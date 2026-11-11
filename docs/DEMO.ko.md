# 데모 인스턴스 운영하기

데모 인스턴스는 처음 보는 사람도 가입해서 써 볼 수 있게 따로 띄우는 Inkling 서버입니다. 운영 중인 서버 옆에서 돌지만 나눠 쓰는 것은 없습니다. compose 프로젝트, 데이터베이스, 볼륨, 네트워크, 포트가 모두 따로입니다. 0.22의 제한 모드가 이런 서버에 필요한 것을 켭니다. 이메일 대신 아이디로 가입, 전체 계정 수 상한, IP별 가입 횟수 제한, 가입 14일 뒤 계정 삭제, 워크스페이스·멤버·페이지·저장 용량 한도, 밖으로 데이터를 보내는 기능을 서버 전체에서 끄는 스위치, 가입할 때 약관 동의, 모든 화면의 "Demo" 표시가 그것입니다. English: [DEMO.md](DEMO.md).

파일은 [`deploy/demo/`](../deploy/demo/)에 있습니다. `demo.sh`(데모를 띄우고 내리고 확인하는 유일한 방법), `compose.demo.yaml`(`compose.yaml`에 덧씌우는 파일), `demo.env.example`(설정), `legal/`(이용약관, 개인정보 처리방침, 가입 화면 문구의 틀)입니다. 설계 설명은 ADR 2500–2529와 2535–2539에 있습니다.

<a id="1-start-it-as-a-separate-instance"></a>
## 1. 별도 인스턴스로 띄우기

데모는 따로 만든 폴더에서 배포합니다. 같은 릴리스를 한 번 더 받은 사본이어야 하고, 운영 인스턴스를 실행하는 폴더를 쓰면 안 됩니다(그 폴더의 `.env`와 평소 명령은 운영용입니다). 같은 서버에서 돌려도 됩니다.

```bash
git clone <the Inkling repository> /srv/inkling-demo/inkling    # a second copy, at the release you run
cd /srv/inkling-demo/inkling
cp deploy/demo/demo.env.example deploy/demo/demo.env
# fill in DEMO_POSTGRES_PASSWORD and DEMO_APP_SECRET_KEY (new values, see "Secrets" below)
# and PUBLIC_URL: the public https address people will use (for example https://demo.example.com)
deploy/demo/demo.sh config     # check what would run; changes nothing
deploy/demo/demo.sh up
```

데모 명령은 모두 `deploy/demo/demo.sh`(`config`, `up`, `down`, `destroy`, `ps`, `logs`, `exec`)로 실행하고, `docker compose`를 직접 부르지 않습니다. 스크립트는 언제나 프로젝트 이름 `inkling-demo`, compose 파일 두 개, `deploy/demo/demo.env`(다른 파일은 `--env-file`로)를 쓰고, 셸의 변수는 `PATH`, `HOME`, Docker 연결 변수 말고는 넘기지 않습니다. 셸에 `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, `INKLING_DATA_NAME`이 있으면 바로 멈춥니다. `up`, `down`, `destroy` 전에는 해석된 설정을 읽어서, 프로젝트가 `inkling-demo`이고 모든 볼륨과 네트워크 이름이 `inkling-demo_…`이고 데이터베이스와 그 역할이 `inkling_demo`이고 3000번 포트(운영의 기본값)가 없을 때만 진행합니다. 하나라도 어긋나면 아무것도 하지 않고 거절합니다. `config`는 같은 검사 결과를 보여 주고, `up`은 `CHANGE-ME`가 남은 비밀 값도 거절합니다. 이 이름들은 `compose.demo.yaml`에 글자로 적혀 있어서 운영 인스턴스가 쓰는 변수로는 데모를 운영 데이터로 돌릴 수 없고, 덧씌우는 파일을 `docker compose`로 직접 쓰면 안내와 함께 멈춥니다. 데모 설정은 모두 필수라서 운영용 `.env`로 한도 없는 데모가 뜨는 일도 없습니다. `down`은 데모의 볼륨을 남기고, `destroy`는 프로젝트 이름을 직접 입력해야 볼륨까지 지웁니다. 앱은 `127.0.0.1:3100`(`DEMO_PORT`)에서만 듣습니다. 3단계 전까지는 밖에서 열 수 없습니다.

<a id="secrets"></a>
### 비밀 값

데모의 비밀 값은 새로 만들고, 운영 인스턴스의 값을 복사하지 않습니다. 두 인스턴스의 로그인과 토큰이 서로 통하지 않는 것은 이 값들이 다를 때뿐입니다.

```bash
openssl rand -base64 32    # DEMO_POSTGRES_PASSWORD
openssl rand -base64 32    # DEMO_APP_SECRET_KEY
openssl rand -base64 32    # DEMO_BACKUP_PASSPHRASE, only if BACKUP_RCLONE_REMOTE is set
```

데모 전용 이름이라서 셸에 내보내 둔 운영 값이 섞여 들어가지 않습니다.

운영자 계정이 생기기 전(4단계)에는 설정 링크로 하는 가입 말고는 어떤 가입도 받지 않습니다. 가입 상한, 계정 수명, 아이디 가입 가운데 하나라도 켜져 있고 관리자가 없는 서버는 다른 가입을 모두 `SETUP_REQUIRED`로 거절하고, 가입 화면에는 운영자를 기다린다는 안내만 보입니다. 그래서 단계의 순서와 상관없이 처음 온 낯선 사람이 관리자가 되는 일은 없습니다.

<a id="2-fill-in-the-terms-folder"></a>
## 2. 약관 폴더 채우기

운영자를 포함해 누구든 가입하기 전에 합니다. 모든 사람은 폴더의 버전에 동의하고, 나중에 고치면 모두 다시 동의해야 합니다.

`deploy/demo/legal/`은 자리표시자 네 개가 들어 있는 틀입니다. `{{OPERATOR_NAME}}`, `{{CONTACT_EMAIL}}`, `{{SERVICE_URL}}`, `{{EFFECTIVE_DATE}}`입니다. 저장소 밖으로 복사해서 채우고, `demo.env`의 `DEMO_LEGAL_DIR`이 그 사본을 가리키게 합니다.

```bash
sudo mkdir -p /srv/inkling-demo && sudo cp -r deploy/demo/legal /srv/inkling-demo/legal
# edit the four placeholders in /srv/inkling-demo/legal/*.md, then in demo.env:
#   DEMO_LEGAL_DIR=/srv/inkling-demo/legal
deploy/demo/demo.sh up
```

서버는 시작할 때 폴더를 한 번 읽습니다. `signup.json` 형식이 틀리면 로그에 파일 이름과 이유를 남기고 멈춥니다. 문서에 자리표시자가 남아 있으면 시작할 때마다 경고합니다. 폴더의 버전은 파일 내용의 해시라서, 파일을 고치고 다시 시작하면 운영자를 포함한 모든 계정이 다음 요청에서 다시 동의해야 합니다. 다시 시작하면 열려 있던 편집 연결도 끊기므로, 옛 약관으로 계속 쓰는 사람은 없습니다.

폴더에 들어가는 파일은 다음과 같습니다.

| 파일 | 쓰임 |
|---|---|
| `terms.ko.md`, `terms.en.md` | 이용약관. `/terms`에 보입니다 |
| `privacy.ko.md`, `privacy.en.md` | 개인정보 처리방침. `/privacy`에 보입니다 |
| `signup.json` | 가입 화면 맨 위 고지와 체크 항목(`id`, `required`, `label`, 선택 `doc`과 `details`) |

한 언어로만 쓴 문서는 모든 사람에게 그 언어로 보입니다. 문서는 Markdown입니다. 문서 안의 HTML은 글자로 보이고, 링크는 `http`, `https`, `mailto`만 동작합니다.

틀은 이 문서의 설정으로 앱이 하는 일을 적었습니다. 설정을 바꾸면 그 설정에 관한 문장(가입 14일 뒤 삭제, 휴지통 7일, 한도, 꺼 둔 기능)을 확인합니다.

<a id="3-proxy"></a>
## 3. 프록시

`PUBLIC_URL`에 적은 주소로 `127.0.0.1:3100` 앞에 HTTPS를 둡니다. https 주소면 로그인 쿠키에 Secure가 붙습니다. 호스트에서 Caddy를 쓰면 다음과 같습니다.

```
demo.example.com {
	encode gzip zstd
	reverse_proxy 127.0.0.1:3100
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}
```

`TRUST_PROXY=loopback,uniquelocal`이면 프록시에서 온 요청은 `X-Forwarded-For`에서 실제 주소를 읽습니다. IP별 가입 횟수 제한에 이 주소가 필요합니다. 프록시가 접근 로그를 남긴다면 그 로그에도 IP 주소가 들어 있습니다. 처리방침 틀은 앱 자체의 기록(10MB 파일 세 개, 오래된 것부터 지움)을 적었으니, 프록시 로그도 그보다 오래 두지 않거나 그 규칙을 처리방침에 적습니다.

<a id="4-create-the-operator-account-with-the-setup-link"></a>
## 4. 설정 링크로 운영자 계정 만들기

```bash
deploy/demo/demo.sh logs app | grep -A2 'No accounts yet'
```

로그에 나온 `/setup?code=…` 링크를 엽니다. 링크는 `PUBLIC_URL`로 만들어지므로 프록시를 거쳐 공개 주소에서 열립니다. 서버는 `PUBLIC_URL`이 아닌 출처에서 보낸 양식을 거절하므로 그 주소를 씁니다(`PUBLIC_URL`을 그렇게 바꾸지 않았다면 터널로 연 `localhost:3100`에서는 안 됩니다). 링크는 계정이 하나도 없을 때 한 번만 쓸 수 있고, 그 전에 다시 시작하면 새 링크가 나옵니다. 설정 화면에도 가입 화면과 같은 동의 항목이 나옵니다. 운영자도 약관에 동의합니다. 관리자 계정은 만료되지 않습니다. 계정이 생기면 가입 화면이 모두에게 열립니다.

<a id="5-check-before-you-announce-it"></a>
## 5. 알리기 전에 확인할 것

- 시작 로그에 켜진 한도 한 줄, 꺼진 기능 한 줄, 버전이 적힌 `LEGAL_DIR` 한 줄이 있고, 자리표시자 경고는 없습니다.
- `curl -s https://demo.example.com/api/auth/mode`에 `loginId`, `instanceLabel`, `legal`, `limits`(`trashDays` 포함), `disabledFeatures`가 보이고 `setupPending`이 `false`입니다.
- 시크릿 창에서 가입 화면이 아이디를 묻고, 고지와 체크되지 않은 항목 여섯 개를 보여 주며, 모두 체크하기 전에는 가입 단추가 꺼져 있습니다. `/terms`와 `/privacy`는 로그인하지 않아도 열립니다.
- 가입한 뒤 삭제 예정일이 보이고, 휴대폰과 컴퓨터 모두에서 "Demo" 표시가 보입니다.
- `deploy/demo/demo.sh config`가 `ok` 줄만 보여 주고, `deploy/demo/demo.sh ps`에 공개된 데이터베이스 포트가 없으며 앱은 `127.0.0.1:3100`만 있습니다.
- 관리자 › 백업에 일 7, 주 0, 월 0이 보입니다.
- 한 네트워크에서 하루에 세 번째 가입은 거절됩니다(프록시가 실제 주소를 넘깁니다).

<a id="settings"></a>
## 설정

한 줄씩만 적습니다. 자세한 설명은 운영 문서에 있습니다.

| 변수 | 데모 값 | 뜻 |
|---|---|---|
| `LOGIN_ID_MODE` | `username` | 이메일 대신 아이디와 별명으로 가입 |
| `SIGNUP_REQUIRE_KEY` | `0` | 가입 키 없이 누구나 가입 |
| `SIGNUP_MAX_USERS` | `50` | 서버 전체 계정 수 상한(관리자 포함) |
| `SIGNUP_PER_IP_PER_DAY` | `2` | 한 주소에서 24시간 동안 할 수 있는 가입 수 |
| `ACCOUNT_LIFETIME_DAYS` | `14` | 지금부터 가입하는 계정은 가입 후 이 일수가 지나면 삭제 |
| `ACCOUNT_LIFETIME_DRY_RUN` | 비움 | `1`이면 지울 대상을 로그로만 남기고 지우지 않음 |
| `LIMIT_WORKSPACES_PER_USER` | `2` | 한 사람이 소유한 워크스페이스 수(삭제했지만 복구할 수 있는 것 포함) |
| `LIMIT_MEMBERS_PER_WORKSPACE` | `4` | 워크스페이스 하나의 멤버 수 |
| `LIMIT_PAGES_PER_WORKSPACE` | `300` | 워크스페이스 하나의 페이지 수(휴지통 포함) |
| `LIMIT_FILE_MB` | `5` | 업로드 파일 하나의 크기 |
| `LIMIT_WORKSPACE_STORAGE_MB` | `20` | 워크스페이스 하나의 파일, 페이지 본문, 버전 기록 합계 |
| `LIMIT_VERSIONS_PER_PAGE` | `10` | 페이지마다 남기는 버전 기록 수 |
| `LIMIT_TRASH_DAYS` | `7` | 휴지통의 페이지를 길어도 이 일수 뒤에 완전히 삭제(워크스페이스 설정과 상관없이) |
| `WORKSPACE_RESTORE_DAYS` | `7` | 삭제한 워크스페이스를 복구할 수 있는 일수 |
| `AGENT_UPLOAD_MAX_MB`, `AGENT_UPLOAD_DAILY_MB` | `5`, `10` | AI 에이전트 업로드: 파일 하나, 계정마다 하루 합계 |
| `DISABLED_FEATURES` | `demo.env.example` 참고 | 서버 전체에서 끄는 기능 |
| `LEGAL_DIR` | `/legal` | 컨테이너 안의 약관 폴더(호스트에서는 `DEMO_LEGAL_DIR`) |
| `INSTANCE_LABEL` | `Demo` | 모든 화면에 보이는 표시 |
| `INSTANCE_NOTICE` | 비움 | 로그인·가입·동의 화면과 모든 앱 화면 위에 보이는 공지(글자만, 500자까지) |
| `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_MONTHLY` | `7`, `0`, `0` | 남기는 백업 세트 수 |
| `SIGNUP_PER_HOUR` | `10` | 서버 전체에서 한 시간에 만들 수 있는 계정 수(설정 링크로 만든 계정은 세지 않음) |
| `OAUTH_UNUSED_CLIENT_HOURS` | `24` | 스스로 등록한 OAuth 클라이언트 가운데 한 번도 쓰이지 않은 것을 등록 후 이 시간이 지나면 삭제 |
| `OAUTH_UNUSED_CLIENT_MAX` | `500` | 한 번도 쓰이지 않은 OAuth 클라이언트를 남기는 최대 수. 새 등록이 가장 오래된 것부터 지움(15분이 안 된 것은 지우지 않음) |
| `DEMO_PORT` | `127.0.0.1:3100` | 데모의 호스트 포트(3000은 안 됨) |
| `DEMO_POSTGRES_PASSWORD`, `DEMO_APP_SECRET_KEY`, `DEMO_BACKUP_PASSPHRASE` | 새로 만든 값 | 데모 전용 비밀 값(위 "비밀 값") |

메일, OIDC, 의미 검색, 실험 기능은 변수를 비워 두어 꺼 둡니다. MCP는 켜 둡니다.

<a id="what-the-operator-should-know"></a>
## 운영자가 알아야 할 것

<a id="accounts-are-really-deleted"></a>
### 계정은 실제로 지워집니다

`ACCOUNT_LIFETIME_DAYS=14`는 가입 14일 뒤에 계정과 그 사람의 비공개 페이지와 파일, 그 사람만 있던 워크스페이스를 접속 여부와 상관없이 지웁니다. 백업에는 최대 7일 더 남습니다. 이 설정을 켜기 전에 만든 계정과 관리자 계정은 이 설정으로 지워지지 않습니다.

실제로 지우기 전에 무엇을 지울지 보려면 `ACCOUNT_LIFETIME_DRY_RUN=1`로 시작합니다. 그러면 매시간 도는 정리 작업이 지울 계정마다 로그 한 줄(계정 id와 함께 지워질 워크스페이스 수)을 남기고 아무것도 지우지 않습니다. 첫 계정들의 삭제 예정일이 지나고 로그에 정확히 그 계정들만 나오면, 값을 비우고 `deploy/demo/demo.sh up`을 다시 실행합니다.

<a id="posting-a-notice"></a>
### 공지 올리기

데모는 메일을 보내지 않고, 약관 틀은 공지(약관 변경, 서비스 변경, 중단, 개인정보 유출)를 앱 안과 로그인 화면에 올린다고 적었습니다. 그 수단이 `INSTANCE_NOTICE`입니다. `demo.env`에 적고(큰따옴표 안에서 `\n`이 줄바꿈, 500자까지) `deploy/demo/demo.sh up`을 다시 실행합니다. 내릴 때도 값을 비우고 같은 방법으로 합니다. 공지는 링크 없이 글자로만 보이고 닫을 수 없습니다. 다시 시작하면 열려 있던 편집 연결이 끊겼다가 바로 다시 붙습니다.

<a id="closing-the-demo-without-notice"></a>
### 예고 없이 데모를 닫을 때

데모를 닫으면 데이터베이스, 파일, 백업을 지체 없이 지운다고 처리방침 틀에 적혀 있습니다.

```bash
deploy/demo/demo.sh destroy    # asks you to type inkling-demo
```

`destroy`는 `up`과 같은 검사를 거친 뒤 백업을 포함한 데모의 볼륨을 지우고, 운영 인스턴스는 건드리지 않습니다. `BACKUP_RCLONE_REMOTE`를 썼다면 원격 백업 사본도, 데모 주소의 프록시 접근 로그도, 채운 약관 폴더와 `demo.env`도 지웁니다. 서버가 갑자기 멈췄다면 다시 접속할 수 있게 되는 대로 이 일을 합니다.

<a id="these-files-are-not-legal-advice"></a>
### 이 파일들은 법률 자문이 아닙니다

`deploy/demo/legal/`의 틀과 이 문서는 한 운영자의 데모를 위해 쓴 출발점이고, 법률 자문이 아닙니다. 읽어 보고 자기 사정과 나라에 맞게 고치고, 확실하지 않으면 확인을 받으세요. 틀에서 앱 동작을 설명하는 문장은 위 설정을 기준으로 썼습니다. 설정을 바꾸면 문장도 고쳐야 할 수 있습니다.
