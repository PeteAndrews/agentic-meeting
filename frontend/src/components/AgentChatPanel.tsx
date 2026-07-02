import { useCallback, useEffect, useRef, useState } from 'react'

import { apiJson, formatApiError } from '../api/http'
import {
  CALIBRATION_COMPLETE,
  CALIBRATION_INTRO,
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
  scenario?: string | null
  droppedQuestionIndex?: number | null
  calibrationAnswers?: Record<string, string>
  calibrationCompletedAt: string | null
  interventionsUsed?: number
  maxInterventions?: number
  updatedAt: string | null
}

type CalibrationQuestion = {
  id: string
  text: string
  index: number
}

type CalibrationPlan = {
  scenario: string
  displayName: string
  droppedQuestionIndex: number | null
  questions: CalibrationQuestion[]
  answeredQuestionIds: string[]
  complete: boolean
}

type ScenarioDefinition = {
  id: string
  displayName: string
  voiceSamplePassage?: string | null
}

type AgentPrompt = {
  id: string
  roomName: string
  participantId: string
  kind: 'proxy_question' | 'public_draft'
  text: string
  status: 'pending_proxy' | 'pending_approval' | 'approved' | 'rejected' | 'spoken'
  interventionNumber: number
  source: string
  createdAt: string
  updatedAt: string
  triggerSegmentText?: string | null
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

type OnboardingStep =
  | 'voice'
  | 'calibration_qa'
  | 'awaiting_join_confirm'
  | 'active'

type Props = {
  session: Session
  initialProfile: AgentProfile | null
  onProfileChange: (profile: AgentProfile) => void
}

function voiceModeLabel(mode: VoiceOutputMode): string {
  return mode === 'cloned_voice_tts' ? 'your voice sample' : 'OpenAI TTS'
}

function profileQuery(session: Session, voiceMode: VoiceOutputMode): URLSearchParams {
  const query = new URLSearchParams({
    roomName: session.roomName,
    participantId: session.participantId,
    voiceOutputMode: voiceMode,
  })
  if (session.scenario) query.set('scenario', session.scenario)
  if (session.calibrationDropQuestionIndex != null) {
    query.set('calibrationDropQuestionIndex', String(session.calibrationDropQuestionIndex))
  }
  if (session.maxInterventions != null) {
    query.set('maxInterventions', String(session.maxInterventions))
  }
  if (session.agentTriggerPhrases?.length) {
    query.set('agentTriggerPhrases', session.agentTriggerPhrases.join(','))
  }
  if (session.agentDisplayName) {
    query.set('agentDisplayName', session.agentDisplayName)
  }
  if (session.ttsVoiceGender) {
    query.set('ttsVoiceGender', session.ttsVoiceGender)
  }
  return query
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
  const agentName = session.agentDisplayName ?? 'Echo'
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
  const [calibrationPlan, setCalibrationPlan] = useState<CalibrationPlan | null>(null)
  const [calibrationIndex, setCalibrationIndex] = useState(0)
  const [voicePassage, setVoicePassage] = useState(VOICE_SAMPLE_PASSAGE)
  const [prompts, setPrompts] = useState<AgentPrompt[]>([])
  const [editDraft, setEditDraft] = useState<Record<string, string>>({})

  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const autoJoinAttemptedRef = useRef(false)
  const sequenceCancelRef = useRef(false)
  const calibrationStartedRef = useRef(false)
  const seenPromptIdsRef = useRef<Set<string>>(new Set())

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
      setTypingIndicator(randomTypingLabel(agentName))
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
    await showAgentMessage(voicePassage, 'passage')
    setStep('voice')
  }, [showAgentMessage, voicePassage])

  const publishCalibrationQuestion = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      pushAgent(trimmed)
    },
    [pushAgent],
  )

  const loadCalibrationPlan = useCallback(async () => {
    const query = profileQuery(session, voiceMode)
    return apiJson<CalibrationPlan>(`/api/agent-profile/calibration-plan?${query.toString()}`)
  }, [session, voiceMode])

  const runCalibrationSequence = useCallback(
    async (plan: CalibrationPlan, force = false) => {
      if (calibrationStartedRef.current && !force) return
      calibrationStartedRef.current = true
      sequenceCancelRef.current = false
      setCalibrationPlan(plan)
      setStep('calibration_qa')
      setSaveError(null)

      await showAgentMessage(CALIBRATION_INTRO)

      const unanswered = plan.questions.filter((q) => !plan.answeredQuestionIds.includes(q.id))
      if (unanswered.length === 0 && plan.complete) {
        await showAgentMessage(CALIBRATION_COMPLETE)
        await showAgentMessage(JOIN_CONFIRM_QUESTION)
        await showAgentMessage(JOIN_CONFIRM_HINT)
        setStep('awaiting_join_confirm')
        return
      }

      setCalibrationIndex(0)
      publishCalibrationQuestion(unanswered[0]?.text ?? '')
    },
    [publishCalibrationQuestion, showAgentMessage],
  )

  const resumeIncompleteCalibration = useCallback(async () => {
    sequenceCancelRef.current = false
    const plan = await loadCalibrationPlan()
    setCalibrationPlan(plan)
    calibrationStartedRef.current = true
    const unanswered = plan.questions.filter((q) => !plan.answeredQuestionIds.includes(q.id))
    if (unanswered.length === 0) {
      if (plan.complete) {
        setStep('awaiting_join_confirm')
        return true
      }
      return false
    }
    setStep('calibration_qa')
    publishCalibrationQuestion('We still need a few calibration answers before I can join.')
    publishCalibrationQuestion(unanswered[0]?.text ?? '')
    return false
  }, [loadCalibrationPlan, publishCalibrationQuestion])

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
  }, [lines, typingIndicator, prompts, scrollChat])

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

  const loadPrompts = useCallback(async () => {
    try {
      const query = new URLSearchParams({
        roomName: session.roomName,
        participantId: session.participantId,
      })
      const result = await apiJson<{ prompts: AgentPrompt[] }>(`/api/agent/prompts?${query.toString()}`)
      setPrompts(result.prompts)

      for (const prompt of result.prompts) {
        if (seenPromptIdsRef.current.has(prompt.id)) continue
        if (prompt.status === 'pending_proxy') {
          seenPromptIdsRef.current.add(prompt.id)
          const meetingLine = prompt.triggerSegmentText
            ? `In the meeting, someone asked:\n"${prompt.triggerSegmentText}"`
            : ''
          pushAgent(
            [
              meetingLine,
              prompt.text ? `I need your input before I can respond:\n\n${prompt.text}` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          )
        }
        if (prompt.status === 'pending_approval') {
          seenPromptIdsRef.current.add(prompt.id)
          if (prompt.kind === 'public_draft') {
            const meetingLine = prompt.triggerSegmentText
              ? `Draft to speak in the meeting (re: "${prompt.triggerSegmentText}")`
              : 'Draft to speak in the meeting'
            pushAgent(`${meetingLine}:\n\n${prompt.text}`)
          }
        }
      }
    } catch {
      // ignore polling errors
    }
  }, [pushAgent, session.participantId, session.roomName])

  const ensureAgentJoined = useCallback(
    async (reason: 'returning' | 'onboarding') => {
      setJoinBusy(true)
      setJoinError(null)
      try {
        await apiJson('/api/agent/join', {
          method: 'POST',
          body: JSON.stringify({
            roomName: session.roomName,
            displayName: agentName,
          }),
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
    [loadAgentStatus, pushAgent, session.roomName, agentName],
  )

  useEffect(() => {
    let cancelled = false
    sequenceCancelRef.current = false

    async function init() {
      setLoadError(null)
      try {
        const query = profileQuery(session, voiceMode)
        let loaded = await apiJson<AgentProfile>(`/api/agent-profile?${query.toString()}`)
        if (cancelled) return

        if (loaded.voiceOutputMode !== voiceMode) {
          loaded = await apiJson<AgentProfile>('/api/agent-profile', {
            method: 'PUT',
            body: JSON.stringify({
              roomName: session.roomName,
              participantId: session.participantId,
              voiceOutputMode: voiceMode,
              scenario: session.scenario,
              droppedQuestionIndex: session.calibrationDropQuestionIndex,
              maxInterventions: session.maxInterventions,
            }),
          })
        } else if (
          session.scenario &&
          (loaded.scenario !== session.scenario ||
            loaded.droppedQuestionIndex !== session.calibrationDropQuestionIndex)
        ) {
          loaded = await apiJson<AgentProfile>('/api/agent-profile', {
            method: 'PUT',
            body: JSON.stringify({
              roomName: session.roomName,
              participantId: session.participantId,
              scenario: session.scenario,
              droppedQuestionIndex: session.calibrationDropQuestionIndex,
              maxInterventions: session.maxInterventions,
            }),
          })
        }

        const effectiveScenario = loaded.scenario ?? session.scenario

        if (effectiveScenario) {
          try {
            const scenario = await apiJson<ScenarioDefinition>(`/api/scenarios/${effectiveScenario}`)
            if (scenario.voiceSamplePassage) {
              setVoicePassage(scenario.voiceSamplePassage)
            }
          } catch {
            // optional scenario metadata
          }
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
        if (cancelled) return

        if (isCloneArm && !loaded.voiceSampleStored) {
          await presentVoiceSampleInChat()
          return
        }

        if (isCloneArm && loaded.voiceSampleStored) {
          await showAgentMessage(VOICE_SAMPLE_SAVED)
        }

        if (effectiveScenario) {
          const plan = await loadCalibrationPlan()
          await runCalibrationSequence(plan, true)
          return
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
      setTypingIndicator(null)
    }
    // Onboarding runs once when the console chat mounts for this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      sequenceCancelRef.current = true
    }
  }, [])

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
    const interval = setInterval(() => {
      void loadAgentStatus()
      void loadPrompts()
    }, 5000)
    void loadPrompts()
    return () => clearInterval(interval)
  }, [loadAgentStatus, loadPrompts, profile?.calibrationCompletedAt, step])

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

    const scenarioForSetup = profile?.scenario ?? session.scenario
    if (scenarioForSetup) {
      try {
        const plan = await loadCalibrationPlan()
        if (!plan.complete) {
          setSaveError(
            `Please answer all calibration questions first (${plan.questions.length - plan.answeredQuestionIds.length} remaining).`,
          )
          await resumeIncompleteCalibration()
          return
        }
      } catch (e) {
        setSaveError(formatApiError(e))
        return
      }
    }

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
      const message = formatApiError(e)
      setSaveError(message)
      if (scenarioForSetup) {
        await resumeIncompleteCalibration()
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleCalibrationAnswer() {
    if (busy || introPlaying || typingIndicator || step !== 'calibration_qa' || !calibrationPlan) return
    const reply = draft.trim()
    if (!reply) return

    const unanswered = calibrationPlan.questions.filter(
      (q) => !calibrationPlan.answeredQuestionIds.includes(q.id),
    )
    const current = unanswered[calibrationIndex]
    if (!current) return

    pushUser(reply)
    setDraft('')
    setBusy(true)
    setSaveError(null)

    try {
      const updated = await apiJson<AgentProfile>('/api/agent-profile/calibration-answer', {
        method: 'POST',
        body: JSON.stringify({
          roomName: session.roomName,
          participantId: session.participantId,
          questionId: current.id,
          answer: reply,
        }),
      })
      setProfile(updated)
      onProfileChange(updated)

      const nextPlan = await loadCalibrationPlan()
      setCalibrationPlan(nextPlan)
      const nextUnanswered = nextPlan.questions.filter(
        (q) => !nextPlan.answeredQuestionIds.includes(q.id),
      )

      if (nextUnanswered.length === 0 && nextPlan.complete) {
        await showAgentMessage(CALIBRATION_COMPLETE)
        await askJoinConfirm()
      } else if (nextUnanswered.length > 0) {
        setCalibrationIndex(0)
        await showAgentMessage(nextUnanswered[0]?.text ?? '')
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save calibration answer')
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

      if (session.scenario) {
        const plan = await loadCalibrationPlan()
        calibrationStartedRef.current = false
        await runCalibrationSequence(plan)
      } else {
        await askJoinConfirm()
      }
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

  async function respondToPrompt(promptId: string) {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    setSaveError(null)
    try {
      const query = new URLSearchParams({ roomName: session.roomName })
      await apiJson(`/api/agent/prompts/${promptId}/respond?${query.toString()}`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      pushUser(text)
      setDraft('')
      await loadPrompts()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to send response')
    } finally {
      setBusy(false)
    }
  }

  async function approvePrompt(promptId: string) {
    setBusy(true)
    setSaveError(null)
    try {
      const query = new URLSearchParams({ roomName: session.roomName })
      await apiJson(`/api/agent/prompts/${promptId}/approve?${query.toString()}`, { method: 'POST' })
      pushAgent('Approved — speaking in the meeting now.')
      await loadPrompts()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to approve draft')
    } finally {
      setBusy(false)
    }
  }

  async function editAndApprovePrompt(promptId: string) {
    const text = (editDraft[promptId] ?? '').trim()
    if (!text) return
    setBusy(true)
    setSaveError(null)
    try {
      const query = new URLSearchParams({ roomName: session.roomName })
      await apiJson(`/api/agent/prompts/${promptId}/edit?${query.toString()}`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      pushAgent('Edited and approved — speaking in the meeting now.')
      await loadPrompts()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to edit draft')
    } finally {
      setBusy(false)
    }
  }

  async function rejectPrompt(promptId: string) {
    setBusy(true)
    setSaveError(null)
    try {
      const query = new URLSearchParams({ roomName: session.roomName })
      await apiJson(`/api/agent/prompts/${promptId}/reject?${query.toString()}`, { method: 'POST' })
      pushAgent('Draft rejected — I will not speak that in the meeting.')
      await loadPrompts()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to reject draft')
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return <p className="error">{loadError}</p>
  }

  const composerLocked = busy || introPlaying || !!typingIndicator
  const showTextComposer = step === 'awaiting_join_confirm' || step === 'calibration_qa'
  const showVoiceComposer = step === 'voice'
  const showRetry = step === 'active' && !!joinError

  const openProxyPrompt = prompts.find(
    (p) => p.status === 'pending_proxy' && p.kind === 'proxy_question',
  )
  const openDraftPrompts = prompts.filter(
    (p) => p.status === 'pending_approval' && p.kind === 'public_draft',
  )

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

        {step === 'active' &&
          openDraftPrompts.map((prompt) => (
            <div key={prompt.id} className="calibration">
              <div className="calibrationHeader">
                <strong>Draft for meeting</strong>
                <span className="pill">{prompt.source.replace(/_/g, ' ')}</span>
              </div>
              {prompt.triggerSegmentText && (
                <p className="muted" style={{ marginBottom: 8 }}>
                  Re: "{prompt.triggerSegmentText}"
                </p>
              )}
              <div className="chatBubble">{prompt.text}</div>
              <textarea
                className="input chatInput"
                rows={3}
                value={editDraft[prompt.id] ?? prompt.text}
                onChange={(e) =>
                  setEditDraft((prev) => ({ ...prev, [prompt.id]: e.target.value }))
                }
              />
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void approvePrompt(prompt.id)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void editAndApprovePrompt(prompt.id)}
                >
                  Edit &amp; approve
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void rejectPrompt(prompt.id)}
                >
                  Reject
                </button>
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

      {step === 'active' && openProxyPrompt && (
        <div className="chatComposer calibration">
          <p className="muted">{agentName} needs your answer before responding in the meeting.</p>
          {openProxyPrompt.triggerSegmentText && (
            <div className="chatBubble" style={{ marginBottom: 12 }}>
              <strong>In the meeting:</strong>
              <div>"{openProxyPrompt.triggerSegmentText}"</div>
            </div>
          )}
          {openProxyPrompt.text && (
            <div className="chatBubble" style={{ marginBottom: 12 }}>
              <strong>{agentName} asks:</strong>
              <div>{openProxyPrompt.text}</div>
            </div>
          )}
          <textarea
            className="input chatInput"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Your answer for ${agentName}…`}
            disabled={composerLocked}
          />
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={composerLocked || !draft.trim()}
              onClick={() => void respondToPrompt(openProxyPrompt.id)}
            >
              Send to {agentName}
            </button>
          </div>
        </div>
      )}

      {showTextComposer && (
        <div className="chatComposer">
          {step === 'awaiting_join_confirm' && (
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
          )}
          <textarea
            className="input chatInput"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              step === 'calibration_qa' ? 'Type your answer…' : `Reply to ${agentName}…`
            }
            disabled={composerLocked}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (step === 'calibration_qa') {
                  void handleCalibrationAnswer()
                } else {
                  void handleJoinConfirm()
                }
              }
            }}
          />
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={composerLocked || !draft.trim()}
              onClick={() =>
                void (step === 'calibration_qa' ? handleCalibrationAnswer() : handleJoinConfirm())
              }
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
