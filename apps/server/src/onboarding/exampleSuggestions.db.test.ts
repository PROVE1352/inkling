// Example suggestions on the sample page (docs/adr/2388-*) against a real database: a new sample
// (button or the first admin's automatic one) comes with two open suggestions from the example agent
// in the person's language, marked by connection 'example'; nothing is notified when they are made
// or decided; the replace one splits into two changes and can be accepted in part; they stay out of
// the person's own list and the Team agents board but show on the page; an existing sample gets none;
// a failure to seed leaves the sample made and recorded.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-example-suggestions-${process.pid}`
delete process.env.ONBOARDING
delete process.env.ONBOARDING_EXISTING_USERS

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] example suggestions on the sample page', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { flushNotifications } = await import('../notify/engine')
  const { currentBlocks, readOutline, readSection } = await import('../context/sectionSource')
  const { readTeamAgents } = await import('../teamAgents')
  const { EXAMPLE_CONNECTION } = await import('../suggestions')
  const ex = await import('./exampleSuggestions')
  const { createSample } = await import('./state')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Suggestion = import('@inkling/shared').SuggestionDTO
  type Locale = 'en' | 'ko'
  const LANG: Record<Locale, string> = { en: 'en-US', ko: 'ko-KR,ko;q=0.9' }
  const call = (u: U, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie, ...headers }, ...(payload ? { payload } : {}) })
  const makeSample = async (u: U, wsId: string, locale: Locale) => {
    const r = await call(u, 'POST', '/me/onboarding/sample', { workspaceId: wsId }, { 'accept-language': LANG[locale] })
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as { pageId: string; created: boolean }
  }
  const pageSuggestions = async (u: U, pageId: string, status = 'open') => {
    const r = await call(u, 'GET', `/pages/${pageId}/suggestions?status=${status}`)
    assert.equal(r.statusCode, 200, r.body)
    return (r.json() as { suggestions: Suggestion[] }).suggestions
  }
  const rows = async (pageId: string) =>
    (await db.execute(sql`
      SELECT id, connection, origin, via, status, auto_at AS "autoAt", rule, review_reason AS "reviewReason"
        FROM section_suggestions WHERE page_id = ${pageId} ORDER BY created_at, id
    `)) as unknown as { id: string; connection: string; origin: string; via: string; status: string; autoAt: unknown; rule: unknown; reviewReason: unknown }[]
  const notificationsOf = async (u: U) =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${u.id}`)) as unknown as { n: number }[])[0].n
  const notifyRowsIn = async (wsId: string) =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'notify' AND workspace_id = ${wsId}`)) as unknown as { n: number }[])[0].n
  const fresh = async (name: string) => {
    const u = await h.makeUser(name)
    const ws = await h.makeWorkspace(u)
    return { u, ws }
  }

  for (const locale of ['ko', 'en'] as const) {
    it(`a new sample (${locale}) comes with two open example suggestions in that language, no notification`, async () => {
      const { u, ws } = await fresh(`seed-${locale}`)
      const made = await makeSample(u, ws.id, locale)
      assert.equal(made.created, true)
      // made with the sample, before any flush: no approval request queued
      assert.equal(await notifyRowsIn(ws.id), 0, 'no notify row in the outbox')
      const list = await pageSuggestions(u, made.pageId)
      assert.equal(list.length, 2)
      const items = ex.exampleSuggestionItems(locale)
      const [one, two] = list
      assert.deepEqual(
        list.map((s) => [s.headingPath, s.mode, s.via, s.origin, s.author.id]),
        [
          [items[0].heading, 'replace', ex.exampleAgentName(locale), 'asked', u.id],
          [items[1].heading, 'append', ex.exampleAgentName(locale), 'asked', u.id],
        ],
      )
      assert.equal(ex.exampleAgentName(locale), locale === 'ko' ? '예시 에이전트' : 'Example agent')
      // the rows carry the marker, and nothing an auto-accept sweep or a rule would act on
      for (const r of await rows(made.pageId)) {
        assert.equal(r.connection, EXAMPLE_CONNECTION)
        assert.equal(r.origin, 'asked')
        assert.equal(r.autoAt, null)
        assert.equal(r.rule, null)
        assert.equal(r.reviewReason, null)
      }
      // both point at their heading block (the ✎ marks need it)
      const outline = await readOutline(made.pageId)
      for (const s of list) {
        assert.ok(s.blockId, 'blockId set')
        assert.equal(outline.find((o) => o.anchor === s.anchor)?.blockId, s.blockId)
      }
      // their text says they are examples, not an AI's
      const exampleWord = locale === 'ko' ? /예시/ : /example/i
      assert.match(one.markdown, exampleWord)
      assert.match(two.markdown, exampleWord)
      assert.match(two.markdown, locale === 'ko' ? /AI가 쓴 글이 아닙니다/ : /No AI wrote it/)
      // the sample's top tip points at them
      const top = await readSection(made.pageId, outline[0].anchor)
      assert.ok(top.found)
      assert.equal(outline[0].level, 0, 'the part above the first heading')
      assert.match(top.markdown, locale === 'ko' ? /예시 에이전트의 제안을 검토/ : /review what the example agent suggested/)
      const topBlocks = (await currentBlocks(made.pageId)).slice(0, 2)
      assert.deepEqual(
        topBlocks.map((b) => [b.type, (b.props as { type?: string }).type]),
        [
          ['callout', 'note'],
          ['callout', 'tip'],
        ],
        'the tip is its own callout under the note',
      )
      // the AI section names the menu item of "What an agent reads" (fixed name, contract decision 7)
      const ai = await readSection(made.pageId, items[1].heading)
      assert.ok(ai.found)
      assert.match(ai.markdown, locale === 'ko' ? /에이전트가 보는 화면/ : /What an agent reads/)

      await flushNotifications()
      assert.equal(await notificationsOf(u), 0, 'no notification for the person')
    })
  }

  it('the replace suggestion splits into two changes; one alone → accepted_partial; reject and accept whole stay quiet', async () => {
    const { u, ws } = await fresh('decide')
    const made = await makeSample(u, ws.id, 'en')
    const [one, two] = await pageSuggestions(u, made.pageId)
    const [p1a, p1b] = ex.exampleSuggestionItems('en')[0].markdown.split('\n\n')

    const pr = (await call(u, 'GET', `/suggestions/${one.id}?preview=1`)).json() as { suggestion: Suggestion }
    const merge = pr.suggestion.preview!.merge!
    assert.equal(merge.baseKnown, true)
    const effective = merge.hunks.filter((x) => !x.same)
    assert.equal(effective.length, 2, 'two separate changes')
    assert.deepEqual(
      effective.map((x) => [x.before, x.after, x.conflict]),
      [
        ['', p1a, false],
        ['', p1b, false],
      ],
    )

    const acc = await call(u, 'POST', `/suggestions/${one.id}/accept`, { hunks: [effective[0].id], mergeKey: merge.key })
    assert.equal(acc.statusCode, 200, acc.body)
    const decided = (acc.json() as { suggestion: Suggestion }).suggestion
    assert.equal(decided.status, 'accepted_partial')
    assert.deepEqual(decided.partial, { applied: 1, total: 2 })
    const sec = await readSection(made.pageId, one.anchor)
    assert.ok(sec.found)
    assert.ok(sec.markdown.includes(p1a), 'the chosen paragraph is in')
    assert.ok(!sec.markdown.includes(p1b), 'the other one is not')
    assert.ok(sec.markdown.indexOf(p1a) < sec.markdown.indexOf('```mermaid'), 'in front of the code block')

    const rej = await call(u, 'POST', `/suggestions/${two.id}/reject`)
    assert.equal(rej.statusCode, 200, rej.body)
    await flushNotifications()
    assert.equal(await notificationsOf(u), 0, 'partial accept and reject: no notification')

    // accepted whole, on another sample: also quiet
    const { u: v, ws: ws2 } = await fresh('decide-whole')
    const made2 = await makeSample(v, ws2.id, 'ko')
    const [, tip] = await pageSuggestions(v, made2.pageId)
    const whole = await call(v, 'POST', `/suggestions/${tip.id}/accept`, {})
    assert.equal(whole.statusCode, 200, whole.body)
    assert.equal((whole.json() as { suggestion: Suggestion }).suggestion.status, 'accepted')
    const aiSec = await readSection(made2.pageId, tip.anchor)
    assert.ok(aiSec.found && aiSec.markdown.includes('AI가 쓴 글이 아닙니다'))
    await flushNotifications()
    assert.equal(await notificationsOf(v), 0, 'whole accept: no notification')
  })

  it('left out of the person’s own list and the Team agents board, shown on the page', async () => {
    const { u, ws } = await fresh('lists')
    const made = await makeSample(u, ws.id, 'en')
    const onPage = await pageSuggestions(u, made.pageId)
    assert.equal(onPage.length, 2)
    const ids = new Set(onPage.map((s) => s.id))
    for (const status of ['open', 'all']) {
      const mine = (await call(u, 'GET', `/suggestions?status=${status}`)).json() as { suggestions: Suggestion[] }
      assert.ok(!mine.suggestions.some((s) => ids.has(s.id)), `GET /suggestions?status=${status} leaves them out`)
    }
    const board = await readTeamAgents(ws.id, u.id, Date.now() - 3_600_000)
    assert.equal(board.totals.openSuggestions, 0)
    assert.equal(board.totals.suggestions, 0)
    assert.ok(board.people.every((p) => p.suggestions.length === 0 && p.agents.every((a) => a.suggestions === 0)))
  })

  it('an existing sample gets none; a new sample after deleting the old one gets its own two', async () => {
    const { u, ws } = await fresh('again')
    const first = await makeSample(u, ws.id, 'en')
    const again = await makeSample(u, ws.id, 'en')
    assert.deepEqual([again.created, again.pageId], [false, first.pageId])
    assert.equal((await rows(first.pageId)).length, 2, 'no more rows on the existing sample')

    assert.ok((await call(u, 'DELETE', `/pages/${first.pageId}`)).statusCode < 300)
    const second = await makeSample(u, ws.id, 'en')
    assert.equal(second.created, true)
    assert.notEqual(second.pageId, first.pageId)
    assert.equal((await rows(second.pageId)).length, 2)
    assert.equal((await rows(first.pageId)).length, 2, 'the old sample’s rows are left as they were')
  })

  it('a failure to seed leaves the sample made and recorded', async () => {
    const { u, ws } = await fresh('fail')
    const errors: unknown[] = []
    const log = console.error
    console.error = (...a: unknown[]) => void errors.push(a)
    ex.exampleSuggestionHooks.items = (locale) => [{ heading: 'No such heading', mode: 'append', markdown: `> [!tip] ${ex.exampleAgentName(locale)}` }]
    try {
      const made = await makeSample(u, ws.id, 'en')
      assert.equal(made.created, true)
      assert.equal((await rows(made.pageId)).length, 0)
      const d = (await call(u, 'GET', '/me/onboarding')).json() as { samples: Record<string, string> }
      assert.equal(d.samples[ws.id], made.pageId, 'the sample is recorded')
      assert.ok(errors.length >= 1, 'the failure is logged')
    } finally {
      ex.exampleSuggestionHooks.items = null
      console.error = log
    }
  })

  it('the first admin’s automatic sample is seeded too (createSample with auto)', async () => {
    const { u, ws } = await fresh('auto')
    const made = await createSample({ userId: u.id, userName: u.name, workspaceId: ws.id, role: 'owner', locale: 'ko', auto: true })
    assert.equal(made.created, true)
    const list = await pageSuggestions(u, made.pageId)
    assert.deepEqual(
      list.map((s) => s.via),
      ['예시 에이전트', '예시 에이전트'],
    )
    await flushNotifications()
    assert.equal(await notificationsOf(u), 0)
  })
})
