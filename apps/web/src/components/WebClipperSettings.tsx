import { useEffect, useRef, useState } from 'react'
import { usePages, useWorkspaces } from '../api'
import { useT } from '../i18n'
import { readDefaultClipLocation, writeDefaultClipLocation, type ClipLocation } from '../lib/clipPrefs'
import { buildBookmarklet } from '../lib/clipQuery'
import { Group, Row } from './SettingsRows'

// Settings › Connections › Web clipper (docs/adr/2263-*): the bookmarklet to drag to the bookmarks bar
// (or copy), what to do where a site's security policy blocks it, the phone share menu, and the
// default location the /clip screen starts at.

const btn =
  'rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40'

function DefaultLocationName({ loc }: { loc: ClipLocation }) {
  const workspaces = useWorkspaces()
  const pages = usePages(loc.parentId ? loc.workspaceId : '')
  const ws = workspaces.data?.find((w) => w.id === loc.workspaceId)
  const parent = loc.parentId ? pages.data?.find((p) => p.id === loc.parentId) : null
  if (!ws) return null
  return (
    <span className="text-xs text-ink">
      {ws.name}
      {parent ? ` › ${parent.title || '—'}` : ''}
    </span>
  )
}

export function WebClipperSettings() {
  const t = useT()
  const origin = window.location.origin
  const code = buildBookmarklet(origin)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [copied, setCopied] = useState(false)
  const [def, setDef] = useState<ClipLocation | null>(() => readDefaultClipLocation())

  // React 19 replaces a javascript: href with an error-throwing one, so the bookmarklet's address is
  // set on the element directly. It is our own code with this server's address, no user input.
  useEffect(() => {
    linkRef.current?.setAttribute('href', code)
  }, [code])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* no clipboard permission: the code is selectable below */
    }
  }

  return (
    <Group title={t('clipSettings.title')} desc={t('clipSettings.desc')}>
      <div className="px-4 py-3" data-pref="webClipper">
        <div className="text-sm text-ink">{t('clipSettings.bookmarklet')}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-sub">{t('clipSettings.bookmarkletDesc')}</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            ref={linkRef}
            data-bookmarklet
            draggable
            onClick={(e) => e.preventDefault()}
            className="inline-flex cursor-grab items-center gap-1 rounded-md border border-accent px-3 py-1 text-sm font-medium text-accent active:cursor-grabbing"
            title={t('clipSettings.bookmarkletLabel')}
          >
            <img src="/icon.svg" alt="" className="h-4 w-4" />
            {t('clipSettings.bookmarkletLabel')}
          </a>
          <button type="button" className={btn} onClick={copy}>
            {copied ? t('common.copied') : t('clipSettings.copyCode')}
          </button>
        </div>
        <div className="mt-1 text-xs leading-relaxed text-sub">{t('clipSettings.copyCodeDesc')}</div>
        <div className="mt-2 text-xs leading-relaxed text-sub">{t('clipSettings.csp', { path: `${origin}/clip?url=…` })}</div>
      </div>
      <Row title={t('clipSettings.share')} desc={t('clipSettings.shareDesc')} />
      <Row id="clipDefault" title={t('clipSettings.defaultLocation')} desc={t('clipSettings.defaultLocationDesc')} deviceOnly stack>
        {def ? <DefaultLocationName loc={def} /> : <span className="text-xs text-sub">{t('clipSettings.defaultNone')}</span>}
        {def && (
          <button
            type="button"
            className={btn}
            onClick={() => {
              writeDefaultClipLocation(null)
              setDef(null)
            }}
          >
            {t('clipSettings.clearDefault')}
          </button>
        )}
      </Row>
    </Group>
  )
}
