import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useMe } from '../api'
import { XIcon } from '../components/Icons'
import { useT } from '../i18n'
import { useAdminStatus, type StatusItem } from './api'
import { freshProblems, markShown, readSeen, writeSeen } from './seen'
import { problemText } from './text'

// One-line server status banner for admins (docs/adr/1230-*, 1233-*). Mounted at the top of the
// app shell (AppLayout). All clear → renders nothing. Warnings/problems → one line with the first
// problem, a count and a link to Admin; it shows the same problem at most once a day and can be
// closed. Not shown on the admin page itself, which has the full cards.
export function AdminStatusBanner() {
  const tr = useT()
  const me = useMe()
  const { wsId } = useParams()
  const loc = useLocation()
  const isAdmin = me.data?.isAdmin ?? false
  const q = useAdminStatus(isAdmin)
  const onAdmin = /\/admin\/?$/.test(loc.pathname)
  const [shown, setShown] = useState<StatusItem[] | null>(null)
  const decided = useRef<string | null>(null)

  useEffect(() => {
    const data = q.data
    const userId = me.data?.id
    if (!data || !userId) return
    const fp = data.issues.map((i) => `${i.key}:${i.level}`).join('|')
    if (onAdmin) {
      // the admin page shows every problem on its cards: that counts as shown
      if (data.issues.length) writeSeen(userId, markShown(data.issues, readSeen(userId), Date.now()))
      decided.current = fp
      setShown(null)
      return
    }
    // decide once per set of problems (a ref, so StrictMode's second effect run does not re-decide)
    if (decided.current === fp) return
    decided.current = fp
    if (data.issues.length === 0) {
      setShown(null)
      return
    }
    const now = Date.now()
    const seen = readSeen(userId)
    if (freshProblems(data.issues, seen, now).length === 0) {
      setShown(null)
      return
    }
    writeSeen(userId, markShown(data.issues, seen, now))
    setShown(data.issues)
  }, [q.data, me.data?.id, onAdmin])

  if (!isAdmin || onAdmin || !shown || shown.length === 0) return null
  const first = shown[0]
  const error = shown.some((i) => i.level === 'error')
  const text =
    shown.length > 1
      ? tr('adminStatus.banner.more', { problem: problemText(first), count: shown.length - 1 })
      : tr('adminStatus.banner.one', { problem: problemText(first) })

  return (
    <div
      role="status"
      data-testid="admin-status-banner"
      className={`flex shrink-0 items-center gap-2 border-b py-1.5 pl-4 pr-14 text-xs text-ink ${
        error ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${error ? 'bg-red-500' : 'bg-amber-500'}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={shown.map(problemText).join('\n')}>
        {text}
      </span>
      <Link
        to={wsId ? `/w/${wsId}/admin` : '/'}
        className="shrink-0 rounded-md px-2 py-0.5 text-accent transition-colors duration-150 hover:bg-hover"
      >
        {tr('adminStatus.banner.details')}
      </Link>
      <button
        type="button"
        onClick={() => setShown(null)}
        aria-label={tr('adminStatus.banner.dismiss')}
        title={tr('adminStatus.banner.dismiss')}
        className="shrink-0 rounded-md p-0.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <XIcon size={14} />
      </button>
    </div>
  )
}
