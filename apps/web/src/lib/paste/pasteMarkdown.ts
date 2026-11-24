import { prepareKatexHtml } from './katexHtml'
import { prepareMarkdownPaste, type PasteBlock } from './markdownNotation'

// Paste with Inkling's math and callout notation (lib/paste/markdownNotation.ts) and rendered KaTeX
// (lib/paste/katexHtml.ts).
//
// BlockNote's default paste handler decides by itself what the clipboard is (text/markdown, text/plain
// that looks like Markdown even next to HTML, HTML, or text/plain alone) and then calls
// `editor.pasteMarkdown` or `editor.pasteHTML`. That decision, the code-block case, files,
// `blocknote/html` (a raw paste) and VS Code stay BlockNote's: only the Markdown and the non-raw HTML
// steps are replaced, for the duration of the synchronous default handler call, on this editor
// instance (no change to the BlockNote package, no `patches/` entry).
//
// `pasteMarkdown(md)` is `pasteHTML(markdownToHTML(md))`, and a non-raw `pasteHTML(html)` parses the
// HTML to blocks, serializes them back and pastes the result with one ProseMirror paste. Here the
// same steps run with the notation fix between parse and serialize, so a paste is still one
// transaction: one ⌘Z undoes it and a collaborator never sees the raw `$$` as blocks. When there is
// nothing to convert the original method runs unchanged.

interface PasteEditor {
  pasteMarkdown(markdown: string): void
  pasteHTML(html: string, raw?: boolean): void
  tryParseMarkdownToBlocks(markdown: string): unknown[]
  tryParseHTMLToBlocks(html: string): unknown[]
  blocksToFullHTML(blocks: never[]): string
}

function pasteBlocks(editor: PasteEditor, blocks: PasteBlock[]): void {
  const html = editor.blocksToFullHTML(blocks as never[])
  if (html) editor.pasteHTML(html, true)
}

/** Pastes Markdown like BlockNote's `pasteMarkdown`, with math and callouts as Inkling blocks. */
export function pasteInklingMarkdown(editor: PasteEditor, markdown: string, fallback: (md: string) => void): void {
  const prepared = prepareMarkdownPaste(markdown)
  if (!prepared) return fallback(markdown)
  pasteBlocks(editor, prepared.restore(editor.tryParseMarkdownToBlocks(prepared.markdown) as PasteBlock[]))
}

/** Pastes HTML like BlockNote's non-raw `pasteHTML`, with KaTeX formulas as math nodes. */
export function pasteInklingHtml(editor: PasteEditor, html: string, fallback: (html: string) => void): void {
  const prepared = prepareKatexHtml(html, (s) => new DOMParser().parseFromString(s, 'text/html'))
  if (!prepared) return fallback(html)
  pasteBlocks(editor, prepared.restore(editor.tryParseHTMLToBlocks(prepared.html) as PasteBlock[]))
}

/** Runs BlockNote's default paste handler with Markdown and HTML going through the functions above. */
export function withInklingPaste(editor: unknown, run: () => boolean | undefined): boolean | undefined {
  const ed = editor as PasteEditor
  const ownMd = Object.prototype.hasOwnProperty.call(ed, 'pasteMarkdown')
  const ownHtml = Object.prototype.hasOwnProperty.call(ed, 'pasteHTML')
  const pasteMarkdown = ed.pasteMarkdown
  const pasteHTML = ed.pasteHTML
  ed.pasteMarkdown = (md: string) => pasteInklingMarkdown(ed, md, (m) => pasteMarkdown.call(ed, m))
  ed.pasteHTML = (html: string, raw = false) =>
    raw ? pasteHTML.call(ed, html, true) : pasteInklingHtml(ed, html, (h) => pasteHTML.call(ed, h, false))
  try {
    return run()
  } finally {
    if (ownMd) ed.pasteMarkdown = pasteMarkdown
    else delete (ed as Partial<PasteEditor>).pasteMarkdown
    if (ownHtml) ed.pasteHTML = pasteHTML
    else delete (ed as Partial<PasteEditor>).pasteHTML
  }
}
