import { strFlag } from '../args'
import { DEFAULT_SERVER, loadConfig, saveConfig } from '../config'
import { login } from '../http'
import { promptLine, promptPassword } from '../prompt'

/**
 * inklingctl login [--server <url>] [--email <email>]
 *
 * Credentials come in three ways, so login also works where nobody can type
 * (agents, cron, CI):
 *   1) --email flag / INKLING_EMAIL, INKLING_PASSWORD environment variables
 *   2) piped input (`printf 'id\npassword\n' | inklingctl login`)
 *   3) interactive prompt (TTY)
 * The password is never taken from argv — it would end up in ps output and shell history.
 *
 * Delegated-login accounts (<id>@<DELEGATED_EMAIL_DOMAIN>) use the external account's id and its password.
 * They have no separate Inkling password.
 */
export async function cmdLogin(flags: Record<string, string | boolean>): Promise<void> {
  const config = await loadConfig()
  const server = strFlag(flags, 'server') ?? config.server ?? DEFAULT_SERVER

  const envEmail = process.env.INKLING_EMAIL?.trim()
  const envPassword = process.env.INKLING_PASSWORD
  const flagEmail = strFlag(flags, 'email')?.trim()

  process.stderr.write(`Server: ${server}\n`)

  const email = flagEmail || envEmail || (await promptLine('Email: '))
  const password = envPassword ?? (await promptPassword('Password: '))

  if (!email || !password) {
    throw new Error(
      'Both email and password are required.\n' +
        'If you cannot type input here, pass them as environment variables: ' +
        'INKLING_EMAIL=<id> INKLING_PASSWORD=<password> inklingctl login\n' +
        '(delegated-login accounts use the external account id + its password)',
    )
  }

  const { cookie, user } = await login(server, email, password)
  await saveConfig({ ...config, server, cookie })

  process.stdout.write(`Logged in: ${user.name} <${user.email}>\n`)
  process.stdout.write(`Config saved (~/.inkling.json, mode 0600)\n`)
}
