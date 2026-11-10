<p align="center">
  <img src="apps/web/public/icon.svg" width="72" height="72" alt="Inkling 로고">
</p>

<h1 align="center">Inkling</h1>

<p align="center">
  사람과 AI 에이전트가 같은 노트를 함께 읽고 쓰는 셀프호스트 노트 앱입니다. 노션식 데이터베이스와
  옵시디언식 링크, 그래프, 캔버스, 실시간 동시 편집, MCP 서버가 들어 있고, MIT 라이선스로 모든 기능을 무료로 공개하고 있습니다.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://github.com/PROVE1352/inkling/actions/workflows/ci.yml"><img src="https://github.com/PROVE1352/inkling/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · 한국어
</p>

세 명에서 다섯 명 정도가 각자 Claude 같은 AI 에이전트를 붙여서 일하는 작은 팀, 그리고 노트를 내 서버에 두고 싶은 개인을 생각하고 만들었습니다. 다른 노트 앱과 다른 점은 크게 세 가지입니다.

1. 에이전트는 토큰 예산 안에서 필요한 섹션만 읽고, 읽은 버전을 확인한 뒤 섹션 하나만 고칩니다. 에이전트의 수정을 제안으로 받아 사람이 일부만 고를 수도 있고, 나중에 되돌릴 수도 있습니다.
2. 코멘트나 사람 칸에서 일을 특정 멤버의 에이전트에게 넘기면 그 에이전트의 받은 함으로 가고, 팀 에이전트 화면에서 에이전트마다 무엇을 하고 있는지 봅니다.
3. 노션식 데이터베이스(표, 보드, 캘린더, 타임라인, 차트, 폼 뷰와 수식)와 옵시디언식 `[[위키링크]]`, 백링크, 그래프, JSON Canvas가 한 앱에 같이 있습니다.

초대받아 쓰시는 분은 [사용 설명서](docs/GUIDE.ko.md)를 먼저 보시면 메뉴 위치를 찾기 편합니다. 40초짜리 소개 영상은 [site/assets/promo-ko.mp4](site/assets/promo-ko.mp4)에 있습니다.

![백링크·나가는 링크·태그 패널이 열린 문서](docs/images/1-doc-backlinks.png)

| | |
|---|---|
| ![상태별로 묶은 보드 뷰](docs/images/2-database-board.png) | ![같은 데이터베이스의 표 뷰](docs/images/2b-database-table.png) |
| ![워크스페이스 링크 그래프](docs/images/3-graph.png) | ![JSON Canvas 화이트보드](docs/images/4-canvas.png) |
| ![쿼리 블록: 표와 열린 할 일](docs/images/5-query-block-tall.png) | ![마감일 캘린더](docs/images/6-calendar.png) |

스크린샷은 영어 화면입니다. 설정 › 모양 › 언어에서 한국어로 바꾸실 수 있습니다.

## 빠른 시작

Docker와 Compose 플러그인이 필요합니다. 내 컴퓨터에서 먼저 써 보시려면 이렇게 하시면 됩니다.

```bash
git clone https://github.com/PROVE1352/inkling.git && cd inkling
./deploy/local.sh
```

스크립트가 비밀번호와 키를 만들어 `.env`를 쓰고, 비어 있는 로컬 포트(보통 http://localhost:3000)로 Inkling을 띄운 뒤 한 번만 쓰는 링크를 보여 줍니다. 그 링크를 열어 계정을 만들면 그 계정이 관리자가 됩니다. 끄려면 `./deploy/local.sh stop`, 지우려면 `./deploy/local.sh destroy`를 실행하시면 됩니다. 스크립트는 미리 빌드된 이미지를 받아 오는데, 이 링크는 0.17부터 생긴 기능이라 받아 온 이미지가 그보다 오래된 것이면 그렇다고 알려 주고 대신 가입 키 만드는 방법을 보여 줍니다. 받아 둔 소스로 바로 빌드하시려면 `./deploy/local.sh --build`를 쓰시면 됩니다(처음엔 몇 분 걸립니다). AI 에이전트까지 붙여 보시려면 [docs/MCP.md](docs/MCP.md#a-local-trial-with-an-agent-in-five-minutes)의 순서를 따라 하시면 됩니다. 다른 사람에게 줄 가입 키는 관리자 페이지에서 만들 수 있습니다.

서버에 올리실 때는 서버를 가리키는 도메인과 열린 80, 443 포트를 준비하고 Caddy 오버레이를 같이 띄우시면 됩니다. 인증서는 Caddy가 받아 오고 갱신하며, 앱과 DB 포트는 밖에서 보이지 않게 됩니다.

```bash
# .env 수정: PUBLIC_URL=https://notes.example.com   DOMAIN=notes.example.com
#           POSTGRES_PASSWORD=<긴 무작위 문자열>     BACKUP_PASSPHRASE=<서버 밖에도 따로 보관>
#           APP_SECRET_KEY=<openssl rand -base64 32>
docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d
./deploy/signup-key.sh new "first admin"   # https://notes.example.com/register 링크가 출력됩니다
```

앱은 미리 빌드된 이미지 `ghcr.io/prove1352/inkling`(amd64, arm64)을 받아 오므로 램 1 GB 서버에서도 직접 빌드할 필요가 없습니다. 특정 릴리스로 고정하시려면 `.env`의 `INKLING_VERSION`에 `X.Y.Z`나 `X.Y` 형식으로 적으시면 됩니다(비우면 `latest`). 받아 둔 소스로 직접 빌드하시려면 `-f compose.build.yaml`과 `--build`를 더하시면 됩니다([deploy/DEPLOY.md](deploy/DEPLOY.md#image-or-source-build)).

업그레이드는 백업, 새 이미지 받기, 앱 재시작 순서입니다. 마이그레이션은 부팅할 때 자동으로 돌고, 이전 버전으로 내리는 것은 지원하지 않습니다. 자세한 내용은 [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades)에 있습니다.

```bash
./deploy/backup.sh
git pull                      # compose 파일과 배포 스크립트
docker compose -f compose.yaml -f deploy/compose.caddy.yaml pull app
docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d app
```

0.18 이하를 쓰던 서버를 0.19로 올리실 때는 `.env`에 `INKLING_DATA_NAME=nodian` 한 줄을 먼저 넣어 주세요. 그 버전들의 볼륨과 DB는 프로젝트의 예전 이름(nodian)으로 만들어져 있어서, 이 줄이 없으면 compose가 아예 시작하지 않습니다. 새 이름(inkling)으로 옮기는 건 선택이고 `./deploy/rename-from-nodian.sh`로 하시면 됩니다. 자세한 내용은 [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrading-to-019-the-nodian--inkling-names)에 있습니다.

### 설정

꼭 보셔야 할 항목만 추렸습니다. 모두 `.env`에 적습니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PUBLIC_URL` | 비어 있음 | 공개 주소입니다. 예: `https://notes.example.com`. 메일 링크, OAuth 발급자, 공유 미리보기에 쓰고 `Host` 헤더는 믿지 않습니다. `https://`로 시작하면 Secure 쿠키도 켜집니다. |
| `POSTGRES_PASSWORD` | 없음(필수) | DB 비밀번호입니다. 처음 띄우기 전에 넣어 주셔야 합니다. Postgres는 데이터 볼륨을 만들 때만 이 값을 읽고, 비어 있으면 compose가 아예 시작하지 않습니다. |
| `INKLING_DATA_NAME` | 없음(필수, `.env.example`에는 `inkling`) | compose 프로젝트, 볼륨, DB 역할과 DB의 이름입니다. 새로 설치하시면 `inkling`, 0.18 이하에서 올라온 서버라면 `nodian`입니다(위의 업그레이드 설명 참고). |
| `APP_SECRET_KEY` | 비어 있음 | 32자 이상. 2단계 인증과 Slack 비밀값을 암호화하는 키라서, 비어 있으면 아무도 2단계 인증을 켤 수 없습니다. 백업과는 따로 보관해 주세요. |
| `SIGNUP_REQUIRE_KEY` | 프로덕션에서 필수 | 비워 두면 가입에 키가 필요합니다. `0`이면 누구나 가입할 수 있습니다. |
| `DEFAULT_LOCALE` | `en` | `en` 또는 `ko`. 언어를 고르지 않은 사용자에게 가는 메일과 기본 템플릿의 언어이고, 브라우저 언어보다 먼저 쓰는 화면 기본값입니다. |
| `TZ` | `UTC` | 마감일, 데일리 노트, 알림, 백업 일정에서 "오늘"을 정하는 시간대입니다. 예: `Asia/Seoul` |

나머지는 [.env.example](.env.example)과 [deploy/DEPLOY.md](deploy/DEPLOY.md)에 있습니다. 메일은 [3-E](deploy/DEPLOY.md#3-e-mail-optional), OpenID Connect 로그인은 [3-G](deploy/DEPLOY.md#3-g-openid-connect-sign-in-optional), 의미 검색은 [3-H](deploy/DEPLOY.md#3-h-semantic-search-optional)를 보시면 되고, 직접 운영하시는 리버스 프록시 뒤에 두는 방법도 같은 문서에 있습니다. 메모리 한도와 Postgres 튜닝은 [docs/OPERATIONS.md](docs/OPERATIONS.md)를 참고하시기 바랍니다.

### 개발

Node 22 이상, pnpm(버전은 `package.json`에 고정), Docker가 필요합니다.

```bash
pnpm install
pnpm db:up      # Postgres, localhost:55432
pnpm dev        # API·협업 서버 :3001, 웹 :5173
```

테스트, CI, 작업 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)에, 코딩 에이전트용 규칙은 [AGENTS.md](AGENTS.md)에 있습니다.

## 기능

### 쓰기

에디터는 BlockNote 블록 에디터입니다. `/` 슬래시 메뉴로 코드 블록, 체크리스트, 콜아웃, KaTeX 수식 같은 블록을 넣고(코드 블록 언어를 `mermaid`로 두면 다이어그램이 그려집니다), 이미지와 파일은 끌어다 놓으면 들어가고, 링크는 미리보기나 임베드로 보여 줍니다. 표는 빈 줄에 `| 이름 | 역할 |`처럼 치고 Enter를 누르거나 `/표 3x4`로 바로 만들 수 있습니다. `[[위키링크]]`(`[[페이지#헤딩]]`이면 그 헤딩으로 바로 갑니다), `#태그`, `@멘션`, 데일리 노트가 있고, 템플릿은 페이지 하나뿐 아니라 하위 페이지와 데이터베이스까지 묶어서 만들 수 있습니다([docs/TEMPLATES.md](docs/TEMPLATES.md)). 펜 모드로 페이지 위에 손글씨나 형광펜을 남길 수도 있습니다.

페이지는 폴더처럼 겹겹이 넣고 사이드바에서 끌어서 순서를 바꿉니다. 검색(⌘K)은 제목과 본문을 같이 찾고, 체크리스트에 날짜를 붙이면 할 일로 잡혀 마감 화면과 전체 캘린더에 나옵니다. 그 밖에 이름 붙인 버전 기록, 휴지통, PDF 내보내기, 페이지를 제목 단위로 나눠 슬라이드처럼 보여 주는 발표 모드가 있습니다. 명령 팔레트와 직접 바꿀 수 있는 단축키, 다시 볼 페이지를 모아 두고 알림을 받는 '나중에 보기', 팔로우한 코멘트 스레드 목록도 있습니다. `/버튼`으로 넣는 버튼은 누르면 행 추가, 값 바꾸기, 페이지 열기, 웹훅 보내기를 차례로 해 줍니다. 웹에서 본 글은 북마클릿이나 `/clip` 화면, 안드로이드 공유 메뉴로 링크나 본문째 저장할 수 있습니다. 화면은 한국어와 영어를 지원하고, PWA로 설치할 수 있으며(설치한 앱은 연 페이지를 기기에 보관해서 오프라인에서도 열고 고칠 수 있습니다), 라이트·다크 테마가 있습니다.

### 데이터베이스

뷰는 표, 보드, 캘린더, 갤러리, 타임라인, 차트, 폼, 리스트가 있고 뷰마다 정렬과 필터(OR, NOT 포함), 그룹을 따로 정합니다. 뷰 하나를 문서 안에 그대로 넣을 수도 있습니다(`/데이터베이스 보기`). 속성은 텍스트, 숫자, 선택, 다중 선택, 날짜, 체크박스, 사람, URL, 이메일, 전화번호, 관계형, 롤업, 수식이 있고, 생성·편집 일시와 생성자·최종 편집자, `TASK-12` 같은 ID는 저절로 채워집니다. 행 아래에 하위 항목을 둘 수 있고, 행 템플릿을 둘 수 있으며, CSV/XLSX로 가져오고 내보냅니다.

차트는 문서 안에서 `/chart`로 넣는데, 데이터베이스나 쿼리를 골라 그립니다. 폼 뷰는 멤버가 앱에서 채우는 것이 기본이고, 소유자나 관리자가 공개 링크를 켜면 바깥 사람도 답을 보낼 수 있습니다. 자동화를 걸어 두면 행이 추가되거나 속성이 바뀌거나 날짜가 다가올 때 값을 바꾸고, 사람을 지정하거나 알리고, 다른 데이터베이스에 행을 넣거나 웹훅을 보냅니다.

### 링크와 캔버스

오른쪽 패널에서 백링크, 미연결 멘션, 나가는 링크를 보고, 워크스페이스 전체 그래프와 로컬 그래프가 있습니다. 캔버스는 옵시디언의 [JSON Canvas](https://jsoncanvas.org) 형식(`.canvas`)을 그대로 따릅니다. 쿼리 블록은 Dataview 문법의 일부(`TABLE` / `LIST` / `TASK`)를 지원하고, 페이지가 바뀌면 결과도 따라 바뀝니다([docs/QUERY.md](docs/QUERY.md)).

### 함께 쓰기

동시 편집은 Yjs로 구현했습니다. 다른 사람의 커서와 접속 상태가 보이고, 연결이 끊긴 동안 고친 내용은 다시 연결되면 합쳐집니다. 오프라인 사본을 켠 기기(설치한 앱은 기본으로 켜져 있습니다)에서는 편집이 기기에 남고, 그렇지 않으면 탭을 열어 두는 동안만 남아서 탭을 닫을 때 경고가 뜹니다.

워크스페이스에는 초대 링크로 들어오고, 역할은 소유자, 관리자, 멤버 세 가지입니다. 페이지 트리마다 멤버의 권한(보기, 코멘트, 편집, 전체)을 따로 줄 수 있습니다. 워크스페이스 밖의 사람은 게스트로 초대해 공유받은 페이지만 보게 할 수 있습니다. 워크스페이스가 많으면 나만 보는 묶음으로 나누고, 끝난 것은 보관해 둘 수 있습니다. 편집 잠금을 걸면 페이지와 그 하위 페이지를 담당자와 지정한 편집자만 고치고, AI 에이전트는 사람과 따로 '제안만', '코멘트만', '읽기만'으로 묶어 둘 수 있습니다.

페이지와 섹션에 코멘트를 달 수 있고, 알림은 메일 요약과 기기 푸시로도 받을 수 있으며, 활동 화면에서는 바뀐 줄을 비교해 봅니다. 문서마다 담당자와 검토일을 둘 수 있고, '페이지 확인 표시'로 이 문서가 언제까지 맞는지 적어 두면 그날이 지난 뒤 '다시 확인 필요'로 바뀝니다. 공개 링크는 만료일, 비밀번호, 공개 시작 시각을 정할 수 있습니다. 멤버마다 이모지와 짧은 상태 메시지를 걸어 둘 수 있어서 멘션할 때 함께 보입니다.

워크스페이스마다 Slack 앱을 연결하면 채널 알림, `/inkling` 검색, 링크 미리보기를 쓸 수 있습니다. Slack이나 Discord, 서명된 JSON을 받는 아무 https 주소로 웹훅을 보낼 수도 있습니다([docs/WEBHOOKS.md](docs/WEBHOOKS.md)).

### 셀프호스팅

`docker compose` 하나로 Postgres, 앱, 백업 사이드카가 뜨고, Caddy 오버레이를 더하면 HTTPS까지 붙습니다. 백업은 예약 실행되고 매번 검증하며, 암호화와 GFS 보관, 주간 복원 테스트, rclone 외부 사본을 지원합니다([docs/BACKUP.md](docs/BACKUP.md)). 로그인은 가입 키, 2단계 인증, OpenID Connect, 외부 인증 서버로 넘기는 위임 로그인을 지원하고, 관리자 페이지에서 사용자, 가입 키, 막힌 IP, 백업, 서버 상태를 봅니다. 노션 내보내기 zip과 마크다운/zip을 가져올 수 있고, 마크다운/zip과 PDF로 내보내며, 마감일은 iCal로 구독할 수 있습니다.

### 실험 기능

`EXPERIMENTAL_FEATURES`에 적어야 켜집니다. `inklingctl` CLI로 옵시디언 볼트와 양방향 동기화([docs/VAULT-SYNC.md](docs/VAULT-SYNC.md)), 샌드박스에서 도는 플러그인([docs/PLUGINS.md](docs/PLUGINS.md)), 읽기 전용 Google Sheets 동기화가 있습니다.

## AI 에이전트(MCP)

MCP 서버는 앱에 들어 있고 주소는 `https://<도메인>/mcp`입니다. 사람마다 OAuth 2.1로(로그인을 못 하는 클라이언트는 에이전트 연결 토큰으로) 자기 클라이언트를 연결하기 때문에, 에이전트는 연결한 사람이 웹에서 볼 수 있는 것만 봅니다. 연결할 때 읽기 전용과 읽기·쓰기 중에서 고르고, 일부 워크스페이스나 페이지 트리 하나로 범위를 좁힐 수 있습니다. 영구 삭제 도구는 일부러 만들지 않았습니다.

```bash
claude mcp add --transport http inkling https://notes.example.com/mcp
# Claude Code에서 /mcp → inkling → Authenticate
```

claude.ai에서는 설정 › 커넥터 › Add custom connector에 같은 주소를 넣으시면 됩니다. 도구 48개(`?profile=core`로 연결하면 32개만 보이고 나머지는 `more_tools`로 씁니다)와 에이전트용 안내는 [docs/MCP.md](docs/MCP.md)에 있습니다. 보통은 이런 순서로 씁니다.

1. `find_context(query)`로 질문에 맞는 섹션을 순위대로 토큰 예산 안에 받습니다. 결과마다 페이지 id(모든 도구가 받는 8자리), `§앵커`, 버전이 붙습니다. `queries=[…]`로 질문과 그 번역처럼 여러 표현을 한 번에 찾을 수 있습니다.
2. 모자라면 `read_page(pageId, outline=true)`로 목차를 보고 `read_page(pageId, section=…)`로 섹션 하나만 읽습니다. `known=<버전>`을 주면 바뀌지 않은 페이지는 한 줄로 답합니다.
3. `patch_section(pageId, section, markdown, mode, baseVersion)`으로 섹션 하나를 고칩니다. 그사이 바뀌었으면 덮어쓰지 않고 지금 내용을 돌려주니 합쳐서 다시 보내면 됩니다(`replace`와 `delete`는 `baseVersion`이 꼭 필요합니다). 같은 섹션을 사람이 치고 있어도 그 사람의 글은 남습니다.

여러 에이전트가 같이 일할 때는 `claim_section`으로 섹션을 최대 30분 잡아 둘 수 있고, 그동안 다른 에이전트가 그 섹션을 직접 고치려 하면 거절됩니다. 사람은 막지 않습니다. `suggest=true`를 주거나 워크스페이스·잠금 설정을 바꾸면 에이전트의 수정이 제안으로 남습니다. 무슨 일이 있었는지는 `inbox`, `catch_up`, `changes_since` 커서로 알 수 있고, 워크스페이스 규칙은 잠긴 페이지에 적어 두면 `get_instructions`로 읽어 갑니다. 첨부 파일은 `read_file`로 읽고(PDF는 글자까지), 에이전트가 만든 파일은 `upload_file`로 붙입니다. 제안을 받아들이는 일과 에이전트 편집을 되돌리는 일은 사람만 할 수 있습니다. 에이전트가 한 일은 '사용자 (앱 경유)'로 남습니다. 페이지 내용은 신뢰하지 않는 데이터로 감싸서 넘기는데, 프롬프트 인젝션을 완전히 막을 방법은 없다고 봐서 이건 완화책으로만 두었습니다. 실제 경계는 편집 잠금과 연결 권한, 워크스페이스별 에이전트 차단입니다.

토큰은 같은 데이터로 전후를 재서 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)에 측정 방법과 함께 적어 두었습니다. 세션마다 고정으로 드는 비용(도구 목록과 서버 안내문)은 0.15.1에서 약 16,938토큰에서 약 12,390토큰으로 26.9% 줄었습니다. `find_context`를 처음 넣었을 때 5,000페이지 벤치마크에서 재 보니, 검색 후 페이지를 통째로 읽던 방식보다 질문당 평균 토큰이 2,254에서 624로, 도구 호출이 3.68번에서 1.00번으로 줄었습니다. `read_page(outline=true)`의 목차는 0.15.1에서 34% 작아졌고, 바뀌지 않은 목차를 `known`으로 다시 읽으면 93.5% 덜 듭니다. 문장 하나를 `patch_section`으로 고치면 약 222토큰이 들고, 읽고 통째로 바꾸면 약 2,415토큰이 듭니다. 에이전트가 섹션을 고치는 동안 같은 섹션을 사람이 치고 있으면, 예전에는 6개 시나리오 중 1개에서만 사람의 글이 남았는데 지금은 6개 모두에서 남습니다.

의미 검색은 선택 기능이고 기본으로 꺼져 있습니다. 운영자가 켜면 `find_context`가 뜻으로도 순위를 매기고, 이때 섹션 내용이 설정한 임베딩 주소로 나갑니다. 로컬 Ollama를 쓰면 노트가 내 네트워크 밖으로 나가지 않습니다([deploy/DEPLOY.md](deploy/DEPLOY.md#3-h-semantic-search-optional)).

게임 엔진, 디자인 도구, 코드 저장소 같은 다른 MCP 서버와 같이 쓰는 예시는 [docs/RECIPES.ko.md](docs/RECIPES.ko.md)에 모아 두었습니다.

## 다른 도구와 비교

2026년 11월 기준으로 각 프로젝트의 저장소, 문서, 가격 페이지를 보고 정리했습니다. "EE"는 유료 엔터프라이즈 판에만 있는 기능입니다. 제가 잘못 본 곳이 있을 수 있으니 틀린 부분은 알려 주시면 고치겠습니다.

| | Inkling | [salt.md](https://github.com/saltmd/salt.md) | [Docmost](https://github.com/docmost/docmost) | [AFFiNE](https://github.com/toeverything/AFFiNE) | [Outline](https://github.com/outline/outline) |
|---|---|---|---|---|---|
| 라이선스 | MIT | AGPL-3.0 | 코어 AGPL-3.0 + 유료 EE | MIT. 서버 코드는 EE 라이선스지만 무료 셀프호스트 Community Edition은 예외 | BSL 1.1(2030-10-23에 Apache 2.0으로 전환) |
| 데이터베이스 뷰 | 표, 보드, 캘린더, 갤러리, 타임라인, 차트, 폼, 리스트 | 표, 보드, 리스트, 갤러리, 캘린더, 타임라인, 폼 | EE | 표, 칸반, 캘린더 | 없음 |
| `[[위키링크]]` / 백링크 | 있음 / 있음 | `[[`로 링크 메뉴 열기 / 있음 | 없음(`@` 멘션) / 있음 | 있음 / 있음 | 있음 / 있음 |
| 그래프 뷰 | 있음 | 있음 | 확인 못 함 | 확인 못 함 | 확인 못 함 |
| 캔버스 | JSON Canvas(`.canvas`) | 없음 | Excalidraw, draw.io 임베드 | 자체 화이트보드(Edgeless), JSON Canvas 아님 | 없음(diagrams.net 임베드) |
| 실시간 협업 | 있음 | 있음 | 있음 | 있음 | 있음 |
| MCP 서버 | 내장, 무료 | 내장, 무료 | EE | 내장, AI 제공자 설정 필요, 기본은 읽기 전용 | 내장(요금제 제한: ?) |
| 옵시디언 볼트 동기화 | 양방향(실험 기능) | 없음 | 없음 | 단방향 가져오기 | 없음 |
| 노션 가져오기 | 내보내기 zip(Markdown & CSV), API 가져오기는 없음 | 있음 | 있음 | 있음 | 있음 |
| 셀프호스트 무게 | 앱 + PostgreSQL | Go 바이너리 하나 + SQLite | 앱 + PostgreSQL + Redis | 앱 + PostgreSQL(pgvector) + Redis | 앱 + PostgreSQL + Redis, 로그인용 SSO나 SMTP 별도 필요 |

## 한계

Inkling이 약한 점도 분명히 있습니다. PostgreSQL이 꼭 있어야 하고 SQLite 모드는 없습니다. 데스크톱이나 모바일 네이티브 앱이 없어서 웹 앱을 PWA로 설치해 쓰셔야 하고, 웹 푸시는 서버가 HTTPS여야 하며 iPhone·iPad에서는 홈 화면에 추가한 앱에서만 됩니다. 인스턴스 하나로만 돌게 만들어서, 같은 DB를 다른 프로세스가 쓰고 있으면 서버가 아예 뜨지 않고 수평 확장도 안 됩니다.

오프라인에서는 오프라인 사본을 켠 기기에서 한 번 열어 본 페이지만 읽고 고칠 수 있습니다. 브라우저 탭은 이 설정이 기본으로 꺼져 있어서 오프라인 편집이 탭을 열어 두는 동안만 남습니다. 오프라인에서 페이지를 새로 만들거나 옮기는 일, 데이터베이스와 검색은 아직 안 됩니다. Inkling 자체에는 AI 모델이 없고, 글을 쓰거나 요약하는 일은 연결한 에이전트가 합니다. 의미 검색을 켜지 않으면 `find_context`는 단어로만 찾기 때문에, 영어로 물으면 한국어로만 적힌 노트를 찾지 못합니다. 이럴 때는 `queries=[질문, 번역]`으로 같이 물어보시거나 의미 검색을 켜시면 됩니다.

아직 쓰는 사람이 적은 새 프로젝트라서 부족한 부분이 많고, 피드백과 기여를 기다리고 있습니다. 첫 공개를 막을 정도는 아니라서 남겨 둔 문제들을 영역과 심각도별로 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)에 적어 두었고, 앞으로 할 일은 [docs/ROADMAP.md](docs/ROADMAP.md)에 있습니다.

## 구조

- 서버(`apps/server`): Node 22, Fastify 5(`/api` REST), `/collab`의 Hocuspocus/Yjs 협업, PostgreSQL 16 위의 Drizzle ORM(부팅할 때 마이그레이션 적용), OAuth 서버가 딸린 `/mcp` 엔드포인트
- 웹(`apps/web`): React 19, Vite, Tailwind CSS v4, BlockNote 에디터, React Flow 캔버스, d3-force 그래프
- CLI(`apps/cli`)는 볼트 동기화용 `inklingctl`이고, 공용 패키지(`packages/shared`)에 zod 스키마와 DTO, 쿼리 파서가 있습니다

설계 설명은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에, 결정과 그 이유는 [docs/adr/](docs/adr/README.md)의 ADR에, REST 계약은 [docs/API.md](docs/API.md)에 있습니다. 성능을 손볼 때는 같은 데이터로 전후를 재서, 효과가 없어 버린 변경까지 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)에 남깁니다. 이 문서들은 영어로만 쓰여 있습니다.

## 보안

Inkling은 서로 믿는 사람들이 워크스페이스 단위로 함께 쓰는 셀프호스트 단일 인스턴스를 전제로 만들었습니다. 인터넷에 여시기 전에 다음을 확인하시기 바랍니다.

- HTTPS 뒤에서 돌려 주세요. `deploy/compose.caddy.yaml`을 쓰면 앱과 DB 포트도 밖에서 보이지 않습니다. 직접 운영하시는 프록시에서 TLS를 끝내셔도 됩니다.
- `PUBLIC_URL`을 설정해 주세요(메일 링크를 다른 주소로 보내려면 `APP_URL`도). 메일 링크, OAuth 메타데이터, 공유 미리보기가 이 값으로 만들어지고, `https://`면 세션 쿠키에 Secure가 자동으로 붙습니다.
- 가입 키 요구는 끄지 않는 편이 좋습니다(프로덕션 기본값). 첫 관리자는 새 서버가 로그에 찍어 주는 한 번용 설정 링크로 가입하거나, `./deploy/signup-key.sh`로 만든 키로 가입합니다.
- `POSTGRES_PASSWORD`는 충분히 길게 정하고, `BACKUP_PASSPHRASE`와 `APP_SECRET_KEY`는 서버 밖에도 보관해 두세요. `APP_SECRET_KEY`는 백업과도 따로 두셔야 합니다.
- `TRUST_PROXY`는 실제로 앞에 둔 리버스 프록시만 가리키게 해 주세요.
- 실험 기능(`plugins`, `vault-sync`, `sheets-sync`)은 기본으로 꺼져 있습니다. 플러그인은 샌드박스에서 돌지만, 관리자가 승인한 뒤에는 신뢰하는 코드로 취급합니다.

기본으로는 워크스페이스 멤버가 그 워크스페이스의 공유 페이지를 모두 읽고 고칠 수 있습니다. 페이지별 권한과 편집 잠금으로 이를 좁힐 수 있고, 개인 페이지는 만든 사람만, 게스트는 공유받은 페이지만 봅니다. 전체 점검 목록은 [docs/OPERATIONS.md](docs/OPERATIONS.md#before-first-deploy)에 있습니다. 취약점을 발견하시면 [SECURITY.md](SECURITY.md)의 방법으로 알려 주시기 바랍니다.

## AI 도움을 받아 만들었습니다

Inkling은 설계와 구현에 AI 코딩 에이전트를 많이 썼습니다. 생성된 코드는 동시성, 자원, 보안 쪽에서 잘 틀린다고 봐서 이 부분을 겨냥해 여러 차례 따로 검토했고, 성능은 추측하지 않고 측정한 결과를 보고 고쳤습니다. 그 과정에서 내린 결정과 절충은 [docs/adr/](docs/adr/README.md)에, 아직 못 고친 문제는 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)에 공개해 두었습니다. 중요한 데이터를 맡기시기 전에는 다른 새 프로젝트와 마찬가지로 충분히 살펴보시기 바랍니다.

## 기여

이슈와 풀 리퀘스트는 언제든 환영합니다. 먼저 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어 주시고, 큰 변경은 이슈에서 짧게 이야기를 나눈 뒤에 올려 주시면 반영하기가 훨씬 수월합니다.

## 라이선스

[MIT](LICENSE). 이 저장소의 기능은 모두 무료이고, 유료 판은 따로 없습니다.
