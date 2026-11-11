import type { FastifyInstance } from 'fastify'
import { env } from '../env'
import { limits } from '../limits'
import { registerRequestGate } from '../requestGates'
import { registerAuthModeExtra, registerMeExtra } from '../restrictedExtras'
import { registerSignupHook, type SignupContext } from '../signupHooks'
import { describeBundle, LEGAL_DOC_NAMES, loadLegalDir, type LegalBundle } from './bundle'
import { activeLegal, checkConsents, consentRequired, hasConsented, recordConsents, setActiveLegal } from './consent'
import { registerLegalRoutes } from './routes'

/**
 * Restricted mode, piece C (terms, privacy, consent, docs/adr/2519-*): the one place this piece
 * registers itself. restricted.ts registerRestrictedMode calls it inside the `/api` scope of every app.
 *
 * Without LEGAL_DIR nothing is registered: no routes (404), no sign-up hook (a sign-up without
 * `consents` works as in 0.21.1), no gate, no /auth/mode or /auth/me field.
 *
 * With LEGAL_DIR the folder is read and checked once (a bad folder throws, so the server does not
 * boot), and the process-wide parts are registered once; the routes go on every app built. Tests
 * build several apps in one process and switch LEGAL_DIR with setLimitsForTests, so each call brings
 * the registrations in line with the current setting instead of trusting a one-time flag.
 */

let current: { dir: string; off: (() => void)[] } | null = null

function teardown(): void {
  for (const off of current?.off ?? []) off()
  current = null
  setActiveLegal(null)
}

function gateMessage(): string {
  const url = env.publicUrl ?? env.appUrl
  return url
    ? `You must agree to the terms of this server first. Sign in on the web and agree: ${url}/`
    : 'You must agree to the terms of this server first. Sign in to the web app of this server and agree.'
}

/**
 * The sign-up check: every sign-up, the first admin made with the setup code included (the operator
 * agrees to the terms like everyone else; `ctx.setupCode` is deliberately not looked at).
 */
export function legalBeforeSignup(ctx: Pick<SignupContext, 'body'>): void {
  const b = activeLegal()
  if (b) checkConsents(b, ctx.body.consents, ctx.body.legalVersion)
}

function registerProcessWide(): (() => void)[] {
  const bundle = (): LegalBundle | null => activeLegal()
  return [
    registerAuthModeExtra('legal', () => {
      const b = bundle()
      return b ? { legal: { version: b.version, docs: LEGAL_DOC_NAMES.filter((d) => b.docs[d]) } } : {}
    }),
    registerMeExtra('legal-consent', async (user) => {
      const b = bundle()
      return b && !(await hasConsented(user.id, b)) ? { consentRequired: true as const } : {}
    }),
    // Sign-up: the check before anything is spent, the rows in the account's transaction.
    registerSignupHook('legal-consent', {
      before: legalBeforeSignup,
      on: async (tx, user, ctx) => {
        const b = bundle()
        if (b) await recordConsents(tx, user.id, checkConsents(b, ctx.body.consents, ctx.body.legalVersion), b.version, ctx.ip)
      },
    }),
    // Every authenticated request: cookie, API token, MCP (the /mcp door and the REST its tools call),
    // the collaboration socket. Automation runs are the server's own work on a rule set up earlier,
    // not a request of the person: refusing them would count as failures and turn the rule off.
    registerRequestGate('legal-consent', async ({ user }) => {
      const b = bundle()
      if (!b || user.automation) return
      if (await hasConsented(user.id, b)) return
      throw consentRequired(b, gateMessage(), 403)
    }),
  ]
}

export async function registerLegal(api: FastifyInstance): Promise<void> {
  const dir = limits.legalDir
  if (!dir) {
    if (current) teardown()
    return
  }
  if (!current || current.dir !== dir) {
    teardown()
    const bundle = loadLegalDir(dir)
    const { info, warn } = describeBundle(bundle)
    for (const line of info) console.log(line)
    for (const line of warn) console.warn(line)
    setActiveLegal(bundle)
    current = { dir, off: registerProcessWide() }
  }
  await registerLegalRoutes(api)
}

/** Tests: read LEGAL_DIR again (a changed file = a new version), as a restart would. */
export function reloadLegalForTests(): LegalBundle | null {
  if (!current) return null
  const bundle = loadLegalDir(current.dir)
  setActiveLegal(bundle)
  return bundle
}

/** Tests: unregister everything (the next registerLegal starts from the current setting). */
export function resetLegalForTests(): void {
  teardown()
}
