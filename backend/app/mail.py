"""Outgoing mail for interview invitations.

Two modes:
  * SMTP configured (SMTP_HOST/PORT/USER/PASS + MAIL_FROM) → real delivery.
  * not configured  → the message is written to ``data/outbox/*.eml`` and
    returned to the caller, so the shortlist → schedule → invite flow can be
    demonstrated end to end without any mail account.
"""
from __future__ import annotations

import smtplib
import secrets
from dataclasses import dataclass
from email.message import EmailMessage
from pathlib import Path
from typing import Optional

from .config import MAIL_FROM, MAIL_ENABLED, OUTBOX_DIR, SMTP_HOST, SMTP_PASS, \
    SMTP_PORT, SMTP_USER


@dataclass
class MailResult:
    status: str                 # sent | outbox | failed:<reason>
    detail: str = ""
    preview: str = ""           # rendered message, useful for demos / dry runs


def _build(to: str, subject: str, text: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = MAIL_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    return msg


def send_mail(to: str, subject: str, text: str) -> MailResult:
    if not to or "@" not in to:
        return MailResult("failed:no-recipient", "No deliverable email address.")

    msg = _build(to, subject, text)

    if not MAIL_ENABLED:
        path = _write_outbox(msg)
        return MailResult("outbox", str(path), preview=text)

    try:
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20) as s:
                if SMTP_USER:
                    s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
                s.ehlo()
                try:
                    s.starttls()
                    s.ehlo()
                except smtplib.SMTPNotSupportedError:
                    pass
                if SMTP_USER:
                    s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        return MailResult("sent", SMTP_HOST, preview=text)
    except Exception as exc:                      # noqa: BLE001 — report any transport error
        # fall back to the outbox so the recruiter still sees the invitation
        path = _write_outbox(msg)
        return MailResult("failed:smtp", f"{exc} (copy kept at {path})",
                          preview=text)


def _write_outbox(msg: EmailMessage) -> Path:
    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTBOX_DIR / f"{secrets.token_hex(6)}.eml"
    path.write_bytes(bytes(msg))
    return path


def invitation_text(*, candidate_name: str, job_title: str, company_line: str,
                    meeting_line: str, link: str, code: str,
                    message: str = "") -> str:
    """Render the invitation body shared by both mail modes."""
    lines = [
        f"Hello {candidate_name},",
        "",
        f"You have been shortlisted for the {job_title} position.",
        "",
        f"Interview meeting: {meeting_line}",
        company_line,
        "",
        "Start your interview here:",
        f"  {link}",
        "",
        f"Interview code: {code}",
        "",
        "Before you begin you will sign in, check your camera and microphone,",
        "and verify your face against the profile photo you enrolled with.",
        "",
    ]
    if message.strip():
        lines += ["From the recruiter:", message.strip(), ""]
    lines += [
        "Good luck!",
        "— Hiring team",
    ]
    return "\n".join(lines)
