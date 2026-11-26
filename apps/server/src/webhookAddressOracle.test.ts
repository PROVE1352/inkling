// A generic webhook's save check and test send must not tell a name that does not resolve from a
// name that resolves to an internal address (0.25.4 security fix D-4): otherwise a workspace owner
// can map internal DNS names (docker services, VCN names) through the error text. Both now read the
// same; link previews already answer every failure alike.
// Run: cd apps/server && node ../../scripts/run-tests.mjs --test-name-pattern=webhook
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'

describe('generic webhooks: no internal-name oracle', () => {
  const NO_SUCH = 'https://no-such-host-d4.invalid/hook' // never resolves
  const INTERNAL = 'https://localhost/hook' // resolves to loopback (blocked by name, too)
  const INTERNAL_IP = 'https://10.0.0.5/hook' // a literal internal address

  it('saving: the same message for a name that does not resolve and an internal one', async () => {
    const { assertPublicWebhookHost, parseWebhookUrl } = await import('./webhooks')
    const messageOf = async (url: string) => {
      try {
        parseWebhookUrl(url, 'generic')
        await assertPublicWebhookHost(url)
      } catch (e) {
        return (e as Error).message
      }
      return 'accepted'
    }
    const a = await messageOf(NO_SUCH)
    const b = await messageOf(INTERNAL)
    const c = await messageOf(INTERNAL_IP)
    assert.notEqual(a, 'accepted')
    assert.equal(a, b)
    assert.equal(b, c)
  })

  it('test send / delivery: the same error for both', async () => {
    const { deliver, storeHookSecret, storeHookUrl } = await import('./webhooks')
    const errorOf = async (url: string) => {
      const id = randomUUID()
      const r = await deliver({ id, kind: 'generic', url: storeHookUrl(id, url), secret: storeHookSecret(id, 'whsec_test') }, '{}')
      assert.equal(r.ok, false)
      return r.ok ? '' : r.error
    }
    const a = await errorOf(NO_SUCH)
    const b = await errorOf(INTERNAL)
    const c = await errorOf(INTERNAL_IP)
    assert.equal(a, b)
    assert.equal(b, c)
  })
})
