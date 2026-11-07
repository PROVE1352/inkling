import { z } from 'zod'

// The SPA's CSP has no 'unsafe-eval' (docs/adr/0814-*). zod probes `new Function` when the first
// object schema is built; the throw is caught, but the browser still reports a CSP violation.
// Browser only: the server keeps the JIT fast path. Must run before any schema is constructed,
// hence its own module imported first by index.ts.
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') z.config({ jitless: true })
