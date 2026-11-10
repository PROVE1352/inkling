import { CLIP_MAX_TAG_LEN, CLIP_MAX_TAGS, CLIP_MAX_TEXT, CLIP_MAX_TITLE, CLIP_MAX_URL, CLIP_TAG_RE } from '@inkling/shared'

// What the /clip screen makes of its query (docs/adr/2263-*). Three senders fill it:
//  - the bookmarklet: title, url and the selected text, each in its own parameter;
//  - the installed app's share target (manifest share_target, GET title/text/url): Android Chrome
//    usually sends the page title as `title` (or `text`) and the link inside `text`, with `url` empty;
//    other apps send "Some headline https://…" as `text`, or only a URL;
//  - a person typing /clip?url=… by hand.
// The values are plain text: capped, control characters dropped, never parsed as markup.

export interface ClipQuery {
  title: string
  text: string
  url: string
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const URL_IN_TEXT = /https?:\/\/[^\s<>"'“”‘’]+/gi

/** Cut to `max` code points (never in the middle of a surrogate pair). */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s
  return Array.from(s).slice(0, max).join('')
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** An http(s) URL as the browser normalizes it, or '' (other schemes, credentials, over the cap). */
export function httpUrl(raw: string): string {
  const t = raw.trim()
  if (!t || t.length > CLIP_MAX_URL) return ''
  try {
    const u = new URL(t)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return ''
    return u.href.length <= CLIP_MAX_URL ? u.href : ''
  } catch {
    return ''
  }
}

/** Trailing punctuation that a sentence put after a link is not part of it. */
function trimLinkTail(u: string): string {
  return u.replace(/[).,;:!?。、，]+$/u, '')
}

export function normalizeClipQuery(params: URLSearchParams): ClipQuery {
  let title = oneLine(clean(params.get('title')))
  let text = clean(params.get('text')).trim()
  let url = httpUrl(clean(params.get('url')))

  // A link inside the text (share sheets): take the last one as the URL when none was given, and
  // drop it from the text.
  if (!url && text) {
    const found = [...text.matchAll(URL_IN_TEXT)].map((m) => trimLinkTail(m[0]))
    const last = found.length ? httpUrl(found[found.length - 1]) : ''
    if (last) {
      url = last
      const raw = found[found.length - 1]
      const at = text.lastIndexOf(raw)
      text = (text.slice(0, at) + text.slice(at + raw.length)).trim()
    }
  } else if (url && text) {
    // The URL repeated in the text adds nothing.
    text = text.split(url).join('').trim()
    if (url.endsWith('/')) text = text.split(url.slice(0, -1)).join('').trim()
  }
  // The title given as a URL is no title.
  if (title && httpUrl(title)) {
    if (!url) url = httpUrl(title)
    title = ''
  }
  // Only a short single line left in the text and no title: it was the title (Android puts it there).
  if (!title && text && !text.includes('\n') && text.length <= CLIP_MAX_TITLE) {
    title = oneLine(text)
    text = ''
  }
  // The text that repeats the title adds nothing either.
  if (title && oneLine(text) === title) text = ''
  return {
    title: cutText(title, CLIP_MAX_TITLE),
    text: cutText(text, CLIP_MAX_TEXT),
    url,
  }
}

/** Tags typed as "a, b #c": the valid ones (deduplicated, capped) and the ones that are not tags. */
export function parseClipTags(input: string): { tags: string[]; invalid: string[] } {
  const tags: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const raw of input.split(/[\s,]+/)) {
    const t = raw.replace(/^#/, '')
    if (!t) continue
    if (t.length > CLIP_MAX_TAG_LEN || !CLIP_TAG_RE.test(t)) {
      invalid.push(raw)
      continue
    }
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (tags.length < CLIP_MAX_TAGS) tags.push(t)
  }
  return { tags, invalid }
}

// ---------------------------------------------------------------------------
// Bookmarklet
// ---------------------------------------------------------------------------

/** Longest /clip URL the bookmarklet opens: under common proxy request-line limits (nginx: 8 KiB). */
export const BOOKMARKLET_MAX_URL = 6000

/**
 * The bookmarklet for this server: a `javascript:` link that opens `<origin>/clip?title&url&text` in
 * a small window with the tab's title, address and selected text. It holds no token or secret (the
 * /clip screen uses the browser's own session) and runs nothing from the server in the page.
 * A long selection is cut (by code points, ending with "…") until the address fits BOOKMARKLET_MAX_URL.
 */
export function buildBookmarklet(origin: string): string {
  const base = JSON.stringify(`${origin.replace(/\/+$/, '')}/clip?`)
  const code =
    `(function(){var d=document,w=window,e=encodeURIComponent,` +
    `s=String(w.getSelection?w.getSelection():'').trim(),u=String(location.href).slice(0,2048),` +
    `t=String(d.title||'').slice(0,300),b=${base},M=${BOOKMARKLET_MAX_URL};` +
    `function q(x){return b+'title='+e(t)+'&url='+e(u)+(x?'&text='+e(x):'')}` +
    `var a=Array.from(s),x=s;while(x&&q(x).length>M){a=a.slice(0,Math.floor(a.length*0.8));x=a.length?a.join('')+'\\u2026':''}` +
    `var h=q(x),p=w.open(h,'inklingClip','width=520,height=680');if(!p)location.href=h;else try{p.focus()}catch(_){}})();`
  return `javascript:${code}`
}
