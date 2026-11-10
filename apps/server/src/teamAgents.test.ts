// Team agents, pure parts (docs/adr/1860-* .. 1866-*): the "person's connection" value, the person
// cell next-to-key rule a 0.14 client never sees, agent chips in to-dos, and the MCP output (inbox
// marker, catch_up team group) with its token cost. `TOKENS=1` prints the measured numbers.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { agentPropKey, agentRefOfCell, formatAgentRef, parseAgentRef, shortConnection } from '@inkling/shared'
import type { TeamAgentsDTO } from '@inkling/shared'
import { estimateTokens } from './context/tokens'
import { scanMentions } from './notify/mentionScan'
import { formatInbox } from './mcpTools/inboxTools'
import type { InboxItem } from './routes/inbox'
import { teamItems, packItems, renderPacked } from './catchUp'

const U = '0b9d8e7f-2222-4a1b-8c3d-abcdef012345'
const V = '1c9d8e7f-3333-4a1b-8c3d-abcdef012345'
const G = '7a6b5c4d-3333-4e2f-9a1b-fedcba987654'
const P1 = '9f8e7d6c-1111-4c3b-9a55-0123456789ab'
const P2 = 'aa8e7d6c-1111-4c3b-9a55-0123456789ab'
const log = (s: string) => {
  if (process.env.TOKENS === '1') console.log(s)
}

describe('agent ref value', () => {
  it('parses and formats `<person>/<connection>`, lower case; anything else is not a ref', () => {
    assert.deepEqual(parseAgentRef(`${U.toUpperCase()}/GRANT:${G}`), { userId: U, connection: `grant:${G}` })
    assert.equal(formatAgentRef({ userId: U, connection: `token:${G}` }), `${U}/token:${G}`)
    for (const bad of [U, `grant:${G}`, `${U}/grant:x`, `${U}/oauth:${G}`, 42, null]) assert.equal(parseAgentRef(bad), null)
    assert.equal(shortConnection(`grant:${G}`), 'g:7a6b5c4d')
    assert.equal(shortConnection(`token:${G}`), 't:7a6b5c4d')
  })

  it('person cell: the agent counts only while its person is in the cell (what a 0.14 client changes)', () => {
    const props = { own: U, [agentPropKey('own')]: `${U}/grant:${G}` }
    assert.deepEqual(agentRefOfCell(props, 'own'), { userId: U, connection: `grant:${G}` })
    // a 0.14 client set the cell to someone else and kept the extra key: the key no longer counts
    assert.equal(agentRefOfCell({ ...props, own: V }, 'own'), null)
    // arrays (imports) work the same
    assert.deepEqual(agentRefOfCell({ ...props, own: [V, U] }, 'own')?.userId, U)
    assert.equal(agentRefOfCell({ own: U }, 'own'), null)
  })
})

describe('agent chips in documents', () => {
  function doc(blockType: string, kind: string, id: string): Uint8Array {
    const d = new Y.Doc()
    const group = new Y.XmlElement('blockGroup')
    d.getXmlFragment('document').insert(0, [group])
    const bc = new Y.XmlElement('blockContainer')
    group.insert(0, [bc])
    bc.setAttribute('id', 'b1')
    const el = new Y.XmlElement(blockType)
    bc.insert(0, [el])
    const t = new Y.XmlText()
    el.insert(0, [t])
    t.insert(0, 'Ship it ')
    const m = new Y.XmlElement('mention')
    el.insert(1, [m])
    m.setAttribute('kind', kind)
    m.setAttribute('id', id)
    m.setAttribute('label', 'Kim · Claude Code')
    const out = Y.encodeStateAsUpdate(d)
    d.destroy()
    return out
  }

  it('an agent chip names the person and the connection; in a to-do it is an assignment', () => {
    const [m] = scanMentions(doc('checkListItem', 'agent', `${U}/grant:${G}`))
    assert.deepEqual(m, { userId: U, connection: `grant:${G}`, blockId: 'b1', top: 0, text: 'Ship it @Kim · Claude Code', inTask: true })
    const [p] = scanMentions(doc('paragraph', 'agent', `${U}/grant:${G}`))
    assert.equal(p.inTask, false)
    // a malformed agent id is ignored, a person chip is unchanged (no connection, no inTask key)
    assert.deepEqual(scanMentions(doc('paragraph', 'agent', U)), [])
    assert.deepEqual(scanMentions(doc('checkListItem', 'user', U)), [{ userId: U, blockId: 'b1', top: 0, text: 'Ship it @Kim · Claude Code' }])
  })
})

describe('MCP output', () => {
  const item = (seq: string, handoff?: boolean): InboxItem => ({
    seq,
    kind: 'mention',
    type: 'comment_mention',
    workspaceId: 'w',
    pageId: P1,
    pageTitle: 'Launch plan',
    anchor: null,
    actorName: 'Alice',
    via: null,
    excerpt: 'draft the FAQ',
    count: 1,
    createdAt: '2026-11-10T09:00:00.000Z',
    read: false,
    can: 'edit',
    ...(handoff === undefined ? {} : { handoff }),
  })

  it('inbox: lines of items for the person are byte-identical to 0.14; a hand-off adds one marker', () => {
    const before = formatInbox({ items: [item('5')], more: false, unacked: 1 }, undefined, 2000)
    const after = formatInbox({ items: [item('5', false)], more: false, unacked: 1, handoffs: 0 }, undefined, 2000)
    assert.equal(after, before)
    const handed = formatInbox({ items: [item('5', true)], more: false, unacked: 1, handoffs: 1 }, undefined, 2000)
    assert.match(handed, /^inbox: 1 item\(s\) · 1 unacknowledged in total \(1 handed to this connection\)$/m)
    assert.match(handed, /^5 \| mention \(comment\) → this connection \| page /m)
    const extra = estimateTokens(handed) - estimateTokens(before)
    log(`[tokens] inbox hand-off: +${extra} tokens for one item (${estimateTokens(before)} → ${estimateTokens(handed)})`)
    assert.ok(extra > 0 && extra <= 16)
  })

  const team: TeamAgentsDTO = {
    since: '2026-11-10T00:00:00.000Z',
    now: '2026-11-10T10:00:00.000Z',
    totals: { claims: 2, openSuggestions: 1, edits: 4, created: 1, suggestions: 2, reverted: 1 },
    people: [
      {
        userId: V,
        name: 'Minsu',
        claims: [
          { pageId: P1, pageTitle: 'Launch plan', anchor: 'faq', hidden: false, connection: `grant:${G}`, client: 'Claude Code', expiresAt: '2026-11-10T10:12:00.000Z', ttlSeconds: 720 },
          { pageId: P2, pageTitle: null, anchor: null, hidden: true, connection: `grant:${G}`, client: 'Claude Code', expiresAt: '2026-11-10T10:05:00.000Z', ttlSeconds: 300 },
        ],
        suggestions: [{ id: 's1', pageId: P1, pageTitle: 'Launch plan', anchor: 'faq', hidden: false, mode: 'replace', client: 'Claude Code', createdAt: '2026-11-10T09:30:00.000Z' }],
        agents: [
          {
            client: 'Claude Code',
            connections: [`grant:${G}`],
            edits: 4,
            created: 1,
            suggestions: 2,
            reverted: 1,
            lastAt: '2026-11-10T09:58:00.000Z',
            recentPages: [
              { pageId: P1, title: 'Launch plan', hidden: false, at: '2026-11-10T09:58:00.000Z' },
              { pageId: P2, title: null, hidden: true, at: '2026-11-10T09:40:00.000Z' },
            ],
          },
          { client: 'Cursor', connections: [], edits: 0, created: 0, suggestions: 0, reverted: 0, lastAt: null, recentPages: [] },
        ],
      },
    ],
  }

  it('catch_up team group: claims and one line per busy agent, short ids, hidden pages without title; deterministic', () => {
    const items = teamItems(team, { workspaceId: 'w', many: false, connection: null, userId: U, nowMs: Date.parse(team.now) })
    const text = renderPacked(packItems(items, 4000)).join('\n')
    assert.equal(text, renderPacked(packItems(teamItems(team, { workspaceId: 'w', many: false, connection: null, userId: U, nowMs: 0 }), 4000)).join('\n'))
    assert.equal(
      text,
      [
        "## Team agents (others' claims and agents)",
        '- claim (hidden) aa8e7d6c · Minsu via Claude Code (g:7a6b5c4d) · until 2026-11-10T10:05Z (5 min)',
        '- claim §faq · "Launch plan" 9f8e7d6c · Minsu via Claude Code (g:7a6b5c4d) · until 2026-11-10T10:12Z (12 min)',
        '- Minsu via Claude Code (g:7a6b5c4d): 4 edits, 1 new, 2 suggested, 1 open, 1 reverted · last 2026-11-10T09:58Z · "Launch plan" 9f8e7d6c, (hidden) aa8e7d6c',
      ].join('\n'),
    )
    log(`[tokens] catch_up team group for 1 person, 2 claims, 1 busy agent: ${estimateTokens(text)} tokens`)
    // this connection's own claims and agent are left out
    const own = teamItems(team, { workspaceId: 'w', many: false, connection: `grant:${G}`, userId: V, nowMs: 0 })
    assert.equal(own.length, 0)
  })
})
