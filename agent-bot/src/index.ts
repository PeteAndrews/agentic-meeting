import cors from "cors";
import express from "express";

import { AudioPublisher } from "./audioPublisher.js";
import { createBotApi } from "./botApi.js";
import { config } from "./config.js";
import { JitsiClient } from "./jitsiClient.js";
import { preloadThinkingAmbient } from "./thinkingAmbient.js";
import { installWebRtcAdapter } from "./webrtcAdapter.js";

process.on("uncaughtException", (error) => {
  console.error("[agent-bot] uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[agent-bot] unhandled rejection:", reason);
});

if (!config.fakeJitsi) {
  try {
    installWebRtcAdapter();
  } catch (error) {
    console.error("[agent-bot] WebRTC adapter failed to load:", error);
    console.error("[agent-bot] Run: npm install @roamhq/wrtc (or AGENT_BOT_FAKE_JITSI=true)");
    process.exit(1);
  }
}

preloadThinkingAmbient();

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

const jitsiClient = new JitsiClient();
const audioPublisher = new AudioPublisher(jitsiClient);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "agent-bot", mode: jitsiClient.getStatus().mode });
});

app.use("/bot", createBotApi(jitsiClient, audioPublisher));

app.listen(config.port, () => {
  console.log(
    `[agent-bot] listening on :${config.port} domain=${config.jitsiDomain} mode=${
      config.fakeJitsi ? "fake" : "lib-jitsi"
    }`,
  );
});
