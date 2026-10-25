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

/** Cosine similarity needed to call a frame a match. Tunable per deployment. */
export const MATCH_THRESHOLD = 0.5;

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
      const h = new mod.default({
        modelBasePath: "/human/models",
        warmup: "none",
        debug: false,
        // only what identity matching needs — keeps load and inference cheap
        face: {
          iris: { enabled: false },
          emotion: { enabled: false },
          attention: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
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

async function embed(input: CanvasImageSource | ImageData): Promise<number[] | null> {
  try {
    const h = await getHuman();
    const result = await h.detect(input as never);
    const face = result.face?.[0];
    if (!face || !face.embedding || face.embedding.length === 0) return null;
    return Array.from(face.embedding);
  } catch {
    return null;
  }
}

/** Embed an image referenced by URL (the candidate's profile picture). */
export async function embedImageUrl(url: string): Promise<number[] | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = url;
  if (!(await loaded)) return null;
  return embed(img);
}

/** Embed the current frame of a live video element. */
export async function embedVideoFrame(
  video: HTMLVideoElement,
): Promise<number[] | null> {
  if (!video.videoWidth || video.readyState < 2) return null;
  return embed(video);
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
      reason: "The profile photo could not be analysed — retake it with the face clearly visible.",
    };
  }
  if (!live) {
    return {
      match: false,
      similarity: 0,
      reason: "No clear face was detected on camera — face the lens and try again.",
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
