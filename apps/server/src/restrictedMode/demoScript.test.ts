// deploy/demo/demo.sh and the demo overlay (0.22 security fix F7, contract §14, docs/adr/2538-*).
// The review found that with COMPOSE_PROJECT_NAME=inkling INKLING_DATA_NAME=inkling in the shell, the
// documented demo command resolved to production's project, volumes and database (and its `down -v`
// would delete production's volumes). These tests run the script against copies of the compose files
// with `docker compose config` only: a `docker` stand-in first in PATH passes `config` through to the
// real Docker and records (never runs) every other command. Skipped without Docker Compose or python3.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const realDocker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim()
const usable =
  !!realDocker &&
  spawnSync(realDocker, ['compose', 'version'], { encoding: 'utf8' }).status === 0 &&
  spawnSync('python3', ['--version']).status === 0 &&
  spawnSync('bash', ['--version']).status === 0

describe('deploy/demo/demo.sh', { skip: !usable && 'needs docker compose, python3 and bash' }, () => {
  let root = ''
  let shim = ''
  const calls = () => (existsSync(path.join(shim, 'calls.log')) ? readFileSync(path.join(shim, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [])
  // 0.22.1: the volumes are folders under DEMO_VOLUME_ROOT (a temporary folder here)
  const fixtureEnv = () =>
    readFileSync(path.join(repo, 'deploy/demo/demo.env.example'), 'utf8')
      .replaceAll('CHANGE-ME-openssl-rand-base64-32', 'fixture-not-a-secret-0123456789abcdef')
      .replace(/^DEMO_VOLUME_ROOT=.*$/m, `DEMO_VOLUME_ROOT=${path.join(root, 'vol')}`)
  const writeEnv = (text: string, name = 'deploy/demo/demo.env') => writeFileSync(path.join(root, name), text)
  /** Run the copied script with a clean shell plus `env`; stdin = `input`. */
  const run = (args: string[], env: Record<string, string> = {}, input = '') => {
    const r = spawnSync('bash', [path.join(root, 'deploy/demo/demo.sh'), ...args], {
      cwd: root,
      env: { PATH: `${shim}:${process.env.PATH}`, HOME: process.env.HOME ?? root, ...env },
      input,
      encoding: 'utf8',
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const prodShell = { COMPOSE_PROJECT_NAME: 'inkling', INKLING_DATA_NAME: 'inkling' }

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'inkling-demo-sh-'))
    mkdirSync(path.join(root, 'deploy'), { recursive: true })
    cpSync(path.join(repo, 'compose.yaml'), path.join(root, 'compose.yaml'))
    cpSync(path.join(repo, 'deploy/demo'), path.join(root, 'deploy/demo'), { recursive: true })
    cpSync(path.join(repo, 'deploy/backup'), path.join(root, 'deploy/backup'), { recursive: true })
    shim = path.join(root, 'bin')
    mkdirSync(shim)
    mkdirSync(path.join(root, 'vol'))
    const docker = path.join(shim, 'docker')
    writeFileSync(
      docker,
      `#!/bin/bash\nfor a in "$@"; do if [ "$a" = config ] || [ "$a" = info ]; then exec ${JSON.stringify(realDocker)} "$@"; fi; done\necho "$*" >> "$(dirname "$0")/calls.log"\n`,
    )
    chmodSync(docker, 0o755)
  })
  after(() => rmSync(root, { recursive: true, force: true }))
  beforeEach(() => {
    rmSync(path.join(shim, 'calls.log'), { force: true })
    cpSync(path.join(repo, 'deploy/demo/compose.demo.yaml'), path.join(root, 'deploy/demo/compose.demo.yaml'))
    writeEnv(fixtureEnv())
    rmSync(path.join(root, '.env'), { force: true })
  })

  it('the review\'s command in a production shell no longer resolves to production\'s project, volumes or database', () => {
    const r = spawnSync(
      realDocker,
      ['compose', '--env-file', 'deploy/demo/demo.env', '-f', 'compose.yaml', '-f', 'deploy/demo/compose.demo.yaml', 'config', '--format', 'json'],
      { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME ?? root, ...prodShell }, encoding: 'utf8' },
    )
    if (r.status === 0) {
      const c = JSON.parse(r.stdout) as { volumes: Record<string, { name: string }>; services: { db: { environment: Record<string, string> } } }
      for (const v of Object.values(c.volumes)) assert.ok(v.name.startsWith('inkling-demo_'), v.name)
      assert.equal(c.services.db.environment.POSTGRES_DB, 'inkling_demo')
    } else {
      // plain compose with the overlay stops: only demo.sh may run it
      assert.match(r.stderr, /DEMO_VIA_SCRIPT|demo\.sh/)
    }
  })

  it('a production shell (COMPOSE_PROJECT_NAME, COMPOSE_FILE or INKLING_DATA_NAME set): every command stops before Docker', () => {
    const shells: Record<string, string>[] = [{ COMPOSE_PROJECT_NAME: 'inkling' }, { INKLING_DATA_NAME: 'inkling' }, { COMPOSE_FILE: 'compose.yaml' }, prodShell]
    for (const env of shells) {
      for (const cmd of [['config'], ['up'], ['down'], ['destroy'], ['ps']]) {
        const r = run(cmd, env, 'inkling-demo\n')
        assert.equal(r.code, 2, `${JSON.stringify(env)} ${cmd}: ${r.out}${r.err}`)
        assert.match(r.err, /names the production instance/)
      }
    }
    assert.deepEqual(calls(), [])
  })

  it('in a folder with production\'s .env and a shell full of production values, the demo still resolves to its own names and values', () => {
    writeFileSync(path.join(root, '.env'), 'INKLING_DATA_NAME=inkling\nPOSTGRES_PASSWORD=prod-password\nINKLING_PORT=127.0.0.1:3000\nAPP_SECRET_KEY=prod-secret\nPUBLIC_URL=https://notes.example.com\n')
    // DEMO_ALLOW_SHARED_DISK: the temporary volume folder is on the root filesystem (0.22.1, tested below)
    const shell = { PUBLIC_URL: 'https://notes.example.com', POSTGRES_PASSWORD: 'prod-password', APP_SECRET_KEY: 'prod-secret', LIMIT_FILE_MB: '25', DEMO_PORT: '3000', DEMO_ALLOW_SHARED_DISK: '1' }
    const c = run(['config'], shell)
    assert.equal(c.code, 0, c.out + c.err)
    assert.match(c.out, /info {4}public address 'https:\/\/demo\.example\.com'/)
    assert.doesNotMatch(c.out, /REFUSED/)
    const u = run(['up'], shell)
    assert.equal(u.code, 0, u.out + u.err)
    const [call, ...more] = calls()
    assert.deepEqual(more, [])
    assert.match(call, /^compose --project-directory \S+ -p inkling-demo --env-file \S+\/deploy\/demo\/demo\.env -f \S+\/compose\.yaml -f \S+\/deploy\/demo\/compose\.demo\.yaml up -d$/)
  })

  it('a clean shell: down keeps the volumes, destroy deletes them only after the project name is typed', () => {
    assert.equal(run(['config']).code, 0)
    assert.equal(run(['down']).code, 0)
    assert.equal(run(['down', '-v']).code, 2)
    assert.equal(run(['up', '--build']).code, 2)
    const wrong = run(['destroy'], {}, 'inkling\n')
    assert.equal(wrong.code, 3)
    assert.match(wrong.err, /nothing was deleted/)
    const none = run(['destroy'], {}, '')
    assert.equal(none.code, 3)
    assert.equal(run(['destroy'], {}, 'inkling-demo\n').code, 0)
    assert.deepEqual(
      calls().map((c) => c.replace(/^compose .* -f \S+compose\.demo\.yaml /, '')),
      ['down', 'down -v', 'image inspect inkling-demo:local', 'image rm inkling-demo:local'],
    )
    // read-only commands go to the demo project too
    assert.equal(run(['ps']).code, 0)
    assert.equal(run(['logs', '--tail', '5', 'app']).code, 0)
    assert.match(calls().slice(-2).join('\n'), /-p inkling-demo .* ps\n.*-p inkling-demo .* logs --tail 5 app$/)
  })

  it('refuses a configuration that is not the demo\'s: production\'s port, a volume or database named from a variable, production\'s .env as the env file', () => {
    for (const port of ['127.0.0.1:3000', '3000', '0.0.0.0:3000']) {
      writeEnv(fixtureEnv().replace('DEMO_PORT=127.0.0.1:3100', `DEMO_PORT=${port}`))
      const r = run(['config'])
      assert.equal(r.code, 3, port + r.out)
      assert.match(r.out, /REFUSED service app publishes .*3000/)
      assert.equal(run(['up']).code, 3)
      assert.equal(run(['down']).code, 3)
    }
    writeEnv(fixtureEnv())
    // an overlay edited to take a name from the shared variable again
    const overlay = path.join(root, 'deploy/demo/compose.demo.yaml')
    writeFileSync(overlay, readFileSync(overlay, 'utf8').replace('name: inkling-demo_db', 'name: inkling_${INKLING_DATA_NAME}-db'))
    const v = run(['up'])
    assert.equal(v.code, 3)
    assert.match(v.out, /REFUSED volume db = 'inkling_inkling_demo-db'/)
    writeFileSync(overlay, readFileSync(path.join(repo, 'deploy/demo/compose.demo.yaml'), 'utf8').replaceAll('POSTGRES_DB: inkling_demo', 'POSTGRES_DB: ${INKLING_DATA_NAME}'))
    writeEnv(fixtureEnv().replace('INKLING_DATA_NAME=inkling_demo', 'INKLING_DATA_NAME=inkling'))
    const d = run(['down'])
    assert.equal(d.code, 3)
    assert.match(d.out, /REFUSED database 'inkling'/)
    cpSync(path.join(repo, 'deploy/demo/compose.demo.yaml'), overlay)
    // production's .env given as the demo's env file: the demo-only variables are missing
    writeFileSync(path.join(root, '.env'), 'INKLING_DATA_NAME=inkling\nPOSTGRES_PASSWORD=prod-password\n')
    const p = run(['--env-file', '.env', 'up'])
    assert.equal(p.code, 3, p.out + p.err)
    assert.deepEqual(calls(), [])
  })

  it('up refuses an env file whose secrets are still CHANGE-ME (config only reports)', () => {
    writeEnv(readFileSync(path.join(repo, 'deploy/demo/demo.env.example'), 'utf8'))
    const c = run(['config'])
    assert.equal(c.code, 0, c.out + c.err)
    const u = run(['up'])
    assert.equal(u.code, 3)
    assert.match(u.out, /REFUSED secrets filled in/)
    assert.deepEqual(calls(), [])
  })

  // --- 0.22.1 (contract §15, review N8, docs/adr/2546-*) ---------------------------------------------------

  it('N8: the demo runs its own image name; production\'s tag is not the demo\'s, and a production name is refused', () => {
    const cfg = (args: string[]) =>
      spawnSync(realDocker, ['compose', ...args, 'config', '--format', 'json'], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: process.env.HOME ?? root, DEMO_VIA_SCRIPT: '1' },
        encoding: 'utf8',
      })
    const demo = cfg(['-p', 'inkling-demo', '--env-file', 'deploy/demo/demo.env', '-f', 'compose.yaml', '-f', 'deploy/demo/compose.demo.yaml'])
    assert.equal(demo.status, 0, demo.stderr)
    const app = (JSON.parse(demo.stdout) as { services: { app: { image: string; build?: unknown } } }).services.app
    assert.equal(app.image, 'inkling-demo:local', 'a demo build tags the demo name only')
    // production's compose (its own .env) still resolves to the published name
    writeFileSync(path.join(root, '.env'), 'INKLING_DATA_NAME=inkling\nPOSTGRES_PASSWORD=prod-password\n')
    const prod = cfg(['-p', 'inkling', '-f', 'compose.yaml'])
    assert.equal(prod.status, 0, prod.stderr)
    assert.match((JSON.parse(prod.stdout) as { services: { app: { image: string } } }).services.app.image, /^ghcr\.io\/prove1352\/inkling:/)
    for (const image of ['ghcr.io/prove1352/inkling:latest', 'ghcr.io/prove1352/inkling:0.22.1', 'inkling:local']) {
      writeEnv(fixtureEnv().replace('DEMO_IMAGE=inkling-demo:local', `DEMO_IMAGE=${image}`))
      const r = run(['config'])
      assert.equal(r.code, 3, image + r.out)
      assert.match(r.out, /REFUSED app image/)
      assert.equal(run(['up'], { DEMO_ALLOW_SHARED_DISK: '1' }).code, 3)
      assert.equal(run(['build']).code, 3)
    }
    writeEnv(fixtureEnv().replace(/^DEMO_IMAGE=.*\n/m, ''))
    assert.equal(run(['config']).code, 3, 'no DEMO_IMAGE: compose stops')
    writeEnv(fixtureEnv())
    assert.equal(run(['build']).code, 0)
    assert.deepEqual(calls().map((c) => c.replace(/^compose .* -f \S+compose\.demo\.yaml /, '')), ['build app'])
  })

  it('N8: every volume is a folder under one absolute DEMO_VOLUME_ROOT; up refuses a relative, missing or root-filesystem path', () => {
    const c = run(['config'])
    assert.equal(c.code, 0, c.out + c.err)
    for (const v of ['db', 'data', 'backups', 'backup-ctl']) assert.match(c.out, new RegExp(`ok {6}volume ${v} is the folder '${path.join(root, 'vol', v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    // relative (compose would put it under the checkout), the root itself, missing
    writeEnv(fixtureEnv().replace(/^DEMO_VOLUME_ROOT=.*$/m, 'DEMO_VOLUME_ROOT=demo-data'))
    const rel = run(['up'], { DEMO_ALLOW_SHARED_DISK: '1' })
    assert.equal(rel.code, 3)
    assert.match(rel.out, /REFUSED DEMO_VOLUME_ROOT is written as an absolute path/)
    writeEnv(fixtureEnv().replace(/^DEMO_VOLUME_ROOT=.*$/m, 'DEMO_VOLUME_ROOT=/'))
    assert.equal(run(['up'], { DEMO_ALLOW_SHARED_DISK: '1' }).code, 3)
    writeEnv(fixtureEnv().replace(/^DEMO_VOLUME_ROOT=.*$/m, `DEMO_VOLUME_ROOT=${path.join(root, 'not-mounted')}`))
    const missing = run(['up'], { DEMO_ALLOW_SHARED_DISK: '1' })
    assert.equal(missing.code, 3)
    assert.match(missing.out, /REFUSED DEMO_VOLUME_ROOT \S+ exists/)
    assert.equal(existsSync(path.join(root, 'not-mounted')), false, 'nothing made before the checks pass')
    writeEnv(fixtureEnv().replace(/^DEMO_VOLUME_ROOT=.*$/m, ''))
    assert.equal(run(['config']).code, 3, 'no DEMO_VOLUME_ROOT: compose stops')
    assert.deepEqual(calls(), [])
  })

  it('N8: up refuses a DEMO_VOLUME_ROOT on the root filesystem; DEMO_ALLOW_SHARED_DISK=1 goes on with a warning and makes the four folders', () => {
    // a folder on the same filesystem as /: the temporary folder when it is there, else /usr (never written: refused first)
    const sameAsRoot = statSync(root).dev === statSync('/').dev
    const onRoot = sameAsRoot ? path.join(root, 'vol') : '/usr'
    writeEnv(fixtureEnv().replace(/^DEMO_VOLUME_ROOT=.*$/m, `DEMO_VOLUME_ROOT=${onRoot}`))
    const r = run(['up'])
    assert.equal(r.code, 3, r.out + r.err)
    assert.match(r.out, /REFUSED DEMO_VOLUME_ROOT \S+ is on the same filesystem as the root filesystem/)
    assert.deepEqual(calls(), [])
    for (const bad of ['yes', 'true', '2']) assert.equal(run(['up'], { DEMO_ALLOW_SHARED_DISK: bad }).code, 2, bad)
    if (sameAsRoot) {
      const ok = run(['up'], { DEMO_ALLOW_SHARED_DISK: '1' })
      assert.equal(ok.code, 0, ok.out + ok.err)
      assert.match(ok.out, /WARNING DEMO_VOLUME_ROOT \S+ is on the same filesystem as the root filesystem/)
      for (const v of ['db', 'data', 'backups', 'backup-ctl']) assert.ok(statSync(path.join(root, 'vol', v)).isDirectory(), v)
      assert.match(calls().join('\n'), /-p inkling-demo .* up -d$/)
    }
  })

  it('N8: a DEMO_VOLUME_ROOT on a filesystem of its own passes without the override', (t) => {
    // a writable folder on another filesystem than / (Linux: /dev/shm is tmpfs); none on this machine → skipped
    const rootDev = statSync('/').dev
    const candidates = ['/dev/shm', process.env.XDG_RUNTIME_DIR ?? '', tmpdir()].filter(Boolean)
    let other = ''
    for (const c of candidates) {
      try {
        if (statSync(c).dev === rootDev) continue
        other = mkdtempSync(path.join(c, 'inkling-demo-vol-'))
        break
      } catch {
        // not there or not writable
      }
    }
    if (!other) return t.skip('no writable folder on a filesystem other than / on this machine')
    try {
      writeEnv(fixtureEnv().replace(/^DEMO_VOLUME_ROOT=.*$/m, `DEMO_VOLUME_ROOT=${other}`))
      const r = run(['up'])
      assert.equal(r.code, 0, r.out + r.err)
      assert.match(r.out, /ok {6}DEMO_VOLUME_ROOT is a filesystem of its own/)
      assert.doesNotMatch(r.out, /WARNING/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('N8: destroy names the image it removes and leaves the bound folders to the operator', () => {
    const d = run(['destroy'], {}, 'inkling-demo\n')
    assert.equal(d.code, 0, d.out + d.err)
    assert.match(d.out, /deletes its volumes .* and its image inkling-demo:local/)
    assert.match(d.out, /the demo's files are still in \S+\/vol\/\{db,data,backups,backup-ctl\}; delete them yourself/)
    assert.ok(existsSync(path.join(root, 'vol')), 'the script never deletes host folders')
  })
})
