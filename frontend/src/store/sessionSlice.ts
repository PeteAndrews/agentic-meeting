import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type Condition = 'HH' | 'HA'
export type Role = 'moderator' | 'active' | 'silent' | 'proxy' | 'agent'

export type VoiceOutputMode = 'generic_tts' | 'cloned_voice_tts'

export type StudyScenario =
  | 'weekend_trip'
  | 'birthday_party'
  | 'team_building_seminar'

export type Session = {
  participantId: string
  role: Role
  condition: Condition
  roomName: string
  displayName: string
  voiceOutputMode?: VoiceOutputMode
  scenario?: StudyScenario | string
  calibrationDropQuestionIndex?: number | null
  maxInterventions?: number
}

type SessionState = {
  session: Session | null
}

const initialState: SessionState = {
  session: null,
}

const slice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    setSession(state, action: PayloadAction<Session>) {
      state.session = action.payload
    },
    clearSession(state) {
      state.session = null
    },
  },
})

export const { setSession, clearSession } = slice.actions
export const sessionReducer = slice.reducer

