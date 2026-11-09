#!/usr/bin/env node
// Typing regression check for the editor (docs/adr/0850-*, 1270-*, 1271-*): types with no delay between
// keys right after inserting a block from the "/" menu, and right after folding a heading, in headless
// Chromium and WebKit, and requires the exact block texts afterwards. It drives a running Inkling over
// HTTP and the browser only, so it imports no app code.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   node scripts/editor-typing/run.mjs --base http://127.0.0.1:3001 --email a@example.com --password … [--runs 30]
//
// Playwright is not a dependency of this repository (docs/adr/0882-*): point PLAYWRIGHT_CORE at any
// install of playwright-core whose browsers are downloaded (`npx playwright install chromium webkit`).
// The account needs a workspace; the script creates one page per browser ("editor-typing check") and
// rewrites its content between runs in the browser, so it stays far below the API rate limit. Use a
// throwaway server: the pages are not deleted.
//
// Scenarios (each --runs times per browser; a run fails on any difference from the expected blocks):
//   callout-text    "X" + /callout + Enter + "hello"          → callout "hello" after "X"
//   callout-empty   empty line + /callout + Enter + "hello"    → the empty line becomes callout "hello"
//   callout-click   like callout-text, item chosen with the mouse
//   callout-enter   /callout + Enter + "abcdef" Enter "ghijkl" → callout "abcdef", paragraph "ghijkl"
//   query, divider, toggle   other items: the text lands in the new block (divider: the line below it)
//   math, inline-math, embed blocks with a field of their own: the text lands in that field
//   fold-enter      ⌘./Ctrl+. folds a section, Enter at the heading end, "abcdef" Enter "ghijkl" (0850)
//   fold-type       ⌘./Ctrl+. from the section body, then "XYZ" → appended to the heading
//   block-move      ⌘⇧↑ / ⌘⇧↓ move the caret's block, typing lands in it (docs/adr/1401-*)
//   heading-level   ⌘⌥1 / ⌘⌥3 / ⌘⌥0 turn the block into heading 1, heading 3, text
//   check-toggle    ⌘L makes a to-do, ⌘Enter checks and unchecks it, ⌘Enter on text does nothing
//   duplicate       ⌘⇧D copies the block below with a new id, the caret goes into the copy
//   delete-block    ⌘D deletes the block, the caret goes to the next one
// At the end the page is reloaded once and the stored document must equal the live one.
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const BASE = args.base ?? 'http://127.0.0.1:3001'
const RUNS = Number(args.runs ?? 30)
const ENGINES = (args.engines ?? 'chromium,webkit').split(',')
const ONLY = args.only ? new Set(args.only.split(',')) : null
if (!args.email || !args.password) {
  console.error('usage: run.mjs --base URL --email E --password P [--runs 30] [--engines chromium,webkit] [--only a,b]')
  process.exit(2)
}
const pwDir = process.env.PLAYWRIGHT_CORE
const pw = await import(pwDir ? pathToFileURL(path.join(pwDir, 'index.mjs')).href : 'playwright-core').catch(() => {
  console.error('playwright-core not found: set PLAYWRIGHT_CORE to its directory')
  process.exit(2)
})

let cookie = ''
async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
  })
  const sc = r.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${t}`)
  return t ? JSON.parse(t) : null
}
await api('POST', '/api/auth/login', { email: args.email, password: args.password })
const ws = (await api('GET', '/api/workspaces')).workspaces[0].id

// --- in-page helpers --------------------------------------------------------------------------------
const P = (t) => ['paragraph', t]
const H = (level, t) => ['heading', t, level]
async function setDoc(page, blocks) {
  await page.evaluate((blocks) => {
    const ed = document.querySelector('.ProseMirror').editor
    const content = blocks.map(([type, text, level]) => ({
      type: 'blockContainer',
      content: [{ type, ...(level ? { attrs: { level } } : {}), content: text ? [{ type: 'text', text }] : [] }],
    }))
    ed.commands.setContent({ type: 'doc', content: [{ type: 'blockGroup', content }] })
  }, blocks)
  await page.evaluate(() => localStorage.removeItem('inkling:folds'))
  await page.waitForTimeout(120)
}
// caret at the start/end of the first text block whose text is `text` ('' = the first empty one)
const caretAt = (page, text, where = 'end') =>
  page.evaluate(
    ([text, where]) => {
      const ed = document.querySelector('.ProseMirror').editor
      let target = -1
      ed.state.doc.descendants((n, pos) => {
        if (target < 0 && n.isTextblock && n.textContent === text) target = where === 'end' ? pos + 1 + n.content.size : pos + 1
      })
      ed.view.focus()
      ed.commands.setTextSelection(target)
    },
    [text, where],
  )
const docBlocks = (page) =>
  page.evaluate(() => {
    const out = []
    document.querySelector('.ProseMirror').editor.state.doc.descendants((n) => {
      if (n.type.name === 'blockContainer') out.push(`${n.firstChild.type.name}:${n.firstChild.textContent}`)
    })
    return out
  })
// type:text plus the attributes the shortcut scenarios change (heading level, to-do state), and the block ids
const docDetail = (page) =>
  page.evaluate(() => {
    const out = []
    const ids = []
    document.querySelector('.ProseMirror').editor.state.doc.descendants((n) => {
      if (n.type.name !== 'blockContainer') return
      ids.push(n.attrs.id)
      const c = n.firstChild
      const extra = c.type.name === 'heading' ? `#${c.attrs.level}` : c.type.name === 'checkListItem' ? (c.attrs.checked ? '[x]' : '[ ]') : ''
      out.push(`${c.type.name}${extra}:${c.textContent}`)
    })
    return { blocks: out, uniqueIds: new Set(ids).size === ids.length }
  })
const fieldValue = (page) => page.evaluate(() => (document.activeElement && 'value' in document.activeElement ? document.activeElement.value : null))
async function slash(page, query, title, { click = false } = {}) {
  await page.keyboard.type('/' + query, { delay: 15 })
  await page.waitForSelector('.bn-suggestion-menu-item')
  await page.waitForTimeout(150)
  const titles = await page.$$eval('.bn-suggestion-menu-item', (els) => els.map((e) => e.innerText))
  const idx = titles.findIndex((t) => t.split('\n').some((l) => l.trim() === title))
  if (idx < 0) throw new Error(`"${title}" not in the menu for /${query}`)
  if (click) return page.locator('.bn-suggestion-menu-item').nth(idx).click()
  for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Each scenario: set up, act (keys with no delay), return null when right or a description when wrong.
const BASEDOC = [P('Alpha'), P('X'), P('Bravo')]
const WITH_EMPTY = [P('Alpha'), P('X'), P(''), P('Bravo')]
const FOLDDOC = [H(1, 'Alpha'), P('alpha one'), P('alpha two'), H(2, 'Alpha sub'), P('sub body'), H(1, 'Bravo'), P('bravo body')]
const textCase = (doc, at, query, title, want, opts) => async (page) => {
  await setDoc(page, doc)
  await caretAt(page, at)
  await slash(page, query, title, opts)
  await page.keyboard.type('hello', { delay: 0 })
  await page.waitForTimeout(200)
  const got = await docBlocks(page)
  return eq(got, want) ? null : got.join(' | ')
}
const fieldCase = (query, title, wantDoc) => async (page) => {
  await setDoc(page, BASEDOC)
  await caretAt(page, 'X')
  await slash(page, query, title)
  await page.keyboard.type('hello', { delay: 0 })
  await page.waitForTimeout(200)
  const v = await fieldValue(page)
  const got = await docBlocks(page)
  await page.keyboard.press('Escape')
  return v === 'hello' && eq(got, wantDoc) ? null : `field=${JSON.stringify(v)} ${got.join(' | ')}`
}
const SCENARIOS = {
  'callout-text': textCase(BASEDOC, 'X', 'callout', 'Callout', ['paragraph:Alpha', 'paragraph:X', 'callout:hello', 'paragraph:Bravo']),
  'callout-empty': textCase(WITH_EMPTY, '', 'callout', 'Callout', ['paragraph:Alpha', 'paragraph:X', 'callout:hello', 'paragraph:Bravo']),
  'callout-click': textCase(BASEDOC, 'X', 'callout', 'Callout', ['paragraph:Alpha', 'paragraph:X', 'callout:hello', 'paragraph:Bravo'], { click: true }),
  'callout-enter': async (page) => {
    await setDoc(page, BASEDOC)
    await caretAt(page, 'X')
    await slash(page, 'callout', 'Callout')
    await page.keyboard.type('abcdef', { delay: 0 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('ghijkl', { delay: 0 })
    await page.waitForTimeout(200)
    const got = await docBlocks(page)
    return eq(got, ['paragraph:Alpha', 'paragraph:X', 'callout:abcdef', 'paragraph:ghijkl', 'paragraph:Bravo']) ? null : got.join(' | ')
  },
  query: async (page) => {
    await setDoc(page, BASEDOC)
    await caretAt(page, 'X')
    await slash(page, 'query', 'Query')
    await page.keyboard.type('hello', { delay: 0 })
    await page.waitForTimeout(200)
    const got = await docBlocks(page)
    return got[2]?.startsWith('codeBlock:') && got[2].endsWith('hello') && got[1] === 'paragraph:X' && got[3] === 'paragraph:Bravo' ? null : got.join(' | ')
  },
  divider: textCase(BASEDOC, 'X', 'divider', 'Divider', ['paragraph:Alpha', 'paragraph:X', 'divider:', 'paragraph:hello', 'paragraph:Bravo']),
  toggle: textCase(BASEDOC, 'X', 'toggle', 'Toggle List', ['paragraph:Alpha', 'paragraph:X', 'toggleListItem:hello', 'paragraph:Bravo']),
  math: fieldCase('math', 'Math block', ['paragraph:Alpha', 'paragraph:X', 'math:', 'paragraph:Bravo']),
  'inline-math': fieldCase('inline', 'Inline math', ['paragraph:Alpha', 'paragraph:X', 'paragraph:Bravo']),
  embed: fieldCase('embed', 'Embed / link card', ['paragraph:Alpha', 'paragraph:X', 'linkEmbed:', 'paragraph:Bravo']),
  'fold-enter': async (page, mod) => {
    await setDoc(page, FOLDDOC)
    await caretAt(page, 'alpha two')
    await page.keyboard.press(`${mod}+Period`)
    await page.keyboard.press('Enter')
    await page.keyboard.type('abcdef', { delay: 0 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('ghijkl', { delay: 0 })
    await page.waitForTimeout(200)
    const got = await docBlocks(page)
    return eq(got.slice(0, 4), ['heading:Alpha', 'paragraph:abcdef', 'paragraph:ghijkl', 'paragraph:alpha one']) ? null : got.join(' | ')
  },
  'fold-type': async (page, mod) => {
    await setDoc(page, FOLDDOC)
    await caretAt(page, 'sub body')
    await page.keyboard.press(`${mod}+Period`)
    await page.keyboard.type('XYZ', { delay: 0 })
    await page.waitForTimeout(150)
    const hidden = await page.evaluate(
      () => [...document.querySelectorAll('.bn-editor > .bn-block-group > .bn-block-outer')].filter((e) => !e.getBoundingClientRect().height).length,
    )
    const got = await docBlocks(page)
    return got[3] === 'heading:Alpha subXYZ' && got[4] === 'paragraph:sub body' && hidden === 1 ? null : `hidden=${hidden} ${got.join(' | ')}`
  },
  'block-move': async (page, mod) => {
    await setDoc(page, BASEDOC)
    await caretAt(page, 'X')
    await page.keyboard.press(`${mod}+Shift+ArrowUp`)
    const up = await docBlocks(page)
    await page.keyboard.press(`${mod}+Shift+ArrowDown`)
    await page.keyboard.press(`${mod}+Shift+ArrowDown`)
    await page.keyboard.type('Z', { delay: 0 })
    await page.waitForTimeout(150)
    const got = await docBlocks(page)
    return eq(up, ['paragraph:X', 'paragraph:Alpha', 'paragraph:Bravo']) && eq(got, ['paragraph:Alpha', 'paragraph:Bravo', 'paragraph:XZ'])
      ? null
      : `${up.join(' | ')} → ${got.join(' | ')}`
  },
  'heading-level': async (page, mod) => {
    await setDoc(page, BASEDOC)
    await caretAt(page, 'X')
    const steps = []
    for (const digit of ['1', '3', '0']) {
      await page.keyboard.press(`${mod}+Alt+Digit${digit}`)
      await page.waitForTimeout(60)
      steps.push((await docDetail(page)).blocks[1])
    }
    await page.keyboard.type('Y', { delay: 0 })
    await page.waitForTimeout(150)
    const got = (await docDetail(page)).blocks
    return eq(steps, ['heading#1:X', 'heading#3:X', 'paragraph:X']) && got[1] === 'paragraph:XY' ? null : `${steps.join(' → ')} / ${got.join(' | ')}`
  },
  'check-toggle': async (page, mod) => {
    await setDoc(page, BASEDOC)
    await caretAt(page, 'X')
    const steps = []
    for (const key of ['KeyL', 'Enter', 'Enter', 'Enter']) {
      await page.keyboard.press(`${mod}+${key}`)
      await page.waitForTimeout(60)
      steps.push((await docDetail(page)).blocks[1])
    }
    await caretAt(page, 'Alpha')
    await page.keyboard.press(`${mod}+Enter`)
    await page.waitForTimeout(60)
    const got = (await docDetail(page)).blocks
    return eq(steps, ['checkListItem[ ]:X', 'checkListItem[x]:X', 'checkListItem[ ]:X', 'checkListItem[x]:X']) &&
      eq(got, ['paragraph:Alpha', 'checkListItem[x]:X', 'paragraph:Bravo'])
      ? null
      : `${steps.join(' → ')} / ${got.join(' | ')}`
  },
  duplicate: async (page, mod) => {
    await setDoc(page, BASEDOC)
    await caretAt(page, 'X')
    await page.keyboard.press(`${mod}+Shift+KeyD`)
    await page.keyboard.type('Q', { delay: 0 })
    await page.waitForTimeout(150)
    const d = await docDetail(page)
    return eq(d.blocks, ['paragraph:Alpha', 'paragraph:X', 'paragraph:XQ', 'paragraph:Bravo']) && d.uniqueIds
      ? null
      : `ids unique=${d.uniqueIds} ${d.blocks.join(' | ')}`
  },
  'delete-block': async (page, mod) => {
    await setDoc(page, BASEDOC)
    await caretAt(page, 'X')
    await page.keyboard.press(`${mod}+KeyD`)
    await page.keyboard.type('W', { delay: 0 })
    await page.waitForTimeout(150)
    const got = await docBlocks(page)
    return eq(got, ['paragraph:Alpha', 'paragraph:WBravo']) ? null : got.join(' | ')
  },
}

let failed = 0
for (const engine of ENGINES) {
  const browser = await pw[engine].launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', serviceWorkers: 'block' })
  const [name, value] = cookie.split('=')
  await ctx.addCookies([{ name, value, url: BASE }])
  const { page: created } = await api('POST', '/api/pages', { workspaceId: ws, title: `editor-typing check (${engine})` })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${BASE}/w/${ws}/p/${created.id}`)
  await page.waitForSelector('.bn-editor .bn-block-outer', { timeout: 30000 })
  await page.waitForTimeout(800)
  const mod = (await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))) ? 'Meta' : 'Control'
  for (const [key, run] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.has(key)) continue
    let bad = 0
    let example = ''
    for (let i = 0; i < RUNS; i++) {
      const wrong = await run(page, mod)
      if (wrong) {
        bad++
        example ||= wrong
      }
    }
    failed += bad
    console.log(`${engine.padEnd(8)} ${key.padEnd(14)} ${RUNS - bad}/${RUNS} exact${bad ? `  e.g. ${example}` : ''}`)
  }
  // persisted state equals the live document
  await page.waitForTimeout(1500)
  const live = await docBlocks(page)
  await page.reload()
  await page.waitForSelector('.bn-editor .bn-block-outer', { timeout: 30000 })
  await page.waitForTimeout(800)
  const stored = await docBlocks(page)
  const same = eq(live, stored)
  if (!same) failed++
  console.log(`${engine.padEnd(8)} reload         ${same ? 'stored = live' : `DIFFERS: ${stored.join(' | ')}`}`)
  if (errors.length) console.log(`${engine.padEnd(8)} page errors: ${errors.slice(0, 3).join(' / ')}`)
  await browser.close()
}
console.log(failed ? `FAILED (${failed})` : 'ok')
process.exit(failed ? 1 : 0)
