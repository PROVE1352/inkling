/**
 * Retrieval evaluation set (docs/adr/0927-*): a fictional team wiki ("Lumen", a made-up product)
 * written for this test — no real data. Each question names the page title and the section anchor
 * that answers it. Pages deliberately share vocabulary (backup, deploy, 회의, 배포 …) so ranking,
 * not mere matching, decides the result. Used by context.db.test.ts and scripts/context-bench.ts.
 */

export interface EvalPage {
  title: string
  markdown: string
  /** Wiki-link aliases (pages.aliases); the harness sets them after create_page (docs/adr/1701-*). */
  aliases?: string[]
}

export interface EvalQuestion {
  q: string
  page: string
  anchor: string
  /** Other sections that also answer the question (graded as relevant in the rank metrics). */
  also?: { page: string; anchor: string }[]
  /**
   * dev: used while tuning weights; test: held out, looked at only for the final numbers
   * (docs/adr/1213-*).
   */
  split: 'dev' | 'test'
  /** Failure family the question reproduces (per-tag metrics in evalRun.ts, docs/adr/1702-*). */
  tag?: string
  /**
   * Asked as find_context(queries=[q, ...queries]) instead of one query: an agent that knows the
   * notes may be in another language passes the original and a translation (docs/adr/1904-*).
   */
  queries?: string[]
  /** Token budget of the call (default: the tool's default). The field cases were seen at small budgets. */
  budget?: number
  /**
   * Text that proves the answer is in the returned body (not only its header). Default: the start
   * of the expected section's first line (`answerEvidence`).
   */
  evidence?: string
}

export const EVAL_PAGES: EvalPage[] = [
  {
    title: 'Deploy runbook',
    markdown: `Steps for shipping the Lumen API to production.

## Prerequisites
You need push rights on the release branch and a green CI run. The deploy uses the \`lumen-deploy\` script on the build host.

## Rolling deploy
Run \`lumen-deploy --rolling\`. Instances are replaced two at a time behind the load balancer; each new instance must pass the /health/ready probe for 30 seconds before the next pair starts.

## Rollback
If error rates rise above 2% within ten minutes, run \`lumen-deploy --rollback <previous tag>\`. The previous image stays cached on every host for 7 days, so a rollback takes about 90 seconds. Announce it in the #ops channel.

## Database migrations
Migrations run before the new instances start. A migration must be backward compatible with the previous release because old and new instances run side by side during a rolling deploy.`,
  },
  {
    title: 'Backup policy',
    markdown: `How Lumen protects its data.

## What is backed up
The Postgres database (full dump) and the uploads volume. Redis is a cache and is not backed up.

## Schedule
A full backup runs every night at 02:30 UTC. WAL archiving gives point-in-time recovery between nightly backups.

## Retention
Nightly backups are kept for 14 days, weekly backups for 8 weeks and monthly backups for 12 months (grandfather-father-son). Off-site copies follow the same retention.

## Restore drill
Once a month the on-call engineer restores the latest backup into a scratch database and runs the smoke tests. The drill result goes into the ops log.`,
  },
  {
    title: 'Incident response',
    markdown: `What to do when production is broken.

## Severity levels
SEV1: the product is down for everyone. SEV2: a major feature is broken. SEV3: degraded performance or a minor bug.

## Paging
SEV1 and SEV2 page the primary on-call through the pager app. If nobody acknowledges within 5 minutes, the secondary is paged, then the engineering manager.

## Postmortem
Every SEV1 and SEV2 gets a blameless postmortem within three working days, with a timeline, root cause and follow-up tickets.`,
  },
  {
    title: 'Onboarding guide',
    markdown: `Welcome to the Lumen team.

## First day
Pick up your laptop from IT, join the #general and #team-lumen channels and read the architecture overview.

## Accounts
Request access to GitHub, the cloud console and the pager app through the access form. Production access needs approval from your manager.

## Local setup
Clone the monorepo, run \`make bootstrap\` and start the stack with \`docker compose up\`. The seed script creates a demo workspace with sample data.`,
  },
  {
    title: '온보딩 체크리스트',
    markdown: `새로 합류한 팀원을 위한 체크리스트입니다.

## 첫 주
노트북 수령, 사내 메신저 가입, 아키텍처 문서 읽기, 멘토와 1:1 일정 잡기.

## 권한 신청
깃허브, 클라우드 콘솔, 호출(페이저) 앱 권한은 접근 신청서로 요청합니다. 운영 환경 권한은 팀장 승인이 필요합니다.

## 개발 환경
모노레포를 받은 뒤 부트스트랩 스크립트를 실행하고 도커 컴포즈로 로컬 스택을 띄웁니다.`,
  },
  {
    title: '주간회의록 2026-10-05',
    markdown: `참석: 민지, 하준, 서연, 도윤

## 지난주 회고
배포 자동화가 끝나서 릴리스 시간이 40분에서 12분으로 줄었다. 검색 속도 개선 작업은 아직 진행 중.

## 결정 사항
다음 분기부터 금요일 오후 배포를 금지한다. 긴급 수정은 예외로 하되 온콜 담당자 승인을 받는다.

## 액션 아이템
하준: 검색 인덱스 튜닝 결과 공유. 서연: 백업 복구 훈련 일정 잡기.`,
  },
  {
    title: '주간회의록 2026-10-12',
    markdown: `참석: 민지, 하준, 서연

## 지난주 회고
검색 인덱스 튜닝으로 p95 지연이 180ms에서 60ms로 줄었다.

## 결정 사항
모바일 앱 출시일을 11월 20일로 확정했다. 베타 테스트는 사내 인원 30명으로 진행한다.

## 액션 아이템
도윤: 베타 테스터 모집 공지. 민지: 출시 체크리스트 작성.`,
  },
  {
    title: 'Search architecture',
    markdown: `How search works in Lumen.

## Indexing
Documents are tokenized on save and written to an inverted index. Korean text is split into character bigrams so compound words match partial queries.

## Ranking
Results are ordered by BM25 with a boost for title matches and a decay for old documents.

## Performance
After the October tuning, p95 latency is 60 ms for a 50k-document workspace. The index is rebuilt incrementally; a full rebuild takes about 4 minutes.`,
  },
  {
    title: 'API rate limits',
    markdown: `Limits applied by the public API.

## Default limits
Each API key may send 600 requests per minute. Bursts up to 100 requests per second are allowed for at most 5 seconds.

## Exceeding the limit
Requests over the limit get HTTP 429 with a Retry-After header. Clients should back off exponentially.

## Raising limits
Enterprise customers can ask support for higher limits; the change is applied per key and reviewed every quarter.`,
  },
  {
    title: 'Pricing plans',
    markdown: `Lumen plans as of 2026.

## Free
Up to 3 members and 1 GB of storage. Community support only.

## Team
$8 per member per month, 100 GB storage, version history for 90 days.

## Enterprise
Custom pricing, SSO, audit log, unlimited version history and a 99.9% uptime SLA.`,
  },
  {
    title: 'Security checklist',
    markdown: `Security baseline for every service.

## Secrets
Secrets live in the vault, never in the repository. Rotate database passwords every 90 days.

## Dependencies
Run the dependency audit in CI and patch critical vulnerabilities within 7 days.

## Access reviews
Every quarter managers review who has production access and remove unused accounts.`,
  },
  {
    title: '장애 대응 매뉴얼',
    markdown: `운영 장애가 났을 때의 절차입니다.

## 등급
1등급은 전체 서비스 중단, 2등급은 주요 기능 장애, 3등급은 성능 저하입니다.

## 호출 절차
1·2등급은 페이저 앱으로 1차 온콜을 호출합니다. 5분 안에 응답이 없으면 2차 온콜, 그다음 팀장을 호출합니다.

## 사후 분석
1·2등급 장애는 3영업일 안에 비난 없는 사후 분석 문서를 작성합니다.`,
  },
  {
    title: 'Mobile app release plan',
    markdown: `Plan for the first Lumen mobile release.

## Scope
Read and edit notes offline, push notifications for mentions, and quick capture from the share sheet.

## Timeline
Internal beta starts on November 3 with 30 testers; the public launch is November 20.

## Store review
Submit to both app stores at least 7 days before launch; keep screenshots in the design drive.`,
  },
  {
    title: 'Code review guidelines',
    markdown: `How we review pull requests.

## Size
Keep pull requests under 400 changed lines; split larger changes.

## Approvals
One approval is enough for most changes; changes to authentication or billing need two approvals, one from the security group.

## Turnaround
Reviewers answer within one working day.`,
  },
  {
    title: 'Logging and monitoring',
    markdown: `Observability setup.

## Logs
Services log JSON to stdout; logs are kept for 30 days in the log store.

## Metrics
Each service exports request rate, error rate and latency histograms. Dashboards live in the metrics app.

## Alerts
Alerts fire when the error rate is above 2% for 5 minutes or p95 latency doubles; they page the on-call engineer.`,
  },
  {
    title: '데이터베이스 운영',
    markdown: `Postgres 운영 메모.

## 연결 풀
애플리케이션당 최대 연결 수는 20개입니다. 연결이 부족하면 풀 크기보다 느린 쿼리를 먼저 찾습니다.

## 인덱스 관리
새 인덱스는 운영 중에 CONCURRENTLY 옵션으로 만듭니다. 사용하지 않는 인덱스는 분기마다 정리합니다.

## 백업 확인
야간 백업이 끝나면 크기와 소요 시간을 대시보드에서 확인합니다. 복구 훈련은 매월 진행합니다.`,
  },
  {
    title: 'Vacation policy',
    markdown: `Time off at Lumen.

## Allowance
Everyone gets 25 days of paid vacation per year, plus public holidays.

## Requesting time off
Request vacation in the HR tool at least two weeks ahead for absences longer than three days.

## On-call swaps
If you are on call during your vacation, swap the shift in the pager app before you leave.`,
  },
  {
    title: 'Architecture overview',
    markdown: `The big picture.

## Services
The web app talks to the API gateway, which routes to the notes service, the search service and the auth service.

## Data stores
Postgres holds notes and users, object storage holds uploads, Redis caches sessions.

## Real-time collaboration
Edits are synchronised with a CRDT over WebSockets; the collab server persists document snapshots every few seconds.`,
  },
  {
    title: 'Customer support playbook',
    markdown: `How support handles tickets.

## Response times
Enterprise tickets are answered within 4 hours, Team tickets within one working day.

## Refunds
Refunds are possible within 30 days of a charge; anything older needs approval from finance.

## Escalation
Bugs are escalated to engineering through the bug tracker with steps to reproduce.`,
  },
  {
    title: '디자인 시스템',
    markdown: `UI 구성 요소와 규칙.

## 색상
주 색상은 남색 계열이며 다크 모드에서도 대비 4.5:1 이상을 유지합니다.

## 타이포그래피
본문은 16px, 제목은 24px과 20px 두 단계만 씁니다.

## 접근성
모든 버튼은 키보드로 조작할 수 있어야 하고 아이콘 버튼에는 레이블을 붙입니다.`,
  },
  {
    title: 'Feature flags',
    markdown: `Using feature flags safely.

## Creating a flag
Flags are created in the flags console with an owner and an expiry date.

## Rollout
Roll out to internal users first, then 5%, 25% and 100% of workspaces, watching error rates at each step.

## Cleanup
Remove a flag within two weeks after it reaches 100%.`,
  },
  {
    title: 'Release notes 2026-10',
    markdown: `What shipped in October.

## Search
Search is three times faster and understands Korean compound words.

## Editor
Tables can be resized and code blocks highlight 40 more languages.

## Fixes
Fixed a crash when pasting very large images.`,
  },
  {
    title: 'Hiring process',
    markdown: `How we hire engineers.

## Stages
Recruiter call, take-home exercise, technical interview, team interview.

## Take-home exercise
The exercise takes about three hours; candidates have one week to submit.

## Decision
The hiring committee decides within three working days after the last interview.`,
  },
  {
    title: '성능 최적화 노트',
    markdown: `성능 개선 기록.

## 캐시
세션 조회는 레디스 캐시로 옮겨 평균 응답 시간이 8ms 줄었다.

## 쿼리 튜닝
검색 쿼리는 트라이그램 인덱스를 써서 전체 스캔을 없앴다.

## 프론트엔드
번들을 라우트별로 나눠 첫 화면 로딩이 1.2초 빨라졌다.`,
  },
  {
    title: 'Glossary',
    markdown: `Terms used in this wiki.

## Workspace
A shared space for a team; members see all shared pages in it.

## On-call
The engineer responsible for answering pages during a shift.

## SLA
Service level agreement: the uptime we promise to Enterprise customers.`,
  },
]

/**
 * Contest and offsite pages (docs/adr/1213-*): reproduce the failures reported on find_context
 * after 0.6 — a query of common words ("서울", "AI", "해커톤") plus one rare key phrase ("팀 구성")
 * ranked pages that repeat the common words above the section that holds the rare phrase, and one
 * long page filled most of the results. Deep heading paths (H1 › H2 › H3) reproduce the long
 * location lines. Fictional content written for this test.
 */
export const CONTEST_PAGES: EvalPage[] = [
  {
    title: '00 대회요강',
    markdown: `2026 해커톤 공식 요강에서 우리에게 필요한 부분만 옮겨 적었다.

# 요강 요약

## 참가 자격
참가 연령은 만 19세에서 34세까지다. 팀당 3명에서 5명이며 개인 참가는 받지 않는다.

## 일정과 제출

### 예선 서류
예선은 서류 심사다. 11월 8일 18시까지 기획서 PDF 한 부를 온라인 접수 페이지에 올린다. 마감 뒤에는 고칠 수 없다.

### 본선 진행
본선 장소는 성수 행사장이고 11월 21일 오전 10시부터 24시간 동안 진행한다. 노트북과 충전기는 각자 챙긴다.

## 심사 기준
배점은 문제 정의 30점, 기술 구현 30점, 사회적 가치 20점, 발표 20점이다. 동점이면 기술 구현 점수가 높은 쪽이 앞선다.

## 준비 사항

### 우리 팀 체크리스트
- [ ] 팀 구성: 기획 1명, 백엔드 2명, 프론트엔드 1명, 디자인 1명으로 다섯 명 채우기
- [ ] 팀장과 발표 담당 정하기
- [ ] 참가 신청서에 팀원 전원의 재학 또는 재직 증명 첨부`,
  },
  {
    title: '03 방향 메모',
    markdown: `# 방향 메모

## 결정된 것
팀 구성은 다섯 명으로 확정했다. 주제는 어르신 디지털 금융 사기 예방으로 정했고 발표는 민서가 맡는다.

## 아직 못 정한 것
데이터를 공공 API로 받을지 직접 모을지, 시연을 웹으로 할지 앱으로 할지.

## 버린 아이디어
지하철 혼잡도 예측은 비슷한 서비스가 많아서 버렸다. 반려동물 산책 매칭도 검증할 데이터가 없어서 접었다.`,
  },
  {
    title: '심사 증언 모음',
    markdown: `지난해 서울 AI 해커톤 심사위원과 참가자에게 들은 이야기를 모았다.

# 2025 서울 AI 해커톤 심사 증언

## 심사위원 A
서울 AI 해커톤은 AI를 쓰는 이유가 분명한 팀을 높게 본다. 해커톤 시연에서 AI 모델이 실제로 돌아가는지가 중요했다.

## 심사위원 B
서울 해커톤 심사에서는 문제를 겪는 사람을 직접 만난 팀이 눈에 띄었다. AI 기술 자랑보다 서울 시민의 불편을 구체적으로 말하는 팀이 좋았다.

## 심사위원 C
AI 해커톤이라고 AI만 보는 것은 아니다. 서울시 데이터를 제대로 쓴 팀에 가산점을 줬다.

## 수상팀 D
우리 팀은 발표 구성이 탄탄하다는 평을 들었다. 서울 AI 해커톤 본선 내내 시연 영상을 다듬었다.

## 수상팀 E
해커톤 마지막 세 시간은 AI 데모 안정화에만 썼다. 서울 지역 문제를 고른 것이 점수에 도움이 됐다.

## 탈락팀 F
AI 모델 정확도만 강조하다가 서울 시민에게 왜 필요한지 설명하지 못했다. 해커톤 심사위원 질문에 답이 막혔다.`,
  },
  {
    title: '현장 투표 전략',
    markdown: `# 서울 AI 해커톤 현장 투표 전략

## 투표 방식
서울 AI 해커톤 본선에는 참가자 상호 투표가 20% 반영된다. 해커톤 참가 팀은 각자 세 표를 가진다.

## 부스 동선
AI 데모 부스는 입구 쪽이 유리하다. 서울 해커톤 지난 대회에서도 입구 쪽 팀이 표를 많이 받았다.

## 피해야 할 것
다른 팀에게 표를 부탁하는 행위는 감점이다. AI 해커톤 운영진이 현장에서 지켜본다.`,
  },
  {
    title: '팀 운영 메모',
    markdown: `# 팀 운영

## 회식
팀 회식은 매달 마지막 금요일 저녁에 한다. 장소는 돌아가면서 정하고 예산은 1인 3만 원이다.

## 주간 1:1
팀장은 팀원마다 격주로 30분씩 1:1을 한다. 안건은 전날까지 공유 문서에 적는다.

## 휴가 공유
휴가는 팀 캘린더에 먼저 올리고 메신저 채널에 알린다.`,
  },
  {
    title: 'Offsite 2026 plan',
    markdown: `Planning notes for the Lumen team offsite.

# Plan

## Venue
We hold a booking at a lakeside lodge for 40 people from May 12 to 14; the deposit is due April 1.

## Budget
Team building budget is $120 per person, capped at $4,000 in total; travel is paid from the department budget.

## Agenda
Day one is strategy, day two is hack sessions, day three is free.`,
  },
  {
    title: 'Offsite 2026 retro',
    markdown: `How the Lumen offsite 2026 went.

# Lumen offsite 2026 retro

## Seoul trip
The Lumen offsite 2026 team trip to Seoul was the highlight; the team liked the city walk.

## Food
The Lumen team loved the offsite dinners; the barbecue on day two was the favourite meal.

## Sessions
Lumen offsite 2026 sessions ran long; the team wants shorter talks next offsite.

## Team games
The Lumen offsite team games were fun but the team building quiz was too hard.

## Feedback survey
Thirty Lumen team members answered the offsite 2026 survey; 80% want another offsite.`,
  },
]

const BASE_QUESTIONS: Omit<EvalQuestion, 'split'>[] = [
  { q: 'how do I roll back a bad deploy', page: 'Deploy runbook', anchor: 'rollback' },
  { q: 'how long are nightly backups kept', page: 'Backup policy', anchor: 'retention' },
  { q: 'when does the nightly backup run', page: 'Backup policy', anchor: 'schedule' },
  { q: 'who gets paged if the on-call does not acknowledge', page: 'Incident response', anchor: 'paging' },
  { q: 'API 429 Retry-After back off', page: 'API rate limits', anchor: 'exceeding-the-limit' },
  { q: 'requests per minute limit per API key', page: 'API rate limits', anchor: 'default-limits' },
  { q: 'price of the Team plan per member', page: 'Pricing plans', anchor: 'team' },
  { q: 'migration backward compatible rolling deploy', page: 'Deploy runbook', anchor: 'database-migrations' },
  { q: 'how often rotate database passwords', page: 'Security checklist', anchor: 'secrets' },
  { q: 'mobile app public launch date', page: 'Mobile app release plan', anchor: 'timeline' },
  { q: 'how many approvals for authentication changes', page: 'Code review guidelines', anchor: 'approvals' },
  { q: 'alert threshold error rate', page: 'Logging and monitoring', anchor: 'alerts' },
  { q: 'how many vacation days per year', page: 'Vacation policy', anchor: 'allowance' },
  { q: 'CRDT collaboration websocket', page: 'Architecture overview', anchor: 'real-time-collaboration' },
  { q: 'refund window for charges', page: 'Customer support playbook', anchor: 'refunds' },
  { q: 'feature flag rollout percentages', page: 'Feature flags', anchor: 'rollout' },
  { q: 'take-home exercise duration', page: 'Hiring process', anchor: 'take-home-exercise' },
  { q: '금요일 배포 금지 결정', page: '주간회의록 2026-10-05', anchor: '결정-사항' },
  { q: '모바일 출시일 확정', page: '주간회의록 2026-10-12', anchor: '결정-사항' },
  { q: '운영 환경 권한 승인', page: '온보딩 체크리스트', anchor: '권한-신청' },
  { q: '장애 사후 분석 기한', page: '장애 대응 매뉴얼', anchor: '사후-분석' },
  { q: '애플리케이션 최대 연결 수', page: '데이터베이스 운영', anchor: '연결-풀' },
  { q: '다크 모드 대비', page: '디자인 시스템', anchor: '색상' },
  { q: '세션 캐시 응답 시간', page: '성능 최적화 노트', anchor: '캐시' },
  { q: '배포 자동화 릴리스 시간', page: '주간회의록 2026-10-05', anchor: '지난주-회고' },
  { q: '인덱스 정리', page: '데이터베이스 운영', anchor: '인덱스-관리' },
  { q: 'search p95 latency after tuning', page: 'Search architecture', anchor: 'performance' },
  { q: '검색 지연 개선', page: '주간회의록 2026-10-12', anchor: '지난주-회고' },
]

const REQ = '요강-요약/준비-사항/우리-팀-체크리스트'
const DECIDED = '방향-메모/결정된-것'

/** Questions on CONTEST_PAGES (and two more on the wiki); the split is fixed here, not computed. */
const CONTEST_QUESTIONS: EvalQuestion[] = [
  { q: '서울 AI 해커톤 팀 구성', page: '00 대회요강', anchor: REQ, also: [{ page: '03 방향 메모', anchor: DECIDED }], split: 'dev' },
  { q: '해커톤 팀 구성 확정', page: '03 방향 메모', anchor: DECIDED, also: [{ page: '00 대회요강', anchor: REQ }], split: 'test' },
  { q: '해커톤 예선 서류 마감', page: '00 대회요강', anchor: '요강-요약/일정과-제출/예선-서류', split: 'dev' },
  { q: 'AI 해커톤 심사 기준 배점', page: '00 대회요강', anchor: '요강-요약/심사-기준', split: 'test' },
  { q: '본선 장소와 시간', page: '00 대회요강', anchor: '요강-요약/일정과-제출/본선-진행', split: 'dev' },
  { q: '아직 못 정한 것', page: '03 방향 메모', anchor: '방향-메모/아직-못-정한-것', split: 'test' },
  { q: '버린 아이디어', page: '03 방향 메모', anchor: '방향-메모/버린-아이디어', split: 'dev' },
  {
    q: '서울 AI 해커톤 투표 전략',
    page: '현장 투표 전략',
    anchor: '서울-ai-해커톤-현장-투표-전략/투표-방식',
    also: [
      { page: '현장 투표 전략', anchor: '서울-ai-해커톤-현장-투표-전략/부스-동선' },
      { page: '현장 투표 전략', anchor: '서울-ai-해커톤-현장-투표-전략/피해야-할-것' },
    ],
    split: 'test',
  },
  {
    q: '심사위원 증언',
    page: '심사 증언 모음',
    anchor: '2025-서울-ai-해커톤-심사-증언/심사위원-a',
    also: [
      { page: '심사 증언 모음', anchor: '2025-서울-ai-해커톤-심사-증언/심사위원-b' },
      { page: '심사 증언 모음', anchor: '2025-서울-ai-해커톤-심사-증언/심사위원-c' },
    ],
    split: 'dev',
  },
  { q: 'Lumen offsite 2026 team building budget', page: 'Offsite 2026 plan', anchor: 'plan/budget', split: 'dev' },
  { q: 'offsite venue booking deposit', page: 'Offsite 2026 plan', anchor: 'plan/venue', split: 'test' },
  { q: 'what did people say about the offsite food', page: 'Offsite 2026 retro', anchor: 'lumen-offsite-2026-retro/food', split: 'dev' },
  { q: '주간 회의 베타 테스트 인원', page: '주간회의록 2026-10-12', anchor: '결정-사항', split: 'test' },
  { q: '운영 권한 팀장 승인', page: '온보딩 체크리스트', anchor: '권한-신청', split: 'dev' },
  { q: '팀 회식', page: '팀 운영 메모', anchor: '팀-운영/회식', split: 'dev' },
  { q: '팀 휴가 공유', page: '팀 운영 메모', anchor: '팀-운영/휴가-공유', split: 'test' },
  { q: '팀장 1:1 안건', page: '팀 운영 메모', anchor: '팀-운영/주간-1-1', split: 'test' },
  { q: '참가 자격 연령', page: '00 대회요강', anchor: '요강-요약/참가-자격', split: 'dev' },
  { q: 'Lumen offsite Seoul trip', page: 'Offsite 2026 retro', anchor: 'lumen-offsite-2026-retro/seoul-trip', split: 'test' },
]

/**
 * Korean partial-match pages (docs/adr/1700-*, 1702-*): the forms that the field query "팀 구성"
 * missed or ranked low — a compound written without a space ("팀구성"), a suffix syllable inside a
 * compound ("디자인팀", "개발팀"), particles on a one-syllable noun ("팀을", "팀으로", "팀에"), verb
 * endings ("결석했을") — and two pages known by an alias (pages.aliases). Fictional content written
 * for this test; it avoids the literal phrase "팀 구성" so the field questions keep their answers.
 */
export const KO_PARTIAL_PAGES: EvalPage[] = [
  {
    title: '알고리즘 스터디 운영',
    markdown: `# 스터디 운영

## 팀구성
스터디원은 열두 명이고 네 명씩 세 팀으로 나눈다. 팀구성은 학기 첫 모임에서 제비뽑기로 정한다.

## 발표 순서
매주 한 팀이 문제 풀이를 발표하고 나머지 팀은 질문을 준비한다.

## 벌금
결석하면 오천 원, 지각하면 이천 원을 낸다. 모인 돈은 학기 말 모임에 쓴다.`,
  },
  {
    title: '사내 TF 킥오프',
    aliases: ['PayFix'],
    markdown: `# 결제 개편 TF

## 구성원
기획 하윤, 백엔드 지호와 은우, 프론트엔드 서진. 디자인은 디자인팀에서 한 명을 지원받는다.

## 목표
결제 실패율을 1% 아래로 낮추고 환불 처리 시간을 하루 안으로 줄인다.

## 회의 주기
매주 화요일 오전 10시에 30분 동안 모인다.`,
  },
  {
    title: '동아리 신입 안내',
    aliases: ['새내기 가이드'],
    markdown: `# 신입 안내

## 팀 배정
신입은 관심 분야를 적어 내고, 운영진이 그 내용을 보고 팀에 배정한다. 배정 결과는 둘째 주에 알린다.

## 활동비
한 학기 활동비는 2만 원이다.

## 연락 방법
공지는 단톡방에 올리고, 개인 문의는 운영진에게 메시지로 한다.`,
  },
  {
    title: '봄 프로젝트 회고',
    markdown: `# 봄 프로젝트 회고

## 잘한 점
개발팀 구성을 일찍 끝내서 첫 주부터 코드를 쓸 수 있었다.

## 아쉬운 점
테스트 작성을 미루다가 마지막 주에 몰렸다.

## 다음에 바꿀 것
팀을 꾸릴 때 디자이너를 먼저 구한다.`,
  },
]

/**
 * Questions on KO_PARTIAL_PAGES and the field answers (docs/adr/1702-*). Each failure family has
 * questions in both splits (matched pairs); the split is fixed here.
 */
const KO_PARTIAL_QUESTIONS: EvalQuestion[] = [
  // the query writes a compound the document spaces ("팀구성" vs "팀 구성")
  { q: '해커톤 팀구성', page: '03 방향 메모', anchor: DECIDED, also: [{ page: '00 대회요강', anchor: REQ }], split: 'dev', tag: 'ko-compound-query' },
  { q: 'TF 회의주기', page: '사내 TF 킥오프', anchor: '결제-개편-tf/회의-주기', split: 'dev', tag: 'ko-compound-query' },
  { q: '팀구성 다섯 명', page: '03 방향 메모', anchor: DECIDED, also: [{ page: '00 대회요강', anchor: REQ }], split: 'test', tag: 'ko-compound-query' },
  { q: '결제개편 목표', page: '사내 TF 킥오프', anchor: '결제-개편-tf/목표', split: 'test', tag: 'ko-compound-query' },
  // particles / endings on the query word ("팀을", "팀으로", "결석했을")
  { q: '신입을 어느 팀으로 배정', page: '동아리 신입 안내', anchor: '신입-안내/팀-배정', split: 'dev', tag: 'ko-particle' },
  { q: '결석했을 때 벌금', page: '알고리즘 스터디 운영', anchor: '스터디-운영/벌금', split: 'dev', tag: 'ko-particle' },
  { q: '팀을 다섯 명으로 구성', page: '03 방향 메모', anchor: DECIDED, also: [{ page: '00 대회요강', anchor: REQ }], split: 'dev', tag: 'ko-particle' },
  { q: '팀을 나눈 방식', page: '알고리즘 스터디 운영', anchor: '스터디-운영/팀구성', split: 'test', tag: 'ko-particle' },
  { q: '팀이 배정되는 시기', page: '동아리 신입 안내', anchor: '신입-안내/팀-배정', split: 'test', tag: 'ko-particle' },
  // the document writes a compound the query spaces ("팀구성", "디자인팀", "개발팀")
  { q: '스터디 팀 구성 방법', page: '알고리즘 스터디 운영', anchor: '스터디-운영/팀구성', split: 'dev', tag: 'ko-doc-compound' },
  { q: '디자인 팀 지원', page: '사내 TF 킥오프', anchor: '결제-개편-tf/구성원', split: 'dev', tag: 'ko-doc-compound' },
  { q: '개발 팀 구성', page: '봄 프로젝트 회고', anchor: '봄-프로젝트-회고/잘한-점', split: 'test', tag: 'ko-doc-compound' },
  { q: '운영진 팀 배정 결과', page: '동아리 신입 안내', anchor: '신입-안내/팀-배정', split: 'test', tag: 'ko-doc-compound' },
  // the page is known by an alias that its text never repeats
  { q: 'PayFix 회의', page: '사내 TF 킥오프', anchor: '결제-개편-tf/회의-주기', split: 'dev', tag: 'alias' },
  { q: '새내기 가이드 공지 방법', page: '동아리 신입 안내', anchor: '신입-안내/연락-방법', split: 'test', tag: 'alias' },
]

/**
 * Field cases of 0.15.1 (docs/adr/1900-*, 1901-*, 1902-*), fictional and built with the same shape:
 *
 *   - Three "court" pages per idea (1심, 2심, 3심). Each starts with a one-line `_intro` that is only
 *     links (the previous ruling and the record), then the ruling (`# 판결문`). The 3심 title says
 *     폐기; its ruling explains why without the words 폐기 or 이유, while the 1심 ruling mentions both
 *     ("폐기 의견도 나왔지만 이유가 약하다"). Asked "<idea> 폐기 이유" at a small budget, the 3심
 *     page's link line won its page slot on the title alone and the ruling became a pointer.
 *   - A contest log in Korean: a ~600-token table of submissions whose links contain
 *     "solar-forecast/submissions", and a short "최고 기록" section that says best submission and
 *     public score. Asked in English, the URLs made the table the top result and the short answer
 *     did not fit the rest of the budget.
 */
function courtPages(idea: string, slug: string): EvalPage[] {
  const link = (n: number) => `[기록](https://court.example.com/${slug}/${n})`
  return [
    {
      title: `${idea} 1심 판결`,
      markdown: `← [[${idea} 아이디어]] · ${link(1)}

# 판결문
1심 재판부는 ${idea} 안을 조건부로 진행하라고 판단했다. 폐기 의견도 나왔지만 이유가 약하다고 봤다. 설치 장소를 세 곳으로 줄이면 비용 문제는 풀린다.

# 보완 과제
현장 데이터를 구청에서 받을 수 있는지 먼저 확인한다.`,
    },
    {
      title: `${idea} 2심 판결`,
      markdown: `← [[${idea} 1심 판결]] · ${link(2)}

# 판결문
2심은 1심 판단을 그대로 유지했다. 비용 추정이 낙관적이라는 지적은 기록으로 남긴다.

# 보완 과제
시범 구역의 유지비를 다시 계산한다.`,
    },
    {
      title: `${idea} 3심 폐기`,
      markdown: `← [[${idea} 2심 판결]] · ${link(3)}

# 판결문
3심 재판부는 ${idea} 안을 접는다. 첫째, 구청 데이터가 공개되지 않아 효과를 검증할 수 없다. 둘째, 한 대 유지비가 연 40만 원으로 예산을 넘는다. 시범 운영도 하지 않는다.

# 소수 의견
한 판사는 시범 구역 한 곳이라도 운영해 보자고 했다.`,
    },
  ]
}

/**
 * A contest log: the contest's English name in the intro, a long submissions table with links and a
 * `score` column, then a short best-result section. Postgres's parser keeps a URL path as one lexeme
 * ("/solar-forecast/submissions/1001"), so the table is a candidate through `score` only; the URL words
 * then counted in the Node score.
 */
function contestLogPage(title: string, name: string, host: string, path: string, model: string, best: string): EvalPage {
  const rows = Array.from({ length: 22 }, (_, i) => {
    const n = i + 1
    const score = (7_900 - i * 61.3).toFixed(2)
    return `| ${n} | 11/${String(2 + Math.floor(i / 3)).padStart(2, '0')} | ${model}${1 + (i % 10)}_s${i % 7} | [열기](https://${host}/${path}/${1000 + n}) | ${score} |`
  })
  return {
    title,
    markdown: `${name}. 대회 기간은 11월 2일부터 13일까지이고 하루 다섯 번까지 낼 수 있다.

# 제출 목록
| 회차 | 날짜 | 모델 | 링크 | score |
|---|---|---|---|---|
${rows.join('\n')}

# 최고 기록
${best}

# 다음 할 일
남은 다섯 번은 앙상블 실험에 쓴다.`,
  }
}

export const FIELD_PAGES: EvalPage[] = [
  ...courtPages('빗물 센서', 'rain-sensor'),
  ...courtPages('공유 우산', 'shared-umbrella'),
  contestLogPage(
    '태양광 예측 대회 기록',
    'Solar Forecast Challenge 2026',
    'contest.example.com',
    'solar-forecast/submissions',
    'G',
    'best submission은 15회차 G10_seed9다. public score 6,465.75로 지금까지 제일 좋은 점수다.',
  ),
  contestLogPage(
    '수요 예측 리그 기록',
    'Demand Prediction League',
    'league.example.com',
    'demand-prediction/entries',
    'L',
    'top entry는 12회차 L7_s3이다. leaderboard score 5,120.30으로 리그 3위다.',
  ),
]

/**
 * Questions of 0.15.1 (docs/adr/1909-*), each family in both splits:
 *   thin-intro    the link-only `_intro` takes the page slot (field case 1), small budget
 *   url-table     URLs in a long table outrank a short answer (field case 2), small budget
 *   cross-lang    English question, Korean notes: asked as queries=[English, Korean]
 *   en-inflection plural / -ed / -ing in the query, the base form in the note
 *   ko-double     two particles on one word ("회의에서는")
 */
const FIELD_QUESTIONS: EvalQuestion[] = [
  { q: '빗물 센서 폐기 이유', page: '빗물 센서 3심 폐기', anchor: '판결문', evidence: '구청 데이터가 공개되지 않아', budget: 800, split: 'dev', tag: 'thin-intro' },
  { q: '공유 우산 폐기 이유', page: '공유 우산 3심 폐기', anchor: '판결문', evidence: '구청 데이터가 공개되지 않아', budget: 800, split: 'test', tag: 'thin-intro' },
  { q: 'solar forecast best submission score', page: '태양광 예측 대회 기록', anchor: '최고-기록', evidence: 'public score 6,465.75', budget: 700, split: 'dev', tag: 'url-table' },
  { q: 'demand prediction top entry leaderboard score', page: '수요 예측 리그 기록', anchor: '최고-기록', evidence: 'leaderboard score 5,120.30', budget: 700, split: 'test', tag: 'url-table' },
  { q: 'team dinner budget per person', queries: ['팀 회식 예산'], page: '팀 운영 메모', anchor: '팀-운영/회식', evidence: '1인 3만 원', split: 'dev', tag: 'cross-lang' },
  { q: 'solar forecast best score', queries: ['태양광 예측 최고 점수'], page: '태양광 예측 대회 기록', anchor: '최고-기록', evidence: 'public score 6,465.75', budget: 1000, split: 'dev', tag: 'cross-lang' },
  { q: 'how are newcomers assigned to teams', queries: ['신입 팀 배정'], page: '동아리 신입 안내', anchor: '신입-안내/팀-배정', evidence: '관심 분야를 적어 내고', split: 'test', tag: 'cross-lang' },
  { q: 'study group fine for absence', queries: ['스터디 결석 벌금'], page: '알고리즘 스터디 운영', anchor: '스터디-운영/벌금', evidence: '결석하면 오천 원', split: 'test', tag: 'cross-lang' },
  { q: 'flags expiry dates owners', page: 'Feature flags', anchor: 'creating-a-flag', split: 'dev', tag: 'en-inflection' },
  { q: 'reviewers answering pull requests', page: 'Code review guidelines', anchor: 'turnaround', split: 'dev', tag: 'en-inflection' },
  { q: 'approved authentication changes', page: 'Code review guidelines', anchor: 'approvals', split: 'test', tag: 'en-inflection' },
  { q: 'rolled back deploys announcing', page: 'Deploy runbook', anchor: 'rollback', split: 'test', tag: 'en-inflection' },
  { q: '주간회의에서는 출시일을 언제로', page: '주간회의록 2026-10-12', anchor: '결정-사항', split: 'dev', tag: 'ko-double' },
  { q: '동아리에서도 활동비는', page: '동아리 신입 안내', anchor: '신입-안내/활동비', split: 'dev', tag: 'ko-double' },
  { q: '스터디에서는 벌금을 얼마', page: '알고리즘 스터디 운영', anchor: '스터디-운영/벌금', split: 'test', tag: 'ko-double' },
  { q: '디자인팀에서는 누구를 지원', page: '사내 TF 킥오프', anchor: '결제-개편-tf/구성원', split: 'test', tag: 'ko-double' },
]

/**
 * Every question. The 28 wiki questions of ADR 0927 are split by position (every third one is
 * held out as test); the contest, Korean partial-match and 0.15.1 questions carry their split
 * explicitly (new questions are appended after them, never into BASE_QUESTIONS).
 */
export const EVAL_QUESTIONS: EvalQuestion[] = [
  ...BASE_QUESTIONS.map((q, i): EvalQuestion => ({ ...q, split: i % 3 === 2 ? 'test' : 'dev' })),
  ...CONTEST_QUESTIONS,
  ...KO_PARTIAL_QUESTIONS,
  ...FIELD_QUESTIONS,
]

/**
 * Text that shows the answer of `q` is in a returned body: `q.evidence`, else the first 16
 * characters of the first non-empty line of the expected section (the fixtures' sections are one
 * or two sentences; their first line is the answer).
 */
export function answerEvidence(q: EvalQuestion, pages: EvalPage[] = ALL_EVAL_PAGES): string {
  if (q.evidence) return q.evidence
  const page = pages.find((p) => p.title === q.page)
  if (!page) throw new Error(`eval page missing: ${q.page}`)
  const leaf = q.anchor.split('/').pop()!
  const slug = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  const lines = page.markdown.split('\n')
  const at = lines.findIndex((l) => /^#{1,6} /.test(l) && slug(l.replace(/^#+ /, '')) === leaf)
  const body = at >= 0 ? lines.slice(at + 1).find((l) => l.trim() && !/^#{1,6} /.test(l)) : lines.find((l) => l.trim())
  if (!body) throw new Error(`no body for ${q.page} §${q.anchor}`)
  return [...body.trim()].slice(0, 16).join('')
}

/**
 * Other contest notes (another team's workspace in the field report): 30 short pages that repeat
 * "서울", "AI", "해커톤", "팀" in varied sentences and never say "구성", so the common words of the
 * contest questions are common in the corpus, as they were in the reporting user's notes. Without
 * them the 32-page wiki is too small for document frequencies to say which words are common.
 */
export function contestNoisePages(n = 30): EvalPage[] {
  const lines = [
    '서울 AI 해커톤 현장 분위기를 정리했다.',
    'AI 심사위원은 해커톤 시연을 가장 중요하게 봤다.',
    '서울 지역 팀이 절반 넘게 참가했다.',
    '해커톤 발표 시간은 팀마다 5분이었다.',
    '현장 투표는 본선 마지막 날 진행됐다.',
    'AI 모델 데모가 멈춘 팀이 여럿 있었다.',
    '서울시 공공데이터를 쓴 팀이 상을 받았다.',
    '해커톤 운영진이 밤새 간식을 챙겨 줬다.',
    '우리 팀은 AI 기능보다 문제 정의를 먼저 설명했다.',
    '서울 AI 해커톤 수상작은 대부분 생활 문제를 다뤘다.',
  ]
  const headings = ['현장 메모', '심사 관찰', '발표 메모', '다른 팀 이야기', '배운 점']
  return Array.from({ length: n }, (_, i) => {
    const sections = [0, 1, 2].map((k) => {
      const body = [0, 1, 2].map((j) => lines[(i * 7 + k * 3 + j) % lines.length]).join(' ')
      return `## ${headings[(i + k) % headings.length]}\n${body}`
    })
    return { title: `대회 후기 ${i + 1}`, markdown: `# ${2020 + (i % 6)} 서울 AI 해커톤 후기\n\n${sections.join('\n\n')}` }
  })
}

/** Wiki + contest pages + Korean partial-match pages + 0.15.1 field pages + other contest notes: the corpus the questions above are asked against. */
export const ALL_EVAL_PAGES: EvalPage[] = [...EVAL_PAGES, ...CONTEST_PAGES, ...KO_PARTIAL_PAGES, ...FIELD_PAGES, ...contestNoisePages()]

// ---------------------------------------------------------------------------
// padding: real pages are longer than the fixture sections above
// ---------------------------------------------------------------------------

const FILLER_EN = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed eiusmod tempor incididunt labore dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat'.split(' ')
const FILLER_KO = '누리 다솜 가람 미르 슬기 아라 한울 별찌 나린 온새미 라온 여우비 그린 해솔 시나브로 윤슬'.split(' ')

/** Deterministic filler text of about `words` words (no evaluation query terms). */
export function fillerText(seed: number, words: number, korean: boolean): string {
  const vocab = korean ? FILLER_KO : FILLER_EN
  let x = seed * 2654435761 >>> 0
  const out: string[] = []
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out.push(vocab[x % vocab.length])
    if (i % 12 === 11) out.push(korean ? '다.\n' : '.\n')
  }
  return out.join(' ')
}

/**
 * Appends `sections` filler sections (~`words` words each) to every page, so pages reach the
 * 1–2k-token size of typical wiki pages. Section headings are neutral ("Appendix 1" …).
 */
export function padPages(pages: EvalPage[], sections = 6, words = 110): EvalPage[] {
  return pages.map((p, pi) => {
    const korean = /[가-힣]/.test(p.title)
    const extra = Array.from({ length: sections }, (_, i) =>
      `## ${korean ? '부록' : 'Appendix'} ${i + 1}\n${fillerText(pi * 31 + i, words, korean)}`,
    ).join('\n\n')
    return { ...p, markdown: `${p.markdown}\n\n${extra}` }
  })
}
