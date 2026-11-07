# Receiving Inkling webhooks

A workspace owner can send workspace events to any https endpoint: n8n, Zapier, Make, a serverless
function or your own server. This guide is for the person writing the receiving side. Slack and
Discord webhooks are configured in the same place but get a chat message, not the JSON described here.

Decisions behind this design: [ADR 1190](adr/1190-generic-webhooks-and-signatures.md) (payload,
signature, secrets, SSRF), [ADR 1191](adr/1191-webhook-delivery-records-and-resend.md) (delivery list,
resend), [ADR 1192](adr/1192-generic-webhook-auto-disable.md) (auto-disable). Delivery itself goes
through the transactional outbox ([ADR 1081](adr/1081-notifications-and-webhooks-through-the-outbox.md)).

## Setting one up

Workspace settings → **Webhooks** → type **Generic (JSON)**, enter the URL, pick the events, **Add
webhook**. The signing secret (`whsec_…`) is shown **once**, right after it is created. Store it with
the receiver; Inkling never shows it again (you can create a new one, see [Rotating the
secret](#rotating-the-secret)).

The URL must be `https://` on the default port (443), without a user name, password or `#fragment`. A
query string is allowed. The host must resolve only to public internet addresses: loopback, private
(10/8, 172.16/12, 192.168/16), link-local (169.254/16, cloud metadata), CGNAT, IPv6 ULA and similar
addresses are refused when you save the webhook and again on every delivery (the connection is made
to the address that was checked, so a DNS change between check and connect cannot redirect it).

**Send test event** posts a `type: "test"` event right away, so you can check the signature code
before real events arrive.

## The request

```
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: Inkling-Webhooks/1
X-Inkling-Delivery: 48213
X-Inkling-Event: comment
X-Inkling-Signature: t=1762500000,v1=5f2b…c9e1
```

| Header | Meaning |
|---|---|
| `X-Inkling-Delivery` | Id of this delivery. The same value on every retry and when an owner sends it again by hand. Equal to the body's `id`. Use it to drop duplicates. |
| `X-Inkling-Event` | The event type (`comment`, `mention`, …, or `test`). Equal to the body's `type`. |
| `X-Inkling-Signature` | `t=<unix seconds>` and one or more `v1=<hex>` signatures (see below). `t` is the time of this attempt, so a retry carries a new `t`. |

Inkling waits at most 8 seconds for the response (3 seconds to connect) and reads at most 16 KiB of it.
Redirects are **not** followed: a 3xx response counts as a failed delivery.

## The body (version 1)

```json
{
  "version": 1,
  "id": "48213",
  "type": "comment",
  "occurredAt": "2026-11-07T09:12:44.512Z",
  "workspace": { "id": "6b1d…", "name": "Product" },
  "actor": { "id": "2f0a…", "name": "Alice", "via": null },
  "page": { "id": "9c3e…", "title": "Launch plan", "url": "https://notes.example.com/w/6b1d…/p/9c3e…" },
  "comment": { "id": "d41a…" }
}
```

Common fields:

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | Fields may be **added** within a version; a removal or a change of meaning bumps it. Ignore fields you do not know. |
| `id` | string | Delivery id, same as `X-Inkling-Delivery`. Test events use `test_<uuid>`. |
| `type` | string | One of the events below, or `test`. |
| `occurredAt` | ISO 8601 | When the event was queued (not when this attempt was made). |
| `workspace` | `{ id, name }` | |
| `actor` | `{ id, name, via }` or `null` | Who caused the event. `via` is the name of the AI connection (MCP / OAuth client) when an agent did it. `null` for reminders, digests and when the person no longer exists. |

Links (`url`) are present when the server has `APP_URL` or `PUBLIC_URL` set, otherwise `null`. They
open in Inkling and need a signed-in member like any page link.

Events (the same list as for Slack and Discord; a webhook receives only the ones ticked):

| `type` | When | Extra fields |
|---|---|---|
| `comment` | A comment on a shared page | `page`, `comment: { id }` |
| `mention` | A comment @mentions members | `page`, `comment: { id }`, `users: [{ id, name }]` (mentioned members) |
| `reminder` | A page's due date is today | `page` |
| `page_created` | A page was created in the shared section (sent 20 s later; dropped if it was moved to private or deleted meanwhile) | `page` |
| `assigned` | A member became a document owner or was put in a person cell | `page`, `users: [{ id, name }]`, `field` (the person field's name, or `owner`) |
| `review_due` | Daily: shared documents past their review date | `pages: [{ id, title, url, owner }]` (≤ 50), `total`, `url` (review screen) |
| `agent_digest` | Daily: shared pages AI connections edited in the last day | `pages: [{ id, title, url, owner: null }]` (≤ 50), `total`, `url` (activity screen) |
| `test` | **Send test event** | `actor` = the owner who pressed it, `url` (workspace) |

What is **never** sent:
- anything about a page in someone's private (🔒) section, a deleted page, or a page moved to another
  workspace; events are checked again at delivery time, so an event whose page became private before
  it was sent is dropped;
- comment text and page content. Fetch them through the REST API with a personal token if the receiver
  needs them, so the receiver's access is that token's access;
- e-mail addresses.

## Verifying the signature

`v1` is the lowercase hex HMAC-SHA256 of the string `<t>.<raw request body>`, keyed with the whole
secret string (`whsec_…`, as UTF-8 bytes). To verify:

1. Read the **raw** body bytes. Do not parse and re-serialise the JSON first: any change of
   whitespace or key order breaks the signature (in Express use `express.raw({ type: 'application/json' })`
   for this route, not `express.json()`).
2. Split the header on `,`; take `t` and every `v1`.
3. Reject when `t` is more than **5 minutes** away from your clock (replay protection; keep the
   receiver's clock synchronised with NTP).
4. Compute the HMAC of `t + "." + body` and compare it with each `v1` in **constant time**. Accept if
   any matches (there are two while a rotated secret is still valid).
5. Then drop the request if you already processed its `X-Inkling-Delivery` id (see below).

Node.js (no dependencies):

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyInkling(header, rawBody, secret, toleranceSeconds = 300) {
  const parts = String(header ?? '').split(',').map((p) => p.split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest()
  return parts.some(([k, v]) => {
    if (k !== 'v1') return false
    const got = Buffer.from(v ?? '', 'hex')
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}

// node:http: collect the raw body, verify, then parse.
// const raw = Buffer.concat(chunks)
// if (!verifyInkling(req.headers['x-inkling-signature'], raw, process.env.INKLING_WEBHOOK_SECRET)) return res.writeHead(401).end()
// const event = JSON.parse(raw.toString('utf8'))
```

Python (standard library):

```python
import hashlib, hmac, time

def verify_inkling(header: str, raw_body: bytes, secret: str, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in (header or "").split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    if t is None or not t.isdigit() or abs(time.time() - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(k == "v1" and hmac.compare_digest(v, expected) for k, v in parts)

# Flask: verify_inkling(request.headers.get("X-Inkling-Signature"), request.get_data(), SECRET)
```

## Responding, retries and duplicates

- Answer with any **2xx** within 8 seconds. Do slow work after answering (queue it).
- **5xx**, **429**, timeouts and connection errors are retried after about 2 s, 10 s and 50 s (four
  attempts in total, about a minute). A `Retry-After` header on 429 is honoured up to 60 s.
- **4xx** (other than 429) and **3xx** are not retried: they mean the request will not be accepted as
  it is.
- Delivery is **at least once**. A crash of the Inkling server after your endpoint answered but before
  it recorded the answer sends the same delivery again; an owner can also send any recent delivery
  again by hand (done deliveries for 7 days, failed ones for 30). Every copy has the same
  `X-Inkling-Delivery` and body `id`, so keep the ids you processed (30 days covers every path) or make
  the handler idempotent.
- There is **no ordering** guarantee between deliveries: use `occurredAt` if order matters.
- At most 20 deliveries per workspace are sent in a burst, then about one every 3 seconds; at most 200
  can wait per workspace, newer events are dropped beyond that.

## Delivery list

Each webhook has a **Recent deliveries** list (the latest 30 are shown, about the newest 100 are kept): event, result (HTTP status or
error), time taken, attempts, the next retry time, and for non-2xx answers the first 200 printable
characters of your response body (2xx bodies are never stored). **Resend** queues the delivery again
with the same id; it is re-checked (privacy) and re-signed at that moment.

## Rotating the secret

**New secret** creates a new secret and shows it once. For the next 24 hours every request carries two
`v1` signatures, one per secret, so you can deploy the new secret without missing events; after that
only the new one is used. Tick **Stop using the old secret at once** first if the old secret leaked.

Secrets (and URLs) are encrypted in the database with `APP_SECRET_KEY` when the server has one
([ADR 1111](adr/1111-webhook-and-sheet-urls-sealed-at-rest.md)). If that key is removed or changed,
deliveries fail with "Signing secret cannot be decrypted" until a new secret is created.

## Automatic disabling

A generic webhook is turned off when its last five or more events all failed **and** the first of those
failures is at least 24 hours old. A short outage (a deploy, a restart) therefore does not turn it off,
while an endpoint that is gone stops being called after a day. Workspace owners get a notification;
**Enabled** turns it back on and resets the count. Slack and Discord webhooks keep their rule: five
failed events in a row.
