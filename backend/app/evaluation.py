"""AI candidate evaluation against a configurable rubric.

Scores each answer 1-5 with evidence quoted from the transcript, assesses
technical knowledge / problem-solving / communication / role fit separately,
and produces strengths, gaps and an overall summary.

Deliberately text-only: no accent, appearance, speaking-rate or facial
expression signals are used (see EVAL_SYSTEM).
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from . import llm

DEFAULT_RUBRIC = {
    "1": "Incorrect or no relevant content",
    "2": "Major gaps; only surface-level understanding",
    "3": "Partially correct; adequate but incomplete",
    "4": "Correct, well-reasoned, with a concrete example",
    "5": "Deep, precise, trade-off aware, evidenced by real experience",
}

DIMENSIONS = ["technical_knowledge", "problem_solving", "communication",
              "role_fit"]

EVAL_SYSTEM = """You are a fair, evidence-based technical hiring assessor.

Score each answer 1-5 using the rubric. Judge ONLY the substance of the written
answer against the job requirements. Never infer anything from accent, typing
speed, appearance, confidence, or length alone - a short but correct answer can
score 5.

For every score you MUST quote a short verbatim fragment of the candidate's
answer as evidence. If the answer is empty or irrelevant, score 1 and say so.

Return ONLY JSON:
{
  "per_question": [
    {
      "answer_id": 1,
      "score": 3,
      "strengths": ["..."],
      "gaps": ["..."],
      "evidence": "verbatim quote from the answer",
      "explanation": "2 sentences: why this score, tied to the quote"
    }
  ],
  "dimension_scores": {
    "technical_knowledge": {"score": 0-5, "comment": "..."},
    "problem_solving":     {"score": 0-5, "comment": "..."},
    "communication":       {"score": 0-5, "comment": "..."},
    "role_fit":            {"score": 0-5, "comment": "..."}
  },
  "strengths": ["..."],
  "knowledge_gaps": ["..."],
  "further_assessment": ["areas a human should probe in the next round"],
  "summary": "4-6 sentence overall assessment",
  "recommendation": "strong_yes|yes|mixed|no|strong_no"
}"""


def _heuristic_per_question(item: dict, rubric: dict) -> dict:
    text = (item.get("transcript") or "").strip()
    words = len(text.split())
    q_tokens = set(re.findall(
        r"[a-z0-9+#.]+",
        (item.get("question") or item.get("question_text") or "").lower()))
    a_tokens = set(re.findall(r"[a-z0-9+#.]+", text.lower()))
    stop = {"the", "a", "an", "you", "your", "of", "to", "in", "and", "for",
            "how", "what", "describe", "tell", "me", "about", "would"}
    overlap = len((q_tokens - stop) & a_tokens)
    if item.get("category") == "followup":
        overlap = max(overlap, 1)

    if words == 0:
        score = 1
        why = "No answer was recorded for this question."
    elif words < 8:
        score = 2
        why = "The answer is too short to demonstrate the required depth."
    elif overlap >= 3 and words >= 30:
        score = 5
        why = "Addresses the question directly with sustained, specific detail."
    elif overlap >= 2 and words >= 25:
        score = 4
        why = "Addresses the question with supporting detail."
    elif words >= 40:
        score = 3
        why = "Substantive answer, though only partly aligned with what was asked."
    elif overlap >= 1:
        score = 3
        why = "On topic but only partially develops the point."
    else:
        score = 2
        why = "The answer does not clearly engage with what was asked."

    return {
        "answer_id": item.get("id"),
        "question": (item.get("question") or item.get("question_text") or "")[:300],
        "category": item.get("category", ""),
        "score": score,
        "strengths": ["Engaged with the question"] if score >= 3 else [],
        "gaps": [] if score >= 3 else ["Insufficient depth or specificity"],
        "evidence": (text[:200] + ("..." if len(text) > 200 else "")) if text else "",
        "explanation": why,
        "rubric_level": rubric.get(str(score), ""),
    }


def evaluate(session: dict, questions: List[dict], answers: List[dict],
             interview: dict, rubric: Dict[str, str] | None = None) -> dict:
    """Return the full evaluation object stored on the session."""
    rubric = rubric or DEFAULT_RUBRIC
    # Warm-up (ice-breaker) answers are excluded from scoring: they exist only
    # to settle the candidate and say nothing about job fit.
    items = [
        {
            "id": a.get("id"),
            "question": a.get("question_text", ""),
            "category": a.get("category", ""),
            "transcript": a.get("transcript", ""),
            "status": a.get("status", ""),
        }
        for a in answers
        if a.get("category") != "icebreaker"
    ]

    ctx = {
        "job_title": interview.get("job_title"),
        "job_description": (interview.get("job_description") or "")[:3000],
        "required_skills": interview.get("required_skills") or [],
        "experience_level": interview.get("experience_level"),
        "candidate": session.get("candidate_name"),
        "rubric": rubric,
        "dimensions": DIMENSIONS,
        "q_and_a": items,
    }

    result: dict | None = None
    if llm.LLM_ENABLED:
        try:
            out = llm.chat_json(EVAL_SYSTEM, json.dumps(ctx, ensure_ascii=False),
                                temperature=0.2, max_tokens=4000)
            result = _normalise(out, items)
        except llm.LLMError:
            result = None

    if result is None:
        result = _offline_evaluate(items, rubric,
                                   interview.get("required_skills") or [])

    result["rubric"] = rubric
    result["scoring_basis"] = (
        "Substance of the written transcript against the job criteria only; "
        "no accent, appearance, speaking-rate or facial-expression signals."
    )
    return result


def _normalise(out: dict, items: List[dict]) -> dict:
    per = {str(p.get("answer_id")): p for p in (out.get("per_question") or [])
           if isinstance(p, dict)}
    normalised = []
    for item in items:
        p = per.get(str(item["id"])) or {}
        score = p.get("score")
        try:
            score = max(1, min(5, int(score)))
        except (TypeError, ValueError):
            score = _heuristic_per_question(item, DEFAULT_RUBRIC)["score"]
        normalised.append({
            "answer_id": item["id"],
            "question": (item.get("question") or item.get("question_text") or "")[:300],
            "category": item.get("category", ""),
            "score": score,
            "strengths": list(p.get("strengths") or [])[:4],
            "gaps": list(p.get("gaps") or [])[:4],
            "evidence": str(p.get("evidence") or "")[:400],
            "explanation": str(p.get("explanation") or "")[:600],
        })

    dims = out.get("dimension_scores") or {}
    dimension_scores = {}
    for d in DIMENSIONS:
        raw = dims.get(d)
        if isinstance(raw, dict):
            try:
                sc = max(0, min(5, int(raw.get("score"))))
            except (TypeError, ValueError):
                sc = 0
            dimension_scores[d] = {"score": sc,
                                   "comment": str(raw.get("comment") or "")[:400]}
        else:
            dimension_scores[d] = {"score": 0, "comment": ""}

    scored = [q["score"] for q in normalised]
    return {
        "per_question": normalised,
        "dimension_scores": dimension_scores,
        "strengths": [str(s) for s in (out.get("strengths") or [])][:8],
        "knowledge_gaps": [str(s) for s in (out.get("knowledge_gaps") or [])][:8],
        "further_assessment": [str(s) for s in (out.get("further_assessment") or [])][:8],
        "summary": str(out.get("summary") or "")[:2000],
        "recommendation": str(out.get("recommendation") or "mixed"),
        "overall_score": round(sum(scored) / len(scored), 2) if scored else 0,
        "engine": "llm",
    }


def _offline_evaluate(items: List[dict], rubric: Dict[str, str],
                      required_skills: List[str] | None = None) -> dict:
    """Rule-based scoring when no LLM key is configured.

    Each dimension is estimated from a different, job-relevant property of the
    transcripts rather than copying one average everywhere:
      communication      - answer length and structure
      problem solving     - reasoning markers in the answers
      technical knowledge - technical answers + skill coverage
      role fit            - overall score + skill coverage
    """
    required_skills = required_skills or []
    per = [_heuristic_per_question(i, rubric) for i in items]
    scored = [p["score"] for p in per]
    overall = round(sum(scored) / len(scored), 2) if scored else 0

    answered = [i for i in items if i["transcript"].strip()]
    gaps = [f"Needs follow-up: {i['question'][:90]}"
            for i in per if i["score"] <= 2]
    strengths = [f"Strong answer: {i['question'][:90]}"
                 for i in per if i["score"] >= 4]

    texts = "\n".join(i["transcript"].lower() for i in answered)

    # --- communication ----------------------------------------------------
    if not answered:
        comm_score, comm_comment = 1, "No recorded answers to assess."
    else:
        avg_words = sum(len(i["transcript"].split()) for i in answered) / len(answered)
        sentences = sum(
            len(re.findall(r"[.!?]", i["transcript"])) for i in answered)
        if avg_words >= 45 and sentences >= 3 * len(answered):
            comm_score = 5
        elif avg_words >= 30:
            comm_score = 4
        elif avg_words >= 18:
            comm_score = 3
        else:
            comm_score = 2
        comm_comment = (
            f"Transcripts average {avg_words:.0f} words per answer with "
            f"{sentences} sentences across {len(answered)} recorded answers; "
            "measured from structure only, not accent or speed."
        )

    # --- problem solving --------------------------------------------------
    markers = ["because", "so that", "first", "then", "root cause", "trade-off",
               "rollback", "measured", "monitor", "risk", "option", "approach",
               "tested", "reproduce", "flag", "retries", "idempot", "deadline",
               "prioriti", "assumption", "rolled out", "rehears"]
    if not answered:
        ps_score, ps_comment = 1, "No recorded answers to assess."
    else:
        hits = sum(sum(m in i["transcript"].lower() for m in markers)
                   for i in answered) / len(answered)
        ps_score = 5 if hits >= 3 else 4 if hits >= 2 else 3 if hits >= 1 else 2
        ps_comment = (
            f"{hits:.1f} reasoning markers (cause/effect, sequencing, trade-offs, "
            "verification) per recorded answer."
        )

    # --- technical knowledge ---------------------------------------------
    tech_items = [p for p in per if p["category"] in ("technical", "scenario")]
    tech_avg = (sum(p["score"] for p in tech_items) / len(tech_items)
                if tech_items else overall)
    skills = [s.strip().lower() for s in required_skills if s.strip()]
    hits_skills = [s for s in skills if s in texts]
    coverage = (len(hits_skills) / len(skills)) if skills else 0.0
    tech_score = max(1, min(5, round(tech_avg * (0.7 + 0.3 * coverage))))
    tech_comment = (
        f"Technical/scenario answers average {tech_avg:.1f}/5; "
        f"{len(hits_skills)} of {len(skills) or 0} required skills mentioned in "
        "the answers."
    )

    # --- role fit ---------------------------------------------------------
    role_score = max(1, min(5, round(overall * 0.7 + coverage * 5 * 0.3)))
    role_comment = (
        f"Overall rubric average {overall}/5 blended with required-skill "
        f"coverage ({len(hits_skills)}/{len(skills) or 0})."
    )

    if not answered:
        recommendation = "no"
    elif overall >= 4:
        recommendation = "yes"
    elif overall >= 3:
        recommendation = "mixed"
    else:
        recommendation = "no"

    return {
        "per_question": per,
        "dimension_scores": {
            "technical_knowledge": {"score": tech_score, "comment": tech_comment},
            "problem_solving": {"score": ps_score, "comment": ps_comment},
            "communication": {"score": comm_score, "comment": comm_comment},
            "role_fit": {"score": role_score, "comment": role_comment},
        },
        "strengths": strengths[:8],
        "knowledge_gaps": gaps[:8],
        "further_assessment": [
            "Probe the lowest-scoring answers in the next round",
            "Verify claimed technologies with a live coding task",
        ],
        "summary": (
            f"The candidate answered {len(answered)} of {len(items)} questions "
            f"with recorded transcripts, giving an average rubric score of "
            f"{overall}/5. Scores are derived from answer substance and "
            f"relevance to each question. Configure OPENAI_API_KEY for "
            f"evidence-quoted, dimension-level assessment."
        ),
        "recommendation": recommendation,
        "overall_score": overall,
        "engine": "offline",
    }
