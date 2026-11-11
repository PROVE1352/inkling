# Inkling API 계약 (M1)

서버 에이전트와 웹 에이전트가 함께 따르는 계약입니다. **이 문서가 기준입니다.** 구현은 이 문서와 달라지면 안 됩니다.
요청 검증 스키마와 DTO 타입은 `@inkling/shared`(packages/shared/src/index.ts)에 정의되어 있고, 서버와 웹 모두 이것을 가져다 씁니다. English: [API.md](API.md).

<a id="common-rules"></a>
## 공통 규칙

- 모든 REST 엔드포인트는 `/api` 접두사를 쓰고 JSON으로 주고받습니다. 예외는 `GET /files/:id`(바이너리)와 `WS /collab`(Hocuspocus)입니다.
- 인증: 세션 쿠키 `inkling_sid`(httpOnly, SameSite=Lax, Path=/, 30일, `COOKIE_SECURE=1`이면 Secure). 서버는 토큰의 SHA-256만 저장합니다(docs/adr/1060-*).
- 교차 사이트 검사: `Authorization` 헤더가 없는 GET/HEAD/OPTIONS 외의 `/api` 요청에서 `Origin`(없으면 `Referer`)이 `PUBLIC_URL`/`APP_URL`이 아니면 → 403 `CROSS_SITE_REQUEST`. 두 헤더를 모두 보내지 않는 클라이언트(CLI, curl)는 허용합니다. `/collab` WebSocket 업그레이드도 같은 방식으로 검사합니다(docs/adr/1062-*).
- 오류 응답 형식: `{ "error": { "code": string, "message": string } }` (`ApiErrorBody`).
  - 코드: `UNAUTHORIZED`(401), `FORBIDDEN`(403), `NOT_FOUND`(404), `VALIDATION`(400),
    `EMAIL_TAKEN`(409), `INVALID_CREDENTIALS`(401), `INVALID_CODE`(404), `INVALID_RESET`(400),
    `EMAIL_NOT_VERIFIED`(403), `DELEGATED_ACCOUNT`(400), `RATE_LIMITED`(429, `Retry-After`),
    `MAIL_DISABLED`(501), `MAIL_FAILED`(502), `CROSS_SITE_REQUEST`(403), `INVALID_TOTP_CODE`(401),
    `TOTP_CODE_REUSED`(401), `TOTP_CHALLENGE_EXPIRED`(401), `TWO_FACTOR_ALREADY_ON`(409), `TWO_FACTOR_UNAVAILABLE`(501),
    `PAYLOAD_TOO_LARGE`(413), `UNSUPPORTED_TYPE`(415), `INTERNAL`(500).
  - `message`는 영어입니다. 클라이언트는 `code`를 보고 현지화합니다. 웹 앱은 알고 있는 코드를 번역하고(정확히 일치하는 일부 메시지도 번역합니다),
    그 밖에는 `message`를 그대로 보여 줍니다. 메시지 문구로 판별하지 마세요.
- 권한 모델: 워크스페이스의 모든 작업은 **멤버**만 할 수 있습니다. 페이지와 파일의 권한은 그것이 속한 워크스페이스로 확인합니다.

<a id="localization"></a>
## 현지화

- 지원 로케일: `en`, `ko`. 운영자가 `DEFAULT_LOCALE`(`en` | `ko`)을 정할 수 있습니다(정하지 않으면 서버는 `en`을 씁니다).
- 웹 클라이언트는 모든 API 요청에 `Accept-Language: <ui locale>`을 보냅니다.
- **서버가 만드는 내용**(기본 제공 템플릿, Tasks 문서처럼 서버가 만드는 페이지의 기본 제목, 컬렉션의 기본 속성과 뷰,
  가입할 때 만드는 워크스페이스 이름)은 사용자가 저장한 로케일을 쓰고, 없으면 `Accept-Language`,
  그것도 없으면 `DEFAULT_LOCALE`을 씁니다.
- **이메일**은 받는 사람이 저장한 로케일을 쓰고, 없으면 `DEFAULT_LOCALE`을 씁니다.
- 오류 `message`는 현지화하지 않습니다([공통 규칙](#common-rules) 참고).
- 관련 엔드포인트: `GET /api/auth/mode`(`defaultLocale`), `GET /api/auth/me`(`user.locale`), `PATCH /api/auth/me/locale`([인증](#auth) 참고).

<a id="auth"></a>
## 인증

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/auth/mode` | - | `AuthModeDTO` `{ delegated, delegatedName, delegatedEmailDomain, signupKeyRequired, mailEnabled, emailVerificationRequired, defaultLocale }`(인증 필요 없음). `defaultLocale: 'en' \| 'ko' \| null`은 운영자가 `DEFAULT_LOCALE`을 설정했을 때만 값이 있습니다(아니면 `null`이고, 브라우저 언어로 정합니다). 제한 모드(0.22)는 설정이 켜진 것마다 선택 필드를 더합니다: [v0.22.0 additions](#v0220-additions) |
| POST | `/api/auth/register` | `registerSchema` | `{ user: UserDTO }` + Set-Cookie. 이메일은 소문자로 정규화합니다. 중복 → 409 `EMAIL_TAKEN`. 가입하면 사용자 이름을 딴 개인 워크스페이스가 자동으로 생깁니다(사용자가 소유자이고, 이름은 [요청 로케일](#localization)을 따릅니다). 아직 관리자가 없으면 이 사용자가 관리자가 됩니다(부트스트랩). 메일이 켜져 있으면 → 인증 메일을 보냅니다. 인증 강제 모드에서는 세션을 만들지 않고 `{ user, verificationRequired: true, mailSent }`를 돌려줍니다. 위임 도메인의 이메일 → 400 `EMAIL_RESERVED`. 가입 키가 틀리면 → 403 `INVALID_SIGNUP_KEY`. 제한 모드(0.22): `email` 대신 `loginId`, 동의와 봇 검사 필드, 새 오류([v0.22.0 additions](#v0220-additions)). |
| POST | `/api/auth/login` | `loginSchema` | `{ user: UserDTO }` + Set-Cookie. 실패 → 401 `INVALID_CREDENTIALS`(이메일이 있는지 절대 드러내지 않고, 메시지도 같습니다). 인증 강제 모드에서 이메일 인증을 하지 않은 계정(비밀번호가 맞을 때만) → 403 `EMAIL_NOT_VERIFIED`. 관리자가 없으면 부트스트랩 승격이 적용됩니다. |
| POST | `/api/auth/login/totp` | `{ challenge, code }` | 2단계 인증을 켠 계정의 두 번째 단계입니다. 이런 계정에서는 `POST /api/auth/login`이 쿠키 없이 `200 { totpRequired: true, challenge }`를 돌려줍니다. `code`는 앱의 6자리 코드나 복구 코드입니다. `{ user: UserDTO, recoveryCodeUsed }` + Set-Cookie. 401 `INVALID_TOTP_CODE` / `TOTP_CODE_REUSED` / `TOTP_CHALLENGE_EXPIRED`(5분이 지나거나 5번 실패). 분당 10회(docs/adr/1061-*) |
| GET | `/api/auth/2fa` | - | `{ enabled, pending, recoveryCodesLeft, available }`. 브라우저 세션, 로컬 계정만 됩니다(다른 `/auth/2fa*` 라우트도 마찬가지입니다). |
| POST | `/api/auth/2fa/setup` | `{ password }` | `{ secret, uri }`(otpauth://). 409 `TWO_FACTOR_ALREADY_ON`, `APP_SECRET_KEY`가 없으면 501 `TWO_FACTOR_UNAVAILABLE`. |
| POST | `/api/auth/2fa/enable` | `{ code }` | `{ recoveryCodes }`(10개, 한 번만 보여 줍니다). |
| POST | `/api/auth/2fa/disable` | `{ password, code }` | `{ ok: true }` |
| POST | `/api/auth/2fa/recovery-codes` | `{ password, code }` | `{ recoveryCodes }`(이전 코드 묶음을 대체합니다). |
| POST | `/api/auth/logout` | - | 204 + 쿠키 삭제. 세션 행을 지웁니다. |
| GET | `/api/auth/me` | - | `{ user: UserDTO }` / 401. `origin`, `emailVerified`(위임 계정은 true), `locale: 'en' \| 'ko' \| null`(저장한 화면·메일 언어, `null` = 자동), `twoFactor`(2단계 인증 켜짐), `sidebar: SidebarPrefsDTO`(사이드바 메뉴 순서와 숨긴 메뉴, [사이드바 메뉴](#sidebar-menus-per-user-docsadr1020-) 참고. 바꾼 적이 없으면 `{ order: [], hidden: [] }`)를 담고, 관리자에게는 `pendingResetRequests`도 담습니다. 제한 모드(0.22)는 해당할 때 `expiresAt`과 `consentRequired`를 더합니다. |
| PATCH | `/api/auth/me/locale` | `{ "locale": "en" \| "ko" \| null }` | `{ "locale": "en" \| "ko" \| null }`. 세션이 필요합니다. 계정의 화면·메일 언어를 저장합니다(`null` = 자동: 브라우저 언어 / `DEFAULT_LOCALE`). 그 밖의 값 → 400 `VALIDATION`. |
| POST | `/api/auth/reset-password` | `resetPasswordSchema` `{ email, code, newPassword }` | `{ ok: true }`. 코드는 관리자나 자동 메일로 받은 초기화 코드(한 번만 쓸 수 있고 24시간 유효)이거나, 그 사람이 가입할 때 쓴 **maxUses=1** 가입 키입니다. 성공하면 그 계정의 세션을 모두 지우고, 남은 코드를 폐기하고, 대기 중인 요청을 처리됨으로 바꿉니다. 실패(없는 계정, 위임 계정, 틀린 코드 모두) → 같은 메시지로 400 `INVALID_RESET`. 분당 10회 + 실패가 쌓이면 차단합니다. |
| POST | `/api/auth/forgot-password` | `forgotPasswordSchema` `{ email, note? }` | 언제나 `{ ok: true }`(계정이 있는지 절대 드러내지 않습니다). 있는 계정만 처리합니다. 인증된 이메일 + 메일 켜짐 → 초기화 코드 메일을 자동으로 보냅니다(백그라운드에서, 5분에 한 통까지). 그 밖(인증 안 됨, 메일 꺼짐, 위임 계정) → `password_reset_requests`의 대기 행 하나로 합칩니다(갱신은 1분에 한 번까지). `@`가 없는 입력은 위임 ID로 봅니다. 분당 5회. |
| POST | `/api/auth/change-password` | `changePasswordSchema` `{ currentPassword, newPassword }` | `{ ok: true }`. 쿠키 세션만 됩니다(bearer → 403). 위임 계정 → 400 `DELEGATED_ACCOUNT`. 현재 비밀번호가 틀리면 → 400 `INVALID_PASSWORD`. 다른 세션은 모두 지우고 지금 세션만 남깁니다. |
| POST | `/api/auth/verify-email` | `{ token }` | `{ ok: true, email }`. 토큰은 한 번만 쓸 수 있고 24시간 유효하며, 메일을 보낼 때의 이메일이 계정 이메일과 같아야 합니다. 잘못된 토큰 → 400 `INVALID_TOKEN`. |
| POST | `/api/auth/verify-email/send` | (쿠키 세션) 또는 `{ email, password }` | `{ ok: true, alreadyVerified? }`. 인증 메일을 다시 보냅니다. 메일 꺼짐 → 501 `MAIL_DISABLED`. 1분에 한 번까지(429). |

- 비밀번호 규칙: 8–100자(`newPasswordSchema`).
- 무차별 대입 방어: 위 인증 라우트, MCP OAuth, 공개 공유 토큰에서 생긴 실패를 IP마다 셉니다. 한도를 넘으면 →
  429 `RATE_LIMITED` + `Retry-After`(문구는 모두 같습니다). 계정 단위로는 지연(backoff)만 있고 잠금은 없습니다. 전체 정책은
  deploy/DEPLOY.md 3-F에 있습니다.

<a id="sidebar-menus-per-user-docsadr1020-"></a>
## 사이드바 메뉴(사용자별, docs/adr/1020-*)

사이드바 맨 위 메뉴 가운데 무엇을 어떤 순서로 보일지를 사람마다 계정에 저장합니다(`users.sidebar_prefs`, 마이그레이션
0033). 그래서 어느 기기에서나 같게 보입니다. 브라우저 세션만 됩니다. 쿠키가 없으면 → 401, 에이전트의 bearer 토큰 → 403.

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/me/sidebar` | – | `SidebarPrefsDTO { order: string[], hidden: string[] }`. 바꾼 적이 없으면 `{ order: [], hidden: [] }`입니다(`GET /api/auth/me`도 같은 값을 `user.sidebar`로 돌려줍니다). |
| PUT | `/api/me/sidebar` | `sidebarPrefsSchema` `{ order, hidden }` | 저장된 값. 값 전체를 바꿉니다. 두 목록이 모두 비면 기본값으로 돌아갑니다(NULL로 저장). id는 `^[a-z][a-z0-9-]{0,31}$`에 맞아야 하고, 목록마다 32개까지이며, 중복은 버립니다(처음 것을 남김). 그 밖에는 → 400 `VALIDATION`이고 아무것도 바뀌지 않습니다. |

- 기본 순서대로 놓은 기본 제공 id(`SIDEBAR_MENU_IDS`): `search, later, threads, graph, tags, shared, due, calendar, activity, today`(`later`와 `threads`는 v0.11.0부터).
- 서버는 모양만 검사하고 어휘는 검사하지 않습니다. 형식이 맞으면 서버가 모르는 id도 저장합니다. 클라이언트는 그릴 때
  모르는 id를 무시하고, 저장할 때는 남겨 둡니다. 알려진 id가 `order`에 없으면(나중에 추가된 메뉴) 기본 위치에
  나옵니다. 기본 순서에서 바로 앞에 오는 메뉴의 바로 뒤입니다. `hidden`에 있는 id는 보이지 않습니다.

<a id="admin-requireadmin-cookie-session--isadmin-bearer-403"></a>
## 관리자(`requireAdmin`: 쿠키 세션 + `isAdmin`, bearer 403)

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| DELETE | `/api/admin/users/:id/2fa` | - | `{ ok, wasOn }`. 멤버의 2단계 인증을 끄고 그 사람의 세션을 로그아웃시킵니다. `GET /api/admin/users`의 행에 `twoFactor`가 있습니다. |
| GET | `/api/admin/signup-keys` | - | `{ keys: SignupKeyDTO[] }` 최신순이며, 키마다 그 키로 가입한 사용자를 담습니다. `SignupKeyDTO.id`는 키 해시입니다. `key`는 아직 다시 보여 줄 수 있을 때(사용하지 않았고 봉인된 사본이 있을 때)만 원래 키이고, 아니면 null입니다. `keyHint`는 끝의 몇 글자를 보여 줍니다(docs/adr/1110-*) |
| POST | `/api/admin/signup-keys` | `createSignupKeySchema` | `{ key: SignupKeyDTO }` |
| DELETE | `/api/admin/signup-keys/:key` | - | `{ ok: true }`(그 키로 가입한 계정은 남습니다) |
| POST | `/api/admin/signup-keys/:key/send-invite` | `{ to }` | `{ ok: true }` 초대 메일(`/register?key=`). 여기와 DELETE의 `:key`는 id 또는 원래 키입니다. 더 이상 보여 줄 수 없는 키는 409 `KEY_NOT_REVEALABLE`. 메일 꺼짐 501, 보내기 실패 502 `MAIL_FAILED`. 분당 20회 |
| GET | `/api/admin/users` | - | `{ users: AdminUserDTO[] }` 최근 가입순. `signupKeyRecovery`(한 번만 쓰는 가입 키를 가지고 있음)와 `emailVerifiedAt`을 담습니다 |
| PATCH | `/api/admin/users/:id` | `setAdminSchema` | `{ user: { id, isAdmin } }`. 자기 자신이나 마지막 관리자의 권한을 빼면 → 400 |
| DELETE | `/api/admin/users/:id` | - | `{ ok: true }` 계정 강제 삭제. 내용은 SET NULL로 남기고, 세션과 멤버십은 cascade로 지워지며, 가입 키의 used_count가 −1 됩니다(0 아래로는 내려가지 않음). 자기 자신이나 마지막 관리자 → 400 |
| POST | `/api/admin/users/:id/temp-password` | - | `{ password }`(한 번만 보여 줌). 그 사용자의 세션을 모두 지우고 대기 중인 요청을 처리됨으로 바꿉니다. 위임 계정 400 `DELEGATED_ACCOUNT`, 자기 자신 400 |
| POST | `/api/admin/users/:id/reset-code` | - | `{ code, expiresAt }`(한 번만 보여 줌, 24시간, DB에는 SHA-256만 저장). 이전 코드를 폐기하고, 세션을 모두 지우고, 대기 중인 요청을 처리됨으로 바꿉니다. 위임 계정이나 자기 자신 400 |
| POST | `/api/admin/users/:id/send-credential` | `sendCredentialMailSchema` `{ to, kind: 'reset-code'\|'temp-password', secret }` | `{ ok: true }`. 그 비밀 값이 지금 그 사용자에게 유효한지 서버가 확인한 뒤에만 보냅니다. 분당 20회 |
| POST | `/api/admin/users/:id/send-verification` | - | `{ ok: true }` 계정 이메일로 인증 메일을 보냅니다. 이미 인증됨 400 |
| POST | `/api/admin/users/:id/verify` | `{ verified?: boolean }` | `{ user: { id, emailVerifiedAt } }` 손으로 인증됨 표시를 합니다(false면 표시를 뗍니다) |
| GET | `/api/admin/reset-requests` | - | `{ requests: ResetRequestDTO[] }` 최신 200개 |
| POST | `/api/admin/reset-requests/:id/dismiss` | - | `{ ok: true }` pending → dismissed. 없거나 이미 처리됨 404 |
| GET | `/api/admin/ip-bans` | - | `IpBansResponseDTO` `{ bans, yourIp, yourIpAllowlisted, allowlist, policy }` |
| POST | `/api/admin/ip-bans` | `manualBanSchema` `{ ip, minutes, reason? }` | `{ ok, ip, bannedUntil }`. 허용 목록에 있는 IP나 내 IP → 400 |
| DELETE | `/api/admin/ip-bans/:id` | - | `{ ok: true }` 그 IP에 걸린 차단을 풉니다(차단 단계는 그대로 남습니다) |

<a id="workspaces"></a>
## 워크스페이스

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/workspaces` | - | `{ workspaces: WorkspaceDTO[] }`(내가 멤버인 것, 역할과 `can` 포함, docs/adr/0945-*). 워크스페이스에서 차단된 MCP 연결에는 그 워크스페이스가 보이지 않습니다(docs/adr/0947-*). `inviteCode`는 소유자이거나, 초대 링크가 켜져 있을 때의 관리자가 아니면 ''입니다 |
| POST | `/api/workspaces` | `createWorkspaceSchema` | `{ workspace: WorkspaceDTO }`(초대 코드는 자동으로 만들고, 내가 소유자가 됩니다) |
| POST | `/api/workspaces/join` | `joinWorkspaceSchema` | `{ workspace: WorkspaceDTO }`. 코드는 대문자로 정규화한 뒤 비교합니다. 모르는 코드이거나 초대 링크가 꺼져 있으면 → 404 `INVALID_CODE`. 이미 멤버이면 → 그냥 200(멱등). `member.joined`로 감사 기록을 남깁니다. |
| GET | `/api/workspaces/:id/members` | - | `{ members: MemberDTO[] }` |
| PATCH | `/api/workspaces/:id` | `renameWorkspaceSchema { name?, icon? }`(icon ≤ 16자, null이면 지움, 필드가 적어도 하나) | `{ workspace: WorkspaceDTO }`: **소유자만** 됩니다(아니면 403). `workspace.updated`로 감사 기록을 남깁니다 |

- 초대 코드: 알파벳 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`(헷갈리는 글자를 뺀 것)에서 고른 대문자와 숫자로, 길이 10, 암호학적 난수입니다. 유일성 충돌이 나면 3번까지 다시 만듭니다.

<a id="pages"></a>
## 페이지

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/workspaces/:id/pages` | - | `{ pages: PageMetaDTO[] }`: `deleted_at IS NULL`인 것만, `sortOrder asc, createdAt asc` 순서입니다. 트리는 클라이언트가 `parentId`로 조립합니다. |
| POST | `/api/pages` | `createPageSchema` | `{ page: PageMetaDTO }`. `parentId`를 주면 같은 워크스페이스의 살아 있는 페이지여야 합니다(아니면 400 VALIDATION). `sortOrder` = 형제 가운데 최댓값 + 1000. |
| PATCH | `/api/pages/:id` | `updatePageSchema` | `{ page: PageMetaDTO }`. `parentId`가 바뀔 때: 같은 워크스페이스여야 하고, 자기 자신이면 안 되고, **자기 하위 페이지 안으로도 안 됩니다**(부모 사슬을 확인해 순환을 막습니다). `updatedAt`을 갱신합니다. |
| DELETE | `/api/pages/:id` | - | 204. 소프트 삭제: 페이지와 그 하위 페이지 전부에 `deleted_at`을 넣습니다(재귀 CTE). |

<a id="files"></a>
## 파일

| 메서드 | 경로 | 입력 | 응답 |
|---|---|---|---|
| POST | `/api/files?workspaceId=<uuid>&pageId=<uuid>` | multipart 필드 `file`(하나) | `{ file: FileDTO }`: `url`은 `/files/<id>`입니다. bearer 토큰은 0.16부터 `pageId`가 필수입니다("v0.16.0 추가 사항" 참고) |
| GET | `/files/:id` | - | 바이너리 스트림. 헤더: 행의 `mime`에서 가져온 Content-Type, 래스터 이미지에는 `Content-Disposition: inline; filename*=UTF-8''<encoded>`, 그 밖의 모든 타입(PDF, 텍스트, 동영상, 오디오)에는 `attachment; …`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`, ETag=id. 인증하지 않으면 401. 파일이 속한 워크스페이스의 멤버나 게스트가 아니거나, 볼 수 없는 페이지의 파일이면 없는 id와 똑같이 404로 답합니다(docs/adr/1301-*). |

- 실제 저장 위치: `DATA_DIR/uploads/<id>`(id 그대로, 확장자 없음). 크기 한도는 25MB입니다(넘으면 413). `LIMIT_FILE_MB`를 더 작게 두면 그 값입니다(413 `LIMIT_FILE`, 0.22).
- 허용하는 MIME 타입: `image/*`, `application/pdf`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/mp4`, `audio/wav`, `text/plain`. 그 밖은 415.

<a id="collab-real-time-co-editing"></a>
## 협업(실시간 공동 편집)

- `WS /collab`: Hocuspocus 프로토콜. `documentName` = 페이지 UUID.
- 인증: 업그레이드 요청의 **쿠키**로 세션을 정합니다. provider의 token 값은 무시하지만, Hocuspocus가 onAuthenticate 훅을 돌리도록 클라이언트는 더미 `token: 'cookie'`를 보냅니다.
- 권한: documentName이 UUID이고, 살아 있는 페이지이고, 사용자가 그 워크스페이스의 멤버여야 합니다. 아니면 연결을 거절합니다.
- 저장: Yjs 상태를 디바운스(2초, 최대 10초)를 두고 `page_docs.state`(bytea)에 저장합니다. 저장할 때 `pages.updated_at`도 갱신합니다.

<a id="misc"></a>
## 기타

- `GET /api/health` → `{ ok: true }`(인증 필요 없음)
- 모든 `/api` 응답에는 `X-Inkling-Build: <id>`가 붙습니다(`WEB_DIST/build.json`의 id이고, 모르면 붙지 않습니다). 자기 빌드와 다른 값을 받은 클라이언트는 업데이트 배너를 띄우거나 새로 고칩니다(docs/adr/0990-0993).
- `GET /api/version` → `{ build: string | null, version: string, updateMode: 'prompt' | 'force' }`(인증 필요 없음)
- `GET /api/version/latest`(관리자) → `{ enabled, current, latest: { version, url } | null, updateAvailable }`. `UPDATE_CHECK=github`가 아니면 `enabled: false`입니다(docs/adr/0994-*)
- 운영(Docker): `WEB_DIST`를 정적으로 서빙하고 SPA 폴백을 둡니다(`/api`, `/files`, `/collab` 밖의 GET 요청 → index.html)

---

<a id="m2-additional-contract-markdown-round-trip--wiki-links--trash--search"></a>
# M2 추가 계약(Markdown 왕복 · 위키 링크 · 휴지통 · 검색)

<a id="wiki-link-representation-convention-shared-by-server-and-web"></a>
## 위키 링크 표현(서버와 웹이 함께 쓰는 규칙)

- 문서 안의 위키 링크는 href가 내부 경로 `/w/<workspaceId>/p/<pageId>`인 **표준 BlockNote `link` 인라인**입니다
  (따로 만든 인라인 타입이 없으므로 스키마를 확장하지 않아도 Markdown 변환과 서버 파싱이 됩니다).
- Markdown **내보내기**에서는 내부 링크가 `[[Title]]`이 됩니다(Title = 링크 글자).
- Markdown **가져오기**에서는 `[[Title]]`을 제목이 같은 페이지로 찾아 내부 링크로 바꿉니다. 찾는 순서는 ① 같은 가져오기 묶음의 페이지 ② 워크스페이스의 살아 있는 페이지(대소문자 구분 없음, updatedAt이 최근인 것 먼저)입니다. 찾지 못한 링크는 글자 그대로 `[[Title]]`로 남습니다.
- 백링크 색인: 문서를 저장할 때(store) 블록에서 내부 href 패턴을 뽑아 `page_links(source_page_id, target_page_id)`를 맞춥니다(모두 지우고 다시 넣기, 중복 제거, 자기 참조 제외. 이 단계가 실패해도 store 자체는 성공합니다).

<a id="pages-additions"></a>
## 페이지 추가 사항

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/pages/:id/backlinks` | `{ pages: PageMetaDTO[], sections? }`: 이 페이지에 링크를 건 살아 있는 페이지(멤버십 확인, updatedAt desc). `sections`(0.17, 섹션 링크가 있는 원본이 있을 때만)는 "v0.17.0 추가 사항" 참고 |
| POST | `/api/pages/:id/restore` | `{ page }`: 페이지와 하위 페이지를 `deleted_at=null`로 돌립니다. 부모가 아직 삭제된 상태이면 `parentId=null`(루트로 옮김). 대상이 삭제된 상태가 아니면 400 |
| DELETE | `/api/pages/:id/purge` | 204: 완전 삭제(cascade). **삭제된(휴지통에 있는) 페이지만** 됩니다. 아니면 400 |
| GET | `/api/workspaces/:id/trash` | `{ pages: PageMetaDTO[] }`: 삭제된 페이지 전부(평평한 목록), deletedAt desc |
| GET | `/api/workspaces/:id/search?q=` | `{ pages: PageMetaDTO[] }`: 제목 ILIKE 부분 일치(이스케이프함), 살아 있는 페이지만, 최대 20개, updatedAt desc. q가 비어 있으면 → 빈 배열 |

<a id="export--import"></a>
## 내보내기 / 가져오기

| 메서드 | 경로 | 입력/출력 |
|---|---|---|
| GET | `/api/pages/:id/export?format=md` | `text/markdown; charset=utf-8` 첨부 파일(페이지 하나, 하위 페이지 제외). 이미지 링크는 절대 경로 `/files/...`를 그대로 둡니다. `notation=plain`(기본) \| `agent` \| `file`(0.17, "v0.17.0 추가 사항" 참고) |
| GET | `/api/pages/:id/export?format=zip` | zip: 페이지와 그 하위 트리. 구조는 아래 규칙을 따릅니다. `notation=plain`이 아니면 페이지를 `notation=file`로 씁니다(0.17) |
| GET | `/api/workspaces/:id/export` | zip: 워크스페이스 트리 전체. `?notation=plain`이 아니면 `notation=file`(0.17) |
| POST | `/api/workspaces/:id/import?parentId=<uuid?>&source=<auto\|markdown\|notion?>` | multipart `file` = `.md` 하나 또는 `.zip`(≤ `IMPORT_MAX_UPLOAD_MB`, 기본 25). 응답은 `{ pages: PageMetaDTO[] }`(만든 페이지, 만든 순서)입니다. Notion 내보내기(`source=notion`이거나, `source`를 빼고 보냈는데 Notion 내보내기로 감지된 zip)는 `{ pages, report }`로 응답합니다. [Notion 내보내기 가져오기](#notion-export-import) 참고. `source=notion`인데 zip이 아니면 → `415` |

<a id="zip-convention-obsidian-friendly"></a>
### zip 규칙(Obsidian 친화)

```
assets/                  ← all images and files (file name: <fileId><extension inferred from mime>)
Page Title.md
Page Title/              ← a page with children gets a folder of the same name (alongside the file)
  Child Title.md
```

위 구조에서 `assets/`에는 모든 이미지와 파일이 들어갑니다(파일 이름은 `<fileId>`에 mime으로 추정한 확장자를 붙인 것). 하위 페이지가 있는 페이지는 파일 옆에 같은 이름의 폴더를 하나 더 둡니다.

- 파일 이름 정리: `/ \ : * ? " < > |`와 제어 문자를 지우고 앞뒤 공백을 자릅니다. 제목이 비면 → `Untitled`(현지화됨). 같은 폴더에서 이름이 겹치면 → ` (2)`, ` (3)`…
- Markdown frontmatter: `inkling-id: <uuid>`와 `updated: <ISO>` 두 줄만 씁니다.
- zip 안 Markdown의 이미지·파일 링크는 상대 경로 `assets/<fileId><ext>`로 바꿔 씁니다. 가져오기는 이것을 거꾸로 합니다(assets를 업로드한 뒤 `/files/<newId>`로 바꿔 씀).
- 가져오기: 폴더 구조 = 부모 관계. frontmatter의 `inkling-id`는 **무시하고 언제나 새 페이지를 만듭니다**(id 충돌을 피하기 위함, M2 범위).
- 가져온 페이지의 문서는 `blocksToYDoc` → `Y.encodeStateAsUpdate` → `page_docs.state` 순서로 저장합니다. 협업이 시작되기 전에 한 번만 하는 초기화라서 안전합니다.

<a id="notion-export-import"></a>
### Notion 내보내기 가져오기

Notion → Settings → Export(또는 페이지의 ⋯ → Export) → **Markdown & CSV**를 고르고, 하위 페이지 포함(include subpages)과
하위 페이지용 폴더 만들기(create folders for subpages)를 켭니다. 내려받은 zip을 그대로 올리면 됩니다(docs/adr/0960-*).

- 제목에서 id(` <32 hex>`)를 지웁니다. `Title.md` + 폴더 `Title/` = 하위 페이지가 있는 페이지 하나입니다.
  형제끼리 제목이 겹치면 ` (2)`를 붙입니다. 맨 앞의 `# Title` 줄이 제목이 됩니다.
- `X_all.csv`(`X.csv`보다 우선) → 표 뷰가 있는 컬렉션이 됩니다. 첫 열 = 행 제목입니다.
  속성 타입은 checkbox / number / date / URL / select / multi-select / relation(같은 가져오기에 든 한
  데이터베이스의 행)으로 정하고, 나머지는 모두 text입니다. 데이터베이스 폴더 안의 행 페이지는
  그 행의 문서가 됩니다(속성 줄은 지웁니다).
- `.md` / `.csv` / 폴더로 가는 상대 링크와 notion.so URL → 내부 링크. 참조된
  이미지와 파일은 업로드합니다. 찾지 못한 링크는 href를 그대로 둡니다.
- 콜아웃 → 인용, `$$` 수식 → `latex` 코드 블록, 인라인 `$x$` → 인라인 코드.
- 안에 든 분할 압축 파일(`Export-…-Part-N.zip`)은 한 단계 깊이까지 풉니다.
- 전부 되거나 전부 안 됩니다. 실패하면 만든 페이지와 업로드한 파일을 지웁니다.

`report`의 모양:

```ts
{ source: 'notion', detected: 'explicit' | 'auto',
  pages, documents, folders, collections, rows, attachments: number,
  links: { total, resolved },             // relative links, attachment paths, notion.so URLs
  brokenLinks: { page, href }[], brokenLinkCount,   // lists capped at 200, counts exact
  skipped: { path, reason }[], skippedCount,         // view CSVs, unreferenced attachments, …
  renamed, callouts, equations: number }
```

`links`는 상대 링크, 첨부 파일 경로, notion.so URL을 셉니다. 목록(`brokenLinks`, `skipped`)은 200개에서 자르고 개수(`brokenLinkCount`, `skippedCount`)는 정확합니다. `skipped`에는 뷰 CSV와 아무도 참조하지 않는 첨부 파일 같은 것이 들어갑니다.

<a id="page-kinds-kind--m2"></a>
## 페이지 종류(kind), M2

- `pages.kind`: `'doc' | 'folder' | 'canvas'`(기본 doc). `createPageSchema`에 `kind?`와 `title?`가 생깁니다.
- **folder**: 문서가 없습니다(협업 연결도 없음). 트리를 정리하는 데 씁니다. 내보낼 때는 디렉터리만 만들고, 가져올 때 Markdown 파일이 없는 디렉터리는 → folder 페이지가 됩니다.
- **canvas**: M3.5에서 구현했습니다(JSON Canvas). M2 서버는 kind를 저장하고 돌려주기만 하면 됩니다.
- PageMetaDTO에 `kind`가 들어가며, 모든 페이지 응답에서 돌려줍니다.

---

<a id="m3-contract--collections-notion-style-databases"></a>
# M3 계약: 컬렉션(Notion식 데이터베이스)

타입과 검증 스키마는 `@inkling/shared`의 M3 절에서 가져옵니다(collectionFieldSchema, viewConfigSchema, updateFieldsSchema, createViewSchema, updateViewSchema, updatePropsSchema, CollectionDTO, CollectionViewDTO, RowDTO).

<a id="model"></a>
## 모델

- **컬렉션 = kind='collection'인 페이지입니다.** 속성 정의는 `collections`(pageId pk, fields jsonb)에, 뷰는 `collection_views`에 있습니다.
- **행 = 컬렉션 페이지의 살아 있는 하위 페이지입니다**(kind는 보통 doc). 속성 값은 `pages.props` jsonb `{ fieldId: value }`에 있습니다.
- 값 모양: text/url→string, number→number, checkbox→boolean, date→'YYYY-MM-DD' string, select→optionId string, multiSelect→optionId string[], person→userId string.
- 페이지 트리(GET pages)는 컬렉션의 하위 페이지(행)도 그대로 돌려줍니다. **웹 앱은 트리를 조립할 때 부모가 컬렉션이면 이것들을 숨깁니다.**

<a id="endpoints"></a>
## 엔드포인트

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| POST | `/api/pages` (kind='collection') | 기존 createPageSchema | 만들 때 서버가 자동으로 만드는 것: `collections` 행(기본 속성: Status (select: To do (gray) / In progress (blue) / Done (green)), Assignee (person), Due (date)) + 기본 표 뷰("Table"). 이름은 [요청 로케일](#localization)을 따릅니다 |
| GET | `/api/pages/:id/collection` | - | `{ collection: CollectionDTO, rows: RowDTO[] }`: 대상이 collection 종류가 아니면 400. rows는 살아 있는 하위 페이지(sortOrder asc)이고 props를 담습니다 |
| PUT | `/api/pages/:id/collection/fields` | `updateFieldsSchema` | `{ collection }`: 통째로 바꿉니다. 속성 id가 겹치면 → 400. 지운 select 옵션을 가리키던 값은 정리하지 않습니다(그릴 때 무시) |
| POST | `/api/pages/:id/collection/views` | `createViewSchema` | `{ view }`(sortOrder = max+1000) |
| PATCH | `/api/collection-views/:id` | `updateViewSchema` | `{ view }`: config는 **통째로 바뀝니다**(병합하지 않음) |
| DELETE | `/api/collection-views/:id` | - | 204. 컬렉션에 남은 마지막 뷰이면 400 VALIDATION |
| PATCH | `/api/pages/:id/props` | `updatePropsSchema` | `{ row: RowDTO }`: **병합**합니다. 값이 null이면 그 키를 지웁니다. 대상 페이지의 부모가 컬렉션이 아니어도 허용합니다(속성은 그냥 저장됩니다) |

- 권한: 모두 그 워크스페이스의 멤버여야 합니다.
- `GET /api/pages/:id/collection`의 rows에는 deletedAt=null인 것만 들어갑니다.
- 컬렉션 페이지 내보내기(.md/zip): 본문 대신 **행을 GFM 표로 씁니다**(머리글은 제목 + 속성 이름이고, 칸은 값을 문자열로 바꾼 것입니다. select는 옵션 이름, person은 사용자 이름, checkbox는 ✅/⬜로 씁니다). 행 페이지는 기존 트리 규칙대로 하위 Markdown 파일로 들어갑니다.

---

<a id="m8-contract--invite-links--member-management--version-history"></a>
# M8 계약: 초대 링크 · 멤버 관리 · 버전 기록

<a id="invites"></a>
## 초대
- `GET /api/workspaces/invite-preview?code=<code>`(인증만 필요하고 멤버가 아니어도 됨) → `InvitePreviewDTO { name, icon, memberCount }`. 모르는 코드는 404 INVALID_CODE.

<a id="members-roles-owner--admin--member-docsadr0945-"></a>
## 멤버(역할 `owner | admin | member`, docs/adr/0945-*)
- `PATCH /api/workspaces/:id/members/:userId` 본문 `updateMemberSchema { role: 'owner'|'admin'|'member' }`(소유자만) → `{ member: MemberDTO }`. 마지막 소유자를 강등하면 400.
- `DELETE /api/workspaces/:id/members/:userId` → 204. 소유자는 누구든 내보낼 수 있고, 관리자는 일반 멤버만 내보낼 수 있으며(대상이 owner/admin이면 403), 누구나 스스로 나갈 수 있습니다. 마지막 소유자가 나가려 하면 400입니다. 다만 그 사람이 유일한 멤버이고 브라우저 세션에서 `{ name }`(워크스페이스 이름)을 보내면 워크스페이스를 바로 삭제합니다(0.22, [v0.22.0 additions](#v0220-additions)). **멤버를 내보내면 이 워크스페이스에 있는 그 사용자의 개인 페이지를 소프트 삭제하고**(audit L3), 그 사람의 문서 소유권을 비우며, (다른 사람을 내보낸 경우) 초대 코드를 새로 만듭니다.
- `GET /api/workspaces/:id/member-candidates`, `POST /api/workspaces/:id/members`: 멤버 추가 정책이 허용하는 호출자만 됩니다(기본은 소유자와 관리자, 아니면 403, docs/adr/0948-*).
- `POST /api/workspaces/:id/invite/regenerate`(소유자 또는 관리자) → `{ workspace: WorkspaceDTO }`(새 코드).
- `POST /api/workspaces/:id/transfer`(소유자) 본문 `transferOwnershipSchema { userId }` → `{ members: MemberDTO[] }`. `ws-members` 잠금 아래 한 트랜잭션에서 대상은 소유자가 되고 호출자는 member가 됩니다(docs/adr/0911-*). 대상이 멤버가 아니면 400(위임 계정도 평소와 똑같이 다룸), 호출자 자신이면 400, 호출자가 소유자가 아니면 403입니다(동시에 두 번 넘길 때 진 쪽도 403). 넘긴 뒤에는 이전 소유자가 보통 방법으로 나갈 수 있습니다.

<a id="workspace-deletion-owner-soft-delete-with-a-30-day-restore--docsadr0910-"></a>
## 워크스페이스 삭제(소유자, 30일 안에 복원할 수 있는 소프트 삭제, docs/adr/0910-*)
- `GET /api/workspaces/:id/delete-preview`(소유자) → 확인 대화상자에 쓰는 `WorkspaceDeletePreviewDTO { pages, files, publicLinks, members, restoreDays }`.
- `DELETE /api/workspaces/:id` 본문 `deleteWorkspaceSchema { name }` → 204. `name`은 워크스페이스 이름과 같아야 하고(앞뒤 공백은 무시, 대소문자 구분) 아니면 400입니다. member는 403, 멤버가 아니거나 없거나 이미 삭제되었으면 404. 모든 사람에게 한꺼번에 적용됩니다. 워크스페이스가 `GET /api/workspaces`에서 사라지고, 모든 `/api/workspaces/:id/*`, 페이지, 댓글, 파일(`/files/:id`), 템플릿 라우트가 404로 답합니다. 공개 링크(`/api/public/*`. `/s/*`는 기본 앱 셸로 돌아감)와 초대 코드가 더는 동작하지 않고, iCal 피드에서 항목이 빠지며, 쿼리 블록, MCP 도구, 리마인더, 웹훅, 시트 동기화가 이 워크스페이스를 건너뛰고, 열려 있던 협업 소켓은 닫힙니다. 다른 멤버는 워크스페이스 이름이 담긴 `workspace_deleted` 알림을 받습니다(웹훅은 보내지 않음).
- `GET /api/workspaces/deleted` → `{ workspaces: DeletedWorkspaceDTO[] }`. 호출자가 소유한 워크스페이스 가운데 삭제되었고 아직 복원할 수 있는 것입니다(`deletedAt`, `purgeAt` = deletedAt + `WORKSPACE_RESTORE_DAYS`, 기본 30일). 최신순입니다. `DELETE /api/workspaces/:id/permanent`는 그중 하나를 바로 완전히 지웁니다(0.22).
- `POST /api/workspaces/:id/restore`(소유자) → `{ workspace: WorkspaceDTO }`. 모든 것이 원래대로 돌아옵니다(멤버, 역할, 페이지, 링크, 초대 코드). 삭제되지 않았거나 복원 기간(`WORKSPACE_RESTORE_DAYS`, 기본 30일)이 지났으면 404, member는 403, 이미 `LIMIT_WORKSPACES_PER_USER`를 넘은 소유자는 403 `LIMIT_WORKSPACES`. `workspace_deleted` 알림은 지웁니다.
- 정리 작업(housekeeping)이 삭제된 지 `WORKSPACE_RESTORE_DAYS`(기본 30)일이 넘은 워크스페이스를 지웁니다. 모든 행은 FK cascade로, 업로드 blob은 커밋 뒤에 지웁니다(계정 강제 삭제 때 개인 워크스페이스를 지우는 것과 같은 함수입니다).

<a id="snapshots-version-history-doc-pages-visibleto-guard"></a>
## 스냅샷(버전 기록, doc 페이지, visibleTo 가드)
- `POST /api/pages/:id/snapshots` 본문 `createSnapshotSchema { label? }` → `{ snapshot: SnapshotDTO }`.
- `GET /api/pages/:id/snapshots` → `{ snapshots: SnapshotDTO[] }` 최신 50개(`created_at DESC, id DESC`). AI 단계 행(0.17)에는 `step`이 붙습니다("v0.17.0 추가 사항" 참고).
- `GET /api/pages/:id/snapshots/:sid/preview` → `{ markdown: string }`.
- `POST /api/pages/:id/snapshots/:sid/restore` → `{ ok: true }`(0.17에서 `before`와 `step`이 붙음, "v0.17.0 추가 사항" 참고). 살아 있는 문서에 적용하고(DirectConnection), 복원 직전에 스냅샷을 자동으로 하나 남깁니다. 캔버스는 400.
- 자동: store 훅에서 마지막 스냅샷에서 10분 이상 지났으면 바뀌기 전 상태를 저장합니다. 페이지마다 50개를 남깁니다.
- 행은 전체 상태이거나 이전 버전에 대한 Yjs V2 차이(diff)입니다(사슬은 최대 10개, docs/adr/1100-*). `SnapshotDTO.bytes`는 저장된 크기입니다. 버전을 다시 만들 수 없으면 미리보기, 비교, 복원이 409 `SNAPSHOT_UNAVAILABLE`로 답하고, 이때 복원은 아무것도 쓰지 않습니다.

<a id="m9-contract--calendar-view--daily-notes--templates"></a>
# M9 계약: 캘린더 뷰 · 데일리 노트 · 템플릿

<a id="calendar-view"></a>
## 캘린더 뷰
- `collection_views.type`에 `'calendar'`가 생깁니다(schema/shared에 반영). `viewConfigSchema.dateFieldId?`를 추가했습니다.
- 서버: 기존 컬렉션·뷰 API를 그대로 씁니다(calendar는 config.dateFieldId를 더 저장할 뿐입니다). **그리는 일은 웹 앱만 합니다.** 행을 날짜 속성 값에 따라 월 격자에 놓습니다.

<a id="daily-notes"></a>
## 데일리 노트
- 서버 API가 필요 없습니다. 웹 앱이 기존 createPage를 씁니다. 개인 섹션에 데일리 폴더(kind=folder, scope=private)가 있는지 확인해 없으면 만들고,
  제목이 `YYYY-MM-DD`인 페이지를 찾거나 만들어서 그 페이지로 이동합니다(usePages에서 제목으로 찾습니다).

<a id="page-duplication-templates-see-templates"></a>
## 페이지 복제(템플릿은 [템플릿](#templates) 참고)
- `POST /api/pages/:id/duplicate` → `{ pages: PageMetaDTO[] }`(복제된 루트 + 하위 페이지).
  - 대상 페이지와 하위 트리를 재귀적으로 복제합니다. 새 id를 쓰고, 같은 부모 아래에 두며(루트 제목은 "Copy of …", 현지화됨), page_docs 상태를 복사하고,
    props를 복사하며, 컬렉션이면 collections/views도 복사합니다. 위키 링크 href는 v1에서 원본을 계속 가리킵니다(다시 쓰지 않음, 보고된 사항).
  - visibleTo 가드를 거치고, 같은 scope를 유지합니다.

---

<a id="mcp-remote-connector--oauth-21"></a>
# MCP 원격 커넥터 + OAuth 2.1

사용 안내: [MCP.ko.md](MCP.ko.md). Claude Code / claude.ai가 `https://<domain>/mcp`에 연결하고, 사용자마다 브라우저 동의 화면에서
허용하고 나면 노트를 **그 사용자의 권한으로만** 읽고 씁니다.

<a id="endpoints-root-not-api-cors--no-cookies"></a>
## 엔드포인트(`/api`가 아닌 루트, CORS `*`, 쿠키 없음)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource`(`/mcp`를 붙인 경로도 같음) | RFC 9728. `resource=<origin>/mcp`, `authorization_servers=[<origin>]` |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414. code + S256 + `token_endpoint_auth_methods=["none"]` |
| POST | `/oauth/register` | RFC 7591 DCR(공개 클라이언트). `redirect_uris`는 https이거나 `http://localhost|127.0.0.1|[::1]:<any port>`여야 합니다. 201 `{client_id,…}`. 분당 20회 |
| GET | `/oauth/authorize` | **서버 라우트가 없습니다.** SPA 동의 화면(`OAuthAuthorize.tsx`)입니다. 로그인하지 않았으면 `/login?next=`를 거칩니다 |
| POST | `/oauth/token` | form-urlencoded(JSON도 받음). `authorization_code`(code는 한 번만, 5분, PKCE S256, redirect_uri가 같아야 함) / `refresh_token`(회전식. 이전 refresh token을 다시 쓰면 연결 전체를 폐기). access는 1시간, refresh는 60일(쓸 때마다 연장). 오류는 RFC 6749 `{error,error_description}` |
| POST | `/mcp` | MCP Streamable HTTP(stateless, JSON 응답). 토큰이 없거나 잘못되면 → 401 + `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. GET/DELETE → 405 |

<a id="apioauth-session-cookie-only-403-with-a-bearer-token"></a>
## `/api/oauth/*`(세션 쿠키만, bearer 토큰은 403)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/oauth/authorize/info?client_id&redirect_uri` | `{ client:{id,name}, redirectHost }`. 등록되지 않은 클라이언트 / redirect 불일치 → 400(리디렉트하지 않음) |
| POST | `/api/oauth/authorize` | 본문 = authorize 쿼리 + `decision: allow|deny` → `{ redirectTo }`(code+state 또는 error) |
| GET | `/api/oauth/grants` | 연결된 앱 `{ grants: [{id, clientName, createdAt, lastUsedAt}] }` |
| DELETE | `/api/oauth/grants/:id` | 204. access 토큰과 refresh 토큰을 바로 무효로 만듭니다 |

<a id="token--permissions"></a>
## 토큰 → 권한

- DB: `oauth_clients`, `oauth_codes`(code 해시), `oauth_grants`(access/refresh 토큰의 SHA-256 해시 + 이전 refresh 해시). 원래 토큰은 저장하지 않습니다.
- `requireUser`는 `Authorization: Bearer`를 받지만, **`/mcp` 핸들러의 내부 inject(프로세스 비밀 헤더)에서 온 것만** 받습니다.
  밖에서 토큰으로 `/api/*`를 직접 부르면 → 401. 그래서 토큰으로 할 수 있는 일 = MCP 도구 범위뿐입니다(완전 삭제, 멤버 관리, 공개 공유, 관리자 API는 없음).
- 도구는 `app.inject`로 기존 REST 라우트를 토큰 사용자로서 부릅니다. 그래서 멤버십과 🔒 개인 페이지 공개 범위 검사가 웹과 똑같습니다. inject에는 원래 클라이언트 IP가 실려서 rate-limit 버킷이 섞이지 않습니다.

<a id="tools"></a>
## 도구

읽기: `find_context(query?, queries?, workspaceId?, budget?)`(`query` / `queries` 중 하나), `read_page(pageId, outline?, section?, maxChars?)`, `read_pages(pageIds[], budget?)`,
`list_workspaces`, `list_pages(workspaceId, parentId?|'root', depth?, format?)`, `search(query, workspaceId?, format?)`,
`changes_since(cursor?, workspaceId?, budget?, detail?)`, `query_rows(collectionId, filter?, sort?, fields?, limit?, cursor?, describe?)`, `list_templates`,
`get_instructions(workspaceId, forPageId?)`(docs/adr/0975-*). 텍스트 출력은 멤버가 쓴 내용을 `<untrusted_content …>`로 감싸고
`can:` / `applies:` / `suspicious:` 줄을 붙입니다(docs/adr/0976-*, 0977-*).
쓰기(읽기 전용 토큰은 거절): `patch_section(pageId, section, markdown?, mode, baseVersion?)`, `update_page(pageId, markdown, mode: append|replace)`,
`create_page(workspaceId, title, markdown, parentId?, private?)`, `import_folder`, `update_row(rowId, properties, baseVersion)`, `create_row(collectionId, title?, properties?)`,
`rename_page`, `move_page(pageId, parentId|null, section?)`(같은 워크스페이스 안에서만), `trash_page`(소프트 삭제), `add_comment(pageId, body)`(첫 블록에 고정), `create_from_template`.
`list_pages`와 `search`는 `format: "lines"`나 `"compact"`가 아니면 예전 JSON을 그대로 씁니다(docs/adr/0928-*, 1541-*). JSON 응답은 멤버가 쓴 문자열을 정리하고, 끝에 `untrusted` 키(객체)나 두 번째 텍스트 블록(배열)을 붙입니다(docs/adr/1525-*). 나중에 추가된 도구는 아래 "v0.12.0 추가 사항", "v0.13.0 추가 사항", "v0.14.0 추가 사항", "v0.15.0 추가 사항"와 [MCP.ko.md](MCP.ko.md)를 보세요.

- `/.well-known/oauth-*`: `scopes_supported`는 `["read","write"]`입니다(`notes`도 전체 권한으로 계속 받습니다).
- `GET /api/oauth/authorize/info?…&scope=`: `requestedAccess: "read" | "write"`가 붙습니다.
- `POST /api/oauth/authorize`: 선택 항목 `access: "read" | "write"`(요청한 scope보다 넓을 수 없고, 없으면 요청한 대로).
- `GET /api/oauth/grants`: grant마다 `access: "read" | "write"`가 붙습니다.
- scope가 `read`인 Bearer(MCP) 토큰은 GET/HEAD가 아닌 모든 라우트에서 403을 받습니다. 라우트가 `config.bearerReadOnlyOk`를 두었으면 예외입니다(docs/adr/0935-*).

<a id="body-edit-route-for-mcp-but-also-callable-with-a-cookie"></a>
## 본문 편집 라우트(MCP용이지만 쿠키로도 부를 수 있음)

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| POST | `/api/pages/:id/content` | `{ markdown, mode: 'replace'|'append' }` | `{ ok: true }`. doc 페이지만 됩니다(아니면 400). 가져오기와 같은 `markdownToBlocks`로 바꾼 뒤 스냅샷 복원과 같은 DirectConnection으로 넣습니다(실시간으로 적용되고, store 훅이 색인을 갱신합니다). append는 새 블록을 기존 블록 뒤에 넣습니다(기존 블록은 건드리지 않음). replace는 이전 상태를 "Before AI edit" 스냅샷으로 남깁니다. 분당 30회 |

<a id="agent-retrieval-and-section-editing-docsadr09260930"></a>
## 에이전트 검색과 섹션 편집(docs/adr/0926–0930)

세션 쿠키 또는 MCP bearer(내부 inject). 토큰 수는 추정값입니다(ADR 0926).

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/context` | `q`(1–300자. 여러 번 줄 수 있고, 정규화한 뒤 서로 다른 값 5개까지, ADR 1720), `workspaceId?`(없으면 내가 속한 살아 있는 워크스페이스 전부), `budget?`(≤ 12,000, 기본 3,500) | `{ fragments: [{pageId, workspaceId, title, anchor, headingPath, sections: [{anchor, headingPath, version}], ords, text, tokens, score, truncated}], more: [{pageId, title, anchor, headingPath, tokens}], titleOnly: [{pageId, title, kind}], budget, usedTokens, candidates }`. 살아 있는 워크스페이스의 살아 있고 볼 수 있는 페이지만 나옵니다. 서로 다른 `q`가 2개 이상이면 `queries: string[]`와 `fragments[].matched: string[]`(쿼리 번호 "1".."5")도 붙습니다. 예산은 모두 합쳐 하나이고, 섹션은 한 번씩만 나옵니다. 의미 검색이 켜져 있는 동안에는 `q`가 하나일 때도 결과를 합칩니다(v0.14.0 추가 사항) |
| GET | `/api/pages/:id/outline` | – | `{ page: {id, title, kind, workspaceId, updatedAt}, sections: [{anchor, headingPath, level, tokens, version}], tokens }`(doc이 아닌 페이지는 `sections`가 비어 있습니다. `tokens`는 섹션의 색인 조각을 더한 값입니다. 섹션 색인이 최신이면 거기서 답합니다, docs/adr/1041-*) |
| GET | `/api/pages/:id/section` | `ref`(앵커, 제목 글자, 제목 경로 또는 제목 블록 id), `maxChars?` | `{ page, section: {anchor, headingPath, level, version}, markdown, truncated, totalChars }`. 모르는 ref → 유효한 앵커 목록과 함께 404 `SECTION_NOT_FOUND` |
| GET | `/api/pages/read` | `ids`(쉼표로 구분, ≤ 20), `budget?`(≤ 30,000, 기본 8,000) | `{ pages: [{id, title, workspaceId, kind, updatedAt, markdown, tokens, truncated}], omitted: [{id, title, reason}], missing: [id], budget, usedTokens }`. 볼 수 없는 id는 `missing`에만 나옵니다 |
| POST | `/api/pages/:id/section` | `{ ref, markdown, mode: replace\|append\|prepend\|insert_after\|delete, baseVersion? }` | `{ ok, section: {anchor, headingPath, version} \| null, sections }`. doc 페이지만 됩니다. 버전이 맞지 않으면 → `error.current {anchor, headingPath, version, markdown}`과 함께 409 `SECTION_CONFLICT`이고 아무것도 쓰지 않습니다. replace/delete는 "Before AI edit" 스냅샷을 남깁니다(페이지마다 2분에 최대 1개). 분당 30회 |

<a id="collection-queries-for-agents-docsadr0934-"></a>
## 에이전트용 컬렉션 쿼리(docs/adr/0934-*)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/pages/:id/collection/query` | 컬렉션의 행을 SQL에서 거르고 정렬하고 나눠서 돌려줍니다. 쿼리: `filter`(짧은 문법, ADR 0934 참고), `sort`("Due desc, Title"), `fields`(JSON 배열이나 쉼표 목록, `*` = 전부), `limit`(1–200, 기본 25), `cursor`(불투명한 `nextCursor`), `describe=1`(스키마만, `definitions`가 붙음). `{collection, workspaceId, fields, columns, rows: [{id, version, cells}], nextCursor}`를 돌려줍니다. 400 `INVALID_QUERY` / `QUERY_TIMEOUT`. |
| GET | `/api/pages/:id/row` | 컬렉션 행 하나: `{collection, workspaceId, fields (definitions), columns, row: {id, title, version, cells}}`. 컬렉션 행이 아닌 페이지는 400 `NOT_A_ROW`. |
| PATCH | `/api/pages/:id/props` | (추가) 선택 항목 `baseVersion`(위 두 라우트가 준 행 버전). 맞지 않으면 → `currentVersion`과 함께 409 `ROW_VERSION_CONFLICT`이고 아무것도 쓰지 않습니다. `baseVersion`을 보내면 응답에 `version`도 들어갑니다. |

<a id="edit-lock-and-agent-instructions-docsadr09700978"></a>
## 편집 잠금과 에이전트 지침(docs/adr/0970–0978)

기본으로는 아무것도 잠겨 있지 않습니다. 페이지에 건 잠금은 그 하위 트리까지 덮고, 가장 가까운 잠긴 조상이 규칙을 정합니다. 편집할 수 없는
멤버가 쓰려고 하면 **403 `PAGE_LOCKED`** 오류가 납니다. 오류에는 `error.lockedPageId`와 `error.editors [{id, name}]`
(페이지 소유자가 맨 앞)이 들어가고, 메시지에 편집할 수 있는 사람의 이름이 나옵니다. 페이지, 컬렉션, 할 일, ink,
스냅샷 복원, 문서 소유자/living, 시트 동기화, 볼트 동기화의 모든 쓰기 라우트가 이것을 검사합니다. 잠긴 부모 아래에 만들기,
잠긴 하위 트리 안팎으로 옮기기, 호출자가 편집할 수 없는 잠금을 품은 하위 트리의 휴지통 이동/복원/완전 삭제도
거절합니다. 댓글은 따로 권한을 봅니다(사람은 언제나 댓글을 달 수 있고, 잠금으로 에이전트의 댓글 권한을 뺄 수 있습니다).
편집할 수 없는 멤버의 협업 소켓은 읽기 전용입니다(Hocuspocus `authenticated` scope `readonly`. 업데이트에는 SyncStatus false로 답하고 버립니다).

| 메서드 | 경로 | 본문 / 쿼리 | 응답 |
|---|---|---|---|
| GET | `/api/pages/:id/lock` | – | 호출자 기준 `PageLockDTO { pageId, locked, own, lockRoot {id,title}\|null, owner, editors, people: editors\|everyone\|null, agents: same\|comment\|read\|null, canEdit, canComment, canManage, instructions }`(MCP 요청은 에이전트로 평가합니다) |
| PUT | `/api/pages/:id/lock` | `{ locked, people?, agents?, editorIds? }` | `PageLockDTO`. 브라우저 세션만 됩니다(bearer → 403). 소유자/관리자, 또는 편집할 수 있는 동안의 페이지 소유자가 할 수 있습니다. 개인 페이지 → 400. 감사 기록: `page.locked`, `page.unlocked`, `page.lock_editors_changed`. 잠금을 풀면 지침 지정도 없어집니다(`instructions.removed`). 하위 트리의 열린 소켓을 닫아 클라이언트가 다시 인증하게 합니다 |
| PUT | `/api/pages/:id/agent-instructions` | `{ mode: always\|match\|manual, applyTo?: ["page:<id>" \| "Title/**"], description?, sortOrder? }` | `PageLockDTO`. 소유자/관리자, 브라우저만. 공유 doc 페이지만 됩니다. 필요하면 페이지를 잠급니다. `match`에는 비어 있지 않은 `applyTo`가 필요합니다. 감사 기록 `instructions.set` |
| DELETE | `/api/pages/:id/agent-instructions` | – | `PageLockDTO`(지정은 없애고 잠금은 남깁니다) |
| GET | `/api/workspaces/:id/agent-instructions` | – | `{ instructions: AgentInstructionDTO[] }`(살아 있고, 잠겨 있고, 공유된 doc 페이지만) |
| GET | `/api/workspaces/:id/agent-instructions/bundle` | `forPageId?` | `{ workspaceId, forPageId, always: [..dto, markdown, truncated], matching: [...], otherMatch, manual, version }`(MCP `get_instructions`) |
| GET | `/api/pages/agent-context` | `ids`(≤ 50), `read=1?` | `{ pages: [{id, can: "read,comment,edit", createdBy, lastEdit {name, via}\|null, large, suspicious: [{anchor, rules}]}], applies: [{pageId, title, mode}] }`(`large`: 상태 ≥ 1 MiB 또는 색인된 토큰 ≥ 50k, docs/adr/1043-*). MCP 도구는 이 라우트를 부르지 않고 프로세스 안에서 같은 객체를 계산합니다(docs/adr/1070-*). `read=1`이면 표시된 내용이 에이전트에게 돌아갈 때 `oauth_grants.tainted_at`을 기록합니다 |
| GET | `/api/pages/:id/suspicious` | – | `SuspiciousSectionsDTO { pageId, sections: [{anchor, headingPath, rules}] }`. 색인할 때 저장해 둔 인젝션 의심 휴리스틱 결과(`page_chunks.suspicious`)이고, 신호일 뿐입니다 |

`PageMetaDTO.editLocked?: true`는 자기 잠금을 가진 페이지에 붙습니다. 새 감사 동작: `page.locked`,
`page.unlocked`, `page.lock_editors_changed`, `instructions.set`, `instructions.removed`, `content.suspicious`
(페이지와 규칙마다 처음 감지했을 때만, actor 없음).

OAuth: `POST /oauth/register`는 접어서(fold) 비교했을 때 예약어가 되는 `client_name`(Inkling, Admin, System, public form, …)을 거절합니다
(400 `invalid_client_metadata`). `POST /api/oauth/authorize`도 같은 예약어를 거절합니다(400
`CLIENT_NAME_RESERVED`). 다른 멤버와 이름이 똑같은 클라이언트는 요청할 때 워크스페이스마다 거절합니다
(403 `CLIENT_NAME_CLASH`, 그 멤버가 있는 워크스페이스에서만. Claude 같은 흔한 앱 이름은 예외). 그리고
`GET /api/oauth/authorize/info`에는 동의 화면용 `nameNotice: { member, workspaces[], blocking } | null`이 붙습니다
(docs/adr/1007-*).


접근 규칙을 바꾸는 작업은 진행 중인 쓰기가 끝나기를 기다립니다(docs/adr/1071-*). `PUT /pages/:id/lock`, `PUT|DELETE /pages/:id/agent-instructions`, `POST|DELETE /workspaces/:id/agents/blocks`, `PUT /pages/:id/owner`, 역할 변경, 멤버 내보내기, `parentId`를 바꾸는 `PATCH /pages/:id`는 워크스페이스 접근 행을 배타적으로 잡습니다. 같은 워크스페이스의 트랜잭션 쓰기는 그 행을 공유로 잡습니다(lock_timeout 10초). 이런 변경 바로 다음 요청부터 새 규칙이 적용됩니다.

<a id="provenance-docsadr0936-"></a>
## 출처 기록(docs/adr/0936-*)

- `GET /api/pages/:id/snapshots`: 스냅샷마다 `author: {id, name} | null`과 `viaClient: string | null`이 붙습니다.
- 댓글 DTO에 `viaClient: string | null`이 붙습니다(MCP로 쓴 경우 OAuth 클라이언트 이름).

<a id="change-feed-docsadr0932--0933-"></a>
## 변경 피드(docs/adr/0932-*, 0933-*)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/changes?cursor&workspaceId&budget&detail` | 커서 이후의 변경입니다(토큰 예산 안에서 섹션별 순 diff. `detail` = `none` \| `diff`(기본) \| `full`). 커서가 없으면 → 현재 커서. `{ status: 'start'\|'ok'\|'resync_required', cursor, text, changes, detailed, listedOnly, rows, more }`를 돌려줍니다. 400 `INVALID_CURSOR` / `CURSOR_WORKSPACE`. `workspaceId`를 주면 → 멤버십이 필요합니다. 변경 시점에 볼 수 있던 페이지만 알려 줍니다. 더 이상 볼 수 없는 페이지는 내용 없이 `removed (no longer visible)`로 나옵니다. 행은 `CHANGE_FEED_RETENTION_DAYS`(기본 30)일 동안 보관합니다 |

0.15.1부터는 앵커가 한 제목에서 다른 제목으로 넘어가면 수정이 아니라 이름 바꾸기로 기록합니다. 다른 `## Decided` 위에
`## Decided`를 넣으면 `renamed decided>decided~2` + `added decided`가 됩니다(전에는 `modified decided` + `added decided~2`).
글로는 `renamed decided → decided~2`로 나옵니다(docs/adr/1960-*, 아래 "v0.15.1 추가 사항" 참고).

<a id="notifications-subscriptions-activity-and-the-agent-inbox-docsadr10001007"></a>
## 알림, 구독, 활동, 에이전트 inbox(docs/adr/1000–1007)

알림 행은 그것을 일으킨 쓰기(댓글, 본문 @멘션, 문서 소유자, person 칸, 팔로우한 페이지의 편집)가 끝난 뒤 백그라운드 큐가 씁니다.
`NotificationDTO`에 `via`, `count`(합쳐진 반복 횟수), `excerpt`(≤ 200자 평문), `anchor`, `quiet`(배지 없이 목록에만 나옴: 에이전트가 쓴 멘션과 수준
`nothing`)가 붙습니다. 안 읽은 개수는 quiet 행을 세지 않습니다. 새 타입: `comment_reply`, `page_owner`, `task_assigned`,
`page_update`, `agent_digest`, 예약된 `approval_request`(음소거를 통과)와 `approval_result`. 이제 `doc_mention`도
실제로 만듭니다.

| 메서드 | 경로 | 본문 / 쿼리 | 응답 |
|---|---|---|---|
| GET | `/api/me/notification-settings` | – | `NotificationSettingsDTO { emailInstant, emailDigest: 'off'\|'daily'\|'weekly', mailAvailable, subscriptions: SubscriptionDTO[] }`(세션 쿠키만) |
| PATCH | `/api/me/notification-settings` | `{ emailInstant?, emailDigest? }` | 같은 DTO. 채널을 끄면 그 채널로 보내려고 기다리던 것을 버립니다 |
| GET | `/api/pages/:id/subscription` | – | `PageSubscriptionDTO { own, effective: {level, source: page\|ancestor\|workspace\|default, fromPageId, fromTitle}, agentDigest, implicit }`(세션만) |
| PUT | `/api/pages/:id/subscription` | `{ level: 'all'\|'mentions'\|'nothing'\|'mute'\|null, subtree?, agentDigest? }` | 같은 DTO. `level: null`은 내 행을 지웁니다(상속). "Follow"(팔로우) = `all` |
| GET / PUT | `/api/workspaces/:id/notification-level` | PUT `{ level, agentDigest? }` | `{ level, agentDigest, isDefault }`: 그 워크스페이스에서 내 기본값(세션만) |
| GET | `/api/workspaces/:id/activity` | `before, limit (≤100), actor=any\|human\|ai, via, userId, rootId, kind=any\|edit\|page, aiPagesOnly=1` | `ActivityPageDTO { items: ActivityItemDTO[], next, clients }` 최신순. 다른 사람의 개인 페이지 행은 절대 나오지 않고, 제목은 지금 볼 수 있는 페이지만 나옵니다 |
| GET | `/api/changes/:seq/diff` | – | `ChangeDiffDTO { before, after, ops: [{t:'='\|'-'\|'+', s}] \| null, large, … }`. 페이지를 지금 볼 수 있고 기록될 때도 그 행을 볼 수 있었던 경우가 아니면 404. 워크스페이스 멤버가 아니어도 404(docs/adr/1301-*) |
| GET | `/api/pages/:id/snapshots/:sid/diff` | `against=current\|<snapshot id>` | `SnapshotDiffDTO { from, to, ops, large }`(두 버전의 Markdown, 줄 단위 diff) |
| GET | `/api/pages/:id/provenance` | – | `PageProvenanceDTO { createdVia, createdByName, lastAgentEdit: {at, via, actorName} \| null }` |
| GET | `/api/inbox` | `workspaceId?, cursor?, kinds=mention,reply,comment,assigned,…` | `{ items: InboxItem[], more, unacked }`: 호출자에게 직접 온 항목 가운데 확인(ack)하지 않은 것, `seq` 순서(MCP `inbox`) |
| POST | `/api/inbox/ack` | `{ ids?: string[], cursor?: string, workspaceId?: uuid, kinds?: InboxKind[] }` | `{ acked }`. `acked_at`을 넣고 `read`는 건드리지 않습니다. `ids`: 정확히 그 항목들. `cursor`: 같은 `workspaceId`/`kinds`로 부른 `GET /api/inbox`가 보여 주는 항목 가운데 그 커서까지(공개 범위, 범위, 멤버십, 에이전트 접근, two-step 규칙을 모두 적용). `workspaceId`/`kinds`가 없으면 거르지 않은 inbox 전체가 대상입니다(docs/adr/1922-*) |

에이전트(bearer) 요청이 `resolved`를 담아 `PATCH /api/comments/:id`를 부르면, 스레드 첫 댓글을 토큰 사용자가 쓴 경우가 아닌 한
403 `AGENT_RESOLVE_NOT_ALLOWED`입니다. `PageMetaDTO`는 바뀌지 않습니다. MCP로 만든 페이지(`POST /api/pages`, 가져오기, import-folder,
from-template)에는 `pages.created_via`를 넣습니다. 웹훅 이벤트에 `assigned`와 `agent_digest`(매일)가 생깁니다. 메일에는 SMTP가 필요하고, 링크는 APP_URL/PUBLIC_URL로 만듭니다.
`NOTIFY_MAIL_DELAY_MS`(기본 120000)만큼 즉시 메일을 늦춥니다. 그래서 한꺼번에 몰린 알림은 메일 한 통이 되고, 그 사이 앱에서 먼저 읽으면 메일을 보내지 않습니다.

<a id="public-folder-sharing-2026-09-23"></a>
# 공개 폴더 공유 (2026-09-23)

폴더(`kind='folder'`)를 공개 링크 하나로 공유합니다. 링크를 가진 사람은 로그인하지 않고도 폴더의 **현재 하위 트리**를 둘러보고 읽을 수 있습니다.
게시와 중지 규칙은 페이지 하나를 공유할 때와 같습니다(워크스페이스 소유자만, `scope='private'` → 400). 기존 단일 페이지 공유 동작은 바뀌지 않습니다.

- **하위 트리 = 요청할 때 계산합니다**(재귀 CTE). 나중에 추가되거나 옮겨 들어온 페이지는 저절로 들어가고, 밖으로 옮겨진 페이지는 저절로 빠집니다.
  휴지통에 있는 페이지(`deleted_at`), 개인 페이지(`scope='private'`), 템플릿 페이지에서는 더 내려가지 않습니다 → 그 하위 트리 전체가 빠집니다. 같은 워크스페이스 안에서만이고, 깊이 제한은 64입니다.
- **ref(불투명 식별자)**: `ref = base64url(HMAC-SHA256(key=shareToken, msg=pageId))`의 앞 22자. 내부 페이지 UUID는 공개 응답이나 URL에 절대 나오지 않습니다(M15 유출 금지 원칙).
  단방향이라 ref에서 pageId를 거꾸로 알아낼 수 없습니다. 공유를 멈췄다가 다시 하면 토큰이 바뀌므로 모든 ref도 바뀝니다. 서버는 요청마다 하위 트리를 다시 계산해 ref를 찾습니다(매핑 테이블 없음, 마이그레이션 없음).
- 하위 트리 밖 / 휴지통 / 개인 / 없음 / 볼 수 없는 종류 → 언제나 **404**(403이 아님).

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/pages/:id/share` · POST도 같음 | `ShareStatusDTO` + 폴더이면 `exposedCount`(지금 볼 수 있는 doc/collection 하위 페이지 수, 폴더 자신은 제외) |
| GET | `/api/public/:token`(폴더 토큰) | `PublicFolderDTO { kind:'folder', title, icon, tree: PublicTreeNodeDTO[], updatedAt }`. 노드 = `{ ref, title, icon, kind, children }`. 컬렉션 행은 트리에서 숨깁니다(앱 사이드바와 같음). 단일 페이지 토큰은 기존 `PublicPageDTO`를 돌려줍니다(kind 필드 없음) |
| GET | `/api/public/:token/p/:ref` | 하위 doc/collection의 본문을 `PublicPageDTO`(서버에서 그린 HTML)로 돌려줍니다. folder/canvas ref → 404. 위키 링크: 하위 트리 안의 대상 → `/s/<token>/p/<ref>`(루트 폴더 → `/s/<token>`), 밖 → 그냥 글자. 첨부 URL → 아래 경로 |
| GET | `/api/public/:token/p/:ref/f/:fileId` | 그 **하위 페이지**의 블록/커버/아이콘이 참조하는 파일만(같은 워크스페이스). 다른 페이지의 fileId → 404 |
| GET | `/api/public/:token/f/:fileId` | 기존 라우트. 폴더 토큰이면 폴더 자신의 아이콘/커버만 |

공개 라우트 공통: 라우트마다 분당 60회, `Content-Security-Policy: default-src 'none'…` + nosniff, 본문은 `Cache-Control: no-store`, 파일은 `public, max-age=300`.
웹: `/s/:token`(폴더는 트리 + 읽기 창), `/s/:token/p/:ref`. 트리 행의 ⋯/오른쪽 클릭 메뉴에 "웹에 공유"(`Share to web`)가 있습니다(doc, collection, folder. 공유 섹션에서만).

<a id="calendar--due-dates-completed--tasks-inside-documents-2026-09-23"></a>
# 캘린더 · 마감 마무리: 문서 안의 할 일 (2026-09-23)

일반 문서만 쓰는 사용자도 캘린더와 마감 목록이 채워지도록, **문서 안의 체크리스트**를 날짜가 있는 항목으로 가져옵니다.

<a id="task-index-pagetasks-migration-0020pagetasks-additive-only"></a>
## 할 일 색인(`page_tasks`, 마이그레이션 `0020_page_tasks`, 추가만 함)

- `page_tasks(id, page_id FK cascade, workspace_id FK cascade, block_id, text, due 'YYYY-MM-DD', checked, updated_at)`, 인덱스 `(workspace_id, due)`와 `(page_id)`.
  `page_task_index(page_id PK FK cascade, indexed_at)` = "색인 끝남" 표시입니다(부팅 때 백필이 새 문서만 고르도록).
- 뽑는 시점: 협업 store 훅(`reindexPageText/Tags` 옆), 가져오기, 템플릿 생성/인스턴스화, 복제. 페이지마다 한 트랜잭션에서 delete+insert를 합니다(페이지별 advisory lock).
  부팅할 때 표시가 없는 살아 있는 doc을 25개씩 백필합니다(묶음 사이 50ms 양보, 페이지별 오류 격리, 개수를 로그에 남김). 뽑는 과정은 문서에 절대 쓰지 않습니다(`stateToBlocks`로 읽기만).
- 대상: 글에 날짜가 있는 BlockNote `checkListItem`(자식 포함). 날짜 문법(우선순위 순, 블록마다 하나, 토큰은 보이는 글에서 지움):
  1. `📅 2026-09-30`(Obsidian Tasks) 2. 연도 있음: `2026-09-30`, `2026.9.30`, `2026/9/30`, `2026년 9월 30일`
  3. 연도 없음: `9/30`, `9월 30일` → 다가오는 날짜(올해, 또는 60일보다 더 전에 지났으면 내년). 동률이면 앞의 것을 고릅니다.
  숫자 경계를 검사하고(`1.2.3` 같은 버전과 `a/9/30` 같은 경로 제외), 없는 날짜(`2/30`)는 무시합니다. 상대어(`오늘/내일/모레`, today/tomorrow/the day after)는 해석하지 않습니다. 스키마에 날짜 멘션은 없습니다.

<a id="dated-items-mddateitemsts--dateitemdto"></a>
## 날짜가 있는 항목(`md/dateItems.ts` → `DateItemDTO`)

`{ kind: 'row'|'page'|'daily'|'task', pageId, title, icon, date, done, collectionTitle?, fieldId?, doneFieldId?, blockId?, parentPath?, pageTitle? }`
- row: 모든 컬렉션의 날짜 속성. done = 체크된 checkbox 속성, 또는 이름이 `/완료|done|끝|complete/i`에 맞는 select 옵션. `doneFieldId` = 이름이 완료를 뜻하는 checkbox(없으면 첫 checkbox. 둘 다 없으면 빠짐 → 체크할 수 없음).
- page: type='date'인 `properties`(`fieldId` = 속성 id). done = `done` checkbox 속성. daily: 제목이 `YYYY-MM-DD`. task: `page_tasks`(done = checked).
- 모두 워크스페이스 + `visibleTo` 범위로 제한하고, 휴지통에 있는 것은 뺍니다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/workspaces/:id/calendar?month=YYYY-MM` 또는 `?from=&to=`(≤62일) | `{ events: CalendarEventDTO[] }` = DateItemDTO + 예전 방식과 호환되는 `type`(=kind). 행은 날짜 속성마다 따로 항목이 됩니다 |
| GET | `/api/workspaces/:id/due` | `DueResponseDTO { today, items: (DateItemDTO & {section})[], counts }`. 구역: `overdue`(끝나지 않음, 최근 60일), `today`, `tomorrow`, `week`(7일 가운데 나머지), `next30`, `done`(끝남 + 날짜가 7일 전부터 30일 뒤까지). row/page/task만(daily 제외). 행마다 하나: 이름이 `마감|due|deadline|기한`인 날짜 속성의 값을 먼저 쓰고, 없으면 값이 있는 첫 날짜 속성. `?range=`는 받지만 무시합니다 |
| PATCH | `/api/pages/:id/tasks/:blockId` | `{ checked?, due? }` → 문서 안 체크리스트 항목 하나의 완료를 바꾸거나 날짜를 바꿉니다. `{ ok, task }`. 분당 120회. 404 = 그런 블록 없음, 400 = 날짜 토큰이 없거나 검증 실패 |
| POST | `/api/workspaces/:id/tasks` | `{ title, date }` → 워크스페이스 Tasks 문서 끝에 `- [ ] title 📅 date`를 붙이고 바로 다시 색인합니다. Tasks 문서는 공유 섹션 최상위에 있고, 없으면 만듭니다(advisory lock으로 하나만 생기게 보장). 제목은 [요청 로케일](#localization)을 따릅니다. `{ ok, pageId, blockId }`. 분당 60회 |
| POST | `/api/pages` | 기존 + `date?: 'YYYY-MM-DD'` → 날짜 속성(`{id:'date', name:<"Date", localized>, type:'date'}`)이 있는 doc을 만듭니다 |
| PATCH | `/api/pages/:id` | 기존 + `dateProperty?: { id?, value: 'YYYY-MM-DD'|null }`(없으면 "Date" 속성으로 추가, null이면 지움) · `done?: boolean`('done' checkbox 속성) |

**안전한 문서 쓰기 경로**: 문서에 쓰는 것은 위의 PATCH tasks / POST tasks 라우트뿐입니다(사용자가 명시적으로 한 동작).
- 할 일 편집: Hocuspocus `openDirectConnection` → 기존 `checkListItem` 요소의 `checked` 어트리뷰트만 바꾸거나, 기존 `Y.XmlText` 안 날짜 토큰의 글자만 바꿉니다(서식 유지, 새 노드 없음). 같은 편집을 먼저 복제한 Y.Doc에 적용하고 BlockNote 변환으로 검증합니다(블록 수 그대로, 대상의 checked/날짜가 기대대로, 날짜 밖 본문은 그대로). 통과할 때만 실제 문서에 적용합니다. 페이지를 열어 둔 편집자에게 바로 보이고, store 훅이 저장하고 다시 색인합니다. 날짜 토큰은 원래 모양을 유지합니다(`9/30`→`10/2`, 연도가 바뀌면 ISO).
- 빠른 추가: `md/docWrite.appendBlocksToDoc`은 `markdownToBlocks` 결과로 BlockNote `blocksToYDoc`가 만든 blockContainer의 깊은 복사본만 최상위 blockGroup 끝에 넣습니다(기존 블록은 다시 쓰지 않음 → 서버 스키마에 없는 콜아웃, 임베드, 멘션이 보존됩니다). 복제본에서 "기존 블록 그대로 + 개수 +1"을 확인한 뒤 적용합니다.
  (`POST /pages/:id/content`의 append는 전부 다시 쓰기 때문에 거기서는 이런 블록이 사라집니다. 이 append는 동작을 바꾸지 않은 채 같은 모듈의 `writeBlocksToDoc`으로 옮겼습니다.)

리마인더: 매시간 도는 검사에 "오늘 마감인 끝나지 않은 할 일이 있는 페이지 → 그 페이지 작성자(워크스페이스 멤버일 때)"가 추가됩니다. 행 리마인더와 같이 페이지마다 하루 한 번으로 중복을 막고, 페이지별로 오류를 격리합니다.

웹: 캘린더 월/주 보기(설정 `calendar.view`), 종류 필터와 완료 표시 토글(범례 역할도 함), 빈 날짜 클릭 / 날짜 숫자에서 Enter → 팝오버(할 일 추가 · ⌘/Ctrl+Enter로 이 날짜에 새 페이지 · 데일리 노트 열기/만들기. 휴대폰에서는 하단 시트), 칩 끌기(행/페이지/할 일만 되고 데일리는 안 됨. MouseSensor 5px, TouchSensor 250ms), 할 일 칩 클릭 → `?block=<id>`로 그 블록까지 스크롤하고 강조합니다.
마감 목록: 구역, 개수, 체크(낙관적 반영 + 되돌리기 토스트), 출처, 상대 날짜, 맨 위 빠른 추가, 사이드바 배지(지난 마감 + 오늘, 지난 마감이 있으면 빨간색).

<a id="plugins-experimental"></a>
## 플러그인(실험 기능)

`EXPERIMENTAL_FEATURES=plugins`일 때만 등록됩니다(아니면 404). `GET /api/auth/mode`에
`experimental: string[]`(켜진 실험 이름)이 붙습니다. 설계: [PLUGINS.ko.md](PLUGINS.ko.md), ADR 0400–0405.

| 메서드 | 경로 | 비고 |
| --- | --- | --- |
| GET | `/api/admin/plugins` | 관리자(쿠키). `PLUGINS_DIR`을 새로 훑은 결과를 승인 정보와 합칩니다: `{ pluginsDir, appVersion, plugins: [{ id, status: 'invalid'\|'missing'\|'not-approved'\|'needs-reapproval'\|'enabled'\|'disabled', error, manifest, hash, install }] }` |
| POST | `/api/admin/plugins/:id/approve` | 관리자. `{ hash, permissions: string[] }` → 정확히 그 내용 해시를 `permissions ∩ manifest.permissions` 권한으로 켭니다. `hash`를 읽은 뒤 파일이 바뀌었으면 409 `PLUGIN_CHANGED`, 요청하지 않은 권한 / 잘못된 플러그인은 400 |
| POST | `/api/admin/plugins/:id/disable` | 관리자. `{ ok }` |
| DELETE | `/api/admin/plugins/:id` | 관리자. 승인을 잊고, 이 플러그인에 대한 모든 사용자의 `plugin_storage` 행을 지웁니다 |
| GET | `/api/plugins` | 사용자. 활성 플러그인 `{ plugins: [{ id, name, version, description, permissions, commands, blocks, frameUrl }] }`(승인됨 + 켜짐 + 디스크의 해시가 그대로) |
| GET | `/api/plugins/:id/pages/:pageId` | `read:pages`. `{ page: { id, workspaceId, title, kind, updatedAt, markdown } }`. 공개 범위와 멤버십은 사용자와 같습니다. canvas/folder → 400. 분당 120회 |
| GET | `/api/plugins/:id/search?workspaceId=&q=` | `read:pages`. 사용자로서 `/api/workspaces/:id/search`를 대신 부릅니다 → `{ pages: [{ id, title, kind, updatedAt, snippet }] }`. 분당 120회 |
| POST | `/api/plugins/:id/pages/:pageId/content` | `write:pages`. `{ markdown, mode: 'replace'\|'append' }` → 사용자로서 `POST /api/pages/:id/content`를 대신 부릅니다(웹 앱이 먼저 사용자에게 확인을 받음). 분당 30회 |
| GET | `/api/plugins/:id/storage` | `storage`. `{ keys }`(이 플러그인, 이 사용자) |
| GET / PUT / DELETE | `/api/plugins/:id/storage/:key` | `storage`. `PUT { value }`(JSON ≤ 64 KB. 사용자마다 플러그인마다 키 500개 / 1 MB → 넘으면 413 `PLUGIN_STORAGE_QUOTA`). `GET` → `{ value \| null }` |
| GET | `/api/plugin-sdk/v1.js` | 인증 없음. 프레임 안에서 쓰는 SDK(`text/javascript`, `nosniff`) |
| GET | `/api/plugin-frame/:id/:hash/index.html` | 인증 없음(opaque origin 프레임은 쿠키를 보내지 않음). 정확히 그 해시로 활성 상태가 아니면 404. CSP `default-src 'none'; script-src 'nonce-…'; connect-src 'none'; … frame-ancestors 'self'; sandbox allow-scripts`, `no-store` |
| GET | `/api/plugin-frame/:id/:hash/main.js` | 인증 없음. 승인된 번들의 바이트, `immutable` |

오류: 모르거나 비활성인 플러그인 → 404 `PLUGIN_NOT_FOUND`. 권한 없음 → 403
`PLUGIN_PERMISSION`. MCP bearer 토큰 → 403(브라우저 세션만 됩니다).

<a id="link-previews-embeds-share-unfurl-workspace-webhooks"></a>
## 링크 미리보기, 임베드, 공유 펼침(unfurl), 워크스페이스 웹훅

사용자 URL을 서버에서 가져올 때는 `safeFetch`(SSRF 가드, docs/adr/0500)를 거칩니다.

| 메서드 | 경로 | 비고 |
|---|---|---|
| GET | `/api/link-preview?url=` | 세션 필요. 세션마다 분당 30회. `{ preview: LinkPreviewDTO }`(`url` 최종 URL, `title`, `description`, `siteName`, `image`(https만), `favicon`(https만)). 닿지 않거나, 막혔거나, 2xx가 아니면 → 422 `PREVIEW_UNAVAILABLE`(일반 메시지). 메모리에 6시간 캐시(실패는 10분). `Cache-Control: private, max-age=3600`. docs/adr/0502 |
| GET | `/s/:token`, `/s/:token/p/:ref` | `WEB_DIST`를 설정했을 때만. 살아 있는 공유(`scope='shared'`) 페이지에는 `og:*` / `twitter:*` 메타와 `<title>`을 넣은 SPA 셸을, 아니면 기본 셸을 줍니다. IP마다 분당 120회, `no-store`. docs/adr/0503 |
| GET | `/api/workspaces/:id/webhooks` | 소유자(또는 멤버인 사이트 관리자). `{ webhooks: WebhookDTO[] }`, URL은 가림(`urlMasked`) |
| POST | `/api/workspaces/:id/webhooks` | 소유자. `{ url, events: WebhookEvent[] }` → `{ webhook }`. `url`은 `https://hooks.slack.com/services/…` 또는 `https://discord.com|discordapp.com/api/webhooks/<id>/<token>`이어야 하고, 아니면 400 `VALIDATION`. 최대 10개 → 넘으면 409 `LIMIT_REACHED`. 분당 20회 |
| PATCH | `/api/webhooks/:id` | 소유자. `{ events?, enabled? }` → `{ webhook }`. 다시 켜면 `failureCount`와 `autoDisabledAt`을 초기화합니다 |
| DELETE | `/api/webhooks/:id` | 소유자. 204 |
| POST | `/api/webhooks/:id/test` | 소유자. 분당 5회. 정해진 테스트 메시지를 바로 보냅니다 → `{ ok, status, error, webhook }` |

`WebhookEvent` = `mention`(댓글 @멘션) · `comment` · `reminder`(오늘 마감) · `page_created`(공유 섹션, 20초 뒤 보냄) · `review_due`(하루 한 번: 검토할 때가 된 공유 문서를 우선순위별로, docs/adr/0952-*).
웹훅 만들기/바꾸기/지우기는 감사 기록에 남습니다(`webhook.*`, 가린 URL).
`scope='shared'`가 아닌 페이지의 이벤트는 절대 보내지 않습니다. 이벤트가 5번 잇달아 실패하면 훅을 끄고 소유자에게
`webhook_disabled` 알림을 보냅니다(`NotificationDTO.workspaceId` 설정됨). docs/adr/0504.

자체 CSP가 없는 HTML 응답에는 `Content-Security-Policy: frame-src 'self' <embed providers>`가 붙습니다(docs/adr/0501).

<a id="collections-relations-rollups-batch-rows-gallerytimeline-sheets-sync-ical"></a>
## 컬렉션: 관계형, 롤업, 행 일괄 처리, 갤러리/타임라인, Sheets 동기화, iCal

뷰 타입: `table | board | calendar | gallery | timeline`. `ViewConfig`에 `cardCover`
(`none|cover|firstImage`), `cardFieldIds`, `cardSize`(`sm|md|lg`), `startFieldId`, `endFieldId`,
`zoom`(`day|week|month`)이 생깁니다. 속성 타입에 `relation`(`relation: { targetPageId, twoWay?, pairFieldId? }`,
값 = 행 id의 `string[]`)과 `rollup`(`rollup: { relationFieldId, targetFieldId | 'title', fn }`,
`fn` = `count|sum|avg|min|max|earliest|latest|percentChecked|showUnique`, 계산값이고 저장하지 않음)이 생깁니다.
컬렉션마다 속성은 200개까지입니다. docs/adr/0300, 0301.

| 메서드 | 경로 | 비고 |
|---|---|---|
| GET | `/api/pages/:id/collection` | 이제 `refs: Record<rowId, RowRefDTO>`도 돌려줍니다(볼 수 있는 연결된 행만). relation 칸에는 볼 수 있고 살아 있는 링크만 들어가고, rollup 값은 `props`에 넣어 줍니다. `?rows=0` → 정의만(`rows: []`) |
| PUT | `/api/pages/:id/collection/fields` | relation 대상(같은 워크스페이스의 볼 수 있는 컬렉션)과 rollup(이 컬렉션의 relation이어야 하고, `count`가 아니면 대상이 rollup/relation이면 안 됨)을 검증합니다 → 맞지 않으면 메시지와 함께 400. 새 `twoWay` relation은 대상 컬렉션에 짝 속성을 만듭니다(`pairFieldId`를 채움) |
| PATCH | `/api/pages/:id/props` | rollup 키는 무시합니다. relation 값: 잘못되었거나 숨겨진 id는 버리고, 기존의 숨겨진 링크는 남기며, 양방향 짝에도 똑같이 반영합니다 |
| GET | `/api/pages/:id/collection/row-options?q=&limit=` | relation 선택기: 컬렉션의 볼 수 있는 행 `{ rows: RowRefDTO[], more }`(limit ≤ 200, 기본 50, title ILIKE) |
| GET | `/api/pages/:id/collection/covers` | 갤러리 "첫 이미지": `{ covers: { rowId: '/files/<id>' } }`(볼 수 있는 행마다 처음 업로드된 이미지) |
| POST | `/api/pages/:id/collection/rows/batch` | `{ rows: [{ title?, props? }] }` 1–1000행, 본문 ≤ 16 MB, 한 트랜잭션. 값은 속성 타입으로 검사하고, relation/rollup/모르는 키는 버립니다. 컬렉션의 살아 있는 행 한도 100 000 → 넘으면 400. → `{ rows: RowDTO[] }` |
| PATCH | `/api/pages/:id/collection/rows/batch` | `{ rows: [{ id, title?, props? }] }` 1–1000. PATCH props처럼 병합하며(`null`이면 지움) SQL 문 하나로 처리합니다. `:id`의 볼 수 있는 하위 페이지만 건드립니다 → `{ updated }` |
| GET / PUT / DELETE | `/api/pages/:id/collection/sheet-sync` | **실험 기능 `sheets-sync`**(꺼져 있으면 404). `PUT { url, keyColumn, titleColumn?, intervalMinutes? (5–1440, default 15), enabled? }`. `url`은 `https://docs.google.com/spreadsheets/`로 시작해야 합니다. → `{ sync: SheetSyncDTO \| null }`. docs/adr/0306 |
| POST | `/api/pages/:id/collection/sheet-sync/run` | **실험 기능.** 지금 동기화합니다(분당 6회). 시트 오류 → 메시지와 함께 400. 이미 돌고 있으면 → 409 `SYNC_RUNNING` → `{ sync, stats: { inserted, updated, unchanged } }` |
| GET | `/api/me/ical` | `{ ical: { active, createdAt, lastUsedAt } }`(토큰은 절대 돌려주지 않음) |
| POST | `/api/me/ical` | 발급/재발급 → `{ ical: { …, url } }`. 비밀 토큰이 든 URL은 한 번만 돌려줍니다 |
| DELETE | `/api/me/ical` | 폐기. 204 |
| GET | `/ical/<token>.ics` | **루트 경로, 세션 없음.** 토큰 주인이 볼 수 있는 날짜 있는 항목 전부의 RFC 5545 피드(모든 워크스페이스, −90/+400일). `text/calendar`, `ETag` + `If-None-Match` → 304, `Cache-Control: private, max-age=300`, IP마다 분당 30회. 모르는 토큰 → 404. docs/adr/0303, 0304 |

<a id="admin-backups"></a>
## 관리자: 백업

관리자 + 브라우저 세션만 됩니다(MCP 토큰 → 403). 데이터는 공유 볼륨을 거쳐 `backup` 사이드카에서 옵니다
(`BACKUP_DIR`, 기본 `/backups`, 읽기 전용. `BACKUP_CTL_DIR`, 기본 `/backup-ctl`).
복원에는 HTTP 엔드포인트가 없습니다(CLI `deploy/restore.sh`). docs/BACKUP.md, docs/adr/0600–0607.

| 메서드 | 경로 | 비고 |
|---|---|---|
| GET | `/api/admin/backups` | `{ configured, status, alert, stale, pending, sets }`. `BACKUP_DIR`이 없으면 `configured:false`(나머지는 모두 비어 있음). `status` = 사이드카의 `status.json`(`running`, `heartbeatAt`, `nextRunAt`, `lastSuccess`, `lastFailure`, `lastVerify`, `lastRestoreTest`, `remote`, `config` …). `alert` = `{ kind, message, at }` 또는 null. `pending` = `queued \| processing \| null`. `sets`는 최신순: `{ id, kind, createdAt, totalBytes, encrypted, appVersion, migration, migrationsApplied, files[{ name, bytes }] }` |
| POST | `/api/admin/backups/run` | 지금 백업을 대기열에 넣습니다(분당 6회). 202 `{ queued: true }`. 409 `BACKUP_QUEUED` / `BACKUP_RUNNING` / `BACKUP_DISABLED` / `BACKUP_NOT_CONFIGURED`, 503 `BACKUP_SIDECAR_DOWN`(10분 동안 heartbeat 없음) |
| GET | `/api/admin/backups/:id/download` | 세트를 압축하지 않은 `application/x-tar`(`inkling-backup-<id>.tar`)로 스트리밍합니다. 파일은 저장된 그대로입니다(암호화된 세트는 암호화된 채로). `:id`는 `^\d{8}-\d{6}$`에 맞아야 하고 → 아니면 404 `BACKUP_NOT_FOUND` |

`NotificationType`에 `workspace_deleted`(docs/adr/0910-*. `pageId`는 null, `workspaceName` 설정, 클릭할 수 없음)와 `backup_failed`(백업, 복원 테스트, 원격
복사가 실패하거나 사이드카가 보고를 멈추면 모든 관리자에게 보냄. 페이지/워크스페이스 없음)가 생깁니다.

<a id="query-blocks"></a>
## 쿼리 블록

Dataview식 쿼리(문법: [QUERY.ko.md](QUERY.ko.md)). docs/adr/0203, 0204.

| 메서드 | 경로 | 비고 |
|---|---|---|
| POST | `/api/workspaces/:id/query` | `{ source, today?: 'YYYY-MM-DD', tzOffsetMinutes?: -840..840 }`(멤버만, 분당 120회). → `QueryResultDTO { type: 'TABLE'\|'LIST'\|'TASK', withoutId, columns: string[], rows: [{ pageId, title, cells: unknown[], task?: { blockId, text, due, checked } }], truncated, elapsedMs, cached? }`. 호출자가 볼 수 있는 페이지만(공유 + 내 개인 페이지) 대상이고, 휴지통 페이지와 템플릿은 뺍니다. 문법 오류 / 모르는 속성 → 400 `QUERY_SYNTAX`(메시지 끝이 `(line L, col C)`). 3초 넘게 걸리면 → 400 `QUERY_TIMEOUT`. 행 ≤ 500(`LIMIT`, 기본 200) |

<a id="vault-sync-experimental-vault-sync"></a>
## 볼트 동기화(실험 기능 `vault-sync`)

`EXPERIMENTAL_FEATURES`에 `vault-sync`가 있을 때만 등록됩니다(아니면 404).
`inklingctl sync <vaultDir> --workspace <name|id>`가 이 라우트를 씁니다. revision 토큰은 불투명한 문자열입니다
(0.15.1부터 state-vector 해시 + delete-set 해시 + 메타데이터 해시, docs/adr/1920-*). `contentHash`는 정규화한 canonical
markdown의 SHA-256입니다(frontmatter `inkling-id`, `aliases`, `tags`, 페이지 속성 + 본문. 첨부 파일은
`/files/<id>`, 위키 링크는 `[[Current Title]]` / `[[Current Title|shown]]`로 씁니다). docs/adr/0200–0202.

| 메서드 | 경로 | 비고 |
|---|---|---|
| GET | `/api/workspaces/:id/sync/changes?since=<cursor>` | → `{ cursor, pages: [{ id, parentId, kind, title, updatedAt, revision, contentHash }], trashed: [{ id, deletedAt }] }`. 볼 수 있는 살아 있는 페이지 전부(≤ 20 000, 넘으면 413 `TOO_MANY_PAGES`). `revision`은 `since` 이후 바뀐 doc(과 그 뒤 이름이 바뀌거나 휴지통으로 간 페이지로 링크하는 doc)에만 있고, `null` = 바뀌지 않음. `contentHash`는 그 revision에 대해 캐시되어 있을 때 들어갑니다. 돌려받은 `cursor`를 다음에 넘기세요(5초 겹침) |
| POST | `/api/workspaces/:id/sync/read` | `{ ids: uuid[] }`(1–100) → `{ pages: [{ id, revision, contentHash, markdown }], missing: uuid[] }`. 브라우저가 문서를 열어 두었으면 살아 있는 문서를 읽습니다 |
| PUT | `/api/pages/:id/sync/md` | `{ markdown (≤ 1.5M chars), expectedRevision }` → `{ revision, contentHash, markdown (canonical), droppedFrontmatterKeys }`. revision 불일치(저장되지 않은 실시간 편집 포함) → **412** `{ error: { code: 'REVISION_MISMATCH' }, current: { revision, contentHash, markdown } }`. frontmatter가 페이지 속성/별칭을 대체합니다(내부 `fullWidth`는 유지). 협업 서버를 거쳐 적용되므로 열린 편집기가 바로 갱신됩니다 |
| POST | `/api/workspaces/:id/sync/pages` | `{ parentId?: uuid\|null, title, kind: 'doc'\|'folder', markdown? }` → `{ page: { id, parentId, kind, title, updatedAt }, revision?, contentHash?, markdown? }`(doc 필드는 `kind: 'doc'`일 때만). scope는 부모를 따릅니다 |
| DELETE | `/api/pages/:id/sync?expectedRevision=` | 잎 페이지 하나를 휴지통으로 보냅니다(204). doc은 `expectedRevision`이 필요하고, 맞지 않으면 → `current`와 함께 412. 살아 있는 하위 페이지가 있으면 → 409 `HAS_CHILDREN` |

<a id="fix-phase-changes-docsadr08000815"></a>
## 수정 단계 변경 사항 (docs/adr/0800–0815)

**오류에 필드가 더 붙을 수 있습니다.** `AppError.details`는 `error` 객체에 합쳐집니다.
`{ "error": { "code": "...", "message": "...", ...details } }`. 클라이언트는 모르는 키를 무시해야 합니다.

**`DELETE /api/admin/users/:id`: 409 `SOLE_OWNER`.** 그 사용자가 어느 워크스페이스든 유일한 소유자이면
거절합니다.

```json
{ "error": { "code": "SOLE_OWNER", "message": "…", "workspaces": [{ "id": "uuid", "name": "Team" }] } }
```

관리자 UI는 `workspaces`를 보여 주고 먼저 다른 멤버를 소유자로 올리라고 안내해야 합니다
(그 워크스페이스의 소유자가, 또는 그곳의 멤버/소유자인 관리자가 `PATCH /api/workspaces/:id/members/:userId { role: "owner" }`를 호출합니다). 삭제에 성공하면 그 사용자의 개인 페이지는 작성자 없이 휴지통으로 갑니다.
아무도(관리자 포함) 그 페이지를 보거나 복원하거나 영구 삭제할 수 없고, 30일 휴지통 정리가 지웁니다.

**보이기 규칙.** 작성자가 더는 없는 개인 페이지(`created_by IS NULL`)는 아무에게도 보이지 않습니다. 이런 페이지가
들어 있는 공유 하위 트리를 개인 섹션으로 옮기면, 옮긴 사람이 그 페이지들의 작성자가 됩니다.

**페이지 트리 변경** (`parentId`를 준 `POST /pages`, `parentId`/`scope`를 준 `PATCH /pages/:id`,
복원/영구 삭제, 복제/캔버스 펼치기, `POST /pages/from-template`, 볼트 동기화의 생성,
가져오기, 컬렉션 행 일괄 처리):
- `400 VALIDATION`: 부모가 없거나, 휴지통에 있거나, 다른 워크스페이스에 있을 때, 순환이 생길 때, 결과가
  64단계보다 깊어질 때.
- `403 FORBIDDEN`: 부모가 공개 링크가 걸린 폴더/페이지 안에 있고 호출한 사람이 워크스페이스 소유자가
  아닐 때(같은 공개 폴더 안에서 옮기는 것과 공개된 컬렉션에 새 행을 넣는 것은 계속 허용됩니다).

**`GET /api/workspaces`, `POST /api/workspaces/join`**: 호출한 사람이 그 워크스페이스의 소유자가 아니면 `inviteCode`는 `""`입니다.
소유자가 다른 사람을 내보내는 **`DELETE /api/workspaces/:id/members/:userId`** 호출은 초대 코드를 새로 만듭니다.

**`PATCH /pages/:id/props`, 컬렉션 행 일괄 처리**: 사람 칸이 워크스페이스 멤버가 아닌 사용자를 가리키면
`400`입니다.

**`POST /pages/:id/publish/notion`**: 실제 업로드(dry-run이 아닌 것)는 소유자만 할 수 있고(`403`), 분당 10회로
제한됩니다.

**템플릿**: 개인 페이지에서 저장한 템플릿(또는 `private: true`로 저장한 템플릿)은 만든 사람에게만 목록에 나오고 쓸 수 있습니다.
`DELETE /templates/:id`는 만든 사람이나 워크스페이스 소유자만 할 수 있습니다. [템플릿](#templates)을 보세요.

**가져오기**: 폴더 깊이 ≤ 32, 만들어지는 페이지는 많아야 `IMPORT_MAX_PAGES`(기본 5000)개, zip 항목은
실제로 푼 바이트로 잽니다(항목 하나당 `IMPORT_MAX_ENTRY_MB`, 기본 25. 전체 `IMPORT_MAX_UNPACKED_MB`,
기본 50). 파일은 많아야 `IMPORT_MAX_FILES`(기본 300)개입니다. 넘으면 → `400`. 가져온
첨부 파일의 `pageId`는 그 파일을 처음 참조하는 페이지입니다.

**로그인**: 로그인을 확인하는 사이에 비밀번호 재설정이 커밋되면 `401`(비밀번호가 방금 바뀜)입니다.
비밀번호를 재설정하면 iCal 피드 토큰도 폐기됩니다.

**`GET /api/health/ready`**: `200 {ok:true, db:true}` / `503 {ok:false, db:false}`(DB `select 1`,
2 s 타임아웃, 5 s 캐시). `/api/health`는 그대로 생존 확인(liveness)입니다.

**협업**: 서버 종료 중이거나 DB가 실패한 동안의 업그레이드는 `503`을 받습니다. 접근 권한이 빠지면 서버가
Hocuspocus `PermissionDenied` 메시지를 이유 `permission-changed`와 함께 보낸 뒤 코드 4403으로
소켓을 닫습니다.

**정적 파일**: 없는 `/assets/*` 파일은 404입니다(SPA 셸을 주지 않습니다).

---

<a id="templates"></a>
# 템플릿

사용법과 파일 형식: [TEMPLATES.ko.md](TEMPLATES.ko.md). 결정: ADR 0920–0925. 모든 경로에
세션과 워크스페이스 멤버 자격이 필요합니다(삭제된 워크스페이스는 `404`). `:tid`는 기본 제공 키
(`meeting`, `standup`, `meetingSeries`, `project`, `kickoff`, `brainstorm`, `retro`, `readingList`,
`weeklyReview`)이거나 사용자 정의 템플릿의 uuid입니다. 기본 제공 텍스트는 요청 언어를 따릅니다(`users.locale`
→ `Accept-Language` → `DEFAULT_LOCALE`).

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/workspaces/:id/templates` | `{ templates: TemplateDTO[] }`. 기본 제공 템플릿이 먼저, 그다음 호출한 사람에게 보이는 사용자 정의 템플릿(최신순). `TemplateDTO { id, builtin, name, description, icon, category: 'docs'\|'projects'\|'meetings'\|'personal'\|'custom', kind: 'doc'\|'structure', pageCount, scope: 'shared'\|'private', mine, withDate, inputs: { name, default }[] }` |
| POST | `/api/workspaces/:id/templates` | 페이지를 템플릿으로 저장합니다. `{ fromPageId, name ≤60, description? ≤300, icon? ≤16, category?, includeSubpages?, includeRows?, private? }` → `{ template }`. 개인 페이지에서 저장하면 언제나 개인 템플릿이 됩니다. 200 페이지 / 12단계 / 20 MB를 넘으면 → `400 TEMPLATE_TOO_LARGE`. 30/min |
| GET | `/api/workspaces/:id/templates/:tid/preview` | `{ preview: { blocks: { type, text, depth, checked? }[] (루트 문서의 처음 14 블록, 일반 텍스트), truncated, outline: { kind, title, icon, depth, fields?, views?, rows? }[] } }` |
| GET | `/api/workspaces/:id/templates/:tid/export` | `.md`(문서 템플릿, frontmatter에 메타) 또는 `.zip`(구조 템플릿: `inkling-template.json` + `pages/*`). 20/min |
| POST | `/api/workspaces/:id/templates/import[?private=1]` | multipart `file`(.md / .zip, ≤ 25 MB) → `{ template }`. 본문은 Markdown / JSON Canvas 가져오기를 거칩니다. 올바르지 않은 압축 파일 → `400 TEMPLATE_INVALID`. 20/min |
| DELETE | `/api/templates/:id` | 204. 기본 제공 키 → 403. 만든 사람, 소유자, 관리자만 가능. 내가 멤버가 아닌 워크스페이스의 템플릿 → 404 `TEMPLATE_NOT_FOUND` (docs/adr/1301-*) |
| POST | `/api/pages/from-template` | `{ workspaceId, builtinKey \| templateId, parentId?, scope?, title? ≤300, date?: 'YYYY-MM-DD', inputs?: { [question]: answer }, tz?: IANA zone }` → `{ page, pages: PageMetaDTO[] (루트 먼저, 깊이 우선), cursor?: { pageId, blockId, offset } }`. 워크스페이스 트리 잠금 아래에서 트리 전체를 트랜잭션 하나로 만듭니다(배치와 깊이 검사는 페이지 만들기와 같고, 부모 아래에 만들면 부모의 섹션을 따릅니다). 변수는 이때 치환됩니다. `withDate` 템플릿은 루트에 `date` 속성도 넣습니다. 30/min |

`POST /api/pages/:id/instantiate`와 페이지의 `isTemplate` 플래그는 없어졌습니다(ADR 0920). 대신 하위 페이지와 함께
페이지를 템플릿으로 저장하세요.

<a id="workspace-settings-docsadr09450953"></a>
# 워크스페이스 설정 (docs/adr/0945–0953)

이 절의 모든 경로에는 브라우저 세션이 필요합니다(bearer 토큰은 /mcp 밖에서 401, /mcp를 거치면 403을 받습니다). `WorkspaceDTO.can`
(`manage`, `editSettings`, `addMembers`, `inviteLink`, `export`, `publish`)은 호출한 사람이 할 수 있는 일을 서버가 본
결과입니다. 경로마다 다시 확인합니다.

| 메서드 | 경로 | 누가 | 본문 / 쿼리 | 응답 |
|---|---|---|---|---|
| GET | `/api/workspaces/:id/settings` | 멤버 | - | `{ settings: WorkspaceSettingsDTO, role, can }` |
| PATCH | `/api/workspaces/:id/settings` | 소유자 | `updateWorkspaceSettingsSchema`(strict): `inviteLinkEnabled`, `memberAddPolicy`/`exportPolicy` (`owners`\|`admins`\|`members`), `publicSharingDisabled`(+ `unpublishExisting: true`면 같은 트랜잭션에서 모든 공개 링크를 내림), `trashRetentionDays` 7–365, `auditRetentionDays` 30–730, `reviewIntervalDays` 7–730 또는 null | `{ settings, role, can, unpublished }`. 바뀐 필드와 함께 `settings.updated`로 감사 기록 |
| GET | `/api/workspaces/:id/audit` | 소유자, 관리자 | `action`(정확한 이름, 또는 `member` 같은 묶음), `actorId`, `cursor`(id), `limit` ≤ 100 | `AuditPageDTO { events, nextCursor, retentionDays }`, 최신순 |
| GET | `/api/workspaces/:id/agents` | 소유자, 관리자 | - | `{ connections: AgentConnectionDTO[], blocks: AgentBlockDTO[] }`. 지금 멤버의 OAuth 연결 중 이 워크스페이스에 닿은 것(`access`, `firstUsedAt`, `lastUsedAt`, `blocked`) |
| POST | `/api/workspaces/:id/agents/blocks` | 소유자, 관리자(소유자의 에이전트는 못 막음) | `{ userId, clientId? }`(client가 없으면 그 멤버의 모든 에이전트) | `{ block: { id } }`. 멱등 |
| DELETE | `/api/workspaces/:id/agents/blocks/:blockId` | 소유자, 관리자 | - | 204 |
| POST | `/api/workspaces/:id/shared/unpublish` | 소유자, 관리자 | `{ pageIds? }`(빼면 전부) | `{ unpublished }` |
| GET | `/api/workspaces/:id/review-due` | 멤버 | `mine=1` | `ReviewDueDTO { intervalDays, today, items, archive, living }`. items는 우선순위 점수 순 |
| POST | `/api/pages/:id/view` | 그 페이지를 볼 수 있는 멤버 | - | 204. 웹 읽기 한 번을 셉니다(페이지 합계만) |
| GET | `/api/pages/:id/review` | 그 페이지를 볼 수 있는 멤버 | - | `{ review: PageReviewDTO }` |
| PUT | `/api/pages/:id/owner` | 그 페이지를 볼 수 있는 멤버 | `{ ownerId \| null }`(멤버. 개인 페이지는 그 작성자) | `{ review }` |
| POST | `/api/pages/:id/review` | 그 페이지를 볼 수 있는 멤버 | - | `{ review }`. 호출한 사람이 지금 "검토 완료"(`Mark reviewed`)를 누른 것으로 기록 |
| PUT | `/api/pages/:id/living` | 그 페이지를 볼 수 있는 멤버 | `{ living: true\|false\|null }` | `{ review }` |

바뀐 규칙:
- `POST /api/pages/:id/share`, `DELETE /api/pages/:id/share`: 소유자와 관리자만 할 수 있습니다. 워크스페이스가 공개 링크를
  막아 두었으면 아직 공개되지 않은 페이지를 공개할 때 403 `PUBLIC_SHARING_DISABLED`를 답합니다.
  둘 다 감사 기록에 남습니다(`share.*`). `GET /api/workspaces/:id/shared` → 소유자와 관리자에게 `canManage`.
- `GET /api/workspaces/:id/export`: 내보내기 정책이 호출한 사람을 허용하지 않으면 403입니다. 감사 기록에 남습니다
  (`export.downloaded`). 페이지 하나를 내보내는 `/api/pages/:id/export`는 바뀌지 않았습니다.
- 에이전트(MCP) 요청: 워크스페이스에서 그 연결이 차단되어 있으면 워크스페이스 경로는 모두 403 `AGENT_BLOCKED`
  (페이지 하나를 다루는 경로는 404)를 답합니다. 여러 워크스페이스를 도는 도구는 그 워크스페이스를 건너뜁니다.
- MCP `read_page` 머리글에 알 수 있는 경우 `owner`, `reviewedAt`, `reviewDue: YYYY-MM-DD (stale, p=0.62)` 또는
  `living: yes`가 붙습니다. `find_context`는 조각 머리글에 `owner X, reviewed YYYY-MM-DD, stale p=0.62`를 붙입니다.
  값은 저장된 날짜와 하루 한 번 도는 배치에서만 나옵니다.
- 휴지통 정리는 워크스페이스마다 `trashRetentionDays`를 씁니다. `auditRetentionDays`가 지난 감사 이벤트와
  90일보다 오래된 페이지 읽기 카운터는 한 시간마다 지웁니다.

<a id="v050-additions"></a>
## v0.5.0 추가 사항

<a id="workspace-two-step-requirement-docsadr1112-"></a>
### 워크스페이스 2단계 인증 요구 (docs/adr/1112-*)
- `PUT /api/workspaces/:id/settings/two-factor`(소유자 또는 관리자) 본문 `{ required: boolean, graceDays?: 0–30 }` → `{ twoFactor }`. `APP_SECRET_KEY`가 없으면 501 `TWO_FACTOR_UNAVAILABLE`, 자기 자신이 2단계 인증을 쓰기 전에 켜려 하면 403 `TWO_FACTOR_SELF_REQUIRED`입니다. 감사 기록에 남습니다.
- `GET /api/workspaces/:id/settings`에 `twoFactor { required, graceDays, requiredAt, deadline, available, selfSatisfied, membersWithout? { count, members (≤50) } }`가 붙습니다(`membersWithout`은 소유자와 관리자에게만).
- `WorkspaceDTO.twoFactor { required, deadline, state: 'off' | 'ok' | 'grace' | 'blocked' }`.
- 기한이 지나면 2단계 인증을 쓰지 않는 멤버의 모든 워크스페이스 경로, MCP 호출, 협업 소켓이 403 `TWO_FACTOR_REQUIRED { workspaceId }`를 받습니다. 다른 서비스로 로그인하는 계정은 인증한 것으로 칩니다.
- 초대 코드는 해시와 비교하며 대소문자를 가리지 않습니다(docs/adr/1110-*). `AdminUserDTO.signupKey`는 가려서 보냅니다.

<a id="large-pages-docsadr1103-"></a>
### 큰 페이지 (docs/adr/1103-*)
- `GET /api/pages/:id/size`(페이지 접근 권한) → `{ stateBytes, tokens, large }`. `stateBytes`는 V1 기준(V2 바이트 × 1.46)이라서 기준값이 에이전트 안내(≥ 1 MiB 또는 ≥ 50k tokens)와 맞습니다.
- `GET /api/workspaces/:id/large-pages`(소유자 또는 관리자, 아니면 403) → `{ pages: [{ id, title, icon, stateBytes, tokens, updatedAt, snapshotBytes, snapshotCount }], thresholds }`. 다른 멤버의 개인 페이지는 빠집니다.

<a id="link-islands-docsadr1123-"></a>
### 연결 묶음 (docs/adr/1123-*)
- `GET /api/workspaces/:id/graph/islands`(멤버) → `{ pages, links, islands: [{ size, hub: { id, title }, pageIds (≤200) }], unlinked: [{ id, title, icon, kind, updatedAt }] (≤500, 최신순, 폴더 제외), unlinkedTotal }`. 묶음은 페이지가 2개 이상이고 큰 것부터 나옵니다. 노드는 `/graph`를 따릅니다(visibleTo, 휴지통 제외, 데이터베이스 행 제외). 내가 볼 수 없는 페이지로 가는 링크는 간선으로 치지 않습니다. ETag = 사용자 + 워크스페이스 버전 + 색인 epoch → 304. 60/min.

<a id="former-titles-docsadr1121-"></a>
### 이전 제목 (docs/adr/1121-*)
- `[[Title]]`은 지금 제목, 그다음 별칭, 그다음 내가 볼 수 있는 페이지의 이전 제목 순으로 찾습니다(같은 이전 제목이 여럿이면 가장 최근에 그 제목을 쓴 페이지). 이전 제목은 `PATCH /api/pages/:id`로 이름을 바꿀 때만 기록됩니다.

<a id="imports-docsadr1122-"></a>
### 가져오기 (docs/adr/1122-*)
- zip과 폴더 가져오기 응답에 `duplicateAttachments`가 붙습니다. Notion 보고에는 `merged: { pages, attachments }`가 붙고, `attachments`는 실제로 저장한 파일 수를 셉니다.

<a id="v060-additions"></a>
## v0.6.0 추가 사항

<a id="openid-connect-sign-in-docsadr11601162"></a>
### OpenID Connect 로그인 (docs/adr/1160–1162)
- `GET /api/auth/oidc/start?returnTo=/path`(인증 없음) → 공급자로 302. `inkling_oidc`를 설정합니다(httpOnly, Lax, Path=/api/auth/oidc, 10 min). `returnTo`는 같은 출처의 경로여야 하고, 아니면 `/`가 됩니다. 설정되어 있지 않으면 → 404 `OIDC_DISABLED`.
- `POST /api/auth/oidc/link { returnTo? }`(브라우저 세션만, bearer는 403) → `{ url }`. 위임 계정은 400 `DELEGATED_ACCOUNT`, 공급자가 내려가 있으면 503 `OIDC_UNAVAILABLE`.
- `GET /api/auth/oidc/callback?code&state`(공급자가 호출) → 언제나 302. 성공하면 → 세션 쿠키와 함께 `returnTo`. Inkling 2단계 인증이 켜져 있으면 → `/login?next=<returnTo>#totp=<challenge>`(`POST /auth/login/totp`로 마무리). 실패하면 → `/login?oidc_error=CODE`(연결 흐름에서는 `returnTo?oidc_error=CODE`).
- 코드: `OIDC_DISABLED`, `OIDC_STATE_INVALID`, `OIDC_CANCELLED`, `OIDC_PROVIDER_ERROR`, `OIDC_UNAVAILABLE`, `OIDC_TOKEN_INVALID`, `OIDC_NO_EMAIL`, `OIDC_EMAIL_UNVERIFIED`, `OIDC_DOMAIN_NOT_ALLOWED`, `OIDC_NO_ACCOUNT`, `OIDC_EMAIL_TAKEN`, `OIDC_MFA_REQUIRED`, `OIDC_ALREADY_LINKED`, `OIDC_LINK_CONFLICT`, `OIDC_LINK_SESSION`, `EMAIL_NOT_VERIFIED`, `RATE_LIMITED`. 세 경로 모두 30/min/IP.
- `GET /api/auth/mode`에 `oidc: { name } | null`이 붙습니다. `GET /api/auth/me`에 `user.logins: [{ provider: 'oidc', name, email, linkedAt, lastUsedAt }]`가 붙습니다. `user.origin`은 `'oidc'`일 수 있습니다(비밀번호가 없으므로 재설정/변경/확인은 `DELEGATED_ACCOUNT`, `POST /auth/login`은 `INVALID_CREDENTIALS`를 답합니다).

<a id="splitting-pages-and-log-rotation-docsadr11401142"></a>
### 페이지 나누기와 로그 넘기기 (docs/adr/1140–1142)
- `POST /api/pages/:id/split`(편집 권한, 문서 페이지, 60/min) `{ level: 1–6, sections?: headingBlockId[] (≤200), preview?: boolean }` → `{ pageId, level, levels: number[6], sections: [{ blockId, anchor, title, blocks, bytes, comments, pageId? }], remainingBlocks, openBy, preview }`. 섹션이 없거나, 문서가 아니거나, 200개를 넘으면 400. 403 `PAGE_LOCKED`. 409 `SPLIT_CONFLICT`(옮길 섹션이 그사이 바뀌었고, 아무것도 바뀌지 않음). 하위 페이지는 응답 직후 곧 색인됩니다.
- `GET /api/pages/:id/rotation`(페이지 접근 권한) → `{ mode: 'off'|'month'|'size', maxBytes, current: { id, title } | null }`. `PUT`(편집 권한) `{ mode, maxBytes? (65536–8388608) }` → 같은 모양.
- `POST /api/pages/:id/rotation/target`(편집 권한, 60/min) → `{ pageId, title, rotated, created, mode }`: 덧붙일 내용이 들어갈 곳을 알려 줍니다. 월별 하위 페이지나 크기별 하위 페이지를 만들 수 있습니다. 넘기지 않는 큰 페이지라면 한 번만 가는 `large_page` 알림을 보냅니다.
- 알림 종류 `large_page`(소유자, 없으면 만든 사람에게. 페이지마다 한 번. 메일 없음). Markdown 입력의 `[[Title#Heading]]`은 Title의 하위 페이지 중 이름이 Heading인 것으로, 없으면 Title로 해석됩니다.

<a id="public-link-expiry-and-passwords-docsadr11701172"></a>
### 공개 링크 만료와 비밀번호 (docs/adr/1170–1172)
- `POST /api/pages/:id/share` 본문(선택) `{ expiresAt?: ISO|null, expiresInDays?: 1–3650, password?: 4–128 chars }`(두 만료 형식을 같이 쓰지 않음). 새 링크를 만들 때만 적용됩니다. 만료를 주지 않으면 → 워크스페이스의 `shareDefaultExpiryDays`. 워크스페이스가 비밀번호를 요구하는데 비밀번호가 없으면 → 403 `SHARE_PASSWORD_POLICY`.
- `PATCH /api/pages/:id/share`(소유자/관리자) `{ expiresAt?: ISO|null, expiresInDays?, password?: string|null }`: 빼면 그대로, null이면 지웁니다. 만료는 지금보다 1분 넘게, 10년 이내 뒤여야 합니다(아니면 400). 409 `NOT_SHARED`. 요구되는 비밀번호를 지우면 403 `SHARE_PASSWORD_POLICY`. → `ShareStatusDTO`.
- `ShareStatusDTO`에 `expiresAt`, `expired`, `hasPassword`, `policy { defaultExpiryDays, passwordRequired }`가 붙습니다. `GET /api/workspaces/:id/shared` 항목에는 `expiresAt`, `expired`, `hasPassword`가 붙고, 만료된 링크도 목록에 남습니다. 해시는 절대 돌려주지 않습니다.
- `POST /api/public/:token/unlock { password }` → 204 + `inkling_share` 쿠키(Path=/api/public/<token>, HttpOnly, Lax, 12 h, 링크 만료를 넘지 않음). 틀리면 401 `SHARE_PASSWORD_INVALID`, 모르는 토큰은 404, 만료되면 410. 모든 응답이 argon2 검증 한 번과 함께 최소 300 ms 걸립니다. 10/min/IP에 더해 링크별 백오프와 IP 차단이 있습니다(429 `RATE_LIMITED`).
- 공개 경로(`/api/public/:token`, `/f/:fileId`, `/p/:ref`, `/p/:ref/f/:fileId`): 만료되면 → 410 `SHARE_EXPIRED`(추측 시도로 세지 않음). 비밀번호가 걸려 있는데 올바른 쿠키가 없으면 → 401 `SHARE_PASSWORD_REQUIRED`. 둘 다 `no-store`와 `X-Robots-Tag: noindex, nofollow`를 붙입니다. 이런 링크의 `/s/…`는 noindex meta만 있고 og/twitter 태그는 없는 빈 셸입니다.
- 워크스페이스 설정에 `shareDefaultExpiryDays`(1–365|null)와 `sharePasswordRequired`가 붙습니다. 감사 동작 `share.expiry_changed`, `share.password_set`, `share.password_changed`, `share.password_removed`.

<a id="events-and-the-write-gate-docsadr11501151"></a>
### 이벤트와 쓰기 관문 (docs/adr/1150–1151)
- `POST /pages/:id/comments`, `PATCH /comments/:id`, `POST /pages/:id/content`와 섹션 편집은 진행 중인 잠금 변경, 에이전트 차단, 멤버 변경을 기다렸다가 그 결과에 따라 답합니다(403 `PAGE_LOCKED`, 403, 403 `AGENT_BLOCKED`). 이벤트를 쓸 수 없으면 요청은 500을 답하고 아무것도 저장하지 않습니다.

<a id="v070-additions"></a>
## v0.7.0 추가 사항

<a id="row-templates-docsadr11801184"></a>
### 행 템플릿 (docs/adr/1180–1184)
- `GET /api/pages/:id/collection/row-templates`(그 데이터베이스를 볼 수 있는 사람 누구나) → `{ templates: RowTemplateDTO[], defaultId }`. `RowTemplateDTO { id, collectionId, name, icon, title, props, isDefault, sortOrder, inputs, hasBody, updatedAt }`.
- `POST /api/pages/:id/collection/row-templates`(데이터베이스를 편집할 수 있을 때. 편집 잠금 → 403 `PAGE_LOCKED`) `{ name, icon?, title?, props?, fromRowId?, isDefault? }` → `{ template }`. 많아야 20개(넘으면 400). props는 속성 id로 줍니다. 날짜는 `YYYY-MM-DD`, `today`, `today±N`, 사람은 멤버 id 또는 `me`. relation/rollup과 올바르지 않은 값은 버립니다.
- `GET /api/collection-row-templates/:id` → `{ template, state }`(본문의 base64 Yjs update, 비어 있으면 ''). `PATCH` `{ name?, icon?, title?, props?, update? (본문에 합칠 base64 Yjs update. 손상되었으면 400 `TEMPLATE_INVALID`, > 2 MiB면 400 `TEMPLATE_TOO_LARGE`), schema? (0.20, "v0.20.0 추가 사항" 참고), isDefault?, sortOrder? }` → `{ template }`. `DELETE` → 204.
- `POST /api/pages/:id/collection/rows` `{ template?: uuid|null, title?, props?, inputs?, tz? }`: template을 빼면 → 기본 템플릿(없으면 → 빈 행), `null` → 빈 행, 모르는 값 → 404 `TEMPLATE_NOT_FOUND`. 준 props가 템플릿보다 우선하고, 직접 입력한 제목이 패턴보다 우선합니다. → `{ row, templateId, cursor? }`. 배치와 편집 잠금은 페이지 만들기와 같습니다. `page_created` 웹훅과 담당 이벤트가 나갑니다.

<a id="webhooks-docsadr11901192-webhooksmd"></a>
### 웹훅 (docs/adr/1190–1192, [WEBHOOKS.ko.md](WEBHOOKS.ko.md))
- `POST /api/workspaces/:id/webhooks`(소유자) `{ url, events, kind? }` → `{ webhook, secret }`. Slack/Discord는 호스트로 알아냅니다(`secret: null`). `kind: 'generic'`은 직접 적어야 하고 https, 포트 443, 자격 증명과 fragment 없음, 모든 DNS 응답이 공인 주소여야 합니다. 아니면 400. `whsec_…` 비밀 값은 여기와 교체할 때만 돌려줍니다. 많아야 10개(409 `LIMIT_REACHED`).
- `WebhookDTO`에 `failingSince`, `hasSecret`, `previousSecretUntil`이 붙습니다. `PATCH /api/webhooks/:id { events?, enabled? }`(다시 켜면 실패 상태가 초기화됨). `DELETE` → 204.
- `POST /api/webhooks/:id/test`(5/min) → `{ ok, status, error, webhook }`. generic 훅에는 서명된 `type: "test"`를 보냅니다.
- `POST /api/webhooks/:id/secret { keepPrevious? = true }`(generic만, 10/min) → `{ webhook, secret }`. `keepPrevious: false`가 아니면 이전 비밀 값도 24 h 동안 함께 서명합니다.
- `GET /api/webhooks/:id/deliveries?limit=`(기본 30, 최대 100) → `{ deliveries: [{ id, event, status, attempts, statusCode, error, durationMs, responseExcerpt (non-2xx, ≤ 200 chars), nextAttemptAt, createdAt, updatedAt, canResend }] }`.
- `POST /api/webhooks/:id/deliveries/:deliveryId/resend`(10/min) → 같은 전송 id로 202. 409 `WEBHOOK_DISABLED` / `DELIVERY_IN_FLIGHT`, 410 `DELIVERY_GONE`.

<a id="api-tokens-and-connection-ranges-docsadr12001204"></a>
### API 토큰과 연결 범위 (docs/adr/1200–1204)
- 모든 `/api` 경로가 `Authorization: Bearer ink_pat_…`를 받습니다. 읽기 전용 토큰은 GET이 아니면 403을 받습니다. 브라우저 전용 표(ADR 1204)에 있는 경로는 어떤 bearer 토큰에도 403을 답합니다. OAuth `ink_at_` 토큰은 계속 `/mcp`용입니다.
- `GET /api/tokens` → `{ tokens }`. `POST /api/tokens { name, expiresInDays: 30|90|365|null, access: 'read'|'write', range }` → 201 `{ token, secret }`(`no-store`. 50개를 넘으면 → 409 `TOO_MANY_TOKENS`). `PATCH /api/tokens/:id { name?, range? }`. `DELETE /api/tokens/:id` → 204. 세션에서만 됩니다.
- 관리자(쿠키): `GET /api/admin/users/:id/api-tokens`, `DELETE /api/admin/users/:id/api-tokens` → `{ revoked }`, `DELETE /api/admin/api-tokens/:id` → 204.
- OAuth: `POST /api/oauth/authorize`가 `range`를 선택으로 받습니다(기본은 전부). `GET /api/oauth/grants` 항목에 `range`가 붙습니다. `PATCH /api/oauth/grants/:id { range }`(세션에서만).
- `AccessRange = { kind: 'all' } | { kind: 'workspaces', workspaceIds (1–20) } | { kind: 'subtree', pageId }`. 오류: 403 `OUT_OF_RANGE`, 400 `INVALID_RANGE`, 올바르지 않거나 만료된 토큰은 401.

<a id="findcontext-docsadr12101212"></a>
### find_context (docs/adr/1210–1212)
- `GET /api/context`의 섹션에 `short`(그 페이지 안에서 겹치지 않는 가장 짧은 앵커 꼬리)와 `heading`(마지막 제목)이 붙습니다. `more` 항목에도 같은 필드가 붙습니다. 기존 필드는 그대로이고, `read_page`와 `patch_section`이 짧은 앵커를 받습니다.

<a id="v080-additions"></a>
## v0.8.0 추가 사항

<a id="admin-status-docsadr12301233"></a>
### 관리자: 상태 (docs/adr/1230–1233)
- `GET /api/admin/status`(관리자, 브라우저 세션만. bearer 토큰은 403. 30/min). `?refresh=1`이면 무거운 점검을 다시 계산합니다(아니면 5 min 캐시). → `{ level: 'ok'|'warn'|'error', generatedAt, groups: [{ id: 'backup'|'storage'|'app'|'security'|'update', level, summary, items: [{ key, group, level: 'ok'|'warn'|'error'|'off', data }] }], issues, cache: { hit, ageSec, ttlSec } }`. `off`는 설정되지 않았거나, 꺼져 있거나, 해당 없음을 뜻하고 문제로 치지 않습니다. `data`에는 비밀 값, 경로, 데이터베이스 URL이 절대 들어가지 않습니다.
- `GET /api/version/latest`에 `securityFix: boolean | null`이 붙습니다(더 새 릴리스에 Security 절이 있으면 true. 읽을 릴리스 노트가 없으면 null).

<a id="heavy-jobs-docsadr1240"></a>
### 무거운 작업 (docs/adr/1240)
- `GET /api/pages/:id/export?format=zip`, `GET /api/workspaces/:id/export`, `POST /api/workspaces/:id/import`, `POST /api/workspaces/:id/import-folder`, `POST /api/pages/:id/duplicate`는 자리가 날 때까지 `HEAVY_JOBS_WAIT_MS`만큼 기다릴 수 있습니다. 그래도 안 되면 503 `HEAVY_JOBS_BUSY`(대기열이 꽉 찼거나 시간 안에 자리가 나지 않음) 또는 429 `HEAVY_JOBS_PER_USER`(호출한 사람이 이미 `HEAVY_JOBS_PER_USER`개 작업을 돌리거나 기다리는 중)를 답합니다. 둘 다 초 단위 `Retry-After`가 붙습니다.

<a id="v090-additions-guests-and-page-levels-docsadr12501253"></a>
## v0.9.0 추가 사항: 게스트와 페이지 권한 단계 (docs/adr/1250–1253)
아래 경로는 모두 브라우저 세션에서만 됩니다.
- `GET /api/pages/:id/access`(멤버. 게스트는 403) → `{ access: { pageId, people: [{ userId, name, email, level, guest, inheritedFrom: { pageId, title } | null }], invites, myLevel, canManage, canInviteGuests, guestPolicy, private } }`.
- `PUT /api/pages/:id/access { userId | email, level: 'view'|'comment'|'edit'|'full' }` → `{ access, invite?, mailed? }`. 이메일이 정확히 맞으면 그 계정을 찾습니다. 계정이 없으면 → 초대(메일을 보내지 않았으면 `invite.link`). 소유자와 관리자 → 400. 게스트는 `full`이 될 수 없음 → 400. 멤버의 단계는 전체 권한을 가진 사람만 정할 수 있습니다. 새 게스트는 `guestInvitePolicy`를 따릅니다(403). 아무도 자기 단계보다 높게 줄 수 없습니다. 접근 버전을 올리고 그 하위 트리에서 그 사람의 소켓을 닫습니다. 감사 기록에 남습니다.
- `DELETE /api/pages/:id/access/:userId` → `{ access }`(자기 줄이면 나가기, 아니면 PUT과 같은 규칙). `DELETE /api/pages/:id/invites/:inviteId` → `{ access }`.
- `GET /api/pages/:id/access/candidates?q=` → `{ candidates: [{ userId, name, email, guest }] }`: 멤버는 이름이나 이메일로 찾고(전체 권한을 가진 사람이 찾을 때), 외부 사람은 이메일이 정확히 맞을 때만 찾습니다(게스트 정책).
- `GET /api/workspaces/:id/guests`(소유자, 관리자) → `{ guests: [{ userId, name, email, pages: [{ pageId, title, level }] }] }`. `POST /api/workspaces/:id/guests/remove { userIds (1–200) }` → `{ removed }`. 그 사람들의 소켓을 닫고, `guests.removed`로 감사 기록에 남깁니다.
- `GET /api/page-invites/:token` → `{ invite: { workspaceName, pageTitle, level, invitedBy, emailMatches } }`(404 `INVALID_INVITE`). `POST /api/page-invites/:token/accept` → `{ workspaceId, pageId }`(403 `INVITE_EMAIL_MISMATCH`, 404 `INVALID_INVITE`. 속도 제한 있음).
- `PATCH /workspaces/:id/settings`가 `guestInvitePolicy: 'off'|'owners'|'admins'|'members'`를 받습니다.
- 게스트가 부를 수 있는 것은 이것뿐입니다: `GET /workspaces`(`role: 'guest'`, `can`은 모두 false, `inviteCode`는 빈 값), `GET /workspaces/:id/pages`(공유받은 하위 트리, 맨 위는 `parentId: null`), `GET /pages/:id/lock`(`level`, `guest`, 편집자 이름 없음), `GET /pages/:id/backlinks`, 댓글(목록, 달기, 자기 댓글 고치기와 지우기), 편집할 수 있는 공유 페이지 아래의 `POST /pages`, `PATCH /pages/:id`(title, icon, coverUrl, fullWidth. 그 밖은 403 `GUEST_OUTSIDE`), 편집할 수 있는 `pageId`를 준 `POST /files`, `GET /files/:id`, 협업 소켓. 나머지는 모두 403을 답합니다.
- 새 오류 코드: `PAGE_ACCESS`(`details.level`), `GUEST_OUTSIDE`, `INVITE_EMAIL_MISMATCH`, `INVALID_INVITE`.

<a id="v0100-additions"></a>
## v0.10.0 추가 사항

<a id="workspace-boundaries-docsadr13001302"></a>
### 워크스페이스 경계 (docs/adr/1300–1302)
- 워크스페이스의 멤버도 게스트도 아닌 사람은 그 워크스페이스의 페이지, 댓글, 변경 행(`GET /api/changes/:seq/diff`), 템플릿(`DELETE /api/templates/:id` → 404 `TEMPLATE_NOT_FOUND`), 행 속성(`PATCH /api/pages/:id/props` → 404 `NOT_FOUND`), 파일(`GET /files/:id`), 웹훅(`/api/webhooks/:id`와 그 test, secret, deliveries, resend 경로), 휴지통 복원과 영구 삭제, 볼트 동기화의 쓰기와 삭제에 대해 404를 받습니다. 없는 id일 때와 같습니다. 예전에는 있는 id면 403이었고, 2단계 인증을 요구하는 워크스페이스의 페이지면 403 `TWO_FACTOR_REQUIRED { workspaceId }`였습니다. 다른 워크스페이스의 페이지 아래로 페이지를 옮기면 부모가 없을 때와 같은 400 "Parent page is invalid"를 답합니다(docs/adr/1301-*).
- 여러 워크스페이스를 읽는 요청은 2단계 인증 요구 때문에 호출한 사람이 막힌 워크스페이스를 거절하지 않고 빼고 답합니다: `workspaceId` 없는 `GET /api/changes`와 `GET /api/inbox`, `workspaceId` 없는 `GET /api/context`, `GET /api/pages/read`(그런 페이지는 `missing`에 나옴), `GET /api/pages/agent-context`, 멤버 후보, 알림 설정의 구독 목록. 알림 메일(즉시와 모아 보내기)에서는 그 항목을 빼고, 앱에는 남겨 둡니다. 요구 때문에 막힌 소유자가 `DELETE /api/workspaces/:id`와 `POST /api/workspaces/:id/restore`를 부르면 → 403 `TWO_FACTOR_REQUIRED` (docs/adr/1300-*).
- `DELETE /api/comments/:id`에도 댓글 달기와 고치기처럼 그 페이지의 댓글 권한이 필요합니다. 없으면 403 `PAGE_LOCKED` 또는 403 `PAGE_ACCESS`입니다(docs/adr/0971-*, 1251-*).
- 공개 파일 경로(`/api/public/:token/f/:fileId`, `/api/public/:token/p/:ref/f/:fileId`): 파일이 속한 페이지가 공유된 페이지 자신이거나, 공유된 폴더 또는 그 하위 트리의 페이지여야 합니다. 아니면 404입니다(docs/adr/1302-*).

<a id="query-blocks-docsadr1320-1352"></a>
### 쿼리 블록 (docs/adr/1320, 1352)
- `POST /api/workspaces/:id/query`, `rows[].cells`: 컬렉션의 사람 속성을 가리키는 열에는 멤버의 표시 이름이 들어갑니다(저장된 id가 워크스페이스 멤버가 아니면 `null`). relation 속성을 가리키는 열에는 호출한 사람이 볼 수 있는 연결된 행의 `QueryPageRef[]`(`[{ ref: 'page', pageId, title }]`)가 저장된 순서대로 들어갑니다(숨은 행, 휴지통의 행, 다른 컬렉션으로 가는 링크는 빠지고 그 id도 보내지 않습니다). 다른 열은 그대로입니다. 속성 이름만 쓴 열만 바뀝니다(`TABLE Owner`, `LIST Owner`). `elapsedMs`에 이제 이 표시 단계도 들어갑니다(docs/adr/1320-*).
- `WHERE`, `SORT`, `contains()`와 비교에서 컬렉션 행의 사람 속성은 멤버 이름으로 비교하고(멤버가 아니면 값 없음), relation 속성은 호출한 사람이 볼 수 있는 연결된 행 제목의 목록으로 비교합니다(저장된 순서. `SORT`는 ", "로 이어 붙여 씁니다). `=`, `!=`와 문자열을 준 `contains()`는 멤버나 보이는 연결된 행의 저장된 id와도 맞춰 봅니다. 다른 값은 저장된 그대로 비교합니다. 비교는 정확히 일치해야 하고 대소문자를 가립니다(docs/adr/1352-*).

<a id="collections-docsadr1351-1353"></a>
### 컬렉션 (docs/adr/1351, 1353)
- `ViewConfig`(표)에 `columnWidths: { [fieldId]: number }`가 붙습니다. 속성 열의 너비(px, 정수 150–1600, 항목은 많아야 200개. 항목이 없는 속성은 창에 맞춰 크기가 정해짐)입니다. `titleWidth`도 붙는데, 제목 열의 너비(px, 정수 240–1600)입니다. 범위를 벗어난 값은 다른 잘못된 설정처럼 400 `VALIDATION`입니다. `PATCH /api/collection-views/:id`는 여전히 설정 전체를 바꿉니다. 이 키 없이 설정을 보내는 클라이언트는 너비를 지우게 됩니다. 템플릿 내보내기와 가져오기에도 들어갑니다(docs/adr/1351-*).
- `PUT /api/pages/:id/collection/fields`: 새로 만들거나, 대상을 바꾸거나, 양방향으로 바꾼 relation이 없는 컬렉션이나 호출한 사람이 볼 수 없는 컬렉션을 가리키면(두 경우 답이 같음), 또는 새로 만들거나 바꾼 rollup이 그런 relation을 쓰면 400 `VALIDATION` "Relation target collection not found"를 답합니다. 바꾸지 않고 그대로 다시 보낸 relation 속성과 rollup은 호출한 사람이 대상을 볼 수 없어도 통과합니다(docs/adr/1353-*).

<a id="ink-docsadr1340"></a>
### 필기 (docs/adr/1340)
- `GET /api/pages/:id/ink` → `{ ink: InkDTO { pageId, strokes, updatedAt | null } }`. `PUT /api/pages/:id/ink { strokes, expectedUpdatedAt?: ISO | null }` → `{ ink }`(편집 잠금이 적용됨). `expectedUpdatedAt`을 주었는데 버전이 다르면 412 `INK_CONFLICT`를 답하고 `error.ink`에 지금 필기를 담습니다(docs/adr/0815-*). 새로 바뀐 점: `expectedUpdatedAt` 없는 PUT이 비어 있지 않은 필기를 `[]`로 바꾸려 하면 역시 412 `INK_CONFLICT`를 답하고 아무것도 쓰지 않습니다. 버전을 준 지우기와, 버전 없이 비어 있지 않은 목록을 저장하는 것은 예전과 같습니다(마지막에 쓴 것이 이김).

<a id="v0110-additions"></a>
## v0.11.0 추가 사항

<a id="later-list-and-followed-threads-docsadr14101413"></a>
### 나중에 보기 목록과 따라가는 스레드 (docs/adr/1410–1413)
마이그레이션 `0039_v011_later_threads`가 `later_items`, `thread_follows`와 `user_notification_settings`의 열 두 개를 더합니다.

| 메서드 | 경로 | 본문 / 쿼리 | 응답 |
|---|---|---|---|
| GET | `/api/later` | `workspaceId?, state=open\|done` | `{ items: LaterItemDTO[], open, due }`. 호출한 사람의 항목, 최신순(≤ 200). `accessible: false`인 항목에는 제목, 미리보기, 행위자, 앵커, 알림 종류가 없습니다. 토큰 범위 밖이거나 에이전트가 차단된 워크스페이스의 항목은 빠집니다. 읽기 전용 토큰도 부를 수 있습니다(MCP `later`) |
| GET | `/api/later/target` | `pageId`, `threadId`, `notificationId`, `id` 중 정확히 하나 | `{ item: LaterItemDTO \| null }`. 이 대상이 내 목록에 있는지 |
| POST | `/api/later` | `{ kind: 'page'\|'thread'\|'notification', pageId?, threadId?, notificationId?, anchor?, remindAt?: ISO \| null, remindTz? }` | 201(새로 저장) / 200(이미 저장됨: 다시 열고, 본문에 `remindAt`이 있으면 리마인더를 바꿈) `{ item }`. 호출한 사람이 대상을 볼 수 없으면 404(외부 사람 포함). 워크스페이스 단위 알림, 과거(1 min 넘게 지난) 리마인더, 732일보다 먼 리마인더는 400. 열린 항목이 500개면 409 `LATER_FULL` |
| PATCH | `/api/later/:id` | `{ done?: boolean, remindAt?: ISO \| null, remindTz? }` | `{ item }`. 자기 항목만(아니면 404). 새 `remindAt`을 주면 리마인더를 다시 겁니다 |
| DELETE | `/api/later/:id` | | 204 |
| GET | `/api/threads` | `workspaceId, all=0\|1` | `{ threads: ThreadSummaryDTO[], unread }`. 따라가는 스레드 중 `lastReadAt` 이후 다른 사람의 답글이 달린 것(all=1: 따라가는 스레드 전부), 최근 활동순(≤ 100). 호출한 사람이 볼 수 없는 페이지는 빠집니다. 게스트는 공유받은 트리 안에서만 |
| GET | `/api/pages/:id/thread-follows` | | `{ follows: ThreadFollowDTO[] }`. 이 페이지에 있는 호출한 사람의 줄 |
| GET | `/api/threads/:id/follow` | | `ThreadFollowDTO`(`source: null` = 줄 없음) |
| PUT | `/api/threads/:id/follow` | `{ following: boolean }` | `ThreadFollowDTO`. 직접 따라가기를 켜면 지금까지의 스레드를 읽은 것으로 칩니다. 답글 id이거나 호출한 사람이 볼 수 없는 스레드면 404 |
| POST | `/api/threads/:id/read` | `{}` | `{ ok, notificationsRead }`. 스레드를 읽음으로 하고, 그 스레드에 대한 호출한 사람의 안 읽은 종 알림(`cr:`/`c:`/`cm:` 묶음 키)도 읽음으로 바꿉니다 |

바뀐 점:
- `GET/PATCH /api/me/notification-settings`: `NotificationSettingsDTO`에 `threadAutoFollow`(기본 true)와 `threadReplies`(기본 true)가 붙고, PATCH가 둘 다 받습니다.
- `ids`를 준 `POST /api/notifications/read`: 댓글, 답글, 멘션 항목이면 `GET /api/threads`에서도 그 스레드를 읽음으로 바꿉니다. `ids` 없이("모두 읽음") 부르면 스레드는 건드리지 않습니다.
- `NotificationType`에 `later_reminder`가 붙습니다(행위자 없음. 음소거와 시간당 상한을 무시하고 나감. 즉시 메일. 에이전트 inbox 항목은 아님).
- `POST /api/pages/:id/comments`: 댓글을 쓴 사람은 그 스레드를 따라가게 되고(`threadAutoFollow`가 꺼져 있으면 아님. 예전에 따라가기를 끈 것은 그대로 둠), 지금까지 읽은 것으로 칩니다. `comment_reply`는 스레드에 글을 쓴 모든 사람 대신, `threadReplies`가 켜진 스레드 팔로워에게 갑니다. 에이전트 inbox의 `reply` 종류도 같은 규칙을 따릅니다. 마이그레이션이 스레드의 예전 작성자를 모두 팔로워로 넣으므로, 업그레이드 직후 받는 사람은 그대로입니다.
- 사이드바 메뉴 id(`SIDEBAR_MENU_IDS`)에 `later`와 `threads`가 `search` 뒤에 붙습니다. 이 둘이 없는 저장된 순서에서는 기본 자리에 보입니다.
- MCP: `later(workspaceId?, state?, budget?)`, 읽기 도구([MCP.ko.md](MCP.ko.md), docs/adr/1413-*).

<a id="v0120-additions"></a>
## v0.12.0 추가 사항

마이그레이션은 `0040_v012_agent_ink_setting`(`workspaces.agent_ink_read`)과 `0041_v012_suggestions_leases`
(`section_suggestions`, `section_leases`, `agent_edit_policies`, `catch_up_markers`. catch_up 표시는
`plugin_storage`에서 옮겨 옴)입니다.

<a id="agent-notation-and-renamed-sections-docsadr15001501"></a>
### 에이전트 표기법과 이름이 바뀐 섹션 (docs/adr/1500–1501)
- `GET /api/pages/:id/export?format=md&notation=agent`: 새 선택 파라미터 `notation`(`plain`이 기본 | `agent`)입니다. MCP `read_page`가 쓰는 왕복 표기법입니다(콜아웃은 `> [!type]`, 멘션은 `@[Name](user:<id>)`, 임베드, 플러그인, 파일, 오디오 블록은 `<!-- inkling:… -->` 줄). 일반 Markdown 내보내기도 이제 콜아웃을 `> [!type] text`로, 멘션 칩을 `@Name`으로 씁니다. 임베드와 플러그인 블록은 여전히 빠집니다(docs/adr/1500-*).
- `GET /api/pages/:id/section`: 제목 이름을 바꾸기 전의 앵커로 참조했으면 답에 `movedFrom: "<ref as given>"`이 붙을 수 있고, `section.anchor`는 새 앵커입니다. 옛 이름이 이제 여러 섹션으로 이어지면 → 409 `SECTION_AMBIGUOUS` ("Section "x" was renamed and now matches several sections: a, b. Use one of these anchors.", 이름이 바뀐 섹션이 여러 섹션과 맞으니 그중 한 앵커를 쓰라는 뜻) (docs/adr/1501-*).
- `POST /api/pages/:id/section`: 성공 본문과 409 `SECTION_CONFLICT` 본문에 `movedFrom`이 붙을 수 있습니다. 같은 409 `SECTION_AMBIGUOUS`도 있습니다.
- `POST /api/pages/:id/content`(`mode=replace`): 문서를 최소한으로 고칩니다(블록 id 유지). 응답은 그대로입니다.

<a id="handwriting-versions-trash-and-files-for-agents-docsadr15101514"></a>
### 에이전트를 위한 필기, 버전, 휴지통, 파일 (docs/adr/1510–1514)
- `GET /api/workspaces/:id/settings`: `settings.agentInkRead: boolean`("에이전트가 필기를 읽을 수 있음"(`Agents can read handwriting`), 기본 false).
- `PUT /api/workspaces/:id/settings/agent-ink { enabled: boolean }`(strict): 소유자와 관리자, 브라우저 세션만(토큰은 403). 앞뒤 `{ agentInkRead }`와 함께 `settings.updated`로 감사 기록에 남습니다. `PATCH /settings`처럼 `{ settings, role, can }`를 답합니다. 멤버는 403, 없는 워크스페이스는 404입니다(docs/adr/1510-*).
- `GET /api/pages/:id/ink`: 이 설정이 꺼진 워크스페이스에서 에이전트(OAuth/MCP) 요청이면 403 `AGENT_INK_OFF`. 브라우저 세션과 개인 API 토큰은 그대로입니다.
- `GET /api/files/:id/meta`(새 경로) → `{ file: { id, url, name, mime, size, workspaceId, pageId, createdAt } }`. `GET /files/:id`와 같은 검사를 합니다(멤버 또는 게스트. 파일이 속한 페이지가 지금 보여야 함. 게스트는 공유받은 페이지의 파일만. 아니면 404이고, 저장된 파일이 없을 때도 404). 하위 트리로 범위가 묶인 연결은 페이지가 없는 예전 파일에 403 `OUT_OF_RANGE`를 받습니다. 읽기 전용 토큰도 부를 수 있습니다(docs/adr/1514-*).
- `POST /api/pages/:id/snapshots/:sid/restore`: 워크스페이스 접근 상태로 확인하고 쓰기 관문 아래에서 적용합니다(docs/adr/1151-*, 1513-*). 복원이 도는 사이에 편집 잠금이나 멤버 제외가 커밋되면 403 `PAGE_LOCKED` / 403을 답하고 페이지는 건드리지 않습니다. "복원 전"(`Before restore`) 스냅샷에는 에이전트 요청이면 `viaClient`가 붙고, 변경 피드에는 복원한 사람(과 클라이언트)이 기록됩니다.

<a id="catchup-collection-structure-and-mcp-requests-docsadr15201526-1537"></a>
### catch_up, 컬렉션 구조, MCP 요청 (docs/adr/1520–1526, 1537)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/catch-up` | `since?`, `workspaceId?`, `budget?`(≤ 12,000, 기본 4,000), `advance?`(`0`이면 표시를 그대로 둠) | `{ text, cursor, since: { at, source: 'given'\|'connection'\|'person'\|'default' }, counts: { pages, comments, forYou, due, later, listed, hidden }, tokens }`. 호출한 사람에게 "자리를 비운 사이" 일어난 일을 순위대로 정리한 텍스트입니다. `since` 뒤에 생긴 inbox 항목, 마감 항목(오늘 − 14일 … + 7일, 끝나지 않은 것), 마감이 지났거나 7일 안에 오는 나중에 보기 리마인더, `since` 뒤에 생긴 댓글, `since` 뒤의 변경 기록 줄을 페이지별로 묶은 것(편집, 사람과 클라이언트, 섹션 diff)이 들어갑니다. `since`: catch_up 커서, `changes_since` 커서, ISO 시각 중 하나. 빼면 → 호출한 사람의 마지막 catch_up 표시(OAuth 허가나 API 토큰마다, `workspaceId`마다 `catch_up_markers`에 있음), 없으면 그 사람의 표시, 그것도 없으면 24시간. 400 `INVALID_SINCE`. `workspaceId`에는 멤버 자격이 필요합니다. 읽기 전용 토큰도 부를 수 있습니다(호출한 사람의 표시만 씀). 보이는 범위는 `/changes`, `/inbox`, `/later`, 마감 보기와 같습니다. 30/min |

- `POST /api/pages/:id/collection/rows`: `props`의 relation 값은 `PATCH /props`의 규칙으로 행의 트랜잭션 안에서 저장됩니다. 대상 컬렉션에서 호출한 사람이 볼 수 있는 살아 있는 행이 아닌 id는 버립니다. 양방향 relation이면 대상 행을 편집할 수 있어야 하고(아니면 403 `PAGE_LOCKED` / `PAGE_ACCESS`이고 행을 만들지 않음), 짝이 되는 속성에도 똑같이 반영합니다(docs/adr/1524-*).
- `PUT /api/pages/:id/collection/fields`는 쓰기 관문 아래에서 돕니다(docs/adr/1071-*). 편집 잠금 확인 뒤에 커밋된 잠금, 에이전트 차단, 역할 변경을 트랜잭션 안에서 다시 확인합니다(docs/adr/1523-*).
- `POST /mcp`: 본문을 읽기 전에 bearer 토큰을 확인합니다(올바른 토큰이 없으면 본문을 해석하지 않고 401. JSON이 아닌 본문도 마찬가지). JSON 값이 20,000개를 넘는 본문 → 413 `TOO_MANY_VALUES`. 본문 한도는 12 MB입니다(docs/adr/1526-*).
- JSON을 출력하는 MCP 도구는 멤버가 쓴 문자열을 정리하고, 맨 끝에 `untrusted` 키(객체)나 두 번째 텍스트 블록(배열)을 붙입니다. `create_page`, `rename_page`, `move_page`는 에이전트 지침이 적용되면 `applies`를 붙입니다(docs/adr/1525-*).

<a id="suggestions-and-section-claims-docsadr15301539"></a>
### 제안과 섹션 잡기 (docs/adr/1530–1539)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/pages/:id/suggestions` | `preview=1`, `all=1` | `{ suggestions: SuggestionDTO[], claims: SectionClaimDTO[], canDecide }`. 페이지의 열린 제안(`all=1`: 수락, 거절, 철회된 것도), 살아 있는 섹션 잡기, 호출한 사람이 수락이나 거절을 할 수 있는지. `preview=1`이면 열린 제안마다 `preview { found, currentAnchor, currentVersion, changed, before, after, ops: DiffOpDTO[] \| null, large }`가 붙습니다. 멤버만(게스트: 404). 페이지가 보여야 하고, 에이전트 차단과 연결 범위가 적용됩니다 |
| GET | `/api/suggestions` | | `{ suggestions }`: 호출한 사람이 낸 것 중 열린 것과 최근 7일 안에 결정된 것 |
| GET | `/api/suggestions/:id` | `preview=1` | `{ suggestion }` |
| POST | `/api/suggestions/:id/accept` | `{ confirmChanged?: boolean }` | `{ suggestion }`. 사람만(브라우저 세션 또는 개인 API 토큰. OAuth/MCP → 403 `PEOPLE_DECIDE`), 편집 권한 필요. 에이전트가 읽은 뒤 섹션이 바뀌었고 `confirmChanged`를 주지 않았으면 409 `SUGGESTION_CHANGED { preview }`. 409 `SECTION_GONE { preview }`. 409 `SUGGESTION_DECIDED`. 30/min |
| POST | `/api/suggestions/:id/reject` | | `{ suggestion }`. 사람만, 편집 권한 필요 |
| POST | `/api/suggestions/:id/withdraw` | | `{ suggestion }`. 낸 사람(에이전트도) |
| POST | `/api/pages/:id/claims` | `{ section, ttlSeconds? }`(30–1800, 기본 300) | `{ claim: SectionClaimDTO }`. bearer 연결만(브라우저 세션은 400). 문서 페이지. 호출한 사람이 그곳을 편집하거나 제안할 수 있어야 합니다. 다른 연결이 잡고 있으면 409 `SECTION_CLAIMED`. 연결 하나가 살아 있는 잡기를 20개 넘게 가지면 429 `TOO_MANY_CLAIMS`. 60/min |
| DELETE | `/api/pages/:id/claims` | `section` | `{ released: boolean }` |

`SuggestionDTO { id, pageId, workspaceId, anchor, headingPath, blockId, mode: replace|append|prepend|insert_after|delete|page_replace|page_append, origin: 'asked'|'lock'|'policy', status: open|accepted|rejected|superseded|withdrawn, markdown, baseVersion, author { id, name }, via, createdAt, decidedBy, decidedAt, rule, reviewReason, autoAt, applied?, preview? }`. `SectionClaimDTO { pageId, anchor, blockId, by, userId, mine, expiresAt }`. 열린 제안은 페이지마다 많아야 100개입니다.

바뀐 점:
- `POST /api/pages/:id/section`이 `suggest?: boolean`을 받습니다. 변경이 제안으로 남았으면(요청했거나, 에이전트 편집 정책이나 페이지 잠금 때문에) `202 { suggestion }`을 답합니다. bearer 연결은 다른 연결이 그 섹션을 잡고 있으면 409 `SECTION_CLAIMED { claim }`을 받습니다(제안은 잡기에 막히지 않습니다).
- `POST /api/pages/:id/content`는 에이전트 편집이 제안이 되는 곳에서 `202 { suggestion }`을 답합니다(`page_replace` / `page_append`). 다른 연결이 페이지의 섹션을 잡고 있는 동안 `mode: replace`는 409 `SECTION_CLAIMED`를 받습니다.
- 살아 있는 잡기가 있으면 `GET /api/pages/:id/outline`에 `claims`가, `GET /api/pages/:id/section`에 `claim`이 붙습니다.
- `NotificationType`의 `approval_request`(새 제안이 생기면 페이지 소유자, 없으면 만든 사람에게)와 `approval_result`(결정된 제안을 낸 사람에게. 에이전트 inbox 종류)를 이제 실제로 만들어 보냅니다(docs/adr/1534-*).

<a id="saving-tokens-docsadr15401543"></a>
### 토큰 아끼기 (docs/adr/1540–1543)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/api/pages/:id/sections` | `{ edits: [{ ref, markdown, mode: replace\|append\|prepend\|insert_after\|delete, baseVersion? }], suggest? }`(편집 1–20개, Markdown은 모두 합쳐 ≤ 2,000,000자) | `{ ok, results: [{index, section: {anchor, headingPath, version} \| null, movedFrom?}], sections }`. 문서 페이지만. 편집은 순서대로 적용되고 전부 되거나 전부 안 됩니다. 하나라도 실패하면 → 409 `SECTIONS_CONFLICT`. `error.conflicts: [{index, ref, anchor?, reason: version\|not_found\|ambiguous\|duplicate\|empty\|claimed\|invalid, message, baseVersion?, version?, markdown?}]`와 `error.anchors`(처음 50개)가 붙고, 아무것도 쓰지 않습니다. `suggest`를 주었거나 에이전트 편집이 제안이 되는 곳이면 `202 { suggestions: SuggestionDTO[] }`, 역시 전부 되거나 전부 안 됩니다(잘못된 섹션은 `POST /section`의 단일 오류로 답함. 예: 404 `SECTION_NOT_FOUND`) (docs/adr/1538-*). 편집 중 하나라도 replace/delete면 "AI 편집 전"(`Before AI edit`) 스냅샷을 하나 남깁니다(페이지마다 2 min에 ≤ 1개). 30/min (docs/adr/1542-*) |

- `GET /api/pages/read`가 `known?`(`id:version,…`, 호출한 쪽이 가진 페이지 버전)을 받습니다. 페이지마다 `version`(kind, 제목, 속성, 본문의 해시)이 붙습니다. `known`을 주면 버전이 같은 아는 페이지는 `unchanged: [{id, title, kind, updatedAt, version}]`에 본문 없이, 예산을 쓰지 않고 나옵니다(docs/adr/1540-*).
- `GET /api/workspaces`는 만든 시각순, 그다음 id순으로 정렬됩니다(docs/adr/1543-*).

<a id="agent-edit-policy-and-auto-accept-rules-docsadr15441545"></a>
### 에이전트 편집 정책과 자동 수락 규칙 (docs/adr/1544–1545)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/workspaces/:id/agent-policy` | | `{ policy: AgentPolicyDTO }`. 멤버 |
| PUT | `/api/workspaces/:id/agent-policy` | `{ level: 'direct'\|'auto'\|'review', rules }` | `{ policy }`. 소유자와 관리자, 브라우저 세션만. `agent_policy.changed`로 감사 기록 |
| GET | `/api/pages/:id/agent-rules` | | `{ policy }`: "규칙으로 수락"(`Accept by rules`) 잠금 노드의 규칙(정하지 않았으면 기본값) |
| PUT | `/api/pages/:id/agent-rules` | `{ rules }` | `{ policy }`. 페이지 잠금을 관리할 수 있는 사람, 브라우저 세션만. 감사 기록에 남음 |

`rules = { modes: ('append'|'insert_after'|'prepend'|'replace'|'delete')[], connections: ('grant:<id>'|'token:<id>')[], maxLines: number|null, maxChars: number|null, graceMinutes: 0–10080 }`(기본값: append, insert_after, prepend. 모든 연결. 제한 없음. 기다림 없음). `AgentPolicyDTO { level, rules, canManage, updatedBy, updatedAt }`.

바뀐 점:
- `PUT /api/pages/:id/lock`: `agents`가 `'same' | 'direct' | 'auto' | 'suggest' | 'comment' | 'read'`를 받습니다. `'same'`은 이제 "워크스페이스 기본값을 따름"을 뜻합니다. `GET`이 이 값을 돌려줍니다.
- `POST /api/pages/:id/section`, `/sections`, `/content`는 규칙에 따라 바로 수락된 제안(`status: 'accepted'`, `rule`, `applied`)이나 기다리는 제안(유예 시간이면 `autoAt`, 맞는 규칙이 없으면 `reviewReason`)으로 202를 답할 수 있습니다.

<a id="several-agents-at-once-docsadr15501552"></a>
### 에이전트 여럿이 동시에 (docs/adr/1550–1552)
- `GET /api/context`: 계약은 그대로입니다. 답은 사람마다 두는 캐시에서 나올 수 있고, 캐시 키는 검색한 워크스페이스들의 권한 상태와 색인 표시입니다(docs/adr/1550-*).
- `GET /api/workspaces/:id/agents` → `{ connections: AgentConnectionDTO[], blocks: AgentBlockDTO[], usageSince }`. 연결마다 `usageSince`(서버 시작 시각, 프로세스마다) 이후 이 워크스페이스에 닿은 호출에 대한 `usage: { calls, errors, tokens, cacheHits, lastUsedAt } | null`이 붙습니다. 숫자만 담습니다(docs/adr/1552-*).
- `GET /api/admin/status`에 `agents: { since, totals: { connections, calls, errors, tokens, cacheHits }, cache: { hits, misses, entries, bytes }, waiting, connections: [{ kind: 'agent'|'token', id, name, user: { id, name } | null, calls, errors, tokens, cacheHits, avgMs, p95Ms, waitSec, lastUsedAt }], more }`가 붙습니다. 실시간 값이고(5분 점검 캐시에 들어가지 않음), 서버가 시작한 뒤 가장 최근에 쓰인 연결 50개입니다.
- `GET /api/changes`는 그대로입니다. 롱 폴링 `wait`는 MCP 도구에만 있습니다(docs/adr/1551-*).

<a id="mcp-tools"></a>
### MCP 도구
새 도구: `catch_up(workspaceId?, since?, budget?, peek?)`, `read_ink(pageId, top?, height?, scale?)`, `list_versions`, `diff_versions`, `read_file`, `list_trash`, `list_suggestions(pageId?)`(읽기). `patch_sections(pageId, edits, suggest?)`, `create_collection(workspaceId, title, fields[], parentId?, private?)`, `update_fields(collectionId, add?, change?, remove?, order?)`, `restore_version`, `restore_page`, `withdraw_suggestion(id)`, `claim_section(pageId, section, minutes?)`, `release_section(pageId, section)`(쓰기. 읽기 전용 연결은 거절됨). 새 인자: `read_page(…, known?, knownSections?)`, `read_pages(…, known?)`, `list_pages` / `search`의 `format: "compact"`, `patch_section(…, suggest?)`, `changes_since(…, wait?)`(0–25 s, 커서가 있을 때만. 기다리는 호출이 프로세스당 한도(256)나 연결당 한도(4)를 넘거나 서버가 종료 중이면 바로 답하고, 답은 `wait skipped: …`로 시작합니다). 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0130-additions"></a>
## v0.13.0 추가 사항

마이그레이션은 없습니다. `collection_views.type`이 `chart`일 수 있고 `section_suggestions.status`가 `accepted_partial`일 수 있습니다(CHECK가
없는 텍스트 열). 저장된 제안 기준본은 `plugin_storage`에 플러그인 id `inkling:suggestion_base`로 들어갑니다.

<a id="charts-docsadr16001606"></a>
### 차트 (docs/adr/1600–1606)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/api/workspaces/:id/charts/aggregate` | `ChartAggregateInput`(아래) | `ChartDataDTO`(아래). 컬렉션의 행이나 쿼리 블록 쿼리의 행을 호출한 사람의 권한으로, 컬렉션 쿼리와 같은 접근 규칙에 따라 묶고 잽니다. 읽기 전용 토큰도 부를 수 있습니다. 240/min (docs/adr/1602-*) |

`ChartAggregateInput`:

| 필드 | 형식 | |
|---|---|---|
| `source` | `{ "type": "collection", "collectionId": uuid, "viewId"?: uuid }` 또는 `{ "type": "query", "query": string }` | `viewId`: 그 컬렉션의 보기. 그 보기에 저장된 필터가 행을 고릅니다 |
| `groupBy` | `{ "field": string, "bucket"?: "day" \| "week" \| "month" }` | 속성 id 또는 `"title"`(컬렉션), 열 이름(쿼리) |
| `series` | `groupBy`와 같은 모양, 선택 | 두 번째 묶음 |
| `measure` | `{ "fn": "count" \| "sum" \| "avg" \| "min" \| "max", "field"?: string }`, 선택 | 기본은 count. 나머지는 `field`(숫자나 rollup 속성 / 열)가 필요 |
| `sort` | `"auto" \| "label" \| "valueDesc" \| "valueAsc"`, 선택 | auto: 옵션 / 날짜 순서, 아니면 큰 값부터. "값 없음"은 맨 뒤 |
| `limit` | 1–100, 선택 | 돌려줄 묶음 수(나머지는 `omittedGroups`에 셈) |
| `today`, `tzOffsetMinutes` | 선택 | 쿼리 소스에서 `POST /query`와 같게 씀 |

`ChartDataDTO`: `source`(`{type:'collection', id, title, viewName?}` 또는 `{type:'query'}`), `group` / `series`
(`{field, name, type, bucket?}`), `measure`(`{fn, field?, name?}`), `groups`(`[{key, label, special?}]`. "값 없음"이면 `key`가 null,
`special`은 `empty` / `checked` / `unchecked`), `seriesKeys?`, `values`(`(number|null)[]`, 또는
`[group][series]`), `rowCount`, `omittedGroups`, `omittedSeries`, `truncated?`(쿼리가 행의 일부만 돌려줌),
`elapsedMs`, `cached?`.

묶을 수 있는 속성 종류: 선택, 다중 선택, 사람, 날짜, 체크박스, relation, 텍스트, URL, 숫자, 제목.
잴 수 있는 것: 숫자와 rollup. 사람은 멤버 이름이고(멤버가 아닌 사람의 id는 "값 없음"), relation은
보이는 연결된 행의 제목입니다. 오류: 404 `NOT_FOUND`(워크스페이스, 컬렉션, 보기가 없거나, 숨었거나, 다른 워크스페이스의 것이거나,
컬렉션이 아님), 멤버가 아닌 사람 / 게스트 / 범위 밖 토큰은 403, 400 `INVALID_CHART`(모르는 속성, 묶거나 잴 수
없는 속성), 400 `QUERY_SYNTAX` / `QUERY_TIMEOUT`.

바뀐 점:
- `POST /api/pages/:id/collection/views`가 `config`(선택, `ViewConfig`, `PATCH`와 같은 모양)를 받습니다. 보기 `type`이
  `chart`일 수 있습니다. `ViewConfig.chart` = `{ kind, groupBy, series?, measure?, sort?, limit?, title?, options? }`
  (docs/adr/1603-*).
- 페이지 블록: `chart` 블록의 prop은 `config` 하나입니다(`{ source, kind, groupBy, … }`의 정규화된 JSON, 설정하는 동안은 `''`).
  에이전트 표기법: `<!-- inkling:chart {config} -->`. `read_page`는 그 아래에 `<!-- inkling:chart-data … -->`를
  붙이고, 쓰기에서는 이 줄을 무시합니다(docs/adr/1604-*).
- Markdown 내보내기(`GET /api/pages/:id/export?format=md`)는 차트를 그 숫자의 표로 씁니다. 공개 폴더 링크는
  데이터베이스가 링크 안에 있는 차트만 표로 보여 줍니다(docs/adr/1605-*).

<a id="suggestions-in-parts-docsadr1621-1622-1626"></a>
### 제안을 나눠서 수락하기 (docs/adr/1621, 1622, 1626)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/pages/:id/suggestions` | `preview=1`, `status?`, `all=1` | 0.12와 같습니다. `status` = `open`(기본) \| `decided`(accepted, accepted_partial, rejected) \| `all` \| 상태 하나. `all=1`은 여전히 웹 기록(superseded를 뺀 전부)입니다. `preview=1`이면 열린 `replace` 제안의 `preview`에 `merge: { baseKnown, key, hunks: [{ id, conflict, same, before, after, ours, context }] }`가 붙습니다(섹션이 없어졌거나 너무 커서 나눌 수 없으면 없음) |
| GET | `/api/suggestions` | `status?` | `{ suggestions }`: 호출한 사람이 낸 것, 같은 필터, 기본 `open`, 최신 50개 |
| POST | `/api/suggestions/:id/accept` | `{ confirmChanged?, hunks?: number[], mergeKey?: string }` | `{ suggestion }`. `hunks`(`preview.merge`의 id들, 그 `key`를 `mergeKey`로 줌)를 주면 그 변경 조각만 적용합니다. 서버가 병합을 다시 계산해 병합된 섹션을 씁니다. `mergeKey`가 낡았으면 → 409 `SUGGESTION_CHANGED`, `error.preview`와 함께. `status`는 `accepted` 또는 `accepted_partial`(`partial: { applied, total }`)입니다. `hunks`가 없으면 0.12와 같습니다 |
| POST | `/api/suggestions/:id/withdraw` | | `{ suggestion }`. 이미 열린 상태가 아닌 제안은 상태마다 다른 409를 답합니다(아래) |

`SuggestionDTO`에 `supersededBy?`(같은 연결이 같은 섹션에 낸 더 새 제안)와 `partial?`
(`{ applied, total }`)가 붙습니다. `status`에 `accepted_partial`이 붙습니다. 수락과 철회의 409 코드: `SUGGESTION_SUPERSEDED`,
`SUGGESTION_WITHDRAWN`, `SUGGESTION_DECIDED`, `SUGGESTION_UNSPLITTABLE`(너무 커서 변경 조각으로 나눌 수 없음), `SECTION_GONE`.
메시지마다 상태와 누가 했는지를 말하고, 대체된 제안이면 더 새 제안의 id도 알려 줍니다.

<a id="reverting-changes-docsadr1620-1623-1624"></a>
### 변경 되돌리기 (docs/adr/1620, 1623, 1624)

사람만 할 수 있습니다(브라우저 세션 또는 개인 API 토큰. 에이전트 연결 → 403 `PEOPLE_DECIDE`). 되돌리기 경로는 모두
미리보기용 `dryRun`을 받습니다.

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/pages/:id/changes` | `before?`(seq), `limit?`(1–100, 기본 20) | `{ items: ActivityItemDTO[], next }`: 그 페이지 자신의 변경 기록, 최신순. 항목마다 `revert`(아래)가 있습니다 |
| POST | `/api/changes/:seq/revert` | `{ dryRun? }` | `RevertResultDTO`. 변경 하나. 그 페이지의 편집 권한 필요. 변경이나 그 페이지가 보이지 않으면 404. 30/min |
| POST | `/api/pages/:id/revert` | `{ seqs? (1–200) \| via, actorId?, since?, until?, dryRun? }` | `RevertResultDTO`. 지정한 변경들, 또는 한 에이전트가 그 페이지에서 한 기간 동안 한 변경(`via` = 클라이언트 이름, `actorId`를 주면 한 멤버의 연결로 좁힘). `seqs`나 `via` 중 하나가 필요합니다(없으면 400). 30/min |
| POST | `/api/workspaces/:id/revert` | `{ via, actorId?, since, until?, dryRun? }` | `RevertResultDTO`. 워크스페이스에서 한 에이전트가 한 변경. 소유자와 관리자. 페이지마다 전부 쓰거나 전혀 쓰지 않고, 잠긴 페이지는 보고합니다. 10/min |

`RevertResultDTO { dryRun, pages: [{ pageId, title, written, error?: { code, message }, changes: [{ seq, kind, anchor, headingPath, via, actor, changedAt, outcome, applied, conflicts: [{ wanted, now, reason: 'overlap' | 'no_source' }], plainText, reason? }] }], totals: { pages, changes, applied, partial, conflicts, unsupported, noop }, truncated }`.
`outcome`: `applied` | `partial` | `conflict` | `noop` | `unsupported`. `reason`(unsupported일 때): `large` | `page_event` |
`moved` | `heading_only` | `section_gone` | `section_exists` | `no_source` | `too_complex`. 한 번 호출에 변경은 많아야 300개입니다
(더 많이 맞으면 `truncated`이니 다시 부르세요). 쓰는 페이지마다 먼저 "되돌리기 전"(`Before revert`) 버전을 남깁니다. 되돌리기는
그 사람의 평범한 변경이고, `page.changes_reverted`(`before.seqs`, `before.via`, `after.seqs`,
`after.conflicts`)로 감사 기록에 남습니다.

`GET /api/workspaces/:id/activity`와 `GET /api/pages/:id/changes` 항목에 `revert: { revertable, revertedBy: { name,
at } | null, isRevert }`가 붙습니다.

<a id="change-feed-docsadr1625-16501653"></a>
### 변경 피드 (docs/adr/1625, 1650–1653)
- `page_changes.kind`와 활동 `kind`에 `page_props`가 붙습니다(행 속성이 바뀜. `after` = 바뀐 속성 이름).
  활동 필터 `kind=page`에는 들어가고 `kind=edit`에는 들어가지 않습니다(docs/adr/1650-*).
- `GET /api/changes` 텍스트에 새 줄 모양이 생겼습니다: `collection added:`, `row added:`, `rows added: N to collection …`(한 답에서
  한 컬렉션의 행이 10개 이상일 때), `  properties: …`, `  trashed, then restored` (docs/adr/1650–1652).
- `PATCH /api/pages/:id/collection/rows/batch`는 사람 칸이 없어도 트랜잭션 하나에서 돌고, 제목 변경
  (`page_renamed`)과 `page_props`를 기록합니다.
- 편집기 입력 줄은 마지막 색인 이후 한 사람만 입력했으면 그 사람을 행위자로 기록합니다. REST/MCP 쓰기는 자기 변경보다 먼저
  밀려 있던 입력을 기록합니다(docs/adr/1625-*).
- `GET /api/catch-up`: "다른 사람이 바꾼 페이지"(`Pages changed by others`)는 다른 식별된 사람이 한 변경을 뜻합니다. 행위자가 없는 편집은
  `unattributed edits N`으로 셉니다(docs/adr/1653-*).

<a id="mcp-tools-1"></a>
### MCP 도구
새 도구: `create_chart(pageId, section?, placement?, collectionId? | query?, view?, kind, groupBy, bucket?, series?, seriesBucket?, measure?,
measureField?, sort?, limit?, title?, options?, suggest?)`, `create_view(collectionId, type, name, config?, chart?)`(쓰기.
읽기 전용 연결은 거절됨). 새 인자: `list_suggestions(…, status?)`. 바뀐 출력: `read_page`는 모든 읽기 형식에서
차트 토큰과 그 데이터 줄, 섹션 잡기를 보여 줍니다. `changes_since`와 `catch_up`은 컬렉션,
행, 행 속성을 나열합니다. `query_rows describe=true`는 `<untrusted_content>`로 감쌉니다. 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0140-additions"></a>
## v0.14.0 추가 사항

마이그레이션은 `0042_v014_semantic_vectors` 하나이고, 테이블 `page_chunk_vectors`(`page_id`, `text_hash`, `workspace_id`,
`model`, `dims`, `embedding real[]`)를 만듭니다. 이 테이블은 의미 검색이 켜져 있는 동안에만 씁니다(docs/adr/1741-*). 다른 스키마
변경은 없습니다.

<a id="findcontext-with-several-queries-docsadr17201723"></a>
### 질의 여러 개로 find_context (docs/adr/1720–1723)
- `GET /api/context`: `q`를 여러 번 줄 수 있습니다(`?q=a&q=b`. NFKC / 소문자 / 공백
  정규화 뒤 서로 다른 값이 많아야 5개, 넘으면 400). 서로 다른 값이 하나면 계약과 출력이 그대로입니다. 둘 이상이면 합친 결과에
  `queries`와 조각마다 `matched` 배열이 붙습니다. `fragments[].score`는 RRF 점수입니다. `more`와 `titleOnly`는
  모양이 그대로입니다(추가 순위 목록에서 온 `more` 항목은 `anchor: ""`(페이지 전체)와 `tokens: 0`일 수 있음)
  (docs/adr/1720-*, 1722-*).
- 의미 검색이 켜져 있으면(docs/adr/1740-*) `q`가 하나여도 `queries`와 `fragments[].matched`를 돌려줍니다. 조각이
  의미 검색 후보에서 올 수 있습니다(`matched`가 질의 번호를 알려 줌) (docs/adr/1723-*).
- 순위(모양은 그대로): 한국어 질의 단어는 조사와 어미가 붙은 꼴과도 맞습니다("백업을" → 백업,
  "팀을" → 팀/팀에/팀의를 온전한 단어로). 띄어 쓰지 않은 합성어도 띄어 쓴 단어와 맞습니다
  ("팀구성" → "팀 구성"). 페이지 별칭은 페이지 제목으로 칩니다. 제목(heading) 가중치는 0.3입니다(docs/adr/1700-*, 1701-*).

<a id="admin-semantic-search-state-docsadr1744"></a>
### 관리자: 의미 검색 상태 (docs/adr/1744)
`GET /api/admin/status`에 선택 필드가 하나 붙습니다. 의미 검색이 켜져 있을 때만(`EMBEDDING_URL`과
`EMBEDDING_MODEL`이 설정됨) 있고, 꺼져 있으면 응답은 그대로입니다.

```json
"semantic": {
  "enabled": true,
  "model": "bge-m3",
  "endpoint": "http://192.168.0.10:11434/v1/embeddings",
  "dims": 1024,
  "sections": { "indexed": 980, "pending": 20 },
  "chunks": { "indexed": 1210, "pending": 30, "rejected": 0 },
  "lastError": { "at": "2026-11-10T03:00:00.000Z", "message": "http://…/embeddings: timeout after 30000 ms" },
  "lastSuccessAt": "2026-11-10T03:01:00.000Z",
  "backoffUntil": null,
  "cache": { "workspaces": 2, "bytes": 5242880 }
}
```

`endpoint`는 스킴, 호스트, 경로만 담고 API 키는 절대 나오지 않습니다. 개수는 30 s 동안 캐시합니다. 개수를 읽을 수
없으면 이 필드는 `{ "enabled": true, "error": "status query failed" }`(또는 `"unavailable"`)가 되고, 나머지
상태는 평소대로 답합니다.

<a id="mcp-tools-2"></a>
### MCP 도구
새 인자: `find_context(…, queries?)`(표현을 5개까지. `query`는 선택이 되고, 둘 중 하나는 꼭 줘야 합니다).
바뀐 출력: 질의가 여럿이면 머리글이 질의를 번호로 보여 주고, 각 조각의 괄호 줄 끝에
`; matched: 1,3`이 붙습니다. 의미 검색이 켜져 있으면 뜻으로만 찾은 섹션은 본문을 함께 보여 줍니다. 자세한 내용:
[MCP.ko.md](MCP.ko.md).

<a id="v0150-additions"></a>
## v0.15.0 추가 사항

마이그레이션은 네 개입니다. `0043_v015_slack` (`slack_integrations`, `slack_user_links`, `slack_link_codes`, `slack_request_nonces`), `0044_wave13_forms` (`collection_form_links`), `0045_wave13_verify_present_status` (`pages.share_starts_at`, `page_verifications`, `user_statuses`), `0046_wave13_team_agents` (`notifications.connection`, `notifications.person_too`, `user_notification_settings.agent_handoff_copy`)입니다. 수식 속성과 폼 뷰는 기존 jsonb 열(`collection_fields`, 뷰의 `config`)에 저장합니다. `collection_views.type`은 `form`일 수 있습니다.

<a id="slack-app-docsadr18001806"></a>
### Slack 앱 (docs/adr/1800–1806)

설정(세션 쿠키, 워크스페이스 소유자만. 그 밖의 사람은 403):

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/workspaces/:id/slack` | – | `SlackSettingsResponse { integration: SlackIntegrationDTO \| null, setup: SlackSetupInfo }`. 토큰과 비밀은 절대 담기지 않습니다(`botTokenHint`는 `xoxb-…` 뒤에 마지막 4글자를 붙인 것입니다) |
| PUT | `/api/workspaces/:id/slack` | `{ botToken?, signingSecret?, channelId, events: SlackEventKind[], enabled? }` | `{ integration }`. 처음 저장할 때는 토큰과 비밀이 꼭 있어야 하고(400 `SLACK_SECRETS_REQUIRED`), 그 뒤로는 빼면 저장된 값을 그대로 씁니다. Slack의 `auth.test`를 실행해 보고, 실패하면 400 `SLACK_AUTH_FAILED`와 `error.slackError`(Slack의 오류 코드)를 돌려줍니다. 일시 중지를 풉니다. 감사 로그: `settings.updated`, 대상 `slack` |
| DELETE | `/api/workspaces/:id/slack` | – | 연결을 끊습니다. 계정 연결, 연결 코드, 대기 중인 Slack 작업을 지웁니다 |
| POST | `/api/workspaces/:id/slack/test` | – | 시험 메시지를 보냅니다 → `{ ok, error }`(Slack의 오류 코드). 성공하면 일시 중지를 풉니다 |
| GET | `/api/workspaces/:id/slack/links` | – | `{ links: SlackLinkDTO[] }` |
| DELETE | `/api/workspaces/:id/slack/links/:userId` | – | 멤버 한 명의 계정 연결을 지웁니다 |

이벤트 종류(`SLACK_EVENT_KINDS`): `mention`, `assigned`, `suggestion`, `reply`, `digest`. 봇 권한(`SLACK_BOT_SCOPES`): `chat:write chat:write.public commands links:read links:write users:read users:read.email`.

계정 연결(로그인한 멤버. 웹 앱의 `/slack/link` 페이지가 이 경로를 부릅니다):

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/api/slack/link/preview` | `{ code }` | `SlackLinkPreviewDTO`. 모르는 코드, 만료되었거나 이미 쓴 코드는 404, 그 워크스페이스의 멤버가 아니면 403 |
| POST | `/api/slack/link/confirm` | `{ code }` | `{ ok, workspaceId }`. 코드는 한 번만 쓸 수 있습니다 |

Slack에서 오는 요청(세션 없음. 본문을 v0 서명, 5분 타임스탬프 창, 팀 ID, 재전송 표로 검사하고, 검사에 실패하면 이유를 밝히지 않고 401로 답합니다):

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/api/slack/w/:workspaceId/commands` | 슬래시 명령(form-encoded). 텍스트: `<words>`, `help`, `link`, `unlink` | 항상 `response_type: ephemeral`. Slack의 `ssl_check=1`에는 200으로 답합니다 |
| POST | `/api/slack/w/:workspaceId/events` | Events API JSON: `url_verification`, 그리고 `link_shared`, `app_uninstalled`, `tokens_revoked`를 담은 `event_callback` | `url_verification`에는 `{ challenge }`로 답합니다(서명 없이 받는 것은 살아 있는 워크스페이스에 저장된 앱이 없을 때뿐입니다). 그 밖에는 바로 200으로 답하고, 링크 미리보기(unfurl)는 나중에 outbox를 거쳐 보냅니다. JSON이 아닌 본문은 400 |

<a id="form-views-and-public-forms-docsadr18201822-1870"></a>
### 폼 뷰와 공개 폼 (docs/adr/1820–1822, 1870)

- `viewTypeSchema`에 `form`이 생깁니다. `ViewConfig.form = { title?, description?, fields: [{ fieldId, required?, description? }], submitLabel?, successMessage? }`입니다(`fieldId: "title"`은 행 제목이고, 질문은 50개까지). 폼으로 물을 수 있는 속성은 text, number, select, multiSelect, date, checkbox, url이고, person 속성은 멤버에게만 묻습니다.

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/collection-views/:id/form-link` | – | 데이터베이스를 볼 수 있는 멤버에게 `{ shared, token, canPublish }`를 줍니다. 뷰가 폼이 아니면 400 |
| POST | `/api/collection-views/:id/form-link` | – | 공개 링크를 켭니다(소유자와 관리자. 그 밖의 사람은 403. 개인 데이터베이스이거나 폼이 아니면 400. 403 `PUBLIC_SHARING_DISABLED`). 여러 번 불러도 결과가 같습니다. 감사 로그 `form.published` |
| DELETE | `/api/collection-views/:id/form-link` | – | 공개 링크를 끕니다(소유자와 관리자, 또는 데이터베이스를 편집할 수 있는 사람). 감사 로그 `form.unpublished` |
| GET | `/api/public/forms/:token` | – (세션 없음) | `PublicFormDTO { title, description, submitLabel, successMessage, fields: [{ key, name, type, required, description, options? }], honeypot }`. IP당 60/min. `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` |
| POST | `/api/public/forms/:token` | `{ values: { [key]: answer }, website?: "" }`(strict. `website`는 허니팟 칸) | `{ ok: true }`. 400 `FORM_INVALID`(`fields: { key: "required" \| "invalid" }`), 닫혔거나 모르는 링크는 404, 32 KiB를 넘으면 413, 429 `RATE_LIMITED`(IP당 10/min, 또는 폼 하나에 300/hour) |

응답 값은 이렇습니다. text는 문자열(≤ 5,000자), number는 숫자(또는 숫자로 된 문자열), select/multiSelect는 옵션 id나 이름, date는 `YYYY-MM-DD`, checkbox는 `true`/`"on"`, url은 공백 없는 문자열(≤ 2,000자)입니다. person, relation, formula 속성은 공개 응답에서 절대 받지 않습니다. 웹 페이지는 `/f/:token`이고, 페이지 링크(`/api/public/:token`)와 경로도 관문도 함께 쓰지 않습니다. 추측한 토큰은 IP 차단에서 실패 한 번으로 셉니다(사유 `form-token`).

공개 응답은 링크를 켠 멤버 이름으로 만들어지고 `via = "public form"`이 붙습니다(`pages.created_via`, `page_changes.via_client`). 공개 응답은 사람의 입력으로 칩니다(docs/adr/1870-*):
- `GET /api/workspaces/:id/activity?actor=human`에는 공개 폼 응답이 들어갑니다. `actor=ai`, `aiPagesOnly=1`, 클라이언트 목록에서는 빠집니다.
- `GET /api/pages/:id/provenance`는 이런 페이지에 `createdVia: null`을 주고 `lastAgentEdit`는 주지 않습니다.
- 표시 문구에는 그대로 드러납니다. catch_up, 변경 피드, 메일, 웹훅, inbox는 "<publisher> via public form"으로 적습니다.
- `POST /oauth/register`와 `POST /api/oauth/authorize`는 다른 예약어와 마찬가지로 클라이언트 이름 "public form"(대소문자 등을 접어서 비교)을 거부합니다(400).

<a id="formula-fields-docsadr18231827"></a>
### 수식 속성 (docs/adr/1823–1827)

- `CollectionField.type`에 `formula`가 생깁니다. `CollectionField.formula = { expression: string }`(≤ 2,000자)입니다. `PUT /api/pages/:id/collection/fields`에서 새로 넣거나 고친 수식은 문법이 맞아야 하고, 있는 속성만 가리켜야 하며, 순환하면 안 됩니다. 어기면 400 `Formula "<name>": <reason>`입니다. 고치지 않은 수식은 속성 이름이 바뀌면 따라갑니다(저장된 식을 고쳐 씁니다). 롤업은 대상 데이터베이스의 수식을 집계할 수 없습니다(`count`만 됩니다).
- 수식 값은 모든 읽기 응답의 `rows[].props[fieldId]`에 들어 있습니다(`GET /api/pages/:id/collection`, `PATCH /api/pages/:id/props` 응답, `GET /api/pages/:id/row`, `GET …/collection/query`의 셀). 값은 number, string, boolean 또는 날짜 문자열(`YYYY-MM-DD` / `YYYY-MM-DDTHH:mmZ`, UTC)이고, 비었거나 오류가 나면 `null`입니다. 수식 id에 값을 쓰면 무시합니다(props, batch, 행 템플릿, 시트 동기화, 가져오기). MCP `update_row`는 거부합니다.
- `GET /api/pages/:id/collection/query`: 수식은 결과 타입(number, text, checkbox, date)의 연산자로 거르고 정렬할 수 있습니다. 요약에는 `fields[].formula = { expression, result }`가 들어 있습니다. 오류가 난 셀은 `#error(<code>)`로 읽힙니다(코드: `syntax`, `unknownProp`, `ambiguousProp`, `unknownFunction`, `args`, `cycle`, `type`, `divZero`, `tooLong`, `tooComplex`, `badDate`, `badUnit`).
- 차트 집계: `groupBy` / `series`에 수식을 쓸 수 있고, `measure.field`에는 숫자를 내는 수식을 쓸 수 있습니다.

<a id="page-verification-docsadr18401842"></a>
### 페이지 확인 표시 (docs/adr/1840–1842)

| 메서드 | 경로 | 누가 | 요청 / 응답 |
|---|---|---|---|
| GET | `/api/pages/:id/verification` | 멤버(세션과 토큰) | `{ verification: PageVerificationDTO \| null, canVerify }` |
| POST | `/api/pages/:id/verification` | 브라우저 세션. 페이지를 편집할 수 있는 사람이고, 페이지에 소유자가 있으면 그 소유자나 워크스페이스 소유자/관리자 | `{ expiresInDays (1–365) \| expiresAt, note? (≤ 200) }`(만료는 두 형식 중 하나로). 페이지의 검토 시각도 함께 정합니다 |
| DELETE | `/api/pages/:id/verification` | POST와 같음 | `{ verification: null, canVerify }` |
| GET | `/api/workspaces/:id/verified?days=1..90&mine=1` | 멤버 | `{ expiringDays, expired[], expiring[], verified[] }`. 볼 수 있는 페이지만, 최대 500개 |

`PageVerificationDTO`: `state ('verified' | 'expired'), expiringSoon, verifiedAt, verifiedBy { id, name } | null, expiresAt, note, changedSections, changedMuch`. 오류는 403(`Pages are verified in the web app`, `Only the page's owner or a workspace admin can verify this page`, `PAGE_LOCKED`)과 400(`Folders are not verified`, 범위를 벗어난 만료)입니다. 감사 로그: `page.verified`, `page.unverified`.

<a id="scheduled-public-links-docsadr1844"></a>
### 예약 공개 링크 (docs/adr/1844)

- `POST /api/pages/:id/share` 본문에 `startsAt?: ISO | null`이 생깁니다(만료보다 앞이어야 하고 최대 10년 뒤까지, 지난 시각이면 바로 엽니다). `PATCH /api/pages/:id/share`에는 `startsAt: ISO | null`이 생깁니다(null이면 지금 엽니다). 시작이 만료보다 늦으면 400 `Pick a start before the expiry`입니다. 감사 로그: `share.start_changed`.
- `ShareStatusDTO`와 `GET /api/workspaces/:id/shared`의 항목에 `startsAt: string | null`과 `notStarted: boolean`이 생깁니다.
- 공개 경로(`/api/public/:token`, `…/f/:fileId`, `…/p/:ref`, `…/p/:ref/f/:fileId`, `…/unlock`)와 `/s/…`는 `startsAt` 전에 404 `NOT_FOUND`로 답합니다. 공유하지 않은 토큰과 똑같은 응답이고, `Cache-Control: no-store`가 붙으며, 실패로 세지 않습니다. 만료된 링크는 예전처럼 410 `SHARE_EXPIRED`입니다.

<a id="member-status-docsadr18451846"></a>
### 멤버 상태 (docs/adr/1845–1846)

| 메서드 | 경로 | 누가 | 요청 / 응답 |
|---|---|---|---|
| GET | `/api/me/status` | 로그인한 사람 | `{ status: MemberStatusDTO \| null }` |
| PUT | `/api/me/status` | 브라우저 세션 | `{ emoji? (≤ 16), text (≤ 80), clearAt?: ISO \| null }`. emoji와 text 중 하나는 있어야 하고, `clearAt`은 미래 시각이며 최대 1년 뒤까지입니다 |
| DELETE | `/api/me/status` | 브라우저 세션 | `{ status: null }` |

`GET /api/workspaces/:id/members`: 멤버마다 `status: { emoji, text, clearAt } | null`이 생깁니다(`clearAt`이 지난 상태는 null). 상태는 계정마다 하나이고, 모든 워크스페이스에서 같습니다.

<a id="team-agents-docsadr18601866"></a>
### 팀 에이전트 (docs/adr/1860–1866)

새 경로(멤버만. 게스트는 403):
- `GET /api/workspaces/:id/agent-connections` → `{ connections: WorkspaceConnectionDTO[] }`이고, 항목은 `{ ref, key, userId, userName, client, kind: 'grant' | 'token', lastUsedAt }`입니다. 멤버들의 살아 있는 연결(만료되지 않았고, 범위에 이 워크스페이스가 들어 있고, 여기서 막히지 않은 것)만 나옵니다. `ref` = `<userId>/grant:<id>`.
- `GET /api/workspaces/:id/team-agents?since=<ISO>` → `TeamAgentsDTO { since, now, totals: { claims, openSuggestions, edits, created, suggestions, reverted }, people: [{ userId, name, claims[], suggestions[], agents[] }] }`. `since`의 기본값은 24시간 전이고, 최대 7일 전까지 거슬러 갑니다. 잡아 둔 섹션(claims)은 `{ pageId, pageTitle | null, anchor | null, hidden, connection, client, expiresAt, ttlSeconds }`, 제안(suggestions)은 `{ id, pageId, pageTitle | null, anchor | null, hidden, mode, client, createdAt }`, 에이전트(agents)는 `{ client, connections[], edits, created, suggestions, reverted, recentPages[{ pageId, title | null, hidden, at }], lastAt }`입니다. 호출 제한 60/min.

바뀐 것(추가만):
- `POST /api/pages/:id/comments` 본문: `mentionConnections?: string[]`(≤ 10. `<userId>/grant:<id>`, `grant:<id>`, `token:<id>`, `g:xxxxxxxx` 중 하나). 멤버의 살아 있는 연결이 아니면 400 `AGENT_NOT_AVAILABLE`이고 아무것도 쓰지 않습니다.
- `PATCH /api/pages/:id/props`: person 속성 옆에 `agent:<fieldId>` 키를 둘 수 있습니다(값 형식은 같고, `null`이면 비웁니다). 셀에는 그 연결을 가진 사람이 들어갑니다. 같은 쓰기에서 그 셀을 다른 사람으로 정하면 400 `AGENT_NOT_AVAILABLE`입니다. 셀을 다른 사람으로 옮기는 쓰기는 agent 키를 지웁니다. 일괄 생성·수정 경로는 `agent:` 키를 무시합니다.
- 행의 `properties`에 `agent:<fieldId>`(`<userId>/grant:<id>`)가 들어갈 수 있습니다. 그 사람이 셀에 있고 연결이 살아 있는 동안에만 효력이 있습니다.
- `GET /api/notifications`: 내 연결 중 하나에 넘긴 항목은 내 사본 설정이 켜져 있을 때만 나오고, `forAgent: "<client name>"`이 붙습니다.
- `GET|PATCH /api/me/notification-settings`: `agentHandoffCopy`(기본값 false).
- `GET /api/inbox`(MCP): 부르는 연결에 넘긴 항목에는 `handoff: true`가 붙고, 결과에 `handoffs`(개수)가 더해집니다. 그 사람의 다른 연결에 넘긴 항목은 나오지 않으며, `POST /api/inbox/ack`도 그런 항목은 절대 확인 처리하지 않습니다.
- `GET /api/catch-up?team=1`은 팀 묶음을 더합니다.
- `GET /api/pages/:id/collection/query` 필터: person `= this connection`(에이전트 연결만).

<a id="member-statuses-in-row-answers-docsadr1846-1870"></a>
### 행 응답 속 멤버 상태 (docs/adr/1846, 1870)

`GET /api/pages/:id/collection/query`에 `people?: string[]`이 생깁니다. 그 페이지에 나온 행들의 person 셀에 있는 사용자 id를 정렬한 목록이고, 하나도 없으면 빠집니다. 그래서 person 열이 없는 응답은 0.14와 바이트 단위로 같습니다.

<a id="mcp-tools-3"></a>
### MCP 도구
새 인수: `create_view(…, type: "form", form?)`, `expression`을 담은 필드 스펙 `type: "formula"`(`create_collection`, `update_fields`), `add_comment(…, handoffTo?)`, `reply_comment(…, handoffTo?)`, `catch_up(…, team?)`, 그리고 `update_row` / `create_row`의 person 값 `"this connection"`, `grant:<id>`, `g:xxxxxxxx`.
바뀐 출력: `read_page`의 verified / stale 줄과 소유자의 상태, `find_context`의 verified 표시, 상태가 있는 사람을 멘션하거나 배정한 쓰기 뒤와 `query_rows` 뒤에 붙는 마지막 `status: …` 줄, 이 연결에 넘긴 항목을 표시하는 `inbox`. 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0151-additions"></a>
## v0.15.1 추가 사항

마이그레이션은 `0047_v0151_index_stamp` 하나입니다. `page_chunk_index.doc_updated_at` 열(timestamptz, NULL)을 더하고, 기존 행은 `page_docs.updated_at`으로 채웁니다. 더하거나 뺀 경로는 없습니다. 이 릴리스는 에이전트 도구를 바깥에서 평가한 결과와 운영 서버에서 올라온 보고를 반영합니다.

<a id="findcontext-docsadr19001909"></a>
### find_context (docs/adr/1900–1909)
- `GET /api/context`: 모양은 그대로이고 `fragments[].fullTokens?: number`만 더해집니다. 텍스트가 잘린 조각(`truncated: true`)에만 있고, 섹션 전체(색인 조각 전부)의 추정 토큰 수입니다.
- 순위(모양은 그대로): 링크 한 줄뿐인 섹션이나 페이지 제목으로만 맞는 섹션은, 같은 페이지의 다른 섹션이 스스로 맞을 때 그 페이지의 자리를 차지하지 않습니다. 링크 대상과 맨 URL은 맞추는 대상이 아닙니다. 예산의 40%를 넘는 조각은 가장 잘 맞는 줄 주변만 남기고 자릅니다(표는 열 이름 줄을 남깁니다). 질의에 있는 영어 복수형/-ed/-ing 형태와 조사가 두 개 붙은 한국어 낱말도 기본형에 맞습니다. 여러 번 준 `q`는 RRF k = 10으로 합칩니다(예전에는 60).
- REST에서는 페이지 id를 전체로 둡니다. MCP 텍스트는 8글자 접두사를 찍습니다(docs/adr/1906-*).

<a id="section-writes-docsadr19601961"></a>
### 섹션 쓰기 (docs/adr/1960–1961)
- `POST /api/pages/:id/section`과 `POST /api/pages/:id/sections`는 무엇이든 쓰기 전에 섹션 참조부터 풉니다. 참조가 여러 섹션에 맞거나, 아직 있는 다른 섹션이 예전에 그 참조로 불린 적이 있으면(변경 로그로 판단하고, 입력이 아직 로그에 남지 않았을 때는 섹션 색인으로 판단) 섹션 하나를 고르는 `baseVersion`이 있어야 합니다. 없으면 409 `SECTION_AMBIGUOUS`(details: `anchors`)이고 아무것도 쓰지 않습니다. 다른 기존 섹션이 예전에 그 앵커를 가졌던 경우에는 정확한 앵커에도 이 규칙이 적용됩니다. `/sections`는 이런 편집을 409 `SECTIONS_CONFLICT` 안에 `reason: 'ambiguous'`로 나열하고, 제안 모드에서도 마찬가지입니다.
- 잡기(claim) 경로는 짧은 앵커나 제목 텍스트가 모호해졌을 때 같은 409로 답합니다(버전을 받지 않으므로 정확한 앵커는 그대로 씁니다). 코멘트 경로는 그대로이고, MCP `add_comment`가 경로를 부르기 전에 섹션을 풉니다.
- REST의 `patch_section`은 `replace`/`delete`에서 `baseVersion`이 없어도 여전히 받습니다(사람이 자기 토큰으로 돌리는 스크립트 때문입니다). MCP 도구는 꼭 요구합니다(docs/adr/1961-*).

<a id="change-feed-docsadr1960-"></a>
### 변경 피드 (docs/adr/1960-*)
- 같은 이름의 제목 위에 제목을 넣으면(`## Decided` 위에 `## Decided`) 앵커가 새 제목으로 넘어갑니다. 이것은 예전 섹션의 이름 바꾸기와 섹션 추가로 기록됩니다. 0.15.1 전에는 `modified decided` + `added decided~2`였고, 이제는 `renamed decided>decided~2` + `added decided`입니다(행으로는 앵커 `decided~2`, `prev_anchor` `decided`인 `kind: 'renamed'` 다음에 앵커 `decided`인 `kind: 'added'`가 오고, `changes_since` 텍스트는 `renamed decided → decided~2`로 읽힙니다). 둘 중 첫 번째를 지우면 `removed decided` + `renamed decided~2>decided`가 됩니다. `GET /api/changes`, catch_up, 활동, 되돌리기는 이 패턴에서 이 종류들을 봅니다. 제목을 새 블록으로 다시 입력한 경우는 `modified`로 남습니다.

<a id="inbox-docsadr1922-"></a>
### inbox (docs/adr/1922-*)
- `POST /api/inbox/ack`는 `cursor` 옆에 `workspaceId`와 `kinds`를 받습니다. 커서는 같은 필터로 `GET /api/inbox`가 보여 주는 것만 확인 처리하고, 목록의 보이기·범위·접근 규칙도 그대로 따릅니다. 0.15.1 전에는 다른 워크스페이스와 다른 종류의 오래된 항목, 부르는 쪽이 볼 수 없는 항목까지 확인 처리했습니다.
- `inboxAckSchema`(`@inkling/shared`)에 `workspaceId`와 `kinds`가 생깁니다.

<a id="vault-sync-docsadr1920-"></a>
### 볼트 동기화 (docs/adr/1920-*)
- `revision`은 `<state vector hash>-<delete set hash>.<metadata hash>`입니다(클라이언트는 속을 들여다보지 않는 값입니다). 그래서 지우기만 해도 바뀝니다. `-`가 없는 토큰은 예전 서버에서 온 것입니다. 그 토큰으로 `PUT`하면 지금 버전과 함께 412를 받고(CLI가 합칩니다), `DELETE`는 그 뒤로 삽입이나 서식 변경이 없었으면 성공합니다.
- `PUT /api/pages/:id/sync/md`는 Markdown을 문서의 최소 편집으로 적용합니다(`update_page`의 replace 경로). 노트에서 바뀌지 않은 블록은 id와 Markdown이 아닌 속성을 유지하고, 쓰기 직후 서버에 닿은 입력은 그 블록에 합쳐집니다. 최소 편집이 검증을 통과하지 못하면 예전처럼 문서 전체를 다시 씁니다(로그 `[vault-sync] minimal replace not applied`).

<a id="other-behaviour"></a>
### 그 밖의 동작
- `POST /api/pages/:id/duplicate`는 복사하기 전에 하위 트리의 열린 문서를 저장(하고 색인)합니다. 그래서 복사본에 마지막 몇 초 동안의 입력도 들어갑니다(docs/adr/1923-*).
- 소유권 이전도 다른 역할 변경처럼 워크스페이스 접근 버전을 올립니다. 그래서 캐시된 권한이 새로 고쳐집니다(docs/adr/1923-*).
- `GET /api/catch-up?since=<time>`은 행 한 묶음이 `seq`에서 10의 거듭제곱을 걸쳐 있을 때도 그 시각과 같거나 뒤인 첫 변경 로그 행에서 시작합니다(예전에는 seq를 텍스트로 정렬해서 몇 행 늦게 시작할 수 있었습니다).

<a id="mcp-tools-4"></a>
### MCP 도구
새 인수: `read_page(…, backlinks?)`, `create_page(…, kind?)`(`doc`, `canvas`, `folder`), `replace`용 `update_page(…, baseVersion?)`. 페이지 id로 워크스페이스를 알 수 있거나 연결에 워크스페이스가 하나뿐이면 `list_pages`, `create_page`, `import_folder`, `create_from_template`, `create_collection`, `get_instructions`에서 `workspaceId`를 빼도 됩니다. 모든 id 인수는 8글자(또는 그보다 긴) 접두사를 받습니다. 바뀐 기본값과 출력은 이렇습니다. `list_pages` / `search`의 기본값이 `format: "compact"`입니다. 텍스트 출력은 8글자 id를 찍습니다. 개요 줄은 수준마다 들여 쓴 `- §<anchor> ~N tok v=…`이고 개요 버전이 붙습니다. 소유자 상태, verified/stale, 잡아 둔 섹션은 페이지 텍스트 뒤에 나옵니다. `find_context`는 모든 결과의 `can:`이 같으면 한 번만 찍고, 잘린 조각에는 `; truncated, section ~N tok`을, 마지막에는 `Verification:` 줄을 붙입니다. 필터를 건 목록의 `inbox` 커서에는 그 필터가 들어갑니다(`<seq>;ws=<id>;kinds=a,b`). 도구 목록에서 id 필드마다 붙던 UUID 패턴과 SDK의 `execution`, `$schema` 기본값을 뺐습니다(docs/adr/1940–1948). 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0160-additions"></a>
## v0.16.0 추가 사항

마이그레이션은 세 개이고 모두 추가만 합니다. `0048_wave16_taint`(테이블 `connection_taints`, 열 `workspaces.agent_taint_demote boolean not null default true`), `0049_wave16_agent_tokens`(`oauth_grants.kind text not null default 'oauth'`, `oauth_grants.token_prefix`), `0050_wave16_agent_uploads`(`workspaces.agent_uploads`, `files.uploaded_via`, `files`의 부분 색인)입니다. 이 릴리스는 MCP와 AI 에이전트와의 작업을 다룹니다.

<a id="mcp-endpoint-docsadr2000--2060--2065-"></a>
### MCP 엔드포인트 (docs/adr/2000-*, 2060-*, 2065-*)
- `POST /mcp?profile=core|full`: 프로필이 없으면 full입니다. 다른 값이거나 파라미터가 두 번 오면 HTTP 400 `{"jsonrpc":"2.0","error":{"code":-32602,"message":"Unknown profile: use /mcp?profile=core or /mcp?profile=full (no profile = full)."},"id":null}`로 답합니다. OAuth `resource` 지시자는 `<origin>/mcp?profile=core|full`이어도 됩니다(`/mcp`로 취급합니다).
- `/mcp`는 OAuth 액세스 토큰뿐 아니라 `Authorization: Bearer ink_agt_…`(에이전트 연결 토큰)도 받습니다. 둘 다 에이전트 연결입니다. `ink_pat_`(개인 API 토큰)은 그대로 401입니다. 차단된 IP에서 온 `ink_agt_` 토큰은 조회하기 전에 `Retry-After`와 함께 429 `{ error: { code: 'RATE_LIMITED' } }`를 받고, 모르는 토큰은 IP 차단 횟수에 들어갑니다. 에이전트 연결 토큰으로 `/api` 경로를 부르면 401입니다.
- 본문 한도는 예전처럼 12 MB입니다. `AGENT_UPLOAD_MAX_MB` 때문에 더 큰 업로드가 가능해지면, 12 MB를 넘는 본문은 `upload_file`의 `tools/call`(직접 또는 `more_tools`를 거쳐)만 받고 base64(`AGENT_UPLOAD_MAX_MB`) + 1 MB까지 받습니다. 그 밖의 큰 본문은 413 `PAYLOAD_TOO_LARGE`입니다.
- 새 기능 `resources`(템플릿 `inkling://page/{id}`, 최대 50개 페이지의 목록)와 `prompts`(`catch-up`, `meeting-notes`, `memory-review`)가 생깁니다(docs/adr/2001-*, 2002-*).

<a id="agent-connection-tokens-docsadr20602063"></a>
### 에이전트 연결 토큰 (docs/adr/2060–2063)
브라우저 세션에서만 됩니다. bearer 토큰은 403(API 토큰) 또는 401(MCP 토큰)을 받습니다.

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/agent-tokens` | – | `{ tokens: AgentTokenDTO[] }`, 새것부터: `{ id, name, prefix ('ink_agt_' + 4), access: 'read'\|'write', range, createdAt, expiresAt, lastUsedAt, suggestOnly: { until, sources } \| null }`. 토큰 값은 절대 담지 않습니다. `id`는 grant id입니다(연결 키 `grant:<id>`) |
| POST | `/api/agent-tokens` | `{ name (1–60), expiresInDays: 7\|30\|90\|365, access: 'read'\|'write', range }` (strict) | `201 { token: AgentTokenDTO, secret: 'ink_agt_…' }`, `Cache-Control: no-store`. 비밀을 돌려주는 것은 이때뿐입니다. 400 `CLIENT_NAME_RESERVED`, `CLIENT_NAME_CLASH`, `VALIDATION`, `INVALID_RANGE`, 409 `TOO_MANY_TOKENS`(계정당 살아 있는 토큰 20개). 호출 제한 20/min. 범위 안의 워크스페이스마다 감사 로그에 `agent.token_created`를 남깁니다 |
| DELETE | `/api/agent-tokens/:id` | – | 204. 부르는 사람의 에이전트 토큰이 아니면 404. 바로 폐기하고, 넘겨받았던 일을 되돌려 놓고, 감사 로그에 `agent.token_revoked`를 남깁니다 |
| PATCH | `/api/oauth/grants/:id` | `{ range }` | (바뀜) 에이전트 토큰의 범위도 바꿉니다. 예전 범위나 새 범위가 닿는 모든 워크스페이스의 감사 로그에 `agent.token_range_changed`를 남깁니다 |
| DELETE | `/api/oauth/grants/:id` | – | (바뀜) 에이전트 토큰도 폐기하며, 효과는 같습니다 |
| GET | `/api/oauth/grants` | – | (바뀜) OAuth로 만든 연결(`kind = 'oauth'`)만 나옵니다. 에이전트 토큰은 `/api/agent-tokens`에 있습니다 |

감사 동작은 `agent.token_created`(대상 `connection` `grant:<id>`, 라벨 = 이름, `after: { access, range, expiresAt }`), `agent.token_revoked`, `agent.token_range_changed`(`before.range`, `after.range`: 범위 종류)입니다. 토큰 값은 절대 남기지 않습니다.

<a id="suggest-only-connections-docsadr20402043"></a>
### 제안만 하는 연결 (docs/adr/2040–2043)
- 의심 표시가 붙은 콘텐츠를 건네받은 bearer 연결(OAuth, 에이전트 토큰, API 토큰)은 그런 읽기가 마지막으로 있은 뒤 60분 동안 제안만 할 수 있습니다. `agentTaintDemote`가 켜진(기본값) 모든 워크스페이스에서 그렇습니다. 콘텐츠를 "건네는" 것은 MCP 읽기 도구와 리소스이고, API 토큰이라면 `GET /pages/:id/section`(돌려준 섹션만), `GET /pages/read`, `GET /context`(돌려준 섹션만), `GET /pages/:id/export`도 해당합니다.
- 제안만 하는 동안에는 `POST /pages/:id/section`, `/sections`, `/content`가 `origin: 'taint'`와 `reviewReason`이 붙은 `202 { suggestion }`으로 답합니다. 코멘트, 스레드(팔로우/읽음), 잡기, `POST /suggestions/:id/withdraw`, `POST /inbox/ack`, 나중에 보기(Later), `POST /notifications/read`는 됩니다(`mentionConnections`가 있는 코멘트는 같은 코드로 거부됩니다. 제안만 하는 동안에는 넘기기가 없습니다). 그 밖의 모든 쓰기는 `403 { error: { code: 'CONNECTION_SUGGEST_ONLY', message, suggestOnlyUntil } }`로 답합니다.
- `PUT /api/workspaces/:id/settings/agent-taint` `{ enabled }`: 소유자/관리자, 브라우저만 → `{ settings, role, can }`. `WorkspaceSettingsDTO.agentTaintDemote`가 더해집니다.
- `POST /api/workspaces/:id/agent-connections/release` `{ connection: 'grant:<id>' | 'token:<id>' }`: 워크스페이스 소유자/관리자 또는 연결의 주인, 브라우저만. 이 워크스페이스에서 그 연결에 걸린 출처를 풉니다 → `{ released: n, suggestOnly: SuggestOnlyDTO | null }`. 다른 멤버는 403, 모르는 연결은 404입니다.
- `POST /api/connections/release` `{ connection }`: 연결의 주인, 브라우저만. 모든 출처를 풉니다 → `{ released: n, suggestOnly: null }`. 부르는 사람의 연결이 아니면 404입니다.
- `GET /api/connections/suggest-only`: 브라우저만. 부르는 사람 자신의 연결 가운데 지금 제안만 하는 것들을 `{ connections: [{ key, until, sources }] }`로 돌려줍니다.
- 추가 필드: `GET /oauth/grants`, `GET /agent-tokens`, `GET /tokens` 항목에 `suggestOnly: { until, sources } | null`, `GET /workspaces/:id/agent-connections` 항목에 `suggestOnly: { until, sources, sourcesHere } | null`(워크스페이스에서 스위치가 꺼져 있으면 null), `GET /workspaces/:id/team-agents`에 `suggestOnly: { [connectionKey]: { until, sources, sourcesHere } }`가 붙습니다. `SuggestionDTO.origin`에 `'taint'`가 더해집니다.
- 감사 동작 `agent.tainted`(대상 `connection`, `after: { source, rules, until }`, 텍스트는 절대 남기지 않음)와 `agent.taint_released`(`before: { sources }`, `after: { scope: 'workspace' | 'all' }`).

<a id="files-and-uploads-by-agents-docsadr20442046-2065"></a>
### 에이전트의 파일과 업로드 (docs/adr/2044–2046, 2065)
- bearer 토큰(MCP, 에이전트 토큰, API 토큰)으로 부르는 `POST /api/files`: `pageId`가 꼭 있어야 합니다(없으면 400). 연결이 그 페이지를 편집하거나 제안할 수 있어야 합니다(아니면 `PAGE_LOCKED` / `PAGE_ACCESS`). 크기는 `AGENT_UPLOAD_MAX_MB`까지입니다(기본값 5 MB, 넘으면 한도를 밝힌 413 `PAYLOAD_TOO_LARGE`). 형식은 파일 이름으로 정하고 실제 바이트와 맞아야 합니다(png, jpg/jpeg, gif, webp, pdf는 매직 넘버로, txt, log, tsv, csv, md, markdown, json은 NUL 없는 UTF-8인지로 확인). 맞지 않으면 이유와 함께 415 `UNSUPPORTED_TYPE`입니다. 계정의 연결들이 24시간 안에 `AGENT_UPLOAD_DAILY_MB`(기본값 200 MB)만큼 올리면 429 `UPLOAD_BUDGET`입니다(브라우저 업로드는 세지 않고, 0이면 일일 한도가 없습니다). 서버나 워크스페이스가 에이전트 업로드를 끄면 403 `AGENT_UPLOADS_OFF`, 제안만 하는 동안에는 403 `CONNECTION_SUGGEST_ONLY`입니다. 파일 행에 `uploaded_via`가 기록됩니다.
- 브라우저 업로드: `text/csv`, `text/markdown`, `application/json`을 받게 된 것 말고는 그대로입니다(25 MB, 일일 한도 없음).
- `PUT /api/workspaces/:id/settings/agent-uploads` `{ value: 'default' | 'on' | 'off' }`: 소유자/관리자, 브라우저만 → `{ settings, role, can }`. `AGENT_UPLOADS=never`일 때 `on`을 보내면 409 `AGENT_UPLOADS_NEVER`입니다. 감사 로그에는 `settings.updated`(`before/after: { agentUploads }`)로 남습니다. `WorkspaceSettingsDTO`에 `agentUploads: 'on' | 'off' | null`과 `agentUploadsServer: 'on' | 'off' | 'never'`가 더해집니다.
- `GET /api/admin/status`: 새 항목 `security.agentUploads`가 생기고, `data: { mode, maxMb, dailyMb (null = no budget), mcpBodyMb, warnings }`를 담습니다.

<a id="memory-check-and-instruction-length-docsadr2003--2004-"></a>
### 기억 점검과 지침 길이 (docs/adr/2003-*, 2004-*)

| 메서드 | 경로 | 누가 | 응답 |
|---|---|---|---|
| GET | `/api/workspaces/:id/notes-check?parentId=&limit=1..50` | 멤버(토큰도) | `NotesCheckDTO { workspaceId, rootId, checked, broken { total, pages, items[{ pageId, title, count, links[{ text, state: missing\|exists\|trashed, targetId?, trashedOn? }] }] }, duplicates { total, items[{ title, pageIds }] }, unlinked { total, items[{ pageId, title, updatedOn }] }, verification { total, items[{ pageId, title, state: lapsed\|changed, until, changedSections }] }, quietLarge { total, minTokens, before, items[{ pageId, title, tokens, updatedOn }] } }`. 볼 수 있는 페이지만 봅니다. `parentId`가 보이지 않으면 404 |
| GET | `/api/workspaces/:id/agent-instructions/length` | 멤버 | `{ limits: { lines: 200, bytes: 25000 }, always: { lines, bytes, tokens, long, pages }, pages: [{ pageId, mode, lines, bytes, tokens, long, truncated }] }`. get_instructions가 보내는 Markdown으로 잽니다(12,000자에서 자르고 `truncated` 표시). 크기만 돌려줍니다 |

<a id="mcp-tools-5"></a>
### MCP 도구
새 도구: `upload_file(pageId, name, text | base64, section?, attachOnly?)`, `check_notes(workspaceId?, parentId?, limit?, budget?)`, `more_tools(tool?, arguments?)`(core 프로필에만). `read_file`은 PDF에 `pages`(`"2-5"`)를 받고, 확장자로 판단해 더 많은 텍스트 파일을 읽습니다. 돌려주는 텍스트는 인젝션처럼 보이는 내용이 있는지 검사합니다. `get_instructions`는 지침이 200줄이나 25 KB를 넘으면 `note:` 줄로 끝납니다. 연결이 제안만 하는 동안에는 `can:` 줄에 `suggest`라고 나옵니다. 도구 목록: full 47개(~12,370 tokens), core 32개(~7,437). 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0170-additions"></a>
## v0.17.0 추가 사항

마이그레이션은 0051(`pages.row_number`, `edited_by`, `edited_via`, `collections.row_seq`, ID 트리거), 0052(`page_links.sections`), 0053(`page_snapshots.digest`, `step`)이고 모두 추가만 합니다. 따로 적지 않았으면 기존 응답의 모양은 그대로이고, 새 필드는 덧붙기만 합니다.

<a id="section-links-docsadr21002103"></a>
### 섹션 링크 (docs/adr/2100–2103)
- 내부 링크는 href가 `/w/<workspaceId>/p/<pageId>`인 BlockNote `link` 인라인입니다. 섹션 링크는 여기에 프래그먼트 `#h=<heading>&b=<heading block id>&p=<page title>`를 붙입니다(URL 인코딩, `b`와 `p`는 선택이고 이 순서를 지킵니다). Markdown으로는 `[[Page#Heading]]`, `[[Page#Heading|shown]]`입니다. 가져오기와 MCP 쓰기는 `Page`가 보이고 `Page#Heading`이라는 제목의 페이지나 분할 하위 페이지가 없을 때 `[[Page#Heading]]`을 섹션 링크로 바꿉니다. 코드 블록 안의 `[[…]]`는 코드로 남습니다.

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/pages/:id/backlinks` | (바뀜) 원본 페이지에 섹션 링크가 있을 때만 `sections`를 더합니다: `{ <sourcePageId>: [{ heading, status }] }`. `status`는 `found` \| `renamed`(그 제목의 지금 이름이 `heading`) \| `missing`입니다 ([ADR 2101](adr/2101-section-refs-in-page-links.md)) |
| GET | `/api/pages/:id/headings` | `{ headings: [{ blockId, text, level, anchor }] }`: 페이지의 섹션 제목(최상위 제목, ADR 0926)이고, `[[Page#` 메뉴에 씁니다. 문서만 해당합니다(그 밖에는 `[]`). 멤버 자격은 `/pages/:id/outline`과 같고, 게스트는 403입니다 ([ADR 2100](adr/2100-section-links-are-page-links-with-a-heading-fragment.md)) |
| GET | `/api/pages/:id/section-link?heading=&block=` | 섹션 링크가 지금 어느 제목을 가리키는지 알려 줍니다: `{ status: 'found' \| 'renamed' \| 'missing', heading, blockId, anchor }`. 블록 id, 그다음 이름, 그다음 변경 로그의 이름 바꾸기 흔적 순서로 찾습니다. `heading`은 1–500자, `block`은 선택인 블록 id입니다. 읽기 전용이고, 에이전트 읽기로 기록하지 않습니다 ([ADR 2102](adr/2102-following-section-links-through-renames.md)) |

- `NotesCheckDTO`: `broken.items[].links[].state`에 `'noHeading'`이 더해집니다(`targetId` = 그 페이지, `text` = `Title#Heading`).

<a id="database-views-public-pages-and-the-markdown-download-docsadr21202123-2190"></a>
### 데이터베이스 뷰, 공개 페이지, Markdown 내려받기 (docs/adr/2120–2123, 2190)
- 블록 props: `pageEmbed`에 `viewId`(string, 기본값 `''`)가 생깁니다. `pageId`가 컬렉션이면 그 블록은 인라인 데이터베이스 뷰이고, `''`는 컬렉션의 첫 뷰입니다.
- `GET /api/pages/:id/export?format=md&notation=file`: 내려받기용 형식입니다. 차트는 `<!-- inkling:chart {…} -->` 줄, 데이터베이스 뷰는 `<!-- inkling:pageEmbed {"pageId":"…","viewId":"…"} -->` 줄이 되고, 각각 뒤에 `<!-- inkling:snapshot -->`, 내보내는 멤버 기준의 숫자 표(최대 1000행), `<!-- /inkling:snapshot -->`가 붙습니다. ```dataview 펜스 뒤에는 그 결과의 스냅샷이 붙습니다. 페이지 임베드는 `[[Title]]`, 링크 임베드는 링크가 됩니다. zip 내보내기는 이 형식이 기본입니다(`notation=plain`이면 0.16의 출력). 가져올 때(`POST /api/workspaces/:id/import`, zip과 폴더 가져오기) 블록 줄이나 코드 펜스 바로 뒤의 스냅샷은 버리고 블록을 되살립니다. 다른 곳에서는 표시 줄만 지웁니다.
- 공개 페이지(`GET /api/public/:token`, `/api/public/:token/p/:ref`)는 링크 안에 있는 페이지에서 온 페이지 임베드, 링크 임베드, 데이터베이스 뷰, 쿼리 블록만 그립니다(그 밖에는 "Embedded content that is not part of this link."로 나옵니다). 응답 모양은 그대로입니다. 공개 페이지와 내려받기의 데이터베이스 표는 자동 속성을 채우고(ID는 `TASK-12` 꼴, 시각은 ISO UTC, 멤버 이름, 멤버가 아니면 `-`, `Name (via Client)`는 멤버의 내려받기에서만), 표 뷰와 목록 뷰에서 하위 항목을 부모 아래에 `↳`로 놓습니다. 공개 페이지에서는 최대 200행입니다.
- MCP `read_page`는 데이터베이스 뷰 아래에 `view-info` 줄을 더합니다([MCP.ko.md](MCP.ko.md)).

<a id="collections-docsadr21402147-2192"></a>
### 데이터베이스(컬렉션) (docs/adr/2140–2147, 2192)
- 속성 타입 `email`, `phone`, `createdTime`, `editedTime`, `createdBy`, `editedBy`, `uniqueId`(`{ uniqueId: { prefix } }`)가 생깁니다. `relation.subItems: true`는 컬렉션이 자기 자신을 가리키는 상위 항목(Parent item) 관계임을 표시합니다. ID와 상위 항목은 컬렉션마다 하나씩만 둘 수 있습니다(400). `PUT /pages/:id/collection/fields`가 이것들을 검증합니다.
- `GET /pages/:id/collection`(과 다른 행 응답): 행의 `props`에 자동 값이 들어갑니다(`createdTime` / `editedTime`은 ISO UTC 문자열, `createdBy` / `editedBy`는 사용자 id이고 에이전트가 바꿨을 때는 `via:<fieldId>`에 클라이언트 이름이 들어가며, `uniqueId`는 숫자). 페이지 게스트도 부를 수 있고(공유받은 트리 밖은 404), 게스트의 응답에는 `people: { [userId]: name }`이 더해집니다.
- 페이지 게스트에게 열린 경로(쓰기는 편집 권한이 있어야 함): `GET /pages/:id/collection/row-options`, `GET …/covers`, `GET …/row-templates`, `POST …/collection/rows`, `PATCH /pages/:id/props`. 게스트가 person 값을 넣으면 403 `GUEST_PERSON`입니다. 속성, 뷰, 일괄 붙여넣기와 가져오기, 차트, 멤버 목록은 그대로 멤버만 씁니다.
- `PATCH /pages/:id/props`: 자동 값과 `via:` 키는 무시합니다. 상위 항목에는 id 하나만 남습니다. 순환이 생기면 400 `SUBITEM_CYCLE`입니다.
- `GET /pages/:id/collection/query`: `under`(행 id, `TASK-3` 같은 ID, 또는 정확한 제목)와 `depth`(1–8, 기본값 1)가 생깁니다. 필드 요약에 `prefix`(uniqueId)와 `subItems: true`가 붙습니다. 자동 값은 필터나 정렬이 가리키는 필드만 SQL로 계산하고, 돌려주는 행의 자동 값은 그 행들을 한 번 더 읽어서 채웁니다([ADR 2192](adr/2192-query-rows-computes-automatic-values-only-when-read.md)). 응답 모양은 그대로입니다.
- 뷰 설정: 예전의 평평한 `filters` 옆에 `filter`가 생깁니다(트리 `{ mode: 'and' | 'or', items: (condition | group)[] }`, 조건은 `{ fieldId, op, value?, not? }`, 그룹은 `{ mode, not?, items: condition[] }`이고, 그룹은 한 단계까지, 단계마다 항목 10개까지). 단순한 AND 필터는 여전히 `filters`로 저장합니다. `subItems: 'nested' | 'flat'`. 뷰 타입 `list`.
- 기본 제공 템플릿 키 `agentBoard`.

<a id="first-admin-setup-and-the-local-trial-docsadr21602161"></a>
### 첫 관리자 설정과 로컬 체험 (docs/adr/2160–2161)
- `GET /api/auth/mode`: `setupPending: boolean`이 더해집니다(계정이 아직 없고 설정 링크가 출력된 상태).
- `POST /api/auth/register`: 본문에 `setupCode?: string`이 더해집니다. 이것이 있으면 `signupKey`가 필요 없고, 서버에 계정이 하나도 없을 때만 그 계정이 관리자로 만들어집니다. 403 `INVALID_SETUP_CODE`(로그에 나온 코드가 아님. IP 차단 횟수에 들어감), 403 `SETUP_CLOSED`(계정이 이미 있거나 열린 코드가 없음). 설정으로 만든 계정에는 `REQUIRE_EMAIL_VERIFICATION`이 적용되지 않습니다.
- 웹 경로 `/setup?code=…`: 설정 모드의 가입 화면입니다.

<a id="imports-by-connections-and-zip-safety-docsadr21622163"></a>
### 연결의 가져오기와 zip 안전 (docs/adr/2162–2163)
- bearer 토큰과 zip으로 부르는 `POST /api/workspaces/:id/import`: 파일은 `min(IMPORT_MAX_UPLOAD_MB, AGENT_UPLOAD_MAX_MB)`까지입니다(넘으면 413 `PAYLOAD_TOO_LARGE`). `assets/` 첨부가 있으면 무엇이든 만들기 전에 403 `AGENT_UPLOADS_OFF` / 429 `UPLOAD_BUDGET`를 검사합니다. 첨부는 `POST /api/files`처럼 형식을 확인하고 파일마다 크기를 제한하며, 거부한 것은 `skippedAttachments: [{ name, reason }]`로 나열합니다(bearer `import-folder`에서도 마찬가지). Notion 내보내기는 `?source=markdown`이 아니면 415 `NOTION_IMPORT_IN_APP`입니다. 이렇게 저장한 첨부에는 `uploaded_via`가 기록되고 일일 한도에 들어갑니다. 브라우저 가져오기는 그대로입니다.
- 모든 zip 가져오기: `..` 항목이 있는 압축 파일("Unsafe path in the archive"), 심볼릭 링크, 풀린 크기가 1 MB를 넘어서면서 압축된 크기의 200배를 넘는 항목(`ZIP_RATIO`)은 400입니다. 이름은 NFC로 맞추고, UTF-8이 아닌 이름은 CP949로 읽습니다.

<a id="versions-ai-steps-docsadr21802182"></a>
### 버전: AI 단계 (docs/adr/2180–2182)
- `GET /api/pages/:id/snapshots`: AI 단계 행에 `step: { n, tool, mode?, sections, more?, added?, removed?, restoredFrom? }`(`SnapshotStepDTO`)이 더해집니다. `n`은 한 클라이언트의 연속된 단계 행을 1부터 셉니다. `sections`는 최대 3개의 앵커이고(`more`는 나머지 개수, 비어 있으면 본문 전체), `added` / `removed`는 Markdown 줄입니다.
- `POST /api/pages/:id/snapshots/:sid/restore` → `{ ok: true, before: string | null, step: string | null }`. 사람이 복원하면 먼저 "Before restore" 스냅샷을 저장합니다(`before`). 에이전트의 복원(클라이언트가 있는 bearer 요청)은 AI 단계입니다. `before`는 가장 새 버전이 페이지와 같으면(에이전트의 이전 단계) 그 버전이고, 아니면 새 "Before restore" 스냅샷입니다. `step`은 복원된 페이지의 단계 행입니다.
- 클라이언트마다 페이지당 가장 새 단계 행 20개를 남기고, 한 페이지에는 최대 30개입니다. 버전 50개 한도는 그대로이고, 단계 행부터 정리합니다. 자동 저장은 저장할 때가 되었는지 판단할 때 단계 행을 무시합니다.

<a id="agent-search-docsadr21832184"></a>
### 에이전트 검색 (docs/adr/2183–2184)

| 메서드 | 경로 | 쿼리 | 응답 |
|---|---|---|---|
| GET | `/api/search` | `q`(1–200자), `workspaceId?`(없으면 내가 속한 살아 있는 워크스페이스 가운데 이 에이전트를 막지 않고 연결 범위 안에 있는 모든 곳), `limit?`(1–50, 기본값 10) | `{ results: [{id, workspaceId, title, kind, scope, updatedAt, match: 'title'\|'heading'\|'body', exact, anchor?, shortAnchor?, headingPath?, snippet?}], total, workspaces: [{id, name, matches}], limit }`. 맞는 항목은 `/api/workspaces/:id/search`와 같습니다(페이지 제목이나 본문 텍스트에 `q`가 들어 있음, 대소문자 무시, 휴지통에 없고 볼 수 있는 페이지). 순서: 페이지 제목이 `q`와 같음 → 페이지 제목에 `q`가 온전한 낱말로 있음 → 페이지 제목에 들어 있음 → 섹션 제목에 온전한 낱말로 있음 → 섹션 제목에 들어 있음 → 본문에 온전한 낱말로 있음 → 본문에 들어 있음, 그다음 `updatedAt` 내림차순, 그다음 id. 온전한 낱말이란 바로 앞이나 뒤에 글자, 숫자(ASCII, 라틴, 그리스, 키릴, 한글, 가나, CJK), `_`가 없는 것입니다. 한글 음절로 끝나는 질의 뒤에는 어울리는 조사가 와도 됩니다(+ 는/은/도/만). `snippet`은 본문에서 맞았을 때만 있습니다. `total`과 `workspaces[].matches`는 보여 주었든 아니든 맞은 것을 모두 셉니다. 읽기 전용 토큰도 됩니다. `workspaceId`가 있으면 워크스페이스 검색 경로의 오류(403/404, `OUT_OF_RANGE`, `AGENT_BLOCKED`, `TWO_FACTOR_REQUIRED`)가 그대로 납니다 |

웹 앱의 `GET /api/workspaces/:id/search`는 그대로입니다.

<a id="vault-sync-experimental-vault-sync-docsadr21662169"></a>
### 볼트 동기화 (실험 기능 `vault-sync`, docs/adr/2166–2169)
- `POST /api/workspaces/:id/sync/pages`: `clientKey?: uuid`. 페이지 id를 워크스페이스와 키에서 만들어 내므로, 같은 키로 다시 시도하면(같은 워크스페이스, 같은 작성자, 살아 있는 페이지) 같은 페이지를 `replayed: true`와 함께 돌려줍니다.
- `PUT /api/pages/:id/sync/md`: revision이 낡았어도 페이지가 이미 노트와 같으면 쓰지 않고 200으로 답합니다. `droppedFrontmatterKeys`에 예약된 키와 한도를 넘은 키가 들어갑니다. Markdown에 블록 토큰(`<!-- inkling:pageEmbed … -->` 같은 것)이 들어갑니다. revision의 메타 절반에 형식 표시 `md2`가 들어갑니다.
- `DELETE /api/pages/:id/sync`: 0.17 이전의 메타 절반도 받습니다. 변경 피드에는 `page_trashed`로 기록됩니다.

<a id="mcp-tools-6"></a>
### MCP 도구
새 도구: `import_zip(base64, workspaceId?, parentId?, source?)`(숨은 그룹 `files`). 새 인수: `search(…, limit?)`, `list_versions(…, all?)`, `query_rows(…, under?, depth?)`, `create_row(…, parent?)`. `create_collection`과 `update_fields`는 새 필드 타입, `prefix`, `subItems`를 받습니다. `workspaceId` 인수에 워크스페이스 이름을 줄 수 있습니다(inbox는 빼고). `search` 출력과 여러 워크스페이스에 걸친 `find_context`가 바뀌었습니다(docs/adr/2184-*, 2185-*). 도구 목록: full 48개(~12,777 tokens), core 32개(~7,533). 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0180-additions"></a>
## v0.18.0 추가 사항

마이그레이션은 0054(`push_subscriptions`, `push_vapid_keys`, `push_settings`), 0055(`collection_automations`, `automation_runs`), 0056(`pages.doc_gen`), 0057(`workspace_list_groups`, `workspace_listings`), 0058(행 번호 트리거 함수의 새 본문)이고 모두 추가만 합니다. 따로 적지 않았으면 기존 응답의 모양은 그대로이고, 새 필드는 덧붙기만 합니다. "브라우저 세션만"은 쿠키 세션을 뜻합니다. bearer 토큰(API 토큰, MCP 토큰, 에이전트 연결 토큰)은 403을 받습니다.

<a id="offline-copies-docsadr22002204"></a>
### 오프라인 사본 (docs/adr/2200–2204)

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/pages/:id/sync-check` | `{ gen: number, canEdit: boolean, trashed: boolean, sv: string, needs?: number }`(`needs`와 `?schema=`는 0.20부터, "v0.20.0 추가 사항" 참고). 브라우저가 기기 사본을 동기화하기 전에 부릅니다. `gen`은 페이지의 문서 세대이고, `canEdit`는 부르는 사람이 지금 본문을 편집할 수 있는지입니다(잠금, 사람 행, 게스트 권한을 따지고, 휴지통에 있으면 false). `trashed`는 페이지가 휴지통에 있는지입니다(부르는 사람이 볼 수 있었던 페이지가 휴지통에 있으면 404 대신 200으로 답합니다). `sv`는 살아 있는 문서(또는 `page_docs`)의 base64 Yjs 상태 벡터입니다. 브라우저 세션만 됩니다(토큰은 403). 협업 소켓과 마찬가지로 멤버와 게스트가 부를 수 있습니다. 페이지가 보이지 않거나 문서가 아니면 404, 워크스페이스의 멤버나 게스트가 아니면 403, 또는 `TWO_FACTOR_REQUIRED`. `Cache-Control: no-store` |

- 협업 소켓: 인증 직후 서버가 페이지 채널로 상태 없는(stateless) 메시지 `{"t":"gen","gen":<n>}`를 보내고, 세대가 바뀌면 열려 있는 모든 클라이언트에 다시 보냅니다. 클라이언트는 모르는 `t`를 무시합니다.
- 세대는 버전 복원, AI 편집 되돌리기, 분할, 본문 전체 다시 쓰기에서 올라갑니다([ADR 2201](adr/2201-document-generation-and-the-sync-gate.md)).

<a id="web-push-docsadr22202223"></a>
### 웹 푸시 (docs/adr/2220–2223)

브라우저 세션만 됩니다.

| 메서드 | 경로 | 본문 / 응답 |
|---|---|---|
| GET | `/api/push/key` | `{ available, publicKey }`: VAPID 공개 키(base64url, 65바이트 점), 또는 `available: false`(`WEB_PUSH=off`이거나 키에 문제가 있을 때) |
| GET | `/api/push/settings` | `PushSettingsDTO` `{ available, enabled, kinds[], hideContent, devices[] }`. 기기 하나는 `{ id, label, createdAt, lastSuccessAt, lastFailureAt, failureCount, current, stale }`입니다 |
| PATCH | `/api/push/settings` | `{ enabled?, kinds?: ('mention'\|'assigned'\|'reply'\|'comment'\|'approval'\|'reminder'\|'updates')[], hideContent? }` → `PushSettingsDTO`. 기본 종류는 `updates`를 뺀 전부입니다 |
| POST | `/api/push/subscriptions` | `PushSubscription.toJSON()`(`{ endpoint, expirationTime?, keys: { p256dh, auth } }`)과 선택인 `label` → 201 `{ id, device }`. 같은 endpoint를 다시 보내면 같은 행입니다(새로 고치고 이 세션에 묶습니다). 다른 계정이 그 endpoint를 등록하면 그 계정으로 넘어갑니다. 400 `PUSH_SERVICE_NOT_ALLOWED`(endpoint 호스트가 허용된 푸시 서비스가 아님), 400 `PUSH_SUBSCRIPTION_INVALID`(URL이나 키 검사에 걸림), 503 `PUSH_UNAVAILABLE`. 모양이 틀린 본문(keys가 없거나, endpoint가 1,024자를 넘거나, label이 80자를 넘음)은 보통의 검증 오류입니다. 20/min. 사람마다 기기는 최대 20대입니다(넘으면 가장 오래 전달이 없던 기기를 뺍니다) |
| DELETE | `/api/push/subscriptions` | `{ endpoint }` → 204. 이 브라우저의 행이 부르는 사람의 것이면 지웁니다(아니어도 오류는 없음) |
| DELETE | `/api/push/devices/:id` | 204. 부르는 사람의 기기가 아니면 404 |
| POST | `/api/push/test` | `{ deviceId? }` → `{ queued }`. 부르는 사람의 기기가 아니면 404, 쓸 수 없으면 503. 5/min |

- 푸시 페이로드(암호화된 메시지 안의 내용, 서비스 워커를 직접 쓰는 사람용): `{ v: 1, title, body, url, tag, id, ts }`. `url`은 같은 출처의 경로이고, `tag`는 `p:<pageId>`, `n:<id>`, `test` 중 하나입니다.
- 구독은 그것을 등록한 세션에 속하고, 세션과 함께 지워집니다(로그아웃, 비밀번호 변경, 관리자의 폐기, 만료).

<a id="buttons-and-database-automations-docsadr22402245"></a>
### 버튼과 데이터베이스 자동화 (docs/adr/2240–2245)

| 메서드 | 경로 | 본문 / 응답 |
|---|---|---|
| GET | `/api/collections/:id/automations` | `{ automations: AutomationDTO[], canEdit }`. 데이터베이스를 볼 수 있는 멤버(게스트 제외). 토큰도 읽을 수 있고, `canEdit`는 편집 권한이 있는 브라우저 세션에서만 true입니다 |
| POST | `/api/collections/:id/automations` | `{ name (1–80), enabled?, trigger, condition?, actions }` → `{ automation }`. 브라우저 세션만. 데이터베이스 편집 권한이 있어야 합니다(`PUT /pages/:id/collection/fields`와 같음). 필드, 데이터베이스, 웹훅이 맞지 않으면 400. 데이터베이스마다 규칙 20개까지. 30/min. 저장한 사람이 작성자가 됩니다 |
| PATCH | `/api/collections/:id/automations/:ruleId` | 일부만 담은 본문 → `{ automation }`. `{ enabled: false }`만 보내면 작성자를 그대로 둡니다. 그 밖의 변경은 (켜기도 포함해) 부르는 사람을 작성자로 만들고 규칙을 다시 검사합니다. 켜면 연속 실패 기록을 초기화합니다. 브라우저 세션만 |
| DELETE | `/api/collections/:id/automations/:ruleId` | 204. 브라우저 세션만 |
| GET | `/api/collections/:id/automations/runs?automationId=&limit=` | `{ runs: AutomationRunDTO[] }`, 새것부터, `limit` 1–100(기본값 50): `status` `ok` / `failed` / `skipped`, `failedAction`(0부터 셈), `error`, `actorName`, `depth`, `rowTitle`(행이 없어졌으면 null) |
| GET | `/api/workspaces/:id/webhook-targets` | `{ targets: [{ id, kind, label, enabled }] }`(`label`은 호스트). 멤버 |
| POST | `/api/pages/:id/button-webhook` | `{ blockId, webhookId }` → `{ ok: true }`. 페이지를 볼 수 있는 멤버. 10/min. 저장된 페이지에 그 훅을 쓰는 그 버튼이 없으면 409 `BUTTON_NOT_SAVED`(협업 저장소는 입력하고 몇 초 뒤에 씁니다), 409 `WEBHOOK_OFF`, 워크스페이스의 웹훅 대기열이 가득 차면 429 `RATE_LIMITED` |

- 트리거(trigger): `{ type: 'rowAdded' }` | `{ type: 'fieldChanged', fieldId, to? }` | `{ type: 'dateReached', fieldId, daysBefore: 0..30 }`. 조건(condition): 뷰 필터 트리(그룹과 `not`을 쓰는 `{ mode, items }`).
- 동작(actions, 최대 5개): `setFields { props }`, `assign { fieldId, to: ['me' | 'creator' | userId] }`, `notify { fieldId?, creator?, userIds?, message? }`, `webhook { webhookId, message? }`, `addRow { collectionId, templateId?, title?, props? }`, `assignAgent { fieldId, connection }`. 버튼 블록은 같은 동작에서 `assign`/`assignAgent`/`notify`를 빼고 `open`을 더한 것을 씁니다. 버튼 블록의 props에는 `label`, `color`, `actions`가 들어갑니다.
- 규칙이 한 쓰기에는 `via` = `automation: <rule name>`(80자에서 자름)이 붙습니다.
- 변경 로그: `page_props` 이벤트에 `keys`(바뀐 속성 id, 최대 100개)가 붙습니다. 웹훅은 이벤트 타입 `automation`을 보낼 수 있습니다(구독할 수는 없고, 버튼이나 규칙이 지정한 훅에만 갑니다. 일반 페이로드는 `type: "automation"`, `field`, `message`).
- Markdown: 버튼은 에이전트 읽기, 내려받기, 볼트 동기화에서 `<!-- inkling:button {"actions":[…],"color":"…","label":"…"} -->`이고, 일반 Markdown에서는 `**[label]**`입니다.

<a id="web-clipper-docsadr22602263"></a>
### 웹 클리퍼 (docs/adr/2260–2263)

| 메서드 | 경로 | 본문 / 응답 |
|---|---|---|
| POST | `/api/clip` | `{ workspaceId, parentId?, url? (http(s), ≤ 2,048), title? (≤ 300), text? (≤ 20,000), mode?: 'link' \| 'article' (default link), tags?: string[] (≤ 10, each ≤ 40 letters, digits, _, - or /, a leading # allowed) }`. `url`과 `text` 중 하나는 있어야 합니다 → `200 { page: PageMetaDTO, mode: 'link' \| 'article', fallback?: 'fetch_failed' \| 'not_html' \| 'no_content', truncated?: true }` |
| GET | `/api/clip/lookup?workspaceId=&url=` | `{ pages: [{ id, title, workspaceId, createdAt }] }`: 그 워크스페이스에서 부르는 사람에게 보이고 `source` 속성이 이 URL(정규화한 값)인 살아 있는 페이지를 새것부터 최대 5개 돌려줍니다. `workspaceId`는 꼭 있어야 합니다. 멤버와 게스트(게스트는 자기에게 보이는 페이지만). 토큰도 됩니다 |

- `POST /api/clip`은 `POST /pages`처럼 검사합니다. 멤버 자격(게스트는 편집용으로 공유받은 페이지 아래에서만), 연결 범위, 부모의 편집 잠금(`403 PAGE_LOCKED`)을 보고, 제안만 하는 연결(`403 CONNECTION_SUGGEST_ONLY`)과 읽기 전용 토큰은 거부합니다. http(s)가 아닌 URL은 `400 CLIP_INVALID_URL`입니다.
- `mode: 'article'`은 브라우저 세션이 있어야 합니다. bearer 토큰은 모두 `403 CLIP_ARTICLE_SESSION_ONLY`를 받습니다. 기사 가져오기에는 한도가 있습니다(사람마다 분당 10회, 사람마다 동시에 2개, 서버 전체에서 8개). 넘으면 `429 CLIP_RATE_LIMITED`입니다. 경로 한도는 30/min입니다.
- 가져올 수 없거나 기사 본문이 없는 기사는 `fallback`과 함께 링크로 저장합니다. 어느 쪽이든 페이지는 만들어집니다. 본문은 URL의 링크 카드, 인용으로 넣은 텍스트, `#tags`, "Saved … UTC from host" 줄, 그리고 기사 순서입니다(기사는 100,000자에서, 2 MiB 읽기 한도에서, 또는 블록 변환에서 잘릴 수 있고, 어디서든 잘리면 `truncated`가 붙습니다). 페이지 속성 `source`(URL)와 `clipped`(`YYYY-MM-DD HH:MM UTC`)는 만든 사람의 언어에 따라 "Source" / "Clipped"(한국어로는 "출처" / "저장한 날")라는 이름이 붙습니다.
- 웹 경로 `/clip?title=&text=&url=`: 저장 화면입니다. 스스로는 아무것도 저장하지 않습니다.

<a id="workspace-groups-and-archive-docsadr23002305"></a>
### 워크스페이스 묶음과 보관 (docs/adr/2300–2305)

읽기까지 모두 브라우저 세션만 됩니다. 워크스페이스 id는 부르는 사람이 열 수 있는 것이어야 합니다(살아 있는 워크스페이스의 멤버이거나 게스트). 아니면 404입니다. 다른 사람의 묶음도 404입니다.

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/me/workspace-groups` | – | `{ groups: [{ id, name, collapsed }] }`, 그 사람이 정한 순서대로 |
| POST | `/api/me/workspace-groups` | `{ name }`(1–40자, 앞뒤 공백 제거, 묶음은 최대 50개) | `{ group }` |
| PATCH | `/api/me/workspace-groups/:id` | `{ name?, collapsed? }` | `{ group }` |
| DELETE | `/api/me/workspace-groups/:id` | – | 204. 그 묶음의 워크스페이스는 묶음 없음으로 가고(뒤에 붙음), 보관 상태는 그대로입니다 |
| PUT | `/api/me/workspace-groups/order` | `{ ids }`(≤ 50) | `{ groups }`. 목록에 없는 묶음은 나열한 묶음 뒤에서 순서를 유지합니다 |
| POST | `/api/me/workspace-groups/:id/archive` | `{ archived }` | `{ count }`(묶음 안의 모든 워크스페이스) |
| PATCH | `/api/me/workspaces/:id/listing` | `{ archived?, groupId? }`(null = 묶음 없음, 옮기면 뒤에 붙음) | `{ listing }` |
| PUT | `/api/me/workspace-order` | `{ groupId, ids }`(≤ 500) | 204. 나열한 워크스페이스가 이 위치에서 그 묶음에 들어갑니다 |

- `GET /api/workspaces`: 부르는 사람이 정리한 워크스페이스마다 `listing?: { archived?: true, groupId?, group?, position? }`이 붙습니다. 목록 순서는 그대로입니다.
- `workspaceId` 없이 부른 `GET /api/search`와 `GET /api/context`는 부르는 사람의 보관된 워크스페이스를 뺐을 때 `archived: [{ id, name }]`를 더합니다. 일부 워크스페이스로 제한된 연결은 자기 범위를 검색하고, 보관은 적용되지 않습니다.

<a id="oauth-client-id-metadata-documents-oauthcimd1-docsadr22802282"></a>
### OAuth: Client ID Metadata Documents (`OAUTH_CIMD=1`, docs/adr/2280–2282)

- `GET /.well-known/oauth-authorization-server`: `client_id_metadata_document_supported: true`는 `OAUTH_CIMD=1`일 때만 나옵니다.
- `/oauth/authorize`(연결 확인 화면), `GET /api/oauth/authorize/info`(브라우저 세션), `POST /api/oauth/authorize`: `client_id`가 https URL일 수 있습니다(2,000자까지. 다른 id는 여전히 200자까지). 그런 클라이언트에는 `info`가 `metadataDocument: { host, loopbackRedirect }`를 더합니다. 오류는 `400 INVALID_CLIENT`(꺼져 있음, 이때는 모르는 id와 같은 메시지. URL을 받을 수 없음. 허용되지 않은 호스트. 문서를 거부함, 이유와 함께), `400 INVALID_REDIRECT`(`redirect_uri`가 문서의 `redirect_uris`에 없음. 루프백 http는 아무 포트나 써도 됨), `400 CLIENT_NAME_RESERVED`(문서의 `client_name`), `503 CLIENT_METADATA_UNAVAILABLE`(지금은 문서를 가져올 수 없음. `Retry-After: 60`)입니다. 어느 것도 클라이언트로 리디렉션하지 않습니다.
- 메타데이터 문서 클라이언트에 대한 모든 인가 응답(코드든 오류든, 거부 포함)에는 `iss=<issuer>`가 붙습니다(RFC 9207). 등록된 클라이언트에 대한 응답은 바뀌지 않습니다.
- `POST /oauth/token`: URL 클라이언트의 `authorization_code`는 CIMD가 꺼져 있거나 호스트가 더는 허용되지 않으면 `400 invalid_client`로 답합니다. 코드 교환 때는 문서를 가져오지 않습니다. URL 클라이언트의 `refresh_token`은 문서를 다시 읽습니다(캐시 사용). 꺼져 있거나, 허용되지 않거나, 문서가 거부되면 `400 invalid_client`입니다. 문서가 이제 다른 `client_id`를 밝히면 grant를 폐기합니다. 가져올 수 없고 쓸 만한 캐시 사본도 없으면 `503 temporarily_unavailable`입니다(유효했던 사본은 호스트가 실패하는 동안 최대 7일까지 씁니다).
- `GET /api/oauth/grants`: URL 클라이언트의 grant에 `clientHost`가 더해집니다.
- 예약된 클라이언트 이름: 접었을 때 "automation"으로 시작하는 낱말이 되거나 "public form"이 되는 이름은 등록할 때, 동의할 때(메타데이터 문서에서 온 이름도), 에이전트 연결 토큰을 만들 때 `CLIENT_NAME_RESERVED`입니다.

<a id="mcp-tools-7"></a>
### MCP 도구
새 도구도 설명 변경도 없습니다. full 48개(~12,777 tokens), core 32개(~7,533), 서버 지침 ~492입니다. `workspaceId` 없이 부른 find_context, search, catch_up은 부르는 사람의 보관된 워크스페이스를 빼고, 마지막 줄에서 그렇다고 알립니다. `list_workspaces`는 `group`과 `archived`를 더합니다. `query_rows describe=true`는 켜진 자동화를 나열합니다. 버튼은 `<!-- inkling:button … -->`로 읽힙니다. 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0190-additions"></a>
## v0.19.0 추가 사항

마이그레이션은 0059(`pages.share_allow_download boolean not null default false`) 하나이고 추가만 합니다. 기존 응답의 모양은 그대로이고, 새 필드는 덧붙기만 합니다.

<a id="public-page-downloads-docsadr23602363"></a>
### 공개 페이지 내려받기 (docs/adr/2360–2363)

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/public/:token/export.md` | 단일 페이지 링크의 페이지를 Markdown으로 줍니다. 링크가 내려받기를 허용할 때(`allowDownload`)만 됩니다. 관문은 `/api/public/:token`과 같습니다. 모르는 토큰은 404(추측으로 셈), 만료는 410, 예약한 시작 전에는 404, 비밀번호가 걸려 있으면 풀기 전까지 401입니다. 그다음 폴더 토큰이나 캔버스면 404, 내려받기가 꺼져 있으면 404입니다. `200 text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename*=UTF-8''<title>.md`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`. 내용은 공개 페이지의 블록(id, 토큰, frontmatter 없음)이고, 링크와 파일은 `PUBLIC_URL` 기준의 절대 주소로 씁니다. 60/min |
| GET | `/api/public/:token/p/:ref/export.md` | 폴더 링크 안의 페이지(문서나 컬렉션)에 대해 같은 일을 합니다. 폴더 링크의 설정이 적용됩니다. ref가 하위 트리 밖이거나, 개인 페이지이거나, 휴지통에 있으면 404 |

- `PATCH /api/pages/:id/share` 본문에 `allowDownload?: boolean`이 더해집니다(소유자와 관리자. 감사 로그에는 before/after `{ allowDownload }`와 함께 `share.download_changed`로 남습니다). `POST`는 이것을 받지 않습니다(strict 본문이라 보내면 400). 새 링크는 항상 내려받기가 꺼진 채로 시작합니다. 공개하거나 공개를 취소하면 꺼짐으로 되돌아갑니다.
- `ShareStatusDTO`에 `allowDownload: boolean`이 더해집니다.
- `PublicPageDTO`에 `fullWidth?: true`(페이지의 '전체 너비'(`Full width`))와 `download?: true`(링크가 `…/export.md`를 허용함)가 더해집니다. 둘 다 false면 빠집니다.

<a id="onboarding-docsadr23802383"></a>
### 온보딩 (docs/adr/2380–2383)

마이그레이션 0060(`user_onboarding`, 이 마이그레이션 전부터 있던 모든 계정에 `{"legacy": true}` 행). 브라우저 세션만 됩니다. bearer 토큰은 403을 받습니다.

| 메서드 | 경로 | 본문 | 응답 | 비고 |
| --- | --- | --- | --- | --- |
| GET | `/api/me/onboarding` | — | `OnboardingDTO` `{ enabled, audience: owner\|member\|guest, intro, checklist: { show, collapsed, dismissed, complete, items: [{ id, done }] }, samples: { [workspaceId]: pageId } }` | 처음 부르면 그 사람의 행을 만듭니다. 새 서버의 첫 관리자라면 샘플 페이지도 만듭니다. 120/min |
| PATCH | `/api/me/onboarding` | `{ introSeen: true, collapsed, dismissed, event: slash\|link\|ai\|explore\|install }` 중 아무것이나 (strict) | `OnboardingDTO` | 비었거나 모르는 필드는 400. 60/min |
| POST | `/api/me/onboarding/sample` | `{ workspaceId }` | `{ pageId, workspaceId, created }` | 그 워크스페이스의 멤버(게스트 제외). 개인 페이지로 만듭니다. 살아 있는 샘플이 있으면 그것을 돌려줍니다(`created: false`). 만드는 중이면 409 `SAMPLE_IN_PROGRESS`, 404 `ONBOARDING_OFF`. 10/min |

- `ONBOARDING=off`: GET과 PATCH는 `enabled: false`로 답하고 눈에 보이는 것은 아무것도 바꾸지 않습니다. POST는 404 `ONBOARDING_OFF`입니다.
- `POST /api/pages/from-template`(그래서 `create_from_template`도): 템플릿 문서 안의 페이지 임베드가 같은 템플릿의 페이지를 가리키면, 이제 그 페이지의 새 복사본을 가리킵니다(docs/adr/2381-*).

<a id="mcp-tools-8"></a>
### MCP 도구
새 도구도 설명 변경도 없습니다. full 48개(~12,777 tokens), core 32개(~7,533). 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0200-additions"></a>
## v0.20.0 추가 사항

마이그레이션은 0061(아래의 공개 링크 차트) 하나입니다. 기존 응답의 모양은 그대로이고, 새 필드는 덧붙기만 합니다.

<a id="columns-docsadr24202424"></a>
### 단 (docs/adr/2420–2424)
- 단이 있는 페이지 본문은 모든 Markdown 응답과 입력에서 `<!-- inkling:columns -->`(단 폭이 서로 다르면 퍼센트 단위의 `{"widths":[…]}`가 붙음), `<!-- inkling:column -->`, `<!-- /inkling:columns -->` 줄을 씁니다. `GET /api/pages/:id/export?format=md`(모든 `notation`), zip 내보내기와 가져오기, `POST /api/pages/:id/content`, 섹션 경로, 볼트 동기화가 여기에 해당합니다. 짝이 맞지 않는 표시는 입력할 때 버리고 블록은 남깁니다.
- `GET`과 `POST /api/pages/:id/section`(과 `POST /api/pages/:id/sections`)은 최상위 단 묶음을 그 섹션의 블록 하나로 다룹니다. 단 안의 제목은 섹션이 아닙니다. replace는 묶음을 그대로 두거나 통째로 바꿉니다(docs/adr/2424-*).

<a id="document-schema-docsadr2425"></a>
### 문서 스키마 (docs/adr/2425)
- 협업 소켓: `GET /collab?schema=N`(WebSocket 업그레이드). `N`은 클라이언트가 아는 문서 스키마입니다(0.20 = 2). 없거나 잘못된 값이면 1입니다(0.19 이하). `N`보다 높은 노드 타입이 있는 페이지에서는 연결이 읽기 전용이 되고(`Authenticated` scope `readonly`) 상태 없는 메시지 `{"t":"schema","needs":M}`를 받습니다. 연결이 열려 있는 동안 그런 노드가 페이지에 들어오면 연결은 바로 읽기 전용이 되고, 클라이언트가 다시 연결하도록 소켓을 코드 4000으로 닫습니다.
- `GET /api/pages/:id/sync-check?schema=N`: `N`이 서버의 문서 스키마보다 낮으면 응답에 `needs: number`(페이지가 지금 필요로 하는 스키마)가 더해집니다. 파라미터가 없거나 서버 자신의 버전이면 응답은 그대로입니다.
- `PATCH /api/collection-row-templates/:id` 본문에 `schema?: number`가 더해집니다(`update`를 만든 클라이언트의 문서 스키마, 없으면 1). 저장된 본문이 필요로 하는 것보다 낮은 클라이언트가 보낸 `update`에는 409 `SCHEMA_OUTDATED`로 답하고 아무것도 바꾸지 않습니다. `update`가 없는 다른 필드 변경은 영향을 받지 않습니다.

<a id="charts-on-public-links-docsadr24402444"></a>
### 공개 링크의 차트 (docs/adr/2440–2444)

마이그레이션 0061(`pages.share_include_charts boolean not null default false`, users를 가리키는 `pages.share_charts_by uuid`(`on delete set null`), `pages.share_chart_sources jsonb`(승인된 원본 키, 꺼져 있는 동안 null))이고 추가만 합니다.

- `PATCH /api/pages/:id/share` 본문에 `includeCharts?: boolean`이 더해집니다(소유자와 관리자. 이 경로와 마찬가지로 세션만. 감사 로그에는 before/after `{ includeCharts }`와 함께 `share.charts_changed`로 남습니다). 켜면 부르는 사람을 차트를 집계할 계정으로 기록합니다. 켜져 있을 때 `true`를 보내면 기록된 계정을 그대로 둡니다. 켜면 링크의 차트가 지금 쓰는 원본도 승인합니다(컬렉션이나 그 뷰라면 컬렉션, 쿼리라면 공백을 정규화한 쿼리 텍스트). `false`는 세 가지를 모두 지웁니다. `POST`는 이것을 받지 않습니다(strict 본문이라 400). 새 링크는 차트가 꺼진 채로 시작합니다. 공개를 취소하면 지워집니다.
- `PATCH /api/pages/:id/share` 본문에 `approveChartSources?: true`가 더해집니다(소유자와 관리자, 세션만. 차트가 꺼져 있으면 409 `CHARTS_OFF`). 링크의 차트가 지금 쓰는 원본을 승인하고, 부르는 사람을 차트를 집계할 계정으로 기록합니다. 감사 로그에는 before/after `{ includeCharts, sources }`(승인된 원본 수)와 함께 `share.charts_changed`로 남습니다.
- `ShareStatusDTO`에 `includeCharts: boolean`, `chartsBy?: string | null`(켜져 있는 동안 기록된 계정의 이름), `charts?: { total, hidden, pending }`이 더해집니다. 차트가 없으면 `charts`는 빠집니다. `total`은 페이지의 차트 블록 수입니다(단 안에 있는 것 포함. 폴더라면 링크 안의 문서 페이지들의 차트이고, 최대 300페이지까지 읽습니다). `hidden`은 지금 설정에서 공개 페이지가 빼는 차트 수입니다(`pending` 포함). `pending`은 차트가 켜져 있을 때 원본이 승인되지 않은 차트 수이고(차트를 켜거나 마지막으로 승인한 뒤 더하거나 바뀐 것), `approveChartSources`를 부르면 공개될 것들입니다. 꺼져 있으면 0입니다. GET은 링크가 생기기 전에도 이것을 답하고(설정은 꺼짐), POST와 PATCH도 돌려줍니다.
- `PublicPageDTO`에 `charts?: PublicChartDTO[]`가 더해집니다(비어 있으면 빠짐). 링크의 평소 관문을 거칩니다(모르는 토큰 404, 만료 410, 시작 전 404, 비밀번호 401). 모양은 `{ anchor, kind, title?, group, series?, measure: { fn, name? }, groups: { label, special? }[], seriesKeys?: { label, special? }[], values: (number|null)[] | (number|null)[][], omittedGroups, omittedSeries, truncated? }`입니다. `group` / `series` / `measure.name`은 속성의 표시 이름이고, `special`은 `empty`, `checked`, `unchecked` 중 하나입니다. id, 키, 원본, 쿼리 텍스트, 라이브러리 옵션은 들어가지 않습니다. `html`에서는 차트 자리에(단 안에 있으면 그 단 안에) 차트의 제목 블록이 `data-id="<anchor>"`(제목이 있을 때)를, 표 블록이 `data-id="<anchor>-t"`를 가집니다. 앵커는 렌더링할 때마다 새로 만듭니다. 들어가는 차트는 스위치가 켜져 있을 때 승인된 원본의 차트 가운데 기록된 계정(아직 멤버일 때)이 Markdown 내보내기에서처럼 볼 수 있는 것입니다(페이지 워크스페이스의 컬렉션과 뷰, 쿼리 원본은 그 계정으로 실행). 폴더 링크에서는 링크 안에 있는 컬렉션의 차트도 들어갑니다. 그 밖에는 아무것도 들어가지 않습니다.
- Markdown 내려받기(`…/export.md`)는 들어가는 차트마다 굵은 제목과 GFM 표로 씁니다(차트가 단 안에 있으면 단 표시 안에 씁니다).

<a id="public-page-html-docsadr2387"></a>
### 공개 페이지 HTML (docs/adr/2387)
- `PublicPageDTO.html`: 콜아웃은 상자, 그다음 타입의 이모지를 담은 `<span class="nd-callout-icon" aria-hidden="true">`, 그다음 텍스트 요소 순서입니다(모르는 타입은 note로 그립니다). 글자색과 배경색은 BlockNote의 속성을 유지하고(텍스트에는 `data-style-type` / `data-value`, 블록과 표 셀에는 `data-text-color` / `data-background-color`), 이제 공개 페이지가 두 테마 모두에서 이 색을 그립니다. 이 서버 HTML은 공개 페이지만 씁니다.

<a id="mcp-tools-9"></a>
### MCP 도구
새 도구도 설명 변경도 없습니다. 이제 모든 도구에 주석 힌트가 붙습니다(docs/adr/2460-*). full 48개(~13,245 tokens, 0.19: ~12,777), core 32개(~7,857, 0.19: ~7,533)이고, 서버 지침은 그대로입니다(~492). `catch_up`은 더 이상 읽기 전용으로 표시하지 않고, `update_row`는 destructive로 표시합니다. 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0210-additions"></a>
## v0.21.0 추가 사항

마이그레이션도 서버 변경도 없습니다. 엔드포인트, 요청 본문, 응답은 0.20.0과 같습니다.

<a id="pdf-preview-docsadr24802482"></a>
### PDF 미리보기 (docs/adr/2480–2482)
- 웹 앱의 PDF 미리보기는 파일의 크기와 타입을 `GET /api/files/:id/meta`에서 읽고, 파일은 `GET /files/:id`로 받아 브라우저에서 그립니다. 두 경로 모두 전과 같습니다(검사도 헤더도 같음). 새로 저장하는 것도, 새 필드를 받는 경로도 없습니다.

<a id="mcp-tools-10"></a>
### MCP 도구
새 도구도 설명 변경도 없습니다. 수치는 0.20과 같습니다. full 48개(~13,245 tokens), core 32개(~7,857), 서버 지침 ~492입니다. 자세한 내용: [MCP.ko.md](MCP.ko.md).

<a id="v0220-additions"></a>
## v0.22.0 추가 사항

마이그레이션 0062(추가만). 제한 모드의 설정은 운영자가 켜기 전에는 모두 꺼져 있고(docs/OPERATIONS.ko.md, 17절), 하나도
설정하지 않으면 아래에서 설정에 따라 달라지는 응답은 모두 0.21.1과 같습니다. 계정 삭제, 혼자 남은 워크스페이스에서 나가기,
"지금 완전히 삭제"는 모든 서버에 있습니다.

<a id="settings-in-apiauthmode-and-apiauthme-docsadr25002503"></a>
### `/api/auth/mode`와 `/api/auth/me`의 설정 (docs/adr/2500–2503)
- `GET /api/auth/mode`는 설정이 켜져 있을 때만 그 필드를 더합니다(아니면 키 자체가 없고 `undefined`도 보내지 않습니다).
  `loginId: 'username'`(`LOGIN_ID_MODE=username`), `signupFull: true`(계정 수가 `SIGNUP_MAX_USERS`에 닿음),
  `signupChecks: true`(`SIGNUP_MAX_USERS`나 `SIGNUP_PER_IP_PER_DAY`가 있어서 가입 양식이 봇 검사 필드를 보냄),
  `instanceLabel`, `accountLifetimeDays`, `disabledFeatures: string[]`(정렬), `legal: { version, docs: ('terms' |
  'privacy')[] }`(`LEGAL_DIR`), `limits: { workspacesPerUser?, membersPerWorkspace?, pagesPerWorkspace?, fileMb?,
  workspaceStorageMb? }`(설정된 한도만, MB는 설정한 값 그대로), `workspaceRestoreDays`(30이 아닐 때만)입니다.
- `GET /api/auth/mode`는 `INSTANCE_NOTICE`가 있으면 `instanceNotice: string`을 더합니다.
- `GET /api/auth/me`의 `UserDTO`는 `expiresAt`(ISO, `ACCOUNT_LIFETIME_DAYS`에 따른 계정 삭제일)과
  `consentRequired: true`(현재 문서에 동의하지 않음)를 더합니다. 로그인, 2단계, 가입 응답의 `user`는 지금처럼 짧게
  두고, 웹 앱은 이 필드를 `/auth/me`에서 읽습니다.
- `AdminUserDTO`(`GET /api/admin/users`)는 만료일이 있는 계정에 `expiresAt`을 더합니다.
- 공유 상수는 `@inkling/shared`(`packages/shared/src/limits.ts`)에 있습니다. `DISABLED_FEATURE_NAMES`,
  `RESTRICTED_MODE_ERRORS`, `AuthModeLimitsDTO`, `AuthModeLegalDTO`, `WorkspaceUsageDTO`입니다.

<a id="sign-up-docsadr2501-2512-2516-2519"></a>
### 가입 (docs/adr/2501, 2512, 2516, 2519)
- `POST /api/auth/register`는 새 선택 필드를 받습니다. `LEGAL_DIR`이 있으면 `consents: string[]`(체크한 항목 id,
  32개까지)와 `legalVersion`(양식이 보여 준 버전), `signupChecks`가 켜져 있으면 `website`(비워 둬야 하는 숨은 입력란)와
  `formMs`(양식이 화면에 떠 있던 밀리초, 2000 이상)입니다. `formMs`는 보낸 본문에서 그대로 읽고 `registerSchema`에는
  없습니다.
- `LOGIN_ID_MODE=username`이면 본문에 `email` 대신 `loginId`를 보냅니다. `email`을 보내면 400 `VALIDATION`, 아이디가
  없거나 규칙에 맞지 않으면 400 `LOGIN_ID_INVALID`, 이미 쓰이면 409 `LOGIN_ID_TAKEN`입니다. 아이디는 소문자로 바꿔 계정의
  이메일 열에 저장하므로 `UserDTO.email`에 아이디가 들어갑니다. 로그인은 지금처럼 `email`에 아이디를 넣어 보냅니다.
  이메일 모드에서는 `loginId` 필드를 무시합니다.
- 검사 순서: 본문, 예약된 위임 도메인, 설정 코드, 그다음 제한 모드 검사(봇 검사, 계정 수 상한, 주소별 상한, 동의)입니다.
  모두 가입 키를 쓰거나 무엇을 쓰기 전에 합니다. 계정 수 상한과 주소별 상한은 계정을 만드는 트랜잭션 안에서 다시 세고,
  동의 행도 거기서 씁니다. 설정 코드로 만드는 첫 관리자는 계정 수·주소별 상한과 봇 검사를 거치지 않지만 동의는 해야
  합니다.
- 제한 모드(`SIGNUP_MAX_USERS`, `SIGNUP_PER_IP_PER_DAY`, `ACCOUNT_LIFETIME_DAYS` 가운데 하나가 있거나
  `LOGIN_ID_MODE=username`)에서 관리자가 없는 서버는 설정 코드 없는 가입을 403 `SETUP_REQUIRED`로 거절합니다.
- `ACCOUNT_LIFETIME_DAYS`가 있을 때 만든 계정은 `users.expires_at` = 가입 시각 + N일을 받습니다. 관리자는 받지 않습니다.

<a id="account-deletion-and-leaving-docsadr25132517"></a>
### 계정 삭제와 나가기 (docs/adr/2513–2517)
- `GET /api/me/delete-preview` → `{ deleted: { id, name, pages, files }[], transferred: { id, name, to: { id, name }
  }[], kept: { id, name }[], privatePages, pages, files, needs: { password, code, recentSignIn }, confirm,
  lastAdmin }`. 계정과 함께 지워지는 워크스페이스, 다른 멤버에게 넘어가는 워크스페이스, 나머지, 그리고 요청에 실어야
  하는 것입니다. `confirm`은 입력할 확인 문구(로그인 이메일이나 아이디)입니다.
- `DELETE /api/me` 본문 `{ confirm, password?, code? }` → `{ ok: true, deletedWorkspaces, transferredWorkspaces }`이고
  세션 쿠키를 지웁니다. 브라우저 세션에서만 됩니다(bearer 토큰은 403). `confirm`은 대소문자를 무시하고 로그인 이메일이나
  아이디와 같아야 합니다(400 `CONFIRM_MISMATCH`). 로컬 계정은 현재 비밀번호를 보내고(400 `INVALID_PASSWORD`),
  2단계 인증이 켜져 있으면 `code`도 보냅니다(없으면 400 `TOTP_REQUIRED`, 틀리면 400 `INVALID_TOTP_CODE`). 실패는 로그인
  보호 장치에 셉니다. 위임 로그인과 OIDC 계정은 최근 10분 안에 만든 세션이어야 합니다(401 `REAUTH_REQUIRED`). 유일한
  관리자는 409 `LAST_ADMIN`. 분당 10회. 바로 지웁니다. 그 사람만 멤버인 워크스페이스는 파일까지 지우고, 그 사람이 혼자
  소유한 공유 워크스페이스는 가장 오래된 관리자 역할 멤버, 없으면 가장 오래된 멤버에게 넘깁니다(알림 타입
  `workspace_owner`). 비공개 페이지는 지우고, 공유 페이지·댓글·버전은 작성자를 null로 두고 남깁니다.
- `DELETE /api/workspaces/:id/members/:userId`를 자기 자신에게, 유일한 멤버이자 마지막 소유자로서, 워크스페이스 이름과
  같은 `{ name }` 본문을 실어 브라우저 세션에서 보내면 204이고 워크스페이스를 파일까지 바로 지웁니다(복원 없음). 이름이
  틀리면 400이고, `name`이 없거나 토큰으로 보냈거나 다른 멤버가 있으면 지금처럼 400입니다.
- `DELETE /api/workspaces/:id/permanent` 본문 `{ name }` → 204. 소유자가 삭제된(아직 복원할 수 있는) 워크스페이스를 바로
  완전히 지웁니다. 브라우저 세션에서만 되고(bearer 토큰은 403), 삭제되지 않았거나 없거나 멤버가 아니면 404, 소유자가
  아니면 403, 워크스페이스의 2단계 인증 규칙은 복원과 같이 적용되고, 이름이 틀리면 400입니다.
- `DELETE /api/admin/users/:id`는 0.21과 같이 답합니다(목록이 담긴 409 `SOLE_OWNER`, 비공개 페이지는 휴지통으로).
- `GET /api/admin/users/:id/expiry` → `{ expiresAt: string | null }`. `PATCH`에 `{ expiresAt: string | null }`(오프셋이
  붙은 ISO)을 보내면 날짜를 옮기거나 풀고(`null`) `{ expiresAt }`을 돌려줍니다. 지난 날짜는 400, 날짜가 없는 계정에 여기서
  날짜를 줄 수는 없고(400), 없는 계정은 404 `USER_NOT_FOUND`. 관리자, 브라우저 세션.

<a id="usage-and-limits-docsadr25052506"></a>
### 사용량과 한도 (docs/adr/2505–2506)
- `GET /api/workspaces/:id/usage`(멤버) → `WorkspaceUsageDTO { members, pages, storageBytes, fileBytes, limits: {
  members?, pages?, storageBytes? } }`. `pages`는 휴지통도 세고, `storageBytes`는 저장 용량 합계(파일 포함), `fileBytes`는
  파일만입니다. `limits`에는 설정된 한도만 들어가고 저장 용량은 바이트입니다. 모든 서버에서 답합니다. 저장 용량 한도가
  없으면 부를 때마다 세고, 있으면 캐시한 값을 쓰되 그 값이 1분보다 오래되었으면 먼저 다시 셉니다.
- 한도를 넘는 생성은 만드는 트랜잭션 안에서 거절합니다. REST도, 그 REST를 부르는 MCP 도구도 같습니다. 페이지(만들기,
  복제, 캔버스, 행과 행 일괄, 가져오기, 템플릿, 나누기, 클립, 빠른 할 일, 동기화, 폼 응답), 파일, 워크스페이스(만들기,
  넘겨받기, 소유자로 승격, 복원), 멤버(초대 코드로 참여, 바로 추가)가 그렇습니다. 이미 멤버인 워크스페이스에 다시
  참여하면 다시 세지 않습니다.
- `LIMIT_WORKSPACE_STORAGE_MB`를 넘은 워크스페이스는 읽기 전용입니다. docs/OPERATIONS.ko.md(17절)에 적은 쓰기는 413
  `LIMIT_STORAGE`로 답하고, 협업 연결은 읽기 전용 범위를 받습니다. 본문이 한도의 1/4을 넘은 페이지는 REST와 MCP 쓰기를
  413 `LIMIT_STORAGE`로 거절합니다("This page is too large to grow further: move part of it to a new page", `limit`은 그
  1/4).
- 내장 상한(브라우저 25 MB, 토큰은 `AGENT_UPLOAD_MAX_MB`)보다 작은 `LIMIT_FILE_MB`가 있으면 `POST /api/files`는 413
  `LIMIT_FILE`로 답합니다. 없으면 지금처럼 413 `PAYLOAD_TOO_LARGE`입니다.

<a id="features-turned-off-docsadr2507"></a>
### 기능 끄기 (docs/adr/2507)
- `DISABLED_FEATURES`에 든 기능의 라우트는 인증보다 먼저 `details: { feature }`가 붙은 404 `FEATURE_DISABLED`로 답합니다.
  기능별 라우트 목록은 `apps/server/src/quota/features.ts`에 있습니다. 이미 있는 것을 없애는 라우트(게시 취소, 웹훅 삭제,
  Slack 연결이나 iCal 토큰 없애기, 기기 구독 해지)는 열려 있습니다. 기능이 꺼져 있는 동안 `/s/:token`은 빈 앱 화면을
  돌려주고 `/ical/:file`은 404로 답합니다.
- `notion-import`가 꺼져 있을 때 `source=notion`을 붙인 `POST /api/workspaces/:id/import`는 404 `FEATURE_DISABLED`이고,
  Notion에서 내보낸 것처럼 보이는 zip은 일반 Markdown으로 가져옵니다(연결로 보낸 경우도 같습니다. 원래는 415
  `NOTION_IMPORT_IN_APP`).

<a id="terms-and-consent-docsadr25192520"></a>
### 약관과 동의 (docs/adr/2519–2520)
`LEGAL_DIR`이 있을 때만입니다. 없으면 이 라우트들은 404이고 아래 내용은 적용되지 않습니다.
- `GET /api/legal`(로그인 불필요) → 한 언어로 된 `{ version, notice: string | null, items: { id, required, label, doc?,
  details? }[] }`(`?locale=en|ko`, 없으면 `Accept-Language`, 없으면 `DEFAULT_LOCALE`). `Cache-Control: no-store`.
- `GET /api/legal/:doc`(`terms` 또는 `privacy`, 로그인 불필요) → `{ doc, version, locale, markdown }`. 폴더에 한 언어로만
  있는 문서는 그 언어로 돌려주고, 어느 언어인지는 `locale`이 알려 줍니다.
- `POST /api/legal/consent` 본문 `{ consents, legalVersion }` → `{ ok: true, version }`. 로그인한 브라우저 세션에서만
  됩니다(bearer 토큰은 403 `FORBIDDEN`). 다른 버전, 모르는 항목, 체크하지 않은 필수 항목은 `details: { version }`이 붙은
  400 `CONSENT_REQUIRED`. 분당 20회.
- 현재 버전의 필수 항목 전부에 동의하지 않은 사람은 인증이 필요한 모든 요청에서 403 `CONSENT_REQUIRED`(`details: {
  version }`, 메시지에 어디서 동의하는지 적힘)로 거절됩니다. 쿠키, 개인 API 토큰, OAuth·에이전트 토큰, MCP 도구가 부르는
  REST, `/mcp` 엔드포인트 자체(JSON-RPC 응답 전에 오류 본문이 담긴 일반 HTTP 403), 협업 소켓이 모두 그렇습니다. 예외:
  `POST /api/auth/logout`, `GET /api/auth/me`, `/api/legal` 아래 전부, `DELETE /api/me`, `GET /api/me/delete-preview`.
  `PATCH /api/auth/me/locale`은 예외가 아닙니다. 전에 만들어 둔 자동화 실행은 통과합니다.

<a id="error-codes"></a>
### 오류 코드
| 상태 | 코드 | 언제 | `details` |
|---|---|---|---|
| 400 | `LOGIN_ID_INVALID` | 아이디 모드: `loginId`가 없거나 규칙에 맞지 않거나 예약어 | — |
| 409 | `LOGIN_ID_TAKEN` | 아이디 모드: 이미 쓰이는 아이디(이메일 모드는 `EMAIL_TAKEN` 그대로) | — |
| 403 | `SIGNUP_FULL` | 서버의 계정 수가 `SIGNUP_MAX_USERS`에 닿음 | — |
| 429 | `SIGNUP_IP_LIMIT` | 그 주소에서 24시간 동안 `SIGNUP_PER_IP_PER_DAY`개를 만듦 | — |
| 400 | `SIGNUP_CHECK_FAILED` | 가입 제한이 켜져 있는데 숨은 `website` 칸이 채워졌거나, `formMs`가 없거나 2000보다 작음 | — |
| 403 | `SETUP_REQUIRED` | 제한 모드, 아직 관리자 없음, 설정 코드 없는 가입 | — |
| 400 | `CONSENT_REQUIRED` | 가입이나 `POST /api/legal/consent`: 다른 버전, 모르는 항목, 체크하지 않은 필수 항목 | `{ version }` |
| 403 | `CONSENT_REQUIRED` | 현재 버전에 동의하기 전의 다른 모든 게이트 대상 요청 | `{ version }` |
| 404 | `FEATURE_DISABLED` | `DISABLED_FEATURES`에 든 기능의 라우트 | `{ feature }` |
| 403 | `LIMIT_WORKSPACES` | 만들기, 넘겨받기, 소유자로 승격, 복원이 `LIMIT_WORKSPACES_PER_USER`를 넘음 | `{ limit, used }` |
| 403 | `LIMIT_MEMBERS` | 참여나 바로 추가가 `LIMIT_MEMBERS_PER_WORKSPACE`를 넘음 | `{ limit, used }` |
| 403 | `LIMIT_PAGES` | 페이지를 만드는 모든 경로가 `LIMIT_PAGES_PER_WORKSPACE`를 넘음(휴지통 포함) | `{ limit, used }` |
| 413 | `LIMIT_STORAGE` | 워크스페이스가 `LIMIT_WORKSPACE_STORAGE_MB`를 넘었거나 이 쓰기로 넘음. 또는 페이지 본문이 그 1/4을 넘음 | `{ limit, used, unit: 'bytes' }` |
| 413 | `LIMIT_FILE` | `LIMIT_FILE_MB`보다 큰 업로드 | `{ limit, used, unit: 'bytes' }`. `used`는 `limit` + 1(업로드를 거기서 끊으므로 실제 크기는 모름) |
| 409 | `LAST_ADMIN` | 유일한 관리자의 `DELETE /api/me` | — |
| 401 | `REAUTH_REQUIRED` | 세션이 10분보다 오래된 위임 로그인·OIDC 계정의 `DELETE /api/me` | — |
| 400 | `CONFIRM_MISMATCH` | `DELETE /api/me`: `confirm`이 로그인 이메일이나 아이디와 다름 | — |
| 400 | `TOTP_REQUIRED` | `DELETE /api/me`: 2단계 인증이 켜져 있는데 `code`가 없음 | — |

`details`의 키는 오류 객체 안에 `code`, `message`와 나란히 들어갑니다: `{ "error": { "code", "message", "limit", "used",
"unit" } }`. `limit`과 `used`는 숫자이고, 웹 앱은 이 값을 자기 문구에 넣어 보여 줍니다. `DELETE /api/me`는 틀린 2단계
코드에 400 `INVALID_TOTP_CODE`로 답합니다(로그인은 401).

<a id="mcp-tools-11"></a>
### MCP 도구
새 도구도, 설명이나 서버 지침의 변경도 없습니다. 수치는 0.21과 같습니다(full 48개, core 32개). 도구는 자기가 부르는 REST
라우트를 거치므로 같은 한도, 기능 끄기, 동의에 똑같이 걸립니다. 자세한 내용: [MCP.ko.md](MCP.ko.md).
