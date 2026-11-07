/**
 * Link → embed conversion for the editor's embed block (client side, no server fetch).
 *
 * Security model (see docs/adr/0501-embed-providers-and-frame-src.md):
 *  - The input is parsed with `new URL`, the hostname must match a provider's exact host
 *    set, IDs are extracted with anchored, bounded character-class patterns, and the embed
 *    URL is CONSTRUCTED from those parts. The original query string is never passed through,
 *    so `https://evil.com/youtube.com/watch?v=…` or `https://youtube.com.evil.com/…` never match.
 *  - The editor stores only the user's original URL in the document; the iframe `src` is
 *    recomputed with `toEmbed()` at render time, so a collaborator cannot inject an arbitrary
 *    frame source through block props.
 *  - The server mirrors `EMBED_FRAME_ORIGINS` into the SPA's CSP `frame-src`.
 */

// packages/shared compiles without DOM/node libs; both runtimes provide the WHATWG URL global.
// This module-scoped declaration types only the members used here (no runtime emit).
export interface UrlLike {
  href: string
  protocol: string
  username: string
  password: string
  hostname: string
  port: string
  pathname: string
  hash: string
  searchParams: { get(name: string): string | null }
}
declare const URL: { new (input: string, base?: string): UrlLike }
type URL = UrlLike

export type EmbedProviderId =
  | 'youtube'
  | 'vimeo'
  | 'loom'
  | 'figma'
  | 'miro'
  | 'google-docs'
  | 'google-sheets'
  | 'google-slides'
  | 'gist'
  | 'codepen'
  | 'excalidraw'
  | 'spotify'

export interface EmbedInfo {
  provider: EmbedProviderId
  /** Human label, e.g. "YouTube". */
  label: string
  /** Constructed, canonical embed URL (always https). */
  src: string
  /** iframe `sandbox` tokens — the least privilege that still lets the player work. */
  sandbox: string
  /** iframe `allow` (Permissions Policy) value; '' when nothing is delegated. */
  allow: string
  /** Suggested frame height in px (width is always 100%). Ignored when `aspect` is set. */
  height: number
  /** When set, height follows width with this ratio (e.g. 16/9 for video). */
  aspect?: number
}

interface ProviderDef {
  id: EmbedProviderId
  label: string
  hosts: string[]
  sandbox: string
  allow: string
  height: number
  aspect?: number
  build: (u: URL) => string | null
}

// Common sandbox profiles. Third-party players are cross-origin, so allow-same-origin only
// lets them use THEIR own storage/cookies — it never grants access to the Inkling origin.
const SB_PLAYER = 'allow-scripts allow-same-origin allow-popups allow-presentation'
const SB_APP = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox'
const SB_STATIC = 'allow-popups allow-popups-to-escape-sandbox'

const ID11 = /^[A-Za-z0-9_-]{11}$/

function parseYouTubeStart(v: string | null): number | null {
  if (!v) return null
  if (/^\d{1,6}$/.test(v)) return Number(v)
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(v)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

function seg(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean)
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'],
    sandbox: SB_PLAYER,
    allow: 'encrypted-media; picture-in-picture; fullscreen',
    height: 360,
    aspect: 16 / 9,
    build: (u) => {
      const s = seg(u)
      let id: string | null = null
      if (u.hostname === 'youtu.be') id = s[0] ?? null
      else if (s[0] === 'watch' && s.length === 1) id = u.searchParams.get('v')
      else if (['shorts', 'embed', 'live', 'v'].includes(s[0] ?? '') && s.length === 2) id = s[1]
      const list = u.searchParams.get('list')
      if (!id && s[0] === 'playlist' && list && /^[A-Za-z0-9_-]{10,64}$/.test(list)) {
        return `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`
      }
      if (!id || !ID11.test(id)) return null
      const start = parseYouTubeStart(u.searchParams.get('t') ?? u.searchParams.get('start'))
      return `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`
    },
  },
  {
    id: 'vimeo',
    label: 'Vimeo',
    hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
    sandbox: SB_PLAYER,
    allow: 'encrypted-media; picture-in-picture; fullscreen',
    height: 360,
    aspect: 16 / 9,
    build: (u) => {
      const s = seg(u)
      let id: string | undefined
      let hash: string | null = u.searchParams.get('h')
      if (u.hostname === 'player.vimeo.com') {
        if (s[0] !== 'video') return null
        id = s[1]
      } else {
        // vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123
        const i = s.findIndex((p) => /^\d{1,12}$/.test(p))
        if (i < 0) return null
        id = s[i]
        if (!hash && s[i + 1] && /^[0-9a-f]{6,20}$/.test(s[i + 1])) hash = s[i + 1]
      }
      if (!id || !/^\d{1,12}$/.test(id)) return null
      const h = hash && /^[0-9a-f]{6,20}$/.test(hash) ? `?h=${hash}` : ''
      return `https://player.vimeo.com/video/${id}${h}`
    },
  },
  {
    id: 'loom',
    label: 'Loom',
    hosts: ['loom.com', 'www.loom.com'],
    sandbox: SB_PLAYER,
    allow: 'fullscreen',
    height: 360,
    aspect: 16 / 9,
    build: (u) => {
      const s = seg(u)
      if ((s[0] === 'share' || s[0] === 'embed') && s[1] && /^[0-9a-f]{32}$/.test(s[1])) {
        return `https://www.loom.com/embed/${s[1]}`
      }
      return null
    },
  },
  {
    id: 'figma',
    label: 'Figma',
    hosts: ['figma.com', 'www.figma.com'],
    sandbox: SB_APP,
    allow: 'fullscreen; clipboard-write',
    height: 450,
    build: (u) => {
      const s = seg(u)
      const kinds = ['file', 'design', 'proto', 'board', 'slides', 'deck']
      if (!kinds.includes(s[0] ?? '') || !s[1] || !/^[A-Za-z0-9]{10,64}$/.test(s[1])) return null
      const node = u.searchParams.get('node-id')
      const nodeQ = node && /^[0-9]{1,10}[-:][0-9]{1,10}$/.test(node) ? `?node-id=${node}` : ''
      const canonical = `https://www.figma.com/${s[0]}/${s[1]}${nodeQ}`
      return `https://www.figma.com/embed?embed_host=inkling&url=${encodeURIComponent(canonical)}`
    },
  },
  {
    id: 'miro',
    label: 'Miro',
    hosts: ['miro.com'],
    sandbox: SB_APP,
    allow: 'fullscreen; clipboard-read; clipboard-write',
    height: 450,
    build: (u) => {
      const s = seg(u)
      // miro.com/app/board/<id>/ and miro.com/app/live-embed/<id>/
      if (s[0] !== 'app' || (s[1] !== 'board' && s[1] !== 'live-embed')) return null
      const id = s[2]
      if (!id || !/^[A-Za-z0-9_=-]{8,40}$/.test(id)) return null
      return `https://miro.com/app/live-embed/${id}/`
    },
  },
  ...(['document', 'spreadsheets', 'presentation'] as const).map(
    (kind): ProviderDef => ({
      id: kind === 'document' ? 'google-docs' : kind === 'spreadsheets' ? 'google-sheets' : 'google-slides',
      label: kind === 'document' ? 'Google Docs' : kind === 'spreadsheets' ? 'Google Sheets' : 'Google Slides',
      hosts: ['docs.google.com'],
      sandbox: SB_APP,
      allow: 'fullscreen',
      height: kind === 'presentation' ? 360 : 500,
      aspect: kind === 'presentation' ? 16 / 9 : undefined,
      build: (u) => {
        const s = seg(u)
        if (s[0] !== kind || s[1] !== 'd') return null
        const ID = /^[A-Za-z0-9_-]{20,128}$/
        // Published-to-web links: /d/e/2PACX-…/pub
        if (s[2] === 'e' && s[3] && ID.test(s[3])) {
          const base = `https://docs.google.com/${kind}/d/e/${s[3]}`
          if (kind === 'document') return `${base}/pub?embedded=true`
          if (kind === 'spreadsheets') return `${base}/pubhtml?widget=true&headers=false`
          return `${base}/embed`
        }
        if (!s[2] || !ID.test(s[2])) return null
        const base = `https://docs.google.com/${kind}/d/${s[2]}`
        return kind === 'presentation' ? `${base}/embed` : `${base}/preview`
      },
    }),
  ),
  {
    id: 'gist',
    label: 'GitHub Gist',
    hosts: ['gist.github.com'],
    // The `.pibb` view is static HTML; Gist's official embed is a <script>, which we never load.
    sandbox: SB_STATIC,
    allow: '',
    height: 360,
    build: (u) => {
      const s = seg(u)
      if (s.length < 2) return null
      const user = s[0]
      const id = s[1].replace(/\.(js|pibb)$/, '')
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) return null
      if (!/^(?:[0-9a-f]{20,40}|\d{1,12})$/.test(id)) return null
      return `https://gist.github.com/${user}/${id}.pibb`
    },
  },
  {
    id: 'codepen',
    label: 'CodePen',
    hosts: ['codepen.io'],
    sandbox: SB_APP,
    allow: 'fullscreen',
    height: 400,
    build: (u) => {
      const s = seg(u)
      // codepen.io/<user>/(pen|full|details|embed)/<id>
      if (s.length < 3 || !['pen', 'full', 'details', 'embed'].includes(s[1])) return null
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(s[0]) || !/^[A-Za-z0-9]{3,16}$/.test(s[2])) return null
      return `https://codepen.io/${s[0]}/embed/${s[2]}?default-tab=result`
    },
  },
  {
    id: 'excalidraw',
    label: 'Excalidraw',
    hosts: ['excalidraw.com'],
    sandbox: SB_APP,
    allow: 'fullscreen; clipboard-write',
    height: 450,
    build: (u) => {
      // Shareable (read-only snapshot) link: https://excalidraw.com/#json=<id>,<key>
      // Live-collaboration room links (#room=) are intentionally not embedded.
      if (seg(u).length !== 0) return null
      const m = /^#json=([A-Za-z0-9_-]{8,64}),([A-Za-z0-9_-]{8,64})$/.exec(u.hash)
      if (!m) return null
      return `https://excalidraw.com/#json=${m[1]},${m[2]}`
    },
  },
  {
    id: 'spotify',
    label: 'Spotify',
    hosts: ['open.spotify.com'],
    sandbox: SB_APP,
    allow: 'encrypted-media; clipboard-write; fullscreen; picture-in-picture',
    height: 352,
    build: (u) => {
      let s = seg(u)
      if (s[0] && /^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(s[0])) s = s.slice(1)
      if (s[0] === 'embed') s = s.slice(1)
      const types = ['track', 'album', 'playlist', 'episode', 'show', 'artist']
      if (!types.includes(s[0] ?? '') || !s[1] || !/^[A-Za-z0-9]{22}$/.test(s[1])) return null
      return `https://open.spotify.com/embed/${s[0]}/${s[1]}`
    },
  },
]

/** Origins the SPA must allow in CSP `frame-src` for the providers above. */
export const EMBED_FRAME_ORIGINS: readonly string[] = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.loom.com',
  'https://www.figma.com',
  'https://embed.figma.com',
  'https://miro.com',
  'https://docs.google.com',
  'https://gist.github.com',
  'https://codepen.io',
  'https://excalidraw.com',
  'https://open.spotify.com',
]

/** Provider labels for UI (e.g. "Supported: YouTube, Vimeo, …"). */
export const EMBED_PROVIDER_LABELS: readonly string[] = PROVIDERS.map((p) => p.label)

const MAX_URL_LEN = 2048

/** Parse an absolute http(s) URL; null for anything else. */
export function parseHttpUrl(raw: string): URL | null {
  const t = raw.trim()
  if (!t || t.length > MAX_URL_LEN || /\s/.test(t)) return null
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  return u
}

/** Convert a pasted link into a provider embed, or null if it is not a supported embed. */
export function toEmbed(raw: string): EmbedInfo | null {
  const u = parseHttpUrl(raw)
  if (!u) return null
  if (u.port && u.port !== '443' && u.port !== '80') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  for (const p of PROVIDERS) {
    if (!p.hosts.includes(host)) continue
    const src = p.build(u)
    if (!src) continue
    return {
      provider: p.id,
      label: p.label,
      src,
      sandbox: p.sandbox,
      allow: p.allow,
      height: p.height,
      aspect: p.aspect,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Link preview / webhook DTOs (server ↔ web)
// ---------------------------------------------------------------------------

/** GET /api/link-preview?url= */
export interface LinkPreviewDTO {
  /** Final URL after redirects (http/https). */
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  /** https image URL or null. Rendered with referrerpolicy=no-referrer, never proxied. */
  image: string | null
  /** https favicon URL or null. */
  favicon: string | null
}

export type WebhookKind = 'slack' | 'discord'
/** review_due: a once-a-day digest of documents past their review date (docs/adr/0952-*). */
export type WebhookEvent = 'mention' | 'comment' | 'reminder' | 'page_created' | 'review_due'
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ['mention', 'comment', 'reminder', 'page_created', 'review_due']

export interface WebhookDTO {
  id: string
  kind: WebhookKind
  /** Masked URL — the secret path is never returned after creation. */
  urlMasked: string
  events: WebhookEvent[]
  enabled: boolean
  /** Set when the hook was disabled automatically after repeated delivery failures. */
  autoDisabledAt: string | null
  failureCount: number
  lastError: string | null
  lastSuccessAt: string | null
  createdAt: string
}
