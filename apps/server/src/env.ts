import { config } from 'dotenv'

// In dev the cwd is apps/server, so also look for the root .env
config({ path: ['.env', '../../.env'] })

function posNum(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** DEFAULT_LOCALE → 'en' | 'ko' | null (unset or unknown). Mirrors normalizeLocale in i18n.ts. */
function localeEnv(v: string | undefined): 'en' | 'ko' | null {
  const s = v?.trim().toLowerCase() ?? ''
  if (s === 'ko' || s.startsWith('ko-') || s.startsWith('ko_')) return 'ko'
  if (s === 'en' || s.startsWith('en-') || s.startsWith('en_')) return 'en'
  return null
}

export const env = {
  port: Number(process.env.PORT ?? 3001),
  /**
   * DEFAULT_LOCALE: language for emails/templates of users without a saved locale, and the web
   * UI default before the browser language (docs/adr/0901-*). Default 'en'.
   */
  defaultLocale: localeEnv(process.env.DEFAULT_LOCALE) ?? 'en',
  /** Whether DEFAULT_LOCALE was set explicitly (only then does /auth/mode override the browser). */
  defaultLocaleConfigured: localeEnv(process.env.DEFAULT_LOCALE) !== null,
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://nodian:nodian@localhost:55432/nodian',
  dataDir: process.env.DATA_DIR ?? './data',
  /** When set, serve this directory as the SPA's static files (production Docker) */
  webDist: process.env.WEB_DIST,
  drizzleDir: process.env.DRIZZLE_DIR ?? './drizzle',
  /** Secure cookies: COOKIE_SECURE=1, or automatically when PUBLIC_URL is https (C-M9). */
  cookieSecure:
    process.env.COOKIE_SECURE === '1' || /^https:\/\//i.test(process.env.PUBLIC_URL?.trim() || ''),
  isProd: process.env.NODE_ENV === 'production',
  /** Notion internal integration token; without it Notion upload is disabled (501) */
  notionToken: process.env.NOTION_TOKEN || null,
  /**
   * When set, "delegated login" is on: signing in with an ID Inkling does not know delegates the
   * check to the external auth server at this URL (contract in deploy/DEPLOY.md). Coexists with
   * Inkling's own accounts (origin='local'); delegation is login-only and one-way (passwords of
   * Inkling accounts are never sent out).
   * e.g. https://auth.example.com
   */
  delegatedAuthUrl: process.env.DELEGATED_AUTH_URL?.trim() || null,
  /**
   * Name of the delegated account shown on the login and admin screens (e.g. "Company account").
   * The web client shows its own translation when it sees the default 'External account'.
   */
  delegatedAuthName: process.env.DELEGATED_AUTH_NAME?.trim() || 'External account',
  /**
   * Email domain used when mirroring delegated accounts into Inkling's users (<id>@<domain>).
   * A fake domain that never receives mail; self-signup cannot use it. Changing it on a running
   * instance breaks matching with existing mirror accounts, so keep the value you started with.
   */
  delegatedEmailDomain: (process.env.DELEGATED_EMAIL_DOMAIN?.trim() || 'delegated.local')
    .replace(/^@/, '')
    .toLowerCase(),
  /**
   * Public site origin (e.g. https://notes.example.com). Used for the issuer and endpoint URLs of
   * the MCP OAuth metadata, resource_metadata in WWW-Authenticate, and og:url.
   * The Host header is never trusted for these (origin.ts): unset (and no APP_URL) is only
   * accepted without mail, where the request host is used with a warning (dev).
   */
  publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || null,
  /**
   * Whether signup requires an Inkling signup key. Always required in delegated mode (the site
   * is public); in local development (no delegation) turn it on with SIGNUP_REQUIRE_KEY=1.
   */
  signupRequireKey:
    process.env.SIGNUP_REQUIRE_KEY === '1' ||
    !!process.env.DELEGATED_AUTH_URL?.trim() ||
    // Production default (C-M10): a public instance must not let the first stranger who signs up
    // become admin. Only an explicit SIGNUP_REQUIRE_KEY=0 opens public signup.
    (process.env.NODE_ENV === 'production' && process.env.SIGNUP_REQUIRE_KEY?.trim() !== '0'),
  /**
   * Outgoing mail (SMTP). On only when both SMTP_HOST and MAIL_FROM are set; otherwise every
   * mail feature (admin "Send by email", email verification, automatic reset mail) is disabled.
   */
  smtp: {
    host: process.env.SMTP_HOST?.trim() || null,
    secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true',
    port: Number(
      process.env.SMTP_PORT ||
        (process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true' ? 465 : 587),
    ),
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
  },
  mailFrom: process.env.MAIL_FROM?.trim() || null,
  /** Origin of links in emails (e.g. https://notes.example.com). Falls back to PUBLIC_URL. */
  appUrl:
    (process.env.APP_URL || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || null,
  /**
   * With 1, accounts created after email verification was introduced cannot sign in until
   * verified. Ignored when mail is disabled, since there is no way to verify (default 0 = warning
   * banner only).
   */
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === '1',
  /**
   * Front proxies whose X-Forwarded-For is trusted (comma-separated CIDR/IP, or the loopback /
   * linklocal / uniquelocal presets). Default 'loopback,uniquelocal' covers both Caddy on the same
   * host (127.0.0.1) and the Docker bridge (172.16/12 etc.). Connections straight from the
   * internet do not match, so a forged XFF is ignored. 'false' never trusts XFF.
   */
  trustProxy: ((): string[] | false => {
    const raw = (process.env.TRUST_PROXY?.trim() || 'loopback,uniquelocal').trim()
    if (raw === 'false' || raw === '0') return false
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  })(),
  /** IPs/CIDRs exempt from banning (comma-separated), e.g. 203.0.113.7,10.0.0.0/8 */
  allowlistIps: (process.env.ALLOWLIST_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Brute-force protection policy (guard.ts) */
  authGuard: {
    windowMinutes: posNum(process.env.AUTH_GUARD_WINDOW_MINUTES, 15),
    maxFailures: posNum(process.env.AUTH_GUARD_MAX_FAILURES, 10),
    banMinutes: posNum(process.env.AUTH_GUARD_BAN_MINUTES, 15),
    banMaxHours: posNum(process.env.AUTH_GUARD_BAN_MAX_HOURS, 24),
    accountFailures: posNum(process.env.AUTH_GUARD_ACCOUNT_FAILURES, 5),
  },
}

/** Whether mail can be sent */
export const mailEnabled = !!(env.smtp.host && env.mailFrom)
