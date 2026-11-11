import { useQuery } from '@tanstack/react-query'
import { api, useAuthMode } from '../../api'
import { getLocale } from '../../i18n'

/**
 * Terms, privacy policy and consent of this server (LEGAL_DIR, restricted mode, docs/adr/2519-*).
 * Nothing here asks the server anything unless /auth/mode says the server has documents
 * (`legal`): without LEGAL_DIR the routes are 404 and every screen part of this piece draws nothing.
 */

export type LegalDocName = 'terms' | 'privacy'

export interface LegalItem {
  id: string
  required: boolean
  label: string
  doc?: LegalDocName
  /** Markdown, shown folded under the item. */
  details?: string
}

export interface Legal {
  version: string
  notice: string | null
  items: LegalItem[]
}

export interface LegalDoc {
  doc: LegalDocName
  version: string
  locale: 'en' | 'ko'
  markdown: string
}

/** Fired on window when any API call answers CONSENT_REQUIRED (api.ts): the documents changed or were never agreed to. */
export const CONSENT_REQUIRED_EVENT = 'inkling:consent-required'

export const legalKeys = {
  items: (locale: string) => ['legal', 'items', locale] as const,
  doc: (doc: LegalDocName, locale: string) => ['legal', 'doc', doc, locale] as const,
}

/** /auth/mode `legal` ({ version, docs }) when the server has LEGAL_DIR, else undefined. */
export function useLegalMode() {
  return useAuthMode().data?.legal
}

/** The notice and the tick boxes, in the current UI language. */
export function useLegal(enabled: boolean) {
  const locale = getLocale()
  return useQuery({
    queryKey: legalKeys.items(locale),
    queryFn: () => api<Legal>(`/api/legal?locale=${locale}`),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

export function useLegalDoc(doc: LegalDocName, enabled: boolean) {
  const locale = getLocale()
  return useQuery({
    queryKey: legalKeys.doc(doc, locale),
    queryFn: () => api<LegalDoc>(`/api/legal/${doc}?locale=${locale}`),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

export function submitConsent(body: { consents: string[]; legalVersion: string }): Promise<{ ok: true; version: string }> {
  return api('/api/legal/consent', { method: 'POST', body: JSON.stringify(body) })
}

export const DOC_PATH: Record<LegalDocName, string> = { terms: '/terms', privacy: '/privacy' }
