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
    if not data:
        return ""
    name = (filename or "").lower()

    # 1. PDF detection (by extension or %PDF magic marker anywhere in first 1024 bytes)
    if name.endswith(".pdf") or b"%PDF" in data[:1024]:
        txt = _pdf_text(data)
        if txt.strip():
            return txt

    # 2. DOCX detection (by extension or ZIP magic marker PK)
    if name.endswith(".docx") or (data[:2] == b"PK" and b"word/" in data[:4096]):
        txt = _docx_text(data)
        if txt.strip():
            return txt

    # 3. Binary Word DOC (Word 97-2003 OLE format)
    if name.endswith(".doc") or data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        txt = _doc_binary_text(data)
        if txt.strip():
            return txt

    # 4. Rich Text Format (RTF)
    if name.endswith(".rtf") or data[:5] == b"{\\rtf":
        txt = _rtf_text(data)
        if txt.strip():
            return txt

    # 5. Plain text with common encodings
    for encoding in ("utf-8", "utf-16", "utf-16-le", "latin-1", "cp1252"):
        try:
            decoded = data.decode(encoding)
            letters = sum(1 for c in decoded if c.isalpha())
            if letters > 20:
                return decoded.strip()
        except Exception:
            continue

    # 6. Raw printable character extraction fallback
    try:
        strings = re.findall(rb"[\x20-\x7e\r\n\t]{4,}", data)
        extracted = "\n".join(s.decode("latin-1", errors="ignore") for s in strings)
        if len(extracted.strip()) > 25:
            return extracted.strip()
    except Exception:
        pass

    return ""


def _pdf_text(data: bytes) -> str:
    parts: list[str] = []

    # Strategy 1: PyMuPDF (fitz) - industry gold standard for complex layouts, CMap, and fonts
    try:
        import pymupdf
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            if doc.is_encrypted:
                try:
                    doc.authenticate("")
                except Exception:
                    pass
            for page in doc:
                t = page.get_text("text") or ""
                if not t.strip():
                    # Try blocks mode
                    blocks = page.get_text("blocks") or []
                    t = "\n".join(b[4] for b in blocks if len(b) > 4 and isinstance(b[4], str))
                if not t.strip():
                    # Try words mode
                    words = page.get_text("words") or []
                    t = " ".join(w[4] for w in words if len(w) > 4 and isinstance(w[4], str))
                if t.strip():
                    parts.append(t.strip())

            # Check for form fields/widgets
            if not "".join(parts).strip():
                for page in doc:
                    for widget in page.widgets():
                        if widget.field_value:
                            parts.append(str(widget.field_value))

            # Metadata fallback
            if not "".join(parts).strip() and doc.metadata:
                meta = [f"{k}: {v}" for k, v in doc.metadata.items() if v]
                if meta:
                    parts.append("\n".join(meta))
    except Exception:
        pass

    res = "\n\n".join(parts).strip()
    if res:
        return res

    # Strategy 2: pypdf fallback (layout and standard extraction)
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                pass
        for page in reader.pages:
            try:
                t = page.extract_text(extraction_mode="layout") or page.extract_text() or ""
                if t.strip():
                    parts.append(t.strip())
            except Exception:
                try:
                    t = page.extract_text() or ""
                    if t.strip():
                        parts.append(t.strip())
                except Exception:
                    pass

        # Check fields
        try:
            fields = reader.get_fields() or {}
            for field_name, field in fields.items():
                val = field.get("/V")
                if val:
                    parts.append(f"{field_name}: {val}")
        except Exception:
            pass
    except Exception:
        pass

    res = "\n\n".join(parts).strip()
    if res:
        return res

    # Strategy 3: Raw PDF stream decompression for uncompressed/FlateDecode text streams
    try:
        import zlib
        for stream_match in re.finditer(rb"stream[\r\n]+(.*?)[\r\n]+endstream", data, re.DOTALL):
            stream_data = stream_match.group(1)
            decompressed = None
            for wbits in (0, 15, -15, 32):
                try:
                    decompressed = zlib.decompress(stream_data, wbits)
                    break
                except Exception:
                    continue
            if decompressed is None:
                decompressed = stream_data

            matches = re.findall(rb"\((.*?)\)", decompressed)
            for m in matches:
                try:
                    s = m.decode("utf-8", errors="ignore").strip()
                    if len(s) > 2 and any(c.isalnum() for c in s):
                        parts.append(s)
                except Exception:
                    pass
    except Exception:
        pass

    return "\n".join(parts).strip()


def _docx_text(data: bytes) -> str:
    parts: list[str] = []

    # 1. Standard python-docx paragraphs, tables, and headers/footers
    try:
        from docx import Document
        doc = Document(io.BytesIO(data))
        for p in doc.paragraphs:
            if p.text.strip():
                parts.append(p.text.strip())
        for table in doc.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        for section in doc.sections:
            try:
                for hp in section.header.paragraphs:
                    if hp.text.strip():
                        parts.append(hp.text.strip())
                for fp in section.footer.paragraphs:
                    if fp.text.strip():
                        parts.append(fp.text.strip())
            except Exception:
                pass
    except Exception:
        pass

    # 2. Deep XML extraction: catches text boxes (<w:txbxContent>), shapes, and sidebars
    try:
        import zipfile
        import xml.etree.ElementTree as ET
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml_parts = []
            for item in z.namelist():
                if item.startswith("word/") and item.endswith(".xml"):
                    try:
                        content = z.read(item)
                        tree = ET.fromstring(content)
                        for node in tree.iter():
                            if node.tag.endswith("}t") and node.text and node.text.strip():
                                xml_parts.append(node.text.strip())
                    except Exception:
                        continue
            xml_text = " ".join(xml_parts).strip()
            # If standard docx parser extracted less text than XML (common with textboxes)
            if len(xml_text) > len("\n".join(parts)):
                return xml_text
    except Exception:
        pass

    return "\n".join(parts).strip()


def _doc_binary_text(data: bytes) -> str:
    """Extract readable text chunks from legacy Word 97-2003 (.doc) binary streams."""
    try:
        utf16_matches = re.findall(rb"(?:[\x20-\x7e]\x00){4,}", data)
        ascii_matches = re.findall(rb"[\x20-\x7e\r\n\t]{4,}", data)
        extracted: list[str] = []
        for m in utf16_matches:
            try:
                s = m.decode("utf-16le", errors="ignore").strip()
                if len(s) > 3:
                    extracted.append(s)
            except Exception:
                pass
        for m in ascii_matches:
            try:
                s = m.decode("latin-1", errors="ignore").strip()
                if len(s) > 3 and any(c.isalnum() for c in s):
                    extracted.append(s)
            except Exception:
                pass
        return "\n".join(extracted).strip()
    except Exception:
        return ""


def _rtf_text(data: bytes) -> str:
    """Extract readable text from RTF documents."""
    try:
        text = data.decode("latin-1", errors="ignore")
        text = re.sub(r"\\[a-z0-9]+-?[0-9]*\s?", " ", text)
        text = re.sub(r"[{}]", "", text)
        return " ".join(text.split()).strip()
    except Exception:
        return ""


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
