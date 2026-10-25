/**
 * Unnecessary-device detection (COCO object detector, in the browser).
 *
 * Only ONE primary laptop and ONE paired phone are allowed. Each feed is scanned
 * for objects that would be a second device:
 *
 *   primary feed (laptop webcam)  - more than one phone, another laptop, a TV or
 *                                   external monitor
 *   secondary feed (paired phone) - any phone (this camera IS the phone, so a
 *                                   phone in its view is a different one), a
 *                                   second laptop, a TV or external monitor
 *
 * The detector is a mid-size CenterNet model vendored under /human/models, so it
 * runs offline. It reports observations only; the caller decides what a
 * confirmed sighting means and the recruiter reviews the evidence frame.
 */
import type Human from "@vladmandic/human";
import type { Config } from "@vladmandic/human";

type HumanCtor = new (config?: Partial<Config>) => Human;

export type DeviceLabel = "cell phone" | "laptop" | "tv";

export interface DeviceSighting {
  label: DeviceLabel;
  score: number;
  /** [x, y, w, h] in video pixels */
  box: [number, number, number, number];
}

export interface DeviceVerdict {
  /** human-readable reasons, empty when nothing extra is visible */
  extras: string[];
  /** every device-like object seen, for the HUD */
  seen: DeviceSighting[];
}

const WANTED = new Set<string>(["cell phone", "laptop", "tv"]);
const MIN_SCORE = 0.5;

function iou(a: number[], b: number[]) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

export class DeviceDetector {
  private human: Human | null = null;
  private loading: Promise<boolean> | null = null;
  error: string | null = null;

  get ready() {
    return this.human !== null;
  }

  init(): Promise<boolean> {
    if (this.human) return Promise.resolve(true);
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const mod = (await import("@vladmandic/human")) as unknown as {
          default: HumanCtor;
        };
        const h = new mod.default({
          modelBasePath: "/human/models",
          warmup: "none",
          debug: false,
          face: { enabled: false },
          body: { enabled: false },
          hand: { enabled: false },
          gesture: { enabled: false },
          segmentation: { enabled: false },
          filter: { enabled: false },
          object: {
            enabled: true,
            modelPath: "centernet.json",
            minConfidence: MIN_SCORE,
            maxDetected: 12,
            skipFrames: 0,
          },
        });
        await h.init();      // select + initialise the TF backend first
        await h.load();
        this.human = h;
        this.error = null;
        return true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.loading = null;
        return false;
      }
    })();
    return this.loading;
  }

  /** Scan one frame; null when the detector is not ready or the frame is empty. */
  async scan(video: HTMLVideoElement, feed: "primary" | "secondary"):
      Promise<DeviceVerdict | null> {
    if (!this.human || video.readyState < 2 || !video.videoWidth) return null;
    let objects: { label: string; score: number; box: number[] }[] = [];
    try {
      const res = await this.human.detect(video as never);
      objects = (res.object ?? []) as typeof objects;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return null;
    }

    const seen: DeviceSighting[] = objects
      .filter((o) => WANTED.has(o.label) && o.score >= MIN_SCORE)
      .map((o) => ({
        label: o.label as DeviceLabel,
        score: o.score,
        box: [o.box[0], o.box[1], o.box[2], o.box[3]] as [number, number, number, number],
      }));

    // A laptop screen is often also labelled "tv": drop any tv that overlaps a
    // laptop so one machine is never counted twice.
    const laptops = seen.filter((s) => s.label === "laptop");
    const tvs = seen.filter(
      (s) => s.label === "tv" && !laptops.some((l) => iou(l.box, s.box) > 0.3),
    );
    const phones = seen.filter((s) => s.label === "cell phone");

    const extras: string[] = [];
    if (feed === "primary") {
      if (phones.length > 1) extras.push(`${phones.length} phones in the laptop camera view`);
      if (laptops.length > 0) extras.push("another laptop in the laptop camera view");
      if (tvs.length > 0) extras.push("an external screen in the laptop camera view");
    } else {
      if (phones.length > 0) extras.push("a second phone in the paired-phone view");
      if (laptops.length > 1) extras.push(`${laptops.length} laptops in the paired-phone view`);
      if (tvs.length > 0) extras.push("an external screen in the paired-phone view");
    }
    return { extras, seen };
  }

  close() {
    this.human = null;
    this.loading = null;
  }
}
