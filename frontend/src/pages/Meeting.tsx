import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { apiJson } from '../api/http'
import { JitsiEmbed } from '../components/JitsiEmbed'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { clearSession } from '../store/sessionSlice'

type LogEventRequest = {
  roomName: string
  participantId: string
  role: 'moderator' | 'active' | 'silent' | 'agent'
  condition: 'HH' | 'HA'
  tsMs: number
  eventType: string
  payload: Record<string, unknown>
}

type TranscriptSegmentRequest = {
  roomName: string
  participantId: string
  role: 'moderator' | 'active' | 'silent' | 'agent'
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
  sttRoles: Array<'moderator' | 'active' | 'silent' | 'agent'>
  sttLanguage: string
  sttSendInterim: boolean
  sttRequireUserClick: boolean
}

export function Meeting() {
  const session = useAppSelector((s) => s.session.session)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const [eventStatus, setEventStatus] = useState<'idle' | 'error'>('idle')
  const [sttPostStatus, setSttPostStatus] = useState<'idle' | 'error'>('idle')
  const [sttRunState, setSttRunState] = useState<'off' | 'starting' | 'listening'>('off')
  const [sttLastError, setSttLastError] = useState<string | null>(null)
  const [configStatus, setConfigStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sessionConfig, setSessionConfig] = useState<SessionConfig | null>(null)
  const [sttDesired, setSttDesired] = useState(false)

  const startWithAudioMuted = useMemo(() => session?.role === 'silent', [session?.role])
  const sttSupported = useMemo(
    () => typeof window !== 'undefined' && (!!window.SpeechRecognition || !!window.webkitSpeechRecognition),
    [],
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
      setSttPostStatus('idle')
    } catch {
      setSttPostStatus('error')
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
      setSttRunState('off')
      void logEvent('stt.disabled_by_policy', {
        sttEnabled: sttEnabledByConfig,
        roleAllowed: sttAllowedByRole,
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
      setSttRunState('starting')
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
  ])

  useEffect(() => {
    if (!session) return

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
      setSttLastError(msg)
      void logEvent('stt.error', { error: msg })
    }

    rec.onend = () => {
      sttRecRef.current = null
      currentUtteranceStartMsRef.current = null
      if (stopped) return
      if (!sttDesiredRef.current) return
      // Chrome frequently ends recognition after pauses; auto-restart while enabled.
      setTimeout(() => {
        if (!sttDesiredRef.current) return
        try {
          setSttRunState('starting')
          rec.start()
        } catch {
          // ignore start races
        }
      }, 250)
    }

    try {
      setSttLastError(null)
      setSttRunState('starting')
      void logEvent('stt.start_requested', {})
      rec.start()
      setSttRunState('listening')
      void logEvent('stt.started', {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start STT'
      setSttLastError(msg)
      setSttRunState('off')
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
  }, [session, sessionConfig, sttSupported, sttAllowedByRole, sttEnabledByConfig, sttDesired])

  function toggleStt() {
    if (!session) return

    if (!sttSupported) {
      void logEvent('stt.unsupported', { ua: navigator.userAgent })
      return
    }
    if (!sessionConfig) {
      void logEvent('stt.config_missing', {})
      return
    }
    if (!sttEnabledByConfig) {
      void logEvent('stt.disabled_by_config', {})
      return
    }
    if (!sttAllowedByRole) {
      void logEvent('stt.disallowed_by_role', { role: session.role })
      return
    }

    if (sttDesiredRef.current) {
      currentUtteranceStartMsRef.current = null
      try {
        sttRecRef.current?.stop()
      } catch {
        // ignore
      }
      sttRecRef.current = null
      setSttRunState('off')
      setSttDesired(false)
      void logEvent('stt.stopped', {})
    } else {
      autoStartAttemptedRef.current = true
      setSttDesired(true)
      // The effect above will create and start recognition.
      void logEvent('stt.enabled', {})
      setSttRunState('starting')
    }
  }

  if (!session) return <Navigate to="/" replace />

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
          {sessionConfig && sttEnabledByConfig ? (
            <>
              {!sttSupported && <span className="pill warn">stt unsupported</span>}
              {sttSupported && sttAllowedByRole && (
                <span className="pill">
                  stt {sttRunState === 'listening' ? 'on' : 'off'}
                  {sttRunState === 'starting' ? '…' : ''}
                </span>
              )}
              {sttPostStatus === 'error' && <span className="pill warn">transcripts offline</span>}
              {sttAllowedByRole ? (
                <button
                  className="button secondary"
                  onClick={toggleStt}
                  disabled={!sttSupported || sttRunState === 'starting'}
                  title={sttLastError ?? undefined}
                >
                  {sttRunState === 'listening' ? 'Stop STT' : sttRequireUserClick ? 'Start STT' : 'STT'}
                </button>
              ) : (
                <span className="pill">stt disabled for role</span>
              )}
            </>
          ) : (
            sessionConfig && <span className="pill">stt disabled by config</span>
          )}
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

