import wrtc from "@roamhq/wrtc";

import { patchTrackForLibJitsi } from "./webrtcAdapter.js";

const { RTCAudioSource } = wrtc.nonstandard;

const TARGET_SAMPLE_RATE = 48_000;

/** Duplicate samples to upsample 24 kHz PCM to 48 kHz for WebRTC. */
export function upsamplePcmTo48k(pcm: Int16Array): Int16Array {
  if (pcm.length === 0) {
    return pcm;
  }
  const out = new Int16Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] ?? 0;
    out[i * 2] = sample;
    out[i * 2 + 1] = sample;
  }
  return out;
}

export function pcmDurationMs(pcm: Int16Array, sampleRate: number): number {
  if (sampleRate <= 0 || pcm.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil((pcm.length / sampleRate) * 1000));
}

/** Feeds pre-encoded PCM into a WebRTC audio track via RTCAudioSource. */
export class PcmAudioSource {
  private readonly source = new RTCAudioSource();
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly pcm: Int16Array;

  private track: MediaStreamTrack | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private offset = 0;

  public constructor(pcm: Int16Array, sampleRate: number) {
    const normalized =
      sampleRate === 24_000 ? upsamplePcmTo48k(pcm) : pcm;
    this.sampleRate = sampleRate === 24_000 ? TARGET_SAMPLE_RATE : sampleRate;
    this.pcm = normalized;
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
    this.interval = setInterval(() => {
      if (this.offset >= this.pcm.length) {
        this.stopInterval();
        return;
      }
      const samples = new Int16Array(this.frameSamples);
      const end = Math.min(this.offset + this.frameSamples, this.pcm.length);
      samples.set(this.pcm.subarray(this.offset, end));
      this.offset = end;
      this.source.onData({ samples, sampleRate: this.sampleRate });
    }, 10);
  }

  public stop(): void {
    this.stopInterval();
    if (this.track && this.track.readyState !== "ended") {
      this.track.stop();
    }
    this.track = null;
    this.offset = 0;
  }

  private stopInterval(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
