// Slack app: request signatures, event → post mapping, link parsing, first paragraph, manifest
// (docs/adr/1802-*, 1804-*, 1805-*, 1806-*). The [db] suite is slack.db.test.ts.
process.env.PUBLIC_URL ||= 'https://notes.example.com/'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { slackSignature, verifySlackSignature, replayKey, SLACK_TOLERANCE_S } = await import('./signature')
const { esc, linkOr } = await import('./messages')
const { setupInfo } = await import('./config')

describe('Slack v0 signatures', () => {
  const secret = '8f742231b10e8888abcd99aaaaaa85a5'
  const body = 'token=x&team_id=T1&user_id=U1&command=%2Finkling&text=deploy'
  const now = 1_800_000_000
  const ts = String(now)
  const sig = slackSignature(secret, ts, body)

  it('matches the documented construction and accepts a fresh request', () => {
    assert.match(sig, /^v0=[0-9a-f]{64}$/)
    assert.deepEqual(verifySlackSignature(secret, ts, sig, body, now), { ok: true })
  })

  it('refuses a changed body, another secret, a missing header and a malformed signature', () => {
    assert.deepEqual(verifySlackSignature(secret, ts, sig, body + '&x=1', now), { ok: false, reason: 'mismatch' })
    assert.deepEqual(verifySlackSignature('0'.repeat(32), ts, sig, body, now), { ok: false, reason: 'mismatch' })
    assert.deepEqual(verifySlackSignature(secret, undefined, sig, body, now), { ok: false, reason: 'missing' })
    assert.deepEqual(verifySlackSignature(secret, ts, 'v0=abc', body, now), { ok: false, reason: 'missing' })
    assert.deepEqual(verifySlackSignature(secret, ts, sig.toUpperCase(), body, now), { ok: false, reason: 'missing' })
  })

  it('accepts exactly five minutes of clock difference, in both directions', () => {
    assert.equal(verifySlackSignature(secret, ts, sig, body, now + SLACK_TOLERANCE_S).ok, true)
    assert.equal(verifySlackSignature(secret, ts, sig, body, now - SLACK_TOLERANCE_S).ok, true)
    assert.deepEqual(verifySlackSignature(secret, ts, sig, body, now + SLACK_TOLERANCE_S + 1), { ok: false, reason: 'stale' })
    assert.deepEqual(verifySlackSignature(secret, ts, sig, body, now - SLACK_TOLERANCE_S - 1), { ok: false, reason: 'stale' })
  })

  it('replay keys differ per signature and never contain the signature itself', () => {
    const k = replayKey(ts, sig)
    assert.match(k, /^sig:[0-9a-f]{64}$/)
    assert.notEqual(k, replayKey(ts, slackSignature(secret, ts, body + '1')))
    assert.ok(!k.includes(sig.slice(3)))
  })
})

describe('Slack text escaping', () => {
  it('neutralises <, > and & so a title cannot form a mention or a link', () => {
    assert.equal(esc('<!channel> & <https://evil|x>'), '&lt;!channel&gt; &amp; &lt;https://evil|x&gt;')
    assert.equal(linkOr('https://n.example/w/1/p/2', 'a|b'), '*<https://n.example/w/1/p/2|a¦b>*')
    assert.equal(linkOr(null, 'T'), '*T*')
  })
})

describe('notification events → channel posts', async () => {
  const { slackPostFor } = await import('./notify')
  const base = { workspaceId: 'w', pageId: 'p', actorId: 'a', via: null as string | null, recipients: [] as { userId: string; kind: never; reason: 'direct' }[] }
  const r = (userId: string, kind: string) => ({ userId, kind: kind as never, reason: 'direct' as const })
  const all = new Set(['mention', 'assigned', 'suggestion', 'reply', 'digest'] as const)

  it('picks the first switched-on kind in the order mention > assigned > suggestion > reply', () => {
    const ev = { ...base, commentId: 'c', recipients: [r('b', 'comment_reply'), r('c', 'comment_mention'), r('d', 'comment')] }
    assert.equal(slackPostFor(ev, all)?.kind, 'mention')
    assert.equal(slackPostFor(ev, all)?.inComment, true)
    assert.deepEqual(slackPostFor(ev, all)?.userIds, ['c'])
    const noMention = new Set(['reply'] as const)
    assert.equal(slackPostFor(ev, noMention)?.kind, 'reply')
    assert.equal(slackPostFor(ev, new Set(['assigned'] as const)), null)
  })

  it('never posts followers-only activity, page-less items or the actor alone', () => {
    assert.equal(slackPostFor({ ...base, recipients: [], followers: 'page_update' }, all), null)
    assert.equal(slackPostFor({ ...base, pageId: null, recipients: [r('b', 'doc_mention')] }, all), null)
    assert.equal(slackPostFor({ ...base, recipients: [r('a', 'doc_mention')] }, all), null)
    assert.equal(slackPostFor({ ...base, recipients: [r('b', 'agent_digest')] }, all), null)
  })

  it('an agent mention does not ping the channel; its suggestion does', () => {
    assert.equal(slackPostFor({ ...base, via: 'Claude', recipients: [r('b', 'doc_mention')] }, all), null)
    const s = slackPostFor({ ...base, via: 'Claude', actorId: null as unknown as string, recipients: [r('b', 'approval_request')], anchor: 'plan' }, all)
    assert.equal(s?.kind, 'suggestion')
    assert.equal(s?.anchor, 'plan')
    assert.equal(s?.commentId, null)
  })

  it('assignments carry the field name, owner assignments say owner', () => {
    assert.equal(slackPostFor({ ...base, recipients: [r('b', 'task_assigned')], excerpt: 'Reviewer' }, all)?.field, 'Reviewer')
    assert.equal(slackPostFor({ ...base, recipients: [r('b', 'page_owner')] }, all)?.field, 'owner')
  })
})

describe('link unfurl helpers', async () => {
  const { pageLinksOf } = await import('./inbound')
  const { firstParagraph } = await import('./notify')
  const ws = '11111111-1111-4111-8111-111111111111'
  const pg = '22222222-2222-4222-8222-222222222222'

  it('accepts only page links of this host and this workspace', () => {
    const links = [
      { url: `https://notes.example.com/w/${ws}/p/${pg}` },
      { url: `https://evil.example.com/w/${ws}/p/${pg}` },
      { url: `https://notes.example.com/w/33333333-3333-4333-8333-333333333333/p/${pg}` },
      { url: `https://notes.example.com/w/${ws}/settings` },
      { url: 'not a url' },
      { nope: 1 },
    ]
    assert.deepEqual(pageLinksOf(links, ws, 'https://notes.example.com'), [{ url: links[0].url, pageId: pg }])
    assert.deepEqual(pageLinksOf(links, ws, null), [])
  })

  it('first paragraph skips the title and short heading-like lines, and is capped', () => {
    assert.equal(firstParagraph('Plan\nGoals\nWe ship the release on Friday after the review.\nMore', 'Plan'), 'We ship the release on Friday after the review.')
    assert.equal(firstParagraph('Short', 'Title'), 'Short')
    assert.equal(firstParagraph('', 'Title'), null)
    assert.equal(firstParagraph('x'.repeat(1000), 'T')!.length, 300)
  })
})

describe('setup values and manifest', () => {
  it('fills the request URLs from PUBLIC_URL and lists the unfurl domain', () => {
    const s = setupInfo('11111111-1111-4111-8111-111111111111', 'http://ignored:1')
    assert.equal(s.commandUrl, 'https://notes.example.com/api/slack/w/11111111-1111-4111-8111-111111111111/commands')
    assert.equal(s.eventsUrl, 'https://notes.example.com/api/slack/w/11111111-1111-4111-8111-111111111111/events')
    assert.equal(s.unfurlDomain, 'notes.example.com')
    assert.equal(s.publicUrlSet, true)
    const m = s.manifest as { features: { slash_commands: { url: string }[]; unfurl_domains: string[] }; oauth_config: { scopes: { bot: string[] } } }
    assert.equal(m.features.slash_commands[0].url, s.commandUrl)
    assert.deepEqual(m.features.unfurl_domains, ['notes.example.com'])
    assert.ok(m.oauth_config.scopes.bot.includes('links:write'))
    assert.ok(m.oauth_config.scopes.bot.includes('users:read.email'))
  })
})
