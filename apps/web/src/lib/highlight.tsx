import type { ReactNode } from 'react'

// Escape regex metacharacters — queries can contain #, -, / and so on (tag search, …).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Builds a node array with case-insensitive matches of query wrapped in <mark> (accent background,
// dark-mode aware). Returns the original string when query is empty or nothing matches.
export function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const re = new RegExp(escapeRegExp(q), 'gi')
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <mark
        key={key++}
        className="rounded-[2px] bg-accent-soft px-0.5 text-accent"
      >
        {m[0]}
      </mark>,
    )
    last = m.index + m[0].length
    // Guard against an infinite loop on an empty match (shouldn't happen, e.g. whitespace-only query, but be defensive)
    if (m[0].length === 0) re.lastIndex++
  }
  if (parts.length === 0) return text
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
