# 템플릿

템플릿을 쓰면 페이지 하나, 또는 여러 페이지로 된 구조 전체를 내용이 미리 채워진 채로 만들 수 있습니다. **새 페이지 ▾ › 템플릿에서 시작**(`New page ▾ → Start from template`)이나 명령 팔레트에서 갤러리를 엽니다. 템플릿을 고르고 질문에 답한 뒤 **만들기**(`Create`)를 누르면 됩니다. English: [TEMPLATES.md](TEMPLATES.md).

설계 기록은 [ADR 0920](adr/0920-template-model.md)(모델과 정리), [0921](adr/0921-structure-templates-atomic-instantiation.md)(구조), [0922](adr/0922-template-variables.md)(변수), [0923](adr/0923-templater-compatibility-no-code.md)(Templater), [0924](adr/0924-template-file-format.md)(파일), [0925](adr/0925-template-gallery-visibility-mcp.md)(갤러리, 공개 범위, MCP)에 있습니다.

<a id="kinds-of-templates"></a>
## 템플릿 종류

| 종류 | 만드는 것 |
|---|---|
| 문서 | 본문이 들어 있는 페이지 하나. |
| 구조 | 페이지 트리. 루트 페이지와 그 아래의 하위 페이지, 폴더, 데이터베이스(속성, 뷰, 행 템플릿, 원하면 처음 행까지), 캔버스가 함께 만들어집니다. 그 안의 페이지끼리 건 링크, 데이터베이스의 관계형 속성, 캔버스 카드는 새로 만든 페이지를 가리킵니다. |

데이터베이스마다 따로 두는 [행 템플릿](#row-templates)은 이것과 다른 기능입니다. 그 데이터베이스에 새 행을 만들 때 내용을 채워 줍니다.

<a id="built-in-templates"></a>
### 기본 템플릿

기본 템플릿은 앱에 들어 있습니다. 업데이트하면 함께 나아지고, 지울 수는 없습니다. 영어판과 한국어판이 있고, 내 언어에 맞는 쪽이 나옵니다.

| 템플릿 | 분류 | 종류 | 내용 |
|---|---|---|---|
| 회의록(`Meeting notes`) | 회의 | 문서 | 목표, 참석자, 안건, 메모, 결정 사항, 할 일, 남은 질문. 날짜가 붙습니다(캘린더에 나옵니다). |
| 데일리 스탠드업(`Daily standup`) | 회의 | 문서 | 사람마다 어제 한 일 / 오늘 할 일 / 막힌 점. 날짜가 붙습니다. |
| 정기 회의(`Meeting series`) | 회의 | 구조 (3) | 목적과 고정 안건을 적는 페이지 + **회의 기록**(`Meetings`) 데이터베이스(표, 캘린더 뷰)와 첫 회의. |
| 프로젝트(`Project`) | 프로젝트 | 구조 (7) | 개요 페이지 + 처음 할 일 세 개가 든 **할 일**(`Tasks`) 데이터베이스(상태별 보드, 표, 캘린더. 상태, 담당자, 마감일, 우선순위 속성) + 킥오프 페이지가 든 **회의록**(`Meeting notes`) 폴더. 목표와 목표 날짜를 묻습니다. |
| 프로젝트 킥오프(`Project kickoff`) | 프로젝트 | 문서 | 왜 하는지, 목표, 범위, 마일스톤, 팀, 위험 요소, 일하는 방식. |
| 브레인스토밍(`Brainstorm`) | 문서 | 문서 | 질문, 제약, 진행 규칙, 아이디어, 주제 묶음, 추린 목록, 다음 단계. |
| 회고 (KPT)(`Retrospective (KPT)`) | 문서 | 문서 | Keep / Problem / Try와 할 일. 어느 기간을 돌아볼지 묻습니다. |
| 읽을거리(`Reading list`) | 개인 | 구조 (2) | 갤러리 뷰 "책장", 상태별 보드, 표가 있는 데이터베이스. 지금 무엇을 읽고 있는지 묻고 그 책의 노트 페이지를 만듭니다. |
| 주간 회고(`Weekly review`) | 개인 | 구조 (9) | ISO 주 번호를 제목에 넣은 회고 페이지 + 요일마다 행이 하나씩 있는 **습관 기록**(`Habits`) 표. |

<a id="your-own-templates"></a>
### 직접 만드는 템플릿

**템플릿으로 저장**(`Save as template`)은 페이지의 ⋯ 메뉴와 오른쪽 패널에 있습니다. 이름, 아이콘, 설명, 분류를 정하고, 아래 두 가지를 함께 넣을지 고릅니다.

- 페이지 아래의 **하위 페이지, 데이터베이스, 캔버스**(넣지 않으면 그 페이지만 저장됩니다)
- 처음 행으로 쓸 **데이터베이스 행**(넣지 않으면 데이터베이스는 속성과 뷰만 남기고 빈 채로 시작합니다)

개인 페이지에서 저장한 템플릿은 개인 템플릿이 되어 나만 볼 수 있습니다. 다른 페이지에서 저장할 때는 **나만 보기**(`Only me`)를 체크할 수 있습니다. 공유 템플릿은 워크스페이스의 다른 사람 모두에게 보입니다. 템플릿을 지울 수 있는 사람은 만든 사람과 워크스페이스 소유자입니다.

템플릿은 저장한 순간의 사본입니다. 나중에 원래 페이지를 고쳐도 템플릿은 그대로입니다. 사람과 사람 속성은 템플릿에 저장되지 않습니다. 이미지와 파일은 원래 첨부 파일을 가리키는 링크로 남습니다.

<a id="variables"></a>
## 변수

변수는 글 안에 적어 두면 페이지를 만들 때 채워집니다. 페이지를 만드는 그 순간 서버에서 채웁니다. 페이지 본문, 페이지 제목, 캔버스의 텍스트 카드, 데이터베이스 행의 텍스트 값에서 쓸 수 있습니다.

| 변수 | 채워지는 값 | 예 |
|---|---|---|
| `{{title}}` | 새로 만든 루트 페이지의 제목 | `Apollo` |
| `{{date}}` | 날짜(`YYYY-MM-DD`) | `2026-11-07` |
| `{{date:FORMAT}}` | 정한 형식의 날짜(아래 참고) | `{{date:dddd, MMMM D}}` → `Saturday, November 7` |
| `{{time}}`, `{{time:FORMAT}}` | 지금 시각(기본 형식은 `HH:mm`) | `09:05` |
| `{{weekday}}` | 내 언어로 쓴 요일 | `Saturday` / `토요일` |
| `{{author}}` | 내 이름 | `Ada` |
| `{{workspace}}` | 워크스페이스 이름 | `Acme` |
| `{{input:Question\|default}}` | 만들기 전에 묻는 질문에 내가 한 답. 비워 두면 기본값 | `{{input:Target date\|TBD}}` |
| `{{cursor}}` | 지워지고, 페이지를 열면 그 자리에 커서가 놓입니다 | |

- **날짜와 시각**은 내 기기의 시간대를 따릅니다. 클라이언트가 시간대를 보내지 않으면 서버의 `TZ`를 씁니다. 날짜가 붙는 템플릿이면 갤러리에 날짜 칸이 나오고, `{{date}}`는 그 칸의 날짜로 채워집니다.
- 질문이 같은 **입력**은 한 번만 묻습니다. 기본값은 변수가 적힌 자리마다 따로 적용됩니다. 답은 서식 없는 텍스트로 들어갑니다.
- **커서**: `{{cursor}}`가 있는 첫 페이지의 첫 번째 `{{cursor}}`만 쓰이고, 나머지는 지워집니다.
- **모르는 변수는 적힌 그대로 남습니다**(`{{mood}}`는 건드리지 않습니다). 그래서 이 문법 때문에 글이 사라지는 일은 없습니다.
- **서식은 그대로 남습니다.** 변수는 서식이 같은 한 덩어리의 텍스트 안에서만 바뀝니다. 그래서 `**{{author}}**`는 굵은 글씨로 남고, 링크가 가리키는 주소도 바뀌지 않습니다. 변수가 두 서식에 걸쳐 있으면(절반만 굵은 글씨) 변수로 알아보지 못합니다. 인라인 코드와 코드 블록 안에서는 변수가 바뀌지 않으니, 템플릿 문법을 설명하는 글은 이 둘로 쓰세요.

<a id="date-format-tokens"></a>
### 날짜 형식 토큰

Moment.js와 호환되는 일부만 지원합니다. `YYYY` `YY` · `MMMM` `MMM` `MM` `M` · `DD` `D` `Do` · `dddd` `ddd` `dd` `d` · `HH` `H` `hh` `h` · `mm` `m` · `ss` `s` · `A` `a` · `W` `WW`(ISO 주) `GGGG`(ISO 주 기준 연도)입니다. `[brackets]`처럼 대괄호 안에 쓴 글자는 그대로 찍힙니다. 월과 요일 이름은 내 언어를 따릅니다(`MMMM` → `November` / `11월`).

| 형식 | en | ko |
|---|---|---|
| `{{date:YYYY-MM-DD}}` | 2026-11-07 | 2026-11-07 |
| `{{date:MMMM D, YYYY}}` | November 7, 2026 | 11월 7, 2026 |
| `{{date:YYYY년 M월 D일 dddd}}` | — | 2026년 11월 7일 토요일 |
| `{{date:GGGG-[W]WW}}` | 2026-W45 | 2026-W45 |
| `{{time:h:mm A}}` | 9:05 AM | 9:05 오전 |

<a id="obsidian-templater-compatibility"></a>
## 옵시디언 Templater 호환

옵시디언 볼트에서 가져온 템플릿도 Templater 태그 가운데 자주 쓰는 것은 그대로 동작합니다. 이 태그들은 실행되지 않고, 위의 변수로 **바꿔 적힙니다**.

| Templater | Inkling |
|---|---|
| `<% tp.date.now() %>` | `{{date}}` |
| `<% tp.date.now("FORMAT") %>` | `{{date:FORMAT}}` |
| `<% tp.date.now("FORMAT", 7) %>` | 7일 뒤의 날짜(음수를 주면 그만큼 앞 날짜) |
| `<% tp.file.title %>` | `{{title}}` |
| `<% tp.file.cursor() %>` | `{{cursor}}` |

그 밖의 것은 모두 일반 텍스트로 남습니다. `<%* … %>` 블록, `tp.system.prompt`, `tp.user.*`, `tp.web.*`, 그 밖의 `tp.file` 함수가 여기에 해당합니다. 템플릿은 멤버끼리 나눠 쓰고 파일에서 가져오기도 하기 때문에, Inkling은 템플릿 안의 코드를 실행하지 않습니다. `tp.system.prompt` 대신 `{{input:…}}`을 쓰세요.

<a id="files-export-and-import"></a>
## 파일로 내보내기와 가져오기

갤러리에서는 어떤 템플릿이든(기본 템플릿도) 내보낼 수 있고, `.md`와 `.zip` 파일을 가져올 수 있습니다. 가져올 때는 페이지 가져오기와 같은 제한과 변환기를 거칩니다. 파일 하나에 25 MB, 압축을 푼 크기 50 MB, 항목 300개까지이고, 템플릿 하나에 페이지는 200개, 깊이는 12단계까지입니다.

<a id="document-template-markdown"></a>
### 문서 템플릿: Markdown

```markdown
---
inkling-template: 1
name: "Meeting notes"
description: "Goal, agenda, decisions and action items for one meeting"
category: meetings
icon: "📋"
with-date: true
variables:
  - "Which period are you looking back on?|This sprint"
---
**When:** {{date:MMMM D, YYYY}} ({{weekday}}), {{time}} · **Notes by:** {{author}}

## Agenda

1. {{cursor}}
```

- 키는 한 단계로만 씁니다(중첩된 맵은 쓰지 않습니다). `category`는 `docs`, `projects`, `meetings`, `personal`, `custom` 중 하나이고, 그 밖의 값은 `custom`으로 가져옵니다. `variables`에는 입력 질문을 `Question|default` 꼴로 적습니다. 이 목록은 참고용일 뿐이고, 실제 질문은 본문에서 읽어 냅니다.
- 이 frontmatter가 없는 Markdown 파일은 파일 이름을 딴 문서 템플릿으로 가져옵니다. 그래서 옵시디언 템플릿 폴더를 파일 하나씩 가져올 수 있습니다.

<a id="structure-template-zip"></a>
### 구조 템플릿: zip

```
inkling-template.json
pages/p0.md
pages/p3.md
pages/p5.canvas
```

`inkling-template.json`은 이렇게 생겼습니다.

```json
{
  "inkling-template": 1,
  "name": "Project",
  "description": "…",
  "category": "projects",
  "icon": "🚀",
  "withDate": false,
  "variables": ["Target date|TBD"],
  "root": {
    "ref": "p0", "kind": "doc", "title": "Project", "icon": "🚀", "file": "pages/p0.md",
    "children": [
      {
        "ref": "p1", "kind": "collection", "title": "Tasks",
        "fields": [{ "id": "status", "name": "Status", "type": "select", "options": [ … ] },
                   { "id": "parent", "name": "Parent", "type": "relation", "relation": { "targetPageId": "p1" } }],
        "views": [{ "name": "Board", "type": "board", "config": { "groupByFieldId": "status" } }],
        "children": [
          { "ref": "p2", "kind": "doc", "title": "Write the brief", "file": "pages/p2.md",
            "props": { "status": "todo", "parent": ["p2"] }, "children": [] }
        ]
      }
    ]
  }
}
```

- `kind`는 `doc`, `folder`, `collection`, `canvas` 중 하나입니다. 문서는 Markdown 파일을 가리키고, 캔버스는 JSON Canvas(`.canvas`) 파일을 가리킵니다. 캔버스의 파일 카드는 다른 페이지의 `ref`를 `file` 값으로 씁니다.
- 페이지끼리는 데이터베이스 id가 아니라 `ref`(`p0`, `p1`, …)로 서로를 가리킵니다. 관계형 속성의 대상, `props` 안의 관계형 값, 캔버스 카드가 모두 그렇습니다. Markdown 안의 `[[Title]]` 링크는 먼저 템플릿 안의 페이지에서 찾고, 없으면 가져오는 워크스페이스에서 내가 볼 수 있는 페이지에서 찾습니다.
- 속성과 뷰는 API와 같은 모양(`CollectionField`, `ViewConfig`)으로 씁니다. 대상 데이터베이스가 템플릿 안에 없는 관계형 속성은 텍스트 속성으로 가져오고, 사람 값은 버립니다.

<a id="row-templates"></a>
## 행 템플릿

데이터베이스마다 **새 행**(`New row`) 버튼에 쓸 행 템플릿을 20개까지 둘 수 있습니다. 행 템플릿에는 이름과 아이콘, **제목** 패턴, **속성값**, **본문**이 들어가고, 그중 하나를 기본 템플릿으로 정할 수 있습니다. 설계 기록은 [ADR 1180](adr/1180-row-templates-stored-apart-from-pages.md)(모델), [1181](adr/1181-one-create-path-for-rows.md)(행 만들기와 값), [1182](adr/1182-row-template-editor-on-a-local-document.md)(편집기), [1183](adr/1183-row-templates-in-copies-and-files.md)(사본과 파일), [1184](adr/1184-row-template-permissions-and-leaks.md)(권한)에 있습니다.

- **새 행**은 기본 템플릿을 쓰고, 기본 템플릿이 없으면 빈 행을 만듭니다. 그 옆의 **▾** 메뉴에서 다른 템플릿이나 **빈 행**(`Empty row`)을 고를 수 있습니다. 보드 열의 **+** 버튼과 캘린더 날짜의 **+** 버튼도 기본 템플릿을 씁니다. 이때는 그 열의 값이나 그 날짜가 템플릿 값 위에 덮어써집니다.
- 템플릿의 아이콘이 행의 아이콘이 됩니다. 행을 만들 때 제목을 직접 입력하면 제목 패턴 대신 그 제목이 쓰입니다.
- 제목, 텍스트 값, URL 값, 본문에는 위의 [변수](#variables)를 쓸 수 있습니다. 여기서 `{{title}}`은 행의 제목입니다. `{{input:…}}` 질문은 행을 만들기 전에 묻습니다(MCP 클라이언트는 `inputs`로 답을 넘깁니다). 변수는 행을 만들 때만 채워지고, 템플릿을 저장하거나 복사할 때는 채워지지 않습니다.

속성값은 행의 값과 같은 방식으로 저장됩니다. 다만 상대적인 값을 쓰는 형태가 두 가지 있습니다.

| 속성 | 템플릿에 넣는 값 | 채워지는 값 |
|---|---|---|
| 날짜 | `today`, `today+7`, `today-1` 또는 `2026-12-01` | 만든 사람의 날짜(그 사람의 시간대 기준)에서 그 일수만큼 옮긴 날짜 |
| 사람 | `me` 또는 멤버 | `me`는 행을 추가하는 사람 |
| 선택, 다중 선택 | 옵션 id | 같은 옵션 |
| 텍스트, URL | 변수가 들어간 텍스트 | 변수를 채운 텍스트 |
| 숫자, 체크박스 | 값 | 같은 값 |
| 관계형, 롤업 | 넣을 수 없음 | 행마다 정합니다 |

더 이상 맞지 않는 값(지워진 옵션, 종류가 바뀐 속성, 워크스페이스를 떠난 사람)은 행을 만들 때 버립니다. 이때도 행은 만들어집니다.

템플릿을 편집하면 페이지처럼 열립니다. 편집기도 같고, 본문 위에 속성값이 나옵니다. 바꾼 내용은 입력하는 대로 저장됩니다. 데이터베이스를 볼 수 있는 사람은 누구나 그 데이터베이스의 템플릿을 쓸 수 있습니다. 템플릿을 만들고, 고치고, 지우고, 기본 템플릿을 정하려면 그 데이터베이스를 편집할 수 있어야 하고, 데이터베이스에 걸린 [편집 잠금](GUIDE.ko.md)도 적용됩니다. 행 템플릿은 페이지가 아니기 때문에 검색, 백링크, 쿼리 블록, 그래프, 사이드바, 웹훅, MCP 페이지 목록 어디에도 나오지 않습니다.

**사본.** 데이터베이스를 복제하면 행 템플릿도 함께 복사됩니다. **템플릿으로 저장**을 하면 행 템플릿도 데이터베이스와 함께 저장됩니다(행과 마찬가지로 `me`가 아닌 사람 값은 버립니다). 그 템플릿으로 페이지를 만들면 새 데이터베이스도 같은 행 템플릿을 갖게 됩니다. 템플릿 파일에서는 `inkling-template.json` 안에 들어갑니다(아래 예). 워크스페이스 Markdown 내보내기에는 뷰와 마찬가지로 들어가지 않습니다.

```json
{
  "ref": "p1", "kind": "collection", "title": "Meetings",
  "fields": [ … ], "views": [ … ],
  "rowTemplates": [
    { "name": "Weekly", "icon": "📋", "title": "{{date}} {{input:Topic|Weekly}} meeting",
      "props": { "status": "plan", "date": "today", "owner": "me" },
      "default": true, "file": "pages/p1-t0.md" }
  ],
  "children": [ … ]
}
```

<a id="api-and-mcp"></a>
## API와 MCP

REST 경로는 [API.ko.md의 Templates](API.ko.md#templates)에 정리되어 있습니다. MCP 클라이언트는 `list_templates`와 `create_from_template` 도구를 씁니다([MCP.ko.md](MCP.ko.md)).

행 템플릿에는 `GET`/`POST /api/pages/:id/collection/row-templates`, `GET`/`PATCH`/`DELETE /api/collection-row-templates/:id`가 있고, 행 하나를 만들 때는 `POST /api/pages/:id/collection/rows`를 씁니다(`template`을 빼면 기본 템플릿, `null`이면 빈 행). MCP의 `create_row`는 `template`(이름이나 id, 또는 `"none"`)과 `inputs`를 받습니다. `query_rows`에 `describe: true`를 주면 템플릿 목록이 함께 나옵니다.
