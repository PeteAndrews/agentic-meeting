export function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs)
}

export function randomTypingLabel(displayName = 'Echo'): string {
  return `${displayName} is thinking…`
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
