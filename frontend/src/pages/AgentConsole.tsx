import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { AgentChatPanel } from '../components/AgentChatPanel'
import { apiJson } from '../api/http'
import { destinationForRole, isProxyRole } from '../routing/roleRoutes'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { clearSession } from '../store/sessionSlice'
import { type AgentProfile, voiceModeLabel } from '../types/agent'

export function AgentConsole() {
  const session = useAppSelector((s) => s.session.session)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [leaving, setLeaving] = useState(false)

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
    const activeSession = session

    let cancelled = false
    async function loadProfile() {
      setProfileLoading(true)
      try {
        const query = new URLSearchParams({
          roomName: activeSession.roomName,
          participantId: activeSession.participantId,
        })
        if (activeSession.voiceOutputMode) {
          query.set('voiceOutputMode', activeSession.voiceOutputMode)
        }
        if (activeSession.scenario) {
          query.set('scenario', activeSession.scenario)
        }
        if (activeSession.calibrationDropQuestionIndex != null) {
          query.set('calibrationDropQuestionIndex', String(activeSession.calibrationDropQuestionIndex))
        }
        if (activeSession.maxInterventions != null) {
          query.set('maxInterventions', String(activeSession.maxInterventions))
        }
        if (activeSession.agentTriggerPhrases?.length) {
          query.set('agentTriggerPhrases', activeSession.agentTriggerPhrases.join(','))
        }
        if (activeSession.agentDisplayName) {
          query.set('agentDisplayName', activeSession.agentDisplayName)
        }
        if (activeSession.ttsVoiceGender) {
          query.set('ttsVoiceGender', activeSession.ttsVoiceGender)
        }
        const p = await apiJson<AgentProfile>(`/api/agent-profile?${query.toString()}`)
        if (!cancelled) {
          setProfile(p)
        }
      } catch {
        if (!cancelled) setProfile(null)
      } finally {
        if (!cancelled) setProfileLoading(false)
      }
    }
    void loadProfile()
    return () => {
      cancelled = true
    }
  }, [session?.participantId, session?.roomName, session?.role, session?.voiceOutputMode])

  async function handleLeave() {
    if (!session || leaving) return
    setLeaving(true)
    try {
      if (profile?.calibrationCompletedAt) {
        await apiJson('/api/agent/leave', {
          method: 'POST',
          body: JSON.stringify({ roomName: session.roomName }),
        })
      }
    } catch {
      // still leave the console even if bot leave fails
    } finally {
      dispatch(clearSession())
      navigate('/')
    }
  }

  if (!session) {
    return <Navigate to="/" replace />
  }

  if (!isProxyRole(session.role)) {
    return <Navigate to={destinationForRole(session.role)} replace />
  }

  const assignedMode = session.voiceOutputMode ?? profile?.voiceOutputMode ?? 'generic_tts'

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Agentic Meeting</div>
        <div className="tag">
          {session.displayName} · Agent Console · room <code>{session.roomName}</code>
          <span className="pill" style={{ marginLeft: 8 }}>
            Voice: {voiceModeLabel(assignedMode)}
          </span>
          {session.scenario && (
            <span className="pill" style={{ marginLeft: 8 }}>
              Scenario: {session.scenario}
            </span>
          )}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <button className="button secondary" disabled={leaving} onClick={() => void handleLeave()}>
            {leaving ? 'Leaving…' : 'Leave'}
          </button>
        </div>
      </header>

      <main className="card agentConsoleMain">
        <h1>Agent Console</h1>
        <p className="muted">
          Chat with <strong>{session?.agentDisplayName ?? 'Echo'}</strong>, who attends the meeting on your behalf.
        </p>

        {profileLoading && <p className="muted">Loading chat…</p>}

        {!profileLoading && session && (
          <AgentChatPanel
            session={session}
            initialProfile={profile}
            onProfileChange={setProfile}
          />
        )}
      </main>
    </div>
  )
}
