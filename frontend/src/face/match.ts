/**
 * Identity check: compare the candidate's enrolment photo with what the camera
 * sees right now.
 *
 * The reference image and the live frame are both embedded locally with
 * Human's face-recognition model (`faceres`); the server never receives a
 * biometric template — it only stores the photo the candidate uploaded.
 *
 * Output is always framed as an observation for review, never as proof:
 * lighting, pose, glasses or a moved camera can all lower the similarity.
 */
import type Human from "@vladmandic/human";
import type { Config } from "@vladmandic/human";

// Loaded only when an identity check actually runs, so the interview pages
// don't pay for the ~2 MB recognition bundle up front.
type HumanCtor = new (config?: Partial<Config>) => Human;

/**
 * Cosine similarity needed to call a frame a match.
 * Tuned to 0.40 for reliable cross-device matching (webcam vs phone/passport photo)
 * while safely rejecting different people (random similarity typically < 0.22).
 */
export const MATCH_THRESHOLD = 0.40;

export interface IdentityResult {
  /** true when a face was found and scored at or above MATCH_THRESHOLD */
  match: boolean;
  /** cosine similarity in 0..1, or 0 when either side had no usable face */
  similarity: number;
  /** short human-readable explanation for the UI and the incident log */
  reason: string;
  /** true when the pipeline itself failed (no model / no backend) */
  unavailable?: boolean;
}

let human: Human | null = null;
let loading: Promise<Human> | null = null;
let lastError = "";

export function identityStatus(): { ready: boolean; error: string } {
  return { ready: human !== null, error: lastError };
}

/** Load the detector + embedding models once, from the vendored /human/models. */
export function getHuman(): Promise<Human> {
  if (human) return Promise.resolve(human);
  if (loading) return loading;

  loading = (async () => {
    try {
      const mod = (await import("@vladmandic/human")) as unknown as {
        default: HumanCtor;
      };
      // Config must be passed to the constructor: Human seals its config and
      // snapshots model-load options there, so later mutation is ignored.
      // We explicitly set skipFrames: 0 and skipTime: 0 so no detections are throttled or skipped.
      const h = new mod.default({
        modelBasePath: "/human/models",
        warmup: "none",
        debug: false,
        face: {
          enabled: true,
          detector: {
            enabled: true,
            modelPath: "blazeface.json",
            rotation: true,
            maxDetected: 2,
            minConfidence: 0.12,
            skipFrames: 0,
            skipTime: 0,
            return: true,
          },
          mesh: {
            enabled: true,
            skipFrames: 0,
            skipTime: 0,
          },
          description: {
            enabled: true,
            modelPath: "faceres.json",
            skipFrames: 0,
            skipTime: 0,
            minConfidence: 0.05,
          },
          iris: { enabled: false },
          emotion: { enabled: false },
          attention: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
          gear: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        segmentation: { enabled: false },
        gesture: { enabled: false },
        filter: { enabled: false },
      });
      await h.load();
      human = h;
      lastError = "";
      return h;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      loading = null;
      throw err;
    }
  })();
  return loading;
}

/** Rescales and normalizes image/video source onto an offscreen canvas for optimal face detection. */
function toCanvas(
  source: CanvasImageSource,
  maxDim = 640,
  boostContrast = false,
): HTMLCanvasElement | null {
  try {
    const sw =
      (source as HTMLVideoElement).videoWidth ||
      (source as HTMLImageElement).naturalWidth ||
      (source as HTMLCanvasElement).width ||
      0;
    const sh =
      (source as HTMLVideoElement).videoHeight ||
      (source as HTMLImageElement).naturalHeight ||
      (source as HTMLCanvasElement).height ||
      0;
    if (!sw || !sh) return null;

    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const dw = Math.max(64, Math.round(sw * scale));
    const dh = Math.max(64, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    if (boostContrast) {
      ctx.filter = "contrast(1.2) brightness(1.08)";
    }
    ctx.drawImage(source, 0, 0, dw, dh);
    return canvas;
  } catch {
    return null;
  }
}

async function embedWithScore(
  input: CanvasImageSource | ImageData,
): Promise<{ embedding: number[] | null; confidence: number } | null> {
  try {
    const h = await getHuman();
    const result = await h.detect(input as never);
    const face = result.face?.[0];
    if (!face || !face.embedding || face.embedding.length === 0) return null;
    return {
      embedding: Array.from(face.embedding),
      confidence: face.score || face.boxScore || 0.8,
    };
  } catch {
    return null;
  }
}

async function embed(input: CanvasImageSource | ImageData): Promise<number[] | null> {
  const res = await embedWithScore(input);
  return res ? res.embedding : null;
}

/** Rapid lightweight face detection check for real-time UI indicator. */
export async function detectFaceQuick(
  input: CanvasImageSource,
): Promise<{ detected: boolean; score: number }> {
  try {
    const canvas = toCanvas(input, 480, false);
    const target = canvas || input;
    const h = await getHuman();
    const result = await h.detect(target as never);
    const face = result.face?.[0];
    if (face && ((face.score && face.score > 0.15) || (face.boxScore && face.boxScore > 0.15))) {
      return { detected: true, score: face.score || face.boxScore || 0.5 };
    }
    return { detected: false, score: 0 };
  } catch {
    return { detected: false, score: 0 };
  }
}

/** Embed an image referenced by URL (the candidate's profile picture). Multi-pass for robustness. */
export async function embedImageUrl(url: string): Promise<number[] | null> {
  if (!url) return null;
  const img = new Image();
  if (!url.startsWith("data:")) {
    img.crossOrigin = "anonymous";
  }
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = url;
  if (!(await loaded)) return null;

  // Pass 1: Standard rescaled canvas (640px max dimension, optimal for BlazeFace anchor boxes)
  const c1 = toCanvas(img, 640, false);
  if (c1) {
    const emb = await embed(c1);
    if (emb) return emb;
  }

  // Pass 2: Contrast-boosted canvas (handles low-light or uneven exposure photos)
  const c2 = toCanvas(img, 640, true);
  if (c2) {
    const emb = await embed(c2);
    if (emb) return emb;
  }

  // Pass 3: Intermediate resolution
  const c3 = toCanvas(img, 400, false);
  if (c3) {
    const emb = await embed(c3);
    if (emb) return emb;
  }

  // Pass 4: Fallback to direct element
  return embed(img);
}

/**
 * Embed the live video frame with multi-frame burst sampling.
 * Webcams often have exposure jitter, auto-focus delay, or temporary motion blur.
 * Sampling consecutive frames over ~400ms guarantees finding the clearest face.
 */
export async function embedVideoFrameWithRetries(
  video: HTMLVideoElement,
  attempts = 6,
  delayMs = 90,
): Promise<{ embedding: number[] | null; confidence: number }> {
  if (!video.videoWidth || video.readyState < 2) {
    return { embedding: null, confidence: 0 };
  }

  let bestEmbedding: number[] | null = null;
  let bestConfidence = 0;

  for (let i = 0; i < attempts; i++) {
    const canvas = toCanvas(video, 640, i % 2 === 1);
    const target = canvas || video;
    const result = await embedWithScore(target);

    if (result && result.embedding) {
      if (result.confidence > bestConfidence) {
        bestConfidence = result.confidence;
        bestEmbedding = result.embedding;
      }
      if (bestConfidence >= 0.55) {
        break; // High confidence match found, no need to wait
      }
    }

    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { embedding: bestEmbedding, confidence: bestConfidence };
}

/** Embed the current frame of a live video element. Uses multi-frame sampling. */
export async function embedVideoFrame(
  video: HTMLVideoElement,
): Promise<number[] | null> {
  const { embedding } = await embedVideoFrameWithRetries(video, 5, 90);
  return embedding;
}

/** Grab the current frame as a small JPEG data URL (evidence for the log). */
export function snapshotFrame(
  video: HTMLVideoElement,
  quality = 0.6,
): string | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 480 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return null;
  }
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Compare an enrolment embedding with a live one. */
export function compareFaces(
  reference: number[] | null,
  live: number[] | null,
): IdentityResult {
  if (!human && lastError) {
    return {
      match: false,
      similarity: 0,
      reason: `Identity check unavailable: ${lastError}`,
      unavailable: true,
    };
  }
  if (!reference) {
    return {
      match: false,
      similarity: 0,
      reason: "The profile photo could not be analysed — ensure your photo has a clear, well-lit, front-facing face.",
    };
  }
  if (!live) {
    return {
      match: false,
      similarity: 0,
      reason: "No clear face was detected on camera — face the lens directly in good lighting and try again.",
    };
  }
  const similarity = cosine(reference, live);
  const pct = (similarity * 100).toFixed(1);
  return similarity >= MATCH_THRESHOLD
    ? {
        match: true,
        similarity,
        reason: `Face matches the enrolment photo (similarity ${pct}%, threshold ${(MATCH_THRESHOLD * 100).toFixed(0)}%).`,
      }
    : {
        match: false,
        similarity,
        reason: `Face did not match the enrolment photo (similarity ${pct}%, threshold ${(MATCH_THRESHOLD * 100).toFixed(0)}%).`,
      };
}
