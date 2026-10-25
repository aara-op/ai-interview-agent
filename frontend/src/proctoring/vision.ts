/**
 * In-browser face analysis built on MediaPipe Tasks (FaceLandmarker).
 *
 * Deliberately lightweight: it reports *observations* (how many faces, where
 * they are, an approximate head orientation). Turning those observations into
 * a suspicion belongs to the caller and, ultimately, to the recruiter.
 *
 * Loading order for the WASM runtime and the model is local-first
 * (`/mp/wasm`, `/models/face_landmarker.task`) with a CDN fallback, so the
 * prototype also works when the vendored assets are missing.
 */
import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";

const WASM_SOURCES = [
  "/mp/wasm",
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
];

const MODEL_SOURCES = [
  "/models/face_landmarker.task",
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
];

export interface FaceBox {
  x: number; // normalised 0..1 of the *video content*
  y: number;
  w: number;
  h: number;
}

export interface FaceSignal {
  ready: boolean;
  error?: string;
  faceCount: number;
  boxes: FaceBox[];
  /** approximate yaw in degrees; + = turned to their left. null when no face */
  yaw: number | null;
  /** approximate pitch in degrees; + = looking down. null when no face */
  pitch: number | null;
  confidence: number;
  inferenceMs: number;
  /** direction the EYES point (independent of head pose); null = on screen
   *  or unknown */
  eyeDir: "left" | "right" | "up" | "down" | null;
  /** mouth activity 0..1 (jawOpen + lip funnel/pucker/stretch), null when
   *  blendshapes are unavailable */
  mouth: number | null;
}

export const EMPTY_SIGNAL: FaceSignal = {
  ready: false, faceCount: 0, boxes: [], yaw: null, pitch: null,
  confidence: 0, inferenceMs: 0, eyeDir: null, mouth: null,
};

/** Blendshape score lookup. */
function bs(map: Map<string, number>, name: string): number {
  return map.get(name) ?? 0;
}

/** Eye direction from the iris blendshapes; the dominant axis must be clear. */
function eyeDirection(map: Map<string, number>, mirror: boolean) {
  // "In" is toward the nose. For the left eye, looking toward the subject's
  // right is "in"; for the right eye the same movement is "out".
  const toRight = (bs(map, "eyeLookInLeft") + bs(map, "eyeLookOutRight")) / 2;
  const toLeft = (bs(map, "eyeLookOutLeft") + bs(map, "eyeLookInRight")) / 2;
  const up = (bs(map, "eyeLookUpLeft") + bs(map, "eyeLookUpRight")) / 2;
  const down = (bs(map, "eyeLookDownLeft") + bs(map, "eyeLookDownRight")) / 2;
  const horiz = toRight - toLeft;
  const vert = up - down;
  const T = 0.45;
  if (Math.abs(horiz) >= Math.abs(vert)) {
    if (horiz > T) return mirror ? "left" : "right";
    if (horiz < -T) return mirror ? "right" : "left";
  } else {
    if (vert > T + 0.1) return "up";
    // looking down at a keyboard/phone is the common cheating direction, but
    // reading the screen also dips the eyes; require a stronger signal
    if (-vert > T + 0.15) return "down";
  }
  return null;
}

// MediaPipe face-mesh indices used for the orientation estimate.
const NOSE_TIP = 1;
const CHIN = 152;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Convert normalised landmark coords to 0..1 of the video *element*. */
function mapBox(box: FaceBox, vw: number, vh: number, ew: number, eh: number) {
  if (!vw || !vh || !ew || !eh) return box;
  const scale = Math.max(ew / vw, eh / vh); // object-fit: cover
  const dw = vw * scale;
  const dh = vh * scale;
  const ox = (ew - dw) / 2;
  const oy = (eh - dh) / 2;
  return {
    x: (ox + box.x * dw) / ew,
    y: (oy + box.y * dh) / eh,
    w: (box.w * dw) / ew,
    h: (box.h * dh) / eh,
  };
}

export class FaceAnalyzer {
  private landmarker: FaceLandmarker | null = null;
  private lastTs = -1;
  private failed = false;
  error: string | null = null;
  backend = "";

  get ready() {
    return this.landmarker !== null;
  }

  async init(): Promise<boolean> {
    if (this.landmarker) return true;
    if (this.failed) return false;

    let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
    for (const base of WASM_SOURCES) {
      try {
        fileset = await FilesetResolver.forVisionTasks(base);
        this.backend = base;
        break;
      } catch {
        /* try the next source */
      }
    }
    if (!fileset) {
      this.failed = true;
      this.error = "Vision runtime unavailable (offline and CDN blocked).";
      return false;
    }

    for (const model of MODEL_SOURCES) {
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: model, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 2,
          minFaceDetectionConfidence: 0.3,
          minFacePresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
        });
        return true;
      } catch {
        try {
          this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: model, delegate: "CPU" },
            runningMode: "VIDEO",
            numFaces: 2,
            minFaceDetectionConfidence: 0.3,
            minFacePresenceConfidence: 0.3,
            minTrackingConfidence: 0.3,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: false,
          });
          return true;
        } catch {
          /* try the next model source */
        }
      }
    }
    this.failed = true;
    this.error = "Face model could not be downloaded.";
    return false;
  }

  analyze(video: HTMLVideoElement, mirror = false): FaceSignal {
    const t0 = performance.now();
    if (!this.landmarker) {
      return { ...EMPTY_SIGNAL, error: this.error ?? undefined };
    }
    if (video.readyState < 2 || !video.videoWidth) {
      return { ...EMPTY_SIGNAL, ready: true };
    }

    // detectForVideo requires a strictly increasing timestamp.
    const now = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = now;

    let result: FaceLandmarkerResult;
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return { ...EMPTY_SIGNAL, ready: true, error: this.error };
    }

    const faces = result.faceLandmarks ?? [];
    const boxes: FaceBox[] = [];
    let yaw: number | null = null;
    let pitch: number | null = null;
    let eyeDir: FaceSignal["eyeDir"] = null;
    let mouth: number | null = null;

    const blend = result.faceBlendshapes?.[0]?.categories;
    if (blend && blend.length) {
      const map = new Map<string, number>();
      blend.forEach((c) => map.set(c.categoryName, c.score));
      eyeDir = eyeDirection(map, mirror);
      mouth = Math.min(1,
        bs(map, "jawOpen") + 0.5 * (bs(map, "mouthFunnel") + bs(map, "mouthPucker")
          + bs(map, "mouthStretchLeft") + bs(map, "mouthStretchRight")) / 2);
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const aspect = vw / vh;

    faces.forEach((lm, idx) => {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of lm) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      boxes.push(mapBox(
        { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
        vw, vh, video.clientWidth || 1, video.clientHeight || 1,
      ));

      // --- approximate head orientation (primary face only) ---------------
      if (idx === 0 && lm.length > RIGHT_CHEEK) {
        const nose = lm[NOSE_TIP];
        const chin = lm[CHIN];
        const le = lm[LEFT_EYE_OUTER];
        const re = lm[RIGHT_EYE_OUTER];
        const lc = lm[LEFT_CHEEK];
        const rc = lm[RIGHT_CHEEK];

        const eyeMidX = ((le.x + re.x) / 2) * aspect;
        const noseX = nose.x * aspect;
        const eyeMidY = (le.y + re.y) / 2;
        const chinY = chin.y;
        const halfWidth = Math.abs(rc.x - lc.x) * aspect * 0.5 || 1e-6;
        const eyeToChin = chinY - eyeMidY || 1e-6;

        yaw = clamp(((noseX - eyeMidX) / halfWidth) * 55, -70, 70);
        const neutral = (nose.y - eyeMidY) / eyeToChin;
        pitch = clamp((neutral - 0.31) * 130, -50, 50);
      }
    });

    if (mirror) {
      boxes.forEach((b) => { b.x = 1 - b.x - b.w; });
      if (yaw !== null) yaw = -yaw;
    }

    return {
      ready: true,
      faceCount: faces.length,
      boxes,
      yaw: yaw === null ? null : Math.round(yaw * 10) / 10,
      pitch: pitch === null ? null : Math.round(pitch * 10) / 10,
      confidence: faces.length ? 0.9 : 0,
      inferenceMs: Math.round((performance.now() - t0) * 10) / 10,
      eyeDir: faces.length ? eyeDir : null,
      mouth: faces.length ? mouth : null,
    };
  }

  close() {
    try {
      this.landmarker?.close();
    } catch {
      /* ignore */
    }
    this.landmarker = null;
  }
}
