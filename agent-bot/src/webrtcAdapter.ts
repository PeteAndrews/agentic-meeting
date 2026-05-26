import wrtc from "@roamhq/wrtc";

import {
  createMediaDevicesStub,
  getDomWindow,
  getShimNavigator,
} from "./browserShim.js";

let installed = false;

/** node-webrtc lacks setCodecPreferences; lib-jitsi probes for it on RTCPeerConnection. */
function patchRtcPeerConnection(): typeof wrtc.RTCPeerConnection {
  const Base = wrtc.RTCPeerConnection;
  if ("setCodecPreferences" in Base.prototype) {
    return Base;
  }
  return class PatchedRTCPeerConnection extends Base {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setCodecPreferences(_codecs: unknown) {
      // no-op for headless bot
    }
  } as typeof wrtc.RTCPeerConnection;
}

function patchTargetWebRtc(target: Record<string, unknown>): void {
  const PatchedRtc = patchRtcPeerConnection();
  target.RTCPeerConnection = PatchedRtc;
  target.RTCSessionDescription = wrtc.RTCSessionDescription;
  target.RTCIceCandidate = wrtc.RTCIceCandidate;
  target.MediaStream = wrtc.MediaStream;
  target.MediaStreamTrack = wrtc.MediaStreamTrack;
}

function patchNavigatorMediaDevices(navigator: Navigator, mediaDevices: MediaDevices): void {
  try {
    Object.defineProperty(navigator, "mediaDevices", {
      value: mediaDevices,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  } catch {
    (navigator as Navigator & { mediaDevices: MediaDevices }).mediaDevices = mediaDevices;
  }
}

function patchTrackForLibJitsi(track: MediaStreamTrack): void {
  const extended = track as MediaStreamTrack & {
    getConstraints?: () => MediaTrackConstraints;
    getSettings?: () => MediaTrackSettings;
  };
  if (!extended.getConstraints) {
    extended.getConstraints = () => ({ audio: true, video: false });
  }
  if (!extended.getSettings) {
    extended.getSettings = () => ({ deviceId: "default" });
  }
}

/** node-webrtc has getUserMedia but not enumerateDevices — combine with a minimal stub. */
export function createWrtcMediaDevices(): MediaDevices {
  const stub = createMediaDevicesStub();
  const wrtcDevices = (wrtc as typeof wrtc & { mediaDevices: MediaDevices }).mediaDevices;

  return {
    ...stub,
    getUserMedia: async (constraints) => {
      const stream = await wrtcDevices.getUserMedia(constraints);
      for (const track of stream.getTracks()) {
        patchTrackForLibJitsi(track);
      }
      return stream;
    },
    getDisplayMedia: (constraints) => wrtcDevices.getDisplayMedia(constraints),
    enumerateDevices: async () => [
      {
        deviceId: "default",
        kind: "audioinput",
        label: "Default Audio",
        groupId: "default",
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ],
  } as MediaDevices;
}

/** Install Node WebRTC globals required by lib-jitsi-meet. */
export function installWebRtcAdapter(): void {
  if (installed) {
    return;
  }

  const targets: Record<string, unknown>[] = [globalThis as Record<string, unknown>];
  const domWindow = getDomWindow();
  if (domWindow) {
    targets.push(domWindow as unknown as Record<string, unknown>);
  }

  for (const target of targets) {
    patchTargetWebRtc(target);
  }

  installed = true;
}

/** Call after installBrowserShim so lib-jitsi can acquire a silent mic track. */
export function applyWrtcMediaDevices(): void {
  if (!installed) {
    return;
  }

  const mediaDevices = createWrtcMediaDevices();
  const shimNavigator = getShimNavigator();
  const domWindow = getDomWindow();

  if (shimNavigator) {
    patchNavigatorMediaDevices(shimNavigator, mediaDevices);
  }
  if (domWindow) {
    patchNavigatorMediaDevices(domWindow.navigator as unknown as Navigator, mediaDevices);
  }
  if (globalThis.navigator) {
    patchNavigatorMediaDevices(globalThis.navigator, mediaDevices);
  }
}

export function isWebRtcAdapterInstalled(): boolean {
  return installed && typeof globalThis.RTCPeerConnection !== "undefined";
}
