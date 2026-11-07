import { parseArgs } from './args'
import { cmdLogin } from './commands/login'
import { cmdLs } from './commands/ls'
import { cmdPull } from './commands/pull'
import { cmdPush } from './commands/push'
import { cmdStatus } from './commands/status'
import { cmdSync } from './commands/sync'
import { ApiError } from './http'

const VALUE_FLAGS = new Set([
  'server',
  'workspace',
  'vault',
  'subdir',
  'parent',
  'title',
  'email',
])

const USAGE = `inklingctl — command-line client for Inkling

Usage:
  inklingctl login  [--server <url>] [--email <email>]              log in (prompt / pipe / env vars)
                   also reads INKLING_EMAIL and INKLING_PASSWORD (non-interactive)
  inklingctl login  --token [--server <url>]                        save an API token instead (prompt, pipe
                   or INKLING_TOKEN); make one in Settings › Connections
  inklingctl ls                                                     list workspaces
  inklingctl pull   [--workspace <name|id>] [--vault <path>]
                   [--subdir <name>] [--dry-run]                   place a workspace in a vault (replaces its folder)
  inklingctl push   <file.md> [--parent <pageId>] [--title <title>]
                   [--workspace <name|id>]                         create a page from Markdown (with content, optional parent)
  inklingctl status                                                 server status + login status
  inklingctl sync   <vaultDir> [--workspace <name|id>] [--dry-run]  two-way vault sync (experimental:
                   server needs EXPERIMENTAL_FEATURES=vault-sync)

Config file: ~/.inkling.json (mode 0600)
INKLING_TOKEN=ink_pat_… overrides the saved login for one run (nothing is written).
`

async function run(): Promise<number> {
  const argv = process.argv.slice(2)
  const { command, flags, positionals } = parseArgs(argv, VALUE_FLAGS)

  if (flags['help'] === true || command === 'help' || command === undefined) {
    process.stdout.write(USAGE)
    return command === undefined ? 1 : 0
  }

  switch (command) {
    case 'login':
      await cmdLogin(flags)
      return 0
    case 'ls':
      await cmdLs()
      return 0
    case 'pull':
      await cmdPull(flags)
      return 0
    case 'push':
      await cmdPush(flags, positionals)
      return 0
    case 'status':
      await cmdStatus()
      return 0
    case 'sync':
      await cmdSync(flags, positionals)
      return 0
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`)
      process.stdout.write(USAGE)
      return 1
  }
}

run()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    const message =
      err instanceof ApiError || err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    process.exitCode = 1
  })
