declare module "@roamhq/wrtc" {
  export const RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  export const RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  export const RTCIceCandidate: typeof globalThis.RTCIceCandidate;
  export const MediaStream: typeof globalThis.MediaStream;
  export const MediaStreamTrack: typeof globalThis.MediaStreamTrack;
}

declare const JitsiMeetJS: unknown;

declare module "ws" {
  import type { EventEmitter } from "node:events";
  class WebSocket extends EventEmitter {
    constructor(address: string, protocols?: string | string[]);
  }
  export default WebSocket;
}
