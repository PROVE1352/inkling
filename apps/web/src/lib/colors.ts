// Colour palette for collaboration cursors/avatars. Picks a colour by hashing the id string.
// (Deterministic hash, so the same user always gets the same colour.)
const PALETTE = [
  '#e03e3e', // red
  '#d9730d', // orange
  '#cb912f', // yellow
  '#0f7b6c', // green
  '#0b6e99', // blue
  '#6940a5', // purple
  '#ad1a72', // pink
  '#e255a1', // magenta
  '#448361', // teal
  '#337ea9', // cyan
]

export function userColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}
