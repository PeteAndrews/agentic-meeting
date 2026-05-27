/**
 * lib-jitsi ChatRoom.join() awaits moderator.sendConferenceRequest() until Jicofo
 * returns ready=true (can hang 2+ minutes in Node). This patch starts the IQ in
 * the background but resolves immediately so MUC join stays fast.
 *
 * ensureBridgeMedia() uses forceConferenceRequest() to reset conferenceRequestSent
 * (otherwise sendConferenceRequest is a no-op and JVB session-initiate never retries).
 */

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function patchModeratorNonBlockingConferenceRequest(xmpp: { moderator?: unknown } | null): void {
  const moderator = xmpp?.moderator as
    | {
        sendConferenceRequest?: (roomJid: string) => Promise<unknown>;
        conferenceRequestSent?: boolean;
        __agentBotModeratorPatched?: boolean;
      }
    | undefined;

  if (!moderator?.sendConferenceRequest || moderator.__agentBotModeratorPatched) {
    return;
  }

  const original = moderator.sendConferenceRequest.bind(moderator);
  (moderator as { __agentBotOriginalSendConferenceRequest?: typeof original }).__agentBotOriginalSendConferenceRequest =
    original;

  moderator.sendConferenceRequest = (roomJid: string): Promise<void> => {
    const pending = original(roomJid);
    void pending.catch((error: unknown) => {
      console.warn(`[agent-bot] conference request failed: ${formatError(error)}`);
    });
    return Promise.resolve();
  };

  moderator.__agentBotModeratorPatched = true;
  console.log("[agent-bot] patched moderator.sendConferenceRequest (non-blocking join)");
}

export function getModeratorSendConferenceRequest(moderator: {
  sendConferenceRequest?: (roomJid: string) => Promise<unknown>;
  __agentBotOriginalSendConferenceRequest?: (roomJid: string) => Promise<unknown>;
}): ((roomJid: string) => Promise<unknown>) | undefined {
  const fn = moderator.__agentBotOriginalSendConferenceRequest ?? moderator.sendConferenceRequest;
  // lib-jitsi reads this.conferenceRequestSent — must preserve moderator as `this`.
  return fn ? fn.bind(moderator) : undefined;
}
