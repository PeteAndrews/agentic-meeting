import { useEffect, useRef } from 'react'

type Props = {
  roomName: string
  displayName: string
  startWithAudioMuted: boolean
  onJitsiEvent?: (name: string, payload: Record<string, unknown>) => void
}

let jitsiExternalApiPromise: Promise<void> | null = null

function loadJitsiExternalApi(): Promise<void> {
  if (jitsiExternalApiPromise) return jitsiExternalApiPromise

  jitsiExternalApiPromise = new Promise<void>((resolve, reject) => {
    if (window.JitsiMeetExternalAPI) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = 'https://meet.jit.si/external_api.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Jitsi external_api.js'))
    document.head.appendChild(script)
  })

  return jitsiExternalApiPromise
}

export function JitsiEmbed({ roomName, displayName, startWithAudioMuted, onJitsiEvent }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<JitsiMeetExternalAPI | null>(null)

  useEffect(() => {
    let cancelled = false

    async function start() {
      await loadJitsiExternalApi()
      if (cancelled) return
      if (!hostRef.current) return
      if (!window.JitsiMeetExternalAPI) {
        throw new Error('JitsiMeetExternalAPI is not available after script load')
      }

      hostRef.current.innerHTML = ''

      const api = new window.JitsiMeetExternalAPI('meet.jit.si', {
        roomName,
        parentNode: hostRef.current,
        userInfo: { displayName },
        configOverwrite: {
          startWithAudioMuted,
        },
      })

      apiRef.current = api

      const events = [
        'videoConferenceJoined',
        'videoConferenceLeft',
        'participantJoined',
        'participantLeft',
        'audioMuteStatusChanged',
        'videoMuteStatusChanged',
      ] as const

      for (const name of events) {
        api.addEventListener(name, (payload: unknown) => {
          onJitsiEvent?.(name, (payload ?? {}) as Record<string, unknown>)
        })
      }
    }

    void start()

    return () => {
      cancelled = true
      apiRef.current?.dispose()
      apiRef.current = null
    }
  }, [roomName, displayName, startWithAudioMuted, onJitsiEvent])

  return <div ref={hostRef} className="jitsiHost" />
}

