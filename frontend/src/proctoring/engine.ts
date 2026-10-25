/**
 * Proctoring engine: runs the detectors and turns raw measurements into
 * timestamped, reviewable events.
 *
 * Every emission carries two distinct strings:
 *   observed  - what the sensor actually measured (fact)
 *   inference - a cautious possible meaning, always phrased for human review
 *
 * Nothing here ever produces a verdict; a single event is never treated as
 * proof of anything.
 */
import { AudioMonitor, type AudioSample } from "./audio";
import { DeviceDetector } from "./devices";
import { FaceAnalyzer, type FaceSignal } from "./vision";

export type Severity = "info" | "warning" | "high";

export interface ProctorEvent {
  type: string;
  ts_ms: number;
  observed: string;
  inference: string;
  value?: string;
  duration_ms?: number;
  severity?: Severity;
  evidence_data_url?: string | null;
  feed?: "primary" | "secondary";
}

export interface EngineState {
  running: boolean;
  faceCount: number;
  yaw: number | null;
  pitch: number | null;
  visionReady: boolean;
  visionError?: string;
  micLevel: number;
  speaking: boolean;
  cameraOk: boolean;
  micOk: boolean;
  lastEvent: ProctorEvent | null;
  /** direction the eyes point right now (null = on screen / unknown) */
  eyeDir: string | null;
  /** extra-device alerts raised so far (the rules allow one, two disqualify) */
  deviceAlerts: number;
  deviceScanReady: boolean;
  /** "match" | "mismatch" | "unknown" - both cameras show the same room */
  environment: "match" | "mismatch" | "unknown";
}

interface Thresholds {
  eyeHoldMs: number;
  eyeRepeatCount: number;
  eyeRepeatWindowMs: number;
  glanceYawDeg: number;
  glanceMinMs: number;
  glanceMaxCount: number;
  glanceWindowMs: number;
  lipDesyncMs: number;
  lipStillRange: number;
  glitchMs: number;
  blackLuma: number;
  deviceScanMs: number;
  deviceConfirmScans: number;
  gazeYawDeg: number;
  gazePitchDeg: number;
  gazeMinMs: number;
  absentMinMs: number;
  silenceMs: number;
  loudDuringPrompt: number;
  loudDuringPromptMs: number;
}

const DEFAULTS: Thresholds = {
  // Rule: head turned more than 30 degrees from the camera axis for more than
  // 7 seconds is one warning; shorter turns are never counted as a warning.
  gazeYawDeg: 30,
  gazePitchDeg: 30,
  gazeMinMs: 7000,
  // Rule: eyes held in the same off-screen direction for 5 seconds is a
  // warning; the same direction 3 times inside a minute is one too.
  eyeHoldMs: 5000,
  eyeRepeatCount: 3,
  eyeRepeatWindowMs: 60000,
  // Rule: more than 2 glances toward the side of the room where the phone
  // sits (short head turns that return before the 7 s warning) is flagged.
  glanceYawDeg: 20,
  glanceMinMs: 400,
  glanceMaxCount: 2,
  glanceWindowMs: 180000,
  // Voice energy for this long while the lips barely move is a desync flag.
  lipDesyncMs: 1800,
  lipStillRange: 0.06,
  // Camera frozen, covered or stopped for this long deploys a backup question.
  glitchMs: 5000,
  blackLuma: 10,
  // Unnecessary-device scan cadence; a sighting must repeat to be confirmed.
  deviceScanMs: 2500,
  deviceConfirmScans: 2,
  absentMinMs: 3500,
  silenceMs: 10000,
  loudDuringPrompt: 0.055,
  loudDuringPromptMs: 1600,
};

/** Keys we will not re-emit inside a cool-down window (anti-spam). */
const COOLDOWN_MS: Record<string, number> = {
  face_absent: 20000,
  multiple_faces: 15000,
  gaze_aversion: 9000,
  // Each emission already requires 10 s of sustained aversion, so a short
  // cool-down only debounces double-fires; consecutive episodes must each
  // reach the warning counter.
  prolonged_gaze_aversion: 1200,
  secondary_voice: 25000,
  background_noise: 20000,
  silence: 30000,
  camera_lost: 8000,
  microphone_lost: 8000,
  tab_blur: 6000,
  secondary_camera_disconnected: 10000,
  secondary_multiple_faces: 15000,
  secondary_camera_connected: 5000,
  vision_unavailable: 60000,
  eye_gaze_hold: 1200,
  mobile_glance: 30000,
  lip_audio_desync: 20000,
  extra_device: 30000,
  camera_glitch: 30000,
  environment_mismatch: 90000,
  environment_match: 600000,
  secondary_camera_unstable: 30000,
};

function fmtDeg(v: number | null) {
  return v === null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(1)} deg`;
}

export class ProctoringEngine {
  readonly startedAt = Date.now();
  private sessionId: number;
  private onEvent: (e: ProctorEvent) => void;
  private primaryVideo: HTMLVideoElement | null = null;
  private secondaryVideo: HTMLVideoElement | null = null;
  private primaryStream: MediaStream | null = null;
  private secondaryStream: MediaStream | null = null;

  private analyzer = new FaceAnalyzer();
  private audio = new AudioMonitor();
  private visionTimer: number | null = null;
  private pollTimer: number | null = null;
  private visionDelay = 240;

  private lastEmit: Record<string, number> = {};
  private faceSince: number | null = null;
  private noFaceSince: number | null = null;
  private gazeSince: number | null = null;
  private gazeHits: number[] = [];
  private loudSince: number | null = null;
  private promptActive = false;
  private stopped = false;

  // eye-direction hold + repeat tracking
  private eyeDir: string | null = null;
  private eyeSince: number | null = null;
  private eyeLostAt = 0;
  private eyeEpisodes: { dir: string; t: number }[] = [];
  // short head turns toward the phone side
  private turnSince: number | null = null;
  private turnSide = 0;
  private glances: { side: number; t: number }[] = [];
  // mouth movement vs voice
  private mouthHist: { t: number; v: number }[] = [];
  private speechSince: number | null = null;
  private lastFaceYaw: number | null = null;
  // camera freeze / cover
  private lastVideoTime = -1;
  private frozenSince: number | null = null;
  private darkSince: number | null = null;
  private lumaCanvas: HTMLCanvasElement | null = null;
  // extra-device scan
  private devices = new DeviceDetector();
  private deviceTimer: number | null = null;
  private deviceFeedToggle = 0;
  private deviceStrikes: Record<string, number> = { primary: 0, secondary: 0 };
  private secondaryDrops = 0;
  // environment match
  private envTimer: number | null = null;

  /** Called by the interview room: true while the interviewer is speaking. */
  setPromptActive(active: boolean) {
    this.promptActive = active;
    if (!active) this.loudSince = null;
  }

  state: EngineState = {
    running: false, faceCount: 0, yaw: null, pitch: null, visionReady: false,
    micLevel: 0, speaking: false, cameraOk: false, micOk: false, lastEvent: null,
    eyeDir: null, deviceAlerts: 0, deviceScanReady: false, environment: "unknown",
  };

  constructor(sessionId: number, onEvent: (e: ProctorEvent) => void) {
    this.sessionId = sessionId;
    this.onEvent = onEvent;
  }

  attachPrimary(stream: MediaStream, video: HTMLVideoElement) {
    this.primaryStream = stream;
    this.primaryVideo = video;
    this.state.cameraOk = stream.getVideoTracks().length > 0;
    this.state.micOk = stream.getAudioTracks().length > 0;
    this.watchDevices(stream, "primary");
  }

  attachSecondary(stream: MediaStream | null, video: HTMLVideoElement | null) {
    if (this.secondaryStream && this.secondaryStream !== stream) {
      this.secondaryStream.getTracks().forEach((t) => t.removeEventListener("ended", this.secondaryEnded));
    }
    this.secondaryStream = stream;
    this.secondaryVideo = video;
    if (this.envTimer !== null) {
      window.clearTimeout(this.envTimer);
      this.envTimer = null;
    }
    if (stream) {
      // compare the two rooms shortly after the phone starts streaming, then
      // keep re-checking so a swapped camera is noticed
      this.envTimer = window.setTimeout(() => this.checkEnvironment(), 5000);
      stream.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", this.secondaryEnded));
      this.emit({
        type: "secondary_camera_connected", severity: "info",
        observed: "Secondary camera stream started producing frames.",
        inference: "Secondary view is live and available for monitoring.",
      });
    }
  }

  /** The paired phone left the call (peer left / track ended). */
  noteSecondaryDisconnected() {
    this.secondaryDrops += 1;
    if (this.secondaryDrops >= 2) {
      this.emit({
        type: "secondary_camera_unstable", severity: "warning",
        value: `${this.secondaryDrops} stops`,
        observed: `The paired phone camera stopped ${this.secondaryDrops} times.`,
        inference: "The rules allow the phone camera to stop once; "
          + "repeated stops can hide part of the room.",
      });
    }
  }

  private secondaryEnded = () => {
    this.noteSecondaryDisconnected();
    this.emit({
      type: "secondary_camera_disconnected", severity: "warning",
      observed: "The secondary camera video track ended unexpectedly.",        inference: "The phone may have left, locked, or lost connectivity.",
      });
  };

  private watchDevices(stream: MediaStream, feed: "primary" | "secondary") {
    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (feed !== "primary") return;
        if (track.kind === "video") {
          this.state.cameraOk = false;
          this.emit({
            type: "camera_lost", severity: "high",
            observed: `Primary camera track "${track.label || "camera"}" ended.`,
            inference: "The camera was stopped, unplugged or claimed by another app.",
          });
        } else {
          this.state.micOk = false;
          this.emit({
            type: "microphone_lost", severity: "high",
            observed: `Microphone track "${track.label || "mic"}" ended.`,
            inference: "The microphone was stopped, unplugged or claimed by another app.",
          });
        }
      });
    });
  }

  async start() {
    this.stopped = false;
    this.state.running = true;

    document.addEventListener("visibilitychange", this.onVisibility);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);

    const ok = await this.analyzer.init();
    this.state.visionReady = ok;
    if (!ok) {
      this.state.visionError = this.analyzer.error ?? "unknown";
      this.emit({
        type: "vision_unavailable", severity: "warning",
        observed: `Face analysis could not start: ${this.analyzer.error ?? "unknown"}.`,
        inference: "Face-based signals are unavailable; audio, device and focus "
          + "monitoring remain active.",
      });
    }

    if (this.primaryStream) {
      await this.audio.start(this.primaryStream);
      this.audio.onSample = (s) => this.onAudio(s);
    }

    this.visionTimer = window.setTimeout(() => this.visionTick(), this.visionDelay);
    this.pollTimer = window.setInterval(() => this.pollTick(), 1000);

    // Extra-device detection loads in the background; the interview never waits.
    void this.devices.init().then((ok) => {
      this.state.deviceScanReady = ok;
      if (ok && !this.stopped) {
        this.deviceTimer = window.setTimeout(() => void this.deviceTick(), 4000);
      }
    });
  }

  stop() {
    this.stopped = true;
    this.state.running = false;
    if (this.visionTimer !== null) window.clearTimeout(this.visionTimer);
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.visionTimer = null;
    this.pollTimer = null;
    if (this.deviceTimer !== null) window.clearTimeout(this.deviceTimer);
    if (this.envTimer !== null) window.clearTimeout(this.envTimer);
    this.deviceTimer = null;
    this.envTimer = null;
    this.devices.close();
    document.removeEventListener("visibilitychange", this.onVisibility);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.audio.onSample = null;
    this.audio.stop();
    this.analyzer.close();
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.emit({
        type: "tab_blur", severity: "warning",
        observed: "The interview tab was hidden or lost focus.",
        inference: "The candidate may have switched to another application.",
      });
    }
  };

  private onDeviceChange = () => {
    const cams = this.primaryStream?.getVideoTracks().length ?? 0;
    const mics = this.primaryStream?.getAudioTracks().length ?? 0;
    if (!cams) {
      this.emit({
        type: "camera_lost", severity: "high",
        observed: "Device enumeration reports no available camera.",
        inference: "The camera was disconnected or is in use elsewhere.",
      });
    }
    if (!mics) {
      this.emit({
        type: "microphone_lost", severity: "high",
        observed: "Device enumeration reports no available microphone.",
        inference: "The microphone was disconnected or is in use elsewhere.",
      });
    }
  };

  // ------------------------------------------------------------------ vision
  private visionTick() {
    if (this.stopped) return;
    let slowest = 0;

    const run = (video: HTMLVideoElement | null, feed: "primary" | "secondary") => {
      if (!video || !video.videoWidth) return;
      const sig: FaceSignal = this.analyzer.analyze(video, feed === "primary");
      slowest = Math.max(slowest, sig.inferenceMs);
      if (feed === "primary") {
        this.state.faceCount = sig.faceCount;
        this.state.yaw = sig.yaw;
        this.state.pitch = sig.pitch;
      }
      if (!sig.ready) return;
      this.handleFaceSignal(sig, feed, video);
    };

    run(this.primaryVideo, "primary");
    run(this.secondaryVideo, "secondary");

    // Keep the main thread responsive: when inference is expensive (CPU
    // delegate, large frames, two feeds) back off automatically, otherwise
    // sample at the normal proctoring rate.
    this.visionDelay = Math.min(900, Math.max(240, Math.round(slowest * 3)));
    this.visionTimer = window.setTimeout(() => this.visionTick(), this.visionDelay);
  }

  private handleFaceSignal(sig: FaceSignal, feed: "primary" | "secondary",
                           video: HTMLVideoElement) {
    const now = Date.now();
    const ts = now - this.startedAt;
    const multiType = feed === "primary" ? "multiple_faces" : "secondary_multiple_faces";
    const absentType = feed === "primary" ? "face_absent" : "face_absent";

    // --- person count -----------------------------------------------------
    if (sig.faceCount > 1) {
      this.emit({
        type: multiType, severity: "high", ts_ms: ts, feed,
        value: `${sig.faceCount} faces`,
        observed: `${sig.faceCount} faces detected in the ${feed} frame for `
          + `consecutive samples.`,
        inference: feed === "primary"
          ? "A second person may be in frame; review the captured evidence."
          : "More than one person is visible in the secondary view; review.",
        evidence_data_url: feed === "primary" ? this.snapshot(video) : null,
      });
      this.faceSince = null;
      this.noFaceSince = null;
      return;
    }

    // --- presence ---------------------------------------------------------
    if (sig.faceCount === 0) {
      this.faceSince = null;
      if (this.noFaceSince === null) this.noFaceSince = now;
      const dur = now - this.noFaceSince;
      if (feed === "primary" && dur >= DEFAULTS.absentMinMs) {
        this.emit({
          type: absentType, severity: "warning", ts_ms: ts, duration_ms: dur,
          value: `${(dur / 1000).toFixed(1)}s`,
          observed: `No face detected in the primary camera for ${(dur / 1000).toFixed(1)}s.`,
          inference: "The candidate may have stepped away or be out of framing.",
        });
        this.noFaceSince = null;
      }
      return;
    }

    if (this.noFaceSince !== null) {
      const dur = now - this.noFaceSince;
      if (feed === "primary" && dur > 1500) {
        this.emit({
          type: "face_reacquired", severity: "info", ts_ms: ts, duration_ms: dur,
          observed: "A face returned to the primary camera frame.",
          inference: "Framing restored after a short absence.",
        });
      }
      this.noFaceSince = null;
    }
    if (this.faceSince === null) this.faceSince = now;

    if (feed !== "primary" || sig.yaw === null || sig.pitch === null) return;

    this.trackEyes(sig, now, ts, video);
    this.trackGlances(sig, now, ts, video);
    this.lastFaceYaw = sig.yaw;
    if (sig.mouth !== null) {
      this.mouthHist.push({ t: now, v: sig.mouth });
      this.mouthHist = this.mouthHist.filter((m) => now - m.t < 4000);
    }

    // --- head orientation (30 deg for more than 7 s = warning) -------------
    const off = Math.abs(sig.yaw) >= DEFAULTS.gazeYawDeg ||
                Math.abs(sig.pitch) >= DEFAULTS.gazePitchDeg;
    if (off) {
      if (this.gazeSince === null) this.gazeSince = now;
      const dur = now - this.gazeSince;
      if (dur >= DEFAULTS.gazeMinMs) {
        this.emit({
          type: "prolonged_gaze_aversion", severity: "warning", ts_ms: ts,
          duration_ms: dur,
          value: `yaw ${fmtDeg(sig.yaw)}, pitch ${fmtDeg(sig.pitch)}`,
          observed: `Head turned beyond ${DEFAULTS.gazeYawDeg} deg from the camera axis for `
            + `${(dur / 1000).toFixed(1)}s (yaw ${fmtDeg(sig.yaw)}, pitch ${fmtDeg(sig.pitch)}).`,
          inference: "Attention moved away from the screen for a sustained period; "
            + "this alone is not evidence of assistance.",
          evidence_data_url: this.snapshot(video),
        });
        this.gazeSince = null;
        this.gazeHits.push(now);
        this.gazeHits = this.gazeHits.filter((t) => now - t < 45000);
        if (this.gazeHits.length >= 3) {
          this.emit({
            type: "gaze_aversion", severity: "warning", ts_ms: ts,
            value: `${this.gazeHits.length} occurrences in 45s`,
            observed: `${this.gazeHits.length} separate off-screen intervals within 45 seconds.`,
            inference: "A repeated pattern worth reviewing in context; not a conclusion.",
          });
          this.gazeHits = [];
        }
      }
    } else {
      this.gazeSince = null;
    }
  }

  // ------------------------------------------------------------------- audio
  private onAudio(s: AudioSample) {
    if (this.stopped) return;
    this.state.micLevel = s.rms;
    this.state.speaking = s.speech;

    const now = Date.now();
    const ts = now - this.startedAt;
    this.checkLipSync(s, now, ts);

    // Audio present while the interviewer holds the floor -> possible another
    // voice or background activity worth reviewing.
    if (this.promptActive && s.rms > DEFAULTS.loudDuringPrompt) {
      if (this.loudSince === null) this.loudSince = now;
      if (now - this.loudSince >= DEFAULTS.loudDuringPromptMs) {
        this.emit({
          type: "secondary_voice", severity: "high", ts_ms: ts,
          duration_ms: now - this.loudSince,
          value: `rms ${s.rms.toFixed(3)}`,
          observed: `Sustained microphone energy (rms ${s.rms.toFixed(3)} > `
            + `${DEFAULTS.loudDuringPrompt}) for ${((now - this.loudSince) / 1000).toFixed(1)}s `
            + `while the AI interviewer was speaking.`,
          inference: "Another voice or sound may be present in the room; review the audio.",
        });
        this.loudSince = null;
      }
    } else {
      this.loudSince = null;
    }
  }

  // -------------------------------------------------------------- idle poll
  private pollTick() {
    if (this.stopped) return;
    const now = Date.now();
    const ts = now - this.startedAt;
    this.checkCamera(now, ts);
    const waitingForAnswer = this.promptActive === false && !this.audio.speechActive;

    if (waitingForAnswer && this.audio.msSinceSpeech(now) >= DEFAULTS.silenceMs) {
      this.emit({
        type: "silence", severity: "info", ts_ms: ts,
        duration_ms: this.audio.msSinceSpeech(now),
        value: `${Math.round(this.audio.msSinceSpeech(now) / 1000)}s`,
        observed: `No speech energy for ${Math.round(this.audio.msSinceSpeech(now) / 1000)}s.`,
        inference: "The candidate may be thinking, muted, or disconnected.",
      });
    }
  }


  // ------------------------------------------------------- eyes / glances
  /** Eyes held in one off-screen direction (5 s) or repeated 3x in a minute. */
  private trackEyes(sig: FaceSignal, now: number, ts: number, video: HTMLVideoElement) {
    const dir = sig.eyeDir;
    this.state.eyeDir = dir;
    if (dir) {
      this.eyeLostAt = 0;
      if (this.eyeDir !== dir) {
        this.closeEyeEpisode(now, ts);
        this.eyeDir = dir;
        this.eyeSince = now;
      }
      const dur = now - (this.eyeSince ?? now);
      if (dur >= DEFAULTS.eyeHoldMs) {
        this.emit({
          type: "eye_gaze_hold", severity: "warning", ts_ms: ts, duration_ms: dur,
          value: `${dir} ${(dur / 1000).toFixed(1)}s`,
          observed: `Eyes held ${dir} (off-screen) for ${(dur / 1000).toFixed(1)}s.`,
          inference: "Sustained eye direction away from the screen; this alone is "
            + "not evidence of assistance.",
          evidence_data_url: this.snapshot(video),
        });
        this.eyeSince = now;
      }
    } else if (this.eyeDir) {
      // a blink or tracking flicker must not reset a real hold
      if (!this.eyeLostAt) this.eyeLostAt = now;
      else if (now - this.eyeLostAt > 700) this.closeEyeEpisode(now, ts);
    }
  }

  private closeEyeEpisode(now: number, ts: number) {
    const dir = this.eyeDir;
    const since = this.eyeSince;
    this.eyeDir = null;
    this.eyeSince = null;
    this.eyeLostAt = 0;
    if (!dir || since === null || now - since < 1500) return;
    this.eyeEpisodes.push({ dir, t: now });
    this.eyeEpisodes = this.eyeEpisodes.filter(
      (e) => now - e.t < DEFAULTS.eyeRepeatWindowMs);
    const same = this.eyeEpisodes.filter((e) => e.dir === dir).length;
    if (same >= DEFAULTS.eyeRepeatCount) {
      this.emit({
        type: "eye_gaze_hold", severity: "warning", ts_ms: ts,
        value: `${dir} x${same}`,
        observed: `Eyes went ${dir} ${same} separate times within `
          + `${Math.round(DEFAULTS.eyeRepeatWindowMs / 1000)}s.`,
        inference: "A repeated pattern toward the same side worth reviewing in "
          + "context; not a conclusion.",
      });
      this.eyeEpisodes = this.eyeEpisodes.filter((e) => e.dir !== dir);
    }
  }

  /** Short head turns toward one side more than twice = glancing at the phone. */
  private trackGlances(sig: FaceSignal, now: number, ts: number, video: HTMLVideoElement) {
    const yaw = sig.yaw ?? 0;
    const turned = Math.abs(yaw) >= DEFAULTS.glanceYawDeg;
    if (turned) {
      if (this.turnSince === null) {
        this.turnSince = now;
        this.turnSide = Math.sign(yaw);
      }
      return;
    }
    if (this.turnSince === null) return;
    const dur = now - this.turnSince;
    const side = this.turnSide;
    this.turnSince = null;
    // anything held for 7 s+ already produced a head-pose warning
    if (dur < DEFAULTS.glanceMinMs || dur >= DEFAULTS.gazeMinMs) return;
    this.glances.push({ side, t: now });
    this.glances = this.glances.filter((g) => now - g.t < DEFAULTS.glanceWindowMs);
    const same = this.glances.filter((g) => g.side === side).length;
    if (same > DEFAULTS.glanceMaxCount) {
      this.emit({
        type: "mobile_glance", severity: "warning", ts_ms: ts,
        value: `${same} glances ${side > 0 ? "left" : "right"}`,
        observed: `${same} separate head turns toward the same side within `
          + `${Math.round(DEFAULTS.glanceWindowMs / 60000)} minutes.`,
        inference: "Repeated glances toward one side; the paired phone may have "
          + "drawn attention. Review the evidence frame.",
        evidence_data_url: this.snapshot(video),
      });
      this.glances = this.glances.filter((g) => g.side !== side);
    }
  }

  // ------------------------------------------------------------- lip sync
  /** Voice energy while the lips stay still = audio may come from elsewhere. */
  private checkLipSync(s: AudioSample, now: number, ts: number) {
    const last = this.mouthHist[this.mouthHist.length - 1];
    const eligible =
      !this.promptActive &&              // the interviewer's own voice leaks in
      s.speech && s.rms > 0.035 &&
      this.state.faceCount === 1 &&
      last !== undefined && now - last.t < 900 &&
      this.lastFaceYaw !== null && Math.abs(this.lastFaceYaw) < 25;
    if (!eligible) {
      this.speechSince = null;
      return;
    }
    if (this.speechSince === null) this.speechSince = now;
    if (now - this.speechSince < DEFAULTS.lipDesyncMs) return;

    const win = this.mouthHist.filter((m) => now - m.t <= DEFAULTS.lipDesyncMs);
    if (win.length < 4) return;
    const vals = win.map((m) => m.v);
    const range = Math.max(...vals) - Math.min(...vals);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (range < DEFAULTS.lipStillRange && mean < 0.15) {
      this.emit({
        type: "lip_audio_desync", severity: "high", ts_ms: ts,
        duration_ms: now - this.speechSince,
        value: `rms ${s.rms.toFixed(3)}, mouth range ${range.toFixed(3)}`,
        observed: `Voice energy (rms ${s.rms.toFixed(3)}) for `
          + `${((now - this.speechSince) / 1000).toFixed(1)}s while the lips were `
          + `nearly still (movement ${range.toFixed(3)}).`,
        inference: "Speech may be coming from another source, or the lips were "
          + "briefly not tracked; verify before drawing a conclusion.",
        evidence_data_url: this.primaryVideo ? this.snapshot(this.primaryVideo) : null,
      });
    }
    this.speechSince = null;
  }

  // -------------------------------------------------------- camera glitch
  private meanLuma(video: HTMLVideoElement): number | null {
    try {
      if (!this.lumaCanvas) {
        this.lumaCanvas = document.createElement("canvas");
        this.lumaCanvas.width = 16;
        this.lumaCanvas.height = 9;
      }
      const ctx = this.lumaCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx || !video.videoWidth) return null;
      ctx.drawImage(video, 0, 0, 16, 9);
      const d = ctx.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }
      return sum / (d.length / 4);
    } catch {
      return null;
    }
  }

  /** Frozen, covered or stopped primary camera for 5 s -> backup question. */
  private checkCamera(now: number, ts: number) {
    const video = this.primaryVideo;
    const stream = this.primaryStream;
    if (!video || !stream || !this.state.running) return;

    const track = stream.getVideoTracks()[0];
    const dead = !track || track.readyState === "ended" || track.muted || !track.enabled;
    const advancing = video.currentTime !== this.lastVideoTime;
    this.lastVideoTime = video.currentTime;
    const frozen = !advancing && document.visibilityState === "visible";
    const luma = this.meanLuma(video);
    const covered = luma !== null && luma < DEFAULTS.blackLuma;

    if (frozen || dead) {
      if (this.frozenSince === null) this.frozenSince = now;
    } else {
      this.frozenSince = null;
    }
    if (covered && !dead) {
      if (this.darkSince === null) this.darkSince = now;
    } else {
      this.darkSince = null;
    }

    const since = Math.min(this.frozenSince ?? Infinity, this.darkSince ?? Infinity);
    if (since === Infinity || now - since < DEFAULTS.glitchMs) return;
    const dur = now - since;
    const why = dead ? "the camera track stopped or was muted"
      : covered ? "the image is black (lens covered or camera off)"
      : "the video stopped updating";
    this.emit({
      type: "camera_glitch", severity: "warning", ts_ms: ts, duration_ms: dur,
      value: `${(dur / 1000).toFixed(1)}s`,
      observed: `Primary camera interrupted for ${(dur / 1000).toFixed(1)}s: ${why}.`,
      inference: "A technical fault or a deliberate camera cut; a backup question "
        + "is deployed so the interview still collects evidence.",
    });
    this.frozenSince = null;
    this.darkSince = null;
  }

  // -------------------------------------------------------- extra devices
  private async deviceTick() {
    if (this.stopped) return;
    try {
      const feeds: ["primary" | "secondary", HTMLVideoElement | null][] = [
        ["primary", this.primaryVideo],
      ];
      if (this.secondaryVideo && this.secondaryStream) {
        feeds.push(["secondary", this.secondaryVideo]);
      }
      const [feed, video] = feeds[this.deviceFeedToggle++ % feeds.length];
      const verdict = video ? await this.devices.scan(video, feed) : null;
      if (verdict && video) {
        if (verdict.extras.length) {
          this.deviceStrikes[feed] += 1;
          if (this.deviceStrikes[feed] >= DEFAULTS.deviceConfirmScans) {
            this.deviceStrikes[feed] = 0;
            const n = this.state.deviceAlerts + 1;
            const sent = this.emit({
              type: "extra_device", severity: "high", feed,
              value: `alert ${n}`,
              observed: `Unnecessary device detected: ${verdict.extras.join("; ")} `
                + `(alert ${n}).`,
              inference: "Only the laptop and the paired phone are allowed in "
                + "frame; the object may be misidentified, so review the frame.",
              evidence_data_url: this.snapshot(video),
            });
            if (sent) this.state.deviceAlerts = n;
          }
        } else {
          this.deviceStrikes[feed] = 0;
        }
      }
    } finally {
      if (!this.stopped) {
        this.deviceTimer = window.setTimeout(
          () => void this.deviceTick(), DEFAULTS.deviceScanMs);
      }
    }
  }

  // ---------------------------------------------------------- environment
  private fingerprint(video: HTMLVideoElement | null) {
    try {
      if (!video || video.readyState < 2 || !video.videoWidth) return null;
      const c = document.createElement("canvas");
      c.width = 32;
      c.height = 18;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, 32, 18);
      const d = ctx.getImageData(0, 0, 32, 18).data;
      const hue = new Array(8).fill(0);
      let r = 0, g = 0, b = 0, luma = 0, colourful = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        r += R; g += G; b += B;
        luma += 0.299 * R + 0.587 * G + 0.114 * B;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx - mn > 0.15 * 255 && mx > 40) {
          let h = 0;
          const dlt = mx - mn;
          if (mx === R) h = ((G - B) / dlt) % 6;
          else if (mx === G) h = (B - R) / dlt + 2;
          else h = (R - G) / dlt + 4;
          h = (h * 60 + 360) % 360;
          hue[Math.floor(h / 45) % 8] += 1;
          colourful += 1;
        }
      }
      const tot = r + g + b || 1;
      return {
        luma: luma / n,
        cr: r / tot,
        cg: g / tot,
        hue: colourful ? hue.map((v) => v / colourful) : null,
      };
    } catch {
      return null;
    }
  }

  /** Both cameras should show the same room: lighting, colour cast, palette. */
  private checkEnvironment() {
    if (this.stopped) return;
    const a = this.fingerprint(this.primaryVideo);
    const b = this.fingerprint(this.secondaryVideo);
    const ts = Date.now() - this.startedAt;
    if (a && b) {
      const lumaDiff = Math.abs(a.luma - b.luma) / 255;
      const chroma = Math.hypot(a.cr - b.cr, a.cg - b.cg);
      let hist = 1;
      if (a.hue && b.hue) hist = a.hue.reduce((s, v, i) => s + Math.min(v, b.hue![i]), 0);
      const mismatch = lumaDiff > 0.4 || (chroma > 0.1 && hist < 0.3);
      this.state.environment = mismatch ? "mismatch" : "match";
      const value = `light diff ${(lumaDiff * 100).toFixed(0)}%, palette ${(hist * 100).toFixed(0)}%`;
      if (mismatch) {
        this.emit({
          type: "environment_mismatch", severity: "warning", ts_ms: ts, value,
          observed: `The two cameras differ in lighting or colour (${value}).`,
          inference: "The feeds may show different rooms, or just different "
            + "exposure and angle; verify before relying on the phone view.",
          evidence_data_url: this.primaryVideo ? this.snapshot(this.primaryVideo) : null,
        });
      } else {
        this.emit({
          type: "environment_match", severity: "info", ts_ms: ts, value,
          observed: `Both cameras agree on lighting and colour (${value}).`,
          inference: "Both feeds are consistent with the same room.",
        });
      }
    }
    if (this.secondaryStream && !this.stopped) {
      this.envTimer = window.setTimeout(() => this.checkEnvironment(), 90000);
    }
  }

  // ----------------------------------------------------------------- helpers
  private emit(e: Omit<ProctorEvent, "ts_ms"> & { ts_ms?: number }): boolean {
    const now = Date.now();
    const last = this.lastEmit[e.type] ?? 0;
    const cd = COOLDOWN_MS[e.type] ?? 12000;
    if (now - last < cd) return false;
    this.lastEmit[e.type] = now;
    const ev: ProctorEvent = { ...e, ts_ms: e.ts_ms ?? now - this.startedAt };
    this.state.lastEvent = ev;
    this.onEvent(ev);
    return true;
  }

  /** Capture a small JPEG of the primary feed as review evidence. */
  snapshot(video: HTMLVideoElement): string | null {
    try {
      const w = 320;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 240;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, w, h);
      const url = canvas.toDataURL("image/jpeg", 0.6);
      return url.length < 700_000 ? url : null;
    } catch {
      return null;
    }
  }
}
