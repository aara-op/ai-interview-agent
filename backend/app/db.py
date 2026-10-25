"""SQLAlchemy engine + all ORM models for the interview lifecycle."""
from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
)
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker

from .config import DB_PATH

Base = declarative_base()


def _now() -> datetime:
    return datetime.utcnow()


# --------------------------------------------------------------------------- #
# Recruiter configuration
# --------------------------------------------------------------------------- #
class Interview(Base):
    __tablename__ = "interviews"

    id = Column(Integer, primary_key=True, autoincrement=True)
    public_id = Column(String(32), unique=True, index=True)   # used in URLs
    created_at = Column(DateTime, default=_now)

    job_title = Column(String(200), nullable=False)
    job_description = Column(Text, nullable=False, default="")
    required_skills = Column(Text, nullable=False, default="[]")     # json list
    experience_level = Column(String(60), default="mid")
    responsibilities = Column(Text, nullable=False, default="")
    min_years_experience = Column(Integer, default=0)

    # interview settings
    duration_minutes = Column(Integer, default=30)
    question_count = Column(Integer, default=10)
    categories = Column(Text, default='["technical","behavioral","experience","scenario"]')
    difficulty = Column(String(20), default="mixed")   # easy|mixed|hard
    per_question_limit_seconds = Column(Integer, default=90)
    allow_followups = Column(Boolean, default=True)
    max_followups = Column(Integer, default=3)
    status = Column(String(20), default="draft")       # draft|ready|closed
    # recruiter-set scoring weights (json {technical, behavioral, integrity});
    # empty string = the defaults in scorecard.DEFAULT_WEIGHTS
    score_weights = Column(Text, default="")

    resume = relationship("Resume", uselist=False, back_populates="interview",
                          cascade="all, delete-orphan")
    questions = relationship("Question", back_populates="interview",
                             cascade="all, delete-orphan",
                             order_by="Question.position")
    sessions = relationship("InterviewSession", back_populates="interview",
                            cascade="all, delete-orphan")

    @property
    def skills_list(self) -> list:
        return json.loads(self.required_skills or "[]")

    @property
    def categories_list(self) -> list:
        return json.loads(self.categories or "[]")


class Resume(Base):
    __tablename__ = "resumes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    interview_id = Column(Integer, ForeignKey("interviews.id"), unique=True)
    filename = Column(String(300), default="")
    raw_text = Column(Text, default="")
    candidate_name = Column(String(200), default="")
    candidate_email = Column(String(200), default="")
    candidate_phone = Column(String(60), default="")
    years_experience = Column(Float, default=0)
    parsed = Column(Text, default="{}")   # json: skills/experience/education/...

    interview = relationship("Interview", back_populates="resume")


class Question(Base):
    __tablename__ = "questions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    interview_id = Column(Integer, ForeignKey("interviews.id"), index=True)
    position = Column(Integer, default=0)
    text = Column(Text, nullable=False)
    category = Column(String(40), default="technical")
    difficulty = Column(String(20), default="medium")
    source = Column(String(20), default="ai")          # ai | recruiter
    rationale = Column(Text, default="")
    skill_target = Column(String(120), default="")
    is_followup_slot = Column(Boolean, default=False)

    interview = relationship("Interview", back_populates="questions")


# --------------------------------------------------------------------------- #
# Recruiter organisation profile (dashboard settings, key/value)
# --------------------------------------------------------------------------- #
class Setting(Base):
    __tablename__ = "settings"

    key = Column(String(60), primary_key=True)
    value = Column(Text, default="")


# --------------------------------------------------------------------------- #
# Candidate account (login + profile picture used for identity checks)
# --------------------------------------------------------------------------- #
class Candidate(Base):
    __tablename__ = "candidates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    public_id = Column(String(32), unique=True, index=True)
    name = Column(String(200), default="")
    email = Column(String(200), unique=True, index=True)
    password_salt = Column(String(64), default="")
    password_hash = Column(String(128), default="")
    pfp_path = Column(String(400), default="")         # profile picture on disk
    resume_path = Column(String(400), default="")      # uploaded CV on disk
    resume_filename = Column(String(250), default="")
    resume_text = Column(Text, default="")             # extracted CV text
    resume_email = Column(String(200), default="")     # contact email found in the CV
    resume_parsed = Column(Text, default="{}")         # json: skills, roles, …
    voice_path = Column(String(400), default="")       # 20s voice test on disk
    aadhaar_id = Column(String(20), default="")        # 12-digit UID (masked in API)
    created_at = Column(DateTime, default=_now)
    last_login_at = Column(DateTime, nullable=True)


# --------------------------------------------------------------------------- #
# Candidate session
# --------------------------------------------------------------------------- #
class InterviewSession(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    public_id = Column(String(40), unique=True, index=True)
    interview_id = Column(Integer, ForeignKey("interviews.id"), index=True)
    candidate_name = Column(String(200), default="")
    candidate_email = Column(String(200), default="")

    status = Column(String(20), default="onboarding")   # onboarding|in_progress|completed|abandoned
    created_at = Column(DateTime, default=_now)
    started_at = Column(DateTime, nullable=True)
    ended_at = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, default=0)

    pair_token = Column(String(64), unique=True, index=True)   # secondary camera
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=True)
    consent_recording = Column(Boolean, default=False)
    consent_proctoring = Column(Boolean, default=False)
    device_check = Column(Text, default="{}")                   # json
    recording_path = Column(String(400), default="")

    # recruiter shortlist + invitation
    shortlisted = Column(Boolean, default=False)
    meeting_at = Column(DateTime, nullable=True)
    meeting_minutes = Column(Integer, default=45)
    invite_email = Column(String(200), default="")     # where the invite went
    invite_status = Column(String(40), default="")     # sent|outbox|failed:…
    invite_sent_at = Column(DateTime, nullable=True)

    # human integrity review: suspicion flags judged by the recruiter, which
    # adjust the reported score (the raw AI score is kept alongside it)
    integrity_verdict = Column(String(20), default="")   # clean|review|suspicious
    integrity_penalty = Column(Integer, default=0)        # points off the overall score
    integrity_note = Column(Text, default="")
    # recruiter decision on the automatic veto: "" (none) | reinstated | rejected
    veto_override = Column(String(12), default="")

    # final AI evaluation (json) — filled on completion
    evaluation = Column(Text, default="")
    evaluation_status = Column(String(20), default="pending")   # pending|running|done|failed
    recruiter_notes = Column(Text, default="")

    interview = relationship("Interview", back_populates="sessions")
    candidate = relationship("Candidate")
    answers = relationship("Answer", back_populates="session",
                           cascade="all, delete-orphan",
                           order_by="Answer.position")
    incidents = relationship("Incident", back_populates="session",
                             cascade="all, delete-orphan",
                             order_by="Incident.ts_ms")


class Answer(Base):
    __tablename__ = "answers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), index=True)
    position = Column(Integer, default=0)
    question_text = Column(Text, default="")
    category = Column(String(40), default="")

    transcript = Column(Text, default="")
    status = Column(String(20), default="pending")   # pending|answered|skipped|unanswered|followup
    is_followup = Column(Boolean, default=False)
    parent_answer_id = Column(Integer, ForeignKey("answers.id"), nullable=True)

    started_at = Column(DateTime, nullable=True)
    answered_at = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, default=0)
    char_count = Column(Integer, default=0)

    score = Column(Integer, nullable=True)           # 1..5
    score_json = Column(Text, default="")            # rubric detail

    session = relationship("InterviewSession", back_populates="answers")
    parent = relationship("Answer", remote_side=[id])


class Incident(Base):
    __tablename__ = "incidents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), index=True)
    ts_ms = Column(Integer, default=0)                 # ms since session start
    wall_time = Column(DateTime, default=_now)
    type = Column(String(50), default="")              # face_absent | multiple_faces | ...
    severity = Column(String(20), default="info")      # info|warning|high
    observed = Column(Text, default="")                # FACT: what the sensor saw
    inference = Column(Text, default="")               # INFERENCE: possible meaning
    value = Column(String(60), default="")             # e.g. "2 faces for 4.2s"
    duration_ms = Column(Integer, default=0)
    evidence_jpeg = Column(LargeBinary, nullable=True)
    evidence_mime = Column(String(40), default="image/jpeg")
    acknowledged = Column(Boolean, default=False)
    reviewer_note = Column(Text, default="")

    session = relationship("InterviewSession", back_populates="incidents")


# --------------------------------------------------------------------------- #
# Engine / session factory
# --------------------------------------------------------------------------- #
def _connect_args() -> dict:
    return {"check_same_thread": False}


engine = None
SessionLocal = sessionmaker(autocommit=False, autoflush=False)


def init_db() -> None:
    global engine
    from sqlalchemy import create_engine

    engine = create_engine(
        f"sqlite:///{DB_PATH}", connect_args=_connect_args(), future=True
    )
    SessionLocal.configure(bind=engine)
    Base.metadata.create_all(engine)
    _migrate(engine)


def _migrate(eng) -> None:
    """Additive-only schema upgrades for databases created before these columns."""
    from sqlalchemy import text

    wanted = {
        "sessions": {
            "candidate_id": "INTEGER",
            "shortlisted": "BOOLEAN DEFAULT 0",
            "meeting_at": "DATETIME",
            "meeting_minutes": "INTEGER DEFAULT 45",
            "invite_email": "VARCHAR(200) DEFAULT ''",
            "invite_status": "VARCHAR(40) DEFAULT ''",
            "invite_sent_at": "DATETIME",
            "integrity_verdict": "VARCHAR(20) DEFAULT ''",
            "integrity_penalty": "INTEGER DEFAULT 0",
            "integrity_note": "TEXT DEFAULT ''",
            "veto_override": "VARCHAR(12) DEFAULT ''",
        },
        "interviews": {
            "score_weights": "TEXT DEFAULT ''",
        },
        "candidates": {
            "resume_path": "VARCHAR(400) DEFAULT ''",
            "resume_filename": "VARCHAR(250) DEFAULT ''",
            "resume_text": "TEXT DEFAULT ''",
            "resume_email": "VARCHAR(200) DEFAULT ''",
            "resume_parsed": "TEXT DEFAULT '{}'",
            "voice_path": "VARCHAR(400) DEFAULT ''",
            "aadhaar_id": "VARCHAR(20) DEFAULT ''",
        },
    }
    with eng.connect() as conn:
        for table, cols in wanted.items():
            existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            for name, ddl in cols.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
            conn.commit()


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
