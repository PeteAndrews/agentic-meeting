import { createRequire } from "node:module";
import vm from "node:vm";

import {
  getDomWindow,
  getShimNavigator,
  getXmlDocument,
  installBrowserShim,
} from "./browserShim.js";
import { config } from "./config.js";
import {
  applyWrtcMediaDevices,
  getWebRtcGlobalsForVm,
  installWebRtcAdapter,
  isWebRtcAdapterInstalled,
} from "./webrtcAdapter.js";
import { installWebSocketShim } from "./webSocketShim.js";
import { getNodeCrypto, installCryptoPolyfill } from "./cryptoPolyfill.js";
import { Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JitsiMeetGlobal = any;

let loadPromise: Promise<JitsiMeetGlobal> | null = null;

export async function loadJitsiMeet(): Promise<JitsiMeetGlobal> {
  const g = globalThis as Record<string, unknown>;
  if (g.JitsiMeetJS) {
    return g.JitsiMeetJS as JitsiMeetGlobal;
  }

  if (!loadPromise) {
    loadPromise = loadJitsiMeetInternal().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

function applyWebRtcToDomWindow(domWindow: import("happy-dom").Window): void {
  const win = domWindow as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(getWebRtcGlobalsForVm())) {
    if (value !== undefined) {
      win[key] = value;
    }
  }
}

function buildJitsiVmContext(domWindow: import("happy-dom").Window, shimNavigator: Navigator): vm.Context {
  const nodeRequire = createRequire(import.meta.url);
  const g = globalThis as Record<string, unknown>;
  const WebSocketImpl = g.WebSocket;

  applyWebRtcToDomWindow(domWindow);

  const xmlDocument = getXmlDocument() ?? domWindow.document;
  const webRtcGlobals = getWebRtcGlobalsForVm();

  const context: Record<string, unknown> = {
    window: domWindow,
    self: domWindow,
    globalThis: domWindow,
    document: xmlDocument,
    navigator: shimNavigator,
    location: domWindow.location,
    crypto: getNodeCrypto(),
    XMLHttpRequest: domWindow.XMLHttpRequest,
    DOMParser: g.DOMParser,
    XMLSerializer: g.XMLSerializer,
    localStorage: g.localStorage,
    sessionStorage: g.sessionStorage,
    require: nodeRequire,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    fetch,
    ...webRtcGlobals,
    structuredClone: globalThis.structuredClone?.bind(globalThis),
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    atob: globalThis.atob?.bind(globalThis),
    btoa: globalThis.btoa?.bind(globalThis),
    ArrayBuffer,
    Uint8Array,
    WebSocket: WebSocketImpl,
    Element: XmlElement,
    Node: XmlNode,
    Event: (domWindow as unknown as { Event?: unknown }).Event ?? g.Event,
    Error,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Proxy,
    Reflect,
  };

  return vm.createContext(context);
}

async function loadJitsiMeetInternal(): Promise<JitsiMeetGlobal> {
  installBrowserShim();
  installCryptoPolyfill();
  installWebSocketShim();
  installWebRtcAdapter();
  applyWrtcMediaDevices();

  const domWindow = getDomWindow();
  const shimNavigator = getShimNavigator();
  if (!domWindow || !shimNavigator) {
    throw new Error("Browser shim failed to initialize");
  }

  if (!isWebRtcAdapterInstalled()) {
    throw new Error(
      "WebRTC adapter missing. Run: npm install @roamhq/wrtc (or AGENT_BOT_FAKE_JITSI=true for API-only tests).",
    );
  }

  const webRtcGlobals = getWebRtcGlobalsForVm();
  if (!webRtcGlobals.RTCRtpSender) {
    throw new Error("RTCRtpSender not installed — lib-jitsi JVB accept will fail");
  }

  const url = config.jitsiLibUrl;
  console.log(`[agent-bot] loading lib-jitsi-meet from ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch lib-jitsi-meet (${response.status}) from ${url}`);
  }

  const source = await response.text();
  const context = buildJitsiVmContext(domWindow, shimNavigator);
  installCryptoPolyfill(
    context,
    domWindow as unknown as Record<string, unknown>,
    context.window as Record<string, unknown>,
  );
  const script = new vm.Script(source, { filename: "lib-jitsi-meet.min.js" });
  script.runInContext(context);

  const ctx = context as Record<string, unknown>;
  const win = ctx.window as Record<string, unknown> | undefined;
  const JitsiMeetJS = win?.JitsiMeetJS ?? ctx.JitsiMeetJS ?? (globalThis as Record<string, unknown>).JitsiMeetJS;

  if (!JitsiMeetJS) {
    throw new Error("JitsiMeetJS global not found after loading lib-jitsi-meet");
  }

  (globalThis as Record<string, unknown>).JitsiMeetJS = JitsiMeetJS;
  console.log("[agent-bot] lib-jitsi-meet loaded");
  return JitsiMeetJS as JitsiMeetGlobal;
}
