import { health, me } from '../api'
import { loadConfig } from '../config'

/** inklingctl status — server health + login state. */
export async function cmdStatus(): Promise<void> {
  const config = await loadConfig()

  process.stdout.write(`Server: ${config.server}\n`)

  const ok = await health(config.server)
  process.stdout.write(`Server status: ${ok ? 'OK (health ok)' : 'not responding'}\n`)

  const user = ok ? await me(config.server, config.cookie) : null
  if (user) {
    process.stdout.write(`Logged in: ${user.name} <${user.email}>\n`)
  } else if (config.cookie) {
    process.stdout.write('Logged in: session expired or invalid — run `inklingctl login`\n')
  } else {
    process.stdout.write('Logged in: no — run `inklingctl login`\n')
  }

  if (config.vault) process.stdout.write(`Vault: ${config.vault}\n`)
  process.stdout.write(`Subfolder (subdir): ${config.subdir ?? 'Inkling'}\n`)
}
