"""Proctoring incident ingestion, evidence storage and reviewer triage.

Every record keeps a strict separation between:
  observed  - the factual sensor reading (what was detected, for how long)
  inference - a cautious interpretation offered for HUMAN review
Nothing here produces a "cheating" verdict; the dashboard treats these as
review items only.
"""
from __future__ import annotations

import base64
import json
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import Incident, InterviewSession, get_db
from ..serializers import incident_dict

router = APIRouter(prefix="/api", tags=["proctoring"])

KNOWN_TYPES = {
    "face_absent": "warning",
    "multiple_faces": "high",
    "face_reacquired": "info",
    "gaze_aversion": "warning",
    "prolonged_gaze_aversion": "warning",
    "secondary_voice": "high",
    "background_noise": "info",
    "silence": "info",
    "camera_lost": "high",
    "microphone_lost": "high",
    "tab_blur": "warning",
    "window_blur": "warning",
    "fullscreen_exit": "warning",
    "disqualified": "high",
    "identity_verified": "info",
    "identity_mismatch": "high",
    "vision_unavailable": "warning",
    "posture_aversion": "warning",
    "mobile_glance": "warning",
    "eye_gaze_hold": "warning",
    "camera_glitch": "warning",
    "secondary_camera_unstable": "warning",
    "lip_audio_desync": "high",
    "extra_device": "high",
    "environment_mismatch": "warning",
    "environment_match": "info",
    "calibration": "info",
    "speech_baseline": "info",
    "backup_deployed": "info",
    "secondary_camera_disconnected": "warning",
    "secondary_camera_connected": "info",
    "secondary_multiple_faces": "high",
    "recording_interrupted": "warning",
    "note": "info",
}

# Explicit, plain-language wording so a recruiter never mistakes an observation
# for a verdict.
INFERENCES = {
    "face_absent": "Candidate may have stepped away or lost framing; review the clip.",
    "multiple_faces": "A second person may be present in frame; review the evidence.",
    "gaze_aversion": "Attention moved off-screen; this alone is not evidence of assistance.",
    "prolonged_gaze_aversion": "Sustained off-screen attention; review context before drawing conclusions.",
    "secondary_voice": "Another voice may be audible; review the audio segment.",
    "background_noise": "Unusual audio detected; may be environmental.",
    "silence": "No speech detected for the configured window.",
    "camera_lost": "Camera device became unavailable or was interrupted.",
    "microphone_lost": "Microphone device became unavailable or was interrupted.",
    "tab_blur": "Interview tab lost focus during a response.",
    "window_blur": "The interview window lost focus — the candidate may have switched applications.",
    "fullscreen_exit": "The interview left fullscreen; return to fullscreen to continue.",
    "disqualified": "The warning budget was exceeded; the recruiter reviews the full evidence trail.",
    "posture_aversion": "Sustained off-axis head posture; review the captured frame in context.",
    "eye_gaze_hold": "Eyes held in one off-screen direction past the limit; review the captured frame in context.",
    "camera_glitch": "The camera feed froze or stopped for several seconds; a backup question may have been deployed.",
    "secondary_camera_unstable": "The paired phone camera stopped more than once, which the rules do not allow.",
    "mobile_glance": "Repeated short glances away from the screen; the paired phone may have drawn attention.",
    "lip_audio_desync": "Voice energy while the mouth appeared stationary; verify whether another source was speaking.",
    "extra_device": "An unexpected device appears in frame beyond the allowed laptop and paired phone.",
    "environment_mismatch": "The two camera feeds appear to show different environments; verify before relying on the secondary view.",
    "environment_match": "Both camera feeds are consistent with the same environment.",
    "calibration": "Pre-interview calibration recorded for this session.",
    "speech_baseline": "Speech baseline recorded during the warm-up phase.",
    "backup_deployed": "A backup question was deployed after a camera interruption.",
    "secondary_camera_disconnected": "The paired secondary camera stopped streaming.",
    "secondary_camera_connected": "The paired secondary camera started streaming.",
    "secondary_multiple_faces": "More than one person visible in the secondary view.",
    "recording_interrupted": "Recording was interrupted.",
}


class IncidentIn(BaseModel):
    type: str
    ts_ms: int = 0
    observed: str = ""
    inference: str = ""
    value: str = ""
    duration_ms: int = 0
    severity: Optional[str] = None
    evidence_data_url: Optional[str] = None


def _decode_evidence(data_url: Optional[str]) -> Optional[bytes]:
    if not data_url:
        return None
    m = re.match(r"data:image/(\w+);base64,(.+)$", data_url.strip(), re.S)
    if not m:
        return None
    payload = m.group(2)
    if len(payload) > 900_000:        # ~675 KB binary ceiling per frame
        return None
    try:
        return base64.b64decode(payload)
    except (ValueError, TypeError):
        return None


@router.post("/sessions/{session_id}/incidents")
def log_incident(session_id: int, body: IncidentIn,
                 db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")

    etype = body.type if body.type in KNOWN_TYPES else "note"
    severity = body.severity if body.severity in ("info", "warning", "high") \
        else KNOWN_TYPES.get(etype, "info")

    observed = body.observed.strip() or _default_observation(etype, body.value)
    inference = body.inference.strip() or INFERENCES.get(etype, "")

    inc = Incident(
        session_id=s.id,
        ts_ms=max(0, int(body.ts_ms)),
        wall_time=datetime.utcnow(),
        type=etype,
        severity=severity,
        observed=observed[:1000],
        inference=inference[:600],
        value=(body.value or "")[:120],
        duration_ms=max(0, int(body.duration_ms)),
        evidence_jpeg=_decode_evidence(body.evidence_data_url),
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)
    return incident_dict(inc)


def _default_observation(etype: str, value: str) -> str:
    label = etype.replace("_", " ")
    if value:
        return f"Detected: {label} ({value})."
    return f"Detected: {label}."


@router.get("/sessions/{session_id}/incidents")
def list_incidents(session_id: int, evidence: bool = False,
                   db: Session = Depends(get_db)):
    s = db.get(InterviewSession, session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    return [incident_dict(i, evidence=evidence) for i in s.incidents]


class IncidentPatch(BaseModel):
    acknowledged: Optional[bool] = None
    reviewer_note: Optional[str] = None
    severity: Optional[str] = None


@router.patch("/sessions/{session_id}/incidents/{incident_id}")
def update_incident(session_id: int, incident_id: int, body: IncidentPatch,
                    db: Session = Depends(get_db)):
    inc = db.get(Incident, incident_id)
    if not inc or inc.session_id != session_id:
        raise HTTPException(404, "Incident not found.")
    if body.acknowledged is not None:
        inc.acknowledged = body.acknowledged
    if body.reviewer_note is not None:
        inc.reviewer_note = body.reviewer_note[:500]
    if body.severity in ("info", "warning", "high"):
        inc.severity = body.severity
    db.commit()
    db.refresh(inc)
    return incident_dict(inc)
