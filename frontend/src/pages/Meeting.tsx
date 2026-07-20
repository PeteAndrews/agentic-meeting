import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { apiJson } from '../api/http'
import { JitsiEmbed } from '../components/JitsiEmbed'
import { isServerSttSupported, startServerStt } from '../hooks/useServerStt'
import { destinationForRole, isProxyRole } from '../routing/roleRoutes'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { clearSession } from '../store/sessionSlice'

type LogEventRequest = {
  roomName: string
  participantId: string
  role: 'moderator' | 'active' | 'silent' | 'proxy' | 'agent'
  condition: 'HH' | 'HA'
  tsMs: number
  eventType: string
  payload: Record<string, unknown>
}

type TranscriptSegmentRequest = {
  roomName: string
  participantId: string
  role: 'moderator' | 'active' | 'silent' | 'proxy' | 'agent'
  condition: 'HH' | 'HA'
  startMs: number
  endMs: number
  isFinal: boolean
  text: string
  confidence?: number | null
}

type SessionConfig = {
  roomName: string
  condition: 'HH' | 'HA'
  sttEnabled: boolean
  sttMode: 'browser' | 'server_per_client'
  sttRoles: Array<'moderator' | 'active' | 'silent' | 'proxy' | 'agent'>
  sttLanguage: string
  sttSendInterim: boolean
  sttRequireUserClick: boolean
}

export function Meeting() {
  const session = useAppSelector((s) => s.session.session)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const [eventStatus, setEventStatus] = useState<'idle' | 'error'>('idle')
  const [configStatus, setConfigStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sessionConfig, setSessionConfig] = useState<SessionConfig | null>(null)
  const [sttDesired, setSttDesired] = useState(false)
  const [sttRestartNonce, setSttRestartNonce] = useState(0)

  const startWithAudioMuted = useMemo(() => session?.role === 'silent', [session?.role])
  const sttMode = useMemo(
    () => sessionConfig?.sttMode ?? 'browser',
    [sessionConfig?.sttMode],
  )
  const browserSttSupported = useMemo(
    () => typeof window !== 'undefined' && (!!window.SpeechRecognition || !!window.webkitSpeechRecognition),
    [],
  )
  const sttSupported = useMemo(
    () => (sttMode === 'server_per_client' ? isServerSttSupported() : browserSttSupported),
    [sttMode, browserSttSupported],
  )
  const sttAllowedByRole = useMemo(() => {
    if (!session || !sessionConfig) return false
    return sessionConfig.sttRoles.includes(session.role)
  }, [session, sessionConfig])
  const sttEnabledByConfig = useMemo(() => {
    if (!sessionConfig) return false
    return !!sessionConfig.sttEnabled
  }, [sessionConfig])
  const sttRequireUserClick = useMemo(() => {
    if (!sessionConfig) return true
    return !!sessionConfig.sttRequireUserClick
  }, [sessionConfig])

  const sttRecRef = useRef<SpeechRecognition | null>(null)
  const serverSttStopRef = useRef<(() => void) | null>(null)
  const currentUtteranceStartMsRef = useRef<number | null>(null)
  const autoStartAttemptedRef = useRef(false)
  const sttDesiredRef = useRef(false)

  useEffect(() => {
    sttDesiredRef.current = sttDesired
  }, [sttDesired])

  useEffect(() => {
    if (!session) return
    void logEvent('ui.meeting_page_loaded', {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.participantId])

  useEffect(() => {
    document.documentElement.classList.add('meeting-layout')
    return () => {
      document.documentElement.classList.remove('meeting-layout')
    }
  }, [])

  useEffect(() => {
    if (!session) return
    const roomName = session.roomName

    let cancelled = false
    async function loadConfig() {
      setConfigStatus('loading')
      try {
        const cfg = await apiJson<SessionConfig>(
          `/api/session-config?roomName=${encodeURIComponent(roomName)}`,
        )
        if (cancelled) return
        setSessionConfig(cfg)
        setConfigStatus('idle')
      } catch {
        if (cancelled) return
        setSessionConfig(null)
        setConfigStatus('error')
      }
    }

    void loadConfig()
    return () => {
      cancelled = true
    }
  }, [session?.roomName])

  async function logEvent(eventType: string, payload: Record<string, unknown>) {
    if (!session) return
    try {
      await apiJson<{ status: string }>('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          roomName: session.roomName,
          participantId: session.participantId,
          role: session.role,
          condition: session.condition,
          tsMs: Date.now(),
          eventType,
          payload,
        } satisfies LogEventRequest),
      })
      setEventStatus('idle')
    } catch {
      setEventStatus('error')
    }
  }

  async function postTranscriptSegment(body: TranscriptSegmentRequest) {
    try {
      await apiJson<{ status: string }>('/api/transcripts', {
        method: 'POST',
        body: JSON.stringify(body satisfies TranscriptSegmentRequest),
      })
    } catch {
      void logEvent('stt.post_failed', { roomName: body.roomName })
    }
  }

  // Enforce policy changes (e.g. config disables STT) and auto-start when allowed.
  useEffect(() => {
    if (!session) return
    if (!sessionConfig) return

    const policyAllowsStt = sttSupported && sttEnabledByConfig && sttAllowedByRole

    if (!policyAllowsStt && sttDesired) {
      setSttDesired(false)
      currentUtteranceStartMsRef.current = null
      try {
        sttRecRef.current?.stop()
      } catch {
        // ignore
      }
      sttRecRef.current = null
      serverSttStopRef.current?.()
      serverSttStopRef.current = null
      void logEvent('stt.disabled_by_policy', {
        sttEnabled: sttEnabledByConfig,
        roleAllowed: sttAllowedByRole,
        sttMode,
      })
      return
    }

    if (
      policyAllowsStt &&
      !sttRequireUserClick &&
      !sttDesired &&
      !autoStartAttemptedRef.current
    ) {
      autoStartAttemptedRef.current = true
      setSttDesired(true)
      void logEvent('stt.auto_enabled', { reason: 'config' })
    }
  }, [
    session,
    sessionConfig,
    sttSupported,
    sttAllowedByRole,
    sttEnabledByConfig,
    sttRequireUserClick,
    sttDesired,
    sttMode,
  ])

  useEffect(() => {
    if (!session) return
    if (sttMode !== 'browser') return

    if (!sttDesired) return
    if (!sessionConfig) return
    if (!sttSupported || !sttEnabledByConfig || !sttAllowedByRole) return

    const RecCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!RecCtor) return

    let stopped = false
    const rec = new RecCtor()
    sttRecRef.current = rec

    rec.lang = sessionConfig.sttLanguage || 'en-US'
    rec.continuous = true
    rec.interimResults = !!sessionConfig.sttSendInterim
    rec.maxAlternatives = 1

    rec.onresult = (ev) => {
      if (!session) return

      // Use arrival time as our timebase (Web Speech doesn't expose per-word timestamps).
      const nowMs = Date.now()
      if (currentUtteranceStartMsRef.current == null) currentUtteranceStartMsRef.current = nowMs

      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const result = ev.results[i]
        if (!result) continue

        // Always take the top alternative.
        const alt = result[0]
        const text = (alt?.transcript ?? '').trim()
        if (!text) continue

        if (result.isFinal) {
          const startMs = currentUtteranceStartMsRef.current ?? nowMs
          currentUtteranceStartMsRef.current = null

          void postTranscriptSegment({
            roomName: session.roomName,
            participantId: session.participantId,
            role: session.role,
            condition: session.condition,
            startMs,
            endMs: nowMs,
            isFinal: true,
            text,
            confidence: typeof alt?.confidence === 'number' ? alt.confidence : null,
          })
        }
      }
    }

    rec.onerror = (ev) => {
      const msg = (ev as SpeechRecognitionErrorEvent).error ?? 'unknown_error'
      // Browser STT emits no-speech / network during silence; harmless while listening.
      const benign = msg === 'no-speech' || msg === 'network' || msg === 'aborted'
      if (!benign) {
        void logEvent('stt.error', { error: msg })
      }
    }

    rec.onend = () => {
      sttRecRef.current = null
      currentUtteranceStartMsRef.current = null
      if (stopped) return
      if (!sttDesiredRef.current) return
      // Chrome frequently ends recognition after pauses; recreate the instance.
      setTimeout(() => {
        if (!sttDesiredRef.current) return
        setSttRestartNonce((n) => n + 1)
      }, 250)
    }

    try {
      void logEvent('stt.start_requested', {})
      rec.start()
      void logEvent('stt.started', {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start STT'
      setSttDesired(false)
      void logEvent('stt.start_failed', { message: msg })
    }

    return () => {
      stopped = true
      try {
        rec.onresult = null
        rec.onerror = null
        rec.onend = null
        rec.stop()
      } catch {
        // ignore
      }
      sttRecRef.current = null
      currentUtteranceStartMsRef.current = null
    }
  }, [session, sessionConfig, sttMode, sttSupported, sttAllowedByRole, sttEnabledByConfig, sttDesired, sttRestartNonce])

  useEffect(() => {
    if (!session) return
    if (sttMode !== 'server_per_client') return

    if (!sttDesired) return
    if (!sessionConfig) return
    if (!sttSupported || !sttEnabledByConfig || !sttAllowedByRole) return

    let stopped = false
    let restartTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleRestart = () => {
      if (stopped || !sttDesiredRef.current) return
      restartTimer = setTimeout(() => {
        if (!sttDesiredRef.current) return
        setSttRestartNonce((n) => n + 1)
      }, 250)
    }

    void (async () => {
      void logEvent('stt.start_requested', { mode: 'server_per_client' })

      try {
        const stop = await startServerStt(
          {
            roomName: session.roomName,
            participantId: session.participantId,
            role: session.role,
            condition: session.condition,
            sttLanguage: sessionConfig.sttLanguage || 'en-US',
            sttSendInterim: !!sessionConfig.sttSendInterim,
          },
          {
            onReady: () => {
              if (stopped) return
              void logEvent('stt.started', { mode: 'server_per_client' })
            },
            onError: (message) => {
              if (stopped) return
              void logEvent('stt.error', { error: message, mode: 'server_per_client' })
            },
            onClose: () => {
              serverSttStopRef.current = null
              if (stopped) return
              scheduleRestart()
            },
          },
        )

        if (stopped) {
          stop()
          return
        }

        serverSttStopRef.current = stop
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to start server STT'
        setSttDesired(false)
        void logEvent('stt.start_failed', { message: msg, mode: 'server_per_client' })
      }
    })()

    return () => {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      serverSttStopRef.current?.()
      serverSttStopRef.current = null
    }
  }, [
    session,
    sessionConfig,
    sttMode,
    sttSupported,
    sttAllowedByRole,
    sttEnabledByConfig,
    sttDesired,
    sttRestartNonce,
  ])

  if (!session) return <Navigate to="/" replace />
  if (isProxyRole(session.role)) {
    return <Navigate to={destinationForRole(session.role)} replace />
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Agentic Meeting</div>
        <div className="tag">
          {session.displayName} · {session.condition} · room <code>{session.roomName}</code>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {eventStatus === 'error' && <span className="pill warn">logging offline</span>}
          {configStatus === 'loading' && <span className="pill">config loading…</span>}
          {configStatus === 'error' && <span className="pill warn">config error</span>}
          <button
            className="button secondary"
            onClick={() => {
              dispatch(clearSession())
              navigate('/')
            }}
          >
            Leave
          </button>
        </div>
      </header>

      <main className="meeting">
        <JitsiEmbed
          roomName={session.roomName}
          displayName={session.displayName}
          startWithAudioMuted={startWithAudioMuted}
          onJitsiEvent={(name, payload) => {
            void logEvent(`jitsi.${name}`, payload)
          }}
        />
      </main>
    </div>
  )
}

