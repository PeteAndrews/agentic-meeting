import "./loadEnv.js";

const jitsiDomain = process.env.JITSI_DOMAIN ?? "meet.uib-study.com";

export const config = {
  port: Number(process.env.AGENT_BOT_PORT ?? 3001),
  jitsiDomain,
  /** Load lib-jitsi-meet from the deployment (matches frontend Jitsi version). */
  jitsiLibUrl:
    process.env.JITSI_LIB_URL ?? `https://${jitsiDomain}/libs/lib-jitsi-meet.min.js`,
  /** Primary XMPP transport URL (WebSocket by default). */
  jitsiServiceUrl:
    process.env.JITSI_SERVICE_URL ?? `wss://${jitsiDomain}/xmpp-websocket`,
  /** BOSH fallback when WebSocket cannot connect. */
  jitsiBoshUrl: process.env.JITSI_BOSH_URL ?? `https://${jitsiDomain}/http-bind`,
  backendUrl: process.env.AGENT_BOT_BACKEND_URL ?? "http://127.0.0.1:8000",
  defaultDisplayName: process.env.AGENT_DISPLAY_NAME ?? "Echo",
  fakeJitsi: (process.env.AGENT_BOT_FAKE_JITSI ?? "false").toLowerCase() === "true",
  connectionTimeoutMs: Number(process.env.AGENT_BOT_CONNECT_TIMEOUT_MS ?? 35000),
  conferenceJoinTimeoutMs: Number(process.env.AGENT_BOT_CONFERENCE_TIMEOUT_MS ?? 35000),
  /**
   * Skip Jicofo at MUC join (legacy). Default false: invite focus with a non-blocking
   * conference-request (see jitsiModeratorPatch).
   */
  disableFocusAtJoin: process.env.AGENT_BOT_DISABLE_FOCUS === "true",
  /** Non-blocking sendConferenceRequest during join (recommended). */
  nonBlockingConferenceRequest:
    process.env.AGENT_BOT_NONBLOCKING_CONFERENCE_REQUEST !== "false",
  /** Max wait for JVB session after a deferred conference request (speak-test). */
  bridgeSetupTimeoutMs: Number(process.env.AGENT_BOT_BRIDGE_TIMEOUT_MS ?? 90000),
  /** Known Jicofo focus auth JID (helps accept JVB session-initiate). */
  focusUserJid: process.env.JITSI_FOCUS_USER_JID ?? `focus@auth.${jitsiDomain}`,
  /** Accept JVB session-initiate even when lib-jitsi isFocus check fails (headless bot). */
  forceJvbAccept: process.env.AGENT_BOT_FORCE_JVB_ACCEPT !== "false",
  speakTestDurationMs: Number(process.env.AGENT_BOT_SPEAK_TEST_MS ?? 5000),
  speakTestFrequencyHz: Number(process.env.AGENT_BOT_SPEAK_TEST_HZ ?? 440),
  /** MP3/WAV loop played while Echo is thinking or waiting for a proxy reply. */
  waitingAudioPath: process.env.AGENT_BOT_WAITING_AUDIO ?? "",
  /** Linear gain applied to the waiting audio loop (default 0.35). */
  waitingAudioGain: Number(process.env.AGENT_BOT_WAITING_AUDIO_GAIN ?? 0.35),
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  /** Extra conference media/session event logging (noisy). */
  verboseConferenceLogs: (process.env.AGENT_BOT_VERBOSE_CONFERENCE ?? "false").toLowerCase() === "true",
};
