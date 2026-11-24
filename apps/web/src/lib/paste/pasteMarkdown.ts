import { prepareMarkdownPaste, type PasteBlock } from './markdownNotation'

// Markdown paste with Inkling's math and callout notation (lib/paste/markdownNotation.ts).
//
// BlockNote's default paste handler decides by itself when a clipboard is Markdown (text/markdown,
// text/plain that looks like Markdown even next to HTML, or text/plain alone) and then calls
// `editor.pasteMarkdown`. That decision, the code-block case, files, `blocknote/html` and VS Code
// stay BlockNote's: only the Markdown step is replaced, for the duration of the synchronous default
// handler call, on this editor instance (no change to the BlockNote package, no `patches/` entry).
//
// `pasteMarkdown(md)` is `pasteHTML(markdownToHTML(md))`, which parses that HTML to blocks, serializes
// them back and pastes the result with one ProseMirror paste. Here the same steps run with the
// notation fix between parse and serialize, so a paste is still one transaction: one ⌘Z undoes it
// and a collaborator never sees the raw `$$` as blocks.

interface MarkdownPasteEditor {
  pasteMarkdown(markdown: string): void
  tryParseMarkdownToBlocks(markdown: string): unknown[]
  blocksToFullHTML(blocks: never[]): string
  pasteHTML(html: string, raw?: boolean): void
}

/** Pastes Markdown like BlockNote's `pasteMarkdown`, with math and callouts as Inkling blocks. */
export function pasteInklingMarkdown(editor: MarkdownPasteEditor, markdown: string, fallback: (md: string) => void): void {
  const prepared = prepareMarkdownPaste(markdown)
  if (!prepared) {
    fallback(markdown)
    return
  }
  const blocks = prepared.restore(editor.tryParseMarkdownToBlocks(prepared.markdown) as PasteBlock[])
  const html = editor.blocksToFullHTML(blocks as never[])
  if (html) editor.pasteHTML(html, true)
}

/** Runs BlockNote's default paste handler with `pasteMarkdown` going through `pasteInklingMarkdown`. */
export function withInklingMarkdown(editor: unknown, run: () => boolean | undefined): boolean | undefined {
  const ed = editor as MarkdownPasteEditor
  const own = Object.prototype.hasOwnProperty.call(ed, 'pasteMarkdown')
  const original = ed.pasteMarkdown
  ed.pasteMarkdown = (md: string) => pasteInklingMarkdown(ed, md, (m) => original.call(ed, m))
  try {
    return run()
  } finally {
    if (own) ed.pasteMarkdown = original
    else delete (ed as Partial<MarkdownPasteEditor>).pasteMarkdown
  }
}
