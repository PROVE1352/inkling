import { boolFlag, strFlag } from '../args'
import { DEFAULT_SERVER, loadConfig, saveConfig } from '../config'
import { API_TOKEN_PREFIX, login } from '../http'
import { me } from '../api'
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
 *
 * `--token` saves a personal API token instead (docs/adr/1201-*): from INKLING_TOKEN, piped input or a
 * hidden prompt. It is checked against /api/auth/me before it is saved; the saved session cookie is
 * dropped so only one credential is on disk.
 */
export async function cmdLogin(flags: Record<string, string | boolean>): Promise<void> {
  const config = await loadConfig()
  const server = strFlag(flags, 'server') ?? config.server ?? DEFAULT_SERVER

  const envEmail = process.env.INKLING_EMAIL?.trim()
  const envPassword = process.env.INKLING_PASSWORD
  const flagEmail = strFlag(flags, 'email')?.trim()

  process.stderr.write(`Server: ${server}\n`)

  if (boolFlag(flags, 'token')) {
    const token = (process.env.INKLING_TOKEN?.trim() || (await promptPassword('API token: '))).trim()
    if (!token.startsWith(API_TOKEN_PREFIX)) {
      throw new Error(`That is not an API token (it starts with ${API_TOKEN_PREFIX}). Make one in Settings › Connections › API tokens`)
    }
    const user = await me(server, token)
    if (!user) throw new Error('The server did not accept this token (expired, revoked or for another server)')
    await saveConfig({ ...config, server, token, cookie: undefined })
    process.stdout.write(`Logged in with an API token: ${user.name} <${user.email}>\n`)
    process.stdout.write(`Config saved (~/.inkling.json, mode 0600)\n`)
    return
  }

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
  // a password login replaces a saved API token (one credential on disk)
  await saveConfig({ ...config, server, cookie, token: undefined })

  process.stdout.write(`Logged in: ${user.name} <${user.email}>\n`)
  process.stdout.write(`Config saved (~/.inkling.json, mode 0600)\n`)
}
