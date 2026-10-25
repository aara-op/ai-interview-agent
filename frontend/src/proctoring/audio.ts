/**
 * Microphone level monitoring with an adaptive noise floor.
 *
 * This reports *measurements* only (RMS energy, whether it looks like speech).
 * Interpreting sustained energy during the interviewer's turn as a possible
 * additional voice is the caller's job.
 */
export interface AudioSample {
  rms: number;        // 0..1 smoothed
  peak: number;       // 0..1 since last read
  speech: boolean;    // above the adaptive threshold
  noiseFloor: number; // 0..1
}

export class AudioMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private buffer: Float32Array = new Float32Array(1024);
  private timer: number | null = null;

  private smooth = 0;
  private peak = 0;
  private floor = 0.012;
  private lastSpeechAt = 0;

  onSample: ((s: AudioSample) => void) | null = null;

  get level() {
    return this.smooth;
  }

  get speechActive() {
    return this.smooth > this.floor * 2.4;
  }

  msSinceSpeech(now = Date.now()) {
    return this.lastSpeechAt ? now - this.lastSpeechAt : 0;
  }

  async start(stream: MediaStream): Promise<boolean> {
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctor();
      this.source = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.4;
      this.source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);
    } catch {
      return false;
    }

    this.timer = window.setInterval(() => this.sample(), 90);
    return true;
  }

  private sample() {
    if (!this.analyser) return;
    // AudioWorklet-free float read keeps the measurement in true RMS terms.
    if (typeof (this.analyser as AudioNode & { getFloatTimeDomainData?: unknown })
        .getFloatTimeDomainData === "function") {
      (this.analyser as AnalyserNode).getFloatTimeDomainData(
        this.buffer as unknown as Parameters<
          AnalyserNode["getFloatTimeDomainData"]
        >[0],
      );
    } else {
      return;
    }
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = this.buffer[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / this.buffer.length);

    // slow adaptive noise floor, only when the candidate is quiet
    if (rms < this.smooth) {
      this.floor = this.floor * 0.97 + rms * 0.03;
      this.floor = Math.max(this.floor, 0.004);
    }

    this.smooth = this.smooth * 0.55 + rms * 0.45;
    this.peak = this.peak * 0.4 + peak * 0.6;

    const speech = this.smooth > Math.max(this.floor * 2.2, 0.02);
    if (speech) this.lastSpeechAt = Date.now();

    this.onSample?.({
      rms: this.smooth,
      peak: this.peak,
      speech,
      noiseFloor: this.floor,
    });
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    try {
      this.source?.disconnect();
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.analyser = null;
    this.ctx = null;
  }
}
