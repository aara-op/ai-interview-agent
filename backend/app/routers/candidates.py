"""Candidate accounts: self-enrolment, sign-in, profile picture.

Signup collects what the recruiter needs to shortlist: the candidate's resume
(PDF/DOCX), their Aadhaar ID (identity reference for the on-camera face check),
their profile photo, and a ~20 second voice test used later for the spoken
interview.  The face image is stored on disk and served to the signed-in
browser; all face embedding and matching happens client-side, so no biometric
template leaves the machine beyond the photo the candidate uploaded.
The Aadhaar number is never returned in full by the API — the serializers expose
only a masked form (last four digits).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as OrmSession

from .. import resume as rparse
from ..config import MAX_PFP_MB, MAX_VOICE_MB, PFP_DIR, UPLOAD_DIR, VOICE_DIR
from ..db import Candidate, InterviewSession, get_db
from ..serializers import _iso, candidate_dict, session_dict

router = APIRouter(prefix="/api", tags=["candidates"])

_PBKDF2_ITERATIONS = 120_000
_DATA_URL_RE = re.compile(r"^data:image/(png|jpe?g|webp);base64,(?P<b64>.+)$",
                          re.S | re.I)


class LoginIn(BaseModel):
    code: str
    email: str
    password: str


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt,
                               _PBKDF2_ITERATIONS).hex()


def verify_password(password: str, salt_hex: str, expected_hex: str) -> bool:
    if not salt_hex or not expected_hex:
        return False
    got = hash_password(password, salt_hex)
    return hmac.compare_digest(got, expected_hex)


def resolve_session(db: OrmSession, code: str) -> InterviewSession:
    key = (code or "").strip()
    s = None
    if key.isdigit():
        s = db.get(InterviewSession, int(key))
    if s is None and key:
        s = (db.query(InterviewSession)
             .filter(InterviewSession.public_id == key).first())
    if not s:
        raise HTTPException(404, "No interview matches that code.")
    return s


def _clean_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(400, "Enter a valid email address.")
    return email


def _clean_aadhaar(raw: str) -> str:
    """Normalise the 12-digit Aadhaar UID kept as the identity reference."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) != 12:
        raise HTTPException(400,
                            "Enter your 12-digit Aadhaar number — it is used to "
                            "verify your identity against the face check.")
    return digits


def _store_pfp(candidate: Candidate, data_url: str) -> None:
    m = _DATA_URL_RE.match((data_url or "").strip())
    if not m:
        raise HTTPException(400, "Profile picture must be a PNG, JPEG or WebP image.")
    try:
        blob = base64.b64decode(m.group("b64"), validate=True)
    except (ValueError, TypeError):
        raise HTTPException(400, "Profile picture could not be decoded.")
    if len(blob) > MAX_PFP_MB * 1024 * 1024:
        raise HTTPException(400, f"Profile picture must be under {MAX_PFP_MB} MB.")
    path = PFP_DIR / f"{candidate.public_id}.jpg"
    path.write_bytes(blob)
    candidate.pfp_path = str(path)


def _store_resume(candidate: Candidate, upload: UploadFile) -> None:
    name = (upload.filename or "").strip()
    if not name:
        raise HTTPException(400, "Upload your resume as PDF or DOCX.")
    data = upload.file.read()
    if not data:
        raise HTTPException(400, "The resume file is empty.")
    text = rparse.extract_text(name, data)
    if not text.strip():
        # Fallback rather than crashing with 422:
        # Use candidate form data and filename stem so the candidate can always enroll
        clean_name = (candidate.name or "").strip() or "Candidate"
        clean_stem = re.sub(r"[_\-\.]+", " ", Path(name).stem).title()
        text = (
            f"Candidate: {clean_name}\n"
            f"Email: {candidate.email}\n"
            f"Document Title: {clean_stem}\n"
            f"Attachment: {name}\n"
            f"Notice: Scanned or graphic document layout uploaded."
        )
    parsed = rparse.extract_resume(text)

    ext = ".pdf" if name.lower().endswith(".pdf") or data[:4] == b"%PDF" else ".docx"
    path = UPLOAD_DIR / f"resume-{candidate.public_id}{ext}"
    path.write_bytes(data)

    candidate.resume_path = str(path)
    candidate.resume_filename = name
    candidate.resume_text = text
    candidate.resume_email = parsed.get("email") or candidate.email
    candidate.resume_parsed = json.dumps(parsed, ensure_ascii=False)


def _store_voice(candidate: Candidate, upload: UploadFile) -> None:
    data = upload.file.read()
    if not data:
        raise HTTPException(400, "The voice test recording is empty.")
    if len(data) > MAX_VOICE_MB * 1024 * 1024:
        raise HTTPException(400, f"Voice test must be under {MAX_VOICE_MB} MB.")
    ctype = (upload.content_type or "").lower()
    if not (ctype.startswith("audio/") or ctype.startswith("video/webm")):
        raise HTTPException(400, "Voice test must be an audio recording.")
    path = VOICE_DIR / f"{candidate.public_id}.webm"
    path.write_bytes(data)
    candidate.voice_path = str(path)


def _bind(db: OrmSession, session: InterviewSession, candidate: Candidate) -> None:
    session.candidate_id = candidate.id
    candidate.last_login_at = datetime.utcnow()
    if candidate.name and session.candidate_name in ("", "Candidate"):
        session.candidate_name = candidate.name
    if not session.candidate_email:
        session.candidate_email = candidate.resume_email or candidate.email
    db.commit()


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.post("/candidates/enroll")
async def enroll(
    code: str = Form(...),
    name: str = Form(...),
    email: str = Form(...),
    aadhaar_id: str = Form(""),
    password: str = Form(...),
    pfp_data_url: str = Form(...),
    resume: Optional[UploadFile] = File(None),
    voice: Optional[UploadFile] = File(None),
    db: OrmSession = Depends(get_db),
):
    """First visit: create the login, store photo, resume and voice test."""
    session = resolve_session(db, code)
    clean_email = _clean_email(email)
    clean_name = (name or "").strip()
    if not clean_name:
        raise HTTPException(400, "Enter your name.")
    aadhaar = _clean_aadhaar(aadhaar_id)
    if len(password or "") < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")
    if resume is None or not resume.filename:
        raise HTTPException(400, "Upload your resume (PDF or DOCX) to sign up.")
    if voice is None:
        raise HTTPException(400, "Record the 20 second voice test to sign up.")
    if db.query(Candidate).filter(Candidate.email == clean_email).first():
        raise HTTPException(409,
                            "An account with this email already exists — sign in instead.")

    salt = secrets.token_hex(16)
    candidate = Candidate(
        public_id=secrets.token_urlsafe(9)[:12],
        name=clean_name,
        email=clean_email,
        aadhaar_id=aadhaar,
        password_salt=salt,
        password_hash=hash_password(password, salt),
    )
    db.add(candidate)
    db.flush()
    _store_pfp(candidate, pfp_data_url)
    _store_voice(candidate, voice)
    _store_resume(candidate, resume)
    db.commit()
    db.refresh(candidate)
    _bind(db, session, candidate)
    db.refresh(candidate)

    return {
        "candidate": candidate_dict(candidate),
        "session": session_dict(session, with_answers=False),
    }


@router.post("/candidates/login")
def login(body: LoginIn, db: OrmSession = Depends(get_db)):
    """Returning candidate: verify credentials and bind them to this session."""
    session = resolve_session(db, body.code)
    email = _clean_email(body.email)
    candidate = db.query(Candidate).filter(Candidate.email == email).first()
    if not candidate or not verify_password(body.password,
                                            candidate.password_salt,
                                            candidate.password_hash):
        raise HTTPException(401, "Email or password is incorrect.")
    if not candidate.pfp_path:
        raise HTTPException(409,
                            "This account has no profile photo — enrol again with your interview code.")

    _bind(db, session, candidate)
    db.refresh(candidate)
    return {
        "candidate": candidate_dict(candidate),
        "session": session_dict(session, with_answers=False),
    }


@router.get("/candidates/{candidate_id}/pfp")
def get_pfp(candidate_id: int, db: OrmSession = Depends(get_db)):
    """Profile picture used as the reference image for face matching."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate or not candidate.pfp_path:
        raise HTTPException(404, "No profile picture for this candidate.")
    path = candidate.pfp_path
    media = "image/png" if path.lower().endswith(".png") else "image/jpeg"
    return FileResponse(path, media_type=media)


@router.get("/candidates/{candidate_id}/voice")
def get_voice(candidate_id: int, db: OrmSession = Depends(get_db)):
    """20 second voice test recorded at signup (recruiter review)."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate or not candidate.voice_path:
        raise HTTPException(404, "No voice test for this candidate.")
    return FileResponse(candidate.voice_path, media_type="audio/webm")


@router.get("/candidates/{candidate_id}/resume")
def get_resume(candidate_id: int, db: OrmSession = Depends(get_db)):
    """The resume uploaded at sign-up, for the candidate's own dashboard."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate or not candidate.resume_path:
        raise HTTPException(404, "No resume on file.")
    path = candidate.resume_path.lower()
    media = ("application/pdf" if path.endswith(".pdf") else
             "application/vnd.openxmlformats-officedocument."
             "wordprocessingml.document")
    return FileResponse(candidate.resume_path, media_type=media,
                        filename=candidate.resume_filename or "resume")


@router.get("/candidates/{candidate_id}/interviews")
def candidate_interviews(candidate_id: int, db: OrmSession = Depends(get_db)):
    """Everything this candidate is booked on: meetings, links, outcomes."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "Candidate not found.")
    rows = (db.query(InterviewSession)
            .filter(InterviewSession.candidate_id == candidate.id)
            .order_by(InterviewSession.created_at.desc()).all())
    out = []
    for s in rows:
        iv = s.interview
        evaluation = {}
        if s.evaluation:
            try:
                evaluation = json.loads(s.evaluation) or {}
            except json.JSONDecodeError:
                evaluation = {}
        out.append({
            "session_id": s.id,
            "code": s.public_id,
            "interview_id": s.interview_id,
            "job_title": iv.job_title if iv else "Interview",
            "status": s.status,
            "meeting_at": _iso(s.meeting_at),
            "meeting_minutes": s.meeting_minutes or 45,
            "started_at": _iso(s.started_at),
            "ended_at": _iso(s.ended_at),
            "score": evaluation.get("overall_score"),
            "invite_email": s.invite_email or "",
        })
    return out
