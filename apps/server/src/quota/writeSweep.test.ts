// A workspace that is read-only for storage refuses every write that can grow what it keeps (contract §14,
// security review F5, docs/adr/2533-*). Every POST, PUT and PATCH route in the server's source is in the
// table below, either checked (the handler, or the helper it goes through, calls one of the storage
// checks) or open with the reason. A new write route fails this test until it is added here.
// The database suite quota/readOnlyWrites.db.test.ts sends the routes that grow content to a full
// workspace and expects LIMIT_STORAGE.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = /\b(assertWorkspaceWritable|assertWorkspaceGrowth|assertWorkspaceRoom|assertUserRoom|assertWorkspacesTotalRoom|pageEditGate)\(/

type Entry = 'check' | { via: string } | { open: string }

const PERSON = 'about the person only (account, session, sign-in, their own preferences, lists and read marks), not workspace storage; the instance fuse covers the disk'
const ADMIN = 'server admin, not workspace storage'
const SETTING = 'replaces a setting of bounded size in place; switching things off must stay possible in a full workspace'
const SHRINKS = 'removes, unpublishes, rejects or restores what is counted already: makes room or leaves it as it is'
const MEMBERS = 'membership and roles: joining is checked as members; leaving, removing and handing over never add storage'
const READS = 'a read sent as POST'

const ROUTES: Record<string, Entry> = {
  // --- content: checked in the handler ---
  'POST /pages': 'check',
  'PATCH /pages/:id': 'check', // title, icon, cover, aliases, date property; moving and switches are open
  'PATCH /pages/:id/props': 'check', // R10
  'PUT /pages/:id/collection/fields': 'check',
  'POST /pages/:id/collection/views': 'check',
  'PATCH /collection-views/:id': 'check',
  'POST /pages/:id/collection/row-templates': 'check',
  'PATCH /collection-row-templates/:id': 'check',
  'POST /pages/:id/collection/rows/batch': 'check',
  'PATCH /pages/:id/collection/rows/batch': 'check',
  'POST /pages/:id/comments': 'check',
  'PATCH /comments/:id': 'check', // an edited body; resolving is not refused
  'PUT /pages/:id/ink': 'check',
  'POST /pages/:id/snapshots': 'check',
  'POST /pages/:id/snapshots/:sid/restore': 'check',
  'POST /pages/:id/sections': 'check',
  'POST /pages/:id/duplicate': 'check',
  'POST /pages/:id/expand-canvas': 'check',
  'POST /pages/:id/share': 'check',
  'POST /files': 'check',
  'POST /clip': 'check',
  'POST /workspaces/:id/tasks': 'check',
  'POST /workspaces/:id/sync/pages': 'check',
  'PUT /pages/:id/sync/md': 'check',
  'POST /collections/:id/automations': 'check',
  'POST /workspaces/:id/webhooks': 'check',
  // --- content: checked in the helper the handler goes through ---
  'POST /pages/:id/content': { via: 'pageContentWrite.ts' },
  'POST /pages/:id/section': { via: 'context/sectionWrite.ts' }, // body writes; suggestions via suggestions.ts
  'POST /suggestions/:id/accept': { via: 'suggestions.ts' }, // createSuggestions, and the accept writes through the gate
  'POST /pages/:id/revert': { via: 'revert.ts' },
  'POST /changes/:seq/revert': { via: 'revert.ts' },
  'POST /workspaces/:id/revert': { via: 'revert.ts' },
  'POST /pages/:id/collection/rows': { via: 'rowTemplates.ts' }, // createRow
  'POST /public/forms/:token': { via: 'rowTemplates.ts' }, // createRow (public-forms)
  'POST /pages/from-template': { via: 'templates/structure.ts' }, // instantiateTree
  'POST /me/onboarding/sample': { via: 'templates/structure.ts' }, // instantiateTree
  'POST /workspaces/:id/templates': { via: 'routes/templates.ts' }, // insertTemplate
  'POST /workspaces/:id/templates/import': { via: 'routes/templates.ts' }, // insertTemplate
  'POST /workspaces/:id/import': { via: 'md/importer.ts' }, // also md/notionImport.ts
  'POST /workspaces/:id/import-folder': { via: 'md/importer.ts' },
  'POST /pages/:id/split': { via: 'routes/splitPage.ts' }, // insertChildren
  'POST /pages/:id/rotation/target': { via: 'routes/splitPage.ts' }, // insertChildren
  'POST /pages/:id/collection/sheet-sync/run': { via: 'routes/sheetSync.ts' },
  'POST /plugins/:id/pages/:pageId/content': { open: 'goes through POST /api/pages/:id/content (injected as the user), which is checked' },
  // --- open: bounded settings replaced in place ---
  'PATCH /workspaces/:id': { open: SETTING + ' (the name, at most 60 characters)' },
  'PATCH /workspaces/:id/settings': { open: SETTING },
  'PUT /workspaces/:id/settings/agent-ink': { open: SETTING },
  'PUT /workspaces/:id/settings/agent-taint': { open: SETTING },
  'PUT /workspaces/:id/settings/agent-uploads': { open: SETTING },
  'PUT /workspaces/:id/settings/two-factor': { open: SETTING },
  'PUT /workspaces/:id/agent-policy': { open: SETTING + ' (level and auto-accept rules)' },
  'PUT /pages/:id/agent-rules': { open: SETTING },
  'PUT /pages/:id/agent-instructions': { open: SETTING + ' (designates an instruction page; description ≤ 300)' },
  'PUT /pages/:id/lock': { open: SETTING },
  'PUT /pages/:id/living': { open: SETTING },
  'PUT /pages/:id/owner': { open: SETTING },
  'PUT /pages/:id/rotation': { open: SETTING },
  'PUT /pages/:id/access': { open: SETTING + ' (one grant per person, people are bounded by the account limit)' },
  'PATCH /pages/:id/share': { open: SETTING + ' (expiry, password of the one link a page has)' },
  'PATCH /pages/:id/tasks/:blockId': { open: 'ticks a task or moves its date in place (ADR 2506 keeps it open: it must not grow the body)' },
  'POST /pages/:id/verification': { open: SETTING + ' (verified until, a note ≤ VERIFY_NOTE_MAX)' },
  'POST /pages/:id/review': { open: SETTING + ' (reviewed now)' },
  'PATCH /collections/:id/automations/:ruleId': { open: SETTING + ' (a rule is replaced; turning one off must work)' },
  'PUT /pages/:id/collection/sheet-sync': { open: SETTING + ' (experimental sheets sync settings)' },
  'POST /collection-views/:id/form-link': { open: SETTING + ' (one form link per view; public-forms)' },
  'PATCH /webhooks/:id': { open: SETTING + ' (webhooks)' },
  'POST /webhooks/:id/secret': { open: SETTING + ' (webhooks)' },
  'POST /webhooks/:id/test': { open: 'sends a test delivery; stores nothing in the workspace (webhooks)' },
  'POST /webhooks/:id/deliveries/:deliveryId/resend': { open: 'sends a delivery again; the delivery log is retention-bound (webhooks)' },
  'POST /pages/:id/button-webhook': { open: 'sends a request; stores nothing in the workspace (automations-webhooks)' },
  'PUT /workspaces/:id/slack': { open: SETTING + ' (slack)' },
  'POST /workspaces/:id/slack/test': { open: 'sends a test message (slack)' },
  'POST /slack/link/preview': { open: READS + ' (slack)' },
  'POST /slack/link/confirm': { open: SETTING + ' (one link per person; slack)' },
  'POST /slack/w/:workspaceId/commands': { open: 'Slack calls; a command that writes goes through the checked routes (slack)' },
  'POST /slack/w/:workspaceId/events': { open: 'Slack calls; nothing is stored (slack)' },
  'POST /pages/:id/publish/notion': { open: 'sends the page to Notion; stores nothing here (notion)' },
  'POST /workspaces/:id/agents/blocks': { open: SETTING + ' (one block per agent connection)' },
  'POST /workspaces/:id/agent-connections/release': { open: SHRINKS },
  'POST /connections/release': { open: SHRINKS },
  'POST /pages/:id/claims': { open: 'a short-lived section claim (one per section and connection), dropped when it expires' },
  // --- open: makes room, or restores what is counted already ---
  'POST /pages/:id/restore': { open: SHRINKS + ' (a trashed page is counted until it is purged)' },
  'POST /workspaces/:id/restore': { open: SHRINKS + ' (a deleted workspace is counted until it is gone)' },
  'POST /suggestions/:id/reject': { open: SHRINKS },
  'POST /suggestions/:id/withdraw': { open: SHRINKS },
  'POST /workspaces/:id/shared/unpublish': { open: SHRINKS },
  'POST /workspaces/:id/guests/remove': { open: SHRINKS },
  // --- open: membership ---
  'POST /workspaces': { open: 'a new, empty workspace of its own (LIMIT_WORKSPACES and LIMIT_WORKSPACES_TOTAL apply)' },
  'POST /workspaces/:id/members': { open: MEMBERS + ' (LIMIT_MEMBERS applies)' },
  'POST /workspaces/join': { open: MEMBERS + ' (LIMIT_MEMBERS applies)' },
  'PATCH /workspaces/:id/members/:userId': { open: MEMBERS },
  'POST /workspaces/:id/transfer': { open: MEMBERS },
  'POST /workspaces/:id/invite/regenerate': { open: MEMBERS + ' (replaces the one invite code)' },
  'POST /page-invites/:token/accept': { open: MEMBERS + ' (a page grant for the person; people are bounded)' },
  // --- open: reads ---
  'POST /workspaces/:id/query': { open: READS },
  'POST /workspaces/:id/charts/aggregate': { open: READS },
  'POST /workspaces/:id/sync/read': { open: READS },
  'POST /pages/:id/view': { open: PERSON + ' (the last time they opened a page)' },
  // --- open: the person ---
  'POST /pages/:id/bookmark': { open: PERSON },
  'PUT /pages/:id/subscription': { open: PERSON },
  'PUT /workspaces/:id/notification-level': { open: PERSON },
  'PUT /threads/:id/follow': { open: PERSON },
  'POST /threads/:id/read': { open: PERSON },
  'POST /inbox/ack': { open: PERSON },
  'POST /notifications/read': { open: PERSON },
  'POST /later': { open: PERSON },
  'PATCH /later/:id': { open: PERSON },
  'PATCH /me/notification-settings': { open: PERSON },
  'PATCH /me/onboarding': { open: PERSON },
  'POST /me/workspace-groups': { open: PERSON },
  'PATCH /me/workspace-groups/:id': { open: PERSON },
  'POST /me/workspace-groups/:id/archive': { open: PERSON },
  'PUT /me/workspace-groups/order': { open: PERSON },
  'PUT /me/workspace-order': { open: PERSON },
  'PATCH /me/workspaces/:id/listing': { open: PERSON },
  'PUT /me/sidebar': { open: PERSON },
  'PUT /me/status': { open: PERSON },
  'POST /me/ical': { open: PERSON },
  'PATCH /auth/me/locale': { open: PERSON },
  'POST /auth/register': { open: PERSON + ' (sign-up: the limits of accounts and workspaces apply, signup hooks)' },
  'POST /auth/login': { open: PERSON },
  'POST /auth/login/totp': { open: PERSON },
  'POST /auth/logout': { open: PERSON },
  'POST /auth/change-password': { open: PERSON },
  'POST /auth/forgot-password': { open: PERSON },
  'POST /auth/reset-password': { open: PERSON },
  'POST /auth/verify-email': { open: PERSON },
  'POST /auth/verify-email/send': { open: PERSON },
  'POST /auth/2fa/setup': { open: PERSON },
  'POST /auth/2fa/enable': { open: PERSON },
  'POST /auth/2fa/disable': { open: PERSON },
  'POST /auth/2fa/recovery-codes': { open: PERSON },
  'POST /auth/oidc/link': { open: PERSON },
  'POST /tokens': { open: PERSON },
  'PATCH /tokens/:id': { open: PERSON },
  'POST /agent-tokens': { open: PERSON },
  'PATCH /oauth/grants/:id': { open: PERSON },
  'POST /oauth/authorize': { open: PERSON },
  'POST /oauth/token': { open: PERSON },
  'POST /oauth/register': { open: 'an OAuth client, not workspace storage (bounded by the OAuth client settings and the instance fuse)' },
  'POST /push/subscriptions': { open: PERSON },
  'PATCH /push/settings': { open: PERSON },
  'POST /push/test': { open: PERSON },
  'POST /legal/consent': { open: PERSON + ' (consent, which must work on a full server)' },
  'PUT /plugins/:id/storage/:key': { open: PERSON + ' (a plugin’s own key-value store; experimental plugins)' },
  'POST /public/:token/unlock': { open: 'a visitor unlocks a public link; nothing is stored' },
  'POST /mcp': { open: 'the MCP endpoint: its tools call the REST routes above, which check' },
  // --- open: server admin ---
  'PATCH /admin/users/:id': { open: ADMIN },
  'PATCH /admin/users/:id/expiry': { open: ADMIN },
  'POST /admin/users/:id/temp-password': { open: ADMIN },
  'POST /admin/users/:id/reset-code': { open: ADMIN },
  'POST /admin/users/:id/send-credential': { open: ADMIN },
  'POST /admin/users/:id/send-verification': { open: ADMIN },
  'POST /admin/users/:id/verify': { open: ADMIN },
  'POST /admin/reset-requests/:id/dismiss': { open: ADMIN },
  'POST /admin/signup-keys': { open: ADMIN },
  'POST /admin/signup-keys/:key/send-invite': { open: ADMIN },
  'POST /admin/ip-bans': { open: ADMIN },
  'POST /admin/backups/run': { open: ADMIN },
  'POST /admin/plugins/:id/approve': { open: ADMIN },
  'POST /admin/plugins/:id/disable': { open: ADMIN },
}

function sources(dir = SRC, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !/TestKit|testHarness|Fixture|fixture/.test(p)) out.push(p)
  }
  return out
}

/** Every POST/PUT/PATCH route in the source, with the text of its handler (up to the next route). */
function writeRoutes(): Map<string, { file: string; text: string }> {
  const found = new Map<string, { file: string; text: string }>()
  for (const file of sources()) {
    const src = readFileSync(file, 'utf8')
    const rel = path.relative(SRC, file).split(path.sep).join('/')
    const starts: { i: number; key: string | null }[] = []
    const re = /\b(?:app|api|s|inner|root|scope)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(['`])([^'`]+)\2/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const method = m[1].toUpperCase()
      starts.push({ i: m.index, key: ['POST', 'PUT', 'PATCH'].includes(method) ? `${method} ${m[3]}` : null })
    }
    assert.doesNotMatch(src, /\.route\(\s*\{[^}]*method:\s*\[?\s*'(POST|PUT|PATCH)'/, `${rel}: a route declared with .route(); list it by hand`)
    starts.forEach((s, n) => {
      if (!s.key) return
      assert.ok(!found.has(s.key), `${s.key} declared twice`)
      found.set(s.key, { file: rel, text: src.slice(s.i, starts[n + 1]?.i ?? src.length) })
    })
  }
  return found
}

describe('read-only workspaces refuse every write that grows them (docs/adr/2533-*)', () => {
  const found = writeRoutes()

  it('every POST, PUT and PATCH route is in the table', () => {
    assert.ok(found.size > 150, `${found.size} write routes found`)
    const missing = [...found.keys()].filter((k) => !(k in ROUTES))
    assert.deepEqual(missing, [], `new write routes: add a storage check (quota/room.ts) or an open reason to quota/writeSweep.test.ts`)
    const stale = Object.keys(ROUTES).filter((k) => !found.has(k))
    assert.deepEqual(stale, [], 'listed but no longer found')
  })

  it('a checked route calls a storage check in its handler, or in the helper it names', () => {
    for (const [key, entry] of Object.entries(ROUTES)) {
      const r = found.get(key)
      if (!r) continue
      if (entry === 'check') assert.match(r.text, CHECK, `${key} (${r.file}) is listed as checked but its handler calls no storage check`)
      else if ('via' in entry) assert.match(readFileSync(path.join(SRC, entry.via), 'utf8'), CHECK, `${key}: ${entry.via} calls no storage check`)
      else assert.ok(entry.open.length > 10, `${key}: say why it stays open`)
    }
  })
})
