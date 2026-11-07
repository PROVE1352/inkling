import { useState } from 'react'
import type { WebhookDeliveryDTO, WebhookDTO, WebhookEvent } from '@inkling/shared'
import { WEBHOOK_EVENTS } from '@inkling/shared'
import {
  ApiError,
  useCreateWebhook,
  useDeleteWebhook,
  useResendWebhookDelivery,
  useRotateWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhooks,
} from '../api'
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, KeyIcon, PlugIcon, TrashIcon } from './Icons'
import { Spinner } from './Spinner'
import { t } from '../i18n'
import { askConfirm } from '../lib/confirm'
import { formatDateTime, relativeTime } from '../lib/time'

// Workspace → Slack / Discord notifications and generic signed JSON webhooks (owners only),
// including the daily digests. The webhook URL and the signing secret are secrets: the server
// returns a masked URL, and the secret only once (on create and on rotation). Pages in the private
// (🔒) section are never sent. See docs/adr/0504-*, 1190-*, 1191-*, 1192-*, docs/WEBHOOKS.md.

// UI strings — getters so each read follows the current language.
const T = {
  get intro() { return t('webhooks.introAll') },
  get urlLabel() { return t('webhooks.urlLabel') },
  get urlPlaceholder() { return t('webhooks.urlPlaceholder') },
  get genericUrlLabel() { return t('webhooks.genericUrlLabel') },
  get genericUrlPlaceholder() { return t('webhooks.genericUrlPlaceholder') },
  get genericHint() { return t('webhooks.genericHint') },
  get kindLabel() { return t('webhooks.kindLabel') },
  get add() { return t('webhooks.add') },
  get test() { return t('webhooks.test') },
  get testEvent() { return t('webhooks.testEvent') },
  get testOk() { return t('webhooks.testOk') },
  testFail: (e: string) => t('webhooks.testFail', { error: e }),
  get remove() { return t('common.remove') },
  get enabled() { return t('webhooks.enabled') },
  get autoDisabled() { return t('webhooks.autoDisabled') },
  lastError: (e: string) => t('webhooks.lastError', { error: e }),
  failingSince: (time: string) => t('webhooks.failingSince', { time }),
  get empty() { return t('webhooks.empty') },
  get needEvent() { return t('webhooks.needEvent') },
  get genericError() { return t('common.unknownError') },
  get secretTitle() { return t('webhooks.secretTitle') },
  get secretOnce() { return t('webhooks.secretOnce') },
  get copy() { return t('webhooks.copy') },
  get copied() { return t('webhooks.copied') },
  get secretDone() { return t('webhooks.secretDone') },
  get secretSet() { return t('webhooks.secretSet') },
  secretOldUntil: (time: string) => t('webhooks.secretOldUntil', { time }),
  get rotate() { return t('webhooks.rotate') },
  get rotateConfirm() { return t('webhooks.rotateConfirm') },
  get rotateRevokeConfirm() { return t('webhooks.rotateRevokeConfirm') },
  get rotateOk() { return t('webhooks.rotateOk') },
  get revokeOld() { return t('webhooks.revokeOld') },
  get deliveries() { return t('webhooks.deliveries') },
  get deliveriesEmpty() { return t('webhooks.deliveriesEmpty') },
  attempts: (count: number) => t('webhooks.attempts', { count }),
  nextRetry: (time: string) => t('webhooks.nextRetry', { time }),
  get resend() { return t('webhooks.resend') },
  get resent() { return t('webhooks.resent') },
  response: (text: string) => t('webhooks.response', { text }),
  ms: (ms: number) => t('webhooks.ms', { ms }),
  status: {
    get ok() { return t('webhooks.statusOk') },
    get retrying() { return t('webhooks.statusRetrying') },
    get failed() { return t('webhooks.statusFailed') },
  } satisfies Record<WebhookDeliveryDTO['status'], string>,
  events: {
    get mention() { return t('webhooks.eventMention') },
    get comment() { return t('webhooks.eventComment') },
    get reminder() { return t('webhooks.eventReminder') },
    get page_created() { return t('webhooks.eventPageCreated') },
    get review_due() { return t('webhooks.eventReviewDue') },
    get assigned() { return t('webhooks.eventAssigned') },
    get agent_digest() { return t('webhooks.eventAgentDigest') },
    get test() { return t('webhooks.eventTest') },
  } satisfies Record<WebhookEvent | 'test', string>,
  kind: {
    slack: 'Slack',
    discord: 'Discord',
    get generic() { return t('webhooks.kindGeneric') },
  },
}

const btn =
  'rounded-md border border-line px-2 py-1 text-xs text-ink transition duration-150 hover:bg-hover active:scale-[.98] disabled:opacity-60'

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : T.genericError
}

function EventPicker({
  value,
  onChange,
  disabled,
}: {
  value: WebhookEvent[]
  onChange: (v: WebhookEvent[]) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {WEBHOOK_EVENTS.map((ev) => (
        <label key={ev} className="flex items-center gap-1.5 text-xs text-sub">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.includes(ev)}
            onChange={(e) => onChange(e.target.checked ? [...value, ev] : value.filter((x) => x !== ev))}
          />
          {T.events[ev]}
        </label>
      ))}
    </div>
  )
}

/** A freshly created or rotated secret: shown once, with copy. */
function SecretOnce({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-accent/50 bg-accent/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
        <KeyIcon size={13} /> {T.secretTitle}
      </p>
      <p className="text-xs text-sub">{T.secretOnce}</p>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-app px-2 py-1 font-mono text-xs text-ink" data-testid="webhook-secret">
          {secret}
        </code>
        <button
          type="button"
          className={`${btn} flex shrink-0 items-center gap-1`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret)
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          <CopyIcon size={12} /> {copied ? T.copied : T.copy}
        </button>
      </div>
      <div>
        <button type="button" className={btn} onClick={onDone}>
          {T.secretDone}
        </button>
      </div>
    </div>
  )
}

function statusClass(s: WebhookDeliveryDTO['status']): string {
  if (s === 'ok') return 'text-emerald-700 dark:text-emerald-400'
  if (s === 'retrying') return 'text-amber-700 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function DeliveryRow({ hookId, d, hookEnabled }: { hookId: string; d: WebhookDeliveryDTO; hookEnabled: boolean }) {
  const resend = useResendWebhookDelivery(hookId)
  const [note, setNote] = useState<string | null>(null)
  const result = d.statusCode !== null ? `HTTP ${d.statusCode}` : (d.error ?? '')
  return (
    <li className="flex flex-col gap-1 border-t border-line py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className={`font-medium ${statusClass(d.status)}`}>{T.status[d.status]}</span>
        <span className="text-ink">{T.events[d.event] ?? d.event}</span>
        <span className="font-mono text-sub">{result}</span>
        {d.durationMs !== null && <span className="text-sub">{T.ms(d.durationMs)}</span>}
        <span className="text-sub">{T.attempts(d.attempts)}</span>
        <span className="text-sub" title={formatDateTime(d.updatedAt)}>
          {relativeTime(d.updatedAt)}
        </span>
        {d.canResend && (
          <button
            type="button"
            disabled={!hookEnabled || resend.isPending || d.status === 'retrying'}
            onClick={() => {
              setNote(null)
              resend.mutate(d.id!, { onSuccess: () => setNote(T.resent), onError: (e) => setNote(errMsg(e)) })
            }}
            className={`${btn} ml-auto py-0.5`}
          >
            {resend.isPending ? <Spinner size={11} /> : T.resend}
          </button>
        )}
      </div>
      {d.status === 'retrying' && d.nextAttemptAt && (
        <p className="text-xs text-sub" title={formatDateTime(d.nextAttemptAt)}>
          {T.nextRetry(relativeTime(d.nextAttemptAt))}
        </p>
      )}
      {d.statusCode !== null && d.error && d.error !== `HTTP ${d.statusCode}` && <p className="text-xs text-sub">{d.error}</p>}
      {d.responseExcerpt && <p className="break-all font-mono text-[11px] text-sub">{T.response(d.responseExcerpt)}</p>}
      {d.id && <p className="font-mono text-[10px] text-sub/80">X-Inkling-Delivery: {d.id}</p>}
      {note && <p className="text-xs text-sub">{note}</p>}
    </li>
  )
}

function Deliveries({ hook }: { hook: WebhookDTO }) {
  const [open, setOpen] = useState(false)
  const q = useWebhookDeliveries(hook.id, open)
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs font-medium text-ink hover:bg-hover"
      >
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />} {T.deliveries}
      </button>
      {open &&
        (q.isLoading ? (
          <Spinner size={14} />
        ) : q.data && q.data.length > 0 ? (
          <ul className="flex flex-col rounded-md border border-line px-2">
            {q.data.map((d, i) => (
              <DeliveryRow key={d.id ?? `t${i}-${d.createdAt}`} hookId={hook.id} d={d} hookEnabled={hook.enabled} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-sub">{q.isError ? errMsg(q.error) : T.deliveriesEmpty}</p>
        ))}
    </div>
  )
}

function HookRow({ wsId, hook }: { wsId: string; hook: WebhookDTO }) {
  const update = useUpdateWebhook(wsId)
  const del = useDeleteWebhook(wsId)
  const test = useTestWebhook(wsId)
  const rotate = useRotateWebhookSecret(wsId)
  const [note, setNote] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [revokeOld, setRevokeOld] = useState(false)
  const busy = update.isPending || del.isPending || test.isPending || rotate.isPending
  const generic = hook.kind === 'generic'

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] font-medium text-sub">{T.kind[hook.kind]}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={hook.urlMasked}>
          {hook.urlMasked}
        </span>
        <label className="flex items-center gap-1 text-xs text-sub">
          <input
            type="checkbox"
            checked={hook.enabled}
            disabled={busy}
            onChange={(e) => update.mutate({ id: hook.id, enabled: e.target.checked })}
          />
          {T.enabled}
        </label>
      </div>
      <EventPicker
        value={hook.events}
        disabled={busy}
        onChange={(events) => update.mutate({ id: hook.id, events })}
      />
      {hook.autoDisabledAt && !hook.enabled && <p className="text-xs text-red-600">{T.autoDisabled}</p>}
      {hook.enabled && generic && hook.failingSince && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{T.failingSince(formatDateTime(hook.failingSince))}</p>
      )}
      {hook.lastError && <p className="text-xs text-sub">{T.lastError(hook.lastError)}</p>}
      {generic && !secret && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-sub">
          <span className="flex items-center gap-1">
            <KeyIcon size={12} /> {T.secretSet}
          </span>
          {hook.previousSecretUntil && <span>{T.secretOldUntil(formatDateTime(hook.previousSecretUntil))}</span>}
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={revokeOld} disabled={busy} onChange={(e) => setRevokeOld(e.target.checked)} />
            {T.revokeOld}
          </label>
        </div>
      )}
      {secret && <SecretOnce secret={secret} onDone={() => setSecret(null)} />}
      {note && <p className="text-xs text-sub">{note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setNote(null)
            test.mutate(hook.id, {
              onSuccess: (r) => setNote(r.ok ? T.testOk : T.testFail(r.error ?? t('webhooks.unknown'))),
              onError: (e) => setNote(errMsg(e)),
            })
          }}
          className={btn}
        >
          {test.isPending ? <Spinner size={12} /> : generic ? T.testEvent : T.test}
        </button>
        {generic && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!(await askConfirm(revokeOld ? T.rotateRevokeConfirm : T.rotateConfirm, T.rotateOk))) return
              setNote(null)
              rotate.mutate(
                { id: hook.id, keepPrevious: !revokeOld },
                { onSuccess: (r) => setSecret(r.secret), onError: (e) => setNote(errMsg(e)) },
              )
            }}
            className={`${btn} flex items-center gap-1`}
          >
            {rotate.isPending ? <Spinner size={12} /> : <KeyIcon size={12} />} {T.rotate}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => del.mutate(hook.id, { onError: (e) => setNote(errMsg(e)) })}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sub transition duration-150 hover:bg-hover hover:text-red-600 disabled:opacity-60"
        >
          <TrashIcon size={13} /> {T.remove}
        </button>
      </div>
      <Deliveries hook={hook} />
    </li>
  )
}

/** Webhooks tab of the workspace settings screen (owners). */
export function WebhooksPanel({ wsId }: { wsId: string }) {
  const hooks = useWebhooks(wsId)
  const create = useCreateWebhook(wsId)
  const [kind, setKind] = useState<'chat' | 'generic'>('chat')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEvent[]>(['mention', 'comment'])
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (events.length === 0) return setError(T.needEvent)
    create.mutate(
      { url: url.trim(), events, ...(kind === 'generic' ? { kind: 'generic' as const } : {}) },
      {
        onSuccess: (r) => {
          setUrl('')
          setCreated(r.secret)
        },
        onError: (err) => setError(errMsg(err)),
      },
    )
  }

  return (
    <div className="rounded-lg border border-line p-4">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-sub">{T.intro}</p>
        <form onSubmit={submit} className="flex flex-col gap-2">
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <legend className="sr-only">{T.kindLabel}</legend>
            {(['chat', 'generic'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-xs text-ink">
                <input type="radio" name="webhook-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                {k === 'chat' ? t('webhooks.kindChat') : T.kind.generic}
              </label>
            ))}
          </fieldset>
          <label className="text-xs font-medium text-ink" htmlFor="webhook-url">
            {kind === 'generic' ? T.genericUrlLabel : T.urlLabel}
          </label>
          <input
            id="webhook-url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={kind === 'generic' ? T.genericUrlPlaceholder : T.urlPlaceholder}
            autoComplete="off"
            className="rounded-md border border-line bg-app px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
          {kind === 'generic' && <p className="text-xs text-sub">{T.genericHint}</p>}
          <EventPicker value={events} onChange={setEvents} />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={create.isPending || !url.trim()}
            className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition duration-150 active:scale-[.98] disabled:opacity-60"
          >
            {create.isPending ? <Spinner size={14} /> : <PlugIcon size={14} />} {T.add}
          </button>
        </form>
        {created && <SecretOnce secret={created} onDone={() => setCreated(null)} />}
        {hooks.isLoading ? (
          <Spinner size={16} />
        ) : hooks.data && hooks.data.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {hooks.data.map((h) => (
              <HookRow key={h.id} wsId={wsId} hook={h} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-sub">{hooks.isError ? errMsg(hooks.error) : T.empty}</p>
        )}
      </div>
    </div>
  )
}
