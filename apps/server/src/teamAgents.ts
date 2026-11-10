import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import {
  AGENT_PROP_PREFIX,
  agentPropKey,
  agentRefOfCell,
  shortConnection,
  CONNECTION_KEY_RE,
  formatAgentRef,
  parseAgentRef,
} from '@inkling/shared'
import type {
  ConnectionKey,
  TeamAgentActivityDTO,
  TeamAgentsDTO,
  TeamClaimDTO,
  TeamPersonDTO,
  TeamSuggestionDTO,
  WorkspaceConnectionDTO,
} from '@inkling/shared'
import { db } from './db/index'
import type { Exec } from './outbox'
import { AppError } from './errors'
import { pageInRangeSql } from './tokenRange'

/**
 * Team agents (docs/adr/1860-* .. 1866-*).
 *
 * A "person's connection" is the connection key used since 0.12 ('grant:<id>' / 'token:<id>') with
 * its person in front: `<userId>/grant:<id>`. It is a target in a workspace while it is LIVE there:
 *   - the grant's refresh token has not expired (an OAuth grant is deleted on revoke), or the API
 *     token exists and has not expired;
 *   - its person is a member of the workspace (guests' connections are never targets);
 *   - its range includes the workspace (docs/adr/1200-*): all, the workspace in a 'workspaces'
 *     range, or a 'subtree' range rooted in the workspace;
 *   - an owner/admin has not blocked that OAuth client of that person there (docs/adr/0947-*).
 * Anything else means the person (docs/adr/1863-*).
 */

const SHORT_RE = /^([gt]):([0-9a-f]{4,32})$/i

/** SQL: the connection key in `conn` (text) is live in workspace `ws` (uuid). */
export function connectionLiveSql(conn: SQL, ws: SQL): SQL {
  return sql`(CASE
    WHEN ${conn} ~ '^grant:[0-9a-fA-F-]{36}$' THEN EXISTS (
      SELECT 1 FROM oauth_grants g
       WHERE g.id = substr(${conn}, 7)::uuid AND g.refresh_expires_at > now()
         AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${ws} AND m.user_id = g.user_id)
         AND ${rangeCoversSql(sql`g`, ws)}
         AND NOT EXISTS (SELECT 1 FROM workspace_agent_blocks b
                          WHERE b.workspace_id = ${ws} AND b.user_id = g.user_id AND (b.client_id IS NULL OR b.client_id = g.client_id)))
    WHEN ${conn} ~ '^token:[0-9a-fA-F-]{36}$' THEN EXISTS (
      SELECT 1 FROM api_tokens t
       WHERE t.id = substr(${conn}, 7)::uuid AND (t.expires_at IS NULL OR t.expires_at > now())
         AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${ws} AND m.user_id = t.user_id)
         AND ${rangeCoversSql(sql`t`, ws)})
    ELSE false END)`
}

/** SQL: the person (uuid) of connection key `conn`, null when the connection does not exist. */
export function connectionOwnerSql(conn: SQL): SQL {
  return sql`(CASE
    WHEN ${conn} ~ '^grant:[0-9a-fA-F-]{36}$' THEN (SELECT g.user_id FROM oauth_grants g WHERE g.id = substr(${conn}, 7)::uuid)
    WHEN ${conn} ~ '^token:[0-9a-fA-F-]{36}$' THEN (SELECT t.user_id FROM api_tokens t WHERE t.id = substr(${conn}, 7)::uuid)
  END)`
}

/** SQL: the range columns of table alias `a` include workspace `ws`. */
function rangeCoversSql(a: SQL, ws: SQL): SQL {
  return sql`(${a}.range_kind IS NULL OR ${a}.range_kind = 'all'
    OR (${a}.range_kind = 'workspaces' AND ${ws} = ANY(${a}.range_workspace_ids))
    OR (${a}.range_kind = 'subtree' AND EXISTS (SELECT 1 FROM pages rp WHERE rp.id = ${a}.range_page_id AND rp.workspace_id = ${ws} AND rp.deleted_at IS NULL)))`
}

interface ConnRow {
  key: string
  userId: string
  userName: string
  client: string
  kind: 'grant' | 'token'
  lastUsedAt: Date | string | null
}

/**
 * The live connections of the workspace's members, ordered by person name, client, last use, key
 * (deterministic). Both OAuth grants (MCP) and personal API tokens.
 */
export async function workspaceConnections(workspaceId: string, exec: Pick<Exec, 'execute'> = db): Promise<WorkspaceConnectionDTO[]> {
  const ws = sql`${workspaceId}::uuid`
  const rows = (await exec.execute(sql`
    SELECT x.* FROM (
      SELECT 'grant:' || g.id AS key, g.user_id AS "userId", u.name AS "userName", c.name AS client, 'grant' AS kind,
             g.last_used_at AS "lastUsedAt"
        FROM oauth_grants g
        JOIN oauth_clients c ON c.id = g.client_id
        JOIN users u ON u.id = g.user_id
        JOIN workspace_members m ON m.workspace_id = ${ws} AND m.user_id = g.user_id
       WHERE g.refresh_expires_at > now()
         AND ${rangeCoversSql(sql`g`, ws)}
         AND NOT EXISTS (SELECT 1 FROM workspace_agent_blocks b
                          WHERE b.workspace_id = ${ws} AND b.user_id = g.user_id AND (b.client_id IS NULL OR b.client_id = g.client_id))
      UNION ALL
      SELECT 'token:' || t.id, t.user_id, u.name, t.name, 'token', t.last_used_at
        FROM api_tokens t
        JOIN users u ON u.id = t.user_id
        JOIN workspace_members m ON m.workspace_id = ${ws} AND m.user_id = t.user_id
       WHERE (t.expires_at IS NULL OR t.expires_at > now())
         AND ${rangeCoversSql(sql`t`, ws)}
    ) x
    ORDER BY lower(x."userName"), x."userId", lower(x.client), x."lastUsedAt" DESC NULLS LAST, x.key
  `)) as unknown as ConnRow[]
  return rows.map((r) => ({
    ref: formatAgentRef({ userId: r.userId, connection: r.key as ConnectionKey }),
    key: r.key as ConnectionKey,
    userId: r.userId,
    userName: r.userName,
    client: r.client,
    kind: r.kind,
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
  }))
}

/**
 * Of `keys`, the connections whose range is a subtree (docs/adr/1200-*) that does not hold `pageId`:
 * such a connection never sees the page, so an item about it must not be handed to it (it would be
 * listed nowhere). One statement; a walk up from the page, capped like every tree walk.
 */
export async function connectionsOutsidePage(keys: string[], pageId: string, exec: Pick<Exec, 'execute'> = db): Promise<Set<string>> {
  const list = keys.filter((k) => CONNECTION_KEY_RE.test(k))
  if (!list.length) return new Set()
  const rows = (await exec.execute(sql`
    WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM pages WHERE id = ${pageId}::uuid
      UNION ALL
      SELECT p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
    )
    SELECT c.key FROM unnest(${`{${list.join(',')}}`}::text[]) AS c(key)
      LEFT JOIN oauth_grants g ON c.key = 'grant:' || g.id::text
      LEFT JOIN api_tokens t ON c.key = 'token:' || t.id::text
     WHERE coalesce(g.range_kind, t.range_kind) = 'subtree'
       AND NOT EXISTS (SELECT 1 FROM up WHERE up.id = coalesce(g.range_page_id, t.range_page_id))
  `)) as unknown as { key: string }[]
  return new Set(rows.map((r) => r.key))
}

export function agentRefError(message: string): AppError {
  return new AppError(400, 'AGENT_NOT_AVAILABLE', message)
}

/**
 * Resolves what a client or an agent wrote for "a person's connection" against the workspace's
 * live member connections: `<userId>/grant:<id>`, `grant:<id>` / `token:<id>`, or the short
 * `g:1a2b3c4d` / `t:1a2b3c4d` that MCP output prints. Refuses (400 AGENT_NOT_AVAILABLE) a connection
 * that is not live there, of a non-member, outside its range, or whose person is not the one named
 * in front of it — nothing is written then.
 */
export async function resolveAgentRefs(
  workspaceId: string,
  refs: string[],
  exec: Pick<Exec, 'execute'> = db,
  /** The page the hand-off is about: a connection limited to a subtree without it is refused. */
  pageId?: string,
): Promise<WorkspaceConnectionDTO[]> {
  if (!refs.length) return []
  const live = await workspaceConnections(workspaceId, exec)
  const out: WorkspaceConnectionDTO[] = []
  for (const raw of refs) {
    const s = raw.trim()
    let hit: WorkspaceConnectionDTO | undefined
    const full = parseAgentRef(s)
    if (full) {
      hit = live.find((c) => c.key === full.connection)
      if (hit && hit.userId !== full.userId) {
        throw agentRefError(`"${s}" names a connection of another person; nothing was written. Pick one from the person's own connections.`)
      }
    } else if (CONNECTION_KEY_RE.test(s)) {
      hit = live.find((c) => c.key === s.toLowerCase())
    } else {
      const m = SHORT_RE.exec(s)
      if (!m) throw agentRefError(`"${s}" is not a connection; use <userId>/grant:<id>, grant:<id>, token:<id> or the short g:xxxxxxxx`)
      const prefix = `${m[1].toLowerCase() === 'g' ? 'grant' : 'token'}:${m[2].toLowerCase()}`
      const hits = live.filter((c) => c.key.startsWith(prefix))
      if (hits.length > 1) throw agentRefError(`"${s}" matches ${hits.length} connections; use more characters of the id`)
      hit = hits[0]
    }
    if (!hit) {
      throw agentRefError(
        `"${s}" is not a live agent connection of a member of this workspace (revoked, expired, blocked here, ` +
          'outside its range, or not a member); nothing was written.',
      )
    }
    if (!out.some((o) => o.key === hit!.key)) out.push(hit)
  }
  if (pageId) {
    const outside = await connectionsOutsidePage(out.map((o) => o.key), pageId, exec)
    const o = out.find((x) => outside.has(x.key))
    if (o) {
      throw agentRefError(`"${o.userName} · ${o.client}" is limited to a part of the workspace that does not hold this page (its range); nothing was written.`)
    }
  }
  return out
}

/**
 * Hand back (docs/adr/1863-*): inbox items handed to a connection that is gone fall to its person —
 * their bell and every one of their connections' inboxes list them from then on. `keys` limits it to
 * those connections (the revoke routes); without, every handed item whose connection is no longer
 * live in its workspace (housekeeping: expiry, blocks, a person who left). Already acknowledged items
 * stay where they are (the agent handled them). Returns the people whose bell changed.
 */
export async function handBackConnections(keys: string[] | null, exec: Pick<Exec, 'execute'> = db): Promise<string[]> {
  if (keys && !keys.length) return []
  const which = keys
    ? sql`connection = ANY(${`{${keys.map((k) => k.replace(/[^a-z0-9:-]/gi, '')).join(',')}}`}::text[])`
    : sql`connection IS NOT NULL AND NOT ${connectionLiveSql(sql`connection`, sql`workspace_id`)}`
  const rows = (await exec.execute(sql`
    UPDATE notifications SET connection = NULL, person_too = false
     WHERE ${which} AND acked_at IS NULL
    RETURNING user_id AS "userId"
  `)) as unknown as { userId: string }[]
  return [...new Set(rows.map((r) => r.userId))]
}

// ---------------------------------------------------------------------------
// Board (docs/adr/1862-*)
// ---------------------------------------------------------------------------

export const TEAM_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_SUGGESTIONS = 100
const MAX_RECENT = 5
const BODY_KINDS = ['added', 'modified', 'removed', 'moved', 'renamed', 'page_renamed', 'page_moved', 'page_trashed', 'page_restored', 'page_visibility', 'page_props']

/** SQL: the viewer may see page row `p` now (live page, shared or theirs, inside their connection range). */
function visibleNowSql(viewerId: string): SQL {
  return sql`(p.id IS NOT NULL AND p.deleted_at IS NULL AND (p.scope = 'shared' OR p.created_by = ${viewerId})
             AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, viewerId)})`
}

const iso = (d: Date | string) => new Date(d).toISOString()

/**
 * The workspace's agents right now: live claims, open suggestions and what each person's agents did
 * since `sinceMs` (at most 7 days back), grouped by person. Titles and anchors of pages the viewer
 * cannot see are left out (`hidden`); the counts still include them.
 */
export async function readTeamAgents(workspaceId: string, viewerId: string, sinceMs: number, nowMs = Date.now()): Promise<TeamAgentsDTO> {
  const since = new Date(Math.max(sinceMs, nowMs - TEAM_WINDOW_MAX_MS))
  const sinceSql = sql`${since.toISOString()}::timestamptz`
  const vis = visibleNowSql(viewerId)

  const claims = (await db.execute(sql`
    SELECT l.page_id AS "pageId", l.anchor, l.user_id AS "userId", l.connection, coalesce(l.via, t.name, '') AS client,
           l.expires_at AS "expiresAt", greatest(0, floor(extract(epoch FROM l.expires_at - now())))::int AS ttl,
           CASE WHEN ${vis} THEN p.title END AS title, ${vis} AS visible
      FROM section_leases l
      LEFT JOIN pages p ON p.id = l.page_id
      LEFT JOIN api_tokens t ON l.connection = 'token:' || t.id::text
     WHERE l.workspace_id = ${workspaceId} AND l.expires_at > now()
     ORDER BY l.expires_at, l.page_id, l.anchor
  `)) as unknown as { pageId: string; anchor: string; userId: string; connection: string; client: string; expiresAt: Date | string; ttl: number; title: string | null; visible: boolean }[]

  const open = (await db.execute(sql`
    SELECT s.id, s.page_id AS "pageId", s.anchor, s.author_id AS "userId", s.mode, coalesce(s.via, t.name, '') AS client,
           s.created_at AS "createdAt", CASE WHEN ${vis} THEN p.title END AS title, ${vis} AS visible
      FROM section_suggestions s
      LEFT JOIN pages p ON p.id = s.page_id
      LEFT JOIN api_tokens t ON s.connection = 'token:' || t.id::text
     WHERE s.workspace_id = ${workspaceId} AND s.status = 'open'
     ORDER BY s.created_at DESC, s.id
     LIMIT ${MAX_SUGGESTIONS}
  `)) as unknown as { id: string; pageId: string; anchor: string; userId: string; mode: string; client: string; createdAt: Date | string; title: string | null; visible: boolean }[]
  const [{ n: openTotal }] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM section_suggestions WHERE workspace_id = ${workspaceId} AND status = 'open'
  `)) as unknown as { n: number }[]

  const activity = (await db.execute(sql`
    SELECT actor_id AS "userId", via_client AS client,
           count(*) FILTER (WHERE kind = ANY(${`{${BODY_KINDS.join(',')}}`}::text[]))::int AS edits,
           count(*) FILTER (WHERE kind = 'page_added')::int AS created,
           max(changed_at) AS "lastAt"
      FROM page_changes
     WHERE workspace_id = ${workspaceId} AND changed_at >= ${sinceSql} AND via_client IS NOT NULL AND actor_id IS NOT NULL
     GROUP BY actor_id, via_client
  `)) as unknown as { userId: string; client: string; edits: number; created: number; lastAt: Date | string }[]

  const recent = (await db.execute(sql`
    SELECT r."userId", r.client, r."pageId", r.at, CASE WHEN ${vis} THEN p.title END AS title, ${vis} AS visible
      FROM (
        SELECT x.*, row_number() OVER (PARTITION BY x."userId", x.client ORDER BY x.at DESC, x."pageId") AS rn
          FROM (
            SELECT actor_id AS "userId", via_client AS client, page_id AS "pageId", max(changed_at) AS at
              FROM page_changes
             WHERE workspace_id = ${workspaceId} AND changed_at >= ${sinceSql} AND via_client IS NOT NULL AND actor_id IS NOT NULL
             GROUP BY actor_id, via_client, page_id
          ) x
      ) r
      LEFT JOIN pages p ON p.id = r."pageId"
     WHERE r.rn <= ${MAX_RECENT}
     ORDER BY r."userId", r.client, r.at DESC, r."pageId"
  `)) as unknown as { userId: string; client: string; pageId: string; at: Date | string; title: string | null; visible: boolean }[]

  const suggested = (await db.execute(sql`
    SELECT s.author_id AS "userId", coalesce(s.via, t.name, '') AS client, count(*)::int AS n, max(s.created_at) AS "lastAt"
      FROM section_suggestions s
      LEFT JOIN api_tokens t ON s.connection = 'token:' || t.id::text
     WHERE s.workspace_id = ${workspaceId} AND s.created_at >= ${sinceSql} AND s.connection <> ''
     GROUP BY 1, 2
  `)) as unknown as { userId: string; client: string; n: number; lastAt: Date | string }[]

  // Reverted: changes of an agent named by a revert event in the window (docs/adr/1623-*).
  const reverted = (await db.execute(sql`
    SELECT pc.actor_id AS "userId", pc.via_client AS client, count(DISTINCT pc.seq)::int AS n
      FROM workspace_audit_events e
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(e.before->'seqs', '[]'::jsonb)) s(seq)
      JOIN page_changes pc ON pc.seq = s.seq::bigint
     WHERE e.workspace_id = ${workspaceId} AND e.action = 'page.changes_reverted' AND e.created_at >= ${sinceSql}
       AND pc.via_client IS NOT NULL AND pc.actor_id IS NOT NULL
     GROUP BY 1, 2
  `)) as unknown as { userId: string; client: string; n: number }[]

  const conns = await workspaceConnections(workspaceId)

  // ---- group by person, then by agent (client name) ----
  const userIds = new Set<string>()
  for (const r of [...claims, ...open, ...activity, ...suggested, ...reverted]) userIds.add(r.userId)
  for (const c of conns) userIds.add(c.userId)
  const names = new Map<string, string>()
  if (userIds.size) {
    const rows = (await db.execute(sql`
      SELECT id, name FROM users WHERE id = ANY(${`{${[...userIds].join(',')}}`}::uuid[])
    `)) as unknown as { id: string; name: string }[]
    for (const r of rows) names.set(r.id, r.name)
  }
  const people = new Map<string, TeamPersonDTO>()
  const person = (userId: string): TeamPersonDTO => {
    let p = people.get(userId)
    if (!p) {
      p = { userId, name: names.get(userId) ?? '', agents: [], claims: [], suggestions: [] }
      people.set(userId, p)
    }
    return p
  }
  const agent = (userId: string, client: string): TeamAgentActivityDTO => {
    const p = person(userId)
    let a = p.agents.find((x) => x.client === client)
    if (!a) {
      a = { client, connections: [], edits: 0, created: 0, suggestions: 0, reverted: 0, recentPages: [], lastAt: null }
      p.agents.push(a)
    }
    return a
  }
  const later = (a: string | null, b: Date | string) => (a && a > iso(b) ? a : iso(b))
  for (const c of conns) agent(c.userId, c.client).connections.push(c.key)
  for (const r of activity) {
    const a = agent(r.userId, r.client)
    a.edits += r.edits
    a.created += r.created
    a.lastAt = later(a.lastAt, r.lastAt)
  }
  for (const r of suggested) {
    const a = agent(r.userId, r.client)
    a.suggestions += r.n
    a.lastAt = later(a.lastAt, r.lastAt)
  }
  for (const r of reverted) agent(r.userId, r.client).reverted += r.n
  for (const r of recent) {
    agent(r.userId, r.client).recentPages.push({ pageId: r.pageId, title: r.visible ? (r.title ?? '') : null, hidden: !r.visible, at: iso(r.at) })
  }
  for (const r of claims) {
    const c: TeamClaimDTO = {
      pageId: r.pageId,
      pageTitle: r.visible ? (r.title ?? '') : null,
      anchor: r.visible ? r.anchor : null,
      hidden: !r.visible,
      connection: r.connection,
      client: r.client,
      expiresAt: iso(r.expiresAt),
      ttlSeconds: Number(r.ttl),
    }
    person(r.userId).claims.push(c)
  }
  for (const r of open) {
    const s: TeamSuggestionDTO = {
      id: r.id,
      pageId: r.pageId,
      pageTitle: r.visible ? (r.title ?? '') : null,
      anchor: r.visible ? r.anchor : null,
      hidden: !r.visible,
      mode: r.mode,
      client: r.client,
      createdAt: iso(r.createdAt),
    }
    person(r.userId).suggestions.push(s)
  }
  const list = [...people.values()]
  for (const p of list) {
    // agents with something to show first (most recent), then idle connections by name
    p.agents.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.client.localeCompare(b.client))
  }
  list.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
  const sum = (f: (a: TeamAgentActivityDTO) => number) => list.reduce((n, p) => n + p.agents.reduce((m, a) => m + f(a), 0), 0)
  return {
    since: since.toISOString(),
    now: new Date(nowMs).toISOString(),
    people: list,
    totals: {
      claims: claims.length,
      openSuggestions: openTotal,
      edits: sum((a) => a.edits),
      created: sum((a) => a.created),
      suggestions: sum((a) => a.suggestions),
      reverted: sum((a) => a.reverted),
    },
  }
}

// ---------------------------------------------------------------------------
// Person cells (docs/adr/1861-*, 1864-*)
// ---------------------------------------------------------------------------

interface PersonFieldLike {
  id: string
  name: string
  type: string
}

const peopleOf = (v: unknown): string[] =>
  typeof v === 'string' && v ? [v.toLowerCase()] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : []

/**
 * Agent keys of one row write (`props` as the client sent it; null = delete), checked and normalised
 * in place: every `agent:<fieldId>` must name a person field of the collection and a live connection
 * of a member; it is stored as `<person>/<key>`, and the cell is set to that person when the write
 * leaves it empty. A cell set to someone else in the same write is refused (the agent would belong to
 * another person). A person cell the write changes without naming its agent key loses the old agent
 * when the agent's person is no longer in the cell. Returns the newly assigned connections per field.
 */
export async function normalizeAgentProps(
  workspaceId: string,
  fields: PersonFieldLike[],
  oldProps: Record<string, unknown>,
  props: Record<string, unknown>,
  /** The row: a connection whose subtree range leaves it out cannot be assigned. */
  rowId?: string,
): Promise<{ field: string; fieldId: string; conn: WorkspaceConnectionDTO }[]> {
  const persons = new Map(fields.filter((f) => f.type === 'person').map((f) => [f.id, f]))
  const assigned: { field: string; fieldId: string; conn: WorkspaceConnectionDTO }[] = []
  for (const key of Object.keys(props)) {
    if (!key.startsWith(AGENT_PROP_PREFIX)) continue
    const fid = key.slice(AGENT_PROP_PREFIX.length)
    const field = persons.get(fid)
    if (!field) throw agentRefError(`"${key}" does not name a person field of this collection`)
    const v = props[key]
    if (v === null) continue
    if (typeof v !== 'string') throw agentRefError(`"${key}" expects a connection (<userId>/grant:<id>, grant:<id> or g:xxxxxxxx)`)
    const [conn] = await resolveAgentRefs(workspaceId, [v], db, rowId)
    // Assigning an agent assigns its person: the cell becomes that person unless the same write
    // names the cell's people itself, which must then include them.
    const named = fid in props && props[fid] !== null ? peopleOf(props[fid]) : []
    if (!named.length) props[fid] = conn.userId
    else if (!named.includes(conn.userId)) {
      throw agentRefError(`"${field.name}" names another person; an agent can only be assigned together with its own person`)
    }
    props[key] = conn.ref
    const before = parseAgentRef(oldProps[key])
    if (!before || before.connection !== conn.key || !peopleOf(oldProps[fid]).includes(conn.userId)) {
      assigned.push({ field: field.name, fieldId: fid, conn })
    }
  }
  for (const fid of persons.keys()) {
    const key = agentPropKey(fid)
    if (!(fid in props) || key in props || oldProps[key] === undefined) continue
    const before = parseAgentRef(oldProps[key])
    if (!before || !peopleOf(props[fid]).includes(before.userId)) props[key] = null
  }
  return assigned
}

/**
 * `Client (g:1a2b3c4d)` per `<rowId>|<fieldId>` for person cells whose agent key names a live
 * connection of the person in the cell (query_rows output, docs/adr/1864-*). One query per call.
 */
export async function agentCellLabels(
  workspaceId: string,
  personFields: { id: string }[],
  rows: { id: string; props: Record<string, unknown> }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const wanted: { key: string; ref: { userId: string; connection: string } }[] = []
  for (const r of rows) {
    for (const f of personFields) {
      const ref = agentRefOfCell(r.props, f.id)
      if (ref) wanted.push({ key: `${r.id}|${f.id}`, ref })
    }
  }
  if (!wanted.length) return out
  const live = new Map((await workspaceConnections(workspaceId)).map((c) => [c.key, c]))
  for (const w of wanted) {
    const c = live.get(w.ref.connection as ConnectionKey)
    if (c && c.userId === w.ref.userId) out.set(w.key, `${c.client} (${shortConnection(c.key)})`)
  }
  return out
}
