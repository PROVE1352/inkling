# 쿼리 블록

**쿼리 블록**은 페이지를 실시간 표나 목록으로 보여 줍니다. 쿼리는 [Obsidian Dataview](https://blacksmithgu.github.io/obsidian-dataview/) 쿼리 언어의 일부를 그대로 써서 적습니다. English: [QUERY.md](QUERY.md).

블록은 **/ › 쿼리**(`/ → Query`)로 넣습니다. 쿼리 블록은 언어가 `dataview`인 코드 블록입니다. 결과는 그 아래에 나오고, 워크스페이스의 페이지가 바뀌면 결과도 따라 바뀝니다. 평범한 ` ```dataview ` 코드 블록이라서 Markdown으로 내보내도, MCP 커넥터나 볼트 동기화를 거쳐도 쿼리가 바뀌지 않습니다. Dataview 플러그인을 켠 옵시디언 볼트에서도 같은 쿼리가 그대로 돕니다.

```dataview
TABLE status, due, file.tags
FROM #project AND "Work/Clients"
WHERE status != "done" AND due < date(today)
SORT due ASC
LIMIT 50
```

<a id="query-shape"></a>
## 쿼리 구조

```
TABLE [WITHOUT ID] <expr> [AS "Label"], …   |   LIST [<expr>]   |   TASK
[FROM <source>]
[WHERE <expr>]
[SORT <expr> [ASC|DESC], …]
[LIMIT <n>]
```

* 키워드는 대소문자를 가리지 않습니다. `FROM`은 다른 절보다 앞에 와야 합니다. `WHERE`, `SORT`, `LIMIT`는 순서에 상관없이 쓸 수 있고, 각각 한 번씩만 쓸 수 있습니다.
* `TABLE`은 맨 앞 열에 페이지 링크를 보여 줍니다. `WITHOUT ID`를 붙이면 이 열이 빠집니다.
* `LIST <expr>`는 페이지 링크 옆에 그 값을 보여 줍니다.
* `TASK`는 **날짜가 붙은** 체크리스트 항목을 나열합니다. `page_tasks` 색인을 쓰기 때문에 캘린더와 '마감' 화면에 나오는 항목과 같습니다. 날짜가 없는 체크리스트 항목은 색인되지 않아서 나오지 않습니다.

<a id="sources-from"></a>
## 소스(`FROM`)

| 소스 | 가져오는 페이지 |
|---|---|
| `#tag` | 본문이나 `tags` 속성에 그 태그가 있는 페이지. 대소문자를 가리지 않고, `#a`로 찾으면 그 아래 태그인 `#a/b`도 함께 나옵니다. |
| `"Folder/Sub"` | 그 페이지 경로 아래에 있는 모든 페이지와, 딱 그 경로에 있는 페이지. 경로는 사이드바 트리처럼 제목을 `/`로 이어서 씁니다. |
| `[[Page]]` | `Page`**로 가는** 링크가 있는 페이지 |
| `-src`, `NOT src` | 제외 |
| `a AND b`, `a OR b`, `( … )` | 조합 |

`FROM`을 쓰지 않으면 워크스페이스에서 내가 볼 수 있는 문서 페이지 전부가 대상입니다.

<a id="fields"></a>
## 필드

| 필드 | 값 |
|---|---|
| `file.name`, `file.link` | 페이지 제목 |
| `file.ctime`, `file.mtime` | 만든 시각 / 마지막으로 고친 시각(타임스탬프) |
| `file.cday`, `file.mday` | 만든 날짜 / 고친 날짜(`YYYY-MM-DD`, 내 시간대 기준) |
| `file.tags` | `#tags` 목록(본문에 쓴 태그와 `tags` 속성) |
| `file.folder` | 부모 페이지의 경로(`Work/Clients`). 최상위 페이지는 `""` |
| `file.path` | 페이지 자신의 경로 |
| 그 밖의 이름 | 그 이름의 페이지 **속성**(대소문자 구분 없음). 그런 속성이 없고 데이터베이스 행이면 그 이름의 **데이터베이스 속성**을 씁니다. 선택 옵션은 라벨로 보입니다. 사람 속성은 멤버 이름으로 보이고, 관계형 속성은 내가 볼 수 있는 행으로 가는 링크로 보입니다(볼 수 없는 행은 빠집니다)(docs/adr/1320-*). `WHERE`와 `SORT`도 같은 값을 씁니다. 사람 속성은 멤버 이름으로, 관계형 속성은 내가 볼 수 있는 연결된 행의 제목으로 비교합니다(`SORT`는 이 제목들을 ", "로 이어서 씁니다). 그래서 `WHERE Owner = "Priya Nair"`로 찾을 수 있습니다. `=`, `!=`, `contains()`는 저장된 id로도 맞춰 봅니다. 멤버의 id와, 내가 볼 수 있는 연결된 행의 id가 그렇습니다. 이름과 제목은 대소문자까지 똑같아야 맞습니다(docs/adr/1352-*). |
| `` `Name with spaces` `` | 속성 이름에 공백이 있으면 백틱으로 감쌉니다 |
| `text`, `due`, `completed` / `checked` | **`TASK` 전용**: 항목의 글, 날짜, 체크 상태 |

<a id="expressions"></a>
## 표현식

* 리터럴: `"text"`, `42`, `3.5`, `true`, `false`, `null`
* 날짜: `date(today)`, `date(tomorrow)`, `date(yesterday)`, `date("2026-11-07")`. `today`는 보는 사람의 현지 날짜입니다.
* 비교: `=` `!=` `<` `<=` `>` `>=`
  * 필드가 `"x"`를 담은 **목록**이어도 `field = "x"`는 참입니다.
  * 숫자와 비교하면 숫자로 비교합니다. 숫자로 된 문자열도 숫자로 칩니다.
  * 날짜와 비교하면 `YYYY-MM-DD` 부분만 비교합니다. `file.ctime` / `file.mtime`은 그 날짜의 현지 시간 자정과 비교합니다.
* `contains(list, "x")`: 목록에 그 값이 들어 있는지 봅니다. 텍스트 값이면 그 문자열이 들어 있는지 봅니다.
* 논리: `AND` / `&&`, `OR` / `||`, `NOT` / `!`, 괄호. 필드 이름만 쓰면 그 값이 있고 `false`, `0`, `""`, `[]`가 아닐 때 참입니다.

<a id="limits"></a>
## 제한

| 항목 | 값 |
|---|---|
| 쿼리 길이 | 2,000자, 토큰 400개, 중첩 깊이 24 |
| 열 / 정렬 키 | 20개 / 5개 |
| 행 | `LIMIT` ≤ 500(기본 200). 결과가 잘리면 블록에 그렇게 나옵니다 |
| 실행 | 쿼리 한 번에 3초 제한(statement timeout). 이 제한에 걸리면 `FROM` / `WHERE`로 범위를 좁히세요 |

결과에는 내가 볼 수 있는 페이지(공유 페이지와 내 개인 페이지)만 나옵니다. 휴지통에 있는 페이지와 템플릿은 빠집니다.

<a id="errors"></a>
## 오류

문법 오류는 블록 안에 나옵니다. 줄과 열 번호를 알려 주고, 문제가 있는 곳 밑을 캐럿으로 가리킵니다. 브라우저와 서버는 같은 파서(`packages/shared/src/query.ts`)를 씁니다.

<a id="differences-from-dataview"></a>
## Dataview와 다른 점

지원하지 않는 것은 `CALENDAR` 쿼리, `GROUP BY`, `FLATTEN`, 인라인 필드(`key:: value`), 산술 연산, 기간(`date(today) - dur(1 week)`), 정규식 함수, DataviewJS, 나가는 링크로 거르는 `FROM`(`outgoing([[Page]])`)입니다. `TASK`는 날짜가 붙은 체크리스트 항목만 다룹니다.

<a id="api"></a>
## API

`POST /api/workspaces/:id/query`입니다. 자세한 내용은 [API.ko.md](API.ko.md#query-blocks)를 보세요.
