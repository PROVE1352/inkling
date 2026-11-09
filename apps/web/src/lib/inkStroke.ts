// Stroke geometry lives in @inkling/shared (docs/adr/1511-*): the server renders the same outline
// to PNG for agents (read_ink), so the web layer and the agent's picture never drift apart.
export { strokeHit, strokeOutline, strokePath, toPoints } from '@inkling/shared'
export type { InkPoint, StrokeOutline } from '@inkling/shared'
