const TYPING_LABELS = [
  'Agent C is typing…',
  'Agent C is writing…',
  'Agent C is thinking…',
] as const

export function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs)
}

export function randomTypingLabel(): string {
  return TYPING_LABELS[Math.floor(Math.random() * TYPING_LABELS.length)] ?? TYPING_LABELS[0]
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
