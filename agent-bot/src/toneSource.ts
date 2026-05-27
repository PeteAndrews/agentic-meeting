import wrtc from "@roamhq/wrtc";

import { patchTrackForLibJitsi } from "./webrtcAdapter.js";

const { RTCAudioSource } = wrtc.nonstandard;

export type ToneSourceOptions = {
  frequencyHz?: number;
  sampleRate?: number;
  /** 0–1 linear gain applied to Int16 samples */
  gain?: number;
};

/** Feeds a sine wave into a WebRTC audio track via node-webrtc RTCAudioSource. */
export class ToneSource {
  private readonly source = new RTCAudioSource();
  private readonly sampleRate: number;
  private readonly frequencyHz: number;
  private readonly gain: number;
  private readonly frameSamples: number;

  private track: MediaStreamTrack | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private phase = 0;

  public constructor(options: ToneSourceOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48_000;
    this.frequencyHz = options.frequencyHz ?? 440;
    this.gain = options.gain ?? 0.35;
    this.frameSamples = Math.floor(this.sampleRate / 100);
  }

  public createTrack(): MediaStreamTrack {
    if (this.track && this.track.readyState !== "ended") {
      return this.track;
    }
    const track = this.source.createTrack();
    patchTrackForLibJitsi(track);
    this.track = track;
    return track;
  }

  public start(): void {
    if (this.interval) {
      return;
    }
    const samples = new Int16Array(this.frameSamples);
    this.interval = setInterval(() => {
      for (let i = 0; i < samples.length; i++) {
        const t = (this.phase + i) / this.sampleRate;
        const sample = Math.sin(2 * Math.PI * this.frequencyHz * t) * this.gain * 32_767;
        samples[i] = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
      }
      this.phase += samples.length;
      this.source.onData({ samples, sampleRate: this.sampleRate });
    }, 10);
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.track && this.track.readyState !== "ended") {
      this.track.stop();
    }
    this.track = null;
    this.phase = 0;
  }
}
