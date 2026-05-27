// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JitsiConference = any;

function isAudioTrack(track: any): boolean {
  if (typeof track.isAudioTrack === "function") {
    return track.isAudioTrack();
  }
  return track?.type === "audio" || track?.videoType === undefined;
}

/** Push local audio tracks onto the active JVB peer connection (needed after late bridge setup). */
export async function republishLocalAudioToJvb(conference: JitsiConference): Promise<number> {
  const jvb = conference?.jvbJingleSession;
  if (!jvb) {
    console.warn("[agent-bot] republish skipped: no jvbJingleSession");
    return 0;
  }

  if (typeof jvb.setMediaTransferActive === "function") {
    try {
      await jvb.setMediaTransferActive(true);
    } catch {
      // ignore
    }
  }

  const localTracks =
    typeof conference.getLocalTracks === "function" ? conference.getLocalTracks() : [];

  let published = 0;
  for (const track of localTracks) {
    if (!isAudioTrack(track)) {
      continue;
    }
    try {
      if (typeof jvb.addTrackToPc === "function") {
        await jvb.addTrackToPc(track);
        published += 1;
        console.log("[agent-bot] republished local audio track to JVB");
      } else if (typeof jvb.replaceTrack === "function" && track) {
        await jvb.replaceTrack(null, track);
        published += 1;
      }
    } catch (error) {
      console.warn(`[agent-bot] JVB addTrackToPc failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  return published;
}

export async function ensureConferenceAudioUnmuted(conference: JitsiConference): Promise<void> {
  if (typeof conference.setAudioMuted === "function") {
    try {
      conference.setAudioMuted(false);
    } catch {
      // ignore
    }
  }
  if (typeof conference.setLocalParticipantProperty === "function") {
    conference.setLocalParticipantProperty("audioMuted", false);
  }
}
