# Inkling 웹훅 받기

워크스페이스 소유자는 워크스페이스에서 일어난 이벤트를 아무 https 주소로 보낼 수 있습니다. n8n, Zapier, Make, 서버리스 함수, 직접 만든 서버 모두 됩니다. 이 문서는 받는 쪽 프로그램을 만드는 분을 위한 것입니다. Slack과 Discord 웹훅도 같은 곳에서 설정하지만, 그쪽에는 여기서 설명하는 JSON이 아니라 채팅 메시지가 갑니다. English: [WEBHOOKS.md](WEBHOOKS.md).

이렇게 설계한 이유는 [ADR 1190](adr/1190-generic-webhooks-and-signatures.md)(페이로드, 서명, 비밀, SSRF), [ADR 1191](adr/1191-webhook-delivery-records-and-resend.md)(전송 목록, 다시 보내기), [ADR 1192](adr/1192-generic-webhook-auto-disable.md)(자동으로 끄기)에 적어 두었습니다. 전송 자체는 트랜잭션 아웃박스를 거칩니다([ADR 1081](adr/1081-notifications-and-webhooks-through-the-outbox.md)).

<a id="setting-one-up"></a>
## 웹훅 만들기

워크스페이스 설정(`Workspace settings`) › **웹훅**(`Webhooks`)에서 종류를 **범용 (JSON)**(`Generic (JSON)`)으로 고르고, URL을 넣고, 받을 이벤트를 고른 뒤 **웹훅 추가**(`Add webhook`)를 누릅니다. 서명 비밀(`whsec_…`)은 만든 직후에 **한 번만** 보여 줍니다. 받는 쪽에 저장해 두세요. Inkling은 이 값을 다시 보여 주지 않습니다. 새 비밀을 만들 수는 있습니다([비밀 바꾸기](#rotating-the-secret) 참고).

URL은 기본 포트(443)를 쓰는 `https://` 주소여야 하고, 사용자 이름, 비밀번호, `#fragment`가 들어 있으면 안 됩니다. 쿼리 문자열은 넣어도 됩니다. 호스트는 공개 인터넷 주소로만 풀려야 합니다. 루프백, 사설 주소(10/8, 172.16/12, 192.168/16), 링크 로컬(169.254/16, 클라우드 메타데이터), CGNAT, IPv6 ULA 같은 주소는 웹훅을 저장할 때 거절하고, 전송할 때마다 다시 확인해서 거절합니다. 연결은 확인을 마친 바로 그 주소로 맺기 때문에, 확인과 연결 사이에 DNS를 바꾸더라도 연결을 다른 주소로 돌릴 수 없습니다.

**테스트 이벤트 보내기**(`Send test event`)를 누르면 `type: "test"` 이벤트가 바로 갑니다. 실제 이벤트가 오기 전에 서명 확인 코드를 시험해 볼 수 있습니다.

<a id="the-request"></a>
## 요청

```
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: Inkling-Webhooks/1
X-Inkling-Delivery: 48213
X-Inkling-Event: comment
X-Inkling-Signature: t=1762500000,v1=5f2b…c9e1
```

| 헤더 | 뜻 |
|---|---|
| `X-Inkling-Delivery` | 이 전송의 id입니다. 재시도할 때도, 소유자가 손으로 다시 보낼 때도 값이 같습니다. 본문의 `id`와 같은 값입니다. 중복을 걸러 낼 때 쓰세요. |
| `X-Inkling-Event` | 이벤트 종류(`comment`, `mention`, … 또는 `test`)입니다. 본문의 `type`과 같습니다. |
| `X-Inkling-Signature` | `t=<unix seconds>`와 하나 이상의 `v1=<hex>` 서명입니다(아래 참고). `t`는 이번 시도의 시각이므로 재시도하면 새 `t`가 붙습니다. |

Inkling은 응답을 최대 8초(연결은 3초) 기다리고, 응답은 16 KiB까지만 읽습니다. 리다이렉트는 따라가지 **않습니다**. 3xx 응답은 전송 실패로 칩니다.

<a id="the-body-version-1"></a>
## 본문 (버전 1)

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

공통 필드:

| 필드 | 타입 | 설명 |
|---|---|---|
| `version` | `1` | 같은 버전 안에서는 필드가 **늘어나기만** 합니다. 필드를 빼거나 뜻을 바꿀 때는 버전을 올립니다. 모르는 필드는 무시하세요. |
| `id` | string | 전송 id이고 `X-Inkling-Delivery`와 같습니다. 테스트 이벤트는 `test_<uuid>`를 씁니다. |
| `type` | string | 아래 이벤트 가운데 하나이거나 `test`입니다. |
| `occurredAt` | ISO 8601 | 이벤트가 큐에 들어간 시각입니다. 이번 시도의 시각이 아닙니다. |
| `workspace` | `{ id, name }` | |
| `actor` | `{ id, name, via }` 또는 `null` | 이벤트를 일으킨 사람입니다. 에이전트가 한 일이면 `via`에 AI 연결(MCP / OAuth 클라이언트)의 이름이 들어갑니다. 리마인더와 요약, 그리고 그 사람이 더는 없을 때는 `null`입니다. |

링크(`url`)는 서버에 `APP_URL`이나 `PUBLIC_URL`이 설정되어 있을 때만 들어가고, 아니면 `null`입니다. 링크는 Inkling에서 열리고, 다른 페이지 링크와 마찬가지로 로그인한 멤버만 볼 수 있습니다.

이벤트 목록은 Slack, Discord와 같습니다. 웹훅은 체크해 둔 이벤트만 받습니다.

| `type` | 언제 | 더 붙는 필드 |
|---|---|---|
| `comment` | 공유 페이지에 코멘트가 달렸을 때 | `page`, `comment: { id }` |
| `mention` | 코멘트에서 멤버를 @멘션했을 때 | `page`, `comment: { id }`, `users: [{ id, name }]`(멘션된 멤버) |
| `reminder` | 페이지의 마감일이 오늘일 때 | `page` |
| `page_created` | 공유 구역에 페이지가 생겼을 때(20초 뒤에 보냅니다. 그사이 개인 구역으로 옮겨졌거나 지워졌으면 보내지 않습니다) | `page` |
| `assigned` | 멤버가 문서 소유자가 되었거나 사람 칸에 들어갔을 때 | `page`, `users: [{ id, name }]`, `field`(사람 필드의 이름 또는 `owner`) |
| `review_due` | 매일: 검토일이 지난 공유 문서 | `pages: [{ id, title, url, owner }]`(≤ 50), `total`, `url`(검토 화면) |
| `agent_digest` | 매일: 지난 하루 동안 AI 연결이 편집한 공유 페이지 | `pages: [{ id, title, url, owner: null }]`(≤ 50), `total`, `url`(활동 화면) |
| `test` | **테스트 이벤트 보내기** | `actor` = 버튼을 누른 소유자, `url`(워크스페이스) |

다음은 **절대** 보내지 않습니다.
- 누군가의 개인(🔒) 구역에 있는 페이지, 지운 페이지, 다른 워크스페이스로 옮긴 페이지에 관한 것. 이벤트는 전송할 때 한 번 더 확인하므로, 보내기 전에 페이지가 개인 페이지로 바뀌었으면 그 이벤트는 버립니다.
- 코멘트 글과 페이지 내용. 받는 쪽에 필요하면 개인 토큰으로 REST API에서 가져오세요. 그러면 받는 쪽이 볼 수 있는 범위가 그 토큰의 범위와 같아집니다.
- 이메일 주소.

<a id="verifying-the-signature"></a>
## 서명 확인

`v1`은 `<t>.<raw request body>` 문자열의 HMAC-SHA256 값을 소문자 16진수로 적은 것입니다. 키는 비밀 문자열 전체(`whsec_…`, UTF-8 바이트)입니다. 확인하는 순서는 이렇습니다.

1. 본문을 **가공하지 않은 바이트** 그대로 읽습니다. JSON을 먼저 파싱했다가 다시 직렬화하면 안 됩니다. 공백이나 키 순서가 조금만 바뀌어도 서명이 맞지 않습니다(Express라면 이 경로에는 `express.json()`이 아니라 `express.raw({ type: 'application/json' })`를 쓰세요).
2. 헤더를 `,`로 나누고 `t`와 모든 `v1`을 꺼냅니다.
3. `t`가 내 시계와 **5분** 넘게 차이 나면 거절합니다. 재전송 공격을 막기 위해서이니, 받는 쪽 시계는 NTP로 맞춰 두세요.
4. `t + "." + body`의 HMAC을 계산해서 각 `v1`과 **상수 시간**으로 비교합니다. 하나라도 맞으면 받아들입니다. 비밀을 바꾼 뒤 이전 비밀이 아직 유효한 동안에는 `v1`이 두 개입니다.
5. 그다음, 이미 처리한 `X-Inkling-Delivery` id라면 그 요청은 버립니다(아래 참고).

Node.js(의존성 없음):

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

끝의 주석은 `node:http`에서 쓰는 예입니다. 가공하지 않은 본문을 모아 서명을 확인한 다음에 파싱합니다.

Python(표준 라이브러리):

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

끝의 주석은 Flask에서 부르는 예입니다.

<a id="responding-retries-and-duplicates"></a>
## 응답, 재시도, 중복

- 8초 안에 아무 **2xx**로 답하세요. 오래 걸리는 일은 답한 다음에 하세요(큐에 넣어 두는 식으로).
- **5xx**, **429**, 시간 초과, 연결 오류는 약 2초, 10초, 50초 뒤에 다시 시도합니다. 모두 네 번 시도하고, 다 합쳐 1분쯤 걸립니다. 429에 `Retry-After` 헤더가 있으면 60초까지는 그 값을 따릅니다.
- **4xx**(429 제외)와 **3xx**는 다시 시도하지 않습니다. 요청을 지금 모양 그대로는 받지 않겠다는 뜻이기 때문입니다.
- 전송은 **적어도 한 번**(at least once) 갑니다. 받는 쪽이 답한 뒤, Inkling 서버가 그 답을 기록하기 전에 죽으면 같은 전송을 다시 보냅니다. 소유자가 최근 전송을 손으로 다시 보낼 수도 있습니다(끝난 전송은 7일, 실패한 전송은 30일 동안). 사본은 모두 `X-Inkling-Delivery`와 본문 `id`가 같습니다. 처리한 id를 보관하거나(30일이면 모든 경우가 들어갑니다), 같은 전송을 여러 번 받아도 결과가 같도록(멱등하게) 처리 코드를 만드세요.
- 전송 사이의 **순서는 보장하지 않습니다**. 순서가 중요하면 `occurredAt`을 쓰세요.
- 한 워크스페이스에서 한꺼번에 보내는 것은 20개까지이고, 그 뒤로는 약 3초에 하나씩 보냅니다. 워크스페이스마다 기다릴 수 있는 것은 200개까지이고, 그보다 많아지면 새로 생긴 이벤트를 버립니다.

<a id="delivery-list"></a>
## 전송 목록

웹훅마다 **최근 전송**(`Recent deliveries`) 목록이 있습니다(최근 30개를 보여 주고, 대략 최근 100개를 보관합니다). 이벤트, 결과(HTTP 상태 또는 오류), 걸린 시간, 시도 횟수, 다음 재시도 시각이 나오고, 2xx가 아닌 답이면 응답 본문에서 출력할 수 있는 문자를 앞에서부터 200자까지 보여 줍니다(2xx 본문은 저장하지 않습니다). **다시 보내기**(`Resend`)는 같은 id로 전송을 다시 큐에 넣습니다. 보내는 그 순간에 개인 페이지 여부를 다시 확인하고 서명도 새로 합니다.

<a id="rotating-the-secret"></a>
## 비밀 바꾸기

**새 비밀**(`New secret`)을 누르면 새 비밀을 만들고 한 번 보여 줍니다. 그 뒤 24시간 동안은 요청마다 비밀 하나에 하나씩, 모두 두 개의 `v1` 서명이 붙습니다. 그래서 이벤트를 놓치지 않고 받는 쪽에 새 비밀을 배포할 수 있습니다. 24시간이 지나면 새 비밀만 씁니다. 이전 비밀이 새어 나갔다면 먼저 **이전 비밀 바로 버리기**(`Stop using the old secret at once`)에 체크하세요.

서버에 `APP_SECRET_KEY`가 있으면 비밀(과 URL)을 이 키로 암호화해서 데이터베이스에 저장합니다([ADR 1111](adr/1111-webhook-and-sheet-urls-sealed-at-rest.md)). 이 키를 지우거나 바꾸면 새 비밀을 만들 때까지 전송이 "Signing secret cannot be decrypted"(서명 비밀을 복호화할 수 없음) 오류로 실패합니다.

<a id="automatic-disabling"></a>
## 자동으로 끄기

범용 웹훅은 마지막 이벤트 다섯 개 이상이 모두 실패했고 **동시에** 그 실패 가운데 첫 번째가 24시간 이상 지났을 때 꺼집니다. 그래서 배포나 재시작 같은 짧은 중단으로는 꺼지지 않고, 없어진 엔드포인트는 하루가 지나면 더는 부르지 않습니다. 워크스페이스 소유자에게 알림이 갑니다. **사용**(`Enabled`)을 다시 켜면 웹훅이 켜지고 실패 횟수도 처음부터 다시 셉니다. Slack과 Discord 웹훅은 원래 규칙대로 이벤트 다섯 개가 연달아 실패하면 꺼집니다.
