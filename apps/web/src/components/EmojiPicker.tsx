import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useT, type TKey } from '../i18n'

// Curated emoji set with no extra dependency: per-category arrays of Unicode emoji.
// `label` is an i18n key, translated at render time.
type Category = { key: string; label: TKey; emojis: string[] }

const CATEGORIES: Category[] = [
  {
    key: 'smileys',
    label: 'emoji.smileys',
    emojis: [
      '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '😉', '😊', '😍',
      '😘', '😎', '🤩', '🥳', '🤔', '🤨', '😐', '😴', '😌', '😔',
      '😢', '😭', '😤', '😠', '😱', '🤯', '😇', '🤗', '🤝', '🙏',
      '👍', '👎', '👏', '🙌', '💪', '✌️', '👋', '🫶', '🧠', '👀',
    ],
  },
  {
    key: 'objects',
    label: 'emoji.objects',
    emojis: [
      '📄', '📝', '📋', '📌', '📎', '🗂', '📁', '📂', '🗃', '🗄',
      '📚', '📖', '📕', '📗', '📘', '📙', '📓', '📔', '🔖', '🏷',
      '✏️', '🖊', '🖋', '🖌', '🖍', '📐', '📏', '✂️', '🔍', '🔎',
      '💡', '🔦', '🔒', '🔓', '🔑', '🗝', '🔨', '🛠', '⚙️', '🧰',
      '💻', '🖥', '⌨️', '🖱', '📱', '📞', '📷', '🎥', '🔋', '🔌',
      '💾', '💿', '🧾', '📊', '📈', '📉', '🗒', '📅', '📆', '⏰',
    ],
  },
  {
    key: 'symbols',
    label: 'emoji.symbols',
    emojis: [
      '⭐', '🌟', '✨', '🔥', '💥', '⚡', '❤️', '🧡', '💛', '💚',
      '💙', '💜', '🖤', '🤍', '✅', '☑️', '❌', '⚠️', '❓', '❗',
      '💬', '💭', '🔔', '🔕', '➕', '➖', '✔️', '🔗', '🎯', '🚩',
      '🏁', '🎌', '♻️', '🆕', '🆒', '🔆', '🌀', '💠', '🔺', '🔻',
    ],
  },
  {
    key: 'nature',
    label: 'emoji.nature',
    emojis: [
      '🌱', '🌿', '🍀', '🌳', '🌲', '🌵', '🌸', '🌼', '🌻', '🌹',
      '🍁', '🍂', '🌊', '🔆', '🌈', '☀️', '🌙', '⛅', '☁️', '❄️',
      '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐸', '🐢',
      '🦉', '🦅', '🐝', '🦋', '🐬', '🐳', '🦄', '🐙', '🌍', '🌏',
    ],
  },
  {
    key: 'food',
    label: 'emoji.food',
    emojis: [
      '🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍑', '🥝', '🍅',
      '🥑', '🥕', '🌽', '🍞', '🧀', '🍔', '🍟', '🍕', '🌮', '🍣',
      '🍜', '🍚', '🍙', '🍩', '🍪', '🎂', '🍰', '🍫', '🍿', '☕',
      '🍵', '🧋', '🍺', '🍷', '🥤', '🧃', '🍯', '🥗', '🍳', '🥪',
    ],
  },
  {
    key: 'activity',
    label: 'emoji.activity',
    emojis: [
      '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏓', '🎱', '🎮', '🎲',
      '🎯', '🎨', '🎬', '🎤', '🎧', '🎼', '🎸', '🎹', '🥁', '🏆',
      '🥇', '🎖', '🏅', '🚀', '✈️', '🚗', '🚄', '🚲', '⛰', '🏕',
      '🏝', '🏠', '🏢', '🏫', '🏬', '🗺', '🧭', '🎁', '🎉', '🎊',
    ],
  },
]

const ALL = CATEGORIES.flatMap((c) => c.emojis)

// Emoji popover fixed on screen relative to its anchor (the trigger button).
// Position is computed in useLayoutEffect before paint and clamped to stay on screen.
export function EmojiPicker<T extends HTMLElement>({
  anchorRef,
  onSelect,
  onRemove,
  onClose,
  hasIcon,
}: {
  anchorRef: RefObject<T | null>
  onSelect: (emoji: string) => void
  onRemove: () => void
  onClose: () => void
  hasIcon: boolean
}) {
  const tr = useT()
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [custom, setCustom] = useState('')

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = panelRef.current
    const w = el?.offsetWidth ?? 288
    const h = el?.offsetHeight ?? 360
    const rect = anchor?.getBoundingClientRect()
    const baseLeft = rect?.left ?? 8
    const baseTop = rect ? rect.bottom + 6 : 8
    const left = Math.max(8, Math.min(baseLeft, window.innerWidth - w - 8))
    const top = Math.max(8, Math.min(baseTop, window.innerHeight - h - 8))
    setPos({ left, top })
  }, [anchorRef])

  // Close on outside click / Esc. (Clicks on the anchor itself are excluded; its own toggle handles them.)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  const filtered = useMemo(() => {
    const q = custom.trim()
    if (!q) return null
    // Not a search but "type your own" — a short emoji-like string becomes the candidate as is.
    return q
  }, [custom])

  const pick = (emoji: string) => {
    onSelect(emoji)
    onClose()
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={tr('emoji.pickIcon')}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="nd-pop fixed z-[60] flex max-h-[60dvh] w-72 flex-col overflow-hidden rounded-lg border border-line bg-app shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && custom.trim()) {
              e.preventDefault()
              pick(custom.trim())
            }
          }}
          placeholder={tr('emoji.customPlaceholder')}
          className="min-w-0 flex-1 rounded border border-line bg-app px-2 py-1 text-sm text-ink placeholder:text-sub focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
        {hasIcon && (
          <button
            type="button"
            onClick={() => {
              onRemove()
              onClose()
            }}
            className="shrink-0 rounded px-2 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            {tr('common.remove')}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {filtered ? (
          <button
            type="button"
            onClick={() => pick(filtered)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-hover"
          >
            <span className="text-xl leading-none">{filtered}</span>
            <span className="text-xs text-sub">{tr('emoji.useCustom')}</span>
          </button>
        ) : (
          CATEGORIES.map((cat) => (
            <div key={cat.key} className="mb-2 last:mb-0">
              <div className="mb-1 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {tr(cat.label)}
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {cat.emojis.map((emoji, i) => (
                  <button
                    key={`${cat.key}-${i}`}
                    type="button"
                    onClick={() => pick(emoji)}
                    title={emoji}
                    className="flex h-8 w-8 items-center justify-center rounded text-lg leading-none transition-colors duration-100 hover:bg-hover"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  )
}

// Expose the curated set (for tests/debugging).
export const EMOJI_SET = ALL
