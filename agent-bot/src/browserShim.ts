import {
  DOMImplementation,
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
} from "@xmldom/xmldom";
import { Window } from "happy-dom";

import { Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";
import { installXmlDomPolyfills } from "./xmlDomPolyfills.js";
import { installCryptoPolyfill } from "./cryptoPolyfill.js";

/** Browser globals so lib-jitsi-meet / Strophe can run in Node. */

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let installed = false;
let domWindow: Window | null = null;
let shimNavigator: Navigator | null = null;
let xmlDocument: XmlDocument | null = null;
const domImplementation = new DOMImplementation();

class MemoryStorage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  clear() {
    this.data.clear();
  }

  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
}

function defineGlobal(name: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && !descriptor.configurable) {
    return;
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/** Shared stub — lib-jitsi calls enumerateDevices at init even when muted. */
export function createMediaDevicesStub(): MediaDevices {
  return {
    ondevicechange: null,
    enumerateDevices: async () => [],
    getSupportedConstraints: () => ({}),
    getUserMedia: async () => {
      throw new Error("getUserMedia is not available in agent-bot");
    },
    getDisplayMedia: async () => {
      throw new Error("getDisplayMedia is not available in agent-bot");
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  } as unknown as MediaDevices;
}

export function createShimNavigator(): Navigator {
  const mediaDevices = createMediaDevicesStub();
  return {
    userAgent: CHROME_USER_AGENT,
    platform: "Win32",
    vendor: "Google Inc.",
    language: "en-US",
    languages: ["en-US"],
    mediaDevices,
    javaEnabled: () => false,
    sendBeacon: () => true,
  } as unknown as Navigator;
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

function patchNodeNavigator(mediaDevices: MediaDevices): void {
  const nodeNav = globalThis.navigator;
  if (!nodeNav) {
    return;
  }
  patchNavigatorMediaDevices(nodeNav, mediaDevices);
}

function createXmlDocument(): XmlDocument {
  // Single XML document tree for Strophe create + serialize (must not mix with happy-dom nodes).
  return domImplementation.createDocument("", "", null);
}

export function installBrowserShim(): void {
  if (installed) {
    return;
  }

  installXmlDomPolyfills();

  shimNavigator = createShimNavigator();
  const mediaDevices = shimNavigator.mediaDevices ?? createMediaDevicesStub();
  xmlDocument = createXmlDocument();

  domWindow = new Window({
    url: "https://agentic-meeting.local/agent-bot",
    width: 1280,
    height: 720,
    settings: {
      navigator: {
        userAgent: CHROME_USER_AGENT,
      },
    },
  });

  Object.defineProperty(domWindow, "navigator", {
    value: shimNavigator,
    configurable: true,
    writable: true,
  });

  // Strophe must use the same document implementation for building and serializing stanzas.
  Object.defineProperty(domWindow, "document", {
    value: xmlDocument,
    configurable: true,
    writable: true,
  });

  const win = domWindow as unknown as Record<string, unknown>;
  win.DOMParser = DOMParser;
  win.XMLSerializer = XMLSerializer;
  win.XMLHttpRequest = domWindow.XMLHttpRequest;
  win.Event = domWindow.Event;

  defineGlobal("window", domWindow);
  defineGlobal("self", domWindow);
  defineGlobal("document", xmlDocument);
  defineGlobal("navigator", shimNavigator);
  defineGlobal("DOMParser", DOMParser);
  defineGlobal("XMLSerializer", XMLSerializer);
  defineGlobal("Element", XmlElement);
  defineGlobal("Node", XmlNode);
  defineGlobal("Event", domWindow.Event);
  defineGlobal("location", domWindow.location);
  defineGlobal("localStorage", new MemoryStorage());
  defineGlobal("sessionStorage", new MemoryStorage());

  patchNodeNavigator(mediaDevices);

  installCryptoPolyfill(domWindow as unknown as Record<string, unknown>, shimNavigator as unknown as Record<string, unknown>);

  installed = true;
}

export function getDomWindow(): Window | null {
  return domWindow;
}

export function getShimNavigator(): Navigator | null {
  return shimNavigator;
}

export function getXmlDocument(): XmlDocument | null {
  return xmlDocument;
}
