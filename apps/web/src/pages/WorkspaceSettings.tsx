import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type {
  AuditEventDTO,
  ReviewDueItemDTO,
  RolePolicy,
  TwoFactorPolicyDTO,
  WorkspaceCapabilities,
  WorkspaceDTO,
  WorkspaceSettingsDTO,
} from '@inkling/shared'
import {
  AUDIT_RETENTION_DAYS,
  REVIEW_INTERVAL_DAYS,
  TRASH_RETENTION_DAYS,
} from '@inkling/shared'
import {
  ApiError,
  triggerDownload,
  useAuditLog,
  useBlockAgent,
  useBulkUnpublish,
  useMembers,
  useReviewDue,
  useSetTwoFactorPolicy,
  useSharedList,
  useUnblockAgent,
  useUnshare,
  useUpdateWorkspace,
  useUpdateWorkspaceSettings,
  useWorkspaceAgents,
  useWorkspaces,
  useWorkspaceSettings,
} from '../api'
import { useLayout } from '../components/AppLayout'
import { ConfirmPopover } from '../components/ConfirmPopover'
import { EmojiPicker } from '../components/EmojiPicker'
import {
  DownloadIcon,
  GlobeIcon,
  HistoryIcon,
  LockIcon,
  LogOutIcon,
  MenuIcon,
  PlugIcon,
  SlidersIcon,
  TrashIcon,
  UsersIcon,
  ClockIcon,
  KeyIcon,
  FileTextIcon,
} from '../components/Icons'
import { MembersPanel, RoleBadge } from '../components/MembersPanel'
import { Modal } from '../components/Modal'
import { NavButtons } from '../components/NavButtons'
import { Group, Row, Select, Toggle } from '../components/SettingsRows'
import { Spinner } from '../components/Spinner'
import { WebhooksPanel } from '../components/WebhooksPanel'
import { LargePagesPanel } from '../components/LargePagesPanel'
import { WorkspaceAvatar } from '../components/WorkspaceAvatar'
import { DeletedWorkspacesList, WorkspaceDangerDialogs, type DangerAction } from '../components/WorkspaceDanger'
import { fmtDate, fmtDateTime, fmtRelative, useT, type TKey } from '../i18n'

// Workspace settings (/w/:wsId/workspace-settings?tab=…) — docs/adr/0945-* .. 0952-*.
// One screen for what used to be spread over the switcher menu and four modals. Tabs follow the
// caller's role (WorkspaceDTO.can, computed by the server); every rule is enforced server-side too.

type Tab = 'general' | 'members' | 'sharing' | 'agents' | 'audit' | 'review' | 'large' | 'webhooks' | 'danger'

const TABS: { id: Tab; label: TKey; icon: ReactNode; show: (c: WorkspaceCapabilities) => boolean }[] = [
  { id: 'general', label: 'wsSettings.tabGeneral', icon: <SlidersIcon size={15} />, show: () => true },
  { id: 'members', label: 'wsSettings.tabMembers', icon: <UsersIcon size={15} />, show: () => true },
  { id: 'sharing', label: 'wsSettings.tabSharing', icon: <GlobeIcon size={15} />, show: (c) => c.manage },
  { id: 'agents', label: 'wsSettings.tabAgents', icon: <KeyIcon size={15} />, show: (c) => c.manage },
  { id: 'audit', label: 'wsSettings.tabAudit', icon: <HistoryIcon size={15} />, show: (c) => c.manage },
  { id: 'review', label: 'wsSettings.tabReview', icon: <ClockIcon size={15} />, show: () => true },
  // Large pages (docs/adr/1103-*): owners and admins, like the audit log.
  { id: 'large', label: 'wsSettings.tabLargePages', icon: <FileTextIcon size={15} />, show: (c) => c.manage },
  { id: 'webhooks', label: 'wsSettings.tabWebhooks', icon: <PlugIcon size={15} />, show: (c) => c.editSettings },
  { id: 'danger', label: 'wsSettings.tabDanger', icon: <TrashIcon size={15} />, show: () => true },
]

/** Older servers without WorkspaceDTO.can: derive the owner-only behaviour they had. */
function capsOf(ws: WorkspaceDTO): WorkspaceCapabilities {
  if (ws.can) return ws.can
  const owner = ws.role === 'owner'
  return { manage: owner, editSettings: owner, addMembers: true, inviteLink: owner, export: true, publish: owner }
}

export function WorkspaceSettings() {
  const t = useT()
  const { wsId = '' } = useParams()
  const navigate = useNavigate()
  const { onToggleSidebar } = useLayout()
  const [params, setParams] = useSearchParams()
  const workspaces = useWorkspaces()
  const ws = workspaces.data?.find((w) => w.id === wsId)

  if (!ws) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    )
  }
  const can = capsOf(ws)
  const visible = TABS.filter((x) => x.show(can))
  const requested = params.get('tab') as Tab | null
  const tab: Tab = visible.some((x) => x.id === requested) ? (requested as Tab) : 'general'
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(`/w/${wsId}`)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('settings.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <button
          type="button"
          onClick={goBack}
          className="rounded-md px-2 py-1 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          ← {t('common.back')}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-ink">
          <WorkspaceAvatar name={ws.name} icon={ws.icon} size={18} />
          <span className="truncate">{t('wsSettings.title', { name: ws.name })}</span>
        </div>
      </header>

      <nav
        aria-label={t('wsSettings.tabsLabel')}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-1.5"
      >
        {visible.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-current={tab === x.id ? 'page' : undefined}
            onClick={() => setParams({ tab: x.id }, { replace: true })}
            className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150 ${
              tab === x.id ? 'bg-active font-medium text-ink' : 'text-sub hover:bg-hover hover:text-ink'
            }`}
          >
            {x.icon}
            {t(x.label)}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          {tab === 'general' && <GeneralTab ws={ws} can={can} />}
          {tab === 'members' && <MembersPanel wsId={wsId} workspace={ws} />}
          {tab === 'sharing' && <SharingTab ws={ws} can={can} />}
          {tab === 'agents' && <AgentsTab ws={ws} />}
          {tab === 'audit' && <AuditTab ws={ws} />}
          {tab === 'review' && <ReviewTab ws={ws} can={can} />}
          {tab === 'large' && <LargePagesPanel wsId={wsId} />}
          {tab === 'webhooks' && <WebhooksPanel wsId={wsId} />}
          {tab === 'danger' && <DangerTab ws={ws} />}
        </div>
      </div>
    </div>
  )
}

function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

// ---------------------------------------------------------------------------
// General: name, icon, policies, retention, export
// ---------------------------------------------------------------------------

function DaysInput({
  value,
  min,
  max,
  disabled,
  label,
  onCommit,
}: {
  value: number
  min: number
  max: number
  disabled: boolean
  label: string
  onCommit: (n: number) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Number(draft)
    if (!Number.isInteger(n) || n < min || n > max) {
      setDraft(String(value))
      return
    }
    if (n !== value) onCommit(n)
  }
  return (
    <label className="flex items-center gap-1.5 text-sm text-sub">
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="w-20 rounded-md border border-line bg-app px-2 py-1 text-right text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      />
      {t('wsSettings.days')}
    </label>
  )
}

function GeneralTab({ ws, can }: { ws: WorkspaceDTO; can: WorkspaceCapabilities }) {
  const t = useT()
  const settings = useWorkspaceSettings(ws.id)
  const update = useUpdateWorkspaceSettings(ws.id)
  const rename = useUpdateWorkspace(ws.id)
  const [name, setName] = useState(ws.name)
  const [pickerOpen, setPickerOpen] = useState(false)
  const iconRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setName(ws.name), [ws.name])
  const owner = can.editSettings

  const save = (patch: Parameters<typeof update.mutate>[0]) => {
    setError(null)
    update.mutate(patch, { onError: (e) => setError(errText(e, t('wsSettings.saveFailed'))) })
  }
  const saveWs = (patch: { name?: string; icon?: string | null }) => {
    setError(null)
    rename.mutate(patch, { onError: (e) => setError(errText(e, t('wsSettings.saveFailed'))) })
  }
  const policyOptions: { value: RolePolicy; label: string }[] = [
    { value: 'owners', label: t('wsSettings.policyOwners') },
    { value: 'admins', label: t('wsSettings.policyAdmins') },
    { value: 'members', label: t('wsSettings.policyMembers') },
  ]
  const s: WorkspaceSettingsDTO | undefined = settings.data?.settings
  const reviewOptions = [
    { value: 'off', label: t('wsSettings.reviewOff') },
    ...[30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: t('wsSettings.everyDays', { count: d }) })),
  ]
  if (s?.reviewIntervalDays && !reviewOptions.some((o) => o.value === String(s.reviewIntervalDays))) {
    reviewOptions.push({ value: String(s.reviewIntervalDays), label: t('wsSettings.everyDays', { count: s.reviewIntervalDays }) })
  }

  return (
    <>
      {!owner && <p className="mb-4 text-xs text-sub">{t('wsSettings.readOnlyNote')}</p>}
      <Group title={t('wsSettings.groupWorkspace')}>
        <Row title={t('wsSettings.name')}>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const v = name.trim()
              if (v && v !== ws.name) saveWs({ name: v })
            }}
          >
            <input
              value={name}
              maxLength={60}
              disabled={!owner}
              aria-label={t('wsSettings.name')}
              onChange={(e) => setName(e.target.value)}
              className="w-48 rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            />
            {owner && (
              <button
                type="submit"
                disabled={rename.isPending || !name.trim() || name.trim() === ws.name}
                className="rounded-md bg-accent px-2.5 py-1 text-sm text-white transition duration-150 hover:opacity-90 disabled:opacity-50"
              >
                {t('common.save')}
              </button>
            )}
          </form>
        </Row>
        <Row title={t('wsSettings.icon')} desc={t('wsSettings.iconDesc')}>
          <button
            ref={iconRef}
            type="button"
            disabled={!owner}
            onClick={() => setPickerOpen(true)}
            aria-label={t('wsSettings.icon')}
            className="rounded-md border border-line p-1 transition-colors duration-150 hover:bg-hover disabled:opacity-60"
          >
            <WorkspaceAvatar name={ws.name} icon={ws.icon} size={24} />
          </button>
          {pickerOpen && (
            <EmojiPicker
              anchorRef={iconRef}
              hasIcon={!!ws.icon}
              onSelect={(emoji) => {
                setPickerOpen(false)
                saveWs({ icon: emoji })
              }}
              onRemove={() => {
                setPickerOpen(false)
                saveWs({ icon: null })
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </Row>
      </Group>

      {settings.isLoading || !s ? (
        <div className="flex justify-center py-6">
          <Spinner size={18} />
        </div>
      ) : (
        <>
          <Group title={t('wsSettings.groupPeople')}>
            <Row title={t('wsSettings.inviteLink')} desc={t('wsSettings.inviteLinkDesc')}>
              <Toggle
                checked={s.inviteLinkEnabled}
                disabled={!owner || update.isPending}
                label={t('wsSettings.inviteLink')}
                onChange={(v) => save({ inviteLinkEnabled: v })}
              />
            </Row>
            <Row title={t('wsSettings.memberAdd')} desc={t('wsSettings.memberAddDesc')}>
              <Select
                value={s.memberAddPolicy}
                options={policyOptions}
                disabled={!owner || update.isPending}
                label={t('wsSettings.memberAdd')}
                onChange={(v) => save({ memberAddPolicy: v })}
              />
            </Row>
          </Group>

          {settings.data?.twoFactor && <TwoFactorPolicyGroup ws={ws} can={can} policy={settings.data.twoFactor} />}
          <Group title={t('wsSettings.groupContent')}>
            <Row title={t('wsSettings.exportPolicy')} desc={t('wsSettings.exportPolicyDesc')}>
              <Select
                value={s.exportPolicy}
                options={policyOptions}
                disabled={!owner || update.isPending}
                label={t('wsSettings.exportPolicy')}
                onChange={(v) => save({ exportPolicy: v })}
              />
            </Row>
            <Row title={t('wsSettings.exportNow')} desc={t('wsSettings.exportNowDesc')}>
              <button
                type="button"
                disabled={!can.export}
                onClick={() => triggerDownload(`/api/workspaces/${ws.id}/export`)}
                className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50"
              >
                <DownloadIcon size={14} /> {t('workspace.exportAll')}
              </button>
            </Row>
            <Row
              title={t('wsSettings.trashRetention')}
              desc={t('wsSettings.trashRetentionDesc', { min: TRASH_RETENTION_DAYS.min, max: TRASH_RETENTION_DAYS.max })}
            >
              <DaysInput
                value={s.trashRetentionDays}
                min={TRASH_RETENTION_DAYS.min}
                max={TRASH_RETENTION_DAYS.max}
                disabled={!owner || update.isPending}
                label={t('wsSettings.trashRetention')}
                onCommit={(n) => save({ trashRetentionDays: n })}
              />
            </Row>
            <Row title={t('wsSettings.reviewInterval')} desc={t('wsSettings.reviewIntervalDesc')}>
              <Select
                value={s.reviewIntervalDays ? String(s.reviewIntervalDays) : 'off'}
                options={reviewOptions}
                disabled={!owner || update.isPending}
                label={t('wsSettings.reviewInterval')}
                onChange={(v) => save({ reviewIntervalDays: v === 'off' ? null : Number(v) })}
              />
            </Row>
          </Group>

          {can.manage && (
            <Group title={t('wsSettings.groupAudit')}>
              <Row
                title={t('wsSettings.auditRetention')}
                desc={t('wsSettings.auditRetentionDesc', { min: AUDIT_RETENTION_DAYS.min, max: AUDIT_RETENTION_DAYS.max })}
              >
                <DaysInput
                  value={s.auditRetentionDays}
                  min={AUDIT_RETENTION_DAYS.min}
                  max={AUDIT_RETENTION_DAYS.max}
                  disabled={!owner || update.isPending}
                  label={t('wsSettings.auditRetention')}
                  onCommit={(n) => save({ auditRetentionDays: n })}
                />
              </Row>
            </Group>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </>
  )
}

// ---------------------------------------------------------------------------
// Sharing: "no public links" switch + the list of public pages
// ---------------------------------------------------------------------------

/** "Require two-step verification" (docs/adr/1112-*): owners and admins switch it; members see it. */
function TwoFactorPolicyGroup({ ws, can, policy }: { ws: WorkspaceDTO; can: WorkspaceCapabilities; policy: TwoFactorPolicyDTO }) {
  const t = useT()
  const set = useSetTwoFactorPolicy(ws.id)
  const [error, setError] = useState<string | null>(null)
  const manage = can.manage
  const canTurnOn = policy.available && policy.selfSatisfied
  const save = (input: { required: boolean; graceDays?: number }) => {
    setError(null)
    set.mutate(input, { onError: (e) => setError(errText(e, t('wsSettings.saveFailed'))) })
  }
  const graceOptions = [0, 1, 3, 7, 14, 30].map((d) => ({
    value: String(d),
    label: d === 0 ? t('wsTwoFactor.graceNone') : t('wsTwoFactor.graceDays', { count: d }),
  }))
  if (!graceOptions.some((o) => o.value === String(policy.graceDays))) {
    graceOptions.push({ value: String(policy.graceDays), label: t('wsTwoFactor.graceDays', { count: policy.graceDays }) })
  }
  const without = policy.membersWithout
  return (
    <Group title={t('wsTwoFactor.group')}>
      <Row
        id="twoFactorRequired"
        title={t('wsTwoFactor.title')}
        desc={
          <>
            {t('wsTwoFactor.desc')}
            {!policy.available && <span className="mt-1 block text-amber-600">{t('wsTwoFactor.unavailable')}</span>}
            {policy.available && !policy.selfSatisfied && !policy.required && manage && (
              <span className="mt-1 block text-amber-600">
                {t('wsTwoFactor.selfFirst')}{' '}
                <Link to={`/w/${ws.id}/settings#security`} className="text-accent hover:underline">
                  {t('wsTwoFactor.selfFirstLink')}
                </Link>
              </span>
            )}
            {policy.required && policy.deadline && (
              <span className="mt-1 block">
                {new Date(policy.deadline).getTime() > Date.now()
                  ? t('wsTwoFactor.deadlineFuture', { date: fmtDateTime(policy.deadline) })
                  : t('wsTwoFactor.deadlinePast', { date: fmtDateTime(policy.deadline) })}
              </span>
            )}
          </>
        }
      >
        <Toggle
          checked={policy.required}
          disabled={!manage || set.isPending || (!policy.required && !canTurnOn)}
          label={t('wsTwoFactor.title')}
          onChange={(v) => save({ required: v, graceDays: policy.graceDays })}
        />
      </Row>
      <Row title={t('wsTwoFactor.grace')} desc={t('wsTwoFactor.graceDesc')}>
        <Select
          value={String(policy.graceDays)}
          options={graceOptions}
          disabled={!manage || set.isPending}
          label={t('wsTwoFactor.grace')}
          onChange={(v) => save({ required: policy.required, graceDays: Number(v) })}
        />
      </Row>
      {manage && without && (
        <Row
          title={t('wsTwoFactor.withoutTitle', { count: without.count })}
          desc={
            without.count === 0
              ? t('wsTwoFactor.withoutNone')
              : without.members.map((m) => m.name).join(', ') + (without.count > without.members.length ? ' …' : '')
          }
        />
      )}
      {error && <p className="px-4 py-2 text-xs text-red-600">{error}</p>}
    </Group>
  )
}

function SharingTab({ ws, can }: { ws: WorkspaceDTO; can: WorkspaceCapabilities }) {
  const t = useT()
  const settings = useWorkspaceSettings(ws.id)
  const update = useUpdateWorkspaceSettings(ws.id)
  const shared = useSharedList(ws.id)
  const bulk = useBulkUnpublish(ws.id)
  const [confirmOff, setConfirmOff] = useState(false)
  const [alsoUnpublish, setAlsoUnpublish] = useState(true)
  const [confirmAll, setConfirmAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disabled = settings.data?.settings.publicSharingDisabled ?? false
  const items = shared.data?.items ?? []
  // Rules for new links (docs/adr/1172-*): default expiry and "password required".
  const defaultDays = settings.data?.settings.shareDefaultExpiryDays ?? null
  const expiryOptions = [
    { value: 'off', label: t('shareLink.never') },
    ...[1, 7, 30, 90].map((d) => ({ value: String(d), label: t('shareLink.days', { count: d }) })),
  ]
  if (defaultDays && !expiryOptions.some((o) => o.value === String(defaultDays))) {
    expiryOptions.push({ value: String(defaultDays), label: t('shareLink.days', { count: defaultDays }) })
  }
  const savePolicy = (patch: { shareDefaultExpiryDays?: number | null; sharePasswordRequired?: boolean }) => {
    setError(null)
    update.mutate(patch, { onError: (e) => setError(errText(e, t('wsSettings.saveFailed'))) })
  }

  return (
    <>
      <Group title={t('wsSettings.groupPublic')}>
        <Row title={t('wsSettings.publicOff')} desc={t('wsSettings.publicOffDesc')}>
          <Toggle
            checked={disabled}
            disabled={!can.editSettings || update.isPending}
            label={t('wsSettings.publicOff')}
            onChange={(v) => {
              setError(null)
              if (v) setConfirmOff(true)
              else update.mutate({ publicSharingDisabled: false }, { onError: (e) => setError(errText(e, t('wsSettings.saveFailed'))) })
            }}
          />
        </Row>
        <Row title={t('wsSettings.shareDefaultExpiry')} desc={t('wsSettings.shareDefaultExpiryDesc')}>
          <Select
            value={defaultDays ? String(defaultDays) : 'off'}
            options={expiryOptions}
            disabled={!can.editSettings || update.isPending || !settings.data}
            label={t('wsSettings.shareDefaultExpiry')}
            onChange={(v) => savePolicy({ shareDefaultExpiryDays: v === 'off' ? null : Number(v) })}
          />
        </Row>
        <Row title={t('wsSettings.sharePasswordRequired')} desc={t('wsSettings.sharePasswordRequiredDesc')}>
          <Toggle
            checked={settings.data?.settings.sharePasswordRequired ?? false}
            disabled={!can.editSettings || update.isPending || !settings.data}
            label={t('wsSettings.sharePasswordRequired')}
            onChange={(v) => savePolicy({ sharePasswordRequired: v })}
          />
        </Row>
      </Group>

      <section className="mb-8">
        <div className="mb-1 flex items-center gap-2 px-1">
          <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
            {t('wsSettings.publicPages', { count: items.length })}
          </h2>
          {items.length > 0 && (
            <ConfirmPopover
              open={confirmAll}
              onCancel={() => setConfirmAll(false)}
              onConfirm={() => {
                setConfirmAll(false)
                bulk.mutate(undefined, { onError: (e) => setError(errText(e, t('wsSettings.saveFailed'))) })
              }}
              message={t('wsSettings.unpublishAllConfirm', { count: items.length })}
              confirmLabel={t('wsSettings.unpublishAll')}
            >
              <button
                type="button"
                onClick={() => setConfirmAll(true)}
                disabled={bulk.isPending}
                className="rounded-md px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-50"
              >
                {t('wsSettings.unpublishAll')}
              </button>
            </ConfirmPopover>
          )}
        </div>
        <div className="divide-y divide-line rounded-lg border border-line">
          {shared.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sub">{t('wsSettings.noPublicPages')}</p>
          ) : (
            items.map((it) => <PublicRow key={it.id} wsId={ws.id} item={it} />)
          )}
        </div>
        <p className="mt-2 px-1 text-xs text-sub">{t('wsSettings.publicListNote')}</p>
      </section>
      {error && <p className="text-xs text-red-600">{error}</p>}

      <Modal open={confirmOff} onClose={() => setConfirmOff(false)} title={t('wsSettings.publicOffTitle')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-sub">{t('wsSettings.publicOffBody')}</p>
          {items.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={alsoUnpublish} onChange={(e) => setAlsoUnpublish(e.target.checked)} />
              {t('wsSettings.publicOffAlso', { count: items.length })}
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmOff(false)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-hover"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { publicSharingDisabled: true, ...(alsoUnpublish && items.length > 0 ? { unpublishExisting: true } : {}) },
                  {
                    onSuccess: () => setConfirmOff(false),
                    onError: (e) => setError(errText(e, t('wsSettings.saveFailed'))),
                  },
                )
              }
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {t('wsSettings.publicOffConfirm')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  )
}

function PublicRow({ wsId, item }: { wsId: string; item: { id: string; title: string; icon: string | null; updatedAt: string; exposedCount?: number } }) {
  const t = useT()
  const unshare = useUnshare(item.id)
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 text-sm">
      <span className="w-5 shrink-0 text-center">{item.icon ?? <GlobeIcon size={14} className="inline text-sub" />}</span>
      <Link to={`/w/${wsId}/p/${item.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
        {item.title || t('common.untitled')}
      </Link>
      {item.exposedCount !== undefined && (
        <span className="shrink-0 text-xs text-sub">{t('wsSettings.exposedCount', { count: item.exposedCount })}</span>
      )}
      <button
        type="button"
        disabled={unshare.isPending}
        onClick={() => unshare.mutate()}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-50"
      >
        {t('wsSettings.unpublish')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connected agents
// ---------------------------------------------------------------------------

function AgentsTab({ ws }: { ws: WorkspaceDTO }) {
  const t = useT()
  const agents = useWorkspaceAgents(ws.id)
  const block = useBlockAgent(ws.id)
  const unblock = useUnblockAgent(ws.id)
  const members = useMembers(ws.id)
  const [error, setError] = useState<string | null>(null)
  const roleOf = (userId: string) => members.data?.find((m) => m.id === userId)?.role
  const mayTouch = (userId: string) => ws.role === 'owner' || roleOf(userId) !== 'owner'
  const onErr = (e: unknown) => setError(errText(e, t('wsSettings.saveFailed')))
  const connections = agents.data?.connections ?? []
  const blocks = agents.data?.blocks ?? []

  return (
    <>
      <p className="mb-4 text-xs leading-relaxed text-sub">{t('agents.intro')}</p>
      <section className="mb-8">
        <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{t('agents.connections')}</h2>
        <div className="divide-y divide-line rounded-lg border border-line">
          {agents.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : connections.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sub">{t('agents.empty')}</p>
          ) : (
            connections.map((c) => (
              <div key={c.grantId} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink">
                    {c.client.name} <span className="text-sub">· {c.user.name}</span>
                  </div>
                  <div className="text-xs text-sub" title={fmtDateTime(c.lastUsedAt)}>
                    {t('agents.lastUsed', { when: fmtRelative(c.lastUsedAt) })} ·{' '}
                    {c.access === 'write' ? t('agents.accessWrite') : t('agents.accessRead')}
                  </div>
                </div>
                {c.blocked ? (
                  <span className="shrink-0 rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-600">{t('agents.blocked')}</span>
                ) : (
                  mayTouch(c.user.id) && (
                    <button
                      type="button"
                      disabled={block.isPending}
                      onClick={() => block.mutate({ userId: c.user.id, clientId: c.client.id }, { onError: onErr })}
                      className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50"
                    >
                      {t('agents.block')}
                    </button>
                  )
                )}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-1 flex items-center gap-2 px-1">
          <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{t('agents.blocks')}</h2>
          <BlockAllPicker
            members={(members.data ?? []).filter((m) => mayTouch(m.id))}
            disabled={block.isPending}
            onPick={(userId) => block.mutate({ userId, clientId: null }, { onError: onErr })}
          />
        </div>
        <div className="divide-y divide-line rounded-lg border border-line">
          {blocks.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sub">{t('agents.noBlocks')}</p>
          ) : (
            blocks.map((b) => (
              <div key={b.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                <LockIcon size={14} className="shrink-0 text-sub" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink">
                    {b.client ? b.client.name : t('agents.allAgents')} <span className="text-sub">· {b.user.name}</span>
                  </div>
                  <div className="text-xs text-sub">
                    {t('agents.blockedBy', { name: b.createdBy ?? '—', date: fmtDate(b.createdAt) })}
                  </div>
                </div>
                {mayTouch(b.user.id) && (
                  <button
                    type="button"
                    disabled={unblock.isPending}
                    onClick={() => unblock.mutate(b.id, { onError: onErr })}
                    className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50"
                  >
                    {t('agents.unblock')}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
        <p className="mt-2 px-1 text-xs text-sub">{t('agents.revokeNote')}</p>
      </section>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </>
  )
}

function BlockAllPicker({
  members,
  disabled,
  onPick,
}: {
  members: { id: string; name: string }[]
  disabled: boolean
  onPick: (userId: string) => void
}) {
  const t = useT()
  return (
    <select
      value=""
      disabled={disabled || members.length === 0}
      aria-label={t('agents.blockAll')}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value)
      }}
      className="rounded-md border border-line bg-app px-2 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
    >
      <option value="">{t('agents.blockAll')}</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const AUDIT_GROUPS = [
  '',
  'member',
  'invite',
  'share',
  'page',
  'instructions',
  'content',
  'export',
  'workspace',
  'agent',
  'settings',
  'webhook',
] as const

function summarize(v: Record<string, unknown> | null): string {
  if (!v) return ''
  return Object.entries(v)
    .map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(', ') : x === null ? '—' : String(x)}`)
    .join(' · ')
}

function AuditRow({ e }: { e: AuditEventDTO }) {
  const t = useT()
  const key = `audit.action.${e.action}` as TKey
  const change = [summarize(e.before), summarize(e.after)].filter(Boolean)
  return (
    <div className="px-4 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-ink">{t(key)}</span>
        {e.target?.label && <span className="min-w-0 truncate text-ink">{e.target.label}</span>}
        <span className="ml-auto shrink-0 text-xs text-sub" title={e.createdAt}>
          {fmtDateTime(e.createdAt)}
        </span>
      </div>
      <div className="text-xs text-sub">
        {e.actor.name || t('audit.unknownActor')}
        {e.viaClient && ` ${t('audit.via', { client: e.viaClient })}`}
        {change.length > 0 && <span> · {change.join(' → ')}</span>}
      </div>
    </div>
  )
}

function AuditTab({ ws }: { ws: WorkspaceDTO }) {
  const t = useT()
  const members = useMembers(ws.id)
  const [action, setAction] = useState('')
  const [actorId, setActorId] = useState('')
  const log = useAuditLog(ws.id, { action, actorId })
  const events = log.data?.pages.flatMap((p) => p.events) ?? []
  const retention = log.data?.pages[0]?.retentionDays

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          value={action}
          label={t('audit.filterAction')}
          options={AUDIT_GROUPS.map((g) => ({ value: g, label: t(`audit.group.${g || 'all'}` as TKey) }))}
          onChange={setAction}
        />
        <Select
          value={actorId}
          label={t('audit.filterActor')}
          options={[{ value: '', label: t('audit.everyone') }, ...(members.data ?? []).map((m) => ({ value: m.id, label: m.name }))]}
          onChange={setActorId}
        />
        {retention && <span className="ml-auto text-xs text-sub">{t('audit.retention', { count: retention })}</span>}
      </div>
      <div className="divide-y divide-line rounded-lg border border-line">
        {log.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        ) : log.isError ? (
          <p className="px-4 py-6 text-center text-sm text-red-600">{errText(log.error, t('common.unknownError'))}</p>
        ) : events.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-sub">{t('audit.empty')}</p>
        ) : (
          events.map((e) => <AuditRow key={e.id} e={e} />)
        )}
      </div>
      {log.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            disabled={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-50"
          >
            {log.isFetchingNextPage ? <Spinner size={14} /> : t('audit.more')}
          </button>
        </div>
      )}
      <p className="mt-3 px-1 text-xs text-sub">{t('audit.contentNote')}</p>
    </>
  )
}

// ---------------------------------------------------------------------------
// Review: documents past their review date
// ---------------------------------------------------------------------------

function ReviewList({ wsId, items, empty, kind }: { wsId: string; items: ReviewDueItemDTO[]; empty: string; kind: 'stale' | 'archive' | 'living' }) {
  const t = useT()
  return (
    <div className="divide-y divide-line rounded-lg border border-line">
      {items.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-sub">{empty}</p>
      ) : (
        items.map((it) => (
          <div key={it.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
            <span className="w-5 shrink-0 text-center">{it.icon ?? ''}</span>
            <div className="min-w-0 flex-1">
              <Link to={`/w/${wsId}/p/${it.id}`} className="block truncate text-ink hover:underline">
                {it.title || t('common.untitled')}
              </Link>
              <div className="text-xs text-sub">
                {it.owner ? t('review.ownerIs', { name: it.owner.name }) : t('review.noOwner')} ·{' '}
                {it.reviewedAt ? t('review.lastReviewed', { date: fmtDate(it.reviewedAt) }) : t('review.neverReviewed')} ·{' '}
                {t('review.reads', { count: it.reads30 })}
                {kind === 'stale' && <> · {t('review.minutes', { count: it.estMinutes })}</>}
              </div>
            </div>
            {kind === 'stale' && (
              <span
                className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                title={t('review.scoreTitle', { p: `${Math.round(it.pStale * 100)}%`, date: it.dueOn })}
              >
                {t('review.score', { score: it.score.toFixed(2) })}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function ReviewTab({ ws, can }: { ws: WorkspaceDTO; can: WorkspaceCapabilities }) {
  const t = useT()
  const [, setParams] = useSearchParams()
  const [mine, setMine] = useState(false)
  const due = useReviewDue(ws.id, mine)
  const interval = due.data?.intervalDays ?? null

  if (due.isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner size={18} />
      </div>
    )
  }
  if (interval == null) {
    return (
      <div className="rounded-lg border border-line px-4 py-6 text-sm text-sub">
        <p>{t('review.off')}</p>
        {can.editSettings && (
          <button
            type="button"
            onClick={() => setParams({ tab: 'general' }, { replace: true })}
            className="mt-2 text-accent hover:underline"
          >
            {t('review.turnOn')}
          </button>
        )}
      </div>
    )
  }
  const items = due.data?.items ?? []
  const totalMinutes = items.reduce((n, i) => n + i.estMinutes, 0)
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="flex-1 text-xs leading-relaxed text-sub">{t('review.intro', { count: interval })}</p>
        <label className="flex items-center gap-2 text-sm text-ink">
          <Toggle checked={mine} onChange={setMine} label={t('review.onlyMine')} />
          {t('review.onlyMine')}
        </label>
      </div>
      <section className="mb-8">
        <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
          {t('review.priority', { count: items.length })}
          {items.length > 0 && <span className="ml-2 normal-case">{t('review.totalMinutes', { count: totalMinutes })}</span>}
        </h2>
        <ReviewList wsId={ws.id} items={items} empty={t('review.empty')} kind="stale" />
      </section>
      <section className="mb-8">
        <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{t('review.archive')}</h2>
        <ReviewList wsId={ws.id} items={due.data?.archive ?? []} empty={t('review.archiveEmpty')} kind="archive" />
        <p className="mt-2 px-1 text-xs text-sub">{t('review.archiveNote')}</p>
      </section>
      <section className="mb-8">
        <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{t('review.living')}</h2>
        <ReviewList wsId={ws.id} items={due.data?.living ?? []} empty={t('review.livingEmpty')} kind="living" />
        <p className="mt-2 px-1 text-xs text-sub">{t('review.livingNote')}</p>
      </section>
      <p className="px-1 text-xs text-sub">{t('review.webhookNote')}</p>
    </>
  )
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

function DangerTab({ ws }: { ws: WorkspaceDTO }) {
  const t = useT()
  const [danger, setDanger] = useState<DangerAction>(null)
  const owner = ws.role === 'owner'
  return (
    <>
      <Group title={t('wsDanger.section')}>
        <Row title={t('wsDanger.leave')} desc={t('wsSettings.leaveDesc')}>
          <button
            type="button"
            onClick={() => setDanger('leave')}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm text-ink hover:bg-hover"
          >
            <LogOutIcon size={14} /> {t('wsDanger.leave')}
          </button>
        </Row>
        {owner && (
          <Row title={t('wsSettings.transferTitle')} desc={t('wsSettings.transferDesc')}>
            <button
              type="button"
              onClick={() => setDanger('transfer')}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm text-ink hover:bg-hover"
            >
              <UsersIcon size={14} /> {t('wsDanger.transfer')}
            </button>
          </Row>
        )}
        {owner && (
          <Row title={t('wsSettings.deleteTitle')} desc={t('wsSettings.deleteDesc')}>
            <button
              type="button"
              onClick={() => setDanger('delete')}
              className="flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-sm text-white hover:opacity-90"
            >
              <TrashIcon size={14} /> {t('wsDanger.delete')}
            </button>
          </Row>
        )}
      </Group>
      {!owner && (
        <p className="mb-6 flex items-center gap-1.5 text-xs text-sub">
          <RoleBadge role={ws.role} /> {t('wsSettings.dangerOwnerOnly')}
        </p>
      )}
      <DeletedWorkspacesList />
      <WorkspaceDangerDialogs action={danger} onAction={setDanger} wsId={ws.id} workspace={ws} />
    </>
  )
}
