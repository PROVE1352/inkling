#!/usr/bin/env node
// Builds the GitHub Pages site into site/_site/:
//   - copies the landing pages (index.html, ko/) and assets/
//   - renders docs/*.md into docs/*.html with the site layout
//   - checks that every local href/src in the output points at a file (and heading) that exists
//
// Usage (Node 22+): node site/build.mjs
// The Markdown renderer (marked, pinned in site/package.json) is installed into site/node_modules on
// the first run. site/ is not part of the pnpm workspace, so the repo's lockfile is not touched.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SITE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(SITE, '..')
const DOCS = join(REPO, 'docs')
const OUT = join(SITE, '_site')
const GH = 'https://github.com/PROVE1352/inkling'
const BRANCH = 'main'

// ---------------------------------------------------------------------------
// marked (pinned in site/package.json)
// ---------------------------------------------------------------------------
function loadMarked() {
  const req = createRequire(join(SITE, 'package.json'))
  try {
    return req.resolve('marked')
  } catch {
    console.log('installing marked into site/node_modules …')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const args = existsSync(join(SITE, 'package-lock.json')) ? ['ci'] : ['install']
    execFileSync(npm, [...args, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: SITE, stdio: 'inherit' })
    return req.resolve('marked')
  }
}
const markedModule = await import(pathToFileURL(loadMarked()).href)
const Marked = markedModule.Marked ?? markedModule.default.Marked

// ---------------------------------------------------------------------------
// Which docs, in which order. Every top-level docs/*.md is rendered; the ones not listed here go
// under "More". docs/adr/ is not rendered, only linked on GitHub.
// ---------------------------------------------------------------------------
const GROUPS = [
  {
    title: 'Using Inkling',
    docs: [
      ['GUIDE', 'User guide', 'Where things are, for people using a server someone else runs.'],
      ['GUIDE.ko', '사용 설명서 (한국어)', '초대받아 쓰시는 분을 위한 한국어 설명서입니다.'],
      ['MCP', 'MCP connector', 'Connecting Claude and other MCP clients, the tools, and a guide for agents.'],
      ['TEMPLATES', 'Templates', 'Page and structure templates, variables, prompts and row templates.'],
      ['QUERY', 'Query blocks', 'The Dataview subset: TABLE, LIST, TASK, FROM, WHERE, SORT, LIMIT.'],
    ],
  },
  {
    title: 'Running a server',
    docs: [
      ['OPERATIONS', 'Operations', 'Deployment checklist, upgrades, the status summary, database tuning.'],
      ['BACKUP', 'Backup and restore', 'Schedules, encryption, GFS retention, restore tests, rclone copies.'],
      ['KNOWN-ISSUES', 'Known issues', 'Open problems by area and severity.'],
    ],
  },
  {
    title: 'Integrating',
    docs: [
      ['API', 'REST API', 'The REST contract shared by the web app, scripts and the MCP tools.'],
      ['WEBHOOKS', 'Webhooks', 'Receiving workspace events on your own endpoint.'],
      ['PLUGINS', 'Plugins (experimental)', 'Sandboxed iframe plugins: manifest, runtime API, security model.'],
      ['VAULT-SYNC', 'Vault sync (experimental)', 'Two-way sync with an Obsidian vault through inklingctl.'],
    ],
  },
  {
    title: 'Project',
    docs: [
      ['ARCHITECTURE', 'Architecture', 'How the server, collaboration and web app fit together.'],
      ['ROADMAP', 'Roadmap', 'Planned work and non-goals.'],
      ['PERFORMANCE', 'Performance log', 'Every performance change with numbers before and after.'],
    ],
  },
]
const EXTERNAL = [
  ['Design decisions (ADRs)', `${GH}/tree/${BRANCH}/docs/adr`],
  ['Changelog', `${GH}/blob/${BRANCH}/CHANGELOG.md`],
  ['Deployment notes', `${GH}/blob/${BRANCH}/deploy/DEPLOY.md`],
  ['Contributing', `${GH}/blob/${BRANCH}/CONTRIBUTING.md`],
  ['Security policy', `${GH}/blob/${BRANCH}/SECURITY.md`],
]

const allMd = readdirSync(DOCS)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
const listed = new Set(GROUPS.flatMap((g) => g.docs.map((d) => d[0])))
const extra = allMd.filter((n) => !listed.has(n)).sort()
if (extra.length) GROUPS.push({ title: 'More', docs: extra.map((n) => [n, n, '']) })
for (const g of GROUPS) g.docs = g.docs.filter(([n]) => allMd.includes(n))
const DOC_NAMES = new Set(allMd)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
const stripTags = (s) => s.replace(/<[^>]*>/g, '')

/** GitHub-style heading slug (github-slugger): lowercase, drop punctuation, spaces to hyphens. */
function slugger() {
  const seen = new Map()
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-')
    let slug = base
    if (seen.has(base)) {
      let n = seen.get(base)
      do slug = `${base}-${++n}`
      while (seen.has(slug))
      seen.set(base, n)
    }
    seen.set(slug, seen.get(slug) ?? 0)
    return slug
  }
}

/** Rewrites one relative link found in docs/<from>.md. */
function rewriteLink(href, kind) {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href
  const hashAt = href.indexOf('#')
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href
  const hash = hashAt >= 0 ? href.slice(hashAt) : ''
  if (!path) return href
  const repoPath = posix.normalize(posix.join('docs', decodeURI(path)))
  const m = /^docs\/([^/]+)\.md$/.exec(repoPath)
  if (m && DOC_NAMES.has(m[1])) return `${m[1]}.html${hash}`
  if (repoPath.startsWith('..')) return href
  const abs = join(REPO, repoPath)
  if (kind === 'src') return `https://raw.githubusercontent.com/PROVE1352/inkling/${BRANCH}/${encodeURI(repoPath)}`
  const isDir = existsSync(abs) && statSync(abs).isDirectory()
  if (!existsSync(abs)) warn(`link to missing repo path ${repoPath}`)
  return `${GH}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${encodeURI(repoPath.replace(/\/$/, ''))}${hash}`
}

const warnings = []
const warn = (msg) => warnings.push(msg)

// ---------------------------------------------------------------------------
// render one doc
// ---------------------------------------------------------------------------
function renderDoc(name) {
  const src = readFileSync(join(DOCS, `${name}.md`), 'utf8')
  const slug = slugger()
  const toc = []
  let title = null
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const text = decode(stripTags(inner)).trim()
        const id = slug(text)
        if (depth === 1 && title === null) {
          title = text
          return `<h1 id="${esc(id)}">${inner}</h1>\n`
        }
        if (depth === 2) toc.push({ id, html: inner })
        return `<h${depth} id="${esc(id)}">${inner}<a class="anchor" href="#${esc(id)}" aria-label="Link to this section">#</a></h${depth}>\n`
      },
    },
  })
  let html = marked.parse(src)
  html = html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/\b(href|src)="([^"]*)"/g, (all, attr, val) => `${attr}="${esc(rewriteLink(decode(val), attr))}"`)
  return { title: title ?? name, html, toc }
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------
function sideNav(current) {
  let out = ''
  for (const g of GROUPS) {
    out += `<h2>${esc(g.title)}</h2><ul>`
    for (const [n, label] of g.docs) {
      const cur = n === current ? ' aria-current="page"' : ''
      const lang = n.endsWith('.ko') ? ' lang="ko"' : ''
      out += `<li><a href="${n}.html"${cur}${lang}>${esc(label)}</a></li>`
    }
    out += '</ul>'
  }
  out += '<h2>On GitHub</h2><ul>'
  for (const [label, url] of EXTERNAL) out += `<li><a href="${url}">${esc(label)}</a></li>`
  out += '</ul>'
  return out
}

function page({ lang, title, description, current, body, toc, langLink }) {
  const ko = lang === 'ko'
  const home = ko ? '../ko/' : '../'
  return `<!doctype html>
<html lang="${lang}" class="no-js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · Inkling</title>
  ${description ? `<meta name="description" content="${esc(description)}">` : ''}
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#191919" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="../assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../assets/site.css">
  <script src="../assets/site.js" defer></script>
</head>
<body class="docs-body">
<a class="skip" href="#main">${ko ? '본문으로 건너뛰기' : 'Skip to content'}</a>
<header class="top">
  <div class="wrap" style="max-width:1280px">
    <a class="brand" href="${home}"><img src="../assets/icon.svg" alt="" width="28" height="28"><span>Inkling</span></a>
    <nav class="nav" aria-label="${ko ? '주 메뉴' : 'Main'}">
      <a href="./"${current === 'index' ? ' aria-current="page"' : ''}>${ko ? '문서' : 'Docs'}</a>
      <a href="${GH}">GitHub</a>
      ${langLink}
    </nav>
  </div>
</header>
<div class="docs-layout">
  <aside class="docs-side" aria-label="Documentation">${sideNav(current)}</aside>
  <main id="main" class="${current === 'index' ? 'doc-index' : 'prose'}">
    ${current === 'index' ? '' : `<details class="docs-pick"><summary>${ko ? '문서 목록' : 'All docs'}</summary><ul>${GROUPS.flatMap((g) => g.docs).map(([n, l]) => `<li><a href="${n}.html">${esc(l)}</a></li>`).join('')}</ul></details>`}
    ${body}
  </main>
  ${
    toc && toc.length > 1
      ? `<nav class="docs-toc" aria-label="${ko ? '이 문서의 목차' : 'On this page'}"><h2>${ko ? '목차' : 'On this page'}</h2><ul>${toc.map((t) => `<li><a href="#${esc(t.id)}">${stripTags(t.html)}</a></li>`).join('')}</ul></nav>`
      : ''
  }
</div>
<footer class="foot">
  <div class="wrap" style="max-width:1280px">
    <span>Inkling · MIT License</span>
    <nav aria-label="Footer">
      <a href="${GH}">GitHub</a>
      <a href="${GH}/blob/${BRANCH}/CHANGELOG.md">Changelog</a>
      <a href="${GH}/tree/${BRANCH}/docs/adr">ADRs</a>
      <a href="${GH}/blob/${BRANCH}/LICENSE">License</a>
    </nav>
  </div>
</footer>
</body>
</html>
`
}

function langLinkFor(name) {
  if (name === 'GUIDE') return '<a class="lang" href="GUIDE.ko.html" hreflang="ko" lang="ko">한국어</a>'
  if (name === 'GUIDE.ko') return '<a class="lang" href="GUIDE.html" hreflang="en" lang="en">English</a>'
  return '<a class="lang" href="../ko/" hreflang="ko" lang="ko">한국어</a>'
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'docs'), { recursive: true })

cpSync(join(SITE, 'index.html'), join(OUT, 'index.html'))
cpSync(join(SITE, 'ko'), join(OUT, 'ko'), { recursive: true })
cpSync(join(SITE, 'assets'), join(OUT, 'assets'), { recursive: true, filter: (p) => !/\.DS_Store$/.test(p) })
writeFileSync(join(OUT, '.nojekyll'), '')

const descriptions = new Map(GROUPS.flatMap((g) => g.docs.map(([n, , d]) => [n, d])))
for (const name of allMd) {
  const { title, html, toc } = renderDoc(name)
  const lang = name.endsWith('.ko') ? 'ko' : 'en'
  const edit = `${GH}/blob/${BRANCH}/docs/${name}.md`
  const meta = `<p class="doc-meta"><a href="${edit}">${lang === 'ko' ? 'GitHub에서 원문 보기' : 'View source on GitHub'}</a><a href="./">${lang === 'ko' ? '전체 문서' : 'All docs'}</a></p>`
  writeFileSync(
    join(OUT, 'docs', `${name}.html`),
    page({ lang, title, description: descriptions.get(name), current: name, body: html + meta, toc, langLink: langLinkFor(name) }),
  )
}

// docs index
{
  let body = '<h1>Documentation</h1><p>Rendered from the <code>docs/</code> folder of the repository at the published version.</p>'
  for (const g of GROUPS) {
    body += `<h2>${esc(g.title)}</h2><div class="grid two">`
    for (const [n, label, d] of g.docs) {
      const lang = n.endsWith('.ko') ? ' lang="ko"' : ''
      body += `<a class="card" href="${n}.html"${lang}><h3>${esc(label)}</h3>${d ? `<p>${esc(d)}</p>` : ''}</a>`
    }
    body += '</div>'
  }
  body += '<h2>On GitHub</h2><div class="grid two">'
  for (const [label, url] of EXTERNAL) body += `<a class="card" href="${url}"><h3>${esc(label)}</h3></a>`
  body += '</div>'
  writeFileSync(
    join(OUT, 'docs', 'index.html'),
    page({ lang: 'en', title: 'Documentation', description: 'Inkling documentation', current: 'index', body, toc: null, langLink: langLinkFor('') }),
  )
}

// ---------------------------------------------------------------------------
// check local links and anchors in the output
// ---------------------------------------------------------------------------
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const files = walk(OUT)
const htmlFiles = files.filter((f) => f.endsWith('.html'))
const idsOf = new Map()
const idsFor = (file) => {
  if (!idsOf.has(file)) {
    const ids = new Set()
    const s = readFileSync(file, 'utf8')
    for (const m of s.matchAll(/\sid="([^"]+)"/g)) ids.add(decode(m[1]))
    idsOf.set(file, ids)
  }
  return idsOf.get(file)
}
for (const file of htmlFiles) {
  // Comments (the promo-video slot) are not live references.
  const s = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  for (const m of s.matchAll(/\s(href|src|srcset)="([^"]*)"/g)) {
    const raw = decode(m[2])
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue
    const [path, hash] = raw.split('#')
    let target = path ? resolve(dirname(file), path) : file
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
    const where = relative(OUT, file)
    if (!existsSync(target)) {
      warn(`${where}: missing ${raw}`)
      continue
    }
    if (hash && target.endsWith('.html') && !idsFor(target).has(decodeURIComponent(hash))) warn(`${where}: missing anchor ${raw}`)
  }
}

const pngs = files.filter((f) => f.endsWith('.png'))
const big = pngs.filter((f) => statSync(f).size > 500 * 1024)
for (const f of big) warn(`large image ${relative(OUT, f)} (${Math.round(statSync(f).size / 1024)} KB)`)

console.log(`built ${relative(REPO, OUT)}: ${htmlFiles.length} pages, ${pngs.length} images`)
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  - ${w}`)
  if (process.argv.includes('--strict')) process.exit(1)
}
