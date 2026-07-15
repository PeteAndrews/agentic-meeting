import { ensureBridgeMedia, hasBridgeMedia, type BridgeMediaResult } from "./bridgeMedia.js";
import { config } from "./config.js";
import { postAgentEvent } from "./backendClient.js";
import { getBridgeDiagnostics, patchConferenceMediaHandlers } from "./jitsiFocusPatch.js";
import { patchModeratorNonBlockingConferenceRequest } from "./jitsiModeratorPatch.js";
import {
  createLocalAudioTrackFromMediaStream,
  disposeLocalTrack,
  muteLocalAudio,
  unmuteLocalAudio,
  type JitsiLocalTrack,
} from "./jitsiTrackUtils.js";
import { ensureConferenceAudioUnmuted, republishLocalAudioToJvb } from "./jitsiMediaSync.js";
import { loadJitsiMeet, type JitsiMeetGlobal } from "./loadJitsiMeet.js";
import type { SpeakAudioInput, SpeakResult, SpeakTestResult } from "./speakTypes.js";
import { pcmDurationMs, PcmAudioSource } from "./pcmAudioSource.js";
import { ToneSource } from "./toneSource.js";

type BotState = {
  connected: boolean;
  roomName: string | null;
  displayName: string;
  mode: "fake" | "lib-jitsi";
  lastError: string | null;
};

type ConnectionOptions = {
  hosts: {
    domain: string;
    muc: string;
    focus?: string;
  };
  focusUserJid?: string;
  serviceUrl: string;
  bosh?: string;
  websocket?: string;
  clientNode: string;
  enableWebsocketResume?: boolean;
};

const TTS_PRE_ROLL_MS = 250;
const TTS_POST_DRAIN_MIN_MS = 300;
const TTS_POST_DRAIN_MAX_MS = 800;

function postPlayDrainMs(durationMs: number): number {
  return Math.max(TTS_POST_DRAIN_MIN_MS, Math.min(TTS_POST_DRAIN_MAX_MS, durationMs * 0.25 + 150));
}

function formatJitsiError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) {
      return record.message;
    }
    if (typeof record.reason === "string" && record.reason) {
      return record.reason;
    }
    const keys = Object.keys(record);
    if (keys.length === 0) {
      return "unknown connection error (empty payload)";
    }
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized === "{}" ? "unknown connection error" : serialized;
  } catch {
    return String(error);
  }
}

export class JitsiClient {
  private state: BotState = {
    connected: false,
    roomName: null,
    displayName: config.defaultDisplayName,
    mode: config.fakeJitsi ? "fake" : "lib-jitsi",
    lastError: null,
  };

  private jitsi: JitsiMeetGlobal | null = null;
  private connection: any | null = null;
  private room: any | null = null;
  private localAudioTracks: JitsiLocalTrack[] = [];
  private toneSource: ToneSource | null = null;
  private pcmSource: PcmAudioSource | null = null;
  private pcmSpeechTrack: JitsiLocalTrack | null = null;
  private audioPublishInProgress = false;
  private thinkingInProgress = false;
  private bridgeSetupPromise: Promise<BridgeMediaResult> | null = null;

  public getStatus() {
    return {
      connected: this.state.connected,
      roomName: this.state.roomName,
      displayName: this.state.displayName,
      phase: "phase_5c",
      mode: this.state.mode,
      lastError: this.state.lastError,
      bridgeMedia: hasBridgeMedia(this.room),
      bridgeDiagnostics: getBridgeDiagnostics(),
      mucOnlyJoin: config.disableFocusAtJoin,
      audioPublishInProgress: this.audioPublishInProgress,
      thinkingInProgress: this.thinkingInProgress,
      jitsiLibUrl: config.jitsiLibUrl,
      jitsiServiceUrl: config.jitsiServiceUrl,
      jitsiBoshUrl: config.jitsiBoshUrl,
    };
  }

  public async join(roomName: string, displayName?: string) {
    const finalDisplayName = displayName ?? config.defaultDisplayName;
    this.state.displayName = finalDisplayName;

    if (this.state.connected && this.state.roomName === roomName) {
      return this.getStatus();
    }

    if (this.state.connected && this.state.roomName !== roomName) {
      await this.leave(this.state.roomName ?? undefined);
    }

    await postAgentEvent({
      roomName,
      eventType: "agent.join_requested",
      payload: { mode: this.state.mode, displayName: finalDisplayName },
    });

    if (config.fakeJitsi) {
      this.state.connected = true;
      this.state.roomName = roomName;
      this.state.lastError = null;
      await postAgentEvent({
        roomName,
        eventType: "agent.joined",
        payload: { mode: "fake" },
      });
      return this.getStatus();
    }

    try {
      await this.joinWithLibJitsi(roomName, finalDisplayName);
      this.state.connected = true;
      this.state.roomName = roomName;
      this.state.lastError = null;
      await postAgentEvent({
        roomName,
        eventType: "agent.joined",
        payload: { mode: "lib-jitsi", displayName: finalDisplayName },
      });
      return this.getStatus();
    } catch (error) {
      const message = formatJitsiError(error);
      this.state.lastError = message;
      this.state.connected = false;
      this.state.roomName = null;
      await this.teardownLibJitsi();
      await postAgentEvent({
        roomName,
        eventType: "agent.connection_failed",
        payload: { mode: "lib-jitsi", error: message },
      });
      throw error;
    }
  }

  public async leave(roomName?: string) {
    const activeRoom = this.state.roomName ?? roomName ?? "unknown-room";

    if (!this.state.connected && !this.room && !this.connection) {
      return this.getStatus();
    }

    if (config.fakeJitsi) {
      this.state.connected = false;
      this.state.roomName = null;
      await postAgentEvent({ roomName: activeRoom, eventType: "agent.left", payload: { mode: "fake" } });
      return this.getStatus();
    }

    try {
      await this.teardownLibJitsi();
    } finally {
      this.state.connected = false;
      this.state.roomName = null;
      await postAgentEvent({
        roomName: activeRoom,
        eventType: "agent.left",
        payload: { mode: "lib-jitsi" },
      });
    }
    return this.getStatus();
  }

  public async startThinking(roomName: string): Promise<SpeakResult> {
    if (config.fakeJitsi) {
      this.thinkingInProgress = true;
      return {
        ok: true,
        note: `fake mode: thinking ambient simulated for ${roomName}`,
        bridgeMedia: false,
      };
    }

    if (!this.state.connected || this.state.roomName !== roomName || !this.room || !this.jitsi) {
      return {
        ok: false,
        note: `Echo is not connected to room "${roomName}" (call POST /bot/join first)`,
        bridgeMedia: hasBridgeMedia(this.room),
      };
    }

    if (this.audioPublishInProgress) {
      return {
        ok: false,
        note: "audio publish already in progress",
        bridgeMedia: hasBridgeMedia(this.room),
      };
    }

    if (this.thinkingInProgress && this.pcmSource?.isAmbientActive()) {
      return {
        ok: true,
        note: "thinking ambient already playing",
        bridgeMedia: hasBridgeMedia(this.room),
      };
    }

    try {
      const bridge = await this.waitForBridgeMedia();
      if (!bridge.ready) {
        return {
          ok: false,
          note: bridge.note,
          bridgeMedia: false,
        };
      }

      await republishLocalAudioToJvb(this.room);
      await ensureConferenceAudioUnmuted(this.room);

      const speechTrack = await this.ensurePcmSpeechTrack();
      await republishLocalAudioToJvb(this.room);
      await unmuteLocalAudio(this.room, speechTrack);
      await ensureConferenceAudioUnmuted(this.room);

      this.pcmSource!.startThinkingAmbient();
      this.thinkingInProgress = true;

      await postAgentEvent({
        roomName,
        eventType: "agent.thinking_started",
        payload: {},
      });

      console.log("[agent-bot] thinking ambient started");
      return {
        ok: true,
        note: `Thinking ambient playing in ${roomName}`,
        bridgeMedia: true,
      };
    } catch (error) {
      this.thinkingInProgress = false;
      this.pcmSource?.stopThinkingAmbient();
      const message = formatJitsiError(error);
      await postAgentEvent({
        roomName,
        eventType: "agent.thinking_failed",
        payload: { error: message },
      });
      return {
        ok: false,
        note: message,
        bridgeMedia: hasBridgeMedia(this.room),
      };
    }
  }

  public async stopThinking(roomName?: string): Promise<SpeakResult> {
    const activeRoom = this.state.roomName ?? roomName ?? "unknown-room";
    const wasActive = this.thinkingInProgress || Boolean(this.pcmSource?.isAmbientActive());

    this.pcmSource?.stopThinkingAmbient();
    this.thinkingInProgress = false;

    if (this.pcmSpeechTrack && this.room) {
      try {
        await muteLocalAudio(this.room, this.pcmSpeechTrack);
      } catch {
        // ignore
      }
    }

    if (wasActive) {
      await postAgentEvent({
        roomName: activeRoom,
        eventType: "agent.thinking_stopped",
        payload: {},
      });
      console.log("[agent-bot] thinking ambient stopped");
    }

    return {
      ok: true,
      note: wasActive ? `Thinking ambient stopped in ${activeRoom}` : "thinking ambient was not playing",
      bridgeMedia: hasBridgeMedia(this.room),
    };
  }

  public async speakTest(roomName: string): Promise<SpeakTestResult> {
    if (config.fakeJitsi) {
      return {
        ok: true,
        note: `fake mode: speak-test simulated for ${roomName}`,
        durationMs: config.speakTestDurationMs,
        frequencyHz: config.speakTestFrequencyHz,
        bridgeMedia: false,
      };
    }

    if (!this.state.connected || this.state.roomName !== roomName || !this.room || !this.jitsi) {
      return {
        ok: false,
        note: `Echo is not connected to room "${roomName}" (call POST /bot/join first)`,
        bridgeMedia: hasBridgeMedia(this.room),
      };
    }

    if (this.audioPublishInProgress) {
      return {
        ok: false,
        note: "audio publish already in progress",
        bridgeMedia: hasBridgeMedia(this.room),
      };
    }

    this.audioPublishInProgress = true;
    try {
      await postAgentEvent({
        roomName,
        eventType: "agent.speak_test_started",
        payload: {
          durationMs: config.speakTestDurationMs,
          frequencyHz: config.speakTestFrequencyHz,
        },
      });

      const bridge = await this.waitForBridgeMedia();
      if (!bridge.ready) {
        return {
          ok: false,
          note: bridge.note,
          bridgeMedia: false,
        };
      }

      await republishLocalAudioToJvb(this.room);
      await ensureConferenceAudioUnmuted(this.room);

      const tone = new ToneSource({
        frequencyHz: config.speakTestFrequencyHz,
        gain: 0.75,
      });
      this.toneSource = tone;
      let toneTrack: JitsiLocalTrack | null = null;
      const previousTracks = [...this.localAudioTracks];

      try {
        for (const old of previousTracks) {
          try {
            await this.room.removeTrack(old);
          } catch {
            // ignore
          }
          disposeLocalTrack(old);
        }
        this.localAudioTracks = [];

        const mediaTrack = tone.createTrack();
        tone.start();
        toneTrack = await createLocalAudioTrackFromMediaStream(this.jitsi, mediaTrack);

        console.log("[agent-bot] adding tone track to conference");
        await this.room.addTrack(toneTrack);
        this.localAudioTracks = [toneTrack];

        await republishLocalAudioToJvb(this.room);
        await unmuteLocalAudio(this.room, toneTrack);
        await ensureConferenceAudioUnmuted(this.room);

        console.log(
          `[agent-bot] speak-test playing ${config.speakTestFrequencyHz}Hz for ${config.speakTestDurationMs}ms`,
        );

        await new Promise((resolve) => setTimeout(resolve, config.speakTestDurationMs));

        await muteLocalAudio(this.room, toneTrack);

        const note = `Played ${config.speakTestFrequencyHz} Hz tone for ${config.speakTestDurationMs} ms in ${roomName}`;
        await postAgentEvent({
          roomName,
          eventType: "agent.speak_test_completed",
          payload: { frequencyHz: config.speakTestFrequencyHz, durationMs: config.speakTestDurationMs },
        });

        return {
          ok: true,
          note,
          durationMs: config.speakTestDurationMs,
          frequencyHz: config.speakTestFrequencyHz,
          bridgeMedia: true,
        };
      } catch (error) {
        const message = formatJitsiError(error);
        await postAgentEvent({
          roomName,
          eventType: "agent.speak_test_failed",
          payload: { error: message },
        });
        return {
          ok: false,
          note: message,
          bridgeMedia: hasBridgeMedia(this.room),
        };
      } finally {
        tone.stop();
        this.toneSource = null;

        if (toneTrack) {
          try {
            await this.room?.removeTrack?.(toneTrack);
          } catch {
            // ignore
          }
          disposeLocalTrack(toneTrack);
        }

        await this.restoreSilentMic();
      }
    } finally {
      this.audioPublishInProgress = false;
    }
  }

  public async speak(input: SpeakAudioInput): Promise<SpeakResult> {
    const { roomName, audioBase64, sampleRate, text } = input;

    // Always clear thinking pad before TTS so speech is not mixed/blocked.
    await this.stopThinking(roomName);

    if (config.fakeJitsi) {
      return {
        ok: true,
        note: `fake mode: speak simulated for ${roomName}`,
        durationMs: input.durationMs,
        bridgeMedia: false,
        text,
      };
    }

    if (!this.state.connected || this.state.roomName !== roomName || !this.room || !this.jitsi) {
      return {
        ok: false,
        note: `Echo is not connected to room "${roomName}" (call POST /bot/join first)`,
        bridgeMedia: hasBridgeMedia(this.room),
        text,
      };
    }

    if (this.audioPublishInProgress) {
      return {
        ok: false,
        note: "audio publish already in progress",
        bridgeMedia: hasBridgeMedia(this.room),
        text,
      };
    }

    let pcm: Int16Array;
    try {
      const raw = Buffer.from(audioBase64, "base64");
      if (raw.byteLength % 2 !== 0) {
        return {
          ok: false,
          note: "PCM payload must have an even byte length",
          bridgeMedia: hasBridgeMedia(this.room),
          text,
        };
      }
      const bytes = new Uint8Array(raw);
      pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    } catch (error) {
      return {
        ok: false,
        note: `Invalid audioBase64: ${formatJitsiError(error)}`,
        bridgeMedia: hasBridgeMedia(this.room),
        text,
      };
    }

    if (pcm.length === 0) {
      return {
        ok: false,
        note: "Empty PCM audio payload",
        bridgeMedia: hasBridgeMedia(this.room),
        text,
      };
    }

    const durationMs = input.durationMs ?? pcmDurationMs(pcm, sampleRate);

    this.audioPublishInProgress = true;
    try {
      await postAgentEvent({
        roomName,
        eventType: "agent.speak_playback_started",
        payload: { durationMs, sampleRate, text },
      });

      const bridge = await this.waitForBridgeMedia();
      if (!bridge.ready) {
        return {
          ok: false,
          note: bridge.note,
          bridgeMedia: false,
          text,
        };
      }

      await republishLocalAudioToJvb(this.room);
      await ensureConferenceAudioUnmuted(this.room);

      let speechTrack: JitsiLocalTrack;
      try {
        speechTrack = await this.ensurePcmSpeechTrack();
      } catch (error) {
        const message = formatJitsiError(error);
        await postAgentEvent({
          roomName,
          eventType: "agent.speak_playback_failed",
          payload: { error: message, text },
        });
        return {
          ok: false,
          note: message,
          bridgeMedia: hasBridgeMedia(this.room),
          text,
        };
      }

      try {
        await republishLocalAudioToJvb(this.room);
        await unmuteLocalAudio(this.room, speechTrack);
        await ensureConferenceAudioUnmuted(this.room);

        // Give remote participants time to subscribe before short clips start.
        await new Promise((resolve) => setTimeout(resolve, TTS_PRE_ROLL_MS));

        console.log(`[agent-bot] speak playing TTS for ~${durationMs}ms`);
        await this.pcmSource!.play(pcm, sampleRate);
        await new Promise((resolve) => setTimeout(resolve, postPlayDrainMs(durationMs)));

        await muteLocalAudio(this.room, speechTrack);

        const note = `Played TTS audio (${durationMs} ms) in ${roomName}`;
        await postAgentEvent({
          roomName,
          eventType: "agent.speak_playback_finished",
          payload: { durationMs, text },
        });

        return {
          ok: true,
          note,
          durationMs,
          bridgeMedia: true,
          text,
        };
      } catch (error) {
        const message = formatJitsiError(error);
        await postAgentEvent({
          roomName,
          eventType: "agent.speak_playback_failed",
          payload: { error: message, text },
        });
        return {
          ok: false,
          note: message,
          bridgeMedia: hasBridgeMedia(this.room),
          text,
        };
      } finally {
        this.pcmSource?.stopFeed();
      }
    } finally {
      this.audioPublishInProgress = false;
    }
  }

  private async ensurePcmSpeechTrack(): Promise<JitsiLocalTrack> {
    if (!this.room || !this.jitsi) {
      throw new Error("Echo is not connected to a Jitsi room");
    }

    if (this.pcmSpeechTrack && this.pcmSource?.mediaTrackReady()) {
      return this.pcmSpeechTrack;
    }

    this.pcmSource ??= new PcmAudioSource();
    const mediaTrack = this.pcmSource.ensureTrack();
    const speechTrack = await createLocalAudioTrackFromMediaStream(this.jitsi, mediaTrack);

    for (const old of [...this.localAudioTracks]) {
      try {
        await this.room.removeTrack(old);
      } catch {
        // ignore
      }
      disposeLocalTrack(old);
    }
    this.localAudioTracks = [];

    console.log("[agent-bot] adding persistent TTS track to conference");
    await this.room.addTrack(speechTrack);
    this.localAudioTracks = [speechTrack];
    this.pcmSpeechTrack = speechTrack;

    await republishLocalAudioToJvb(this.room);
    await muteLocalAudio(this.room, speechTrack);
    return speechTrack;
  }

  private async restoreSilentMic(): Promise<void> {
    try {
      const JitsiMeetJS = this.jitsi;
      if (JitsiMeetJS && this.room) {
        const [silent] = await JitsiMeetJS.createLocalTracks({ devices: ["audio"] });
        if (silent) {
          await this.room.addTrack(silent);
          await republishLocalAudioToJvb(this.room);
          await muteLocalAudio(this.room, silent);
          this.localAudioTracks = [silent];
        }
      }
    } catch (restoreError) {
      console.warn(
        `[agent-bot] failed restoring silent mic after audio publish: ${formatJitsiError(restoreError)}`,
      );
      this.localAudioTracks = [];
    }
  }

  private startBackgroundBridgeSetup(): void {
    if (!this.room || !this.jitsi || config.fakeJitsi) {
      return;
    }
    if (hasBridgeMedia(this.room)) {
      return;
    }
    console.log("[agent-bot] starting background bridge setup after MUC join");
    this.bridgeSetupPromise = ensureBridgeMedia(this.room, this.jitsi);
    void this.bridgeSetupPromise.then((result) => {
      console.log(`[agent-bot] background bridge: ${result.note}`);
    });
  }

  private async waitForBridgeMedia(): Promise<BridgeMediaResult> {
    if (hasBridgeMedia(this.room)) {
      return { ready: true, note: "JVB session already active" };
    }
    if (this.bridgeSetupPromise) {
      const pending = await this.bridgeSetupPromise;
      if (pending.ready) {
        return pending;
      }
      this.bridgeSetupPromise = null;
    }
    this.bridgeSetupPromise = ensureBridgeMedia(this.room, this.jitsi ?? undefined);
    return this.bridgeSetupPromise;
  }

  /** lib-jitsi on the server may default to AV1; node-webrtc needs VP8 for JVB video section. */
  private forceVp8CodecPreference(room: any): void {
    try {
      const codecController = room?.qualityController?.codecController;
      if (!codecController?.codecPreferenceOrder) {
        return;
      }
      codecController.codecPreferenceOrder.jvb = ["vp8"];
      codecController.codecPreferenceOrder.p2p = ["vp8"];
      console.log("[agent-bot] forced JVB codec preference order to vp8");
    } catch {
      // ignore
    }
  }

  private async teardownLibJitsi(): Promise<void> {
    this.thinkingInProgress = false;
    this.toneSource?.stop();
    this.toneSource = null;
    this.pcmSource?.stop();
    this.pcmSource = null;
    this.pcmSpeechTrack = null;
    for (const track of this.localAudioTracks) {
      disposeLocalTrack(track);
    }
    this.localAudioTracks = [];
    if (this.room?.leave) {
      try {
        this.room.leave();
      } catch {
        // ignore leave errors during cleanup
      }
    }
    if (this.connection?.disconnect) {
      try {
        this.connection.disconnect();
      } catch {
        // ignore disconnect errors during cleanup
      }
    }
    this.room = null;
    this.connection = null;
    this.jitsi = null;
    this.bridgeSetupPromise = null;
  }

  private buildConnectionOptions(domain: string, serviceUrl: string): ConnectionOptions {
    const websocket = config.jitsiServiceUrl.startsWith("ws")
      ? config.jitsiServiceUrl
      : `wss://${domain}/xmpp-websocket`;
    return {
      hosts: {
        domain,
        muc: `conference.${domain}`,
        focus: `focus.${domain}`,
      },
      focusUserJid: config.focusUserJid,
      serviceUrl,
      bosh: config.jitsiBoshUrl,
      websocket,
      clientNode: "http://jitsi.org/jitsimeet",
      enableWebsocketResume: true,
    };
  }

  private connectionServiceUrls(): string[] {
    // WebSocket first — BOSH XHR often fails from Node (status 0).
    const urls = [config.jitsiServiceUrl, config.jitsiBoshUrl];
    return [...new Set(urls.filter((url) => typeof url === "string" && url.length > 0))];
  }

  private async establishXmppConnection(
    JitsiMeetJS: JitsiMeetGlobal,
    connectionOptions: ConnectionOptions,
    roomName: string,
  ): Promise<any> {
    const connection = new JitsiMeetJS.JitsiConnection(null, null, connectionOptions);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          connection.disconnect();
        } catch {
          // ignore
        }
        reject(
          new Error(`Timed out connecting to Jitsi XMPP (${connectionOptions.serviceUrl})`),
        );
      }, config.connectionTimeoutMs);

      const onEstablished = () => {
        clearTimeout(timeout);
        connection.removeEventListener(
          JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
          onEstablished,
        );
        connection.removeEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, onFailed);
        resolve();
      };

      const onFailed = (err: unknown) => {
        clearTimeout(timeout);
        connection.removeEventListener(
          JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
          onEstablished,
        );
        connection.removeEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, onFailed);
        try {
          connection.disconnect();
        } catch {
          // ignore
        }
        reject(new Error(`Jitsi connection failed (${connectionOptions.serviceUrl}): ${formatJitsiError(err)}`));
      };

      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, onEstablished);
      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, onFailed);
      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED, () => {
        this.state.connected = false;
        void this.teardownLibJitsi();
      });

      connection.connect({ name: roomName });
    });

    return connection;
  }

  private async connectWithFallback(
    JitsiMeetJS: JitsiMeetGlobal,
    domain: string,
    roomName: string,
  ): Promise<any> {
    const serviceUrls = this.connectionServiceUrls();
    const errors: string[] = [];

    for (const serviceUrl of serviceUrls) {
      console.log(`[agent-bot] trying XMPP via ${serviceUrl}`);
      try {
        const connection = await this.establishXmppConnection(
          JitsiMeetJS,
          this.buildConnectionOptions(domain, serviceUrl),
          roomName,
        );
        console.log(`[agent-bot] XMPP connected via ${serviceUrl}`);
        return connection;
      } catch (error) {
        const message = formatJitsiError(error);
        errors.push(message);
        console.warn(`[agent-bot] XMPP failed for ${serviceUrl}: ${message}`);
      }
    }

    throw new Error(`All XMPP transports failed:\n${errors.join("\n")}`);
  }

  private async joinWithLibJitsi(roomName: string, displayName: string): Promise<void> {
    const JitsiMeetJS = await loadJitsiMeet();
    this.jitsi = JitsiMeetJS;

    if (JitsiMeetJS.setLogLevel && JitsiMeetJS.logLevels) {
      JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.INFO);
    }

    const vp8Only = {
      codecPreferenceOrder: ["VP8"],
      preferredCodec: "VP8",
      disabledCodec: "AV1",
    };

    JitsiMeetJS.init({
      disableAudioLevels: true,
      disableThirdPartyRequests: true,
      videoQuality: vp8Only,
      p2p: { enabled: false, ...vp8Only },
    });

    const domain = config.jitsiDomain;
    this.connection = await this.connectWithFallback(JitsiMeetJS, domain, roomName);

    if (config.nonBlockingConferenceRequest && !config.disableFocusAtJoin) {
      patchModeratorNonBlockingConferenceRequest(this.connection.xmpp);
    }

    const disableFocus = config.disableFocusAtJoin;
    const room = this.connection.initJitsiConference(roomName, {
      disableFocus,
      openBridgeChannel: true,
      startAudioMuted: false,
      startWithAudioMuted: false,
      startVideoMuted: true,
      startWithVideoMuted: true,
      ignoreStartMuted: true,
      startAudioOnly: true,
      videoQuality: vp8Only,
      p2p: { enabled: false, ...vp8Only },
    });
    console.log(
      disableFocus
        ? "[agent-bot] joining via MUC (fast); bridge media requested on speak-test"
        : "[agent-bot] joining with Jicofo conference request at join (may be slow or hang in Node)",
    );
    this.room = room;
    patchConferenceMediaHandlers(room);
    this.forceVp8CodecPreference(room);
    room.setDisplayName(displayName);

    this.localAudioTracks = [];
    try {
      const localTracks = await JitsiMeetJS.createLocalTracks({
        devices: ["audio"],
      });
      for (const track of localTracks) {
        await room.addTrack(track);
        this.localAudioTracks.push(track);
      }
      console.log(`[agent-bot] added ${localTracks.length} local audio track(s)`);
      for (const track of this.localAudioTracks) {
        await unmuteLocalAudio(room, track);
      }
      await ensureConferenceAudioUnmuted(room);
    } catch (error) {
      console.warn(`[agent-bot] createLocalTracks failed: ${formatJitsiError(error)}`);
    }

    room.on(JitsiMeetJS.events.conference.MUC_JOINED, () => {
      console.log(`[agent-bot] MUC joined: ${roomName}`);
    });

    room.on(JitsiMeetJS.events.conference.TRACK_ADDED, (track: unknown) => {
      console.log("[agent-bot] conference TRACK_ADDED", track);
    });

    room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, (...args: unknown[]) => {
      console.error("[agent-bot] CONFERENCE_FAILED:", ...args);
    });

    const conferenceEvents = JitsiMeetJS.events.conference as Record<string, string>;
    for (const [key, eventName] of Object.entries(conferenceEvents)) {
      if (/FOCUS|FAIL|ERROR|MEDIA_SESSION|JINGLE|SESSION/i.test(key)) {
        room.on(eventName, (...args: unknown[]) => {
          console.warn(`[agent-bot] conference event ${key}:`, ...args);
        });
      }
    }

    // ChatRoom MUC_JOINED is forwarded to conference CONFERENCE_JOINED in lib-jitsi.
    const joinSuccessEvent = JitsiMeetJS.events.conference.CONFERENCE_JOINED;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out joining conference room "${roomName}"`));
      }, config.conferenceJoinTimeoutMs);

      const onJoined = () => {
        clearTimeout(timeout);
        room.off(joinSuccessEvent, onJoined);
        room.off(JitsiMeetJS.events.conference.CONFERENCE_FAILED, onConferenceFailed);
        console.log(
          `[agent-bot] join complete (${disableFocus ? "MUC presence" : "with focus at join"}; bridge=${
            hasBridgeMedia(room) ? "yes" : "no"
          })`,
        );
        resolve();
      };

      const onConferenceFailed = (err: unknown) => {
        clearTimeout(timeout);
        room.off(joinSuccessEvent, onJoined);
        room.off(JitsiMeetJS.events.conference.CONFERENCE_FAILED, onConferenceFailed);
        reject(new Error(`Conference failed: ${formatJitsiError(err)}`));
      };

      room.on(joinSuccessEvent, onJoined);
      room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, onConferenceFailed);
      room.join();
    });

    this.startBackgroundBridgeSetup();
  }
}
