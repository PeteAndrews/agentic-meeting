const AFFIRMATIVE_PATTERNS = [
  /^yes\b/,
  /^yeah\b/,
  /^yep\b/,
  /^yup\b/,
  /^sure\b/,
  /^ok\b/,
  /^okay\b/,
  /^go ahead\b/,
  /^please do\b/,
  /^do it\b/,
  /^join\b/,
  /^absolutely\b/,
  /^correct\b/,
  /^affirmative\b/,
  /^i'?m ready\b/,
  /^ready\b/,
  /^sounds good\b/,
  /^that works\b/,
  /^let'?s go\b/,
]

const NEGATIVE_PATTERNS = [
  /^no\b/,
  /^nope\b/,
  /^not yet\b/,
  /^wait\b/,
  /^hold on\b/,
  /^not ready\b/,
]

function normalizeReply(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
}

/** Lightweight yes/no detection for onboarding — no API call needed. */
export function isAffirmative(text: string): boolean {
  const normalized = normalizeReply(text)
  if (!normalized) return false
  if (NEGATIVE_PATTERNS.some((p) => p.test(normalized))) return false
  return AFFIRMATIVE_PATTERNS.some((p) => p.test(normalized))
}
