import { randomUUID } from 'node:crypto'
import type { BuiltinTemplateKey, CollectionField, TemplateCategory, TemplateInputDTO } from '@inkling/shared'
import { blocksToStateBuffer, markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import type { Locale } from '../i18n'
import type { NodeKind, TNode, TemplateView } from './structure'
import { collectInputs } from './variables'

/**
 * Built-in templates (docs/adr/0920-*, 0921-*), defined as code constants (no DB seed), so they
 * improve with every deploy. Each one has English and Korean text with the same structure and
 * variables; the creator's locale picks one (docs/adr/0903-*).
 *
 * A built-in is a spec tree: documents are markdown (`[[Title]]` links to another page of the same
 * template), collections declare fields, views and starter rows. The spec is compiled once per key
 * and language into the same tree model custom templates use (structure.ts), then instantiated by
 * the same code path.
 *
 * Markdown is limited to blocks the server editor knows (headings, paragraphs, lists, check lists,
 * tables, quotes, code): anything else would not survive markdown → blocks.
 */

interface SpecNode {
  kind: NodeKind
  title: string
  icon?: string
  md?: string
  props?: Record<string, unknown>
  fields?: CollectionField[]
  views?: Omit<TemplateView, 'sortOrder'>[]
  children?: SpecNode[]
}

interface Text {
  name: string
  description: string
  root: SpecNode
}

interface BuiltinDef {
  key: BuiltinTemplateKey
  icon: string
  category: TemplateCategory
  /** The created root page gets a date property (shows on the calendar). */
  withDate?: boolean
  text: Record<Locale, Text>
}

export interface BuiltinTemplate {
  key: BuiltinTemplateKey
  locale: Locale
  name: string
  icon: string
  description: string
  category: TemplateCategory
  defaultProps: { withDate?: boolean }
  kind: 'doc' | 'structure'
  pageCount: number
  inputs: TemplateInputDTO[]
  spec: SpecNode
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const doc = (title: string, md: string, extra: Partial<SpecNode> = {}): SpecNode => ({ kind: 'doc', title, md, ...extra })

type Color = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink'
const select = (id: string, name: string, options: [string, string, Color][]): CollectionField => ({
  id,
  name,
  type: 'select',
  options: options.map(([oid, oname, color]) => ({ id: oid, name: oname, color })),
})

// ---------------------------------------------------------------------------
// document templates
// ---------------------------------------------------------------------------

const MEETING_EN = `**When:** {{date:MMMM D, YYYY}} ({{weekday}}), {{time}} · **Notes by:** {{author}}

## Goal

- What should this meeting decide or produce?

## Attendees

- {{author}}

## Agenda

1. {{cursor}}

## Notes

- Key points, in the order they came up

## Decisions

- What was agreed, and who agreed it

## Action items

- [ ] Task — owner — due date

## Open questions

- What still needs an answer, and who will find it
`

const MEETING_KO = `**일시:** {{date:YYYY년 M월 D일}} {{weekday}} {{time}} · **기록:** {{author}}

## 회의 목적

- 이 회의에서 무엇을 정하거나 만들어야 하나요?

## 참석자

- {{author}}

## 안건

1. {{cursor}}

## 논의 내용

- 나온 순서대로 핵심만 적어 주세요

## 결정 사항

- 무엇을 누가 합의했는지

## 할 일

- [ ] 할 일 — 담당자 — 기한

## 남은 질문

- 아직 답이 없는 것과 알아볼 사람
`

const BRAINSTORM_EN = `## The question

- Phrase the problem as "How might we …?"

## Constraints

- Time, budget, and anything that's off the table

## Ground rules

- No judging during the idea round
- Go for quantity — wild ideas are welcome
- Build on each other's ideas ("yes, and …")

## Ideas

- {{cursor}}

## Themes

| Theme | Ideas | Votes |
| --- | --- | --- |
|  |  |  |
|  |  |  |

## Shortlist

1. The idea worth trying first

## Next steps

- [ ] Experiment — owner — by when
`

const BRAINSTORM_KO = `## 질문

- 풀고 싶은 문제를 "어떻게 하면 …할 수 있을까?"로 적어 보세요

## 제약 조건

- 시간, 예산, 이번에는 다루지 않을 것

## 진행 규칙

- 아이디어를 내는 동안에는 평가하지 않기
- 질보다 양, 엉뚱한 아이디어도 환영
- 다른 사람의 아이디어에 덧붙이기

## 아이디어

- {{cursor}}

## 묶어 보기

| 주제 | 아이디어 | 투표 |
| --- | --- | --- |
|  |  |  |
|  |  |  |

## 추린 아이디어

1. 가장 먼저 해 볼 만한 것

## 다음 단계

- [ ] 해 볼 일 — 담당자 — 기한
`

const KICKOFF_EN = `**Kickoff:** {{date:MMMM D, YYYY}} · **Lead:** {{author}}

## Why this project

- The problem we're solving, and why now

## Goals

- {{cursor}}

## Scope

- **In:** what we will deliver
- **Out:** what we deliberately won't do

## Milestones

| Milestone | Target date | Owner |
| --- | --- | --- |
| Plan agreed |  |  |
| First version |  |  |
| Launch |  |  |

## Team

| Role | Person |
| --- | --- |
| Lead | {{author}} |
|  |  |

## Risks

| Risk | How likely | What we'll do |
| --- | --- | --- |
|  |  |  |

## How we work

- Where we talk, how often we meet, how decisions get made

## Next steps

- [ ] First thing to do this week
`

const KICKOFF_KO = `**킥오프:** {{date:YYYY년 M월 D일}} · **리드:** {{author}}

## 왜 하나요

- 풀려는 문제와 지금 해야 하는 이유

## 목표

- {{cursor}}

## 범위

- **한다:** 이번에 만들 것
- **안 한다:** 일부러 빼는 것

## 마일스톤

| 마일스톤 | 목표일 | 담당 |
| --- | --- | --- |
| 계획 확정 |  |  |
| 첫 버전 |  |  |
| 출시 |  |  |

## 팀

| 역할 | 담당자 |
| --- | --- |
| 리드 | {{author}} |
|  |  |

## 리스크

| 리스크 | 가능성 | 대응 |
| --- | --- | --- |
|  |  |  |

## 일하는 방식

- 소통 채널, 회의 주기, 결정하는 방법

## 다음 할 일

- [ ] 이번 주에 먼저 할 일
`

const STANDUP_EN = `## {{date:dddd, MMMM D}}

### {{author}}

- **Yesterday:** {{cursor}}
- **Today:**
- **Blockers:** none

### Teammate

- **Yesterday:**
- **Today:**
- **Blockers:**

## To discuss after standup

- [ ] Topic — who needs to be there
`

const STANDUP_KO = `## {{date:M월 D일}} {{weekday}}

### {{author}}

- **어제 한 일:** {{cursor}}
- **오늘 할 일:**
- **막힌 점:** 없음

### 팀원

- **어제 한 일:**
- **오늘 할 일:**
- **막힌 점:**

## 끝나고 따로 이야기할 것

- [ ] 주제 — 필요한 사람
`

const RETRO_EN = `**Period:** {{input:Which period are you looking back on?|This sprint}} · **Facilitator:** {{author}}

## Keep

- {{cursor}}

## Problem

- What slowed us down or went wrong

## Try

- One or two things to change next time

## Action items

- [ ] Action — owner — due date
`

const RETRO_KO = `**기간:** {{input:돌아볼 기간|이번 스프린트}} · **진행:** {{author}}

## Keep — 계속할 것

- {{cursor}}

## Problem — 문제였던 것

- 발목을 잡은 것, 잘 안 된 것

## Try — 바꿔 볼 것

- 다음에 바꿔 볼 한두 가지

## 할 일

- [ ] 할 일 — 담당자 — 기한
`

// ---------------------------------------------------------------------------
// structure templates
// ---------------------------------------------------------------------------

function projectSpec(locale: Locale): SpecNode {
  const ko = locale === 'ko'
  const status = select('status', ko ? '상태' : 'Status', [
    ['todo', ko ? '시작 전' : 'Not started', 'gray'],
    ['doing', ko ? '진행 중' : 'In progress', 'blue'],
    ['blocked', ko ? '막힘' : 'Blocked', 'red'],
    ['done', ko ? '완료' : 'Done', 'green'],
  ])
  const priority = select('priority', ko ? '우선순위' : 'Priority', [
    ['high', ko ? '높음' : 'High', 'red'],
    ['medium', ko ? '보통' : 'Medium', 'yellow'],
    ['low', ko ? '낮음' : 'Low', 'gray'],
  ])
  const tasks = ko ? '할 일' : 'Tasks'
  const notes = ko ? '회의록' : 'Meeting notes'
  const row = (title: string, s: string, p: string, due?: string): SpecNode => ({
    kind: 'doc',
    title,
    md: '',
    props: { status: s, priority: p, ...(due ? { due } : {}) },
  })
  return {
    kind: 'doc',
    title: ko ? '프로젝트' : 'Project',
    icon: '🚀',
    md: ko
      ? `**리드:** {{author}} · **시작:** {{date}} · **목표일:** {{input:목표일|미정}}

## 목표

{{input:이 프로젝트로 무엇을 이루려고 하나요?|한 문장으로 결과를 적어 주세요.}}

## 성공의 기준

- {{cursor}}

## 범위

- **한다:** 이번에 만들 것
- **안 한다:** 일부러 빼는 것

## 마일스톤

| 마일스톤 | 목표일 | 상태 |
| --- | --- | --- |
| 계획 확정 |  | 시작 전 |
| 첫 버전 |  | 시작 전 |
| 출시 |  | 시작 전 |

## 어디에 무엇이 있나

- [[${tasks}]] — 모든 할 일을 상태별 보드로
- [[${notes}]] — 회의마다 한 페이지

## 결정 기록

| 날짜 | 결정 | 이유 |
| --- | --- | --- |
| {{date}} | 프로젝트 시작 |  |
`
      : `**Lead:** {{author}} · **Started:** {{date}} · **Target date:** {{input:Target date|TBD}}

## Goal

{{input:What is this project for?|Describe the outcome in one sentence.}}

## What success looks like

- {{cursor}}

## Scope

- **In:** what we will deliver
- **Out:** what we deliberately won't do

## Milestones

| Milestone | Target date | Status |
| --- | --- | --- |
| Plan agreed |  | Not started |
| First version |  | Not started |
| Launch |  | Not started |

## Where things live

- [[${tasks}]] — every task, on a board by status
- [[${notes}]] — one page per meeting

## Decision log

| Date | Decision | Why |
| --- | --- | --- |
| {{date}} | Project started |  |
`,
    children: [
      {
        kind: 'collection',
        title: tasks,
        icon: '✅',
        fields: [
          status,
          { id: 'owner', name: ko ? '담당자' : 'Owner', type: 'person' },
          { id: 'due', name: ko ? '마감일' : 'Due', type: 'date' },
          priority,
        ],
        views: [
          { name: ko ? '보드' : 'Board', type: 'board', config: { groupByFieldId: 'status' } },
          { name: ko ? '전체' : 'All tasks', type: 'table', config: { sorts: [{ fieldId: 'due', dir: 'asc' }] } },
          { name: ko ? '일정' : 'Calendar', type: 'calendar', config: { dateFieldId: 'due' } },
        ],
        children: [
          row(ko ? '프로젝트 개요 정리하기' : 'Write the project brief', 'doing', 'high'),
          row(ko ? '킥오프 회의 열기' : 'Hold the kickoff meeting', 'todo', 'high', '{{date}}'),
          row(ko ? '첫 마일스톤 계획 세우기' : 'Plan the first milestone', 'todo', 'medium'),
        ],
      },
      {
        kind: 'folder',
        title: notes,
        icon: '🗂️',
        children: [
          doc(
            ko ? '{{date}} 킥오프' : 'Kickoff — {{date}}',
            ko
              ? `**참석자:** {{author}}

## 안건

1. 목표와 성공의 기준 맞추기
2. 범위: 하는 것과 안 하는 것
3. 역할 나누기
4. 일정과 마일스톤
5. 리스크와 질문

## 논의 내용

-

## 결정 사항

-

## 할 일

- [ ] 할 일 — 담당자 — 기한
`
              : `**Attendees:** {{author}}

## Agenda

1. Agree on the goal and what success looks like
2. Scope: what's in, what's out
3. Who does what
4. Timeline and milestones
5. Risks and open questions

## Notes

-

## Decisions

-

## Action items

- [ ] Task — owner — due date
`,
          ),
        ],
      },
    ],
  }
}

function meetingSeriesSpec(locale: Locale): SpecNode {
  const ko = locale === 'ko'
  const meetings = ko ? '회의 기록' : 'Meetings'
  return {
    kind: 'doc',
    title: ko ? '정기 회의' : 'Meeting series',
    icon: '📆',
    md: ko
      ? `**주기:** {{input:언제 모이나요?|매주 월요일 10시}} · **주관:** {{author}}

## 이 회의는

- {{cursor}}

## 참석자

- {{author}}

## 고정 안건

1. 근황 나누기 (5분)
2. 지난 회의 이후 진행 상황
3. 오늘 이야기할 주제
4. 결정 사항과 할 일 정리

## 회의 기록

회의마다 [[${meetings}]]에 한 페이지씩 쌓입니다. 표에서 새 행을 추가하거나 일정 보기에서 날짜를 눌러 만드세요.

## 결정 모음

| 날짜 | 결정 |
| --- | --- |
|  |  |
`
      : `**When:** {{input:When does this meeting happen?|Every Monday, 10:00}} · **Organizer:** {{author}}

## What this meeting is for

- {{cursor}}

## Members

- {{author}}

## Standing agenda

1. Check-in (5 min)
2. Progress since last time
3. Topics for today
4. Decisions and action items

## Meeting notes

Every meeting gets a page in [[${meetings}]]. Add a row in the table, or click a day in the calendar view.

## Decisions so far

| Date | Decision |
| --- | --- |
|  |  |
`,
    children: [
      {
        kind: 'collection',
        title: meetings,
        icon: '🗓️',
        fields: [
          { id: 'date', name: ko ? '날짜' : 'Date', type: 'date' },
          select('status', ko ? '상태' : 'Status', [
            ['upcoming', ko ? '예정' : 'Upcoming', 'blue'],
            ['done', ko ? '완료' : 'Done', 'green'],
            ['cancelled', ko ? '취소' : 'Cancelled', 'gray'],
          ]),
          { id: 'facilitator', name: ko ? '진행' : 'Facilitator', type: 'person' },
        ],
        views: [
          { name: ko ? '목록' : 'All meetings', type: 'table', config: { sorts: [{ fieldId: 'date', dir: 'desc' }] } },
          { name: ko ? '일정' : 'Calendar', type: 'calendar', config: { dateFieldId: 'date' } },
        ],
        children: [
          {
            kind: 'doc',
            title: ko ? '{{date:M월 D일}} 회의' : 'Meeting — {{date:MMM D}}',
            props: { date: '{{date}}', status: 'upcoming' },
            md: ko
              ? `## 안건

1. 근황 나누기
2. 진행 상황
3. 오늘의 주제

## 논의 내용

-

## 결정 사항

-

## 할 일

- [ ] 할 일 — 담당자 — 기한
`
              : `## Agenda

1. Check-in
2. Progress
3. Today's topics

## Notes

-

## Decisions

-

## Action items

- [ ] Task — owner — due date
`,
          },
        ],
      },
    ],
  }
}

function readingListSpec(locale: Locale): SpecNode {
  const ko = locale === 'ko'
  const stars: [string, string, Color][] = [
    ['r1', '★', 'gray'],
    ['r2', '★★', 'gray'],
    ['r3', '★★★', 'yellow'],
    ['r4', '★★★★', 'orange'],
    ['r5', '★★★★★', 'red'],
  ]
  return {
    kind: 'collection',
    title: ko ? '읽을거리' : 'Reading list',
    icon: '📚',
    fields: [
      { id: 'author', name: ko ? '저자' : 'Author', type: 'text' },
      select('type', ko ? '종류' : 'Type', [
        ['book', ko ? '책' : 'Book', 'blue'],
        ['article', ko ? '글' : 'Article', 'green'],
        ['paper', ko ? '논문' : 'Paper', 'purple'],
        ['video', ko ? '영상' : 'Video', 'red'],
        ['podcast', ko ? '팟캐스트' : 'Podcast', 'orange'],
      ]),
      select('status', ko ? '상태' : 'Status', [
        ['want', ko ? '읽고 싶음' : 'Want to read', 'gray'],
        ['reading', ko ? '읽는 중' : 'Reading', 'blue'],
        ['finished', ko ? '다 읽음' : 'Finished', 'green'],
        ['dropped', ko ? '그만 읽음' : 'Dropped', 'red'],
      ]),
      select('rating', ko ? '평점' : 'Rating', stars),
      { id: 'finished', name: ko ? '다 읽은 날' : 'Finished on', type: 'date' },
      { id: 'link', name: ko ? '링크' : 'Link', type: 'url' },
    ],
    views: [
      {
        name: ko ? '책장' : 'Shelf',
        type: 'gallery',
        config: { cardCover: 'cover', cardFieldIds: ['author', 'status', 'rating'], cardSize: 'md' },
      },
      { name: ko ? '상태별' : 'By status', type: 'board', config: { groupByFieldId: 'status' } },
      { name: ko ? '표' : 'Table', type: 'table', config: {} },
    ],
    children: [
      {
        kind: 'doc',
        title: ko ? '{{input:지금 읽고 있는 것|첫 번째 책}}' : '{{input:What are you reading right now?|My first book}}',
        props: { status: 'reading', type: 'book' },
        md: ko
          ? `## 왜 읽나요

-

## 핵심 내용

-

## 기억하고 싶은 문장

>

## 내 생각

- 이 내용으로 무엇을 해 볼지
`
          : `## Why I'm reading this

-

## Key ideas

-

## Quotes worth keeping

>

## My take

- What I'll do with this
`,
      },
    ],
  }
}

function weeklyReviewSpec(locale: Locale): SpecNode {
  const ko = locale === 'ko'
  const habits = ko ? '습관 기록' : 'Habits'
  const days = ko
    ? ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일']
    : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  return {
    kind: 'doc',
    title: ko ? '{{date:GGGG}}년 {{date:W}}주차 회고' : 'Weekly review — {{date:GGGG-[W]WW}}',
    icon: '🗓️',
    md: ko
      ? `**{{date:M월 D일}} {{weekday}}에 작성** · {{author}}

## 잘된 일

- {{cursor}}

## 아쉬웠던 일

-

## 새로 알게 된 것

-

## 아직 머릿속에 남은 일

- [ ] 적어 두면 마음이 가벼워지는 것들

## 다음 주에 꼭 할 세 가지

1.
2.
3.

## 습관

[[${habits}]]에 날마다 체크하고, 한 주의 흐름을 여기 적어 보세요.
`
      : `**Written on {{weekday}}, {{date:MMMM D}}** · {{author}}

## Wins

- {{cursor}}

## What didn't go well

-

## What I learned

-

## Open loops

- [ ] Anything still on your mind — write it down so it stops nagging

## Top 3 for next week

1.
2.
3.

## Habits

Tick each day in [[${habits}]], then note the pattern here.
`,
    children: [
      {
        kind: 'collection',
        title: habits,
        icon: '✔️',
        fields: [
          { id: 'exercise', name: ko ? '운동' : 'Exercise', type: 'checkbox' },
          { id: 'reading', name: ko ? '독서' : 'Reading', type: 'checkbox' },
          { id: 'sleep', name: ko ? '수면 (시간)' : 'Sleep (h)', type: 'number' },
          select('mood', ko ? '기분' : 'Mood', [
            ['good', '🙂', 'green'],
            ['ok', '😐', 'yellow'],
            ['low', '🙁', 'gray'],
          ]),
          { id: 'note', name: ko ? '한 줄' : 'Note', type: 'text' },
        ],
        views: [{ name: ko ? '이번 주' : 'This week', type: 'table', config: {} }],
        children: days.map((d) => ({ kind: 'doc' as const, title: d, md: '' })),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/**
 * Placeholders a spec may use where an id is not known before compile (docs/adr/2147-*): a relation
 * field of a collection pointing at that same collection, and a row value naming another starter row
 * of the same collection by its title. compile() turns both into node ids, which instantiation remaps.
 */
const SELF_COLLECTION = '@self'
const rowRef = (title: string) => `@row:${title}`

function agentBoardSpec(locale: Locale): SpecNode {
  const ko = locale === 'ko'
  const t = {
    parent: ko ? '예시: 기능 X 출시' : 'Example: ship feature X',
    sub1: ko ? '예시: X의 API 작성' : 'Example: write the X API',
    sub2: ko ? '예시: X 문서화' : 'Example: document X',
  }
  const body = (lines: string[]) => lines.join('\n')
  return {
    kind: 'collection',
    title: ko ? '에이전트 작업 보드' : 'Agent task board',
    icon: '🤖',
    fields: [
      select('status', ko ? '상태' : 'Status', [
        ['todo', ko ? '할 일' : 'To do', 'gray'],
        ['doing', ko ? '진행 중' : 'In progress', 'blue'],
        ['blocked', ko ? '막힘' : 'Blocked', 'red'],
        ['done', ko ? '완료' : 'Done', 'green'],
      ]),
      // a person, or a person's agent connection next to them (docs/adr/1861-*)
      { id: 'assignee', name: ko ? '담당' : 'Assignee', type: 'person' },
      { id: 'parent', name: ko ? '상위 작업' : 'Parent task', type: 'relation', relation: { targetPageId: SELF_COLLECTION, subItems: true } },
      { id: 'evidence', name: ko ? '완료 근거' : 'Evidence', type: 'text' },
      { id: 'taskId', name: 'ID', type: 'uniqueId', uniqueId: { prefix: 'TASK' } },
    ],
    views: [
      { name: ko ? '상태별' : 'By status', type: 'board', config: { groupByFieldId: 'status' } },
      { name: ko ? '작업 트리' : 'Task tree', type: 'table', config: { columnOrder: ['taskId', 'status', 'assignee', 'parent', 'evidence'], subItems: 'nested' } },
      { name: ko ? '목록' : 'List', type: 'list', config: { columnOrder: ['taskId', 'status', 'assignee'], hiddenFields: ['parent', 'evidence'] } },
    ],
    children: [
      {
        kind: 'doc',
        title: t.parent,
        props: { status: 'doing' },
        md: ko
          ? body([
              '## 목표',
              '',
              '- 이 작업이 끝나면 무엇이 달라지는지 한 줄로',
              '',
              '## 쪼개기',
              '',
              '- 큰 작업을 맡은 에이전트가 하위 작업을 만들고(create_row parent=이 작업의 ID) 담당을 비워 둡니다',
              '- 다른 에이전트가 담당이 빈 하위 작업을 가져갑니다(update_row 담당 = this connection, 상태 = 진행 중)',
              '- 끝낸 에이전트는 완료 근거(PR, 커밋, 문서 링크)를 적고 상태를 완료로 바꿉니다',
            ])
          : body([
              '## Goal',
              '',
              '- One line on what is different when this is done',
              '',
              '## Splitting',
              '',
              '- The agent that owns a large task adds sub-tasks (create_row parent=this task\'s ID) and leaves Assignee empty',
              '- Another agent takes an unassigned sub-task (update_row Assignee = this connection, Status = In progress)',
              '- When done, it fills Evidence (PR, commit, doc link) and sets Status to Done',
            ]),
      },
      { kind: 'doc', title: t.sub1, props: { status: 'todo', parent: [rowRef(t.parent)] }, md: '' },
      { kind: 'doc', title: t.sub2, props: { status: 'todo', parent: [rowRef(t.parent)] }, md: '' },
    ],
  }
}

const BUILTINS: BuiltinDef[] = [
  {
    key: 'meeting',
    icon: '📋',
    category: 'meetings',
    withDate: true,
    text: {
      en: {
        name: 'Meeting notes',
        description: 'Goal, agenda, decisions and action items for one meeting',
        root: doc('Meeting notes', MEETING_EN),
      },
      ko: {
        name: '회의록',
        description: '회의 한 번의 목적, 안건, 결정 사항, 할 일',
        root: doc('회의록', MEETING_KO),
      },
    },
  },
  {
    key: 'standup',
    icon: '☀️',
    category: 'meetings',
    withDate: true,
    text: {
      en: {
        name: 'Daily standup',
        description: "Yesterday, today and blockers for each person",
        root: doc('Daily standup', STANDUP_EN),
      },
      ko: {
        name: '데일리 스탠드업',
        description: '사람마다 어제 한 일, 오늘 할 일, 막힌 점',
        root: doc('데일리 스탠드업', STANDUP_KO),
      },
    },
  },
  {
    key: 'meetingSeries',
    icon: '📆',
    category: 'meetings',
    text: {
      en: {
        name: 'Meeting series',
        description: 'A recurring meeting: purpose and standing agenda, plus a calendar of meeting notes',
        root: meetingSeriesSpec('en'),
      },
      ko: {
        name: '정기 회의',
        description: '반복되는 회의의 목적과 고정 안건, 회의 기록을 모은 일정표',
        root: meetingSeriesSpec('ko'),
      },
    },
  },
  {
    key: 'project',
    icon: '🚀',
    category: 'projects',
    text: {
      en: {
        name: 'Project',
        description: 'Overview page, a Tasks board (status, owner, due) and a Meeting notes folder',
        root: projectSpec('en'),
      },
      ko: {
        name: '프로젝트',
        description: '개요 페이지, 할 일 보드(상태·담당자·마감일), 회의록 폴더',
        root: projectSpec('ko'),
      },
    },
  },
  {
    key: 'kickoff',
    icon: '🏁',
    category: 'projects',
    text: {
      en: {
        name: 'Project kickoff',
        description: 'Why, goals, scope, milestones, team and risks on one page',
        root: doc('Project kickoff', KICKOFF_EN),
      },
      ko: {
        name: '프로젝트 킥오프',
        description: '이유, 목표, 범위, 마일스톤, 팀, 리스크를 한 페이지에',
        root: doc('프로젝트 킥오프', KICKOFF_KO),
      },
    },
  },
  {
    key: 'brainstorm',
    icon: '💡',
    category: 'docs',
    text: {
      en: {
        name: 'Brainstorm',
        description: 'Frame the question, collect ideas freely, then group and pick',
        root: doc('Brainstorm', BRAINSTORM_EN),
      },
      ko: {
        name: '브레인스토밍',
        description: '질문을 정하고, 아이디어를 마음껏 모은 뒤 묶고 고르기',
        root: doc('브레인스토밍', BRAINSTORM_KO),
      },
    },
  },
  {
    key: 'retro',
    icon: '🔄',
    category: 'docs',
    text: {
      en: {
        name: 'Retrospective (KPT)',
        description: 'Keep, Problem, Try — and the actions that come out of it',
        root: doc('Retrospective', RETRO_EN),
      },
      ko: {
        name: '회고 (KPT)',
        description: 'Keep, Problem, Try로 돌아보고 할 일까지 정리',
        root: doc('회고', RETRO_KO),
      },
    },
  },
  {
    key: 'readingList',
    icon: '📚',
    category: 'personal',
    text: {
      en: {
        name: 'Reading list',
        description: 'Books and articles on a shelf view, with a notes page for each',
        root: readingListSpec('en'),
      },
      ko: {
        name: '읽을거리',
        description: '책과 글을 책장 보기로 모으고, 하나마다 독서 노트를 남기기',
        root: readingListSpec('ko'),
      },
    },
  },
  {
    key: 'weeklyReview',
    icon: '🧭',
    category: 'personal',
    text: {
      en: {
        name: 'Weekly review',
        description: 'Wins, lessons and next week’s top three, with a daily habit table',
        root: weeklyReviewSpec('en'),
      },
      ko: {
        name: '주간 회고',
        description: '잘된 일, 배운 점, 다음 주 할 세 가지와 요일별 습관 기록',
        root: weeklyReviewSpec('ko'),
      },
    },
  },
  {
    key: 'agentBoard',
    icon: '🤖',
    category: 'projects',
    text: {
      en: {
        name: 'Agent task board',
        description: 'Tasks with sub-tasks, IDs and evidence, for agents that split work and pick it up',
        root: agentBoardSpec('en'),
      },
      ko: {
        name: '에이전트 작업 보드',
        description: '하위 작업, ID, 완료 근거가 있는 작업표. 에이전트가 일을 쪼개 올리고 나눠 가져가는 용도',
        root: agentBoardSpec('ko'),
      },
    },
  },
]

function specTexts(n: SpecNode, out: string[] = []): string[] {
  out.push(n.title, n.md ?? '')
  for (const v of Object.values(n.props ?? {})) if (typeof v === 'string') out.push(v)
  for (const c of n.children ?? []) specTexts(c, out)
  return out
}

function specCount(n: SpecNode): number {
  return 1 + (n.children ?? []).reduce((s, c) => s + specCount(c), 0)
}

/** All built-in templates in `locale`, in gallery order. */
export function builtinTemplates(locale: Locale): BuiltinTemplate[] {
  return BUILTINS.map((b) => {
    const t = b.text[locale]
    const pageCount = specCount(t.root)
    return {
      key: b.key,
      locale,
      icon: b.icon,
      name: t.name,
      description: t.description,
      category: b.category,
      defaultProps: b.withDate ? { withDate: true } : {},
      kind: pageCount === 1 && t.root.kind === 'doc' ? 'doc' : 'structure',
      pageCount,
      inputs: collectInputs(specTexts(t.root)),
      spec: t.root,
    }
  })
}

/** One built-in template in `locale` (undefined for an unknown key). */
export function getBuiltinTemplate(key: string, locale: Locale): BuiltinTemplate | undefined {
  return builtinTemplates(locale).find((t) => t.key === key)
}

/** Whether `key` names a built-in template (in any language). */
export function isBuiltinKey(key: string): boolean {
  return BUILTINS.some((b) => b.key === key)
}

// ---------------------------------------------------------------------------
// compile spec → tree (cached per key and language)
// ---------------------------------------------------------------------------

/**
 * Markdown has no empty list item: "- " or "1. " alone parses as a paragraph. Built-ins use empty
 * items as places to type, so they get an invisible placeholder for parsing that is removed again.
 */
const EMPTY = '\u2063'
function withEmptyItems(md: string): string {
  return md.replace(/^(\s*)(- \[ \]|-|\d+\.|>)[ \t]*$/gm, `$1$2 ${EMPTY}`)
}
function stripPlaceholder(blocks: AnyBlock[]): AnyBlock[] {
  for (const b of blocks) {
    if (Array.isArray(b.content)) {
      b.content = (b.content as { type?: string; text?: string }[])
        .map((c) => (c.type === 'text' && typeof c.text === 'string' ? { ...c, text: c.text.replaceAll(EMPTY, '') } : c))
        .filter((c) => !(c.type === 'text' && c.text === '')) as AnyBlock['content']
    }
    if (Array.isArray(b.children)) stripPlaceholder(b.children)
  }
  return blocks
}

/** Placeholder workspace in compiled links; instantiation rewrites the whole href. */
const LINK_WS = '00000000-0000-0000-0000-000000000000'

async function compile(spec: SpecNode): Promise<TNode> {
  const ids = new Map<SpecNode, string>()
  const byTitle = new Map<string, string>()
  const assign = (n: SpecNode): void => {
    const id = randomUUID()
    ids.set(n, id)
    const k = n.title.toLowerCase()
    if (!byTitle.has(k)) byTitle.set(k, id)
    for (const c of n.children ?? []) assign(c)
  }
  assign(spec)
  const resolve = (title: string): string | null => {
    const id = byTitle.get(title.toLowerCase())
    return id ? `/w/${LINK_WS}/p/${id}` : null
  }
  const build = async (n: SpecNode): Promise<TNode> => {
    const node: TNode = { id: ids.get(n)!, kind: n.kind, title: n.title, icon: n.icon ?? null, children: [] }
    if (n.props) node.props = structuredClone(n.props)
    if (n.kind === 'doc') {
      let blocks = stripPlaceholder(await markdownToBlocks(withEmptyItems(n.md ?? ''), resolve))
      if (blocks.length === 0) blocks = [{ type: 'paragraph', content: [] }]
      node.state = blocksToStateBuffer(blocks).toString('base64')
    }
    if (n.kind === 'collection') {
      node.fields = structuredClone(n.fields ?? []).map((f) =>
        f.relation?.targetPageId === SELF_COLLECTION ? { ...f, relation: { ...f.relation, targetPageId: node.id } } : f,
      )
      node.views = (n.views ?? []).map((v, i) => ({ ...structuredClone(v), sortOrder: i * 1000 }))
    }
    for (const c of n.children ?? []) node.children.push(await build(c))
    if (n.kind === 'collection') {
      // starter rows that name another starter row (sub-items): the title becomes that row's node id
      const rowIds = new Map((n.children ?? []).map((c) => [c.title, ids.get(c)!]))
      for (const child of node.children) {
        for (const [k, v] of Object.entries(child.props ?? {})) {
          if (Array.isArray(v)) child.props![k] = v.map((x) => (typeof x === 'string' && x.startsWith('@row:') ? (rowIds.get(x.slice(5)) ?? null) : x)).filter((x) => x !== null)
        }
      }
    }
    return node
  }
  return build(spec)
}

const treeCache = new Map<string, Promise<TNode>>()

/** Compiled tree of a built-in (deep copy, safe to mutate). */
export async function builtinTree(t: BuiltinTemplate): Promise<TNode> {
  const cacheKey = `${t.key}:${t.locale}`
  let p = treeCache.get(cacheKey)
  if (!p) {
    p = compile(t.spec)
    treeCache.set(cacheKey, p)
    p.catch(() => treeCache.delete(cacheKey))
  }
  return structuredClone(await p)
}
