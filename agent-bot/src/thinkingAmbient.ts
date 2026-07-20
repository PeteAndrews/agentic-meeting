import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WAITING_AUDIO_NAMES = ["waiting-ambient.mp3", "waiting-sound.mp3", "waiting-ambient.wav", "waiting-sound.wav"] as const;

function agentBotRoot(): string {
  const parent = resolve(MODULE_DIR, "..");
  if (parent.endsWith(`${sep}dist`) || parent.endsWith("/dist") || parent.endsWith("\\dist")) {
    return resolve(parent, "..");
  }
  return parent;
}

function defaultWaitingAudioPath(): string {
  const assetsDir = resolve(agentBotRoot(), "assets");
  for (const name of DEFAULT_WAITING_AUDIO_NAMES) {
    const candidate = resolve(assetsDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return resolve(assetsDir, DEFAULT_WAITING_AUDIO_NAMES[0]);
}

export type ThinkingAmbientOptions = {
  sampleRate?: number;
  frequencyA?: number;
  frequencyB?: number;
  gain?: number;
  pulseMs?: number;
};

const SYNTH_DEFAULTS = {
  sampleRate: 48_000,
  frequencyA: 196,
  frequencyB: 294,
  gain: 0.045,
  pulseMs: 2400,
} as const;

let cachedFilePcm: Int16Array | null | undefined;

function ffmpegExecutable(): string {
  return config.ffmpegPath;
}

function resolveWaitingAudioPath(): string {
  const configured = config.waitingAudioPath.trim();
  if (configured) {
    return resolve(configured);
  }
  return defaultWaitingAudioPath();
}

/** Decode MP3/WAV/etc. to 48 kHz mono PCM for WebRTC playback. */
export function loadThinkingAmbientPcm(): Int16Array | null {
  if (cachedFilePcm !== undefined) {
    return cachedFilePcm;
  }

  const audioPath = resolveWaitingAudioPath();
  if (!existsSync(audioPath)) {
    console.warn(
      `[agent-bot] Waiting audio not found at ${audioPath}; using synthesized ambient. ` +
        `Place your MP3 in agent-bot/assets/ (e.g. waiting-sound.mp3) or set AGENT_BOT_WAITING_AUDIO.`,
    );
    cachedFilePcm = null;
    return null;
  }

  const ffmpeg = ffmpegExecutable();
  const result = spawnSync(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      audioPath,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "48000",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.error) {
    console.warn(`[agent-bot] ffmpeg unavailable for waiting audio (${ffmpeg}): ${result.error.message}`);
    cachedFilePcm = null;
    return null;
  }

  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf-8").trim() || `exit ${result.status}`;
    console.warn(`[agent-bot] ffmpeg failed to decode waiting audio: ${detail}`);
    cachedFilePcm = null;
    return null;
  }

  const raw = result.stdout;
  if (!raw || raw.byteLength < 2) {
    console.warn("[agent-bot] Waiting audio decode produced empty PCM");
    cachedFilePcm = null;
    return null;
  }

  if (raw.byteLength % 2 !== 0) {
    console.warn("[agent-bot] Waiting audio PCM has odd byte length; truncating last byte");
  }

  const evenBytes = raw.byteLength - (raw.byteLength % 2);
  cachedFilePcm = new Int16Array(raw.buffer, raw.byteOffset, evenBytes / 2);
  console.log(
    `[agent-bot] Loaded waiting audio (${cachedFilePcm.length} samples @ 48 kHz) from ${audioPath}`,
  );
  return cachedFilePcm;
}

/** Apply linear gain once at load so playback avoids per-frame scaling. */
export function scaleThinkingAmbientPcm(pcm: Int16Array, gain: number): Int16Array {
  const clampedGain = Math.max(0, Math.min(2, gain));
  if (clampedGain === 1) {
    return pcm;
  }
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const scaled = Math.round((pcm[i] ?? 0) * clampedGain);
    out[i] = Math.max(-32_768, Math.min(32_767, scaled));
  }
  return out;
}

/** Read a frame from a looping PCM buffer at an absolute sample offset. */
export function readThinkingAmbientFrameAt(
  frameSamples: number,
  startSampleIndex: number,
  pcm: Int16Array,
): Int16Array {
  if (pcm.length === 0) {
    return new Int16Array(frameSamples);
  }

  const samples = new Int16Array(frameSamples);
  const len = pcm.length;
  let pos = ((startSampleIndex % len) + len) % len;

  for (let i = 0; i < frameSamples; i += 1) {
    samples[i] = pcm[pos] ?? 0;
    pos = (pos + 1) % len;
  }

  return samples;
}

/** Fallback synthesized pad when no waiting audio file is configured. */
export function generateThinkingAmbientFrame(
  frameSamples: number,
  phase: { a: number; b: number; sampleIndex: number },
  options: ThinkingAmbientOptions = {},
): Int16Array {
  const sampleRate = options.sampleRate ?? SYNTH_DEFAULTS.sampleRate;
  const frequencyA = options.frequencyA ?? SYNTH_DEFAULTS.frequencyA;
  const frequencyB = options.frequencyB ?? SYNTH_DEFAULTS.frequencyB;
  const gain = options.gain ?? SYNTH_DEFAULTS.gain;
  const pulseMs = options.pulseMs ?? SYNTH_DEFAULTS.pulseMs;
  const pulsePeriodSamples = Math.max(1, Math.floor((pulseMs / 1000) * sampleRate));

  const samples = new Int16Array(frameSamples);
  for (let i = 0; i < frameSamples; i += 1) {
    const tA = (phase.a + i) / sampleRate;
    const tB = (phase.b + i) / sampleRate;
    const pulsePhase = ((phase.sampleIndex + i) % pulsePeriodSamples) / pulsePeriodSamples;
    const envelope = 0.55 + 0.45 * (0.5 - 0.5 * Math.cos(2 * Math.PI * pulsePhase));
    const mixed =
      Math.sin(2 * Math.PI * frequencyA * tA) * 0.62 +
      Math.sin(2 * Math.PI * frequencyB * tB) * 0.38;
    const sample = mixed * gain * 32_767;
    samples[i] = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  }

  phase.a += frameSamples;
  phase.b += frameSamples;
  phase.sampleIndex += frameSamples;
  return samples;
}
