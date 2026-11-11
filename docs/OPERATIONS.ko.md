# 운영: 배포 점검 목록, 성능, 캐시, 데이터베이스 튜닝

[deploy/DEPLOY.ko.md](../deploy/DEPLOY.ko.md), [docs/BACKUP.ko.md](BACKUP.ko.md)와 함께 보는 문서입니다. 설계 기록은 `docs/adr/0750`–`0759`에 있고, 알고 있지만 그대로 두기로 한 문제는 [KNOWN-ISSUES.ko.md](KNOWN-ISSUES.ko.md)에 있습니다. English: [OPERATIONS.md](OPERATIONS.md).

<a id="0-deployment-checklist"></a>
## 0. 배포 점검 목록

<a id="before-first-deploy"></a>
### 처음 배포하기 전에

- [ ] TLS 뒤에서 돌리세요: `docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d`. 기본 compose가 여는 `3000:3000`(평문 HTTP)을 인터넷에 그대로 내놓으면 안 됩니다.
- [ ] `.env`에 충분히 강한 `POSTGRES_PASSWORD`를 넣으세요. 필수 값이라 없으면 compose가 시작하지 않습니다.
- [ ] `PUBLIC_URL`(또는 `APP_URL`)을 바깥에서 접속하는 주소(origin)로 정하세요. 예: `PUBLIC_URL=https://notes.example.com`. 메일 링크, OAuth 발급자, `og:url`은 이 값으로만 만들고 `Host` 헤더는 절대 믿지 않습니다. SMTP 메일을 켰는데 두 변수가 모두 비어 있으면 서버가 부팅하지 않습니다.
  다른 origin(LAN IP나 다른 도메인)으로 앱을 연 브라우저는 읽기만 할 수 있고, 쓰기는 모두 403 `CROSS_SITE_REQUEST`로 거절됩니다(docs/adr/1062-*).
- [ ] 누군가 2단계 인증을 켜기 전에 `APP_SECRET_KEY`(32자 이상, `openssl rand -base64 32`)를 넣고, 데이터베이스·데이터 백업과는 다른 곳에 보관하세요. 이 값을 바꾸면 이미 켜 둔 2단계 인증 정보를 읽을 수 없게 됩니다(복구 코드와 관리자 초기화는 그대로 됩니다). 0.5.0부터는 공유 링크, 초대 코드, 가입 키의 "링크 복사"용 사본과 웹훅·시트 동기화 URL도 이 키로 암호화합니다. 키가 없으면 이 사본과 URL은 평문으로 남고(부팅 때 경고), 키를 넣은 뒤 처음 부팅할 때 암호화됩니다(docs/adr/1110-*, 1111-*).
- [ ] 쿠키: `PUBLIC_URL`이 `https`이면 세션 쿠키에 `Secure`가 저절로 붙습니다. `COOKIE_SECURE`는 `.env` 값을 그대로 넘기고(기본 `0`), Caddy 오버레이는 이 값을 `1`로 둡니다.
- [ ] 가입 키: `NODE_ENV=production`에서는 `SIGNUP_REQUIRE_KEY=0`을 직접 넣지 않는 한 가입할 때 가입 키가 필요합니다. 첫 관리자의 키는 `./deploy/signup-key.sh new "<name>"`으로 만듭니다(서버가 부팅할 때 이 방법을 로그에 남깁니다).
- [ ] OpenID Connect 로그인(선택, [deploy/DEPLOY.ko.md](../deploy/DEPLOY.ko.md#3-g-openid-connect-sign-in-optional)의 3-G): 제공자 쪽에 `<PUBLIC_URL>/api/auth/oidc/callback`을 등록하고 `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`을 넣으세요. 이 중 일부만 넣었거나 `PUBLIC_URL`이 없으면 부팅이 멈춥니다. 이 로그인에는 가입 키가 적용되지 않으므로 `OIDC_AUTO_CREATE=1`을 쓸 때는 `OIDC_ALLOWED_DOMAINS`도 넣으세요. 제공자가 이메일 주소를 확인해 주는 곳이 아니라면 `OIDC_LINK_EXISTING=0`으로 두시고(docs/adr/1161-*), 워크스페이스의 2단계 인증이 제공자 쪽 인증을 믿어도 될지 정하세요(`OIDC_REQUIRE_MFA`, docs/adr/1162-*). 빈 인스턴스에서 `OIDC_AUTO_CREATE`를 켜기 전에 첫 관리자로 비밀번호 로그인을 한 번 해 두세요.
- [ ] 의미 검색(선택, 기본 꺼짐, 5절): find_context가 뜻으로도 순위를 매기게 하고 싶을 때만 `EMBEDDING_URL`과 `EMBEDDING_MODEL`을 넣으세요. 청크(색인 단위로 나눈 글 조각)의 글이 그 주소로 나갑니다. 호스팅 제공자를 쓰면 그곳은 제3자이므로, 노트가 이 기계 밖으로 나가면 안 될 때는 로컬 모델 서버를 쓰는 편이 낫습니다. 둘 중 하나만 넣으면 꺼진 채로 있고 부팅 때 경고를 한 번 남깁니다(docs/adr/1740-*).
- [ ] Slack 앱(선택, 6절): 도메인 이름으로 된 `PUBLIC_URL`(링크 미리보기와 `/inkling link` URL에 씁니다)과 `APP_SECRET_KEY`가 필요합니다. `APP_SECRET_KEY`가 없으면 봇 토큰과 서명 비밀값이 암호화되지 않은 채 저장되고, 설정 화면에 경고가 나옵니다. Slack용 환경 변수는 따로 없습니다. 워크스페이스 소유자가 각자 만든 앱의 토큰과 비밀값을 워크스페이스 설정 → Slack(`Workspace settings → Slack`)에 붙여 넣습니다.
- [ ] `TZ`를 사용자들이 사는 시간대로 정하세요(알림, 데일리 노트, 백업 일정, GFS 보관 구간이 이 값을 씁니다). compose 기본값은 `UTC`이고, 한국에서 쓰는 서버라면 `TZ=Asia/Seoul`로 둡니다.
- [ ] `DEFAULT_LOCALE`(`en` | `ko`, 기본 `en`)을 정하세요. 언어를 고르지 않은 사용자에게 가는 메일과 기본 템플릿의 언어이고, 브라우저 언어보다 먼저 쓰는 웹 화면 기본값입니다(docs/adr/0901-*, 0903-*). 한국에서 쓰는 서버라면 `DEFAULT_LOCALE=ko`로 둡니다.
- [ ] 서버 환경 변수는 모두 `compose.yaml`이 `${X:-}` 형태로 넘기므로 `.env`에 적기만 하면 됩니다(`.env` 파일 자체는 이미지에 복사되지 않습니다). `compose.override.yaml`을 쓰신다면 그 파일이 필요한 `environment:` 항목을 덮어쓰지 않는지 확인하세요.
- [ ] 돌고 있는 컨테이너에서 `NODE_ENV=production`인지 확인하세요. 이 값은 `WEBHOOK_TEST_ALLOW_LOOPBACK` 같은 루프백 테스트 스위치도 꺼 줍니다.
- [ ] `BACKUP_PASSPHRASE`를 정하고 서버 밖에 보관하세요. 잃어버리면 암호화된 백업 세트를 복구할 수 없습니다.
- [ ] 외부 사본을 설정하세요(`deploy/compose.backup-rclone.yaml`). 로컬 백업 세트는 데이터베이스와 같은 디스크에 있습니다.

<a id="resource-limits"></a>
### 자원 한도

- [ ] 호스트 디스크: (데이터베이스 크기 + 데이터 볼륨)의 2배 이상을 비워 두세요. 백업, 주간 복원 테스트, 업로드가 이 공간을 같이 씁니다.
- [ ] 디스크가 작다면 `BACKUP_MIN_FREE_MB`를 기본값 256 MB보다 올리세요. 오래된 백업 정리(prune)가 남은 공간 확인보다 먼저 돌기 때문에(가장 최근 세트는 언제나 남깁니다) 디스크가 가득 차도 정리가 막히지 않습니다.
- [ ] 컨테이너 메모리: `APP_MEM_LIMIT` / `NODE_OPTIONS`와 `PG_MEM_LIMIT` / `PG_SHM_SIZE`(1절과 2절 참고). 백업 사이드카는 256m입니다.
- [ ] 기본 `compose.yaml`의 서비스들은 `x-logging` 앵커를 함께 씁니다. 오버레이 파일(Caddy, rclone)에서는 이 앵커를 가져다 쓸 수 없으니, 그 서비스들에는 `logging:` 블록을 따로 넣으세요.
- [ ] 가져오기 한도: 폴더 깊이는 32까지이고, 가져오기 한 번에 만드는 페이지 수는 `IMPORT_MAX_PAGES`(기본 5000)까지입니다. zip 항목은 실제로 풀린 바이트로 잽니다. 크기 한도는 환경 변수로 바꿀 수 있습니다: `IMPORT_MAX_UPLOAD_MB`(25), `IMPORT_MAX_UNPACKED_MB`(50), `IMPORT_MAX_ENTRY_MB`(25), `IMPORT_MAX_FILES`(300). 노션 내보내기를 받으려고 이 값을 올리면 최대 메모리 사용량이 대략 업로드 크기만큼 늘어납니다(안에 분할 압축 파일이 들어 있으면 두 배). docs/adr/0961-*을 보세요.
- [ ] 무거운 작업 한도(docs/adr/1240-*): 가져오기(Markdown, zip, Notion, 폴더), zip 내보내기, 하위 트리 복제는 `HEAVY_JOBS_MAX`개의 자리 중 하나를 차지합니다(기본 2. 메모리 768 MB 미만 컨테이너이거나 `IMPORT_MAX_*` 한도를 올렸다면 `1`로 두세요). 나머지 작업은 `HEAVY_JOBS_QUEUE_MAX`(16)개까지 들어가는 공정한 대기열에서 최대 `HEAVY_JOBS_WAIT_MS`(60000) 동안 기다리고, 그래도 차례가 오지 않으면 `Retry-After`와 함께 `503 HEAVY_JOBS_BUSY`를 받습니다. 한 사람이 돌리거나 기다릴 수 있는 작업은 `HEAVY_JOBS_PER_USER`(2)개이고, 하나 더 하려고 하면 `429 HEAVY_JOBS_PER_USER`를 받습니다. zip 내보내기는 다운로드가 끝나거나 클라이언트 연결이 끊길 때까지 자리를 잡고 있습니다. 이 한도들은 프로세스마다 따로 적용됩니다.

<a id="database-timeouts"></a>
### 데이터베이스 타임아웃

앱은 풀의 모든 연결에 `statement_timeout` 15초, `idle_in_transaction_session_timeout` 60초, `lock_timeout` 10초를 걸고, 연결할 때 `connect_timeout` 10초를 씁니다. 이 값들을 역할(role)이나 데이터베이스 단위로 걸지는 **마세요**. 백업 사이드카의 `pg_dump`도 같은 역할을 쓰기 때문입니다. 백업 스크립트는 `statement_timeout=0`을 담은 `PGOPTIONS`를 export합니다.

<a id="shutdown-and-crashes"></a>
### 종료와 크래시

- `compose.yaml`의 `app`에는 `stop_grace_period: 30s`가 걸려 있습니다. SIGTERM을 받으면 앱은 협업 연결 업그레이드를 더 받지 않고, 열린 문서를 저장하고(최대 10초), HTTP를 닫고(시간 제한 있음), 선택 기능인 의미 색인기를 멈춘 뒤(2초. 진행 중인 임베딩 요청은 버립니다) 데이터베이스 풀을 닫습니다. 25초가 지나면 감시 타이머가 프로세스를 강제로 끝냅니다.
- `unhandledRejection`은 로그만 남기고 프로세스는 계속 돕니다. `uncaughtException`은 로그를 남긴 뒤 위의 정상 종료 절차를 시작하고, 컨테이너 재시작 정책이 앱을 다시 띄웁니다.
- 0.15.1부터는 재시도까지 다 실패한 문서 저장을 백그라운드에서 다시 시도합니다(5초부터 두 배씩 늘려 최대 60초 간격). 저장되지 않은 변경이 있는 페이지는 마지막 편집자가 나간 뒤에도 저장에 성공할 때까지 메모리에 남습니다. 단일 인스턴스 잠금은 열린 문서를 저장한 뒤 맨 마지막에 풉니다(9절, docs/adr/1921-*, 1925-*).
- 크래시나 강제 종료(OOM, 정전, `docker kill`)가 나면 마지막 2–10초 동안 입력한 내용은 여전히 잃습니다. 저장을 잠깐씩 모아서 하기 때문입니다(debounce). 정상 종료는 먼저 모두 저장합니다. 크래시 때문에 색인 작업을 잃은 페이지는 다음 부팅 때 다시 색인합니다(9절).

<a id="monitoring"></a>
### 모니터링

- [ ] `GET /api/health`는 프로세스가 살아 있는지만 봅니다. `GET /api/health/ready`는 2초 제한으로 `select 1`을 실행하고(결과는 5초 캐시) 데이터베이스에 닿지 않으면 503을 돌려줍니다. 외부 모니터에는 이쪽을 쓰세요. compose 헬스체크는 계속 `/api/health`를 써도 됩니다.
- [ ] Docker는 `unhealthy` 상태가 된 컨테이너를 다시 시작하지 않습니다. 외부 모니터나 autoheal을 쓰세요.
- [ ] 앱이 재시작되는지 지켜보세요. 재시작이 반복되면(크래시 루프) 보통 데이터베이스가 내려갔거나 디스크가 가득 찬 것입니다.
- [ ] 관리자 › 백업(`Admin › Backups`)에서 마지막 성공, 마지막 복원 테스트, 사이드카 하트비트를 볼 수 있습니다.
- [ ] 남은 디스크 공간을 매주 확인하세요.

<a id="reading-the-status-summary"></a>
### 상태 요약 읽기

관리자는 **관리자**(`Admin`) 화면 맨 위에서 서버 상태 요약을 보고, 손볼 것이 있으면 앱 맨 위에 한 줄짜리 배너가 뜹니다(docs/adr/1230-*, 1233-*). 같은 데이터를 `GET /api/admin/status`로도 받을 수 있습니다(관리자의 브라우저 세션에서만 됩니다. `?refresh=1`을 붙이면 5분 캐시를 건너뜁니다).

- **색.** 초록은 정상, 주황은 경고, 빨강은 문제이고, 회색은 꺼져 있거나 이 서버에서 설정하지 않은 항목입니다. 회색 줄은 배너를 띄우지 않습니다. `NODE_ENV=production`이 아니면 설정 점검 항목(비밀 키, `PUBLIC_URL`, 쿠키, 가입, 데이터베이스 비밀번호, 사이드카 없음)은 회색으로 나옵니다. 프로덕션 서버를 위한 점검이기 때문입니다.
- **배너**는 첫 번째 문제와 나머지 문제가 몇 개인지 보여 줍니다. 같은 문제(항목 + 단계)는 관리자와 브라우저마다 하루에 한 번만 보여 주고, 새 문제나 경고에서 문제로 올라간 항목은 바로 보여 줍니다. 관리자 화면을 열면 본 것으로 칩니다. 배너를 닫으면 그 세션 동안은 보이지 않습니다.
- **측정 주기.** 디스크 공간, 데이터베이스 크기, 업로드, 큰 페이지, 저장된 비밀값, 마이그레이션은 최대 5분에 한 번 잽니다. 화면에는 언제 쟀는지(`Checked … ago`)가 나오고, **다시 확인**(`Check again`)을 누르면 바로 다시 잽니다. 백업 상태, 재시작, 오류, 설정은 요청마다 읽습니다.

| 카드 · 줄 | 뜻 | 할 일 |
|---|---|---|
| 백업 · 백업 서비스 (`Backups · Backup service`) | 사이드카의 하트비트(60초마다)입니다. 10분 동안 소식이 없으면 빨강이 됩니다. | `docker compose ps backup`, `docker compose logs backup`([BACKUP.ko.md](BACKUP.ko.md#troubleshooting)의 문제 해결 절). |
| 백업 · 마지막 백업 (`Backups · Last backup`) | 예약 실행을 한 번 놓치면(마지막 실행이 일정 간격 × 2 + 1시간보다 오래되면) 주황, 마지막 실행이 실패했거나 가장 최근 세트가 7일보다 오래되면 빨강입니다. | 관리자 › 백업에 실패 메시지가 나옵니다. 원인을 고친 뒤 **지금 백업**(`Back up now`)을 누르세요. |
| 백업 · 검증 / 복원 테스트 (`Backups · Verification / Restore test`) | 마지막 확인이 실패하면 빨강입니다. 복원 테스트는 `BACKUP_RESTORE_TEST_DAYS` × 2보다 오래되면 주황입니다. | `./deploy/backup.sh restore-test`, [BACKUP.ko.md](BACKUP.ko.md#what-a-backup-set-contains)의 복원 테스트 설명. |
| 백업 · 외부 사본 / 암호화 (`Backups · Off-site copy / Encryption`) | `BACKUP_RCLONE_REMOTE`가 없으면 회색입니다(그래도 3-2-1 규칙을 생각하면 고칠 만합니다). 암호화는 암호화하지 않은 세트를 외부로 복사할 때만 주황입니다. 암호 문구 자체는 화면에 나오지 않습니다. | [BACKUP.ko.md](BACKUP.ko.md#off-site-copies-with-rclone)의 외부 사본, [암호화](BACKUP.ko.md#encryption) 절. |
| 저장 공간 · 데이터 디스크 (`Storage · Data disk`) | `DATA_DIR` 볼륨의 남은 공간입니다. 2 × (데이터베이스 + 업로드)나 10 %보다 적으면 주황, 512 MB나 3 %보다 적으면 빨강입니다. | 데이터베이스가 공간을 다 쓰기 전에 공간을 비우거나 디스크를 늘리세요("장애 대응" 절). |
| 저장 공간 · 백업 디스크 (`Storage · Backup disk`) | 마지막 세트 × 2 + `BACKUP_MIN_FREE_MB`보다 적으면 주황, 다음 실행이 들어갈 자리가 없으면 빨강입니다. "데이터와 같은 디스크"(`Same disk as the data`)는 디스크 하나에 둘 다 있다는 뜻입니다. | `BACKUP_KEEP_*`를 낮추거나, 백업 볼륨을 옮기거나, 외부 사본을 더하세요. |
| 저장 공간 · 데이터베이스 / 업로드 / 큰 페이지 (`Storage · Database / Uploads / Large pages`) | 현재 값만 보여 줍니다. 큰 페이지(상태 1 MiB 이상 또는 토큰 50k개 이상, docs/adr/1103-*)는 워크스페이스마다 그 워크스페이스 설정에 목록이 있습니다. | 긴 로그를 하위 페이지로 나누세요. |
| 앱 · 24시간 재시작 (`App · Restarts in 24 h`) | `DATA_DIR/status/boots.json`에서 셉니다. 정상 종료 없이 재시작한 일(OOM 강제 종료, 크래시, `docker kill`)이 한 번이라도 있거나 프로덕션 환경에서 정상 재시작이 3번이면 주황, 비정상 재시작이 3번이면 빨강(크래시 루프)입니다. 배포는 정상 재시작으로 셉니다. | `docker compose logs --tail 200 app`. 종료 코드 137은 메모리 부족입니다(2절). |
| 앱 · 24시간 오류 로그 (`App · Errors logged in 24 h`) | error/fatal 단계의 로그 기록 수입니다. 24시간에 10개면 주황, 한 시간에 50개면 빨강입니다. 개수만 남기고 내용은 남기지 않습니다. | `docker compose logs app \| grep '"level":50'`. |
| 앱 · 데이터베이스 스키마 (`App · Database schema`) | 데이터베이스에 적용된 마이그레이션과 이 서버에 들어 있는 마이그레이션을 비교합니다. 다르면 빨강입니다(예: 더 새 릴리스에서 만든 데이터베이스를 복원한 경우). | 그 데이터베이스를 마지막으로 쓴 릴리스로 업그레이드하세요("업그레이드" 절). |
| 앱 · 웹 푸시 (`App · Web push`) | 기기 수, 실패하는 기기 수, 24시간 동안 포기한 전송 수입니다(0.18). `WEB_PUSH=off`면 회색입니다. 24시간에 포기한 전송이 20개가 되거나 "보낼 수 없음: VAPID 키 문제 (…)"(`Cannot send: VAPID key problem (…)`)가 나오면 주황입니다. | 12절의 "웹 푸시": 서버에서 푸시 서비스로 나가는 연결, `APP_SECRET_KEY`, VAPID 환경 변수 한 쌍을 확인하세요. |
| 앱 · 데이터베이스 자동화 (`App · Database automations`) | 켜진 규칙, 대기 중인 실행, 24시간 동안 실패한 실행 수입니다(0.18). 규칙이 없으면 회색이고, 때가 된 실행이 15분 이상 기다리고 있으면 주황입니다("자동화 대기열이 밀려 있습니다"(`the automation queue is not keeping up`)). | 12절의 "데이터베이스 자동화와 버튼". 같은 동작을 되풀이하는 규칙이나 느린 웹훅이 있는지 보세요. |
| 보안 설정 (`Security settings`) | 프로덕션 환경에서 다음 중 하나면 주황입니다. `APP_SECRET_KEY`나 `PUBLIC_URL`이 없을 때, 쿠키가 `Secure`가 아닐 때, 누구나 가입할 수 있을 때(`SIGNUP_REQUIRE_KEY=0`, 또는 `OIDC_ALLOWED_DOMAINS` 없이 `OIDC_AUTO_CREATE=1`), 데이터베이스 비밀번호가 비었거나 사용자 이름과 같거나 흔한 기본값이거나 12자보다 짧을 때입니다(판단은 서버에서 하고 값은 보여 주지 않습니다). 암호화해 둔 비밀값이 있는데 `APP_SECRET_KEY`가 없어졌으면 빨강입니다. | 0절의 "처음 배포하기 전에". |
| 업데이트 (`Updates`) | `UPDATE_CHECK=github`가 아니면 회색입니다. 더 새 릴리스가 있으면 주황, 이 서버보다 새 릴리스 가운데 릴리스 노트에 "Security" 절이 있는 것이 있으면 빨강입니다(docs/adr/1232-*). | "업그레이드" 절. |

<a id="upgrades"></a>
### 업그레이드

릴리스는 여러 아키텍처용 이미지 `ghcr.io/prove1352/inkling:<X.Y.Z>`로 나옵니다(`X.Y`와 `latest` 태그도 있습니다. docs/adr/1050-*). 순서는 아래와 같고, compose 명령마다 쓰시는 `-f` 파일을 붙이세요.

```bash
./deploy/backup.sh                 # 1. backup (ends with "ok set=<id> ...")
git pull                           # 2. compose files and deploy scripts of the new release
#    optional: INKLING_VERSION=X.Y.Z (or X.Y) in .env to pin the release (empty = latest)
docker compose pull app            # 3. fetch the image
docker compose up -d app           # 4. restart; migrations run in one transaction at boot
docker compose logs --tail 50 app  #    check the migration result and "Server listening"
```

1번은 백업이고 "ok set=<id> ..."로 끝나야 합니다. 2번은 새 릴리스의 compose 파일과 배포 스크립트를 받습니다. 릴리스를 고정하고 싶으면 이때 `.env`에 `INKLING_VERSION=X.Y.Z`(또는 `X.Y`)를 넣으세요(비우면 latest). 3번은 이미지를 받고, 4번은 앱을 다시 띄웁니다. 마이그레이션은 부팅할 때 한 트랜잭션으로 돌고, 마지막 줄로 마이그레이션 결과와 "Server listening"을 확인합니다.

- 소스 빌드는 3–4번 대신 `compose.build.yaml`(또는 `compose.override.yaml`에 넣은 그 두 줄)을 쓰고 `up -d --build app`을 실행합니다([deploy/DEPLOY.ko.md](../deploy/DEPLOY.ko.md#image-or-source-build), docs/adr/1051-*).
- 소스 빌드에서 배포 이미지로 옮겨도 데이터는 바뀌지 않습니다. 다만 데이터베이스를 마지막으로 마이그레이션한 코드보다 오래된 릴리스는 받지 마세요. 최신 릴리스 이후의 `main`으로 빌드한 설치라면 다음 릴리스가 나올 때까지 기다려야 합니다.
- 이전 버전으로 내릴 수는 없습니다. 오래된 릴리스는 더 새 스키마를 모르기 때문입니다. 되돌리려면 1번에서 받은 백업을 복원하고 `INKLING_VERSION`을 예전 릴리스로 고정하세요.
  0.5.0부터는 이 점이 더 중요합니다. 페이지 상태를 Yjs V2로 쓰고 공유 링크, 초대 코드, 가입 키를 해시로 보관하는데, 0.4.x는 이것을 읽지 못합니다. 되돌린 뒤에도 최근 편집을 살려야 한다면 서버를 멈추고 `apps/server/scripts/states-to-v1.ts`를 실행하세요(먼저 `--dry-run`으로 해 보세요). 이때 기존 공유 링크, 초대 코드, 가입 키는 더 이상 쓸 수 없게 됩니다(docs/adr/1101-*, 1110-*).
- 모든 릴리스는 이미지를 내기 전에, 그 전의 모든 릴리스에서 데이터가 든 채로 업그레이드하는 테스트를 거칩니다(`.github/workflows/upgrade.yml`, docs/adr/1052-*).
- 0.14 → 0.15는 마이그레이션 4개를 적용합니다(`drizzle.__drizzle_migrations`의 행이 43개에서 47개로 늘어납니다): `0043_v015_slack`, `0044_wave13_forms`, `0045_wave13_verify_present_status`, `0046_wave13_team_agents`. 넷 다 테이블, nullable 열, 상수 기본값이 있는 열(Postgres 11 이상에서는 메타데이터만 바뀝니다), 값이 모두 NULL인 열의 인덱스를 더할 뿐이고, 기존 행을 채우는 작업(backfill)이 없어서 부팅 트랜잭션 안에서 돌려도 안전합니다. 꼭 넣어야 하는 새 환경 변수는 없습니다.
- 0.15 → 0.15.1은 마이그레이션 1개를 적용합니다(47 → 48행). `0047_v0151_index_stamp`는 nullable 열 `page_chunk_index.doc_updated_at`을 더하고, 기존 행은 `page_docs.updated_at` 값으로 채웁니다(UPDATE 한 번, 페이지마다 한 행). 그래서 첫 부팅 때 다시 색인하는 페이지가 없습니다. 0.15 프로세스가 정상 종료했다는 전제입니다(0.15는 SIGTERM을 받으면 대기 중인 색인 작업을 마저 처리합니다). `docker compose up -d app`은 그렇게 멈춥니다. 새로 생긴 선택 설정은 `SINGLE_INSTANCE`, `SINGLE_INSTANCE_WAIT`입니다(9절). 예전 서버와 동기화하던 볼트는 따로 할 일이 없습니다. 업그레이드 뒤 첫 `inklingctl sync`가 마지막 동기화 이후 바뀐 페이지를 다시 읽고, 로컬에서 고친 노트를 한 번 합칩니다. 이때 아무것도 덮어쓰지 않고 충돌로 표시하지도 않습니다(docs/adr/1920-*).
- 0.15.1 → 0.16은 마이그레이션 3개를 적용합니다(48 → 51행). `0048_wave16_taint`(테이블 `connection_taints`, 상수 기본값 `true`가 있는 열 `workspaces.agent_taint_demote`), `0049_wave16_agent_tokens`(상수 기본값 `'oauth'`가 있는 `oauth_grants.kind`, nullable `oauth_grants.token_prefix`), `0050_wave16_agent_uploads`(nullable `workspaces.agent_uploads`와 `files.uploaded_via`, 그리고 `uploaded_via`가 채워진 행만 담는 `files`의 부분 인덱스. 업그레이드 시점에는 그런 행이 없습니다)입니다. backfill은 없습니다. 이미지에 새 의존성 `unpdf` 1.9.1이 들어갑니다(순수 JavaScript라 시스템 패키지가 필요 없습니다). 새로 생긴 선택 설정은 `AGENT_UPLOADS`, `AGENT_UPLOAD_MAX_MB`, `AGENT_UPLOAD_DAILY_MB`입니다(10절). 업그레이드하고 나면 모든 워크스페이스에서, 의심스러운 텍스트를 읽은 에이전트는 한 시간 동안 제안만 할 수 있습니다(10절).
- 0.16 → 0.17은 마이그레이션 3개를 적용합니다(51 → 54행). `0051_v017_collection_rows`(상수 기본값 `0`이 있는 `collections.row_seq`, nullable `pages.row_number`, 외래 키가 걸린 `pages.edited_by`, `pages.edited_via`, 번호가 있는 행만 담는 `pages (parent_id, row_number)`의 부분 유니크 인덱스(업그레이드 시점에는 그런 행이 없습니다), ID 번호를 매기는 트리거 3개), `0052_page_link_sections`(nullable `page_links.sections`), `0053_v017_snapshot_steps`(nullable `page_snapshots.digest`와 `step`)입니다. backfill은 없습니다. 빈 인덱스를 만들고 새 외래 키를 확인하느라 부팅 트랜잭션 안에서 `pages`를 한 번 읽습니다. 새 의존성 `mermaid` 12.3.0은 웹 번들에만 들어갑니다(11절). 새로 생긴 선택 설정은 `INKLING_PORT`, `INKLING_DB_PORT`(compose)입니다. 이제 에이전트가 쓸 때마다 버전 행이 하나씩 저장되고(11절), zip 가져오기는 안전하지 않은 압축 파일을 거절하며, 계정이 하나도 없는 서버는 부팅할 때 설정 링크를 출력합니다.
- 0.17 → 0.18은 마이그레이션 5개를 적용합니다(54 → 59행). `0054_w18_web_push`(테이블 `push_subscriptions`, `push_vapid_keys`, `push_settings`), `0055_w18_automations`(`collection_automations`, `automation_runs`), `0056_offline_doc_gen`(`pages.doc_gen integer not null default 0`, 상수 기본값), `0057_workspace_listings`(`workspace_list_groups`, `workspace_listings`), `0058_row_number_tid`(트리거 함수 `inkling_row_number()`의 본문만 새로 씁니다. 테이블, 인덱스, 트리거 정의는 그대로입니다)입니다. backfill이 없어서 몇 밀리초면 끝납니다. 새 의존성은 없습니다. 새로 생긴 선택 설정은 `WEB_PUSH`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `WEB_PUSH_ALLOWED_HOSTS`, `OAUTH_CIMD`, `OAUTH_CIMD_ALLOWED_HOSTS`입니다(12절. `compose.yaml`이 그대로 넘겨 줍니다). 업그레이드한 뒤에는 이런 점을 챙기세요. 버튼 블록을 쓰기 전에 열려 있는 탭과 설치한 앱을 모두 새로고침하라고 사람들에게 알리세요(0.17 클라이언트가 버튼이 있는 페이지를 고치면 버튼이 지워집니다). 웹 푸시는 서버에서 푸시 서비스로 나가는 HTTPS 연결이 필요하고, 처음 쓸 때 VAPID 키를 만듭니다. `/push-sw.js`는 `no-cache`로 나갑니다(4절). 웹 클리퍼의 "본문 가져오기"(`Article text`)는 서버에서 밖으로 HTTP(S) 요청을 보냅니다. 프로세스마다 15분 간격의 자동화 타이머가 돕니다. 사람들이 무언가를 켜기 전까지 그 밖에 달라지는 것은 없습니다.
- 0.18 → 0.19는 compose를 다시 시작하기 전에 `.env`에 한 줄이 필요합니다. 기존 설치라면 `INKLING_DATA_NAME=nodian`입니다(아래 "0.19로 업그레이드하기" 참고). 그다음 원하면 `deploy/rename-from-nodian.sh`를 돌립니다. 마이그레이션은 2개를 적용합니다(`drizzle.__drizzle_migrations`의 행이 59개에서 61개로 늘어납니다). `0059_share_allow_download`는 `pages.share_allow_download boolean not null default false`를 더합니다(상수 기본값이라 메타데이터만 바뀌고 backfill 없이 몇 밀리초면 끝납니다). `0060_onboarding`은 `user_onboarding`을 만들고 기존 계정마다 `{"legacy": true}` 행을 하나씩 넣습니다(`users`에 대한 INSERT…SELECT 한 번). 새 의존성은 없습니다. 새 설정은 `INKLING_DATA_NAME`(필수)과 선택 설정 `ONBOARDING`, `ONBOARDING_EXISTING_USERS`입니다(13절). 0059만 적용된 상태에서 0.18.0으로 돌아갈 때는 복원이 필요 없었습니다. 0.18.0이 60행짜리 데이터베이스에서 그대로 시작했습니다(더해진 열에는 기본값이 있고 0.18.0은 그 열을 읽지 않습니다. 거의 빈 데이터베이스에서 확인했습니다. KNOWN-ISSUES SHARE-5). 0060까지 적용된 상태로는 다시 확인하지 않았습니다(ONBOARD-5).

- [ ] 먼저 손으로 백업을 받으세요: `./deploy/backup.sh`.
- [ ] 백업이 도는 시간(기본 03:00)에는 배포하지 마세요.
- [ ] 프로덕션 데이터베이스에 `drizzle-kit push`를 절대 돌리지 마세요(1절 참고).
- [ ] 앱 인스턴스는 하나만 둡니다. 알림, 시트 동기화, 웹훅 대기열, Hocuspocus 상태, 공개 폼 답변의 시간당 한도가 모두 프로세스마다 따로 있기 때문입니다. 0.15.1부터는 다른 Inkling 프로세스가 같은 데이터베이스를 쓰고 있으면 서버가 시작하지 않습니다(9절).
- [ ] 업그레이드한 뒤에는 부팅 로그에서 마이그레이션이 성공했는지, 켜진 실험 기능이 무엇인지 확인하세요.

<a id="upgrading-to-019-the-nodian--inkling-names"></a>
### 0.19로 업그레이드하기: nodian → inkling 이름

0.18까지는 compose 프로젝트, 볼륨, 데이터베이스 역할, 데이터베이스의 이름이 모두 프로젝트의 예전 이름인 `nodian`이었습니다. 0.19부터는 이 이름들을 `.env`의 `INKLING_DATA_NAME`에서 가져옵니다(docs/adr/2340-*). `inkling`으로 두면 프로젝트는 `inkling`, 볼륨은 `inkling_inkling-db`, `-data`, `-backups`, `-backup-ctl`, 역할과 데이터베이스는 `inkling`이 됩니다. `nodian`으로 두면 0.18과 똑같은 이름이 됩니다. 이 변수에는 기본값이 없습니다. 그래서 이 글을 읽지 않고 업그레이드해도 새 빈 볼륨으로 떠 버리는 일은 생기지 않습니다. 모든 compose 명령이 무언가를 만들거나 멈추기 전에 거절하고, 돌고 있던 스택은 그대로 돕니다.

```
error while interpolating name: required variable INKLING_DATA_NAME is missing a value: set INKLING_DATA_NAME
in .env: nodian if this server ran Inkling 0.18 or older (keeps its data), inkling for a new install. ...
```

방법은 두 가지이고, 둘 다 지원합니다.

1. **예전 이름을 그대로 쓰기**(데이터를 옮기지 않음): `.env`에 `INKLING_DATA_NAME=nodian`을 넣고 평소처럼 업그레이드합니다. 컨테이너, 볼륨, 백업이 모두 전과 같습니다. 적어도 1.0까지는 지원하고, 지원을 그만두게 되면 한 마이너 릴리스 앞서 CHANGELOG에 알립니다.
2. **새 이름으로 옮기기**: 1번을 마친 뒤 언제든 할 수 있습니다. 권장하는 순서는 업그레이드를 먼저 하고 확인한 다음 이름을 바꾸는 것입니다. 마이그레이션과 이름 바꾸기가 한꺼번에 일어나지 않게 하려는 것입니다.

```bash
./deploy/backup.sh
printf '\nINKLING_DATA_NAME=nodian\n' >> .env       # 1. keep the old names for the upgrade
git pull                                         #    (or copy the new release's files)
docker compose pull app && docker compose up -d  #    or `up -d --build` for source builds
./deploy/rename-from-nodian.sh --dry-run         # 2. plan: volumes, sizes, free disk, downtime
./deploy/rename-from-nodian.sh                   #    the rename (asks once)
```

블록의 1번은 업그레이드하는 동안 예전 이름을 유지하는 단계입니다. `git pull` 대신 새 릴리스 파일을 복사해도 되고, 소스 빌드라면 `up -d --build`를 씁니다. 2번의 `--dry-run`은 볼륨, 크기, 남은 디스크, 중단 시간 계획을 보여 주고, `--dry-run` 없이 돌리면 한 번 물어본 뒤 이름을 바꿉니다.

`deploy/rename-from-nodian.sh`는 다음 일을 합니다(docs/adr/2341-*). compose 파일은 평소에 쓰시는 것을 씁니다. override 파일은 평소처럼 읽히고, override가 없으면 `COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/…`처럼 넘겨 주세요.

- 앱을 멈추고(이때 열린 문서를 저장합니다), 백업 사이드카로 이름 바꾸기 전 백업을 받고(사이드카가 없으면 `./backups/rename-nodian-to-inkling/`에 `pg_dump`를 받습니다), 모든 테이블의 행 수를 적어 둔 뒤 스택을 멈춥니다(`down`. `-v`는 절대 쓰지 않습니다).
- 이름이 바뀌는 볼륨(데이터베이스, 데이터, 백업, 백업 제어, rclone 바이너리, Caddy 인증서)을 모두 새 이름의 볼륨으로 **복사**합니다. 예전 볼륨은 읽기만 하고, 바꾸거나 지우지 않습니다.
- 네트워크가 없는 임시 서버에서 복사본 안의 역할과 데이터베이스 이름을 바꾸고, `.env`의 `POSTGRES_PASSWORD`로 역할의 비밀번호를 다시 설정합니다(이름을 바꾸면 MD5 비밀번호가 지워지기 때문입니다. SCRAM 비밀번호였다면 남았을 것입니다). 소유권, 권한, 시퀀스, `pg_trgm` 확장은 역할을 따라갑니다. 행 수가 그대로여야 합니다.
- `.env`의 값을 `INKLING_DATA_NAME=inkling`으로 바꾸고(예전 `.env`의 사본은 `./backups/rename-nodian-to-inkling/env.before`에 남습니다), 같은 이미지로 스택을 띄운 다음 `/api/health/ready`, 마이그레이션, 계정, 페이지, 컬렉션 행, 공유 링크, 파일을 확인하고 새 역할로 백업을 하나 받아 봅니다.

중단 시간은 앱 정지, 덤프, 복사, 부팅을 합친 만큼입니다. 덤프가 65 MB인 서버라면 1분쯤 걸리고, `--dry-run`이 내 서버의 예상치를 알려 줍니다. 볼륨 사본과 덤프 하나가 들어갈 공간이 필요하고, 남은 공간이 볼륨 크기의 두 배보다 적으면 경고합니다. 중간에 끊겼거나 실패했으면 다시 실행하세요. 하던 곳부터 이어서 합니다. 끝난 뒤를 포함해 언제든 `./deploy/rename-from-nodian.sh --rollback`으로 예전 이름으로 돌아갈 수 있습니다(그 사이 새 이름으로 쓴 내용은 예전 볼륨에 없습니다). 며칠 동안 문제가 없으면 스크립트가 출력한 `docker volume rm …` 줄로 예전 볼륨을 지우세요.

그 밖에 알아 둘 점:
- 로컬 체험(`deploy/local.sh`)은 따로 할 일이 없습니다. 새 `local.sh`가 자기가 쓴 `.env`에 `INKLING_DATA_NAME=nodian`을 넣어 줍니다. 거기서 `local.sh`를 한 번도 돌리지 않고 그냥 `docker compose`를 먼저 실행하면 다른 곳과 마찬가지로 이 줄을 넣으라고 나옵니다.
- `COMPOSE_PROJECT_NAME`이나 `-p`는 계속 쓸 수 있습니다. 프로젝트 이름은 정하신 그대로이고 볼륨, 역할, 데이터베이스 이름만 바뀝니다.
- 예전 볼륨 키(`nodian-data:/…`)를 쓰는 override는 새 키(`data`, `db`, `backups`, `backup-ctl`, `rclone-bin`)로 고쳐야 합니다. 고치기 전까지 compose가 "undefined volume"을 냅니다. 스크립트가 그런 줄을 찾아서 보여 줍니다.
- `.env`의 `POSTGRES_USER`/`POSTGRES_DB`는 compose가 예전에도 읽지 않았고 지금도 읽지 않습니다. 지우세요.
- 컨테이너를 이름(`nodian-backup-1`, `nodian-app-1`)으로 부르는 cron 줄이나 다른 스택은 새 이름(`inkling-backup-1`, …)으로 고쳐야 합니다. rclone 원격 경로(`BACKUP_RCLONE_REMOTE`)는 바뀌지 않습니다.
- 예전 서버에 실수로 `inkling`을 넣었다면 compose가 손대지 않은 예전 볼륨 옆에 빈 `inkling` 프로젝트를 띄웁니다. `INKLING_DATA_NAME=nodian`으로 되돌리고 `docker compose -p inkling down`, `docker compose up -d`를 실행한 다음 빈 `inkling_inkling-*` 볼륨을 지우세요.
- Docker를 sudo로 돌리는 서버라면 이름 바꾸기 스크립트도 compose를 돌리는 방식 그대로 `sudo ./deploy/rename-from-nodian.sh --dry-run`처럼 실행하세요. 스크립트는 `.env`를 그 자리에서 고치고(소유자와 권한은 유지), 상태 파일은 `./backups/rename-nodian-to-inkling/` 아래에 씁니다(sudo로 돌리면 root 소유가 됩니다). 위의 `printf … >> .env` 줄은 `.env`에 쓸 권한이 있는 셸에서 돌려야 합니다. 파일이 root 소유라면 `sudo sh -c "printf '\nINKLING_DATA_NAME=nodian\n' >> .env"`로 하세요.

<a id="client-updates"></a>
### 클라이언트 업데이트

열려 있는 탭은 모든 `/api` 응답에 붙는 `X-Inkling-Build` 헤더를 보고 새 배포를 알아챕니다(웹 빌드가 `WEB_DIST/build.json`에 적어 둔 id입니다. docs/adr/0990-*). 그때 탭이 어떻게 할지는 아래 값으로 정합니다.

| 환경 변수 | 값 | 기본값 | 효과 |
|---|---|---|---|
| `UPDATE_MODE` | `prompt`, `force` | `prompt` | `prompt`: 모든 화면에 "새 버전이 있습니다 · 새로고침"(`A new version is available · Reload`) 배너를 띄웁니다. `force`: 그 탭의 문서 편집을 서버가 받았다고 확인했고, 진행 중인 요청이 없고, 사용자가 3초 동안 아무것도 하지 않으면 탭이 저절로 새로고침합니다. 예전 번들로 막 연 탭은 바로 새로고침합니다. 2분 동안 안전한 때가 오지 않거나 자동 새로고침을 막 한 뒤라면 대신 배너를 보여 줍니다(docs/adr/0991-*, 0992-*). |
| `UPDATE_CHECK` | `github` 또는 비움 | 비움(꺼짐) | 하루 한 번(관리자가 그날 처음 들어올 때) 서버 버전을 GitHub의 최신 릴리스와 비교해서, 관리자 화면에 "Inkling X.Y.Z is available"을 보여 줍니다. 요청에는 저장소 경로만 들어가고 이 인스턴스에 관한 정보는 아무것도 보내지 않습니다(docs/adr/0994-*). |
| `UPDATE_CHECK_REPO` | `owner/name` | `PROVE1352/inkling` | `UPDATE_CHECK=github`일 때 확인할 저장소입니다. |
| `INKLING_BUILD` | 빌드 인자 / 환경 변수 | 빌드 때 정해진 해시 | Docker에서는 `docker build --build-arg INKLING_BUILD=$(git rev-parse --short HEAD) .`로 빌드에 이름표를 붙입니다. 실행 중에는 `WEB_DIST`에 `build.json`이 없을 때만 대신 쓰입니다. |

- [ ] `GET /api/version`은 `{ build, version, updateMode }`를 돌려줍니다. `curl -sI <url>/api/health | grep -i x-inkling-build`로 서버가 알리는 id를 볼 수 있습니다.
- [ ] 리버스 프록시나 CDN이 `X-Inkling-Build`를 지우거나 `/api/*`를 캐시하면 안 됩니다.
- [ ] 바뀐 것 없이 다시 빌드해도 새 id(시간 기반)가 생기고 "새 버전" 알림이 한 번 뜹니다. 이를 피하려면 `INKLING_BUILD`를 넘기세요.

<a id="backup-and-restore"></a>
### 백업과 복원

- [ ] 복원은 CLI로만 합니다. 먼저 `./deploy/restore.sh --dry-run <set>`을 실행하세요. 자세한 내용은 [BACKUP.ko.md](BACKUP.ko.md)에 있습니다.
- [ ] 적어도 분기에 한 번은 버려도 되는 환경에 실제로 복원해 보세요.

<a id="accounts"></a>
### 계정

- 관리자가 계정을 강제로 지우면 그 사용자의 개인 페이지는 소유자 없이 휴지통으로 갑니다. 관리자를 포함해 아무도 볼 수 없고, 30일 뒤 완전히 지워집니다. 그 사용자가 어떤 워크스페이스의 유일한 소유자라면 409로 거절되니, 소유권을 먼저 넘기세요.
- 이 동작이 생기기 전의 예전 버전에서 만들어진, 소유자 없는 개인 페이지는 계속 숨겨진 채로 남고 지워지지 않습니다.

- OpenID Connect: 한 사람이 연결한 로그인은 `user_identities`(발급자, subject, 사용자)에 들어 있습니다. 앱에는 아직 "연결 끊기"가 없으니, 잘못 연결된 것은 `DELETE FROM user_identities WHERE user_id = '<id>' AND issuer = '<issuer>'`로 지우세요. `OIDC_ISSUER`를 바꿔도 기존 연결은 옮겨지지 않습니다. 사람들이 설정 › 계정(`Settings › Account`)에서 다시 연결하거나, `OIDC_LINK_EXISTING=1`이면 확인된 이메일로 연결됩니다.

<a id="incidents"></a>
### 장애 대응

- [ ] 데이터베이스가 내려갔거나 디스크가 가득 찼을 때: 앱을 먼저 멈추고, 데이터베이스나 디스크를 고친 다음 앱을 띄우세요.
- [ ] OOM으로 강제 종료됐을 때(종료 코드 137): 큰 가져오기, 내보내기, 복제가 한꺼번에 돌았는지 보세요.
- [ ] 메모리 대기열에 있던 웹훅 전송은 재시작하면 사라집니다.

<a id="1-postgresql-tuning"></a>
## 1. PostgreSQL 튜닝

모든 설정은 `compose.yaml`의 `db` 서비스가 `-c` 인자로 넘기고, `.env`에서 바꿀 수 있습니다. 기본값을 작게 잡아 두어서 램 1 GB 호스트에서도 전체 스택이 들어갑니다.

| 변수 | 기본값 | 다른 서비스와 함께 쓰는 4코어 / 24 GB ARM VM에서의 예 |
|---|---|---|
| `PG_MEM_LIMIT` | `512m` | `2g` |
| `PG_SHARED_BUFFERS` | `128MB` | `512MB`(컨테이너 한도의 약 25%) |
| `PG_EFFECTIVE_CACHE_SIZE` | `384MB` | `1536MB`(shared_buffers + 컨테이너가 쥐고 있을 수 있는 페이지 캐시) |
| `PG_WORK_MEM` | `4MB` | `16MB`(정렬·해시 노드마다 씁니다. 앱 연결은 10개) |
| `PG_MAINTENANCE_WORK_MEM` | `64MB` | `128MB` |
| `PG_RANDOM_PAGE_COST` | `1.1` | `1.1`(블록 볼륨이 SSD 기반이라서) |
| `PG_EFFECTIVE_IO_CONCURRENCY` | `100` | `100` |
| `PG_SHM_SIZE` | `128m` | `256m` |
| `PG_PRELOAD_LIBRARIES` | *(비어 있음)* | 원인을 조사하는 동안 `pg_stat_statements` |

알아 둘 점
- `shared_buffers`와 `shared_preload_libraries`는 `docker compose up -d db`(컨테이너 재시작)를 해야 바뀝니다. 나머지는 `ALTER SYSTEM` + `SELECT pg_reload_conf()`로 돌고 있는 채로도 바꿀 수 있지만, 다음에 재시작하면 compose 인자 값이 이깁니다.
- 컨테이너의 페이지 캐시도 `mem_limit`에 들어갑니다. `effective_cache_size`는 `PG_MEM_LIMIT`에서 `shared_buffers`를 뺀 값을 넘지 않게 두세요. 위 표의 두 열이 모두 딱 그 값입니다(`512m` − `128MB` = `384MB`, `2g` − `512MB` = `1536MB`). 그렇지 않으면 플래너는 cgroup이 결국 비워 버릴 캐시까지 있다고 보고 계획을 세웁니다.
- `db`에 자체 `command:`를 정의한 `compose.override.yaml`을 쓰면 여기 있는 명령이 통째로 바뀝니다. 그럴 때는 위 플래그들을 그 파일에 합쳐 넣으세요.

<a id="query-statistics-opt-in"></a>
### 쿼리 통계 (켜야 동작)

```sh
# .env
PG_PRELOAD_LIBRARIES=pg_stat_statements
docker compose up -d db
docker compose exec db psql -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
```

`# .env` 바로 아래 줄은 `.env`에 넣는 값이고, 나머지 두 줄은 셸에서 실행합니다.

전체 실행 시간이 긴 쿼리 순서로 보기:

```sql
SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       rows / greatest(calls, 1) AS rows_per_call, left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
-- reset: SELECT pg_stat_statements_reset();
```

통계를 비우려면 블록 마지막 주석에 있는 `SELECT pg_stat_statements_reset();`을 실행하세요.

<a id="is-the-working-set-in-memory"></a>
### 자주 쓰는 데이터가 메모리에 있나요?

```sql
-- Buffer cache hit ratio per database (aim for > 0.99 once warm)
SELECT datname, blks_hit, blks_read,
       round(blks_hit::numeric / nullif(blks_hit + blks_read, 0), 4) AS hit_ratio
FROM pg_stat_database WHERE datname = current_database();

-- Per table (heap + index)
SELECT relname,
       round(heap_blks_hit::numeric / nullif(heap_blks_hit + heap_blks_read, 0), 4) AS heap_hit,
       round(idx_blks_hit::numeric / nullif(idx_blks_hit + idx_blks_read, 0), 4)   AS idx_hit
FROM pg_statio_user_tables ORDER BY heap_blks_read + idx_blks_read DESC LIMIT 15;

-- Database size vs shared_buffers
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, current_setting('shared_buffers');
```

세 쿼리는 차례로 데이터베이스의 버퍼 캐시 적중률(캐시가 데워진 뒤에는 0.99를 넘는 것이 목표입니다), 테이블별 적중률(힙과 인덱스), 데이터베이스 크기와 `shared_buffers`를 보여 줍니다.

<a id="hot-updates-fillfactor"></a>
### HOT 업데이트 (fillfactor)

마이그레이션 0024는 `pages`에 `fillfactor = 85`, `page_docs`에 `90`을 걸어서, 자주 일어나는 `updated_at` 갱신이 HOT 업데이트(인덱스를 다시 쓰지 않는 업데이트)가 될 수 있게 합니다. 이미 있던 힙 페이지는 다시 쓰기 전까지 빽빽하게 찬 채로 남습니다. 아래 쿼리로 확인해 보고, 원하면 한가한 때 한 번 다시 쓰세요(작은 테이블이면 몇 초 동안 배타 잠금을 잡습니다).

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(n_tup_hot_upd::numeric / nullif(n_tup_upd, 0), 3) AS hot_ratio
FROM pg_stat_user_tables WHERE relname IN ('pages', 'page_docs');

VACUUM (FULL, ANALYZE) pages;   -- optional one-time rewrite
```

`VACUUM (FULL, ANALYZE) pages;`는 한 번만 하면 되는 선택 작업입니다.

5k 페이지짜리 시드 데이터로 재 보니 HOT 비율이 0.1%였다가, `fillfactor = 85`를 걸고 다시 쓴 뒤 91%가 되었습니다.

<a id="never-drizzle-kit-push-against-production"></a>
### 프로덕션 데이터베이스에 `drizzle-kit push`를 쓰지 마세요

push는 돌고 있는 데이터베이스를 `schema.ts`와 비교해서, 거기 선언되지 않은 것은 지워 버립니다. 손으로 만든 trigram 인덱스와 "perf" 인덱스가 실제로 한 번 이렇게 지워졌습니다. 마이그레이션 0024부터는 이 인덱스들을 스키마에 선언해 두고 `IF NOT EXISTS`로 다시 만듭니다. 언제나 생성된 마이그레이션(`pnpm db:generate`, 부팅할 때 적용)을 쓰세요.

<a id="2-node-process"></a>
## 2. Node 프로세스

- `APP_MEM_LIMIT`(기본 `768m`)와 `NODE_OPTIONS`(기본 `--max-old-space-size=512`): 힙 상한은 컨테이너 한도의 65% 정도로 두세요. Buffer, Yjs 문서, 코드는 V8 힙 밖에 있습니다.
- `UV_THREADPOOL_SIZE`(기본 4)는 argon2 해시, 파일 스트리밍, zlib이 함께 씁니다. 로그인과 큰 업로드가 자주 겹친다면 `8`을 고려해 보세요.
- 스트리밍 가져오기·내보내기는 `DATA_DIR/tmp`(부팅할 때마다 비웁니다)를 쓰고, 올라오는 중인 업로드는 `DATA_DIR/uploads/.upload-*`에 둡니다. 남은 디스크 공간은 가장 큰 가져오기·내보내기보다 크게 유지하세요(폴더 가져오기는 50 MB 이하, zip 내보내기는 첨부 파일 300 MB 이하).

<a id="3-in-process-caches-and-maps-single-instance"></a>
## 3. 프로세스 안의 캐시와 맵 (단일 인스턴스)

| 위치 | 내용 | 한도 | 만료 / 무효화 |
|---|---|---|---|
| `linkPreview.ts` | URL → 미리보기 카드 | LRU 1,000개 | 6시간(실패한 것은 10분) |
| `routes/query.ts` | 사용자별 쿼리 블록 결과 | LRU 200개 | 60초. 키에 워크스페이스 버전과 색인 epoch가 들어갑니다 |
| `routes/public.ts` | 공개 페이지 HTML / 허용된 파일 id | 200개 + 32 MB / 500개 + 8 MB | 10분. 키에 `pages.updated_at`이 들어갑니다. 토큰·범위 확인을 통과한 뒤에 조회합니다 |
| `docIndexer.ts` | 대기 중인 색인 작업 / 변경 서명 | 대기 200개 / 서명 2,000개 | 8–30초 디바운스 / TTL 10분. 종료할 때 마저 처리합니다 |
| `snapshotStore.ts` | 페이지별 마지막 자동 스냅샷 시각 | LRU 5,000개 | 10분 간격 제한 확인을 건너뛰는 데만 씁니다 |
| `webhooks.ts` | 전송 대기열, 워크스페이스별 카운터 | 작업 5,000개(워크스페이스당 200개) | 재시작하면 사라집니다(의도한 동작) |
| `guard.ts` | 로그인 실패 카운터 / IP 차단 | 맵마다 20,000개 / 차단은 만료될 때까지 | 5분마다 정리합니다. 재시작하면 초기화됩니다 |
| `collab.ts` | IP별 소켓 수와 업그레이드 시각 | IP가 1,024개를 넘으면 정리 | 10초 구간 |
| `hocuspocus.documents` | 열려 있는 Yjs 문서 | 열려 있는 문서 수만큼 | 마지막 클라이언트가 나가면 내립니다 |
| `context/contextCache.ts` | 사람별 find_context 결과(ADR 1550), 단일 쿼리와 합친 묶음(ADR 1721) | LRU 1,000개 + 32 MB(함께 씀) | 5분. 키에 검색한 모든 워크스페이스의 접근 버전, 페이지 표식, 섹션 색인 epoch가 들어갑니다. 묶음 키에는 쿼리 목록, 추가 순위 목록의 digest가 더 들어가고, 의미 검색이 켜져 있으면 워크스페이스마다 벡터 epoch도 들어갑니다(ADR 1723) |
| `context/semantic.ts` | 의미 검색 전용(기본 꺼짐): 워크스페이스별 청크 벡터, 쿼리 벡터(ADR 1741) | 모든 워크스페이스를 합쳐 `EMBEDDING_CACHE_MB`(128 MB), 여기 들어가지 않는 워크스페이스는 SQL에서 점수를 매깁니다 / 쿼리 벡터 256개 | 첫 쿼리 때 불러오고 색인기가 쓴 뒤 갱신 / 10분 |
| `context/embeddings.ts`, `semanticIndexer.ts` | 엔드포인트 상태와 재시도 대기(backoff), 거절된 청크(ADR 1742) | 상태 하나 / 거절된 청크 해시 10,000개 | 대기 5초 → 10분. 거절된 청크는 재시작할 때까지 |
| `connectionUsage.ts` | 연결별, (워크스페이스, 연결)별 사용량(ADR 1552) | LRU 5,000 + 20,000개 | 재시작하면 사라집니다(의도한 동작) |
| `context/changeWait.ts` | 기다리고 있는 changes_since 호출(ADR 1551) | 프로세스당 256개, 연결당 4개 | 각각 25초. 종료할 때 풀어 줍니다 |
| `slack/config.ts` | 알림 소비자가 쓰는 워크스페이스별 Slack 설정(ADR 1802) | 워크스페이스 10,000개 | 60초. 설정을 저장하거나 지우면 버립니다 |
| `routes/forms.ts` | 폼별 최근 한 시간의 공개 폼 답변(ADR 1822) | 폼 5,000개, 가장 오래된 것부터 잊음 | 한 시간 이동 구간. 재시작하면 사라집니다 |

세션, 멤버십, 페이지 공개 범위를 담아 두는 캐시는 없습니다. 이것들은 요청마다 데이터베이스에서 읽습니다. find_context 캐시에 들어 있는 것은 권한이 아니라 답입니다. 키에 워크스페이스 접근 버전과 그 사람의 권한을 정하는 값들이 들어 있어서, 멤버십, 잠금, 차단, 공개 범위가 바뀌면 다음 호출은 처음부터 다시 검색합니다. 오래 유지되는 권한은 열려 있는 협업 소켓 하나뿐인데, 이것도 멤버를 내보낼 때, 페이지가 개인 페이지로 바뀔 때, 강제 삭제할 때, 비밀번호를 바꾸거나 세션을 끊을 때 회수합니다(`liveConnections.ts`, ADR 0754).

<a id="4-http-caching"></a>
## 4. HTTP 캐싱

- `assets/*`, `workbox-*.js`: `public, max-age=31536000, immutable`. `index.html`, `sw.js`, `push-sw.js`(0.18. 서비스 워커가 이 파일을 import하는데, 워커를 갱신할 때 import는 HTTP 캐시를 거칩니다), `registerSW.js`, `manifest.webmanifest`, SPA 경로: `no-cache`. 그 밖의 정적 파일: 하루.
- API: 기본은 `private, no-store`입니다. 큰 GET(페이지 트리, 그래프, 마감 목록, 컬렉션)은 약한 ETag와 `private, no-cache`를 달고, `If-None-Match`가 오면 실제 작업을 하기 전에 304로 답합니다. 그 밖에 1 KB 이상인 GET JSON에는 내용 해시로 만든 ETag가 붙습니다.
- 압축은 Caddy(`encode gzip zstd`)에서만 합니다. 프록시를 거쳐 빠르게 확인하는 방법은 다음과 같습니다.

```sh
curl -sI --compressed -H "cookie: inkling_sid=…" https://<host>/api/workspaces/<id>/pages | grep -i 'etag\|cache-control\|content-encoding'
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: <etag from above>' -H "cookie: inkling_sid=…" https://<host>/api/workspaces/<id>/pages   # 304
```

<a id="5-semantic-search-optional"></a>
## 5. 의미 검색 (선택)

`EMBEDDING_URL`과 `EMBEDDING_MODEL`을 둘 다 넣어야 켜집니다(docs/adr/1740-*). 켜면 서버가 모든 섹션 청크의 글(페이지 제목, 헤딩 경로, 청크 본문)을 바뀔 때마다 한 번씩 그 엔드포인트로 보내고, find_context가 뜻으로도 섹션 순위를 매깁니다. 호스팅 제공자를 쓰면 그곳은 제3자입니다. 노트가 이 기계 밖으로 나가면 안 된다면 로컬 모델 서버를 쓰세요. 꺼 두면 이 기능에 속한 것은 아무것도 돌지 않습니다. 요청도, 타이머도, 쿼리도 없습니다.

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `EMBEDDING_URL` | — | OpenAI 호환 API의 기본 URL(`https://api.openai.com/v1`, Ollama는 `http://host:11434/v1`, text-embeddings-inference는 `http://tei:8080/v1`) 또는 `…/embeddings`까지 적은 전체 URL |
| `EMBEDDING_MODEL` | — | 모델 이름입니다. 벡터마다 함께 저장되므로, 바꾸면 전부 다시 임베딩합니다 |
| `EMBEDDING_API_KEY` | 없음 | `Authorization: Bearer …`로 보냅니다. 로그나 화면에는 나오지 않습니다 |
| `EMBEDDING_DIMENSIONS` | 모델 기본값 | `dimensions`로 보냅니다(벡터 길이를 줄일 수 있는 모델용, 예: text-embedding-3-*) |
| `EMBEDDING_BATCH_SIZE` | 32 | 요청 하나에 담는 청크 수(1–256) |
| `EMBEDDING_REQUESTS_PER_MINUTE` | 60 | 색인기의 요청 속도입니다. 요청은 한 번에 하나씩만 보냅니다 |
| `EMBEDDING_TIMEOUT_MS` | 30000 | 색인기 요청의 타임아웃 |
| `EMBEDDING_QUERY_TIMEOUT_MS` | 3000 | 검색마다 한 번 하는 쿼리 임베딩의 타임아웃입니다. 시간을 넘기면 단어 검색으로만 답합니다 |
| `EMBEDDING_MAX_CHARS` | 4000 | 청크 하나에서 모델로 보내는 글자 수 |
| `EMBEDDING_CACHE_MB` | 128 | 쿼리에 쓰는 프로세스 안 벡터 캐시입니다. 여기 들어가지 않는 워크스페이스는 SQL에서 점수를 매깁니다(더 느림) |
| `EMBEDDING_QUERY_PREFIX` | 비어 있음 | 모든 검색 쿼리 앞에 붙이는 역할 접두어(0.20, docs/adr/2404-*) |
| `EMBEDDING_PASSAGE_PREFIX` | 비어 있음 | 임베딩하러 보내는 모든 섹션 앞에 붙이는 역할 접두어(0.20) |

`EMBEDDING_QUERY_PREFIX` / `EMBEDDING_PASSAGE_PREFIX`는 역할 접두어를 붙여 학습한 모델을 위한 설정입니다. e5라면 `EMBEDDING_QUERY_PREFIX="query: "`, `EMBEDDING_PASSAGE_PREFIX="passage: "`로 두고, 끝의 공백이 남도록 `.env`에서 따옴표로 감싸세요. 벡터는 모델 이름에 접두어의 짧은 해시를 붙인 이름으로 저장됩니다. 그래서 접두어를 넣거나 바꾸거나 빼면 모델을 바꿨을 때와 똑같이 모든 섹션을 다시 임베딩하고, 정리 작업이 예전 벡터를 지웁니다. 관리자 상태 화면에는 계속 모델 이름이 나옵니다. 0.20에서 이 접두어를 붙인 `multilingual-e5-small`을 재 봤지만 쓰지 않기로 했습니다. 질문 묶음에 따라 page@1이 오르기도 하고 내리기도 했고, 답의 토큰은 1.7배에서 7.5배까지 늘었습니다(docs/PERFORMANCE.md의 "Rejected / no effect").

`compose.yaml`이 열두 개를 모두 넘겨 주므로 `.env`에 적기만 하면 됩니다(예시는 `.env.example`에 있습니다). 반만 채운 설정(URL만 있고 모델이 없거나 그 반대)은 꺼진 채로 있고 부팅 때 경고를 한 번 남깁니다. 한국어와 영어가 섞인 노트에는 다국어 모델이 가장 잘 맞습니다(예: `bge-m3`, `multilingual-e5-large`, `text-embedding-3-small`).

Docker: 컨테이너 안에서 `localhost`는 컨테이너 자신입니다. Docker 호스트에서 도는 Ollama를 쓰려면 `http://host.docker.internal:11434/v1`(Docker Desktop)이나 호스트의 LAN 주소를 넣고, Ollama가 그 주소에서 요청을 받도록 하세요(`OLLAMA_HOST=0.0.0.0`). 다른 곳으로 리다이렉트하는 `EMBEDDING_URL`(예: http → https)은 거절되고 "connection failed"로 보고됩니다. 최종 URL을 넣으세요.

- **켜졌을 때 부팅 로그:** `[inkling] semantic search: on — model <model> at <scheme://host/path>, 32 chunks/request, 60 requests/min`.
- **처음 채우기:** 마이그레이션 0042가 `page_chunk_vectors`를 만듭니다. 처음 켜면 색인기가 살아 있는 모든 청크를 백그라운드에서 임베딩하고(그 뒤로는 바뀐 청크만 합니다), 그동안 검색은 이미 임베딩된 것만으로 답합니다.
- **엔드포인트 실패:** 새로운 오류가 날 때마다 `[inkling] semantic index: <host/path>: <reason>; retrying later` 한 줄을 남기고, 요청 간격을 5초에서 10분까지 늘립니다. 그동안 검색은 단어로만 답하고, 저장에는 전혀 영향이 없습니다. 엔드포인트가 그 청크만 따로 거절하면(400/413/422) 재시작할 때까지 그 청크를 건너뜁니다. 모델의 컨텍스트가 작다면 `EMBEDDING_MAX_CHARS`를 낮추세요.
- **진행 상황:** 관리자 › 서버 상태(`Admin › Server status`)에 "의미 검색"(`Semantic search`)이 나옵니다(색인된 섹션 / 기다리는 섹션, 거절된 청크, 마지막 오류, 대기가 끝나는 시각). `GET /api/admin/status` → `semantic`으로도 볼 수 있습니다(docs/API.md, 개수는 30초 캐시).
- **find_context:** 쿼리마다 의미 후보를 최대 8개 받는데, 가장 좋은 후보의 코사인 값에 0.6을 곱한 값 이상인 것만 받습니다(`context/semanticFind.ts`). 이 후보들을 단어 검색 결과와 RRF로 합칩니다(docs/adr/1723-*).
- **메모리:** 평소 프로세스 메모리(2절)에 더해 `EMBEDDING_CACHE_MB`(기본 128 MB)만큼을 잡아 두세요.
- **헬스체크:** `/api/health`와 `/api/health/ready`는 임베딩 엔드포인트와 상관없이 동작합니다.
- **백업:** `page_chunk_vectors`는 데이터베이스 덤프에 들어갑니다. 다른 데이터에서 다시 만들 수 있는 데이터이므로, 덤프 전에 비우면 공간을 아낄 수 있습니다(백그라운드에서 다시 만듭니다).
- **끄기:** 변수를 지우고 재시작합니다. 테이블은 남지만 읽는 곳이 없고, `TRUNCATE page_chunk_vectors;`로 공간을 비울 수 있습니다. 다시 켜면 바뀐 것만 임베딩합니다.
- **모델 바꾸기:** `EMBEDDING_MODEL`을 바꾸고 재시작합니다. 모든 청크를 백그라운드에서 다시 임베딩하고, 10분마다 도는 정리 작업이 예전 모델의 행을 지웁니다.
- **규모:** 쿼리 시간은 검색하는 워크스페이스의 청크 수에 따라 늘어납니다(캐시된 768차원 벡터 2,700개당 약 10 ms, docs/PERFORMANCE.md). 워크스페이스당 청크가 50k개쯤을 넘으면 pgvector(docs/adr/1214-*)로 옮기는 것이 해결책일 것입니다(docs/KNOWN-ISSUES.md).

<a id="6-slack-app-per-workspace"></a>
## 6. Slack 앱 (워크스페이스마다)

Inkling 워크스페이스마다 자기 Slack 앱을 연결할 수 있습니다(docs/adr/1800-*). 중앙에서 운영하는 Inkling 앱은 없고 `.env`에 넣는 Slack 설정도 없습니다. 워크스페이스 소유자가 자기 Slack 워크스페이스에 앱을 만들고 그 인증 정보를 붙여 넣습니다.

1. `PUBLIC_URL`(링크 미리보기와 `/inkling link` URL에 필요합니다)과 `APP_SECRET_KEY`를 넣으세요. `APP_SECRET_KEY`가 없으면 토큰과 비밀값이 암호화되지 않은 채 저장되고, 설정 화면에 경고가 나옵니다.
2. Inkling에서 워크스페이스 설정 → Slack(`Workspace settings → Slack`, 소유자만)을 열고 매니페스트(JSON)를 복사합니다.
3. https://api.slack.com/apps 에서 `Create New App` → `From an app manifest` → Slack 워크스페이스 선택 → 매니페스트 붙여 넣기 → `Create` 순서로 누릅니다. Slack이 어떤 항목을 받아 주지 않으면 페이지에 나온 값으로 앱을 직접 만드세요. 슬래시 명령 `/inkling`과 그 명령 URL, 봇 이벤트 `link_shared`, `app_uninstalled`, `tokens_revoked`를 넣은 `Event Subscriptions` 요청 URL, `PUBLIC_URL`의 호스트로 정한 `App unfurl domain`, 봇 스코프 `chat:write chat:write.public commands links:read links:write users:read users:read.email`을 넣으면 됩니다.
4. `Install to Workspace`를 누릅니다. **OAuth & Permissions → Bot User OAuth Token**(`xoxb-…`)과 **Basic Information → Signing Secret**을 복사합니다.
5. Inkling으로 돌아와 둘을 붙여 넣고, 채널 **ID**(채널 세부정보 맨 아래의 `C…`)를 넣고, 보낼 업데이트를 고른 뒤 저장합니다(이때 Inkling이 `auth.test`를 호출합니다). 비공개 채널이라면 먼저 그 채널에서 `/invite @<app name>`을 실행하세요.
6. 테스트 메시지 보내기를 누릅니다. `not_in_channel`이 나오면 봇을 채널에 초대하고, `invalid_auth`가 나오면 토큰이 틀린 것입니다.
7. 멤버들은 `/inkling help`를 쳐 봅니다. Slack 이메일과 Inkling 이메일이 다르면 `/inkling link`를 씁니다.

Slack은 매니페스트로 앱을 만들 때, 토큰과 비밀값이 Inkling에 저장되기도 전에 `Event Subscriptions` URL을 확인합니다. Inkling은 앱이 아직 저장되지 않은 워크스페이스라도 살아 있는 워크스페이스라면 이 첫 확인에 답합니다. 그래도 Slack에 URL이 확인되지 않았다고 나오면, 5단계를 마친 뒤 `Event Subscriptions`를 열고 `Retry`를 누르세요.

- **실패한 게시:** outbox 토픽은 `slack`입니다. 실패한 작업은 `state = 'dead'`로 끝나고 `last_error`에 Slack의 오류 코드가 남습니다: `SELECT state, last_error, count(*) FROM outbox WHERE topic = 'slack' GROUP BY 1, 2;`
- **멈춘 게시:** 토큰이 취소됐거나 봇이 채널에서 빠지면 설정 화면에 `blocked_reason`으로 나옵니다. 설정을 저장하거나 테스트가 통과하면 다시 보냅니다.
- **정기 정리(매시간):** 일일 요약을 대기열에 넣고(현지 날짜로 하루 한 번), `slack_request_nonces`(15분보다 오래된 것)와 만료된 `slack_link_codes`를 지웁니다.
- **토큰이나 비밀값 바꾸기:** 새 값을 붙여 넣고 저장합니다. 비워 둔 칸은 저장된 값을 그대로 둡니다. `APP_SECRET_KEY`를 잃었거나 바꿨다면 저장된 값을 읽을 수 없으니 다시 넣어야 합니다.
- **연결 끊기**는 계정 연결, 계정 연결 코드, 대기 중인 Slack 작업을 지웁니다. 앱 자체는 Slack에서 지웁니다.
- **에이전트 연결에 넘긴 일**은 채널에 올리지 않습니다(docs/adr/1870-*).
- **테스트용 훅:** `SLACK_TEST_API_URL=http://127.0.0.1:<port>/api`와 `WEBHOOK_TEST_ALLOW_LOOPBACK=1`(`NODE_ENV=production`이면 무시됩니다).

<a id="7-public-forms"></a>
## 7. 공개 폼

폼 뷰에는 공개 링크(`/f/<token>`, API는 `/api/public/forms/<token>`. docs/adr/1821-*, 1822-*)를 줄 수 있습니다. 계정 없는 방문자가 데이터를 쓰는 경로는 이것 하나뿐입니다.

- **한도:** IP당 1분에 답변 10개(`@fastify/rate-limit` 경로 설정), IP당 1분에 폼 읽기 60번, 폼당 한 시간에 답변 300개입니다. 마지막 한도는 **프로세스마다 메모리에서** 셉니다(프로세스가 여럿이면 그 수만큼 곱해집니다). 요청 본문은 최대 32 KiB, 글 답변은 5,000자까지입니다. 허니팟 칸이 채워져 있으면 성공한 것처럼 답하고 아무것도 쓰지 않습니다.
- **추측한 토큰**은 페이지 링크 토큰과 마찬가지로 IP 차단을 위한 실패로 셉니다(`guard.ts`, 사유 `form-token`).
- **닫힘:** 워크스페이스 설정에서 공개 링크를 끄면 모든 공개 폼이 한꺼번에 닫힙니다. 폼은 그 컬렉션이 휴지통으로 가거나 개인 페이지가 될 때, 또는 링크를 켠 멤버가 더 이상 행을 추가할 수 없게 될 때(워크스페이스에서 빠졌거나 그 멤버에게 컬렉션이 잠긴 경우)에도 닫힙니다. 답변 하나하나가 그 멤버 이름으로 만들어지기 때문입니다.
- **표시:** 답변은 게시한 사람이 `via public form`으로 만든 행입니다. 활동 기록, "AI가 작성"(`Written by AI`) 배지, AI 요약은 이 답변을 사람이 넣은 것으로 셉니다(docs/adr/1870-*).

<a id="8-page-verification-scheduled-links-member-status-and-team-agents"></a>
## 8. 페이지 확인 표시, 예약 공개 링크, 멤버 상태, 팀 에이전트

- 마이그레이션 0045는 nullable 열 하나(`pages.share_starts_at`)와 작은 테이블 두 개(`page_verifications`, `user_statuses`)를 더합니다. backfill도 긴 잠금도 없습니다. 확인 표시 만료, 예약 링크 공개 시작, 상태 메시지 지우기는 읽을 때 서버 시계와 비교해서 정합니다. 새 작업도 새 변수도 없습니다.
- 마이그레이션 0046은 `notifications.connection`, `notifications.person_too`, `user_notification_settings.agent_handoff_copy`(상수 기본값이라 메타데이터만 바뀝니다)와, 값이 모두 NULL인 열에 거는 부분 인덱스 `notifications_connection_idx`(만들 때는 비어 있음)를 더합니다.
- 매시간 도는 정리 작업은 워크스페이스에서 더 이상 살아 있지 않은 연결(권한이나 토큰 만료, 차단, 사람이 나감, 범위 변경)이 아직 확인하지 않은 항목을 그 부분 인덱스를 쓰는 UPDATE 한 번으로 돌려놓습니다. 연결 해제와 토큰 삭제 경로는 해당 연결에 대해 이 일을 바로 합니다.

<a id="9-single-instance-boot-re-index-and-saving-0151"></a>
## 9. 단일 인스턴스, 부팅 때 재색인, 저장 (0.15.1)

<a id="single-instance-docsadr1925-"></a>
### 단일 인스턴스 (docs/adr/1925-*)

- Inkling은 데이터베이스 하나에 서버 프로세스 하나만 돌립니다. 서버는 부팅할 때 마이그레이션보다 먼저 자기 연결에서 Postgres advisory lock(권고 잠금)을 잡고(`application_name = inkling-instance-lock`, `pg_stat_activity`에서 보입니다) 종료할 때까지 쥐고 있습니다. 이 잠금은 열린 문서를 저장한 뒤 맨 마지막에 풉니다.
- 다른 프로세스가 잠금을 쥐고 있으면 어느 프로세스인지 로그에 남기고 기다립니다:
  `[inkling] another Inkling process uses this database (pid …, application "inkling-instance-lock", from …, connected since …); waiting up to 60 s for it to stop`. 다른 프로세스가 멈추면 부팅을 이어 갑니다. `SINGLE_INSTANCE_WAIT`초(기본 60)가 지나도 멈추지 않으면 `[inkling] refusing to start: another Inkling process is running against this database (…)`를 남기고 종료합니다. `restart: unless-stopped`라면 컨테이너가 계속 다시 시도하다가, 다른 프로세스가 사라지면 시작합니다.
- `docker compose up -d`는 새 컨테이너를 띄우기 전에 예전 컨테이너를 멈추므로 평소 배포가 늦어지지는 않습니다. 예전 컨테이너가 아직 종료하는 중일 때(최대 30초의 stop grace period) 띄운 새 컨테이너는 그 종료를 기다립니다. `compose.yaml`에는 앱의 헬스 상태를 기다리는 설정이 없습니다. 헬스체크(시작 유예 10초, 간격 30초, 재시도 3번)는 약 100초가 지나야 unhealthy가 되므로, 기본값대로 60초를 기다린 새 컨테이너도 healthy가 됩니다.
- 잠금은 30초마다 확인합니다. 데이터베이스가 재시작되면 서버가 잠금을 다시 잡는데, 그 사이 다른 프로세스가 먼저 잡았다면 서버가 종료합니다(`lost the instance lock to another process`).
- `SINGLE_INSTANCE=0`(`false`, `off`, `no`도 됩니다)은 이 보호를 끄고, 부팅 때 경고를 남깁니다. 이 값은 두 경우에만 쓰세요. 살아 있는 데이터베이스에 일부러 프로세스를 하나 더 붙일 때(한 번 돌리고 마는 유지보수 스크립트)와, 세션 잠금이 아무 의미가 없는 트랜잭션 모드 풀러(PgBouncer `pool_mode=transaction`) 뒤에서 돌릴 때입니다. 두 번째 웹 서버를 띄우는 데는 절대 쓰지 마세요. 테스트는 `index.ts`를 부팅하지 않으므로 영향을 받지 않습니다.
- 0.15.0 프로세스는 잠금을 잡지 않습니다. 그래서 버전이 섞여서 겹치는 동안에는 보호 장치가 그 프로세스를 알아보지 못합니다. compose 배포는 겹치지 않습니다(멈춘 다음 시작합니다).

<a id="boot-re-index-of-stale-pages-docsadr1924-"></a>
### 오래된 페이지를 부팅 때 다시 색인하기 (docs/adr/1924-*)

- 예전에는 저장과 그 뒤에 대기 중이던 색인 작업 사이에 크래시가 나면, 그 페이지의 검색용 글, 섹션, 링크, 태그, 할 일이 다음 편집 때까지 예전 내용을 가리켰습니다. 이제는 서버가 요청을 받기 시작하고 10초 뒤부터, 저장된 내용이 `page_chunk_index.doc_updated_at`보다 새로운 페이지를 백그라운드에서 다시 색인합니다. 초당 열 페이지쯤씩, 부팅마다 최대 20,000페이지까지 하고, `[inkling] re-indexed N page(s) whose last index pass was lost (crash or kill)`를 남깁니다. 오래된 페이지가 없었으면 아무것도 남기지 않습니다.

<a id="saving-documents-docsadr1921-"></a>
### 문서 저장 (docs/adr/1921-*)

- `[inkling] collab store of <page> failed; retrying in the background`, 이어서 `collab store retry N of <page> failed`: 데이터베이스가 문서 저장을 거절한 것입니다. 5초 간격으로 시작해 두 배씩 늘리며 60초 간격까지 다시 시도합니다.
- `[inkling] <page> has unsaved changes and the store failed; keeping it in memory`: 저장에 성공하기 전에 마지막 편집자가 나갔습니다. 저장에 성공할 때까지 그 페이지를 메모리에 올려 둡니다.
- 종료할 때 `[inkling] shutting down with unsaved changes in N document(s): …`가 저장하지 못한 문서를 알려 줍니다.
- 브라우저에서는 편집이 서버에 닿지 않은 동안 페이지의 연결 표시 점이 주황으로 바뀌고 "아직 저장되지 않음"(`Not saved yet`)이라고 나오며, 탭을 닫거나 새로고침하기 전에 한 번 묻습니다(docs/adr/1926-*). 그 페이지의 오프라인 사본이 없으면(12절의 기기별 설정이고, 브라우저 탭에서는 기본으로 꺼져 있습니다) 브라우저 저장소에는 아무것도 남기지 않으므로, 오프라인에서 한 편집은 탭이 열려 있는 동안만 남습니다. 이 설정을 켜 두면 편집이 기기에도 저장됩니다. 그때 표시 점에는 "아직 올라가지 않음"(`Not uploaded yet`)이 나오고, 다음에 연결되면 서버로 보냅니다(docs/adr/2204-*).

<a id="vault-sync-revisions-docsadr1920-"></a>
### 볼트 동기화 리비전 (docs/adr/1920-*)

- 0.15.1부터는 리비전에 문서에서 지운 내용까지 들어가므로, `inklingctl sync`가 서버에서 지운 글을 되살리지 않습니다. 서버만 바뀐 것이라 예전 CLI도 그대로 동작합니다. 예전 서버의 리비전도 알아봅니다(안에 `-`가 없습니다). 그 리비전으로 쓰기를 하면 현재 버전과 함께 한 번 거절되고 CLI가 합칩니다. 그 리비전으로 삭제를 하면, 그 뒤에 넣거나 서식을 바꾼 것이 없을 때 성공합니다. 업그레이드 전에 로컬에서 지운 노트는 그대로 서버에서도 휴지통으로 갑니다.
- 볼트에서 온 쓰기는 최소한의 편집으로 적용합니다. 그 결과가 검증을 통과하지 못하면 서버가 문서 전체를 다시 쓰고 `[vault-sync] minimal replace not applied`를 남깁니다.

<a id="10-mcp-and-ai-agents-016"></a>
## 10. MCP와 AI 에이전트 (0.16)

<a id="tool-profiles-and-the-mcp-query-string-docsadr2000-"></a>
### 도구 프로필과 `/mcp` 쿼리 문자열 (docs/adr/2000-*)

- `/mcp`는 쿼리 문자열(`?profile=core`)을 받습니다. 쿼리를 버리거나 바꾸는 프록시를 거치면 모든 연결이 전체 프로필이 됩니다(Caddy와 nginx는 기본으로 그대로 넘깁니다). 모르는 값을 주면 HTTP 400입니다.

<a id="uploads-by-ai-agents-docsadr2044--2045--2065-"></a>
### AI 에이전트의 파일 업로드 (docs/adr/2044-*, 2045-*, 2065-*)

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `AGENT_UPLOADS` | `on` | `on`: 워크스페이스가 끄지 않는 한 에이전트가 파일을 올릴 수 있습니다. `off`: 켠 워크스페이스에서만 됩니다. `never`: 어디서나 꺼지고, 워크스페이스 설정은 이유와 함께 비활성으로 보입니다. 다른 값을 넣으면 경고와 함께 부팅하고 `off`로 칩니다 |
| `AGENT_UPLOAD_MAX_MB` | `5` | MCP 연결, 에이전트 토큰, API 토큰이 올릴 수 있는 가장 큰 파일 크기입니다. 최대 64이고, 더 큰 값은 경고와 함께 64로 줄입니다. 0이나 숫자가 아닌 값은 경고와 함께 5로 둡니다 |
| `AGENT_UPLOAD_DAILY_MB` | `200` | 계정마다 최근 24시간 동안 그 계정의 연결들이 올린 파일(`files.uploaded_via`)에 거는 하루 예산입니다. `0`이면 예산이 없습니다. 사람이 브라우저에서 올린 파일은 예산도 없고 세지도 않습니다 |

- 워크스페이스 소유자와 관리자는 워크스페이스 설정 › 연결된 에이전트 › 파일 업로드(`Workspace settings › Connected agents › File uploads`)에서 "AI 에이전트의 파일 업로드"(`Uploads by AI agents`)를 고릅니다(서버 기본값, 켜기, 끄기). 사람이 올리는 파일에는 영향이 없습니다.
- **메모리.** upload_file 호출 하나는 JSON 본문, 파싱한 base64 문자열, 디코딩한 바이트를 한꺼번에 쥐고 있어서, 진행 중인 업로드마다 파일 크기의 약 네 배를 씁니다. 한도가 64 MB라면 동시 업로드 하나당 ~256 MB입니다. 한도가 8 MB를 넘으면 upload_file 호출에 한해서 `/mcp` 본문 한도가 (한도의 base64 크기 + 1 MB)로 커지고, 다른 MCP 요청은 계속 12 MB입니다. API 토큰 업로드(multipart)는 디스크로 바로 흘려 씁니다. 메모리에 여유가 있을 때만 한도를 올리세요.
- 사용 중인 한도가 기본값과 다르면 부팅 로그에 출력합니다(파일당 한도, upload_file 호출의 MCP 본문 한도, 하루 예산). 잘리거나 무시된 값은 부팅 경고가 되고, 관리자 › 상태(`Admin › Status`)에도 경고로 나옵니다(`security.agentUploads`).
- 사람에게는 여전히 저장 공간 할당량이 없고, 파일은 저절로 정리되지 않습니다. 에이전트의 업로드를 되돌리면 링크만 사라지고 파일은 남습니다.

<a id="suggest-only-after-suspicious-content-docsadr2040---2043-"></a>
### 의심 텍스트를 읽은 뒤 제안만 하기 (docs/adr/2040-* .. 2043-*)

- 연결(OAuth, 에이전트 연결 토큰, 개인 API 토큰)이 인젝션 탐지 규칙에 걸린 텍스트를 받으면, 마지막으로 그런 텍스트를 읽은 때부터 60분 동안 제안만 쓸 수 있습니다. 그 밖의 쓰기는 `403 CONNECTION_SUGGEST_ONLY`로 거절됩니다. 업그레이드하면 모든 워크스페이스에서 켜져 있습니다.
- 워크스페이스마다 끌 수 있습니다: 워크스페이스 설정 › 연결된 에이전트 › 의심 텍스트(`Workspace settings › Connected agents › Suspicious content`, 소유자와 관리자). 연결 하나만 일찍 풀어 주려면 그 연결의 주인이 설정 › 연결(`Settings › Connections`)에서 **편집 다시 허용**(`Allow edits again`)을 누르거나, 워크스페이스 소유자·관리자가 팀 에이전트 보드에서 **여기서 편집 다시 허용**(`Allow edits here`)을 누릅니다(그 워크스페이스에 있던 내용을 읽은 경우).
- 감사 로그에는 `agent.tainted`(원본 페이지나 파일, 걸린 규칙. 텍스트 자체는 남기지 않습니다)와 `agent.taint_released`가 남습니다. 거절된 쓰기는 하나하나 기록하지 않습니다.
- 매시간 도는 정리 작업이 30일보다 오래된 `connection_taints` 행을 지웁니다.
- 탐지 규칙은 짧은 영어·한국어 문구 목록입니다. 놓치는 것도 있고 잘못 걸리는 것도 조금 있습니다(긴 16진수 id가 든 CSV가 `encoded-blob`에 걸릴 수 있습니다). 어떤 워크스페이스의 내용이 자꾸 걸린다면 서버 전체가 아니라 그 워크스페이스에서 이 기능을 끄세요.

<a id="agent-connection-tokens-docsadr2060---2063-"></a>
### 에이전트 연결 토큰 (docs/adr/2060-* .. 2063-*)

- 에이전트 연결 토큰은 `kind = 'token'`인 `oauth_grants` 행이고, 토큰마다 `oauth_clients` 행 `ink_tc_…`이 하나씩 딸려 있습니다. 매시간 도는 정리 작업이 만료된 토큰(`refresh_expires_at` 기준이고, 이 값이 만료 시각과 같습니다)과 grant 없이 남은 client 행을 지웁니다. 계정마다 살아 있는 토큰은 최대 20개입니다. 만료는 7, 30, 90, 365일 중에서 고르고, "만료 없음"은 없습니다.
- 비밀값 스캐닝용 패턴은 `ink_agt_[A-Za-z0-9_-]{43}`(에이전트 연결 토큰, `/mcp`에서만 동작)과 `ink_pat_[A-Za-z0-9_-]{43}`(API 토큰)입니다. 새어 나간 에이전트 토큰은 주인이 설정 › 연결에서 취소하고, 계정 전체를 막으려면 비밀번호를 재설정합니다(모든 grant가 지워집니다).
- IP 차단(`AUTH_GUARD_*`)은 `/mcp`로 들어온 모르는 `ink_agt_` 토큰도 실패로 셉니다. 존재하지만 만료된 토큰과 OAuth 액세스 토큰은 세지 않습니다.

<a id="pdf-text-docsadr2047--2048-"></a>
### PDF 텍스트 (docs/adr/2047-*, 2048-*)

- `read_file`은 `unpdf` 1.9.1(pdf.js를 담고 있고 Node 22 이상이 필요합니다)로 PDF의 텍스트 층을 읽습니다. 빌드된 이미지 안에서 이 패키지는 약 2.5 MB입니다.
- 호출마다 잠깐 쓰고 버리는 워커 스레드에서 파싱합니다. 힙 상한은 256 MB, 실제 경과 시간 제한은 10초이고, 프로세스당 동시에 PDF 두 개까지만 파싱합니다(더 오면 자리가 날 때까지 기다립니다). 20 MB를 넘는 파일은 파싱하지 않고(메타데이터만), 호출 한 번에 최대 50페이지까지 읽습니다. 설정할 것은 없습니다. OCR은 하지 않으므로 스캔한 PDF에서는 텍스트가 나오지 않습니다.

<a id="11-local-trial-setup-link-zips-versions-and-diagrams-017"></a>
## 11. 로컬 체험, 설정 링크, zip, 버전, 다이어그램 (0.17)

<a id="first-admin-setup-link-docsadr2160-"></a>
### 첫 관리자 설정 링크 (docs/adr/2160-*)

- 계정이 하나도 없는 서버는 부팅할 때마다 한 번, 테두리를 두른 블록을 stdout에 출력합니다: "No accounts yet. Create the first administrator account here: `<PUBLIC_URL>/setup?code=…`". `docker compose logs app | grep setup`으로 찾으세요. 재시작하면 새 코드가 나오고 예전 코드는 더 이상 쓸 수 없습니다. 이 링크로 만든 계정이 관리자가 되고, 계정이 하나라도 생기면 링크는 바로 닫힙니다. 이미 계정이 있는 서버는 아무것도 출력하지 않습니다.
- **보안.** 코드는 메모리에만 있고 한 번만 쓸 수 있으며, 틀리게 추측하면 IP 차단 횟수로 셉니다. 하지만 첫 계정이 생기기 전까지는 컨테이너의 stdout을 읽을 수 있는 사람이면 누구나 이 코드를 볼 수 있습니다. 로그가 공유 서비스로 간다면 처음 띄운 직후 바로 첫 계정을 만들거나, 가입 키를 쓰세요(`./deploy/signup-key.sh new "first admin"`, [deploy/DEPLOY.ko.md](../deploy/DEPLOY.ko.md#3-c-accounts--issuing-signup-keys)의 3-C). 아직 이 링크를 끄는 스위치는 없습니다(KNOWN-ISSUES SETUP-1).

<a id="local-trial-docsadr2161-"></a>
### 로컬 체험 (docs/adr/2161-*)

- `./deploy/local.sh`(시작. `--build`를 붙이면 이미지를 받는 대신 받아 둔 소스를 빌드합니다), `./deploy/local.sh stop`, `./deploy/local.sh destroy`(체험용 컨테이너와 볼륨을 지웁니다. `.env`는 남습니다). 스크립트는 `# made by deploy/local.sh` 표시가 붙은 `.env`를 씁니다. 여기에는 `POSTGRES_PASSWORD`(무작위 16진수), `APP_SECRET_KEY`(무작위 base64), `PUBLIC_URL=http://localhost:<port>`, `INKLING_PORT=127.0.0.1:<port>`, `BACKUP_ENABLED=0`, `INKLING_DATA_NAME=inkling`, `COMPOSE_FILE=compose.yaml:compose.local.yaml`, `COMPOSE_PROJECT_NAME=inkling-local`이 들어갑니다. 그래서 그냥 `docker compose …`를 치거나 다른 `deploy/*.sh` 스크립트를 돌려도 그 스택에 적용됩니다. 표시가 없는 `.env`는 절대 고치지 않습니다. 표시가 있지만 0.19 전에 만든 `.env`에는 `INKLING_DATA_NAME=nodian`(예전 볼륨과 역할 이름)을 넣습니다.
- 다른 사람이 쓰는 서버용이 아닙니다. http만 되고, 이 기계에서만 접속할 수 있으며, 백업이 없고, 데이터베이스 호스트 포트도 열지 않습니다. bash, curl, Docker Compose v2.24 이상(`!override` 때문입니다)이 필요합니다. Windows에서는 WSL이나 Git Bash에서 실행하세요.
- `--build` 없이 돌리면 `ghcr.io/prove1352/inkling:${INKLING_VERSION:-latest}`를 받습니다. 0.17보다 오래된 이미지는 설정 링크를 출력하지 않으므로, 이때 스크립트는 `./deploy/signup-key.sh`로 첫 가입 키를 만들라고 알려 줍니다.
- `compose.yaml`은 `INKLING_PORT`(앱의 호스트 포트 또는 `ip:port`, 기본 `3000`)와 `INKLING_DB_PORT`(루프백 데이터베이스 포트, 기본 `55432`)를 읽습니다.

<a id="zip-imports-docsadr2162--2163-"></a>
### zip 가져오기 (docs/adr/2162-*, 2163-*)

- 모든 zip 가져오기(웹과 MCP)는 `..` 항목이나 심볼릭 링크가 든 압축 파일을 거절하고, 1 MB를 넘어서면서 압축된 크기의 200배 넘게 부푸는 항목은 중간에 멈춥니다(400 `ZIP_RATIO`). 이름은 정규화하고(NFC, `\`, 맨 앞의 `/`, 드라이브 문자), UTF-8이 아닌 이름은 CP949로 읽습니다.
- 연결의 토큰으로 보낸 zip(MCP `import_zip`, 또는 bearer 토큰으로 보낸 `POST /api/workspaces/:id/import`)은 최대 `min(IMPORT_MAX_UPLOAD_MB, AGENT_UPLOAD_MAX_MB)`(기본 5 MB)입니다. 그 안의 `assets/` 첨부 파일은 에이전트 업로드 스위치, 파일당 한도, 형식 검사, 하루 예산(10절)을 따르고 `uploaded_via`가 기록됩니다. bearer 토큰으로 하는 `import-folder`도 첨부 파일을 같은 방식으로 다룹니다. 브라우저에서 하는 가져오기는 그대로 `IMPORT_MAX_UPLOAD_MB`를 따르고 예산이 없습니다.
- `import_zip` 호출은 zip을 base64로 바꿔 MCP 요청 하나에 담습니다. `AGENT_UPLOAD_MAX_MB`가 8 MB를 넘으면 upload_file과 마찬가지로 이 호출의 `/mcp` 본문 한도가 커집니다(진행 중인 호출마다 파일 크기의 약 네 배를 메모리에 씁니다).

<a id="versions-ai-steps-docsadr2180-"></a>
### 버전: AI 단계 (docs/adr/2180-*)

- 에이전트가 쓸 때마다 `page_snapshots` 행("AI 단계")이 하나씩 저장됩니다. 보통은 작은 Yjs diff이고(벤치마크에서 중앙값 약 0.7 KB), 한 사슬의 10번째 행마다 전체 상태를 저장합니다(docs/adr/1100-*). 클라이언트마다 페이지당 가장 최근 20단계를 남기고, 한 페이지에는 최대 30단계까지 남으며, 페이지당 50개인 버전 한도는 그대로입니다. 정리할 때는 단계 행부터 지우고, 지운 행의 diff는 다음에 남는 행을 새로 만들지 않고 그 행에 합칩니다.
- 저장 공간: 12 KB 노트에 에이전트가 30번 쓰면 21행, 디스크 34.3 KB가 남습니다(0.16에서는 1행, 4.5 KB). 4.1 MB 로그라면 디스크 2.37 MB입니다(0.16에서는 1.07 MB). 상한은 페이지의 50개 버전 예산입니다(docs/PERFORMANCE.md). 수 MB짜리 페이지에 자주 덧붙이는 에이전트는 10번 쓸 때마다 대략 페이지 크기만큼을 씁니다. 로그는 하위 페이지로 써야 합니다(docs/adr/1140-*).
- 쓰기 비용: 에이전트 쓰기마다 짧은 트랜잭션 두 번과 내용 digest 계산 두 번이 들고, 작은 페이지에서 +6–9 ms입니다.

<a id="mermaid-diagrams-docsadr2104--2191-"></a>
### Mermaid 다이어그램 (docs/adr/2104-*, 2191-*)

- `mermaid` 12.3.0은 웹 번들의 `assets/lazy/` 아래에 들어 있고(모든 다이어그램 종류를 합쳐 약 90개 파일, 5.16 MB, gzip 1.44 MB), 서비스 워커가 미리 캐시하지 않습니다. 브라우저는 다이어그램이 있는 페이지를 처음 열 때 이것을 받습니다(순서도 하나에 gzip 약 246 kB). 다이어그램을 한 번도 그려 본 적 없는 브라우저는 오프라인에서 다이어그램을 그리지 못합니다. 서버에서는 아무것도 돌지 않고, 공개 페이지도 읽는 사람의 브라우저에서 다이어그램을 그립니다.

<a id="12-offline-copies-web-push-automations-the-web-clipper-and-cimd-018"></a>
## 12. 오프라인 사본, 웹 푸시, 자동화, 웹 클리퍼, CIMD (0.18)

<a id="offline-copies-docsadr2200---2204-"></a>
### 오프라인 사본 (docs/adr/2200-* .. 2204-*)

- 오프라인 사본은 사람마다 자기 브라우저(IndexedDB `inkling-offline`)에 있습니다. 서버가 새로 저장하는 것은 `pages.doc_gen`뿐이고, 사본이 있는 페이지를 열 때와 다시 연결될 때마다 `GET /api/pages/:id/sync-check` 요청 하나에 답합니다. 설정할 것은 없습니다.
- "이 기기에 오프라인 사본 보관"(`Keep offline copies on this device`) 설정은 기기마다 따로입니다. 설치한 앱에서는 기본으로 켜져 있고 브라우저 탭에서는 꺼져 있습니다. 사본은 암호화되지 않아서, 그 브라우저 프로필에 접근할 수 있는 사람은 누구나 읽을 수 있습니다. 여럿이 같이 쓰거나 공용인 컴퓨터에서는 이 설정을 끈 브라우저 탭(기본값)을 쓰고 다 쓰면 로그아웃하라고 알려 주세요. 로그아웃, 세션 만료나 취소, 다른 계정의 로그인은 그 기기의 사본을 모두 지웁니다.
- 오프라인 상태에서 로그아웃하면 사본과 브라우저의 푸시 구독은 바로 지워지지만, 서버 쪽 세션은 끝낼 수 없습니다. 그 세션은 만료되거나(30일) 취소될 때까지 유효합니다. 아직 "모든 기기에서 로그아웃" 버튼은 없습니다. 본인이 비밀번호를 바꾸거나, 관리자가 관리자 › 사용자(`Admin › Users`)에서 재설정 코드나 임시 비밀번호를 발급하면 모든 세션이 로그아웃됩니다(KNOWN-ISSUES OFFLINE-LOGOUT).
- `deploy/restore.sh`로 백업에서 복원한 뒤에는, 백업보다 새로운 편집을 아직 보내지 못한 브라우저가 다음에 연결될 때 그 편집을 복구 항목으로 돌립니다. 사람들에게 설정 › 오프라인 › 복구 항목(`Settings › Offline › Recovery`)을 확인하라고 알려 주세요.

<a id="web-push-docsadr2220---2223-"></a>
### 웹 푸시 (docs/adr/2220-* .. 2223-*)

- **HTTPS가 필요합니다.** 브라우저는 `https://` origin과 `http://localhost`에서만 푸시(와 서비스 워커)를 허용합니다. 리버스 프록시(Caddy, nginx) 뒤라면 평소처럼 HTTPS로 앱을 내보내면 되고, 프록시에 경로를 더 넣을 필요는 없습니다. `/sw.js`, `/push-sw.js`, `/api/push/*`는 보통의 앱 경로입니다. 서버는 `/sw.js`와 `/push-sw.js`를 `Cache-Control: no-cache`로 보내고(4절), 프록시가 이 값을 덮어쓰면 안 됩니다.
- **iPhone과 iPad:** 푸시는 홈 화면에 추가한 앱(Safari → 공유 → 홈 화면에 추가, `Safari → Share → Add to Home Screen`)에서만 되고, iOS/iPadOS 16.4 이상이어야 합니다. Safari 탭에서는 그 방법을 안내합니다. Apple은 VAPID `sub` 클레임을 확인하므로 `VAPID_SUBJECT=mailto:you@your-domain`을 넣으세요(또는 https로 된 `PUBLIC_URL`에 맡기세요). 둘 다 없을 때 쓰는 자리 채움 값 `mailto:webpush@inkling.invalid`는 Apple이 거절할 수 있습니다.
- **밖으로 나가는 연결**(HTTPS, 443 포트): 서버에서 브라우저들이 쓰는 푸시 서비스로 연결할 수 있어야 합니다. Chrome, Android의 Edge, 삼성 인터넷, Opera는 `fcm.googleapis.com`(과 예전 주소 `android.googleapis.com`), Firefox는 `updates.push.services.mozilla.com` / `*.push.services.mozilla.com`, Safari는 `web.push.apple.com` / `*.push.apple.com`, Windows의 Edge는 `*.notify.windows.com`입니다. 나가는 연결을 거르는 방화벽이 있다면 이 주소들을 허용해야 합니다. 그 밖의 호스트는 `WEB_PUSH_ALLOWED_HOSTS`(쉼표로 구분, `host` 또는 `*.suffix`)에 적지 않으면 거절됩니다. 어떤 대상이든 공개 주소로 풀려야 하고, 리다이렉트는 따라가지 않으며, 응답은 최대 4 KiB까지만 읽습니다.

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `WEB_PUSH` | 켜짐 | `off`면 서버 전체에서 푸시를 끕니다. 아무것도 대기열에 넣지 않고, 이미 대기 중인 전송은 버리며, 관련 경로는 사용할 수 없다고 답합니다 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | 비어 있음(처음 쓸 때 키를 만들어 `push_vapid_keys`에 보관) | 둘 다 넣거나 둘 다 비웁니다. `npx web-push generate-vapid-keys`가 출력하는 base64url 원시 키입니다 |
| `VAPID_SUBJECT` | https면 `PUBLIC_URL`, 아니면 `mailto:webpush@inkling.invalid` | VAPID `sub` 클레임 |
| `WEB_PUSH_ALLOWED_HOSTS` | 비어 있음 | 더 허용할 푸시 서비스 호스트입니다. 쉼표로 구분하고 `host` 또는 `*.suffix`로 씁니다 |
| `PUSH_TEST_ALLOW_LOOPBACK` | 꺼짐 | 테스트 전용입니다. `NODE_ENV=production`이면 무시됩니다 |

- **키.** 만들어진 개인 키는 구독 엔드포인트, 구독의 인증 비밀값과 마찬가지로 `APP_SECRET_KEY`로 암호화합니다(`APP_SECRET_KEY`를 넣기 전에 쓴 행은 다음 부팅 때 암호화합니다). VAPID 키를 바꾸면(나중에 환경 변수 한 쌍을 넣거나 키를 새로 만들게 되면) 모든 구독이 무효가 됩니다. 예전 구독으로 가는 전송은 버리고 그 행을 지우며, 기기는 사람이 앱을 열 때 다시 구독합니다. 키는 데이터베이스 안에 있습니다. 서버가 다른 데이터베이스(다른 인스턴스의 것이나 새 것)를 가리키게 하거나 그 행을 지우면 다른 키가 됩니다. 반대로 이 데이터베이스 자신의 백업을 복원하면, 같은 `APP_SECRET_KEY`를 넣어 두는 한 키가 그대로 유지됩니다(`APP_SECRET_KEY`는 서버 밖, 백업과도 다른 곳에 사본을 두세요). 새로 만든 키로 처음부터 다시 시작하려면 `DELETE FROM push_vapid_keys;`를 실행하고 재시작하세요. 서버 상태에 "VAPID 키 문제 (stored_unreadable)"(`VAPID key problem (stored_unreadable)`)가 나오면 `APP_SECRET_KEY`가 없거나 바뀐 것입니다. 원래 값을 되돌려 넣거나 그 행을 지우세요. `env_incomplete` / `env_invalid`가 나오면 환경 변수 한 쌍을 고치세요.
- **구독**은 그것을 만든 로그인 세션에 속하고, 세션과 함께 지워집니다(로그아웃, 비밀번호 변경, 관리자의 세션 취소, 30일 만료). 한 사람당 기기는 최대 20대입니다.
- **전송:** outbox 토픽은 `push`이고, 프로세스당 동시에 요청 4개까지 보냅니다. 재시도는 10초 → 30초 → 90초 → … 순서로 간격을 늘립니다(최대 30분 간격, 5번 시도, 푸시 서비스가 보낸 Retry-After를 따름). 404/410을 받거나 10번 연달아 실패하면 그 기기를 지웁니다. 푸시 서비스에서의 TTL은 24시간입니다. 한 페이지나 스레드에서 30초 안에 몰려 생긴 알림은 기기마다 푸시 하나로 보냅니다. 한 사람에게 대기 중인 푸시는 최대 100개이고, 넘치면 새로 생긴 것을 버립니다. 서버 상태 › 웹 푸시(`Server status › Web push`)를 지켜보세요.
- **무엇이 푸시되나.** 푸시는 알림 행을 따라갑니다. 보낼 때 그 사람의 푸시 종류 설정(멘션, 담당 지정, 답글, 코멘트, 승인, 리마인더. `updates`는 기본으로 꺼져 있습니다)과 페이지 공개 범위를 다시 확인합니다. 자동화 알림(규칙의 "알리기" 동작과 "다섯 번 실패해서 꺼짐")은 멘션으로 푸시되고, `Alice via automation: Ping reviewer mentioned you in "Draft 3"`처럼 적힙니다(실패한 규칙 알림에는 사람이 없어서 `automation: <rule> mentioned you in "<database>"`가 됩니다). 시스템 알림(`workspace_added`, `workspace_deleted`, `webhook_disabled`, `backup_failed`, `large_page`)은 종 모양 알림 목록에만 나옵니다. 자기 워크스페이스 목록에서 어떤 워크스페이스를 보관해도 그 워크스페이스의 푸시는 멈추지 않습니다.

<a id="database-automations-and-buttons-docsadr2240---2244-"></a>
### 데이터베이스 자동화와 버튼 (docs/adr/2240-* .. 2244-*)

- 규칙 실행은 변경 로그 소비자가 대기열에 넣습니다. 쓰기 경로들이 이미 남기고 있는 이벤트를 보고 넣는 것이고, 실행은 outbox 토픽 `automation`으로 합니다. 대기 중인 행과 끝난 행이 `outbox`에 있고, 끝난 행은 다른 토픽과 마찬가지로 7일 동안 남는데 이것이 "날짜 도달" 규칙의 중복 실행도 막아 줍니다. 서버 상태에 "데이터베이스 자동화"(`Database automations`)가 나옵니다("상태 요약 읽기" 절).
- 프로세스마다 타이머가 15분마다(부팅 뒤 첫 실행은 20초 뒤) 서버의 현지 날짜 기준으로 "날짜 도달" 규칙을 대기열에 넣습니다. 그날이 지난 뒤에 켠 규칙은 지나간 날을 따라잡지 않습니다.
- 프로세스당 한도: 규칙당 1분에 30번 실행, 워크스페이스당 1분에 120번, 연쇄 깊이 3, 규칙당 실행 기록 50개 보관이고, 다섯 번 연달아 실패하면 규칙이 꺼집니다. 데이터베이스당 규칙은 최대 20개, 규칙이나 버튼 하나당 동작은 최대 5개입니다.
- 밖으로 나가는 동작은 워크스페이스 소유자가 등록해 둔 웹훅(워크스페이스 설정 › 웹훅, `Workspace settings › Webhooks`)으로만, 기존 웹훅 대기열을 거쳐 보냅니다.
- 설정할 것은 없습니다. 급할 때 모든 자동화를 멈추려면 `UPDATE collection_automations SET enabled = false;`를 실행하세요(규칙을 만든 사람들이 데이터베이스 메뉴 › 자동화에서 다시 켭니다).

<a id="web-clipper-docsadr2260---2263-"></a>
### 웹 클리퍼 (docs/adr/2260-* .. 2263-*)

- "본문 가져오기"(`Article text`)로 저장하면 서버가 그 페이지를 받아 옵니다. SSRF 방어를 거치는 밖으로 나가는 GET 요청이고(공개 주소만, 리다이렉트마다 다시 확인, 리다이렉트 최대 3번, 10초, 최대 2 MiB 읽기, HTML만, 80/443 포트), 사용자 에이전트는 `Mozilla/5.0 (compatible; InklingBot/1.0)`입니다. 나가는 연결을 막아 둔 서버에서는 모든 글이 링크로만 저장됩니다(`fallback: fetch_failed`).
- 프로세스마다 메모리에서 세는 한도: 한 사람당 1분에 본문 가져오기 10번, 한 사람당 동시에 2개, 서버 전체에서 동시에 8개입니다. 경로 자체는 1분에 요청 30개까지 받습니다. 본문 가져오기는 브라우저 세션에서만 할 수 있고, 토큰으로는 링크만 저장합니다.
- 본문 추출은 요청 스레드에서 돕니다. 1.6 MB 페이지에 CPU 약 0.3–0.9초가 들고, 태그 20,000개에서 자르고 400단계보다 깊은 중첩은 거절하는 것으로 상한을 둡니다. 글 속 이미지는 원래 사이트에 있는 것을 그대로 가리킵니다(클립 하나에 최대 100개).
- `CLIP_TEST_ALLOW_LOOPBACK`은 테스트 전용이고 `NODE_ENV=production`이면 무시됩니다. 그 밖의 변수는 없습니다.
- Android 공유 메뉴와 북마클릿은 앱의 `/clip`을 열기만 하므로, 프록시에 더할 경로가 없습니다.

<a id="oauth-client-id-metadata-documents-docsadr2280---2282-"></a>
### OAuth Client ID Metadata Documents (docs/adr/2280-* .. 2282-*)

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `OAUTH_CIMD` | 꺼짐 | `1`이면 `client_id`가 메타데이터 문서의 https URL인 OAuth 클라이언트를 받아들입니다 |
| `OAUTH_CIMD_ALLOWED_HOSTS` | 비어 있음(공개 호스트 모두) | 쉼표나 공백으로 구분한 호스트입니다. 정확한 이름이나 `*.suffix`로 씁니다. 예: `claude.ai` |
| `OAUTH_CIMD_TEST_ALLOW_LOOPBACK` | 꺼짐 | 테스트 전용: `http://127.0.0.1`에 있는 문서를 허용합니다. `NODE_ENV=production`이면 무시됩니다 |

- **밖으로 나가는 연결.** 이 기능을 켜면, 로그인한 사람이 동의 링크를 열 때, 그리고 이렇게 만든 연결이 토큰을 갱신하는데 캐시해 둔 사본이 이미 만료됐을 때 서버가 client_id URL을 받아 옵니다(HTTPS GET, `Accept: application/json`). `safeFetch`를 거치므로 https만, 공개 주소만 허용하고(사설, 루프백, 링크 로컬, CGNAT, 메타데이터 주소는 거절, DNS 결과 고정), 리다이렉트는 따라가지 않으며, 5 KB와 5초 제한이 있습니다. URL마다 응답의 `max-age`만큼 캐시하고(60초–24시간. 없으면 5분이고, Claude의 문서는 5분입니다), 캐시는 프로세스마다 하나입니다. 호스트가 응답하지 못하는 동안에는 유효했던 사본을 최대 7일 동안 씁니다. 실패한 URL은 30초 동안 다시 받지 않고, 전체적으로 1분에 최대 60번까지만 받습니다. 나가는 연결을 막는 방화벽이 있으면 이런 클라이언트만 동작하지 않습니다(사용자에게는 "could not be loaded"가 보입니다). 나가는 연결을 제한한다면 `claude.ai:443`을 허용하세요.
- Claude만 쓰는 팀이라면 `OAUTH_CIMD_ALLOWED_HOSTS=claude.ai`가 가장 좁은 설정입니다.
- 익명 요청으로는 서버가 문서를 받아 오게 만들 수 없습니다. 동의 정보 경로는 브라우저 세션이 있어야 하고, 토큰 엔드포인트는 이미 알고 있는 갱신 토큰에 대해서만 문서를 받아 옵니다. 문서 내용은 로그에 전혀 남기지 않습니다.
- 다시 끄면: 이 방식으로 만든 연결은 다음 토큰 갱신 때(한 시간 안에) 멈춥니다. 연결 해제하기 전까지는 연결(`Connections`) 목록에 남아 있습니다. 이 기능에 기대기 전에 [MCP.ko.md](MCP.ko.md) 끝에 있는 실제 클라이언트 점검 목록을 해 보세요.

<a id="workspace-groups-and-archive-docsadr2300---2305-"></a>
### 워크스페이스 묶음과 보관 (docs/adr/2300-* .. 2305-*)

- 설정할 것은 없습니다. 이 행들은 계정이 지워질 때, 워크스페이스가 완전히 삭제될 때, 멤버가 나가거나 내보내질 때 함께 지워집니다. 일시 삭제된 워크스페이스는 복원에 대비해 이 행들을 남겨 둡니다. 0.17로 내리면 두 테이블은 쓰이지 않은 채 남습니다.

<a id="13-public-page-downloads-start-up-notices-and-onboarding-019"></a>
## 13. 공개 페이지 내려받기, 시작 안내, 온보딩 (0.19)

<a id="public-page-downloads-docsadr2360---2363-"></a>
### 공개 페이지 내려받기 (docs/adr/2360-* .. 2363-*)

- 공개 링크에서 Markdown 내려받기를 제공할 수 있습니다(링크마다, 기본 꺼짐). 응답은 `no-store`와 `noindex`이고, 다른 공개 경로와 같은 속도 제한을 받습니다(경로와 IP마다 1분에 60번). 내려받기는 요청 로그 말고는 따로 기록하지 않습니다. 파일 안의 이미지와 첨부 파일 주소는 `PUBLIC_URL`로 만듭니다.
- 내려받기가 켜진 링크 찾기: `SELECT id, title FROM pages WHERE share_token IS NOT NULL AND share_allow_download;`
  모두 끄기: `UPDATE pages SET share_allow_download = false WHERE share_allow_download;`
- 넓게 보기와 PDF로 저장은 방문자의 브라우저에서 돌아갑니다. 설정할 것은 없습니다.

<a id="start-up-and-screen-notices-docsadr2324-"></a>
### 시작 안내와 화면 오류 안내 (docs/adr/2324-*)

- `index.html`에는 짧은 정적 안내(영어와 한국어)와 새로고침 링크가 들어 있고, 앱 스크립트가 12초가 지나도 시작되지 않으면 CSS로 이 안내를 드러냅니다. 스크립트가 필요 없으므로 셸의 `script-src 'self'`는 바뀌지 않습니다. `index.html`을 고쳐 쓰거나 캐시하는 프록시는 전과 마찬가지로 이 파일을 `no-cache`로 두어야 합니다(4절).
- 그리다 실패한 화면은 "이 화면을 표시하지 못했습니다"(`This screen could not be shown`)와 새로고침 버튼을 보여 주고, 오류 내용은 자세히(`Details`) 아래에 둡니다. 빈 화면이나 깨진 화면을 알려 오는 사람에게는 자세히 안에 있는 글을 받아 보세요.
- IndexedDB가 끝내 응답하지 않는 브라우저에서는, 오프라인 사본을 켠 페이지가 "연결 중…"(`Connecting…`)에서 계속 기다리지 않고 5초 뒤 서버에서 열립니다. 그 탭은 새로고침할 때까지 기기 사본 없이 동작하고, 설정 › 오프라인에 기기 저장소를 쓸 수 없다고 나옵니다.

<a id="onboarding-docsadr2380---2383-"></a>
### 온보딩 (docs/adr/2380-* .. 2383-*)

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `ONBOARDING` | 켜짐 | `off`(또는 `0`, `false`, `no`): 모든 사람에게 소개, 시작하기 카드, 샘플 페이지가 나오지 않습니다. 조직에 자체 안내서가 있을 때 쓰세요. 이 값이 꺼져 있는 동안 처음 들어온 계정은 나중에 다시 켜면 기존 계정으로 칩니다. |
| `ONBOARDING_EXISTING_USERS` | 꺼짐 | `once`: 온보딩이 생기기 전부터 있던 계정(그리고 `ONBOARDING=off`인 동안 처음 들어온 계정)도 다음에 앱을 열 때 소개를 한 번 봅니다. 소개만 나오고, 체크리스트는 꺼진 채로 있으며 샘플 페이지도 만들지 않습니다. 사람마다 저장하므로(`introSeenAt`) 변수를 그대로 둔 채 재시작해도 다시 나오지 않고, 나중에 변수를 지워도 달라지는 것이 없습니다. `ONBOARDING=off`가 우선합니다. |

둘 다 요청마다 읽고 `compose.yaml`이 그대로 넘깁니다. 값을 바꾼 뒤에는 앱 컨테이너를 다시 만드세요(`docker compose up -d app`). 온보딩 경로는 브라우저 세션 전용이라 에이전트와 토큰에는 온보딩이 보이지 않습니다.

`.env`에 `ONBOARDING_EXISTING_USERS=once`를 넣고 컨테이너를 다시 만든 뒤에는 값이 제대로 들어갔는지 확인하세요. `docker compose exec app printenv ONBOARDING_EXISTING_USERS`가 `once`를 출력해야 합니다(빈 줄이 나오면 설정되지 않은 것입니다). 몇 개 계정에 소개가 나갈지는 아래 쿼리로 셉니다. 아직 소개를 닫지 않은 기존 계정에서 게스트를 뺀 수입니다. 게스트는 소개를 받지 않습니다("게스트"의 기준은 `apps/server/src/onboarding/state.ts`에 있는 `audienceOf`의 규칙입니다).

```sql
SELECT count(*) FROM user_onboarding o JOIN users u ON u.id = o.user_id
 WHERE (o.state->>'legacy' = 'true' OR o.state->>'off' = 'true') AND o.state->'introSeenAt' IS NULL
   AND NOT (NOT u.is_admin
     AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                      WHERE m.user_id = u.id AND w.deleted_at IS NULL AND m.role <> 'owner')
     AND EXISTS (SELECT 1 FROM page_grants g JOIN pages p ON p.id = g.page_id
                  WHERE g.user_id = u.id AND NOT EXISTS (SELECT 1 FROM workspace_members m2
                                                          WHERE m2.workspace_id = p.workspace_id AND m2.user_id = u.id)));
```

소개를 닫아야(건너뛰기, Esc, 마지막 장면) 본 것으로 칩니다. 재생 중에 탭을 닫으면 다음에 앱을 열 때 다시 나옵니다(KNOWN-ISSUES ONBOARD-6).

온보딩 상태는 `user_onboarding`에 있습니다(계정마다 한 행이고 계정과 함께 지워집니다). 한 사람에게 소개를 다시 보여 주는 가장 쉬운 방법은 본인이 설정 › 정보 › 소개 다시 보기(`Settings › About › Watch the intro again`)를 누르는 것입니다. SQL로 하려면 `UPDATE user_onboarding SET state = state - 'introSeenAt' WHERE user_id = '…';`를 실행하세요. 업그레이드 뒤에 만든 계정이라면(또는 `ONBOARDING_EXISTING_USERS=once`가 설정된 동안에는 어느 계정이든) 다음에 앱을 열 때 소개가 다시 나옵니다. `legacy`까지 지우면(`state - 'introSeenAt' - 'legacy'`) 예전 계정이 새 계정처럼 취급됩니다. 체크리스트도 다시 나오고, 그 계정이 서버의 첫 계정이면서 관리자라면 다음에 앱을 열 때 샘플 페이지도 만들어집니다. 새 서버의 첫 관리자는 처음 앱을 열 때 자기 개인 페이지에 샘플 페이지를 받고, 다른 사람은 카드의 버튼을 눌러야만 받습니다.

<a id="14-columns-and-tabs-of-older-releases-020"></a>
## 14. 단 나누기와 예전 릴리스의 탭 (0.20)

<a id="upgrading-to-020"></a>
### 0.20으로 업그레이드하기
마이그레이션은 하나이고 꼭 넣어야 하는 설정은 없으니, 평소 절차대로 하면 됩니다(위의 "업그레이드" 절). 마이그레이션 0061은 공개 링크의 차트를 위해 `pages`에 열 세 개를 더합니다(15절). 0.19 데이터베이스는 적용된 마이그레이션이 61개에서 62개가 됩니다. 기존 링크는 모두 차트가 꺼진 채로 남으므로, 소유자나 관리자가 켜기 전까지 공개 페이지는 전과 똑같이 보입니다. 업그레이드한 뒤에는 열어 둔 탭을 새로고침하라고 사람들에게 알리세요. 0.19 이하가 돌고 있는 탭은 단이 있는 페이지를 읽을 수는 있지만 고칠 수는 없습니다(아래 참고). 0.19.1로 돌아갈 때는 복원이 필요 없을 것으로 봅니다(0.19는 새로 생긴 열 세 개를 읽지 않습니다. 다만 0061이 적용된 데이터베이스에서 0.19를 실제로 띄워 보지는 않았습니다). 그런데 0.19의 에디터는 단 묶음이 있는 페이지를 열면 그 묶음을 내용째 지웁니다(막는 장치가 없습니다). 단을 쓰기 시작했다면 되돌리지 마세요. 차트를 보여 주던 링크를 0.19가 도는 동안 다시 게시하면 차트 설정은 그대로 남습니다(KNOWN-ISSUES SHARE-9).

<a id="older-tabs-and-the-document-schema-docsadr2425-"></a>
### 예전 탭과 문서 스키마 (docs/adr/2425-*)
- 클라이언트는 협업 소켓에 자기가 아는 문서 스키마를 보냅니다(0.20에서는 `/collab?schema=2`. 0.19 이하는 아무것도 보내지 않고 1로 칩니다). 클라이언트가 모르는 노드 종류(0.19에게는 단)가 들어 있는 페이지에서는 그 연결이 읽기 전용이 됩니다. 이때 0.19 탭은 단 묶음을 뺀 페이지를 잠금 줄("잠김 … 읽기와 코멘트는 되지만 편집은 할 수 없습니다", `Locked … You can read and comment, but not edit`) 아래에 보여 주고, 새로고침하면 0.20으로 바뀌어 평소처럼 편집할 수 있습니다. 단이 없는 페이지는 영향을 받지 않습니다.
- 0.19 탭이 열고 있는 페이지에 단 묶음이 추가되면, 서버는 그 순간 그 연결을 읽기 전용으로 바꾸고 소켓을 닫습니다(WebSocket 종료 코드 4000, 사유 `document-schema`). 탭은 바로 다시 연결합니다. 업그레이드 뒤 로그에 이런 종료가 몇 번 보이는 것은 정상입니다.
- 리버스 프록시는 `/collab`의 쿼리 문자열을 그대로 넘겨야 합니다(Caddy와 nginx의 경로 규칙은 넘깁니다). 넘기지 않으면 모든 탭이 0.19로 취급되어, 브라우저에서는 모든 사람에게 단이 있는 페이지가 읽기 전용이 됩니다.
- 오프라인 사본이 켜져 있을 때, 0.19 탭이 단이 있는 페이지에 대해 기기에 남겨 둔 편집은 새로고침 뒤에 서버로 보내지 않습니다. 그 편집은 복구 항목이 됩니다("이전 버전 앱에서 한 편집"(`Made by an older version of the app`), 설정 › 오프라인).
- 에이전트와 REST API는 서버 자신의 스키마로 쓰므로 영향이 없습니다.
- 비용: 예전 클라이언트의 연결은 페이지를 한 번 훑습니다(페이지가 열려 있지 않으면 `page_docs`에서 읽습니다). 지금 버전의 클라이언트는 메시지마다 비교를 한 번 할 뿐입니다.

<a id="15-charts-on-public-links-020"></a>
## 15. 공개 링크의 차트 (0.20)

<a id="charts-on-public-links-docsadr2440---2444-"></a>
### 공개 링크의 차트 (docs/adr/2440-* .. 2444-*)
- 공개 링크에 차트 집계를 보여 줄 수 있습니다(링크마다, 기본 꺼짐). 집계는 이 기능을 켠 소유자나 관리자(`pages.share_charts_by`)의 권한으로 계산하고, 그 사람이 워크스페이스 멤버로 있는 동안만 계산합니다. 공개 페이지 응답은 페이지 리비전마다 최대 10분 동안 캐시되므로 차트 숫자도 그만큼 지난 것일 수 있습니다. 멤버 여부와 스위치는 요청마다 읽습니다.
- 집계하는 차트는 소유자나 관리자가 승인한 원본(`pages.share_chart_sources`)의 차트뿐이고, 승인한 그 사람의 권한으로 집계합니다. 차트를 켤 때와 "이 차트도 공개"(`Publish these charts too`)를 누를 때도 링크의 문서를 읽습니다(아래 차트 개수를 셀 때와 같은 방식입니다). 단 안에 있는 차트도 다른 차트와 똑같이 세고 승인합니다.
- 차트가 켜진 링크 찾기: `SELECT id, title, share_charts_by FROM pages WHERE share_token IS NOT NULL AND share_include_charts;`
  모두 끄기: `UPDATE pages SET share_include_charts = false, share_charts_by = NULL, share_chart_sources = NULL WHERE share_include_charts;`
- 공유 창의 차트 개수는 폴더 링크에 속한 페이지 가운데 차트 블록이 있는 페이지(최대 300개)의 문서를 읽어서 셉니다. 모두 차트를 담은 큰 페이지 300개짜리 폴더라면 약 0.3초가 들고, 링크 설정을 바꿀 때마다 다시 셉니다.
- 차트가 있는 공개 페이지는 렌더링 결과가 캐시에 없으면 방문할 때마다 차트 집계를 돌립니다(60초짜리 집계 캐시, docs/adr/1602-*는 그대로 적용됩니다). 공개 경로의 한도는 그대로 경로와 IP마다 1분에 60번입니다.
- 새 설정은 없습니다. 공개 페이지 HTML은 콜아웃(아이콘 다음에 글)도 바뀌었고, 글자색과 배경색을 그대로 유지합니다(docs/adr/2387-*). 메모리 안의 렌더링 캐시는 재시작하면 빈 상태로 시작하므로 따로 비울 것은 없습니다.

<a id="16-pdf-preview-021"></a>
## 16. PDF 미리보기 (0.21)

<a id="upgrading-to-021"></a>
### 0.21로 업그레이드하기
마이그레이션도 새 설정도 헤더 변경도 없으니, 평소 절차대로 하면 됩니다(위의 "업그레이드" 절). 0.20 데이터베이스는 적용된 마이그레이션이 62개 그대로입니다. 서버 코드는 0.20과 같고, 이번 릴리스는 웹 앱만 바뀝니다. 열어 둔 탭은 새로고침하라고 사람들에게 알리세요. 아직 0.20이 돌고 있는 탭은 새로고침하기 전까지 PDF를 파일 이름 줄로만 보여 줍니다.

<a id="pdf-preview-docsadr2480---2483-"></a>
### PDF 미리보기 (docs/adr/2480-* .. 2483-*)
- 페이지에 붙인 PDF는 파일 이름 아래에 내용이 보입니다. 브라우저가 pdf.js(`pdfjs-dist` 6.5.438의 legacy 빌드)로 그립니다. 서버는 `GET /files/:id`에 전과 똑같이 답합니다. `Content-Disposition: attachment`, `nosniff`, `sandbox` CSP는 그대로이고, 앱의 CSP도 바뀌지 않았습니다. 미리보기는 내려받기와 똑같이 그 사람의 세션으로 파일을 받아 오고, PDF 안의 어떤 것도 실행하지 않습니다.
- 미리보기 코드, pdf.js, 그 워커(`assets/lazy/pdf.worker.min-*.mjs`), 데이터 파일(`assets/lazy/pdfjs-6.5.438/`: pdf.js의 `LICENSE`, cMap, 표준 글꼴, wasm 디코더, ICC 프로필, 각각의 라이선스 파일)은 앱이 자기 출처에서 내줍니다. CDN도 바깥으로 나가는 요청도 없습니다.
- 리버스 프록시는 `/assets/lazy/`를 그대로 넘겨야 합니다. 이 경로를 막거나 고쳐 쓰면 미리보기가 나오지 않고, 화면에는 "미리보기를 불러오지 못했습니다."(`The preview could not be loaded.`)와 내려받기 링크가 나옵니다. `.mjs`를 JavaScript가 아닌 타입으로 내주는 프록시도 미리보기를 막고, 이때는 오류 문구와 내려받기 링크가 나옵니다.
- `/files/:id`는 바이트 범위를 보내지 않으므로, 1쪽을 그리려면 파일 전체가 필요합니다. 10 MB까지의 파일은 블록이 화면 가까이 오면 불러오고, 그보다 큰 파일은 읽는 사람이 "미리보기 불러오기"(`Load preview`)를 누를 때 불러옵니다(docs/adr/2482-*). 20 Mbit/s에서 10 MB 파일은 약 4 s, 25 MB 파일은 약 10 s가 걸립니다([PERFORMANCE.ko.md](PERFORMANCE.ko.md)).
- pdf.js와 그 파일들은 PWA 프리캐시에 없습니다. 미리보기가 처음 파일을 불러올 때 받아 오고, 서비스 워커는 쓴 것을 따로 둔 `inkling-pdfjs` 캐시(60개, 30일)에 남겨 둡니다. Shiki와 exceljs가 쓰는 `inkling-lazy-assets` 캐시와는 다른 캐시입니다. PDF가 없는 페이지는 아무것도 받지 않습니다. 오프라인에서는 미리보기가 서버에 파일을 물어볼 수 없어서 "파일을 불러오지 못했습니다."(`The file could not be loaded.`)와 내려받기 링크, "다시 시도"(`Try again`)가 나옵니다. 첨부 파일은 오프라인 사본에 들어가지 않습니다.
- 브라우저: pdf.js가 legacy 빌드의 지원 범위로 밝힌 것은 Firefox ESR, Chrome 125+(Edge, Opera), Safari 18+("mostly")입니다. 이번 릴리스는 Chrome 157에서만 확인했습니다(KNOWN-ISSUES PDFVIEW-1). 지원하지 않는 브라우저에서는 미리보기 오류 문구와 내려받기 링크가 나옵니다.
- 적대적이거나 아주 큰 파일에 대한 상한(docs/adr/2483-*): 최대 5,000쪽, 100%에서 쪽 상자 최대 5,000 CSS px, 쪽 캔버스 한 장은 최대 8,388,608 픽셀에 한 변 8,192 px, 한 번에 그리는 쪽은 최대 8쪽, 2^26 픽셀이 넘는 이미지는 그리지 않습니다. 다운로드가 30초 동안 진행되지 않으면 "파일을 받다가 멈췄습니다."(`The file stopped loading.`)와 "다시 시도"가 나옵니다. 미리보기 하나에서 난 오류는 그 블록 안에 머뭅니다.
- 필기 획이 있는 페이지와 필기 모드에서는 미리보기가 없습니다(docs/adr/2481-*). 그래서 PDF가 있는 페이지는 열 때, 필기 모드가 꺼진 채로 열려 있는 동안 60초마다, 탭이 다시 앞에 올 때 획 목록(`GET /api/pages/:id/ink`)을 요청합니다. 서버가 필기 변경을 알리지 않기 때문입니다.
- 그 밖의 서버 쪽 비용은 파일 내려받기 자체와, 미리보기마다 `GET /api/files/:id/meta` 한 번(탭에서 1분 동안 기억)뿐입니다.

<a id="17-limits-and-restricted-mode-022"></a>
## 17. 한도와 제한 모드 (0.22)

<a id="upgrading-to-022"></a>
### 0.22로 업그레이드
마이그레이션은 `0062_limits_accounts` 하나이고 추가만 합니다. 테이블 두 개(`signup_events`, `user_consents`)와 열
네 개(`users.expires_at`, `workspaces.storage_bytes`, `workspaces.storage_checked_at`, `workspaces.over_storage`. 모두
null이거나 고정 기본값)입니다. 0.21 데이터베이스는 적용된 마이그레이션이 62개에서 63개가 됩니다. 아래의 새 설정은
모두 선택입니다. 하나도 주지 않으면 서버는 0.21.1처럼 동작하고, 0.22가 모든 서버에서 바꾸는 것만 달라집니다(CHANGELOG의
"What changes on every server"). 모든 계정이 스스로 계정을 삭제할 수 있고, 혼자 남은 유일 소유자가 워크스페이스에서
나갈 수 있으며(워크스페이스는 바로 삭제됩니다), 소유자가 삭제한 워크스페이스를 완전히 지울 수 있고, 매시간 정리 작업이
차단이 끝난 지 30일이 넘은 `ip_bans` 행을 지웁니다. 또 요청 수 제한이 IPv6 클라이언트를 /64 단위로 세고, 삭제 미리보기는
브라우저 세션에만 답하며, 계정 삭제는 옮겨 적힌 이름을 계정 id로만 찾고, OAuth 토큰 교환은 한 트랜잭션으로 합니다.

`compose.yaml`은 0.22의 변수 22개를 모두 `${VAR:-}`로 앱에 넘기고, `.env.example`에는 변수마다 주석 처리된 예가
있습니다. 그래서 `.env`에 적기만 하면 됩니다. 빈 값은 어느 변수든 설정하지 않은 것과 같습니다. `LEGAL_DIR`은 컨테이너
안의 경로라서 폴더도 마운트해야 합니다(데모 overlay인 `deploy/demo/compose.demo.yaml`에 예가 있습니다).

<a id="limits-and-restricted-mode-docsadr2500---2521-"></a>
### 한도와 제한 모드 (docs/adr/2500-* .. 2521-*)
제한 모드는 두 종류의 서버를 위한 설정 묶음입니다. 디스크 사용량과 인원을 묶고 싶은 설치, 그리고 낯선 사람이 가입할 수
있는 데모 서버입니다. 데모 서버를 여는 순서는 [DEMO.ko.md](DEMO.ko.md)에 있고, 이 절은 참고용 설명입니다.

| 변수 | 형식 | 기본값 | 뜻 | 걸렸을 때의 오류 |
|---|---|---|---|---|
| `LOGIN_ID_MODE` | `email` 또는 `username` | `email` | `username`이면 가입 때 이메일 주소 대신 아이디와 별명을 받습니다. 아이디는 `a-z 0-9 . _ -`로 된 3–30자이고 영문자나 숫자로 시작하며, 소문자로 바꿔 이메일 열에 저장합니다. 예약어(admin, root, support, inkling 등)는 받지 않습니다 | 400 `LOGIN_ID_INVALID`, 409 `LOGIN_ID_TAKEN` |
| `SIGNUP_MAX_USERS` | 정수 ≥ 1 | 없음 | 서버 전체의 계정 수(관리자를 포함한 `users` 행 전부). 가입 트랜잭션 안에서 다시 셉니다. 설정 코드로 만드는 첫 관리자는 거절하지 않습니다 | 403 `SIGNUP_FULL` |
| `SIGNUP_PER_IP_PER_DAY` | 정수 ≥ 1 | 없음 | 한 주소(IPv4 주소나 IPv6 /56)에서 24시간 동안 할 수 있는 가입 수. 이 값이 있는 동안에는 한 주소가 24시간에 받는 "이미 있는 이메일이나 아이디" 답도 10번까지입니다(아래) | 429 `SIGNUP_IP_LIMIT` |
| `ACCOUNT_LIFETIME_DAYS` | 정수 ≥ 1 | 없음 | 이 값이 있는 동안 가입한 계정은 가입하고 이만큼 지나면 삭제됩니다. 관리자와 이 값을 넣기 전에 있던 계정은 만료되지 않습니다 | — |
| `ACCOUNT_LIFETIME_DRY_RUN` | `1` 또는 `0` | `0` | `1`이면 매시간 작업이 지울 계정을 로그로만 남기고 아무것도 지우지 않습니다 | — |
| `LIMIT_WORKSPACES_PER_USER` | 정수 ≥ 1 | 없음 | 한 사람이 소유한 워크스페이스 수. 가입 때 생긴 워크스페이스와, 삭제했지만 아직 복구할 수 있는 것도 셉니다 | 403 `LIMIT_WORKSPACES` |
| `LIMIT_MEMBERS_PER_WORKSPACE` | 정수 ≥ 1 | 없음 | 워크스페이스의 멤버 수(소유자 포함). 페이지 게스트는 멤버가 아니라서 세지 않습니다 | 403 `LIMIT_MEMBERS` |
| `LIMIT_PAGES_PER_WORKSPACE` | 정수 ≥ 1 | 없음 | 워크스페이스의 페이지 수. 문서, 데이터베이스 행, 폴더, 캔버스를 모두 세고 휴지통도 셉니다 | 403 `LIMIT_PAGES` |
| `LIMIT_FILE_MB` | 0보다 큰 수, 25 이하(소수 가능) | 없음(25 MB) | 업로드하는 파일 하나의 크기. 연결과 토큰은 `min(AGENT_UPLOAD_MAX_MB, LIMIT_FILE_MB)`를 받습니다 | 413 `LIMIT_FILE` |
| `LIMIT_WORKSPACE_STORAGE_MB` | 0보다 큰 수(소수 가능) | 없음 | 워크스페이스의 저장 용량(아래). 페이지 하나의 본문은 그 1/4까지만 담을 수 있습니다 | 413 `LIMIT_STORAGE` |
| `LIMIT_VERSIONS_PER_PAGE` | 정수 1–50 | 없음(50) | 페이지마다 남기는 버전 수. 기존 예산 50을 줄이기만 하고, AI 단계가 차지할 수 있는 몫도 함께 줄어듭니다(연결 하나 40 %, 모든 연결 합쳐 60 %) | — |
| `DISABLED_FEATURES` | 쉼표로 구분한 이름 | 비어 있음 | 서버 전체에서 끄는 기능(아래) | 404 `FEATURE_DISABLED` |
| `WORKSPACE_RESTORE_DAYS` | 정수 ≥ 1 | `30` | 소유자가 삭제한 워크스페이스를 복구할 수 있는 일수. 그 뒤에는 정리 작업이 완전히 지웁니다 | — |
| `LEGAL_DIR` | 폴더 경로 | 없음 | 이용약관, 개인정보 처리방침, 가입 동의(아래) | 가입 때 400 `CONSENT_REQUIRED`, 다른 요청에서 403 `CONSENT_REQUIRED` |
| `INSTANCE_LABEL` | 20자 이하, 제어 문자 없음 | 없음 | 모든 화면에 늘 보이는 표시. 예: `Demo` | — |
| `LIMIT_TRASH_DAYS` | 정수 ≥ 7 | 없음 | 페이지 휴지통 보관 일수의 상한. 페이지는 min(워크스페이스의 "휴지통 보관 기간", 이 값)일 동안 휴지통에 남고, MCP `list_trash`도 같은 날짜를 알려 줍니다. 워크스페이스에 저장된 값은 고쳐 쓰지 않습니다. 워크스페이스 설정은 이 상한을 보여 주고 더 큰 값을 받지 않습니다 | 워크스페이스가 더 긴 기간을 고르면 400 `LIMIT_TRASH_DAYS` |
| `INSTANCE_NOTICE` | 500자 이하의 일반 글자(HTML 아님), 줄바꿈 가능 | 없음 | 로그인·가입·동의·운영자 대기 화면의 제목 아래와 모든 앱 화면 위의 띠에 늘 보이는 운영자 공지. 아무도 닫을 수 없고, 링크 없이 글자로만 보입니다. 메일을 보내지 않는 서버에서 변경, 중단, 사고를 알리는 수단입니다 | — |
| `SIGNUP_PER_HOUR` | 정수 ≥ 1 | 없음 | 서버 전체가 한 시간에 만드는 계정 수. 가입 트랜잭션 안에서 잠금 하나를 잡고 다시 셉니다. 설정 코드로 하는 가입은 세지도 거절하지도 않습니다 | 429 `SIGNUP_RATE_LIMIT` |
| `OAUTH_UNUSED_CLIENT_HOURS` | 정수 ≥ 1 | 없음 | 스스로 등록한 OAuth 클라이언트 가운데 한 번도 쓰이지 않은 것을, 등록하고 이만큼 시간이 지나면 매시간 정리 작업이 지웁니다(아래) | — |
| `OAUTH_UNUSED_CLIENT_MAX` | 정수 ≥ 1 | 없음 | 한 번도 쓰이지 않은 자체 등록 OAuth 클라이언트를 남겨 두는 최대 수. 새 등록이 가장 오래된 것부터 지우고, 15분이 안 된 것은 지우지 않습니다(아래) | 그보다 새 것만 남았으면 `/oauth/register`에서 503 `temporarily_unavailable` |
| `LIMIT_WORKSPACES_TOTAL` | 정수 ≥ 1 | 없음 | 서버 전체의 워크스페이스 수. 삭제했지만 아직 복구할 수 있는 것도 세고, 서버 전체에 잠금 하나를 잡고 셉니다. 가입하면 개인 워크스페이스가 생기므로 한도에서는 가입도 거절합니다(설정 코드는 거절하지 않습니다) | 403 `LIMIT_WORKSPACES_TOTAL`; 가입 때 403 `SIGNUP_FULL` |
| `LIMIT_INSTANCE_STORAGE_MB` | 0보다 큰 수(소수 가능) | 없음 | 서버 전체의 저장 공간 퓨즈. 데이터베이스 크기와 데이터 폴더 아래 파일을 더한 값을 1분에 한 번까지 잽니다. 여기에 닿으면 서버는 읽기, 로그인, 내보내기, 삭제만 합니다(아래) | 503 `INSTANCE_FULL`; `/oauth/register`에서 503 `temporarily_unavailable` |

- 1 MB는 1,048,576바이트입니다. 설정하지 않았거나 빈 값이면 "한도 없음"(또는 꺼짐)입니다. 아무것도 설정하지
  않으면 서버는 0.21.1처럼 답하고 아래 검사를 하나도 하지 않습니다.
- 한도는 서버가 페이지, 행, 파일, 멤버, 워크스페이스를 만드는 트랜잭션 안에서 잠금을 잡고 검사합니다. 그래서 동시에 온
  요청이 함께 한도를 넘지 못합니다. 소유권 이전과 워크스페이스 복원은 새 소유자의 소유 워크스페이스 수를 자기
  트랜잭션 안에서 검사하고, 계정 삭제 때 소유권이 넘어가는 것은 한도를 보지 않습니다. MCP 도구는 같은 REST 라우트를 부르므로 똑같이 거절됩니다. 한도 오류에는 모두
  `{ limit, used }`가 붙습니다(API.ko.md의 "v0.22.0 additions").
- `LIMIT_WORKSPACE_STORAGE_MB` 없이 `LIMIT_FILE_MB`만 두면 워크스페이스는 여전히 끝없이 커질 수 있습니다. 둘 다 두면
  디스크의 최악 사용량은 대략 계정 수 × 소유 워크스페이스 수 × 저장 용량 한도(`LIMIT_WORKSPACES_TOTAL`이 있으면 많아야
  그 수 × 저장 용량 한도)에, 세지 않는 것(색인, 감사·알림 행, OAuth 클라이언트)과 백업을 더한 정도입니다.
  `LIMIT_INSTANCE_STORAGE_MB`는 데이터베이스와 데이터 폴더에 거는 퓨즈이지(아래) 디스크의 상한이 아닙니다.

<a id="when-the-server-refuses-to-start"></a>
### 서버가 시작하지 않는 경우
로그에 변수와 이유가 나옵니다. 다음 경우 서버는 시작하지 않습니다.
- 값을 적힌 대로 읽을 수 없을 때. 정수가 필요한 자리에 정수가 아닌 값, 1보다 작은 값, 지수로 쓴 소수, 25보다 큰
  `LIMIT_FILE_MB`, 50보다 큰 `LIMIT_VERSIONS_PER_PAGE`, `1`이나 `0`이 아닌 `ACCOUNT_LIFETIME_DRY_RUN`, `email`이나
  `username`이 아닌 `LOGIN_ID_MODE`, `DISABLED_FEATURES`의 모르는 이름, 20자가 넘거나 제어 문자가 든
  `INSTANCE_LABEL`, 7보다 작은 `LIMIT_TRASH_DAYS`, 500자가 넘거나 줄바꿈 말고 다른 제어 문자가 든 `INSTANCE_NOTICE`.
- `LOGIN_ID_MODE=username`이 `DELEGATED_AUTH_URL`, OpenID Connect, SMTP 메일과 함께 켜져 있거나,
  `DISABLED_FEATURES`에 `password-reset`이 없을 때(아이디는 메일을 받을 수 있는 주소가 아닙니다).
- `LEGAL_DIR`이 읽을 수 있는 폴더가 아니거나, `signup.json`이 없거나, 안의 파일 형식이 틀렸을 때(아래).

다음 경우에는 경고를 남기고 시작합니다. `ACCOUNT_LIFETIME_DAYS` 없이 `ACCOUNT_LIFETIME_DRY_RUN=1`만 있을 때,
`TRUST_PROXY=false`인데 `SIGNUP_PER_IP_PER_DAY`가 있을 때, `LEGAL_DIR`의 파일에 틀의 자리표시자가 남아 있을 때입니다.
시작 로그에는 켜진 한도 한 줄, 꺼진 기능 한 줄이 남고, `ACCOUNT_LIFETIME_DAYS`가 있으면 영향을 받지 않는 기존 계정 수를
알리는 한 줄이 더 남습니다.

<a id="features-turned-off-disabledfeatures"></a>
### 기능 끄기 (`DISABLED_FEATURES`)
라우트는 등록된 채로 남고, 로그인 확인보다 먼저 404 `FEATURE_DISABLED`로 답합니다. 이미 만들어 둔 것은 동작을 멈추지만
지우지는 않고, 그것을 없애는 라우트는 열려 있어서 소유자가 정리할 수 있습니다. 앱은 꺼진 기능의 메뉴를 숨깁니다.

| 이름 | 꺼지는 것 | 그대로 되는 것 |
|---|---|---|
| `public-links` | 공개 링크 게시와 변경, `/api/public/*`. `/s/:token`은 빈 앱 화면을 돌려줍니다 | 게시 취소 |
| `public-forms` | 폼 링크 켜기와 읽기, 공개 폼과 그 응답 | 폼 링크 없애기 |
| `webhooks` | 웹훅 목록, 추가, 변경, 시험, 비밀값, 전송 기록. 아무것도 보내지 않습니다(쌓인 전송은 기다립니다) | 웹훅 삭제 |
| `slack` | Slack 설정, 시험, 연결 흐름, `/inkling` 명령과 이벤트. 아무것도 올리지 않습니다 | Slack 설정과 연결 없애기 |
| `link-preview` | 링크 미리보기 카드(`GET /api/link-preview`) | — |
| `web-clipper` | 웹에서 저장하기(`POST /api/clip`)와 그 조회 | — |
| `ical` | 설정의 iCal 피드 주소. `/ical/:file`은 404로 답합니다 | 피드 해지 |
| `notion-import` | Notion으로 가져오기를 요청하면 거절합니다. Notion에서 내보낸 것처럼 보이는 zip은 일반 Markdown으로 가져옵니다 | Markdown, zip, 폴더 가져오기 |
| `web-push` | 구독, 푸시 설정, 시험, 보내기(쌓인 푸시는 기다립니다) | 기기 구독 해지 |
| `password-reset` | 비밀번호 찾기, 코드로 재설정, 관리자의 임시 비밀번호·재설정 코드·자격 정보 보내기·재설정 요청 목록 | 로그인한 채로 자기 비밀번호 바꾸기 |
| `email-invites` | 관리자 화면에서 가입 키를 메일로 보내기. 페이지 초대도 메일로 보내지 않고 링크를 보여 줍니다 | 키와 링크 복사 |
| `automations-webhooks` | 웹훅을 부르는 버튼 블록과 자동화 동작(그 동작만 건너뛰고 규칙은 켜진 채로 둡니다) | 다른 자동화 동작 |
| `oauth-cimd` | OAuth Client ID Metadata Documents. `OAUTH_CIMD=1`이어도 꺼집니다 | 동적 클라이언트 등록 |
| `embeds` | 다른 사이트의 프레임. 앱의 CSP가 `frame-src 'self'`만 남깁니다 | 이 서버 페이지의 페이지 임베드 |
| `member-direct-add` | 초대 링크 없이 기존 계정을 워크스페이스에 넣기와 그 후보 목록 | 초대 링크 |

설정하기 전에는 이미 꺼져 있는 것은 목록에 없습니다. 실험 기능(`EXPERIMENTAL_FEATURES`), 의미 검색, OpenID Connect,
메일이 그렇습니다. MCP는 켜진 채로 둡니다.

<a id="storage-and-read-only-workspaces"></a>
### 저장 용량과 읽기 전용 워크스페이스
- `LIMIT_WORKSPACE_STORAGE_MB`는 멤버가 끝없이 키울 수 있는 것을 셉니다. 업로드한 파일, 페이지 본문, 버전 기록, 필기,
  코멘트, 페이지 행 자체(제목, 속성, 아이콘), 데이터베이스 필드·뷰·행 템플릿, 직접 만든 템플릿, 변경 기록이 남기는 글,
  에이전트 제안입니다. 휴지통에 있는 페이지는 완전히 지워질 때까지 셉니다. 검색 색인, 감사 기록, 알림, outbox, 사람마다
  두는 테이블, OAuth 클라이언트, 백업은 세지 않습니다.
- 센 값은 `workspaces.storage_bytes`에 둡니다. 업로드는 자기 트랜잭션에서 바이트를 더하고, 페이지 본문을 저장할 때마다
  본문이 늘어난 만큼 더합니다. 정리 작업이 매시간 모든 워크스페이스를 다시 세고, 워크스페이스 설정 › 일반은 저장해 둔
  값이 1분보다 오래되었으면 다시 세고(워크스페이스마다 1분에 한 번까지), 완전히 지운 뒤에도 다시 셉니다.
- 한도에 닿은 워크스페이스는 읽기 전용이 됩니다. 담긴 것을 키울 수 있는 쓰기는 모두 413 `LIMIT_STORAGE`로
  거절합니다(docs/adr/2533-*). 새 페이지, 업로드, 가져오기, 템플릿, 코멘트와 코멘트 본문 고치기, 필기, 수동 버전, REST와
  MCP의 본문 쓰기, 빠른 할 일, vault 동기화, 행과 행 속성, 데이터베이스 필드·뷰·행 템플릿, 페이지의 제목·아이콘·표지·
  별칭·날짜 속성, 에이전트 제안이고, 새 자동화·웹훅·공유 링크도 거절합니다. 실시간 편집 연결은 읽기 전용이 됩니다. 크기가
  정해진 설정을 그 자리에서 바꾸기, 할 일 체크, 멤버 관련, 복원과 없애기는 열어 둡니다(API.ko.md에 목록이 있습니다).
  멤버는 페이지 위에서 안내("이 워크스페이스는 저장 용량을 다 써서 읽기 전용입니다. …", `This workspace has used up its
  storage, so it is read-only. …`)를 봅니다. 페이지와 파일 삭제, 휴지통 비우기, 필기 지우기, 내보내기는 언제나 됩니다.
- 다시 쓸 수 있게 하려면 파일이나 페이지를 지우고 휴지통을 비운 뒤, 워크스페이스 설정 › 일반을 열거나(다시 셉니다)
  매시간 계산을 기다립니다. 워크스페이스가 한도 아래로 돌아온 것을 확인한 계산이 읽기 전용 편집 연결을 닫고, 연결은
  바로 다시 붙어 편집할 수 있게 됩니다(KNOWN-ISSUES LIMITS-3).
- 페이지 하나의 본문은 한도의 1/4까지만 담을 수 있습니다. 넘으면 그 페이지에 대한 REST와 MCP 쓰기를 거절하고 실시간
  연결은 읽기 전용이 됩니다. 빠져나오는 길은 하위 페이지로 나누는 것입니다(KNOWN-ISSUES LIMITS-2).
- 위의 쓰기는 저장해 둔 값을 요청 크기만큼 바로 올립니다(위쪽 어림값). 그래서 한도 가까이에서는 들어갈 수 있는 큰
  쓰기가 거절될 수 있습니다. 거절하기 전에 센 값이 10초보다 오래되었으면 서버가 워크스페이스를 다시 세므로 오래가지는
  않습니다.
- 실시간 편집은 적용하기 전에, 도착할 때 셉니다(docs/adr/2530-*). 페이지 본문을 한도의 1/4 넘게, 또는 워크스페이스를
  한도 넘게 키울 편집이나 인스턴스 저장 공간 퓨즈가 끊긴 동안 온 편집은 적용하지도 저장하지도 않습니다. 연결은 읽기
  전용이 되고 읽기 전용으로 다시 붙으며, 그 뒤 10분 동안(또는 워크스페이스에 공간이 생긴 것을 계산이 확인하거나 서버가
  재시작할 때까지) 그 페이지의 연결은 읽기 전용으로 열립니다. 그때 입력하거나 붙여 넣은 내용은 그 사람의 편집기와 기기에만 남습니다(KNOWN-ISSUES
  LIMITS-24).
- `LIMIT_WORKSPACE_STORAGE_MB`나 `LIMIT_INSTANCE_STORAGE_MB`가 있으면 협업 소켓은 클라이언트가 보내는 양도 묶습니다. 한
  클라이언트 주소의 소켓들이 16 MB를 함께 쓰고 초당 4 MB씩 다시 채워지며, 소켓 하나는 아직 열지 않은 문서에 대한
  메시지를 8 MB까지만 쌓아 둘 수 있습니다. 어느 쪽이든 넘으면 소켓을 끊습니다. 두 설정이 다 없으면 이 검사는 하나도
  돌지 않습니다.

<a id="instance-storage-fuse"></a>
### 인스턴스 저장 공간 퓨즈
`LIMIT_INSTANCE_STORAGE_MB`(docs/adr/2532-*)는 데모처럼 낯선 사람이 채울 수 있는 서버에서 쓰기를 멈춥니다. 크기
제한이 있는 파일시스템보다 약하므로(KNOWN-ISSUES LIMITS-27) 데모에는 그런 파일시스템도 따로 주세요(아래).

- **재는 것**: 앱 데이터베이스의 `pg_database_size`에 데이터 폴더(`DATA_DIR`: 업로드, 가져오기·내보내기 임시 폴더,
  플러그인) 아래 모든 파일의 바이트를 더합니다. 파일은 디스크를 직접 돌며 셉니다. 재는 것은 1분에 한 번까지이고, 검사가
  마지막 측정이 그보다 오래된 것을 볼 때, 매시간 정리 작업 때, 실시간 편집이 들어오는 동안 뒤에서 잽니다. 측정이
  실패하면 마지막 답을 그대로 씁니다. 퓨즈가 끊길 때와 다시 아래로 내려올 때 로그에 한 줄씩 남습니다.
- **가득 찼을 때 멈추는 것**(합이 한도에 닿았을 때): `/api` 아래의 POST, PUT, PATCH는 로그인 확인보다 먼저 503
  `INSTANCE_FULL`로 답하고, 가입도 같습니다(설정 코드 가입은 아닙니다). 새 OIDC 계정을 거절하고, `POST /oauth/register`는
  503 `temporarily_unavailable`로 답하며, 실시간 편집 연결은 읽기 전용이 되어 읽기 전용으로 다시 붙습니다. 앱은 띠를
  보여 주고("이 서버의 저장 공간이 가득 찼습니다. 지금은 읽기와 삭제만 됩니다."), MCP 도구는 에이전트에게 다시 시도하지
  말라고 알립니다.
- **그대로 되는 것**: GET과 DELETE는 언제나 통과하므로 읽기, 내보내기, 그리고 페이지·파일·워크스페이스·휴지통·자기 계정
  삭제가 됩니다. 다른 쓰기 가운데 열려 있는 것은 다음과 같습니다(`quota/instanceGate.ts`). 로그인과 로그아웃, 2단계 로그인,
  비밀번호 바꾸기와 재설정, 2단계 인증 설정, 약관 동의, POST로 보내는 읽기(데이터베이스 쿼리, 차트 집계, vault 동기화 읽기,
  공개 링크 잠금 풀기), 읽음 표시(받은 편지함, 알림, 스레드), 없애거나 넘기기만 하는 것(제안 거절과 철회, 게시 취소, 게스트
  빼기, 연결 해제, 소유권 이전), 관리자 라우트(`/api/admin/**`)입니다. 측정에서 서버가 다시 한도 아래로 내려오면 쓰기는
  바로 되고, 읽기 전용 편집 연결은 다시 붙어 편집할 수 있습니다.
- 관리자 › 상태에 **서버 저장 공간 상한**이 사용량, 한도, 데이터베이스, 파일과 함께 나옵니다. 끊기면 빨강, 90 %부터
  주황입니다.

**끊긴 퓨즈는 대개 운영자가 풀어야 합니다.** 행을 지워도 데이터베이스 파일은 작아지지 않습니다. Postgres는 그 공간을 각
테이블 안에서 다시 쓰려고 남겨 둡니다. 0.22.0을 위해 잰 값(ADR 2532): 60 × 5 MB로 데이터베이스가 11.4 MB에서 322.6 MB가
되었고, 모든 행을 지워도 322.6 MB였으며, 행 절반을 지운 경우 `VACUUM` 뒤에도 326.2 MB로 끊긴 그대로였고, 그 테이블에
`VACUUM FULL`을 하자 167.0 MB가 되어 풀렸습니다. 그러니 멤버가 페이지를 지우는 것만으로는 대개 풀리지 않습니다. 푸는
방법은 다음과 같습니다.

1. 가장 큰 테이블을 찾습니다(TOAST 데이터와 색인 포함). 보통 `page_docs`와 `page_snapshots`가 앞에 옵니다.
2. 없앨 것을 지우게 합니다. 삭제한 워크스페이스는 완전히 지우고, 휴지통을 비우고, 없앨 계정을 지웁니다.
3. 그 테이블들에 하나씩 `VACUUM FULL`을 돌립니다. 도는 동안 테이블을 잠그고, 테이블의 살아 있는 데이터만큼 빈 디스크가
   필요합니다.
4. 아니면 `LIMIT_INSTANCE_STORAGE_MB`를 올리고 재시작합니다. 이 가운데 하나를 할 때까지 서버는 읽기와 삭제만 합니다.

```sh
# a demo (deploy/demo/demo.sh); on a main instance: docker compose exec db psql -c "…"
deploy/demo/demo.sh exec db psql -c "SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY pg_total_relation_size(oid) DESC LIMIT 10"
deploy/demo/demo.sh exec db psql -c 'VACUUM FULL page_snapshots'
```

**퓨즈가 묶지 못하는 것.** WAL(`max_wal_size`까지, 기본 1 GB이고 백업이나 긴 트랜잭션이 붙잡고 있으면 더), 백업 묶음,
컨테이너 로그(서비스마다 3 × 10 MB), 두 측정 사이 1분 동안 늘어나는 것, 끊긴 뒤에도 늘어나는 것(세션, 열려 있는 쓰기의
감사 행)은 보지 못합니다. 다시 쓰기도 데이터베이스를 부풀립니다. 5 MB 값 하나를 8초 동안 40번 다시 쓰자 207.5 MB가
늘었고, 한 클라이언트 주소는 협업 소켓으로 초당 4 MB(분당 약 240 MB)를 보낼 수 있습니다. 그래서 주소 몇 개가 1~2분 동안
최대 속도로 쓰면, 센 데이터가 2,000 MB인 데모의 3,000 MB 퓨즈를 끊을 수 있습니다. 멈추는 것은 그 서버뿐이지만, 운영자가
손대기 전까지 멈춘 채로 있습니다.

퓨즈가 `L` MB일 때의 디스크 예산: 살아 있는 데이터 `L`에 1분 동안 늘어나는 양, WAL 약 1 GB, 매일 백업 한 묶음마다 많아야
`L`(압축되지 않는 내용), 로그입니다. 데모 기본값(3,000 MB, 매일 백업 7벌)이면 최악의 경우 약 3 + 1 + 7 × 3 = 25 GB입니다.
데모의 Docker 볼륨은 크기 제한이 있는 별도 파일시스템에 두어, 퓨즈가 놓친 것이 본 인스턴스가 쓰는 디스크를 채우지
못하게 하세요.

<a id="terms-and-consent-legaldir"></a>
### 약관과 동의 (`LEGAL_DIR`)
- 폴더에는 `terms.ko.md`, `terms.en.md`, `privacy.ko.md`, `privacy.en.md`(있는 것만)와 `signup.json`(가입 화면 맨 위의
  고지와 체크 항목: `id`, `required`, `label`, 선택인 `doc`과 `details`)이 들어갑니다. 파일 설명은
  [DEMO.ko.md](DEMO.ko.md)에 있고, `deploy/demo/legal/`에 틀이 있습니다.
- 서버는 시작할 때 폴더를 한 번 읽습니다. `signup.json`의 형식이 틀리면(JSON이 아님, 모르는 키, 빈 라벨, 겹치는 id, 파일이
  없는 `doc`, 32개가 넘는 항목) 시작하지 않고, 빈 문서나 512 KB가 넘는 문서도 마찬가지입니다. 폴더 안의 다른 파일은
  무시하고 로그에 적습니다.
- 버전은 문서들과 `signup.json`에 대한 SHA-256의 앞 16진수 12자입니다. 그래서 무엇이든 고치면 재시작해야 하고, 재시작한
  뒤에는 관리자를 포함한 모든 사람이 다시 동의해야 계속 쓸 수 있습니다.
- 동의는 가입할 때 항목마다 받아 저장합니다(`user_consents`, 버전과 주소를 함께). 다른 길(위임 로그인, OIDC)로 생긴
  계정과, 약관이 바뀐 뒤의 모든 사람은 앱 대신 동의 화면을 봅니다. 동의하기 전에는 그 사람의 모든 요청을 403
  `CONSENT_REQUIRED`로 거절합니다. 브라우저, 개인 API 토큰, MCP 연결(`/mcp` 요청 자체가 HTTP 403으로 거절됩니다), 협업
  소켓이 모두 그렇습니다. 로그아웃, 문서 읽기, 동의, 계정 삭제는 됩니다. 동의 화면에 **계정 삭제**가 있고, 거기에는
  내보내기가 없습니다(내보내기는 동의 전에 열려 있지 않고, 대화상자가 그렇게 알려 줍니다). 전에 만들어 둔 자동화 규칙은
  계속 돕니다.
- `/terms`와 `/privacy`는 로그인하지 않아도 열립니다. 로그인·가입 화면과 설정에서 이 둘로 갑니다.

<a id="sign-up-limits-and-trustproxy"></a>
### 가입 제한과 `TRUST_PROXY`
- `SIGNUP_PER_IP_PER_DAY`에는 클라이언트의 실제 주소가 필요합니다. 이 주소는 `TRUST_PROXY` 주소에서 온 연결의
  `X-Forwarded-For`에서만 읽습니다. 기본값 `loopback,uniquelocal`은 모든 사설 대역(10/8, 172.16/12, 192.168/16,
  fc00::/7)도 믿으므로, 그런 망에서 앱 포트에 닿을 수 있는 사람은 지어낸 주소를 보낼 수 있습니다. `TRUST_PROXY`는
  리버스 프록시의 주소로만 두고, 앱 포트는 `127.0.0.1` 밖으로 열지 마세요. 사설 주소나 루프백 주소에서 온 가입은, 프록시가
  이 헤더를 보내지 않는다는 신호로 보고 로그에 한 번 남깁니다.
- 가입 제한은 IPv6 클라이언트를 /56 단위로(가입자 하나가 보통 적어도 그만큼을 받습니다), IPv4 클라이언트를 주소로 세고,
  IPv4-mapped IPv6 주소는 그 IPv4 주소로 셉니다. 모든 서버의 요청 수 제한은 IPv6를 /64 단위로 세고, 로그인 실패 차단은
  그대로입니다.
- `SIGNUP_MAX_USERS`, `SIGNUP_PER_IP_PER_DAY`, `SIGNUP_PER_HOUR` 가운데 하나가 있으면 가입 양식에 비워 둬야 하는 숨은
  입력란이 생기고, 양식이 화면에 2초 이상 떠 있어야 합니다(아니면 400 `SIGNUP_CHECK_FAILED`). 이 검사는 단순한 스크립트만
  막습니다. 피해를 묶는 것은 상한들이고, 상한도 서버가 차는 것을 늦출 뿐 막지는 못합니다(KNOWN-ISSUES LIMITS-10, LIMITS-28).
- `SIGNUP_PER_HOUR`는 지난 한 시간 동안 서버가 만든 계정을 셉니다(429 `SIGNUP_RATE_LIMIT`, "한 시간 뒤에 다시 시도하세요").
  설정 코드로 하는 가입은 세지도 거절하지도 않습니다.
- `SIGNUP_PER_IP_PER_DAY`가 있는 동안에는 이메일이나 아이디가 이미 있어 거절된 가입을 그 주소에 기록합니다(`signup_events`에
  `taken:`과 주소로). 24시간에 이런 답을 10번 받은 주소는 그 뒤 모든 가입에 429 `SIGNUP_IP_LIMIT`를 받고, 서버는 이름이
  있는지 알려 주기 전에 거절합니다. `SIGNUP_PER_IP_PER_DAY`가 없으면 기록하지 않고 답의 수도 묶지 않습니다.
- 가입 주소 기록은 30일 뒤 지웁니다. 매시간 정리 작업은 모든 서버에서 차단이 끝난 지 30일이 넘은 `ip_bans` 행도
  지웁니다. 아직 유효한 차단은 건드리지 않습니다.
- 관리자가 없는 서버에서 공개 가입(`SIGNUP_REQUIRE_KEY=0`)을 열면 첫 계정이 관리자가 됩니다. 제한 가입(`SIGNUP_MAX_USERS`,
  `SIGNUP_PER_IP_PER_DAY`, `ACCOUNT_LIFETIME_DAYS` 가운데 하나가 있거나 `LOGIN_ID_MODE=username`. `SIGNUP_PER_HOUR`만 있는
  것은 제한 가입이 아닙니다)에서는 관리자가 없는
  서버가 설정 코드 없는 가입을 다른 어떤 검사보다 먼저 거절하고(403 `SETUP_REQUIRED`) 가입 화면에는 운영자를 기다린다는
  안내만 나옵니다. 운영자 계정은 로그에 나온 설정 링크(`/setup?code=…`, `PUBLIC_URL` 주소로 엽니다)로 만듭니다. 그 뒤에는
  설정한 대로 가입이 열립니다. 로그인은 여전히 관리자로 올립니다. OIDC나 위임 로그인이 켜져 있으면(상한이나 수명과는 함께
  쓸 수 있고, 아이디 로그인과는 쓸 수 없습니다), 그리고 계정은 있는데 관리자가 없는 서버에서는 처음 로그인한 계정이
  관리자가 됩니다(KNOWN-ISSUES LIMITS-19, LIMITS-20).

<a id="unused-oauth-clients"></a>
### 쓰이지 않은 OAuth 클라이언트
`POST /oauth/register`는 계정 없이 부를 수 있고, 부를 때마다 클라이언트 행을 하나 저장합니다(많아야 약 20 KB). 낯선
사람에게 열린 서버에서는 두 설정으로 이 행을 묶습니다(docs/adr/2536-*). 둘 다 기본은 꺼짐이고, 없으면 아무것도 지우지
않습니다.
- **한 번도 쓰이지 않음**은 스스로 등록한 클라이언트(`ink_c_…`) 가운데 무엇도 가리키지 않는 것입니다. 인가 코드, grant,
  에이전트 접근 기록, 에이전트 차단이 하나도 없어야 합니다. 만료된 grant도 매시간 OAuth 정리가 지울 때까지(마지막 갱신
  60일 뒤) 쓰인 것으로 셉니다. 에이전트 연결 토큰(`ink_tc_…`)과 메타데이터 문서 클라이언트(id가 URL인 것)는 이렇게 지우지
  않고, 누군가 연결한 적이 있는 클라이언트도 지우지 않습니다.
- `OAUTH_UNUSED_CLIENT_HOURS`: 매시간 정리 작업이 등록한 지 이만큼 시간이 넘은, 쓰이지 않은 클라이언트를 지웁니다.
- `OAUTH_UNUSED_CLIENT_MAX`: 쓰이지 않은 클라이언트가 이 수를 넘게 될 등록은 먼저 가장 오래된 것을 지웁니다. 최근
  15분 안에 등록한 것은 지우지 않습니다(누군가 그것으로 로그인이나 동의 화면에 있을 수 있습니다). 그런 것만 남았으면
  등록을 503 `temporarily_unavailable`과 `Retry-After`로 거절합니다.
- 클라이언트가 지워진 앱은 인가 단계에서 거절되고(400 `INVALID_CLIENT`) 다시 등록해야 합니다(KNOWN-ISSUES LIMITS-30).
- 데모 값(24시간, 500)이면 쓰이지 않은 행은 약 500 × 23 KB 아래에 머뭅니다.

<a id="account-lifetime"></a>
### 계정 수명
- `ACCOUNT_LIFETIME_DAYS`는 이 값이 있는 동안 가입한 계정에만 만료일을 주고, 관리자에게는 주지 않습니다. 나중에 켜도
  기존 계정은 그대로이고, 끄면 만료일이 있는 계정도 지우지 않습니다.
- **껐다가 다시 켜면** 계정이 전에 받은 만료일이 그대로 살아 있어서, 다음 매시간 작업이 꺼져 있던 동안 만료일이 지난
  계정을 모두 한꺼번에 지웁니다. 다시 켜기 전에 관리자 › 사용자에서 만료일을 보고, 적용하지 않을 것은 옮기거나 푸세요(KNOWN-ISSUES LIMITS-33).
- 매시간 만료된 계정을 50개까지, 만료일이 오래된 것부터 하나씩 따로 트랜잭션을 열어 지웁니다. 하나가 실패하면 로그 한
  줄을 남기고 다음 계정으로 넘어갑니다. 로그에는 계정 id와 개수만 남고 이름이나 아이디는 남지 않습니다.
- 처음에는 `ACCOUNT_LIFETIME_DRY_RUN=1`로 시작하세요. 그러면 작업이 지울 계정마다 한 줄을 남기고("would delete user
  …, N workspace(s) deleted, M handed over") 아무것도 지우지 않습니다. 첫 계정들이 만료일을 지났을 때 로그가 꼭 그
  계정들만 적는지 보고, 값을 지운 뒤 재시작합니다.
- 만료된 계정은 스스로 탈퇴한 것과 같이 지워집니다(아래). 백업에는 백업이 순환될 때까지 남습니다.
- 관리자 › 사용자에 만료일과 **만료 해제**가 나옵니다. `GET`과 `PATCH /api/admin/users/:id/expiry`로 만료일을 읽고, 옮기고,
  풀 수 있습니다. 만료일이 없는 계정에 새로 주지는 않습니다.

<a id="account-deletion"></a>
### 계정 삭제
- 모든 서버에서 모든 계정이 스스로 계정을 삭제할 수 있습니다(설정 › 계정 › **계정 삭제**, `DELETE /api/me`). 브라우저
  세션에서만 되고, 현재 비밀번호(2단계 인증이 켜져 있으면 그 코드도)가 필요하며, 위임 로그인과 OIDC 계정은 로그인하고
  10분 안에만 됩니다. 유일한 관리자는 삭제할 수 없습니다.
- 바로 지워지고 되돌릴 수 없습니다. 그 사람만 멤버인 워크스페이스와, 그 사람이 혼자 소유한 삭제된(아직 복원할 수 있는)
  워크스페이스는 파일까지 지웁니다. 그 사람이 혼자 소유한 공유
  워크스페이스는 가장 오래된 관리자 역할 멤버, 없으면 가장 오래된 멤버에게 넘어갑니다(받은 사람에게 알림이 갑니다).
  개인 페이지는 지우고, 공유 페이지·코멘트·버전은 이름 없이 남깁니다. 다른 멤버가 쓴 멘션과 감사 기록 속 이름 없는 id는
  남습니다(KNOWN-ISSUES LIMITS-8).
- 옮겨 적힌 이름은 계정 id로만 찾습니다. 감사 기록의 이름(행위자, 대상, 쓰는 쪽이 id 옆에 남긴 이름)과, 이 계정이 가입
  때 만든 워크스페이스(`<name>의 워크스페이스`, `<name>'s workspace`)입니다. 이름이 같은 다른 사람의 기록은 바뀌지 않습니다. 0.22.0 전에 쓰인 감사
  행 네 종류(페이지 잠금, 잠금 편집자 바꾸기, 에이전트 차단과 차단 해제)의 이름은 옆에 id가 없어서 남습니다.
- 삭제할 것을 보여 주는 미리보기(`GET /api/me/delete-preview`)는 브라우저 세션에만 답합니다.
- 관리자 › 사용자의 **삭제**는 0.21 동작 그대로입니다(409 `SOLE_OWNER`, 개인 페이지는 휴지통으로).

<a id="admin-status"></a>
### 관리자 상태 화면
- "보안 설정" 카드에 항목 두 개가 생깁니다. **계정 수 상한**은 누구나 가입할 수 있을 때 나오고, 프로덕션에서
  `SIGNUP_MAX_USERS`가 없으면 주황입니다. **계정 수명**은 `ACCOUNT_LIFETIME_DAYS`나 시험 실행이 설정되어 있을 때 나오고,
  시험 실행 중에는 주황입니다.
- `LIMIT_INSTANCE_STORAGE_MB`가 있으면 저장 공간 묶음에 **서버 저장 공간 상한**이 나옵니다(위의 "인스턴스 저장 공간 퓨즈").
