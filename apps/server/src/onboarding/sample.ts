import type { CollectionField } from '@inkling/shared'
import type { Locale } from '../i18n'
import type { SpecNode } from '../templates/builtins'

/**
 * The "Getting started" sample page (docs/adr/2381-*): a short page to try things on, built with the
 * built-in template machinery (spec → compile → instantiateTree) but not listed as a template.
 *
 * Its title and first line say it is a sample, so an agent that finds it with find_context or
 * search can tell it apart from real notes; there is at most one live sample per person and
 * workspace, in that person's private pages.
 */

type Color = 'gray' | 'blue' | 'green'

export function sampleTitle(locale: Locale): string {
  return locale === 'ko' ? 'Inkling 시작하기 (샘플)' : 'Getting started with Inkling (sample)'
}

export function sampleSpec(locale: Locale): SpecNode {
  const ko = locale === 'ko'
  const linkPage = ko ? '링크 연습' : 'Practice linking'
  const board = ko ? '샘플 할 일' : 'Sample tasks'
  const status: CollectionField = {
    id: 'status',
    name: ko ? '상태' : 'Status',
    type: 'select',
    options: (
      [
        ['todo', ko ? '할 일' : 'To do', 'gray'],
        ['doing', ko ? '하는 중' : 'Doing', 'blue'],
        ['done', ko ? '끝남' : 'Done', 'green'],
      ] as [string, string, Color][]
    ).map(([id, name, color]) => ({ id, name, color })),
  }
  const row = (title: string, s: string, md: string): SpecNode => ({ kind: 'doc', title, md, props: { status: s } })

  const root = ko
    ? `> [!note] 이 페이지는 Inkling을 직접 만져 보기 위한 샘플입니다. 마음껏 고치고, 다 보면 지워도 됩니다. 지운 샘플은 다시 생기지 않습니다.

## 1. 블록

빈 줄에서 \`/\`를 누르면 블록 메뉴가 열립니다. 제목, 할 일, 표, 콜아웃, 코드, 수식, 데이터베이스 보기를 넣을 수 있습니다.

- [ ] 아래 빈 줄에서 \`/\`를 누르고 "체크리스트"를 골라 보세요
- [ ] 이 줄을 체크해 보세요
- [x] 끝난 일은 이렇게 보입니다

## 2. 링크

\`[[\`를 입력하고 페이지 이름을 고르면 링크가 됩니다. 예: [[${linkPage}]]. 링크된 페이지 아래에는 이 페이지가 백링크로 나옵니다.

> [!tip] 없는 이름을 \`[[\` 뒤에 적으면 그 이름으로 새 페이지를 만들 수 있습니다.

## 3. 데이터베이스

아래는 [[${board}]] 데이터베이스를 이 문서 안에 넣은 보기입니다. 여기서 고친 값은 데이터베이스에도 바로 반영됩니다. 데이터베이스 페이지에서 표, 보드, 캘린더 보기를 바꿔 보세요.

<!-- inkling:pageEmbed {"pageId":"@${board}","viewId":""} -->

## 4. 다이어그램

코드 블록의 언어를 mermaid로 두면 아래에 그림이 그려집니다.

\`\`\`mermaid
flowchart LR
  A[메모] --> B[링크]
  B --> C[데이터베이스]
  C --> D[AI 에이전트]
\`\`\`

## 5. AI 에이전트

설정 › 연결에서 MCP 주소를 복사해 Claude, Cursor, VS Code 같은 MCP 클라이언트에 넣으면 에이전트가 이 노트를 찾아 읽고 고칠 수 있습니다. 에이전트가 고친 내용은 기록에 남아 되돌릴 수 있고, 제안으로만 고치게 할 수도 있습니다.

## 단축키 몇 개

| 하는 일 | Mac | Windows·Linux |
| --- | --- | --- |
| 검색 | ⌘K | Ctrl+K |
| 명령 팔레트 | ⌘P | Ctrl+P |
| 새 페이지 | ⌘⌥N | Ctrl+Alt+N |
| 단축키 전체 보기 | ? | ? |
`
    : `> [!note] This page is a sample for trying Inkling out. Change anything, and delete it when you are done. A deleted sample does not come back.

## 1. Blocks

Press \`/\` on an empty line to open the block menu: headings, to-dos, tables, callouts, code, math and database views.

- [ ] Press \`/\` on the empty line below and pick "Check List"
- [ ] Tick this line
- [x] Finished items look like this

## 2. Links

Type \`[[\` and pick a page to link it, like [[${linkPage}]]. The linked page lists this one under its backlinks.

> [!tip] Type a name that does not exist yet after \`[[\` to create a page with that name.

## 3. Databases

Below is a view of the [[${board}]] database inside this document. A value you change here changes in the database too. On the database page, switch between the table, board and calendar views.

<!-- inkling:pageEmbed {"pageId":"@${board}","viewId":""} -->

## 4. Diagrams

Set a code block's language to mermaid and the diagram is drawn below it.

\`\`\`mermaid
flowchart LR
  A[Notes] --> B[Links]
  B --> C[Databases]
  C --> D[AI agents]
\`\`\`

## 5. AI agents

Copy the MCP address from Settings › Connections into an MCP client such as Claude, Cursor or VS Code, and the agent can find, read and edit these notes. Its edits are recorded and can be undone, and you can let it only suggest edits.

## A few shortcuts

| What | Mac | Windows · Linux |
| --- | --- | --- |
| Search | ⌘K | Ctrl+K |
| Command palette | ⌘P | Ctrl+P |
| New page | ⌘⌥N | Ctrl+Alt+N |
| All shortcuts | ? | ? |
`

  return {
    kind: 'doc',
    title: sampleTitle(locale),
    icon: '👋',
    md: root,
    children: [
      {
        kind: 'doc',
        title: linkPage,
        icon: '🔗',
        md: ko
          ? `이 페이지는 [[${sampleTitle(locale)}]]에서 링크했습니다. 아래쪽 백링크에서 그 페이지가 보입니다.\n\n여기서도 \`[[\`를 입력해 다른 페이지를 링크해 보세요.\n`
          : `[[${sampleTitle(locale)}]] links here; you will see it under the backlinks below.\n\nType \`[[\` here too and link another page.\n`,
      },
      {
        kind: 'collection',
        title: board,
        icon: '✅',
        fields: [status, { id: 'due', name: ko ? '날짜' : 'Date', type: 'date' }],
        views: [
          { name: ko ? '표' : 'Table', type: 'table', config: {} },
          { name: ko ? '보드' : 'Board', type: 'board', config: { groupByFieldId: 'status' } },
          { name: ko ? '캘린더' : 'Calendar', type: 'calendar', config: { dateFieldId: 'due' } },
        ],
        children: [
          row(ko ? '슬래시 메뉴 열어 보기' : 'Open the slash menu', 'done', ''),
          row(ko ? '페이지 두 개 링크하기' : 'Link two pages', 'doing', ''),
          row(ko ? 'AI 에이전트 연결하기' : 'Connect an AI agent', 'todo', ''),
        ],
      },
    ],
  }
}
