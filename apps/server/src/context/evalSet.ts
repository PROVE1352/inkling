/**
 * Retrieval evaluation set (docs/adr/0927-*): a fictional team wiki ("Lumen", a made-up product)
 * written for this test — no real data. Each question names the page title and the section anchor
 * that answers it. Pages deliberately share vocabulary (backup, deploy, 회의, 배포 …) so ranking,
 * not mere matching, decides the result. Used by context.db.test.ts and scripts/context-bench.ts.
 */

export interface EvalPage {
  title: string
  markdown: string
}

export interface EvalQuestion {
  q: string
  page: string
  anchor: string
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

export const EVAL_QUESTIONS: EvalQuestion[] = [
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
    return { title: p.title, markdown: `${p.markdown}\n\n${extra}` }
  })
}
