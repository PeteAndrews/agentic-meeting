import type { JitsiClient } from "./jitsiClient.js";
import type { SpeakAudioInput, SpeakResult, SpeakTestResult } from "./speakTypes.js";

export type { SpeakAudioInput, SpeakResult, SpeakTestResult } from "./speakTypes.js";

export class AudioPublisher {
  public constructor(private readonly jitsiClient: JitsiClient) {}

  public async speakTest(roomName: string): Promise<SpeakTestResult> {
    return this.jitsiClient.speakTest(roomName);
  }

  public async speak(input: SpeakAudioInput): Promise<SpeakResult> {
    return this.jitsiClient.speak(input);
  }

  public async startThinking(roomName: string): Promise<SpeakResult> {
    return this.jitsiClient.startThinking(roomName);
  }

  public async stopThinking(roomName?: string): Promise<SpeakResult> {
    return this.jitsiClient.stopThinking(roomName);
  }
}
