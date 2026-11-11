# Inkling 배포 안내 (리눅스 서버)

모든 이미지는 멀티 아키텍처(x86-64와 ARM64)로 나옵니다. 그래서 ARM 클라우드 VM(예를 들면 무료 등급 Ampere 인스턴스)에서도, 보통의 x86 서버에서도 같은 설정으로 돌아갑니다. English: [DEPLOY.md](DEPLOY.md).

> **내 컴퓨터에서 써 보기만 하실 건가요?** `git clone <repo-url> && cd inkling && ./deploy/local.sh`를 실행하면 스크립트가 비밀값을 만들어 `.env`를 쓰고, 127.0.0.1에 묶인 빈 포트로 스택을 띄운 뒤 첫 관리자 계정을 만드는 한 번용 링크를 보여 줍니다(맨 끝의 "로컬 체험" 참고). 이 문서의 나머지는 다른 사람들이 접속하는 서버를 위한 내용입니다.

<a id="1-prepare-the-server-ubuntu-2204"></a>
## 1. 서버 준비 (Ubuntu 22.04)

Docker를 설치하고 지금 사용자를 `docker` 그룹에 넣습니다. 그룹은 다시 로그인해야 적용됩니다. 그다음 방화벽이나 보안 목록에서 80, 443 포트로 들어오는 연결을 열어 주세요. OCI라면 콘솔의 Security List에서도 열어야 합니다.

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log in again afterwards

# Firewall / security list: allow inbound 80 and 443 (in the OCI console's Security List too!)
```

<a id="2-code--environment"></a>
## 2. 코드와 환경 설정

저장소를 `/opt/inkling`에 받고 `.env.example`을 `.env`로 복사합니다. `.env`에서는 `POSTGRES_PASSWORD`를 강한 값으로 바꿔 주세요. 이 비밀번호는 Docker 네트워크 안에서 쓰입니다. `INKLING_DATA_NAME=inkling`은 그대로 둡니다. 이 값이 compose 프로젝트와 볼륨, 데이터베이스의 이름이 됩니다.

```bash
git clone <repo-url> /opt/inkling && cd /opt/inkling
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD to a strong value! (used inside the Docker network)
# Leave INKLING_DATA_NAME=inkling as it is (the compose project, volume and database names)
```

저장소는 `compose.yaml`, Caddy 오버레이, `deploy/*.sh` 스크립트 때문에 여전히 받아 두어야 합니다. 앱 자체는 미리 빌드된 이미지 `ghcr.io/prove1352/inkling`(linux/amd64, linux/arm64)으로 받아 오기 때문에 서버에서 빌드를 돌릴 일은 없습니다. 빌드에는 메모리가 1 GB 넘게 듭니다.

<a id="image-or-source-build"></a>
### 이미지로 받기와 소스에서 빌드하기

| | 배포된 이미지(기본) | 소스 빌드 |
|---|---|---|
| 시작 / 업데이트 | `docker compose pull app && docker compose up -d app` | `docker compose -f compose.yaml -f compose.build.yaml up -d --build app` |
| 버전 | `.env`의 `INKLING_VERSION`. 릴리스를 `X.Y.Z`(그 버전 그대로)나 `X.Y`(그 안의 최신 패치)로 적거나, 비워 둡니다(= `latest`) | 지금 체크아웃한 코드 |
| 이미지 이름 | `ghcr.io/prove1352/inkling:<version>` | `inkling:local`(받아 오지 않음) |

`compose.yaml`은 배포된 이미지 이름을 적어 두면서 `build: .`**도** 그대로 갖고 있습니다. 그래서 `docker compose up -d --build`를 하면 예전과 똑같이 소스에서 빌드합니다. 다만 빌드 결과에 배포된 이미지 이름이 붙기 때문에, 나중에 `docker compose pull`을 하면 릴리스 이미지로 바뀌어 버립니다. 로컬에 이미지가 없거나 pull이 실패하면(예를 들어 오프라인일 때) `up`은 빌드로 넘어갑니다. 포크, 로컬 패치, 아직 릴리스하지 않은 `main`처럼 일부러 소스로 배포하신다면 둘이 섞이지 않도록 `compose.build.yaml`을 쓰세요. HTTPS를 쓸 때는 이 파일을 맨 뒤에 둡니다(`-f compose.yaml -f deploy/compose.caddy.yaml -f compose.build.yaml`). 이미 `compose.override.yaml`(`-f`를 주지 않으면 저절로 읽힙니다)을 쓰고 계시면 대신 그 파일의 `app:` 아래에 다음 두 줄을 넣으세요.

```yaml
services:
  app:
    image: inkling:local
    pull_policy: never
```

<a id="language-and-time-zone"></a>
### 언어와 시간대

- `DEFAULT_LOCALE`(`en` | `ko`, 기본값 `en`): 언어를 고르지 않은 사용자에게 가는 메일과 기본 템플릿의 언어이고, 브라우저 언어를 적용하기 전 웹 화면의 기본값입니다. 사용자는 각자 설정 › 모양 › 언어(`Settings › Appearance › Language`)에서 자기 언어를 고릅니다.
- `TZ`(컨테이너 시간대, 기본값 `UTC`): 마감일, 데일리 노트, 알림에서 "오늘"이 언제인지를 정하고, 메일에 찍히는 시각도 이 시간대를 따릅니다.

한국에서 운영하신다면 `.env`에 이렇게 넣으세요.

```bash
DEFAULT_LOCALE=ko
TZ=Asia/Seoul
```

<a id="3-a-plain-http-internal-network--testing-only"></a>
## 3-A. 일반 HTTP (내부망이나 테스트 전용)

```bash
docker compose up -d     # → http://<server-ip>:3000
```

> **로컬이 아닌 호스트(인터넷에 열린 서버)에서는 3-B의 Caddy 오버레이가 꼭 필요합니다.** 기본 `compose.yaml`만 띄우면 앱이 3000 포트에서 암호화되지 않은 HTTP로 열립니다(DB 포트는 루프백에만 묶입니다). 그러니 로컬이나 내부 테스트에만 쓰세요. 공개 서버는 반드시 Caddy(HTTPS) 뒤에 두어야 합니다. 그래야 Secure 쿠키가 켜지고 앱과 DB 포트가 밖에서 보이지 않습니다.

<a id="3-b-domain--https-recommended--pwa-install-and-the-clipboard-api-need-it-too"></a>
## 3-B. 도메인 + HTTPS (권장, PWA 설치와 클립보드 API에도 필요)

1. DNS에서 도메인(A 레코드)이 서버 IP를 가리키게 합니다. 도메인이든 서브도메인이든 상관없습니다.
2. `.env`(`.env.example`을 복사한 파일)에 이미 있는 두 줄을 채웁니다. `PUBLIC_URL`은 메일 링크와 OAuth 발급자에 쓰이고, 배포 스크립트도 이 값을 읽습니다.
   ```dotenv
   DOMAIN=notes.example.com
   PUBLIC_URL=https://notes.example.com   # mail links, OAuth issuer; also read by the deploy scripts
   ```
   그다음 오버레이를 붙여서 띄웁니다.
   ```bash
   docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d
   ```
3. Caddy가 인증서를 자동으로 받아 오고, `https://<domain>`으로 열립니다. 쿠키도 자동으로 Secure 모드(COOKIE_SECURE=1)로 바뀝니다.

<a id="3-c-accounts--issuing-signup-keys"></a>
## 3-C. 계정과 가입 키 발급

Inkling 계정은 **가입 키**가 있어야만 만들 수 있습니다(위임 로그인을 켜 두었다면 외부 계정으로도 들어올 수 있습니다. 3-D 참고). `NODE_ENV=production`(compose 기본값)에서는 `SIGNUP_REQUIRE_KEY`가 비어 있어도 가입 키가 필요합니다. 키 없이 누구나 가입하게 하려면 `.env`에 `SIGNUP_REQUIRE_KEY=0`을 직접 적어야 합니다.

**첫 관리자.** 데이터베이스에 계정이 하나도 없는 동안에는 서버가 시작할 때마다 한 번만 쓰는 설정 링크를 로그에 찍습니다(0.17, docs/adr/2160-*).

```bash
docker compose logs app | grep setup     # → https://notes.example.com/setup?code=XXXX-XXXX-…
```

이 링크를 연 사람이 첫 계정을 만들고, 그 계정이 관리자가 됩니다. 코드는 서버 메모리에만 있고 한 번만 쓸 수 있습니다. 어떤 방법으로든 계정이 하나라도 생기면 바로 쓸 수 없게 되고, 계정이 없는 채로 다시 시작하면 새 링크가 찍힙니다. "localhost에서 온 요청이면 허용"하는 방식이 아닙니다. 프록시 뒤에서는 모든 요청이 로컬에서 온 것처럼 보이기 때문입니다. 서버 로그를 읽을 수 있는 사람이라면 이미 서버를 운영할 수 있는 사람이므로, 이 링크가 증명하는 것은 `signup-key.sh`로 만든 키(psql INSERT)와 같습니다. 컨테이너 로그를 다른 사람도 읽는 곳으로 보내고 있다면 처음 띄운 직후에 첫 계정을 만들거나, 링크 대신 키를 쓰세요. 이 키로 가장 먼저 가입한 사람이 관리자가 됩니다.

```bash
./deploy/signup-key.sh new "me"     # the first person to sign up with this key becomes admin
```

관리자가 한 명도 없는 동안에는 처음 가입하거나 로그인한 사람이 자동으로 관리자가 됩니다(새로 설치한 서버를 위한 처리입니다). 그다음부터는 관리자들이 관리자 화면에서 서로 관리자 역할을 주고 뺍니다. 마지막 남은 관리자는 강등하거나 탈퇴시킬 수 없습니다.

**웹 관리자 페이지(권장).** 관리자 계정으로 로그인하면 사이드바에 관리자(`Admin`)가 나타납니다(`/w/<workspace>/admin`, 처리하지 않은 비밀번호 재설정 요청이 있으면 숫자 배지가 붙습니다). 여기서 키를 발급하고 회수하고(초대 메일 포함), 사용자를 관리하고(비밀번호 재설정, 이메일 인증, 관리자 역할, 강제 탈퇴), 비밀번호 재설정 요청을 처리하고, 차단된 IP를 관리합니다. 목록은 최신 5개씩 보여 주고 검색할 수 있습니다.

SQL로 바로 관리자를 지정해야 할 때는 이렇게 합니다.

```bash
docker compose exec -T db psql \
  -c "UPDATE users SET is_admin=true WHERE email='someone@example.com'"
```

**CLI(비상용).** 웹 화면이 죽었거나 관리자 계정이 잠겼을 때 씁니다. `new "friend A"`는 한 번만 쓸 수 있고 만료되지 않는 키를, `new "study" 5 30`은 5번 쓸 수 있고 30일 뒤 만료되는 키를 만듭니다. `list`는 발급한 키를 보여 주고, `revoke <KEY>`는 키를 지웁니다(이미 만든 계정은 남습니다). `reset-password.sh`는 임시 비밀번호를 발급하고 그 계정의 로그인을 모두 끊습니다.

```bash
./deploy/signup-key.sh new "friend A"     # single use, never expires
./deploy/signup-key.sh new "study" 5 30   # 5 uses, expires in 30 days
./deploy/signup-key.sh list               # list issued keys
./deploy/signup-key.sh revoke <KEY>       # delete a key (accounts already created stay)
./deploy/reset-password.sh someone@example.com   # issue a temporary password + log that account out
```

키를 받은 사람은 `https://<domain>/register?key=<KEY>`에서 가입하거나 `/register`에서 키를 입력하고, 이메일과 이름, 비밀번호를 정합니다.

**비밀번호를 잊었을 때.**

- 로그인 화면에서 '비밀번호를 잊었나요?'(`Forgot your password?`)를 누르면 `/reset`으로 갑니다.
  - *코드가 있어요*(`I have a code`): 이메일, 코드, 새 비밀번호를 넣습니다. 코드는 관리자가 발급한 한 번용 재설정 코드(24시간 유효)이거나, 그 사람이 가입할 때 쓴 **한 사람용(1회) 가입 키**입니다. 여러 사람이 같이 쓴 가입 키로는 재설정할 수 없습니다.
  - *코드가 없어요*(`I don't have a code`): 관리자에게 재설정 요청을 보냅니다(메모를 붙일 수 있습니다). 계정 이메일이 인증되어 있고 메일이 켜져 있으면 관리자를 거치지 않고 재설정 메일이 자동으로 나갑니다. 계정이 있든 없든 응답은 똑같습니다.
- 관리자: 요청 행이나 사용자 행에서 '재설정 코드'(`Reset code`)나 '임시 비밀번호'(`Temporary password`)를 발급하면 화면에 한 번만 보여 줍니다(복사하거나 메일로 보냅니다). 어느 쪽이든 그 사람의 기존 로그인은 모두 끊깁니다. DB에는 재설정 코드의 해시만 저장됩니다.
- 사용자 본인: 설정 › 계정(`Settings › Account`)에서 지금 비밀번호를 넣고 바꿉니다(다른 기기는 로그아웃되고 지금 쓰는 기기는 그대로입니다).
- 위임 로그인 계정은 비밀번호가 외부 인증 서버에 있으므로 위 내용이 모두 해당되지 않습니다.

**강제 탈퇴.** 관리자 화면의 사용자 행에서 '탈퇴'(`Remove`)를 누릅니다. users 행이 지워지면서 세션, 워크스페이스 멤버십, 즐겨찾기, 그 사람이 받은 알림, MCP 연결도 함께 지워집니다. 페이지, 파일, 코멘트, 스냅샷, 템플릿, 워크스페이스는 작성자 칸만 비운 채(SET NULL) 남습니다. 그 사람이 썼던 가입 키는 사용 횟수가 하나 돌아옵니다. 그 사람이 혼자 소유한 워크스페이스가 있으면 409 `SOLE_OWNER`와 해당 워크스페이스 목록을 돌려주며 거절합니다. 다른 멤버를 먼저 소유자로 올린 다음 다시 시도하세요. 그 사람의 개인 페이지는 작성자 없이 휴지통으로 가고, 관리자를 포함해 아무도 볼 수 없으며, 30일 뒤 영구 삭제됩니다. 본인이 원하면 탈퇴 전에 내보내기를 권해 주세요.

<a id="3-d-delegated-login-optional"></a>
## 3-D. 위임 로그인 (선택)

`DELEGATED_AUTH_URL`을 설정하면 Inkling이 모르는 아이디로 로그인할 때 그 외부 인증 서버에 확인을 맡깁니다. 이 연동은 **로그인 한 방향으로만** 이뤄집니다. Inkling 계정의 비밀번호는 밖으로 나가지 않고, Inkling 자체 계정(이메일이 일치하는 로컬 계정)은 언제나 Inkling 안에서 확인합니다.

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `DELEGATED_AUTH_URL` | 외부 인증 서버의 origin(경로 없이 스킴과 호스트까지만, 예: `https://auth.example.com`) | 없음(꺼짐) |
| `DELEGATED_AUTH_NAME` | 로그인 화면과 관리자 화면에 보이는 이름 | "External account" |
| `DELEGATED_EMAIL_DOMAIN` | Inkling 쪽에 만들어 두는 위임 계정의 이메일 도메인(`<id>@<domain>`, 실제로 메일을 보내지는 않습니다) | `delegated.local` |

`DELEGATED_EMAIL_DOMAIN`은 처음 정한 값을 그대로 두세요. 바꾸면 기존 위임 계정과 짝이 맞지 않아서 같은 사람에게 계정이 새로 생깁니다. 위임 로그인을 켜면 가입 키 요구도 자동으로 켜집니다.

**외부 인증 서버가 지켜야 할 약속:**

```
POST <DELEGATED_AUTH_URL>/api/auth/login
Content-Type: application/json
{"username": "<id>", "password": "<password>"}
```

| 외부 서버의 응답 | Inkling의 처리 |
|---|---|
| 200 + `{"access_token": "<non-empty string>"}` | 성공. Inkling 사용자 중에서 `<id>@<DELEGATED_EMAIL_DOMAIN>`을 찾고, 없으면 만든 뒤 Inkling 세션을 발급합니다. 토큰은 버리고, 저장하거나 다른 곳에 넘기지 않습니다. |
| 200 + `{"totp_required": true}` | 401 `TOTP_UNSUPPORTED`(2단계 인증을 쓰는 계정은 지원하지 않습니다) |
| 401 | 401 `INVALID_CREDENTIALS`(로컬 로그인이 실패했을 때와 같은 메시지) |
| 429 | 429 `RATE_LIMITED` |
| 5xx, 네트워크 오류, 10초 타임아웃, 그 밖의 모든 경우 | 503 `AUTH_UPSTREAM_UNAVAILABLE` |

<a id="3-e-mail-optional"></a>
## 3-E. 메일 (선택)

`SMTP_HOST`와 `MAIL_FROM`을 설정하면 켜집니다(그 밖에 `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, 링크에 넣을 주소 `APP_URL`이 있습니다). 꺼져 있으면 관련 버튼이 숨겨지고, 복사해서 붙여 넣는 방법만 남습니다.

- 관리자: 재설정 코드, 임시 비밀번호, 가입 키(초대)에 '이메일로 보내기'(`Send by email`)가 생깁니다. 받는 사람은 기본으로 그 사용자의 이메일이고 바꿀 수 있습니다(위임 계정처럼 가짜 도메인이면 비어 있습니다).
- 메일 속 링크는 `/reset?email=&code=`, `/register?key=`, `/verify?token=`입니다. 링크를 열면 화면에 값이 미리 채워져 있습니다.
- 이메일 인증: 가입 직후 인증 메일이 가고, 설정 › 계정과 로그인 화면에서 다시 보낼 수 있습니다. 관리자 화면에는 '인증 메일'(`Verification email`)과 '인증됨 처리'(`Mark verified`)가 있습니다. 기존 계정은 미인증으로 표시만 되고 로그인이 막히지는 않습니다. `REQUIRE_EMAIL_VERIFICATION=1`이면 **그 뒤로** 가입한 사람은 인증하기 전까지 로그인할 수 없습니다.
- 이메일이 인증된 계정에서 '비밀번호를 잊었나요?'를 누르면 관리자 대기열을 거치지 않고 재설정 메일이 나갑니다(5분에 최대 한 통).
- 서버 로그에는 받는 사람의 도메인과 SMTP 오류 코드만 남습니다(코드, 비밀번호, SMTP_PASS는 남기지 않습니다).

<a id="3-f-brute-force-protection"></a>
## 3-F. 무차별 대입 공격 막기

로그인, 비밀번호 재설정, 가입 키, 이메일 인증 토큰, 재설정 요청, 위임 로그인, MCP OAuth 인가와 토큰 교환, 공개 공유 링크(없는 토큰)의 **실패**를 IP마다 셉니다. 기본값으로는 15분 안에 10번 실패하면 그 IP를 15분 동안 막고, 다시 막힐 때마다 1시간, 6시간, 24시간(상한)으로 늘어납니다(마지막 차단 뒤 7일이 지나면 단계가 처음으로 돌아갑니다). 막혀 있는 동안 429와 `Retry-After`를 돌려주는 것은 인증과 토큰 경로뿐이고, 로그인한 사용자가 쓰는 일반 API는 막지 않습니다. IPv6는 /64 단위로 셉니다. 계정은 잠그지 않습니다. 한 계정이 5번 넘게 실패하면 다음 시도까지 기다리는 시간만 1초, 2초, 4초… 식으로 늘어나 최대 5분까지 갑니다. 한 번 성공하면 카운터가 초기화됩니다.

- 실제 클라이언트 IP는 `TRUST_PROXY`에 맞는 앞단 프록시가 붙인 `X-Forwarded-For`에서만 가져옵니다. 기본값은 `loopback,uniquelocal`이고, 같은 호스트의 Caddy(127.0.0.1)와 Docker 브리지(172.16/12 등)를 거쳐 오는 연결이 여기에 해당합니다. 인터넷에서 바로 들어온 연결의 XFF는 무시합니다. 앞단 프록시가 다른 곳에 있다면 이 값을 그 주소나 CIDR로 바꾸세요.
- `ALLOWLIST_IPS`에 적은 IP와 CIDR은 절대 막지 않습니다(관리자 화면에 보입니다).
- 차단 기록은 `ip_bans` 테이블에 남아서 재시작해도 유지됩니다. 관리자 화면의 '차단된 IP'(`Banned IPs`)에서 풀 수 있습니다(직접 차단하는 것도 되는데, 지금 접속한 IP는 막을 수 없습니다). SQL로 빨리 풀려면 아래처럼 합니다. 두 번째 명령은 메모리에 있는 차단 목록까지 비우려고 앱을 다시 시작하는 것입니다.

```bash
docker compose exec -T db psql \
  -c "UPDATE ip_bans SET banned_until = now() WHERE banned_until > now()"
docker compose restart app   # to clear the in-memory ban list as well
```

- 조정할 수 있는 값: `AUTH_GUARD_WINDOW_MINUTES`, `AUTH_GUARD_MAX_FAILURES`, `AUTH_GUARD_BAN_MINUTES`, `AUTH_GUARD_BAN_MAX_HOURS`, `AUTH_GUARD_ACCOUNT_FAILURES`.
- 요청 속도 제한(@fastify/rate-limit: 전체 분당 300회, 인증은 분당 10회 등)은 이와 따로 계속 동작하고, 같은 429 `RATE_LIMITED` 형식을 씁니다.

<a id="3-g-openid-connect-sign-in-optional"></a>
## 3-G. OpenID Connect 로그인 (선택)

로그인 화면에 "`<name>`로 로그인"(`Sign in with <name>`) 버튼이 생깁니다. Google Workspace, Microsoft Entra ID, Keycloak, Authentik 같은 OpenID Connect 제공자와 함께 쓸 수 있습니다. 비밀번호는 제공자 쪽에 있고, Inkling은 서명된 id_token을 받아 평소와 같은 세션을 발급합니다(docs/adr/1160-*). 비밀번호 로그인도 그대로 함께 쓸 수 있습니다.

1. 제공자에 Inkling을 기밀 웹 클라이언트(authorization code flow)로 등록하고, 리디렉션 URI는 `<PUBLIC_URL>/api/auth/oidc/callback`으로 넣습니다. 예를 들면 `https://notes.example.com/api/auth/oidc/callback`입니다. `PUBLIC_URL`은 꼭 있어야 합니다. OIDC를 설정했는데 `PUBLIC_URL`이 없으면 서버가 시작하지 않습니다.
2. 발급자, 클라이언트 id와 시크릿을 `.env`에 넣고 다시 시작합니다.

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `OIDC_ISSUER` | 발급자 URL. 제공자의 discovery 문서(제공자가 자기 엔드포인트와 키 위치를 알리는 설정 문서)에 적힌 그대로 씁니다 | 없음(꺼짐) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | 클라이언트 자격 증명. 시크릿은 토큰 엔드포인트에만 보내고, 로그에 남기거나 돌려주지 않습니다 | 없음 |
| `OIDC_NAME` | 버튼 라벨("`<name>`로 로그인") | `SSO` |
| `OIDC_ALLOWED_DOMAINS` | 로그인을 허용할 이메일 도메인, 쉼표로 구분. `email_verified`가 필요합니다 | 비어 있음(제공자가 발급하는 누구나) |
| `OIDC_AUTO_CREATE` | `1` = 처음 보는 사람이 처음 로그인하면 계정을 만듭니다(가입 키 없이) | `0` |
| `OIDC_LINK_EXISTING` | `1` = 제공자가 인증한 같은 이메일의 기존 로컬 계정에 연결합니다(관리자 계정은 제외) | `0` |
| `OIDC_REQUIRE_MFA` | `1` = id_token에 두 번째 인증 수단(`amr`/`acr`)이 보이지 않으면 로그인을 거절합니다 | `0` |
| `OIDC_ACR_VALUES` | 요청할 acr 값. 돌아온 값이 이 목록에 있으면 두 번째 인증 수단으로 칩니다 | 비어 있음 |
| `OIDC_TRUST_EMAIL` | `1` = 제공자가 `email_verified`를 보내지 않을 때 이메일을 인증된 것으로 봅니다 | `0` |
| `OIDC_SCOPES` | 요청할 scope | `openid email profile` |
| `OIDC_ID_TOKEN_ALG` | 받아들이는 id_token 알고리즘 하나. `RS256`, `PS256`, `ES256` 중에서 고릅니다 | `RS256` |

발급자 예시:

| 제공자 | `OIDC_ISSUER` | 참고 |
|---|---|---|
| Google Workspace | `https://accounts.google.com` | `OIDC_ALLOWED_DOMAINS=<your domain>`으로 제한하세요. Google은 `amr`을 보내지 않으므로 `OIDC_REQUIRE_MFA=0`으로 두고, 2단계 인증은 Google 관리 콘솔에서 강제하세요. |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | `common`/`organizations`가 아니라 테넌트 id를 쓰세요. 선택 클레임 `email`을 켜 주세요. Entra는 `email_verified`를 보내지 않기 때문에 계정을 만들려면 `OIDC_TRUST_EMAIL=1`이 필요하고, 이메일로 기존 계정에 연결하는 기능은 꺼진 채로 남습니다. |
| Keycloak | `https://<host>/realms/<realm>` | `OIDC_REQUIRE_MFA`를 쓰려면 ACR 단계를 설정하고 `OIDC_ACR_VALUES`를 정하거나, `amr` 매퍼를 추가하세요. |
| Authentik | `https://<host>/application/o/<slug>/` | 끝의 슬래시를 지우지 마세요. 발급자 주소의 일부입니다. |

계정을 맞추는 방법(docs/adr/1161-*): 제공자의 발급자와 subject(제공자가 사용자마다 붙이는 고유 id)로 맞추고, 이메일만 보고 맞추는 일은 없습니다. 이미 Inkling 계정이 있는 사람은 설정 › 계정(`Settings › Account`)에서 제공자를 연결하는 것이 안전합니다. `OIDC_LINK_EXISTING=1`이면 제공자가 이메일을 인증된 것으로 표시했을 때 첫 로그인에서 같은 이메일의 계정에도 연결합니다. 계정이 없는 사람은 `OIDC_AUTO_CREATE=1`일 때만 계정이 생깁니다. 이때는 가입 키를 묻지 않으니 `OIDC_ALLOWED_DOMAINS`를 정해 두세요(비어 있으면 서버가 부팅할 때 경고합니다). 아무 계정도 없는 인스턴스에서는 다른 가입과 마찬가지로 첫 계정이 관리자가 됩니다.

2단계 인증(docs/adr/1162-*): 제공자를 통해 만든 계정은 제공자의 두 번째 인증 수단을 쓰고, 2단계 인증을 요구하는 워크스페이스에서도 인증을 마친 것으로 칩니다. Inkling이 이를 직접 확인하게 하려면 `OIDC_REQUIRE_MFA=1`로 두세요. Inkling 자체 2단계 인증도 켠 계정은 제공자에서 로그인한 다음 코드를 한 번 더 묻습니다.

문제가 생기면 로그인 화면에는 정해진 문구가 뜨고, 서버 로그에는 `[oidc] callback refused: <CODE> (<reason>)`가 남습니다. `OIDC_STATE_INVALID`는 대개 로그인에 10분 넘게 걸렸거나 다른 탭이나 브라우저에서 로그인을 시작했다는 뜻입니다. `OIDC_UNAVAILABLE`은 discovery 문서, 키, 토큰 엔드포인트 중 어딘가에 닿지 못했다는 뜻입니다(발급자 주소와 컨테이너에서 밖으로 나가는 네트워크를 확인하세요).

<a id="3-h-semantic-search-optional"></a>
## 3-H. 의미 검색 (선택)

`EMBEDDING_URL`과 `EMBEDDING_MODEL`을 둘 다 설정해야 켜집니다(docs/adr/1740-*). 켜면 find_context가 뜻으로도 섹션의 순위를 매기고, 서버는 섹션 조각마다 그 내용(페이지 제목, 헤딩 경로, 조각 본문)을 바뀔 때마다 한 번씩 그 엔드포인트로 보냅니다. 호스팅 제공자를 쓰면 제3자에게 보내는 것이고, 로컬 모델 서버(Ollama, text-embeddings-inference)를 쓰면 노트가 내 네트워크 안에 머뭅니다. 변수를 `.env`에 넣고(예시는 `.env.example`에 있습니다) 다시 시작하세요.

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `EMBEDDING_URL` | OpenAI 호환 API의 기본 URL(`https://api.openai.com/v1`, Ollama는 `http://host:11434/v1`)이나 `…/embeddings`까지 적은 전체 URL | 없음(꺼짐) |
| `EMBEDDING_MODEL` | 모델 이름. 바꾸면 전부 다시 임베딩합니다 | 없음(꺼짐) |
| `EMBEDDING_API_KEY` | `Authorization: Bearer …`로 보냅니다. 로그에 남기거나 화면에 보여 주지 않습니다 | 없음 |
| `EMBEDDING_DIMENSIONS` | `dimensions`로 보냅니다(벡터 길이를 줄일 수 있는 모델용) | 모델 기본값 |
| `EMBEDDING_BATCH_SIZE` | 요청 하나에 담는 조각 수(1–256) | `32` |
| `EMBEDDING_REQUESTS_PER_MINUTE` | 인덱서의 요청 속도 | `60` |
| `EMBEDDING_TIMEOUT_MS` | 인덱서 요청의 타임아웃 | `30000` |
| `EMBEDDING_QUERY_TIMEOUT_MS` | 검색 한 번에서 질의를 임베딩할 때의 타임아웃. 시간을 넘기면 단어 검색으로 답합니다 | `3000` |
| `EMBEDDING_MAX_CHARS` | 조각 하나에서 모델로 보내는 글자 수 | `4000` |
| `EMBEDDING_CACHE_MB` | 질의용 벡터 캐시(프로세스 안) | `128` |
| `EMBEDDING_QUERY_PREFIX` | 모든 검색 질의 앞에 붙이는 말(e5 모델은 `"query: "`). 적은 그대로 씁니다. 바꾸면 전부 다시 임베딩합니다 | 비어 있음 |
| `EMBEDDING_PASSAGE_PREFIX` | 임베딩하려고 보내는 모든 섹션 앞에 붙이는 말(e5는 `"passage: "`). 바꾸면 전부 다시 임베딩합니다 | 비어 있음 |

컨테이너 안에서 `localhost`는 컨테이너 자신입니다. Docker 호스트에서 도는 Ollama를 쓰려면 `http://host.docker.internal:11434/v1`(Docker Desktop)이나 호스트의 LAN 주소를 쓰세요. 부팅 로그, 진행 상황, 메모리, 다시 끄는 방법은 [docs/OPERATIONS.ko.md](../docs/OPERATIONS.ko.md) 5절에 있습니다.

<a id="3-h2-uploads-by-ai-agents"></a>
## 3-H2. AI 에이전트의 파일 업로드

에이전트는 MCP 도구 `upload_file`로, API 토큰은 `POST /api/files`로 페이지에 파일을 붙입니다(docs/adr/2044-*, 2065-*). 워크스페이스마다 서버 기본값을 따르게 하거나 직접 켜고 끌 수 있습니다(워크스페이스 설정 › 연결된 에이전트 › 파일 업로드(`Workspace settings › Connected agents › File uploads`), 소유자와 관리자). 사람이 브라우저에서 올리는 파일과 에이전트가 첨부 파일을 읽는 일에는 영향이 없습니다. 기본값을 바꿀 때만 `.env`에 변수를 넣으세요. 지금 적용된 값은 관리자 › 상태(`Admin › Status`)에서 볼 수 있습니다.

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `AGENT_UPLOADS` | `on` = 워크스페이스가 끄지 않으면 허용, `off` = 워크스페이스가 켜지 않으면 거절, `never` = 어디서나 거절하고 워크스페이스도 켤 수 없음. 그 밖의 값은 `off`로 치고 부팅할 때 경고합니다 | `on` |
| `AGENT_UPLOAD_MAX_MB` | 에이전트가 올릴 수 있는 가장 큰 파일 크기(MB, 최대 64이고 그보다 큰 값은 경고와 함께 64로 잘립니다). 8보다 크게 잡으면 upload_file을 부르는 MCP 요청은 파일을 base64로 바꾼 크기에 1 MB를 더한 만큼까지 커질 수 있고, 다른 MCP 요청은 12 MB 그대로입니다. 업로드 하나가 진행되는 동안 드는 메모리는 파일 크기의 약 네 배입니다 | `5` |
| `AGENT_UPLOAD_DAILY_MB` | 계정마다 24시간 동안 쓸 수 있는 양. 그 계정의 연결들이 올린 파일을 합쳐서 셉니다. `0` = 제한 없음. 브라우저 업로드는 세지 않고 제한도 없습니다 | `200` |

<a id="3-i-one-server-process-per-database"></a>
## 3-I. 데이터베이스 하나에 서버 프로세스 하나

다른 Inkling 프로세스가 같은 데이터베이스를 쓰고 있으면 서버가 시작하지 않습니다. 두 프로세스가 서로의 문서를 덮어쓰기 때문입니다(docs/adr/1925-*). `docker compose up -d`는 옛 컨테이너를 먼저 멈추므로 평소 업데이트에는 영향이 없습니다. 기본값을 바꿔야 할 때만 `.env`에 변수를 넣으세요.

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `SINGLE_INSTANCE` | `0`(또는 `false`/`off`/`no`)이면 이 보호 장치를 끄고 부팅할 때 경고합니다. 돌고 있는 데이터베이스에 일부러 프로세스를 하나 더 붙이거나 트랜잭션 모드로 도는 커넥션 풀러(여러 연결을 몇 개의 DB 연결로 나눠 쓰게 하는 프록시) 뒤에 둘 때만 쓰세요. 두 번째 웹 서버를 띄우는 용도로는 절대 쓰지 마세요 | 켜짐 |
| `SINGLE_INSTANCE_WAIT` | 시작하는 서버가 다른 프로세스(교체되면서 아직 문서를 저장하고 있는 컨테이너)가 멈추기를 기다리는 시간(초). 그래도 멈추지 않으면 종료합니다 | `60` |

로그에 나오는 줄과 대처 방법은 [docs/OPERATIONS.ko.md](../docs/OPERATIONS.ko.md) 9절에 있습니다.

<a id="3-j-push-notifications-and-the-web-clipper-018"></a>
## 3-J. 푸시 알림과 웹 클리퍼 (0.18)

둘 다 위의 설정만으로 동작하고 프록시 경로를 따로 더할 필요가 없습니다. `/sw.js`, `/push-sw.js`, `/api/push/*`, `/api/clip`, `/clip`은 모든 요청을 넘기는 `reverse_proxy` 뒤에 있는 평범한 앱 경로입니다. 푸시는 사이트가 HTTPS여야 합니다(3-B). 브라우저는 `localhost`가 아니면 일반 http에서 푸시를 거절합니다. 또 프록시는 `/sw.js`와 `/push-sw.js`에 앱이 붙인 `Cache-Control: no-cache`를 바꾸지 않고 넘겨야 합니다. 서버에 필요한 것은 **밖으로 나가는** HTTPS입니다. 푸시를 쓰려면 브라우저 푸시 서비스의 443 포트(`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`)로 나갈 수 있어야 합니다. 클리퍼의 '본문 가져오기'(`Article text`)를 쓰려면(그리고 `OAUTH_CIMD=1`일 때 CIMD 문서를 받으려면) 공개 웹 서버의 80/443 포트로 나갈 수 있어야 합니다. 보안 목록이나 방화벽이 나가는 연결을 막으면 푸시가 오지 않고, 본문 클립은 모두 링크로만 저장됩니다. VAPID 키는 처음 쓸 때 만들어져 데이터베이스에 보관됩니다. `.env`에 `APP_SECRET_KEY`를 넣어 두면 이 키를 암호화해서 저장하고, iPhone을 위해서는 `VAPID_SUBJECT=mailto:you@your-domain`도 넣어 주세요. 변수와 자세한 내용은 [docs/OPERATIONS.ko.md](../docs/OPERATIONS.ko.md) 12절에 있습니다.

<a id="4-backups"></a>
## 4. 백업

`compose.yaml`의 `backup` 서비스가 매일 03:00에 데이터베이스와 데이터 볼륨을 백업합니다(검증, GFS 보관, 주간 복원 테스트 포함). crontab은 필요 없습니다. 상태 확인, '지금 백업'(`Back up now`), 내려받기는 관리자 › 백업(`Admin › Backups`)에서 합니다. 외부 사본(rclone), 암호화, `./deploy/restore.sh`로 복원하는 방법은 **[docs/BACKUP.ko.md](../docs/BACKUP.ko.md)** 문서에 있습니다.

아래 첫 명령은 지금 바로 백업을 받습니다.

```bash
./deploy/backup.sh            # back up now
./deploy/backup.sh list
./deploy/restore.sh --dry-run <set-id>
```

예전 스크립트가 만든 `./backups/nodian-db-*.dump` 파일도 `docker compose exec -T -e PGOPTIONS="-c statement_timeout=0" db sh -c 'pg_restore -d "$POSTGRES_DB" --clean --no-owner' < <file>`로 복원할 수 있습니다. PGOPTIONS는 역할이나 데이터베이스 수준에 걸린 statement_timeout이 오래 걸리는 복원을 끊지 않게 해 줍니다. 백업 스크립트들도 자기가 실행하는 psql / pg_dump / pg_restore마다 같은 값을 넣습니다.

<a id="5-updating"></a>
## 5. 업데이트

마이그레이션은 새 앱이 부팅할 때 트랜잭션 하나로 자동으로 돌고, 그때까지는 옛 버전이 데이터베이스를 그대로 씁니다. 먼저 백업을 받은 다음 아래 순서대로 하세요. compose 명령마다 쓰시는 `-f` 파일들을 붙여야 합니다.

`backup.sh`는 `ok set=<id> ...`로 끝나고, `git pull`은 compose 파일과 배포 스크립트를 받아 옵니다. 원하면 이때 `.env`에 `INKLING_VERSION=X.Y.Z`(또는 `X.Y`)를 적어 릴리스를 고정합니다. 마지막 로그 명령으로 마이그레이션 결과와 "Server listening"이 찍혔는지 확인합니다.

```bash
cd /opt/inkling
./deploy/backup.sh                 # ends with "ok set=<id> ..."
git pull                           # compose files and deploy scripts
# optional: pin the release in .env as INKLING_VERSION=X.Y.Z (or X.Y)
docker compose pull app
docker compose up -d app
docker compose logs --tail 50 app  # migration result and "Server listening"
```

소스로 빌드하신다면 대신 `git pull && docker compose -f compose.yaml -f compose.build.yaml up -d --build app`을 실행합니다(두 줄을 `compose.override.yaml`에 넣어 두었다면 `docker compose up -d --build app`).

소스로 빌드해 쓰던 서버를 배포 이미지로 옮길 때는, 옮기는 것만으로 마이그레이션되는 것은 없고 데이터베이스와 볼륨도 그대로입니다. 받아 올 릴리스가 지금까지 돌리던 코드보다 오래된 것은 아닌지 확인하세요(체크아웃에서 `git describe --tags`). 최신 릴리스 이후의 `main`으로 빌드한 서버라면 다음 릴리스를 기다리거나 계속 소스로 빌드해야 합니다. 오래된 이미지는 더 새 스키마를 모르기 때문입니다. 확인이 끝나면 위 순서를 따르면 됩니다. 모든 릴리스는 그전의 각 릴리스에서 올라오는 업그레이드를 테스트합니다(`.github/workflows/upgrade.yml`). 이전 버전으로 내리는 것은 지원하지 않습니다. 되돌리려면 업그레이드 전에 받은 백업을 복원하고(docs/BACKUP.ko.md) `INKLING_VERSION`을 옛 릴리스로 정하세요.

<a id="upgrading-to-019-the-nodian--inkling-names"></a>
### 0.19로 올리기: nodian에서 inkling으로 바뀐 이름

0.18까지는 compose 프로젝트, 볼륨, 데이터베이스 역할의 이름이 `nodian`이었습니다. 0.19부터는 `.env`의 `INKLING_DATA_NAME`을 따르고, 이 값에는 기본값이 없습니다. 새 `compose.yaml`을 쓰는데 이 줄이 없으면 모든 compose 명령이 무엇을 만들거나 멈추기 전에 "required variable INKLING_DATA_NAME is missing a value"를 내고 멈춥니다. 그래서 업그레이드한 서버가 새로 만든 빈 볼륨으로 뜨는 일은 없습니다. 0.18 이하를 돌리던 서버에서는 아래처럼 합니다.

두 번째 줄은 옛 이름을 그대로 쓰겠다는 설정이고, 업그레이드로 다른 것은 바뀌지 않습니다. 새 이름이 필요하면 나중에 `rename-from-nodian.sh`를 돌립니다. 이 스크립트는 볼륨을 복사하고, 옛 볼륨은 직접 지울 때까지 남겨 둡니다. `--dry-run`은 크기, 남은 디스크, 예상 중단 시간을 보여 주고, 중간 어느 단계에서든 `./deploy/rename-from-nodian.sh --rollback`으로 되돌릴 수 있습니다.

```bash
./deploy/backup.sh
printf '\nINKLING_DATA_NAME=nodian\n' >> .env   # keep the old names: the upgrade changes nothing else
git pull && docker compose pull app && docker compose up -d
# later, if you want the new names (copies the volumes; the old ones stay until you delete them):
./deploy/rename-from-nodian.sh --dry-run   # sizes, free disk, expected downtime
./deploy/rename-from-nodian.sh             # back at any point: ./deploy/rename-from-nodian.sh --rollback
```

`nodian`을 계속 써도 됩니다. 스크립트가 하는 일, 중단 시간, 되돌리는 방법, 특수한 경우(로컬 체험, `COMPOSE_PROJECT_NAME`, override 파일, 컨테이너 이름을 적어 둔 cron 줄)는 docs/OPERATIONS.ko.md의 0.19 업그레이드 설명과 docs/adr/2340-*, 2341-*에 있습니다.

Docker를 sudo로 돌리는 서버에서는 스크립트도 같은 방식으로 실행하세요(`sudo ./deploy/rename-from-nodian.sh --dry-run`). 스크립트는 `.env`를 그 자리에서 고치고(소유자와 권한은 그대로 둡니다) 진행 상태를 `./backups/rename-nodian-to-inkling/`에 남깁니다(이때 이 폴더는 root 소유가 됩니다). `.env`가 root 소유라면 줄을 `sudo sh -c "printf '\nINKLING_DATA_NAME=nodian\n' >> .env"`로 더하세요.

0.19는 마이그레이션 두 개를 적용합니다. `0059_share_allow_download`는 상수 기본값이 있는 열이고, `0060_onboarding`은 기존 계정마다 한 행씩 들어가는 새 테이블입니다. 거의 빈 데이터베이스로 확인해 보니 0059를 적용한 데이터베이스에서도 v0.18.0 이미지가 떴고, 그래서 0.18.0으로 돌아갈 때 복원이 필요 없었습니다. 0060이 들어간 뒤로는 다시 확인하지 않았습니다. 업그레이드 전에 받은 백업은 남겨 두세요(docs/OPERATIONS.ko.md의 업그레이드 설명). 새 계정에는 짧은 소개와 시작하기(`Getting started`) 카드가 나옵니다. `.env`에 `ONBOARDING=off`를 넣으면 모두에게서 끌 수 있습니다(docs/OPERATIONS.ko.md 13절).

정지 신호(SIGTERM)를 받으면 앱은 편집 중인 공동 편집 문서를 DB에 저장한 뒤 끝나는데, 여기에 최대 25초쯤 걸립니다. compose의 `stop_grace_period: 30s`가 이 시간을 기다려 주니 `docker kill` / `docker compose kill`로 끊지 마세요. 옛 컨테이너가 아직 저장하고 있는 동안 새 컨테이너가 시작되면 새 컨테이너가 기다립니다(`SINGLE_INSTANCE_WAIT`, 3-I절).

<a id="local-trial-deploylocalsh"></a>
## 로컬 체험 (deploy/local.sh)

다른 사람들이 쓰는 서버가 아니라 내 컴퓨터에서 Inkling을 써 보기 위한 방법입니다. 이미지를 받아 오는 대신 받아 둔 소스를 빌드하려면 `./deploy/local.sh --build`를 쓰세요.

```bash
git clone <repo-url> inkling && cd inkling
./deploy/local.sh            # or ./deploy/local.sh --build to build this checkout instead of pulling
```

처음 한 번은 이런 일을 합니다. 먼저 `.env`를 씁니다("made by deploy/local.sh" 표시가 붙습니다). 여기에는 16진수 `POSTGRES_PASSWORD`, `openssl rand`로 만든 `APP_SECRET_KEY`, `PUBLIC_URL=http://localhost:<port>`, `COOKIE_SECURE=0`, `BACKUP_ENABLED=0`, `INKLING_PORT=127.0.0.1:<port>`(3000, 3987, 3001–3010 중 처음 비어 있는 포트, 또는 환경 변수로 준 `INKLING_PORT=…`), `INKLING_DATA_NAME=inkling`, 그리고 `COMPOSE_FILE=compose.yaml:compose.local.yaml`과 `COMPOSE_PROJECT_NAME=inkling-local`이 들어갑니다. 그다음 스택을 띄우고 `/api/health`가 응답할 때까지 기다린 뒤, 첫 관리자 설정 링크와 MCP 주소를 보여 줍니다. 스크립트가 직접 쓰지 않은 `.env`는 절대 건드리지 않습니다.

`--build`가 없으면 스크립트는 배포된 이미지(`ghcr.io/prove1352/inkling`, 태그는 `INKLING_VERSION`, 기본 `latest`)를 받아 옵니다. 설정 링크는 0.17부터 있습니다. 0.17보다 오래된 이미지(`INKLING_VERSION`에 그 전 릴리스를 적은 경우)는 링크를 찍지 않으므로, 스크립트가 그렇다고 알려 주고 `./deploy/signup-key.sh new "first admin"`을 안내합니다(`/register`를 열고 키를 붙여 넣으면 됩니다). `--build`는 받아 둔 소스를 빌드하므로 어느 쪽이든 설정 링크가 있습니다. 첫 빌드는 몇 분 걸립니다. 한 번 `--build`를 쓰면 그다음에 `--build` 없이 `./deploy/local.sh`를 실행해도 계속 소스로 빌드합니다.

bash, curl, Docker Compose v2.24 이상이 필요합니다(`compose.local.yaml`이 `!override`를 씁니다). 윈도우에서는 WSL이나 Git Bash에서 실행하세요.

`compose.local.yaml`은 체험용 스택에 별도의 compose 프로젝트를 줍니다. 그래서 같은 컴퓨터에 있는 본 스택과 컨테이너나 볼륨이 섞이지 않고, 데이터베이스용 호스트 포트와 백업 사이드카도 없습니다. `.env`가 compose 파일을 지정하기 때문에 그냥 `docker compose logs -f app`이나 `./deploy/signup-key.sh`를 실행해도 체험용 스택에 적용됩니다. `./deploy/local.sh stop`으로 멈추고, `./deploy/local.sh destroy`로 컨테이너와 볼륨을 지웁니다. `.env`는 남으니, 새 비밀값으로 처음부터 다시 하려면 `.env`도 지우세요.

에이전트를 연결하려면 `http://localhost:<port>/settings/connections`를 열어 에이전트 연결 토큰을 발급하고, 클라이언트가 `Authorization: Bearer <token>` 헤더를 붙여 `http://localhost:<port>/mcp`에 접속하게 합니다(Claude Code라면 `claude mcp add --transport http inkling http://localhost:<port>/mcp --header "Authorization: Bearer <token>"`).

체험용 데이터를 실제 서버로 옮기려면 서버를 새로 설치한 뒤 가져오기를 합니다. 워크스페이스를 zip으로 내보내 그쪽에서 가져오세요. 페이지와 첨부 파일은 옮겨지고, 코멘트와 버전 기록은 옮겨지지 않습니다.

<a id="notes"></a>
## 참고

- 노션 업로드 기능을 쓰려면 `.env`에 `NOTION_TOKEN=secret_...`을 넣으세요(notion.so/my-integrations에서 내부 통합을 만들고 대상 페이지에 접근 권한을 주면 됩니다).
- 다른 컴퓨터에서 데이터를 옮겨 오려면 그쪽에서 `./deploy/backup.sh`와 `./deploy/backup.sh copy-out <set> <dir>`를 실행하고, 세트를 새 서버로 복사한 뒤 docs/BACKUP.ko.md의 "새 서버에 복원하기"를 따르세요.
