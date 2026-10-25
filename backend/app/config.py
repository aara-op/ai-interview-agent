"""Application configuration loaded from environment / .env file."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent          # backend/
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
EVIDENCE_DIR = DATA_DIR / "evidence"
RECORDING_DIR = DATA_DIR / "recordings"
PFP_DIR = DATA_DIR / "pfp"
VOICE_DIR = DATA_DIR / "voice"
OUTBOX_DIR = DATA_DIR / "outbox"
DB_PATH = DATA_DIR / "interview_agent.db"

for _d in (DATA_DIR, UPLOAD_DIR, EVIDENCE_DIR, RECORDING_DIR, PFP_DIR, VOICE_DIR,
           OUTBOX_DIR):
    _d.mkdir(parents=True, exist_ok=True)

load_dotenv(BASE_DIR / ".env")

# --- LLM (OpenAI-compatible endpoint) -------------------------------------
LLM_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
LLM_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").strip()
LLM_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()

# When no key is configured the backend falls back to deterministic offline
# generators so the whole lifecycle can still be demonstrated.
LLM_ENABLED = bool(LLM_API_KEY)

DEFAULT_QUESTION_COUNT = 10          # spec: default of 10 when not specified
DEFAULT_RESPONSE_LIMIT_SECONDS = 90
DEFAULT_INTERVIEW_DURATION_MINUTES = 30
MAX_UPLOAD_MB = 15
MAX_PFP_MB = 4
MAX_VOICE_MB = 12          # ~20s of webm/opus is well under this

# --- recruiter organisation profile (shown on the recruiter dashboard) -----
# Editable in the UI; these are only the starting defaults.
ORG_NAME = os.getenv("ORG_NAME", "").strip()
ORG_EMAIL = os.getenv("ORG_EMAIL", "").strip()
ORG_PHONE = os.getenv("ORG_PHONE", "").strip()

# --- outgoing mail ----------------------------------------------------------
# Without SMTP settings invitations are written to data/outbox instead of being
# sent, so the shortlist → schedule → invite flow can be demonstrated offline.
SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "587") or 587)
SMTP_USER = os.getenv("SMTP_USER", "").strip()
SMTP_PASS = os.getenv("SMTP_PASS", "").strip()
MAIL_FROM = os.getenv("MAIL_FROM", "").strip() or (SMTP_USER or "interviews@localhost")
MAIL_ENABLED = bool(SMTP_HOST)
