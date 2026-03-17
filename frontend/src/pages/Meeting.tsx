import { useEffect, useMemo, useState } from 'react'
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

export function Meeting() {
  const session = useAppSelector((s) => s.session.session)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const [eventStatus, setEventStatus] = useState<'idle' | 'error'>('idle')

  const startWithAudioMuted = useMemo(() => session?.role === 'silent', [session?.role])

  useEffect(() => {
    if (!session) return
    void logEvent('ui.meeting_page_loaded', {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.participantId])

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

