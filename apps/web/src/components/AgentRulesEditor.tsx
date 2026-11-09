import { useEffect, useState } from 'react'
import { AUTO_ACCEPT_MODES, DEFAULT_AUTO_ACCEPT_RULES, type AutoAcceptMode, type AutoAcceptRules } from '@inkling/shared'
import { useT, type TKey } from '../i18n'
import { Spinner } from './Spinner'

// Auto-accept rules (docs/adr/1545-*): which agent edits are accepted without a person. Used by the
// workspace default (Workspace settings › Connected agents) and by an "auto" lock node (lock dialog).
// The rule "the section is unchanged since the agent read it" always applies and is not a setting.

const MODE_LABEL: Record<AutoAcceptMode, TKey> = {
  append: 'agentPolicy.mode.append',
  insert_after: 'agentPolicy.mode.insert_after',
  prepend: 'agentPolicy.mode.prepend',
  replace: 'agentPolicy.mode.replace',
  delete: 'agentPolicy.mode.delete',
}

const inputClass =
  'w-24 rounded-md border border-line bg-app px-2 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60'

export function AgentRulesEditor({
  rules,
  connections,
  disabled,
  saving,
  onSave,
}: {
  rules: AutoAcceptRules | undefined
  /** Connections that may be listed ('grant:<id>' → label); empty when the caller cannot see them. */
  connections: { key: string; label: string }[]
  disabled: boolean
  saving: boolean
  onSave: (rules: AutoAcceptRules) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<AutoAcceptRules>(rules ?? DEFAULT_AUTO_ACCEPT_RULES)
  useEffect(() => {
    if (rules) setDraft(rules)
  }, [rules])
  const num = (v: string): number | null => {
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v))
  const dirty = JSON.stringify(draft) !== JSON.stringify(rules ?? DEFAULT_AUTO_ACCEPT_RULES)

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="agent-rules-editor">
      <p className="text-sub">{t('agentPolicy.alwaysRule')}</p>
      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="mb-1 font-medium text-ink">{t('agentPolicy.modes')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {AUTO_ACCEPT_MODES.map((m) => (
            <label key={m} className="flex items-center gap-1.5 text-ink">
              <input
                type="checkbox"
                checked={draft.modes.includes(m)}
                onChange={(e) => setDraft({ ...draft, modes: toggle(draft.modes, m, e.target.checked) })}
              />
              {t(MODE_LABEL[m])}
              {(m === 'replace' || m === 'delete') && <span className="text-sub">({t('agentPolicy.optional')})</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="mb-1 font-medium text-ink">{t('agentPolicy.connections')}</legend>
        <p className="text-sub">{t('agentPolicy.connectionsHint')}</p>
        {connections.length > 0 && (
          <div className="flex flex-col gap-1">
            {connections.map((c) => (
              <label key={c.key} className="flex min-w-0 items-center gap-1.5 text-ink">
                <input
                  type="checkbox"
                  checked={draft.connections.includes(c.key)}
                  onChange={(e) => setDraft({ ...draft, connections: toggle(draft.connections, c.key, e.target.checked) })}
                />
                <span className="truncate">{c.label}</span>
              </label>
            ))}
          </div>
        )}
        {draft.connections.length > 0 && connections.length === 0 && (
          <p className="text-sub">{t('agentPolicy.connectionsCount', { count: draft.connections.length })}</p>
        )}
      </fieldset>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-ink">
          {t('agentPolicy.maxLines')}
          <input
            type="number"
            min={1}
            disabled={disabled}
            value={draft.maxLines ?? ''}
            placeholder={t('agentPolicy.noLimit')}
            onChange={(e) => setDraft({ ...draft, maxLines: num(e.target.value) })}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-1.5 text-ink">
          {t('agentPolicy.maxChars')}
          <input
            type="number"
            min={1}
            disabled={disabled}
            value={draft.maxChars ?? ''}
            placeholder={t('agentPolicy.noLimit')}
            onChange={(e) => setDraft({ ...draft, maxChars: num(e.target.value) })}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-1.5 text-ink">
          {t('agentPolicy.grace')}
          <input
            type="number"
            min={0}
            disabled={disabled}
            value={draft.graceMinutes}
            onChange={(e) => setDraft({ ...draft, graceMinutes: Math.max(0, num(e.target.value) ?? 0) })}
            className={inputClass}
          />
        </label>
      </div>
      <p className="text-sub">{draft.graceMinutes > 0 ? t('agentPolicy.graceOn', { minutes: draft.graceMinutes }) : t('agentPolicy.graceOff')}</p>
      {!disabled && (
        <div className="flex items-center justify-end gap-2">
          {saving && <Spinner size={12} />}
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => onSave(draft)}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('agentPolicy.saveRules')}
          </button>
        </div>
      )}
    </div>
  )
}
