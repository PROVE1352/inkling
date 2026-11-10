import { index, integer, pgTable, primaryKey, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages, workspaces } from './schema'

/**
 * Optional semantic search (docs/adr/1740-*): one embedding per section-index chunk (page_chunks),
 * stored only while EMBEDDING_URL and EMBEDDING_MODEL are set. Nothing reads or writes this table
 * when the feature is off.
 *
 * Content-addressed per page: `text_hash` = md5 of the embedded text (page title, heading path and
 * chunk text), so a chunk that moved to another position keeps its vector and an edited chunk gets
 * a new row. Rows whose hash matches no current chunk are never served and are removed by the
 * indexer. No foreign key to page_chunks: the section-index writer stays exactly as it was.
 *
 * `embedding` is a plain `real[]` (no pgvector, docs/adr/1741-*), L2-normalised at write time so
 * cosine similarity is a dot product. `model` + `dims` decide whether a row is current: another
 * model name or another vector length means the chunk is embedded again.
 */
export const pageChunkVectors = pgTable(
  'page_chunk_vectors',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    textHash: text('text_hash').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    dims: integer('dims').notNull(),
    embedding: real('embedding').array().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.textHash] }),
    index('page_chunk_vectors_workspace_idx').on(t.workspaceId, t.updatedAt),
  ],
)
