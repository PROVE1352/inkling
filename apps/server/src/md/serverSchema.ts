import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  calloutConfig,
  chartBlockConfig,
  inlineMathConfig,
  linkEmbedConfig,
  mathBlockConfig,
  mentionConfig,
  pageEmbedConfig,
  pluginBlockConfig,
} from '@inkling/shared'

/**
 * The server's BlockNote schema: BlockNote's defaults plus the math nodes
 * (docs/adr/0995-math-nodes-in-both-editor-schemas.md) and the web editor's callout, page embed,
 * link embed, plugin block and mention (docs/adr/1500-agent-markdown-notation-for-custom-nodes.md).
 *
 * y-prosemirror deletes Yjs items whose node the reading schema does not know (ADR 0940), so every
 * node the server must not lose has to be in this schema with the same name and attributes as in
 * the web editor. Both sides build the specs from the configs in `@inkling/shared`.
 *
 * `@blocknote/core` is not a dependency of the server package (only `@blocknote/server-util` is,
 * which depends on core at the same pinned version), so it is loaded from server-util's own
 * resolution. It must be the ESM entry: server-util imports core as ESM, and a second (CJS) copy
 * would create specs and a schema class the editor does not recognise.
 */

/** The few `@blocknote/core` exports used here (its types are not resolvable from this package). */
interface BlockNoteCore {
  BlockNoteSchema: { create(options: { blockSpecs: object; inlineContentSpecs: object }): unknown }
  defaultBlockSpecs: Record<string, unknown>
  defaultInlineContentSpecs: Record<string, unknown>
  createBlockSpec(config: object, implementation: object): () => unknown
  createInlineContentSpec(config: object, implementation: object): unknown
}

async function loadCore(): Promise<BlockNoteCore> {
  const req = createRequire(import.meta.url)
  const serverUtil = req.resolve('@blocknote/server-util')
  // `@blocknote/core/package.json` is not in core's export map; resolve the CJS entry only to find
  // the package directory, then import the ESM entry named by its `exports['.'].import`.
  let dir = path.dirname(createRequire(serverUtil).resolve('@blocknote/core'))
  while (!isCorePackage(dir)) {
    const up = path.dirname(dir)
    if (up === dir) throw new Error('@blocknote/core not found next to @blocknote/server-util')
    dir = up
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    exports?: { '.'?: { import?: string } }
  }
  const entry = pkg.exports?.['.']?.import
  if (!entry) throw new Error('@blocknote/core has no ESM entry')
  return (await import(pathToFileURL(path.join(dir, entry)).href)) as BlockNoteCore
}

function isCorePackage(dir: string): boolean {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name === '@blocknote/core'
  } catch {
    return false
  }
}

const core = await loadCore()

/**
 * Server render of a math node: the LaTeX source as text (no KaTeX on the server). The public share
 * page renders it on the client from the `data-latex` attribute BlockNote writes on the wrapper
 * (docs/adr/0997-*); without script (or in a feed reader) the source stays readable.
 */
interface DomElement {
  className: string
  textContent: string | null
  setAttribute(name: string, value: string): void
  appendChild(child: DomElement): DomElement
}

function element(tag: string, className: string): DomElement {
  const doc = (globalThis as unknown as { document: { createElement(tag: string): DomElement } }).document
  const el = doc.createElement(tag)
  el.className = className
  return el
}

function sourceElement(tag: 'div' | 'span', latex: string): DomElement {
  // server-util renders inside its JSDOM, which it installs as the global `document` for the call
  const doc = (globalThis as unknown as { document: { createElement(tag: string): DomElement } }).document
  const el = doc.createElement(tag)
  el.className = tag === 'div' ? 'nd-math-source' : 'nd-math-inline-source'
  el.textContent = latex
  return el
}

const mathBlockSpec = core.createBlockSpec(mathBlockConfig, {
  render: (block: { props: { latex: string } }) => ({ dom: sourceElement('div', block.props.latex) }),
})

const inlineMathSpec = core.createInlineContentSpec(inlineMathConfig, {
  render: (inline: { props: { latex: string } }) => ({ dom: sourceElement('span', inline.props.latex) }),
})

/**
 * Server renders of the web-only nodes (HTML only: the public share page and BlockNote's own
 * Markdown pipeline, which md/notation.ts keeps these nodes away from). A callout is a box around its
 * editable text; embeds and plugin blocks render as empty placeholders (their content lives
 * elsewhere and the public page never loaded it); a mention is its `@label` text.
 */
const calloutSpec = core.createBlockSpec(calloutConfig, {
  render: (block: { props: { type: string } }) => {
    const dom = element('div', 'nd-callout')
    dom.setAttribute('data-callout-type', block.props.type)
    const contentDOM = element('div', 'nd-callout-content')
    dom.appendChild(contentDOM)
    return { dom, contentDOM }
  },
})

const placeholder = (className: string) => () => ({ dom: element('div', className) })
const pageEmbedSpec = core.createBlockSpec(pageEmbedConfig, { render: placeholder('nd-page-embed') })
const linkEmbedSpec = core.createBlockSpec(linkEmbedConfig, { render: placeholder('nd-link-embed') })
const pluginBlockSpec = core.createBlockSpec(pluginBlockConfig, { render: placeholder('nd-plugin-block') })
const chartBlockSpec = core.createBlockSpec(chartBlockConfig, { render: placeholder('nd-chart') })

const mentionSpec = core.createInlineContentSpec(mentionConfig, {
  render: (inline: { props: { label: string } }) => {
    const dom = element('span', 'nd-mention')
    dom.textContent = `@${inline.props.label}`
    return { dom }
  },
})

/** The schema passed to `ServerBlockNoteEditor.create`. */
export const serverSchema = core.BlockNoteSchema.create({
  blockSpecs: {
    ...core.defaultBlockSpecs,
    [mathBlockConfig.type]: mathBlockSpec(),
    [calloutConfig.type]: calloutSpec(),
    [pageEmbedConfig.type]: pageEmbedSpec(),
    [linkEmbedConfig.type]: linkEmbedSpec(),
    [pluginBlockConfig.type]: pluginBlockSpec(),
    [chartBlockConfig.type]: chartBlockSpec(),
  },
  inlineContentSpecs: {
    ...core.defaultInlineContentSpecs,
    [inlineMathConfig.type]: inlineMathSpec,
    [mentionConfig.type]: mentionSpec,
  },
})
