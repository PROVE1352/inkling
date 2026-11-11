#!/usr/bin/env node
// Builds the GitHub Pages site into site/_site/:
//   - copies the landing pages (index.html, ko/index.html) and assets/, filling in {{…}} placeholders
//     (the version from apps/server/package.json, links to the Korean or English version of a doc,
//     the drawings in figures.mjs, the strip of section links)
//   - renders docs/*.md and deploy/DEPLOY*.md into docs/*.html with the site layout (English or Korean
//     chrome by the file name: NAME.ko.md is Korean) and copies each source next to it as docs/NAME.md.
//     Tables keep every cell in the HTML; a class picked from the header row lets CSS show wide ones
//     as cards (see "tables" below), so no page needs sideways scrolling
//   - writes the tour (tour/index.html, ko/tour/index.html and an index.md beside each) from assets/tour.js
//   - writes llms.txt from site/llms.txt
//   - checks that every local href/src in the output points at a file (and heading) that exists, and that
//     no local link ends at a folder (file:// would show a directory listing there)
//
// Usage (Node 22+): node site/build.mjs [--strict]
// The Markdown renderer (marked, pinned in site/package.json) is installed into site/node_modules on
// the first run. site/ is not part of the pnpm workspace, so the repo's lockfile is not touched.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { figure, iconSvg } from './figures.mjs'

const SITE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(SITE, '..')
const OUT = join(SITE, '_site')
const GH = 'https://github.com/PROVE1352/inkling'
const BRANCH = 'main'
/** Where GitHub Pages publishes the site; used for canonical, hreflang and Open Graph URLs only. */
const BASE_URL = 'https://prove1352.github.io/inkling/'
const VERSION = JSON.parse(readFileSync(join(REPO, 'apps/server/package.json'), 'utf8')).version

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
// Which docs. Every top-level docs/*.md is rendered, and deploy/DEPLOY.md (+ DEPLOY.ko.md when it exists).
// NAME.ko.md is the Korean version of NAME.md. Docs not listed in GROUPS go under "More".
// docs/adr/ is not rendered, only linked on GitHub.
// ---------------------------------------------------------------------------
/** name -> repo path of its Markdown source */
const SOURCES = new Map()
for (const f of readdirSync(join(REPO, 'docs')).filter((f) => f.endsWith('.md'))) SOURCES.set(f.slice(0, -3), `docs/${f}`)
for (const n of ['DEPLOY', 'DEPLOY.ko']) if (existsSync(join(REPO, 'deploy', `${n}.md`))) SOURCES.set(n, `deploy/${n}.md`)
const BY_PATH = new Map([...SOURCES].map(([n, p]) => [p, n]))
const hasDoc = (n) => SOURCES.has(n)
const isKo = (n) => n.endsWith('.ko')
const baseOf = (n) => (isKo(n) ? n.slice(0, -3) : n)
/** The other-language version of a doc, if there is one. */
const pairOf = (n) => (isKo(n) ? (hasDoc(baseOf(n)) ? baseOf(n) : null) : hasDoc(`${n}.ko`) ? `${n}.ko` : null)

// [name, English label, English description, Korean label, Korean description]
const GROUPS = [
  {
    en: 'Using Inkling',
    ko: 'Inkling 쓰기',
    docs: [
      ['GUIDE', 'User guide', 'Where things are, for people using a server someone else runs.', '사용 설명서', '초대받아 쓰시는 분을 위한 설명서입니다. 메뉴가 어디 있는지 찾기 쉽게 정리했습니다.'],
      ['MCP', 'MCP connector and agent guide', 'Connecting Claude and other MCP clients, every tool, and a guide for agents.', 'MCP 연결과 에이전트 안내', 'Claude와 다른 MCP 클라이언트 연결, 도구 목록, 에이전트가 따를 순서를 적은 문서입니다.'],
      ['RECIPES', 'Recipes with other MCP servers', 'Inkling next to game engines, design tools and code hosts.', '다른 MCP 서버와 같이 쓰기', '게임 엔진, 디자인 도구, 코드 저장소 같은 다른 MCP 서버와 같이 쓰는 예시입니다.'],
      ['TEMPLATES', 'Templates', 'Page and structure templates, variables, prompts and row templates.', '템플릿', '페이지와 구조 템플릿, 변수, 입력 질문, 행 템플릿.'],
      ['QUERY', 'Query blocks', 'The Dataview subset: TABLE, LIST, TASK, FROM, WHERE, SORT, LIMIT.', '쿼리 블록', 'Dataview 문법 일부: TABLE, LIST, TASK, FROM, WHERE, SORT, LIMIT.'],
    ],
  },
  {
    en: 'Running a server',
    ko: '서버 운영',
    docs: [
      ['DEPLOY', 'Deployment', 'A Linux server step by step: HTTPS, signup keys, mail, sign-in options, semantic search, updates.', '배포', '리눅스 서버에 올리는 순서: HTTPS, 가입 키, 메일, 로그인 방식, 의미 검색, 업데이트.'],
      ['OPERATIONS', 'Operations', 'Deployment checklist, upgrades, the status summary, database tuning.', '운영', '배포 점검표, 업그레이드, 상태 요약, 데이터베이스 튜닝.'],
      ['BACKUP', 'Backup and restore', 'Schedules, encryption, GFS retention, restore tests, rclone copies.', '백업과 복원', '일정, 암호화, GFS 보관, 복원 테스트, rclone 외부 사본.'],
      ['KNOWN-ISSUES', 'Known issues', 'Open problems by area and severity.', '알려진 문제', '아직 남은 문제를 영역과 심각도별로 정리했습니다.'],
    ],
  },
  {
    en: 'Integrating',
    ko: '연동',
    docs: [
      ['API', 'REST API', 'The REST contract shared by the web app, scripts and the MCP tools.', 'REST API', '웹 앱, 스크립트, MCP 도구가 함께 쓰는 REST 계약.'],
      ['WEBHOOKS', 'Webhooks', 'Receiving workspace events on your own endpoint.', '웹훅', '워크스페이스 이벤트를 내 주소로 받는 방법.'],
      ['PLUGINS', 'Plugins (experimental)', 'Sandboxed iframe plugins: manifest, runtime API, security model.', '플러그인(실험 기능)', '샌드박스 iframe 플러그인의 매니페스트, 런타임 API, 보안 모델.'],
      ['VAULT-SYNC', 'Vault sync (experimental)', 'Two-way sync with an Obsidian vault through inklingctl.', '볼트 동기화(실험 기능)', 'inklingctl로 옵시디언 볼트와 양방향 동기화.'],
    ],
  },
  {
    en: 'Project',
    ko: '프로젝트',
    docs: [
      ['ARCHITECTURE', 'Architecture', 'How the server, collaboration and web app fit together.', '구조', '서버, 동시 편집, 웹 앱이 어떻게 맞물리는지.'],
      ['ROADMAP', 'Roadmap', 'Planned work and non-goals.', '로드맵', '앞으로 할 일과 하지 않을 일.'],
      ['PERFORMANCE', 'Performance log', 'Every performance change with numbers before and after, and how they were measured.', '성능 기록', '성능을 손본 변경마다 전후 수치와 잰 방법을 적은 기록.'],
    ],
  },
]
const EXTERNAL = [
  ['Design decisions (ADRs)', '설계 결정(ADR)', `${GH}/tree/${BRANCH}/docs/adr`, false],
  ['Changelog', '변경 기록', `${GH}/blob/${BRANCH}/CHANGELOG.md`, false],
  ['README', 'README', `${GH}/blob/${BRANCH}/README.md`, `${GH}/blob/${BRANCH}/README.ko.md`],
  ['Contributing', '기여 안내', `${GH}/blob/${BRANCH}/CONTRIBUTING.md`, false],
  ['Security policy', '보안 정책', `${GH}/blob/${BRANCH}/SECURITY.md`, false],
]

const listed = new Set(GROUPS.flatMap((g) => g.docs.map((d) => d[0])))
const extra = [...SOURCES.keys()].filter((n) => !isKo(n) && !listed.has(n)).sort()
if (extra.length) GROUPS.push({ en: 'More', ko: '그 밖의 문서', docs: extra.map((n) => [n, n, '', n, '']) })
for (const g of GROUPS) g.docs = g.docs.filter(([n]) => hasDoc(n))
// A Korean doc without an English one still gets a place in the Korean lists.
for (const n of SOURCES.keys()) if (isKo(n) && !hasDoc(baseOf(n))) GROUPS.at(-1).docs.push([baseOf(n), n, '', n, ''])
const DOC_INFO = new Map(GROUPS.flatMap((g) => g.docs.map((d) => [d[0], d])))

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

const warnings = []
const warn = (msg) => warnings.push(msg)

/** Rewrites one relative link found in the Markdown source at repo path `from`. */
function rewriteLink(href, kind, from) {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href
  const hashAt = href.indexOf('#')
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href
  const hash = hashAt >= 0 ? href.slice(hashAt) : ''
  if (!path) return href
  const repoPath = posix.normalize(posix.join(posix.dirname(from), decodeURI(path)))
  if (BY_PATH.has(repoPath)) return `${BY_PATH.get(repoPath)}.html${hash}`
  if (repoPath.startsWith('..')) return href
  const abs = join(REPO, repoPath)
  if (kind === 'src') return `https://raw.githubusercontent.com/PROVE1352/inkling/${BRANCH}/${encodeURI(repoPath)}`
  const isDir = existsSync(abs) && statSync(abs).isDirectory()
  if (!existsSync(abs)) warn(`${from}: link to missing repo path ${repoPath}`)
  return `${GH}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${encodeURI(repoPath.replace(/\/$/, ''))}${hash}`
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------
// Tables. A Markdown table stays one <table> in the output (every cell's text is in the static HTML, in
// source order), and a class picks how CSS lays it out:
//   t-perf      "Area | Change | Before | After | Improvement | Cost | How measured | Source": one card per
//               row, before and after side by side, the method folded into <details>
//   t-endpoint  first two columns are Method and Path: one card per row with a method badge
//   t-recs      five or more columns with long cells: one card per row, cells labelled by their header
//   t-auto      a table that becomes cards only when its container is narrow
//   t-keep      small tables that fit a phone as they are
// Text the site adds on top of the source (the <summary> label) carries data-x, so a checker can drop it.
const PERF_ROLES = [
  ['before', /^(전|before)$/i],
  ['after', /^(후|after)$/i],
  ['gain', /^(개선|improvement|gain)$/i],
  ['cost', /^(비용|cost)$/i],
  ['method', /^(측정 방법|how measured)$/i],
  ['source', /^(출처|source)$/i],
]
const plain = (s) => s.replace(/[`*]/g, '').trim()
/** First "number unit" of a before/after cell, with the words in front of it. */
function firstQuantity(text) {
  const m = plain(text).match(/^(.{0,14}?)(?:≈ ?|~ ?)?(\d[\d,]*(?:\.\d+)?)\s?(ms|s|µs|tokens|tok|KB|MB|GB|kB|%|번|개|calls|bytes)(?![A-Za-z])/)
  return m ? { pre: m[1].trim(), value: Number(m[2].replace(/,/g, '')), unit: m[3] } : null
}
/** Wraps the first percentage or multiplier of an HTML fragment (outside tags) in <b class="num">. */
function markFirstFigure(html) {
  let done = false
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (done || part.startsWith('<')) return part
      return part.replace(/[−+-]?\d[\d,.]*(?:[–-]\d[\d,.]*)?\s?(?:%|×)/, (m) => {
        done = true
        return `<b class="num">${m}</b>`
      })
    })
    .join('')
}

function renderTable(token, parser, ctx) {
  const heads = token.header.map((c) => ({ html: parser.parseInline(c.tokens), text: plain(c.text) }))
  const cols = heads.length
  const label = (i) => (heads[i].text ? ` data-label="${esc(heads[i].text)}"` : '')
  const cell = (c) => parser.parseInline(c.tokens)
  const empty = (c) => !c.text.trim()
  const maxCell = Math.max(0, ...token.rows.flatMap((r) => r.map((c) => c.text.length)))
  const thead = `<thead><tr>${heads.map((h) => `<th scope="col">${h.html}</th>`).join('')}</tr></thead>`

  const roles = heads.map((h, i) => (PERF_ROLES.find(([, re]) => re.test(h.text)) ?? [i === 0 ? 'area' : i === 1 ? 'change' : 'extra'])[0])
  const isPerf = cols >= 7 && ['before', 'after', 'gain'].every((r) => roles.includes(r)) && roles.indexOf('after') === roles.indexOf('before') + 1
  const isEndpoint = cols >= 3 && /^(메서드|method)$/i.test(heads[0].text) && /^(경로|path)$/i.test(heads[1].text)

  let kind
  let body = ''
  if (isPerf) {
    kind = 't-perf'
    const bi = roles.indexOf('before')
    for (const row of token.rows) {
      const a = firstQuantity(row[bi].text)
      const b = firstQuantity(row[bi + 1].text)
      // A bar only when both cells open with the same measure in the same unit.
      const bars = a && b && a.unit === b.unit && a.pre === b.pre && a.value > 0 && b.value > 0 ? [a.value, b.value] : null
      const top = bars ? Math.max(...bars) : 0
      body += '<tr class="rec">'
      row.forEach((c, i) => {
        const role = roles[i]
        let inner = cell(c)
        // "none", "not claimed" and a dash are not improvements; rejected and regression sections never are.
        const flat = role === 'gain' && (ctx.tone !== 'gain' || /^(—|–|-|없음|주장하지 않음|내세우지 않음|none|no claim|not claimed|n\/a)/i.test(plain(c.text)))
        if (role === 'gain' && !flat) inner = markFirstFigure(inner)
        if (role === 'method' && !empty(c)) inner = `<details><summary data-x>${heads[i].html}</summary><div class="fold">${inner}</div></details>`
        if (bars && (role === 'before' || role === 'after')) {
          const w = Math.max(2, Math.round((bars[role === 'before' ? 0 : 1] / top) * 100))
          inner += `<span class="bar" aria-hidden="true" style="--w:${w}%"></span>`
        }
        // A source that is a sentence, not a link or two, goes under the card instead of beside its title.
        const long = role === 'source' && plain(c.text).replace(/\]\([^)]*\)/g, ']').length > 60
        body += `<td class="c-${role}${flat ? ' is-flat' : ''}${long ? ' is-long' : ''}${empty(c) ? ' is-empty' : ''}"${label(i)}>${inner}</td>`
      })
      body += '</tr>'
    }
  } else if (isEndpoint) {
    kind = 't-endpoint'
    for (const row of token.rows) {
      const method = plain(row[0].text)
      const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : 'MULTI'
      body += `<tr class="rec" data-method="${m}">`
      row.forEach((c, i) => {
        const cls = i === 0 ? 'c-method' : i === 1 ? 'c-path' : 'c-field'
        body += `<td class="${cls}${empty(c) ? ' is-empty' : ''}"${label(i)}>${cell(c)}</td>`
      })
      body += '</tr>'
    }
  } else {
    // A table whose one column reads like paragraphs (the MCP tool list: name, kind, a long description) is
    // easier to read as cards at any width: the name as the title, the short cells as badges, the text below.
    const avg = heads.map((_, i) => token.rows.reduce((n, r) => n + r[i].text.length, 0) / Math.max(1, token.rows.length))
    const bodyCol = avg.indexOf(Math.max(...avg))
    const isDoc = cols >= 3 && avg[bodyCol] >= 400
    kind = isDoc ? 't-recs t-doc' : cols >= 5 && maxCell > 40 ? 't-recs' : (cols <= 2 && maxCell <= 24) || (cols === 3 && maxCell <= 12) ? 't-keep' : 't-auto'
    // Short cells (numbers, yes/no) keep their first column on one line.
    if (maxCell <= 40) kind += ' t-short'
    for (const row of token.rows) {
      body += '<tr class="rec">'
      row.forEach((c, i) => {
        const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : ''
        // "0.848 → 0.897": the two values are marked up so the second one can stand out.
        const pair = c.tokens.length === 1 && c.tokens[0].type === 'text' ? c.text.match(/^(\S+) → (\S+)$/) : null
        const inner = pair ? `<span class="ba"><span class="ba-b">${esc(pair[1])} →</span> <span class="ba-a">${esc(pair[2])}</span></span>` : cell(c)
        // As a card, short values sit side by side and a long one takes the full width.
        // A short name in the first column (a tool, a variable, a field) is never folded: c-name.
        const cls = i === 0 ? (plain(c.text).length <= 24 ? 'c-title c-name' : 'c-title') : isDoc && i === bodyCol ? 'c-field c-wide c-body' : c.text.length > 48 || /\S{17,}/.test(plain(c.text)) ? 'c-field c-wide' : 'c-field'
        body += `<td class="${cls}${empty(c) ? ' is-empty' : ''}"${label(i)}${align}>${inner}</td>`
      })
      body += '</tr>'
    }
  }
  const cards = /t-(perf|endpoint|recs)/.test(kind)
  const tone = isPerf ? ` data-tone="${ctx.tone}"` : ''
  return `<div class="table-wrap${cards ? ' has-cards' : ''}"${tone}><table class="${kind}${cards ? ' cards' : ''}" data-cols="${cols}">${thead}<tbody>${body}</tbody></table></div>\n`
}

// ---------------------------------------------------------------------------
// render one doc
// ---------------------------------------------------------------------------
function renderDoc(name) {
  const from = SOURCES.get(name)
  const src = readFileSync(join(REPO, from), 'utf8')
  const slug = slugger()
  const toc = []
  let title = null
  let h1 = null
  // How the "Improvement" column of a performance table reads in the current section.
  const ctx = { tone: 'gain' }
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const text = decode(stripTags(inner)).trim()
        const id = slug(text)
        if (depth === 1 && title === null) {
          title = text
          h1 = `<h1 id="${esc(id)}">${inner}</h1>`
          return ''
        }
        if (depth === 2) {
          toc.push({ id, html: inner })
          ctx.tone = /회귀|regression/i.test(text) ? 'regress' : /채택하지 않음|효과 없음|rejected|not adopted|no effect/i.test(text) ? 'neutral' : 'gain'
        }
        // No "#" link next to the heading: a link must have a visible text name (the TOC links every h2).
        return `<h${depth} id="${esc(id)}">${inner}</h${depth}>\n`
      },
      table(token) {
        return renderTable(token, this.parser, ctx)
      },
    },
  })
  let html = marked.parse(src)
  html = html
    // "- **Severity** (ID) text" lines (KNOWN-ISSUES): the severity becomes a badge and a filter key.
    .replace(/<li>(<p>)?(<del>)?<strong>(High|Medium|Low|Info)<\/strong>( \(([^()<]{1,120})\))?/g, (_, p = '', del = '', sev, idPart = '', id) => {
      const idHtml = idPart ? ` <span class="issue-id">(${id})</span>` : ''
      return `<li class="issue" data-sev="${sev.toLowerCase()}"${del ? ' data-fixed' : ''}>${p}${del}<strong class="sev">${sev}</strong>${idHtml}`
    })
    // Inline code wraps at spaces and stays whole otherwise; only a token too long to fit a column
        // (over 30 characters: a URL, a long path) may be broken anywhere.
    .replace(/<code>([^<]*)<\/code>/g, (all, inner) => (/\S{31,}/.test(decode(inner)) ? `<code class="long">${inner}</code>` : all))
    .replace(/\b(href|src)="([^"]*)"/g, (all, attr, val) => `${attr}="${esc(rewriteLink(decode(val), attr, from))}"`)
  return { title: title ?? name, h1: h1 ?? `<h1>${esc(name)}</h1>`, html, toc }
}

// ---------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------
/** "한국어 | English", the current one marked. Both hrefs are relative file paths. */
function langSwitch(lang, koHref, enHref) {
  const ko = lang === 'ko'
  return `<span class="langs" role="group" aria-label="${ko ? '언어' : 'Language'}"><a href="${koHref}" hreflang="ko" lang="ko"${ko ? ' aria-current="true"' : ''}>한국어</a><a href="${enHref}" hreflang="en" lang="en"${ko ? '' : ' aria-current="true"'}>English</a></span>`
}

/** Link to a doc as seen from a page in `lang` that sits `prefix` away from docs/ ('' inside docs/). */
function docLink(name, lang, prefix = '') {
  if (lang === 'ko' && hasDoc(`${name}.ko`)) return { href: `${prefix}${name}.ko.html`, en: false }
  if (hasDoc(name)) return { href: `${prefix}${name}.html`, en: lang === 'ko' }
  return { href: `${prefix}${name}.ko.html`, en: false }
}
const EN_MARK = ' <span class="en-mark">(영어)</span>'

function sideNav(current, lang) {
  const ko = lang === 'ko'
  let out = ''
  for (const g of GROUPS) {
    out += `<h2>${esc(ko ? g.ko : g.en)}</h2><ul>`
    for (const [n, enLabel, , koLabel] of g.docs) {
      const { href, en } = docLink(n, lang)
      const target = href.replace(/\.html$/, '')
      const cur = target === current ? ' aria-current="page"' : ''
      out += `<li><a href="${href}"${cur}>${esc(ko ? koLabel : enLabel)}${en ? EN_MARK : ''}</a></li>`
    }
    out += '</ul>'
  }
  out += `<h2>${ko ? 'GitHub에서' : 'On GitHub'}</h2><ul>`
  for (const [enLabel, koLabel, url, koUrl] of EXTERNAL) {
    const en = ko && !koUrl
    out += `<li><a href="${ko && koUrl ? koUrl : url}">${esc(ko ? koLabel : enLabel)}${en ? EN_MARK : ''}</a></li>`
  }
  return out + '</ul>'
}

function head({ lang, title, description, canonical, alternates, ogImage, ogType, extra = '' }) {
  const alt = alternates ? Object.entries(alternates).map(([l, u]) => `<link rel="alternate" hreflang="${l}" href="${u}">`).join('\n  ') : ''
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  ${description ? `<meta name="description" content="${esc(description)}">` : ''}
  <link rel="canonical" href="${canonical}">
  ${alt}
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#191919" media="(prefers-color-scheme: dark)">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="Inkling">
  <meta property="og:title" content="${esc(title)}">
  ${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:locale" content="${lang === 'ko' ? 'ko_KR' : 'en_US'}">
  ${extra}`
}

// ---------------------------------------------------------------------------
// docs layout
// ---------------------------------------------------------------------------
function page({ lang, name, title, description, body, toc, mdHref }) {
  const ko = lang === 'ko'
  const isIndex = name === 'index' || name === 'index.ko'
  const pair = isIndex ? (ko ? 'index' : 'index.ko') : pairOf(name)
  const koHref = ko ? `${name}.html` : pair ? `${pair}.html` : '../ko/index.html'
  const enHref = ko ? (pair ? `${pair}.html` : '../index.html') : `${name}.html`
  const url = (n) => `${BASE_URL}docs/${n}.html`
  const alternates = pair ? { [lang]: url(name), [ko ? 'en' : 'ko']: url(pair) } : null
  const docsIndex = ko ? 'index.ko.html' : 'index.html'
  const all = GROUPS.flatMap((g) => g.docs)
  return `<!doctype html>
<html lang="${lang}" class="no-js">
<head>
  ${head({
    lang,
    title: `${title} · Inkling`,
    description,
    canonical: url(name),
    alternates,
    ogImage: `${BASE_URL}assets/${ko ? 'ko' : 'en'}/doc-light.png`,
    ogType: 'article',
    extra: mdHref ? `<link rel="alternate" type="text/markdown" href="${mdHref}" title="${ko ? '이 문서의 Markdown 원문' : 'This page as Markdown'}">` : '',
  })}
  <link rel="icon" href="../assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../assets/site.css">
  <script src="../assets/site.js" defer></script>
</head>
<body class="docs-body">
<a class="skip" href="#main">${ko ? '본문으로 건너뛰기' : 'Skip to content'}</a>
<header class="top">
  <div class="wrap wide">
    <a class="brand" href="${ko ? '../ko/index.html' : '../index.html'}"><img src="../assets/icon.svg" alt="" width="28" height="28"><span>Inkling</span></a>
    <nav class="nav" aria-label="${ko ? '주 메뉴' : 'Main'}">
      <a class="hide-sm" href="${ko ? '../ko/tour/index.html' : '../tour/index.html'}">${ko ? '둘러보기' : 'Tour'}</a>
      <a href="${docsIndex}"${isIndex ? ' aria-current="page"' : ''}>${ko ? '문서' : 'Docs'}</a>
      <a class="hide-sm" href="${GH}">GitHub</a>
      ${langSwitch(lang, koHref, enHref)}
    </nav>
  </div>
</header>
<div class="docs-layout${toc && toc.length > 1 ? ' has-toc' : ''}">
  <nav class="docs-side" aria-label="${ko ? '문서 목록' : 'Documentation'}">${sideNav(name, lang)}</nav>
  <main id="main" class="${isIndex ? 'doc-index' : 'prose'}">
    ${
      isIndex
        ? ''
        : `<details class="docs-pick"><summary>${ko ? '문서 목록' : 'All docs'}</summary><ul>${all
            .map(([n, l, , kl]) => {
              const d = docLink(n, lang)
              return `<li><a href="${d.href}">${esc(ko ? kl : l)}${d.en ? EN_MARK : ''}</a></li>`
            })
            .join('')}</ul></details>`
    }
    ${body}
  </main>
  ${
    toc && toc.length > 1
      ? `<nav class="docs-toc" aria-label="${ko ? '이 문서의 목차' : 'On this page'}" data-toc><h2>${ko ? '목차' : 'On this page'}</h2><ul>${toc.map((t) => `<li><a href="#${esc(t.id)}">${stripTags(t.html)}</a></li>`).join('')}</ul></nav>`
      : ''
  }
</div>
<footer class="foot">
  <div class="wrap wide">
    <span>Inkling ${esc(`v${VERSION}`)}</span>
    <nav aria-label="${ko ? '바닥글' : 'Footer'}">
      <a href="${GH}">GitHub</a>
      <a href="${GH}/blob/${BRANCH}/CHANGELOG.md">${ko ? '변경 기록' : 'Changelog'}</a>
      <a href="${GH}/tree/${BRANCH}/docs/adr">ADR</a>
      <a href="../llms.txt">llms.txt</a>
    </nav>
  </div>
</footer>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// landing pages: {{…}} placeholders
//   {{VERSION}}          v0.20.0 (from apps/server/package.json)
//   {{VERSION_NUMBER}}   0.20.0
//   {{DOCS_INDEX}}       the docs index in this page's language
//   {{DOC:NAME}}         href of a doc in this page's language (the Korean version on ko/ when it exists)
//   {{MD:NAME}}          the same doc's Markdown source (docs/NAME.ko.md or docs/NAME.md)
//   {{EN:NAME}}          on ko/: " (영어)" when the link above goes to an English doc, else nothing
//   {{FIG:name}}         a drawing from figures.mjs in this page's language
//   {{ICON:name}}        a small icon from figures.mjs
//   {{SECTIONS}}         links to the page's sections, named by each section's kicker
// ---------------------------------------------------------------------------
function sectionStrip(src, lang) {
  const links = [...src.matchAll(/<section class="block[^"]*" id="([a-z-]+)"[\s\S]*?<p class="kicker">([^<]+)<\/p>/g)].map(([, id, label]) => `<a href="#${id}">${label}</a>`)
  return `<nav class="sections" data-sections aria-label="${lang === 'ko' ? '이 쪽의 절' : 'Sections of this page'}"><div class="wrap">${links.join('')}</div></nav>`
}
function fillLanding(src, lang, prefix, where) {
  const out = src
    .replace(/\{\{SECTIONS\}\}/g, () => sectionStrip(src, lang))
    .replace(/\{\{FIG:([a-z]+)\}\}/g, (all, n) => figure(n, lang) ?? all)
    .replace(/\{\{ICON:([a-z]+)\}\}/g, (all, n) => iconSvg(n) ?? all)
    .replace(/\{\{VERSION\}\}/g, `v${VERSION}`)
    .replace(/\{\{VERSION_NUMBER\}\}/g, VERSION)
    .replace(/\{\{DOCS_INDEX\}\}/g, `${prefix}${lang === 'ko' ? 'index.ko.html' : 'index.html'}`)
    .replace(/\{\{DOC:([A-Z0-9.-]+)\}\}/g, (_, n) => {
      if (!hasDoc(n) && !hasDoc(`${n}.ko`)) warn(`${where}: no doc named ${n}`)
      return docLink(n, lang, prefix).href
    })
    .replace(/\{\{MD:([A-Z0-9.-]+)\}\}/g, (_, n) => docLink(n, lang, prefix).href.replace(/\.html$/, '.md'))
    .replace(/\{\{EN:([A-Z0-9.-]+)\}\}/g, (_, n) => (docLink(n, lang, prefix).en ? EN_MARK : ''))
  for (const m of out.matchAll(/\{\{[^}]*\}\}/g)) warn(`${where}: unknown placeholder ${m[0]}`)
  return out
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'docs'), { recursive: true })
mkdirSync(join(OUT, 'ko'), { recursive: true })

writeFileSync(join(OUT, 'index.html'), fillLanding(readFileSync(join(SITE, 'index.html'), 'utf8'), 'en', 'docs/', 'index.html'))
writeFileSync(join(OUT, 'ko', 'index.html'), fillLanding(readFileSync(join(SITE, 'ko', 'index.html'), 'utf8'), 'ko', '../docs/', 'ko/index.html'))
cpSync(join(SITE, 'assets'), join(OUT, 'assets'), { recursive: true, filter: (p) => !/\.DS_Store$/.test(p) })
{
  // llms.txt: the version, and the Korean docs that exist in this build
  const koDocs = [['README', 'README (Korean)', `${GH}/blob/${BRANCH}/README.ko.md`]]
  for (const n of [...SOURCES.keys()].filter(isKo).sort()) {
    const info = DOC_INFO.get(baseOf(n))
    koDocs.push([n, `${info ? info[3] : baseOf(n)} (${info ? info[1] : baseOf(n)}, Korean)`, `docs/${n}.md`])
  }
  const llms = readFileSync(join(SITE, 'llms.txt'), 'utf8')
    .replace(/\{\{VERSION\}\}/g, `v${VERSION}`)
    .replace('{{KO_DOCS}}', koDocs.map(([, label, href]) => `- [${label}](${href})`).join('\n'))
  for (const m of llms.matchAll(/\{\{[^}]*\}\}/g)) warn(`llms.txt: unknown placeholder ${m[0]}`)
  writeFileSync(join(OUT, 'llms.txt'), llms)
}
writeFileSync(join(OUT, '.nojekyll'), '')

for (const name of SOURCES.keys()) {
  const { title, h1, html, toc } = renderDoc(name)
  const lang = isKo(name) ? 'ko' : 'en'
  const ko = lang === 'ko'
  const from = SOURCES.get(name)
  // The Markdown source next to the page: agents read it for far fewer tokens than the HTML.
  cpSync(join(REPO, from), join(OUT, 'docs', `${name}.md`))
  const info = DOC_INFO.get(baseOf(name))
  const description = info ? (ko ? info[4] : info[2]) || undefined : undefined
  const meta = `<p class="doc-meta"><a href="${name}.md" type="text/markdown">${ko ? 'Markdown 원문' : 'Markdown source'}</a><a href="${GH}/blob/${BRANCH}/${from}">${ko ? 'GitHub에서 보기' : 'View on GitHub'}</a><a href="${ko ? 'index.ko.html' : 'index.html'}">${ko ? '전체 문서' : 'All docs'}</a></p>`
  const group = GROUPS.find((g) => g.docs.some((d) => d[0] === baseOf(name)))
  // Page head: the group as a small label, the title, the one-line description, then where the text comes from.
  const top = `<header class="doc-head">${group ? `<p class="doc-kicker">${esc(ko ? group.ko : group.en)}</p>` : ''}${h1}${description ? `<p class="doc-desc">${esc(description)}</p>` : ''}<p class="doc-meta doc-meta-top">${ko ? '이 문서는 저장소의' : 'Rendered from'} <code>${esc(from)}</code>${ko ? '을 그대로 옮겼습니다.' : ' in the repository.'} <a href="${name}.md" type="text/markdown">${ko ? 'Markdown 원문' : 'Markdown source'}</a></p></header>`
  writeFileSync(join(OUT, 'docs', `${name}.html`), page({ lang, name, title, description, body: top + html + meta, toc, mdHref: `${name}.md` }))
}

// docs indexes, English and Korean
for (const lang of ['en', 'ko']) {
  const ko = lang === 'ko'
  let body = ko
    ? `<h1>문서</h1><p>저장소의 <code>docs/</code> 폴더와 <code>deploy/DEPLOY.md</code>를 Inkling ${esc(`v${VERSION}`)} 기준으로 옮겼습니다. 한국어판이 없는 문서는 영어로 열립니다. 문서마다 Markdown 원문 링크가 있습니다.</p>`
    : `<h1>Documentation</h1><p>Rendered from the repository's <code>docs/</code> folder and <code>deploy/DEPLOY.md</code> for Inkling ${esc(`v${VERSION}`)}. Every page links its Markdown source.</p>`
  for (const g of GROUPS) {
    body += `<h2>${esc(ko ? g.ko : g.en)}</h2><div class="grid two">`
    for (const [n, label, d, kl, kd] of g.docs) {
      const link = docLink(n, lang)
      const desc = ko ? kd : d
      body += `<a class="card" href="${link.href}"><h3>${esc(ko ? kl : label)}${link.en ? EN_MARK : ''}</h3>${desc ? `<p>${esc(desc)}</p>` : ''}</a>`
    }
    body += '</div>'
  }
  body += `<h2>${ko ? 'GitHub에서' : 'On GitHub'}</h2><div class="grid two">`
  for (const [label, kl, url, koUrl] of EXTERNAL) {
    const en = ko && !koUrl
    body += `<a class="card" href="${ko && koUrl ? koUrl : url}"><h3>${esc(ko ? kl : label)}${en ? EN_MARK : ''}</h3></a>`
  }
  body += '</div>'
  const name = ko ? 'index.ko' : 'index'
  writeFileSync(
    join(OUT, 'docs', `${name}.html`),
    page({ lang, name, title: ko ? '문서' : 'Documentation', description: ko ? 'Inkling 문서 목록' : 'Inkling documentation', body, toc: null }),
  )
}

// ---------------------------------------------------------------------------
// tour: tour/index.html and ko/tour/index.html, with index.md next to each
// The words, the made-up note and the scenes live in assets/tour.js, which also runs the page. Here the
// same code prints every scene as text, so the page says everything without scripts and the scripts put
// the stage on top of it.
// ---------------------------------------------------------------------------
const tour = (() => {
  const scope = {}
  new Function('globalThis', readFileSync(join(SITE, 'assets', 'tour.js'), 'utf8'))(scope)
  return scope.InklingTour
})()

function tourPage(lang) {
  const ko = lang === 'ko'
  const t = tour.T[lang]
  const up = ko ? '../../' : '../'
  const home = ko ? '../index.html' : '../index.html'
  const inl = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
  const link = ([label, doc, enHash, koHash]) => {
    const d = docLink(doc, lang, `${up}docs/`)
    // the Korean docs keep English ids where the source has them, and Korean slugs elsewhere
    return { label, href: `${d.href}#${ko && !d.en ? koHash : enHash}`, en: d.en, md: `${d.href.replace(/\.html$/, '.md')}` }
  }
  const state = tour.create(lang)
  const scenes = tour.ORDER.map((id, i) => ({ id, n: i + 1, title: t.sc[id][0], does: t.sc[id][1], real: t.sc[id][2], links: (t.links[id] || []).map(link), text: tour.transcript(lang, id) }))
  const next = t.next.map(([title, text, doc]) => ({ title, text, ...docLink(doc, lang, `${up}docs/`) }))
  const canonical = `${BASE_URL}${ko ? 'ko/' : ''}tour/index.html`

  const html = `<!doctype html>
<html lang="${lang}" class="no-js tour-page">
<head>
  ${head({
    lang,
    title: `${t.title} · Inkling`,
    description: t.lede,
    canonical,
    alternates: { ko: `${BASE_URL}ko/tour/index.html`, en: `${BASE_URL}tour/index.html` },
    ogImage: `${BASE_URL}assets/${ko ? 'ko' : 'en'}/review-light.png`,
    ogType: 'website',
    extra: `<link rel="alternate" type="text/markdown" href="index.md" title="${ko ? '이 쪽의 Markdown 원문' : 'This page as Markdown'}">`,
  })}
  <link rel="icon" href="${up}assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${up}assets/site.css">
  <script src="${up}assets/site.js" defer></script>
  <script src="${up}assets/tour.js" defer></script>
</head>
<body>
<a class="skip" href="#main">${ko ? '본문으로 건너뛰기' : 'Skip to content'}</a>
<header class="top">
  <div class="wrap">
    <a class="brand" href="${home}"><img src="${up}assets/icon.svg" alt="" width="28" height="28"><span>Inkling</span></a>
    <nav class="nav" aria-label="${ko ? '주 메뉴' : 'Main'}">
      <a class="hide-sm" href="index.html" aria-current="page">${esc(t.title)}</a>
      <a href="${up}docs/${ko ? 'index.ko.html' : 'index.html'}">${ko ? '문서' : 'Docs'}</a>
      <a class="hide-sm" href="${GH}">GitHub</a>
      ${langSwitch(lang, ko ? 'index.html' : '../ko/tour/index.html', ko ? '../../tour/index.html' : 'index.html')}
    </nav>
  </div>
</header>
<main id="main" class="tour">
  <div class="wrap">
    <p class="tour-notice" role="note">${esc(t.notice)}</p>
    <header class="tour-head">
      <p class="doc-kicker">${esc(t.title)}</p>
      <h1>${esc(t.h1)}</h1>
      <p class="lede">${esc(t.lede)}</p>
      <p class="tour-made">${esc(t.made)} <a href="index.md" type="text/markdown">${esc(t.mdNote)}</a></p>
    </header>
    <div data-tour>
      <section class="tour-start">
        <h2>${esc(t.startTitle)}</h2>
        <p>${esc(t.startText)}</p>
        <pre><code>${esc(tour.pageMd(state))}</code></pre>
      </section>
${scenes
  .map(
    (s) => `      <section class="tour-sc" id="scene-${s.id}" data-sc="${s.id}">
        <h2><span class="tour-n">${s.n}</span>${esc(s.title)}</h2>
        <p class="tour-does">${inl(s.does)}</p>
        <p class="tour-label">${esc(t.scriptLabel)}</p>
        <pre class="tour-script"><code>${esc(s.text)}</code></pre>
        <p class="tour-real">${inl(s.real)} ${s.links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>${l.en ? EN_MARK : ''}`).join(' · ')}</p>
      </section>`,
  )
  .join('\n')}
    </div>
    <section class="tour-next" aria-labelledby="tour-next">
      <h2 id="tour-next">${esc(t.nextTitle)}</h2>
      <div class="grid two">${next.map((n) => `<a class="card" href="${n.href}"><h3>${esc(n.title)}${n.en ? EN_MARK : ''}</h3><p>${esc(n.text)}</p></a>`).join('')}</div>
    </section>
  </div>
</main>
<footer class="foot">
  <div class="wrap">
    <span>Inkling ${esc(`v${VERSION}`)}</span>
    <nav aria-label="${ko ? '바닥글' : 'Footer'}">
      <a href="${GH}">GitHub</a>
      <a href="${up}docs/${ko ? 'index.ko.html' : 'index.html'}">${ko ? '문서' : 'Docs'}</a>
      <a href="${up}llms.txt">llms.txt</a>
    </nav>
  </div>
</footer>
</body>
</html>
`
  const md = [
    `# ${t.h1}`,
    `> ${t.notice}`,
    t.lede,
    t.made,
    `## ${t.startTitle}`,
    t.startText,
    '```markdown\n' + tour.pageMd(state) + '\n```',
    ...scenes.flatMap((s) => [`## ${s.n}. ${s.title}`, s.does, '```text\n' + s.text + '\n```', s.real, s.links.map((l) => `- [${l.label}](${l.md})`).join('\n')]),
    `## ${t.nextTitle}`,
    next.map((n) => `- [${n.title}](${n.href.replace(/\.html$/, '.md')}): ${n.text}`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
  return { html, md: md + '\n' }
}
for (const lang of ['en', 'ko']) {
  const dir = join(OUT, lang === 'ko' ? 'ko' : '', 'tour')
  mkdirSync(dir, { recursive: true })
  const { html, md } = tourPage(lang)
  writeFileSync(join(dir, 'index.html'), html)
  writeFileSync(join(dir, 'index.md'), md)
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
  // Comments are not live references.
  const s = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const where = relative(OUT, file)
  for (const m of s.matchAll(/\s(href|src|srcset|poster)="([^"]*)"/g)) {
    const raw = decode(m[2])
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue
    const [path, hash] = raw.split('#')
    if (path.startsWith('/')) {
      warn(`${where}: root-relative link ${raw} (breaks under /inkling/ and file://)`)
      continue
    }
    const target = path ? resolve(dirname(file), path) : file
    if (!existsSync(target)) {
      warn(`${where}: missing ${raw}`)
      continue
    }
    if (statSync(target).isDirectory()) {
      warn(`${where}: link to a folder ${raw} (name the file, e.g. index.html)`)
      continue
    }
    if (hash && target.endsWith('.html') && !idsFor(target).has(decodeURIComponent(hash))) warn(`${where}: missing anchor ${raw}`)
  }
}
// Links in llms.txt are relative to the site root.
for (const m of readFileSync(join(OUT, 'llms.txt'), 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
  const raw = m[1]
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
  const target = join(OUT, raw.split('#')[0])
  if (!existsSync(target) || statSync(target).isDirectory()) warn(`llms.txt: missing ${raw}`)
}

const pngs = files.filter((f) => f.endsWith('.png'))
const big = pngs.filter((f) => statSync(f).size > 500 * 1024)
for (const f of big) warn(`large image ${relative(OUT, f)} (${Math.round(statSync(f).size / 1024)} KB)`)

console.log(`built ${relative(REPO, OUT)} for v${VERSION}: ${htmlFiles.length} pages, ${pngs.length} images`)
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  - ${w}`)
  if (process.argv.includes('--strict')) process.exit(1)
}
