<p align="center">
  <img src="apps/web/public/icon.svg" width="72" height="72" alt="Inkling 로고">
</p>

<h1 align="center">Inkling</h1>

<p align="center">
  노션식 데이터베이스와 옵시디언식 링크, 그래프, JSON Canvas를 함께 쓸 수 있는 셀프호스트 노트 앱입니다.
  실시간 동시 편집과 AI 에이전트용 MCP 서버가 들어 있고, MIT 라이선스로 모든 기능을 무료로 공개하고 있습니다.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://github.com/PROVE1352/inkling/actions/workflows/ci.yml"><img src="https://github.com/PROVE1352/inkling/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · 한국어
</p>

Inkling은 노션처럼 표와 보드로 정리하는 일과 옵시디언처럼 문서를 링크로 엮는 일을 한 서버에서 같이 하고 싶어서 만들었습니다. 팀이 함께 쓰는 노트를 남의 서비스가 아니라 직접 운영하는 서버에 두고, 거기에 Claude 같은 AI 에이전트를 붙여서 같이 읽고 쓰게 하는 것이 목표입니다. 아직 사용자가 많지 않은 새 프로젝트라서 부족한 부분이 많고, 피드백과 기여를 기다리고 있습니다.

![백링크·나가는 링크·태그 패널이 열린 문서](docs/images/1-doc-backlinks.png)

| | |
|---|---|
| ![상태별로 묶은 보드 뷰](docs/images/2-database-board.png) | ![같은 데이터베이스의 표 뷰](docs/images/2b-database-table.png) |
| ![워크스페이스 링크 그래프](docs/images/3-graph.png) | ![JSON Canvas 화이트보드](docs/images/4-canvas.png) |
| ![쿼리 블록: 표와 열린 할 일](docs/images/5-query-block-tall.png) | ![마감일 캘린더](docs/images/6-calendar.png) |

스크린샷은 영어 화면입니다. 설정 › 모양 › 언어에서 한국어로 바꾸실 수 있습니다. 초대받아 쓰시는 분은 [사용 설명서](docs/GUIDE.ko.md)를 먼저 보시면 메뉴 위치를 찾기 편합니다.

## 기능

### 쓰기

에디터는 BlockNote 블록 에디터를 씁니다. `/`를 치면 나오는 슬래시 메뉴로 표, 코드 블록, 체크리스트, 콜아웃 같은 블록을 넣고, 이미지와 파일은 끌어다 놓으면 들어갑니다. 수식은 KaTeX로 그리는데, 한 줄짜리 수식 블록과 문장 안에 들어가는 인라인 수식을 모두 지원합니다. `$x^2$`처럼 입력하거나 ⌘/Ctrl+Shift+E를 누르면 되고, 수식을 클릭하면 결과를 보면서 LaTeX를 고칠 수 있습니다. 렌더링은 브라우저에서만 하고, 수식이 있는 페이지에서만 KaTeX를 불러오도록 했습니다.

`[[위키링크]]`는 자동완성이 되고, `#태그`, `@멘션`, 데일리 노트도 있습니다. 템플릿은 페이지 하나뿐 아니라 하위 페이지, 뷰를 갖춘 데이터베이스, 캔버스까지 묶어서 만들 수 있고, 변수와 입력 질문, 옵시디언 Templater의 기본 문법을 지원합니다. 자세한 내용은 [docs/TEMPLATES.md](docs/TEMPLATES.md)를 참고하시기 바랍니다.

그 밖에 원하는 시점에 이름을 붙여 저장해 둘 수 있는 버전 기록(현재 상태와 비교도 됩니다), 코멘트, 30일 동안 되살릴 수 있는 휴지통, PDF 내보내기가 있습니다. 화면은 한국어와 영어를 지원하고, PWA로 설치할 수 있으며, 라이트·다크 테마가 있습니다.

### 정리와 데이터베이스

페이지는 폴더처럼 겹겹이 넣을 수 있고, 사이드바에서 끌어서 순서를 바꿉니다. 워크스페이스마다 멤버 모두가 보는 공유 페이지와 나만 보는 개인 페이지가 나뉘어 있습니다.

데이터베이스는 표, 보드, 캘린더, 갤러리, 타임라인 뷰를 지원합니다. 속성은 텍스트, 숫자, 선택, 다중 선택, 날짜, 체크박스, 사람, URL, 관계형, 롤업이 있고, 뷰마다 정렬과 필터, 그룹을 따로 정할 수 있습니다. 문서 안의 체크리스트에 날짜를 붙이면 할 일로 잡혀서 마감 화면과 전체 캘린더에 함께 나옵니다. 검색(⌘K)은 제목과 본문을 같이 찾습니다.

0.3.1부터는 사이드바 위쪽 메뉴(검색, 그래프, 태그, 웹 공유, 마감, 캘린더, 활동, 오늘)를 사람마다 숨기거나 순서를 바꿀 수 있습니다. 설정은 계정에 저장되기 때문에 어느 기기에서 열어도 같게 보입니다.

### 연결

오른쪽 패널에서 백링크, 미연결 멘션, 나가는 링크를 볼 수 있고, 워크스페이스 전체 그래프와 지금 페이지 주변만 보는 로컬 그래프가 있습니다. 캔버스는 옵시디언의 [JSON Canvas](https://jsoncanvas.org) 형식(`.canvas`)을 그대로 따르기 때문에 옵시디언과 파일을 주고받을 수 있습니다.

쿼리 블록은 Dataview 문법의 일부(`TABLE` / `LIST` / `TASK`, `FROM`, `WHERE`, `SORT`, `LIMIT`)를 지원합니다. 페이지가 바뀌면 결과도 따라 바뀝니다. 문법은 [docs/QUERY.md](docs/QUERY.md)에 정리해 두었습니다.

### 협업

동시 편집은 Yjs로 구현했습니다. 다른 사람의 커서와 접속 상태가 보이고, 연결이 끊긴 동안 고친 내용은 탭을 열어 둔 채 다시 연결되면 합쳐집니다. 브라우저에 따로 저장해 두지는 않아서, 저장 안 된 편집이 있으면 탭을 닫을 때 경고가 뜹니다. 워크스페이스에는 초대 링크로 들어오고, 역할은 소유자, 관리자, 멤버 세 가지입니다. 페이지나 폴더를 읽기 전용 공개 링크로 내보낼 수 있는데, 원하지 않으면 워크스페이스 단위로 웹 공개를 아예 막을 수도 있습니다.

같은 워크스페이스 안에서는 멤버 모두가 공유 페이지를 고칠 수 있기 때문에, 0.2.0에서 편집 잠금을 넣었습니다. 페이지와 그 하위 페이지를 담당자와 지정한 편집자만 고치게 할 수 있고, AI 에이전트는 사람과 따로 '코멘트만'이나 '읽기만'으로 묶어 둘 수 있습니다. 같은 버전에서 워크스페이스 설정 화면(일반, 멤버, 공개 링크, 연결된 에이전트, 감사 로그, 검토, Slack·Discord, 위험 구역)과, 문서마다 담당자와 검토일을 두고 오래됐을 가능성이 큰 문서부터 보여 주는 검토 목록도 들어갔습니다.

알림은 0.3.0에서 꽤 많이 바뀌었습니다. 본문과 코멘트의 멘션, 내 스레드에 달린 답글, 담당자나 사람 칸 지정, 팔로우한 페이지의 변경이 알림으로 오고, 같은 페이지에서 연달아 생긴 알림은 하나로 묶입니다. 페이지나 하위 트리 단위로 모든 활동, 멘션만, 알리지 않음, 음소거 중에서 고를 수 있습니다. 서버에 SMTP를 설정하면 멘션과 답글은 바로 메일로, 나머지는 매일 또는 매주 요약 메일로 보냅니다. 활동 화면에서는 사람과 AI가 바꾼 내용을 최신순으로 걸러 보고, 바뀐 줄을 비교할 수 있습니다.

워크스페이스 소유권을 다른 멤버에게 넘길 수 있고, 워크스페이스를 지워도 소유자가 30일 안에는 되돌릴 수 있습니다.

### AI와 연동

MCP 서버가 앱에 들어 있습니다. OAuth 2.1과 PKCE로 사용자마다 따로 연결하기 때문에 Claude Code나 claude.ai 같은 클라이언트는 연결한 사람이 볼 수 있는 페이지만 다룹니다. 연결할 때 읽기 전용과 읽기·쓰기 중에서 고를 수 있고, 영구 삭제 도구는 일부러 만들지 않았습니다. 연결 방법과 도구 목록은 [docs/MCP.md](docs/MCP.md)에 있습니다. 게임 엔진, 디자인 도구, 코드 저장소 같은 다른 MCP 서버와 같이 쓰는 예시는 [docs/RECIPES.ko.md](docs/RECIPES.ko.md)에 모아 두었습니다.

에이전트가 페이지를 통째로 검색하고 읽으면 토큰이 많이 들어서, 0.2.0에서 섹션 단위 도구를 따로 만들었습니다. `find_context`는 질문에 맞는 섹션만 골라 정해진 토큰 예산 안에 담아 돌려줍니다. 5,000페이지 벤치마크에서 질문당 토큰이 약 72% 줄었고, 도구 호출은 평균 3.7번에서 1번으로 줄었습니다. `read_page`는 개요나 섹션 하나만 읽을 수 있고, `read_pages`로 여러 페이지를 한 번에 읽습니다. 수정은 `patch_section`으로 섹션 하나만 바꾸는데, 버전을 확인하고 바뀐 글자만 반영하기 때문에 같은 섹션을 사람이 치고 있어도 그 사람의 글은 남습니다. `changes_since`는 커서 기반 변경 피드라서, 에이전트가 자기 쪽 노트를 바뀐 부분만 갱신할 수 있습니다. 이 밖에 데이터베이스 행을 다루는 `query_rows`, `create_row`, `update_row`와 코멘트 도구, 에이전트 수신함(`inbox`, `ack`)이 있습니다.

AI가 한 일은 '사용자 (앱 경유)'로 버전 기록, 코멘트, 변경 피드, 활동 화면에 남고, AI가 만든 페이지에는 'AI가 작성' 표시가 붙습니다. 워크스페이스 규칙을 잠긴 페이지에 적어 두면 에이전트가 `get_instructions`로 읽어 가는 에이전트 지침 기능도 있습니다.

프롬프트 인젝션은 완전히 막을 방법이 없다고 판단해서, 사용자가 쓴 내용을 신뢰하지 않는 데이터로 감싸서 넘기고 수상한 문구를 표시하는 정도에서 멈췄습니다. 이건 완화책일 뿐이고, 실제 경계는 편집 잠금과 연결 권한, 워크스페이스별 에이전트 차단입니다.

외부 서비스와는 이런 식으로 이어집니다. 링크를 붙이면 미리보기나 임베드(YouTube, Vimeo, Loom, Figma, Spotify, CodePen, Google Docs)로 보여 주고, 외부 요청은 모두 SSRF 필터를 거칩니다. 멘션, 코멘트, 마감일, 새 페이지, 담당 지정, AI 편집 요약은 Slack이나 Discord 웹훅으로 보낼 수 있습니다. 마감일은 iCal로 구독할 수 있고, 데이터베이스는 CSV/XLSX로 가져오고 내보냅니다. 마크다운과 zip 가져오기·내보내기는 front matter와 첨부 파일, `[[링크]]`를 살려서 처리하고, 노션으로 올리는 기능도 있습니다.

노션에서 옮겨 오실 때는 노션의 내보내기 파일(Markdown & CSV zip)을 그대로 올리시면 됩니다. 페이지 트리와 링크, 이미지와 파일이 들어오고, CSV 데이터베이스는 속성 타입을 맞춰서 데이터베이스로 만듭니다. 수식은 수식으로 들어오지만 콜아웃은 아직 인용으로 바뀝니다. 기본 용량 제한은 업로드 25 MB, 압축 해제 후 50 MB입니다.

### 셀프호스팅과 운영

`docker compose` 하나로 Postgres, 앱, 백업 사이드카가 뜨고, Caddy 오버레이를 더하면 HTTPS 인증서까지 자동으로 붙습니다. 백업은 예약 실행되고 매번 검증하며, 암호화와 GFS 보관, 주간 복원 테스트, rclone 외부 사본을 지원합니다([docs/BACKUP.md](docs/BACKUP.md)).

관리자 페이지에서는 사용자, 가입 키, 비밀번호 재설정 요청, 무차별 대입 방어로 막힌 IP, 백업을 관리합니다. 새 버전을 배포하면 열려 있는 탭마다 새 버전 알림이 뜨고, 원하시면 GitHub의 새 릴리스를 확인하게 할 수도 있습니다. SMTP(초대, 비밀번호 재설정, 이메일 인증)와 외부 인증 서버로 로그인을 넘기는 위임 로그인은 선택 사항입니다.

### 실험 기능

아래 기능은 아직 다듬는 중이라 `EXPERIMENTAL_FEATURES`에 적어야 켜집니다.

- `inklingctl` CLI로 옵시디언 볼트와 양방향 동기화 ([docs/VAULT-SYNC.md](docs/VAULT-SYNC.md))
- 플러그인 API v0. 샌드박스 iframe에서 돌고 관리자가 승인해야 설치됩니다 ([docs/PLUGINS.md](docs/PLUGINS.md))
- 시트를 그대로 따라가는 읽기 전용 Google Sheets 동기화

## 빠른 시작

Docker와 Compose 플러그인이 필요합니다. HTTPS로 여시려면 서버를 가리키는 도메인과 열린 80, 443 포트도 있어야 합니다.

```bash
git clone https://github.com/PROVE1352/inkling.git
cd inkling
cp .env.example .env
# .env 수정: PUBLIC_URL=https://notes.example.com, DOMAIN=notes.example.com,
#           POSTGRES_PASSWORD=<긴 무작위 문자열>, BACKUP_PASSPHRASE=<서버 밖에도 따로 보관>

docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d
```

미리 빌드된 이미지 `ghcr.io/prove1352/inkling`(amd64, arm64)을 받아 오므로 램 1 GB 서버에서도 직접 빌드할 필요가 없습니다. 특정 릴리스로 고정하시려면 `.env`에 `INKLING_VERSION=0.3.1`처럼 적으시면 됩니다(비우면 `latest`). 받아 둔 소스로 직접 빌드하시려면 `-f compose.build.yaml`과 `--build`를 더하시면 됩니다([deploy/DEPLOY.md](deploy/DEPLOY.md)).

인증서는 Caddy가 받아 오고 갱신합니다. 그다음 첫 계정용 가입 키를 만드시면 됩니다. 처음 가입한 계정이 사이트 관리자가 됩니다.

```bash
./deploy/signup-key.sh new "first admin"
#   Signup key : ABCD-EFGH-JKMN-PQRS
#   Signup link: https://notes.example.com/register
```

가입 링크를 열고 키를 붙여 넣으시면 됩니다. 다음 키부터는 관리자 페이지에서 만들 수 있습니다.

도메인 없이 내 컴퓨터에서 먼저 써 보고 싶으시면 `.env.example`을 `.env`로 복사해 `POSTGRES_PASSWORD`만 채우고 `docker compose up -d`로 띄운 다음 http://localhost:3000 을 여시면 됩니다. 이때도 프로덕션 모드라 가입 키가 필요하니 위의 `signup-key.sh` 명령을 똑같이 실행하셔야 합니다.

업그레이드는 백업, 새 이미지 받기, 앱 재시작 순서입니다(마이그레이션은 부팅할 때 자동으로 돕니다). 소스 빌드에서 배포 이미지로 옮기는 방법까지 [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrades)에 있습니다.

```bash
./deploy/backup.sh
git pull                      # compose 파일과 배포 스크립트
docker compose -f compose.yaml -f deploy/compose.caddy.yaml pull app
docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d app
```

Compose 프로젝트, 볼륨, DB 역할 이름은 예전 이름인 `nodian`을 쓰고 있습니다. 이걸 바꾸면 업그레이드 후 기존 데이터 볼륨을 찾지 못하니 그대로 두시기 바랍니다.

### 설정

꼭 보셔야 할 항목만 추렸습니다. 모두 `.env`에 적습니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PUBLIC_URL` | 비어 있음 | 공개 주소입니다. 예: `https://notes.example.com`. 메일 링크, OAuth 발급자, 공유 미리보기에 쓰고 `Host` 헤더는 믿지 않습니다. `https://`로 시작하면 Secure 쿠키도 켜집니다. |
| `POSTGRES_PASSWORD` | 없음(필수) | DB 비밀번호입니다. `openssl rand -base64 24` 같은 걸로 만들어서 처음 띄우기 전에 넣어 주셔야 합니다. Postgres는 데이터 볼륨을 만들 때만 이 값을 읽고, 비어 있으면 compose가 아예 시작하지 않습니다. |
| `SIGNUP_REQUIRE_KEY` | 프로덕션에서 필수 | 비워 두면 가입에 키가 필요합니다. `0`이면 누구나 가입할 수 있습니다. |
| `DEFAULT_LOCALE` | `en` | `en` 또는 `ko`. 언어를 고르지 않은 사용자에게 가는 메일과 기본 템플릿의 언어이고, 브라우저 언어보다 먼저 쓰는 화면 기본값입니다. |
| `TZ` | `UTC` | 마감일, 데일리 노트, 알림, 백업 일정에서 "오늘"을 정하는 시간대입니다. 예: `Asia/Seoul` |
| `COOKIE_SECURE` | 자동 | `PUBLIC_URL`이 `https://`면 저절로 켜집니다(Caddy 오버레이도 켭니다). `PUBLIC_URL` 없이 다른 방식으로 HTTPS를 쓰실 때만 `1`로 두시면 됩니다. |

나머지(백업, 로그인 실패 제한, 위임 로그인, 임베드, 실험 기능, 메모리 한도, Postgres 튜닝)는 [.env.example](.env.example)과 [docs/OPERATIONS.md](docs/OPERATIONS.md)에 있습니다. 직접 운영하시는 리버스 프록시 뒤에 두는 방법 같은 배포 세부 사항은 [deploy/DEPLOY.md](deploy/DEPLOY.md)를 참고하시기 바랍니다.

<details>
<summary>Gmail로 메일 보내기(선택)</summary>

`SMTP_HOST`와 `MAIL_FROM`을 둘 다 넣어야 메일이 켜집니다. 2단계 인증을 켠 Google 계정에서 앱 비밀번호(Google 계정 › 보안 › 앱 비밀번호)를 만들어 `.env`에 넣으시면 됩니다.

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=<Gmail 주소>
SMTP_PASS=<16자리 앱 비밀번호>
MAIL_FROM="Inkling <Gmail 주소>"
# 선택: 이메일 인증 전에는 로그인 막기(이 설정을 켠 뒤 가입한 계정에만 적용)
REQUIRE_EMAIL_VERIFICATION=0
```

그다음 `docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d app`을 실행합니다. Gmail은 보낸 사람을 로그인한 계정으로 바꾸고 하루 발송량에도 제한이 있어서, 팀이 크다면 트랜잭션 메일 서비스를 쓰시는 편이 낫습니다.

</details>

### 개발

Node 22 이상, pnpm(버전은 `package.json`에 고정), Docker가 필요합니다.

```bash
pnpm install
pnpm db:up      # Postgres, localhost:55432
pnpm dev        # API·협업 서버 :3001, 웹 :5173
```

테스트, CI, 작업 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

## 다른 도구와 비교

2026년 11월 기준으로 각 프로젝트의 저장소, 문서, 가격 페이지를 보고 정리했습니다. "EE"는 유료 엔터프라이즈 판에만 있는 기능입니다. 제가 잘못 본 곳이 있을 수 있으니 틀린 부분은 알려 주시면 고치겠습니다.

| | Inkling | [salt.md](https://github.com/saltmd/salt.md) | [Docmost](https://github.com/docmost/docmost) | [AFFiNE](https://github.com/toeverything/AFFiNE) | [Outline](https://github.com/outline/outline) |
|---|---|---|---|---|---|
| 라이선스 | MIT | AGPL-3.0 | 코어 AGPL-3.0 + 유료 EE | MIT. 서버 코드는 EE 라이선스지만 무료 셀프호스트 Community Edition은 예외 | BSL 1.1(2030-10-23에 Apache 2.0으로 전환) |
| 데이터베이스 뷰 | 표, 보드, 캘린더, 갤러리, 타임라인 | 표, 보드, 리스트, 갤러리, 캘린더, 타임라인, 폼 | EE | 표, 칸반, 캘린더 | 없음 |
| `[[위키링크]]` / 백링크 | 있음 / 있음 | `[[`로 링크 메뉴 열기 / 있음 | 없음(`@` 멘션) / 있음 | 있음 / 있음 | 있음 / 있음 |
| 그래프 뷰 | 있음 | 있음 | 확인 못 함 | 확인 못 함 | 확인 못 함 |
| 캔버스 | JSON Canvas(`.canvas`) | 없음 | Excalidraw, draw.io 임베드 | 자체 화이트보드(Edgeless), JSON Canvas 아님 | 없음(diagrams.net 임베드) |
| 실시간 협업 | 있음 | 있음 | 있음 | 있음 | 있음 |
| MCP 서버 | 내장, 무료 | 내장, 무료 | EE | 내장, AI 제공자 설정 필요, 기본은 읽기 전용 | 내장(요금제 제한: ?) |
| 옵시디언 볼트 동기화 | 양방향(실험 기능) | 없음 | 없음 | 단방향 가져오기 | 없음 |
| 노션 가져오기 | 내보내기 zip(Markdown & CSV), API 가져오기는 없음 | 있음 | 있음 | 있음 | 있음 |
| 셀프호스트 무게 | 앱 + PostgreSQL | Go 바이너리 하나 + SQLite | 앱 + PostgreSQL + Redis | 앱 + PostgreSQL(pgvector) + Redis | 앱 + PostgreSQL + Redis, 로그인용 SSO나 SMTP 별도 필요 |

Inkling이 약한 점도 분명히 있습니다. PostgreSQL이 꼭 있어야 하고 SQLite 모드는 없습니다. 데스크톱이나 모바일 네이티브 앱도 없어서 웹 앱을 PWA로 설치해 쓰셔야 합니다. 인스턴스 하나로만 돌기 때문에 수평 확장이 안 되고, 아직 쓰는 사람이 적은 새 프로젝트입니다.

## 구조

- 서버(`apps/server`): Node 22, Fastify 5(`/api` REST), `/collab`의 Hocuspocus/Yjs 웹소켓 협업, PostgreSQL 16 위의 Drizzle ORM(트라이그램 검색, 부팅할 때 마이그레이션 적용), OAuth 서버가 딸린 `/mcp` 엔드포인트
- 웹(`apps/web`): React 19, Vite, Tailwind CSS v4, BlockNote(ProseMirror) 에디터, React Flow 캔버스, d3-force 그래프, PWA
- CLI(`apps/cli`): 볼트 동기화용 `inklingctl`
- 공용(`packages/shared`): 서버와 웹이 같이 쓰는 zod 스키마와 DTO, 쿼리 언어 파서
- 배포(`deploy/`): Caddy 오버레이, 백업 사이드카 스크립트, 복원·관리 보조 스크립트

설계 설명은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에, 결정과 그 이유는 [docs/adr/](docs/adr/README.md)의 ADR에, REST 계약은 [docs/API.md](docs/API.md)에 있습니다. 이 문서들은 영어로만 쓰여 있습니다.

## 성능

성능을 손볼 때는 같은 데이터로 전후를 재서 기록해 두고 있습니다. 몇 가지만 옮기면 이렇습니다.

`find_context`는 5,000페이지, 질문 28개짜리 벤치마크에서 질문당 평균 토큰이 2,254에서 624로 72% 줄었고, 도구 호출은 3.68번에서 1.00번으로, 답이 돌려준 내용 안에 들어 있는 비율은 0.75에서 0.93으로 올랐습니다([ADR 0927](docs/adr/0927-find-context-ranking-and-budget-packing.md)). `patch_section`으로 문장 하나를 고치면 약 222토큰이 드는데, 읽고 통째로 바꾸는 방식은 약 2,415토큰이 들었습니다([ADR 0930](docs/adr/0930-patch-section-yjs-splice-with-base-version.md)). 에이전트가 섹션을 고치는 동안 같은 섹션을 사람이 치고 있는 경우, 예전에는 6개 시나리오 중 1개에서만 사람의 글이 남았는데 지금은 6개 모두에서 남습니다([ADR 0940](docs/adr/0940-patch-section-minimal-yjs-edit.md)). 협업 저장 경로는 약 300블록짜리 페이지를 1,000번 저장할 때 SQL 문이 40,006개에서 1,042개로 줄었습니다([ADR 0750](docs/adr/0750-collab-store-path-db-side-snapshot-debounced-diffed-indexing.md)).

측정 방법과, 재 봤지만 효과가 없어서 버린 변경까지 모두 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)에 있습니다.

## 보안

Inkling은 서로 믿는 사람들이 워크스페이스 단위로 함께 쓰는 셀프호스트 단일 인스턴스를 전제로 만들었습니다. 인터넷에 여시기 전에 다음을 확인하시기 바랍니다.

- HTTPS 뒤에서 돌려 주세요. `deploy/compose.caddy.yaml`을 쓰면 앱과 DB 포트도 밖에서 보이지 않습니다. 직접 운영하시는 프록시에서 TLS를 끝내셔도 됩니다.
- `PUBLIC_URL`을 설정해 주세요(메일 링크를 다른 주소로 보내려면 `APP_URL`도). 비밀번호 재설정·인증 메일 링크, OAuth 메타데이터, 공유 미리보기가 이 값으로 만들어지고, `https://`면 세션 쿠키에 Secure가 자동으로 붙습니다.
- 가입 키 요구는 끄지 않는 편이 좋습니다(프로덕션 기본값). 첫 관리자 키는 `./deploy/signup-key.sh`로 만듭니다.
- `POSTGRES_PASSWORD`를 바꾸고, `BACKUP_PASSPHRASE`를 정해서 서버 밖에도 보관해 두세요.
- `TRUST_PROXY`는 실제로 앞에 둔 리버스 프록시만 가리키게 해 주세요.
- 실험 기능(`plugins`, `vault-sync`, `sheets-sync`)은 기본으로 꺼져 있습니다. 플러그인은 샌드박스에서 돌지만, 관리자가 승인한 뒤에는 신뢰하는 코드로 취급합니다.

워크스페이스 멤버는 그 워크스페이스의 공유 페이지를 모두 읽고 고칠 수 있고, 개인 페이지는 만든 사람만 봅니다. 취약점을 발견하시면 [SECURITY.md](SECURITY.md)의 방법으로 알려 주시기 바랍니다.

## 알려진 문제

첫 공개를 막을 정도는 아니라서 남겨 둔 문제들을 영역과 심각도별로 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)에 적어 두었습니다. 앞으로 할 일은 [docs/ROADMAP.md](docs/ROADMAP.md)에 있습니다.

## AI 도움을 받아 만들었습니다

Inkling은 설계와 구현에 AI 코딩 에이전트를 많이 썼습니다. 생성된 코드는 동시성(경쟁 상태, 갱신 유실, 잠금), 자원(메모리, 연결, 끝없이 커지는 데이터), 보안 쪽에서 잘 틀린다고 봐서, 이 부분을 겨냥해 여러 차례 따로 검토했습니다. 성능은 추측하지 않고 측정한 결과를 보고 고쳤습니다. 그 과정에서 내린 결정과 절충은 [docs/adr/](docs/adr/README.md)에, 아직 못 고친 문제는 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)에 공개해 두었습니다. 중요한 데이터를 맡기시기 전에는 다른 새 프로젝트와 마찬가지로 충분히 살펴보시기 바랍니다.

## 기여

이슈와 풀 리퀘스트는 언제든 환영합니다. 먼저 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어 주시고, 큰 변경은 이슈에서 짧게 이야기를 나눈 뒤에 올려 주시면 반영하기가 훨씬 수월합니다.

## 라이선스

[MIT](LICENSE). 이 저장소의 기능은 모두 무료이고, 유료 판은 따로 없습니다.
