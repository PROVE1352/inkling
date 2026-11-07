import { z } from 'zod'

/**
 * Plugin manifest (v0) — schema + validation. Pure module (no fs / DB) so it is unit-testable.
 * See docs/PLUGINS.md "manifest.json".
 */

/** Mirrors apps/server/package.json "version". Bump both together. */
export const APP_VERSION = '0.1.0'

export const PLUGIN_PERMISSIONS = [
  'commands',
  'read:pages',
  'write:pages',
  'blocks',
  'storage',
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** Lowercase slug: also the on-disk directory name and part of every plugin URL. */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
/** Command ids and block types. */
export const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/
/**
 * The entry is a bare file name in the plugin directory: no separators, no "..", must end in .js.
 * v0 plugins ship a single pre-bundled script; nothing else in the directory is ever served.
 */
const ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.js$/

export const MAX_MANIFEST_BYTES = 64 * 1024
export const MAX_ENTRY_BYTES = 1024 * 1024
const MAX_DEFAULT_DATA_BYTES = 4 * 1024

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
)

const commandSchema = z.strictObject({
  id: z.string().regex(LOCAL_ID_RE, 'command id must match ^[a-z0-9][a-z0-9-]{0,63}$'),
  title: z.string().trim().min(1).max(80),
})

const blockSchema = z.strictObject({
  type: z.string().regex(LOCAL_ID_RE, 'block type must match ^[a-z0-9][a-z0-9-]{0,63}$'),
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  /** initial `data` for a newly inserted block (JSON, ≤ 4 KB) */
  defaultData: z
    .record(z.string(), jsonValue)
    .optional()
    .refine(
      (v) => v === undefined || Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_DEFAULT_DATA_BYTES,
      'defaultData must be at most 4 KB of JSON',
    ),
  /** initial iframe height in px before the plugin reports its own (clamped 40..800) */
  height: z.number().int().min(40).max(800).optional(),
})

export const manifestSchema = z
  .strictObject({
    id: z.string().regex(PLUGIN_ID_RE, 'id must match ^[a-z0-9][a-z0-9-]{1,63}$'),
    name: z.string().trim().min(1).max(60),
    version: z.string().regex(SEMVER_RE, 'version must be semver (x.y.z)'),
    minAppVersion: z.string().regex(SEMVER_RE, 'minAppVersion must be semver (x.y.z)'),
    description: z.string().trim().max(300).optional(),
    author: z.string().trim().max(100).optional(),
    entry: z
      .string()
      .regex(ENTRY_RE, 'entry must be a bare .js file name in the plugin directory'),
    permissions: z
      .array(z.enum(PLUGIN_PERMISSIONS))
      .max(PLUGIN_PERMISSIONS.length)
      .refine((p) => new Set(p).size === p.length, 'permissions must not repeat'),
    commands: z.array(commandSchema).max(20).optional(),
    blocks: z.array(blockSchema).max(10).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.entry.includes('..')) {
      ctx.addIssue({ code: 'custom', path: ['entry'], message: 'entry must not contain ".."' })
    }
    if (m.commands?.length && !m.permissions.includes('commands')) {
      ctx.addIssue({ code: 'custom', path: ['commands'], message: 'declaring commands requires the "commands" permission' })
    }
    if (m.blocks?.length && !m.permissions.includes('blocks')) {
      ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'declaring blocks requires the "blocks" permission' })
    }
    const dup = (xs: string[]) => new Set(xs).size !== xs.length
    if (m.commands && dup(m.commands.map((c) => c.id))) {
      ctx.addIssue({ code: 'custom', path: ['commands'], message: 'command ids must be unique' })
    }
    if (m.blocks && dup(m.blocks.map((b) => b.type))) {
      ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'block types must be unique' })
    }
    if (compareSemver(m.minAppVersion, APP_VERSION) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['minAppVersion'],
        message: `requires app ${m.minAppVersion}, this server is ${APP_VERSION}`,
      })
    }
  })

export type PluginManifest = z.infer<typeof manifestSchema>

/** Compare x.y.z (pre-release suffix ignored). Returns -1 / 0 / 1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string }

/**
 * Parse + validate raw manifest bytes. `dirName` is the directory the manifest was found in;
 * it must equal the manifest id (so a plugin cannot claim another plugin's id / URL space).
 */
export function parseManifest(raw: Buffer | string, dirName: string): ManifestResult {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
  if (bytes > MAX_MANIFEST_BYTES) return { ok: false, error: 'manifest.json is larger than 64 KB' }
  let json: unknown
  try {
    json = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    return { ok: false, error: 'manifest.json is not valid JSON' }
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.join('.') || '(root)'
    return { ok: false, error: `${at}: ${issue?.message ?? 'invalid manifest'}` }
  }
  if (parsed.data.id !== dirName) {
    return { ok: false, error: `id "${parsed.data.id}" does not match directory name "${dirName}"` }
  }
  return { ok: true, manifest: parsed.data }
}
