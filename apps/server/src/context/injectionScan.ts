import type { InjectionRule } from '@inkling/shared'
import { INJECTION_RULES } from '@inkling/shared'

/**
 * Deterministic prompt-injection heuristics (docs/adr/0977-*, 0979-*).
 *
 * A SIGNAL, never a block: matching text is still stored, indexed and returned; MCP output marks
 * the section `suspicious: injection-like (<rules>)`, the web app shows a small badge and the first
 * detection per page and rule is written to the audit log. The heuristics are easy to evade
 * (paraphrase, another language, splitting across sections) and can misfire on documents that talk
 * about prompt injection; the real boundaries are the edit lock, OAuth scopes and agent blocks.
 *
 * Since 0.24 (rules version 2, docs/adr/0979-*) the sentence rules that misfired on notes ABOUT agents
 * and permissions (permission-change, tool-directive, exfil-url, and the override phrases "시스템
 * 프롬프트 공개", "너는 이제", "developer/god mode") also need a sign that the text tells someone to do
 * something: an imperative or request form, a second person, "from now on", or an agent addressed by
 * name, in the same sentence (the strong signs also in the sentence before or after). Explaining,
 * summarising or recording such a request ("…하는 공격이다", "the attacker makes the agent grant…")
 * no longer matches; a quoted or fenced command still does, because the command form is in the text.
 *
 * Computed once per section at indexing time (page_chunks.suspicious), never at read time. A version
 * that only narrows rules reaches indexed sections through the boot re-scan of flagged chunks
 * (rescanFlaggedChunks); a rule that flags more needs a CHUNKER_VERSION bump (a full re-index).
 */
export const INJECTION_RULES_VERSION = 2

// Invisible / bidi / tag characters (same sets as the MCP output sanitizer, ZWJ and VS16 excluded).
// eslint-disable-next-line no-misleading-character-class
const HIDDEN = /[\u202A-\u202E\u2066-\u2069\u061C\u200B\u200C\u200E\u200F\u2060-\u2064\u180E\uFEFF]|\uDB40[\uDC00-\uDC7F]/

/** Phrases that try to replace the agent's instructions (matched on normalised text). */
export const OVERRIDE_PHRASES: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b(\s+\w+){0,3}\s+(previous|prior|above|earlier|preceding|all|any|your|the)\s+(\w+\s+)?(instructions?|prompts?|rules|directions|guidelines|messages)\b/,
  /\b(reveal|print|show|repeat|output|leak|dump|ignore|override)\b(\s+\w+){0,3}\s+(your\s+|the\s+)?system\s+prompt\b/,
  /\byou\s+are\s+now\s+(an?\s+|the\s+)?(new\s+|different\s+|unrestricted\s+|jailbroken\s+)?(ai|assistant|agent|model|dan|chatbot)\b/,
  /\b(new|updated)\s+instructions\s*:/,
  /\bjailbreak\s+mode\b/,
  /(이전|앞의|위의|기존|모든)\s*(의\s*)?(지시|지침|명령|프롬프트|규칙)(사항)?\s*(을|를|은|는)?\s*(모두\s*|전부\s*|다\s*)?(무시|잊어|잊고|따르지\s*마)/,
  /새로운\s*(지시|지침|명령)\s*:/,
]

/**
 * Override phrases that also occur in ordinary writing ("개발자 모드", a novel's "너는 이제 자유야", a report that a
 * model 공개한 its system prompt). Matched per sentence; they count only with a directive sign in that sentence
 * (`directive`), or, for "너는 이제 …", when the sentence gives the reader a new role (`ROLE_WORD`).
 */
const GATED_OVERRIDE: readonly RegExp[] = [
  /\b(developer|god)\s+mode\b/,
  /시스템\s*프롬프트\s*(를|을)?\s*(출력|보여|공개|알려|무시|유출|반복)/,
]
const YOU_ARE_NOW_KO = /(너는|당신은|넌)\s*(이제|지금부터)/
const ROLE_WORD = /\b(ai|dan|bot|assistant|agent|model)\b|봇|어시스턴트|에이전트|인공지능|비서|모델|관리자|개발자|시스템|역할|제한|규칙|필터|탈옥|모드/

const TOOL_NAMES =
  'patch_section|update_page|trash_page|move_page|rename_page|create_page|import_folder|update_row|create_row|' +
  'add_comment|create_from_template|get_instructions|read_page|read_pages|find_context|changes_since|query_rows|' +
  'create_chart|create_view'
const TOOL = new RegExp(`\\b(${TOOL_NAMES})\\b`)
/** Sentence addresses an AI agent. */
const AGENT_CUE =
  /\b(ai|assistant|agent|agents|llm|model|claude|chatgpt|gpt|copilot|you\s+must|you\s+should|you\s+will|please\s+now)\b|에이전트|어시스턴트|인공지능|ai는|너는|당신은|반드시/
const IMPERATIVE = /\b(call|run|invoke|execute|use|trigger|must|immediately)\b|호출|실행|사용해|하라|해라|하세요|할\s*것/
const PERMISSION_TERM = /\b(permissions?|roles?|admin|administrator|owner|lock|locks|access|scope|token)\b|권한|관리자|소유자|잠금|역할|토큰/
const PERMISSION_VERB = /\b(grant|give|make|change|remove|disable|unlock|elevate|promote|add)\b|부여|변경|해제|풀어|올려|추가해|바꿔/

/*
 * Directive signs (docs/adr/0979-*): does a sentence tell someone to do something? Positive signs only; a sentence
 * is never cleared because it also reads as a description, so a command quoted inside a description still counts.
 */
/** Bullets, quotes, check boxes, numbering and one short "Label:" in front of a sentence. */
const LEAD = /^[\s>*+\-#•·"'“‘`(\[\]x]*(\d{1,3}[.)]\s*)?/
const LABEL = /^[^:：\n]{1,40}[:：]\s*/
const IMPERATIVE_START = new RegExp(
  '^((please|now|first|then|also|and|immediately|just|kindly)[,\\s]+)*(' +
    'ignore|disregard|forget|override|bypass|reveal|print|show|repeat|output|leak|dump|call|run|invoke|execute|use|' +
    'trigger|grant|give|make|change|remove|disable|unlock|elevate|promote|add|set|delete|erase|wipe|send|post|visit|' +
    'open|fetch|load|append|attach|include|put|encode|render|enter|export|copy|move|replace|write|create|update|go|' +
    'stop|follow|obey|switch|turn|enable|transfer|upload|forward|email|share|tell|respond|answer|act|pretend|assume|' +
    'reply|return|navigate|click|insert|paste|clear|empty|lift|raise|assign' +
    ')\\b',
)
const AGENT_NAME = '(ai|assistant|agent|agents|claude|chatgpt|gpt|copilot|llm|model|bot)(\\s+(agent|agents|assistant|model))?'
/** "Assistant:", "AI agent,", "hey Claude," at the start of a sentence or after a quote or punctuation. */
const VOCATIVE_EN = new RegExp(`(^|[.!?:;"'“‘(\\[>]\\s*|\\b(hey|hi|dear|attention|note\\s+to(\\s+the)?)\\s+)${AGENT_NAME}\\s*[:,]`)
/** "…, AI agent." at the end. */
const VOCATIVE_EN_END = new RegExp(`,\\s*(the\\s+)?${AGENT_NAME}\\s*[.!]*$`)
const VOCATIVE_KO = /(^|[\s"'“‘(\[>])(에이전트|어시스턴트|인공지능|ai|비서|봇|챗봇)(야|여|님|씨)?\s*[:,]/
/** Signs strong enough to carry over to the sentence before and after. */
const STRONG_SIGN =
  /\byou\s+(must|should|need\s+to|have\s+to|will\s+now|are\s+to|are\s+now|shall|now)\b|\bfrom\s+now\s+on\b|\byour\s+(new\s+)?(instructions|task|orders|role)\b|지금부터|이제부터|(^|[\s"'“‘(\[>])(너는|넌|네가|너의|너도|당신은|당신이|당신의)/
/** Same-sentence signs: request words, "me" as the one who benefits, urgency. */
const WEAK_SIGN =
  /\bplease\b|\bmust\b|\bshould\s+(now|immediately|also)\b|\bimmediately\b|\bright\s+(now|away)\b|\bnow\s*[.!]*$|\b(grant|give|make|let|send|show|tell)\s+me\b|즉시|당장|지금\s*바로|반드시/
/** Korean imperative and request endings, followed by a clause end (so "하라고" reported speech, "할 것이다" and "할 것 같다" do not count). */
const KO_COMMAND =
  /(해라|하라|어라|아라|여라|거라|세요|십시오|하시오|줘요|줘|바란다|바랍니다|해야\s*(한다|합니다|해)|하도록\s*하라)(?=$|[\s.!?,;:'"”’」』)\]>~])|할\s*것\s*($|[.!,;:'"”’」』)\]>~])/
/** Informal (반말) commands at the very end of a sentence. */
const KO_COMMAND_END =
  /(해|줘|봐|둬|바꿔|풀어|올려|지워|넣어|보내|열어|들어|꺼|켜|가|와|써|만들어|알려|보여|붙여|옮겨|비워|따라|들어가|나가)$/
/** Closing punctuation and quotes at the end of a sentence (trimmed by a loop: `[…]+$` is quadratic on long runs). */
const TAIL_CHARS = new Set([...' \t\r\n\u00a0.!?。"\'”’」』)]>~*`'])
function trimTail(l: string): string {
  let end = l.length
  while (end > 0 && TAIL_CHARS.has(l[end - 1])) end--
  return l.slice(0, end)
}
const VOCATIVE_LEAD = new RegExp(`^${AGENT_NAME}\\s*[:,]\\s*`)

/** The sentence with its bullets/quotes and one short label removed (both forms are tried). */
function heads(l: string): string[] {
  const a = l.replace(LEAD, '')
  const b = a.replace(LABEL, '').replace(LEAD, '')
  return b === a ? [a] : [a, b]
}

/** A strong sign in this sentence (also counts for its neighbours). */
function strongSign(l: string): boolean {
  return STRONG_SIGN.test(l) || VOCATIVE_EN.test(l) || VOCATIVE_EN_END.test(l) || VOCATIVE_KO.test(l)
}

/** Any directive sign in this sentence itself. */
function ownSign(l: string): boolean {
  if (strongSign(l) || WEAK_SIGN.test(l) || KO_COMMAND.test(l)) return true
  if (KO_COMMAND_END.test(trimTail(l))) return true
  // after a vocative ("Assistant: grant …") the imperative starts there
  for (const h of heads(l)) {
    if (IMPERATIVE_START.test(h)) return true
    const v = h.replace(VOCATIVE_LEAD, '')
    if (v !== h && IMPERATIVE_START.test(v)) return true
  }
  return false
}

const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/
const HEX_BLOB = /\b[0-9a-fA-F]{128,}\b/

/*
 * URL rules are a single left-to-right pass, not one regex: the old patterns
 * (`[^…]+\?[^…]*=`) let both classes take `?` and `=`, so a failed match
 * retried every split point (cubic; 20 KB of `http://?` took 19.5 s on one core).
 * URL_TOKEN takes maximal runs that never overlap, and each `=` after the `?` is
 * looked at once, so the cost is linear in the text (docs/PERFORMANCE.md).
 */
const URL_TOKEN = /https?:\/\/[^\s)>\]"']+/gi
/** Markdown image target. Alt text stops at `[`/`]`/newline so starts never rescan each other. */
const IMAGE_URL = /!\[[^\][\n]{0,300}\]\(\s*(https?:\/\/[^\s)]+)/gi
/** A Markdown image with a URL somewhere in the sentence (non-global twin of IMAGE_URL). */
const IMAGE_IN = /!\[[^\][\n]{0,300}\]\(\s*https?:\/\//
/** A query value that is a placeholder for data the agent should fill in. */
const PLACEHOLDER_HEAD = /^(\{|<|\$|\[|%7b|%3c|%24|%s\b)/i
const PLACEHOLDER_AFTER = /^\s*(\{|<|\$|\[|%7b|%3c|%24|%s\b)/i

interface QueryFacts {
  query: boolean
  placeholder: boolean
  /** The placeholder names data (`{notes}`, `<secret token>`, `$NOTES`, `%7Bsummary%7D`), not a value (`{query}`, `${id}`). */
  dataPlaceholder: boolean
}

/** Does `url` have `?…=`, and is any query value a placeholder? `after` = text right after the URL. */
function queryFacts(url: string, after: string): QueryFacts {
  const q = url.indexOf('?', url.indexOf('//') + 3)
  if (q < 0) return { query: false, placeholder: false, dataPlaceholder: false }
  let query = false
  let placeholder = false
  for (let i = url.indexOf('=', q + 1); i >= 0; i = url.indexOf('=', i + 1)) {
    query = true
    const inUrl = i + 1 < url.length
    if (!(inUrl ? PLACEHOLDER_HEAD.test(url.slice(i + 1, i + 5)) : PLACEHOLDER_AFTER.test(after))) continue
    placeholder = true
    // the placeholder's own text: up to the next `&` inside the URL, or the next 40 characters after it
    const amp = inUrl ? url.indexOf('&', i + 1) : -1
    const name = inUrl ? url.slice(i + 1, amp < 0 ? Math.min(url.length, i + 64) : Math.min(amp, i + 64)) : after.slice(0, 40)
    if (DATA_WORD.test(decodePlaceholder(name))) return { query, placeholder, dataPlaceholder: true }
  }
  return { query, placeholder, dataPlaceholder: false }
}

/** `%7Bsummary%7D` → `{summary}`, `$NOTES` → `$notes`, `{api_key}` → `{api key}` (DATA_WORD sees words). */
function decodePlaceholder(s: string): string {
  return s
    .replace(/%[0-9a-f]{2}/gi, ' ')
    .replace(/[_{}<>$[\]]/g, ' ')
    .toLowerCase()
}

function urlFacts(text: string): QueryFacts {
  const out: QueryFacts = { query: false, placeholder: false, dataPlaceholder: false }
  for (const m of text.matchAll(URL_TOKEN)) {
    const end = m.index + m[0].length
    const f = queryFacts(m[0], text.slice(end, end + 256))
    out.query ||= f.query
    out.placeholder ||= f.placeholder
    if (f.dataPlaceholder) return { ...out, dataPlaceholder: true }
  }
  return out
}

function imageExfil(text: string): boolean {
  for (const m of text.matchAll(IMAGE_URL)) {
    const end = m.index + m[0].length
    const url = m[1]
    // Same rule as the URL scan, with the image class ([^\s)]) as the URL's extent.
    if (queryFacts(url, text.slice(end, end + 256)).placeholder) return true
  }
  return false
}
const EXFIL_VERB =
  /\b(append|add|attach|include|put|send|post|visit|open|fetch|load|encode)\b[^.\n]{0,80}\b(url|link|query|parameter|endpoint)\b|(url|링크|주소|쿼리)[^.\n]{0,40}(붙여|추가|넣어|포함)|(보내|전송|방문)/
const DATA_WORD = /\b(data|contents?|secrets?|tokens?|passwords?|api[\s_-]?keys?|credentials?|conversation|notes?|summary|email)\b|비밀|토큰|비밀번호|내용|데이터|대화|요약/

/** NFKC, lower case, invisibles removed, whitespace collapsed — what the phrase rules see. */
export function normalizeForScan(s: string): string {
  return s
    .normalize('NFKC')
    .replace(new RegExp(HIDDEN.source, 'g'), '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/** Sentence-ish pieces (period, line break, Korean sentence ends). */
function sentences(s: string): string[] {
  return s.split(/(?<=[.!?。])\s+|\n+|(?<=다\.)/).map((x) => x.trim()).filter(Boolean)
}

/** Rule ids that `text` matches, in INJECTION_RULES order (empty = nothing found). Pure. */
export function scanInjection(text: string): InjectionRule[] {
  if (!text) return []
  const hits = new Set<InjectionRule>()
  if (HIDDEN.test(text)) hits.add('hidden-chars')
  const raw = text.normalize('NFKC').replace(new RegExp(HIDDEN.source, 'g'), '')
  const norm = normalizeForScan(text)
  if (OVERRIDE_PHRASES.some((re) => re.test(norm))) hits.add('override-phrase')
  const lines = sentences(raw).map((x) => x.toLowerCase())
  const strong = lines.map(strongSign)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // a directive sign in this sentence, or a strong one (you must, from now on, "Assistant:") right next to it
    let directive: boolean | null = null
    const isDirective = () => (directive ??= strong[i] || !!strong[i - 1] || !!strong[i + 1] || ownSign(l))
    if (!hits.has('override-phrase')) {
      const n = l.replace(/\s+/g, ' ')
      if (GATED_OVERRIDE.some((re) => re.test(n)) && isDirective()) hits.add('override-phrase')
      // "너는 이제 …" is itself a second person: it needs a new role, or another sign besides itself
      else if (YOU_ARE_NOW_KO.test(n) && (ROLE_WORD.test(n) || !!strong[i - 1] || !!strong[i + 1] || ownSign(n.replace(YOU_ARE_NOW_KO, ' ')))) {
        hits.add('override-phrase')
      }
    }
    const agent = AGENT_CUE.test(l)
    if (agent && TOOL.test(l) && IMPERATIVE.test(l) && isDirective()) hits.add('tool-directive')
    if (agent && PERMISSION_TERM.test(l) && PERMISSION_VERB.test(l) && isDirective()) hits.add('permission-change')
    const u = urlFacts(l)
    // a placeholder that names data, or any placeholder in an image or a directive; a data word and a send verb
    // only in a directive (a write-up of an exfiltration case mentions all three)
    if (
      u.query &&
      (u.dataPlaceholder ||
        (u.placeholder && (IMAGE_IN.test(l) || isDirective())) ||
        (EXFIL_VERB.test(l) && DATA_WORD.test(l) && isDirective()))
    ) {
      hits.add('exfil-url')
    }
  }
  if (BASE64_BLOB.test(raw) || HEX_BLOB.test(raw)) hits.add('encoded-blob')
  if (imageExfil(raw)) hits.add('image-exfil')
  return INJECTION_RULES.filter((r) => hits.has(r))
}

/** `suspicious: injection-like (a, b)` or '' — the one-line MCP marker. */
export function suspiciousNote(rules: readonly string[]): string {
  return rules.length ? `suspicious: injection-like (${[...rules].join(', ')})` : ''
}
