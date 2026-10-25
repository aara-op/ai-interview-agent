"""Recruiter-facing routes: interview configuration, uploads, question set."""
from __future__ import annotations

import json
import secrets
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import mail
from .. import questions as qgen
from .. import resume as rparse
from .. import scorecard
from ..config import DEFAULT_INTERVIEW_DURATION_MINUTES, DEFAULT_QUESTION_COUNT, \
    MAIL_ENABLED, MAX_UPLOAD_MB
from ..db import Interview, InterviewSession, Question, Resume, get_db
from ..serializers import _iso, candidate_dict, interview_dict

router = APIRouter(prefix="/api/interviews", tags=["interviews"])


def _split_lines(value: str) -> List[str]:
    if not value:
        return []
    parts: List[str] = []
    for chunk in value.replace("\n", ",").split(","):
        chunk = chunk.strip()
        if chunk:
            parts.append(chunk)
    seen, out = set(), []
    for p in parts:
        key = p.lower()
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


@router.post("")
async def create_interview(
    job_title: str = Form(...),
    job_description: str = Form(""),
    required_skills: str = Form(""),
    experience_level: str = Form("mid"),
    min_years_experience: int = Form(0),
    duration_minutes: int = Form(DEFAULT_INTERVIEW_DURATION_MINUTES),
    question_count: int = Form(DEFAULT_QUESTION_COUNT),
    categories: str = Form("technical,behavioral,experience,scenario"),
    difficulty: str = Form("mixed"),
    per_question_limit_seconds: int = Form(90),
    allow_followups: bool = Form(True),
    max_followups: int = Form(3),
    resume: Optional[UploadFile] = File(None),
    jd_file: Optional[UploadFile] = File(None),
    recruiter_questions: str = Form(""),
    weight_technical: int = Form(scorecard.DEFAULT_WEIGHTS["technical"]),
    weight_behavioral: int = Form(scorecard.DEFAULT_WEIGHTS["behavioral"]),
    weight_integrity: int = Form(scorecard.DEFAULT_WEIGHTS["integrity"]),
    db: Session = Depends(get_db),
):
    """Create an interview: parse JD + resume, then generate the question set."""
    if question_count <= 0:
        question_count = DEFAULT_QUESTION_COUNT
    question_count = min(question_count, 40)

    # --- job description: textarea wins, else the uploaded file ------------
    if jd_file is not None and jd_file.filename:
        data = await _read_upload(jd_file)
        job_description = rparse.extract_text(jd_file.filename, data)

    if not job_description.strip():
        raise HTTPException(400, "A job description (text or file) is required.")

    # --- resume ------------------------------------------------------------
    resume_obj: Optional[Resume] = None
    if resume is not None and resume.filename:
        data = await _read_upload(resume)
        text = rparse.extract_text(resume.filename, data)
        if not text.strip():
            raise HTTPException(422,
                                "Could not extract text from that resume file.")
        parsed = rparse.extract_resume(text)
        resume_obj = Resume(
            filename=resume.filename,
            raw_text=text,
            candidate_name=(parsed.get("candidate_name") or "").strip()
            or _name_from_text(text),
            candidate_email=parsed.get("email", ""),
            candidate_phone=parsed.get("phone", ""),
            years_experience=float(parsed.get("years_experience") or 0),
            parsed=json.dumps(parsed, ensure_ascii=False),
        )

    jd_info = rparse.extract_job(job_description, fallback_title=job_title)
    skills = _split_lines(required_skills) or (jd_info.get("required_skills") or [])

    iv = Interview(
        public_id=secrets.token_hex(6),
        job_title=job_title.strip() or (jd_info.get("job_title") or "Untitled role"),
        job_description=job_description.strip(),
        required_skills=json.dumps(skills, ensure_ascii=False),
        experience_level=experience_level or jd_info.get("experience_level") or "mid",
        responsibilities=json.dumps(jd_info.get("responsibilities") or [],
                                    ensure_ascii=False),
        min_years_experience=min_years_experience or int(jd_info.get("min_years_experience") or 0),
        duration_minutes=max(5, min(duration_minutes, 240)),
        question_count=question_count,
        categories=json.dumps(
            [c.strip() for c in (categories or "").split(",") if c.strip()]
            or qgen.CATEGORIES, ensure_ascii=False),
        difficulty=difficulty if difficulty in ("easy", "mixed", "hard") else "mixed",
        per_question_limit_seconds=max(15, min(per_question_limit_seconds, 600)),
        allow_followups=bool(allow_followups),
        max_followups=max(0, min(max_followups, 10)),
        score_weights=scorecard.encode_weights(
            weight_technical, weight_behavioral, weight_integrity),
        status="ready",
    )
    db.add(iv)
    if resume_obj is not None:
        resume_obj.interview = iv
        db.add(resume_obj)
    db.flush()

    # Warm-ups first (positions 0..n), then the recruiter's and AI's main set —
    # all outside the configured question count.
    ensure_warmups(db, iv)
    _write_questions(db, iv, _manual_questions(recruiter_questions),
                      replace_all=False)
    _generate_and_store(db, iv)
    db.commit()
    db.refresh(iv)
    return interview_dict(iv)


async def _read_upload(file: UploadFile) -> bytes:
    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB} MB limit.")
    return data


def _name_from_text(text: str) -> str:
    return (rparse._guess_name(text) or "")


def _manual_questions(raw: str) -> List[dict]:
    out = []
    for line in (raw or "").splitlines():
        line = line.strip("- •\t ")
        if not line:
            continue
        if line[0].isdigit() and line[1:2] in (".", ")"):
            line = line[2:].strip()
        out.append({"text": line, "category": "recruiter", "difficulty": "medium",
                    "skill_target": "", "rationale": "Written by recruiter.",
                    "source": "recruiter"})
    return out[:20]


def _context(iv: Interview) -> dict:
    parsed = json.loads(iv.resume.parsed) if iv.resume and iv.resume.parsed else {}
    roles = parsed.get("experience_roles") or []
    if not roles and iv.resume:
        # heuristic path: expose the raw resume tail so the model still has
        # something concrete to anchor questions on
        roles = []
    analysis = qgen.match_skills(iv.skills_list, parsed.get("skills") or [])
    return {
        "job_title": iv.job_title,
        "job_description": iv.job_description,
        "required_skills": iv.skills_list,
        "experience_level": iv.experience_level,
        "resume_summary": parsed.get("summary", ""),
        "candidate_skills": parsed.get("skills") or [],
        "years_experience": iv.resume.years_experience if iv.resume else 0,
        "roles": roles,
        "projects": parsed.get("projects") or [],
        "education": parsed.get("education") or [],
        "matched_skills": analysis["matched"],
        "gap_skills": analysis["gaps"],
        "extras": analysis["extras"],
        "resume_text": (iv.resume.raw_text if iv.resume else "")[:6000],
    }


def _write_questions(db: Session, iv: Interview, generated: List[dict],
                     *, replace_all: bool) -> None:
    start = 0
    if replace_all:
        for old in list(iv.questions):
            db.delete(old)
        db.flush()
    else:
        start = len(iv.questions)

    for i, q in enumerate(generated):
        row = Question(
            position=start + i,
            text=q["text"],
            category=q.get("category", "technical"),
            difficulty=q.get("difficulty", "medium"),
            source=q.get("source", "ai"),
            rationale=q.get("rationale", ""),
            skill_target=q.get("skill_target", ""),
        )
        iv.questions.append(row)   # keeps the parent collection in sync
        db.add(row)
    db.flush()


def ensure_warmups(db: Session, iv: Interview) -> None:
    """Guarantee the interview opens with its warm-up (ice-breaker) set.

    Warm-ups sit OUTSIDE the recruiter's configured question count: they are
    asked before the main set to settle the candidate and are never scored.
    Existing warm-ups are left alone, so recruiter deletions stick.
    """
    if any(q.category == "icebreaker" for q in iv.questions):
        return
    ctx = _context(iv)
    ctx["candidate_name"] = iv.resume.candidate_name if iv.resume else ""
    warmups = qgen.generate_icebreakers(ctx, qgen.WARMUP_COUNT)
    start = len(iv.questions)
    for i, q in enumerate(warmups):
        row = Question(
            interview_id=iv.id,
            position=start + i,
            text=q["text"],
            category="icebreaker",
            difficulty=q.get("difficulty", "easy"),
            source=q.get("source", "ai"),
            rationale=q.get("rationale", ""),
            skill_target=q.get("skill_target", "rapport"),
        )
        iv.questions.append(row)
        db.add(row)
    db.flush()


def _generate_and_store(db: Session, iv: Interview) -> None:
    manual = [q for q in iv.questions if q.source == "recruiter"]
    remaining = max(0, iv.question_count - len(manual))
    generated: List[dict] = []
    if remaining:
        categories = iv.categories_list
        # recruiter-authored questions don't consume a category slot
        generated = qgen.generate_questions(
            _context(iv), remaining, categories, iv.difficulty)
        # if the recruiter added questions, keep their total to the configured count
        if len(manual) + len(generated) > iv.question_count:
            generated = generated[: max(0, iv.question_count - len(manual))]
    _write_questions(db, iv, generated, replace_all=False)


@router.get("")
def list_interviews(db: Session = Depends(get_db)):
    rows = (db.query(Interview)
            .order_by(Interview.created_at.desc()).all())
    out = []
    for iv in rows:
        item = interview_dict(iv, with_questions=False)
        item["question_count_actual"] = len(iv.questions)
        item["resume_name"] = iv.resume.candidate_name if iv.resume else ""
        item["session_count"] = len(iv.sessions)
        out.append(item)
    return out


@router.get("/{interview_id}")
def get_interview(interview_id: int, db: Session = Depends(get_db)):
    iv = db.get(Interview, interview_id)
    if not iv:
        raise HTTPException(404, "Interview not found.")
    return interview_dict(iv)


@router.post("/{interview_id}/regenerate")
def regenerate(interview_id: int, payload: dict, db: Session = Depends(get_db)):
    """Regenerate the AI questions, optionally with new settings/count."""
    iv = db.get(Interview, interview_id)
    if not iv:
        raise HTTPException(404, "Interview not found.")

    if "question_count" in payload:
        iv.question_count = max(1, min(int(payload["question_count"]), 40))
    if payload.get("difficulty"):
        iv.difficulty = payload["difficulty"]
    if payload.get("categories"):
        iv.categories = json.dumps([c for c in payload["categories"] if c])
    if payload.get("required_skills") is not None:
        iv.required_skills = json.dumps(_split_lines(
            ",".join(payload["required_skills"]) if isinstance(
                payload["required_skills"], list)
            else str(payload["required_skills"])), ensure_ascii=False)

    # drop previously AI-generated questions, keep recruiter-authored ones
    # (warm-ups are source "ai" too — they are regenerated fresh below)
    for old in [q for q in iv.questions if q.source == "ai"]:
        db.delete(old)
    db.flush()
    db.refresh(iv)
    _generate_and_store(db, iv)
    ensure_warmups(db, iv)
    ordered = sorted(iv.questions,
                     key=lambda q: (0 if q.category == "icebreaker" else 1,
                                    q.position))
    for i, q in enumerate(ordered):
        q.position = i
    db.commit()
    db.refresh(iv)
    return interview_dict(iv)


class QuestionIn(BaseModel):
    text: str
    category: str = "recruiter"
    difficulty: str = "medium"
    skill_target: str = ""


@router.post("/{interview_id}/questions")
def add_question(interview_id: int, body: QuestionIn,
                 db: Session = Depends(get_db)):
    iv = db.get(Interview, interview_id)
    if not iv:
        raise HTTPException(404, "Interview not found.")
    q = Question(interview_id=iv.id, position=len(iv.questions),
                 text=body.text.strip(), category=body.category,
                 difficulty=body.difficulty, source="recruiter",
                 rationale="Written by recruiter.",
                 skill_target=body.skill_target)
    db.add(q)
    db.commit()
    db.refresh(iv)
    return interview_dict(iv)


@router.delete("/{interview_id}/questions/{question_id}")
def delete_question(interview_id: int, question_id: int,
                    db: Session = Depends(get_db)):
    q = db.get(Question, question_id)
    if not q or q.interview_id != interview_id:
        raise HTTPException(404, "Question not found.")
    db.delete(q)
    db.commit()
    iv = db.get(Interview, interview_id)
    for i, qq in enumerate(iv.questions):
        qq.position = i
    db.commit()
    db.refresh(iv)
    return interview_dict(iv)


@router.patch("/{interview_id}/questions/{question_id}")
def update_question(interview_id: int, question_id: int, body: QuestionIn,
                    db: Session = Depends(get_db)):
    q = db.get(Question, question_id)
    if not q or q.interview_id != interview_id:
        raise HTTPException(404, "Question not found.")
    q.text = body.text.strip()
    q.category = body.category
    q.difficulty = body.difficulty
    db.commit()
    iv = db.get(Interview, interview_id)
    return interview_dict(iv)


# --------------------------------------------------------------------------- #
# Applicants: skill match, shortlist, meeting + invitation mail
# --------------------------------------------------------------------------- #
class InviteIn(BaseModel):
    session_ids: List[int]
    meeting_at: str                 # "YYYY-MM-DDTHH:MM" from a datetime-local input
    duration_minutes: int = 45
    origin: str = ""
    message: str = ""


def _skill_match(required: List[str], candidate_skills: List[str]) -> dict:
    lowered = [s.strip().lower() for s in candidate_skills if s and s.strip()]
    matched, missing = [], []
    for req in required:
        r = req.strip().lower()
        if not r:
            continue
        hit = any(r in cs or cs in r for cs in lowered)
        (matched if hit else missing).append(req)
    score = round(len(matched) / len(required), 2) if required else 0.0
    return {"required": required, "matched": matched, "missing": missing,
            "score": score}


@router.get("/{interview_id}/applicants")
def list_applicants(interview_id: int, db: Session = Depends(get_db)):
    """Everyone who signed up for this position, ranked by skill match."""
    iv = db.get(Interview, interview_id)
    if not iv:
        raise HTTPException(404, "Interview not found.")
    required = json.loads(iv.required_skills or "[]")

    rows = []
    for s in iv.sessions:
        if not s.candidate_id:
            continue
        c = s.candidate
        parsed = json.loads(c.resume_parsed or "{}")
        rows.append({
            "session_id": s.id,
            "candidate": candidate_dict(c),
            "match": _skill_match(required, parsed.get("skills") or []),
            "years_experience": float(parsed.get("years_experience") or 0),
            "shortlisted": bool(s.shortlisted),
            "meeting_at": _iso(s.meeting_at),
            "meeting_minutes": s.meeting_minutes or 45,
            "invite_email": s.invite_email or "",
            "invite_status": s.invite_status or "",
            "invite_sent_at": _iso(s.invite_sent_at),
            "status": s.status,
        })
    rows.sort(key=lambda r: (-r["match"]["score"], -r["years_experience"]))
    return rows


@router.post("/{interview_id}/invitations")
def send_invitations(interview_id: int, body: InviteIn,
                     db: Session = Depends(get_db)):
    """Shortlist the selected candidates, schedule the meeting, mail the link."""
    iv = db.get(Interview, interview_id)
    if not iv:
        raise HTTPException(404, "Interview not found.")
    if not body.session_ids:
        raise HTTPException(400, "Select at least one candidate to shortlist.")
    try:
        meeting = datetime.fromisoformat(body.meeting_at)
    except ValueError:
        raise HTTPException(400, "Pick a valid meeting date and time.")
    if meeting.year < 2000:
        raise HTTPException(400, "Pick a valid meeting date and time.")

    origin = (body.origin or "").rstrip("/")
    meeting_line = (meeting.strftime("%A, %d %B %Y at %H:%M")
                    + f" ({max(5, min(body.duration_minutes, 240))} minutes)")

    results = []
    for sid in body.session_ids:
        s = db.get(InterviewSession, int(sid))
        if not s or s.interview_id != iv.id or not s.candidate_id:
            results.append({"session_id": sid, "status": "failed:no-candidate"})
            continue
        c = s.candidate
        # contact address: the one parsed from the resume, else the login email
        to = (c.resume_email or c.email or s.candidate_email or "").strip()
        link = f"{origin}/join/{s.id}" if origin else f"/join/{s.id}"
        text = mail.invitation_text(
            candidate_name=c.name or "candidate",
            job_title=iv.job_title,
            company_line="",
            meeting_line=meeting_line,
            link=link,
            code=s.public_id,
            message=body.message,
        )
        res = mail.send_mail(
            to, f"You're shortlisted for {iv.job_title} — interview details", text)

        s.shortlisted = True
        s.meeting_at = meeting
        s.meeting_minutes = max(5, min(body.duration_minutes, 240))
        s.invite_email = to
        s.invite_status = res.status
        s.invite_sent_at = datetime.utcnow() if res.status in ("sent", "outbox") else None
        results.append({"session_id": sid, "candidate": c.name, "email": to,
                        "status": res.status, "detail": res.detail,
                        "preview": res.preview})
    db.commit()

    return {
        "mail_backend": "smtp" if MAIL_ENABLED else "outbox",
        "meeting_at": meeting.isoformat(timespec="minutes"),
        "results": results,
    }
