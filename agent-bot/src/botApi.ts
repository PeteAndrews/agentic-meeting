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

type SpeakBody = {
  roomName?: string;
  audioBase64?: string;
  sampleRate?: number;
  durationMs?: number;
  text?: string;
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
    try {
      const result = await audioPublisher.speakTest(body.roomName);
      if (!result.ok) {
        return res.status(409).json({ status: "error", ...result });
      }
      return res.json({ status: "ok", ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/speak", async (req, res) => {
    const body = req.body as SpeakBody;
    if (!body?.roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }
    if (!body?.audioBase64) {
      return res.status(400).json({ error: "audioBase64 is required" });
    }
    if (!body?.sampleRate || body.sampleRate <= 0) {
      return res.status(400).json({ error: "sampleRate must be a positive number" });
    }
    try {
      const result = await audioPublisher.speak({
        roomName: body.roomName,
        audioBase64: body.audioBase64,
        sampleRate: body.sampleRate,
        durationMs: body.durationMs,
        text: body.text,
      });
      if (!result.ok) {
        return res.status(409).json({ status: "error", ...result });
      }
      return res.json({ status: "ok", ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/thinking/start", async (req, res) => {
    const body = req.body as SpeakTestBody;
    if (!body?.roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }
    try {
      const result = await audioPublisher.startThinking(body.roomName);
      if (!result.ok) {
        return res.status(409).json({ status: "error", ...result });
      }
      return res.json({ status: "ok", ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  router.post("/thinking/stop", async (req, res) => {
    const body = req.body as LeaveBody;
    try {
      const result = await audioPublisher.stopThinking(body?.roomName);
      return res.json({ status: "ok", ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
