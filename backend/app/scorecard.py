"""Post-interview scorecard (NEMOTRON Phase 3).

Turns the per-question rubric scores and the stored proctoring incidents into
the three headline numbers the recruiter dossier shows:

    Technical score   /10   (technical + experience/resume + scenario answers)
    Behavioral score  /5    (behavioral answers)
    Integrity index   0-100 (starts at 100, loses points for stored incidents)

The three are blended with recruiter-set weights into one composite percentage.
Technical and integrity weigh more than behavioral by default, mirroring the
brief ("technical up-up, psychological down, physical up").

The integrity index and the veto are transparent arithmetic over stored
observations, never a model judgement. The veto is a *recommendation to the
human*: the recruiter can reinstate or confirm the rejection, and that decision
is stored next to it.
"""
from __future__ import annotations

import json
from typing import Dict, Iterable, List, Optional

DEFAULT_WEIGHTS: Dict[str, int] = {"technical": 50, "behavioral": 20, "integrity": 30}

BEHAVIORAL_CATEGORIES = {"behavioral"}

# integrity points lost per stored incident
POINTS = {"high": 8, "warning": 3}
VETO_BELOW = 40        # integrity index under this -> automatic-reject flag
REVIEW_BELOW = 70


def parse_weights(raw: Optional[str]) -> Dict[str, int]:
    """Recruiter weights from the stored JSON; falls back to the defaults."""
    try:
        data = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        data = {}
    out = dict(DEFAULT_WEIGHTS)
    if isinstance(data, dict):
        for k in out:
            try:
                v = int(data.get(k))
            except (TypeError, ValueError):
                continue
            if 0 <= v <= 100:
                out[k] = v
    if sum(out.values()) <= 0:
        return dict(DEFAULT_WEIGHTS)
    return out


def encode_weights(technical: int, behavioral: int, integrity: int) -> str:
    vals = {"technical": technical, "behavioral": behavioral,
            "integrity": integrity}
    clean = {k: max(0, min(100, int(v))) for k, v in vals.items()}
    if sum(clean.values()) <= 0:
        return ""
    return json.dumps(clean)


def _mean(xs: List[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def build(evaluation: Optional[dict], answers: Iterable, incidents: Iterable,
          status: str, weights_raw: Optional[str] = "",
          veto_override: str = "") -> dict:
    weights = parse_weights(weights_raw)
    answers = list(answers)
    by_id = {a.id: a for a in answers}

    def root_category(a) -> str:
        seen = set()
        while a is not None and (a.category == "followup" or a.is_followup) \
                and a.parent_answer_id in by_id and a.id not in seen:
            seen.add(a.id)
            a = by_id[a.parent_answer_id]
        return (a.category if a is not None else "") or ""

    # --- per-answer scores (recruiter overrides win over the AI score) ----
    ai_scores: Dict[int, float] = {}
    for p in (evaluation or {}).get("per_question") or []:
        try:
            ai_scores[int(p.get("answer_id"))] = float(p.get("score"))
        except (TypeError, ValueError):
            continue

    tech: List[float] = []
    beh: List[float] = []
    for a in answers:
        if a.category == "icebreaker":
            continue                      # warm-ups are never scored
        score = ai_scores.get(a.id)
        if a.score:                       # set when the recruiter overrode it
            score = float(a.score)
        if score is None:
            if a.status in ("unanswered", "skipped"):
                score = 1.0               # a missed question scores the floor
            else:
                continue
        if root_category(a) in BEHAVIORAL_CATEGORIES:
            beh.append(score)
        else:
            tech.append(score)

    tech_avg, beh_avg = _mean(tech), _mean(beh)
    technical_10 = round(tech_avg * 2, 1) if tech_avg is not None else None
    behavioral_5 = round(beh_avg, 1) if beh_avg is not None else None

    # --- integrity index ---------------------------------------------------
    counts = {"high": 0, "warning": 0}
    lost = 0
    for i in incidents:
        sev = i.severity or "info"
        if sev in POINTS:
            counts[sev] += 1
            lost += POINTS[sev]
    integrity = max(0, 100 - lost)
    if status == "disqualified":
        integrity = min(integrity, 20)

    # --- composite -----------------------------------------------------------
    parts = []
    if technical_10 is not None:
        parts.append((weights["technical"], technical_10 * 10))
    if behavioral_5 is not None:
        parts.append((weights["behavioral"], behavioral_5 * 20))
    parts.append((weights["integrity"], float(integrity)))
    total_w = sum(w for w, _ in parts) or 1
    composite = round(sum(w * v for w, v in parts) / total_w, 1)

    # --- veto ---------------------------------------------------------------
    auto_reject = status == "disqualified" or integrity < VETO_BELOW
    if auto_reject:
        reasons = []
        if status == "disqualified":
            reasons.append("the interview ended in disqualification")
        if integrity < VETO_BELOW:
            reasons.append(f"integrity index {integrity} is under {VETO_BELOW}")
        reason = "Automatic-reject flag: " + " and ".join(reasons) + "."
        decision = "auto_reject"
    elif integrity < REVIEW_BELOW or counts["high"]:
        decision = "review"
        reason = ("Integrity flags need a human look before any hiring decision "
                  f"({counts['high']} high, {counts['warning']} warning).")
    else:
        decision = "clear"
        reason = "No integrity flags that need review."

    final = decision
    if veto_override == "reinstated":
        final = "reinstated"
    elif veto_override == "rejected":
        final = "rejected"

    return {
        "technical_10": technical_10,
        "technical_questions": len(tech),
        "behavioral_5": behavioral_5,
        "behavioral_questions": len(beh),
        "integrity_index": integrity,
        "integrity_counts": counts,
        "composite_pct": composite,
        "weights": weights,
        "veto": {
            "auto_reject": auto_reject,
            "decision": decision,
            "reason": reason,
            "override": veto_override or "",
            "final": final,
            "threshold": VETO_BELOW,
        },
        "basis": (
            "Technical = mean of technical, experience and scenario answers "
            "(x2 to a /10 scale). Behavioral = mean of behavioral answers (/5). "
            f"Integrity index = 100 minus {POINTS['high']} per high and "
            f"{POINTS['warning']} per warning incident. Composite uses the "
            "recruiter's weights. Every deduction is a stored, timestamped "
            "observation; the veto is a recommendation the recruiter can override."
        ),
    }
