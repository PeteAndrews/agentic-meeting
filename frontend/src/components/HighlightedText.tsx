import type { ReactNode } from 'react'

const DEFAULT_KEYWORDS = ['Echo']

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split text and wrap wake-word matches (default: Echo) in a highlight span. */
export function highlightKeywords(
  text: string,
  keywords: string[] = DEFAULT_KEYWORDS,
): ReactNode[] {
  const terms = keywords.map((k) => k.trim()).filter(Boolean)
  if (!text || terms.length === 0) {
    return [text]
  }

  const pattern = new RegExp(`\\b(${terms.map(escapeRegExp).join('|')})\\b`, 'gi')
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index
    const matched = match[0]
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start))
    }
    nodes.push(
      <strong key={`kw-${key}`} className="echoKeyword">
        {matched}
      </strong>,
    )
    key += 1
    lastIndex = start + matched.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes.length > 0 ? nodes : [text]
}

type HighlightedTextProps = {
  text: string
  keywords?: string[]
}

export function HighlightedText({ text, keywords = DEFAULT_KEYWORDS }: HighlightedTextProps) {
  return <>{highlightKeywords(text, keywords)}</>
}
