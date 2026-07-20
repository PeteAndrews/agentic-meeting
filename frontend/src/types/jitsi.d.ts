declare global {
  // Minimal subset of the Jitsi iFrame API we use.
  // https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe
  interface JitsiMeetExternalAPI {
    addEventListener(name: string, handler: (payload: unknown) => void): void
    dispose(): void
    resize?: (width: number | string, height: number | string) => void
  }

  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: {
        roomName: string
        parentNode: HTMLElement
        width?: number | string
        height?: number | string
        userInfo?: { displayName?: string }
        configOverwrite?: Record<string, unknown>
        interfaceConfigOverwrite?: Record<string, unknown>
      },
    ) => JitsiMeetExternalAPI
  }
}

export {}

