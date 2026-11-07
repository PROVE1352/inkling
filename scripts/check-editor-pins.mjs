#!/usr/bin/env node
// Verifies the editor dependency pins described in CONTRIBUTING.md and docs/adr/0882-*:
//   1. every @blocknote/* dependency in apps/*/package.json is an exact version, all the same;
//   2. pnpm-lock.yaml resolves exactly that one version for every @blocknote/* package;
//   3. the BlockNote patch in pnpm-workspace.yaml is keyed to that version (otherwise pnpm
//      silently stops applying it after a bump);
//   4. prosemirror-view resolves to exactly one version, the one in the workspace override.
// No dependencies: the lockfile is scanned line by line, not parsed as YAML.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

// 1. package.json specifiers
const specs = new Map() // name -> Set(spec)
for (const group of ['apps', 'packages']) {
  for (const dir of readdirSync(path.join(root, group))) {
    const file = path.join(root, group, dir, 'package.json')
    if (!existsSync(file)) continue
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      for (const [name, spec] of Object.entries(deps ?? {})) {
        if (!name.startsWith('@blocknote/')) continue
        if (!/^\d+\.\d+\.\d+$/.test(spec)) errors.push(`${group}/${dir}: ${name} must be an exact version, got "${spec}"`)
        if (!specs.has(name)) specs.set(name, new Set())
        specs.get(name).add(spec)
      }
    }
  }
}
const declared = new Set([...specs.values()].flatMap((s) => [...s]))
if (declared.size !== 1) errors.push(`@blocknote/* packages must share one version, found: ${[...declared].join(', ') || 'none'}`)
const blocknote = [...declared][0]

// 2 + 4. lockfile `packages:` section keys look like `  '@blocknote/core@0.51.4':` / `  prosemirror-view@1.42.4:`
const lock = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
const pkgSection = lock.slice(lock.indexOf('\npackages:\n'), lock.indexOf('\nsnapshots:\n'))
const resolved = new Map() // name -> Set(version)
for (const m of pkgSection.matchAll(/^ {2}'?((?:@blocknote\/[\w.-]+)|prosemirror-view)@(\d[^':(]*)'?:$/gm)) {
  if (!resolved.has(m[1])) resolved.set(m[1], new Set())
  resolved.get(m[1]).add(m[2])
}
for (const name of specs.keys()) {
  const got = [...(resolved.get(name) ?? [])]
  if (got.length !== 1 || got[0] !== blocknote) errors.push(`lockfile resolves ${name} to [${got.join(', ')}], expected exactly ${blocknote}`)
}
for (const [name, versions] of resolved) {
  if (name.startsWith('@blocknote/') && !specs.has(name) && (versions.size !== 1 || !versions.has(blocknote)))
    errors.push(`transitive ${name} resolves to [${[...versions].join(', ')}], expected ${blocknote}`)
}

// 3. patch key + override in pnpm-workspace.yaml
const ws = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
const patchKeys = [...ws.matchAll(/^\s+"?(@blocknote\/[\w.-]+)@([^":]+)"?:\s*patches\//gm)]
for (const [, name, version] of patchKeys) {
  if (version !== blocknote) errors.push(`patchedDependencies key ${name}@${version} does not match BlockNote ${blocknote}; the patch would no longer apply`)
}
const override = ws.match(/^\s+prosemirror-view:\s*"?([^"\s]+)"?/m)?.[1]
const pmv = [...(resolved.get('prosemirror-view') ?? [])]
if (!override) errors.push('pnpm-workspace.yaml has no prosemirror-view override')
else if (pmv.length !== 1 || pmv[0] !== override) errors.push(`lockfile resolves prosemirror-view to [${pmv.join(', ')}], expected exactly ${override}`)

if (errors.length) {
  console.error('[check-editor-pins] FAILED')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(
  `[check-editor-pins] ok: @blocknote/* ${blocknote} (${specs.size} direct, ${patchKeys.length} patch), prosemirror-view ${override}`,
)
