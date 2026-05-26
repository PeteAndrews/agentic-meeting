import { config } from "./config.js";
import { postAgentEvent } from "./backendClient.js";
import { loadJitsiMeet, type JitsiMeetGlobal } from "./loadJitsiMeet.js";

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
  serviceUrl: string;
  bosh?: string;
  websocket?: string;
  clientNode: string;
  enableWebsocketResume?: boolean;
};

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

  public getStatus() {
    return {
      connected: this.state.connected,
      roomName: this.state.roomName,
      displayName: this.state.displayName,
      phase: "phase_5a",
      mode: this.state.mode,
      lastError: this.state.lastError,
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

  private async teardownLibJitsi(): Promise<void> {
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

    JitsiMeetJS.init({
      disableAudioLevels: true,
      disableThirdPartyRequests: true,
    });

    const domain = config.jitsiDomain;
    this.connection = await this.connectWithFallback(JitsiMeetJS, domain, roomName);

    // Skip Jicofo conference IQ (often hangs for headless lib-jitsi); join MUC directly.
    const disableFocus = process.env.AGENT_BOT_DISABLE_FOCUS !== "false";
    const room = this.connection.initJitsiConference(roomName, {
      disableFocus,
      openBridgeChannel: false,
      startAudioMuted: true,
      startWithAudioMuted: true,
      startVideoMuted: true,
      startWithVideoMuted: true,
      p2p: { enabled: false },
    });
    if (disableFocus) {
      console.log("[agent-bot] conference focus disabled — joining MUC without Jicofo allocate");
    }
    this.room = room;
    room.setDisplayName(displayName);

    try {
      const localTracks = await JitsiMeetJS.createLocalTracks({
        devices: ["audio"],
      });
      for (const track of localTracks) {
        await room.addTrack(track);
      }
      console.log(`[agent-bot] added ${localTracks.length} local audio track(s)`);
    } catch (error) {
      console.warn(`[agent-bot] createLocalTracks failed: ${formatJitsiError(error)}`);
    }

    room.on(JitsiMeetJS.events.conference.MUC_JOINED, () => {
      console.log(`[agent-bot] MUC joined: ${roomName}`);
    });

    const conferenceEvents = JitsiMeetJS.events.conference as Record<string, string>;
    for (const [key, eventName] of Object.entries(conferenceEvents)) {
      if (/FOCUS|FAIL|ERROR/i.test(key)) {
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
          `[agent-bot] join complete (${disableFocus ? "MUC only" : "conference media"})`,
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
  }
}
