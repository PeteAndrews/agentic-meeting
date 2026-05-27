const VALID_SDP_TYPES = new Set<RTCSdpType>(["offer", "answer", "pranswer", "rollback"]);

/** Video codecs node-webrtc often cannot negotiate with modern JVB offers. */
const STRIP_VIDEO_CODEC_NAMES = new Set([
  "AV1",
  "AV1X",
  "VP9",
  "H265",
  "HEVC",
  "H264",
  "H263",
  "MP4V-ES",
]);

type SessionDescriptionInit = {
  type: RTCSdpType;
  sdp?: string;
};

function coerceSdpType(type: unknown, sdp: string): RTCSdpType {
  if (typeof type === "string" && VALID_SDP_TYPES.has(type as RTCSdpType)) {
    return type as RTCSdpType;
  }
  if (sdp.includes("a=setup:active") || /\nm=.*\r?\na=sendonly/i.test(sdp)) {
    return "offer";
  }
  return "answer";
}

function collectPayloadTypesToStrip(lines: string[]): Set<string> {
  const strip = new Set<string>();

  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+([^\s/]+)/i);
    if (!match) {
      continue;
    }
    const pt = match[1];
    const codec = match[2].toUpperCase();
    if (STRIP_VIDEO_CODEC_NAMES.has(codec)) {
      strip.add(pt);
    }
  }

  for (const line of lines) {
    const rtx = line.match(/^a=fmtp:(\d+)\s+apt=(\d+)/i);
    if (rtx && strip.has(rtx[2])) {
      strip.add(rtx[1]);
    }
  }

  return strip;
}

function shouldDropAttributeLine(line: string): boolean {
  const candidate = line.match(/^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+/i);
  if (candidate?.[1]?.includes(":")) {
    return true;
  }
  if (/^a=simulcast:/i.test(line)) {
    return true;
  }
  if (/^a=rid:/i.test(line)) {
    return true;
  }
  if (/^a=extmap:\d+\s+urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id/i.test(line)) {
    return true;
  }
  if (/^a=extmap:\d+\s+urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id/i.test(line)) {
    return true;
  }
  if (/^a=fmtp:\d+\s*$/i.test(line)) {
    return true;
  }
  if (/^a=fmtp:\d+\s+\./i.test(line)) {
    return true;
  }
  return false;
}

function collectDtlsIceLines(lines: string[]): string[] {
  const prefixes = [
    "a=fingerprint:",
    "a=setup:",
    "a=ice-ufrag:",
    "a=ice-pwd:",
    "a=ice-options:",
    "a=rtcp-mux",
  ];
  const collected = new Map<string, string>();

  for (const line of lines) {
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (prefix && !collected.has(prefix)) {
      collected.set(prefix, line);
    }
  }

  return [...collected.values()];
}

/** Headless bot: keep only the first audio m-line for node-webrtc. */
function keepFirstAudioMediaSection(lines: string[]): string[] {
  const out: string[] = [];
  let inMedia = false;
  let keepCurrentMedia = false;
  let keptAudio = false;

  for (const line of lines) {
    if (line.startsWith("m=")) {
      inMedia = true;
      keepCurrentMedia = line.startsWith("m=audio") && !keptAudio;
      if (keepCurrentMedia) {
        keptAudio = true;
        out.push(line);
      }
      continue;
    }

    if (!inMedia || keepCurrentMedia) {
      out.push(line);
    }
  }

  return out;
}

function ensureDtlsIceLines(lines: string[], requiredLines: string[]): string[] {
  if (requiredLines.length === 0) {
    return lines;
  }

  const existing = new Set(
    lines.map((line) => {
      const idx = line.indexOf(":");
      return idx === -1 ? line : line.slice(0, idx);
    }),
  );
  const missing = requiredLines.filter((line) => {
    const idx = line.indexOf(":");
    const key = idx === -1 ? line : line.slice(0, idx);
    return !existing.has(key);
  });
  if (missing.length === 0) {
    return lines;
  }

  const insertAfter = Math.max(
    lines.findIndex((line) => line.startsWith("a=mid:")),
    lines.findIndex((line) => line.startsWith("c=")),
  );
  if (insertAfter === -1) {
    return [...lines, ...missing];
  }

  return [
    ...lines.slice(0, insertAfter + 1),
    ...missing,
    ...lines.slice(insertAfter + 1),
  ];
}

function fixBundleLine(line: string): string {
  if (!line.startsWith("a=group:BUNDLE")) {
    return line;
  }
  return "a=group:BUNDLE 0";
}

function ensureBundleLine(lines: string[]): string[] {
  if (lines.some((line) => line.startsWith("a=group:BUNDLE"))) {
    return lines;
  }

  const timingIndex = lines.findIndex((line) => line.startsWith("t="));
  if (timingIndex === -1) {
    return ["a=group:BUNDLE 0", ...lines];
  }

  return [
    ...lines.slice(0, timingIndex + 1),
    "a=group:BUNDLE 0",
    ...lines.slice(timingIndex + 1),
  ];
}

function normalizeKnownBadLines(line: string): string {
  if (/^a=msid-semantic:\s*WMS\s*$/i.test(line)) {
    return "a=msid-semantic: WMS *";
  }
  if (/^a=msid-semantic:\s+WMS\s*$/i.test(line)) {
    return "a=msid-semantic: WMS *";
  }
  if (/^a=msid-semantic:\s{2,}WMS\b/i.test(line)) {
    return line.replace(/^a=msid-semantic:\s+WMS/i, "a=msid-semantic: WMS");
  }
  if (/^a=msid-semantic:\s+WMS\s+agent-bot\s*$/i.test(line)) {
    return "a=msid-semantic: WMS *";
  }
  if (/^a=msid:-\s+/i.test(line)) {
    return line.replace(/^a=msid:-\s+/i, "a=msid:agent-bot ");
  }
  if (/^a=ssrc:\d+\s+msid:-\s+/i.test(line)) {
    return line.replace(/\smsid:-\s+/i, " msid:agent-bot ");
  }
  if (/^a=candidate:/i.test(line)) {
    const match = line.match(
      /^a=candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)(?:\s+tcptype\s+(\S+))?/i,
    );
    if (match) {
      const [, foundation, component, protocol, priority, ip, port, type, tcpType] = match;
      const base = `a=candidate:${foundation} ${component} ${protocol.toUpperCase()} ${priority} ${ip} ${port} typ ${type}`;
      return tcpType ? `${base} tcptype ${tcpType}` : base;
    }
  }
  return line;
}

/** Sanitize JVB/Jicofo SDP for @roamhq/wrtc (audio-only agent). */
export function sanitizeSdpForNodeWebrtc(sdp: string): string {
  if (!sdp?.trim()) {
    return sdp;
  }

  let lines = sdp
    .split(/\r?\n/)
    .filter((line) => line.length > 0 || line === "")
    .map(normalizeKnownBadLines);
  const dtlsIceLines = collectDtlsIceLines(lines);

  lines = keepFirstAudioMediaSection(lines);

  const stripPts = collectPayloadTypesToStrip(lines);

  lines = lines.filter((line) => {
    if (shouldDropAttributeLine(line)) {
      return false;
    }
    for (const pt of stripPts) {
      if (
        line.startsWith(`a=rtpmap:${pt} `) ||
        line.startsWith(`a=fmtp:${pt} `) ||
        line.startsWith(`a=rtcp-fb:${pt} `)
      ) {
        return false;
      }
    }
    return true;
  });

  lines = lines.map((line) => {
    if (line.startsWith("a=group:BUNDLE")) {
      return fixBundleLine(line);
    }
    if (!line.startsWith("m=")) {
      return line;
    }
    const parts = line.split(" ");
    if (parts.length < 4) {
      return line;
    }
    const head = parts.slice(0, 3);
    const payloads = parts.slice(3).filter((pt) => !stripPts.has(pt));
    return [...head, ...payloads].join(" ");
  });

  lines = ensureBundleLine(lines);
  lines = ensureDtlsIceLines(lines, dtlsIceLines);

  const body = lines.join("\r\n");
  return `${body}\r\n`;
}

export function normalizeSessionDescriptionForNode(
  description: RTCSessionDescription | RTCSessionDescriptionInit,
): RTCSessionDescriptionInit {
  const rawType =
    description instanceof RTCSessionDescription
      ? description.type
      : (description as RTCSessionDescriptionInit).type;
  const rawSdp =
    description instanceof RTCSessionDescription
      ? description.sdp
      : (description as RTCSessionDescriptionInit).sdp;

  const sdp = rawSdp ? sanitizeSdpForNodeWebrtc(rawSdp) : "";
  const type = coerceSdpType(rawType, sdp);

  if (!sdp.trim()) {
    throw new TypeError("SessionDescription has empty SDP after sanitize");
  }

  return { type, sdp };
}
