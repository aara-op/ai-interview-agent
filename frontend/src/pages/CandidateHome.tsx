import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { type Candidate, type CandidateInterview, type Session } from "../types";
import {
  compareFaces,
  detectFaceQuick,
  embedImageUrl,
  embedVideoFrame,
  embedVideoFrameWithRetries,
  identityStatus,
  type IdentityResult,
} from "../face/match";

const STORE_KEY = "candidate-login";
type Mode = "signin" | "enroll";
type DevState = "idle" | "checking" | "ok" | "fail";

export interface Stored {
  code: string;
  candidate: Candidate;
  sessionId: number;
}

/**
 * The sign-in this browser is holding, or null when nobody has signed in yet.
 * Every candidate-facing route checks this first, so the interview is never
 * reachable before a login (or a sign-up) has happened.
 */
export function storedLogin(): Stored | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const saved: Stored = JSON.parse(raw);
    return saved && saved.candidate && saved.sessionId ? saved : null;
  } catch {
    return null;
  }
}

/** Persist the sign-in so every candidate route recognises it. */
export function saveStoredLogin(
  code: string,
  candidate: Candidate,
  sessionId: number,
): void {
  try {
    sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({ code, candidate, sessionId } satisfies Stored),
    );
  } catch {
    /* storage may be disabled — the server-side binding still applies */
  }
}

/**
 * Candidate dashboard: sign in (or enrol with a profile photo), check the
 * camera and microphone, and verify the live face against the enrolment photo
 * before continuing to onboarding.
 */
export default function CandidateHome() {
  const nav = useNavigate();
  const [search] = useSearchParams();

  // ---- join / account --------------------------------------------------
  const [codeInput, setCodeInput] = useState("");
  const [sessionCode, setSessionCode] = useState("");
  const [resolved, setResolved] = useState<{
    id: number;
    job_title: string;
  } | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [candidate, setCandidate] = useState<Candidate | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [aadhaar, setAadhaar] = useState("");
  const [password, setPassword] = useState("");
  const [pfpDataUrl, setPfpDataUrl] = useState("");
  const [pfpError, setPfpError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

  // ---- signup: resume + 20s voice test --------------------------------
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeError, setResumeError] = useState("");
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceLeft, setVoiceLeft] = useState(0);
  // ---- candidate dashboard ----------------------------------------------
  const [myInterviews, setMyInterviews] = useState<CandidateInterview[]>([]);
  const [myLoading, setMyLoading] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const voiceRecRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<BlobPart[]>([]);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const VOICE_SECONDS = 20;

  // ---- identity --------------------------------------------------------
  const [refEmbedding, setRefEmbedding] = useState<number[] | null>(null);
  const [refState, setRefState] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const [identity, setIdentity] = useState<IdentityResult | null>(null);
  const [verified, setVerified] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);

  // ---- devices ---------------------------------------------------------
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const faceTimerRef = useRef<number | null>(null);
  const [faceDetected, setFaceDetected] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [camState, setCamState] = useState<DevState>("idle");
  const [micState, setMicState] = useState<DevState>("idle");
  const [levelPct, setLevelPct] = useState(0);
  const [deviceInfo, setDeviceInfo] = useState("");
  const [deviceError, setDeviceError] = useState("");

  // ---- arrive from the onboarding link (?code=...) --------------------
  useEffect(() => {
    const incoming = search.get("code");
    if (!incoming) return;
    setCodeInput(incoming);
    setSessionCode(incoming);
    void (async () => {
      try {
        const r = await api.resolveJoin(incoming);
        setResolved({ id: r.id, job_title: r.job_title });
        setMode("enroll");
      } catch {
        setAuthError(
          "No interview matches that code. Check for typos, or ask your recruiter to send a new link.",
        );
      }
    })();
  }, [search]);

  // ---- the candidate's own interviews (dashboard) ------------------------
  useEffect(() => {
    if (!candidate?.id) {
      setMyInterviews([]);
      return;
    }
    let cancelled = false;
    setMyLoading(true);
    api
      .candidateInterviews(candidate.id)
      .then((rows) => {
        if (!cancelled) setMyInterviews(rows);
      })
      .catch(() => {
        if (!cancelled) setMyInterviews([]);
      })
      .finally(() => {
        if (!cancelled) setMyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate?.id]);

  // ---- join by pasted link or code ---------------------------------------
  async function joinByLink() {
    const raw = joinLink.trim();
    if (!raw) return;
    const match = raw.match(/\/join\/([^/?#\s]+)/);
    const key = match ? decodeURIComponent(match[1]) : raw;
    setJoinError("");
    setJoining(true);
    try {
      const r = await api.resolveJoin(key);
      setJoinLink("");
      nav(`/join/${r.id}`);
    } catch {
      setJoinError(
        "That link or code does not match an interview. Ask your recruiter for a new one.",
      );
    } finally {
      setJoining(false);
    }
  }

  // ---- restore a previous sign-in -------------------------------------
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved: Stored = JSON.parse(raw);
      if (!saved?.code || !saved?.candidate) return;
      setSessionCode(saved.code);
      setCodeInput(saved.code);
      setCandidate(saved.candidate);
      setResolved({ id: saved.sessionId, job_title: "" });
      void (async () => {
        try {
          const r = await api.resolveJoin(saved.code);
          setResolved({ id: r.id, job_title: r.job_title });
        } catch {
          /* keep the stored id; onboarding will re-validate */
        }
      })();
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  // ---- reference embedding from the enrolment photo --------------------
  useEffect(() => {
    let cancelled = false;
    if (!candidate?.pfp_url) {
      setRefEmbedding(null);
      setRefState("idle");
      return;
    }
    setRefState("loading");
    setVerified(false);
    setIdentity(null);
    void embedImageUrl(candidate.pfp_url).then((emb) => {
      if (cancelled) return;
      if (emb) {
        setRefEmbedding(emb);
        setRefState("ready");
      } else {
        setRefEmbedding(null);
        setRefState("failed");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [candidate?.pfp_url]);

  // ---- devices ---------------------------------------------------------
  function stopCheck() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (faceTimerRef.current !== null) {
      window.clearInterval(faceTimerRef.current);
      faceTimerRef.current = null;
    }
    setFaceDetected(null);
    try {
      ctxRef.current?.close();
    } catch {
      /* already closed */
    }
    ctxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setChecking(false);
    setCamState("idle");
    setMicState("idle");
    setLevelPct(0);
  }

  useEffect(() => stopCheck, []);

  // stop an in-flight voice test if the page goes away
  useEffect(
    () => () => {
      if (voiceTimerRef.current !== null) window.clearInterval(voiceTimerRef.current);
      voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  // Ensure the video element is always displaying the active stream
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => undefined);
    }
  });

  // Proactively start camera check once signed in so Section 2 is never a dark blank box
  useEffect(() => {
    if (candidate && camState === "idle" && !checking) {
      void startCheck();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate]);

  async function startCheck() {
    setChecking(true);
    setDeviceError("");
    setCamState("checking");
    setMicState("checking");
    setVerified(false);
    setIdentity(null);
    setFaceDetected(null);
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        }
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => undefined);
      }
      const vt = stream.getVideoTracks()[0];
      const s = vt?.getSettings?.();
      setDeviceInfo(
        `${vt?.label || "camera"}${s?.width && s?.height ? ` · ${s.width}×${s.height}` : ""}`,
      );
      setCamState(stream.getVideoTracks().length ? "ok" : "fail");
      setMicState(stream.getAudioTracks().length ? "ok" : "fail");

      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      timerRef.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(
          buf as unknown as Parameters<AnalyserNode["getFloatTimeDomainData"]>[0],
        );
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        setLevelPct(Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 400)));
      }, 120);

      // Real-time face detection tracker for preview tile
      faceTimerRef.current = window.setInterval(async () => {
        if (videoRef.current && videoRef.current.readyState >= 2) {
          const { detected } = await detectFaceQuick(videoRef.current);
          setFaceDetected(detected);
        }
      }, 500);
    } catch (e) {
      setCamState("fail");
      setMicState("fail");
      setChecking(false);
      setDeviceError(
        e instanceof Error && /not allowed|denied/i.test(e.message)
          ? "Camera or microphone permission was blocked. Allow it from the browser's address-bar icon, then try again."
          : "No camera or microphone could be opened on this device.",
      );
    }
  }

  // ---- identity check against the enrolment photo ----------------------
  async function verify() {
    if (!videoRef.current || verifyBusy) return;
    setVerifyBusy(true);
    setIdentity(null);
    try {
      const reference =
        refEmbedding ?? (await embedImageUrl(candidate?.pfp_url ?? ""));
      if (reference && !refEmbedding) setRefEmbedding(reference);
      const { embedding: live } = await embedVideoFrameWithRetries(
        videoRef.current,
        6,
        90,
      );
      const result = compareFaces(reference, live);
      setIdentity(result);
      setVerified(result.match);
      if (result.match) setRefState("ready");
      else if (result.unavailable) setRefState("failed");
    } finally {
      setVerifyBusy(false);
    }
  }

  // ---- join + auth -----------------------------------------------------
  async function resolveCode() {
    const raw = codeInput.trim();
    if (!raw) return;
    const match = raw.match(/\/join\/([^/?#\s]+)/);
    const key = match ? decodeURIComponent(match[1]) : raw;
    setAuthError("");
    try {
      const r = await api.resolveJoin(key);
      setSessionCode(key);
      setResolved({ id: r.id, job_title: r.job_title });
    } catch {
      setAuthError(
        "No interview matches that code. Check for typos, or ask your recruiter to send a new link.",
      );
    }
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionCode) return;
    setAuthError("");
    setAuthBusy(true);
    try {
      let res: { candidate: Candidate; session: Session };
      if (mode === "enroll") {
        const digits = aadhaar.replace(/\D/g, "");
        if (digits.length !== 12) {
          throw new Error("Enter your 12-digit Aadhaar number — it is used to verify your identity for the face check.");
        }
        const form = new FormData();
        form.set("code", sessionCode);
        form.set("name", name);
        form.set("email", email);
        form.set("aadhaar_id", digits);
        form.set("password", password);
        form.set("pfp_data_url", pfpDataUrl);
        if (resumeFile) form.set("resume", resumeFile, resumeFile.name);
        if (voiceBlob) form.set("voice", voiceBlob, "voice-test.webm");
        res = await api.enroll(form);
      } else {
        res = await api.login({ code: sessionCode, email, password });
      }
      setCandidate(res.candidate);
      setResolved({
        id: res.session.id,
        job_title: resolved?.job_title ?? "",
      });
      const stored: Stored = {
        code: sessionCode,
        candidate: res.candidate,
        sessionId: res.session.id,
      };
      saveStoredLogin(stored.code, stored.candidate, stored.sessionId);
      setName("");
      setAadhaar("");
      setPassword("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem(STORE_KEY);
    setCandidate(null);
    setRefEmbedding(null);
    setRefState("idle");
    setVerified(false);
    setIdentity(null);
    setMode("signin");
  }

  function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setPfpError("Choose a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setPfpError("Photo must be under 4 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result);
      setPfpDataUrl(dataUrl);
      setPfpError("");
      try {
        const img = new Image();
        img.src = dataUrl;
        await new Promise((r) => {
          img.onload = () => r(true);
          img.onerror = () => r(false);
        });
        const { detected } = await detectFaceQuick(img);
        if (!detected) {
          setPfpError(
            "Note: Face detection was faint in this photo. For reliable verification, ensure good lighting and a front-facing angle.",
          );
        }
      } catch {
        /* non-fatal pre-check */
      }
    };
    reader.onerror = () => setPfpError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  function onPickResume(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = /\.(pdf|docx)$/i.test(file.name) ||
      file.type === "application/pdf" ||
      file.type.includes("wordprocessingml");
    if (!ok) {
      setResumeError("Resume must be a PDF or DOCX file.");
      setResumeFile(null);
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setResumeError("Resume must be under 15 MB.");
      setResumeFile(null);
      return;
    }
    setResumeFile(file);
    setResumeError("");
  }

  /** 20 second spoken sample, stored with the account for recruiter review. */
  async function startVoiceTest() {
    setVoiceError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      voiceStreamRef.current = stream;
      const rec = new MediaRecorder(stream);
      voiceChunksRef.current = [];
      rec.ondataavailable = (ev) => ev.data.size && voiceChunksRef.current.push(ev.data);
      rec.onstop = () => {
        const blob = new Blob(voiceChunksRef.current, { type: "audio/webm" });
        setVoiceBlob(blob);
        setVoiceUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
        voiceStreamRef.current = null;
      };
      rec.start();
      voiceRecRef.current = rec;
      setVoiceBlob(null);
      setVoiceLeft(VOICE_SECONDS);
      voiceTimerRef.current = window.setInterval(() => {
        setVoiceLeft((v) => {
          if (v <= 1) {
            if (voiceTimerRef.current !== null) {
              window.clearInterval(voiceTimerRef.current);
              voiceTimerRef.current = null;
            }
            if (rec.state === "recording") rec.stop();
            return 0;
          }
          return v - 1;
        });
      }, 1000);
    } catch {
      setVoiceError(
        "Microphone permission is needed for the voice test — allow it and try again.",
      );
    }
  }

  function stopVoiceTest() {
    if (voiceTimerRef.current !== null) {
      window.clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    if (voiceRecRef.current && voiceRecRef.current.state === "recording") {
      voiceRecRef.current.stop();
    }
    setVoiceLeft(0);
  }

  const canContinue =
    !!resolved && verified && camState === "ok" && micState === "ok";

  return (
    <div className="join-shell">
      <div className="join-card" style={{ width: "min(820px, 100%)" }}>
        <div className="card mb">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="eyebrow tiny dim" style={{ letterSpacing: ".1em" }}>
                AI VIDEO INTERVIEW · CANDIDATE
              </div>
              <h1 style={{ marginTop: 4 }}>Candidate dashboard</h1>
              <p className="muted" style={{ margin: 0 }}>
                Sign in, check your camera and microphone, verify your face
                against your profile photo, then start.
              </p>
            </div>
            <span className="brand-mark" style={{ fontSize: 30 }}>
              ◈
            </span>
          </div>
        </div>

        {/* ------------------------------------------------- account card */}
        <div className="card mb">
          <div className="card-title">
            <h2>1 · Your interview & login</h2>
            <Link className="btn btn-sm" to="/">
              Switch view
            </Link>
          </div>

          {!resolved && (
            <label className="field">
              <span>Interview code or link</span>
              <div className="row" style={{ gap: 8 }}>
                <input
                  type="text"
                  value={codeInput}
                  placeholder="e.g. TBeHqkXvauZlo-6W or …/join/7"
                  onChange={(e) => setCodeInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && resolveCode()}
                  style={{ flex: 1, minWidth: 200 }}
                  spellCheck={false}
                />
                <button
                  className="btn btn-primary"
                  onClick={resolveCode}
                  disabled={!codeInput.trim()}
                >
                  Continue
                </button>
              </div>
            </label>
          )}

          {resolved && !candidate && (
            <form onSubmit={submitAuth}>
              <div className="notice">
                <strong>{resolved.job_title || "Interview"}</strong>
                {" — "}
                {mode === "signin"
                  ? "sign in with the login you created."
                  : "create your login and enrol your photo once."}
              </div>

              <div className="row" style={{ gap: 8, marginBottom: 10 }}>
                <button
                  type="button"
                  className={"btn " + (mode === "signin" ? "btn-primary" : "")}
                  onClick={() => setMode("signin")}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className={"btn " + (mode === "enroll" ? "btn-primary" : "")}
                  onClick={() => setMode("enroll")}
                >
                  First time — create login
                </button>
              </div>

              {mode === "enroll" && (
                <>
                  <label className="field">
                    <span>Full name</span>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                    />
                  </label>
                  <label className="field">
                    <span>Aadhaar ID (12 digits) — identity reference for the face check</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="XXXX XXXX XXXX"
                      value={aadhaar}
                      onChange={(e) => setAadhaar(e.target.value)}
                      autoComplete="off"
                    />
                    <span className="tiny dim">
                      Stored with your account and shown to your recruiter only as
                      the last four digits; it is matched against your photo and
                      on-camera identity check.
                    </span>
                  </label>
                  <label className="field">
                    <span>Profile photo — used to verify you on camera</span>
                    <input type="file" accept="image/*" onChange={onPickPhoto} />
                    <span className="tiny dim">
                      A clear, front-facing photo works best. Stored with your
                      account; only used for the on-camera match.
                    </span>
                  </label>
                  {pfpDataUrl && (
                    <div className="row" style={{ gap: 10, alignItems: "center" }}>
                      <img className="avatar lg" src={pfpDataUrl} alt="Your photo" />
                      <span className="tiny dim">
                        This photo becomes the reference for the face check.
                      </span>
                    </div>
                  )}
                  {pfpError && <div className="notice err">{pfpError}</div>}

                  <label className="field">
                    <span>Resume (PDF or DOCX) — used to shortlist you for this role</span>
                    <input type="file" accept=".pdf,.docx" onChange={onPickResume} />
                    {resumeFile && (
                      <span className="tiny dim">
                        {resumeFile.name} · {Math.max(1, Math.round(resumeFile.size / 1024))} KB
                      </span>
                    )}
                  </label>
                  {resumeError && <div className="notice err">{resumeError}</div>}

                  <div className="field">
                    <span>
                      Voice test — {VOICE_SECONDS} seconds{" "}
                      {voiceLeft > 0
                        ? `· recording, ${voiceLeft}s left`
                        : voiceBlob
                          ? "· recorded"
                          : "· not recorded"}
                    </span>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      {voiceLeft > 0 ? (
                        <button type="button" className="btn" onClick={stopVoiceTest}>
                          Stop & keep recording
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={startVoiceTest}
                        >
                          {voiceBlob ? "Retake voice test" : "Start 20s voice test"}
                        </button>
                      )}
                      {voiceLeft > 0 && <span className="badge info">● recording</span>}
                      {voiceBlob && voiceUrl && (
                        <audio controls src={voiceUrl} style={{ maxWidth: 260 }} />
                      )}
                    </div>
                    <span className="tiny dim">
                      Introduce yourself out loud — the recruiter plays this before
                      inviting you. Stop early if you finish sooner.
                    </span>
                  </div>
                  {voiceError && <div className="notice err">{voiceError}</div>}
                </>
              )}

              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </label>
              <label className="field">
                <span>Password {mode === "signin" ? "" : "(6+ characters)"}</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    mode === "signin" ? "current-password" : "new-password"
                  }
                />
              </label>

              {authError && <div className="notice err">{authError}</div>}

              <button
                className="btn btn-primary"
                type="submit"
                disabled={
                  authBusy ||
                  !email.trim() ||
                  password.length < 6 ||
                  (mode === "enroll" &&
                    (!name.trim() ||
                      !pfpDataUrl ||
                      !resumeFile ||
                      !voiceBlob ||
                      aadhaar.replace(/\D/g, "").length !== 12))
                }
              >
                {authBusy
                  ? "Checking…"
                  : mode === "signin"
                    ? "Sign in"
                    : "Create login & photo"}
              </button>
            </form>
          )}

          {resolved && candidate && (
            <div className="row" style={{ gap: 12, alignItems: "center" }}>
              {candidate.pfp_url ? (
                <img
                  className="avatar lg"
                  src={candidate.pfp_url}
                  alt={candidate.name}
                />
              ) : (
                <span className="avatar lg placeholder-avatar">?</span>
              )}
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 650 }}>{candidate.name}</div>
                <div className="tiny dim">
                  {candidate.email} · {resolved.job_title || "Interview"} · code{" "}
                  {sessionCode}
                </div>
                <div className="chips" style={{ marginTop: 6 }}>
                  {candidate.has_resume && (
                    <span className="chip hit">📄 {candidate.resume_filename}</span>
                  )}
                  {candidate.has_voice && <span className="chip hit">🎙 voice test</span>}
                  <span className="chip">{candidate.years_experience} yrs</span>
                  {candidate.skills.slice(0, 8).map((s) => (
                    <span className="chip" key={s}>
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <button className="btn btn-sm" onClick={signOut}>
                Sign out
              </button>
            </div>
          )}

          {authError && !resolved && <div className="notice err">{authError}</div>}
        </div>

        {/* --------------------------------------------------- dashboard */}
        {candidate && resolved && (
          <>
            <div className="grid grid-2 mb">
              <div className="card">
                <div className="card-title">
                  <h2>Personal details</h2>
                  <button className="btn btn-sm" onClick={signOut}>
                    Sign out
                  </button>
                </div>
                <dl className="kv">
                  <dt>Name</dt>
                  <dd>{candidate.name}</dd>
                  <dt>Email</dt>
                  <dd className="wrap-anywhere">{candidate.email}</dd>
                  {candidate.phone && (
                    <>
                      <dt>Phone</dt>
                      <dd>{candidate.phone}</dd>
                    </>
                  )}
                  <dt>Aadhaar</dt>
                  <dd>{candidate.aadhaar_masked || "—"}</dd>
                  <dt>Experience</dt>
                  <dd>{candidate.years_experience ?? 0} years</dd>
                  {(candidate.roles ?? []).length > 0 && (
                    <>
                      <dt>Past roles</dt>
                      <dd>{(candidate.roles ?? []).join(" · ")}</dd>
                    </>
                  )}
                  <dt>Interview code</dt>
                  <dd>{sessionCode}</dd>
                  <dt>Member since</dt>
                  <dd>
                    {candidate.created_at
                      ? new Date(candidate.created_at).toLocaleDateString()
                      : "—"}
                  </dd>
                </dl>
              </div>

              <div className="card">
                <div className="card-title">
                  <h2>Skills from your resume</h2>
                  <span className="badge">{(candidate.skills ?? []).length}</span>
                </div>
                {(candidate.skills ?? []).length ? (
                  <div className="chips">
                    {(candidate.skills ?? []).map((s) => (
                      <span className="chip" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No skills were read from your resume.</p>
                )}
                {(candidate.education ?? []).length > 0 && (
                  <p className="tiny dim" style={{ marginTop: 10 }}>
                    <strong>Education:</strong> {(candidate.education ?? []).join(" · ")}
                  </p>
                )}
                {(candidate.projects ?? []).length > 0 && (
                  <p className="tiny dim">
                    <strong>Projects:</strong> {(candidate.projects ?? []).join(" · ")}
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-2 mb">
              <div className="card">
                <div className="card-title">
                  <h2>Resume & voice test</h2>
                </div>
                {candidate.has_resume ? (
                  <div className="row" style={{ gap: 10, alignItems: "center" }}>
                    <span className="chip hit">📄 {candidate.resume_filename}</span>
                    <a
                      className="btn btn-sm"
                      href={`/api/candidates/${candidate.id}/resume`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View resume
                    </a>
                  </div>
                ) : (
                  <p className="muted">No resume on file — ask your recruiter.</p>
                )}
                {candidate.summary && (
                  <p className="tiny dim" style={{ marginTop: 10 }}>
                    {candidate.summary}
                  </p>
                )}
                {candidate.has_voice && (
                  <div className="mt">
                    <div className="tiny dim" style={{ marginBottom: 4 }}>
                      Your 20 second voice test
                    </div>
                    <audio
                      controls
                      preload="none"
                      src={`/api/candidates/${candidate.id}/voice`}
                      style={{ width: "100%" }}
                    />
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-title">
                  <h2>Upcoming interviews</h2>
                  <span className="badge">{myInterviews.length}</span>
                </div>
                {myLoading ? (
                  <p className="muted">Loading your interviews…</p>
                ) : myInterviews.length === 0 ? (
                  <p className="muted">
                    Nothing booked yet. Your recruiter will email a meeting link
                    and a date to the address on your resume.
                  </p>
                ) : (
                  <div className="stack">
                    {myInterviews.map((iv) => (
                      <div className="notice" style={{ margin: 0 }} key={iv.session_id}>
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <strong>{iv.job_title}</strong>
                          <span
                            className={
                              "badge " +
                              (iv.status === "completed"
                                ? "ok"
                                : iv.status === "disqualified"
                                  ? "high"
                                  : iv.status === "in_progress"
                                    ? "info"
                                    : iv.meeting_at
                                      ? "warn"
                                      : "")
                            }
                          >
                            {iv.status.replace("_", " ")}
                          </span>
                        </div>
                        <div className="tiny dim" style={{ marginTop: 4 }}>
                          {iv.meeting_at ? (
                            <>
                              Meeting {new Date(iv.meeting_at).toLocaleString()} ·{" "}
                              {iv.meeting_minutes} min
                            </>
                          ) : (
                            "No meeting time set yet"
                          )}{" "
                          }· code <code>{iv.code}</code>
                          {iv.score !== null && <> · score {iv.score}/5</>}
                        </div>
                        <div className="row" style={{ gap: 8, marginTop: 9 }}>
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => nav(`/join/${iv.session_id}`)}
                          >
                            {iv.status === "in_progress"
                              ? "Continue interview"
                              : iv.status === "completed"
                                ? "View outcome"
                                : "Join meeting"}
                          </button>
                          <a
                            className="btn btn-sm"
                            href={`/report/${iv.session_id}`}
                          >
                            Report
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt">
                  <label className="field">
                    <span>Have a meeting link or code? Paste it here</span>
                    <input
                      value={joinLink}
                      onChange={(e) => setJoinLink(e.target.value)}
                      placeholder="https://…/join/12 or your 16-character code"
                    />
                  </label>
                  <button
                    className="btn"
                    disabled={!joinLink.trim() || joining}
                    onClick={joinByLink}
                  >
                    {joining ? "Checking…" : "Open meeting"}
                  </button>
                  {joinError && <div className="notice err">{joinError}</div>}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ------------------------------------------- device + identity */}
        <div className="card mb">
          <div className="card-title">
            <h2>2 · Camera, microphone & identity</h2>
            <span
              className={"badge " + (verified ? "ok" : checking ? "info" : "warn")}
            >
              {verified ? "identity verified" : "not verified"}
            </span>
          </div>

          <div className="video-grid dual">
            <div
              className="vtile"
              style={{ position: "relative", cursor: !checking ? "pointer" : "default" }}
              onClick={!checking ? startCheck : undefined}
            >
              <video
                ref={(el) => {
                  (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
                  if (el && streamRef.current && el.srcObject !== streamRef.current) {
                    el.srcObject = streamRef.current;
                    el.play().catch(() => undefined);
                  }
                }}
                className="mirrored"
                autoPlay
                playsInline
                muted
              />
              {camState !== "ok" && (
                <div className="placeholder">
                  <div style={{ fontSize: "1.7rem", marginBottom: 2 }}>📷</div>
                  <div style={{ fontWeight: 600 }}>
                    {camState === "fail"
                      ? "Camera unavailable (click to retry)"
                      : camState === "checking"
                        ? "Requesting camera permission…"
                        : "Camera off — click here to turn on"}
                  </div>
                  {camState === "idle" && (
                    <div className="tiny dim">
                      Tap or click to start device & identity check
                    </div>
                  )}
                </div>
              )}
              {camState === "ok" && (
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    zIndex: 5,
                    padding: "4px 10px",
                    borderRadius: 999,
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background:
                      faceDetected === true
                        ? "rgba(16, 185, 129, 0.9)"
                        : faceDetected === false
                          ? "rgba(245, 158, 11, 0.9)"
                          : "rgba(0, 0, 0, 0.6)",
                    color: "#fff",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                    backdropFilter: "blur(4px)",
                  }}
                >
                  <span style={{ fontSize: "0.7rem" }}>
                    {faceDetected === true ? "●" : faceDetected === false ? "▲" : "○"}
                  </span>
                  {faceDetected === true
                    ? "Face detected"
                    : faceDetected === false
                      ? "Center your face"
                      : "Scanning face…"}
                </div>
              )}
              <div className="vlabel">
                <span
                  className="dot"
                  style={{ color: camState === "ok" ? "var(--ok)" : "var(--warn)" }}
                />
                Primary camera
              </div>
            </div>

            <div className="stack">
              <div className="dev">
                <div className="name">Camera</div>
                <div className={camState === "ok" ? "muted" : ""}>
                  {camState === "ok"
                    ? "Working"
                    : camState === "fail"
                      ? "Failed"
                      : camState === "checking"
                        ? "Checking…"
                        : "Not started"}
                </div>
              </div>
              <div className="dev">
                <div className="name">Microphone — speak a few words</div>
                <div className="muted">
                  {micState === "ok"
                    ? "Receiving audio"
                    : micState === "fail"
                      ? "Failed"
                      : micState === "checking"
                        ? "Checking…"
                        : "Not started"}
                </div>
                <div className="lvl">
                  <i
                    style={{
                      width: `${levelPct}%`,
                      background: levelPct > 55 ? "var(--warn)" : "var(--ok)",
                    }}
                  />
                </div>
              </div>
              <div className="dev">
                <div className="name">Detected device</div>
                <div className="muted tiny wrap-anywhere">
                  {deviceInfo || "—"}
                </div>
              </div>

              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {!checking ? (
                  <button className="btn" onClick={startCheck}>
                    Start device check
                  </button>
                ) : (
                  <button className="btn" onClick={stopCheck}>
                    Stop check
                  </button>
                )}
                <button
                  className="btn btn-primary"
                  onClick={verify}
                  disabled={
                    !checking ||
                    !candidate ||
                    verifyBusy ||
                    refState === "loading"
                  }
                  title={
                    !candidate
                      ? "Sign in first"
                      : refState === "loading"
                        ? "Analysing your photo…"
                        : "Match your face against your photo"
                  }
                >
                  {verifyBusy
                    ? "Comparing faces…"
                    : verified
                      ? "Verify again"
                      : "Verify my face"}
                </button>
              </div>
            </div>
          </div>

          {deviceError && <div className="notice err">{deviceError}</div>}

          {!candidate && (
            <div className="notice mt">
              Sign in above to verify your face against your profile photo.
            </div>
          )}
          {candidate && refState === "loading" && (
            <div className="notice mt">Analysing your profile photo…</div>
          )}
          {candidate && refState === "failed" && (
            <div className="notice warn mt">
              Your profile photo could not be analysed (no clear face, or the
              identity model failed to load). Sign out and enrol a clearer
              front-facing photo.
              {identityStatus().error ? ` (${identityStatus().error})` : ""}
            </div>
          )}
          {identity && (
            <div className={"notice mt " + (identity.match ? "ok" : "warn")}>
              <strong>{identity.match ? "Match." : "No match."}</strong>{" "}
              {identity.reason}
              {!identity.match && !identity.unavailable && (
                <div className="tiny" style={{ marginTop: 6 }}>
                  Lighting, pose, glasses or a different person can all cause
                  this — sit facing the camera and try again, or re-enrol with a
                  better photo.
                </div>
              )}
            </div>
          )}
        </div>

        {/* ------------------------------------------------------ footer */}
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <button
            className="btn btn-primary"
            disabled={!canContinue}
            onClick={() => resolved && nav(`/join/${resolved.id}`)}
            title={
              canContinue
                ? "Continue to onboarding"
                : "Sign in, then pass the device and face check"
            }
          >
            Continue to onboarding →
          </button>
          <span className="tiny dim">
            {canContinue
              ? "Devices and identity are ready."
              : "Needs: sign-in, working camera and microphone, and a face match."}
          </span>
        </div>

        <p className="tiny dim" style={{ marginTop: 14, marginBottom: 0 }}>
          What happens next: interview rules, recording and proctoring consent,
          then question 1. Your face is re-checked periodically during the
          interview and any mismatch is logged as an observation for the
          recruiter to review.
        </p>
      </div>
    </div>
  );
}
