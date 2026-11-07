import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { serverSchema } from './serverSchema'

/**
 * ServerBlockNoteEditor singleton.
 *
 * The web app uses a schema with shiki highlighting injected via `createCodeBlockSpec(codeBlockOptions)`,
 * but shiki (`@blocknote/code-block`) is not a server dependency, and `@blocknote/core` is not a direct
 * dependency of the server package, so neither can be imported. Fortunately BlockNote's default schema
 * (defaultBlockSpecs) already includes `codeBlock` (same block type name and propSchema), so even
 * without options code blocks survive the yDoc↔blocks↔markdown round trip. The server conversion needs no highlighter.
 *
 * ServerBlockNoteEditor uses JSDOM internally, so it is created lazily on first use to avoid boot cost.
 *
 * The schema adds the math block and inline nodes to the defaults (./serverSchema.ts, ADR 0995) so a
 * server read keeps them. The web's other custom nodes (callout, mention, embeds) are still unknown here.
 */
let editor: ServerBlockNoteEditor | null = null

/**
 * Install an in-memory localStorage on the JSDOM window.
 * server-util creates its JSDOM without a URL (about:blank = opaque origin), so merely touching
 * window.localStorage throws SecurityError. The toggle list (toggleListItem) renderer reads its
 * open state from localStorage, so blocksToFullHTML (public share view) returned 500 for documents
 * with toggles (2026-09-23). Server rendering never needs to remember open state, so an empty
 * in-memory store shared across requests is enough.
 */
function installMemoryStorage(ed: ServerBlockNoteEditor): void {
  const win = (ed as unknown as { jsdom?: { window?: object } }).jsdom?.window
  if (!win) return
  const data = new Map<string, string>()
  const storage = {
    get length() {
      return data.size
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => data.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void data.set(String(k), String(v)),
    removeItem: (k: string) => void data.delete(String(k)),
    clear: () => data.clear(),
  }
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(win, name, { configurable: true, get: () => storage })
  }
}

export function getServerEditor(): ServerBlockNoteEditor {
  if (!editor) {
    // serverSchema is untyped here (core's types are not resolvable from this package, see serverSchema.ts)
    type Options = Parameters<typeof ServerBlockNoteEditor.create>[0]
    editor = ServerBlockNoteEditor.create({ schema: serverSchema } as unknown as Options) as unknown as ServerBlockNoteEditor
    installMemoryStorage(editor)
  }
  return editor
}
