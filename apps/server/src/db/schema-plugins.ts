import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

/**
 * Plugin API v0 (experimental `plugins`) — see docs/PLUGINS.md and docs/adr/0400-*.
 *
 * Plugin code lives on disk (PLUGINS_DIR/<id>/manifest.json + entry JS) and is installed by the
 * server operator only. This table records the administrator's approval decision.
 *
 * Approval is pinned to a content hash of manifest.json + entry bundle. If either file changes on
 * disk the hash no longer matches, the plugin is treated as "needs re-approval" and is neither
 * listed to users nor served — a silent bundle swap or a permission bump cannot take effect
 * without an admin looking at it again.
 */
export const pluginInstalls = pgTable('plugin_installs', {
  /** manifest id (validated: ^[a-z0-9][a-z0-9-]{1,63}$) — also the directory name. */
  id: text('id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** manifest version at approval time (display only; the hash is what is enforced). */
  approvedVersion: text('approved_version'),
  /** permissions the admin granted (always a subset of the manifest's requested permissions). */
  approvedPermissions: jsonb('approved_permissions').$type<string[]>().notNull().default([]),
  /** sha256(manifest.json bytes || 0x00 || entry bytes) at approval time. */
  approvedHash: text('approved_hash'),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Per-plugin, per-user key/value storage (permission `storage`).
 * Limits are enforced in apps/server/src/plugins/storage.ts (key length, value bytes, key count,
 * total bytes per plugin+user). `bytes` caches the UTF-8 size of `value` so the quota check is a
 * single SUM over the primary-key prefix (plugin_id, user_id) — no full scan.
 */
export const pluginStorage = pgTable(
  'plugin_storage',
  {
    pluginId: text('plugin_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** JSON text exactly as sent by the plugin (validated as JSON, size-capped). */
    value: text('value').notNull(),
    bytes: integer('bytes').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.userId, t.key] })],
)
