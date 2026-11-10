import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH } from 'node:crypto'
import { allowedPushHosts, endpointHash, pushPolicy, validateEndpoint, PushEndpointError } from './config'
import { clip, fit, itemPath, notificationPayload, payloadBytes, PUSH_PAYLOAD_MAX_BYTES, PUSH_PREVIEW_MAX, PUSH_TITLE_MAX, testPayload } from './payload'
import { deviceLabel } from './routes'
import { pushCandidates } from './deliver'
import { b64u, decryptPayload, encryptPayload, MAX_ENCRYPTED_BYTES } from './webPushCrypto'

const code = (fn: () => unknown): string => {
  try {
    fn()
    return 'ok'
  } catch (e) {
    return e instanceof PushEndpointError ? e.code : `other: ${String(e)}`
  }
}

test('endpoint allowlist: the push services of the major browsers are accepted', () => {
  for (const u of [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGuQyavXuuFpNgbYmn',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ]) {
    assert.equal(code(() => validateEndpoint(u)), 'ok', u)
  }
})

test('endpoint allowlist: anything else is refused (host, scheme, port, credentials, internal addresses)', () => {
  assert.equal(code(() => validateEndpoint('https://example.com/push')), 'host_not_allowed')
  assert.equal(code(() => validateEndpoint('https://fcm.googleapis.com.evil.example/x')), 'host_not_allowed')
  assert.equal(code(() => validateEndpoint('https://evilnotify.windows.com/x')), 'host_not_allowed')
  assert.equal(code(() => validateEndpoint('http://fcm.googleapis.com/fcm/send/x')), 'invalid')
  assert.equal(code(() => validateEndpoint('https://fcm.googleapis.com:8443/fcm/send/x')), 'invalid')
  assert.equal(code(() => validateEndpoint('https://user:pw@fcm.googleapis.com/fcm/send/x')), 'invalid')
  assert.equal(code(() => validateEndpoint('https://127.0.0.1/x')), 'host_not_allowed')
  assert.equal(code(() => validateEndpoint('https://[::1]/x')), 'host_not_allowed')
  assert.equal(code(() => validateEndpoint('https://169.254.169.254/latest')), 'host_not_allowed')
  assert.equal(code(() => validateEndpoint('file:///etc/passwd')), 'invalid')
  assert.equal(code(() => validateEndpoint('not a url')), 'invalid')
  assert.equal(code(() => validateEndpoint('')), 'invalid')
  assert.equal(code(() => validateEndpoint(`https://fcm.googleapis.com/${'a'.repeat(1100)}`)), 'invalid')
})

test('endpoint allowlist: WEB_PUSH_ALLOWED_HOSTS-style extra hosts, and an allowed name on an internal literal is still refused', () => {
  const saved = [...pushPolicy.extraHosts]
  try {
    pushPolicy.extraHosts = ['push.example.org', '*.push.corp.example']
    assert.ok(allowedPushHosts().includes('push.example.org'))
    assert.equal(code(() => validateEndpoint('https://push.example.org/sub/1')), 'ok')
    assert.equal(code(() => validateEndpoint('https://a.push.corp.example/sub/1')), 'ok')
    assert.equal(code(() => validateEndpoint('https://push.corp.example/sub/1')), 'host_not_allowed')
    // an operator who allows an IP literal does not open internal addresses
    pushPolicy.extraHosts = ['10.0.0.5']
    assert.equal(code(() => validateEndpoint('https://10.0.0.5/sub/1')), 'invalid')
  } finally {
    pushPolicy.extraHosts = saved
  }
})

test('endpoint allowlist: the test loopback switch only opens loopback, never private ranges', () => {
  const saved = pushPolicy.allowLoopbackForTests
  try {
    pushPolicy.allowLoopbackForTests = true
    assert.equal(code(() => validateEndpoint('http://127.0.0.1:9999/push/1')), 'ok')
    assert.equal(code(() => validateEndpoint('http://10.0.0.1/push/1')), 'invalid')
    assert.equal(code(() => validateEndpoint('http://192.168.1.10/push/1')), 'invalid')
  } finally {
    pushPolicy.allowLoopbackForTests = saved
  }
})

test('endpoint hash: SHA-256 hex', () => {
  assert.match(endpointHash('https://fcm.googleapis.com/fcm/send/x'), /^[0-9a-f]{64}$/)
})

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'comment_mention',
  pageId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  title: 'Launch plan',
  actor: 'Ann',
  via: null,
  excerpt: '@Bob can you check the numbers before Friday?',
  count: 1,
}

test('payload: who did what where, a short preview, the page path and a per-page tag', () => {
  const p = notificationPayload(item, 'en', false, 1)
  assert.equal(p.title, 'Ann mentioned you in a comment on "Launch plan"')
  assert.equal(p.body, item.excerpt)
  assert.equal(p.url, `/w/${item.workspaceId}/p/${item.pageId}`)
  assert.equal(p.tag, `p:${item.pageId}`)
  assert.equal(p.id, item.id)
  const ko = notificationPayload(item, 'ko', false, 1)
  assert.match(ko.title, /Ann님이 "Launch plan" 댓글에서 회원님을 멘션했습니다/)
})

test('payload: "hide content" shows neither who, nor the page, nor the text', () => {
  const p = notificationPayload(item, 'en', true, 1)
  assert.equal(p.title, 'Inkling')
  assert.equal(p.body, 'New notification')
  assert.ok(!JSON.stringify(p).includes('Launch plan'))
  assert.ok(!JSON.stringify(p).includes('Ann'))
  assert.ok(!JSON.stringify(p).includes('numbers'))
  assert.equal(p.url, `/w/${item.workspaceId}/p/${item.pageId}`)
})

test('payload: long titles and previews are cut by characters, and the JSON stays under the byte cap', () => {
  const long = notificationPayload({ ...item, title: '가'.repeat(5000), excerpt: '나'.repeat(5000) }, 'ko', false, 1)
  assert.ok([...long.title].length <= PUSH_TITLE_MAX)
  assert.ok([...long.body].length <= PUSH_PREVIEW_MAX)
  assert.ok(long.body.endsWith('…'))
  assert.ok(payloadBytes(long) <= PUSH_PAYLOAD_MAX_BYTES)
  // fit() shrinks a payload that is over the cap (escaped control characters count 6 bytes)
  const fat = fit({ ...long, title: '\u0001'.repeat(400) + 'x', body: '\u0002'.repeat(400) }, 300)
  assert.ok(payloadBytes(fat) <= 300, String(payloadBytes(fat)))
  // and the encrypted message fits a push service's 4096 bytes
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = Buffer.alloc(16, 3)
  const body = encryptPayload(Buffer.from(JSON.stringify(long)), { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) })
  assert.ok(body.length <= MAX_ENCRYPTED_BYTES)
  assert.deepEqual(JSON.parse(decryptPayload(body, ua.getPrivateKey(), auth).toString('utf8')), long)
})

test('payload: paths are built from ids only', () => {
  assert.equal(itemPath({ type: 'x', pageId: '../../evil', workspaceId: item.workspaceId }), `/w/${item.workspaceId}`)
  assert.equal(itemPath({ type: 'x', pageId: null, workspaceId: null }), '/')
  assert.equal(testPayload('en', 1).url, '/')
  assert.equal(clip('  a\n\tb  ', 10), 'a b')
})

test('candidates: only rows that ping, of a kind that can push; hand-offs only with the person\'s copy', () => {
  const base = { userId: 'u', workspaceId: null, connection: null, personToo: false }
  const out = pushCandidates([
    { ...base, id: '1', type: 'doc_mention', delivery: 'now' },
    { ...base, id: '2', type: 'doc_mention', delivery: 'quiet' },
    { ...base, id: '3', type: 'workspace_added', delivery: 'now' },
    { ...base, id: '4', type: 'task_assigned', delivery: 'now', connection: 'grant:x' },
    { ...base, id: '5', type: 'task_assigned', delivery: 'now', connection: 'grant:x', personToo: true },
  ])
  assert.deepEqual(out.map((r) => [r.id, r.grp]), [['1', 'mention'], ['5', 'assigned']])
})

test('device label: browser and system from the user agent', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), 'Chrome · macOS')
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari · iOS')
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15; SM-S931N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36'), 'Samsung Internet · Android')
  assert.equal(deviceLabel(undefined), null)
})
