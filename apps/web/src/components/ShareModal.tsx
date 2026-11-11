import { useFeatureOff } from './quota/features'
import { useState } from 'react'
import type { PageMetaDTO } from '@inkling/shared'
import { ApiError, useShare, useShareStatus, useUnshare, useWorkspaces } from '../api'
import { copyText } from '../lib/clipboard'
import { Modal } from './Modal'
import { Spinner } from './Spinner'
import { CopyIcon, LinkIcon, LockIcon } from './Icons'
import { LinkSettings, usePublishOptions } from './ShareLinkOptions'
import { ShareChartsOption } from './ShareChartsOption'
import { SharePeople } from './SharePeople'
import { useT } from '../i18n'

// Public link = /s/<token> on the current origin. Uses location.origin as is so it also works
// when opened from a phone (non-secure origin).
function publicUrl(token: string): string {
  return `${location.origin}/s/${token}`
}

// Share dialog: people with access to the page tree (SharePeople, docs/adr/1250-*) and the public
// link that lets anyone view a page without signing in.
// - Private pages: shows that sharing is unavailable (disabled).
// - Only the workspace owner can publish/stop. Non-owners only see the status.
// - Guests never get here (the share button is hidden for them; the server answers 403 anyway).
export function ShareModal({
  open,
  onClose,
  page,
}: {
  open: boolean
  onClose: () => void
  page: PageMetaDTO
}) {
  const t = useT()
  const workspaces = useWorkspaces()
  // Owners and admins manage public links; publishing also needs public sharing allowed (docs/adr/0945-*, 0949-*).
  const ws = (workspaces.data ?? []).find((w) => w.id === page.workspaceId)
  const isOwner = ws?.can?.manage ?? ws?.role === 'owner'
  // public links turned off by the server (DISABLED_FEATURES public-links, docs/adr/2507-*): nothing to publish
  const publicOff = useFeatureOff('public-links')
  const canPublish = (ws?.can?.publish ?? isOwner) && !publicOff
  const isPrivate = page.scope === 'private'
  const isFolder = page.kind === 'folder'

  const guest = ws?.role === 'guest'
  const status = useShareStatus(page.id, open && !isPrivate && !!ws && !guest)
  const share = useShare(page.id)
  const unshare = useUnshare(page.id)

  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const token = status.data?.token ?? null
  const shared = !!status.data?.shared && !!token
  // Expiry and password picked before publishing (docs/adr/1170-*, 1171-*); defaults from the workspace rules.
  const options = usePublishOptions(status.data?.policy)
  // Folder sharing publishes every page below it (except private/trashed), so show the scope and
  // the current number of exposed pages.
  const exposedCount = status.data?.exposedCount
  const folderNotice = isFolder ? (
    <p className="rounded-md border border-line bg-hover/40 px-3 py-2 text-xs text-sub">
      {t('share.folderNotice')}
      {typeof exposedCount === 'number' && (
        <>
          {' · '}
          <span className="font-medium text-ink">
            {t(shared ? 'share.exposedShared' : 'share.exposedPending', { count: exposedCount })}
          </span>
        </>
      )}
    </p>
  ) : null

  const doShare = () => {
    setError(null)
    if (!options.body) return
    share.mutate(options.body, {
      onSuccess: () => options.reset(),
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('share.shareFailed')),
    })
  }

  const doUnshare = () => {
    setError(null)
    unshare.mutate(undefined, {
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('share.unshareFailed')),
    })
  }

  const doCopy = async () => {
    if (!token) return
    const ok = await copyText(publicUrl(token))
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } else {
      setError(t('share.copyFailed'))
    }
  }

  const busy = share.isPending || unshare.isPending

  return (
    <Modal open={open} onClose={onClose} title={t('share.dialogTitle')} size="md">
      {!isPrivate && ws && !guest && (
        <section className="mb-5 flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-sub">{t('access.title')}</h3>
          <SharePeople pageId={page.id} ws={ws} open={open} />
        </section>
      )}
      {!isPrivate && (
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">{t('share.title')}</h3>
      )}
      {isPrivate ? (
        // Private pages cannot be shared — the server also rejects it with 400, but the UI says so first.
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-md border border-line bg-hover/40 p-3 text-sm text-sub">
            <LockIcon size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-ink">{t('share.privateTitle')}</p>
              <p className="mt-1 text-xs">{t('share.privateHint')}</p>
            </div>
          </div>
        </div>
      ) : status.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner size={20} />
        </div>
      ) : shared ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-sub">
            {t(isFolder ? 'share.sharedHintFolder' : 'share.sharedHintPage')}
          </p>
          {folderNotice}
          <div className="flex items-center gap-2 rounded-md border border-line bg-app px-3 py-2">
            <LinkIcon size={14} className="shrink-0 text-sub" />
            <input
              readOnly
              value={publicUrl(token!)}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink focus-visible:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={doCopy}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90"
            >
              <CopyIcon size={14} />
              {copied ? t('common.copied') : t('common.copyLink')}
            </button>
            <a
              href={publicUrl(token!)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              {t('share.openNewTab')}
            </a>
          </div>
          <LinkSettings pageId={page.id} status={status.data!} canManage={isOwner} />
          <ShareChartsOption pageId={page.id} status={status.data!} shared canManage={isOwner} />
          {isOwner ? (
            <button
              type="button"
              onClick={doUnshare}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-sm text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-60"
            >
              {unshare.isPending && (
                <Spinner size={14} className="border-red-600/40 border-t-red-600" />
              )}
              {t('share.stop')}
            </button>
          ) : (
            <p className="text-xs text-sub">{t('share.stopOwnerOnly')}</p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-sub">
            {t(isFolder ? 'share.publishHintFolder' : 'share.publishHintPage')}
          </p>
          {folderNotice}
          {status.data && <ShareChartsOption pageId={page.id} status={status.data} shared={false} canManage={isOwner} />}
          {canPublish && options.view}
          <button
            type="button"
            onClick={doShare}
            disabled={!canPublish || busy || !options.body}
            title={!canPublish ? t(isOwner ? 'share.publishDisabled' : 'share.publishOwnerOnly') : undefined}
            className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {share.isPending && (
              <Spinner size={14} className="border-white/40 border-t-white" />
            )}
            {t('share.publish')}
          </button>
          {!canPublish && (
            <p className="text-xs text-sub">{t(isOwner ? 'share.publishDisabled' : 'share.publishOwnerOnly')}</p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </Modal>
  )
}
