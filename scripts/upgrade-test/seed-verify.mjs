#!/usr/bin/env node
// Upgrade-path test client (docs/adr/1052-*). Talks to a running Inkling server over HTTP only, so
// the same file works against every release since v0.1.0 without importing app code.
//
//   node seed-verify.mjs seed   --base http://127.0.0.1:3000 --out fingerprint.json
//   node seed-verify.mjs verify --base http://127.0.0.1:3000 --in  fingerprint.json
//
// `seed` runs against the OLD release: it creates an account (the first one, so it becomes admin),
// a second workspace, a document with Markdown content, a nested page, a comment thread with a
// reply, and a collection with an extra field and rows with property values. It then reads all of
// that back through the old server's API and writes the result (plus the credentials and the
// session cookie) to the fingerprint file.
//
// `verify` runs against the NEW release after it has migrated the same database on boot: it checks
// the old session cookie still works, logs in again with the password, and compares what the new
// server returns with the fingerprint. Any difference in data is a failure. A difference in the
// exported Markdown text is only a warning when every line the seed wrote is still there (the
// Markdown serializer may legitimately change between releases); a missing line is a failure.
//
// No dependencies: Node 18+ (global fetch). Exit code 0 = ok, 1 = check failed, 2 = usage/HTTP error.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const base = (opt('base') || '').replace(/\/+$/, '')
if (!['seed', 'verify'].includes(cmd) || !base) {
  console.error('usage: seed-verify.mjs seed --base URL --out FILE | verify --base URL --in FILE')
  process.exit(2)
}

// Seed content. Plain text on purpose: no `$` (math since 0.3.0), no HTML, nothing a serializer
// would be allowed to rewrite.
const EMAIL = 'upgrade-test@example.com'
const PASSWORD = 'upgrade-test-password-1'
const NAME = 'Upgrade Tester'
const DOC_LINES = [
  '# Upgrade heading',
  'First paragraph written by the old release.',
  '- bullet one',
  '- bullet two',
  '## Second section',
  'Text under the second section with a tag #upgradetag and a link to [[Nested child]].',
]
const DOC_MARKDOWN = DOC_LINES.join('\n\n') + '\n'

let cookie = ''

async function api(method, path, body, { expect = [200], raw = false, useCookie = true } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (useCookie && cookie) headers.cookie = cookie
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const c of setCookie) {
    const pair = c.split(';')[0]
    if (pair && !/=\s*$/.test(pair)) cookie = pair
  }
  const text = await res.text()
  if (!expect.includes(res.status)) {
    console.error(`[upgrade-test] ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`)
    process.exit(2)
  }
  if (raw) return text
  return text ? JSON.parse(text) : undefined
}

/** Everything the test compares, read through the API in a stable order. */
async function snapshot(ids) {
  const me = await api('GET', '/auth/me')
  const wsList = (await api('GET', '/workspaces')).workspaces
  const workspaces = wsList
    .map((w) => ({ id: w.id, name: w.name, role: w.role }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const pagesByWs = {}
  for (const w of workspaces) {
    const { pages } = await api('GET', `/workspaces/${w.id}/pages`)
    pagesByWs[w.name] = pages
      .map((p) => ({ id: p.id, title: p.title, kind: p.kind, parentId: p.parentId ?? null, scope: p.scope }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  const comments = (await api('GET', `/pages/${ids.docId}/comments`)).comments
    .map((c) => ({
      id: c.id,
      blockId: c.blockId,
      threadId: c.threadId,
      body: c.body,
      resolved: c.resolved,
      authorId: c.author?.id ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const coll = await api('GET', `/pages/${ids.collectionId}/collection`)
  const collection = {
    fields: coll.collection.fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      options: (f.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })),
    })),
    views: (coll.collection.views ?? []).map((v) => ({ id: v.id, name: v.name, type: v.type })),
    rows: coll.rows
      .map((r) => ({ id: r.id, title: r.title, props: sortKeys(r.props ?? {}) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
  const markdown = await api('GET', `/pages/${ids.docId}/export?format=md`, undefined, { raw: true })
  return {
    me: { id: me.user?.id ?? me.id, email: me.user?.email ?? me.email, isAdmin: me.user?.isAdmin ?? me.isAdmin },
    workspaces,
    pages: pagesByWs,
    comments,
    collection,
    markdown,
  }
}

/** Seed lines whose text (heading/list marker stripped) is not in the exported Markdown. */
function missingLines(markdown) {
  return DOC_LINES.filter((line) => !markdown.includes(line.replace(/^(#+|[-*+])\s+/, '')))
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
}

async function seed() {
  const mode = await api('GET', '/auth/mode', undefined, { useCookie: false })
  if (mode.signupKeyRequired) {
    console.error('[upgrade-test] the server requires a signup key; start it with SIGNUP_REQUIRE_KEY=0')
    process.exit(2)
  }
  const reg = await api('POST', '/auth/register', { email: EMAIL, name: NAME, password: PASSWORD })
  const userId = reg.user.id
  if (!cookie) {
    console.error('[upgrade-test] register did not set a session cookie')
    process.exit(2)
  }

  const personal = (await api('GET', '/workspaces')).workspaces[0]
  const second = (await api('POST', '/workspaces', { name: 'Upgrade second workspace' })).workspace

  const doc = (await api('POST', '/pages', { workspaceId: personal.id, kind: 'doc', title: 'Upgrade doc' })).page
  await api('POST', `/pages/${doc.id}/content`, { markdown: DOC_MARKDOWN, mode: 'replace' })
  const child = (
    await api('POST', '/pages', { workspaceId: personal.id, parentId: doc.id, kind: 'doc', title: 'Nested child' })
  ).page
  await api('POST', `/pages/${child.id}/content`, { markdown: 'Child page body.\n', mode: 'replace' })
  await api('POST', '/pages', { workspaceId: personal.id, kind: 'doc', title: 'Private note', scope: 'private' })
  await api('POST', '/pages', { workspaceId: second.id, kind: 'folder', title: 'Folder in second workspace' })

  const thread = (await api('POST', `/pages/${doc.id}/comments`, { blockId: 'upgrade-block-1', body: 'Thread root comment' }))
    .comment
  await api('POST', `/pages/${doc.id}/comments`, {
    blockId: thread.blockId,
    threadId: thread.threadId,
    body: 'Reply in the thread',
  })

  const collPage = (await api('POST', '/pages', { workspaceId: personal.id, kind: 'collection', title: 'Upgrade tasks' })).page
  const coll = (await api('GET', `/pages/${collPage.id}/collection`)).collection
  const fields = [...coll.fields, { id: 'estimate', name: 'Estimate', type: 'number' }, { id: 'note', name: 'Note', type: 'text' }]
  await api('PUT', `/pages/${collPage.id}/collection/fields`, { fields })
  const status = coll.fields.find((f) => f.type === 'select')
  const due = coll.fields.find((f) => f.type === 'date')
  const rowSpecs = [
    { title: 'Row A', est: 3, note: 'alpha', opt: 0, due: '2026-12-01' },
    { title: 'Row B', est: 5, note: 'beta', opt: 1, due: '2026-12-15' },
    { title: 'Row C', est: 8, note: 'gamma', opt: 2, due: null },
  ]
  for (const r of rowSpecs) {
    const row = (await api('POST', '/pages', { workspaceId: personal.id, parentId: collPage.id, title: r.title })).page
    const props = { estimate: r.est, note: r.note }
    if (status?.options?.[r.opt]) props[status.id] = status.options[r.opt].id
    if (due && r.due) props[due.id] = r.due
    await api('PATCH', `/pages/${row.id}/props`, { props })
  }

  const ids = { userId, docId: doc.id, childId: child.id, collectionId: collPage.id }
  const snap = await snapshot(ids)
  const lost = missingLines(snap.markdown)
  if (lost.length) {
    console.error(`[upgrade-test] the old release did not store the seed lines: ${lost.join(' | ')}`)
    console.error('--- exported Markdown\n' + snap.markdown)
    process.exit(1)
  }
  writeFileSync(opt('out'), JSON.stringify({ email: EMAIL, password: PASSWORD, cookie, ids, snapshot: snap }, null, 2))
  console.log(
    `[upgrade-test] seeded: 2 workspaces, ${Object.values(snap.pages).flat().length} pages, ` +
      `${snap.comments.length} comments, ${snap.collection.rows.length} collection rows`,
  )
}

function diff(path, a, b, out) {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
    return
  }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) diff(`${path}.${k}`, a[k], b[k], out)
    return
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
}

async function verify() {
  const fp = JSON.parse(readFileSync(opt('in'), 'utf8'))
  const failures = []

  // 1) The session issued by the old release is still valid (sessions table carried over).
  cookie = fp.cookie
  const meOld = await api('GET', '/auth/me', undefined, { expect: [200, 401] })
  if (meOld?.user?.id !== fp.ids.userId) failures.push('old session cookie no longer accepted')

  // 2) Password login works (users.password_hash carried over, argon2 verifies on this build).
  cookie = ''
  await api('POST', '/auth/login', { email: fp.email, password: fp.password })

  // 3) Same data through the new API.
  const now = await snapshot(fp.ids)
  const before = { ...fp.snapshot, markdown: undefined }
  const after = { ...now, markdown: undefined }
  const out = []
  diff('snapshot', before, after, out)
  failures.push(...out)

  for (const line of missingLines(now.markdown)) failures.push(`markdown export lost: ${line}`)
  if (now.markdown !== fp.snapshot.markdown) {
    console.warn('[upgrade-test] warning: exported Markdown text differs (every seeded line is present):')
    console.warn('--- old\n' + fp.snapshot.markdown + '\n--- new\n' + now.markdown)
  }

  if (failures.length) {
    console.error(`[upgrade-test] FAILED: ${failures.length} difference(s)`)
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }
  console.log(
    `[upgrade-test] verified: session, login, ${now.workspaces.length} workspaces, ` +
      `${Object.values(now.pages).flat().length} pages, ${now.comments.length} comments, ` +
      `${now.collection.rows.length} rows, markdown export`,
  )
}

await (cmd === 'seed' ? seed() : verify())
