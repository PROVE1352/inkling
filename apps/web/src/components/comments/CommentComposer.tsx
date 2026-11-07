import { useRef, useState } from 'react'
import type { MemberDTO } from '@inkling/shared'
import { isMod } from '../../lib/platform'
import { useT } from '../../i18n'

// Comment input — with @mention autocomplete.
// Detects an `@token` right before the caret and shows member candidates; picking one inserts
// `@name ` and records the userId. On submit only mentions whose `@name` is still in the body are
// sent as mentionUserIds.
export function CommentComposer({
  members,
  placeholder,
  submitLabel,
  autoFocus,
  initialValue,
  busy,
  onSubmit,
  onCancel,
}: {
  members: MemberDTO[]
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  initialValue?: string
  busy?: boolean
  onSubmit: (body: string, mentionUserIds: string[]) => void
  onCancel?: () => void
}) {
  const t = useT()
  const [value, setValue] = useState(initialValue ?? '')
  // userId → name token at insertion time. Only those still in the body are sent.
  const mentionsRef = useRef<Map<string, string>>(new Map())
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<{ text: string; at: number; caret: number } | null>(
    null,
  )

  const detect = (val: string, caret: number) => {
    const upto = val.slice(0, caret)
    const m = /(?:^|\s)@([^\s@]*)$/.exec(upto)
    if (m) {
      setQuery({ text: m[1], at: caret - m[1].length - 1, caret })
    } else {
      setQuery(null)
    }
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    detect(e.target.value, e.target.selectionStart ?? e.target.value.length)
  }

  const pickMember = (m: MemberDTO) => {
    if (!query) return
    const before = value.slice(0, query.at)
    const after = value.slice(query.caret)
    const next = `${before}@${m.name} ${after}`
    mentionsRef.current.set(m.id, m.name)
    setValue(next)
    setQuery(null)
    // Put the caret after the insertion
    const pos = before.length + m.name.length + 2
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    })
  }

  const submit = () => {
    const body = value.trim()
    if (!body || busy) return
    const ids: string[] = []
    mentionsRef.current.forEach((name, id) => {
      if (body.includes(`@${name}`)) ids.push(id)
    })
    onSubmit(body, ids)
    setValue('')
    mentionsRef.current.clear()
    setQuery(null)
  }

  const suggestions =
    query === null
      ? []
      : members
          .filter((m) => {
            const q = query.text.toLowerCase()
            return (
              !q ||
              m.name.toLowerCase().includes(q) ||
              m.email.toLowerCase().includes(q)
            )
          })
          .slice(0, 6)

  return (
    <div className="relative flex flex-col gap-1.5">
      <textarea
        ref={taRef}
        value={value}
        autoFocus={autoFocus}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (query) {
              e.preventDefault()
              setQuery(null)
            } else {
              onCancel?.()
            }
          } else if (e.key === 'Enter' && isMod(e)) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        rows={2}
        className="w-full resize-y rounded border border-line bg-transparent px-2 py-1.5 text-xs text-ink placeholder:text-sub/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />

      {suggestions.length > 0 && (
        <div className="nd-pop absolute left-0 right-0 top-full z-30 mt-0.5 overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
          {suggestions.map((m) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                pickMember(m)
              }}
              className="flex w-full flex-col px-2.5 py-1 text-left hover:bg-hover"
            >
              <span className="truncate text-xs text-ink">{m.name}</span>
              <span className="truncate text-[11px] text-sub">{m.email}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim() || busy}
          className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
