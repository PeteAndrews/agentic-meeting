import WebSocket from "ws";

/** Strophe/lib-jitsi work more reliably with the `ws` package than Node's built-in WebSocket. */
export function installWebSocketShim(): void {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

  const domWindow = g.window as Record<string, unknown> | undefined;
  if (domWindow) {
    domWindow.WebSocket = g.WebSocket;
  }
}
