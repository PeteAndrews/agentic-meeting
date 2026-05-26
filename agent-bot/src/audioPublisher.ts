export type SpeakTestResult = {
  ok: boolean;
  note: string;
};

export class AudioPublisher {
  public async speakTest(roomName: string): Promise<SpeakTestResult> {
    return {
      ok: true,
      note: `speak-test placeholder queued for room ${roomName}`,
    };
  }
}
