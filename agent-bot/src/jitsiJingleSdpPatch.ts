import { normalizeSessionDescriptionForNode } from "./sdpSanitize.js";

function getXmlText(node: unknown): string {
  const record = node as { outerHTML?: string; toString?: () => string };
  if (typeof record?.outerHTML === "string") {
    return record.outerHTML;
  }
  if (typeof record?.toString === "function") {
    return record.toString();
  }
  return "";
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function getAttr(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`\\s${name}=["']([^"']+)["']`, "i"));
  return match ? decodeEntities(match[1]) : null;
}

function extractTransportLines(jingleOffer: unknown): string[] {
  const xml = getXmlText(jingleOffer);
  if (!xml) {
    return [];
  }

  const transport = xml.match(/<transport\b[\s\S]*?<\/transport>/i)?.[0] ?? xml;
  const lines: string[] = [];
  const ufrag = getAttr(transport, "ufrag");
  const pwd = getAttr(transport, "pwd");

  if (ufrag) {
    lines.push(`a=ice-ufrag:${ufrag}`);
  }
  if (pwd) {
    lines.push(`a=ice-pwd:${pwd}`);
  }

  const fingerprintMatch = transport.match(/<fingerprint\b([^>]*)>([\s\S]*?)<\/fingerprint>/i);
  if (fingerprintMatch) {
    const hash = getAttr(fingerprintMatch[1], "hash") ?? "sha-256";
    const setup = getAttr(fingerprintMatch[1], "setup") ?? "actpass";
    const fingerprint = decodeEntities(fingerprintMatch[2].trim());
    lines.push(`a=fingerprint:${hash} ${fingerprint}`);
    lines.push(`a=setup:${setup}`);
  }

  const candidateRegex = /<candidate\b([^/>]*)\/?>/gi;
  for (const match of transport.matchAll(candidateRegex)) {
    const attrs = match[1];
    const foundation = getAttr(attrs, "foundation");
    const component = getAttr(attrs, "component");
    const protocol = getAttr(attrs, "protocol");
    const priority = getAttr(attrs, "priority");
    const ip = getAttr(attrs, "ip");
    const port = getAttr(attrs, "port");
    const type = getAttr(attrs, "type");

    if (foundation && component && protocol && priority && ip && port && type) {
      lines.push(
        `a=candidate:${foundation} ${component} ${protocol.toUpperCase()} ${priority} ${ip} ${port} typ ${type}`,
      );
    }
  }

  return [...new Set(lines)];
}

function injectTransportIntoSdp(rawSdp: string, transportLines: string[]): string {
  if (!rawSdp || transportLines.length === 0) {
    return rawSdp;
  }
  if (rawSdp.includes("a=fingerprint:") && rawSdp.includes("a=ice-ufrag:")) {
    return rawSdp;
  }

  const lines = rawSdp.split(/\r?\n/).filter((line) => line.length > 0);
  const firstAudio = lines.findIndex((line) => line.startsWith("m=audio"));
  if (firstAudio === -1) {
    return rawSdp;
  }

  let insertAfter = firstAudio;
  for (let i = firstAudio + 1; i < lines.length && !lines[i].startsWith("m="); i += 1) {
    if (lines[i].startsWith("a=mid:") || lines[i].startsWith("c=")) {
      insertAfter = i;
    }
  }

  const existing = new Set(lines);
  const missing = transportLines.filter((line) => !existing.has(line));
  if (missing.length === 0) {
    return rawSdp;
  }

  const patched = [
    ...lines.slice(0, insertAfter + 1),
    ...missing,
    ...lines.slice(insertAfter + 1),
  ];
  return `${patched.join("\r\n")}\r\n`;
}

function patchJingleOfferSdp(jingleSession: any, jingleOffer: unknown): void {
  if (!jingleSession || jingleSession.__agentBotJingleSdpPatched) {
    return;
  }

  const original = jingleSession._processNewJingleOfferIq?.bind(jingleSession);
  if (typeof original !== "function") {
    return;
  }

  const transportLines = extractTransportLines(jingleOffer);
  const xml = getXmlText(jingleOffer);
  console.log(
    `[agent-bot] Jingle offer transport lines: fingerprint=${transportLines.some((line) => line.startsWith("a=fingerprint:"))} ice=${transportLines.some((line) => line.startsWith("a=ice-ufrag:"))}`,
  );
  if (process.env.AGENT_BOT_LOG_JINGLE === "true" && xml) {
    console.log(`[agent-bot] Jingle offer dump:\n${xml}`);
  }

  jingleSession._processNewJingleOfferIq = (offerIq: unknown) => {
    const sdp = original(offerIq);
    if (sdp?.raw && (!sdp.raw.includes("a=fingerprint:") || !sdp.raw.includes("a=ice-ufrag:"))) {
      sdp.raw = injectTransportIntoSdp(sdp.raw, transportLines);
      if (Array.isArray(sdp.media)) {
        sdp.media = sdp.raw.split(/\r?\nm=/).slice(1).map((section: string) => `m=${section}`);
      }
      console.log(
        `[agent-bot] patched Jingle SDP transport: fingerprint=${sdp.raw.includes("a=fingerprint:")} ice=${sdp.raw.includes("a=ice-ufrag:")}`,
      );
    }
    return sdp;
  };

  jingleSession.__agentBotJingleSdpPatched = true;
}

function patchTraceableLocalDescription(jingleSession: any): void {
  if (!jingleSession || jingleSession.__agentBotLocalDescriptionPatched) {
    return;
  }

  const installLocalDescriptionGetter = () => {
    const tpc = jingleSession.peerconnection;
    const proto = tpc && Object.getPrototypeOf(tpc);
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, "localDescription");

    if (!tpc || !descriptor?.get || Object.prototype.hasOwnProperty.call(tpc, "localDescription")) {
      return;
    }

    Object.defineProperty(tpc, "localDescription", {
      configurable: true,
      enumerable: true,
      get() {
        // Avoid TraceablePeerConnection's getter: it assumes video m-lines exist
        // and runs simulcast SSRC munging, but this bot negotiates audio-only SDP.
        const desc = this.peerconnection?.localDescription;
        if (!desc?.sdp || !desc?.type) {
          return {};
        }
        const normalized = normalizeSessionDescriptionForNode(desc);
        return new RTCSessionDescription(normalized);
      },
    });
    console.log("[agent-bot] patched TraceablePeerConnection localDescription for audio-only Jingle");
  };

  const originalAcceptOffer = jingleSession.acceptOffer?.bind(jingleSession);
  if (typeof originalAcceptOffer !== "function") {
    return;
  }

  jingleSession.acceptOffer = (...args: unknown[]) => {
    installLocalDescriptionGetter();
    return originalAcceptOffer(...args);
  };

  jingleSession.__agentBotLocalDescriptionPatched = true;
}

export function patchJingleSessionForNodeBridge(jingleSession: any, jingleOffer: unknown): void {
  patchJingleOfferSdp(jingleSession, jingleOffer);
  patchTraceableLocalDescription(jingleSession);
}
