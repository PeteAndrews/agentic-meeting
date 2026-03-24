declare global {
  // Minimal Web Speech API typings (Chrome often exposes webkitSpeechRecognition).
  type SpeechRecognitionErrorEvent = Event & { error?: string; message?: string }

  interface SpeechRecognitionAlternative {
    transcript: string
    confidence: number
  }

  interface SpeechRecognitionResult {
    readonly isFinal: boolean
    readonly length: number
    item(index: number): SpeechRecognitionAlternative
    [index: number]: SpeechRecognitionAlternative
  }

  interface SpeechRecognitionResultList {
    readonly length: number
    item(index: number): SpeechRecognitionResult
    [index: number]: SpeechRecognitionResult
  }

  type SpeechRecognitionEvent = Event & { resultIndex: number; results: SpeechRecognitionResultList }

  interface SpeechRecognition extends EventTarget {
    lang: string
    continuous: boolean
    interimResults: boolean
    maxAlternatives: number
    onaudiostart: ((ev: Event) => void) | null
    onsoundstart: ((ev: Event) => void) | null
    onspeechstart: ((ev: Event) => void) | null
    onresult: ((ev: SpeechRecognitionEvent) => void) | null
    onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null
    onend: ((ev: Event) => void) | null
    start(): void
    stop(): void
    abort(): void
  }

  interface Window {
    SpeechRecognition?: new () => SpeechRecognition
    webkitSpeechRecognition?: new () => SpeechRecognition
  }
}

export {}

