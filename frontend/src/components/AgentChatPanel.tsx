import { useCallback, useEffect, useRef, useState } from 'react'

import { apiJson } from '../api/http'
import {
  JOIN_CONFIRM_HINT,
  JOIN_CONFIRM_QUESTION,
  JOIN_CONFIRM_WAIT,
  JOIN_FAILED_MESSAGE,
  JOINED_MESSAGE,
  JOINING_MESSAGE,
  MIN_RECORD_SECONDS,
  ONBOARDING_GREETING,
  ONBOARDING_INTRO_LINES,
  VOICE_SAMPLE_INTRO,
  VOICE_SAMPLE_PASSAGE,
  VOICE_SAMPLE_SAVED,
} from '../constants/onboarding'
import type { Session, VoiceOutputMode } from '../store/sessionSlice'
import { isAffirmative } from '../utils/chatIntent'
import { randomBetween, randomTypingLabel, wait } from '../utils/chatTiming'

type AgentProfile = {
  roomName: string
  participantId: string
  voiceOutputMode: VoiceOutputMode
  voiceSampleStored: boolean
  calibrationCompletedAt: string | null
  updatedAt: string | null
}

type AgentStatus = {
  connected: boolean
  roomName: string | null
  displayName: string | null
  phase: string
  mode: string
}

type CompleteResponse = {
  profile: AgentProfile
  agentJoinOk: boolean
  agentJoinError: string | null
}

type ChatLine = {
  id: string
  role: 'agent' | 'user'
  text: string
  variant?: 'passage'
}

type OnboardingStep = 'voice' | 'awaiting_join_confirm' | 'active'

type Props = {
  session: Session
  initialProfile: AgentProfile | null
  onProfileChange: (profile: AgentProfile) => void
}

function voiceModeLabel(mode: VoiceOutputMode): string {
  return mode === 'cloned_voice_tts' ? 'your voice sample' : 'OpenAI TTS'
}

function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="chatAgent">
      <div className="chatBubble chatTyping">
        <span className="typingDots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        {label}
      </div>
    </div>
  )
}

export function AgentChatPanel({ session, initialProfile, onProfileChange }: Props) {
  const voiceMode = session.voiceOutputMode ?? initialProfile?.voiceOutputMode ?? 'generic_tts'
  const isCloneArm = voiceMode === 'cloned_voice_tts'
  const [profile, setProfile] = useState<AgentProfile | null>(initialProfile)
  const [lines, setLines] = useState<ChatLine[]>([])
  const [step, setStep] = useState<OnboardingStep>('awaiting_join_confirm')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joinBusy, setJoinBusy] = useState(false)
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [typingIndicator, setTypingIndicator] = useState<string | null>(null)
  const [introPlaying, setIntroPlaying] = useState(false)

  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const autoJoinAttemptedRef = useRef(false)
  const onboardingInitRef = useRef(false)
  const sequenceCancelRef = useRef(false)

  const pushAgent = useCallback((text: string, variant?: 'passage') => {
    setLines((prev) => [
      ...prev,
      {
        id: `a-${Date.now()}-${prev.length}`,
        role: 'agent',
        text,
        ...(variant ? { variant } : {}),
      },
    ])
  }, [])

  const pushUser = useCallback((text: string) => {
    setLines((prev) => [...prev, { id: `u-${Date.now()}-${prev.length}`, role: 'user', text }])
  }, [])

  const showAgentMessage = useCallback(
    async (text: string, variant?: 'passage') => {
      if (sequenceCancelRef.current) return
      setTypingIndicator(randomTypingLabel())
      await wait(randomBetween(700, 1800))
      if (sequenceCancelRef.current) return
      setTypingIndicator(null)
      pushAgent(text, variant)
      await wait(randomBetween(350, 850))
    },
    [pushAgent],
  )

  const playIntroSequence = useCallback(async () => {
    setIntroPlaying(true)
    await showAgentMessage(ONBOARDING_GREETING)
    for (const line of ONBOARDING_INTRO_LINES) {
      await showAgentMessage(line)
    }
    setIntroPlaying(false)
  }, [showAgentMessage])

  const presentVoiceSampleInChat = useCallback(async () => {
    await showAgentMessage(VOICE_SAMPLE_INTRO)
    await showAgentMessage(VOICE_SAMPLE_PASSAGE, 'passage')
    setStep('voice')
  }, [showAgentMessage])

  const askJoinConfirm = useCallback(async () => {
    await showAgentMessage(JOIN_CONFIRM_QUESTION)
    await showAgentMessage(JOIN_CONFIRM_HINT)
    setStep('awaiting_join_confirm')
  }, [showAgentMessage])

  const scrollChat = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollChat()
  }, [lines, typingIndicator, scrollChat])

  useEffect(() => {
    setProfile(initialProfile)
  }, [initialProfile])

  const loadAgentStatus = useCallback(async () => {
    try {
      const status = await apiJson<AgentStatus>('/api/agent/status')
      setAgentStatus(status)
      return status
    } catch {
      setAgentStatus(null)
      return null
    }
  }, [])

  const ensureAgentJoined = useCallback(
    async (reason: 'returning' | 'onboarding') => {
      setJoinBusy(true)
      setJoinError(null)
      try {
        await apiJson('/api/agent/join', {
          method: 'POST',
          body: JSON.stringify({ roomName: session.roomName, displayName: 'Agent C' }),
        })
        await loadAgentStatus()
        if (reason === 'returning') {
          pushAgent(JOINED_MESSAGE)
        }
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Agent join failed'
        setJoinError(message)
        if (reason === 'returning') {
          pushAgent(`${JOIN_FAILED_MESSAGE} (${message})`)
        }
        return false
      } finally {
        setJoinBusy(false)
      }
    },
    [loadAgentStatus, pushAgent, session.roomName],
  )

  useEffect(() => {
    if (onboardingInitRef.current) return
    onboardingInitRef.current = true
    sequenceCancelRef.current = false
    let cancelled = false

    async function init() {
      setLoadError(null)
      try {
        const query = new URLSearchParams({
          roomName: session.roomName,
          participantId: session.participantId,
          voiceOutputMode: voiceMode,
        })
        let loaded = await apiJson<AgentProfile>(`/api/agent-profile?${query.toString()}`)
        if (cancelled) return

        if (loaded.voiceOutputMode !== voiceMode) {
          loaded = await apiJson<AgentProfile>('/api/agent-profile', {
            method: 'PUT',
            body: JSON.stringify({
              roomName: session.roomName,
              participantId: session.participantId,
              voiceOutputMode: voiceMode,
            }),
          })
        }

        setProfile(loaded)
        onProfileChange(loaded)

        if (loaded.calibrationCompletedAt) {
          setStep('active')
          await showAgentMessage(
            `Welcome back. I'm set up to speak using ${voiceModeLabel(loaded.voiceOutputMode)}.`,
          )
          return
        }

        await playIntroSequence()
        if (cancelled || sequenceCancelRef.current) return

        if (isCloneArm && !loaded.voiceSampleStored) {
          await presentVoiceSampleInChat()
          return
        }

        if (isCloneArm && loaded.voiceSampleStored) {
          await showAgentMessage(VOICE_SAMPLE_SAVED)
        }

        await askJoinConfirm()
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load chat')
        }
      }
    }

    void init()
    return () => {
      cancelled = true
      sequenceCancelRef.current = true
      setTypingIndicator(null)
    }
  }, [
    askJoinConfirm,
    isCloneArm,
    onProfileChange,
    playIntroSequence,
    presentVoiceSampleInChat,
    session.participantId,
    session.roomName,
    showAgentMessage,
    voiceMode,
  ])

  useEffect(() => {
    if (step !== 'active' || !profile?.calibrationCompletedAt) return
    if (autoJoinAttemptedRef.current) return
    autoJoinAttemptedRef.current = true

    void (async () => {
      const status = await loadAgentStatus()
      const inRoom = status?.connected && status.roomName === session.roomName
      if (!inRoom) {
        pushAgent(JOINING_MESSAGE)
        await ensureAgentJoined('returning')
      } else {
        pushAgent("I'm already in the meeting. I'll message you here when I need your input.")
      }
    })()
  }, [
    ensureAgentJoined,
    loadAgentStatus,
    profile?.calibrationCompletedAt,
    pushAgent,
    session.roomName,
    step,
  ])

  useEffect(() => {
    if (step !== 'active' || !profile?.calibrationCompletedAt) return
    const interval = setInterval(() => void loadAgentStatus(), 15_000)
    return () => clearInterval(interval)
  }, [loadAgentStatus, profile?.calibrationCompletedAt, step])

  useEffect(() => {
    return () => {
      if (recordTimerRef.current != null) {
        window.clearInterval(recordTimerRef.current)
      }
      mediaRecorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  async function completeOnboarding() {
    setBusy(true)
    setSaveError(null)
    pushAgent(JOINING_MESSAGE)
    try {
      const result = await apiJson<CompleteResponse>('/api/agent-profile/complete', {
        method: 'POST',
        body: JSON.stringify({
          roomName: session.roomName,
          participantId: session.participantId,
        }),
      })
      setProfile(result.profile)
      onProfileChange(result.profile)
      setStep('active')
      autoJoinAttemptedRef.current = true

      if (result.agentJoinOk) {
        setJoinError(null)
        pushAgent(JOINED_MESSAGE)
        void loadAgentStatus()
      } else {
        const err = result.agentJoinError ?? 'Agent join failed'
        setJoinError(err)
        pushAgent(`${JOIN_FAILED_MESSAGE} (${err})`)
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to complete onboarding')
    } finally {
      setBusy(false)
    }
  }

  async function handleJoinConfirm() {
    if (busy || introPlaying || typingIndicator || step !== 'awaiting_join_confirm') return
    const reply = draft.trim()
    if (!reply) return

    pushUser(reply)
    setDraft('')

    if (!isAffirmative(reply)) {
      await showAgentMessage(JOIN_CONFIRM_WAIT)
      return
    }

    if (isCloneArm && !profile?.voiceSampleStored) {
      await presentVoiceSampleInChat()
      return
    }

    await completeOnboarding()
  }

  async function startRecording() {
    setSaveError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data)
      }
      mediaRecorderRef.current = recorder
      recorder.start()
      setRecording(true)
      setRecordSeconds(0)
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1)
      }, 1000)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Microphone access denied')
    }
  }

  async function stopRecordingAndUpload() {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return

    setBusy(true)
    setSaveError(null)

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      recorder.stop()
    })

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null

    if (recordTimerRef.current != null) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    setRecording(false)

    try {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      const base64 = await blobToBase64(blob)
      const updated = await apiJson<AgentProfile>('/api/agent-profile/voice-sample', {
        method: 'POST',
        body: JSON.stringify({
          roomName: session.roomName,
          participantId: session.participantId,
          voiceOutputMode: voiceMode,
          audioBase64: base64,
          mimeType: blob.type || 'audio/webm',
        }),
      })
      setProfile(updated)
      onProfileChange(updated)
      pushUser('Voice sample recorded.')
      await showAgentMessage(VOICE_SAMPLE_SAVED)
      await askJoinConfirm()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to upload voice sample')
    } finally {
      setBusy(false)
    }
  }

  async function retryJoin() {
    pushAgent(JOINING_MESSAGE)
    const ok = await ensureAgentJoined('returning')
    if (ok) {
      pushAgent(JOINED_MESSAGE)
    }
  }

  if (loadError) {
    return <p className="error">{loadError}</p>
  }

  const composerLocked = busy || introPlaying || !!typingIndicator
  const showTextComposer = step === 'awaiting_join_confirm'
  const showVoiceComposer = step === 'voice'
  const showRetry = step === 'active' && !!joinError

  return (
    <section className="agentChat">
      <div className="chatLog agentChatLog">
        {lines.map((line) => (
          <div key={line.id} className={line.role === 'agent' ? 'chatAgent' : 'chatUser'}>
            <div
              className={`chatBubble${line.variant === 'passage' ? ' chatBubblePassage' : ''}`}
            >
              {line.text}
            </div>
          </div>
        ))}
        {typingIndicator && <TypingIndicator label={typingIndicator} />}
        {step === 'active' && agentStatus && (
          <div className="chatAgent">
            <div className="chatBubble chatStatus">
              Meeting connection: {agentStatus.connected ? 'in room' : 'not connected'}
              {agentStatus.connected && agentStatus.roomName ? ` (${agentStatus.roomName})` : ''}
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {saveError && <p className="error">{saveError}</p>}

      {showTextComposer && (
        <div className="chatComposer">
          <div className="choiceRow">
            <button
              type="button"
              className="button secondary"
              disabled={composerLocked}
              onClick={() => {
                setDraft('Yes')
                void handleJoinConfirm()
              }}
            >
              Yes
            </button>
          </div>
          <textarea
            className="input chatInput"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply to Agent C…"
            disabled={composerLocked}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleJoinConfirm()
              }
            }}
          />
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={composerLocked || !draft.trim()}
              onClick={() => void handleJoinConfirm()}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {showVoiceComposer && (
        <div className="chatComposer">
          {!recording ? (
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={composerLocked}
                onClick={() => void startRecording()}
              >
                Record voice sample
              </button>
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={busy || recordSeconds < MIN_RECORD_SECONDS}
                onClick={() => void stopRecordingAndUpload()}
              >
                Stop &amp; send ({recordSeconds}s
                {recordSeconds < MIN_RECORD_SECONDS ? ` — min ${MIN_RECORD_SECONDS}s` : ''})
              </button>
            </div>
          )}
        </div>
      )}

      {showRetry && (
        <div className="chatComposer">
          <div className="actions">
            <button type="button" className="button" disabled={joinBusy} onClick={() => void retryJoin()}>
              {joinBusy ? 'Joining…' : 'Retry join'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0)
  }
  return btoa(binary)
}
