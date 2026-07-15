/** Soft dual-tone ambient pad for "Echo is thinking" feedback. */

export type ThinkingAmbientOptions = {
  sampleRate?: number;
  /** Primary tone Hz */
  frequencyA?: number;
  /** Secondary tone Hz (gentle fifth-ish interval) */
  frequencyB?: number;
  /** 0–1 linear gain; keep low so it doesn't overpower speech */
  gain?: number;
  /** Slow amplitude pulse period in ms */
  pulseMs?: number;
};

const DEFAULTS = {
  sampleRate: 48_000,
  frequencyA: 196,
  frequencyB: 294,
  gain: 0.045,
  pulseMs: 2400,
} as const;

/** Generate one frame of soft ambient PCM (Int16). */
export function generateThinkingAmbientFrame(
  frameSamples: number,
  phase: { a: number; b: number; sampleIndex: number },
  options: ThinkingAmbientOptions = {},
): Int16Array {
  const sampleRate = options.sampleRate ?? DEFAULTS.sampleRate;
  const frequencyA = options.frequencyA ?? DEFAULTS.frequencyA;
  const frequencyB = options.frequencyB ?? DEFAULTS.frequencyB;
  const gain = options.gain ?? DEFAULTS.gain;
  const pulseMs = options.pulseMs ?? DEFAULTS.pulseMs;
  const pulsePeriodSamples = Math.max(1, Math.floor((pulseMs / 1000) * sampleRate));

  const samples = new Int16Array(frameSamples);
  for (let i = 0; i < frameSamples; i += 1) {
    const tA = (phase.a + i) / sampleRate;
    const tB = (phase.b + i) / sampleRate;
    const pulsePhase = ((phase.sampleIndex + i) % pulsePeriodSamples) / pulsePeriodSamples;
    // Soft breathing envelope between ~55% and 100% of gain.
    const envelope = 0.55 + 0.45 * (0.5 - 0.5 * Math.cos(2 * Math.PI * pulsePhase));
    const mixed =
      Math.sin(2 * Math.PI * frequencyA * tA) * 0.62 +
      Math.sin(2 * Math.PI * frequencyB * tB) * 0.38;
    const sample = mixed * gain * envelope * 32_767;
    samples[i] = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  }

  phase.a += frameSamples;
  phase.b += frameSamples;
  phase.sampleIndex += frameSamples;
  return samples;
}
