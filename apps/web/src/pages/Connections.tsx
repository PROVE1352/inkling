import { useState } from 'react'
import { Link } from 'react-router'
import { useOAuthGrants, useRevokeOAuthGrant } from '../api'
import { Spinner } from '../components/Spinner'
import { fmtRelative, useT } from '../i18n'

/**
 * MCP connections (/settings/connections) — shows the MCP URL for connecting external AI apps such as
 * Claude, plus the list of connected apps with disconnect. Disconnecting immediately invalidates that
 * app's access and refresh tokens.
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
                <li key={g.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{g.clientName}</div>
                    <div className="text-xs text-sub">
                      {t('connections.meta', {
                        connected: fmtRelative(g.createdAt),
                        lastUsed: g.lastUsedAt ? fmtRelative(g.lastUsedAt) : t('connections.never'),
                      })}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(g.id)}
                    className="rounded-md border border-line px-2 py-1 text-xs text-red-600 hover:bg-hover disabled:opacity-60"
                  >
                    {t('connections.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
