// The operator's "Contact" link (INSTANCE_CONTACT, docs/adr/2554-*): which hrefs the screen draws and
// with which attributes, and the words on it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { en } from '../../i18n/en'
import { ko } from '../../i18n/ko'
import { contactLink, contactLinkAttrs } from './contactLink'

test('nothing set: no link', () => {
  assert.equal(contactLink(undefined), null)
  assert.equal(contactLink(null), null)
  assert.equal(contactLink(''), null)
})

test('mailto: opens in place, https: in a new tab without opener or referrer', () => {
  const mail = contactLink('mailto:you@example.org')
  assert.deepEqual(mail, { href: 'mailto:you@example.org', external: false })
  assert.deepEqual(contactLinkAttrs(mail!), { href: 'mailto:you@example.org' })
  const web = contactLink('https://example.org/contact')
  assert.deepEqual(web, { href: 'https://example.org/contact', external: true })
  assert.deepEqual(contactLinkAttrs(web!), { href: 'https://example.org/contact', target: '_blank', rel: 'noopener noreferrer' })
})

test('any other href is not drawn, whatever the server sent', () => {
  for (const href of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'http://example.org/contact',
    'data:text/html,hi',
    'you@example.org',
    'mailto:',
    'https://',
    '//example.org',
    '/contact',
    'https://example.org/a b',
    'mailto:you@example.org\njavascript:x',
  ]) assert.equal(contactLink(href), null, href)
})

test('the words: Contact / 문의하기, and the Settings › About row', () => {
  assert.equal(en['legal.contact'], 'Contact')
  assert.equal(ko['legal.contact'], '문의하기')
  assert.equal(en['legal.contactTitle'], 'Contact the operator')
  assert.equal(ko['legal.contactTitle'], '운영자에게 문의')
  assert.equal(en['legal.contactDesc'], 'Reach the person who runs this server.')
  assert.equal(ko['legal.contactDesc'], '이 서버를 운영하는 사람에게 연락합니다.')
})
