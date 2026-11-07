// Run: cd apps/server && npx tsx --test src/query/query.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { parseQuery, QuerySyntaxError, tryParseQuery } from '@inkling/shared'
import { compileQuery, QueryCompileError, takeLimit } from './compile'

const ctx = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  today: '2026-11-07',
  tzOffsetMinutes: 540,
}

function compile(src: string) {
  return new PgDialect().sqlToQuery(compileQuery(parseQuery(src), ctx).statement)
}

describe('query parser', () => {
  it('parses the full clause set', () => {
    const ast = parseQuery(
      'TABLE WITHOUT ID file.name AS "Name", `My Prop` FROM #a/b OR ("Work/Notes" AND -[[Home]]) WHERE x = "1" AND !(y < 2) SORT due DESC, file.name LIMIT 5',
    )
    assert.equal(ast.type, 'TABLE')
    assert.equal(ast.withoutId, true)
    assert.deepEqual(
      ast.columns.map((c) => c.label),
      ['Name', 'My Prop'],
    )
    assert.equal(ast.sort.length, 2)
    assert.equal(ast.sort[0].dir, 'desc')
    assert.equal(ast.limit, 5)
    assert.equal(ast.from?.k, 'or')
  })

  it('reports line and column', () => {
    const r = tryParseQuery('LIST\nWHERE a = ')
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.error.line, 2)
      assert.equal(r.error.col, 11)
    }
  })

  for (const bad of [
    'TABEL x',
    'TABLE a b',
    'LIST WHERE a = "x',
    'LIST FROM',
    'LIST LIMIT 0',
    'LIST LIMIT 501',
    'LIST WHERE a < b < c',
    'LIST WHERE file.nope = 1',
    'LIST WHERE foo(1)',
    'LIST SORT a WHERE b FROM #x',
    'LIST WHERE date("2026-13-01") = a',
  ]) {
    it(`rejects: ${bad}`, () => {
      assert.throws(() => parseQuery(bad), QuerySyntaxError)
    })
  }

  it('caps length, tokens and depth without blowing the stack', () => {
    assert.throws(() => parseQuery(`LIST WHERE ${'a = 1 AND '.repeat(300)}a = 1`), /tokens|too long/)
    assert.throws(() => parseQuery(`LIST WHERE ${'('.repeat(5000)}a${')'.repeat(5000)}`), /too long|nested/)
    assert.throws(() => parseQuery(`LIST WHERE ${'NOT '.repeat(100)}a`), /nested/)
  })

  it('tokenizes adversarial input in linear time', () => {
    const t0 = performance.now()
    for (const s of ['"'.repeat(1999), '#'.repeat(1999), '[['.repeat(999), 'a'.repeat(1999), '`'.repeat(1999)]) {
      tryParseQuery(`LIST WHERE ${s}`.slice(0, 2000))
    }
    assert.ok(performance.now() - t0 < 200)
  })
})

describe('query compiler', () => {
  it('never puts user values into SQL text', () => {
    const evil = `x'); DROP TABLE pages; --`
    const { sql, params } = compile(
      `TABLE \`${evil}\` FROM #${'t'} OR "${evil}" OR [[${evil}]] WHERE \`${evil}\` = "${evil}" AND contains(file.tags, "${evil}") SORT \`${evil}\``,
    )
    assert.ok(!sql.includes('DROP TABLE'), 'value leaked into SQL text')
    assert.ok(params.some((p) => typeof p === 'string' && p.includes('DROP TABLE')))
  })

  it('always filters by workspace, trash, templates and visibility', () => {
    for (const q of ['LIST', 'TASK', 'TABLE file.folder FROM "A"']) {
      const { sql, params } = compile(q)
      assert.match(sql, /"pages"\."workspace_id" = \$/)
      assert.match(sql, /"pages"\."deleted_at" IS NULL/)
      assert.match(sql, /"pages"\."is_template" = '0'/)
      assert.match(sql, /"pages"\."scope"/) // visibleTo
      assert.ok(params.includes(ctx.userId))
    }
  })

  it('applies visibility inside the folder CTE too', () => {
    const { sql } = compile('LIST FROM "A/B"')
    const cte = sql.slice(0, sql.indexOf(') SELECT'))
    assert.equal((cte.match(/"pages"\."scope"/g) ?? []).length >= 2, true)
  })

  it('clamps LIMIT and fetches one extra row', () => {
    assert.equal(compileQuery(parseQuery('LIST'), ctx).fetch, 201)
    assert.equal(compileQuery(parseQuery('LIST LIMIT 7'), ctx).fetch, 8)
  })

  it('resolves date(today) with the viewer date', () => {
    const { params } = compile('LIST WHERE due < date(today) AND x > date(tomorrow)')
    assert.ok(params.includes('2026-11-07'))
    assert.ok(params.includes('2026-11-08'))
  })

  it('rejects unknown file fields at compile time as well', () => {
    assert.throws(
      () => compileQuery({ ...parseQuery('LIST'), where: { k: 'field', path: ['file', 'x'], pos: 0 } }, ctx),
      QueryCompileError,
    )
  })
})

describe('query result truncation', () => {
  it('fetches LIMIT + 1 and flags truncation only when the extra row exists', () => {
    const compiled = compileQuery(parseQuery('TASK WHERE !completed LIMIT 12'), ctx)
    assert.equal(compiled.limit, 12)
    assert.equal(compiled.fetch, 13)
    const exact = takeLimit(Array.from({ length: 12 }, (_, i) => i), compiled.limit)
    assert.deepEqual([exact.rows.length, exact.truncated], [12, false])
    const more = takeLimit(Array.from({ length: 13 }, (_, i) => i), compiled.limit)
    assert.deepEqual([more.rows.length, more.truncated], [12, true])
  })
})
