export type SpeakTestResult = {
  ok: boolean;
  note: string;
  durationMs?: number;
  frequencyHz?: number;
  bridgeMedia?: boolean;
};

export type SpeakResult = {
  ok: boolean;
  note: string;
  durationMs?: number;
  bridgeMedia?: boolean;
  text?: string;
};

export type SpeakAudioInput = {
  roomName: string;
  audioBase64: string;
  sampleRate: number;
  durationMs?: number;
  text?: string;
};
