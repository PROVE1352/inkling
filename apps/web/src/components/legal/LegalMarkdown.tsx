import { useMemo, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from './markdownParse'

/**
 * Draws the operator's Markdown (terms, privacy policy, sign-up details) as React elements only, from
 * the tree markdownParse.ts builds: no innerHTML anywhere, so HTML written in a document is shown as text.
 * Tables scroll inside their own box, so a wide table never widens a phone screen.
 */
export function Markdown({ source, compact = false }: { source: string; compact?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={`nd-legal-md min-w-0 break-keep [overflow-wrap:anywhere] text-ink ${compact ? 'text-xs leading-relaxed' : 'text-sm leading-relaxed'}`}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} compact={compact} />
      ))}
    </div>
  )
}

function inlines(list: Inline[]): ReactNode[] {
  return list.map((n, i) => <InlineView key={i} n={n} />)
}

function InlineView({ n }: { n: Inline }): ReactNode {
  switch (n.t) {
    case 'text':
      return n.v
    case 'strong':
      return <strong className="font-semibold">{inlines(n.c)}</strong>
    case 'em':
      return <em>{inlines(n.c)}</em>
    case 'code':
      return <code className="rounded bg-hover px-1 font-mono text-[0.92em]">{n.v}</code>
    case 'link':
      return (
        <a
          href={n.href}
          className="text-accent underline-offset-2 [overflow-wrap:anywhere] hover:underline"
          {...(n.href.startsWith('mailto:') ? {} : { target: '_blank', rel: 'noopener noreferrer nofollow' })}
        >
          {inlines(n.c)}
        </a>
      )
  }
}

function BlockView({ b, compact }: { b: Block; compact: boolean }): ReactNode {
  const gap = compact ? 'mt-2 first:mt-0' : 'mt-3 first:mt-0'
  switch (b.t) {
    case 'heading': {
      const cls = {
        1: 'mt-0 mb-4 text-xl font-bold',
        2: 'mt-8 mb-2 text-base font-semibold first:mt-0',
        3: 'mt-6 mb-2 text-sm font-semibold first:mt-0',
        4: 'mt-4 mb-1 text-sm font-medium first:mt-0',
      }[b.level]
      const Tag = (`h${b.level}` as 'h1' | 'h2' | 'h3' | 'h4')
      return <Tag className={`text-ink ${cls}`}>{inlines(b.c)}</Tag>
    }
    case 'paragraph':
      return <p className={gap}>{inlines(b.c)}</p>
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      return (
        <Tag className={`${gap} flex flex-col gap-1 pl-5 ${b.ordered ? 'list-decimal' : 'list-disc'}`}>
          {b.items.map((it, i) => (
            <li key={i}>{inlines(it)}</li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return (
        <div className={`${gap} max-w-full overflow-x-auto rounded-md border border-line`} tabIndex={0}>
          <table className="w-full border-collapse text-left">
            <thead className="bg-side">
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} scope="col" className="border-b border-line px-2 py-1.5 align-top font-semibold">
                    {inlines(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-t border-line first:border-t-0">
                  {r.map((c, k) => (
                    <td key={k} className="min-w-[6rem] px-2 py-1.5 align-top">
                      {inlines(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return (
        <blockquote className={`${gap} border-l-2 border-line pl-3 text-sub`}>
          {b.c.map((x, i) => (
            <BlockView key={i} b={x} compact={compact} />
          ))}
        </blockquote>
      )
    case 'code':
      return <pre className={`${gap} overflow-x-auto rounded-md bg-hover p-2 font-mono text-xs`}>{b.v}</pre>
    case 'hr':
      return <hr className={`${gap} border-line`} />
  }
}
