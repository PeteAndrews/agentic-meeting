export type SpeakTestResult = {
  ok: boolean;
  note: string;
  durationMs?: number;
  frequencyHz?: number;
  bridgeMedia?: boolean;
};
