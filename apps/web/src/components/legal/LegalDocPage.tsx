import { Link, Navigate } from 'react-router'
import { useAuthMode, useMe } from '../../api'
import { useLocale, useT } from '../../i18n'
import { LOCALE_NAMES } from '../../i18n/names'
import { FullScreenSpinner, Spinner } from '../Spinner'
import { InstanceBadge } from '../InstanceBadge'
import { Markdown } from './LegalMarkdown'
import { LegalLanguageSelect, LegalLinks } from './LegalLinks'
import { useLegalDoc, useLegalMode, type LegalDocName } from './legalApi'

/**
 * /terms and /privacy (docs/adr/2519-*): this server's documents, readable without signing in, drawn
 * from Markdown without any HTML. Without LEGAL_DIR, or for a document the server does not have, the
 * address goes home like any unknown one.
 */
export function LegalDocPage({ doc }: { doc: LegalDocName }) {
  const t = useT()
  const locale = useLocale()
  const authMode = useAuthMode()
  const mode = useLegalMode()
  const has = !!mode?.docs.includes(doc)
  const q = useLegalDoc(doc, has)
  const me = useMe()

  if (authMode.isLoading) return <FullScreenSpinner />
  if (!has) return <Navigate to="/" replace />

  const back = me.data ? '/' : '/login'
  return (
    <div className="min-h-full bg-app px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl min-w-0">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <img src="/icon.svg" alt="" className="h-7 w-7" />
            <span className="text-sm font-semibold text-ink">Inkling</span>
            <InstanceBadge placement="auth" />
          </div>
          <Link to={back} className="text-xs text-accent hover:underline">
            ← {t('legal.back')}
          </Link>
        </header>

        <article className="rounded-lg border border-line bg-app p-4 sm:p-8" data-testid="legal-doc" lang={q.data?.locale}>
          {q.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner size={20} />
            </div>
          ) : !q.data ? (
            <p role="alert" className="text-sm text-red-600">
              {t('legal.loadFailed')}
            </p>
          ) : (
            <>
              {q.data.locale !== locale && (
                <p className="mb-4 rounded-md bg-side px-3 py-2 text-xs text-sub">
                  {t('legal.onlyIn', { language: LOCALE_NAMES[q.data.locale] })}
                </p>
              )}
              <Markdown source={q.data.markdown} />
              <p className="mt-8 border-t border-line pt-3 text-[11px] text-sub">{t('legal.version', { version: q.data.version })}</p>
            </>
          )}
        </article>

        <footer className="mt-6 flex flex-col items-center gap-3">
          <LegalLinks />
          <LegalLanguageSelect />
        </footer>
      </div>
    </div>
  )
}

export function TermsPage() {
  return <LegalDocPage doc="terms" />
}

export function PrivacyPage() {
  return <LegalDocPage doc="privacy" />
}
