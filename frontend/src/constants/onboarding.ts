export const ONBOARDING_GREETING =
  "Hi — I'm Agent C. I'll attend this meeting on your behalf and keep you updated here in our chat."

export const ONBOARDING_INTRO_LINES = [
  'I will join the Jitsi meeting for you — you do not need to be in the call.',
  'If I need your feedback before speaking publicly, I will ask you here first.',
  'I will report during and after the meeting in this chat.',
] as const

export const JOIN_CONFIRM_QUESTION = 'Are you ready for me to join the meeting?'

export const JOIN_CONFIRM_HINT = 'Reply yes when you want me to join (e.g. yes, yeah, yep).'

export const JOIN_CONFIRM_WAIT =
  "No problem — just let me know when you're ready. Reply yes when you want me to join."

export const VOICE_SAMPLE_INTRO =
  'Before I join, I need a short voice sample so I can represent your voice during the meeting. Press Record below, then read the following statement aloud (about 10–30 seconds).'

export const VOICE_SAMPLE_SAVED =
  'Thank you — that sample is saved. I will use it to represent your voice in the meeting.'

export const VOICE_SAMPLE_PASSAGE = `I am recording this sample so Agent C can represent my voice during the meeting.
Today we will discuss timelines and trip organisations where my decisions that affect the outcome.
I will speak clearly and at a natural pace, as I would in a normal conversation with colleagues.
Please capture the full range of my voice from beginning to end.`

export const JOINING_MESSAGE = 'Joining the meeting now…'
export const JOINED_MESSAGE = "I'm in the meeting. I'll message you here when I need your input."
export const JOIN_FAILED_MESSAGE =
  "I couldn't join the meeting automatically. Use Retry below and I'll try again."

export const MIN_RECORD_SECONDS = 8
