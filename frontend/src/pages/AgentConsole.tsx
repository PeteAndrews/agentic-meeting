import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { apiJson } from '../api/http'
import { destinationForRole, isProxyRole } from '../routing/roleRoutes'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { clearSession } from '../store/sessionSlice'

type AgentStatus = {
  connected: boolean
  roomName: string | null
  displayName: string | null
  phase: string
  mode: string
}

export function AgentConsole() {
  const session = useAppSelector((s) => s.session.session)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

  useEffect(() => {
    if (!session || !isProxyRole(session.role)) return

    void apiJson<{ status: string }>('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        roomName: session.roomName,
        participantId: session.participantId,
        role: session.role,
        condition: session.condition,
        tsMs: Date.now(),
        eventType: 'ui.agent_console_loaded',
        payload: {},
      }),
    }).catch(() => {
      // non-blocking
    })
  }, [session?.participantId, session?.role, session?.roomName, session?.condition])

  useEffect(() => {
    if (!session || !isProxyRole(session.role)) return

    let cancelled = false
    async function loadAgentStatus() {
      try {
        const status = await apiJson<AgentStatus>('/api/agent/status')
        if (!cancelled) {
          setAgentStatus(status)
          setStatusError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setAgentStatus(null)
          setStatusError(e instanceof Error ? e.message : 'Could not load agent status')
        }
      }
    }

    void loadAgentStatus()
    const interval = setInterval(() => void loadAgentStatus(), 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [session?.participantId, session?.role])

  if (!session) {
    return <Navigate to="/" replace />
  }

  if (!isProxyRole(session.role)) {
    return <Navigate to={destinationForRole(session.role)} replace />
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Agentic Meeting</div>
        <div className="tag">
          {session.displayName} · Agent Console · room <code>{session.roomName}</code>
        </div>
        <div style={{ marginLeft: 'auto' }}>
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

      <main className="card">
        <h1>Agent Console</h1>
        <p className="muted">
          You are <strong>Person C</strong> in the HA condition. You do not join the Jitsi meeting directly.
          Instead, you brief and steer <strong>Agent C</strong>, who attends the meeting on your behalf.
        </p>

        <section className="summary" style={{ marginTop: 20 }}>
          <h2>Session</h2>
          <div className="kv">
            <div className="k">participantId</div>
            <div className="v">{session.participantId}</div>
            <div className="k">role</div>
            <div className="v">{session.role}</div>
            <div className="k">condition</div>
            <div className="v">{session.condition}</div>
            <div className="k">roomName</div>
            <div className="v">{session.roomName}</div>
          </div>
        </section>

        <section className="summary" style={{ marginTop: 20 }}>
          <h2>Agent C status</h2>
          {statusError && <p className="error">{statusError}</p>}
          {agentStatus ? (
            <div className="kv">
              <div className="k">connected</div>
              <div className="v">{agentStatus.connected ? 'yes' : 'no'}</div>
              <div className="k">roomName</div>
              <div className="v">{agentStatus.roomName ?? '—'}</div>
              <div className="k">displayName</div>
              <div className="v">{agentStatus.displayName ?? '—'}</div>
              <div className="k">phase</div>
              <div className="v">{agentStatus.phase}</div>
            </div>
          ) : (
            !statusError && <p className="muted">Loading agent status…</p>
          )}
          <p className="muted" style={{ marginTop: 12 }}>
            Agent join is still manual in this phase: a researcher calls{' '}
            <code>POST /api/agent/join</code> for <code>{session.roomName}</code> before the meeting.
          </p>
        </section>

        <section className="summary" style={{ marginTop: 20 }}>
          <h2>Coming in Phase 6B</h2>
          <p className="muted">
            Conversational calibration (goals, boundaries, voice sample) and live approve/edit prompts during the
            meeting will appear here.
          </p>
        </section>
      </main>
    </div>
  )
}
