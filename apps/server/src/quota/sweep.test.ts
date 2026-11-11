// Every place that inserts pages, files, members or workspaces is in the table of ADR 2505 and runs a
// limit check (docs/adr/2505-*). A new insert site fails this test until it is added to the table
// below with how it is checked.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DISABLED_FEATURE_NAMES } from '@inkling/shared'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir = SRC, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !/TestKit|testHarness|Fixture|fixture/.test(p)) out.push(p)
  }
  return out
}

/** `file:table` → how many inserts there are and how the site is checked. */
const SITES: Record<string, { n: number; check: 'room' | 'user' | 'exempt'; why: string }> = {
  // pages
  'routes/pages.ts:pages': { n: 3, check: 'room', why: 'create, duplicate (whole subtree), expand to canvas' },
  'rowTemplates.ts:pages': { n: 1, check: 'room', why: 'createRow: REST rows, MCP create_row, public form answers' },
  'routes/collectionsExt.ts:pages': { n: 1, check: 'room', why: 'row batch, all rows or none' },
  'md/importer.ts:pages': { n: 2, check: 'room', why: 'single .md, folder/zip (all pages or none)' },
  'md/notionImport.ts:pages': { n: 1, check: 'room', why: 'all pages or none, archive bytes reserved' },
  'templates/structure.ts:pages': { n: 1, check: 'room', why: 'instantiateTree: templates, onboarding sample, MCP create_from_template' },
  'routes/clip.ts:pages': { n: 1, check: 'room', why: 'web clipper' },
  'routes/splitPage.ts:pages': { n: 1, check: 'room', why: 'insertChildren: split, rotation' },
  'routes/sync.ts:pages': { n: 1, check: 'room', why: 'vault sync (experimental)' },
  'routes/sheetSync.ts:pages': { n: 1, check: 'room', why: 'sheets sync (experimental), all new rows or none' },
  'routes/tasks.ts:pages': { n: 1, check: 'room', why: 'the workspace to-do document' },
  // files
  'routes/files.ts:files': { n: 1, check: 'room', why: 'upload in a transaction, bytes reserved' },
  'md/importer.ts:files': { n: 1, check: 'room', why: 'checked before the first write and in the page transaction; removed if it fails' },
  'md/notionImport.ts:files': { n: 1, check: 'room', why: 'archive bytes reserved in the page transaction' },
  // members and workspaces
  'routes/workspaces.ts:workspaceMembers': { n: 3, check: 'room', why: 'create (owner), join, direct add' },
  'routes/workspaces.ts:workspaces': { n: 1, check: 'user', why: 'create' },
  'routes/auth.ts:workspaceMembers': { n: 1, check: 'exempt', why: 'the sign-up workspace: one is always allowed' },
  'routes/auth.ts:workspaces': { n: 1, check: 'exempt', why: 'the sign-up workspace' },
  'routes/oidc.ts:workspaceMembers': { n: 1, check: 'exempt', why: 'a new OIDC account: its first workspace' },
  'routes/oidc.ts:workspaces': { n: 1, check: 'exempt', why: 'a new OIDC account: its first workspace' },
}

describe('limits on every creating path (docs/adr/2505-*)', () => {
  it('every insert into pages, files, workspace_members and workspaces is listed and checked', () => {
    const found = new Map<string, number>()
    for (const file of sources()) {
      const src = readFileSync(file, 'utf8')
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      for (const table of ['pages', 'files', 'workspaceMembers', 'workspaces']) {
        const re = new RegExp(String.raw`\.insert\(\s*(?:schema\.)?${table}\s*\)`, 'g')
        const n = (src.match(re) ?? []).length
        if (n) found.set(`${rel}:${table}`, n)
      }
      assert.doesNotMatch(src, /INSERT\s+INTO\s+(?:"?pages"?|"?files"?|workspace_members|"?workspaces"?)\s*\(/i, `${rel}: raw SQL insert`)
    }
    for (const [key, n] of found) {
      const site = SITES[key]
      assert.ok(site, `${key}: a new insert site; add a limit check and list it in quota/sweep.test.ts and ADR 2505`)
      assert.equal(n, site.n, `${key}: ${n} inserts, ${site.n} listed`)
    }
    for (const key of Object.keys(SITES)) assert.ok(found.has(key), `${key}: listed but no longer found`)
  })

  it('every listed site that inserts pages or files calls assertWorkspaceRoom before each insert', () => {
    for (const [key, site] of Object.entries(SITES)) {
      if (site.check === 'exempt') continue
      const [rel, table] = key.split(':')
      const src = readFileSync(path.join(SRC, rel), 'utf8')
      const lines = src.split('\n')
      const fn = site.check === 'user' ? 'assertUserRoom' : 'assertWorkspaceRoom'
      lines.forEach((line, i) => {
        if (!new RegExp(String.raw`\.insert\(\s*${table}\s*\)`).test(line)) return
        // the check sits in the same function, at most 60 lines above (the batch sites check once before the loop)
        const above = lines.slice(Math.max(0, i - 60), i + 1).join('\n')
        const ok = above.includes(fn) || (table === 'workspaceMembers' && /assertUserRoom|assertWorkspaceRoom/.test(above))
        assert.ok(ok, `${rel}:${i + 1} inserts into ${table} without ${fn} above it`)
      })
    }
  })

  it('the feature table names only known features', async () => {
    const { FEATURE_ROUTES } = await import('./features')
    assert.deepEqual(Object.keys(FEATURE_ROUTES).sort(), [...DISABLED_FEATURE_NAMES].sort())
    for (const routes of Object.values(FEATURE_ROUTES)) {
      for (const r of routes) assert.match(r, /^(GET|POST|PUT|PATCH|DELETE) \/api\//)
    }
  })
})
