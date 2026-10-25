import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import QRCode from "qrcode";
import { api, secondarySocketUrl } from "../api";
import {
  compareFaces,
  embedImageUrl,
  embedVideoFrame,
  snapshotFrame,
} from "../face/match";
import { ProctoringEngine, type ProctorEvent } from "../proctoring/engine";
import { INCIDENT_LABELS, type Answer, type Incident, type Session } from "../types";
import { storedLogin } from "./CandidateHome";

type Phase =
  | "preparing"
  | "asking"
  | "listening"
  | "reviewing"
  | "finishing"
  | "done"
  | "disqualified";

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Proctoring events that each count as one formal warning under the rules
 * the candidate confirmed at onboarding:
 *   - head turned beyond 30 degrees for more than 7 seconds
 *   - eyes held in one off-screen direction for 5 seconds (or the same
 *     direction three times in a minute)
 *   - the paired phone camera stopping a second time
 *   - the interview tab was hidden (tab switch)
 *   - the interview window lost focus (app switch)
 *   - the interview left fullscreen
 * Two warnings are allowed; a third warning ends the interview as a
 * disqualification, submitted with the full evidence trail for review.
 *
 * Unnecessary devices follow their own rule: alert 1 is a warning to remove the
 * device, alert 2 disqualifies (MAX_DEVICE_ALERTS). Lip/voice desync, phone
 * glances and environment mismatch are flagged for the recruiter but are not
 * strikes, because each is a softer signal that needs human judgement.
 */
const WARN_TYPES = new Set([
  "prolonged_gaze_aversion",
  "eye_gaze_hold",
  "secondary_camera_unstable",
  "tab_blur",
  "window_blur",
  "fullscreen_exit",
]);
const MAX_WARNINGS = 2;
/** Extra devices allowed before disqualification: alert 1 warns, alert 2 ends it. */
const MAX_DEVICE_ALERTS = 2;
/** Events that mean the primary camera cannot be trusted right now. */
const CAMERA_INTERRUPT_TYPES = new Set(["camera_glitch", "camera_lost"]);

/** Words a submission must reach before it counts as captured audio. */
const MIN_ANSWER_WORDS = 8;
/** How many times unclear audio is re-asked before the answer is recorded. */
const MAX_REASKS = 2;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Retry a transient API call with backoff; null when it still fails. */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch {
      if (i === attempts - 1) return null;
      await sleep(400 * 2 ** i);
    }
  }
  return null;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export default function Room() {
  const { sessionId } = useParams();
  const sid = Number(sessionId);
  const nav = useNavigate();

  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<ProctoringEngine | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const listeningRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const queueRef = useRef<number[]>([]);
  const eventsRef = useRef<ProctorEvent[]>([]);
  const startedRef = useRef(Date.now());
  const answersRef = useRef<Answer[]>([]);        // always-current session.answers
  const transcriptRef = useRef("");               // latest transcript, for timers
  const limitMaxRef = useRef(90);                 // configured per-question limit
  const reaskCountRef = useRef(0);                // unclear-audio re-asks so far
  const typedRef = useRef(false);                 // candidate is answering by typing
  const sttDownRef = useRef(false);               // transcription reconnecting
  const sttAttemptRef = useRef(0);
  const restartPendingRef = useRef(false);        // our reconnect owns the restart
  const pendingSaveRef = useRef<{
    answerId: number;
    payload: { transcript: string; status: string; duration_seconds: number };
  } | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [queue, setQueue] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const [answeredAtLoad, setAnsweredAtLoad] = useState(0);
  const [liveEvents, setLiveEvents] = useState<Incident[]>([]);
  const [transcript, setTranscript] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(90);
  const [qr, setQr] = useState("");
  const [pairOpen, setPairOpen] = useState(false);
  const [secondaryOn, setSecondaryOn] = useState(false);
  const [showType, setShowType] = useState(false);
  const [hud, setHud] = useState({
    faces: 0, yaw: null as number | null, mic: 0, vision: "",
    eye: null as string | null, env: "unknown" as string, scan: false,
  });
  const [followInfo, setFollowInfo] = useState("");
  const [retryTick, setRetryTick] = useState(0);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [sttReconnecting, setSttReconnecting] = useState(false);
  const [warnings, setWarnings] = useState<
    { type: string; ts_ms: number; observed: string }[]
  >([]);
  const [fsOk, setFsOk] = useState(() => Boolean(document.fullscreenElement));
  const [deviceAlerts, setDeviceAlerts] = useState(0);
  const [backupsUsed, setBackupsUsed] = useState(0);
  const indexRef = useRef(0);
  const backupFnRef = useRef<(() => Promise<void>) | null>(null);
  const lastBackupAtRef = useRef(0);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const prevSecondaryRef = useRef(false);
  const disqualifiedRef = useRef(false);
  const wasFsRef = useRef(Boolean(document.fullscreenElement));
  const lastBlurRef = useRef(0);

  const answers = session?.answers ?? [];
  // Keep the ref in step with state so a follow-up appended mid-cycle is
  // resolvable immediately, without waiting for a re-render.
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  const updateAnswers = useCallback((fn: (list: Answer[]) => Answer[]) => {
    const next = fn(answersRef.current);
    answersRef.current = next;
    setSession((prev) => (prev ? { ...prev, answers: next } : prev));
  }, []);
  const current = useMemo(
    () => answers.find((a) => a.id === queue[index]) ?? null,
    [answers, queue, index],
  );
  const answeredCount = answers.filter((a) => a.status !== "pending").length;
  const startedAt = startedRef.current;

  // ---- identity: enrolment photo vs live frame --------------------------
  const idRefEmbedding = useRef<number[] | null>(null);
  const idVerifiedLoggedRef = useRef(false);
  const idLastMismatchRef = useRef(0);
  const [idState, setIdState] = useState<
    "idle" | "loading" | "verified" | "mismatch" | "unavailable"
  >("idle");
  const [idScore, setIdScore] = useState<number | null>(null);

  // ---------------------------------------------------------------- helpers
  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? "" : t)), 3600);
  }, []);

  /** Send an answer held back by a connectivity blip, once the link returns. */
  const flushPending = useCallback(async () => {
    const held = pendingSaveRef.current;
    if (!held) return;
    try {
      await api.submitAnswer(sid, held.answerId, held.payload);
      pendingSaveRef.current = null;
    } catch {
      /* still offline — retried on the next tick or when the link returns */
    }
  }, [sid]);

  useEffect(() => {
    const onOnline = () => {
      setOffline(false);
      void flushPending();
    };
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const t = window.setInterval(() => void flushPending(), 20000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(t);
    };
  }, [flushPending]);

  const logEvent = useCallback(
    async (e: ProctorEvent) => {
      eventsRef.current = [e, ...eventsRef.current].slice(0, 60);
      setLiveEvents((prev) =>
        [
          {
            id: Date.now() + Math.random(),
            ts_ms: e.ts_ms ?? 0,
            wall_time: null,
            type: e.type,
            severity: e.severity ?? "info",
            observed: e.observed,
            inference: e.inference,
            value: e.value ?? "",
            duration_ms: e.duration_ms ?? 0,
            acknowledged: false,
            reviewer_note: "",
            has_evidence: Boolean(e.evidence_data_url),
          } as unknown as Incident,
          ...prev,
        ].slice(0, 60),
      );
      try {
        await api.logIncident(sid, e);
      } catch {
        /* telemetry must never interrupt the interview */
      }
      if (WARN_TYPES.has(e.type) && !disqualifiedRef.current) {
        setWarnings((prev) => [
          ...prev,
          { type: e.type, ts_ms: e.ts_ms ?? 0, observed: e.observed },
        ]);
      }
      if (e.type === "extra_device" && !disqualifiedRef.current) {
        setDeviceAlerts((n) => n + 1);
      }
      if (CAMERA_INTERRUPT_TYPES.has(e.type) && !disqualifiedRef.current) {
        void backupFnRef.current?.();
      }
    },
    [sid],
  );

  // reference embedding from the candidate's enrolment photo
  useEffect(() => {
    const url = session?.candidate?.pfp_url;
    if (!url) {
      idRefEmbedding.current = null;
      setIdState("idle");
      return;
    }
    setIdState("loading");
    let cancelled = false;
    void embedImageUrl(url).then((emb) => {
      if (cancelled) return;
      idRefEmbedding.current = emb;
      setIdState(emb ? "idle" : "unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [session?.candidate?.pfp_url]);

  // one identity comparison: feeds the rail chip and the incident log
  const checkIdentity = useCallback(async () => {
    const video = videoRef.current;
    const reference = idRefEmbedding.current;
    if (!video || !reference) return;
    const live = await embedVideoFrame(video);
    const res = compareFaces(reference, live);
    if (res.unavailable) {
      setIdState("unavailable");
      return;
    }
    setIdScore(res.similarity);
    const ts = Math.max(0, Date.now() - startedRef.current);
    if (res.match) {
      setIdState("verified");
      if (!idVerifiedLoggedRef.current) {
        idVerifiedLoggedRef.current = true;
        await logEvent({
          type: "identity_verified",
          ts_ms: ts,
          severity: "info",
          observed: `Live face matches the enrolment photo (${(res.similarity * 100).toFixed(1)}%).`,
          inference: "The person on camera was consistent with the signed-in candidate at this moment.",
        });
      }
      return;
    }
    setIdState("mismatch");
    const now = Date.now();
    if (now - idLastMismatchRef.current > 120000) {
      idLastMismatchRef.current = now;
      await logEvent({
        type: "identity_mismatch",
        ts_ms: ts,
        severity: "high",
        value: `${(res.similarity * 100).toFixed(1)}%`,
        observed: res.reason,
        inference:
          "The person on camera may not be the signed-in candidate — or lighting, pose, glasses, framing or image quality changed the match. Review the captured frame before drawing any conclusion.",
        evidence_data_url: snapshotFrame(video),
      });
    }
  }, [logEvent]);

  // re-check periodically while the interview runs (throttled mismatch logging)
  useEffect(() => {
    if (!session?.candidate?.pfp_url || phase === "done") return;
    // face recognition runs every 10 seconds for the whole interview
    const first = window.setTimeout(() => void checkIdentity(), 4000);
    const timer = window.setInterval(() => void checkIdentity(), 10000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [session?.candidate?.pfp_url, phase, checkIdentity]);

  // ------------------------------------------------------------- load + media
  useEffect(() => {
    let cancelled = false;
    let engine: ProctoringEngine | null = null;

    async function boot() {
      try {
        const s = await api.getSession(sid);
        if (cancelled) return;
        setSession(s);

        // Sign in / sign up comes first, always: without a login bound to this
        // session the room sends the candidate back to the candidate entry
        // point, and an interview that has not gone through consent and the
        // rules yet goes back to onboarding.
        const login = storedLogin();
        if (!s.candidate || !login || String(login.sessionId) !== String(sid)) {
          nav(`/candidate?code=${sid}`, { replace: true });
          return;
        }
        if (s.status === "onboarding") {
          nav(`/join/${sid}`, { replace: true });
          return;
        }

        // Resume where the candidate left off: only pending questions, with
        // pending follow-ups placed directly after their parent question.
        const pending = s.answers
          .filter((a) => a.status === "pending")
          .sort((a, b) => a.position - b.position);
        const fuByParent = new Map<number, typeof pending>();
        pending.forEach((a) => {
          if (a.is_followup && a.parent_answer_id) {
            const list = fuByParent.get(a.parent_answer_id) ?? [];
            list.push(a);
            fuByParent.set(a.parent_answer_id, list);
          }
        });
        const q: number[] = [];
        pending.forEach((a) => {
          if (a.is_followup) return;
          q.push(a.id);
          (fuByParent.get(a.id) ?? []).forEach((f) => q.push(f.id));
        });
        pending.forEach((a) => {
          if (a.is_followup && !q.includes(a.id)) q.push(a.id);
        });
        queueRef.current = q;
        setQueue(q);
        setIndex(0);
        setAnsweredAtLoad(s.answers.filter((a) => a.status !== "pending").length);
        limitMaxRef.current = s.interview?.per_question_limit_seconds ?? 90;
        setLimit(limitMaxRef.current);
        answersRef.current = s.answers;
        reaskCountRef.current = 0;
        startedRef.current = s.started_at ? Date.parse(s.started_at) : Date.now();

        // Rebuild the warning budget after a reload: warnings are persisted
        // as incidents, so refreshing the page cannot reset the count.
        let seededWarnings: { type: string; ts_ms: number; observed: string }[] = [];
        try {
          const inc = await api.incidents(sid);
          seededWarnings = inc
            .filter((i) => WARN_TYPES.has(i.type))
            .map((i) => ({ type: i.type, ts_ms: i.ts_ms, observed: i.observed }));
          setDeviceAlerts(inc.filter((i) => i.type === "extra_device").length);
          setBackupsUsed(inc.filter((i) => i.type === "backup_deployed").length);
        } catch {
          /* best effort — a fresh count is still correct for a new session */
        }
        if (s.status === "disqualified") {
          disqualifiedRef.current = true;
          setWarnings(seededWarnings);
          setPhase("disqualified");
          return;
        }
        if (seededWarnings.length) setWarnings(seededWarnings);

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
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => undefined);
        }

        engine = new ProctoringEngine(sid, logEvent);
        engine.attachPrimary(stream, videoRef.current!);
        engineRef.current = engine;
        await engine.start();
        setHud((h) => ({
          ...h,
          vision: engine!.state.visionReady ? "active" : engine!.state.visionError ?? "unavailable",
        }));

        if (s.consent_recording && typeof MediaRecorder !== "undefined") {
          try {
            const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
            chunksRef.current = [];
            rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
            rec.start(5000);
            recorderRef.current = rec;
          } catch {
            say("Recording could not start; the interview continues.");
          }
        }

        if (s.consent_proctoring && s.pair_token) {
          const url = `${window.location.origin}/secondary/${s.pair_token}`;
          QRCode.toDataURL(url, { margin: 1, width: 300 })
            .then(setQr)
            .catch(() => undefined);
          connectSignalling(s.pair_token);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    boot();
    return () => {
      cancelled = true;
      engine?.stop();
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
      listeningRef.current = false;
      try {
        recorderRef.current?.state === "recording" && recorderRef.current.stop();
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      wsRef.current?.close();
      pcRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  // Attach the phone's stream to its <video> and to the proctoring engine once
  // the tile is on screen; tell the engine when the phone leaves.
  useEffect(() => {
    const engine = engineRef.current;
    if (secondaryOn) {
      const stream = remoteStreamRef.current;
      const el = remoteRef.current;
      if (stream && el) {
        if (el.srcObject !== stream) el.srcObject = stream;
        el.play().catch(() => undefined);
        engine?.attachSecondary(stream, el);
      }
    } else if (prevSecondaryRef.current) {
      engine?.attachSecondary(null, null);
      engine?.noteSecondaryDisconnected();
      remoteStreamRef.current = null;
    }
    prevSecondaryRef.current = secondaryOn;
  }, [secondaryOn]);

  // Keep primary video connected to stream across tab focus changes and re-renders
  useEffect(() => {
    const v = videoRef.current;
    const s = streamRef.current;
    if (v && s && v.srcObject !== s) {
      v.srcObject = s;
      v.play().catch(() => undefined);
    }
  });

  // periodic HUD refresh
  useEffect(() => {
    const t = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      setHud((h) => ({
        ...h,
        faces: e.state.faceCount,
        yaw: e.state.yaw,
        mic: e.state.micLevel,
        vision: e.state.visionReady ? "active" : h.vision,
        eye: e.state.eyeDir,
        env: e.state.environment,
        scan: e.state.deviceScanReady,
      }));
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  // Per-question countdown. It freezes itself while the network or the
  // transcription service is temporarily down, and when time runs out on
  // unclear audio it re-asks the same question instead of burning it as
  // unanswered, so an outage is never scored against the candidate.
  useEffect(() => {
    if (phase !== "listening") return;
    let started = Date.now();
    const tick = 250;
    const t = window.setInterval(() => {
      if (!navigator.onLine || sttDownRef.current) {
        started += tick; // pause the clock through the outage
      }
      const left = limitMaxRef.current * 1000 - (Date.now() - started);
      setLimit(Math.max(0, Math.ceil(left / 1000)));
      if (left <= 0) {
        window.clearInterval(t);
        if (wordCount(transcriptRef.current) < MIN_ANSWER_WORDS && tryReask()) {
          return;
        }
        void submitAnswer("unanswered");
      }
    }, tick);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current?.id, retryTick]);

  // ------------------------------------------------------------------- TTS
  const speak = useCallback(
    (text: string, then: () => void) => {
      if (disqualifiedRef.current) return;
      const synth = window.speechSynthesis;
      engineRef.current?.setPromptActive(true);
      setSpeaking(true);
      if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
        setSpeaking(false);
        engineRef.current?.setPromptActive(false);
        then();
        return;
      }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1;
      u.pitch = 1;
      const voices = synth.getVoices().filter((v) => v.lang?.startsWith("en"));
      if (voices.length) u.voice = voices[0];
      u.onend = () => {
        setSpeaking(false);
        engineRef.current?.setPromptActive(false);
        window.setTimeout(then, 250);
      };
      u.onerror = () => {
        setSpeaking(false);
        engineRef.current?.setPromptActive(false);
        then();
      };
      synth.speak(u);
      // Safari/Chrome occasionally drop onend — guard with a timeout.
      window.setTimeout(() => {
        if (synth.speaking) return;
        setSpeaking(false);
        engineRef.current?.setPromptActive(false);
      }, Math.max(4000, text.length * 75));
    },
    [],
  );

  // ------------------------------------------------------------------- STT
  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, []);

  const startListening = useCallback(() => {
    if (disqualifiedRef.current) return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setTranscript("");
    typedRef.current = false;
    sttDownRef.current = false;
    setSttReconnecting(false);
    sttAttemptRef.current = 0;
    if (!Ctor) {
      say("Live transcription is unavailable in this browser — type your answer instead.");
      typedRef.current = true; // voice cannot be captured here at all
      setShowType(true);
      setPhase("listening");
      return;
    }
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;

    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      setTranscript((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech") return; // a pause in speech — keep waiting

      if (e.error === "aborted") {
        // Interruption: we still intend to listen, so restart ourselves
        // instead of letting the answer quietly die.
        if (listeningRef.current && recognitionRef.current === rec) {
          restartPendingRef.current = true;
          window.setTimeout(() => {
            restartPendingRef.current = false;
            if (
              !listeningRef.current ||
              disqualifiedRef.current ||
              recognitionRef.current !== rec
            ) {
              return;
            }
            try {
              rec.start();
            } catch {
              /* onend below takes over */
            }
          }, 250);
        }
        return;
      }

      if (
        e.error === "network" &&
        listeningRef.current &&
        recognitionRef.current === rec
      ) {
        const attempt = sttAttemptRef.current + 1;
        if (attempt <= 3) {
          // Temporary connectivity issue: back off and reconnect ourselves,
          // freezing the countdown while transcription is down.
          sttAttemptRef.current = attempt;
          restartPendingRef.current = true;
          sttDownRef.current = true;
          setSttReconnecting(true);
          setListening(false);
          say(
            `Transcription connection dropped — reconnecting (attempt ${attempt} of 3)…`,
          );
          window.setTimeout(() => {
            restartPendingRef.current = false;
            const stillWanted =
              listeningRef.current &&
              !disqualifiedRef.current &&
              recognitionRef.current === rec;
            if (!stillWanted) {
              if (recognitionRef.current === rec) {
                sttDownRef.current = false;
                setSttReconnecting(false);
              }
              return;
            }
            try {
              rec.start();
              setListening(true);
              sttDownRef.current = false;
              setSttReconnecting(false);
              sttAttemptRef.current = 0;
            } catch {
              listeningRef.current = false;
              setListening(false);
              sttDownRef.current = false;
              setSttReconnecting(false);
              say("Live transcription cannot reconnect — type your answer instead.");
              typedRef.current = true;
              setShowType(true);
            }
          }, 900 * attempt);
          return;
        }
      }

      // Device problems (blocked microphone / no capture) and repeated
      // failures: hand over to the text box rather than stalling the interview.
      say(
        e.error === "not-allowed"
          ? "Microphone permission was blocked — enable it and type your answer."
          : `Transcription issue (${e.error}) — you can type your answer.`,
      );
      typedRef.current = true;
      setShowType(true);
      listeningRef.current = false;
      setListening(false);
      sttDownRef.current = false;
      setSttReconnecting(false);
    };
    rec.onend = () => {
      if (restartPendingRef.current) return; // our reconnect owns the restart
      if (listeningRef.current) {
        // The browser auto-stops after a pause; keep listening until the
        // candidate presses "Submit answer".
        try {
          rec.start();
        } catch {
          listeningRef.current = false;
          setListening(false);
        }
      } else {
        setListening(false);
      }
    };

    listeningRef.current = true;
    setListening(true);
    setPhase("listening");
    try {
      rec.start();
    } catch {
      listeningRef.current = false;
      setListening(false);
    }
  }, [say]);

  // ----------------------------------------------------------- answer cycle
  const busyRef = useRef(false);

  const finish = useCallback(async () => {
    if (disqualifiedRef.current) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("finishing");
    stopListening();
    window.speechSynthesis?.cancel();
    try {
      const rec = recorderRef.current;
      if (rec && rec.state === "recording") {
        await new Promise<void>((resolve) => {
          rec.onstop = () => resolve();
          rec.stop();
        });
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        if (blob.size > 0) await api.uploadRecording(sid, blob).catch(() => undefined);
      }
      await flushPending();
      await api.complete(sid);
      engineRef.current?.stop();
    } catch {
      /* evaluation still runs from stored answers */
    }
    setPhase("done");
  }, [sid, stopListening, flushPending]);

  const advance = useCallback(() => {
    if (disqualifiedRef.current) return;
    const next = index + 1;
    const q = queueRef.current;
    if (next >= q.length) {
      void finish();
      return;
    }
    setIndex(next);
    setPhase("asking");
    setTranscript("");
    setShowType(false);
    typedRef.current = false;
    reaskCountRef.current = 0;
    setLimit(limitMaxRef.current);
    setRetryTick((n) => n + 1);
    const nextId = q[next];
    // answersRef, not session: a follow-up appended in this very cycle has
    // not reached state yet, so the follow-up is spoken straight after its
    // parent instead of being displayed silently.
    const ans = answersRef.current.find((a) => a.id === nextId);
    if (ans) speak(ans.question_text, () => startListening());
  }, [index, speak, startListening, finish]);

  /** Re-ask the SAME question when nothing usable came through — unclear
   *  audio, an interruption or a transcription drop. Bounded by MAX_REASKS;
   *  returns false once that budget is spent, so the caller records it. */
  const tryReask = useCallback(() => {
    if (disqualifiedRef.current || typedRef.current) return false;
    if (reaskCountRef.current >= MAX_REASKS) return false;
    reaskCountRef.current += 1;
    setPhase("asking");
    setTranscript("");
    setLimit(limitMaxRef.current);
    setRetryTick((n) => n + 1);
    const opener =
      reaskCountRef.current === 1
        ? "Sorry, I didn't quite catch that."
        : "That still isn't clear on my end — once more please, or type your answer instead.";
    say(opener);
    speak(`${opener} ${current?.question_text ?? ""}`, () => startListening());
    return true;
  }, [current, speak, startListening, say]);

  const submitAnswer = useCallback(
    async (status: "answered" | "skipped" | "unanswered", typed?: string) => {
      if (
        !current ||
        busyRef.current ||
        disqualifiedRef.current ||
        phase === "reviewing" ||
        phase === "finishing"
      ) {
        return;
      }

      const text = (typed ?? transcript).trim();
      const words = wordCount(text);

      // --- unclear audio: re-ask instead of burning the question ----------
      if (
        status === "answered" &&
        !typedRef.current &&
        words < MIN_ANSWER_WORDS
      ) {
        if (tryReask()) return;
        // retries spent: record what we have (empty => unanswered)
        status = words === 0 ? "unanswered" : "answered";
      }

      busyRef.current = true;
      stopListening();
      window.speechSynthesis?.cancel();
      setPhase("reviewing");

      const finalStatus: typeof status =
        status === "answered" && !text ? "unanswered" : status;
      const duration = Math.min(
        limit,
        Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
      );
      const payload = {
        transcript: text,
        status: finalStatus,
        duration_seconds: duration,
      };

      // --- save, retrying through a short connectivity blip ----------------
      const saved = await withRetry(() =>
        api.submitAnswer(sid, current.id, payload),
      );
      if (!saved) {
        pendingSaveRef.current = { answerId: current.id, payload };
        say(
          "Connection problem — your answer is held and sent when the link returns.",
        );
      }
      updateAnswers((list) =>
        list.map((a) =>
          a.id === current.id
            ? { ...a, status: finalStatus, transcript: text }
            : a,
        ),
      );

      // --- verdict: complete / unsatisfactory / unclear --------------------
      if (
        finalStatus === "answered" &&
        saved &&
        session?.interview?.allow_followups
      ) {
        const fu = await withRetry(() => api.followup(sid, current.id), 3);
        if (fu?.verdict === "unclear" && tryReask()) {
          busyRef.current = false;
          return;
        }
        if (fu?.allowed && fu.question && fu.answer) {
          // inserted directly after its parent, so follow-ups run one after
          // another and each one continues the same thread
          updateAnswers((list) => [...list, fu.answer!]);
          const next = [...queueRef.current];
          const at = next.indexOf(current.id);
          next.splice(at + 1, 0, fu.answer.id);
          queueRef.current = next;
          setQueue(next);
          setFollowInfo(
            `Follow-up ${fu.used} of ${fu.budget}: ${fu.reason || "digging deeper"}`,
          );
          window.setTimeout(() => setFollowInfo(""), 6000);
        }
      }

      busyRef.current = false;
      advance();
    },
    [
      current,
      phase,
      transcript,
      sid,
      session,
      limit,
      startedAt,
      stopListening,
      say,
      advance,
      tryReask,
      updateAnswers,
    ],
  );

  const beginFirstQuestion = useCallback(() => {
    if (disqualifiedRef.current) return;
    const q = queueRef.current;
    if (!q.length || !session) return;
    setPhase("asking");
    const ans = session.answers.find((a) => a.id === q[0]);
    if (ans) speak(ans.question_text, () => startListening());
  }, [session, speak, startListening]);

  // Start the interview as soon as the session and media are ready.
  useEffect(() => {
    if (phase !== "preparing" || !session || !queue.length) return;
    const t = window.setTimeout(() => beginFirstQuestion(), 600);
    return () => window.clearTimeout(t);
  }, [phase, session, queue.length, beginFirstQuestion]);

  // ------------------------------------------------------ warning discipline
  const disqualify = useCallback(async () => {
    if (disqualifiedRef.current) return;
    disqualifiedRef.current = true;
    stopListening();
    window.speechSynthesis?.cancel();
    setPhase("disqualified");
    engineRef.current?.stop();
    try {
      const rec = recorderRef.current;
      if (rec && rec.state === "recording") {
        await new Promise<void>((resolve) => {
          rec.onstop = () => resolve();
          rec.stop();
        });
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        if (blob.size > 0) await api.uploadRecording(sid, blob).catch(() => undefined);
      }
    } catch {
      /* the answers and incidents below matter more than the recording */
    }
    await logEvent({
      type: "disqualified",
      ts_ms: Math.max(0, Date.now() - startedRef.current),
      severity: "high",
      observed:
        deviceAlerts >= MAX_DEVICE_ALERTS
          ? `${deviceAlerts} unnecessary-device alerts were raised — the allowed maximum is ${MAX_DEVICE_ALERTS - 1}.`
          : `${warnings.length} warnings were issued during this interview — the allowed maximum is ${MAX_WARNINGS}.`,
      inference:
        "The warning budget confirmed at onboarding was exceeded; the recruiter reviews the full evidence trail before any hiring decision.",
    }).catch(() => undefined);
    await api.complete(sid, "disqualified").catch(() => undefined);
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
    } catch {
      /* ignore */
    }
  }, [sid, stopListening, logEvent, warnings.length, deviceAlerts]);

  // Issue a warning toast per counted event; disqualify on the third.
  useEffect(() => {
    if (!warnings.length || disqualifiedRef.current || phase === "disqualified") {
      return;
    }
    const last = warnings[warnings.length - 1];
    if (warnings.length > MAX_WARNINGS) {
      void disqualify();
      return;
    }
    say(
      `Warning ${warnings.length} of ${MAX_WARNINGS} — ${
        INCIDENT_LABELS[last.type] ?? last.type
      }`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warnings]);

  // Extra device: alert 1 is a warning to remove it, alert 2 disqualifies.
  useEffect(() => {
    if (!deviceAlerts || disqualifiedRef.current || phase === "disqualified") return;
    if (deviceAlerts >= MAX_DEVICE_ALERTS) {
      void disqualify();
      return;
    }
    say(
      `Device alert ${deviceAlerts} of ${MAX_DEVICE_ALERTS - 1} allowed — remove any extra phone, tablet, laptop or screen from view now.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceAlerts]);

  // Camera glitch / cut for more than 5 s: queue a backup question right behind
  // the current one so the interview still collects scored evidence.
  const deployBackup = useCallback(async () => {
    if (disqualifiedRef.current) return;
    const now = Date.now();
    if (now - lastBackupAtRef.current < 30000) return;   // one per outage
    lastBackupAtRef.current = now;
    const res = await withRetry(() => api.backup(sid), 3);
    if (!res?.allowed || !res.answer) return;
    const answer = res.answer;
    updateAnswers((list) => [...list, answer]);
    const next = [...queueRef.current];
    next.splice(Math.min(indexRef.current + 1, next.length), 0, answer.id);
    queueRef.current = next;
    setQueue(next);
    setBackupsUsed((n) => n + 1);
    say("Camera interruption detected — a backup question was added.");
    void logEvent({
      type: "backup_deployed",
      ts_ms: Math.max(0, Date.now() - startedRef.current),
      severity: "info",
      value: `${res.used}/${res.budget}`,
      observed: `Backup question ${res.used} of ${res.budget} was queued after the camera was interrupted.`,
      inference:
        "A backup question replaces the evidence lost to a camera fault or camera cut; it is scored like any other question.",
    });
  }, [sid, updateAnswers, say, logEvent]);
  useEffect(() => {
    backupFnRef.current = deployBackup;
  }, [deployBackup]);

  // ------------------------------------------------------------- fullscreen
  const enterFullscreen = useCallback(() => {
    document.documentElement
      .requestFullscreen()
      .catch(() =>
        say("Fullscreen was blocked — allow it in your browser (or press F11)."),
      );
  }, [say]);

  // Listen first, then make the initial attempt: browsers only grant
  // fullscreen without a gesture when the page still has user activation
  // (which it does right after “Begin interview →”); otherwise the overlay
  // below gives the candidate a button, which is always a valid gesture.
  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(document.fullscreenElement);
      setFsOk(active);
      if (active) {
        wasFsRef.current = true;
        return;
      }
      if (wasFsRef.current && !disqualifiedRef.current && phase !== "done") {
        wasFsRef.current = false;
        void logEvent({
          type: "fullscreen_exit",
          ts_ms: Math.max(0, Date.now() - startedRef.current),
          severity: "warning",
          observed: "The interview window left fullscreen mode.",
          inference:
            "The candidate may have opened another window or application — return to fullscreen to continue.",
        });
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [logEvent, phase]);

  useEffect(() => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }, []);

  // Switching applications (Alt/Cmd-Tab) does not hide the tab, so watch
  // window blur in addition to the engine's visibilitychange-based tab_blur.
  useEffect(() => {
    const onBlur = () => {
      if (document.hidden || disqualifiedRef.current || phase === "done") return;
      const now = Date.now();
      if (now - lastBlurRef.current < 4000) return;
      lastBlurRef.current = now;
      void logEvent({
        type: "window_blur",
        ts_ms: Math.max(0, now - startedRef.current),
        severity: "warning",
        observed: "The interview window lost focus.",
        inference:
          "The candidate may have switched to another application — return focus to the interview.",
      });
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [logEvent, phase]);

  // ---------------------------------------------------------------- WebRTC
  const connectSignalling = useCallback((token: string) => {
    try {
      const ws = new WebSocket(secondarySocketUrl(token));
      wsRef.current = ws;

      ws.onopen = () => ws.send(JSON.stringify({ type: "join", role: "host" }));

      ws.onmessage = async (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw.data));
        } catch {
          return;
        }

        if (msg.type === "peer_joined") {
          setPairOpen(true);
          say("Secondary camera connected.");
          return;
        }
        if (msg.type === "peer_left") {
          setSecondaryOn(false);
          return;
        }

        if (msg.type === "offer") {
          try {
            if (!pcRef.current) pcRef.current = new RTCPeerConnection();
            const pc = pcRef.current;
            pc.ontrack = (e) => {
              // the remote <video> only mounts once secondaryOn is true, so the
              // stream is parked in a ref and attached by the effect below
              remoteStreamRef.current = e.streams[0] ?? null;
              if (remoteRef.current) remoteRef.current.srcObject = e.streams[0];
              setSecondaryOn(true);
            };
            pc.onicecandidate = (e) =>
              e.candidate &&
              ws.send(JSON.stringify({ type: "candidate", candidate: e.candidate }));
            await pc.setRemoteDescription(msg.sdp as RTCSessionDescriptionInit);
            for (const c of pendingIceRef.current.splice(0)) {
              await pc.addIceCandidate(c).catch(() => undefined);
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: "answer", sdp: pc.localDescription }));
          } catch {
            say("Could not negotiate the secondary camera stream.");
          }
          return;
        }

        if (msg.type === "candidate") {
          const cand = msg.candidate as RTCIceCandidateInit;
          const pc = pcRef.current;
          if (!pc || !pc.remoteDescription) {
            pendingIceRef.current.push(cand);
            return;
          }
          await pc.addIceCandidate(cand).catch(() => undefined);
        }
      };

      ws.onclose = () => setSecondaryOn(false);
    } catch {
      /* signalling is optional */
    }
  }, [say]);

  // ------------------------------------------------------------------ render
  const timeLeft = `${clock(Date.now() - startedAt)}`;
  const pct = queue.length ? Math.round((index / queue.length) * 100) : 0;

  if (error) {
    return (
      <div className="join-shell">
        <div className="card join-card">
          <h2>Interview could not start</h2>
          <p className="muted">{error}</p>
          <p className="tiny dim">
            Close this tab and open the interview link your recruiter sent you.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "disqualified") {
    return (
      <div className="join-shell">
        <div className="card join-card center">
          <div className="brand-mark" style={{ fontSize: 42, color: "var(--high)" }}>
            ◈
          </div>
          <h1>Interview ended</h1>
          <p className="muted">
            This interview was ended after {warnings.length} warnings under the
            proctoring rules you confirmed at onboarding (maximum{" "}
            {MAX_WARNINGS} warnings). Your answers, the recording and the full
            event log have been submitted — a recruiter reviews the evidence.
          </p>
          <ul className="rules tiny" style={{ textAlign: "left" }}>
            {warnings.map((w, i) => (
              <li key={`${w.type}-${w.ts_ms}-${i}`}>
                <strong>Warning {i + 1}</strong> · {clock(w.ts_ms)} —{" "}
                {INCIDENT_LABELS[w.type] ?? w.type}. {w.observed}
              </li>
            ))}
          </ul>
          <button className="btn mt" onClick={() => window.close()}>
            Close this window
          </button>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="join-shell">
        <div className="card join-card center">
          <div className="brand-mark" style={{ fontSize: 42 }}>◈</div>
          <h1>Interview complete</h1>
          <p className="muted">
            Thank you, {session?.candidate_name ?? "candidate"}. Your responses
            and the proctoring observations have been submitted for review. The
            recruiter will review the evidence manually.
          </p>
          <div className="row" style={{ justifyContent: "center" }}>
            <span className="badge ok">{answeredCount} responses recorded</span>
            <span className="badge info">{liveEvents.length} observations logged</span>
          </div>
          <button
            className="btn mt"
            onClick={() => {
              window.close();
            }}
          >
            Close this window
          </button>
          <p className="tiny dim mt" style={{ marginBottom: 0 }}>
            If the tab does not close, you can close it yourself — there is
            nothing else for you to do here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="interview-shell">
      <header className="interview-head">
        <div className="row">
          <span className="brand-mark" style={{ fontSize: 20 }}>◈</span>
          <strong>{session?.interview?.job_title ?? "Interview"}</strong>
          <span className="badge">
            Q {answeredAtLoad + index + 1} / {answeredAtLoad + queue.length}
          </span>
          <span className="badge">{timeLeft}</span>
        </div>
        <div className="row">
          {recorderRef.current && (
            <span className="badge high">
              <span className="dot" /> REC
            </span>
          )}
          {warnings.length > 0 && (
            <span
              className={
                "badge " + (warnings.length >= MAX_WARNINGS ? "high" : "warn")
              }
            >
              ⚠ warnings {warnings.length}/{MAX_WARNINGS}
            </span>
          )}
          {offline && (
            <span className="badge high">◉ connection lost — timer paused</span>
          )}
          {sttReconnecting && (
            <span className="badge warn">🎙 reconnecting…</span>
          )}
          <span className={"badge " + (hud.vision === "active" ? "ok" : "warn")}>
            vision {hud.vision || "starting"}
          </span>
          <span className="badge">faces {hud.faces}</span>
          {deviceAlerts > 0 && (
            <span className="badge high">
              ⚠ device alerts {deviceAlerts}/{MAX_DEVICE_ALERTS}
            </span>
          )}
          <button className="btn btn-sm" onClick={() => setPairOpen(!pairOpen)}>
            {pairOpen ? "Hide 2nd camera" : "2nd camera"}
          </button>
        </div>
      </header>

      <div className="bar" style={{ margin: "0 20px" }}>
        <i style={{ width: `${pct}%` }} />
      </div>

      <div className="interview-body">
        {/* ------------------------------------------------------- stage */}
        <div className="stage">
          <div className={"video-grid" + (secondaryOn ? " dual" : "")}>
            <div className="vtile">
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
              <div className="vlabel">
                <span className="dot" style={{ color: "var(--ok)" }} />
                Primary camera
              </div>
              <div className="vstatus">{hud.yaw !== null ? `yaw ${hud.yaw}°` : "—"}</div>
              {hud.faces > 1 && (
                <div className="vstatus" style={{ right: "auto", left: 9, top: 34, background: "rgba(255,95,109,.85)" }}>
                  {hud.faces} people detected
                </div>
              )}
            </div>

            {secondaryOn && (
              <div className="vtile">
                <video
                  ref={(el) => {
                    (remoteRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
                    if (el && remoteStreamRef.current && el.srcObject !== remoteStreamRef.current) {
                      el.srcObject = remoteStreamRef.current;
                      el.play().catch(() => undefined);
                    }
                  }}
                  autoPlay
                  playsInline
                  muted
                />
                <div className="vlabel">
                  <span className="dot" style={{ color: "var(--info)" }} />
                  Secondary camera
                </div>
              </div>
            )}
          </div>

          {pairOpen && (
            <div className="card">
              <div className="card-title">
                <h3>Secondary camera (smartphone)</h3>
                <button className="btn btn-sm" onClick={() => setPairOpen(false)}>
                  Close
                </button>
              </div>
              <div className="qr-box">
                {qr && <img className="qr-canvas" src={qr} alt="Pairing QR code" />}
                <div style={{ flex: 1, minWidth: 240 }}>
                  <ol className="rules">
                    <li>Take a second phone and open its camera.</li>
                    <li>Scan the QR code — it opens a private pairing page.</li>
                    <li>Allow camera access on the phone, then prop it at an angle that shows your laptop/desktop screen, the side of your face and your desk together.</li>
                    <li>The feed appears here automatically; it is analysed for extra people and shows where you are looking.</li>
                  </ol>
                  <div className="pair-code mt">{session?.pair_token?.slice(0, 12) ?? ""}</div>
                  <p className="tiny dim" style={{ marginTop: 8 }}>
                    The code is temporary and only valid while this interview is running.
                    Demo tip: open the link in a second window on this machine if you
                    have no phone handy.
                  </p>
                  <p className="tiny" style={{ color: secondaryOn ? "var(--ok)" : "var(--warn)" }}>
                    {secondaryOn
                      ? "● Connected — streaming"
                      : "○ Waiting for the phone to connect…"}
                  </p>
                </div>
              </div>
            </div>
          )}

          {current ? (
            <div className="prompt-card">
              <div className="eyebrow">
                {current.is_followup
                  ? "Follow-up question"
                  : current.category === "icebreaker"
                    ? "Warm-up question"
                    : "Question"}
                {current.category && current.category !== "icebreaker"
                  ? ` · ${current.category}`
                  : ""}
              </div>
              <div className="q">{current.question_text}</div>
              {current.category === "icebreaker" && (
                <div className="fu">
                  A light opener to help you settle in — take your time, this
                  one is not scored.
                </div>
              )}
              {followInfo && <div className="fu">{followInfo}</div>}

              <div className="row mt">
                <button
                  className="btn btn-sm"
                  onClick={() => speak(current.question_text, () => startListening())}
                  disabled={speaking}
                >
                  🔁 Repeat
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => (listening ? stopListening() : startListening())}
                  disabled={speaking}
                >
                  {listening ? "◼ Stop listening" : "🎙 Start listening"}
                </button>
                <button className="btn btn-sm" onClick={() => setShowType(!showType)}>
                  {showType ? "Hide text box" : "Type instead"}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => submitAnswer("skipped")}
                  disabled={phase === "reviewing"}
                >
                  Skip
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => submitAnswer("answered")}
                  disabled={phase === "reviewing"}
                >
                  Submit answer
                </button>
                <span className="ts" style={{ marginLeft: "auto" }}>
                  {phase === "listening" ? `${limit}s left` : speaking ? "asking…" : ""}
                </span>
              </div>
            </div>
          ) : (
            <div className="prompt-card center">
              <div className="q">
                {phase === "preparing"
                  ? "Preparing your interview…"
                  : phase === "finishing"
                    ? "Finishing up and scoring your answers…"
                    : "Loading the first question…"}
              </div>
              <span className="spinner mt" />
            </div>
          )}

          {/* live transcript */}
          <div className="stack">
            <div className="meter">
              <span>{speaking ? "Interviewer speaking" : listening ? "Listening…" : "Idle"}</span>
              <div className="track">
                <i style={{ width: `${Math.min(100, hud.mic * 900)}%` }} />
              </div>
              <span className="ts">{hud.mic.toFixed(3)}</span>
            </div>

            <div className={"transcript" + (transcript ? "" : " placeholder")}>
              {showType
                ? null
                : transcript ||
                  (phase === "listening"
                    ? "Listening — start speaking. If nothing is transcribed, press “Type instead”."
                    : "Your answer will appear here as it is transcribed.")}
            </div>

            {showType && (
              <textarea
                rows={4}
                autoFocus
                placeholder="Type your answer instead…"
                value={transcript}
                onChange={(e) => {
                  typedRef.current = true;
                  setTranscript(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                    submitAnswer("answered");
                }}
              />
            )}
          </div>
        </div>

        {/* -------------------------------------------------------- rail */}
        <aside className="stack">
          <div className="card">
            <div className="card-title">
              <h3>Interview progress</h3>
            </div>
            <dl className="kv">
              <dt>Answered</dt>
              <dd>{answeredCount}</dd>
              <dt>Remaining</dt>
              <dd>{Math.max(0, queue.length - index)}</dd>
              <dt>Follow-ups</dt>
              <dd>
                {answers.filter((a) => a.is_followup).length} /{" "}
                {session?.interview?.max_followups ?? 0}
              </dd>
              <dt>Elapsed</dt>
              <dd>{timeLeft}</dd>
              <dt>Backup questions</dt>
              <dd>{backupsUsed} / 2</dd>
              <dt>Eye direction</dt>
              <dd>{hud.eye ?? "on screen"}</dd>
              <dt>Device scan</dt>
              <dd>{hud.scan ? `active · alerts ${deviceAlerts}/${MAX_DEVICE_ALERTS}` : "starting…"}</dd>
              <dt>Both cameras</dt>
              <dd>
                {!secondaryOn
                  ? "phone not paired"
                  : hud.env === "match"
                    ? "same room"
                    : hud.env === "mismatch"
                      ? "different rooms?"
                      : "checking…"}
              </dd>
              <dt>Identity</dt>
              <dd>
                {!session?.candidate
                  ? "no photo"
                  : idState === "verified"
                    ? `verified${idScore !== null ? ` · ${Math.round(idScore * 100)}%` : ""}`
                    : idState === "mismatch"
                      ? "no match — see feed"
                      : idState === "loading"
                        ? "checking…"
                        : idState === "unavailable"
                          ? "unavailable"
                          : "pending"}
              </dd>
            </dl>
            <button className="btn btn-danger btn-block mt" onClick={finish}>
              End interview early
            </button>
          </div>

          <div className="card">
            <div className="card-title">
              <h3>Proctoring feed</h3>
              <span className="badge">{liveEvents.length}</span>
            </div>
            <p className="tiny dim">
              Observations for human review — never a verdict.
            </p>
            <div className="feed">
              {liveEvents.length === 0 && (
                <p className="tiny dim">No observations yet.</p>
              )}
              {liveEvents.map((e, i) => (
                <div className={`feed-item ${e.severity}`} key={`${e.id}-${i}`}>
                  <div className="head">
                    <span>{INCIDENT_LABELS[e.type] ?? e.type}</span>
                    <span className="ts">{clock(e.ts_ms)}</span>
                  </div>
                  <div className="obs">{e.observed}</div>
                  <div className="inf">{e.inference}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>Privacy</h3>
            <p className="tiny dim" style={{ marginBottom: 0 }}>
              {session?.consent_recording
                ? "Recording consent given — video is captured for reviewer access."
                : "Recording consent not given — no recording is stored."}
              <br />
              {session?.consent_proctoring
                ? "Proctoring consent given — sensor observations are logged with timestamps."
                : "Proctoring consent not given."}
            </p>
          </div>
        </aside>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {!fsOk && (
        <div className="fs-overlay">
          <div className="card center" style={{ maxWidth: 430, padding: 28 }}>
            <div className="brand-mark" style={{ fontSize: 34 }}>◈</div>
            <h2 style={{ marginTop: 6 }}>Fullscreen required</h2>
            <p className="muted">
              The interview must stay in fullscreen. Do not switch tabs or
              windows — leaving fullscreen or losing focus issues a warning, and
              a third warning ends the interview. An unnecessary device in view
              is alerted once, then ends the interview.
            </p>
            <button className="btn btn-primary btn-block" onClick={enterFullscreen}>
              Enter fullscreen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
