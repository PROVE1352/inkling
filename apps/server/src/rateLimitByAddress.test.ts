// Every route with a rate limit of its own and no sign-in preHandler must count by address
// (rateLimitKey.ts addressKey). The global key gives any `Bearer ink_pat_…` header a bucket of its own
// before the token is looked up; a route that never checks a bearer would let a made-up token per
// request reset the limit (0.25.4 security fix, A-F1). A signed-in route is safe with the global key:
// requireUser answers a made-up token with 401 and counts it towards the IP ban.
//
// Static: reads the route registrations of every server source file with the TypeScript parser, so a
// new unauthenticated route with a plain `rateLimit: { max, timeWindow }` fails here.
// Run: cd apps/server && node ../../scripts/run-tests.mjs --test-name-pattern=address
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import ts from 'typescript'

const SRC = path.dirname(new URL(import.meta.url).pathname)
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'])

type Found = { file: string; line: number; path: string; keyed: boolean; signedIn: boolean }

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .filter((f) => !/TestKit\.ts$|testHarness\.ts$|testKit\.ts$/i.test(f))
    .filter((f) => !f.split(path.sep).includes('node_modules'))
}

/** The route registrations with a `config.rateLimit` in one file. */
function scan(rel: string, text: string): Found[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  const consts = new Map<string, ts.Expression>()
  const visitDecls = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer)
    ts.forEachChild(n, visitDecls)
  }
  visitDecls(sf)

  const unwrap = (e: ts.Expression): ts.Expression => {
    let x = e
    for (let i = 0; i < 10; i++) {
      if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression
      else if (ts.isIdentifier(x) && consts.has(x.text)) x = consts.get(x.text)!
      // `const rpc = (max) => ({ … })` used as `rpc(10)`
      else if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && consts.has(x.expression.text)) {
        const fn = consts.get(x.expression.text)!
        if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) x = fn.body
        else break
      } else break
    }
    return x
  }
  /** Properties of an object expression, spreads and same-file constants resolved. */
  const props = (e: ts.Expression | undefined): Map<string, ts.Expression> => {
    const out = new Map<string, ts.Expression>()
    if (!e) return out
    const o = unwrap(e)
    if (!ts.isObjectLiteralExpression(o)) return out
    for (const p of o.properties) {
      if (ts.isSpreadAssignment(p)) for (const [k, v] of props(p.expression)) out.set(k, v)
      else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.set(p.name.text, p.initializer)
      else if (ts.isShorthandPropertyAssignment(p)) out.set(p.name.text, p.name)
    }
    return out
  }
  const isSignInGuard = (e: ts.Expression | undefined): boolean => {
    if (!e) return false
    const x = ts.isIdentifier(e) ? e : unwrap(e)
    if (ts.isIdentifier(x)) return /^require[A-Z]/.test(x.text)
    if (ts.isArrayLiteralExpression(x)) return x.elements.length > 0 && isSignInGuard(x.elements[0])
    return false
  }

  const found: Found[] = []
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      METHODS.has(n.expression.name.text) &&
      n.arguments.length >= 3 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      const opts = props(n.arguments[1])
      const rl = props(props(opts.get('config')).get('rateLimit'))
      if (rl.size > 0) {
        found.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          path: n.arguments[0].text,
          keyed: rl.has('keyGenerator'),
          signedIn: isSignInGuard(opts.get('preHandler')),
        })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

describe('per-route rate limits on routes without sign-in count by address', () => {
  const all = sourceFiles().flatMap((rel) => scan(rel, readFileSync(path.join(SRC, rel), 'utf8')))

  it('the scan sees the known routes (the parser still understands the registrations)', () => {
    const paths = new Set(all.map((f) => f.path))
    for (const p of ['/oauth/register', '/oauth/token', '/auth/login', '/auth/verify-email/send', '/auth/oidc/start', '/public/:token/unlock', '/public/forms/:token', '/ical/:file', '/workspaces/join']) {
      assert.ok(paths.has(p), `scan missed ${p}`)
    }
    assert.ok(all.length > 40, `only ${all.length} limited routes found`)
  })

  it('every limited route without a sign-in preHandler has its own key generator', () => {
    const bad = all.filter((f) => !f.signedIn && !f.keyed).map((f) => `${f.file}:${f.line} ${f.path}`)
    assert.deepEqual(bad, [], 'these routes inherit the global key, which a made-up `Bearer ink_pat_…` per request resets; give them addressKey() (rateLimitKey.ts)')
  })
})
