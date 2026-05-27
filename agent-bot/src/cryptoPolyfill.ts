import { webcrypto } from "node:crypto";

function hasGetRandomValues(value: unknown): value is Crypto {
  return (
    typeof value === "object" &&
    value !== null &&
    "getRandomValues" in value &&
    typeof (value as Crypto).getRandomValues === "function"
  );
}

/** Web Crypto API for lib-jitsi / uuid (conference-request IQ needs getRandomValues). */
export function getNodeCrypto(): Crypto {
  if (hasGetRandomValues(globalThis.crypto)) {
    return globalThis.crypto;
  }
  return webcrypto as Crypto;
}

export function installCryptoPolyfill(...targets: Array<Record<string, unknown> | null | undefined>): void {
  const crypto = getNodeCrypto();
  defineGlobalCrypto(crypto);

  for (const target of targets) {
    if (!target) {
      continue;
    }
    if (!target.crypto || typeof (target.crypto as Crypto).getRandomValues !== "function") {
      target.crypto = crypto;
    }
  }
}

function defineGlobalCrypto(crypto: Crypto): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  if (descriptor && !descriptor.configurable) {
    return;
  }
  Object.defineProperty(globalThis, "crypto", {
    value: crypto,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
