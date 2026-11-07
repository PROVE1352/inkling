import { useState } from 'react'
import { Link } from 'react-router'
import { API_TOKEN_EXPIRY_DAYS, API_TOKEN_NAME_MAX } from '@inkling/shared'
import type { AccessRange, ApiTokenDTO } from '@inkling/shared'
import { ApiError, useOAuthGrants, useRevokeOAuthGrant } from '../api'
import type { OAuthGrantDTO } from '../api'
import { useApiTokens, useCreateApiToken, useRevokeApiToken, useUpdateApiToken, useUpdateGrantRange } from '../apiTokens'
import { RangeBadge, RangePicker, rangeFromView } from '../components/RangePicker'
import { Spinner } from '../components/Spinner'
import { fmtDate, fmtRelative, useT } from '../i18n'

/**
 * Connections (/settings/connections): the MCP URL for AI apps, the connected apps with their access
 * and range (docs/adr/1200-*), and personal API tokens for scripts and inklingctl (docs/adr/1201-*).
 * Disconnecting or revoking cuts access at once.
 */
export function Connections() {
  const t = useT()
  const grants = useOAuthGrants()
  const revoke = useRevokeOAuthGrant()
  const mcpUrl = `${window.location.origin}/mcp`
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // No clipboard permission — the user selects and copies it manually
    }
  }

  return (
    <div className="min-h-full bg-app px-4 py-12">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-ink">{t('connections.title')}</h1>
          <Link to="/" className="text-xs text-accent hover:underline">
            ← {t('common.back')}
          </Link>
        </div>

        <section className="flex flex-col gap-2 rounded-lg border border-line p-4">
          <h2 className="text-sm font-semibold text-ink">{t('connections.serverUrl')}</h2>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-side px-2 py-1 text-xs text-ink">{mcpUrl}</code>
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <p className="text-xs text-sub">
            Claude Code: <code>claude mcp add --transport http inkling {mcpUrl}</code>
            <br />
            claude.ai: {t('connections.claudeAiHint')}
          </p>
        </section>

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

function GrantRow({ grant: g, onRevoke, revoking }: { grant: OAuthGrantDTO; onRevoke: () => void; revoking: boolean }) {
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
            <AccessBadge access={g.access} />
            <RangeBadge range={g.range} />
          </div>
          <div className="text-xs text-sub">
            {t('connections.meta', {
              connected: fmtRelative(g.createdAt),
              lastUsed: g.lastUsedAt ? fmtRelative(g.lastUsedAt) : t('connections.never'),
            })}
          </div>
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
  const tokens = useApiTokens()
  const revoke = useRevokeApiToken()
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
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
