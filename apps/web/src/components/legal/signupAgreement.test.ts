// The one-line agreement under the sign-up button (signup.json `items: []`, docs/adr/2553-*): which
// text keys and document links make the sentence for each set of documents.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { en } from '../../i18n/en'
import { ko } from '../../i18n/ko'
import { signupAgreementParts, type SignupAgreementPart } from './signupAgreement'

const sentence = (parts: SignupAgreementPart[], dict: Record<string, string>) =>
  parts.map((p) => ('doc' in p ? `[${dict[p.doc === 'terms' ? 'legal.terms' : 'legal.privacy']}]` : dict[p.key])).join('')

test('both documents: terms first, then privacy, whatever order the server lists them in', () => {
  const both = signupAgreementParts(['privacy', 'terms'], 0)
  assert.deepEqual(both, [
    { key: 'legal.signupAgreeBefore' },
    { doc: 'terms' },
    { key: 'legal.signupAgreeAnd' },
    { doc: 'privacy' },
    { key: 'legal.signupAgreeAfter' },
  ])
  assert.equal(sentence(both, en), 'By signing up, you agree to the [Terms of Service] and the [Privacy Policy].')
  assert.equal(sentence(both, ko), '가입하면 [이용약관]과 [개인정보 처리방침]에 동의하는 것입니다.')
})

test('one document: the same sentence with that document only', () => {
  assert.equal(sentence(signupAgreementParts(['terms'], 0), en), 'By signing up, you agree to the [Terms of Service].')
  assert.equal(sentence(signupAgreementParts(['privacy'], 0), en), 'By signing up, you agree to the [Privacy Policy].')
  assert.equal(sentence(signupAgreementParts(['terms'], 0), ko), '가입하면 [이용약관]에 동의하는 것입니다.')
  assert.equal(sentence(signupAgreementParts(['privacy'], 0), ko), '가입하면 [개인정보 처리방침]에 동의하는 것입니다.')
})

test('no line without documents, or when there are items to tick (the tick-box form is used then)', () => {
  assert.deepEqual(signupAgreementParts([], 0), [])
  assert.deepEqual(signupAgreementParts(['terms', 'privacy'], 1), [])
})
