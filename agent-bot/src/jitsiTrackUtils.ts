import wrtc from "@roamhq/wrtc";

import type { JitsiMeetGlobal } from "./loadJitsiMeet.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JitsiLocalTrack = any;

export async function createLocalAudioTrackFromMediaStream(
  JitsiMeetJS: JitsiMeetGlobal,
  mediaStreamTrack: MediaStreamTrack,
): Promise<JitsiLocalTrack> {
  const stream = new wrtc.MediaStream([mediaStreamTrack]);

  if (typeof JitsiMeetJS.createLocalTracksFromMediaStreams === "function") {
    const tracks = await JitsiMeetJS.createLocalTracksFromMediaStreams([
      {
        stream,
        mediaType: "audio",
        sourceType: "audio",
      },
    ]);
    if (tracks?.length) {
      return tracks[0];
    }
  }

  const mediaType = JitsiMeetJS.constants?.mediaType?.AUDIO ?? "audio";
  if (typeof JitsiMeetJS.JitsiLocalTrack === "function") {
    return new JitsiMeetJS.JitsiLocalTrack({
      deviceId: "tone-source",
      track: mediaStreamTrack,
      mediaType,
      sourceType: "audio",
      stream,
    });
  }

  throw new Error(
    "JitsiMeetJS cannot wrap a custom audio track (missing createLocalTracksFromMediaStreams / JitsiLocalTrack)",
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function unmuteLocalAudio(room: any, localTrack: JitsiLocalTrack): Promise<void> {
  if (typeof localTrack.unmute === "function") {
    await localTrack.unmute();
  }
  if (typeof room?.setLocalParticipantProperty === "function") {
    room.setLocalParticipantProperty("audioMuted", false);
  }
  if (typeof room?.mute === "function") {
    try {
      await room.mute(false);
    } catch {
      // some lib-jitsi versions use different signatures
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function muteLocalAudio(room: any, localTrack: JitsiLocalTrack): Promise<void> {
  if (typeof localTrack.mute === "function") {
    await localTrack.mute();
  }
  if (typeof room?.setLocalParticipantProperty === "function") {
    room.setLocalParticipantProperty("audioMuted", true);
  }
}

export function disposeLocalTrack(track: JitsiLocalTrack | null | undefined): void {
  if (!track) {
    return;
  }
  try {
    track.dispose?.();
  } catch {
    // ignore
  }
}
