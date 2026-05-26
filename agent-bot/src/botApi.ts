import { Router } from "express";

import { AudioPublisher } from "./audioPublisher.js";
import { JitsiClient } from "./jitsiClient.js";

type JoinBody = {
  roomName?: string;
  displayName?: string;
};

type LeaveBody = {
  roomName?: string;
};

type SpeakTestBody = {
  roomName?: string;
};

export function createBotApi(jitsiClient: JitsiClient, audioPublisher: AudioPublisher): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json(jitsiClient.getStatus());
  });

  router.post("/join", async (req, res) => {
    const body = req.body as JoinBody;
    if (!body?.roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }

    try {
      const status = await jitsiClient.join(body.roomName, body.displayName);
      return res.json({ status: "ok", ...status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/leave", async (req, res) => {
    const body = req.body as LeaveBody;
    try {
      const status = await jitsiClient.leave(body?.roomName);
      return res.json({ status: "ok", ...status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/speak-test", async (req, res) => {
    const body = req.body as SpeakTestBody;
    if (!body?.roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }
    const result = await audioPublisher.speakTest(body.roomName);
    return res.json({ status: "ok", ...result });
  });

  return router;
}
