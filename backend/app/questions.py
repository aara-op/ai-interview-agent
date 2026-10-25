"""AI interview question generation.

Builds a question set from the job description + candidate resume, matched by
skill overlap (JD requirements vs resume evidence), with difficulty variation,
category coverage, de-duplication, and a deterministic offline fallback so the
prototype always produces a usable set of N questions (default 10).
"""
from __future__ import annotations

import json
import random
import re
from collections import Counter
from typing import Any, Dict, List

from . import llm
from .resume import SKILL_VOCAB

DEFAULT_COUNT = 10

CATEGORIES = ["technical", "experience", "behavioral", "scenario"]

CATEGORY_HINT = {
    "technical": "tests concrete technical depth on a specific skill",
    "experience": "explores what the candidate actually did in a past role",
    "behavioral": "a workplace-behaviour scenario told from a corporate "
                   "behaviour trainer's perspective (conflict, collaboration, "
                   "ethics, communication under pressure)",
    "scenario": "presents a hypothetical work situation to solve",
}

# --------------------------------------------------------------------------- #
# Warm-up (ice-breaker) questions
#
# Asked BEFORE the recruiter's configured set (default 10) to make the
# candidate comfortable. They live outside `question_count` and are never
# scored — the evaluation engine skips category "icebreaker" entirely.
# --------------------------------------------------------------------------- #
WARMUP_COUNT = 2

ICEBREAKER_SYSTEM = """You are the BEHAVIORAL_AGENT of NEMOTRON-ORCHESTRATOR:
Elite Corporate Leadership & Psychology Coach. You open interviews as a warm,
friendly corporate behaviour trainer. Given the role (and optionally the
candidate's name), write the short ice-breaker questions to ask at the very
START of a video interview (Phase 1), before the scored core questions, so the
candidate settles in, their nervousness normalises, and their speech baseline
is established.

Rules:
- 1-2 light, warm, professional questions; answerable by anyone.
- Never ask for information already given in the resume.
- Do not reference or preview the scored part of the interview.
- Ask exactly the number requested; no repeats.

Return ONLY JSON:
{"questions": [{"text": "...", "skill_target": "rapport", "rationale": "why this opens well"}]}"""


def _offline_icebreakers(ctx: dict, count: int) -> List[dict]:
    """Deterministic warm-up pool (no API key required)."""
    role = (ctx.get("job_title") or "this role").strip()
    pool = [
        ("To start casually — tell me a little about yourself and what first "
         "drew you to work in this field.",
         "Low-pressure opener; lets the candidate hear their own voice."),
        (f"What interested you about the {role} role, and what are you hoping "
         f"your next position will give you?",
         "Motivation question with no wrong answer; builds early rapport."),
        ("Take a breath and settle in — is there anything you'd like to know "
         "about how this interview will run before we start?",
         "Gives the candidate a moment of control before the main set."),
        ("Describe your ideal working day in a sentence or two.",
         "Light, opinion-based warm-up with no right answer."),
        ("Tell me about something you enjoyed working on recently — just what "
         "made it enjoyable.",
         "Easy storytelling prompt to warm up speaking."),
    ]
    return [
        {"text": text, "category": "icebreaker", "difficulty": "easy",
         "skill_target": "rapport", "rationale": why}
        for text, why in pool[:count]
    ]


def generate_icebreakers(ctx: dict, count: int = WARMUP_COUNT) -> List[dict]:
    """Return `count` friendly opening questions (category "icebreaker")."""
    count = max(1, min(int(count or WARMUP_COUNT), 6))
    out: List[dict] = []
    if llm.LLM_ENABLED:
        try:
            prompt = json.dumps({
                "job_title": ctx.get("job_title"),
                "candidate_name": ctx.get("candidate_name") or "",
                "count": count,
            }, ensure_ascii=False)
            res = llm.chat_json(ICEBREAKER_SYSTEM, prompt,
                                temperature=0.7, max_tokens=900)
            for raw in res.get("questions") or []:
                text = (raw.get("text") or "").strip()
                if not text:
                    continue
                out.append({
                    "text": text,
                    "category": "icebreaker",
                    "difficulty": "easy",
                    "skill_target": (raw.get("skill_target") or "rapport")[:120],
                    "rationale": (raw.get("rationale") or "")[:300],
                })
        except llm.LLMError:
            out = []
    for extra in _offline_icebreakers(ctx, count):
        if len(out) >= count:
            break
        if not is_duplicate(extra, out):
            out.append(extra)
    return out[:count]


# --------------------------------------------------------------------------- #
# Matching JD requirements against resume evidence
# --------------------------------------------------------------------------- #
def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9+#. ]", "", (s or "").lower()).strip()


def match_skills(required: List[str], candidate: List[str]) -> dict:
    req = {_norm(s): s for s in required if s}
    cand = {_norm(s): s for s in candidate if s}
    matched, gaps = [], []
    for key, original in req.items():
        hit = key in cand or any(key in c or c in key for c in cand if len(c) > 2)
        (matched if hit else gaps).append(original)
    extras = [v for k, v in cand.items() if k not in req]
    return {"matched": matched, "gaps": gaps, "extras": extras}


# --------------------------------------------------------------------------- #
# Generation
# --------------------------------------------------------------------------- #
GEN_SYSTEM = """You are the TECHNICAL_AGENT of NEMOTRON-ORCHESTRATOR:
Principal Software Architect & Technical Assessor. You work alongside the
BEHAVIORAL_AGENT (corporate leadership & psychology coach) under one
orchestrator, and you produce evidence-backed assessments with zero tolerance
for hallucination.

Given a job description summary and a candidate resume summary, write interview
questions tailored to BOTH: the skills the role requires and the experience the
candidate actually claims.

Return ONLY JSON:
{
  "questions": [
    {
      "text": "the question, self-contained and specific",
      "category": "technical|experience|behavioral|scenario",
      "difficulty": "easy|medium|hard",
      "skill_target": "the primary skill or competency probed",
      "rationale": "one sentence: why this question for THIS candidate"
    }
  ]
}

Rules:
- Ask exactly the number of questions requested.
- Never repeat or near-repeat a question.
- Respect the requested category quota: the technical/experience/scenario
  questions (TECHNICAL_AGENT's share) outweigh the behavioural ones
  (BEHAVIORAL_AGENT's share).
- Behavioural questions must be scenario-based STAR prompts (Situation, Task,
  Action, Result) covering conflict, ownership and ethics, written from the
  perspective of a corporate behaviour trainer — never generic opinion polls.
- Among the technical questions include EXACTLY ONE interactive
  pseudocode/debugging round: put a short code snippet in a fenced ``` block
  inside the question text; the candidate will dictate their steps aloud.
- Draw on concrete resume details (projects, past roles, named technologies)
  and on gaps between what the job needs and what the resume shows.
- Mix difficulties according to the requested difficulty setting.
- Do not ask for information already given in the resume without probing depth.
- Plain interview language, no preamble, no markdown outside code blocks."""


def _offline_generate(ctx: dict, count: int, categories: List[str],
                      difficulty: str) -> List[dict]:
    """Deterministic template generator (no API key required)."""
    required = ctx.get("required_skills") or []
    matched = ctx.get("matched_skills") or []
    gaps = ctx.get("gap_skills") or []
    extras = ctx.get("candidate_skills") or []
    roles = ctx.get("roles") or []
    projects = ctx.get("projects") or []
    years = ctx.get("years_experience") or 0

    pool: List[dict] = []

    def add(text: str, cat: str, diff: str, skill: str, why: str) -> None:
        pool.append({"text": text, "category": cat, "difficulty": diff,
                     "skill_target": skill, "rationale": why})

    skills_for_q = (matched + gaps + required + extras) or ["software engineering"]
    seen_skills = []
    for s in skills_for_q:
        key = _norm(s)
        if key in seen_skills:
            continue
        seen_skills.append(key)
        add(f"Walk me through how you would design and implement a production "
            f"feature using {s}. What trade-offs would you consider?",
            "technical", "hard" if difficulty == "hard" else "medium", s,
            f"The role requires {s}; checking applied depth rather than recall.")
        add(f"Describe a specific situation where you used {s} and something "
            f"went wrong. How did you diagnose and fix it?",
            "experience", "medium", s,
            f"{s} appears on the resume/job description; probes real usage.")

    if roles:
        r = roles[0]
        title = r.get("title") or "your last role"
        add(f"In your role as {title}, what was the most technically demanding "
            f"problem you owned, and what was your specific contribution?",
            "experience", "medium", "ownership",
            "Resume lists this role; tests depth of personal contribution.")
        add("Tell me about a time you disagreed with a technical decision made "
            "by your team lead. What did you do?",
            "behavioral", "medium", "communication",
            "Standard behavioural probe for collaboration under disagreement.")
    else:
        add("Tell me about the most technically challenging project you have "
            "worked on and your specific role in it.",
            "experience", "medium", "problem-solving",
            "Establishes the candidate's strongest work example.")
        add("Describe a time you had to deliver under a tight deadline with "
            "incomplete requirements. How did you prioritise?",
            "behavioral", "medium", "prioritisation",
            "Behavioural probe relevant to most delivery roles.")

    if projects:
        p = projects[0]
        add(f"Take me through the architecture of '{p[:70]}'. Why did you make "
            f"the choices you did, and what would you change now?",
            "scenario", "hard", "system design",
            "Resume lists this project; probes design reasoning and reflection.")
    else:
        add("A critical service goes down at 2am and users cannot log in. Walk "
            "me through your first fifteen minutes.",
            "scenario", "hard", "incident response",
            "Scenario probe for debugging and incident handling.")

    if gaps:
        add(f"The role calls for {gaps[0]}, which is not prominent on your "
            f"resume. How would you get productive in it, and what do you "
            f"already know that transfers?",
            "scenario", "medium", gaps[0],
            f"{gaps[0]} is required by the job but unproven on the resume.")
        add(f"If you had to deliver something using {gaps[0]} in two weeks "
            f"without prior production experience, what is your plan?",
            "scenario", "hard", gaps[0],
            "Tests learning ability on a required-but-missing skill.")

    add("How do you ensure the quality of code you ship - testing, review, "
        "or monitoring? Give a concrete example of a defect that escaped.",
        "behavioral", "easy", "quality",
        "Communication and engineering-culture signal.")
    add(f"With {int(years)} years of experience, where do you believe your "
        f"biggest technical blind spot is right now?",
        "behavioral", "easy", "self-awareness",
        "Self-assessment against the candidate's stated experience level.")
    add("Explain a complex technical concept to a non-technical stakeholder "
        "who disagreed with your proposal. How did you land it?",
        "behavioral", "easy", "communication",
        "Communication competency explicitly valued in the job description.")
    add("If you joined this team and inherited a codebase with no tests and "
        "frequent regressions, what would your first month look like?",
        "scenario", "hard", "engineering judgement",
        "Scenario probe combining prioritisation and technical strategy.")

    # category coverage (guard against a pathologically small pool)
    by_cat: Dict[str, List[dict]] = {}
    for q in pool:
        by_cat.setdefault(q["category"], []).append(q)

    # Phase 2 split: fill each category up to its quota, then top up any
    # shortfall round-robin from whatever pool remains.
    quota = category_quota(count, categories)
    chosen: List[dict] = []
    cursors: Dict[str, int] = {}
    for cat, n in quota.items():
        bucket = by_cat.get(cat) or []
        take = min(n, len(bucket))
        chosen.extend(bucket[:take])
        cursors[cat] = take
    progressed = True
    while len(chosen) < count and progressed:
        progressed = False
        for cat in quota:
            bucket = by_cat.get(cat) or []
            if cursors.get(cat, 0) < len(bucket) and len(chosen) < count:
                cand = bucket[cursors[cat]]
                cursors[cat] += 1
                if not is_duplicate(cand, chosen):
                    chosen.append(cand)
                progressed = True

    return chosen[:count]


_PAD_TEMPLATES = [
    ("technical", "medium", "Walk me through the data flow of a feature you "
                      "built with {skill}. Where would you put boundaries and why?"),
    ("technical", "hard", "Suppose {skill} is failing under load in production. "
                          "Describe your debugging process from alert to fix."),
    ("experience", "medium", "Tell me about a time {skill} work you did was "
                             "rejected or reworked. What did you change?"),
    ("scenario", "hard", "You must introduce {skill} into a legacy system with "
                         "no downtime. Lay out your migration plan."),
    ("behavioral", "easy", "How do you keep your {skill} knowledge current, and "
                           "what did you learn recently that changed your approach?"),
    ("scenario", "medium", "A teammate is struggling with {skill} and blocking "
                           "the sprint. How would you handle it?"),
    ("technical", "easy", "Explain how you decide between a simple and a "
                          "clever approach when using {skill}."),
    ("behavioral", "medium", "Describe a time you had to say no to a stakeholder "
                             "because of a technical constraint. What was the outcome?"),
]


def _pad(existing: List[dict], needed: int, categories: List[str]) -> List[dict]:
    """Produce unique filler questions so `count` is always satisfied."""
    anchors = [q.get("skill_target") or "the core stack" for q in existing]
    anchors += ["this stack", "the codebase", "production systems", "the team"]
    wanted = categories or CATEGORIES
    # rotate the template list so each pass starts at a different category
    ordered = [t for c in wanted for t in _PAD_TEMPLATES if t[0] == c]
    ordered += [t for t in _PAD_TEMPLATES if t not in ordered]

    out: List[dict] = []
    i = 0
    while len(out) < needed and i < len(ordered) * 8:
        cat, diff, template = ordered[i % len(ordered)]
        skill = anchors[(i // len(ordered)) % len(anchors)]
        candidate = {"text": template.format(skill=skill), "category": cat,
                     "difficulty": diff, "skill_target": skill,
                     "rationale": "Generated to reach the configured question "
                                  "count without repeating existing questions."}
        if not is_duplicate(candidate, existing + out):
            out.append(candidate)
        i += 1
    return out


def category_quota(count: int, categories: List[str]) -> Dict[str, int]:
    """Phase 2 split: ~6-7 technical/resume/systems + 3-4 behavioural STAR.

    Behavioural takes ~35% of the core set (spec: 3-4 of 10); the remainder is
    spread over technical, experience and scenario with technical dominant.
    """
    wanted = [c for c in (categories or CATEGORIES) if c in CATEGORIES] or CATEGORIES
    behavioural = max(1, round(count * 0.35))
    behavioural = behavioural if "behavioral" in wanted else 0
    rest = max(0, count - behavioural)
    technical = round(rest * 0.55)
    experience = round(rest * 0.25)
    scenario = rest - technical - experience
    quota = {"technical": technical, "experience": experience,
             "scenario": scenario, "behavioral": behavioural}
    # drop categories the recruiter excluded, push their share back to the rest
    removed = [c for c in quota if c not in wanted]
    for c in removed:
        share = quota.pop(c)
        if quota:
            quota["technical"] = quota.get("technical", 0) + share
    total = sum(quota.values()) or count
    if total != count:                         # rounding safety
        quota["technical"] = quota.get("technical", 0) + (count - total)
    return quota


def generate_questions(ctx: dict, count: int, categories: List[str],
                       difficulty: str) -> List[dict]:
    """Return `count` de-duplicated question dicts."""
    count = max(1, min(int(count or DEFAULT_COUNT), 40))
    categories = [c for c in (categories or CATEGORIES) if c in CATEGORIES] or CATEGORIES
    quota = category_quota(count, categories)
    questions: List[dict] = []

    if llm.LLM_ENABLED:
        try:
            prompt = _build_prompt(ctx, count, categories, difficulty, quota)
            out = llm.chat_json(GEN_SYSTEM, prompt, temperature=0.6, max_tokens=3500)
            for raw in (out.get("questions") or []):
                text = (raw.get("text") or "").strip()
                if not text:
                    continue
                cat = raw.get("category") if raw.get("category") in CATEGORIES \
                    else "technical"
                # enforce the behavioural cap from the quota
                if cat == "behavioral" and \
                        len([q for q in questions if q["category"] == "behavioral"]) \
                        >= quota.get("behavioral", 0):
                    continue
                questions.append({
                    "text": text,
                    "category": cat,
                    "difficulty": raw.get("difficulty")
                    if raw.get("difficulty") in ("easy", "medium", "hard")
                    else "medium",
                    "skill_target": (raw.get("skill_target") or "")[:120],
                    "rationale": (raw.get("rationale") or "")[:400],
                })
        except llm.LLMError:
            questions = []

    # Always top up from the deterministic generator so the configured count is
    # met even when the model returns too few or fails mid-flight.
    fallback = _offline_generate(ctx, count, categories, difficulty)
    questions = dedupe(questions)[:count]
    for extra in fallback:
        if len(questions) >= count:
            break
        if not is_duplicate(extra, questions):
            questions.append(extra)

    # Last resort: guarantee the exact configured count is always produced.
    if len(questions) < count:
        questions.extend(_pad(questions, count - len(questions), categories))

    # Phase 2: exactly one interactive pseudocode/debugging round — the AI
    # displays the snippet, the candidate dictates their steps aloud.
    if not any("```" in q["text"] for q in questions):
        for i, q in enumerate(questions):
            if q["category"] in ("technical", "scenario"):
                questions[i] = {
                    "text": _PSEUDOCODE_QUESTION,
                    "category": "technical",
                    "difficulty": "hard",
                    "skill_target": "pseudocode & debugging",
                    "rationale": "Interactive pseudocode/debugging round: "
                                 "candidate dictates their steps aloud (Phase 2).",
                }
                break

    # Spread behavioural STAR questions through the set instead of a block.
    questions = _interleave(questions)

    for i, q in enumerate(questions):
        q["position"] = i
    return questions[:count]


_PSEUDOCODE_QUESTION = (
    "Interactive logic round — I will show a short pseudocode snippet on "
    "screen. Read it, then dictate your steps aloud: what it does, the bug "
    "if any, and how you would fix and test it.\n```\n"
    "function sumEven(nums) {\n"
    "  let total = 0\n"
    "  for (let i = 0; i <= nums.length; i++) {\n"
    "    if (nums[i] % 2 === 0) total += nums[i]\n"
    "  }\n"
    "  return total\n"
    "}\n```"
)


def _interleave(chosen: List[dict]) -> List[dict]:
    """Spread behavioural questions through the set instead of a trailing block."""
    behav = [q for q in chosen if q["category"] == "behavioral"]
    rest = [q for q in chosen if q["category"] != "behavioral"]
    if not behav or not rest:
        return chosen
    out: List[dict] = []
    step = max(2, round((len(rest) + 1) / (len(behav) + 1)))
    bi = 0
    for i, q in enumerate(rest):
        out.append(q)
        if (i + 1) % step == 0 and bi < len(behav):
            out.append(behav[bi])
            bi += 1
    out.extend(behav[bi:])
    return out


def _build_prompt(ctx: dict, count: int, categories: List[str],
                  difficulty: str, quota: Dict[str, int] | None = None) -> str:
    payload = {
        "job": {
            "title": ctx.get("job_title"),
            "description": (ctx.get("job_description") or "")[:3000],
            "required_skills": ctx.get("required_skills") or [],
            "experience_level": ctx.get("experience_level"),
        },
        "candidate": {
            "summary": ctx.get("resume_summary", "")[:900],
            "skills": (ctx.get("candidate_skills") or [])[:40],
            "years_experience": ctx.get("years_experience", 0),
            "roles": (ctx.get("roles") or [])[:4],
            "projects": (ctx.get("projects") or [])[:6],
            "education": (ctx.get("education") or [])[:4],
        },
        "skill_analysis": {
            "required_and_present": ctx.get("matched_skills") or [],
            "required_but_missing": ctx.get("gap_skills") or [],
            "candidate_beyond_role": ctx.get("extras") or [],
        },
        "request": {
            "count": count,
            "categories": categories,
            "category_quota": quota or {},
            "difficulty": difficulty,
        },
    }
    return ("Generate the interview questions for this configuration:\n\n"
            + json.dumps(payload, ensure_ascii=False, indent=2))


# --------------------------------------------------------------------------- #
# De-duplication
# --------------------------------------------------------------------------- #
def _tokens(text: str) -> set:
    return set(re.findall(r"[a-z0-9+#.]+", (text or "").lower()))


def similarity(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    stop = {"the", "a", "an", "you", "your", "of", "to", "in", "and", "for",
            "how", "what", "describe", "tell", "me", "about", "would", "do",
            "does", "is", "are", "with", "on", "it", "that", "this"}
    ta, tb = ta - stop, tb - stop
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def is_duplicate(candidate: dict, existing: List[dict], threshold: float = 0.6) -> bool:
    return any(similarity(candidate["text"], e["text"]) >= threshold
               for e in existing)


def dedupe(questions: List[dict], threshold: float = 0.6) -> List[dict]:
    kept: List[dict] = []
    for q in questions:
        if not is_duplicate(q, kept, threshold):
            kept.append(q)
    return kept


# --------------------------------------------------------------------------- #
# Backup questions (camera interruption reserve, NEMOTRON Phase 2)
# --------------------------------------------------------------------------- #
_BACKUP_TEMPLATES = [
    ("technical", "medium",
     "Backup round: explain how you would design a simple rate limiter for an "
     "API, using {skill} where it fits."),
    ("scenario", "hard",
     "Backup round: production latency doubled right after a deploy. Walk "
     "through your triage and rollback decision, with {skill} in the picture."),
    ("technical", "medium",
     "Backup round: how would you test a {skill} component you could not run "
     "locally?"),
    ("experience", "medium",
     "Backup round: describe the hardest debugging session of your career and "
     "what you took away from it."),
]


def generate_backup(ctx: dict, existing_texts: List[str],
                    count: int = 1) -> List[dict]:
    """Reserve questions deployed after a camera glitch or camera cut.

    Deterministic by design: they must be available instantly while the
    candidate's camera is the thing that failed.
    """
    count = max(1, min(int(count or 1), 2))
    existing = [{"text": t} for t in existing_texts if t]
    anchors = (ctx.get("matched_skills") or ctx.get("required_skills")
               or ["this stack"])
    out: List[dict] = []
    i = 0
    while len(out) < count and i < len(_BACKUP_TEMPLATES) * 6:
        cat, diff, tpl = _BACKUP_TEMPLATES[i % len(_BACKUP_TEMPLATES)]
        skill = anchors[(i // len(_BACKUP_TEMPLATES)) % len(anchors)]
        cand = {
            "text": tpl.format(skill=skill),
            "category": cat,
            "difficulty": diff,
            "skill_target": skill,
            "rationale": "Backup question deployed after a camera interruption "
                         "(camera glitch or cut >5s).",
        }
        if not is_duplicate(cand, existing + out):
            out.append(cand)
        i += 1
    return out[:count]


# --------------------------------------------------------------------------- #
# Follow-up questions
# --------------------------------------------------------------------------- #
# Words that make a useless anchor when quoting the candidate back to themselves.
_FOLLOWUP_STOPWORDS = {
    "about", "after", "again", "also", "another", "because", "been", "before",
    "being", "between", "both", "came", "come", "could", "does", "doing",
    "each", "even", "every", "from", "given", "going", "have", "having",
    "into", "itself", "just", "know", "like", "made", "make", "many", "more",
    "most", "much", "need", "next", "only", "other", "ours", "place", "point",
    "problem", "quite", "really", "same", "seen", "should", "since", "some",
    "somebody", "someone", "something", "still", "such", "take", "than", "that",
    "them", "then", "there", "these", "they", "this", "those", "through",
    "under", "upon", "very", "want", "well", "were", "what", "when", "where",
    "which", "while", "will", "with", "without", "work", "would", "your",
    "yours", "answer", "candidate", "question",
    # weak verbs that make a useless anchor when quoted back to the candidate
    "used", "using", "was", "got", "get", "own", "based", "went", "said",
    "told", "asked", "felt", "looked", "seemed", "became", "tried",
}

MIN_ANSWER_WORDS = 8          # below this an answer was never really captured

# Outcome of judging one submitted answer — the three outcomes the room acts on:
#   complete       -> the task for this question is complete, move on
#   unsatisfactory -> answered, but not good enough: ask a follow-up
#   unclear        -> nothing usable came through: re-ask the same question
VERDICTS = ("complete", "unsatisfactory", "unclear")

ASSESS_SYSTEM = """You are an interviewer reviewing one answer a candidate just
gave. Decide whether it settles the question.

Return ONLY JSON:
{"verdict": "complete|unsatisfactory|unclear", "reason": "one short sentence"}

- "complete": the answer substantively addresses what was asked.
- "unsatisfactory": an answer was given but it is thin, evasive or leaves the
  important part unaddressed.
- "unclear": nothing usable was captured (empty, fragmented, or a few words of
  audio that never formed an answer)."""

_VAGUE_ANSWERS = {
    "i don't know", "i do not know", "dont know", "don't know", "no idea",
    "not sure", "unsure", "nothing", "no", "skip", "pass", "next question",
    "no idea about this", "cannot say", "can't say",
}


def _offline_assess(question: str, text: str, words: int) -> dict:
    """Transparent rule-based verdict when no LLM key is configured."""
    low = " ".join((text or "").lower().split())
    if not low or low in _VAGUE_ANSWERS or any(
            low.startswith(v) and len(low) <= len(v) + 12 for v in _VAGUE_ANSWERS):
        return {"verdict": "unclear",
                "reason": "No usable answer was captured for this question."}
    if words < MIN_ANSWER_WORDS:
        return {"verdict": "unclear",
                "reason": f"Only {words} word(s) transcribed — too thin to be "
                          f"an answer."}
    if words < 30:
        return {"verdict": "unsatisfactory",
                "reason": "Too short to show the depth the question asks for."}
    overlap = len((_tokens(question) - _FOLLOWUP_STOPWORDS) & _tokens(text))
    if overlap == 0 and words < 45:
        return {"verdict": "unsatisfactory",
                "reason": "Does not clearly engage with what was asked."}
    return {"verdict": "complete",
            "reason": "Substantive answer that addresses the question."}


def assess_answer(question: str, transcript: str, category: str = "",
                  difficulty: str = "") -> dict:
    """Classify a submitted answer: complete | unsatisfactory | unclear.

    `category` and `difficulty` describe the genre of the question being
    answered, so the judgement stays anchored to what was actually asked.
    """
    text = (transcript or "").strip()
    words = len(text.split())
    if words < MIN_ANSWER_WORDS:
        return {"verdict": "unclear",
                "reason": "Too little transcribed audio to count as an answer."}
    if llm.LLM_ENABLED:
        try:
            out = llm.chat_json(
                ASSESS_SYSTEM,
                json.dumps({"question": question, "answer": text[:2500],
                            "category": category, "difficulty": difficulty},
                           ensure_ascii=False),
                temperature=0.2, max_tokens=250,
            )
            verdict = (out.get("verdict") or "").strip().lower()
            if verdict in VERDICTS:
                return {"verdict": verdict,
                        "reason": (out.get("reason") or "")[:300]}
        except llm.LLMError:
            pass
    return _offline_assess(question, text, words)


FOLLOWUP_SYSTEM = """You are an interviewer partway through a live interview.
Write ONE short follow-up question that continues the thread with the candidate.

Rules:
- Stay in the SAME genre as the parent question you are given (technical stays
  technical, behavioural stays behavioural, experience stays experience,
  scenario stays scenario). Never change genre.
- Keep the difficulty within one level of the parent question — no huge jumps in
  depth or subject matter.
- Continue ONE step from what the candidate just said, referencing a concrete
  detail from their latest answer or resolving something they left open.
- If earlier follow-ups are given, flow on from the last one: never repeat or
  rephrase them and never reopen an earlier sub-topic.
- Never ask it if the answer was empty. Maximum 30 words. Plain interview
  language, no preamble.

Return ONLY JSON:
{"question": "...", "reason": "why this follow-up",
 "category": "technical|experience|behavioral|scenario"}"""


def _content_tokens(text: str) -> set:
    return {t for t in _tokens(text)
            if len(t) > 3 and t not in _FOLLOWUP_STOPWORDS}


def _contextual(candidate: str, sources: List[str]) -> bool:
    """True when the follow-up still talks about something in this thread."""
    ct = _content_tokens(candidate)
    if not ct:
        return False
    return any(ct & _content_tokens(s) for s in sources if s)


# Genre-locked offline follow-ups: every template stays in the parent
# question's genre, quotes a real word from the candidate's own answer, and
# moves the thread forward by exactly one step.
_OFFLINE_FOLLOWUPS: Dict[str, List[str]] = {
    "technical": [
        'You mentioned "{anchor}". What trade-off did you accept there, and '
        'how did you verify it held up?',
        'Going one level deeper on "{anchor}" — how would you test that part '
        'before it reached production?',
        'What was the hardest detail of "{anchor}" to get right, and why?',
    ],
    "experience": [
        'You mentioned "{anchor}". What was the measurable outcome, and what '
        'would you do differently next time?',
        'How long did that "{anchor}" work take, and whose decision was it to '
        'approach it that way?',
        'What part of the "{anchor}" work did you personally own?',
    ],
    "behavioral": [
        'You mentioned "{anchor}". How did the other people involved react, '
        'and what did you do about it?',
        'What was the outcome for the team afterwards, and what did you learn '
        'from handling "{anchor}" that way?',
        'Looking back, what would you say differently about "{anchor}"?',
    ],
    "scenario": [
        'You mentioned "{anchor}". What would your very next step be, and what '
        'could go wrong there?',
        'How would you tell whether the "{anchor}" approach is working, and '
        'what would make you change course?',
        'If "{anchor}" ran late, which trade-off would you give up first?',
    ],
}

_OFFLINE_FALLBACK = (
    "Can you go one level deeper into that last answer - what specifically "
    "did you do, and what was the measurable outcome?"
)


def generate_followup(question: str, transcript: str, skill: str = "",
                      category: str = "", difficulty: str = "",
                      chain: List[dict] | None = None) -> dict:
    """Return {"question": str, "reason": str} or {} when none is warranted.

    `category`/`difficulty` are the genre of the original question and
    `chain` is every earlier follow-up in this thread (oldest first), so the
    new question keeps the same genre, stays within one difficulty level and
    continues one step after the previous one instead of jumping sideways.
    """
    chain = chain or []
    words = len((transcript or "").split())
    if words < MIN_ANSWER_WORDS:        # too thin to follow up on
        return {}

    genre = category if category in CATEGORIES else ""
    thread_questions = [question] + [str(c.get("question") or "")
                                     for c in chain]
    sources = [transcript, question] + [str(c.get("answer") or "")
                                        for c in chain]

    if llm.LLM_ENABLED:
        try:
            out = llm.chat_json(
                FOLLOWUP_SYSTEM,
                json.dumps({"parent_question": question,
                            "genre": genre or "any",
                            "difficulty": difficulty or "medium",
                            "candidate_answer": transcript[:2500],
                            "skill_target": skill,
                            "earlier_followups": [
                                {"question": c.get("question"),
                                 "answer": (c.get("answer") or "")[:600]}
                                for c in chain]}, ensure_ascii=False),
                temperature=0.5, max_tokens=400,
            )
            q = (out.get("question") or "").strip()
            raw_cat = (out.get("category") or "").strip().lower()
            if q and len(q.split()) <= 40:
                # genre lock: reject anything that changed genre
                if not genre or raw_cat in ("", genre):
                    # must still be about this thread, and not a repeat of it
                    if _contextual(q, sources) and not any(
                            similarity(q, t) >= 0.6 for t in thread_questions):
                        return {"question": q,
                                "reason": (out.get("reason") or "")[:300]}
        except llm.LLMError:
            pass

    # offline / rejected-LLM path: genre-locked template quoting the answer
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9+#.\-]{2,}", transcript or "")
    counts = Counter(
        t.lower() for t in tokens
        if len(t) > 3 and t.lower() not in _FOLLOWUP_STOPWORDS
    )
    anchor = ""
    if skill and re.search(re.escape(skill), transcript or "", re.I):
        anchor = skill.lower()
    elif counts:
        anchor = counts.most_common(1)[0][0]

    templates = _OFFLINE_FOLLOWUPS.get(genre, [_OFFLINE_FALLBACK])
    if not anchor:
        templates = [_OFFLINE_FALLBACK]
    for tpl in templates:
        cand_text = tpl.format(anchor=anchor) if "{anchor}" in tpl else tpl
        cand = {"text": cand_text}
        if not is_duplicate(cand, [{"text": t} for t in thread_questions]):
            return {"question": cand_text,
                    "reason": f"Offline heuristic ({genre or 'generic'}): "
                              f"one step deeper on a detail of the answer."}
    return {"question": _OFFLINE_FALLBACK,
            "reason": "Offline heuristic: one step deeper on the last answer."}
