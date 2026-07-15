import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { apiJson } from '../api/http'
import { destinationForRole, isProxyRole } from '../routing/roleRoutes'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { clearSession, setSession, type Session } from '../store/sessionSlice'

type ResolveTokenRequest = {
  studyToken: string
}

export function Lobby() {
  const [searchParams] = useSearchParams()
  const initialToken = searchParams.get('token') ?? ''
  const [token, setTokenValue] = useState(initialToken)
  const [resolvedToken, setResolvedToken] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const session = useAppSelector((s) => s.session.session)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const canContinue = useMemo(
    () => !!session?.roomName && resolvedToken === token.trim(),
    [session?.roomName, resolvedToken, token],
  )

  const continueLabel = useMemo(() => {
    if (!session) return 'Continue'
    return isProxyRole(session.role) ? 'Open Agent Console' : 'Join meeting'
  }, [session])

  async function resolve() {
    setStatus('loading')
    setError(null)
    try {
      const data = await apiJson<Session>('/api/resolve-token', {
        method: 'POST',
        body: JSON.stringify({ studyToken: token } satisfies ResolveTokenRequest),
      })
      dispatch(setSession(data))
      setResolvedToken(token.trim())
      setStatus('idle')
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Unknown error')
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Agentic Meeting</div>
        <div className="tag">Lobby → role routing</div>
      </header>

      <main className="card">
        <h1>Lobby</h1>
        <p className="muted">
          Paste your study token (or use <code>?token=...</code> in the URL) to get your role and room
          assignment. After changing the token, click <strong>Resolve token</strong> before continuing.
        </p>

        <div className="row">
          <label className="label" htmlFor="token">
            Study token
          </label>
          <input
            id="token"
            className="input"
            value={token}
            onChange={(e) => {
              const nextToken = e.target.value
              setTokenValue(nextToken)
              if (resolvedToken && nextToken.trim() !== resolvedToken) {
                dispatch(clearSession())
                setResolvedToken(null)
              }
            }}
            placeholder="e.g., pilot-trip-C"
            autoComplete="off"
          />
        </div>

        <div className="actions">
          <button className="button" onClick={resolve} disabled={!token || status === 'loading'}>
            {status === 'loading' ? 'Resolving…' : 'Resolve token'}
          </button>
          <button
            className="button secondary"
            onClick={() => {
              if (!session) return
              navigate(destinationForRole(session.role))
            }}
            disabled={!canContinue}
          >
            {continueLabel}
          </button>
        </div>

        {status === 'error' && (
          <div className="error">
            <strong>Resolve failed.</strong> {error}
            <div className="muted" style={{ marginTop: 8 }}>
              Tip: for local dev you can set <code>ALLOW_TOKEN_AUTO_CREATE=true</code> on the backend.
            </div>
          </div>
        )}

        {session && (
          <section className="summary">
            <h2>Assignment</h2>
            <div className="kv">
              <div className="k">participantId</div>
              <div className="v">{session.participantId}</div>
              <div className="k">role</div>
              <div className="v">{session.role}</div>
              <div className="k">condition</div>
              <div className="v">{session.condition}</div>
              <div className="k">roomName</div>
              <div className="v">{session.roomName}</div>
              <div className="k">displayName</div>
              <div className="v">{session.displayName}</div>
              {session.voiceOutputMode && (
                <>
                  <div className="k">voiceOutputMode</div>
                  <div className="v">{session.voiceOutputMode}</div>
                </>
              )}
              {session.scenario && (
                <>
                  <div className="k">scenario</div>
                  <div className="v">{session.scenario}</div>
                </>
              )}
              {session.calibrationDropQuestionIndex != null && (
                <>
                  <div className="k">calibrationDropQuestionIndex</div>
                  <div className="v">{session.calibrationDropQuestionIndex}</div>
                </>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

