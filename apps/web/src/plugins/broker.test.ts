// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/plugins/broker.test.ts
// Malicious-plugin scenarios against the parent-side broker (the real enforcement point).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PluginBroker } from './broker'
import { LIMITS, parseIncoming, validateParams } from './protocol'

function setup(over = {}) {
  let t = 0
  const out = []
  const kills = []
  const calls = []
  const handlers = {
    'pages.get': async (p) => {
      calls.push(['pages.get', p])
      return { id: p.pageId, markdown: '# hi' }
    },
    'pages.update': async (p) => {
      calls.push(['pages.update', p])
      return { ok: true }
    },
    'ui.notice': (p) => {
      calls.push(['ui.notice', p])
      return { ok: true }
    },
    'block.setData': (p) => {
      calls.push(['block.setData', p])
      return { ok: true }
    },
  }
  const b = new PluginBroker({
    pluginId: 'evil',
    permissions: ['commands', 'read:pages'],
    mode: 'worker',
    declaredCommands: ['count'],
    declaredBlocks: [],
    handlers,
    post: (m) => out.push(JSON.parse(m)),
    kill: (r) => kills.push(r),
    now: () => t,
    ...over,
  })
  return {
    b,
    out,
    kills,
    calls,
    advance: (ms) => {
      t += ms
    },
    send: (obj) => b.receive(typeof obj === 'string' ? obj : JSON.stringify(obj)),
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const PAGE = '11111111-2222-3333-4444-555555555555'

describe('PluginBroker — malicious plugin scenarios', () => {
  it('allows an approved call and answers with the same request id', async () => {
    const s = setup()
    s.send({ id: 7, method: 'pages.get', params: { pageId: PAGE } })
    await tick()
    assert.deepEqual(s.out[0], { id: 7, ok: true, result: { id: PAGE, markdown: '# hi' } })
  })

  it('blocks pages.update without write:pages (handler never runs)', async () => {
    const s = setup()
    s.send({ id: 1, method: 'pages.update', params: { pageId: PAGE, markdown: 'pwned', mode: 'replace' } })
    await tick()
    assert.equal(s.out[0].ok, false)
    assert.equal(s.out[0].error.code, 'PERMISSION_DENIED')
    assert.equal(s.calls.length, 0)
  })

  it('permissions come from the approval, not from what the plugin claims', async () => {
    const s = setup()
    s.send({ id: 1, method: 'pages.update', params: { pageId: PAGE, markdown: 'x' }, permissions: ['write:pages'] })
    await tick()
    assert.equal(s.out[0].error.code, 'PERMISSION_DENIED')
  })

  it('rejects unknown methods, bad ids and non-string (structured clone) messages', async () => {
    const s = setup()
    s.send({ id: 2, method: 'app.eval', params: {} })
    s.send({ id: -1, method: 'pages.get', params: { pageId: PAGE } })
    s.b.receive({ id: 3, method: 'pages.get', params: { pageId: PAGE } }) // object, not string
    s.send('{not json')
    await tick()
    assert.equal(s.out.length, 1, 'only the request with a valid id gets an error reply')
    assert.equal(s.out[0].error.code, 'BAD_REQUEST')
    assert.equal(s.calls.length, 0)
  })

  it('validates params (pageId must be a UUID — no path injection into proxied URLs)', async () => {
    const s = setup()
    s.send({ id: 1, method: 'pages.get', params: { pageId: '../../admin/users' } })
    await tick()
    assert.equal(s.out[0].error.code, 'BAD_REQUEST')
    assert.equal(s.calls.length, 0)
  })

  it('only manifest-declared commands can be registered', async () => {
    const s = setup()
    s.send({ id: 1, method: 'commands.register', params: { id: 'count' } })
    s.send({ id: 2, method: 'commands.register', params: { id: 'sneaky' } })
    await tick()
    assert.equal(s.out.find((m) => m.id === 1).ok, true)
    assert.equal(s.out.find((m) => m.id === 2).error.code, 'NOT_DECLARED')
    assert.deepEqual([...s.b.registeredCommands], ['count'])
  })

  it('block-only methods are refused in a worker frame', async () => {
    const s = setup({ permissions: ['blocks'] })
    s.send({ id: 1, method: 'block.setData', params: { data: { a: 1 } } })
    await tick()
    assert.equal(s.out[0].ok, false)
    assert.equal(s.calls.length, 0)
  })

  it('caps block data size', () => {
    const big = { s: 'x'.repeat(LIMITS.blockDataMaxChars + 10) }
    assert.equal(validateParams('block.setData', { data: big }).ok, false)
  })

  it('drops oversized messages before parsing and kills after repeated attempts', () => {
    const s = setup()
    const huge = 'x'.repeat(LIMITS.maxMessageChars + 1)
    assert.equal(parseIncoming(huge).kind, 'oversize')
    for (let i = 0; i < LIMITS.maxOversize; i++) s.b.receive(huge)
    assert.deepEqual(s.kills, ['oversize'])
    assert.equal(s.b.isDead, true)
    s.send({ id: 1, method: 'pages.get', params: { pageId: PAGE } })
    assert.equal(s.out.length, 0, 'dead broker ignores everything')
  })

  it('rate-limits a message flood and kills the frame', () => {
    const s = setup()
    // 10,000 messages in the same millisecond: only the burst passes, the rest are violations.
    for (let i = 1; i <= 10_000 && !s.b.isDead; i++) {
      s.send({ id: i, method: 'ui.notice', params: { message: 'spam' } })
    }
    assert.ok(s.calls.length <= LIMITS.rateBurst, `at most the burst reaches handlers (${s.calls.length})`)
    assert.deepEqual(s.kills, ['flood'])
  })

  it('refills the bucket over time (legit steady traffic is fine)', async () => {
    const s = setup()
    for (let i = 1; i <= 300; i++) {
      s.advance(50) // 20 msg/s < refill 30/s
      s.send({ id: i, method: 'ui.notice', params: { message: 'ok' } })
      await tick()
    }
    assert.equal(s.kills.length, 0)
    assert.equal(s.calls.length, 300)
  })

  it('caps concurrent in-flight requests', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const s = setup({
      handlers: { 'pages.get': () => gate },
    })
    for (let i = 1; i <= LIMITS.maxInFlight + 5; i++) s.send({ id: i, method: 'pages.get', params: { pageId: PAGE } })
    await tick()
    const busy = s.out.filter((m) => m.error?.code === 'BUSY')
    assert.equal(busy.length, 5)
    release({})
    await tick()
    assert.equal(s.out.filter((m) => m.ok).length, LIMITS.maxInFlight)
  })

  it('truncates ui.notice text', () => {
    const v = validateParams('ui.notice', { message: 'a'.repeat(5000) })
    assert.equal(v.ok, true)
    assert.equal(v.params.message.length, LIMITS.noticeMaxChars)
  })
})
