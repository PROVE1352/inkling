/**
 * find_context with several queries (docs/adr/1720-*): the corpus and the measurement shared by the
 * [db] test (multiQuery.db.test.ts) and scripts/multi-query-bench.ts. Not imported by the server.
 *
 * The corpus is a small team wiki in English and Korean: a few topic pages whose answer section is
 * written in one language or with one word, and FILLER generated pages that share the common words,
 * so every query fills its budget and the queries of one bundle overlap the way real phrasings do.
 * Each bundle lists 3-5 phrasings an agent would send (synonyms, the other language) and the
 * sections that answer it (gold).
 */
import { estimateTokens } from '../context/tokens'

export type Blocks = { type: string; props?: Record<string, unknown>; content?: { type: string; text: string; styles: Record<string, never> }[] }[]

export const doc = (sections: Record<string, string>): Blocks =>
  Object.entries(sections).flatMap(([hd, body]) => [
    { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: hd, styles: {} }] },
    ...body.split('\n\n').map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p, styles: {} }] })),
  ])

/** Topic pages: title → heading → body. Anchors are the lower-cased headings (chunker rules). */
export const TOPICS: Record<string, Record<string, string>> = {
  'Release runbook': {
    Rollback:
      'To roll back a deployment, flip the release flag off and redeploy the previous image tag from the registry. ' +
      'Announce it in #releases and open an incident only when customers saw errors.',
    Canary: 'Every deployment starts as a canary on five percent of traffic for thirty minutes; watch the error budget dashboard.',
    'Freeze window': 'No deployments on Friday after 15:00 or during the end-of-quarter freeze.',
  },
  '배포 가이드': {
    되돌리기: '배포를 되돌릴 때는 이전 이미지 태그로 다시 배포하고, 기능 플래그를 끈 뒤 릴리스 채널에 알린다. 데이터 마이그레이션이 있었으면 DBA와 먼저 상의한다.',
    승인: '운영 배포는 리뷰어 두 명의 승인이 필요하다.',
  },
  'On-call handbook': {
    Escalation: 'If the primary does not acknowledge a page within 15 minutes, the pager escalates to the secondary and then to the team lead.',
    Handover: 'Write a handover note every Monday: open incidents, noisy alerts, follow-ups.',
  },
  '장애 대응': {
    담당자: '장애가 나면 당번이 지휘를 맡고, 30분 안에 해결되지 않으면 팀장에게 올린다. 고객 공지는 CS 담당자가 쓴다.',
    회고: '장애 회고는 일주일 안에 쓰고 재발 방지 항목에 담당자를 정한다.',
  },
  'Database notes': {
    Backups: 'Nightly snapshots are kept for 30 days. A restore test runs on the first Monday of each month: restore the latest snapshot into a scratch instance and compare row counts.',
    'Migration timeouts': 'Long migrations run with lock_timeout = 5s and are retried; split big backfills into batches.',
  },
  '백업 정책': {
    복구: '재해 복구 시에는 가장 최근 스냅샷을 새 인스턴스로 복원하고 애플리케이션 연결 문자열을 바꾼다. 복구 목표 시간은 4시간이다.',
  },
  'Auth design': {
    'Two-factor': 'Two-factor login uses TOTP codes from an authenticator app; recovery codes are shown once and stored hashed.',
    Sessions: 'Sessions last 30 days and rotate on every login.',
  },
  '보안 수칙': {
    '2단계 인증': '관리자 계정은 2단계 인증(OTP)이 필수다. 분실 시 복구 코드로 로그인한다.',
  },
  'Cache rules': {
    Invalidation: 'Invalidate by key prefix after every write; never purge the whole cache in production. Stale entries expire after ten minutes.',
  },
  '캐시 운영': {
    무효화: '쓰기 직후 키 접두사로 캐시를 무효화한다. 전체 삭제는 금지.',
  },
}

/** A bundle of phrasings and the sections that answer it (page title + anchor). */
export interface Bundle {
  name: string
  queries: string[]
  gold: { title: string; anchor: string }[]
}

export const BUNDLES: Bundle[] = [
  {
    name: 'rollback',
    queries: ['roll back deployment', '배포 되돌리기', 'revert release'],
    gold: [{ title: 'Release runbook', anchor: 'rollback' }, { title: '배포 가이드', anchor: '되돌리기' }],
  },
  {
    name: 'escalation',
    queries: ['on-call escalation', '장애 담당자', 'pager acknowledge'],
    gold: [{ title: 'On-call handbook', anchor: 'escalation' }, { title: '장애 대응', anchor: '담당자' }],
  },
  {
    name: 'restore',
    queries: ['backup restore test', '백업 복구', 'restore snapshot', 'disaster recovery'],
    gold: [{ title: 'Database notes', anchor: 'backups' }, { title: '백업 정책', anchor: '복구' }],
  },
  {
    name: 'two-factor',
    queries: ['two-factor login', '2단계 인증', 'OTP', 'authenticator app', 'recovery codes'],
    gold: [{ title: 'Auth design', anchor: 'two-factor' }, { title: '보안 수칙', anchor: '2단계-인증' }],
  },
  {
    name: 'cache',
    queries: ['cache invalidation', '캐시 무효화', 'purge stale cache'],
    gold: [{ title: 'Cache rules', anchor: 'invalidation' }, { title: '캐시 운영', anchor: '무효화' }],
  },
]

/**
 * Generated meeting notes: mostly everyday words, one word in five from the queries' vocabulary, so
 * every query finds many weak matches (and fills its budget) the way a real wiki does. queryShare = 1
 * (every word a query word) is the worst case for RRF: see docs/adr/1720-* "Consequences".
 */
export const FILLER = 60
const COMMON = [
  'meeting', 'agenda', 'budget', 'hiring', 'roadmap', 'design', 'customer', 'feedback', 'planning', 'quarter', 'metrics',
  'onboarding', 'contract', 'vendor', 'travel', 'office', 'lunch', 'demo', 'sprint', 'retro', 'goal', 'risk',
  '회의', '일정', '예산', '채용', '고객', '계획', '목표', '출장', '데모', '분기',
]
const QUERY_WORDS = [
  'deployment', 'release', 'rollback', 'cache', 'backup', 'restore', 'login', 'incident', 'pager', 'snapshot', 'recovery',
  'test', 'migration', 'review', 'owner', 'flag', 'image', 'stale', 'purge', 'codes', 'app',
  '배포', '장애', '복구', '캐시', '인증', '담당자', '백업', '회고', '테스트', '로그인',
]
export function fillerPages(queryShare = 0.2): { title: string; blocks: Blocks }[] {
  let seed = 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const word = () => (rnd() < queryShare ? QUERY_WORDS[Math.floor(rnd() * QUERY_WORDS.length)] : COMMON[Math.floor(rnd() * COMMON.length)])
  const sentence = () => Array.from({ length: 18 }, word).join(' ') + '.'
  return Array.from({ length: FILLER }, (_, i) => ({
    title: `Meeting notes ${i}`,
    blocks: doc(Object.fromEntries(Array.from({ length: 4 }, (_, s) => [`Item ${i}.${s}`, `${sentence()} ${sentence()}`]))),
  }))
}

/** A gold section is "included" when a fragment header names its page and anchor (not a pointer). */
export function includesSection(text: string, pageId: string, anchor: string): boolean {
  const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\(page ${pageId}; [^\\n]*§${esc} v=`).test(text)
}

export interface BundleMeasure {
  name: string
  queries: number
  separate: { calls: number; tokens: number; gold: number }
  bundled: { calls: number; tokens: number; gold: number }
  goldTotal: number
}

type Tool = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>

/**
 * One bundle: the phrasings as N separate find_context calls (the agent's alternative today) vs one
 * call with queries=[…]. Tokens = tokens.ts estimate of the returned tool text; gold = answer
 * sections shown as text (separately: in any of the N answers).
 */
export async function measureBundle(tool: Tool, b: Bundle, pageIdOf: (title: string) => string, budget?: number): Promise<BundleMeasure> {
  const extra = budget ? { budget } : {}
  const texts: string[] = []
  for (const q of b.queries) {
    const r = await tool('find_context', { query: q, ...extra })
    if (r.isError) throw new Error(r.text)
    texts.push(r.text)
  }
  const bundle = await tool('find_context', { queries: b.queries, ...extra })
  if (bundle.isError) throw new Error(bundle.text)
  const hit = (t: string) => b.gold.filter((g) => includesSection(t, pageIdOf(g.title), g.anchor)).length
  const all = texts.join('\n')
  return {
    name: b.name,
    queries: b.queries.length,
    separate: { calls: b.queries.length, tokens: texts.reduce((n, t) => n + estimateTokens(t), 0), gold: hit(all) },
    bundled: { calls: 1, tokens: estimateTokens(bundle.text), gold: hit(bundle.text) },
    goldTotal: b.gold.length,
  }
}

export function measureTable(rows: BundleMeasure[]): string {
  const lines = [
    '| bundle | queries | separate: calls / tokens / gold | bundled: calls / tokens / gold | tokens saved |',
    '|---|---:|---|---|---:|',
  ]
  let st = 0
  let bt = 0
  for (const r of rows) {
    st += r.separate.tokens
    bt += r.bundled.tokens
    const saved = 100 * (1 - r.bundled.tokens / r.separate.tokens)
    lines.push(
      `| ${r.name} | ${r.queries} | ${r.separate.calls} / ${r.separate.tokens} / ${r.separate.gold}/${r.goldTotal} | ` +
        `${r.bundled.calls} / ${r.bundled.tokens} / ${r.bundled.gold}/${r.goldTotal} | ${saved.toFixed(0)}% |`,
    )
  }
  const calls = rows.reduce((n, r) => n + r.queries, 0)
  lines.push(`| total | ${calls} | ${calls} / ${st} / ${rows.reduce((n, r) => n + r.separate.gold, 0)} | ${rows.length} / ${bt} / ${rows.reduce((n, r) => n + r.bundled.gold, 0)} | ${(100 * (1 - bt / st)).toFixed(0)}% |`)
  return lines.join('\n')
}
