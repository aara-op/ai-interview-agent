"""FastAPI application entry point for the AI Video Interview Agent."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import llm
from .config import DEFAULT_QUESTION_COUNT
from .db import init_db
from .routers import candidates, dashboard, interviews, proctoring, rtc, sessions

APP_VERSION = "0.1.0"

app = FastAPI(
    title="AI Video Interview Agent",
    version=APP_VERSION,
    description="Autonomous AI interviewer with intelligent proctoring.",
)

# Vite dev server runs on another origin during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(interviews.router)
app.include_router(sessions.router)
app.include_router(candidates.router)
app.include_router(dashboard.router)
app.include_router(proctoring.router)
app.include_router(rtc.router)


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "version": APP_VERSION,
        "llm": llm.status(),
        "default_question_count": DEFAULT_QUESTION_COUNT,
    }


from fastapi.responses import FileResponse

# Serve the built SPA when frontend/dist exists (single-server demo mode).
_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _DIST.is_dir():
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = _DIST / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_DIST / "index.html")
