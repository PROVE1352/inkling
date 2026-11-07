import type { FastifyRequest } from 'fastify'
import { configuredMailOrigin } from './origin'
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { env, mailEnabled } from './env'
import { AppError } from './errors'
import { fmtMailDateTime, resolveLocale, type Locale } from './i18n'

/**
 * SMTP mail. Enabled only when env has SMTP_HOST + MAIL_FROM (mailEnabled).
 *
 * Secrets: raw codes, temporary passwords and tokens live in memory only while the body is built;
 * logs keep just the recipient's domain and the SMTP error code (never the body or SMTP_PASS).
 *
 * Every template takes an optional `locale` (the recipient's saved locale); when it is missing
 * the mail is written in DEFAULT_LOCALE (docs/adr/0903-*).
 */

let transporter: Transporter | null = null

function getTransport(): Transporter {
  if (!mailEnabled) {
    throw new AppError(501, 'MAIL_DISABLED', 'Mail is not configured')
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host ?? undefined,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass ?? '' } : undefined,
      // so a slow SMTP server cannot hold up the request
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      logger: false,
      debug: false,
    })
  }
  return transporter
}

/** Origin of links in mail: configured values only (APP_URL → PUBLIC_URL), never the Host header (origin.ts, C-M1). */
export function appOrigin(req?: FastifyRequest): string {
  return configuredMailOrigin(req)
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )

export interface MailContent {
  subject: string
  text: string
  html: string
}

/** Simple mail made of paragraphs + an optional highlighted code + a button link */
function compose(opts: {
  subject: string
  lines: string[]
  code?: { label: string; value: string }
  link?: { label: string; url: string }
  footer?: string
}): MailContent {
  const text = [
    ...opts.lines,
    '',
    ...(opts.code ? [`${opts.code.label}: ${opts.code.value}`, ''] : []),
    ...(opts.link ? [`${opts.link.label}: ${opts.link.url}`, ''] : []),
    ...(opts.footer ? [opts.footer] : []),
  ].join('\n')

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#222">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e5e2;border-radius:10px;padding:24px">
<div style="font-weight:700;font-size:16px;margin-bottom:16px">Inkling</div>
${opts.lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6">${escapeHtml(l)}</p>`).join('\n')}
${
  opts.code
    ? `<div style="margin:16px 0;padding:12px 14px;background:#f3f3f0;border-radius:8px"><div style="font-size:12px;color:#666">${escapeHtml(opts.code.label)}</div><div style="font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:700;letter-spacing:1px">${escapeHtml(opts.code.value)}</div></div>`
    : ''
}
${
  opts.link
    ? `<p style="margin:16px 0"><a href="${escapeHtml(opts.link.url)}" style="display:inline-block;background:#2f6feb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px">${escapeHtml(opts.link.label)}</a></p><p style="margin:0;font-size:12px;color:#888;word-break:break-all">${escapeHtml(opts.link.url)}</p>`
    : ''
}
${opts.footer ? `<p style="margin:16px 0 0;font-size:12px;color:#888">${escapeHtml(opts.footer)}</p>` : ''}
</div></body></html>`

  return { subject: opts.subject, text, html }
}

export function resetCodeMail(o: {
  name: string
  email: string
  code: string
  expiresAt: Date
  origin: string
  locale?: Locale | null
}): MailContent {
  const L = resolveLocale(o.locale)
  const url = `${o.origin}/reset?email=${encodeURIComponent(o.email)}&code=${encodeURIComponent(o.code)}`
  const expires = fmtMailDateTime(o.expiresAt, L)
  const m = {
    en: {
      subject: '[Inkling] Password reset code',
      lines: [
        `Hi ${o.name}, here is your password reset code.`,
        'Open the link below, or enter your email and the code under "Reset password" on the sign-in screen, then choose a new password.',
        `Expires: ${expires} (single use)`,
      ],
      codeLabel: 'Reset code',
      linkLabel: 'Reset password',
      footer: "If you didn't ask for this, ignore this email. Your password won't change.",
    },
    ko: {
      subject: '[Inkling] 비밀번호 재설정 코드',
      lines: [
        `${o.name}님, 비밀번호 재설정 코드가 발급되었습니다.`,
        `아래 링크를 열거나 로그인 화면의 "비밀번호 재설정"에서 이메일과 코드를 입력해 새 비밀번호를 정하세요.`,
        `만료: ${expires} (1회만 사용할 수 있습니다)`,
      ],
      codeLabel: '재설정 코드',
      linkLabel: '비밀번호 재설정',
      footer: '요청한 적이 없다면 이 메일을 무시하세요. 비밀번호는 바뀌지 않습니다.',
    },
  }[L]
  return compose({
    subject: m.subject,
    lines: m.lines,
    code: { label: m.codeLabel, value: o.code },
    link: { label: m.linkLabel, url },
    footer: m.footer,
  })
}

export function tempPasswordMail(o: {
  name: string
  email: string
  password: string
  origin: string
  locale?: Locale | null
}): MailContent {
  const L = resolveLocale(o.locale)
  const m = {
    en: {
      subject: '[Inkling] Temporary password',
      lines: [
        `Hi ${o.name}, an admin has issued you a temporary password.`,
        `Sign in with your email (${o.email}) and the temporary password below, then change your password in Settings.`,
      ],
      codeLabel: 'Temporary password',
      linkLabel: 'Sign in',
    },
    ko: {
      subject: '[Inkling] 임시 비밀번호',
      lines: [
        `${o.name}님, 관리자가 임시 비밀번호를 발급했습니다.`,
        `이메일(${o.email})과 아래 임시 비밀번호로 로그인한 뒤 설정에서 비밀번호를 바꿔 주세요.`,
      ],
      codeLabel: '임시 비밀번호',
      linkLabel: '로그인',
    },
  }[L]
  return compose({
    subject: m.subject,
    lines: m.lines,
    code: { label: m.codeLabel, value: o.password },
    link: { label: m.linkLabel, url: `${o.origin}/login` },
  })
}

/** Signup invitation. There is no recipient account yet, so callers usually leave `locale` unset (DEFAULT_LOCALE). */
export function inviteMail(o: {
  key: string
  expiresAt: Date | null
  origin: string
  locale?: Locale | null
}): MailContent {
  const L = resolveLocale(o.locale)
  const expires = o.expiresAt ? fmtMailDateTime(o.expiresAt, L) : null
  const m = {
    en: {
      subject: "[Inkling] You're invited",
      lines: [
        'Here is your Inkling signup key.',
        'Open the link below and choose an email, name and password to create your account.',
        expires ? `Expires: ${expires}` : 'Expires: never',
      ],
      codeLabel: 'Signup key',
      linkLabel: 'Sign up',
    },
    ko: {
      subject: '[Inkling] 가입 초대',
      lines: [
        'Inkling 가입 키가 도착했습니다.',
        '아래 링크에서 이메일·이름·비밀번호를 정하면 계정이 만들어집니다.',
        expires ? `만료: ${expires}` : '만료: 없음',
      ],
      codeLabel: '가입 키',
      linkLabel: '가입하기',
    },
  }[L]
  return compose({
    subject: m.subject,
    lines: m.lines,
    code: { label: m.codeLabel, value: o.key },
    link: { label: m.linkLabel, url: `${o.origin}/register?key=${encodeURIComponent(o.key)}` },
  })
}

export function verifyMail(o: {
  name: string
  token: string
  origin: string
  locale?: Locale | null
}): MailContent {
  const L = resolveLocale(o.locale)
  const m = {
    en: {
      subject: '[Inkling] Verify your email',
      lines: [
        `Hi ${o.name}, click the button below to verify your email address.`,
        'The link works once and expires in 24 hours.',
      ],
      linkLabel: 'Verify email',
      footer: "If you didn't sign up, ignore this email.",
    },
    ko: {
      subject: '[Inkling] 이메일 인증',
      lines: [
        `${o.name}님, 아래 버튼을 눌러 이메일 주소를 인증해 주세요.`,
        '링크는 24시간 동안 한 번만 쓸 수 있습니다.',
      ],
      linkLabel: '이메일 인증',
      footer: '가입한 적이 없다면 이 메일을 무시하세요.',
    },
  }[L]
  return compose({
    subject: m.subject,
    lines: m.lines,
    link: { label: m.linkLabel, url: `${o.origin}/verify?token=${encodeURIComponent(o.token)}` },
    footer: m.footer,
  })
}

/** Backup failure alert for an admin (backup/monitor.ts). `at` is the alert's ISO timestamp. */
export function backupFailedMail(o: {
  kind: string
  at: string
  details: string
  origin: string
  locale?: Locale | null
}): MailContent {
  const L = resolveLocale(o.locale)
  const atDate = new Date(o.at)
  const when = Number.isNaN(atDate.getTime()) ? o.at : fmtMailDateTime(atDate, L)
  const m = {
    en: {
      subject: '[Inkling] Backup failed',
      lines: [
        'An Inkling backup problem needs your attention.',
        `Kind: ${o.kind}`,
        `When: ${when}`,
        `Details: ${o.details}`,
        'Open Admin → Backups for the full status. See docs/BACKUP.md for troubleshooting.',
      ],
      linkLabel: 'Open Inkling',
    },
    ko: {
      subject: '[Inkling] 백업 실패',
      lines: [
        'Inkling 백업에 확인이 필요한 문제가 생겼습니다.',
        `종류: ${o.kind}`,
        `시각: ${when}`,
        `내용: ${o.details}`,
        '전체 상태는 관리자 → 백업에서 볼 수 있습니다. 문제 해결은 docs/BACKUP.md 를 참고하세요.',
      ],
      linkLabel: 'Inkling 열기',
    },
  }[L]
  // admin page lives under a workspace; the root redirects there
  return compose({ subject: m.subject, lines: m.lines, link: { label: m.linkLabel, url: `${o.origin}/` } })
}

/**
 * Send. On failure throws AppError(502, MAIL_FAILED) whose message carries only the SMTP error
 * code (no secrets). With `log`, records the outcome (recipient domain and error code only).
 */
export async function sendMail(
  to: string,
  content: MailContent,
  log?: (msg: string) => void,
): Promise<void> {
  const t = getTransport()
  const domain = to.split('@')[1] ?? '?'
  try {
    await t.sendMail({
      from: env.mailFrom ?? undefined,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    })
    log?.(`[mail] sent → *@${domain} (${content.subject})`)
  } catch (err) {
    const e = err as { code?: string; responseCode?: number }
    const reason = [e.code, e.responseCode].filter(Boolean).join(' ') || 'UNKNOWN'
    log?.(`[mail] failed → *@${domain} (${reason})`)
    throw new AppError(502, 'MAIL_FAILED', `Failed to send mail (${reason})`)
  }
}
