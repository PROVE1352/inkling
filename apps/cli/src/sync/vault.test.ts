// Vault-side helpers of `inklingctl sync` that decide what stays in a note and which id a retried
// create gets (docs/adr/2166-*, 2168-*). Run: cd apps/cli && node ../../scripts/run-tests.mjs
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { frontmatterEntries, keepFrontmatterKeys, syncCreateId } from './vault'

describe('keepFrontmatterKeys', () => {
  const local = '---\ninkling-id: x\ntags: [a]\nnested:\n  a: 1\n  b: 2\nsummary: |\n  line one\n  line two\nupdated: 2026-01-01\n---\nlocal body\n'
  const server = '---\ninkling-id: x\ntags:\n  - a\n---\n\nserver body\n'

  it('splits entries with their indented lines', () => {
    const e = frontmatterEntries(local)!
    assert.deepEqual(e.entries.map((x) => x.key), ['inkling-id', 'tags', 'nested', 'summary', 'updated'])
    assert.deepEqual(e.entries.find((x) => x.key === 'nested')!.lines, ['nested:', '  a: 1', '  b: 2'])
  })

  it('adds back only the named keys, before the closing line, body from the server', () => {
    const out = keepFrontmatterKeys(server, local, ['nested', 'Summary', 'updated'])
    assert.equal(out, '---\ninkling-id: x\ntags:\n  - a\nnested:\n  a: 1\n  b: 2\nsummary: |\n  line one\n  line two\nupdated: 2026-01-01\n---\n\nserver body\n')
  })

  it('leaves the server text alone without keys, without local frontmatter, or when the server has the key', () => {
    assert.equal(keepFrontmatterKeys(server, local, undefined), server)
    assert.equal(keepFrontmatterKeys(server, 'no frontmatter\n', ['nested']), server)
    assert.equal(keepFrontmatterKeys(server, local, ['tags']), server)
  })

  it('quoted keys and CRLF notes', () => {
    const crlf = '---\r\n"my key":\r\n  x: 1\r\n---\r\nbody\r\n'
    assert.equal(keepFrontmatterKeys(server, crlf, ['my key']), '---\ninkling-id: x\ntags:\n  - a\n"my key":\n  x: 1\n---\n\nserver body\n')
  })
})

describe('syncCreateId', () => {
  it('is a stable UUID per workspace and key', () => {
    const ws = '0b7d6f7e-3c55-4a8e-9a43-0c9a8b3f1e11'
    const key = '5f1e2d3c-4b5a-4968-8776-655443322110'
    const a = syncCreateId(ws, key)
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(syncCreateId(ws.toUpperCase(), key.toUpperCase()), a)
    assert.notEqual(syncCreateId(ws, '5f1e2d3c-4b5a-4968-8776-655443322111'), a)
    assert.notEqual(syncCreateId('1b7d6f7e-3c55-4a8e-9a43-0c9a8b3f1e11', key), a)
  })
})
