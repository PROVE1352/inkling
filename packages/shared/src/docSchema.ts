// Document schema versions (docs/adr/2425-*).
//
// A browser renders a page through y-prosemirror, which deletes every Yjs node its schema does not
// know (ADR 0940) and sends that deletion to the server like any edit. A tab of an older release that
// opens a page holding a newer node type would remove that node, content included. So each client
// says which document schema it knows when it opens the collaboration socket, and the server takes
// writes only from clients that know every node type in the document.
//
// Bump DOC_SCHEMA_VERSION when a release adds a node type to the editor schema, and list the new
// node names in NODE_SCHEMA with the new version. Clients that send no version (0.19 and older) are 1.

/** The document schema this build knows. 1 = 0.19 and older, 2 = 0.20 (columns). */
export const DOC_SCHEMA_VERSION = 2

/** Node names (Yjs XmlElement names) that need a schema above 1, with the first version that knows them. */
export const NODE_SCHEMA: Readonly<Record<string, number>> = {
  columnList: 2,
  column: 2,
}

/** Query parameter of the collaboration socket URL (and of GET /pages/:id/sync-check) carrying the version. */
export const SCHEMA_PARAM = 'schema'

/** A version as sent by a client: a whole number ≥ 1, anything else (missing, garbage) is 1. */
export function parseSchemaVersion(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 ? n : 1
}
