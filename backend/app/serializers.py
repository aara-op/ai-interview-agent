"""Convert ORM rows into JSON-safe dicts for the API."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from .db import Answer, Candidate, Incident, Interview, InterviewSession, Question, Resume


def _iso(dt: Optional[datetime]) -> Optional[str]:
    """Naive UTC timestamps must stay unambiguous in the browser, so tag them Z."""
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.isoformat(timespec="seconds") + "Z"
    return dt.isoformat(timespec="seconds")


def _j(value, default):
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _resume_roles(parsed: dict) -> list:
    """Job titles extracted from the resume (LLM path stores experience_roles)."""
    out: List[str] = []
    for role in (parsed.get("experience_roles") or parsed.get("roles") or []):
        if isinstance(role, dict):
            title = str(role.get("title") or "").strip()
            if title:
                out.append(title)
        elif isinstance(role, str) and role.strip():
            out.append(role.strip())
    return out


def candidate_dict(c: Optional[Candidate]) -> Optional[dict]:
    if not c:
        return None
    parsed = _j(c.resume_parsed, {})
    digits = "".join(ch for ch in (c.aadhaar_id or "") if ch.isdigit())
    return {
        "id": c.id,
        "name": c.name or "",
        "email": c.email or "",
        # Aadhaar is stored for identity checking but never sent in full
        "aadhaar_masked": f"XXXX XXXX {digits[-4:]}" if len(digits) == 12 else "",
        "pfp_url": f"/api/candidates/{c.id}/pfp" if c.pfp_path else "",
        "has_pfp": bool(c.pfp_path),
        "resume_filename": c.resume_filename or "",
        "resume_email": c.resume_email or "",
        "has_resume": bool(c.resume_path),
        "has_voice": bool(c.voice_path),
        "years_experience": float(parsed.get("years_experience") or 0),
        "skills": [str(s) for s in (parsed.get("skills") or [])][:40],
        "roles": _resume_roles(parsed)[:6],
        "education": [str(e) for e in (parsed.get("education") or [])][:4],
        "projects": [str(p) for p in (parsed.get("projects") or [])][:6],
        "phone": str(parsed.get("phone") or ""),
        "summary": str(parsed.get("summary") or parsed.get("summary_excerpt") or "")[:400],
        "created_at": _iso(c.created_at),
        "last_login_at": _iso(c.last_login_at),
    }


def resume_dict(r: Optional[Resume]) -> Optional[dict]:
    if not r:
        return None
    parsed = _j(r.parsed, {})
    return {
        "id": r.id,
        "filename": r.filename,
        "candidate_name": r.candidate_name,
        "candidate_email": r.candidate_email,
        "candidate_phone": r.candidate_phone,
        "years_experience": r.years_experience or 0,
        "parsed": parsed,
        "text_length": len(r.raw_text or ""),
        "text_preview": (r.raw_text or "")[:1500],
    }


def question_dict(q: Question) -> dict:
    return {
        "id": q.id,
        "position": q.position,
        "text": q.text,
        "category": q.category,
        "difficulty": q.difficulty,
        "source": q.source,
        "rationale": q.rationale,
        "skill_target": q.skill_target,
    }


def _weights(iv) -> dict:
    from .scorecard import parse_weights
    return parse_weights(getattr(iv, "score_weights", ""))


def interview_dict(iv: Interview, *, with_questions: bool = True,
                   with_resume: bool = True) -> dict:
    out = {
        "id": iv.id,
        "public_id": iv.public_id,
        "created_at": _iso(iv.created_at),
        "job_title": iv.job_title,
        "job_description": iv.job_description,
        "required_skills": _j(iv.required_skills, []),
        "experience_level": iv.experience_level,
        "responsibilities": iv.responsibilities,
        "min_years_experience": iv.min_years_experience or 0,
        "duration_minutes": iv.duration_minutes,
        "question_count": iv.question_count,
        "categories": _j(iv.categories, []),
        "difficulty": iv.difficulty,
        "per_question_limit_seconds": iv.per_question_limit_seconds,
        "allow_followups": bool(iv.allow_followups),
        "max_followups": iv.max_followups or 0,
        "weights": _weights(iv),
        "status": iv.status,
        "session_count": len(iv.sessions) if hasattr(iv, "sessions") else 0,
    }
    if with_resume:
        out["resume"] = resume_dict(iv.resume)
    if with_questions:
        out["questions"] = [question_dict(q) for q in iv.questions]
    return out


def answer_dict(a: Answer, *, with_score: bool = True) -> dict:
    out = {
        "id": a.id,
        "position": a.position,
        "question_id": a.question_id,
        "question_text": a.question_text,
        "category": a.category,
        "transcript": a.transcript,
        "status": a.status,
        "is_followup": bool(a.is_followup),
        "parent_answer_id": a.parent_answer_id,
        "duration_seconds": a.duration_seconds or 0,
        "char_count": a.char_count or 0,
        "answered_at": _iso(a.answered_at),
    }
    if with_score:
        out["score"] = a.score
        out["score_detail"] = _j(a.score_json, None)
    return out


def incident_dict(i: Incident, *, evidence: bool = False) -> dict:
    out = {
        "id": i.id,
        "ts_ms": i.ts_ms or 0,
        "wall_time": _iso(i.wall_time),
        "type": i.type,
        "severity": i.severity,
        "observed": i.observed,
        "inference": i.inference,
        "value": i.value,
        "duration_ms": i.duration_ms or 0,
        "acknowledged": bool(i.acknowledged),
        "reviewer_note": i.reviewer_note or "",
        "has_evidence": bool(i.evidence_jpeg),
    }
    if evidence and i.evidence_jpeg:
        import base64
        out["evidence_data_url"] = (
            f"data:{i.evidence_mime or 'image/jpeg'};base64,"
            + base64.b64encode(i.evidence_jpeg).decode("ascii")
        )
    return out


def session_dict(s: InterviewSession, *, with_answers: bool = True,
                 with_incidents: bool = False,
                 with_interview: bool = True) -> dict:
    out = {
        "id": s.id,
        "public_id": s.public_id,
        "interview_id": s.interview_id,
        "candidate_name": s.candidate_name,
        "candidate_email": s.candidate_email,
        "status": s.status,
        "created_at": _iso(s.created_at),
        "started_at": _iso(s.started_at),
        "ended_at": _iso(s.ended_at),
        "duration_seconds": s.duration_seconds or 0,
        "consent_recording": bool(s.consent_recording),
        "consent_proctoring": bool(s.consent_proctoring),
        "device_check": _j(s.device_check, {}),
        "pair_token": s.pair_token,
        "candidate": candidate_dict(s.candidate) if s.candidate else None,
        "evaluation_status": s.evaluation_status,
        "evaluation": _j(s.evaluation, None),
        "recorder_note": s.recorder_notes if hasattr(s, "recorder_notes") else None,
        "recorder": bool(s.recording_path),
        "recruiter_notes": s.recruiter_notes or "",
        "integrity": {
            "verdict": s.integrity_verdict or "",
            "penalty": int(s.integrity_penalty or 0),
            "note": s.integrity_note or "",
        },
        "answer_count": len(s.answers),
        "incident_count": len(s.incidents),
    }
    if with_answers:
        out["answers"] = [answer_dict(a) for a in s.answers]
    if with_incidents:
        out["incidents"] = [incident_dict(i) for i in s.incidents]
    if with_interview and s.interview:
        out["interview"] = interview_dict(s.interview)
    return out
