import { config } from "./config.js";
import {
  getBridgeDiagnostics,
  patchConferenceMediaHandlers,
  updateBridgeDiagnostics,
} from "./jitsiFocusPatch.js";
import { republishLocalAudioToJvb } from "./jitsiMediaSync.js";
import { getModeratorSendConferenceRequest } from "./jitsiModeratorPatch.js";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getChatRoom(conference: any): any | null {
  return conference?.room ?? null;
}

function getModerator(conference: any): any | null {
  const chatRoom = getChatRoom(conference);
  return chatRoom?.xmpp?.moderator ?? null;
}

export type BridgeMediaResult = {
  ready: boolean;
  note: string;
  diagnostics?: ReturnType<typeof getBridgeDiagnostics>;
};

const MEDIA_SESSION_EVENTS = ["_MEDIA_SESSION_STARTED", "_MEDIA_SESSION_ACTIVE_CHANGED"] as const;

function syncDiagnostics(conference: any, moderator: any | null): void {
  updateBridgeDiagnostics({
    jvbSessionActive: hasBridgeMedia(conference),
    focusJids: moderator?.focusUserJids ? [...moderator.focusUserJids] : [],
  });
}

/** Wait until JitsiConference has an active JVB jingle session (or timeout). */
export async function waitForJvbSession(
  conference: any,
  timeoutMs: number,
  jitsi?: { events?: { conference?: Record<string, string> } },
): Promise<boolean> {
  if (hasBridgeMedia(conference)) {
    return true;
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let lastLogAt = 0;

    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      for (const [eventName, handler] of listeners) {
        conference.off?.(eventName, handler);
      }
      resolve(ok);
    };

    const poll = setInterval(() => {
      if (hasBridgeMedia(conference)) {
        finish(true);
        return;
      }
      const elapsed = Date.now() - started;
      if (elapsed - lastLogAt >= 10_000) {
        lastLogAt = elapsed;
        const diag = getBridgeDiagnostics();
        console.log(
          `[agent-bot] still waiting for JVB (${Math.round(elapsed / 1000)}s) ` +
            `focusJids=${diag.focusJids.join("|") || "none"} ` +
            `lastIncoming=${diag.lastIncomingCall?.remoteJid ?? "none"}`,
        );
      }
      if (elapsed >= timeoutMs) {
        finish(false);
      }
    }, 250);

    const listeners: Array<[string, () => void]> = [];
    const conferenceEvents = jitsi?.events?.conference;
    if (conferenceEvents && typeof conference.on === "function") {
      const onSession = () => {
        if (hasBridgeMedia(conference)) {
          console.log("[agent-bot] JVB session detected via media session event");
          finish(true);
        }
      };
      for (const key of MEDIA_SESSION_EVENTS) {
        const eventName = conferenceEvents[key];
        if (eventName) {
          conference.on(eventName, onSession);
          listeners.push([eventName, onSession]);
        }
      }
    }
  });
}

/** Kick off (or re-kick) Jicofo allocation; always resets conferenceRequestSent first. */
function kickoffConferenceRequest(moderator: any, roomJid: string, reason: string): void {
  updateBridgeDiagnostics({ conferenceRequestKickoff: true, conferenceRequestSettled: false });
  console.log(`[agent-bot] conference request to focus (${reason}) for ${roomJid}`);

  const sendRequest = getModeratorSendConferenceRequest(moderator);
  if (!sendRequest) {
    return;
  }

  moderator.conferenceRequestSent = false;
  void sendRequest(roomJid)
    .then(() => {
      updateBridgeDiagnostics({ conferenceRequestSettled: true });
      console.log("[agent-bot] conference request promise settled (Jicofo ready)");
    })
    .catch((error: unknown) => {
      console.warn(`[agent-bot] conference request promise rejected: ${formatError(error)}`);
    });
}

/**
 * After MUC join, ask Jicofo for bridge allocation and wait for the JVB WebRTC session.
 * Does NOT await sendConferenceRequest to completion — Jicofo may retry with ready=false for minutes.
 */
export async function ensureBridgeMedia(
  conference: any,
  jitsi?: { events?: { conference?: Record<string, string> } },
): Promise<BridgeMediaResult> {
  if (!conference) {
    return { ready: false, note: "No active conference", diagnostics: getBridgeDiagnostics() };
  }

  patchConferenceMediaHandlers(conference);

  if (hasBridgeMedia(conference)) {
    syncDiagnostics(conference, getModerator(conference));
    return { ready: true, note: "JVB session already active", diagnostics: getBridgeDiagnostics() };
  }

  if (conference.jvbJingleSession) {
    const pc = conference.jvbJingleSession.peerconnection;
    const state =
      pc &&
      ((typeof pc.getConnectionState === "function" ? pc.getConnectionState() : pc.connectionState) ??
        (typeof pc.getIceConnectionState === "function"
          ? pc.getIceConnectionState()
          : pc.iceConnectionState));
    const failed = !state || state === "failed" || state === "closed";
    if (failed || !hasBridgeMedia(conference)) {
      console.warn("[agent-bot] clearing failed JVB session before bridge retry");
      try {
        conference.jvbJingleSession.terminate?.();
      } catch {
        // ignore
      }
      conference.jvbJingleSession = null;
    }
  }

  const chatRoom = getChatRoom(conference);
  const moderator = getModerator(conference);
  const roomJid = chatRoom?.roomjid as string | undefined;

  if (!moderator?.sendConferenceRequest || !roomJid) {
    return {
      ready: false,
      note: "Cannot access XMPP moderator to request bridge media",
      diagnostics: getBridgeDiagnostics(),
    };
  }

  const timeoutMs = config.bridgeSetupTimeoutMs;
  console.log(`[agent-bot] bridge setup started (JVB wait up to ${timeoutMs}ms)`);

  // lib-jitsi skips sendConferenceRequest when conferenceRequestSent is true (Promise.resolve no-op).
  kickoffConferenceRequest(moderator, roomJid, "bridge media");

  try {
    chatRoom?.sendPresence?.();
  } catch {
    // nudge Jicofo after MUC join / retry
  }

  const ready = await waitForJvbSession(conference, timeoutMs, jitsi);
  syncDiagnostics(conference, moderator);

  if (ready) {
    const note = "JVB bridge media ready";
    updateBridgeDiagnostics({ lastNote: note, jvbSessionActive: true });
    console.log(`[agent-bot] ${note}`);
    await republishLocalAudioToJvb(conference);
    return { ready: true, note, diagnostics: getBridgeDiagnostics() };
  }

  const diag = getBridgeDiagnostics();
  const note =
    `No JVB WebRTC session within ${timeoutMs}ms. ` +
    `Focus JIDs: ${diag.focusJids.length ? diag.focusJids.join(", ") : "none"}. ` +
    (diag.lastIncomingCall
      ? `Last Jingle from ${diag.lastIncomingCall.remoteJid} (accepted=${diag.lastIncomingCall.accepted}). `
      : "No session-initiate received. ") +
    "Keep A+B in the room before join/speak-test.";

  updateBridgeDiagnostics({ lastNote: note, jvbSessionActive: false });
  console.warn(`[agent-bot] bridge setup failed: ${note}`);

  return { ready: false, note, diagnostics: diag };
}

export function hasBridgeMedia(conference: any | null): boolean {
  const jvb = conference?.jvbJingleSession;
  const pc = jvb?.peerconnection;
  if (!jvb || !pc) {
    return false;
  }
  const state =
    (typeof pc.getConnectionState === "function" ? pc.getConnectionState() : pc.connectionState) ??
    (typeof pc.getIceConnectionState === "function"
      ? pc.getIceConnectionState()
      : pc.iceConnectionState);
  return state === "connected" || state === "completed";
}
