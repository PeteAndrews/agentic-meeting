export type VoiceOutputMode = 'generic_tts' | 'cloned_voice_tts'

export type AgentProfile = {
  roomName: string
  participantId: string
  displayName?: string
  agentDisplayName?: string
  voiceOutputMode: VoiceOutputMode
  ttsVoiceGender?: 'male' | 'female' | null
  voiceSampleStored: boolean
  scenario?: string | null
  calibrationAnswers?: Record<string, string>
  droppedQuestionIndex?: number | null
  calibrationCompletedAt?: string | null
  interventionsUsed?: number
  maxInterventions?: number
  agentTriggerPhrases?: string[]
  createdAt?: string
  updatedAt?: string | null
}

export function voiceModeLabel(mode: VoiceOutputMode): string {
  if (mode === 'cloned_voice_tts') return 'cloned voice'
  return 'generic TTS'
}
