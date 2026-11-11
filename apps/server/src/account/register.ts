import type { FastifyInstance } from 'fastify'

/**
 * Restricted mode, piece B (accounts: sign-in IDs, deletion, lifetime, docs/adr/2512-*): the one place this piece registers itself.
 * restricted.ts registerRestrictedMode calls it inside the `/api` scope of every app (index.ts and the
 * test harnesses), after the auth routes. Register here: this piece's routes on `api`, sign-up hooks
 * (signupHooks.ts), request gates (requestGates.ts), auth/mode and me fields and housekeeping jobs
 * (restrictedExtras.ts).
 *
 * This function runs every time an app is built, and a test process builds several apps: routes go on
 * the `api` it is given each time, but hooks, gates, extras and housekeeping jobs are process-wide and
 * must be registered only once (keep a module-level flag), or their unique names throw.
 */
export async function registerAccount(api: FastifyInstance): Promise<void> {
  void api
}
