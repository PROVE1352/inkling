import type { CollectionField, MemberDTO } from '@inkling/shared'
import { t } from '../../../i18n'
import { OPTION_BADGE_CLASS } from '../../../lib/optionColors'
import { CheckIcon } from '../../Icons'
import { RelationChips, RollupValue } from './RelationCell'

export function OptionBadge({
  field,
  optionId,
}: {
  field: CollectionField
  optionId: string
}) {
  const opt = field.options?.find((o) => o.id === optionId)
  if (!opt) return null
  return (
    <span
      className={`inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-xs ${
        OPTION_BADGE_CLASS[opt.color]
      }`}
    >
      {opt.name}
    </span>
  )
}

// Read-only render per field type. Reused by board cards, idle table cells and the RightPanel.
export function FieldValue({
  field,
  value,
  members,
}: {
  field: CollectionField
  value: unknown
  members?: MemberDTO[]
}) {
  switch (field.type) {
    case 'checkbox':
      return value ? (
        <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-accent text-white">
          <CheckIcon size={12} />
        </span>
      ) : (
        <span className="inline-block h-4 w-4 rounded border border-line" />
      )

    case 'select': {
      if (!value) return null
      return <OptionBadge field={field} optionId={String(value)} />
    }

    case 'multiSelect': {
      if (!Array.isArray(value) || value.length === 0) return null
      return (
        <span className="flex flex-wrap gap-1">
          {value.map((id) => (
            <OptionBadge key={String(id)} field={field} optionId={String(id)} />
          ))}
        </span>
      )
    }

    case 'person': {
      if (!value) return null
      const m = members?.find((x) => x.id === value)
      const name = m?.name ?? t('cell.unknownPerson')
      const initial = name.slice(0, 1).toUpperCase()
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-ink">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
            {initial}
          </span>
          <span className="truncate">{name}</span>
        </span>
      )
    }

    case 'url': {
      if (!value) return null
      const href = String(value)
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className="truncate text-sm text-accent hover:underline"
        >
          {href}
        </a>
      )
    }

    case 'number':
      return typeof value === 'number' ? (
        <span className="text-sm text-ink">{value}</span>
      ) : null

    case 'date':
      return value ? <span className="text-sm text-ink">{String(value)}</span> : null

    case 'relation':
      return <RelationChips field={field} value={value} />

    case 'rollup':
      return <RollupValue value={value} />

    default:
      return value ? (
        <span className="truncate text-sm text-ink">{String(value)}</span>
      ) : null
  }
}
