# AI-Powered Video Interview Agent

> **🌐 Live Demo (Cloudflare Edge HTTPS):** [https://sets-request-july-binding.trycloudflare.com](https://sets-request-july-binding.trycloudflare.com)  
> **🌊 3D Instanced Wave Showcase:** [https://sets-request-july-binding.trycloudflare.com/demo](https://sets-request-july-binding.trycloudflare.com/demo)  
> **📊 Recruiter Dashboard:** [https://sets-request-july-binding.trycloudflare.com/dashboard](https://sets-request-july-binding.trycloudflare.com/dashboard)  
> **👤 Candidate Portal:** [https://sets-request-july-binding.trycloudflare.com/candidate](https://sets-request-july-binding.trycloudflare.com/candidate)  
> **🚀 1-Click Permanent Cloud Deployment (24/7 Online):**  
> [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/aara-op/ai-interview-agent)  
> [![Deploy on Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/aara-op/ai-interview-agent&branch=main&name=ai-interview-agent)

An end-to-end prototype of an autonomous AI interviewer: a recruiter configures a
role, uploads a resume and a job description, the agent writes the question set,
a virtual interviewer conducts the interview by voice, a proctoring module logs
timestamped observations from camera/audio/tab, and a scoring engine produces an
evidence-based report that a human reviews and can override.

The emphasis of the brief — *"an integrated, working solution rather than a
standalone chatbot that only generates interview questions"* — is implemented as
one connected lifecycle:

```
configure → parse resume/JD → generate questions → onboard candidate →
AI-led interview (TTS/STT, follow-ups) → proctoring + secondary camera →
evaluation → recruiter report → human decision
```

---

## 1. Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Python 3.9+, FastAPI, SQLAlchemy, SQLite |
| LLM | Any OpenAI-compatible endpoint via `OPENAI_API_KEY` / `OPENAI_BASE_URL` (offline heuristic engine when unset) |
| Document parsing | `pypdf` (PDF), `python-docx` (DOCX) — pure Python |
| Frontend | React 18 + TypeScript, Vite, react-router |
| Speech | Browser Web Speech API — `SpeechSynthesis` (interviewer voice) and `SpeechRecognition` (live transcription) |
| Computer vision | MediaPipe Tasks `FaceLandmarker` (WASM, in-browser) — face count, boxes, head pose |
| Audio analysis | Web Audio API `AnalyserNode` — RMS/peak voice-activity and noise-floor tracking |
| Secondary camera | QR-code pairing token + WebRTC (peer connection over a WebSocket signalling channel) |
| Recording | `MediaRecorder` → uploaded as WebM and stored server-side |

No model training is involved; existing libraries and APIs are integrated, as
the brief allows.

---

## 2. Project layout

```
ai-interview-agent/
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI app, CORS, static recordings
│   │   ├── config.py          # env + data directories
│   │   ├── db.py              # SQLAlchemy models (interview, session, question, answer, incident)
│   │   ├── llm.py             # OpenAI-compatible client + offline flag
│   │   ├── resume.py          # PDF/DOCX text extraction + structured extraction
│   │   ├── questions.py       # question generation, dedupe, follow-ups
│   │   ├── evaluation.py      # rubric scoring, dimensions, evidence quotes
│   │   ├── serializers.py     # ORM → JSON (UTC timestamps tagged Z)
│   │   └── routers/
│   │       ├── interviews.py  # create/configure, resume upload, regenerate, recruiter questions
│   │       ├── candidates.py  # signup: name/email/Aadhaar, photo, resume, 20s voice test
│   │       ├── sessions.py    # onboarding, consent, start, next, answers, follow-ups, complete, report, overrides, recording
│   │       ├── proctoring.py  # incident ingestion + reviewer triage + evidence frames
│   │       └── rtc.py         # WebSocket signalling for the secondary camera
│   ├── smoke_test.py          # 40 end-to-end API checks
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── pages/             # Home (role chooser), CandidateHome, Dashboard, NewInterview,
│   │   │                      # InterviewDetail, Onboarding, Room, Report, Secondary
│   │   ├── proctoring/        # vision.ts (MediaPipe), audio.ts (VAD), engine.ts (event rules)
│   │   ├── api.ts, types.ts, styles.css
│   │   └── speech.d.ts
│   └── scripts/setup-vision.mjs  # vendors WASM + face model into public/
├── samples/                   # sample JD + resume (PDF and DOCX) for the demo
└── scripts/make_samples.py    # regenerates samples/
```

---

## 3. Running it

```bash
# 1. backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # add OPENAI_API_KEY for full AI mode (optional)
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000

# 2. frontend (separate terminal)
cd frontend
npm install
npm run setup:vision          # vendors MediaPipe WASM + face_landmarker model
npm run dev                   # http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to `127.0.0.1:8000`.

**Two dashboards.** The app opens on a role chooser (`/`):

- `/dashboard` — **interviewer view**: an editable organisation profile (name,
  contact email, phone, notes), upcoming meetings with copyable candidate links,
  a resume-judgement table (required skills vs resume skills → match % and missing
  skills, next to the interview score), plus question settings, scores, evidence
  quotes, overrides, proctoring timeline and reports.
- `/candidate` — **candidate view**: sign in or sign up first, then a dashboard
  with personal details, skills read from the resume, the resume itself (view /
  download) and the 20s voice test, the candidate's upcoming interviews with a
  **Join meeting** button, and a box to paste any meeting link or code. From there
  the camera/microphone check leads on to onboarding (rules + consent) and the
  interview room. Candidates never see recruiter screens.

**Demo path (deliverable 9):**

1. Recruiter: *New interview* → paste the JD (or upload [samples/sample_job_description.txt](samples/sample_job_description.txt)),
   upload [samples/sample_resume.pdf](samples/sample_resume.pdf) or the DOCX, set
   question count (default **10**), categories, difficulty, duration, follow-up budget,
   and optionally add recruiter-written questions → *Create interview*.
2. *Create candidate link* → send the candidate the link (or the 16-char code).
   The candidate opens it on their own device at `/candidate`, checks camera and
   mic, reads the rules and ticks consent.
3. Optional: scan the on-screen QR with a phone to attach the secondary camera.
4. Interview runs: the agent speaks each question, listens, transcribes, and asks
   bounded follow-ups; the proctoring panel streams observations.
5. *End interview* → evaluation runs → open the report: scores, evidence quotes,
   proctoring timeline with frames, recruiter overrides and notes.

```bash
# backend end-to-end checks
cd backend && .venv/bin/python smoke_test.py

# frontend type-check + production build
cd frontend && npm run build
```

---

## 4. Architecture notes

### Session state machine
`draft → configured → pending → in_progress → completed → evaluated`, with a
queue of answers (question, category, transcript, status, duration, score).
Follow-ups are inserted into the queue directly after their parent question and
are capped by the recruiter's `max_followups` budget, so the interview never
silently grows longer. Each submitted answer is judged into one of three
outcomes before the queue moves on: **task complete** (advance), **answered but
not satisfactory** (one further follow-up, chained after the previous one and
locked to the original question's genre and difficulty) or **unanswered**
(unclear audio is re-asked up to twice before it is recorded that way).
Reloading the room resumes at the first **pending** question.

### Question generation
Skill/requirement extraction from the JD is matched against the resume evidence
(skills, roles, projects, education, certifications) to target questions. Four
categories — technical, experience, behavioural, scenario — with difficulty
variation, near-duplicate filtering (similarity threshold), recruiter-authored
questions preserved verbatim, and a default count of **10** when the recruiter
does not specify one.

### Proctoring
Runs entirely in the browser and emits **observations**, never verdicts:

| Signal | Source | Event |
| --- | --- | --- |
| Face presence / count | MediaPipe FaceLandmarker | `face_absent`, `multiple_faces`, `face_reacquired` |
| Head orientation | landmark geometry (yaw/pitch estimate) | `gaze_aversion`, `prolonged_gaze_aversion` |
| Voice activity / extra speech | `AnalyserNode` RMS + noise floor | `secondary_voice`, `background_noise`, `silence` |
| Device status | track `ended` + `devicechange` | `camera_lost`, `microphone_lost` |
| Focus | `visibilitychange` | `tab_blur` |

Every event stores `type`, `ts_ms`, wall time, a **what was observed** string, a
cautious **what it may mean** string, duration, severity, and optionally a
captured frame as evidence. Cooldowns prevent event spam, and the vision loop
backs off automatically when inference is expensive. Looking away is explicitlyphrased as *"not evidence of assistance"*: the report is built for human
review, never for automatic disqualification.

The report also derives a **suspicion summary** for that review: a transparent
weighted sum (high = 3 points, warning = 1 point) with every contributing
event timestamped against both the interview clock and the wall clock, plus the
identity/assistance flags (face mismatch, second face, second voice), so the
reviewer can see where to look first. The recruiter then records an **integrity
verdict** (`clean` / `review` / `suspicious`) with an optional 0–3 point penalty
and a note; the report shows the penalised score beside the raw AI score so both
remain auditable. Only the three-warning rule is ever automatic.

### Evaluation
A 1–5 rubric (configurable) per question, plus four dimensions — technical
knowledge, problem solving, communication, role fit — with strengths, knowledge
gaps, suggested further assessment, an overall summary, and a recommendation.
With an LLM key, scores quote verbatim fragments from the transcript as
evidence. Without one, a transparent rule-based engine estimates each dimension
from a different job-relevant property (answer structure, reasoning markers,
technical-question performance, required-skill coverage). Deliberately text-only:
no accent, appearance, speaking-rate or facial-expression signals are used.
Recruiters can override any individual score; the original rationale stays
visible so both remain auditable.

---

## 5. API surface (summary)

```
GET  /api/health
POST /api/interviews                      multipart: JD text or file, resume file, settings
GET  /api/interviews | /api/interviews/{id}
POST /api/interviews/{id}/regenerate      change question count / settings
POST /api/interviews/{id}/questions       add recruiter question
DEL  /api/interviews/{id}/questions/{qid}
POST /api/sessions                        create candidate session
POST /api/sessions/{id}/consent | /start | /complete | /evaluate
GET  /api/sessions/{id}/next              current question + progress counters
POST /api/sessions/{id}/answers/{aid}     submit transcript + status + duration
POST /api/sessions/{id}/followup          bounded contextual follow-up
GET  /api/sessions/{id}/report?evidence=true
PATCH /api/sessions/{id}                  score overrides, recruiter notes, incident ack
POST /api/sessions/{id}/incidents         proctoring ingestion (+ evidence frame)
PATCH /api/sessions/{id}/incidents/{iid}  reviewer triage
POST /api/sessions/{id}/recording | GET /recording
GET  /api/join/{code}                     candidate entry: resolve a session code (or id) → session
GET  /api/sessions/{id}/pair              secondary-camera token
WS   /ws/rtc/{token}                      WebRTC signalling for the second camera
```

---

## 6. Limitations

- **LLM key optional.** Without `OPENAI_API_KEY` the system runs on the offline
  heuristic engine: questions and scores are rule-based and noticeably weaker
  than the LLM path. The UI labels this clearly.
- **Speech quality depends on the browser.** Web Speech API needs Chrome/Edge,
  network access to the browser's speech service, and a working microphone; the
  room always offers *Type instead* as a fallback. Unclear audio is re-asked up
  to twice and only then recorded as unanswered, a dropped transcription
  connection reconnects itself (and pauses the countdown while it is down), and
  a failed save is retried when the link returns — none of these are silently
  scored against the candidate.
- **Head-pose and gaze are approximations** from 2D landmarks, not calibrated
  eye tracking; they are directional signals only. Multi-person detection is
  face-count based and can be fooled by photos or by poor lighting.
- **Heuristic "secondary voice" detection** cannot separate the candidate's own
  voice from another person's; it only flags speech-like energy while the
  candidate is not expected to talk.
- **No authentication.** Anyone with the URL can open an interview; recordings,
  evidence frames and transcripts are stored unencrypted on local disk. Suitable
  for a prototype, not for production candidates.
- **Single-process deployment.** SQLite + in-memory WebRTC signalling means one
  uvicorn process; no horizontal scaling, no live recruiter-side monitoring of a
  running interview (the recruiter sees events after the fact).
- **Secondary camera pairing is best-effort:** both devices must reach the same
  host, and strict mobile browsers may restrict `getUserMedia` over plain HTTP.
- **Time:** per-question countdowns pause during page reloads; duration is wall
  time between start and completion.

## 7. Future enhancements

- Live recruiter view: watch both feeds and the proctoring timeline during the
  interview, with the ability to intervene or inject a question.
- Speaker identification (voice embeddings) to reduce false "extra voice" alerts,
  plus gaze/eye-tracking models for genuinely calibrated attention signals.
- Multi-user auth with roles, per-recruiter access control, encryption at rest,
  retention policies and consent-driven deletion.
- Adaptive questioning policy (difficulty that responds to live performance) and
  calibrated scoring with answer-similarity against the JD rubric.
- Post-interview structured feedback: highlighted evidence clips on the
  recording timeline, side-by-side candidate comparison, export to ATS formats.
- Deployment as containers (API + Postgres + object storage) with a managed
  WebSocket service for multi-instance signalling.

---

## 5. Proctoring rules and scorecard (NEMOTRON spec)

| Rule | Behaviour |
| --- | --- |
| Head turned > 30° for > 7 s | warning (strike) |
| Eyes held in one off-screen direction 5 s, or same direction 3x in 60 s | warning (strike) |
| Tab / window / fullscreen loss | warning (strike) |
| Phone camera stops a second time | warning (strike) |
| 3rd strike | automatic disqualification (evidence sent to recruiter) |
| Extra phone / tablet / laptop / screen in either feed | alert 1 warns, alert 2 disqualifies (`MAX_DEVICE_ALERTS` in `Room.tsx`) |
| > 2 short head turns to the same side in 3 min | `mobile_glance` flag |
| Voice energy with still lips for 1.8 s | `lip_audio_desync` flag |
| Camera frozen / covered / stopped for 5 s | `camera_glitch` -> backup question (max 2, `POST /api/sessions/{id}/backup`) |
| Both cameras compared every 90 s | `environment_match` / `environment_mismatch` flag |
| Face recognition vs enrolment photo | every 10 s |

Flags that are not strikes are shown to the recruiter, not used to disqualify.

**Scorecard** (`GET /api/sessions/{id}/report` -> `scorecard`): Technical /10, Behavioral /5,
Integrity index 0-100 (100 minus 8 per high and 3 per warning incident), and a composite using
the recruiter's weights (set on *New interview*). Integrity < 40 or a disqualification raises the
auto-reject veto; the recruiter can reinstate or confirm it on the report page.

Extra-device detection uses the CenterNet model shipped in `@vladmandic/human`
(`npm run setup:vision` copies it to `public/human/models`).
