import type { InjectionRule } from '@inkling/shared'
import { INJECTION_RULES } from '@inkling/shared'

/**
 * Deterministic prompt-injection heuristics (docs/adr/0977-*).
 *
 * A SIGNAL, never a block: matching text is still stored, indexed and returned; MCP output marks
 * the section `suspicious: injection-like (<rules>)`, the web app shows a small badge and the first
 * detection per page and rule is written to the audit log. The heuristics are easy to evade
 * (paraphrase, another language, splitting across sections) and can misfire on documents that talk
 * about prompt injection; the real boundaries are the edit lock, OAuth scopes and agent blocks.
 *
 * Computed once per section at indexing time (page_chunks.suspicious), never at read time. Bump
 * INJECTION_RULES_VERSION (it is folded into CHUNKER_VERSION) when a rule changes so the boot
 * backfill re-scans every page.
 */
export const INJECTION_RULES_VERSION = 1

// Invisible / bidi / tag characters (same sets as the MCP output sanitizer, ZWJ and VS16 excluded).
// eslint-disable-next-line no-misleading-character-class
const HIDDEN = /[\u202A-\u202E\u2066-\u2069\u061C\u200B\u200C\u200E\u200F\u2060-\u2064\u180E\uFEFF]|\uDB40[\uDC00-\uDC7F]/

/** Phrases that try to replace the agent's instructions (matched on normalised text). */
export const OVERRIDE_PHRASES: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b(\s+\w+){0,3}\s+(previous|prior|above|earlier|preceding|all|any|your|the)\s+(\w+\s+)?(instructions?|prompts?|rules|directions|guidelines|messages)\b/,
  /\b(reveal|print|show|repeat|output|leak|dump|ignore|override)\b(\s+\w+){0,3}\s+(your\s+|the\s+)?system\s+prompt\b/,
  /\byou\s+are\s+now\s+(an?\s+|the\s+)?(new\s+|different\s+|unrestricted\s+|jailbroken\s+)?(ai|assistant|agent|model|dan|chatbot)\b/,
  /\b(new|updated)\s+instructions\s*:/,
  /\b(developer|god|jailbreak)\s+mode\b/,
  /(이전|앞의|위의|기존|모든)\s*(의\s*)?(지시|지침|명령|프롬프트|규칙)(사항)?\s*(을|를|은|는)?\s*(모두\s*|전부\s*|다\s*)?(무시|잊어|잊고|따르지\s*마)/,
  /시스템\s*프롬프트\s*(를|을)?\s*(출력|보여|공개|알려|무시|유출|반복)/,
  /(너는|당신은|넌)\s*(이제|지금부터)/,
  /새로운\s*(지시|지침|명령)\s*:/,
]

const TOOL_NAMES =
  'patch_section|update_page|trash_page|move_page|rename_page|create_page|import_folder|update_row|create_row|' +
  'add_comment|create_from_template|get_instructions|read_page|read_pages|find_context|changes_since|query_rows'
const TOOL = new RegExp(`\\b(${TOOL_NAMES})\\b`)
/** Sentence addresses an AI agent. */
const AGENT_CUE =
  /\b(ai|assistant|agent|agents|llm|model|claude|chatgpt|gpt|copilot|you\s+must|you\s+should|you\s+will|please\s+now)\b|에이전트|어시스턴트|인공지능|ai는|너는|당신은|반드시/
const IMPERATIVE = /\b(call|run|invoke|execute|use|trigger|must|immediately)\b|호출|실행|사용해|하라|해라|하세요|할\s*것/
const PERMISSION_TERM = /\b(permissions?|roles?|admin|administrator|owner|lock|locks|access|scope|token)\b|권한|관리자|소유자|잠금|역할|토큰/
const PERMISSION_VERB = /\b(grant|give|make|change|remove|disable|unlock|elevate|promote|add)\b|부여|변경|해제|풀어|올려|추가해|바꿔/

const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/
const HEX_BLOB = /\b[0-9a-fA-F]{128,}\b/

const URL_WITH_QUERY = /https?:\/\/[^\s)>\]"']+\?[^\s)>\]"']*=/i
/** A query value that is a placeholder for data the agent should fill in. */
const PLACEHOLDER_VALUE = /https?:\/\/[^\s)>\]"']+\?[^\s)>\]"']*=\s*(\{|<|\$|\[|%7b|%3c|%24|%s\b)/i
const EXFIL_VERB =
  /\b(append|add|attach|include|put|send|post|visit|open|fetch|load|encode)\b[^.\n]{0,80}\b(url|link|query|parameter|endpoint)\b|(url|링크|주소|쿼리)[^.\n]{0,40}(붙여|추가|넣어|포함)|(보내|전송|방문)/
const DATA_WORD = /\b(data|contents?|secrets?|tokens?|passwords?|api[\s_-]?keys?|credentials?|conversation|notes?|summary|email)\b|비밀|토큰|비밀번호|내용|데이터|대화|요약/
const IMAGE_EXFIL = /!\[[^\]]*\]\(\s*https?:\/\/[^\s)]+\?[^\s)]*=\s*(\{|<|\$|\[|%7b|%3c|%24|%s\b)/i

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
  for (const line of sentences(raw)) {
    const l = line.toLowerCase()
    const agent = AGENT_CUE.test(l)
    if (agent && TOOL.test(l) && IMPERATIVE.test(l)) hits.add('tool-directive')
    if (agent && PERMISSION_TERM.test(l) && PERMISSION_VERB.test(l)) hits.add('permission-change')
    if (URL_WITH_QUERY.test(l) && (PLACEHOLDER_VALUE.test(l) || (EXFIL_VERB.test(l) && DATA_WORD.test(l)))) hits.add('exfil-url')
  }
  if (BASE64_BLOB.test(raw) || HEX_BLOB.test(raw)) hits.add('encoded-blob')
  if (IMAGE_EXFIL.test(raw)) hits.add('image-exfil')
  return INJECTION_RULES.filter((r) => hits.has(r))
}

/** `suspicious: injection-like (a, b)` or '' — the one-line MCP marker. */
export function suspiciousNote(rules: readonly string[]): string {
  return rules.length ? `suspicious: injection-like (${[...rules].join(', ')})` : ''
}
