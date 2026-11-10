import { useState } from 'react'
import { useT, type TKey } from '../i18n'
import {
  MCP_CLIENTS,
  MCP_PROFILES,
  MCP_TOKEN_AUTH_ENABLED,
  buildMcpConfig,
  isAgentConnectionToken,
  mcpServerUrl,
  type McpAuth,
  type McpClient,
  type McpProfile,
} from '../lib/mcpConfig'

// Connection settings generator on /settings/connections (docs/adr/2020-*). Pick the client, the tool profile
// and how it signs in; the box shows what to paste. Token sign-in uses an agent connection token (docs/adr/2060-*),
// never a personal API token (401 at /mcp). A token appears in it only while the one just made on this screen is
// still shown (the parent holds it in React state, never in storage or the URL).

const CLIENT_LABEL: Record<McpClient, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude Desktop · claude.ai',
  cursor: 'Cursor',
  vscode: 'VS Code',
  generic: '',
}
const CLIENT_STEPS: Record<McpClient, TKey> = {
  'claude-code': 'mcpSetup.steps.claudeCode',
  'claude-ai': 'connections.claudeAiHint',
  cursor: 'mcpSetup.steps.cursor',
  vscode: 'mcpSetup.steps.vscode',
  generic: 'mcpSetup.steps.generic',
}
const PROFILE_LABEL: Record<McpProfile, { name: TKey; hint: TKey }> = {
  full: { name: 'mcpSetup.profileFull', hint: 'mcpSetup.profileFullHint' },
  core: { name: 'mcpSetup.profileCore', hint: 'mcpSetup.profileCoreHint' },
}

export function McpSetup({
  origin,
  secret,
  tokenAuthEnabled = MCP_TOKEN_AUTH_ENABLED,
  initial,
}: {
  origin: string
  /** The agent connection token made on this screen a moment ago, while it is still shown; else null. */
  secret: string | null
  tokenAuthEnabled?: boolean
  /** Initial choices (tests). */
  initial?: { client?: McpClient; profile?: McpProfile; auth?: McpAuth }
}) {
  const t = useT()
  const [client, setClient] = useState<McpClient>(initial?.client ?? 'claude-code')
  const [profile, setProfile] = useState<McpProfile>(initial?.profile ?? 'full')
  const [authChoice, setAuth] = useState<McpAuth>(initial?.auth ?? (isAgentConnectionToken(secret) ? 'token' : 'oauth'))
  // A token was just made on this screen: show the settings that use it (the person can switch back to sign-in).
  const [seenSecret, setSeenSecret] = useState(secret)
  if (secret !== seenSecret) {
    setSeenSecret(secret)
    if (isAgentConnectionToken(secret)) setAuth('token')
  }
  const [copied, setCopied] = useState<'config' | 'url' | 'header' | null>(null)
  const auth: McpAuth = tokenAuthEnabled ? authChoice : 'oauth'
  // only an agent connection token is ever filled in (buildMcpConfig checks the prefix too)
  const token = isAgentConnectionToken(secret) ? secret : null
  const config = buildMcpConfig({ client, auth, profile, origin, token })
  const url = mcpServerUrl(origin, profile)
  const isLocalHttp = /^http:\/\//.test(origin)

  const copy = async (text: string, which: 'config' | 'url' | 'header') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // No clipboard permission: the text is selectable
    }
  }
  const clientLabel = (c: McpClient) => (c === 'generic' ? t('mcpSetup.clientGeneric') : CLIENT_LABEL[c])

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-line p-4" data-testid="mcp-setup">
      <h2 className="text-sm font-semibold text-ink">{t('mcpSetup.title')}</h2>

      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs text-sub">{t('connections.serverUrl')}</span>
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-side px-2 py-1 text-xs text-ink" data-testid="mcp-url">
            {url}
          </code>
          <button
            type="button"
            onClick={() => copy(url, 'url')}
            className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
          >
            {copied === 'url' ? t('common.copied') : t('common.copy')}
          </button>
        </div>
      </div>

      <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-ink">
        <span className="shrink-0">{t('mcpSetup.client')}</span>
        <select
          value={client}
          onChange={(e) => setClient(e.target.value as McpClient)}
          className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-xs text-ink"
          data-testid="mcp-client"
        >
          {MCP_CLIENTS.map((c) => (
            <option key={c} value={c}>
              {clientLabel(c)}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-ink">{t('mcpSetup.profile')}</legend>
        <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
          {MCP_PROFILES.map((p) => (
            <label
              key={p}
              className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${profile === p ? 'border-accent' : 'border-line'}`}
            >
              <input type="radio" name="mcp-profile" className="mt-0.5" checked={profile === p} onChange={() => setProfile(p)} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-ink">{t(PROFILE_LABEL[p].name)}</span>
                <span className="text-sub">{t(PROFILE_LABEL[p].hint)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {tokenAuthEnabled && (
        <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid="mcp-auth">
          <legend className="mb-1 text-xs font-medium text-ink">{t('mcpSetup.auth')}</legend>
          <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
            {(['oauth', 'token'] as const).map((a) => (
              <label
                key={a}
                className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${authChoice === a ? 'border-accent' : 'border-line'}`}
              >
                <input type="radio" name="mcp-auth" className="mt-0.5" checked={authChoice === a} onChange={() => setAuth(a)} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-ink">{a === 'oauth' ? t('mcpSetup.authOauth') : t('mcpSetup.authToken')}</span>
                  <span className="text-sub">{a === 'oauth' ? t('mcpSetup.authOauthHint') : t('mcpSetup.authTokenHint')}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-xs leading-relaxed text-sub" data-testid="mcp-steps">
          {t(client === 'claude-code' && auth === 'token' ? 'mcpSetup.steps.claudeCodeToken' : CLIENT_STEPS[client])}
        </p>
        {config.where.length > 0 && (
          <ul className="flex min-w-0 flex-col gap-0.5" data-testid="mcp-where">
            {config.where.map((w) => (
              <li key={w} className="min-w-0 break-all font-mono text-[11px] text-ink">
                {w}
              </li>
            ))}
          </ul>
        )}
        <div className="relative min-w-0">
          <pre
            className="max-h-64 min-w-0 overflow-auto whitespace-pre rounded-md bg-side p-2 pr-14 font-mono text-[11px] leading-snug text-ink"
            data-testid="mcp-config"
          >
            {config.text}
          </pre>
          <button
            type="button"
            onClick={() => copy(config.text, 'config')}
            className="absolute right-1.5 top-1.5 rounded-md border border-line bg-app px-2 py-0.5 text-xs text-ink hover:bg-hover"
          >
            {copied === 'config' ? t('common.copied') : t('common.copy')}
          </button>
        </div>
        {config.headerValue !== undefined && (
          <div className="flex min-w-0 flex-col gap-1" data-testid="mcp-header">
            <p className="text-xs leading-relaxed text-sub">{t('mcpSetup.claudeAiHeader')}</p>
            <div className="flex min-w-0 items-center gap-2">
              <code className="shrink-0 rounded bg-side px-1.5 py-1 font-mono text-[11px] text-ink">authorization</code>
              <code className="min-w-0 flex-1 break-all rounded bg-side px-1.5 py-1 font-mono text-[11px] text-ink">{config.headerValue}</code>
              <button
                type="button"
                onClick={() => copy(config.headerValue ?? '', 'header')}
                className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-ink hover:bg-hover"
              >
                {copied === 'header' ? t('common.copied') : t('common.copy')}
              </button>
            </div>
          </div>
        )}
        {auth === 'token' && (
          <p className="text-xs leading-relaxed text-sub" data-testid="mcp-token-note">
            {client === 'vscode' ? t('mcpSetup.vscodeInput') : token ? t('mcpSetup.tokenFilled') : t('mcpSetup.tokenPlaceholder')}{' '}
            {!token && (
              <a href="#agent-tokens" className="text-accent hover:underline">
                {t('mcpSetup.tokenCreate')}
              </a>
            )}
          </p>
        )}
      </div>

      <details className="text-xs text-sub" open={isLocalHttp}>
        <summary className="cursor-pointer text-ink">{t('mcpSetup.helpTitle')}</summary>
        <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 leading-relaxed">
          <li>{t('mcpSetup.helpPublicUrl')}</li>
          <li>{t('mcpSetup.helpClaudeAi')}</li>
          <li>{t('mcpSetup.helpClaudeCodeHttp')}</li>
          <li>{t('mcpSetup.helpSelfSigned')}</li>
          <li>{t('mcpSetup.helpProfileChange')}</li>
        </ul>
      </details>
    </section>
  )
}
