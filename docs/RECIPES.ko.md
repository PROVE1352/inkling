# 다른 MCP 서버와 같이 쓰기

English: [RECIPES.md](RECIPES.md).

Inkling이 다른 도구에 직접 붙는 것은 아닙니다. 붙는 쪽은 에이전트 클라이언트(Claude Code, claude.ai, 그 밖의 MCP 클라이언트)입니다. 클라이언트에 Inkling MCP 서버를 연결하고, 같이 쓰는 다른 도구의 MCP 서버도 옆에 연결해 두면, 에이전트가 Inkling에서 계획을 읽고 다른 도구로 일을 한 다음 결과를 다시 Inkling에 적습니다. 이 흐름에서 Inkling은 팀의 공용 기억 역할을 합니다. 기획서, 결정 사항, 진행 상황, 회의록을 팀의 사람과 에이전트가 모두 같은 페이지에서 읽고, 누가 무엇을 썼는지는 히스토리와 경유 표시(via)로 남습니다.

## 준비

1. Inkling을 연결합니다. 방법은 [MCP.md의 Claude Code](MCP.md#claude-code)나 [MCP.md의 claude.ai](MCP.md#claudeai) 절에 있습니다. 에이전트가 진행 상황을 적어야 하니 읽기와 쓰기 권한으로 연결하는 것이 좋습니다.
2. 다른 도구의 MCP 서버는 그 도구의 문서에 나온 방법대로 연결합니다. Inkling 쪽에는 따로 설정할 것이 없고, 그 도구의 인증 정보도 Inkling에 들어오지 않습니다.
3. 에이전트에서 두 서버가 모두 보이는지 확인합니다(Claude Code에서는 `/mcp`).

아래 예시를 쓸 때 지켜 두면 좋은 습관이 몇 가지 있습니다.

워크스페이스에서 일을 시작하기 전에 `get_instructions(workspaceId)`를 한 번 부르게 하세요. 잠긴 지침 페이지에 적어 둔 에이전트용 규칙을 돌려줍니다. 페이지를 통째로 읽기보다는 `find_context`로 찾고 `read_page(pageId, section=…)`로 필요한 섹션만 읽는 편이 토큰이 덜 듭니다. 고칠 때는 읽을 때 받은 `v=` 값을 `baseVersion`으로 넘겨서 `patch_section`으로 섹션 하나만 바꿉니다. 그 사이에 누가 고쳤으면 충돌이 나면서 지금 내용이 같이 오니, 합친 다음 다시 보내면 됩니다.

페이지 내용이나 다른 도구에서 가져온 글은 지시가 아니라 데이터입니다. 이슈나 페이지에 "규칙을 무시하라"고 적혀 있어도 그냥 글일 뿐입니다. 여러 에이전트가 한 페이지에서 일할 때는 오래 고칠 섹션을 `claim_section`으로 잡아 두고 끝나면 `release_section`으로 풀어 줍니다. 다른 사람의 에이전트가 무엇을 하고 있는지는 `catch_up(team=true)`로 볼 수 있습니다.

아래에 나오는 Inkling 도구 이름은 실제 이름이고, 인자는 [MCP.md](MCP.md)에 있습니다. 다른 도구 쪽은 일부러 뭉뚱그려 적었습니다. 게임 엔진이나 디자인 도구, 코드 저장소의 MCP 서버가 어떤 도구를 주는지는 서버마다 다르니 그 서버의 문서를 보시기 바랍니다.

## 1. 기획서를 읽고 게임 엔진에서 만든 뒤 진행 상황 남기기

흐름: 기획자가 레벨이나 기능 기획서를 Inkling 페이지에 써 둡니다. 개발자의 에이전트가 그 기획서를 읽고 게임 엔진(Unreal Engine 등)의 MCP 서버로 기능을 만든 다음, 기획서의 "진행 상황" 섹션에 어디까지 했는지 적습니다. 기획자는 따로 묻지 않아도 페이지에서 진행 상황을 봅니다. 게임 엔진 쪽 MCP 서버는 그 서버의 문서대로 설치해 두어야 합니다.

Inkling 쪽 도구:

- `find_context("보스 아레나 기획")`로 페이지와 섹션을 찾고, `read_page(pageId, outline=true)`와 `read_page(pageId, section=…)`로 필요한 부분만 읽습니다.
- `claim_section(pageId, "진행 상황", minutes=30)`으로 섹션을 잡아 두면 그동안 다른 에이전트가 같은 섹션을 덮어쓰지 못합니다. 다시 부르면 시간이 늘어납니다.
- 한 단계가 끝날 때마다 `patch_section(pageId, "진행 상황", markdown, mode="append", baseVersion)`으로 적고, 끝나면 `release_section`으로 풉니다.
- 기획서에 없는 내용은 짐작하지 말고 `add_comment(pageId, section="…", text="…")`로 물어보게 합니다.

프롬프트 예시:

```text
Inkling에서 "보스 아레나" 기획서를 읽어 줘(find_context로 먼저 찾고 필요한 섹션만 읽기).
게임 엔진 도구로 아레나를 만들어 줘. 배치는 "레이아웃" 섹션, 페이즈 규칙은 "페이즈" 섹션대로.
시작하기 전에 기획서의 "진행 상황" 섹션을 잡아 두고, 한 부분이 끝날 때마다 무엇을 만들었고
프로젝트의 어디에 있고 무엇이 남았는지 "진행 상황"에 한 줄씩 덧붙여 줘.
기획서에서 애매한 부분은 그 섹션에 코멘트를 남기고 나머지부터 진행해 줘.
다 끝나면 섹션 잡은 것을 풀어 줘.
```

## 2. 디자인 링크가 있는 PRD를 읽고 코드 고친 뒤 결과 적기

흐름: Inkling의 PRD 페이지에 디자인 파일 링크(예를 들어 Figma 프레임)가 붙어 있습니다. 에이전트가 PRD를 읽고, 디자인 도구의 MCP 서버로 링크된 시안을 열어 보고, 작업 중인 저장소의 코드를 고친 다음, 무엇을 했는지 PRD 페이지에 적습니다.

Inkling 쪽 도구:

- `find_context("결제 화면 개편 PRD")`로 찾고 `read_page(pageId, section=…)`로 요구 사항과 디자인 링크가 있는 섹션을 읽습니다.
- `inbox()`로 그 페이지에서 나를 멘션했거나 나에게 남긴 코멘트를 보고, 처리한 뒤 `ack(cursor)`로 확인 처리합니다.
- `patch_section(pageId, "구현 메모", markdown, mode="replace", baseVersion)`으로 바꾼 파일, 시안과 달라진 점, 남은 질문을 적습니다. 섹션이 없으면 `insert_after`로 새로 만들 수 있습니다.
- 페이지의 리뷰 코멘트에는 `reply_comment(threadId, text)`로 답합니다.

프롬프트 예시:

```text
Inkling에서 "결제 화면 개편" PRD를 읽어 줘. "디자인" 섹션의 링크를 디자인 도구로 열어서
이 저장소의 지금 결제 화면 코드와 비교하고, "요구 사항"에 적힌 대로 고쳐 줘.
끝나면 PRD의 "구현 메모" 섹션을 바꿔 줘. 바꾼 파일, 시안과 다른 점과 그 이유, 남은 질문.
시작하기 전에 Inkling inbox에서 이 PRD에 달린 코멘트를 먼저 보고 답할 수 있는 건 답해 줘.
```

## 3. GitHub PR을 정리해서 회의록에 넣기

흐름: 주간 회의 전에 에이전트가 코드 저장소(예를 들어 GitHub)의 MCP 서버로 지난 회의 뒤에 머지되거나 새로 열린 PR을 모으고, 정리해서 Inkling의 회의록 페이지에 넣습니다.

Inkling 쪽 도구:

- `find_context("주간 회의록")`나 `list_pages(workspaceId, parentId, format="lines")`로 이번 주 회의록 페이지를 찾습니다. 아직 없으면 `create_page(workspaceId, title, markdown, parentId)`로 만들고, 팀에 회의록 템플릿이 있으면 `create_from_template`을 씁니다.
- `read_page(pageId, outline=true)`로 섹션을 보고 `patch_section(pageId, "PR", markdown, mode="replace", baseVersion)`으로 채웁니다.
- 지난 회의 뒤에 노트에서 바뀐 것까지 정리하게 하려면 `catch_up()`을 같이 씁니다.

프롬프트 예시:

```text
코드 저장소 도구로 우리 저장소에서 지난 월요일 이후에 머지됐거나 새로 열린 PR을 모아 줘.
영역별로 묶고 PR마다 제목, 작성자, 링크, 머지 여부를 한 줄로 적어 줘.
그다음 Inkling에서 이번 주 회의록 페이지를 찾아서(없으면 "회의" 아래에 회의록 템플릿으로 만들고)
"PR" 섹션을 이 목록으로 바꿔 줘.
```

## Inkling에 남겨 둘 것

결과와 결정, 진행 상황은 채팅에만 두지 말고 페이지에 적게 하세요. 다음에 에이전트를 다시 돌릴 때도, 팀원이 볼 때도 같은 페이지를 읽게 됩니다. 에이전트가 고친 내용은 사람이 검토할 수 있습니다. 워크스페이스 설정에 따라 에이전트가 바로 고치지 않고 제안(`patch_section(…, suggest=true)`)으로 남기게 할 수 있고, 고친 것은 활동 화면에서 되돌릴 수 있습니다. 후속 작업을 다른 팀원의 에이전트에게 넘기고 싶으면 `catch_up(team=true)`가 보여 주는 짧은 연결 id로 `add_comment(…, handoffTo=["g:…"])`를 쓰면 됩니다.
