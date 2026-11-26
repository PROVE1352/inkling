// Every insert into workspace_members says whether it is the person's own step (docs/adr/2580-*).
// A membership someone else made (a direct add) is written with agentsPending: true, so connections whose
// range is "all" leave that workspace out until the person includes it; every path the person takes
// themselves leaves the default (false). A new insert site fails here until it is classified below, and
// only routes/agentInclusion.ts (the person, signed in) may clear the flag.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))

function sources(dir = SRC, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !/TestKit|testHarness|Fixture|fixture/.test(p)) out.push(p)
  }
  return out
}

/** `file` → the inserts into workspace_members it holds, in source order: whose step each one is. */
const SITES: Record<string, { by: ('self' | 'other')[]; why: string }> = {
  'routes/workspaces.ts': { by: ['self', 'self', 'other'], why: 'create (the creator), join with an invite code, direct add by a member' },
  'routes/auth.ts': { by: ['self'], why: 'the sign-up workspace' },
  'routes/oidc.ts': { by: ['self'], why: "a new OIDC account's first workspace" },
  'account/trial.ts': { by: ['self'], why: "the trial account's only workspace" },
}

const INSERT_RE = /\.insert\(\s*(?:schema\.)?workspaceMembers\s*\)/g

describe('who made a membership (docs/adr/2580-*)', () => {
  it('every insert into workspace_members is classified, and only "other" ones wait for the person', () => {
    const found = new Map<string, string[]>()
    for (const file of sources()) {
      const src = readFileSync(file, 'utf8')
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      const kinds: string[] = []
      for (const m of src.matchAll(INSERT_RE)) {
        // the values() of this insert: up to the end of the statement (the next blank line or `)\n\n`)
        const tail = src.slice(m.index!, m.index! + 400)
        const values = tail.slice(0, tail.search(/\n\s*\n|\n\s*(?:return|await|const|if)\b/) + 1 || tail.length)
        kinds.push(/agentsPending:\s*true/.test(values) ? 'other' : /agentsPending/.test(values) ? 'explicit-false' : 'self')
      }
      if (kinds.length) found.set(rel, kinds)
    }
    for (const [rel, kinds] of found) {
      const site = SITES[rel]
      assert.ok(site, `${rel}: a new insert into workspace_members; classify it here and in ADR 2580 (whose step is it?)`)
      assert.deepEqual(kinds, site.by, `${rel}: ${kinds.join(', ')} found, ${site.by.join(', ')} listed`)
    }
    for (const rel of Object.keys(SITES)) assert.ok(found.has(rel), `${rel}: listed but no longer inserts`)
  })

  it('the direct add records who added the person', () => {
    const src = readFileSync(path.join(SRC, 'routes/workspaces.ts'), 'utf8')
    assert.match(src, /agentsPending: true, addedBy: user\.id/)
  })

  it('only the session route clears the flag', () => {
    for (const file of sources()) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      if (rel === 'routes/agentInclusion.ts' || rel === 'db/schema.ts') continue
      const src = readFileSync(file, 'utf8')
      assert.doesNotMatch(src, /agents_pending\s*=\s*false|agentsPending:\s*false/, `${rel} clears agents_pending`)
    }
  })
})
