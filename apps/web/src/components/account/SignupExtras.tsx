import { useState } from 'react'
import { Link } from 'react-router'
import type { RegisterInput } from '@inkling/shared'
import { useT } from '../../i18n'
import { LanguageSelect } from '../LanguageSelect'

/**
 * Pieces of the sign-up form for restricted mode (docs/adr/2512-*, 2516-*): the bot checks, the
 * "sign-up is full" notice. Without sign-up limits the form sends exactly what it sent in 0.21.1.
 */

/** When the form appeared (the server refuses a sign-up sent within 2 s of it). */
export function useSignupShownAt(): number {
  const [at] = useState(() => Date.now())
  return at
}

/**
 * The sign-up body: the parsed fields plus, when the server asks for bot checks (`authMode.signupChecks`),
 * the time the form was on screen and the hidden field. The hidden field goes as typed (a person
 * never fills it); the server refuses a non-empty one.
 */
export function signupBody(
  parsed: Omit<RegisterInput, 'email'> & { email?: string },
  opts: { checks: boolean; shownAt: number; website: string },
): RegisterInput {
  const body: Record<string, unknown> = { ...parsed }
  if (opts.checks) {
    body.formMs = Date.now() - opts.shownAt
    body.website = opts.website
  }
  // in ID mode the body has `loginId` instead of `email`; the server reads it that way
  return body as unknown as RegisterInput
}

/**
 * A field people do not see and do not reach with the keyboard; scripts that fill every input do.
 * Named like an ordinary field so they fill it, kept away from password managers' autofill.
 */
export function BotCheckField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
      <label>
        Website
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  )
}

/** SIGNUP_MAX_USERS reached: shown instead of the sign-up form. */
export function SignupFullNotice({ next }: { next: string }) {
  const t = useT()
  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm" data-testid="signup-full">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">Inkling</h1>
        </div>
        <div className="rounded-lg border border-line bg-app p-6 text-center">
          <h2 className="mb-2 text-base font-semibold text-ink">{t('accountLifecycle.fullTitle')}</h2>
          <p className="text-sm text-sub">{t('accountLifecycle.fullBody')}</p>
          <Link
            to={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="mt-4 inline-block text-xs text-accent hover:underline"
          >
            {t('auth.toLogin')}
          </Link>
        </div>
        <div className="mt-6 flex justify-center">
          <LanguageSelect compact />
        </div>
      </div>
    </div>
  )
}
