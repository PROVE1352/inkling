import { useState } from 'react'
import { Link } from 'react-router'
import {
  AGENT_TOKEN_DEFAULT_EXPIRY_DAYS,
  AGENT_TOKEN_EXPIRY_DAYS,
  AGENT_TOKEN_NAME_MAX,
  API_TOKEN_EXPIRY_DAYS,
  API_TOKEN_NAME_MAX,
} from '@inkling/shared'
import type { AccessRange, AgentTokenDTO, AgentTokenExpiryDays, ApiTokenDTO, SuggestOnlyDTO } from '@inkling/shared'
import { ApiError, useOAuthGrants, useRevokeOAuthGrant } from '../api'
import type { OAuthGrantDTO } from '../api'
import { useApiTokens, useCreateApiToken, useRevokeApiToken, useUpdateApiToken, useUpdateGrantRange } from '../apiTokens'
import {
  useAgentTokens,
  useCreateAgentToken,
  useReleaseConnection,
  useRevokeAgentToken,
  useUpdateAgentTokenRange,
} from '../agentTokens'
import { RangeBadge, RangePicker, rangeFromView } from '../components/RangePicker'
import { Spinner } from '../components/Spinner'
import { McpSetup } from '../components/McpSetup'
import { fmtDate, fmtRelative, useT } from '../i18n'

/**
 * Connections (/settings/connections): connection settings for AI apps (docs/adr/2020-*), agent connection tokens for
 * apps that cannot sign in (docs/adr/2060-*), the connected apps with their access and range (docs/adr/1200-*), and
 * personal API tokens for scripts and inklingctl (docs/adr/1201-*). Disconnecting or revoking cuts access at once; a
 * connection that is suggest-only after flagged content says so and its owner can lift it (docs/adr/2042-*).
 */
export function Connections() {
  const t = useT()
  const grants = useOAuthGrants()
  const revoke = useRevokeOAuthGrant()
  // The agent connection token made on this screen a moment ago: shown once in its section and filled into the
  // connection settings while it is shown. React state only, never storage or the URL (docs/adr/2020-*, 2063-*).
  // A personal API token is never handed to the generator: it would be refused at /mcp (docs/adr/1201-*).
  const [agentSecret, setAgentSecret] = useState<string | null>(null)

  return (
    <div className="min-h-full bg-app px-4 py-12">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-ink">{t('connections.title')}</h1>
          <Link to="/" className="text-xs text-accent hover:underline">
            ← {t('common.back')}
          </Link>
        </div>

        <McpSetup origin={window.location.origin} secret={agentSecret} />

        <AgentTokensSection secret={agentSecret} setSecret={setAgentSecret} />

        <section className="flex flex-col gap-2 rounded-lg border border-line p-4">
          <h2 className="text-sm font-semibold text-ink">{t('connections.apps')}</h2>
          {grants.isLoading ? (
            <div className="flex justify-center py-4">
              <Spinner size={18} />
            </div>
          ) : grants.isError ? (
            <p className="text-xs text-red-600">{t('connections.loadFailed')}</p>
          ) : !grants.data || grants.data.length === 0 ? (
            <p className="text-xs text-sub">{t('connections.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {grants.data.map((g) => (
                <GrantRow key={g.id} grant={g} onRevoke={() => revoke.mutate(g.id)} revoking={revoke.isPending} />
              ))}
            </ul>
          )}
        </section>

        <ApiTokensSection />
      </div>
    </div>
  )
}

function AccessBadge({ access }: { access: 'read' | 'write' | undefined }) {
  const t = useT()
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
        access === 'read' ? 'bg-hover text-sub' : 'bg-accent/10 text-accent'
      }`}
    >
      {access === 'read' ? t('connections.readOnly') : t('connections.readWrite')}
    </span>
  )
}

/** "Suggestions only until HH:MM" and, for the connection's owner (this screen), the button that lifts it. */
export function SuggestOnlyLine({ state, connection }: { state: SuggestOnlyDTO | null | undefined; connection: string }) {
  const t = useT()
  const release = useReleaseConnection()
  if (!state) return null
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="suggest-only">
      <span
        className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
        title={t('suggestOnly.tooltip')}
      >
        {t('suggestOnly.badge', { time: fmtDate(state.until, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) })}
      </span>
      <button
        type="button"
        disabled={release.isPending}
        onClick={() => release.mutate(connection)}
        className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-hover disabled:opacity-60"
      >
        {t('suggestOnly.release')}
      </button>
      {release.isError && <span className="text-[11px] text-red-600">{t('suggestOnly.releaseFailed')}</span>}
    </div>
  )
}

function GrantRow({
  grant: g,
  onRevoke,
  revoking,
}: {
  grant: OAuthGrantDTO & { suggestOnly?: SuggestOnlyDTO | null }
  onRevoke: () => void
  revoking: boolean
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<AccessRange | null>(null)
  const update = useUpdateGrantRange()
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm text-ink">{g.clientName}</span>
            {g.clientHost && (
              <span className="truncate text-xs text-sub" data-testid="connection-client-host">
                {t('oauthCimd.connectionHost', { host: g.clientHost })}
              </span>
            )}
            <AccessBadge access={g.access} />
            <RangeBadge range={g.range} />
          </div>
          <div className="text-xs text-sub">
            {t('connections.meta', {
              connected: fmtRelative(g.createdAt),
              lastUsed: g.lastUsedAt ? fmtRelative(g.lastUsedAt) : t('connections.never'),
            })}
          </div>
          <SuggestOnlyLine state={g.suggestOnly} connection={`grant:${g.id}`} />
        </div>
        <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
          >
            {t('range.change')}
          </button>
          <button
            type="button"
            disabled={revoking}
            onClick={onRevoke}
            className="rounded-md border border-line px-2 py-1 text-xs text-red-600 hover:bg-hover disabled:opacity-60"
          >
            {t('connections.revoke')}
          </button>
        </div>
      </div>
      {editing && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-2">
          <RangePicker
            name={`grant-range-${g.id}`}
            initial={rangeFromView(g.range)}
            initialWorkspaceId={g.range?.kind === 'subtree' ? g.range.page.workspaceId : null}
            onChange={setDraft}
          />
          {update.isError && (
            <p className="text-xs text-red-600">{update.error instanceof ApiError ? update.error.message : ''}</p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover">
              {t('range.cancel')}
            </button>
            <button
              type="button"
              disabled={!draft || update.isPending}
              onClick={() => draft && update.mutate({ id: g.id, range: draft }, { onSuccess: () => setEditing(false) })}
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('range.save')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function ApiTokensSection() {
  const t = useT()
  // shown once, here only; never filled into the MCP settings (API tokens are 401 at /mcp, docs/adr/1201-*)
  const [secret, setSecret] = useState<string | null>(null)
  const tokens = useApiTokens()
  const revoke = useRevokeApiToken()
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-4" id="tokens" data-testid="api-tokens">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t('tokens.title')}</h2>
        {!creating && !secret && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
          >
            {t('tokens.new')}
          </button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-sub">{t('tokens.intro')}</p>

      {secret && (
        <div role="status" className="flex flex-col gap-2 rounded-md border border-accent/50 bg-accent/5 p-3">
          <p className="text-sm font-medium text-ink">{t('tokens.createdTitle')}</p>
          <code className="select-all break-all rounded bg-side px-2 py-1 font-mono text-xs text-ink" data-testid="token-secret">
            {secret}
          </code>
          <p className="text-xs text-sub">{t('tokens.createdHint')}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(secret).then(() => setCopied(true))
              }}
              className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            <button
              type="button"
              onClick={() => {
                setSecret(null)
                setCopied(false)
              }}
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:opacity-90"
            >
              {t('tokens.done')}
            </button>
          </div>
        </div>
      )}

      {creating && (
        <NewTokenForm
          onCancel={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false)
            setSecret(s)
          }}
        />
      )}

      {tokens.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size={18} />
        </div>
      ) : tokens.isError ? (
        <p className="text-xs text-red-600">{t('tokens.loadFailed')}</p>
      ) : !tokens.data || tokens.data.length === 0 ? (
        <p className="text-xs text-sub">{t('tokens.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {tokens.data.map((tok) => (
            <TokenRow
              key={tok.id}
              token={tok}
              revoking={revoke.isPending}
              onRevoke={() => {
                if (window.confirm(t('tokens.revokeConfirm', { name: tok.name }))) revoke.mutate(tok.id)
              }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function TokenRow({ token: tok, onRevoke, revoking }: { token: ApiTokenDTO; onRevoke: () => void; revoking: boolean }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<AccessRange | null>(null)
  const update = useUpdateApiToken()
  const expired = tok.expiresAt !== null && new Date(tok.expiresAt).getTime() <= Date.now()
  return (
    <li className="flex flex-col gap-2 py-2" data-testid="api-token-row">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm text-ink">{tok.name}</span>
            <code className="shrink-0 font-mono text-[10px] text-sub">{tok.prefix}…</code>
            <AccessBadge access={tok.access} />
            <RangeBadge range={tok.range} />
            {expired && <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-600">{t('tokens.expired')}</span>}
          </div>
          <div className="text-xs text-sub">
            {t('tokens.meta', {
              created: fmtRelative(tok.createdAt),
              expires: tok.expiresAt ? fmtDate(tok.expiresAt) : t('tokens.never'),
              lastUsed: tok.lastUsedAt ? fmtRelative(tok.lastUsedAt) : t('tokens.never'),
            })}
            {tok.lastUsedIp ? ` ${t('tokens.lastIp', { ip: tok.lastUsedIp })}` : ''}
          </div>
          <SuggestOnlyLine state={tok.suggestOnly} connection={`token:${tok.id}`} />
        </div>
        <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
          >
            {t('range.change')}
          </button>
          <button
            type="button"
            disabled={revoking}
            onClick={onRevoke}
            className="rounded-md border border-line px-2 py-1 text-xs text-red-600 hover:bg-hover disabled:opacity-60"
          >
            {t('tokens.revoke')}
          </button>
        </div>
      </div>
      {editing && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-2">
          <RangePicker
            name={`token-range-${tok.id}`}
            initial={rangeFromView(tok.range)}
            initialWorkspaceId={tok.range.kind === 'subtree' ? tok.range.page.workspaceId : null}
            onChange={setDraft}
          />
          {update.isError && (
            <p className="text-xs text-red-600">{update.error instanceof ApiError ? update.error.message : ''}</p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover">
              {t('range.cancel')}
            </button>
            <button
              type="button"
              disabled={!draft || update.isPending}
              onClick={() => draft && update.mutate({ id: tok.id, range: draft }, { onSuccess: () => setEditing(false) })}
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('range.save')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function NewTokenForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (secret: string) => void }) {
  const t = useT()
  const create = useCreateApiToken()
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<'30' | '90' | '365' | 'never'>('90')
  const [access, setAccess] = useState<'read' | 'write'>('read')
  const [range, setRange] = useState<AccessRange | null>({ kind: 'all' })
  const valid = name.trim().length > 0 && range !== null
  const submit = () => {
    if (!valid || !range) return
    create.mutate(
      {
        name: name.trim(),
        expiresInDays: expiry === 'never' ? null : (Number(expiry) as 30 | 90 | 365),
        access,
        range,
      },
      { onSuccess: (r) => onCreated(r.secret) },
    )
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-ink">
        {t('tokens.name')}
        <input
          value={name}
          maxLength={API_TOKEN_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('tokens.namePlaceholder')}
          className="rounded border border-line bg-app px-2 py-1 text-sm text-ink"
          autoFocus
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-ink">
        {t('tokens.expiry')}
        <select
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as typeof expiry)}
          className="rounded border border-line bg-app px-1.5 py-1 text-xs text-ink"
        >
          {API_TOKEN_EXPIRY_DAYS.map((d) => (
            <option key={d} value={String(d)}>
              {t('tokens.expiryDays', { days: d })}
            </option>
          ))}
          <option value="never">{t('tokens.expiryNever')}</option>
        </select>
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-ink">{t('oauth.accessLabel')}</legend>
        {(['read', 'write'] as const).map((opt) => (
          <label
            key={opt}
            className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${access === opt ? 'border-accent' : 'border-line'}`}
          >
            <input type="radio" name="token-access" className="mt-0.5" checked={access === opt} onChange={() => setAccess(opt)} />
            <span className="flex flex-col">
              <span className="font-medium text-ink">{opt === 'write' ? t('oauth.accessWrite') : t('oauth.accessRead')}</span>
              <span className="text-sub">{opt === 'write' ? t('oauth.accessWriteHint') : t('oauth.accessReadHint')}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <RangePicker name="token-range-new" onChange={setRange} />
      {create.isError && (
        <p className="text-xs text-red-600">{create.error instanceof ApiError ? create.error.message : ''}</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover">
          {t('tokens.cancel')}
        </button>
        <button
          type="submit"
          disabled={!valid || create.isPending}
          className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {create.isPending ? t('tokens.creating') : t('tokens.create')}
        </button>
      </div>
    </form>
  )
}

/**
 * Agent connection tokens (docs/adr/2060-* .. 2063-*): for apps that cannot sign in here. Made with a name (its
 * "via" label), an access level, a range and an expiry; shown once; listed without the token; revoked at once.
 */
function AgentTokensSection({ secret, setSecret }: { secret: string | null; setSecret: (s: string | null) => void }) {
  const t = useT()
  const tokens = useAgentTokens()
  const revoke = useRevokeAgentToken()
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-4" id="agent-tokens" data-testid="agent-tokens">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t('agentTokens.title')}</h2>
        {!creating && !secret && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
          >
            {t('agentTokens.new')}
          </button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-sub">{t('agentTokens.intro')}</p>

      {secret && (
        <div role="status" className="flex flex-col gap-2 rounded-md border border-accent/50 bg-accent/5 p-3">
          <p className="text-sm font-medium text-ink">{t('agentTokens.createdTitle')}</p>
          <code className="select-all break-all rounded bg-side px-2 py-1 font-mono text-xs text-ink" data-testid="agent-token-secret">
            {secret}
          </code>
          <p className="text-xs text-sub">{t('agentTokens.createdHint')}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(secret).then(() => setCopied(true))
              }}
              className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            <button
              type="button"
              onClick={() => {
                setSecret(null)
                setCopied(false)
              }}
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:opacity-90"
            >
              {t('agentTokens.done')}
            </button>
          </div>
        </div>
      )}

      {creating && (
        <NewAgentTokenForm
          onCancel={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false)
            setSecret(s)
          }}
        />
      )}

      {tokens.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size={18} />
        </div>
      ) : tokens.isError ? (
        <p className="text-xs text-red-600">{t('agentTokens.loadFailed')}</p>
      ) : !tokens.data || tokens.data.length === 0 ? (
        <p className="text-xs text-sub">{t('agentTokens.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {tokens.data.map((tok) => (
            <AgentTokenRow
              key={tok.id}
              token={tok}
              revoking={revoke.isPending}
              onRevoke={() => {
                if (window.confirm(t('agentTokens.revokeConfirm', { name: tok.name }))) revoke.mutate(tok.id)
              }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function AgentTokenRow({ token: tok, onRevoke, revoking }: { token: AgentTokenDTO; onRevoke: () => void; revoking: boolean }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<AccessRange | null>(null)
  const update = useUpdateAgentTokenRange()
  const expired = new Date(tok.expiresAt).getTime() <= Date.now()
  return (
    <li className="flex flex-col gap-2 py-2" data-testid="agent-token-row">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm text-ink">{tok.name}</span>
            <code className="shrink-0 font-mono text-[10px] text-sub">{tok.prefix}…</code>
            <AccessBadge access={tok.access} />
            <RangeBadge range={tok.range} />
            {expired && (
              <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-600">{t('agentTokens.expired')}</span>
            )}
          </div>
          <div className="text-xs text-sub">
            {t('agentTokens.meta', {
              created: fmtRelative(tok.createdAt),
              expires: fmtDate(tok.expiresAt),
              lastUsed: tok.lastUsedAt ? fmtRelative(tok.lastUsedAt) : t('agentTokens.never'),
            })}
          </div>
          <SuggestOnlyLine state={tok.suggestOnly} connection={`grant:${tok.id}`} />
        </div>
        <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
          >
            {t('range.change')}
          </button>
          <button
            type="button"
            disabled={revoking}
            onClick={onRevoke}
            className="rounded-md border border-line px-2 py-1 text-xs text-red-600 hover:bg-hover disabled:opacity-60"
          >
            {t('agentTokens.revoke')}
          </button>
        </div>
      </div>
      {editing && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-2">
          <RangePicker
            name={`agent-token-range-${tok.id}`}
            initial={rangeFromView(tok.range)}
            initialWorkspaceId={tok.range.kind === 'subtree' ? tok.range.page.workspaceId : null}
            onChange={setDraft}
          />
          {update.isError && (
            <p className="text-xs text-red-600">{update.error instanceof ApiError ? update.error.message : ''}</p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover">
              {t('range.cancel')}
            </button>
            <button
              type="button"
              disabled={!draft || update.isPending}
              onClick={() => draft && update.mutate({ id: tok.id, range: draft }, { onSuccess: () => setEditing(false) })}
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('range.save')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function NewAgentTokenForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (secret: string) => void }) {
  const t = useT()
  const create = useCreateAgentToken()
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<AgentTokenExpiryDays>(AGENT_TOKEN_DEFAULT_EXPIRY_DAYS)
  // preselected like the OAuth consent screen, where apps ask for read and write
  const [access, setAccess] = useState<'read' | 'write'>('write')
  const [range, setRange] = useState<AccessRange | null>({ kind: 'all' })
  const valid = name.trim().length > 0 && range !== null
  const submit = () => {
    if (!valid || !range) return
    create.mutate({ name: name.trim(), expiresInDays: expiry, access, range }, { onSuccess: (r) => onCreated(r.secret) })
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-line p-3"
      data-testid="agent-token-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-ink">
        {t('agentTokens.name')}
        <input
          value={name}
          maxLength={AGENT_TOKEN_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('agentTokens.namePlaceholder')}
          className="rounded border border-line bg-app px-2 py-1 text-sm text-ink"
          autoFocus
        />
      </label>
      <label className="flex flex-wrap items-center gap-2 text-xs text-ink">
        {t('agentTokens.expiry')}
        <select
          value={String(expiry)}
          onChange={(e) => setExpiry(Number(e.target.value) as AgentTokenExpiryDays)}
          className="rounded border border-line bg-app px-1.5 py-1 text-xs text-ink"
        >
          {AGENT_TOKEN_EXPIRY_DAYS.map((d) => (
            <option key={d} value={String(d)}>
              {t('agentTokens.expiryDays', { days: d })}
            </option>
          ))}
        </select>
        <span className="text-sub">{t('agentTokens.expiryHint')}</span>
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-ink">{t('oauth.accessLabel')}</legend>
        {(['write', 'read'] as const).map((opt) => (
          <label
            key={opt}
            className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${access === opt ? 'border-accent' : 'border-line'}`}
          >
            <input type="radio" name="agent-token-access" className="mt-0.5" checked={access === opt} onChange={() => setAccess(opt)} />
            <span className="flex flex-col">
              <span className="font-medium text-ink">{opt === 'write' ? t('oauth.accessWrite') : t('oauth.accessRead')}</span>
              <span className="text-sub">{opt === 'write' ? t('oauth.accessWriteHint') : t('oauth.accessReadHint')}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <RangePicker name="agent-token-range-new" onChange={setRange} />
      {create.isError && (
        <p className="text-xs text-red-600">{create.error instanceof ApiError ? create.error.message : ''}</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover">
          {t('agentTokens.cancel')}
        </button>
        <button
          type="submit"
          disabled={!valid || create.isPending}
          className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {create.isPending ? t('agentTokens.creating') : t('agentTokens.create')}
        </button>
      </div>
    </form>
  )
}
