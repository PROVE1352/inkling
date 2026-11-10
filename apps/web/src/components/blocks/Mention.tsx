import { useNavigate, useParams } from 'react-router'
import { createReactInlineContentSpec } from '@blocknote/react'
import { mentionConfig } from '@inkling/shared'
import { useT } from '../../i18n'

// @mention custom inline content (M13).
// - props: kind('user'|'page'|'agent' = a person's connection, id `<person>/grant:<id>`), id, label. content 'none' → an atom inline node, not a cursor/edit target.
// - The config is shared with the server schema (@inkling/shared, docs/adr/1500-*): server reads keep
//   the chip; Markdown writes `@label` (exports) or `@[label](kind:id)` (agent reads).
// - toExternalHTML: falls back to `@label` text for client HTML export/copy.

// Person mention — blue chip (no click action, v1). Page mention — acts like a link (SPA navigation on click).
function MentionChip({
  kind,
  id,
  label,
}: {
  kind: string
  id: string
  label: string
}) {
  const { wsId } = useParams()
  const navigate = useNavigate()
  const t = useT()
  const text = `@${label || t('mention.fallback')}`

  if (kind === 'page') {
    return (
      <span
        contentEditable={false}
        role="link"
        tabIndex={0}
        title={label}
        data-page-id={id || undefined}
        onClick={() => id && wsId && navigate(`/w/${wsId}/p/${id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && id && wsId) navigate(`/w/${wsId}/p/${id}`)
        }}
        className="nd-mention nd-mention-page cursor-pointer rounded px-1 text-accent hover:underline"
      >
        {text}
      </span>
    )
  }
  if (kind === 'agent') {
    // A person's agent connection (docs/adr/1861-*): only that agent's inbox gets the line. A 0.14
    // client shows the same chip as a person chip with this label.
    return (
      <span
        contentEditable={false}
        title={t('teamAgents.agentChipTitle', { label })}
        data-agent-ref={id || undefined}
        className="nd-mention nd-mention-agent rounded border border-dashed border-accent/50 px-1 font-medium text-accent"
      >
        {text}
      </span>
    )
  }
  return (
    <span
      contentEditable={false}
      title={label}
      className="nd-mention nd-mention-user rounded px-1 font-medium text-accent"
    >
      {text}
    </span>
  )
}

export const mentionSpec = createReactInlineContentSpec(mentionConfig, {
  render: ({ inlineContent }) => (
    <MentionChip
      kind={String(inlineContent.props.kind)}
      id={String(inlineContent.props.id)}
      label={String(inlineContent.props.label)}
    />
  ),
  // Plain-text fallback for HTML/copy outside the editor.
  toExternalHTML: ({ inlineContent }) => (
    <span>@{String(inlineContent.props.label)}</span>
  ),
})
