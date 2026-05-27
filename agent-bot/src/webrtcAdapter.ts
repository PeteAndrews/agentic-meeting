import wrtc from "@roamhq/wrtc";

import {
  createMediaDevicesStub,
  getDomWindow,
  getShimNavigator,
} from "./browserShim.js";
import { normalizeSessionDescriptionForNode } from "./sdpSanitize.js";

let installed = false;

type CodecCapable = {
  setCodecPreferences?: (codecs: unknown) => void;
  setVideoCodecs?: (codecs: unknown) => void;
};

function patchCodecPreferencesOnPrototype(proto: object, label: string): void {
  if (!proto || typeof proto !== "object") {
    return;
  }
  const target = proto as CodecCapable;
  if (typeof target.setCodecPreferences !== "function") {
    target.setCodecPreferences = () => {
      // no-op — lib-jitsi probes browser codec APIs missing in node-webrtc
    };
  }
  if (typeof target.setVideoCodecs !== "function") {
    target.setVideoCodecs = () => {
      // no-op for QualityController codec selection in Node
    };
  }
}

const logSdp = process.env.AGENT_BOT_LOG_SDP === "true";

function extractDescriptionInit(description: unknown): RTCSessionDescriptionInit | null {
  if (!description || typeof description !== "object") {
    return null;
  }
  const record = description as Record<string, unknown>;
  const type = record.type;
  const sdp = record.sdp ?? record._sdp;
  if (typeof type !== "string") {
    return null;
  }
  return {
    type: type as RTCSdpType,
    sdp: typeof sdp === "string" ? sdp : undefined,
  };
}

function toWrtcSessionDescription(
  description: RTCSessionDescription | RTCSessionDescriptionInit,
): InstanceType<typeof wrtc.RTCSessionDescription> {
  try {
    const rawSdp =
      description instanceof RTCSessionDescription
        ? description.sdp
        : (description as RTCSessionDescriptionInit).sdp;
    if (logSdp && rawSdp) {
      console.log(
        `[agent-bot] raw SDP has fingerprint=${rawSdp.includes("a=fingerprint:")} ice=${rawSdp.includes("a=ice-ufrag:")} bytes=${rawSdp.length}`,
      );
      console.log(`[agent-bot] raw SDP dump:\n${rawSdp}`);
    }

    const normalized = normalizeSessionDescriptionForNode(description);
    if (logSdp && normalized.sdp) {
      console.log(
        `[agent-bot] sanitized SDP has fingerprint=${normalized.sdp.includes("a=fingerprint:")} ice=${normalized.sdp.includes("a=ice-ufrag:")}`,
      );
      console.log(
        `[agent-bot] SDP ${normalized.type} (${normalized.sdp.length} bytes): ${normalized.sdp.slice(0, 120).replace(/\r?\n/g, "\\n")}…`,
      );
    }
    return new wrtc.RTCSessionDescription(normalized);
  } catch (error) {
    const raw =
      description instanceof RTCSessionDescription
        ? { type: description.type, sdpLen: description.sdp?.length ?? 0 }
        : { type: (description as RTCSessionDescriptionInit).type, sdpLen: (description as RTCSessionDescriptionInit).sdp?.length ?? 0 };
    console.error("[agent-bot] SDP normalize failed:", raw, error);
    throw error;
  }
}

function patchSessionDescriptionMethods(Base: typeof wrtc.RTCPeerConnection): void {
  const proto = Base.prototype as RTCPeerConnection & {
    setRemoteDescription: (...args: unknown[]) => Promise<void>;
    setLocalDescription: (...args: unknown[]) => Promise<void>;
  };
  // Do NOT .bind(proto) — wrtc uses this._pc on the instance.
  const originalSetRemote = proto.setRemoteDescription;
  const originalSetLocal = proto.setLocalDescription;

  proto.setRemoteDescription = function patchedSetRemoteDescription(
    this: RTCPeerConnection,
    ...args: unknown[]
  ) {
    const init = extractDescriptionInit(args[0]);
    if (init) {
      args[0] = toWrtcSessionDescription(init);
    }
    return originalSetRemote.apply(this, args).catch((error: unknown) => {
      const desc = args[0] as { type?: string; sdp?: string } | undefined;
      console.error(
        `[agent-bot] setRemoteDescription failed type=${desc?.type ?? "?"} sdpBytes=${desc?.sdp?.length ?? 0}:`,
        error,
      );
      if (logSdp && desc?.sdp) {
        console.error(`[agent-bot] SDP dump:\n${desc.sdp}`);
      }
      throw error;
    });
  };

  proto.setLocalDescription = function patchedSetLocalDescription(
    this: RTCPeerConnection,
    ...args: unknown[]
  ) {
    // Let node-webrtc set exactly the answer it created. We sanitize the local
    // description only when lib-jitsi reads it back to build Jingle.
    return originalSetLocal.apply(this, args).catch((error: unknown) => {
      const desc = args[0] as { type?: string; sdp?: string } | undefined;
      console.error(
        `[agent-bot] setLocalDescription failed type=${desc?.type ?? "?"} sdpBytes=${desc?.sdp?.length ?? 0}:`,
        error,
      );
      if (logSdp && desc?.sdp) {
        console.error(`[agent-bot] local SDP dump:\n${desc.sdp}`);
      }
      throw error;
    });
  };
}

function patchIceCandidateEvent(Base: typeof wrtc.RTCPeerConnection): void {
  const proto = Base.prototype as unknown as {
    dispatchEvent?: (event: unknown) => boolean | void;
  };
  const originalDispatch = proto.dispatchEvent;
  if (typeof originalDispatch !== "function") {
    return;
  }

  proto.dispatchEvent = function patchedDispatchEvent(this: RTCPeerConnection, event: unknown) {
    const maybeEvent = event as { type?: string; candidate?: unknown; target?: unknown } | undefined;
    if (maybeEvent?.type === "icecandidate" && "candidate" in maybeEvent) {
      const original = maybeEvent;
      const cloned = {
        type: original.type,
        candidate: original.candidate,
        target: original.target ?? this,
      };
      return originalDispatch.call(this, cloned);
    }
    return originalDispatch.call(this, event);
  };
}

/** node-webrtc lacks setCodecPreferences; lib-jitsi probes RTCRtpSender/Receiver prototypes. */
function patchRtcPeerConnection(): typeof wrtc.RTCPeerConnection {
  const Base = wrtc.RTCPeerConnection;
  patchCodecPreferencesOnPrototype(Base.prototype, "RTCPeerConnection");
  patchSessionDescriptionMethods(Base);
  patchIceCandidateEvent(Base);
  return Base;
}

function patchRtpTypes(): void {
  const w = wrtc as typeof wrtc & {
    RTCRtpSender: { prototype: object };
    RTCRtpReceiver: { prototype: object };
    RTCRtpTransceiver?: { prototype: object };
  };
  patchCodecPreferencesOnPrototype(w.RTCRtpSender.prototype, "RTCRtpSender");
  patchCodecPreferencesOnPrototype(w.RTCRtpReceiver.prototype, "RTCRtpReceiver");
  if (w.RTCRtpTransceiver?.prototype) {
    patchCodecPreferencesOnPrototype(w.RTCRtpTransceiver.prototype, "RTCRtpTransceiver");
  }
}

function patchTargetWebRtc(target: Record<string, unknown>): void {
  const w = wrtc as typeof wrtc & {
    RTCRtpSender: unknown;
    RTCRtpReceiver: unknown;
    RTCRtpTransceiver: unknown;
  };
  const PatchedRtc = patchRtcPeerConnection();
  target.RTCPeerConnection = PatchedRtc;
  target.RTCSessionDescription = wrtc.RTCSessionDescription;
  target.RTCIceCandidate = wrtc.RTCIceCandidate;
  target.MediaStream = wrtc.MediaStream;
  target.MediaStreamTrack = wrtc.MediaStreamTrack;
  target.RTCRtpSender = w.RTCRtpSender;
  target.RTCRtpReceiver = w.RTCRtpReceiver;
  target.RTCRtpTransceiver = w.RTCRtpTransceiver;
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

export function patchTrackForLibJitsi(track: MediaStreamTrack): void {
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

  patchRtpTypes();

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
  return (
    installed &&
    typeof globalThis.RTCPeerConnection !== "undefined" &&
    typeof (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender !== "undefined"
  );
}

/** WebRTC types for lib-jitsi VM context (must mirror globals). */
export function getWebRtcGlobalsForVm(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  return {
    RTCPeerConnection: g.RTCPeerConnection,
    RTCSessionDescription: g.RTCSessionDescription,
    RTCIceCandidate: g.RTCIceCandidate,
    MediaStream: g.MediaStream,
    MediaStreamTrack: g.MediaStreamTrack,
    RTCRtpSender: g.RTCRtpSender,
    RTCRtpReceiver: g.RTCRtpReceiver,
    RTCRtpTransceiver: g.RTCRtpTransceiver,
  };
}
