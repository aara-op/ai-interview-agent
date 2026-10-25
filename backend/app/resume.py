"""Resume / job-description parsing and structured extraction.

PDF and DOCX text extraction is pure-Python (pypdf, python-docx).  The
unstructured -> structured step (skills, experience, education) uses the LLM
when a key is configured, otherwise a deterministic heuristic extractor so the
prototype still runs end to end offline.
"""
from __future__ import annotations

import io
import json
import re
from typing import Any

from . import llm

SKILL_VOCAB = [
    "python", "java", "javascript", "typescript", "c++", "c#", "go", "rust",
    "kotlin", "swift", "ruby", "php", "sql", "mysql", "postgresql", "mongodb",
    "redis", "graphql", "rest", "html", "css", "react", "angular", "vue",
    "node.js", "nodejs", "express", "django", "flask", "fastapi", "spring boot",
    "spring", "microservices", "docker", "kubernetes", "terraform", "aws",
    "azure", "gcp", "ci/cd", "jenkins", "git", "linux", "bash", "pandas",
    "numpy", "tensorflow", "pytorch", "scikit-learn", "machine learning",
    "deep learning", "nlp", "computer vision", "opencv", "data analysis",
    "etl", "spark", "hadoop", "kafka", "rabbitmq", "docker swarm", "nginx",
    "jest", "pytest", "unit testing", "agile", "scrum", "jira", "oauth",
    "jwt", "security", "figma", "redux", "next.js", "svelte", "tailwind",
    "android", "ios", "flutter", "react native", "salesforce", "sap",
    "excel", "powerbi", "tableau", "statistics", "a/b testing",
]


# --------------------------------------------------------------------------- #
# File -> plain text
# --------------------------------------------------------------------------- #
def extract_text(filename: str, data: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith(".pdf") or data[:5] == b"%PDF-":
        return _pdf_text(data)
    if name.endswith(".docx") or data[:2] == b"PK":
        return _docx_text(data)
    # last resort: try utf-8 plain text
    return data.decode("utf-8", errors="ignore")


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = [(page.extract_text() or "") for page in reader.pages]
    return "\n".join(pages).strip()


def _docx_text(data: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(data))
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts).strip()


# --------------------------------------------------------------------------- #
# Structured extraction
# --------------------------------------------------------------------------- #
def _guess_name(text: str) -> str:
    for line in text.splitlines()[:8]:
        line = line.strip()
        if not line or len(line) > 60:
            continue
        if re.match(r"^[A-Za-z][A-Za-z.\' -]{2,40}$", line) and \
           not re.search(r"resume|cv|curriculum|profile|contact|phone|email", line, re.I):
            return line.title()
    return ""


def _guess_contact(text: str) -> tuple[str, str]:
    email = re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text)
    phone = re.search(r"(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){9,12}\d", text)
    return (email.group(0) if email else "", phone.group(0) if phone else "")


def _heuristic_extract(text: str) -> dict:
    lower = text.lower()
    skills = []
    for s in SKILL_VOCAB:
        if re.search(r"(?<![\w.+#-])" + re.escape(s) + r"(?![\w+#-])", lower):
            skills.append(s)

    years = [float(m) for m in re.findall(r"(\d+(?:\.\d+)?)\s*\+?\s*years?", lower)]
    exp_years = max(years) if years else 0.0

    education = []
    for m in re.finditer(
        r"(b\.?e\.?|b\.?tech|bachelor|m\.?tech|master|m\.?s\.?|mba|ph\.?d|"
        r"b\.?sc|m\.?sc|diploma)[^\n]{0,90}", text, re.I):
        education.append(m.group(0).strip(" ,;|-"))

    projects = []
    for m in re.finditer(r"(?:^|\n)\s*(?:#\s*)?(?:project|projects)\s*[:\-]?\s*(.{4,120})",
                         text, re.I):
        projects.append(m.group(1).strip())

    certs = []
    for m in re.finditer(r"(aws certified|google certified|microsoft certified|"
                         r"certified [a-z][^\n,;]{3,60}|[a-z]+ ?certification)",
                         text, re.I):
        certs.append(m.group(0).strip())

    email, phone = _guess_contact(text)
    return {
        "skills": skills[:30],
        "years_experience": exp_years,
        "education": education[:6],
        "projects": projects[:10],
        "certifications": certs[:8],
        "summary_excerpt": " ".join(text.split())[:600],
        "email": email,
        "phone": phone,
        "extraction_method": "heuristic",
    }


EXTRACT_SYSTEM = """You extract structured data from a resume.
Return ONLY a JSON object with these keys:
 skills: string[]          (concrete technical skills/tools found in the resume)
 years_experience: number  (total professional years implied; 0 if unknown)
 education: string[]       (degrees/institutions as written)
 projects: string[]        (notable projects named in the resume)
 certifications: string[]
 experience_roles: [{company, title, duration, highlights[]}]  (max 8)
 summary: string           (3-sentence factual summary of the candidate)
Be literal: only include what the resume actually states. Never invent skills."""


def extract_resume(text: str) -> dict:
    """Resume text -> structured JSON (LLM-backed, heuristic fallback)."""
    if llm.LLM_ENABLED:
        try:
            out = llm.chat_json(EXTRACT_SYSTEM, text[:12000], temperature=0.1)
            base = _heuristic_extract(text)
            for key in ("skills", "education", "projects", "certifications"):
                if not out.get(key):
                    out[key] = base.get(key, [])
            out.setdefault("years_experience", base["years_experience"])
            out.setdefault("experience_roles", [])
            out.setdefault("summary", base["summary_excerpt"][:400])
            out["email"] = base["email"] or out.get("email", "")
            out["phone"] = base["phone"] or out.get("phone", "")
            out["extraction_method"] = "llm"
            return out
        except llm.LLMError:
            pass
    return _heuristic_extract(text)


# --------------------------------------------------------------------------- #
# Job description
# --------------------------------------------------------------------------- #
JD_SYSTEM = """You analyse a job posting. Return ONLY JSON with:
 job_title: string
 required_skills: string[]      (specific, ranked most important first)
 nice_to_have: string[]
 responsibilities: string[]     (max 8)
 experience_level: string       (intern|junior|mid|senior|lead)
 min_years_experience: number
competencies: string[]          (e.g. "system design", "communication")
Do not invent requirements that are not implied by the text."""


def extract_job(text: str, fallback_title: str = "") -> dict:
    if llm.LLM_ENABLED:
        try:
            out = llm.chat_json(JD_SYSTEM, text[:8000], temperature=0.1)
            if isinstance(out, dict) and out.get("required_skills"):
                out.setdefault("job_title", fallback_title)
                out["extraction_method"] = "llm"
                return out
        except llm.LLMError:
            pass
    # heuristic
    skills = [s for s in SKILL_VOCAB if re.search(re.escape(s), text, re.I)]
    return {
        "job_title": fallback_title,
        "required_skills": skills[:20],
        "nice_to_have": [],
        "responsibilities": [],
        "experience_level": "mid",
        "min_years_experience": 0,
        "competencies": [],
        "extraction_method": "heuristic",
    }


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)
