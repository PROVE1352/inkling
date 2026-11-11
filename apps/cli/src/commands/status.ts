import { health, me } from '../api'
import { whoLabel } from '../http'
import { credentialOf, credentialSource, loadConfig } from '../config'

/** inklingctl status — server health + login state. */
export async function cmdStatus(): Promise<void> {
  const config = await loadConfig()

  process.stdout.write(`Server: ${config.server}\n`)

  const ok = await health(config.server)
  process.stdout.write(`Server status: ${ok ? 'OK (health ok)' : 'not responding'}\n`)

  const auth = credentialOf(config)
  const source = credentialSource(config)
  const how = source === 'env' ? 'API token from INKLING_TOKEN' : source === 'token' ? 'saved API token' : 'saved session'
  const user = ok ? await me(config.server, auth) : null
  if (user) {
    process.stdout.write(`Logged in: ${whoLabel(user)} (${how})\n`)
  } else if (auth) {
    process.stdout.write(`Logged in: ${how} expired, revoked or invalid — run \`inklingctl login\`\n`)
  } else {
    process.stdout.write('Logged in: no — run `inklingctl login`\n')
  }

  if (config.vault) process.stdout.write(`Vault: ${config.vault}\n`)
  process.stdout.write(`Subfolder (subdir): ${config.subdir ?? 'Inkling'}\n`)
}
