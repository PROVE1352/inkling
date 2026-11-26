import { useIncludeForAgents } from '../agentInclusion'
import { useT } from '../i18n'

/**
 * "Workspace your agents can't see yet: <name> (added by <person>)" and the Include button (docs/adr/2580-*).
 * Shown in the bell under a workspace_added item and on Settings › Connections. Including asks first: from
 * then on every connection with access to all notes reads that workspace and follows its agent instructions.
 */
export function AgentPendingLine({
  workspaceId,
  workspaceName,
  actorName,
  small = false,
}: {
  workspaceId: string
  workspaceName: string
  actorName: string | null
  small?: boolean
}) {
  const t = useT()
  const include = useIncludeForAgents()
  const size = small ? 'text-[11px]' : 'text-xs'
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="agent-pending">
      <span className={`min-w-0 flex-1 ${size} text-sub`}>
        {actorName
          ? t('agentInclusion.line', { workspace: workspaceName, actor: actorName })
          : t('agentInclusion.lineNoActor', { workspace: workspaceName })}
      </span>
      <button
        type="button"
        onClick={() => {
          if (window.confirm(t('agentInclusion.confirm', { workspace: workspaceName }))) include.mutate(workspaceId)
        }}
        disabled={include.isPending}
        className={`shrink-0 rounded-md border border-line px-2 py-0.5 ${size} text-ink hover:bg-hover disabled:opacity-60`}
      >
        {t('agentInclusion.include')}
      </button>
      {include.isError && <span className={`${size} text-red-600`}>{t('agentInclusion.failed')}</span>}
    </div>
  )
}
