import { useEffect, useState, type ReactNode } from 'react'
import type { SlackEventKind, SlackIntegrationDTO, SlackLinkDTO, SlackSetupInfo } from '@inkling/shared'
import {
  SLACK_EVENT_KINDS,
  slackBotTokenSchema,
  slackChannelIdSchema,
  slackSigningSecretSchema,
} from '@inkling/shared'
import { ApiError } from '../api'
import {
  useDisconnectSlack,
  useRemoveSlackLink,
  useSaveSlackSettings,
  useSlackLinks,
  useSlackSettings,
  useTestSlack,
} from '../slackApi'
import { CheckIcon, CopyIcon, PlugIcon, TrashIcon } from './Icons'
import { Group, Row, Toggle } from './SettingsRows'
import { Spinner } from './Spinner'
import { fmtDateTime, fmtRelative, useT, type TKey } from '../i18n'
import { askConfirm } from '../lib/confirm'

// Workspace → Slack app (owners): setup help with the manifest, the connection form, status, test,
// disconnect and the linked Slack accounts (docs/adr/1800-* .. 1806-*). The bot token and signing
// secret are write-only: the server never returns them, the inputs start empty, are cleared after a
// save, and nothing here renders or logs what was typed.

const EVENT_LABEL: Record<SlackEventKind, { label: TKey; desc: TKey }> = {
  mention: { label: 'slack.eventMention', desc: 'slack.eventMentionDesc' },
  assigned: { label: 'slack.eventAssigned', desc: 'slack.eventAssignedDesc' },
  suggestion: { label: 'slack.eventSuggestion', desc: 'slack.eventSuggestionDesc' },
  reply: { label: 'slack.eventReply', desc: 'slack.eventReplyDesc' },
  digest: { label: 'slack.eventDigest', desc: 'slack.eventDigestDesc' },
}

/** Default selection for a new connection: everything but the daily digest. */
const DEFAULT_EVENTS: SlackEventKind[] = ['mention', 'assigned', 'suggestion', 'reply']

const btn =
  'flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink transition duration-150 hover:bg-hover active:scale-[.98] disabled:opacity-60'
const input =
  'w-full rounded-md border border-line bg-app px-2.5 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:opacity-60 sm:w-72'
const warnBox =
  'rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300'
const errBox = 'rounded-md border border-red-500/60 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400'

function useErrMsg() {
  const t = useT()
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.code === 'SLACK_AUTH_FAILED') {
        const code = typeof e.details.slackError === 'string' ? e.details.slackError : e.code
        return t('slack.authFailed', { code })
      }
      if (e.code === 'SLACK_SECRETS_REQUIRED') return t('slack.secretsRequired')
      return e.message
    }
    return t('common.unknownError')
  }
}

function CopyButton({ text }: { text: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(id)
  }, [copied])
  return (
    <button
      type="button"
      className={`${btn} shrink-0`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
        } catch {
          setCopied(false)
        }
      }}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />} {copied ? t('common.copied') : t('common.copy')}
    </button>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="break-all font-mono text-xs text-ink">{children}</code>
}

// ---------------------------------------------------------------------------
// (a) Setup help
// ---------------------------------------------------------------------------

function SetupGroup({ setup }: { setup: SlackSetupInfo }) {
  const t = useT()
  const manifest = JSON.stringify(setup.manifest, null, 2)
  const noDomain = !setup.publicUrlSet || setup.unfurlDomain === null
  return (
    <Group title={t('slack.setupTitle')}>
      <ol className="list-decimal space-y-1 py-3 pl-9 pr-4 text-xs leading-relaxed text-sub">
        {(['slack.step1', 'slack.step2', 'slack.step3', 'slack.step4', 'slack.step5'] as const).map((k) => (
          <li key={k}>{t(k)}</li>
        ))}
      </ol>
      <Row title={t('slack.commandUrl')} desc={<Mono>{setup.commandUrl}</Mono>}>
        <CopyButton text={setup.commandUrl} />
      </Row>
      <Row title={t('slack.eventsUrl')} desc={<Mono>{setup.eventsUrl}</Mono>}>
        <CopyButton text={setup.eventsUrl} />
      </Row>
      <Row title={t('slack.unfurlDomain')} desc={setup.unfurlDomain ? <Mono>{setup.unfurlDomain}</Mono> : '—'}>
        {setup.unfurlDomain && <CopyButton text={setup.unfurlDomain} />}
      </Row>
      {noDomain && (
        <div className="px-4 py-3">
          <p className={warnBox}>{t('slack.noPublicUrl')}</p>
        </div>
      )}
      <Row
        title={t('slack.scopes')}
        desc={
          <span className="mt-1 flex flex-wrap gap-1">
            {setup.scopes.map((s) => (
              <code key={s} className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-ink">
                {s}
              </code>
            ))}
          </span>
        }
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-ink">{t('slack.manifest')}</div>
            <div className="mt-0.5 text-xs text-sub">{t('slack.manifestHint')}</div>
          </div>
          <CopyButton text={manifest} />
        </div>
        <pre
          className="max-h-72 overflow-auto rounded-md border border-line bg-hover/40 p-2 font-mono text-[11px] leading-snug text-ink"
          data-testid="slack-manifest"
        >
          {manifest}
        </pre>
      </div>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// (b) Connection form
// ---------------------------------------------------------------------------

function SlackForm({
  wsId,
  integration,
  setup,
}: {
  wsId: string
  integration: SlackIntegrationDTO | null
  setup: SlackSetupInfo
}) {
  const t = useT()
  const errMsg = useErrMsg()
  const save = useSaveSlackSettings(wsId)
  // Write-only secrets: never prefilled, cleared after a successful save.
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [channelId, setChannelId] = useState(integration?.channelId ?? '')
  const [events, setEvents] = useState<SlackEventKind[]>(integration?.events ?? DEFAULT_EVENTS)
  const [enabled, setEnabled] = useState(integration?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // Follow the stored settings when they change (a save here or elsewhere).
  const stamp = integration?.updatedAt ?? null
  useEffect(() => {
    setChannelId(integration?.channelId ?? '')
    setEvents(integration?.events ?? DEFAULT_EVENTS)
    setEnabled(integration?.enabled ?? true)
  }, [stamp])

  const busy = save.isPending
  const firstTime = integration === null
  // No stored secrets, or ones the server can no longer decrypt: both must be typed again.
  const needSecrets = firstTime || !integration.secretsReadable

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setNote(null)
    const token = botToken.trim()
    const secret = signingSecret.trim()
    const channel = channelId.trim()
    if (needSecrets && (!token || !secret)) return setError(t('slack.secretsRequired'))
    if (token && !slackBotTokenSchema.safeParse(token).success) return setError(t('slack.invalidToken'))
    if (secret && !slackSigningSecretSchema.safeParse(secret).success) return setError(t('slack.invalidSecret'))
    if (!slackChannelIdSchema.safeParse(channel).success) return setError(t('slack.invalidChannel'))
    save.mutate(
      {
        ...(token ? { botToken: token } : {}),
        ...(secret ? { signingSecret: secret } : {}),
        channelId: channel,
        events: SLACK_EVENT_KINDS.filter((k) => events.includes(k)),
        enabled,
      },
      {
        onSuccess: () => {
          setBotToken('')
          setSigningSecret('')
          setNote(t('slack.saved'))
        },
        onError: (err) => setError(errMsg(err)),
      },
    )
  }

  const keep = (saved: boolean, desc: string) => (saved ? `${desc} ${t('slack.keepSaved')}` : desc)

  return (
    <form onSubmit={submit} autoComplete="off">
      <Group title={t('slack.connectionTitle')}>
        <Row
          stack
          title={t('slack.botToken')}
          desc={keep(!needSecrets && !!integration?.botTokenHint, t('slack.botTokenDesc'))}
        >
          <input
            id="slack-bot-token"
            type="password"
            aria-label={t('slack.botToken')}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={integration?.botTokenHint || 'xoxb-…'}
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
            className={input}
          />
        </Row>
        <Row
          stack
          title={t('slack.signingSecret')}
          desc={keep(!needSecrets && !!integration?.signingSecretSet, t('slack.signingSecretDesc'))}
        >
          <input
            id="slack-signing-secret"
            type="password"
            aria-label={t('slack.signingSecret')}
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            placeholder={integration?.signingSecretSet ? t('slack.savedPlaceholder') : ''}
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
            className={input}
          />
        </Row>
        <Row stack title={t('slack.channelId')} desc={t('slack.channelIdDesc')}>
          <input
            id="slack-channel-id"
            type="text"
            aria-label={t('slack.channelId')}
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            placeholder="C0123456789"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className={input}
          />
        </Row>
        <Row title={t('slack.enabled')} desc={t('slack.enabledDesc')}>
          <Toggle checked={enabled} onChange={setEnabled} label={t('slack.enabled')} disabled={busy} />
        </Row>
        {!setup.secretKeySet && (
          <div className="px-4 py-3">
            <p className={warnBox}>{t('slack.noKeyWarning')}</p>
          </div>
        )}
      </Group>

      <Group title={t('slack.eventsTitle')} desc={t('slack.eventsDesc')}>
        {SLACK_EVENT_KINDS.map((k) => (
          <Row key={k} title={t(EVENT_LABEL[k].label)} desc={t(EVENT_LABEL[k].desc)}>
            <Toggle
              checked={events.includes(k)}
              onChange={(on) => setEvents((v) => (on ? [...v.filter((x) => x !== k), k] : v.filter((x) => x !== k)))}
              label={t(EVENT_LABEL[k].label)}
              disabled={busy}
            />
          </Row>
        ))}
      </Group>

      <div className="-mt-4 mb-8 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || !channelId.trim()}
          className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition duration-150 active:scale-[.98] disabled:opacity-60"
        >
          {busy ? <Spinner size={14} /> : <PlugIcon size={14} />} {firstTime ? t('slack.connect') : t('common.save')}
        </button>
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
        {note && !error && (
          <p role="status" className="text-xs text-sub">
            {note}
          </p>
        )}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// (c) Status, test, disconnect
// ---------------------------------------------------------------------------

function When({ iso }: { iso: string | null }) {
  const t = useT()
  if (!iso) return <>{t('slack.never')}</>
  return <span title={fmtDateTime(iso)}>{fmtRelative(iso)}</span>
}

function StatusGroup({ wsId, integration: it }: { wsId: string; integration: SlackIntegrationDTO }) {
  const t = useT()
  const errMsg = useErrMsg()
  const test = useTestSlack(wsId)
  const disconnect = useDisconnectSlack(wsId)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const busy = test.isPending || disconnect.isPending

  return (
    <Group title={t('slack.statusTitle')}>
      {it.blockedReason && (
        <div className="px-4 py-3">
          <div role="alert" className={errBox}>
            <p className="font-medium">{t('slack.blocked', { reason: it.blockedReason })}</p>
            <p className="mt-0.5 text-xs">{t('slack.blockedHint')}</p>
          </div>
        </div>
      )}
      {!it.secretsReadable && (
        <div className="px-4 py-3">
          <p role="alert" className={errBox}>
            {t('slack.unreadable')}
          </p>
        </div>
      )}
      <Row title={t('slack.team')} desc={it.teamName ? <Mono>{it.teamId}</Mono> : undefined}>
        <span className="text-sm text-ink">{it.teamName ?? <Mono>{it.teamId}</Mono>}</span>
      </Row>
      <Row title={t('slack.channel')} desc={it.channelName ? <Mono>{it.channelId}</Mono> : undefined}>
        <span className="text-sm text-ink">{it.channelName ? `#${it.channelName}` : <Mono>{it.channelId}</Mono>}</span>
      </Row>
      <Row
        title={t('slack.storage')}
        desc={
          it.sealed ? (
            t('slack.sealed')
          ) : (
            <span className="text-amber-700 dark:text-amber-400">{t('slack.unsealed')}</span>
          )
        }
      />
      <Row title={t('slack.lastSuccess')}>
        <span className="text-xs text-sub">
          <When iso={it.lastSuccessAt} />
        </span>
      </Row>
      {it.lastError && (
        <Row title={t('slack.lastError')} desc={<span className="break-all font-mono">{it.lastError}</span>}>
          <span className="text-xs text-sub">
            <When iso={it.lastErrorAt} />
          </span>
        </Row>
      )}
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className={btn}
            onClick={() => {
              setNote(null)
              test.mutate(undefined, {
                onSuccess: (r) =>
                  setNote(
                    r.ok
                      ? { ok: true, text: t('slack.testOk') }
                      : { ok: false, text: t('slack.testFail', { error: r.error ?? t('common.unknownError') }) },
                  ),
                onError: (e) => setNote({ ok: false, text: errMsg(e) }),
              })
            }}
          >
            {test.isPending ? <Spinner size={12} /> : <PlugIcon size={12} />} {t('slack.test')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!(await askConfirm(t('slack.disconnectConfirm'), t('slack.disconnect')))) return
              setNote(null)
              disconnect.mutate(undefined, { onError: (e) => setNote({ ok: false, text: errMsg(e) }) })
            }}
            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sub transition duration-150 hover:bg-hover hover:text-red-600 disabled:opacity-60"
          >
            {disconnect.isPending ? <Spinner size={12} /> : <TrashIcon size={13} />} {t('slack.disconnect')}
          </button>
        </div>
        {note && (
          <p
            role="status"
            className={`text-xs ${note.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {note.text}
          </p>
        )}
      </div>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// (d) Linked accounts
// ---------------------------------------------------------------------------

function LinkRow({ wsId, link }: { wsId: string; link: SlackLinkDTO }) {
  const t = useT()
  const errMsg = useErrMsg()
  const remove = useRemoveSlackLink(wsId)
  const [error, setError] = useState<string | null>(null)
  return (
    <Row
      title={link.name}
      desc={
        <>
          <Mono>{link.slackUserId}</Mono>
          {' · '}
          {link.method === 'email' ? t('slack.methodEmail') : t('slack.methodLink')}
          {' · '}
          <span title={fmtDateTime(link.createdAt)}>{fmtRelative(link.createdAt)}</span>
          {error && <span className="block text-red-600">{error}</span>}
        </>
      }
    >
      <button
        type="button"
        disabled={remove.isPending}
        aria-label={`${t('common.remove')}: ${link.name}`}
        onClick={() => {
          setError(null)
          remove.mutate(link.userId, { onError: (e) => setError(errMsg(e)) })
        }}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sub transition duration-150 hover:bg-hover hover:text-red-600 disabled:opacity-60"
      >
        {remove.isPending ? <Spinner size={12} /> : <TrashIcon size={13} />} {t('common.remove')}
      </button>
    </Row>
  )
}

function LinksGroup({ wsId }: { wsId: string }) {
  const t = useT()
  const errMsg = useErrMsg()
  const links = useSlackLinks(wsId)
  return (
    <Group title={t('slack.linksTitle')} desc={t('slack.linksDesc')}>
      {links.isLoading ? (
        <div className="px-4 py-3">
          <Spinner size={14} />
        </div>
      ) : links.data && links.data.length > 0 ? (
        links.data.map((l) => <LinkRow key={l.userId} wsId={wsId} link={l} />)
      ) : (
        <p className="px-4 py-3 text-xs text-sub">{links.isError ? errMsg(links.error) : t('slack.linksEmpty')}</p>
      )}
    </Group>
  )
}

/** Slack tab of the workspace settings screen (owners). */
export function SlackPanel({ wsId }: { wsId: string }) {
  const t = useT()
  const errMsg = useErrMsg()
  const q = useSlackSettings(wsId)

  if (q.isLoading) return <Spinner size={16} />
  if (q.isError || !q.data) return <p className="text-xs text-red-600">{errMsg(q.error)}</p>

  const { integration, setup } = q.data
  return (
    <div className="flex flex-col">
      <p className="mb-6 px-1 text-xs leading-relaxed text-sub">{t('slack.intro')}</p>
      {!integration && <SetupGroup setup={setup} />}
      {integration && <StatusGroup wsId={wsId} integration={integration} />}
      <SlackForm wsId={wsId} integration={integration} setup={setup} />
      {integration && <LinksGroup wsId={wsId} />}
      {integration && <SetupGroup setup={setup} />}
    </div>
  )
}
