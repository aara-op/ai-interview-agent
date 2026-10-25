import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import {
  compareFaces,
  embedImageUrl,
  embedVideoFrame,
  type IdentityResult,
} from "../face/match";
import { AudioMonitor } from "../proctoring/audio";
import type { Session } from "../types";
import { saveStoredLogin, storedLogin } from "./CandidateHome";

export default function Onboarding() {
  const { sessionId } = useParams();
  const sid = Number(sessionId);
  const nav = useNavigate();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const monitorRef = useRef<AudioMonitor | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState("");
  const [camState, setCamState] = useState<"pending" | "ok" | "fail">("pending");
  const [micState, setMicState] = useState<"pending" | "ok" | "fail">("pending");
  const [micLevel, setMicLevel] = useState(0);
  const [message, setMessage] = useState("");
  const [deviceError, setDeviceError] = useState("");
  const [consentRec, setConsentRec] = useState(false);
  const [consentProc, setConsentProc] = useState(false);
  const [readRules, setReadRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<string>("");

  // ---- sign-in gate + face verification --------------------------------
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [refEmbedding, setRefEmbedding] = useState<number[] | null>(null);
  const [refState, setRefState] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  // this browser must hold a sign-in for THIS interview before anything runs
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const login = storedLogin();
    setAuthed(Boolean(login) && String(login?.sessionId) === String(sid));
  }, [sid]);
  const [identity, setIdentity] = useState<IdentityResult | null>(null);
  const [identityOk, setIdentityOk] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);

  useEffect(() => {
    api
      .getSession(sid)
      .then(setSession)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [sid]);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamState("fail");
        setMicState("fail");
        setDeviceError(
          "This browser does not expose getUserMedia. Use Chrome, Edge or Safari on http/https.",
        );
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setCamState(stream.getVideoTracks().length ? "ok" : "fail");
        setMicState(stream.getAudioTracks().length ? "ok" : "fail");

        const vTrack = stream.getVideoTracks()[0];
        const aTrack = stream.getAudioTracks()[0];
        const settings = vTrack?.getSettings?.() ?? {};
        setDeviceInfo(
          `${vTrack?.label || "camera"} · ${settings.width ?? "?"}×${settings.height ?? "?"}` +
            ` · ${aTrack?.label || "microphone"}`,
        );

        const monitor = new AudioMonitor();
        monitorRef.current = monitor;
        monitor.onSample = (s) => setMicLevel(s.rms);
        await monitor.start(stream);
      } catch (err) {
        setCamState("fail");
        setMicState("fail");
        setDeviceError(
          err instanceof Error ? err.message : "Camera / microphone permission denied.",
        );
      }
    }

    probe();
    return () => {
      cancelled = true;
      monitorRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const levelPct = Math.min(100, Math.round(micLevel * 900));

  // reference embedding comes from the candidate's enrolment photo
  useEffect(() => {
    const url = session?.candidate?.pfp_url;
    if (!url) {
      setRefEmbedding(null);
      setRefState("idle");
      return;
    }
    setRefState("loading");
    let cancelled = false;
    void embedImageUrl(url).then((emb) => {
      if (cancelled) return;
      setRefEmbedding(emb);
      setRefState(emb ? "ready" : "failed");
    });
    return () => {
      cancelled = true;
    };
  }, [session?.candidate?.pfp_url]);

  async function verifyFace() {
    if (!videoRef.current || verifyBusy) return;
    setVerifyBusy(true);
    setIdentity(null);
    try {
      const reference =
        refEmbedding ?? (await embedImageUrl(session?.candidate?.pfp_url ?? ""));
      if (reference && !refEmbedding) setRefEmbedding(reference);
      const live = await embedVideoFrame(videoRef.current);
      const result = compareFaces(reference, live);
      setIdentity(result);
      setIdentityOk(result.match);
    } finally {
      setVerifyBusy(false);
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const res = await api.login({ code: String(sid), email, password });
      setSession(res.session);
      setPassword("");
      saveStoredLogin(String(sid), res.candidate, res.session.id);
      setAuthed(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function begin() {
    if (session?.status === "disqualified" || session?.status === "completed") {
      setMessage("This interview has already ended — contact your recruiter.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await api.consent(sid, {
        consent_recording: consentRec,
        consent_proctoring: consentProc,
        device_check: {
          camera: camState,
          microphone: micState,
          level: String(levelPct),
          device: deviceError ? "error" : deviceInfo,
        },
      });
      await api.startSession(sid);
      nav(`/room/${sid}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="join-shell">
        <div className="card join-card">
          <h2>Cannot open this interview</h2>
          <p className="muted">{loadError}</p>
          <p className="tiny dim">
            Check the link you were sent, or ask your recruiter to generate a
            new one.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="join-shell">
        <p className="muted">Loading interview…</p>
      </div>
    );
  }

  if (!session.candidate || !authed) {
    return (
      <div className="join-shell">
        <div className="card join-card">
          <div className="eyebrow tiny dim" style={{ letterSpacing: ".1em" }}>
            AI VIDEO INTERVIEW · SIGN IN OR SIGN UP
          </div>
          <h1 style={{ marginTop: 4 }}>Sign in or sign up to start</h1>
          <p className="muted">
            {session.interview?.job_title ?? "Interview"} — every candidate
            signs in (or creates an account) first, so the face on camera can be
            checked against their own profile photo.
          </p>

          <form onSubmit={signIn}>
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
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {authError && <div className="notice err">{authError}</div>}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={authBusy || !email.trim() || !password}
            >
              {authBusy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <a
            className="btn btn-block mt"
            href={`/candidate?code=${session.public_id}`}
          >
            Create an account (sign up)
          </a>
          <p className="tiny dim mt">
            Signing up collects your name, email, Aadhaar ID, profile photo,
            resume and a 20 second voice test, then brings you straight back
            here. Interview code <code>{session.public_id}</code>.
          </p>
        </div>
      </div>
    );
  }

  const ready =
    camState === "ok" &&
    micState === "ok" &&
    identityOk &&
    consentRec &&
    consentProc &&
    readRules;

  return (
    <div className="join-shell">
      <div className="join-card">
        <div className="card mb">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="eyebrow tiny dim" style={{ letterSpacing: ".1em" }}>
                AI VIDEO INTERVIEW
              </div>
              <h1 style={{ marginTop: 4 }}>{session.interview?.job_title ?? "Interview"}</h1>
              <p className="muted" style={{ margin: 0 }}>
                {session.candidate_name} · {session.answer_count || "—"} questions
              </p>
            </div>
            <span className="brand-mark" style={{ fontSize: 30 }}>
              ◈
            </span>
          </div>
          <div className="row mt" style={{ gap: 10, alignItems: "center" }}>
            {session.candidate?.pfp_url && (
              <img
                className="avatar"
                src={session.candidate.pfp_url}
                alt={session.candidate.name}
              />
            )}
            <span className="tiny dim">
              Signed in as {session.candidate?.email}
            </span>
          </div>
        </div>

        {/* --------------------------------------------------- device check */}
        <div className="card mb">
          <div className="card-title">
            <h2>1 · Camera & microphone check</h2>
            <span className={"badge " + (camState === "ok" && micState === "ok" ? "ok" : "warn")}>
              {camState === "ok" && micState === "ok" ? "ready" : "checking…"}
            </span>
          </div>

          <div className="video-grid dual">
            <div className="vtile">
              <video ref={videoRef} className="mirrored" autoPlay playsInline muted />
              {camState !== "ok" && (
                <div className="placeholder">
                  <div>{camState === "fail" ? "Camera unavailable" : "Requesting camera…"}</div>
                </div>
              )}
              <div className="vlabel">
                <span className="dot" style={{ color: camState === "ok" ? "var(--ok)" : "var(--warn)" }} />
                Primary camera
              </div>
            </div>

            <div className="stack">
              <div className="dev">
                <div className="name">Camera</div>
                <div className={camState === "ok" ? "muted" : ""}>
                  {camState === "ok" ? "Working" : camState === "fail" ? "Failed" : "Checking…"}
                </div>
              </div>
              <div className="dev">
                <div className="name">Microphone — speak a few words</div>
                <div className="muted">{micState === "ok" ? "Receiving audio" : "Checking…"}</div>
                <div className="lvl">
                  <i style={{ width: `${levelPct}%`, background: levelPct > 55 ? "var(--warn)" : "var(--ok)" }} />
                </div>
              </div>
              <div className="dev">
                <div className="name">Detected device</div>
                <div className="muted tiny wrap-anywhere">{deviceInfo || "—"}</div>
              </div>
              <div className="dev">
                <div className="name">Identity — face vs profile photo</div>
                <div className="muted">
                  {identityOk
                    ? "Verified"
                    : refState === "loading"
                      ? "Analysing your photo…"
                      : refState === "failed"
                        ? "Photo not analysable"
                        : "Not verified"}
                </div>
                <div className="row mt" style={{ gap: 8 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={verifyFace}
                    disabled={camState !== "ok" || verifyBusy || refState === "loading"}
                  >
                    {verifyBusy
                      ? "Comparing faces…"
                      : identityOk
                        ? "Verify again"
                        : "Verify my face"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {deviceError && (
            <div className="notice err mt">
              {deviceError}
              <div className="tiny" style={{ marginTop: 6 }}>
                Check the browser's address-bar permission icon, allow camera and
                microphone, then reload this page.
              </div>
            </div>
          )}

          {refState === "failed" && (
            <div className="notice warn mt">
              Your profile photo could not be analysed, so the face check cannot
              run. Ask your recruiter to re-enrol you with a clearer,
              front-facing photo.
            </div>
          )}

          {identity && (
            <div className={"notice mt " + (identity.match ? "ok" : "warn")}>
              <strong>{identity.match ? "Face verified." : "No match."}</strong>{" "}
              {identity.reason}
              {!identity.match && !identity.unavailable && (
                <div className="tiny" style={{ marginTop: 6 }}>
                  Sit facing the camera with your whole face in frame and try
                  again — lighting, pose or glasses can cause a false mismatch.
                </div>
              )}
            </div>
          )}
        </div>

        {/* -------------------------------------------------------- rules */}
        <div className="card mb">
          <div className="card-title">
            <h2>2 · Interview rules</h2>
          </div>
          <ul className="rules">
            <li>
              The AI interviewer will read each question aloud, then listen while
              you answer. You can also see every question on screen.
            </li>
            <li>Stay in frame with your face visible for the whole interview.</li>
            <li>
              No other person should appear on camera, and no notes, books or
              second device should be used for answers.
            </li>
            <li>
              The session is monitored: face presence, number of people, head
              orientation, audio events, camera/microphone status and tab focus
              are recorded as timestamped observations.
            </li>
            <li>
              <strong>Cheating and forgery checks:</strong> your live face is
              matched against the photo you signed up with (Aadhaar ID on file),
              so appearing as someone else, holding up a printed photo or
              replaying a video is flagged as an identity mismatch. A second
              face, another person's voice, notes, books or a second screen are
              flagged as possible assistance.
            </li>
            <li>
              Every flag is timestamped — against the interview clock and the
              wall clock — with a captured frame where possible, and listed for
              your recruiter as a suspicion timeline with an evidence frame they
              can open, so a human judges it rather than an automatic score.
            </li>
            <li>
              A phone is available as a second camera — scan the QR code shown in
              the interview room and angle it to show your laptop/desktop screen,
              the side of your face and your desk setup.
            </li>
            <li>
              The interview runs in fullscreen: do not switch tabs or windows,
              and do not leave fullscreen. You receive a warning when your head
              turns more than 30° from the screen for over 7 seconds, your eyes
              stay fixed in one off-screen direction for 5 seconds, the tab or
              window loses focus, or your phone camera stops a second time — a
              third warning ends the interview.
            </li>
            <li>
              Only your laptop and the paired phone may be in view. Any other
              phone, tablet, laptop or screen triggers an alert; a second alert
              ends the interview. Repeated glances toward the phone, voice
              without lip movement, or the two cameras showing different rooms
              are flagged for your recruiter.
            </li>
            <li>
              If your camera freezes, is covered or stops for more than 5
              seconds, a backup question is asked in its place. Join at least 20
              minutes early and keep a stable connection.
            </li>
            <li>
              These observations support a human reviewer. The only automatic
              outcome is the three-warning rule above; everything else is judged
              by a recruiter reviewing the evidence.
            </li>
            <li>
              You may skip a question, ask for it to be repeated, or type your
              answer instead of speaking.
            </li>
          </ul>
        </div>

        {/* ------------------------------------------------------ consent */}
        <div className="card mb">
          <div className="card-title">
            <h2>3 · Consent</h2>
          </div>

          <label className="checkrow">
            <input type="checkbox" checked={consentRec} onChange={(e) => setConsentRec(e.target.checked)} />
            <span>
              I consent to this interview being recorded (audio and video) for
              recruiter review.
            </span>
          </label>

          <label className="checkrow">
            <input type="checkbox" checked={consentProc} onChange={(e) => setConsentProc(e.target.checked)} />
            <span>
              I consent to proctoring analysis of my camera and microphone,
              including optional use of a paired secondary camera.
            </span>
          </label>

          <label className="checkrow">
            <input type="checkbox" checked={readRules} onChange={(e) => setReadRules(e.target.checked)} />
            <span>I have read and understood the interview rules above.</span>
          </label>

          <p className="tiny dim">
            Recordings and captured frames are stored with this interview and are
            only visible to the recruiting team.
          </p>
        </div>

        {message && <div className="notice err mb">{message}</div>}

        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={!ready || busy}
          onClick={begin}
        >
          {busy ? (
            <>
              <span className="spinner" /> Preparing your interview…
            </>
          ) : (
            "Begin interview →"
          )}
        </button>

        {!ready && (
          <p className="tiny dim center mt">
            {camState !== "ok" || micState !== "ok"
              ? "Allow camera and microphone access to continue."
              : "Tick all three confirmations to continue."}
          </p>
        )}
      </div>
    </div>
  );
}
