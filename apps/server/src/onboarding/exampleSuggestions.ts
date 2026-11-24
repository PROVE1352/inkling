import type { Locale } from '../i18n'
import { readSection, readSectionBlocks } from '../context/sectionSource'
import { blocksToMarkdown } from '../md/convert'
import { findVisiblePage } from '../pageDto'
import { seedExampleSuggestions } from '../suggestions'

/**
 * Example suggestions on a new sample page (docs/adr/2388-*): two suggested edits from an "example
 * agent" are seeded with the sample, so the review flow (✎ marks, accept in part, reject) can be
 * tried before any agent is connected. Their name and text say they are examples written in
 * advance, not by an AI. No notification is sent when they are made or decided.
 *
 * Suggestion 1 replaces "4. Diagrams" with the section plus two paragraphs, one before and one after
 * its last block (the mermaid code block), so the review dialog shows two separate changes and one
 * can be taken alone. It is built from the section as it is now, not from a fixed string, so it
 * keeps its two changes when the sample text changes. Suggestion 2 appends a tip to "5. AI agents"
 * (accepted or rejected whole).
 */

export interface ExampleItem {
  /** Heading text of the section (what findSection takes as a ref). */
  heading: string
  mode: 'replace' | 'append'
  /**
   * append: the Markdown to add. replace: the paragraphs to weave in, separated by a blank line —
   * the first goes before the section's last block, the second after it.
   */
  markdown: string
}

export function exampleAgentName(locale: Locale): string {
  return locale === 'ko' ? '예시 에이전트' : 'Example agent'
}

export function exampleSuggestionItems(locale: Locale): ExampleItem[] {
  if (locale === 'ko') {
    return [
      {
        heading: '4. 다이어그램',
        mode: 'replace',
        markdown: 'Mermaid는 시퀀스 다이어그램과 간트 차트도 그립니다.\n\n이 문장은 예시 에이전트의 제안에서 왔습니다. 받아들여도 되고 빼도 됩니다.',
      },
      {
        heading: '5. AI 에이전트',
        mode: 'append',
        markdown:
          '> [!tip] 이 문단은 샘플 페이지와 함께 미리 넣어 둔 예시 제안입니다. AI가 쓴 글이 아닙니다. 실제 에이전트의 제안도 똑같이 보이고, 정할 때까지 여기서 기다립니다.',
      },
    ]
  }
  return [
    {
      heading: '4. Diagrams',
      mode: 'replace',
      markdown: "Mermaid also draws sequence diagrams and Gantt charts.\n\nThis sentence came from the example agent's suggestion. Keep it or leave it out.",
    },
    {
      heading: '5. AI agents',
      mode: 'append',
      markdown:
        '> [!tip] This paragraph is an example suggestion that came with the sample page. No AI wrote it. Suggestions from a real agent look the same and wait here until you decide.',
    },
  ]
}

/** Test hook: replaces the items (e.g. a heading that does not exist, to make seeding fail). */
export const exampleSuggestionHooks: { items: ((locale: Locale) => ExampleItem[]) | null } = { items: null }

/**
 * The section body (heading line dropped) with `before` put in front of its last block and `after`
 * behind it. A section without a body block gets both at its end.
 */
async function woven(pageId: string, heading: string, before: string, after: string): Promise<string> {
  const sec = await readSection(pageId, heading)
  const blocks = await readSectionBlocks(pageId, heading)
  if (!sec.found || !blocks.found) throw new Error(`example suggestion: section "${heading}" not found`)
  const nl = sec.markdown.indexOf('\n')
  const body = sec.section.level > 0 ? (nl === -1 ? '' : sec.markdown.slice(nl + 1).trim()) : sec.markdown
  const bodyBlocks = sec.section.level > 0 ? blocks.blocks.slice(1) : blocks.blocks
  const last = bodyBlocks.length ? (await blocksToMarkdown(bodyBlocks.slice(-1), { assetMode: 'absolute', notation: 'agent' })).markdown.trim() : ''
  const at = last ? body.lastIndexOf(last) : -1
  if (at === -1) return [body, before, after].filter((x) => x !== '').join('\n\n')
  const head = body.slice(0, at).trim()
  return [head, before, body.slice(at).trim(), after].filter((x) => x !== '').join('\n\n')
}

/**
 * Seeds the example suggestions on the sample's root page. Throws on failure; the caller (making
 * the sample) logs it and goes on, since the sample is complete without them.
 */
export async function seedSampleSuggestions(userId: string, rootPageId: string, locale: Locale): Promise<void> {
  const page = await findVisiblePage(rootPageId, userId)
  if (!page) throw new Error('example suggestions: sample page not found')
  const items = (exampleSuggestionHooks.items ?? exampleSuggestionItems)(locale)
  const out = []
  for (const i of items) {
    if (i.mode === 'replace') {
      const [before, after = ''] = i.markdown.split(/\n\s*\n/)
      out.push({ ref: i.heading, mode: i.mode, markdown: await woven(page.id, i.heading, before, after) })
    } else {
      out.push({ ref: i.heading, mode: i.mode, markdown: i.markdown })
    }
  }
  await seedExampleSuggestions({ userId, page, via: exampleAgentName(locale), items: out })
}
