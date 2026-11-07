import type { CodeBlockOptions } from '@blocknote/core'

// Code block options without the static Shiki import (docs/adr/0704-route-and-feature-code-splitting.md).
//
// `@blocknote/code-block`'s `codeBlockOptions` builds its Shiki highlighter at module load, so
// importing it puts Shiki's core + regex engine (~150 KB raw / ~40 KB gzip) into the editor
// chunk. BlockNote only calls `createHighlighter()` asynchronously, so we hand it a loader that
// imports the package on first use and keep the language table (pure data) here.
//
// The table is a verbatim copy of @blocknote/code-block 0.51.4 `supportedLanguages` (the
// package is pinned — see package.json). Re-copy it when upgrading BlockNote.

type Lang = { name: string; aliases?: string[] }

export const supportedLanguages: Record<string, Lang> = {
  "text": { name: "Plain Text", aliases: ["text","txt","plain"] },
  "c": { name: "C", aliases: ["c"] },
  "cpp": { name: "C++", aliases: ["cpp","c++"] },
  "css": { name: "CSS", aliases: ["css"] },
  "glsl": { name: "GLSL", aliases: ["glsl"] },
  "graphql": { name: "GraphQL", aliases: ["graphql","gql"] },
  "haml": { name: "Ruby Haml", aliases: ["haml"] },
  "html": { name: "HTML", aliases: ["html"] },
  "java": { name: "Java", aliases: ["java"] },
  "javascript": { name: "JavaScript", aliases: ["javascript","js"] },
  "json": { name: "JSON", aliases: ["json"] },
  "jsonc": { name: "JSON with Comments", aliases: ["jsonc"] },
  "jsonl": { name: "JSON Lines", aliases: ["jsonl"] },
  "jsx": { name: "JSX", aliases: ["jsx"] },
  "julia": { name: "Julia", aliases: ["julia","jl"] },
  "less": { name: "Less", aliases: ["less"] },
  "markdown": { name: "Markdown", aliases: ["markdown","md"] },
  "mdx": { name: "MDX", aliases: ["mdx"] },
  "php": { name: "PHP", aliases: ["php"] },
  "postcss": { name: "PostCSS", aliases: ["postcss"] },
  "pug": { name: "Pug", aliases: ["pug","jade"] },
  "python": { name: "Python", aliases: ["python","py"] },
  "r": { name: "R", aliases: ["r"] },
  "regexp": { name: "RegExp", aliases: ["regexp","regex"] },
  "sass": { name: "Sass", aliases: ["sass"] },
  "scss": { name: "SCSS", aliases: ["scss"] },
  "shellscript": { name: "Shell", aliases: ["shellscript","bash","sh","shell","zsh"] },
  "sql": { name: "SQL", aliases: ["sql"] },
  "svelte": { name: "Svelte", aliases: ["svelte"] },
  "typescript": { name: "TypeScript", aliases: ["typescript","ts"] },
  "vue": { name: "Vue", aliases: ["vue"] },
  "vue-html": { name: "Vue HTML", aliases: ["vue-html"] },
  "wasm": { name: "WebAssembly", aliases: ["wasm"] },
  "wgsl": { name: "WGSL", aliases: ["wgsl"] },
  "xml": { name: "XML", aliases: ["xml"] },
  "yaml": { name: "YAML", aliases: ["yaml","yml"] },
  "tsx": { name: "TSX", aliases: ["tsx","typescriptreact"] },
  "haskell": { name: "Haskell", aliases: ["haskell","hs"] },
  "csharp": { name: "C#", aliases: ["c#","csharp","cs"] },
  "latex": { name: "LaTeX", aliases: ["latex"] },
  "lua": { name: "Lua", aliases: ["lua"] },
  "mermaid": { name: "Mermaid", aliases: ["mermaid","mmd"] },
  "ruby": { name: "Ruby", aliases: ["ruby","rb"] },
  "rust": { name: "Rust", aliases: ["rust","rs"] },
  "scala": { name: "Scala", aliases: ["scala"] },
  "swift": { name: "Swift", aliases: ["swift"] },
  "kotlin": { name: "Kotlin", aliases: ["kotlin","kt","kts"] },
  "objective-c": { name: "Objective C", aliases: ["objective-c","objc"] },
}

type Highlighter = Awaited<ReturnType<NonNullable<CodeBlockOptions['createHighlighter']>>>
type TokensOptions = { lang?: string } & Record<string, unknown>

/**
 * Token colours for both themes (docs/adr/1222-*). BlockNote's parser asks Shiki for the first loaded
 * theme only (github-dark), so code was light-on-dark even on the light theme. Every `codeToTokens`
 * call is answered with Shiki's dual-theme output instead: no inline colour, `--shiki-light` and
 * `--shiki-dark` on each token, and index.css picks one by the app theme. A theme switch is then pure
 * CSS (no re-highlighting). Everything else on the highlighter passes through unchanged.
 */
export function withBothThemes(h: Highlighter): Highlighter {
  const codeToTokens = (code: string, options: TokensOptions) =>
    (h.codeToTokens as (c: string, o: unknown) => unknown)(code, {
      lang: options.lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
  return new Proxy(h, {
    get(target, prop) {
      if (prop === 'codeToTokens') return codeToTokens
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

export const codeBlockOptions = {
  defaultLanguage: 'javascript',
  supportedLanguages,
  createHighlighter: () =>
    import('@blocknote/code-block').then(async (m) => {
      const create = m.codeBlockOptions.createHighlighter
      if (!create) throw new Error('code-block: no highlighter')
      return withBothThemes(await create())
    }),
} satisfies Partial<CodeBlockOptions>
