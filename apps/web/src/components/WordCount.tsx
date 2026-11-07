import { useEffect, useState } from 'react'
import type { InklingEditor } from './CollabEditor'
import { useT } from '../i18n'

type Counts = { words: number; chars: number }

// Extract plain text from the ProseMirror doc in one pass and count it (newline between blocks, space for atom nodes).
// Much cheaper than editor.document (block JSON conversion).
function count(editor: InklingEditor): Counts {
  const doc = editor.prosemirrorState.doc
  const text = doc.textBetween(0, doc.content.size, '\n', ' ')
  const trimmed = text.trim()
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    chars: text.replace(/\n/g, '').length,
  }
}

// Status line at the document's bottom right — word / character count (setting "Show word count").
// Not counted on every keystroke: onChange is debounced by 1 s so we count once after typing stops (saves memory/CPU).
export function WordCount({ editor }: { editor: InklingEditor }) {
  const tr = useT()
  const [counts, setCounts] = useState<Counts | null>(null)

  useEffect(() => {
    let t: number | undefined
    const run = () => {
      try {
        setCounts(count(editor))
      } catch {
        // e.g. right after the editor is destroyed — count again on the next change
      }
    }
    // Defer the first count too, until sync is roughly done (avoids repeated counting during initial load)
    t = window.setTimeout(run, 1000)
    const unsub = editor.onChange(() => {
      window.clearTimeout(t)
      t = window.setTimeout(run, 1000)
    })
    return () => {
      window.clearTimeout(t)
      unsub?.()
    }
  }, [editor])

  if (!counts) return null
  return (
    <div
      data-word-count
      className="pointer-events-none absolute bottom-2 right-4 z-10 select-none rounded-md bg-app/80 px-2 py-0.5 text-[11px] tabular-nums text-sub backdrop-blur-sm"
    >
      {tr('wordCount.words', { count: counts.words })} · {tr('wordCount.chars', { count: counts.chars })}
    </div>
  )
}
