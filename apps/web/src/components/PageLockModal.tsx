import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  MAX_APPLY_TO,
  type AgentInstructionDTO,
  type AgentInstructionMode,
  type LockAgents,
  type LockPeople,
  type PageLockDTO,
  type PageMetaDTO,
  type SetPageLockInput,
} from '@inkling/shared'
import {
  ApiError,
  useMembers,
  usePageLock,
  useRemoveAgentInstructions,
  useSetAgentInstructions,
  useSetPageLock,
  useWorkspaceAgentInstructions,
  useWorkspaces,
} from '../api'
import { agentRuleLine, editableByLine } from '../lib/editLock'
import { useT, type TKey } from '../i18n'
import { Modal } from './Modal'
import { Spinner } from './Spinner'
import { Toggle } from './SettingsRows'
import { LockIcon, XIcon } from './Icons'

// Edit lock (docs/adr/0970-*) and agent instruction designation (docs/adr/0975-*) of one page.
// Opened from the page header, the lock banner and the sidebar row menu. The server decides who
// may manage (PageLockDTO.canManage) and enforces every write; this only reflects it.

const selectClass =
  'min-w-0 flex-1 rounded-md border border-line bg-app px-1.5 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60'
const inputClass =
  'w-full rounded-md border border-line bg-app px-2 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

const PEOPLE_LABEL: Record<LockPeople, TKey> = {
  editors: 'lock.peopleEditors',
  everyone: 'lock.peopleEveryone',
}
const AGENTS_LABEL: Record<LockAgents, TKey> = {
  same: 'lock.agentsSame',
  comment: 'lock.agentsComment',
  read: 'lock.agentsRead',
}
const MODE_LABEL: Record<AgentInstructionMode, TKey> = {
  always: 'instructions.modeAlways',
  match: 'instructions.modeMatch',
  manual: 'instructions.modeManual',
}

export function PageLockModal({
  open,
  onClose,
  wsId,
  page,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  page: PageMetaDTO
}) {
  const t = useT()
  const isPrivate = page.scope === 'private'
  const lock = usePageLock(page.id, open && !isPrivate)
  const workspaces = useWorkspaces()
  const ws = (workspaces.data ?? []).find((w) => w.id === wsId)
  const isAdmin = ws?.can?.manage ?? (ws?.role === 'owner' || ws?.role === 'admin')

  return (
    <Modal open={open} onClose={onClose} title={t('lock.title')}>
      {isPrivate ? (
        <p className="text-sm text-sub">{t('lock.privateUnavailable')}</p>
      ) : lock.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner size={20} />
        </div>
      ) : !lock.data ? (
        <p className="text-sm text-red-600">
          {lock.error instanceof ApiError ? lock.error.message : t('common.unknownError')}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <LockSection wsId={wsId} page={page} lock={lock.data} onNavigate={onClose} />
          {isAdmin && (
            <InstructionsSection wsId={wsId} page={page} lock={lock.data} onNavigate={onClose} />
          )}
        </div>
      )}
    </Modal>
  )
}

function LockSection({
  wsId,
  page,
  lock,
  onNavigate,
}: {
  wsId: string
  page: PageMetaDTO
  lock: PageLockDTO
  onNavigate: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const setLock = useSetPageLock(page.id, wsId)
  const members = useMembers(wsId)
  const [error, setError] = useState<string | null>(null)

  const inherited = lock.locked && !lock.own && !!lock.lockRoot && lock.lockRoot.id !== page.id
  const agentRule = agentRuleLine(lock)

  const change = (input: SetPageLockInput) => {
    setError(null)
    setLock.mutate(input, {
      onError: (e) => setError(e instanceof ApiError ? e.message : t('lock.saveFailed')),
    })
  }

  // Owners and admins always edit, and the lock owner edits by default: offer everyone else.
  const editorIds = new Set(lock.editors.map((e) => e.id))
  const candidates = (members.data ?? []).filter(
    (m) => m.role === 'member' && m.id !== lock.owner?.id && !editorIds.has(m.id),
  )

  return (
    <section className="flex flex-col gap-2 text-sm">
      {inherited && lock.lockRoot && (
        <div className="flex items-center gap-2 rounded-md border border-line bg-hover/40 px-3 py-2 text-xs text-sub">
          <LockIcon size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('lock.inheritedFrom', { title: lock.lockRoot.title || t('common.untitled') })}
          </span>
          <button
            type="button"
            onClick={() => {
              onNavigate()
              navigate(`/w/${wsId}/p/${lock.lockRoot!.id}`)
            }}
            className="shrink-0 rounded px-1.5 py-0.5 text-accent hover:bg-hover"
          >
            {t('lock.openRoot')}
          </button>
        </div>
      )}

      {lock.locked ? (
        <div className="text-xs text-sub">
          <p>{editableByLine(lock)}</p>
          {agentRule && <p>{agentRule}</p>}
          <p className="mt-0.5">{t(lock.canEdit ? 'lock.canEditHint' : 'lock.readOnlyHint')}</p>
        </div>
      ) : (
        <p className="text-xs text-sub">{t('lock.notLocked')}</p>
      )}

      {lock.canManage ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <label className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-sm text-ink">{t('lock.toggle')}</span>
            {setLock.isPending && <Spinner size={12} />}
            <Toggle
              checked={lock.own}
              disabled={setLock.isPending}
              label={t('lock.toggle')}
              onChange={(v) => change({ locked: v })}
            />
          </label>
          <p className="text-xs text-sub">{t(inherited && !lock.own ? 'lock.nestedHint' : 'lock.toggleHint')}</p>
          {lock.own && lock.instructions && (
            <p className="text-xs text-amber-600">{t('lock.unlockDropsInstructions')}</p>
          )}

          {lock.own && (
            <>
              <label className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-sub">{t('lock.people')}</span>
                <select
                  value={lock.people ?? 'editors'}
                  disabled={setLock.isPending}
                  aria-label={t('lock.people')}
                  onChange={(e) => change({ locked: true, people: e.target.value as LockPeople })}
                  className={selectClass}
                >
                  {(Object.keys(PEOPLE_LABEL) as LockPeople[]).map((p) => (
                    <option key={p} value={p}>
                      {t(PEOPLE_LABEL[p])}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-sub">{t('lock.agents')}</span>
                <select
                  value={lock.agents ?? 'same'}
                  disabled={setLock.isPending}
                  aria-label={t('lock.agents')}
                  onChange={(e) => change({ locked: true, agents: e.target.value as LockAgents })}
                  className={selectClass}
                >
                  {(Object.keys(AGENTS_LABEL) as LockAgents[]).map((a) => (
                    <option key={a} value={a}>
                      {t(AGENTS_LABEL[a])}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-sub">{t('lock.agentsHint')}</p>

              {(lock.people ?? 'editors') === 'editors' && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-sub">{t('lock.editors')}</span>
                  <p className="text-xs text-sub">
                    {lock.owner ? t('lock.owner', { name: lock.owner.name }) : t('lock.noOwner')}
                  </p>
                  {lock.editors.length === 0 ? (
                    <p className="text-xs text-sub">{t('lock.noEditors')}</p>
                  ) : (
                    <ul className="flex flex-wrap gap-1.5">
                      {lock.editors.map((e) => (
                        <li
                          key={e.id}
                          className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink"
                        >
                          {e.name}
                          <button
                            type="button"
                            disabled={setLock.isPending}
                            aria-label={t('lock.removeEditor', { name: e.name })}
                            title={t('lock.removeEditor', { name: e.name })}
                            onClick={() =>
                              change({
                                locked: true,
                                editorIds: lock.editors.filter((x) => x.id !== e.id).map((x) => x.id),
                              })
                            }
                            className="rounded-full text-sub hover:text-ink disabled:opacity-60"
                          >
                            <XIcon size={11} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {candidates.length > 0 && (
                    <select
                      value=""
                      disabled={setLock.isPending}
                      aria-label={t('lock.addEditor')}
                      onChange={(e) => {
                        if (!e.target.value) return
                        change({ locked: true, editorIds: [...lock.editors.map((x) => x.id), e.target.value] })
                      }}
                      className={selectClass}
                    >
                      <option value="">{t('lock.addEditor')}</option>
                      {candidates.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <p className="text-xs text-sub">{t('lock.notManager')}</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  )
}

function InstructionsSection({
  wsId,
  page,
  lock,
  onNavigate,
}: {
  wsId: string
  page: PageMetaDTO
  lock: PageLockDTO
  onNavigate: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const list = useWorkspaceAgentInstructions(wsId)
  const others = (list.data ?? []).filter((i) => i.pageId !== page.id)
  const eligible = page.kind === 'doc' && page.scope !== 'private'

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3 text-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-sub">{t('instructions.title')}</h3>
      <p className="text-xs text-sub">{t('instructions.hint')}</p>
      {eligible ? (
        // Remount the form when the saved designation changes so it starts from the server state.
        <InstructionsForm
          key={JSON.stringify(lock.instructions)}
          wsId={wsId}
          pageId={page.id}
          current={lock.instructions}
        />
      ) : (
        <p className="text-xs text-sub">{t('instructions.onlyDocs')}</p>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-sub">{t('instructions.others')}</span>
        {list.isLoading ? (
          <Spinner size={12} />
        ) : others.length === 0 ? (
          <p className="text-xs text-sub">{t('instructions.none')}</p>
        ) : (
          <ul className="flex flex-col">
            {others.map((i) => (
              <li key={i.pageId}>
                <button
                  type="button"
                  onClick={() => {
                    onNavigate()
                    navigate(`/w/${wsId}/p/${i.pageId}`)
                  }}
                  className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-ink">{i.title || t('common.untitled')}</span>
                  <span className="shrink-0 text-sub">{t(MODE_LABEL[i.mode])}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function InstructionsForm({
  wsId,
  pageId,
  current,
}: {
  wsId: string
  pageId: string
  current: AgentInstructionDTO | null
}) {
  const t = useT()
  const save = useSetAgentInstructions(pageId, wsId)
  const remove = useRemoveAgentInstructions(pageId, wsId)
  const [mode, setMode] = useState<AgentInstructionMode>(current?.mode ?? 'always')
  const [applyTo, setApplyTo] = useState((current?.applyTo ?? []).join('\n'))
  const [description, setDescription] = useState(current?.description ?? '')
  const [sortOrder, setSortOrder] = useState(String(current?.sortOrder ?? 0))
  const [error, setError] = useState<string | null>(null)
  const busy = save.isPending || remove.isPending

  const entries = applyTo
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const onErr = (e: unknown) => setError(e instanceof ApiError ? e.message : t('instructions.saveFailed'))

  const submit = () => {
    setError(null)
    if (mode === 'match' && entries.length === 0) return setError(t('instructions.applyToRequired'))
    if (entries.length > MAX_APPLY_TO) return setError(t('instructions.applyToTooMany', { max: MAX_APPLY_TO }))
    const order = Number.parseInt(sortOrder, 10)
    save.mutate(
      {
        mode,
        applyTo: mode === 'match' ? entries : undefined,
        description: description.trim(),
        sortOrder: Number.isFinite(order) ? order : 0,
      },
      { onError: onErr },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {current && <p className="text-xs font-medium text-accent">{t('instructions.designated')}</p>}
      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-xs text-sub">{t('instructions.mode')}</span>
        <select
          value={mode}
          disabled={busy}
          aria-label={t('instructions.mode')}
          onChange={(e) => setMode(e.target.value as AgentInstructionMode)}
          className={selectClass}
        >
          {(Object.keys(MODE_LABEL) as AgentInstructionMode[]).map((m) => (
            <option key={m} value={m}>
              {t(MODE_LABEL[m])}
            </option>
          ))}
        </select>
      </label>
      {mode === 'match' && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-sub">{t('instructions.applyTo')}</span>
          <textarea
            value={applyTo}
            rows={3}
            disabled={busy}
            aria-label={t('instructions.applyTo')}
            placeholder={'Projects/**\nSpecs/*'}
            onChange={(e) => setApplyTo(e.target.value)}
            className={`${inputClass} font-mono`}
          />
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[11px] text-sub">{t('instructions.applyToHint')}</p>
            <button
              type="button"
              disabled={busy || entries.includes(`page:${pageId}`)}
              onClick={() => setApplyTo((v) => (v.trim() ? `${v.trimEnd()}\npage:${pageId}` : `page:${pageId}`))}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-hover disabled:opacity-50"
            >
              {t('instructions.addThisSubtree')}
            </button>
          </div>
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-sub">{t('instructions.description')}</span>
        <input
          value={description}
          maxLength={300}
          disabled={busy}
          placeholder={t('instructions.descriptionPlaceholder')}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-xs text-sub">{t('instructions.sortOrder')}</span>
        <input
          type="number"
          value={sortOrder}
          disabled={busy}
          onChange={(e) => setSortOrder(e.target.value)}
          className={`${inputClass} w-24`}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending && <Spinner size={12} className="border-white/40 border-t-white" />}
          {t(current ? 'instructions.save' : 'instructions.designate')}
        </button>
        {current && (
          <button
            type="button"
            onClick={() => {
              setError(null)
              remove.mutate(undefined, { onError: onErr })
            }}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-60"
          >
            {remove.isPending && <Spinner size={12} className="border-red-600/40 border-t-red-600" />}
            {t('instructions.remove')}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
