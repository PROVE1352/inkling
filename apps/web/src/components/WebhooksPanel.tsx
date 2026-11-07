import { useState } from 'react'
import type { WebhookDTO, WebhookEvent } from '@inkling/shared'
import { WEBHOOK_EVENTS } from '@inkling/shared'
import {
  ApiError,
  useCreateWebhook,
  useDeleteWebhook,
  useTestWebhook,
  useUpdateWebhook,
  useWebhooks,
} from '../api'
import { PlugIcon, TrashIcon } from './Icons'
import { Spinner } from './Spinner'
import { t } from '../i18n'

// Workspace → Slack / Discord notifications (owners only), including the daily review_due digest. The webhook URL is a secret: the
// server returns only a masked form after creation. Pages in the private (🔒) section are never
// sent; messages are a one-line summary + link. See docs/adr/0504-workspace-webhooks.md.

// UI strings — getters so each read follows the current language.
const T = {
  get title() { return t('webhooks.title') },
  get intro() { return t('webhooks.intro') },
  get urlLabel() { return t('webhooks.urlLabel') },
  get urlPlaceholder() { return t('webhooks.urlPlaceholder') },
  get add() { return t('webhooks.add') },
  get test() { return t('webhooks.test') },
  get testOk() { return t('webhooks.testOk') },
  testFail: (e: string) => t('webhooks.testFail', { error: e }),
  get remove() { return t('common.remove') },
  get enabled() { return t('webhooks.enabled') },
  get autoDisabled() { return t('webhooks.autoDisabled') },
  lastError: (e: string) => t('webhooks.lastError', { error: e }),
  get empty() { return t('webhooks.empty') },
  get needEvent() { return t('webhooks.needEvent') },
  get genericError() { return t('common.unknownError') },
  events: {
    get mention() { return t('webhooks.eventMention') },
    get comment() { return t('webhooks.eventComment') },
    get reminder() { return t('webhooks.eventReminder') },
    get page_created() { return t('webhooks.eventPageCreated') },
    get review_due() { return t('webhooks.eventReviewDue') },
  } satisfies Record<WebhookEvent, string>,
  kind: { slack: 'Slack', discord: 'Discord' },
}

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

function HookRow({ wsId, hook }: { wsId: string; hook: WebhookDTO }) {
  const update = useUpdateWebhook(wsId)
  const del = useDeleteWebhook(wsId)
  const test = useTestWebhook(wsId)
  const [note, setNote] = useState<string | null>(null)
  const busy = update.isPending || del.isPending || test.isPending

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex items-center gap-2">
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
      {hook.lastError && <p className="text-xs text-sub">{T.lastError(hook.lastError)}</p>}
      {note && <p className="text-xs text-sub">{note}</p>}
      <div className="flex items-center gap-2">
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
          className="rounded-md border border-line px-2 py-1 text-xs text-ink transition duration-150 hover:bg-hover active:scale-[.98] disabled:opacity-60"
        >
          {test.isPending ? <Spinner size={12} /> : T.test}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => del.mutate(hook.id, { onError: (e) => setNote(errMsg(e)) })}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sub transition duration-150 hover:bg-hover hover:text-red-600 disabled:opacity-60"
        >
          <TrashIcon size={13} /> {T.remove}
        </button>
      </div>
    </li>
  )
}

/** Webhooks tab of the workspace settings screen (owners). */
export function WebhooksPanel({ wsId }: { wsId: string }) {
  const hooks = useWebhooks(wsId)
  const create = useCreateWebhook(wsId)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEvent[]>(['mention', 'comment'])
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (events.length === 0) return setError(T.needEvent)
    create.mutate(
      { url: url.trim(), events },
      {
        onSuccess: () => setUrl(''),
        onError: (err) => setError(errMsg(err)),
      },
    )
  }

  return (
    <div className="rounded-lg border border-line p-4">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-sub">{T.intro}</p>
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label className="text-xs font-medium text-ink" htmlFor="webhook-url">
            {T.urlLabel}
          </label>
          <input
            id="webhook-url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={T.urlPlaceholder}
            autoComplete="off"
            className="rounded-md border border-line bg-app px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
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
