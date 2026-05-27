import { config } from "./config.js";
import { patchJingleSessionForNodeBridge } from "./jitsiJingleSdpPatch.js";

export type BridgeDiagnostics = {
  conferenceRequestKickoff: boolean;
  conferenceRequestSettled: boolean;
  jvbSessionActive: boolean;
  focusJids: string[];
  lastIncomingCall: { remoteJid: string; isP2P: boolean; accepted: boolean; at: string } | null;
  lastNote: string;
};

let diagnostics: BridgeDiagnostics = {
  conferenceRequestKickoff: false,
  conferenceRequestSettled: false,
  jvbSessionActive: false,
  focusJids: [],
  lastIncomingCall: null,
  lastNote: "",
};

export function getBridgeDiagnostics(): BridgeDiagnostics {
  return { ...diagnostics };
}

export function updateBridgeDiagnostics(partial: Partial<BridgeDiagnostics>): void {
  diagnostics = { ...diagnostics, ...partial };
}

function looksLikeFocusJid(jid: string, moderator: { focusUserJids?: Set<string>; isFocusJid?: (j: string) => boolean }): boolean {
  if (!jid) {
    return false;
  }
  if (moderator.isFocusJid?.(jid)) {
    return true;
  }
  if (moderator.focusUserJids) {
    for (const focusJid of moderator.focusUserJids) {
      if (jid === focusJid || jid.startsWith(`${focusJid}/`)) {
        return true;
      }
    }
  }
  if (config.focusUserJid && (jid === config.focusUserJid || jid.startsWith(`${config.focusUserJid}/`))) {
    return true;
  }
  return jid.includes("focus@") || jid.includes("jitsi-focus");
}

/**
 * lib-jitsi rejects JVB session-initiate when isFocus(remoteJid) is false.
 * Patch isFocus + log/force-accept incoming JVB offers for the headless bot.
 */
export function patchConferenceMediaHandlers(conference: any): void {
  if (!conference || conference.__agentBotMediaPatched) {
    return;
  }

  const chatRoom = conference.room;
  const moderator = chatRoom?.xmpp?.moderator;

  if (moderator?.focusUserJids && config.focusUserJid) {
    moderator.focusUserJids.add(config.focusUserJid);
  }

  const originalIsFocus =
    typeof conference.isFocus === "function" ? conference.isFocus.bind(conference) : () => null;

  conference.isFocus = (jid: string): boolean => {
    if (originalIsFocus(jid)) {
      return true;
    }
    if (moderator && looksLikeFocusJid(jid, moderator)) {
      return true;
    }
    return false;
  };

  const originalOnIncomingCall =
    typeof conference.onIncomingCall === "function" ? conference.onIncomingCall.bind(conference) : null;

  const originalAcceptJvb =
    typeof conference._acceptJvbIncomingCall === "function"
      ? conference._acceptJvbIncomingCall.bind(conference)
      : null;

  if (originalAcceptJvb) {
    conference._acceptJvbIncomingCall = async (
      jingleSession: any,
      jingleOffer: unknown,
      now: number,
    ) => {
      const remoteJid = String(jingleSession?.remoteJid ?? "");
      updateBridgeDiagnostics({
        lastIncomingCall: {
          remoteJid,
          isP2P: false,
          accepted: true,
          at: new Date().toISOString(),
        },
        focusJids: moderator?.focusUserJids ? [...moderator.focusUserJids] : [],
      });
      console.log(`[agent-bot] accepting JVB session-initiate from ${remoteJid}`);
      patchJingleSessionForNodeBridge(jingleSession, jingleOffer);
      return originalAcceptJvb(jingleSession, jingleOffer, now);
    };
  }

  if (originalOnIncomingCall) {
    conference.onIncomingCall = (jingleSession: any, jingleOffer: unknown, now: number) => {
      const remoteJid = String(jingleSession?.remoteJid ?? "");
      const isP2P = Boolean(jingleSession?.isP2P);
      console.log(`[agent-bot] incoming Jingle ${isP2P ? "P2P" : "JVB"} from ${remoteJid}`);

      if (!isP2P) {
        const isFocus = conference.isFocus(remoteJid);
        const accepted = isFocus || config.forceJvbAccept;
        updateBridgeDiagnostics({
          lastIncomingCall: {
            remoteJid,
            isP2P,
            accepted,
            at: new Date().toISOString(),
          },
          focusJids: moderator?.focusUserJids ? [...moderator.focusUserJids] : [],
        });

        if (!isFocus && config.forceJvbAccept && typeof conference._acceptJvbIncomingCall === "function") {
          console.warn("[agent-bot] forcing JVB session-initiate accept (focus bypass for headless bot)");
          conference._acceptJvbIncomingCall(jingleSession, jingleOffer, now);
          return;
        }
      }

      originalOnIncomingCall(jingleSession, jingleOffer, now);
    };
  }

  conference.__agentBotMediaPatched = true;
  console.log("[agent-bot] patched conference media handlers (isFocus + incoming JVB)");
}

/** @deprecated use patchConferenceMediaHandlers */
export function patchConferenceFocusCheck(conference: any): void {
  patchConferenceMediaHandlers(conference);
}
