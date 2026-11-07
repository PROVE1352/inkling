import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { ApiError, usePublishNotion } from '../api'
import { Modal } from './Modal'
import { Spinner } from './Spinner'
import { useT } from '../i18n'

const STORAGE_KEY = 'inkling:notionParent'

/** Fill `{name}` placeholders of a translated string with React nodes (for bold/code inside a sentence). */
function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    return <Fragment key={i}>{name && name in nodes ? nodes[name] : part}</Fragment>
  })
}

export function NotionPublishModal({
  open,
  onClose,
  pageId,
  pageTitle,
}: {
  open: boolean
  onClose: () => void
  pageId: string
  pageTitle: string
}) {
  const t = useT()
  const [parentUrl, setParentUrl] = useState('')
  const publish = usePublishNotion(pageId)

  // On open: restore the previous target URL + clear the previous result
  useEffect(() => {
    if (open) {
      setParentUrl(localStorage.getItem(STORAGE_KEY) ?? '')
      publish.reset()
    }
    // React only to `open` changes — publish is a new object every render, so it is left out of the deps
  }, [open])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const url = parentUrl.trim()
    if (!url || publish.isPending) return
    localStorage.setItem(STORAGE_KEY, url)
    publish.mutate(url)
  }

  const result = publish.data
  const err = publish.error as ApiError | null
  const disabled = err?.code === 'NOTION_DISABLED'

  return (
    <Modal open={open} onClose={onClose} title={t('notion.title')}>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">{t('notion.created', { count: result.blockCount })}</p>
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate rounded-md border border-line bg-hover px-3 py-2 text-sm text-accent hover:underline"
          >
            {result.url}
          </a>
          {result.warnings.length > 0 && (
            <div className="rounded-md border border-line bg-app px-3 py-2">
              <p className="mb-1 text-xs font-medium text-sub">
                {t('notion.warnings', { count: result.warnings.length })}
              </p>
              <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4 text-xs text-sub">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-sub">
            {withNodes(t('notion.intro'), {
              title: <span className="font-medium text-ink">{pageTitle || t('common.untitled')}</span>,
            })}
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-sub" htmlFor="notion-parent">
              {t('notion.parentUrl')}
            </label>
            <input
              id="notion-parent"
              value={parentUrl}
              autoFocus
              onChange={(e) => setParentUrl(e.target.value)}
              placeholder="https://www.notion.so/…"
              className="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink placeholder:text-sub focus-visible:border-accent focus-visible:outline-none"
            />
          </div>

          {disabled ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {withNodes(t('notion.disabled'), {
                env: <code>.env</code>,
                token: <code>NOTION_TOKEN</code>,
              })}
            </div>
          ) : (
            err && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {err.message}
              </div>
            )
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={publish.isPending || parentUrl.trim().length === 0}
              className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {publish.isPending && <Spinner size={14} />}
              {publish.isPending ? t('notion.sending') : t('notion.send')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
