"""Recruiter organisation profile and the dashboard roll-up.

`GET  /api/settings`      the organisation card (name, contact email, phone, notes)
`POST /api/settings`      save it (defaults come from ORG_* env vars)
`GET  /api/dashboard`     stats + upcoming meetings + per-candidate resume
                          judgement (required skills vs resume skills, score)
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import ORG_EMAIL, ORG_NAME, ORG_PHONE
from ..db import Interview, InterviewSession, Setting, get_db
from ..serializers import _iso
from .interviews import _skill_match

router = APIRouter(prefix="/api", tags=["dashboard"])

SETTING_KEYS = ("org_name", "org_email", "org_phone", "org_notes")


def _defaults() -> dict:
    return {
        "org_name": ORG_NAME or "Interview Team",
        "org_email": ORG_EMAIL,
        "org_phone": ORG_PHONE,
        "org_notes": "",
    }


def _load(db: Session) -> dict:
    out = _defaults()
    rows = db.query(Setting).filter(Setting.key.in_(SETTING_KEYS)).all()
    for row in rows:
        if row.value:
            out[row.key] = row.value
    return out


class SettingsIn(BaseModel):
    org_name: str = ""
    org_email: str = ""
    org_phone: str = ""
    org_notes: str = ""


@router.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    return _load(db)


@router.post("/settings")
def save_settings(body: SettingsIn, db: Session = Depends(get_db)):
    for key in SETTING_KEYS:
        value = str(getattr(body, key, "") or "")[:300]
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    db.commit()
    return _load(db)


def _json(raw: str, default):
    try:
        return json.loads(raw or "") or default
    except (json.JSONDecodeError, TypeError):
        return default


@router.get("/dashboard")
def recruiter_dashboard(db: Session = Depends(get_db)):
    """Everything the recruiter needs on one page."""
    sessions = (db.query(InterviewSession)
                .order_by(InterviewSession.created_at.desc())
                .limit(500).all())
    org = _load(db)

    upcoming: List[dict] = []
    candidates: List[dict] = []
    scores: List[float] = []
    completed = 0

    for s in sessions:
        iv = s.interview
        if not iv:
            continue
        evaluation = _json(s.evaluation, {})
        if s.status in ("completed", "disqualified"):
            completed += 1
        score = evaluation.get("overall_score")
        if isinstance(score, (int, float)):
            scores.append(float(score))

        c = s.candidate
        parsed = _json(c.resume_parsed, {}) if c else {}
        required = _json(iv.required_skills, [])
        match = _skill_match(required, parsed.get("skills") or []) if c else None

        row = {
            "session_id": s.id,
            "interview_id": iv.id,
            "job_title": iv.job_title,
            "candidate": s.candidate_name or "",
            "email": s.candidate_email or (c.email if c else ""),
            "status": s.status,
            "meeting_at": _iso(s.meeting_at),
            "meeting_minutes": s.meeting_minutes or 45,
            "shortlisted": bool(s.shortlisted),
            "code": s.public_id,
            "score": score if isinstance(score, (int, float)) else None,
            "recommendation": evaluation.get("recommendation") or "",
        }

        judgement = dict(row)
        judgement["match"] = match
        judgement["years"] = float(parsed.get("years_experience") or 0)
        judgement["resume"] = (c.resume_filename if c else "") or ""
        judgement["has_resume"] = bool(c and c.resume_path)
        candidates.append(judgement)

        if s.meeting_at and s.status not in ("completed", "disqualified"):
            upcoming.append(row)

    upcoming.sort(key=lambda r: r["meeting_at"] or "")
    candidates.sort(key=lambda r: (-(r["match"]["score"] if r["match"] else 0.0),
                                   -(r["score"] or 0.0)))

    avg = round(sum(scores) / len(scores), 1) if scores else None
    return {
        "org": org,
        "stats": {
            "interviews": db.query(Interview).count(),
            "sessions": len(sessions),
            "upcoming": len(upcoming),
            "completed": completed,
            "avg_score": avg,
        },
        "upcoming": upcoming,
        "candidates": candidates[:50],
    }