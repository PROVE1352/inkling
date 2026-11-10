import type { Locale } from '../i18n'

/**
 * Text of Slack messages (docs/adr/1802-*, 1803-*). Channel posts use the server's DEFAULT_LOCALE
 * (a channel has no single reader); /inkling answers use the language of the linked person.
 * Every argument is already escaped for Slack mrkdwn by the caller (`esc`).
 */

/** Slack mrkdwn control characters: &, <, > (a title can then not form `<!channel>` or a link). */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** `<url|text>` when there is a link, else the bold text. */
export function linkOr(url: string | null, text: string): string {
  return url ? `*<${url}|${text.replace(/\|/g, '¦')}>*` : `*${text}*`
}

interface Dict {
  someone: string
  untitled: string
  via: (actor: string, client: string) => string
  mention: (actor: string, who: string, page: string) => string
  mentionInComment: (actor: string, who: string, page: string) => string
  assigned: (actor: string, who: string, page: string, field: string | null) => string
  suggestion: (actor: string, page: string, where: string | null) => string
  reply: (actor: string, page: string) => string
  digest: (pages: number, changes: number) => string
  more: (n: number) => string
  test: (workspace: string) => string
  help: string
  disabled: string
  notLinked: string
  notMember: string
  linkCode: (url: string) => string
  linkNoOrigin: string
  unlinked: string
  nothingToUnlink: string
  noResults: (q: string) => string
  results: (q: string) => string
  searchFailed: string
}

const en: Dict = {
  someone: 'Someone',
  untitled: 'Untitled',
  via: (a, c) => `${a} via ${c}`,
  mention: (a, w, p) => `${a} mentioned ${w} in ${p}`,
  mentionInComment: (a, w, p) => `${a} mentioned ${w} in a comment on ${p}`,
  assigned: (a, w, p, f) => `${a} assigned ${w} to ${p}${f ? ` (${f})` : ''}`,
  suggestion: (a, p, where) => `${a} suggested an edit to ${p}${where ? ` (${where})` : ''}, waiting for review`,
  reply: (a, p) => `${a} replied in a comment thread on ${p}`,
  digest: (n, c) => `${n} shared page${n === 1 ? '' : 's'} changed in the last day (${c} change${c === 1 ? '' : 's'})`,
  more: (n) => `and ${n} more`,
  test: (w) => `Inkling is connected to this channel. Updates from the workspace "${w}" will appear here.`,
  help:
    '*/inkling <words>* searches your Inkling notes; only you see the answer.\n' +
    '*/inkling link* links your Slack account to your Inkling account (when your email addresses differ).\n' +
    '*/inkling unlink* removes the link.',
  disabled: 'The Inkling app is turned off for this workspace.',
  notLinked:
    'Your Slack account is not linked to an Inkling account yet, so there are no results. ' +
    'Type */inkling link* and open the link while signed in to Inkling. ' +
    '(Accounts with the same email address in Slack and Inkling are linked automatically.)',
  notMember: 'Your Inkling account is not a member of this workspace, so there are no results.',
  linkCode: (url) => `Open this link while signed in to Inkling to link your Slack account (valid for 10 minutes, once):\n${url}`,
  linkNoOrigin: 'Linking needs the Inkling address (PUBLIC_URL). Ask your Inkling admin to set it.',
  unlinked: 'Your Slack account is no longer linked to Inkling.',
  nothingToUnlink: 'Your Slack account was not linked.',
  noResults: (q) => `No notes found for “${q}”.`,
  results: (q) => `Notes for “${q}”:`,
  searchFailed: 'Search failed. Try again in a moment.',
}

const ko: Dict = {
  someone: '누군가',
  untitled: '제목 없음',
  via: (a, c) => `${a}(${c} 사용)`,
  mention: (a, w, p) => `${a}님이 ${p}에서 ${w}님을 언급했습니다`,
  mentionInComment: (a, w, p) => `${a}님이 ${p}의 댓글에서 ${w}님을 언급했습니다`,
  assigned: (a, w, p, f) => `${a}님이 ${p}${f ? `의 ${f}` : ''}에 ${w}님을 지정했습니다`,
  suggestion: (a, p, where) => `${a}님이 ${p}${where ? `(${where})` : ''}에 수정 제안을 남겼습니다. 검토를 기다리는 중입니다`,
  reply: (a, p) => `${a}님이 ${p}의 댓글 스레드에 답글을 달았습니다`,
  digest: (n, c) => `지난 하루 동안 공유 페이지 ${n}개가 바뀌었습니다(변경 ${c}건)`,
  more: (n) => `외 ${n}개`,
  test: (w) => `Inkling이 이 채널에 연결되었습니다. "${w}" 워크스페이스 소식이 여기에 올라옵니다.`,
  help:
    '*/inkling <검색어>* Inkling 노트를 찾습니다. 결과는 나에게만 보입니다.\n' +
    '*/inkling link* Slack 계정을 Inkling 계정에 연결합니다(이메일 주소가 다를 때).\n' +
    '*/inkling unlink* 연결을 끊습니다.',
  disabled: '이 워크스페이스에서는 Inkling 앱이 꺼져 있습니다.',
  notLinked:
    'Slack 계정이 아직 Inkling 계정에 연결되지 않아 결과를 보여 드릴 수 없습니다. ' +
    '*/inkling link*를 입력한 뒤, Inkling에 로그인한 상태로 링크를 여세요. ' +
    '(Slack과 Inkling의 이메일 주소가 같으면 자동으로 연결됩니다.)',
  notMember: '연결된 Inkling 계정이 이 워크스페이스의 멤버가 아니어서 결과를 보여 드릴 수 없습니다.',
  linkCode: (url) => `Inkling에 로그인한 상태로 이 링크를 열면 Slack 계정이 연결됩니다(10분 동안 한 번만 쓸 수 있습니다):\n${url}`,
  linkNoOrigin: '계정을 연결하려면 Inkling 주소(PUBLIC_URL)가 필요합니다. Inkling 관리자에게 설정을 요청하세요.',
  unlinked: 'Slack 계정과 Inkling의 연결을 끊었습니다.',
  nothingToUnlink: '연결된 Slack 계정이 없습니다.',
  noResults: (q) => `“${q}”에 맞는 노트가 없습니다.`,
  results: (q) => `“${q}” 검색 결과:`,
  searchFailed: '검색에 실패했습니다. 잠시 후 다시 해 보세요.',
}

export function slackText(locale: Locale): Dict {
  return locale === 'ko' ? ko : en
}
