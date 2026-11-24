import type { LegalDocName } from './legalApi'

/**
 * The one line under the sign-up button when signup.json has no items but the folder has documents
 * (docs/adr/2553-*): "By continuing, you agree to the Terms of Service and the Privacy Policy." The
 * sentence is cut into text keys and document links, in that order; terms come first whatever order
 * the server lists them in. No documents (or items to tick) → no line.
 */
export type SignupAgreementPart =
  | { key: 'legal.signupAgreeBefore' | 'legal.signupAgreeAnd' | 'legal.signupAgreeAfter' }
  | { doc: LegalDocName }

const ORDER: readonly LegalDocName[] = ['terms', 'privacy']

export function signupAgreementParts(docs: readonly LegalDocName[], itemCount: number): SignupAgreementPart[] {
  if (itemCount > 0) return []
  const shown = ORDER.filter((d) => docs.includes(d))
  if (shown.length === 0) return []
  const parts: SignupAgreementPart[] = [{ key: 'legal.signupAgreeBefore' }]
  shown.forEach((doc, i) => {
    if (i > 0) parts.push({ key: 'legal.signupAgreeAnd' })
    parts.push({ doc })
  })
  parts.push({ key: 'legal.signupAgreeAfter' })
  return parts
}

/**
 * The sign-up button's text: "Continue" when the one line above shows (the same test, so the button
 * and the line never disagree), otherwise the screen's own text (`register.submit`, `setup.submit`).
 */
export function signupSubmitKey<K extends string>(
  docs: readonly LegalDocName[],
  itemCount: number,
  otherwise: K,
): K | 'legal.signupContinue' {
  return signupAgreementParts(docs, itemCount).length > 0 ? 'legal.signupContinue' : otherwise
}
