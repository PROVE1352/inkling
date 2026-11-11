import {
  replaceEqualDeep,
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import {
  patchItems,
  patchRowProps,
  revertItems,
  revertRowProps,
  type FieldUndo,
} from './lib/optimistic'
import { useParams } from 'react-router'
import { adoptUserLocale, getLocale, setServerDefaultLocale, t, type Locale } from './i18n'
import { localizeApiError } from './i18n/errors'
import { noteServerBuild } from './lib/update'
import * as offline from './lib/offline/runtime'
import { dropPushSubscriptionHere } from './lib/push'
import type {
  AdminUserDTO,
  ApiErrorBody,
  AuthModeDTO,
  ChangePasswordInput,
  ForgotPasswordInput,
  IpBansResponseDTO,
  ManualBanInput,
  ResetPasswordInput,
  ResetRequestDTO,
  SendCredentialMailInput,
  BookmarkDTO,
  CalendarEventDTO,
  DueResponseDTO,
  QuickTaskInput,
  CollectionDTO,
  CreateSignupKeyInput,
  CollectionField,
  CollectionViewDTO,
  CommentDTO,
  CreateCommentInput,
  CreatePageInput,
  CreateTemplateInput,
  CreateWorkspaceInput,
  FileDTO,
  InkDTO,
  InkStroke,
  InvitePreviewDTO,
  JoinWorkspaceInput,
  LoginInput,
  MemberCandidateDTO,
  MemberDTO,
  NotificationDTO,
  PageKind,
  PageMetaDTO,
  PublicPageDTO,
  RegisterInput,
  RowDTO,
  ShareStatusDTO,
  SnapshotDTO,
  TagCountDTO,
  TemplateDTO,
  UpdatePageInput,
  SidebarPrefsDTO,
  SignupKeyDTO,
  UserDTO,
  ViewConfig,
  ViewType,
  WorkspaceDTO,
  WorkspaceRole,
  DeletedWorkspaceDTO,
  WorkspaceDeletePreviewDTO,
} from '@inkling/shared'

// Extension fields the server adds without changing the shared DTOs (docs/adr/0901-*).
/** /auth/me: the user's saved UI language (null = follow the server/browser default) and sidebar menus (docs/adr/1020-*). */
export type MeDTO = UserDTO & { locale?: Locale | null; sidebar?: SidebarPrefsDTO; twoFactor?: boolean }
/** /auth/mode: DEFAULT_LOCALE when the operator set one. */
export type AuthModeExtDTO = AuthModeDTO & { defaultLocale?: Locale | null }

// Collection query response bundle
// refs: visible rows linked by relation cells (server-filtered) — see lib/collectionApi.ts
export type CollectionBundle = {
  collection: CollectionDTO
  rows: RowDTO[]
  refs?: Record<string, import('@inkling/shared').RowRefDTO>
  /** guests only (0.17, docs/adr/2146-*): names of the people in the rows' person cells */
  people?: Record<string, string>
}

// Search result — the server adds a body-match snippet to PageMetaDTO as an extra field (shared stays unchanged).
export type SearchResult = PageMetaDTO & { snippet?: string }

// Graph API response (GET /api/workspaces/:id/graph)
export interface GraphNodeDTO {
  id: string
  title: string
  icon: string | null
  kind: PageKind
  /** Parent page id (null at the root) — for top-level folder group colours */
  parentId?: string | null
  links: number
}
export interface GraphEdgeDTO {
  source: string
  target: string
}
export interface GraphDTO {
  nodes: GraphNodeDTO[]
  edges: GraphEdgeDTO[]
  /** #tags per page (absent on older servers) */
  tags?: { pageId: string; tag: string }[]
}

/** GET /workspaces/:id/graph/islands (docs/adr/1123-*): link islands and unlinked pages for this viewer. */
export interface GraphIslandsDTO {
  pages: number
  links: number
  islands: { size: number; hub: { id: string; title: string }; pageIds: string[] }[]
  unlinked: { id: string; title: string; icon: string | null; kind: PageMetaDTO['kind']; updatedAt: string }[]
  unlinkedTotal: number
}

// ---------------------------------------------------------------------------
// Low-level fetch wrapper
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number
  code: string
  /** Extra fields of the `error` object besides code/message (e.g. SOLE_OWNER `workspaces`). */
  details: Record<string, unknown>
  /** The server's original (English) message; `message` is the localized text. */
  serverMessage = ''
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function parseError(res: Response): Promise<ApiError> {
  let code = 'INTERNAL'
  let message = ''
  let details: Record<string, unknown> = {}
  try {
    const body = (await res.json()) as ApiErrorBody
    if (body?.error?.code) {
      const { code: c, message: m, ...rest } = body.error as ApiErrorBody['error'] & Record<string, unknown>
      code = c
      message = m
      details = rest
    }
  } catch {
    // Body did not parse: keep code 'INTERNAL'
  }
  // The server's message is English; show it localized (docs/adr/0902-*). The raw text stays on
  // `serverMessage` for logs and for callers that match on it.
  const err = new ApiError(res.status, code, localizeApiError(code, message, details), details)
  err.serverMessage = message
  return err
}

/** Fired on window when any API call answers 403 TWO_FACTOR_REQUIRED (detail: { workspaceId }). */
export const TWO_FACTOR_REQUIRED_EVENT = 'inkling:two-factor-required'

/**
 * A request that got no answer at all (offline, server unreachable). Still a TypeError like fetch's own
 * failure, so `offline.isNetworkError` and the offline fallbacks keep working, but its message is the
 * localized "no connection" text every screen shows as is (docs/adr/2321-*).
 */
export class OfflineError extends TypeError {
  constructor(cause?: unknown) {
    super(t('offline.noConnection'), { cause })
    this.name = 'OfflineError'
  }
  /** `String(err)` is the message alone, for screens that print unknown errors that way. */
  override toString(): string {
    return this.message
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // The UI language, so server-generated content (templates, default titles) matches it.
        'Accept-Language': getLocale(),
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
    })
  } catch (err) {
    // fetch rejects with a TypeError only when there is no answer; an abort stays an AbortError
    if (err instanceof TypeError) throw new OfflineError(err)
    throw err
  }
  noteServerBuild(res.headers) // X-Inkling-Build vs this bundle (lib/update.ts, docs/adr/0991-*)
  if (!res.ok) {
    const err = await parseError(res)
    // The server no longer knows this session (expired, "log out everywhere", password change):
    // this device's offline copies go with it (docs/adr/2203-*).
    if (err.status === 401 && err.code === 'UNAUTHORIZED') void offline.wipeOffline()
    // A workspace started requiring two-step verification (docs/adr/1112-*): the layout refetches
    // the workspace list and shows the setup screen instead of a trail of failed requests.
    if (err.code === 'TWO_FACTOR_REQUIRED' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(TWO_FACTOR_REQUIRED_EVENT, { detail: err.details }))
    }
    // Not agreed to this server's current terms (LEGAL_DIR): components/legal reloads /auth/me (CONSENT_REQUIRED_EVENT).
    if (err.code === 'CONSENT_REQUIRED' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('inkling:consent-required'))
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Conditional GET for polled queries (docs/adr/0707-polling-conditional-get.md)
// ---------------------------------------------------------------------------
// The server answers GET JSON with an ETag (apps/server/src/httpCache.ts). For polled queries
// we revalidate with If-None-Match and, on 304, hand React Query back the exact object it
// already holds: no body transfer, no JSON.parse, no structural-sharing walk, no re-render.
// The ETag is remembered per data object (WeakMap) — never per URL — so it only applies while
// the cache still holds the data that came with it: data replaced by setQueryData / optimistic
// updates has no ETag and gets a full fetch. No extra copy of the data is retained.
const etagOf = new WeakMap<object, string>()

function rememberEtag(data: unknown, etag: string | null | undefined) {
  if (etag && data !== null && typeof data === 'object') etagOf.set(data, etag)
}

/**
 * Query options for a polled GET endpoint. `pick` maps the response body to the cached value
 * (e.g. `r => r.comments`).
 */
export function pollingQuery<TRaw, T = TRaw>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  url: string,
  pick?: (raw: TRaw) => T,
) {
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<T> => {
      const prev = queryClient.getQueryData<T>(queryKey)
      const etag = prev !== null && typeof prev === 'object' ? etagOf.get(prev) : undefined
      const res = await fetch(url, {
        credentials: 'same-origin',
        // we do the revalidation ourselves; the HTTP cache would hide the 304 from us
        cache: 'no-store',
        signal,
        headers: etag ? { 'If-None-Match': etag } : undefined,
      })
      noteServerBuild(res.headers) // idle tabs mostly poll: check before the 304 early return
      if (res.status === 304 && prev !== undefined) return prev
      if (!res.ok) throw await parseError(res)
      const raw = (await res.json()) as TRaw
      const data = pick ? pick(raw) : (raw as unknown as T)
      rememberEtag(data, res.headers.get('etag'))
      return data
    },
    // Keep the ETag attached to whatever object React Query ends up storing.
    structuralSharing: (oldData: unknown, newData: unknown) => {
      const out = replaceEqualDeep(oldData, newData)
      if (out !== newData && newData !== null && typeof newData === 'object') {
        rememberEtag(out, etagOf.get(newData))
      }
      return out
    },
  }
}

function jsonBody(data: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(data) }
}

// ---------------------------------------------------------------------------
// File upload (multipart — not the JSON wrapper)
// ---------------------------------------------------------------------------

export async function uploadFile(
  wsId: string,
  file: File,
  pageId?: string,
): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  // With pageId the server links files.pageId, protecting attachments of private pages.
  const qs = `workspaceId=${encodeURIComponent(wsId)}${
    pageId ? `&pageId=${encodeURIComponent(pageId)}` : ''
  }`
  const res = await fetch(`/api/files?${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  })
  if (!res.ok) throw await parseError(res)
  const body = (await res.json()) as { file: FileDTO }
  return body.file.url
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const qk = {
  me: ['me'] as const,
  authMode: ['authMode'] as const,
  signupKeys: ['admin', 'signupKeys'] as const,
  adminUsers: ['admin', 'users'] as const,
  resetRequests: ['admin', 'resetRequests'] as const,
  ipBans: ['admin', 'ipBans'] as const,
  workspaces: ['workspaces'] as const,
  deletedWorkspaces: ['workspaces', 'deleted'] as const,
  deletePreview: (wsId: string) => ['deletePreview', wsId] as const,
  pages: (wsId: string) => ['pages', wsId] as const,
  members: (wsId: string) => ['members', wsId] as const,
  backlinks: (pageId: string) => ['backlinks', pageId] as const,
  search: (wsId: string, q: string) => ['search', wsId, q] as const,
  graph: (wsId: string) => ['graph', wsId] as const,
  trash: (wsId: string) => ['trash', wsId] as const,
  collection: (pageId: string) => ['collection', pageId] as const,
  invitePreview: (code: string) => ['invitePreview', code] as const,
  snapshots: (pageId: string) => ['snapshots', pageId] as const,
  snapshotPreview: (pageId: string, sid: string) =>
    ['snapshotPreview', pageId, sid] as const,
  bookmarks: (wsId: string) => ['bookmarks', wsId] as const,
  tags: (wsId: string) => ['tags', wsId] as const,
  tagPages: (wsId: string, tag: string) => ['tagPages', wsId, tag] as const,
  unlinked: (pageId: string) => ['unlinked', pageId] as const,
  comments: (pageId: string) => ['comments', pageId] as const,
  // Ink layer (pen annotations) — stored separately from the body
  ink: (pageId: string) => ['ink', pageId] as const,
  notifications: ['notifications'] as const,
  // Due view (all sections) — the sidebar badge reuses the same query
  due: (wsId: string) => ['due', wsId] as const,
  // Workspace-wide calendar — aggregated per [from, to] date range (month-grid overflow days, week view)
  calendar: (wsId: string, from: string, to: string) => ['calendar', wsId, from, to] as const,
  // M12 page templates — built-ins + workspace custom
  templates: (wsId: string) => ['templates', wsId] as const,
  // M15 public sharing
  share: (pageId: string) => ['share', pageId] as const,
  publicPage: (token: string) => ['public', token] as const,
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: () =>
      api<{ user: MeDTO }>('/api/auth/me').then(
        (r) => {
          adoptUserLocale(r.user.locale)
          offline.noteServerAnswered()
          void offline.adoptUser(r.user)
          return r.user
        },
        // No answer at all (offline, server down): start from what this device kept, if anything
        // (docs/adr/2202-*). A 401 stays an error: RequireAuth sends it to /login.
        async (err: unknown) => {
          if (offline.isNetworkError(err)) {
            const kept = await offline.deviceMe<MeDTO>()
            if (kept) return kept
          }
          throw err
        },
      ),
    staleTime: 60_000,
    retry: false,
  })
}

// Auth mode. The sign-in/sign-up screens branch their UI on it.
//   delegated / delegatedName — sign-in with an external account id is also allowed (one-way), and its display name
//   signupKeyRequired         — sign-up needs Inkling's own sign-up key
//   mailEnabled               — SMTP configured (mail sending, email verification)
// Server settings that don't change after deploy, so cached for a long time.
export function useAuthMode() {
  return useQuery({
    queryKey: qk.authMode,
    queryFn: () =>
      api<AuthModeExtDTO>('/api/auth/mode').then((m) => {
        setServerDefaultLocale(m.defaultLocale)
        return m
      }),
    staleTime: Infinity,
    retry: false,
  })
}

/**
 * Days an owner can restore a deleted workspace: the server's WORKSPACE_RESTORE_DAYS when it set one
 * (restricted mode, docs/adr/2500-*), else 30 as always.
 */
export function useWorkspaceRestoreDays(): number {
  return useAuthMode().data?.workspaceRestoreDays ?? 30
}

const fetchWorkspaces = () =>
  api<{ workspaces: WorkspaceDTO[] }>('/api/workspaces').then(
    (r) => {
      // kept for an offline start; copies of workspaces no longer listed are deleted (docs/adr/2202-*)
      void offline.saveSnapshot('workspaces', r.workspaces)
      void offline.sweepWorkspaces(new Set(r.workspaces.map((w) => w.id)))
      return r.workspaces
    },
    async (err: unknown) => {
      if (offline.isNetworkError(err)) {
        const kept = await offline.deviceSnapshot<WorkspaceDTO[]>('workspaces')
        if (kept) return kept
      }
      throw err
    },
  )

export function useWorkspaces() {
  return useQuery({
    queryKey: qk.workspaces,
    queryFn: fetchWorkspaces,
  })
}

/**
 * False while the caller is a guest of the workspace (docs/adr/1252-*): a guest only has the pages
 * shared with them, and the server answers 403 to the workspace-wide and member-only routes, so
 * those queries stay off. Without `wsId` it reads the route's :wsId; outside a workspace route
 * (public pages) it is always true and fetches nothing. Waits for the workspace list.
 */
export function useMemberScope(wsId?: string): boolean {
  const params = useParams()
  const id = wsId || params.wsId || ''
  const { data } = useQuery({ queryKey: qk.workspaces, queryFn: fetchWorkspaces, enabled: !!id })
  if (!id) return true
  if (!data) return false
  return data.find((w) => w.id === id)?.role !== 'guest'
}

export function usePages(wsId: string) {
  const queryClient = useQueryClient()
  const polled = pollingQuery<{ pages: PageMetaDTO[] }, PageMetaDTO[]>(
    queryClient,
    qk.pages(wsId),
    `/api/workspaces/${wsId}/pages`,
    (r) => r.pages,
  )
  return useQuery({
    ...polled,
    // The tree is kept for an offline start; copies of pages it no longer lists are checked
    // (trashed: unsent edits kept for recovery; no access: deleted) — docs/adr/2202-*.
    queryFn: (ctx: { signal: AbortSignal }) =>
      polled.queryFn(ctx).then(
        (pages) => {
          offline.noteServerAnswered()
          void offline.saveSnapshot(`pages:${wsId}`, pages)
          void offline.sweepWorkspace(wsId, new Set(pages.map((p) => p.id)), offline.pageStillThere)
          return pages
        },
        async (err: unknown) => {
          if (offline.isNetworkError(err)) {
            const kept = queryClient.getQueryData<PageMetaDTO[]>(qk.pages(wsId)) ?? (await offline.deviceSnapshot<PageMetaDTO[]>(`pages:${wsId}`))
            if (kept) return kept
          }
          throw err
        },
      ),
    enabled: !!wsId,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  })
}

export function useMembers(wsId: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.members(wsId),
    queryFn: () =>
      api<{ members: MemberDTO[] }>(`/api/workspaces/${wsId}/members`).then(
        (r) => r.members,
      ),
    enabled: !!wsId && member,
  })
}

// Search sign-ups who are not members yet (candidates to add) — only when q is set.
export function useMemberCandidates(wsId: string, q: string) {
  return useQuery({
    queryKey: ['memberCandidates', wsId, q] as const,
    queryFn: () =>
      api<{ candidates: MemberCandidateDTO[] }>(
        `/api/workspaces/${wsId}/member-candidates?q=${encodeURIComponent(q)}`,
      ).then((r) => r.candidates),
    enabled: !!wsId && q.length > 0,
    staleTime: 10_000,
  })
}

// Unlinked mentions (M12) — visible pages whose title/alias is mentioned in the body but not linked to this page.
// Fetched only when the section is open (enabled), to avoid needless requests.
export function useUnlinked(pageId: string | undefined, enabled: boolean) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qk.unlinked(pageId ?? ''),
    queryFn: () =>
      api<{ pages: PageMetaDTO[] }>(`/api/pages/${pageId}/unlinked`).then((r) => r.pages),
    enabled: !!pageId && enabled && member,
    staleTime: 30_000,
  })
}

/** Backlinks response: sources, and the headings their section links name (docs/adr/2101-*). */
export type BacklinksResponse = {
  pages: PageMetaDTO[]
  sections?: Record<string, { heading: string; status: 'found' | 'renamed' | 'missing' }[]>
}
const backlinksQuery = (pageId: string | undefined) => ({
  queryKey: qk.backlinks(pageId ?? ''),
  queryFn: () => api<BacklinksResponse>(`/api/pages/${pageId}/backlinks`),
  enabled: !!pageId,
  staleTime: 30_000,
})

// Pages pointing at me (backlinks)
export function useBacklinks(pageId: string | undefined) {
  return useQuery({ ...backlinksQuery(pageId), select: (r: BacklinksResponse) => r.pages })
}

/** Per source page: the headings of this page its section links point to (same request as useBacklinks). */
export function useBacklinkSections(pageId: string | undefined) {
  return useQuery({ ...backlinksQuery(pageId), select: (r: BacklinksResponse) => r.sections ?? {} })
}

// Title + full-text body search (body matches come with a snippet)
export function useSearch(wsId: string, q: string) {
  const member = useMemberScope(wsId)
  const query = q.trim()
  return useQuery({
    queryKey: qk.search(wsId, query),
    queryFn: () =>
      api<{ pages: SearchResult[] }>(
        `/api/workspaces/${wsId}/search?q=${encodeURIComponent(query)}`,
      ).then((r) => r.pages),
    enabled: !!wsId && query.length > 0 && member,
    staleTime: 10_000,
  })
}

// Workspace knowledge graph (nodes = pages, edges = wiki links)
export function useGraph(wsId: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.graph(wsId),
    queryFn: () => api<GraphDTO>(`/api/workspaces/${wsId}/graph`),
    enabled: !!wsId && member,
    staleTime: 15_000,
  })
}

/** Unlinked pages and link islands (graph settings panel); the server answers 304 while the graph is unchanged. */
export function useGraphIslands(wsId: string, enabled = true) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: [...qk.graph(wsId), 'islands'] as const,
    queryFn: () => api<GraphIslandsDTO>(`/api/workspaces/${wsId}/graph/islands`),
    enabled: !!wsId && enabled && member,
    staleTime: 15_000,
  })
}

// Trash (fetched only while the modal is open)
export function useTrash(wsId: string, enabled: boolean) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.trash(wsId),
    queryFn: () =>
      api<{ pages: PageMetaDTO[] }>(`/api/workspaces/${wsId}/trash`).then((r) => r.pages),
    enabled: !!wsId && enabled && member,
  })
}

// Invite link preview — looks up only the workspace name/member count by code (for the confirm card before joining).
// An unknown code is 404 INVALID_CODE → JoinWorkspace shows an error card, so no retry.
export function useInvitePreview(code: string) {
  return useQuery({
    queryKey: qk.invitePreview(code),
    queryFn: () =>
      api<InvitePreviewDTO>(
        `/api/workspaces/invite-preview?code=${encodeURIComponent(code)}`,
      ),
    enabled: !!code,
    retry: false,
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// M11 bookmarks · global tag index
// ---------------------------------------------------------------------------

// My bookmarks limited to live + visible pages of this workspace (sortOrder asc).
export function useBookmarks(wsId: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.bookmarks(wsId),
    queryFn: () =>
      api<{ bookmarks: BookmarkDTO[] }>(`/api/workspaces/${wsId}/bookmarks`).then(
        (r) => r.bookmarks,
      ),
    enabled: !!wsId && member,
    staleTime: 10_000,
  })
}

// Count per tag in the workspace (count desc → name asc).
export function useTags(wsId: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.tags(wsId),
    queryFn: () =>
      api<{ tags: TagCountDTO[] }>(`/api/workspaces/${wsId}/tags`).then((r) => r.tags),
    enabled: !!wsId && member,
    staleTime: 15_000,
  })
}

// Visible pages carrying a given tag.
export function useTagPages(wsId: string, tag: string | undefined) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.tagPages(wsId, tag ?? ''),
    queryFn: () =>
      api<{ pages: PageMetaDTO[] }>(
        `/api/workspaces/${wsId}/tags/${encodeURIComponent(tag!)}/pages`,
      ).then((r) => r.pages),
    enabled: !!wsId && !!tag && member,
    staleTime: 15_000,
  })
}

// Due view — rows (due-like date fields), page date properties and tasks in documents, grouped into sections
// (overdue/today/tomorrow/this week/next 30 days/done). Server GET /workspaces/:id/due. The sidebar badge (overdue + today) uses this query too.
export function useDue(wsId: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.due(wsId),
    queryFn: () => api<DueResponseDTO>(`/api/workspaces/${wsId}/due`),
    enabled: !!wsId && member,
    staleTime: 30_000,
  })
}

// Global calendar — date items in [from, to] (YYYY-MM-DD, at most 62 days): every date field of rows, page date
// properties, daily notes, tasks in documents. Server GET /workspaces/:id/calendar?from=&to=. visibleTo applies.
export function useCalendar(wsId: string, from: string, to: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.calendar(wsId, from, to),
    queryFn: () =>
      api<{ events: CalendarEventDTO[] }>(
        `/api/workspaces/${wsId}/calendar?from=${from}&to=${to}`,
      ).then((r) => r.events),
    enabled: !!wsId && !!from && !!to && member,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

// Quick task add — appends `- [ ] title 📅 date` to the workspace's task document (the server finds or creates it).
export function useQuickTask(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: QuickTaskInput) =>
      api<{ ok: true; pageId: string; blockId: string | null }>(
        `/api/workspaces/${wsId}/tasks`,
        jsonBody(input),
      ),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['calendar', wsId] })
      qc.invalidateQueries({ queryKey: qk.due(wsId) })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

// Bookmark toggle. The server returns only { bookmarked }, so the list is updated optimistically.
// Takes the full page meta as variables so a BookmarkDTO can be built on the spot when turning it on.
export function useToggleBookmark(wsId: string) {
  const qc = useQueryClient()
  const key = qk.bookmarks(wsId)
  return useMutation({
    mutationFn: (page: PageMetaDTO) =>
      api<{ bookmarked: boolean }>(`/api/pages/${page.id}/bookmark`, {
        method: 'POST',
      }).then((r) => r.bookmarked),
    onMutate: async (page: PageMetaDTO) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<BookmarkDTO[]>(key)
      if (previous) {
        const exists = previous.some((b) => b.pageId === page.id)
        if (exists) {
          qc.setQueryData<BookmarkDTO[]>(
            key,
            previous.filter((b) => b.pageId !== page.id),
          )
        } else {
          const maxSort = previous.reduce((m, b) => Math.max(m, b.sortOrder), 0)
          const next: BookmarkDTO = {
            pageId: page.id,
            title: page.title,
            icon: page.icon,
            kind: page.kind,
            workspaceId: page.workspaceId,
            sortOrder: maxSort + 1000,
          }
          qc.setQueryData<BookmarkDTO[]>(key, [...previous, next])
        }
      }
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

// ---------------------------------------------------------------------------
// Auth mutations
// ---------------------------------------------------------------------------

/**
 * POST /auth/login answers either a session (`user`) or, for accounts with two-step verification,
 * a challenge for POST /auth/login/totp (docs/adr/1061-*).
 */
export type LoginResult = { user: UserDTO } | { totpRequired: true; challenge: string }

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: LoginInput) => api<LoginResult>('/api/auth/login', jsonBody(input)),
    onSuccess: (r) => {
      if (!('user' in r)) return
      qc.setQueryData(qk.me, r.user)
      // Refetch to fill fields only /auth/me has (origin, verification status, admin badge)
      qc.invalidateQueries({ queryKey: qk.me })
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

/** Second sign-in step: the challenge + an authenticator code or a recovery code. */
export function useLoginTotp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { challenge: string; code: string }) =>
      api<{ user: UserDTO; recoveryCodeUsed: boolean }>('/api/auth/login/totp', jsonBody(input)),
    onSuccess: (r) => {
      qc.setQueryData(qk.me, r.user)
      qc.invalidateQueries({ queryKey: qk.me })
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

// ---------------------------------------------------------------------------
// Two-step verification settings (docs/adr/1061-*)
// ---------------------------------------------------------------------------

export type TwoFactorStateDTO = {
  enabled: boolean
  pending: boolean
  recoveryCodesLeft: number
  /** false when the server has no APP_SECRET_KEY (turning it on answers 501) */
  available: boolean
}

const twoFactorKey = ['auth', '2fa'] as const

export function useTwoFactorState(enabled = true) {
  return useQuery({
    queryKey: twoFactorKey,
    queryFn: () => api<TwoFactorStateDTO>('/api/auth/2fa'),
    enabled,
  })
}

function useTwoFactorMutation<TIn, TOut>(fn: (input: TIn) => Promise<TOut>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: twoFactorKey })
      qc.invalidateQueries({ queryKey: qk.me })
    },
  })
}

export const useTwoFactorSetup = () =>
  useTwoFactorMutation((password: string) =>
    api<{ secret: string; uri: string }>('/api/auth/2fa/setup', jsonBody({ password })),
  )
export const useTwoFactorEnable = () =>
  useTwoFactorMutation((code: string) =>
    api<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', jsonBody({ code })),
  )
export const useTwoFactorDisable = () =>
  useTwoFactorMutation((input: { password: string; code: string }) =>
    api<{ ok: true }>('/api/auth/2fa/disable', jsonBody(input)),
  )
export const useTwoFactorRecoveryCodes = () =>
  useTwoFactorMutation((input: { password: string; code: string }) =>
    api<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', jsonBody(input)),
  )

export function useRegister() {
  const qc = useQueryClient()
  return useMutation({
    // When email verification is enforced, only { verificationRequired: true } comes back, without a session.
    mutationFn: (input: RegisterInput) =>
      api<{ user: UserDTO; verificationRequired?: boolean; mailSent?: boolean }>(
        '/api/auth/register',
        jsonBody(input),
      ),
    onSuccess: (r) => {
      if (r.verificationRequired) return
      qc.setQueryData(qk.me, r.user)
      qc.invalidateQueries({ queryKey: qk.me })
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

/** Save the UI language on the account (null = automatic). Updates the cached /auth/me. */
export function useSetUserLocale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (locale: Locale | null) =>
      api<{ locale: Locale | null }>('/api/auth/me/locale', {
        method: 'PATCH',
        body: JSON.stringify({ locale }),
      }),
    onSuccess: (r) => {
      qc.setQueryData<MeDTO>(qk.me, (old) => (old ? { ...old, locale: r.locale } : old))
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    // This device's offline copies go even when the server cannot be told (offline): logging out
    // means leaving this device (docs/adr/2203-*).
    // A logout that did not reach the server leaves the session (and its push rows) there: this
    // browser's push subscription goes too, so the device stops receiving pushes (docs/adr/2321-*).
    // 'always': after the browser's offline event React Query would otherwise hold the logout (and the
    // deletion of this device's copies) until the connection is back.
    networkMode: 'always',
    mutationFn: async () => {
      let reached = false
      try {
        await api<void>('/api/auth/logout', { method: 'POST' })
        reached = true
      } finally {
        await Promise.allSettled([offline.wipeOffline(), reached ? Promise.resolve() : dropPushSubscriptionHere()])
      }
    },
    onSettled: () => {
      qc.clear()
    },
  })
}

// ---------------------------------------------------------------------------
// Password reset / change / email verification
// ---------------------------------------------------------------------------

export function useResetPassword() {
  return useMutation({
    mutationFn: (input: ResetPasswordInput) =>
      api<{ ok: true }>('/api/auth/reset-password', jsonBody(input)),
  })
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (input: ForgotPasswordInput) =>
      api<{ ok: true }>('/api/auth/forgot-password', jsonBody(input)),
  })
}

/**
 * Settings › Account: connect the OpenID Connect provider to the signed-in account (docs/adr/1161-*).
 * The server answers the provider URL; the caller navigates there. A JSON POST rather than a link, so
 * the Origin check applies (a cross-site page cannot start a link on someone's account).
 */
export function useOidcLink() {
  return useMutation({
    mutationFn: (returnTo: string) => api<{ url: string }>('/api/auth/oidc/link', jsonBody({ returnTo })),
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      api<{ ok: true }>('/api/auth/change-password', jsonBody(input)),
  })
}

export function useVerifyEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (token: string) =>
      api<{ ok: true; email: string }>('/api/auth/verify-email', jsonBody({ token })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.me })
    },
  })
}

/** Without a body when signed in; with email + password when sign-in is blocked */
export function useResendVerification() {
  return useMutation({
    mutationFn: (input?: { email: string; password: string }) =>
      api<{ ok: true; alreadyVerified?: boolean }>(
        '/api/auth/verify-email/send',
        jsonBody(input ?? {}),
      ),
  })
}

// ---------------------------------------------------------------------------
// Workspace mutations
// ---------------------------------------------------------------------------

export function useCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateWorkspaceInput) =>
      api<{ workspace: WorkspaceDTO }>('/api/workspaces', jsonBody(input)).then(
        (r) => r.workspace,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

export function useJoinWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: JoinWorkspaceInput) =>
      api<{ workspace: WorkspaceDTO }>('/api/workspaces/join', jsonBody(input)).then(
        (r) => r.workspace,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

// ---------------------------------------------------------------------------
// M8 member management (owner only)
// ---------------------------------------------------------------------------

type UpdateMemberVars = { userId: string; role: WorkspaceRole }

// Change a member's role. The server rejects demoting the last owner with 400.
export function useUpdateMemberRole(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, role }: UpdateMemberVars) =>
      api<{ member: MemberDTO }>(`/api/workspaces/${wsId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }).then((r) => r.member),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.members(wsId) })
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

// Remove a member (doubles as leaving when it's yourself). The server rejects the last owner leaving with 400.
export function useRemoveMember(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/workspaces/${wsId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.members(wsId) })
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

// ---------------------------------------------------------------------------
// Workspace deletion (soft, 30-day restore) and ownership transfer — docs/adr/0910-*, 0911-*
// ---------------------------------------------------------------------------

// Counts for the delete dialog (owner only).
export function useWorkspaceDeletePreview(wsId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.deletePreview(wsId),
    queryFn: () => api<WorkspaceDeletePreviewDTO>(`/api/workspaces/${wsId}/delete-preview`),
    enabled: enabled && !!wsId,
    staleTime: 0,
  })
}

// Deleted workspaces I own that can still be restored (Settings and the empty-state screen).
export function useDeletedWorkspaces() {
  return useQuery({
    queryKey: qk.deletedWorkspaces,
    queryFn: () =>
      api<{ workspaces: DeletedWorkspaceDTO[] }>('/api/workspaces/deleted').then((r) => r.workspaces),
  })
}

// Soft delete — body { name } must match the workspace name exactly.
export function useDeleteWorkspace(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      api<void>(`/api/workspaces/${wsId}`, { method: 'DELETE', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      // drop it from the cache first so '/' does not route back into the deleted workspace
      qc.setQueryData<WorkspaceDTO[]>(qk.workspaces, (old) => old?.filter((w) => w.id !== wsId))
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

export function useRestoreWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (wsId: string) =>
      api<{ workspace: WorkspaceDTO }>(`/api/workspaces/${wsId}/restore`, { method: 'POST', body: '{}' }).then(
        (r) => r.workspace,
      ),
    onSuccess: (ws) => {
      // add it at once so /w/:id is accepted before the list refetch lands
      qc.setQueryData<WorkspaceDTO[]>(qk.workspaces, (old) =>
        old && !old.some((w) => w.id === ws.id) ? [...old, ws] : old,
      )
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

// The caller (owner) makes `userId` the owner and becomes a member. Returns the new member list.
export function useTransferOwnership(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api<{ members: MemberDTO[] }>(`/api/workspaces/${wsId}/transfer`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }).then((r) => r.members),
    onSuccess: (members) => {
      qc.setQueryData(qk.members(wsId), members)
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

// Add an existing user directly (no invite link) — they get a notification.
export function useAddMember(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api<{ member: MemberDTO }>(`/api/workspaces/${wsId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }).then((r) => r.member),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.members(wsId) })
      qc.invalidateQueries({ queryKey: ['memberCandidates', wsId] })
    },
  })
}

// Regenerate the invite code (owner) → the old link stops working.
export function useRegenerateInvite(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<{ workspace: WorkspaceDTO }>(`/api/workspaces/${wsId}/invite/regenerate`, {
        method: 'POST',
      }).then((r) => r.workspace),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces })
    },
  })
}

// ---------------------------------------------------------------------------
// Page mutations
// ---------------------------------------------------------------------------

export function useCreatePage(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreatePageInput) =>
      api<{ page: PageMetaDTO }>('/api/pages', jsonBody(input)).then((r) => r.page),
    onSuccess: (page) => {
      // Seed the cache before invalidating so the new page shows at once even when navigating immediately.
      qc.setQueryData<PageMetaDTO[]>(qk.pages(wsId), (old) =>
        old
          ? old.some((p) => p.id === page.id)
            ? old.map((p) => (p.id === page.id ? page : p))
            : [...old, page]
          : [page],
      )
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

type UpdatePageVars = { id: string; input: UpdatePageInput }

export function useUpdatePage(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: UpdatePageVars) =>
      api<{ page: PageMetaDTO }>(`/api/pages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }).then((r) => r.page),
    mutationKey: [...pagesWriteKey(wsId), 'update'],
    // Optimistic update: replace the page's fields in the cache at once. Rollback touches only the fields this
    // mutation wrote (docs/adr/0853-*), never a whole-list snapshot.
    onMutate: ({ id, input }: UpdatePageVars) =>
      optimisticPagesPatch(qc, wsId, new Map([[id, input as Partial<PageMetaDTO>]])),
    onError: (err, _vars, ctx) => {
      revertPagesPatch(qc, wsId, ctx?.undo)
      // Refused by an edit lock the client did not know about yet: refresh the lock state now
      // instead of waiting for the next page-list poll.
      if (isPageLockedError(err)) qc.invalidateQueries({ queryKey: ['pageLock'] })
    },
    onSettled: () => invalidatePagesIfIdle(qc, wsId),
  })
}

// --- Optimistic pages-cache helpers shared by useUpdatePage / useMovePages (docs/adr/0853-*) ---

/** mutationKey prefix of every mutation that writes optimistically into qk.pages(wsId). */
const pagesWriteKey = (wsId: string) => ['pages-write', wsId] as const

async function optimisticPagesPatch(
  qc: QueryClient,
  wsId: string,
  patches: ReadonlyMap<string, Partial<PageMetaDTO>>,
): Promise<{ undo: FieldUndo[] }> {
  const key = qk.pages(wsId)
  // An in-flight refetch that started before this patch would land after it and wipe it.
  await qc.cancelQueries({ queryKey: key })
  let undo: FieldUndo[] = []
  qc.setQueryData<PageMetaDTO[]>(key, (old) => {
    if (!old) return old
    const r = patchItems(old, patches)
    undo = r.undo
    return r.list
  })
  return { undo }
}

function revertPagesPatch(qc: QueryClient, wsId: string, undo: FieldUndo[] | undefined) {
  if (!undo?.length) return
  qc.setQueryData<PageMetaDTO[]>(qk.pages(wsId), (old) => (old ? revertItems(old, undo) : old))
}

/**
 * Refetch the tree only when no other pages-write mutation is still pending: refetching while one
 * is in flight would briefly replace its optimistic value with the server's older state. The last
 * one to settle refetches. (`isMutating` still counts the mutation whose onSettled is running.)
 */
function invalidatePagesIfIdle(qc: QueryClient, wsId: string) {
  if (qc.isMutating({ mutationKey: pagesWriteKey(wsId) }) <= 1) {
    void qc.invalidateQueries({ queryKey: qk.pages(wsId) })
  }
}

// Expand into a canvas (M13) — creates a new ontology map (canvas) from a doc page's blocks.
// The response page is the created canvas page. Seeded into the cache + invalidated so it appears in the tree.
export function useExpandToCanvas(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ page: PageMetaDTO }>(`/api/pages/${id}/expand-canvas`, {
        method: 'POST',
      }).then((r) => r.page),
    onSuccess: (page) => {
      qc.setQueryData<PageMetaDTO[]>(qk.pages(wsId), (old) =>
        old ? (old.some((p) => p.id === page.id) ? old : [...old, page]) : [page],
      )
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

// Duplicate a page (M9 templates) — recursively copies the target + descendant tree. Response pages[0] is the copy's root.
// Invalidating the pages cache makes the copy appear in the tree.
export function useDuplicatePage(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ pages: PageMetaDTO[] }>(`/api/pages/${id}/duplicate`, {
        method: 'POST',
      }).then((r) => r.pages),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

// ---------------------------------------------------------------------------
// Page templates — built-ins + workspace custom (more hooks in templatesApi.ts). Variables are substituted on the server.
// ---------------------------------------------------------------------------

// Built-in (code constants) + this workspace's custom templates.
export function useTemplates(wsId: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qk.templates(wsId),
    queryFn: () =>
      api<{ templates: TemplateDTO[] }>(`/api/workspaces/${wsId}/templates`).then(
        (r) => r.templates,
      ),
    enabled: !!wsId && member,
    staleTime: 30_000,
  })
}

// Save the current page as a custom template. On success the template list is invalidated.
export function useCreateTemplate(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTemplateInput) =>
      api<{ template: TemplateDTO }>(
        `/api/workspaces/${wsId}/templates`,
        jsonBody(input),
      ).then((r) => r.template),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.templates(wsId) }),
  })
}

// Delete a custom template (built-ins get 403 from the server). On success the list is invalidated.
export function useDeleteTemplate(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.templates(wsId) }),
  })
}

export function useDeletePage(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/pages/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      qc.invalidateQueries({ queryKey: qk.trash(wsId) })
    },
  })
}

export function useRestorePage(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ page: PageMetaDTO }>(`/api/pages/${id}/restore`, { method: 'POST' }).then(
        (r) => r.page,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      qc.invalidateQueries({ queryKey: qk.trash(wsId) })
    },
  })
}

// ---------------------------------------------------------------------------
// Multi-select bulk actions (sidebar tree) — call the single-item endpoints (PATCH/DELETE/restore) in parallel and
// invalidate caches only once at the end. Partial failures are gathered with allSettled and thrown as an error with the failure count.
// ---------------------------------------------------------------------------

export class BatchError extends Error {
  constructor(
    public failed: number,
    public total: number,
  ) {
    super(t('api.batchFailed', { failed, total }))
  }
}

async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
  const res = await Promise.allSettled(tasks)
  const failed = res.filter((r) => r.status === 'rejected').length
  if (failed > 0) throw new BatchError(failed, res.length)
}

// Move several pages (parent/order/scope) — applied optimistically in one go; on failure roll back and resync with the server.
export function useMovePages(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (moves: UpdatePageVars[]) =>
      settleAll(
        moves.map(({ id, input }) =>
          api(`/api/pages/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
        ),
      ),
    mutationKey: [...pagesWriteKey(wsId), 'move'],
    onMutate: (moves: UpdatePageVars[]) =>
      optimisticPagesPatch(
        qc,
        wsId,
        new Map(moves.map((m) => [m.id, m.input as Partial<PageMetaDTO>])),
      ),
    // Partial failure (BatchError) also reverts every move of the batch; the refetch below then
    // shows whichever moves the server did apply.
    onError: (_err, _vars, ctx) => revertPagesPatch(qc, wsId, ctx?.undo),
    onSettled: () => invalidatePagesIfIdle(qc, wsId),
  })
}

// Move several pages to trash (each a soft delete including descendants).
export function useDeletePages(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) =>
      settleAll(ids.map((id) => api<void>(`/api/pages/${id}`, { method: 'DELETE' }))),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      qc.invalidateQueries({ queryKey: qk.trash(wsId) })
    },
  })
}

// Restore several pages — the undo of a multi-delete (one toast restores them all).
export function useRestorePages(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) =>
      settleAll(ids.map((id) => api(`/api/pages/${id}/restore`, { method: 'POST' }))),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      qc.invalidateQueries({ queryKey: qk.trash(wsId) })
    },
  })
}

export function usePurgePage(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/pages/${id}/purge`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      qc.invalidateQueries({ queryKey: qk.trash(wsId) })
    },
  })
}

// ---------------------------------------------------------------------------
// Import (multipart — not the JSON wrapper)
// ---------------------------------------------------------------------------

export async function importWorkspace(
  wsId: string,
  file: File,
  parentId?: string,
): Promise<{ pages: PageMetaDTO[]; duplicateAttachments: number }> {
  const fd = new FormData()
  fd.append('file', file)
  const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
  const res = await fetch(`/api/workspaces/${wsId}/import${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  })
  if (!res.ok) throw await parseError(res)
  const body = (await res.json()) as { pages: PageMetaDTO[]; duplicateAttachments?: number }
  // Identical attachments are stored once (docs/adr/1122-*); absent for .md and Notion imports.
  return { pages: body.pages, duplicateAttachments: body.duplicateAttachments ?? 0 }
}

/** Import a whole folder — relative paths are encoded into the filename (multipart strips '/'). */
export async function importFolder(
  wsId: string,
  files: { path: string; file: File }[],
  parentId?: string,
): Promise<PageMetaDTO[]> {
  const fd = new FormData()
  for (const f of files) fd.append('files', f.file, encodeURIComponent(f.path))
  const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
  const res = await fetch(`/api/workspaces/${wsId}/import-folder${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  })
  if (!res.ok) throw await parseError(res)
  const body = (await res.json()) as { pages: PageMetaDTO[] }
  return body.pages
}

export function useImportFolder(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { files: { path: string; file: File }[]; parentId?: string }) =>
      importFolder(wsId, vars.files, vars.parentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

export function useImportWorkspace(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { file: File; parentId?: string }) =>
      importWorkspace(wsId, vars.file, vars.parentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

// ---------------------------------------------------------------------------
// M3 collections (Notion-style databases)
// ---------------------------------------------------------------------------

// Merging props (null deletes the key — same as the server contract) is done by patchRowProps in lib/optimistic.ts.

// Collection fields + views + rows. 15 s polling + refresh on focus picks up concurrent team edits.
export function useCollection(pageId: string | undefined) {
  const queryClient = useQueryClient()
  return useQuery({
    ...pollingQuery<CollectionBundle>(
      queryClient,
      qk.collection(pageId ?? ''),
      `/api/pages/${pageId}/collection`,
    ),
    // page guests open collections shared with them too (0.17, docs/adr/2146-*); others answer 404
    enabled: !!pageId,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  })
}

// Replace all fields (PUT)
export function useUpdateFields(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (fields: CollectionField[]) =>
      api<{ collection: CollectionDTO }>(`/api/pages/${pageId}/collection/fields`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      }).then((r) => r.collection),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.collection(pageId) }),
  })
}

type CreateViewInput = { name: string; type: ViewType; config?: ViewConfig }

export function useCreateView(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateViewInput) =>
      api<{ view: CollectionViewDTO }>(
        `/api/pages/${pageId}/collection/views`,
        jsonBody(input),
      ).then((r) => r.view),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.collection(pageId) }),
  })
}

type UpdateViewInput = { name?: string; config?: ViewConfig; sortOrder?: number }
type UpdateViewVars = { viewId: string; input: UpdateViewInput }

// Update a view (PATCH). The server replaces config entirely — the view in the cache is replaced optimistically
// so sort/filter clicks feel instant.
export function useUpdateView(pageId: string) {
  const qc = useQueryClient()
  const key = qk.collection(pageId)
  return useMutation({
    mutationFn: ({ viewId, input }: UpdateViewVars) =>
      api<{ view: CollectionViewDTO }>(`/api/collection-views/${viewId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }).then((r) => r.view),
    onMutate: async ({ viewId, input }: UpdateViewVars) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<CollectionBundle>(key)
      if (previous) {
        qc.setQueryData<CollectionBundle>(key, {
          ...previous,
          collection: {
            ...previous.collection,
            views: previous.collection.views.map((v) =>
              v.id === viewId ? { ...v, ...input } : v,
            ),
          },
        })
      }
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}

export function useDeleteView(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (viewId: string) =>
      api<void>(`/api/collection-views/${viewId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.collection(pageId) }),
  })
}

type UpdatePropsVars = { id: string; props: Record<string, unknown> }

// Update row props (PATCH, merge). The rows cache is updated optimistically so board drags don't jump.
// pageId = the collection page id (rows cache key). Passing collectionId uses that cache instead.
export function useUpdateProps(pageId: string, collectionId?: string) {
  const qc = useQueryClient()
  const key = qk.collection(collectionId ?? pageId)
  return useMutation({
    mutationFn: ({ id, props }: UpdatePropsVars) =>
      api<{ row: RowDTO }>(`/api/pages/${id}/props`, {
        method: 'PATCH',
        body: JSON.stringify({ props }),
      }).then((r) => r.row),
    mutationKey: ['props-write', ...key],
    onMutate: async ({ id, props }: UpdatePropsVars) => {
      await qc.cancelQueries({ queryKey: key })
      let undo: FieldUndo | null = null
      qc.setQueryData<CollectionBundle>(key, (old) => {
        if (!old) return old
        const r = patchRowProps(old.rows, id, props)
        undo = r.undo
        return { ...old, rows: r.rows }
      })
      return { undo }
    },
    // Only the props keys this mutation wrote are restored (docs/adr/0853-*).
    onError: (_e, _v, ctx) => {
      const undo = ctx?.undo ?? null
      if (!undo) return
      qc.setQueryData<CollectionBundle>(key, (old) =>
        old ? { ...old, rows: revertRowProps(old.rows, undo) } : old,
      )
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: ['props-write', ...key] }) > 1) return
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: ['pages'] })
    },
  })
}

// ---------------------------------------------------------------------------
// M4 one-click Notion upload
// ---------------------------------------------------------------------------

export type PublishNotionResult = {
  url: string
  blockCount: number
  warnings: string[]
}

// Upload a page as a Notion child page. Without NOTION_TOKEN the server returns 501 NOTION_DISABLED.
export function usePublishNotion(pageId: string) {
  return useMutation({
    mutationFn: (parentUrl: string) =>
      api<PublishNotionResult>(
        `/api/pages/${pageId}/publish/notion`,
        jsonBody({ parentUrl }),
      ),
  })
}

// ---------------------------------------------------------------------------
// M8 version history (snapshots)
// ---------------------------------------------------------------------------

// A page's snapshots (newest 50). Fetched only while the history section/modal is open.
export function useSnapshots(pageId: string, enabled: boolean) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qk.snapshots(pageId),
    queryFn: () =>
      api<{ snapshots: SnapshotDTO[] }>(`/api/pages/${pageId}/snapshots`).then(
        (r) => r.snapshots,
      ),
    enabled: !!pageId && enabled && member,
    staleTime: 10_000,
  })
}

// Snapshot preview (markdown) — fetched lazily, only once an entry is selected.
export function useSnapshotPreview(pageId: string, sid: string | null) {
  return useQuery({
    queryKey: qk.snapshotPreview(pageId, sid ?? ''),
    queryFn: () =>
      api<{ markdown: string }>(
        `/api/pages/${pageId}/snapshots/${sid}/preview`,
      ).then((r) => r.markdown),
    enabled: !!pageId && !!sid,
    staleTime: 60_000,
  })
}

// Create a manual snapshot (optional label). The server returns only { ok: true }, so the list is invalidated to refresh.
export function useCreateSnapshot(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (label?: string) =>
      api<{ ok: boolean }>(
        `/api/pages/${pageId}/snapshots`,
        jsonBody(label ? { label } : {}),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.snapshots(pageId) }),
  })
}

// Restore from a snapshot — applied to the live document (the editor updates in real time via collab).
// The server keeps the state just before restoring as a "before restore" snapshot, so the list is invalidated.
export function useRestoreSnapshot(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sid: string) =>
      api<void>(`/api/pages/${pageId}/snapshots/${sid}/restore`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.snapshots(pageId) }),
  })
}

// ---------------------------------------------------------------------------
// M13 inline comments · @mentions · notifications
// ---------------------------------------------------------------------------

// All comments of a page (threads/replies as a flat array, createdAt asc). 15 s polling for near-real-time team use.
export function useComments(pageId: string | undefined) {
  const queryClient = useQueryClient()
  return useQuery({
    ...pollingQuery<{ comments: CommentDTO[] }, CommentDTO[]>(
      queryClient,
      qk.comments(pageId ?? ''),
      `/api/pages/${pageId}/comments`,
      (r) => r.comments,
    ),
    enabled: !!pageId,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  })
}

// New thread (no threadId) or reply (threadId set). @mentions in body are sent along as mentionUserIds.
// Comments trigger notifications, so the notification list is invalidated on success too.
export function useCreateComment(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCommentInput) =>
      api<{ comment: CommentDTO }>(
        `/api/pages/${pageId}/comments`,
        jsonBody(input),
      ).then((r) => r.comment),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.comments(pageId) })
      qc.invalidateQueries({ queryKey: qk.notifications })
      // Writing in a thread follows it (docs/adr/1412-*): the follow buttons and the Threads view.
      qc.invalidateQueries({ queryKey: ['threads'] })
    },
  })
}

type UpdateCommentVars = { id: string; resolved?: boolean; body?: string }

// Toggle resolved on a thread root (root only) or edit the body (author only). Permission violations are server 403/400.
export function useUpdateComment(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, resolved, body }: UpdateCommentVars) =>
      api<{ comment: CommentDTO }>(`/api/comments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ resolved, body }),
      }).then((r) => r.comment),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.comments(pageId) }),
  })
}

// Delete a comment (author or page owner). Deleting a thread root makes the server delete its replies too.
export function useDeleteComment(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/comments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.comments(pageId) }),
  })
}

export interface NotificationsResult {
  notifications: NotificationDTO[]
  unread: number
}

// My notifications, newest first + unread count. Global, not per workspace. 30 s polling.
export function useNotifications() {
  const queryClient = useQueryClient()
  return useQuery({
    ...pollingQuery<NotificationsResult>(queryClient, qk.notifications, '/api/notifications'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}

// Mark the given (ids) or all (no ids) as read. On success the list is invalidated to update the badge.
export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids?: string[]) =>
      api<{ unread: number }>('/api/notifications/read', jsonBody(ids ? { ids } : {})),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notifications }),
  })
}

// ---------------------------------------------------------------------------
// M15 public web sharing (read-only links)
// ---------------------------------------------------------------------------

// A page's share state (members only). Fetched only while the modal is open (enabled). No retry on 4xx.
export function useShareStatus(pageId: string | undefined, enabled = true) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qk.share(pageId ?? ''),
    queryFn: () => api<ShareStatusDTO>(`/api/pages/${pageId}/share`),
    enabled: !!pageId && enabled && member,
    staleTime: 10_000,
    retry: false,
  })
}

// Publish (owner only). On success the share cache is set from the response so the link shows at once.
// The optional body (expiry, password; docs/adr/1170-*, 1171-*) only applies to a new link.
export function useShare(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body?: import('@inkling/shared').CreateShareInput) =>
      api<ShareStatusDTO>(`/api/pages/${pageId}/share`, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.share(pageId), data)
      qc.invalidateQueries({ queryKey: ['sharedList'] })
    },
  })
}

// Stop sharing (unpublish, owner only). The cache is updated with the response { shared:false, token:null }.
export function useUnshare(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<ShareStatusDTO>(`/api/pages/${pageId}/share`, { method: 'DELETE' }),
    onSuccess: (data) => {
      qc.setQueryData(qk.share(pageId), data)
      qc.invalidateQueries({ queryKey: ['sharedList'] })
    },
  })
}

// Change an existing link's expiry or password (owners and admins).
export function useUpdateShare(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: import('@inkling/shared').UpdateShareInput) =>
      api<ShareStatusDTO>(`/api/pages/${pageId}/share`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      qc.setQueryData(qk.share(pageId), data)
      qc.invalidateQueries({ queryKey: ['sharedList'] })
    },
  })
}

// A visitor enters a link's password. The server sets an httpOnly cookie scoped to
// /api/public/<token>; the public queries of that link are then fetched again.
export function useUnlockShare(token: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (password: string) =>
      api<void>(`/api/public/${token}/unlock`, { method: 'POST', body: JSON.stringify({ password }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['public', token ?? ''] }),
  })
}

// Unauthenticated fetch for the public viewer. Sending cookies is harmless — the server decides by the token alone.
// A missing/wrong token is 404 → useQuery error → 404 screen. No retry on 4xx.
export function usePublicPage(token: string | undefined) {
  return useQuery({
    queryKey: qk.publicPage(token ?? ''),
    queryFn: () => api<PublicPageDTO>(`/api/public/${token}`),
    enabled: !!token,
    retry: false,
    staleTime: 30_000,
  })
}

// Export: trigger a download that includes same-origin cookies by clicking a dynamic <a download>
export function triggerDownload(href: string) {
  const a = document.createElement('a')
  a.href = href
  a.rel = 'noopener'
  a.download = ''
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// ---------------------------------------------------------------------------
// Admin — sign-up keys / users (200 only for isAdmin accounts, 403 otherwise)
// ---------------------------------------------------------------------------

export function useSignupKeys(enabled: boolean) {
  return useQuery({
    queryKey: qk.signupKeys,
    queryFn: () =>
      api<{ keys: SignupKeyDTO[] }>('/api/admin/signup-keys').then((r) => r.keys),
    enabled,
    retry: false,
  })
}

export function useCreateSignupKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSignupKeyInput) =>
      api<{ key: SignupKeyDTO }>('/api/admin/signup-keys', jsonBody(input)).then(
        (r) => r.key,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.signupKeys })
    },
  })
}

export function useRevokeSignupKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (key: string) =>
      api<{ ok: true }>(`/api/admin/signup-keys/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.signupKeys })
    },
  })
}

export function useAdminUsers(enabled: boolean) {
  return useQuery({
    queryKey: qk.adminUsers,
    queryFn: () => api<{ users: AdminUserDTO[] }>('/api/admin/users').then((r) => r.users),
    enabled,
    retry: false,
  })
}

// Admin — user password reset / deletion / verification / mail

function useAdminUserMutation<TIn, TOut>(fn: (input: TIn) => Promise<TOut>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.adminUsers })
      qc.invalidateQueries({ queryKey: qk.resetRequests })
      qc.invalidateQueries({ queryKey: qk.signupKeys })
      qc.invalidateQueries({ queryKey: qk.me })
    },
  })
}

export const useIssueTempPassword = () =>
  useAdminUserMutation((id: string) =>
    api<{ password: string }>(`/api/admin/users/${id}/temp-password`, { method: 'POST' }),
  )

export const useIssueResetCode = () =>
  useAdminUserMutation((id: string) =>
    api<{ code: string; expiresAt: string }>(`/api/admin/users/${id}/reset-code`, {
      method: 'POST',
    }),
  )

/** Admin: turn off a member's two-step verification (lost phone); their sessions end. */
export const useAdminDisableTwoFactor = () =>
  useAdminUserMutation((id: string) =>
    api<{ ok: true; wasOn: boolean }>(`/api/admin/users/${id}/2fa`, { method: 'DELETE' }),
  )

export const useDeleteUser = () =>
  useAdminUserMutation((id: string) =>
    api<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  )

/** What a forced deletion would remove / block (GET /admin/users/:id/delete-preview, docs/adr/0813-*). */
export type AdminDeletePreview = {
  personalWorkspaces: number
  personal: { id: string; name: string }[]
  soleOwnedShared: { id: string; name: string }[]
}

/**
 * Fetcher for the delete preview, called when the admin opens the removal confirmation.
 * Always fetches fresh (memberships may have changed since the list loaded).
 */
export function useAdminDeletePreview() {
  const qc = useQueryClient()
  return (userId: string) =>
    qc.fetchQuery({
      queryKey: ['admin', 'users', userId, 'delete-preview'] as const,
      queryFn: () => api<AdminDeletePreview>(`/api/admin/users/${userId}/delete-preview`),
      staleTime: 0,
      retry: false,
    })
}

export const useMarkVerified = () =>
  useAdminUserMutation(({ id, verified }: { id: string; verified: boolean }) =>
    api<{ user: { id: string } }>(`/api/admin/users/${id}/verify`, jsonBody({ verified })),
  )

export const useSendVerificationMail = () =>
  useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/api/admin/users/${id}/send-verification`, { method: 'POST' }),
  })

export const useSendCredentialMail = () =>
  useMutation({
    mutationFn: ({ id, ...input }: SendCredentialMailInput & { id: string }) =>
      api<{ ok: true }>(`/api/admin/users/${id}/send-credential`, jsonBody(input)),
  })

export const useSendInviteMail = () =>
  useMutation({
    mutationFn: ({ key, to }: { key: string; to: string }) =>
      api<{ ok: true }>(
        `/api/admin/signup-keys/${encodeURIComponent(key)}/send-invite`,
        jsonBody({ to }),
      ),
  })

export function useResetRequests(enabled: boolean) {
  return useQuery({
    queryKey: qk.resetRequests,
    queryFn: () =>
      api<{ requests: ResetRequestDTO[] }>('/api/admin/reset-requests').then((r) => r.requests),
    enabled,
    retry: false,
  })
}

export const useDismissResetRequest = () =>
  useAdminUserMutation((id: string) =>
    api<{ ok: true }>(`/api/admin/reset-requests/${id}/dismiss`, { method: 'POST' }),
  )

// Admin — brute-force protection (blocked IPs)
export function useIpBans(enabled: boolean) {
  return useQuery({
    queryKey: qk.ipBans,
    queryFn: () => api<IpBansResponseDTO>('/api/admin/ip-bans'),
    enabled,
    retry: false,
  })
}

export function useBanIp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ManualBanInput) =>
      api<{ ok: true; ip: string; bannedUntil: string }>('/api/admin/ip-bans', jsonBody(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ipBans })
    },
  })
}

export function useUnbanIp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/admin/ip-bans/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ipBans })
    },
  })
}

export function useSetAdmin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, isAdmin }: { id: string; isAdmin: boolean }) =>
      api<{ user: { id: string; isAdmin: boolean } }>(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isAdmin }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.adminUsers })
    },
  })
}

// ---------------------------------------------------------------------------
// Ink layer (pen annotations)
// ---------------------------------------------------------------------------

// Read once when the page opens. Not polled: ink is drawn by you on your own tablet, and swapping
// the screen with a server response mid-stroke makes strokes jump.
export function usePageInk(pageId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.ink(pageId ?? ''),
    queryFn: () => api<{ ink: InkDTO }>(`/api/pages/${pageId}/ink`).then((r) => r.ink),
    enabled: !!pageId && enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
}

/**
 * Whether the page has ink strokes, for the PDF preview's rule (docs/adr/2481-*): the same query as the
 * ink layer, read only while `enabled` (a page body with PDF blocks, pen mode off) and then refreshed every
 * minute and on window focus, since the server does not announce another member's first stroke. `saving`
 * is true while this tab is still saving ink (the layer flushes when pen mode turns off).
 */
export function usePageInkPresence(pageId: string, enabled: boolean): { state: 'loading' | 'error' | number; saving: boolean } {
  const q = useQuery({
    queryKey: qk.ink(pageId),
    queryFn: () => api<{ ink: InkDTO }>(`/api/pages/${pageId}/ink`).then((r) => r.ink),
    enabled: !!pageId && enabled,
    refetchInterval: enabled ? 60_000 : false,
    refetchOnWindowFocus: enabled,
    staleTime: 30_000,
  })
  const saving = useIsMutating({ mutationKey: ['inkSave', pageId] }) > 0
  const state = q.isSuccess ? q.data.strokes.length : q.isError ? 'error' : 'loading'
  return { state, saving }
}

// Save by full replacement (debounced by the caller). On success the cache is set from the response.
// `expectedUpdatedAt`: the server version the strokes are based on (null = no ink yet). On a
// mismatch the server answers 412 INK_CONFLICT with `details.ink` (docs/adr/0815-*).
export function useSaveInk(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    // usePageInkPresence waits for a save in flight (docs/adr/2481-*)
    mutationKey: ['inkSave', pageId],
    mutationFn: ({ strokes, expectedUpdatedAt }: { strokes: InkStroke[]; expectedUpdatedAt?: string | null }) =>
      api<{ ink: InkDTO }>(`/api/pages/${pageId}/ink`, {
        method: 'PUT',
        body: JSON.stringify({ strokes, expectedUpdatedAt }),
      }).then((r) => r.ink),
    onSuccess: (ink) => qc.setQueryData(qk.ink(pageId), ink),
  })
}

// ---------------------------------------------------------------------------
// MCP remote connector (OAuth consent screen · connected apps)
// ---------------------------------------------------------------------------

export interface OAuthClientInfo {
  client: { id: string; name: string }
  redirectHost: string
  /** 'read' = the client asked only for read access (docs/adr/0935-*) */
  requestedAccess?: 'read' | 'write'
  /** The app's name equals a member's display name (docs/adr/1000-*); absent on older servers. */
  nameNotice?: import('@inkling/shared').ClientNameNotice | null
  /** The client_id is a metadata document URL (docs/adr/2282-*): its host, and whether the code goes to a local port. */
  metadataDocument?: { host: string; loopbackRedirect: boolean }
}
export interface OAuthGrantDTO {
  id: string
  clientName: string
  /** The client_id host of an app identified by a metadata document (docs/adr/2282-*); absent otherwise. */
  clientHost?: string | null
  /** 'read' = read-only connection; absent on older servers (= full access) */
  access?: 'read' | 'write'
  /** What the connection may see (docs/adr/1200-*); absent on older servers (= everything) */
  range?: import('@inkling/shared').AccessRangeView
  createdAt: string
  lastUsedAt: string | null
}
/** The /oauth/authorize query as-is + the user's decision */
export interface OAuthAuthorizeInput {
  client_id: string
  redirect_uri: string
  response_type?: string
  code_challenge?: string
  code_challenge_method?: string
  state?: string
  scope?: string
  resource?: string
  decision: 'allow' | 'deny'
  /** The user's consent choice; the server never grants more than the client requested */
  access?: 'read' | 'write'
  /** What the connection may see (docs/adr/1200-*); absent = everything */
  range?: import('@inkling/shared').AccessRange
}

// App name for the consent screen — includes upfront client_id/redirect_uri validation (400 on failure).
export function useOAuthClientInfo(clientId: string, redirectUri: string, enabled: boolean, scope = '') {
  return useQuery({
    queryKey: ['oauth', 'info', clientId, redirectUri, scope] as const,
    queryFn: () =>
      api<OAuthClientInfo>(
        `/api/oauth/authorize/info?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}` +
          (scope ? `&scope=${encodeURIComponent(scope)}` : ''),
      ),
    enabled: enabled && !!clientId && !!redirectUri,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

// Allow/deny → the caller navigates to the redirectTo (the app's callback URL) the server returns.
export function useOAuthAuthorize() {
  return useMutation({
    mutationFn: (input: OAuthAuthorizeInput) =>
      api<{ redirectTo: string }>('/api/oauth/authorize', jsonBody(input)),
  })
}

export function useOAuthGrants() {
  return useQuery({
    queryKey: ['oauth', 'grants'] as const,
    queryFn: () => api<{ grants: OAuthGrantDTO[] }>('/api/oauth/grants').then((r) => r.grants),
  })
}

export function useRevokeOAuthGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/oauth/grants/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['oauth', 'grants'] }),
  })
}

// ---------------------------------------------------------------------------
// Workspace web shares — the sidebar "Web shares" screen + the 🌐 marker in the tree.
// On share/unshare success, invalidate by the ['sharedList'] prefix.
// ---------------------------------------------------------------------------

export interface SharedItemDTO {
  id: string
  title: string
  icon: string | null
  kind: PageMetaDTO['kind']
  parentId: string | null
  token: string
  updatedAt: string
  exposedCount?: number
  /** ISO, null = never (docs/adr/1170-*). */
  expiresAt?: string | null
  expired?: boolean
  hasPassword?: boolean
  /** Scheduled link: opens at this instant (docs/adr/1844-*). */
  startsAt?: string | null
  notStarted?: boolean
}

export function useSharedList(wsId: string | undefined) {
  const member = useMemberScope(wsId ?? '')
  return useQuery({
    queryKey: ['sharedList', wsId ?? ''],
    queryFn: () =>
      api<{ canManage: boolean; items: SharedItemDTO[] }>(`/api/workspaces/${wsId}/shared`),
    enabled: !!wsId && member,
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// Link preview cards + workspace webhooks (Slack / Discord / generic JSON)
// ---------------------------------------------------------------------------

export function useLinkPreview(url: string | undefined) {
  return useQuery({
    queryKey: ['linkPreview', url ?? ''],
    queryFn: () =>
      api<{ preview: import('@inkling/shared').LinkPreviewDTO }>(
        `/api/link-preview?url=${encodeURIComponent(url ?? '')}`,
      ).then((r) => r.preview),
    enabled: !!url,
    staleTime: 60 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
  })
}

type WebhookDTOType = import('@inkling/shared').WebhookDTO
type WebhookEventType = import('@inkling/shared').WebhookEvent

export function useWebhooks(wsId: string, enabled = true) {
  return useQuery({
    queryKey: ['webhooks', wsId],
    queryFn: () => api<{ webhooks: WebhookDTOType[] }>(`/api/workspaces/${wsId}/webhooks`).then((r) => r.webhooks),
    enabled: !!wsId && enabled,
  })
}

export function useCreateWebhook(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { url: string; events: WebhookEventType[]; kind?: 'generic' }) =>
      api<{ webhook: WebhookDTOType; secret: string | null }>(`/api/workspaces/${wsId}/webhooks`, jsonBody(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', wsId] }),
  })
}

export function useUpdateWebhook(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; events?: WebhookEventType[]; enabled?: boolean }) =>
      api<{ webhook: WebhookDTOType }>(`/api/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', wsId] }),
  })
}

export function useDeleteWebhook(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', wsId] }),
  })
}

export function useTestWebhook(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; status: number | null; error: string | null; webhook: WebhookDTOType }>(
        `/api/webhooks/${id}/test`,
        { method: 'POST' },
      ),
    onSettled: (_d, _e, id) => {
      void qc.invalidateQueries({ queryKey: ['webhooks', wsId] })
      void qc.invalidateQueries({ queryKey: ['webhookDeliveries', id] })
    },
  })
}

/** Generic hooks: a new signing secret, returned once (docs/adr/1190-*). */
export function useRotateWebhookSecret(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, keepPrevious }: { id: string; keepPrevious: boolean }) =>
      api<{ webhook: WebhookDTOType; secret: string }>(`/api/webhooks/${id}/secret`, jsonBody({ keepPrevious })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', wsId] }),
  })
}

/** Recent deliveries of a hook (docs/adr/1191-*); refreshed while one is waiting for a retry. */
export function useWebhookDeliveries(hookId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['webhookDeliveries', hookId],
    queryFn: () =>
      api<{ deliveries: import('@inkling/shared').WebhookDeliveryDTO[] }>(`/api/webhooks/${hookId}/deliveries`).then((r) => r.deliveries),
    enabled,
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'retrying') ? 5_000 : false),
  })
}

export function useResendWebhookDelivery(hookId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api<{ ok: boolean }>(`/api/webhooks/${hookId}/deliveries/${deliveryId}/resend`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['webhookDeliveries', hookId] }),
  })
}

// ---------------------------------------------------------------------------
// Query block (Dataview subset) — POST /api/workspaces/:id/query (docs/QUERY.md)
// ---------------------------------------------------------------------------

/** Runs a query with the viewer's local date / UTC offset (for date(today), file.ctime …). */
export function runQuery(wsId: string, source: string) {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  return api<import('@inkling/shared').QueryResultDTO & { cached?: boolean }>(
    `/api/workspaces/${wsId}/query`,
    {
      method: 'POST',
      body: JSON.stringify({ source, today, tzOffsetMinutes: -now.getTimezoneOffset() }),
    },
  )
}

// ---------------------------------------------------------------------------
// Workspace settings screen (docs/adr/0945-* .. 0952-*): settings, audit log, connected agents,
// public link management, document owner / review
// ---------------------------------------------------------------------------

type WsSettingsDTO = import('@inkling/shared').WorkspaceSettingsDTO
type WsCapabilities = import('@inkling/shared').WorkspaceCapabilities
type WsRole = import('@inkling/shared').WorkspaceRole

export interface WorkspaceSettingsResponse {
  settings: WsSettingsDTO
  role: WsRole
  can: WsCapabilities
  unpublished?: number
  /** "Require two-step verification" (docs/adr/1112-*). Older servers omit it. */
  twoFactor?: import('@inkling/shared').TwoFactorPolicyDTO
}

export const qkAdmin = {
  settings: (wsId: string) => ['wsSettings', wsId] as const,
  audit: (wsId: string, action: string, actorId: string) => ['wsAudit', wsId, action, actorId] as const,
  agents: (wsId: string) => ['wsAgents', wsId] as const,
  reviewDue: (wsId: string, mine: boolean) => ['reviewDue', wsId, mine] as const,
  pageReview: (pageId: string) => ['pageReview', pageId] as const,
  pageLock: (pageId: string) => ['pageLock', pageId] as const,
  agentInstructions: (wsId: string) => ['agentInstructions', wsId] as const,
  suspicious: (pageId: string) => ['suspicious', pageId] as const,
}

export function useWorkspaceSettings(wsId: string) {
  return useQuery({
    queryKey: qkAdmin.settings(wsId),
    queryFn: () => api<WorkspaceSettingsResponse>(`/api/workspaces/${wsId}/settings`),
    enabled: !!wsId,
  })
}

export function useUpdateWorkspaceSettings(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: import('@inkling/shared').UpdateWorkspaceSettingsInput) =>
      api<WorkspaceSettingsResponse>(`/api/workspaces/${wsId}/settings`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: (data) => {
      qc.setQueryData(qkAdmin.settings(wsId), data)
      // capabilities in the workspace list (WorkspaceDTO.can) follow the settings
      qc.invalidateQueries({ queryKey: qk.workspaces })
      qc.invalidateQueries({ queryKey: ['sharedList'] })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
      qc.invalidateQueries({ queryKey: ['reviewDue', wsId] })
    },
  })
}

/** Turn "require two-step verification" on/off or change its grace period (owners and admins, docs/adr/1112-*). */
export function useSetTwoFactorPolicy(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: import('@inkling/shared').SetTwoFactorPolicyInput) =>
      api<{ twoFactor: import('@inkling/shared').TwoFactorPolicyDTO }>(`/api/workspaces/${wsId}/settings/two-factor`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      qc.setQueryData<WorkspaceSettingsResponse>(qkAdmin.settings(wsId), (prev) => (prev ? { ...prev, twoFactor: data.twoFactor } : prev))
      qc.invalidateQueries({ queryKey: qk.workspaces })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

/** "Agents can read handwriting" (owners and admins, docs/adr/1510-*). */
export function useSetAgentInk(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: import('@inkling/shared').SetAgentInkInput) =>
      api<WorkspaceSettingsResponse>(`/api/workspaces/${wsId}/settings/agent-ink`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (data) => {
      qc.setQueryData<WorkspaceSettingsResponse>(qkAdmin.settings(wsId), (prev) => (prev ? { ...prev, settings: data.settings } : prev))
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

/** "Uploads by AI agents" (docs/adr/2065-*): owners and admins; 'default' follows the server's AGENT_UPLOADS. */
export function useSetAgentUploads(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: import('@inkling/shared').SetAgentUploadsInput) =>
      api<WorkspaceSettingsResponse>(`/api/workspaces/${wsId}/settings/agent-uploads`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (data) => {
      qc.setQueryData<WorkspaceSettingsResponse>(qkAdmin.settings(wsId), (prev) => (prev ? { ...prev, settings: data.settings } : prev))
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

/** "Suggest only after flagged content" (docs/adr/2043-*): owners and admins. */
export function useSetAgentTaint(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: import('@inkling/shared').SetAgentTaintInput) =>
      api<WorkspaceSettingsResponse>(`/api/workspaces/${wsId}/settings/agent-taint`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (data) => {
      qc.setQueryData<WorkspaceSettingsResponse>(qkAdmin.settings(wsId), (prev) => (prev ? { ...prev, settings: data.settings } : prev))
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

/** Rename / change the icon (owner). */
export function useUpdateWorkspace(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name?: string; icon?: string | null }) =>
      api<{ workspace: WorkspaceDTO }>(`/api/workspaces/${wsId}`, { method: 'PATCH', body: JSON.stringify(input) }).then(
        (r) => r.workspace,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

export function useAuditLog(wsId: string, filter: { action: string; actorId: string }, enabled = true) {
  return useInfiniteQuery({
    queryKey: qkAdmin.audit(wsId, filter.action, filter.actorId),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '50' })
      if (filter.action) q.set('action', filter.action)
      if (filter.actorId) q.set('actorId', filter.actorId)
      if (pageParam) q.set('cursor', pageParam)
      return api<import('@inkling/shared').AuditPageDTO>(`/api/workspaces/${wsId}/audit?${q.toString()}`)
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!wsId && enabled,
  })
}

export function useWorkspaceAgents(wsId: string, enabled = true) {
  return useQuery({
    queryKey: qkAdmin.agents(wsId),
    queryFn: () =>
      api<{
        connections: import('@inkling/shared').AgentConnectionDTO[]
        blocks: import('@inkling/shared').AgentBlockDTO[]
        /** Usage numbers count from here (server start, docs/adr/1552-*). */
        usageSince?: string
      }>(`/api/workspaces/${wsId}/agents`),
    enabled: !!wsId && enabled,
  })
}

export function useBlockAgent(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { userId: string; clientId: string | null }) =>
      api<{ block: { id: string } }>(`/api/workspaces/${wsId}/agents/blocks`, jsonBody(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkAdmin.agents(wsId) })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

export function useUnblockAgent(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (blockId: string) => api<void>(`/api/workspaces/${wsId}/agents/blocks/${blockId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkAdmin.agents(wsId) })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

/** Remove public links: the given pages, or all of them (owners/admins). */
export function useBulkUnpublish(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (pageIds?: string[]) =>
      api<{ unpublished: number }>(`/api/workspaces/${wsId}/shared/unpublish`, jsonBody(pageIds ? { pageIds } : {})),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sharedList'] })
      qc.invalidateQueries({ queryKey: ['share'] })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

export function useReviewDue(wsId: string, mine: boolean, enabled = true) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qkAdmin.reviewDue(wsId, mine),
    queryFn: () => api<import('@inkling/shared').ReviewDueDTO>(`/api/workspaces/${wsId}/review-due${mine ? '?mine=1' : ''}`),
    enabled: !!wsId && enabled && member,
  })
}

type PageReview = import('@inkling/shared').PageReviewDTO

export function usePageReview(pageId: string, enabled = true) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qkAdmin.pageReview(pageId),
    queryFn: () => api<{ review: PageReview | null }>(`/api/pages/${pageId}/review`).then((r) => r.review),
    enabled: !!pageId && enabled && member,
    retry: false,
  })
}

function usePageReviewMutation<V>(pageId: string, fn: (v: V) => Promise<{ review: PageReview | null }>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(qkAdmin.pageReview(pageId), data.review)
      qc.invalidateQueries({ queryKey: ['reviewDue'] })
    },
  })
}

export function useSetPageOwner(pageId: string) {
  return usePageReviewMutation(pageId, (ownerId: string | null) =>
    api<{ review: PageReview | null }>(`/api/pages/${pageId}/owner`, { method: 'PUT', body: JSON.stringify({ ownerId }) }),
  )
}

export function useSetLiving(pageId: string) {
  return usePageReviewMutation(pageId, (living: boolean | null) =>
    api<{ review: PageReview | null }>(`/api/pages/${pageId}/living`, { method: 'PUT', body: JSON.stringify({ living }) }),
  )
}

/** One web view → the page's read counter (totals only, docs/adr/0953-*). Fire and forget. */
export function recordPageView(pageId: string): void {
  void api<void>(`/api/pages/${pageId}/view`, { method: 'POST' }).catch(() => {})
}

export function useMarkReviewed(pageId: string) {
  return usePageReviewMutation(pageId, (_: void) =>
    api<{ review: PageReview | null }>(`/api/pages/${pageId}/review`, { method: 'POST' }),
  )
}


// ---------------------------------------------------------------------------
// Notion export import (docs/adr/0960-*) — same multipart route, ?source=notion
// ---------------------------------------------------------------------------

/** Server report of a Notion import (mirrors NotionImportReport in apps/server/src/md/notionImport.ts). */
export interface NotionImportReportDTO {
  source: 'notion'
  detected: 'explicit' | 'auto'
  pages: number
  documents: number
  folders: number
  collections: number
  rows: number
  attachments: number
  links: { total: number; resolved: number }
  brokenLinks: { page: string; href: string }[]
  brokenLinkCount: number
  skipped: { path: string; reason: string }[]
  skippedCount: number
  renamed: number
  callouts: number
  equations: number
  /** Duplicates merged (docs/adr/1122-*); absent on older servers. */
  merged?: { pages: number; attachments: number }
}

export async function importNotion(
  wsId: string,
  file: File,
  parentId?: string,
): Promise<{ pages: PageMetaDTO[]; report: NotionImportReportDTO }> {
  const fd = new FormData()
  fd.append('file', file)
  const qs = new URLSearchParams({ source: 'notion' })
  if (parentId) qs.set('parentId', parentId)
  const res = await fetch(`/api/workspaces/${wsId}/import?${qs.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as { pages: PageMetaDTO[]; report: NotionImportReportDTO }
}

export function useImportNotion(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { file: File; parentId?: string }) => importNotion(wsId, vars.file, vars.parentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}


// ---------------------------------------------------------------------------
// Edit lock (docs/adr/0970-*) and agent instruction pages (docs/adr/0975-*)
// ---------------------------------------------------------------------------

type PageLock = import('@inkling/shared').PageLockDTO
type AgentInstruction = import('@inkling/shared').AgentInstructionDTO

/** The lock that governs a page (its own or the nearest locked ancestor's). No retry on 4xx. */
export function usePageLock(pageId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qkAdmin.pageLock(pageId ?? ''),
    queryFn: () => api<PageLock>(`/api/pages/${pageId}/lock`),
    enabled: !!pageId && enabled,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** Shared success handling: a lock change can affect the whole subtree, so every lock query is refreshed. */
function useLockMutation<V>(pageId: string, wsId: string, fn: (v: V) => Promise<PageLock>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(qkAdmin.pageLock(pageId), data)
      qc.invalidateQueries({ queryKey: ['pageLock'] })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      qc.invalidateQueries({ queryKey: qkAdmin.agentInstructions(wsId) })
      qc.invalidateQueries({ queryKey: ['agentInstructionLengths', wsId] }) // lib/instructionLengthApi.ts
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

/** Turn this page's own lock on/off, or change its people/agent rules and editors. */
export function useSetPageLock(pageId: string, wsId: string) {
  return useLockMutation(pageId, wsId, (input: import('@inkling/shared').SetPageLockInput) =>
    api<PageLock>(`/api/pages/${pageId}/lock`, { method: 'PUT', body: JSON.stringify(input) }),
  )
}

/** Designate the page as an agent instruction page (owners/admins; the page is locked automatically). */
export function useSetAgentInstructions(pageId: string, wsId: string) {
  return useLockMutation(pageId, wsId, (input: import('@inkling/shared').SetAgentInstructionInput) =>
    api<PageLock>(`/api/pages/${pageId}/agent-instructions`, { method: 'PUT', body: JSON.stringify(input) }),
  )
}

/** Remove the agent-instruction designation (the lock stays). */
export function useRemoveAgentInstructions(pageId: string, wsId: string) {
  return useLockMutation(pageId, wsId, (_: void) =>
    api<PageLock>(`/api/pages/${pageId}/agent-instructions`, { method: 'DELETE' }),
  )
}

/** Every agent instruction page of a workspace. */
export function useWorkspaceAgentInstructions(wsId: string, enabled = true) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qkAdmin.agentInstructions(wsId),
    queryFn: () =>
      api<{ instructions: AgentInstruction[] }>(`/api/workspaces/${wsId}/agent-instructions`).then((r) => r.instructions),
    enabled: !!wsId && enabled && member,
    retry: false,
  })
}

/** A write was refused because the page (or an ancestor) is locked for the caller. */
export function isPageLockedError(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === 'PAGE_LOCKED'
}

/**
 * Sections of a doc page whose text matched a prompt-injection heuristic (shown as a warning only;
 * agents receive that text marked as data). Not real-time: refreshed when the page is reopened.
 */
export function usePageSuspicious(pageId: string | undefined, enabled = true) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qkAdmin.suspicious(pageId ?? ''),
    queryFn: () => api<import('@inkling/shared').SuspiciousSectionsDTO>(`/api/pages/${pageId}/suspicious`),
    enabled: !!pageId && enabled && member,
    staleTime: 5 * 60_000,
    retry: false,
  })
}
