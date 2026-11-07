#!/usr/bin/env node
// Runs every `*.test.ts` under the current package's `src/` with node:test through tsx.
//
//   node ../../scripts/run-tests.mjs          unit run; [db] suites skip themselves without DATABASE_URL
//   node ../../scripts/run-tests.mjs --db     same files, but DATABASE_URL is required (fail fast)
//   node ../../scripts/run-tests.mjs --test-name-pattern=merge3        other args go to node --test
//
// Why a script instead of a glob in package.json: npm/pnpm scripts run under `sh`, where `**` is not
// recursive, so `src/**/*.test.ts` silently misses top-level and deeper files. Node's own
// `--test` glob expansion would work on Node 22, but an empty match is not an error there, and a
// package whose tests all disappeared must fail CI (docs/adr/0880-*).
//
// tsx is resolved from the package first and then from apps/server: apps/web has no tsx
// devDependency (the web tests are plain Node tests that borrow the server's tsx). Test files still
// resolve their imports relative to their own location, so web tests see apps/web/node_modules.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = process.cwd()
const pkgName = readPkgName(pkgDir)

// `--db` is ours; everything else (with or without a `--` separator, which pnpm may or may not
// forward) goes to `node --test`.
const argv = process.argv.slice(2)
const dbMode = argv.includes('--db')
const passThrough = argv.filter((a) => a !== '--db' && a !== '--')

if (dbMode && !process.env.DATABASE_URL) {
  console.error(
    `[run-tests] ${pkgName}: --db needs DATABASE_URL (a migrated scratch database). ` +
      'Without it the [db] suites would skip and the run would look green.',
  )
  process.exit(2)
}

const srcDir = path.join(pkgDir, 'src')
const files = existsSync(srcDir)
  ? readdirSync(srcDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => !f.split(path.sep).some((seg) => seg === 'node_modules' || seg === 'dist'))
      .map((f) => path.join('src', f))
      .sort()
  : []

if (files.length === 0) {
  console.error(`[run-tests] ${pkgName}: no *.test.ts files under src/ — refusing to report success.`)
  process.exit(1)
}

const tsxCli = resolveTsxCli([pkgDir, path.join(repoRoot, 'apps/server')])
if (!tsxCli) {
  console.error('[run-tests] tsx not found (looked in this package and apps/server). Run `pnpm install`.')
  process.exit(1)
}

console.log(
  `[run-tests] ${pkgName}: ${files.length} file(s)${dbMode ? ' [db mode]' : ''}` +
    (!process.env.DATABASE_URL && files.some((f) => readFileSync(path.join(pkgDir, f), 'utf8').includes('[db]'))
      ? ' — DATABASE_URL unset, [db] suites skip'
      : ''),
)

const child = spawn(
  process.execPath,
  [tsxCli, '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', ...passThrough, ...files],
  { cwd: pkgDir, stdio: 'inherit', env: process.env },
)
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))

function readPkgName(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name ?? dir
  } catch {
    return dir
  }
}

function resolveTsxCli(dirs) {
  for (const dir of dirs) {
    try {
      const req = createRequire(path.join(dir, 'package.json'))
      const pkgJson = req.resolve('tsx/package.json')
      const { bin } = JSON.parse(readFileSync(pkgJson, 'utf8'))
      const rel = typeof bin === 'string' ? bin : bin?.tsx
      if (rel) return path.join(path.dirname(pkgJson), rel)
    } catch {
      // not installed here, try the next candidate
    }
  }
  return null
}
