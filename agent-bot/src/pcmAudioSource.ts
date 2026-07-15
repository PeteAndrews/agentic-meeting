import wrtc from "@roamhq/wrtc";

import { generateThinkingAmbientFrame } from "./thinkingAmbient.js";
import { patchTrackForLibJitsi } from "./webrtcAdapter.js";

const { RTCAudioSource } = wrtc.nonstandard;

const TARGET_SAMPLE_RATE = 48_000;
const FRAME_MS = 10;
const TICK_MS = 5;

/** Linear-interpolation upsample from 24 kHz PCM to 48 kHz for WebRTC. */
export function upsamplePcmTo48k(pcm: Int16Array): Int16Array {
  if (pcm.length === 0) {
    return pcm;
  }
  if (pcm.length === 1) {
    const sample = pcm[0] ?? 0;
    return new Int16Array([sample, sample]);
  }

  const out = new Int16Array(pcm.length * 2);
  let outIndex = 0;
  for (let i = 0; i < pcm.length - 1; i += 1) {
    const current = pcm[i] ?? 0;
    const next = pcm[i + 1] ?? current;
    out[outIndex] = current;
    out[outIndex + 1] = Math.round((current + next) / 2);
    outIndex += 2;
  }
  const last = pcm[pcm.length - 1] ?? 0;
  out[outIndex] = last;
  out[outIndex + 1] = last;
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
  private track: MediaStreamTrack | null = null;
  private sampleRate = TARGET_SAMPLE_RATE;
  private frameSamples = Math.floor(TARGET_SAMPLE_RATE / (1000 / FRAME_MS));
  private pcm = new Int16Array(0);
  private offset = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private playResolve: (() => void) | null = null;
  private playStartMs = 0;
  private tailFramesRemaining = 0;
  private ambientTimer: ReturnType<typeof setInterval> | null = null;
  private ambientPhase = { a: 0, b: 0, sampleIndex: 0 };

  public ensureTrack(): MediaStreamTrack {
    if (this.track && this.track.readyState !== "ended") {
      return this.track;
    }
    const track = this.source.createTrack();
    patchTrackForLibJitsi(track);
    this.track = track;
    return track;
  }

  public isAmbientActive(): boolean {
    return this.ambientTimer != null;
  }

  /** Soft looping pad while Echo is processing; interrupted by play()/stopFeed(). */
  public startThinkingAmbient(): void {
    if (this.ambientTimer) {
      return;
    }
    this.stopFeed();
    this.sampleRate = TARGET_SAMPLE_RATE;
    this.frameSamples = Math.max(1, Math.floor(this.sampleRate / (1000 / FRAME_MS)));
    this.ambientPhase = { a: 0, b: 0, sampleIndex: 0 };
    this.ambientTimer = setInterval(() => {
      const samples = generateThinkingAmbientFrame(this.frameSamples, this.ambientPhase);
      this.source.onData({ samples, sampleRate: this.sampleRate });
    }, FRAME_MS);
  }

  public stopThinkingAmbient(): void {
    if (this.ambientTimer) {
      clearInterval(this.ambientTimer);
      this.ambientTimer = null;
    }
    this.ambientPhase = { a: 0, b: 0, sampleIndex: 0 };
  }

  /** Feed PCM until exhausted; resolves after tail silence is paced out. */
  public play(pcm: Int16Array, inputSampleRate: number): Promise<void> {
    this.stopThinkingAmbient();
    this.stopFeed();
    this.tailFramesRemaining = 0;

    const normalized = inputSampleRate === 24_000 ? upsamplePcmTo48k(pcm) : pcm;
    this.sampleRate = inputSampleRate === 24_000 ? TARGET_SAMPLE_RATE : inputSampleRate;
    this.frameSamples = Math.max(1, Math.floor(this.sampleRate / (1000 / FRAME_MS)));
    this.pcm = new Int16Array(normalized);
    this.offset = 0;
    this.playStartMs = performance.now();

    return new Promise((resolve) => {
      this.playResolve = resolve;
      if (this.pcm.length > 0) {
        this.emitFrame();
      }
      this.scheduleTick();
    });
  }

  public emitTailSilence(frameCount = 8): void {
    this.tailFramesRemaining = frameCount;
  }

  private emitOneTailFrame(): void {
    const silent = new Int16Array(this.frameSamples);
    this.source.onData({ samples: silent, sampleRate: this.sampleRate });
  }

  public mediaTrackReady(): boolean {
    return Boolean(this.track && this.track.readyState !== "ended");
  }

  public stopFeed(): void {
    this.stopThinkingAmbient();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.offset = 0;
    this.playStartMs = 0;
    this.tailFramesRemaining = 0;
    const resolve = this.playResolve;
    this.playResolve = null;
    resolve?.();
  }

  public stop(): void {
    this.stopFeed();
    if (this.track && this.track.readyState !== "ended") {
      this.track.stop();
    }
    this.track = null;
    this.pcm = new Int16Array(0);
  }

  private targetOffset(): number {
    const elapsedSec = (performance.now() - this.playStartMs) / 1000;
    return Math.min(this.pcm.length, Math.floor(elapsedSec * this.sampleRate));
  }

  private emitFrame(): void {
    const samples = new Int16Array(this.frameSamples);
    const end = Math.min(this.offset + this.frameSamples, this.pcm.length);
    const written = end - this.offset;
    samples.set(this.pcm.subarray(this.offset, end));
    const lastSample = written > 0 ? samples[written - 1]! : 0;
    for (let i = written; i < this.frameSamples; i += 1) {
      samples[i] = lastSample;
    }
    this.offset = end;
    this.source.onData({ samples, sampleRate: this.sampleRate });
  }

  private drainToTarget(): void {
    const target = this.targetOffset();
    while (this.offset < target) {
      this.emitFrame();
    }
  }

  private scheduleTick(): void {
    this.drainToTarget();

    if (this.offset >= this.pcm.length) {
      if (this.tailFramesRemaining === 0) {
        this.emitTailSilence();
      }
      if (this.tailFramesRemaining > 0) {
        this.emitOneTailFrame();
        this.tailFramesRemaining -= 1;
        if (this.tailFramesRemaining > 0) {
          this.timer = setTimeout(() => this.scheduleTick(), FRAME_MS);
          return;
        }
      }
      this.finishPlay();
      return;
    }

    this.timer = setTimeout(() => this.scheduleTick(), TICK_MS);
  }

  private finishPlay(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.offset = 0;
    this.playStartMs = 0;
    const resolve = this.playResolve;
    this.playResolve = null;
    resolve?.();
  }
}
