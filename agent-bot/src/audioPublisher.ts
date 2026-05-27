import type { JitsiClient } from "./jitsiClient.js";
import type { SpeakTestResult } from "./speakTypes.js";

export type { SpeakTestResult } from "./speakTypes.js";

export class AudioPublisher {
  public constructor(private readonly jitsiClient: JitsiClient) {}

  public async speakTest(roomName: string): Promise<SpeakTestResult> {
    return this.jitsiClient.speakTest(roomName);
  }
}
