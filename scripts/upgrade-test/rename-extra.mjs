#!/usr/bin/env node
// Data the rename test (scripts/upgrade-test/rename.sh, docs/adr/2342-*) adds on top of seed-verify.mjs:
// an attachment on the seeded document and a public share link of it. Kept apart from seed-verify.mjs,
// which every upgrade leg since v0.1.0 runs against old APIs.
//
//   node rename-extra.mjs seed   --base URL --fp fingerprint.json --out extra.json
//   node rename-extra.mjs verify --base URL --fp fingerprint.json --in  extra.json
//
// verify: password login works, the attachment downloads with the same bytes (sha256), and the share
// link answers 200 on /api/public/<token> (the /s/<token> page would answer 200 even for a dead link).
// No dependencies: Node 18+. Exit code 0 = ok, 1 = check failed, 2 = usage/HTTP error.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const base = (opt('base') || '').replace(/\/+$/, '')
if (!['seed', 'verify'].includes(cmd) || !base || !opt('fp')) {
  console.error('usage: rename-extra.mjs seed --base URL --fp FILE --out FILE | verify --base URL --fp FILE --in FILE')
  process.exit(2)
}
const fp = JSON.parse(readFileSync(opt('fp'), 'utf8'))
let cookie = ''

async function req(method, path, { body, form, expect = [200], raw = false } = {}) {
  const headers = { accept: 'application/json' }
  if (cookie) headers.cookie = cookie
  let payload
  if (form) payload = form
  else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload, redirect: 'manual' })
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0]
    if (pair.startsWith('inkling_sid=') && !/=\s*$/.test(pair)) cookie = pair
  }
  if (!expect.includes(res.status)) {
    console.error(`[rename-test] ${method} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    process.exit(2)
  }
  if (raw) return Buffer.from(await res.arrayBuffer())
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function login() {
  cookie = ''
  await req('POST', '/api/auth/login', { body: { email: fp.email, password: fp.password } })
  if (!cookie) {
    console.error('[rename-test] login set no session cookie')
    process.exit(1)
  }
}

async function seed() {
  await login()
  const docId = fp.ids.docId
  const ws = fp.snapshot.workspaces.find((w) => (fp.snapshot.pages[w.name] ?? []).some((p) => p.id === docId))
  const workspaceId = ws.id
  // text/plain is on the upload allow-list of every release in the matrix
  const bytes = Buffer.from(randomBytes(110_000).toString('base64'))
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'text/plain' }), 'rename-test.txt')
  const { file } = await req('POST', `/api/files?workspaceId=${workspaceId}&pageId=${docId}`, { form })
  const share = await req('POST', `/api/pages/${docId}/share`, { body: {} })
  if (!share.token) {
    console.error('[rename-test] the share call returned no token')
    process.exit(2)
  }
  const out = { fileId: file.id, size: bytes.length, sha256: sha(bytes), shareToken: share.token }
  writeFileSync(opt('out'), JSON.stringify(out, null, 2))
  console.log(`[rename-test] seeded: attachment ${file.id} (${bytes.length} bytes), share link`)
}

async function verify() {
  const ex = JSON.parse(readFileSync(opt('in'), 'utf8'))
  const failures = []
  await login()
  const me = await req('GET', '/api/auth/me')
  if ((me.user?.id ?? me.id) !== fp.ids.userId) failures.push('login gave another account')
  const got = await req('GET', `/files/${ex.fileId}`, { raw: true })
  if (got.length !== ex.size || sha(got) !== ex.sha256) failures.push(`attachment differs: ${got.length} bytes, sha256 ${sha(got)}`)
  cookie = ''
  const pub = await req('GET', `/api/public/${ex.shareToken}`, { expect: [200, 404, 410] })
  if (!pub || pub.title !== 'Upgrade doc') failures.push(`share link: ${JSON.stringify(pub)?.slice(0, 120)}`)
  if (failures.length) {
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }
  console.log(`[rename-test] verified: login, attachment ${got.length} bytes (sha256 equal), share link 200`)
}

await (cmd === 'seed' ? seed() : verify())
