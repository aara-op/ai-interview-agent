"""Candidate session lifecycle: onboarding, answers, follow-ups, evaluation."""
from __future__ import annotations

import json
import secrets
import threading
import time
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import evaluation as evalmod
from .. import questions as qgen
from .. import scorecard
from ..config import RECORDING_DIR
from ..db import (Answer, Interview, InterviewSession, Question, SessionLocal,
                   get_db)
from ..serializers import _iso, answer_dict, incident_dict, interview_dict, session_dict
from .interviews import ensure_warmups

BACKUP_PREFIX = "Backup round:"
MAX_BACKUPS = 2

router = APIRouter(prefix="/api", tags=["sessions"])


# --------------------------------------------------------------------------- #
# Bodies
# --------------------------------------------------------------------------- #
class SessionIn(BaseModel):
    interview_id: int
    candidate_name: str = ""
    candidate_email: str = ""


class ConsentIn(BaseModel):
    consent_recording: bool = False
    consent_proctoring: bool = False
    device_check: dict = {}


class AnswerIn(BaseModel):
    transcript: str = ""
    status: str = "answered"          # answered | skipped | unanswered
    duration_seconds: int = 0


class FollowupIn(BaseModel):
    parent_answer_id: int


class ReportPatch(BaseModel):
    recruiter_notes: Optional[str] = None
    overrides: List[dict] = []        # [{answer_id, score, note}]
    acknowledged_incidents: List[int] = []
    # human integrity review: the recruiter judges the suspicion flags and
    # decides how many points (if any) come off the reported overall score
    integrity: Optional[dict] = None   # {verdict, penalty, note}
    # recruiter decision on the automatic veto: "", "reinstated" or "rejected"
    veto_override: Optional[str] = None


# --------------------------------------------------------------------------- #
# Onboarding
# --------------------------------------------------------------------------- #
@router.post("/sessions")
def create_session(body: SessionIn, db: Session = Depends(get_db)):
    iv = db.get(Interview, body.interview_id)
    if not iv:
        raise HTTPException(404, "Interview not found.")
    if not iv.questions:
        raise HTTPException(409, "This interview has no questions yet.")

    resume = iv.resume
    name = body.candidate_name.strip()
    email = body.candidate_email.strip()
    if not name and resume:
        name = resume.candidate_name or "Candidate"
    if not email and resume:
        email = resume.candidate_email or ""

    s = InterviewSession(
        public_id=secrets.token_urlsafe(12)[:16],
        interview_id=iv.id,
        candidate_name=name or "Candidate",
        candidate_email=email,
        status="onboarding",
        pair_token=secrets.token_urlsafe(24)[:32],
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return session_dict(s)


@router.get("/join/{code}")
def resolve_join(code: str, db: Session = Depends(get_db)):
    """Candidate-side entry: accept a public session code or a numeric id."""
    key = (code or "").strip()
    s = None
    if key.isdigit():
        s = db.get(InterviewSession, int(key))
    if s is None and key:
        s = (db.query(InterviewSession)
             .filter(InterviewSession.public_id == key).first())
    if not s:
        raise HTTPException(404, "No interview matches that code.")
    return {
        "id": s.id,
        "status": s.status,
        "job_title": s.interview.job_title if s.interview else "",
        "candidate_name": s.candidate_name,
    }


@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db)):
    """Recruiter dashboard feed: every candidate session with its outcome."""
    rows = (db.query(InterviewSession)
            .order_by(InterviewSession.created_at.desc())
            .limit(200).all())
    out = []
    for s in rows:
        evaluation = None
        if s.evaluation:
            try:
                evaluation = json.loads(s.evaluation)
            except json.JSONDecodeError:
                evaluation = None
        high = len([i for i in s.incidents if i.severity == "high"])
        warning = len([i for i in s.incidents if i.severity == "warning"])
        out.append({
            "id": s.id,
            "public_id": s.public_id,
            "interview_id": s.interview_id,
            "job_title": s.interview.job_title if s.interview else "",
            "candidate_name": s.candidate_name,
            "candidate_email": s.candidate_email,
            "status": s.status,
            "created_at": _iso(s.created_at),
            "started_at": _iso(s.started_at),
            "ended_at": _iso(s.ended_at),
            "duration_seconds": s.duration_seconds or 0,
            "answer_count": len(s.answers),
            "answered_count": len([a for a in s.answers if a.status == "answered"]),
            "incident_count": len(s.incidents),
            "incidents_high": high,
            "incidents_warning": warning,
            "evaluation_status": s.evaluation_status,
            "overall_score": (evaluation or {}).get("overall_score"),
            "recommendation": (evaluation or {}).get("recommendation"),
            "has_recording": bool(s.recording_path),
            "consent_proctoring": bool(s.consent_proctoring),
        })
    return out


@router.get("/sessions/{session_id}")
def get_session(session_id: int, db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    return session_dict(s, with_incidents=True)


@router.post("/sessions/{session_id}/consent")
def give_consent(session_id: int, body: ConsentIn, db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    s.consent_recording = body.consent_recording
    s.consent_proctoring = body.consent_proctoring
    s.device_check = json.dumps(body.device_check, ensure_ascii=False)
    db.commit()
    db.refresh(s)
    return session_dict(s)


@router.post("/sessions/{session_id}/start")
def start_session(session_id: int, db: Session = Depends(get_db)):
    """Create the ordered answer rows and mark the interview started."""
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    if s.status in ("completed",):
        raise HTTPException(409, "This interview already completed.")

    # Interviews created before warm-ups existed still get them here, so every
    # candidate starts with the comfort questions before the configured set.
    ensure_warmups(db, s.interview)

    if not s.answers:
        # Warm-up (ice-breaker) questions are asked first; the recruiter's
        # configured set follows in its configured order.
        ordered = sorted(
            s.interview.questions,
            key=lambda q: (0 if q.category == "icebreaker" else 1, q.position),
        )
        for i, q in enumerate(ordered):
            db.add(Answer(
                session_id=s.id, question_id=q.id, position=i,
                question_text=q.text, category=q.category,
                status="pending", started_at=datetime.utcnow(),
            ))
        s.started_at = s.started_at or datetime.utcnow()
        s.status = "in_progress"
        db.commit()
    elif s.status == "onboarding":
        s.started_at = s.started_at or datetime.utcnow()
        s.status = "in_progress"
        db.commit()

    db.refresh(s)
    return session_dict(s)


# --------------------------------------------------------------------------- #
# Answers
# --------------------------------------------------------------------------- #
@router.post("/sessions/{session_id}/answers/{answer_id}")
def submit_answer(session_id: int, answer_id: int, body: AnswerIn,
                  db: Session = Depends(get_db)):
    a = db.get(Answer, answer_id)
    if not a or a.session_id != session_id:
        raise HTTPException(404, "Answer not found.")

    status = body.status if body.status in ("answered", "skipped",
                                            "unanswered") else "answered"
    if status == "answered" and not body.transcript.strip():
        status = "unanswered"

    a.transcript = body.transcript.strip()
    a.status = status
    a.duration_seconds = max(0, body.duration_seconds)
    a.char_count = len(a.transcript)
    a.answered_at = datetime.utcnow()
    db.commit()
    db.refresh(a)
    return answer_dict(a)


@router.post("/sessions/{session_id}/followup")
def request_followup(session_id: int, body: FollowupIn,
                     db: Session = Depends(get_db)):
    """Generate a contextual follow-up, bounded by the interview's budget."""
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    iv = s.interview
    if not iv.allow_followups:
        return {"allowed": False, "reason": "followups_disabled",
                "question": None}

    parent = db.get(Answer, body.parent_answer_id)
    if not parent or parent.session_id != s.id:
        raise HTTPException(404, "Parent answer not found.")

    # Walk up the thread: the genre (category) and difficulty of the ORIGINAL
    # question govern every follow-up in it, and each earlier exchange is handed
    # to the generator so the new question continues one step after the last
    # one instead of jumping sideways.
    ancestors: List[Answer] = []
    node = parent.parent if parent.is_followup else None
    seen = set()
    while node is not None and node.id not in seen:
        seen.add(node.id)
        ancestors.append(node)
        node = node.parent if node.is_followup else None
    ancestors.reverse()                       # root question first
    root = ancestors[0] if ancestors else parent
    chain = [{"question": a.question_text, "answer": a.transcript}
             for a in ancestors]

    genre = (root.category or "").strip()
    q_row = db.get(Question, root.question_id) if root.question_id else None
    difficulty = (q_row.difficulty if q_row else "") or ""
    skill = (q_row.skill_target if q_row else "") or ""

    # Warm-ups are comfort questions — never extend them with follow-ups.
    if genre == "icebreaker" or parent.category == "icebreaker":
        return {"allowed": False, "reason": "warmup", "question": None}

    # Judge the answer first — the room acts on one of three outcomes:
    #   complete       -> task complete, move on
    #   unsatisfactory -> ask one contextual follow-up (below)
    #   unclear        -> nothing usable was captured: the room re-asks
    verdict = qgen.assess_answer(parent.question_text, parent.transcript,
                                 genre, difficulty)
    if verdict["verdict"] == "unclear":
        return {"allowed": False, "reason": "unclear_answer",
                "verdict": "unclear", "detail": verdict.get("reason", ""),
                "question": None}
    if verdict["verdict"] == "complete":
        return {"allowed": False, "reason": "task_complete",
                "verdict": "complete", "detail": verdict.get("reason", ""),
                "question": None}

    existing = [a for a in s.answers if a.is_followup]
    if len(existing) >= (iv.max_followups or 0):
        return {"allowed": False, "reason": "budget_exhausted",
                "verdict": "unsatisfactory", "question": None,
                "used": len(existing), "budget": iv.max_followups}

    gen = qgen.generate_followup(parent.question_text, parent.transcript,
                                 skill, genre, difficulty, chain)
    if not gen:
        return {"allowed": False, "reason": "not_warranted",
                "verdict": "unsatisfactory", "question": None}

    next_pos = max([a.position for a in s.answers] + [0]) + 1
    a = Answer(
        session_id=s.id, question_id=parent.question_id, position=next_pos,
        question_text=gen["question"], category="followup",
        status="pending", is_followup=True, parent_answer_id=parent.id,
        started_at=datetime.utcnow(),
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return {"allowed": True, "verdict": "unsatisfactory",
            "question": gen["question"],
            "reason": gen.get("reason", ""),
            "answer": answer_dict(a),
            "used": len(existing) + 1, "budget": iv.max_followups}


@router.post("/sessions/{session_id}/backup")
def deploy_backup(session_id: int, db: Session = Depends(get_db)):
    """Deploy a reserve question after a camera glitch or camera cut (>5 s).

    The candidate may have lost the question to a technical fault or hidden the
    camera on purpose; either way a fresh, scored question is queued directly
    behind the current one so the interview still collects its evidence.
    Capped at MAX_BACKUPS per interview so it cannot be used to stretch the
    interview.
    """
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    if s.status in ("completed", "disqualified"):
        return {"allowed": False, "reason": "interview_finished", "answer": None}

    used = [a for a in s.answers if (a.question_text or "").startswith(BACKUP_PREFIX)]
    if len(used) >= MAX_BACKUPS:
        return {"allowed": False, "reason": "backup_budget_exhausted",
                "answer": None, "used": len(used), "budget": MAX_BACKUPS}

    iv = s.interview
    ctx = {
        "required_skills": iv.skills_list,
        "matched_skills": [],
    }
    existing = [a.question_text for a in s.answers] + \
               [q.text for q in iv.questions]
    gen = qgen.generate_backup(ctx, existing, 1)
    if not gen:
        return {"allowed": False, "reason": "no_backup_available", "answer": None}
    q = gen[0]

    next_pos = max([a.position for a in s.answers] + [0]) + 1
    a = Answer(
        session_id=s.id, question_id=None, position=next_pos,
        question_text=q["text"], category=q["category"],
        status="pending", started_at=datetime.utcnow(),
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return {"allowed": True, "answer": answer_dict(a),
            "used": len(used) + 1, "budget": MAX_BACKUPS}


@router.get("/sessions/{session_id}/next")
def next_question(session_id: int, db: Session = Depends(get_db)):
    """Front-end helper: next pending answer + remaining budget/status."""
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    pending = [a for a in s.answers if a.status == "pending"]
    answered = [a for a in s.answers if a.status == "answered"]
    followups_used = len([a for a in s.answers if a.is_followup])
    return {
        "total": len(s.answers),
        "pending": len(pending),
        "answered": len(answered),
        "skipped": len([a for a in s.answers if a.status == "skipped"]),
        "unanswered": len([a for a in s.answers if a.status == "unanswered"]),
        "followups_used": followups_used,
        "followups_budget": s.interview.max_followups if s.interview.allow_followups else 0,
        "current": answer_dict(pending[0]) if pending else None,
        "elapsed_seconds": _elapsed(s),
    }


def _elapsed(s: InterviewSession) -> int:
    if not s.started_at:
        return 0
    end = s.ended_at or datetime.utcnow()
    return max(0, int((end - s.started_at).total_seconds()))


# --------------------------------------------------------------------------- #
# Completion + evaluation
# --------------------------------------------------------------------------- #
class CompleteIn(BaseModel):
    # \"disqualified\" is set by the interview room when the candidate has
    # used up their warning budget (third warning under the proctoring rules).
    status: str = "completed"


@router.post("/sessions/{session_id}/complete")
def complete_session(session_id: int, body: Optional[CompleteIn] = None,
                     db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")

    final_status = body.status if body and body.status in {"completed", "disqualified"} \
        else "completed"
    for a in s.answers:
        if a.status == "pending":
            a.status = "unanswered"
    now = datetime.utcnow()
    s.ended_at = now
    s.duration_seconds = _elapsed(s)
    s.status = final_status
    s.evaluation_status = "running"
    s.evaluation = ""
    db.commit()

    # Evaluation runs off the request thread; the report endpoint polls.
    thread = threading.Thread(target=_run_evaluation, args=(session_id,),
                              daemon=True)
    thread.start()

    db.refresh(s)
    return session_dict(s)


def _run_evaluation(session_id: int) -> None:
    db = SessionLocal()
    try:
        s = db.get(InterviewSession, session_id)
        if not s:
            return
        interview = s.interview
        answers = [
            {
                "id": a.id,
                "question_text": a.question_text,
                "category": a.category,
                "transcript": a.transcript,
                "status": a.status,
            }
            for a in s.answers
        ]
        payload = {
            "job_title": interview.job_title,
            "job_description": interview.job_description,
            "required_skills": interview.skills_list,
            "experience_level": interview.experience_level,
        }
        session_info = {"candidate_name": s.candidate_name}
        try:
            result = evalmod.evaluate(session_info, [], answers, payload)
            s.evaluation = json.dumps(result, ensure_ascii=False)
            s.evaluation_status = "done"
        except Exception as exc:                       # noqa: BLE001
            s.evaluation_status = "failed"
            s.evaluation = json.dumps({"error": str(exc)[:400]})
        db.commit()
    finally:
        db.close()


@router.post("/sessions/{session_id}/evaluate")
def recompute_evaluation(session_id: int, db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    s.evaluation_status = "running"
    db.commit()
    threading.Thread(target=_run_evaluation, args=(session_id,),
                     daemon=True).start()
    return {"evaluation_status": "running"}


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
_FORGERY_TYPES = {"identity_mismatch", "multiple_faces", "secondary_voice",
                  "environment_mismatch"}


def _suspicion_summary(s: InterviewSession) -> dict:
    """Timestamped suspicion flags for the human interviewer.

    Deliberately a transparent sum of the stored observations (high = 3,
    warning = 1) rather than a model judgement: the level tells the reviewer
    where to look first, and every contributing event is listed with its
    timestamp so they can judge it themselves.
    """
    high = warning = 0
    score = 0
    events: List[dict] = []
    forgery: List[dict] = []
    for i in s.incidents:
        sev = i.severity or "info"
        weight = 3 if sev == "high" else 1 if sev == "warning" else 0
        if not weight:
            continue
        high += sev == "high"
        warning += sev == "warning"
        score += weight
        row = {
            "id": i.id,
            "type": i.type,
            "ts_ms": i.ts_ms or 0,
            "wall_time": _iso(i.wall_time),
            "severity": sev,
            "observed": i.observed or "",
            "has_evidence": bool(i.evidence_jpeg),
            "acknowledged": bool(i.acknowledged),
        }
        events.append(row)
        if i.type in _FORGERY_TYPES:
            forgery.append(row)

    if s.status == "disqualified" or high >= 3 or score >= 12:
        level = "high"
    elif high >= 1 or score >= 5:
        level = "medium"
    elif score >= 1:
        level = "low"
    else:
        level = "none"
    events.sort(key=lambda e: e["ts_ms"])
    return {
        "level": level,
        "score": score,
        "high": high,
        "warning": warning,
        "forgery_flags": [e["type"] for e in forgery],
        "events": events,
        "explanation": (
            "Level is a transparent sum of the stored observations "
            "(high = 3 points, warning = 1 point), not a model verdict: "
            "use the timestamps below to judge the candidate yourself."
        ),
    }


@router.get("/sessions/{session_id}/report")
def get_report(session_id: int, evidence: bool = False,
               include_evidence: bool = False,
               db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")

    evaluation = None
    if s.evaluation:
        try:
            evaluation = json.loads(s.evaluation)
        except json.JSONDecodeError:
            evaluation = None

    with_evidence = evidence or include_evidence
    incidents = [incident_dict(i, evidence=with_evidence)
                 for i in s.incidents]

    # proctoring summary — observations, explicitly not verdicts
    by_severity = {"info": 0, "warning": 0, "high": 0}
    for i in s.incidents:
        by_severity[i.severity or "info"] = by_severity.get(i.severity or "info", 0) + 1

    suspicion = _suspicion_summary(s)
    integrity = {
        "verdict": s.integrity_verdict or "",
        "penalty": int(s.integrity_penalty or 0),
        "note": s.integrity_note or "",
    }
    adjusted = None
    if evaluation and isinstance(evaluation.get("overall_score"), (int, float)):
        adjusted = round(max(0.0, float(evaluation["overall_score"])
                             - integrity["penalty"]), 2)

    card = scorecard.build(evaluation, s.answers, s.incidents, s.status,
                           s.interview.score_weights, s.veto_override or "")

    return {
        "session": session_dict(s, with_incidents=False),
        "interview": interview_dict(s.interview),
        "answers": [answer_dict(a) for a in s.answers],
        "scorecard": card,
        "evaluation": evaluation,
        "evaluation_status": s.evaluation_status,
        "incidents": incidents,
        "suspicion": suspicion,
        "integrity": integrity,
        "adjusted_score": adjusted,
        "proctoring_summary": {
            "total": len(incidents),
            "by_severity": by_severity,
            "coverage_seconds": _elapsed(s),
            "disclaimer": (
                "Events are observations for human review. They are not proof "
                "of misconduct and must not be used as an automatic verdict."
            ),
        },
    }


@router.patch("/sessions/{session_id}")
def update_report(session_id: int, body: ReportPatch,
                  db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")

    if body.recruiter_notes is not None:
        s.recruiter_notes = body.recruiter_notes

    for ov in body.overrides:
        a = db.get(Answer, int(ov.get("answer_id", 0)))
        if a and a.session_id == s.id and "score" in ov:
            try:
                score = max(1, min(5, int(ov["score"])))
            except (TypeError, ValueError):
                continue
            a.score = score
            detail = {}
            if a.score_json:
                try:
                    detail = json.loads(a.score_json)
                except json.JSONDecodeError:
                    detail = {}
            detail["score"] = score
            detail["overridden_by_recruiter"] = True
            detail["override_note"] = str(ov.get("note") or "")[:300]
            a.score_json = json.dumps(detail, ensure_ascii=False)

    for inc_id in body.acknowledged_incidents:
        from ..db import Incident
        inc = db.get(Incident, int(inc_id))
        if inc and inc.session_id == s.id:
            inc.acknowledged = True

    if body.integrity is not None:
        verdict = str(body.integrity.get("verdict") or "").strip().lower()
        if verdict not in ("", "clean", "review", "suspicious"):
            raise HTTPException(400, "Unknown integrity verdict.")
        try:
            penalty = int(body.integrity.get("penalty") or 0)
        except (TypeError, ValueError):
            penalty = 0
        s.integrity_verdict = verdict
        s.integrity_penalty = max(0, min(3, penalty))
        s.integrity_note = str(body.integrity.get("note") or "")[:1000]

    if body.veto_override is not None:
        choice = body.veto_override.strip().lower()
        if choice not in ("", "reinstated", "rejected"):
            raise HTTPException(400, "Unknown veto decision.")
        s.veto_override = choice

    db.commit()
    db.refresh(s)
    return get_report(session_id, evidence=True, db=db)


# --------------------------------------------------------------------------- #
# Recording
# --------------------------------------------------------------------------- #
@router.post("/sessions/{session_id}/recording")
async def upload_recording(session_id: int,
                           file: UploadFile = File(...),
                           db: Session = Depends(get_db)):
    """Store the candidate's recorded interview (webm/mp4) for review."""
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    data = await file.read()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(413, "Recording exceeds the 200 MB limit.")
    ext = ".webm"
    name = (file.filename or "").lower()
    if name.endswith(".mp4") or (file.content_type or "").endswith("mp4"):
        ext = ".mp4"
    filename = f"{s.public_id}{ext}"
    (RECORDING_DIR / filename).write_bytes(data)
    s.recording_path = filename
    db.commit()
    return {"stored": True, "bytes": len(data), "recorder": True}


@router.get("/sessions/{session_id}/recording")
def get_recording(session_id: int, db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s or not s.recording_path:
        raise HTTPException(404, "No recording stored for this session.")
    path = RECORDING_DIR / s.recording_path
    if not path.exists():
        raise HTTPException(404, "Recording file missing.")
    return FileResponse(path, media_type="video/webm",
                        filename=f"interview-{s.public_id}.webm")


# --------------------------------------------------------------------------- #
# Secondary camera pairing
# --------------------------------------------------------------------------- #
@router.get("/sessions/{session_id}/pair")
def pair_info(session_id: int, db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    if not s.consent_proctoring:
        raise HTTPException(409, "Proctoring consent has not been given yet.")
    return {"token": s.pair_token, "session_id": s.id,
            "candidate_name": s.candidate_name,
            "interview_title": s.interview.job_title}


@router.get("/pair/{token}")
def resolve_pair(token: str, db: Session = Depends(get_db)):
    s = (db.query(InterviewSession)
         .filter(InterviewSession.pair_token == token).first())
    if not s:
        raise HTTPException(404, "Invalid or expired pairing code.")
    if s.status == "completed":
        raise HTTPException(410, "This interview has already finished.")
    return {
        "session_id": s.id,
        "candidate_name": s.candidate_name,
        "interview_title": s.interview.job_title,
        "consent_ok": bool(s.consent_proctoring),
    }
