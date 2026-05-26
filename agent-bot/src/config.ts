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
  defaultDisplayName: process.env.AGENT_DISPLAY_NAME ?? "Agent C",
  fakeJitsi: (process.env.AGENT_BOT_FAKE_JITSI ?? "false").toLowerCase() === "true",
  connectionTimeoutMs: Number(process.env.AGENT_BOT_CONNECT_TIMEOUT_MS ?? 35000),
  conferenceJoinTimeoutMs: Number(process.env.AGENT_BOT_CONFERENCE_TIMEOUT_MS ?? 35000),
};
