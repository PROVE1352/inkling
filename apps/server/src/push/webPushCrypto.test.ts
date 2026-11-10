import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH } from 'node:crypto'
import {
  MAX_ENCRYPTED_BYTES,
  MAX_PLAINTEXT_BYTES,
  assertSubscriptionKeys,
  assertVapidKeys,
  b64u,
  decryptPayload,
  encryptPayload,
  fromB64u,
  generateVapidKeys,
  vapidAuthorization,
  vapidJwt,
  verifyVapidJwt,
} from './webPushCrypto'

// RFC 8291 Appendix A ("Intermediate Values for Encryption").
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('RFC 8291 appendix A: the example message encrypts byte for byte', () => {
  const out = encryptPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    asPrivateKey: fromB64u(RFC.asPrivate),
    salt: fromB64u(RFC.salt),
  })
  assert.equal(b64u(out), RFC.body)
})

test('RFC 8291 appendix A: the example body decrypts with the user agent key', () => {
  const pt = decryptPayload(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), fromB64u(RFC.auth))
  assert.equal(pt.toString('utf8'), RFC.plaintext)
})

test('a fresh key and salt per message: round trip, and two encryptions differ', () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = Buffer.alloc(16, 7)
  const sub = { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }
  const msg = Buffer.from(JSON.stringify({ title: '알림', body: 'x'.repeat(100) }))
  const a = encryptPayload(msg, sub)
  const b = encryptPayload(msg, sub)
  assert.notEqual(b64u(a), b64u(b))
  assert.deepEqual(decryptPayload(a, ua.getPrivateKey(), auth), msg)
  assert.equal(a.readUInt32BE(16), 4096)
})

test('payload cap: the largest plaintext still fits 4096 bytes, one more byte is refused', () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const sub = { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 1)) }
  const max = encryptPayload(Buffer.alloc(MAX_PLAINTEXT_BYTES, 0x61), sub)
  assert.equal(max.length, MAX_ENCRYPTED_BYTES)
  assert.throws(() => encryptPayload(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 0x61), sub), /too large/)
})

test('subscription keys: sizes and curve membership are checked', () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const good = { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16)) }
  assert.doesNotThrow(() => assertSubscriptionKeys(good))
  assert.throws(() => assertSubscriptionKeys({ ...good, auth: b64u(Buffer.alloc(8)) }))
  assert.throws(() => assertSubscriptionKeys({ ...good, p256dh: b64u(Buffer.alloc(65, 4)) }))
  assert.throws(() => assertSubscriptionKeys({ ...good, p256dh: b64u(ua.getPublicKey(null, 'compressed')) }))
  assert.throws(() => assertSubscriptionKeys({ ...good, auth: 'not base64!' }))
})

test('VAPID: ES256 JWT verifies with the public key, carries aud/sub/exp, and a wrong key fails', () => {
  const keys = generateVapidKeys()
  assert.doesNotThrow(() => assertVapidKeys(keys))
  assert.equal(fromB64u(keys.publicKey).length, 65)
  assert.equal(fromB64u(keys.privateKey).length, 32)
  const now = Date.UTC(2026, 10, 10)
  const jwt = vapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'mailto:ops@example.com', keys, now })
  const [h, , s] = jwt.split('.')
  assert.deepEqual(JSON.parse(fromB64u(h).toString()), { typ: 'JWT', alg: 'ES256' })
  // JOSE form r‖s, not DER
  assert.equal(fromB64u(s).length, 64)
  const claims = verifyVapidJwt(jwt, keys.publicKey)
  assert.ok(claims)
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.equal(claims.sub, 'mailto:ops@example.com')
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600)
  assert.equal(verifyVapidJwt(jwt, generateVapidKeys().publicKey), null)
  // tampered claims
  const forged = jwt.split('.')
  forged[1] = b64u(Buffer.from(JSON.stringify({ aud: 'https://evil.example', exp: claims.exp, sub: claims.sub })))
  assert.equal(verifyVapidJwt(forged.join('.'), keys.publicKey), null)
  assert.equal(vapidAuthorization(jwt, keys.publicKey), `vapid t=${jwt}, k=${keys.publicKey}`)
})

test('VAPID: a private key that does not belong to the public key is refused', () => {
  const a = generateVapidKeys()
  const b = generateVapidKeys()
  assert.throws(() => assertVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey }))
  assert.throws(() => assertVapidKeys({ publicKey: a.publicKey, privateKey: b64u(Buffer.alloc(31, 1)) }))
})
