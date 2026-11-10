// Zoom and pan arithmetic of the image viewer (components/imageViewer, docs/adr/2386-*). Pure functions,
// no DOM, so node:test covers them. The image is drawn at its natural size with
// `transform: translate(x, y) scale(scale)` and `transform-origin: 0 0`, inside a stage of vw × vh.

export type View = { scale: number; x: number; y: number }
export type Size = { w: number; h: number }

/** The largest zoom step and the factor of one +/- press. */
export const MAX_SCALE = 8
export const STEP = 1.25

/** Scale that fits the image in the stage, never above 100% (a small image is not blown up). */
export function fitScale(img: Size, stage: Size): number {
  if (img.w <= 0 || img.h <= 0 || stage.w <= 0 || stage.h <= 0) return 1
  return Math.min(1, stage.w / img.w, stage.h / img.h)
}

/** Lowest scale allowed: the fit (or 100% for an image smaller than the stage). */
export function minScale(img: Size, stage: Size): number {
  return fitScale(img, stage)
}

export function clampScale(scale: number, img: Size, stage: Size): number {
  const lo = minScale(img, stage)
  const hi = Math.max(MAX_SCALE, lo)
  return Math.min(hi, Math.max(lo, scale))
}

/**
 * Keeps the image on screen: along an axis where it is smaller than the stage it is centred, along
 * one where it is larger no empty band may open at either edge.
 */
export function clampPan(v: View, img: Size, stage: Size): View {
  const axis = (pos: number, len: number, room: number) => (len <= room ? (room - len) / 2 : Math.min(0, Math.max(room - len, pos)))
  return { scale: v.scale, x: axis(v.x, img.w * v.scale, stage.w), y: axis(v.y, img.h * v.scale, stage.h) }
}

/** The fitted, centred view. */
export function fitView(img: Size, stage: Size): View {
  return clampPan({ scale: fitScale(img, stage), x: 0, y: 0 }, img, stage)
}

/** Zoom to `scale` keeping the image point under (px, py) — stage coordinates — where it is. */
export function zoomAt(v: View, scale: number, px: number, py: number, img: Size, stage: Size): View {
  const s = clampScale(scale, img, stage)
  const k = s / v.scale
  return clampPan({ scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, img, stage)
}

/** One +/- step about the stage centre. */
export function stepZoom(v: View, dir: 1 | -1, img: Size, stage: Size): View {
  return zoomAt(v, dir > 0 ? v.scale * STEP : v.scale / STEP, stage.w / 2, stage.h / 2, img, stage)
}

/**
 * Wheel factor: a mouse wheel notch (deltaY ±100 px) is about one step; a trackpad pinch (Chrome and
 * Safari send it as wheel + ctrlKey with small deltas) is more sensitive. deltaMode 1 = lines.
 */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  const k = ctrlKey ? 0.01 : 0.0022
  return Math.exp(-Math.max(-300, Math.min(300, px)) * k)
}

/** Double-click: the fitted view ↔ 100% about the clicked point. */
export function toggleActual(v: View, px: number, py: number, img: Size, stage: Size): View {
  const fit = fitScale(img, stage)
  const atFit = Math.abs(v.scale - fit) < 0.001
  if (atFit && fit < 1) return zoomAt(v, 1, px, py, img, stage)
  return fitView(img, stage)
}

/** "128%" for the top bar. */
export function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/** Last path segment of an image address, decoded, without the query (a name to show when there is none). */
export function fileNameFromUrl(src: string): string {
  if (src.startsWith('data:')) return ''
  let path = src
  try {
    path = new URL(src, 'http://x.invalid').pathname
  } catch {
    path = src.split(/[?#]/)[0]
  }
  const last = path.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}
