// Minimal toast store (M10). Subscribed via useSyncExternalStore; rendered by components/Toast.tsx.
// ToastContainer is mounted once at the AppLayout root; call toast(...) from anywhere.
// Dismissing marks the toast `leaving` for its exit fade (docs/adr/1281-*) and removes it EXIT_MS later.
import { EXIT_MS, exitDelay, prefersReducedMotion } from './motion'

export type ToastInput = {
  message: string
  actionLabel?: string
  onAction?: () => void
  duration?: number
}

export type ToastItem = ToastInput & { id: number; leaving?: boolean }

let items: ToastItem[] = []
const listeners = new Set<() => void>()
let seq = 0

function emit() {
  for (const l of listeners) l()
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Stable reference: build a new array only on change (prevents a useSyncExternalStore infinite loop).
export function getToasts(): ToastItem[] {
  return items
}

export function toast(input: ToastInput): number {
  const id = ++seq
  items = [...items, { ...input, id }]
  emit()
  const duration = input.duration ?? 5000
  if (duration > 0 && typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), duration)
  }
  return id
}

export function dismissToast(id: number, exitMs: number = exitDelay(prefersReducedMotion(), EXIT_MS)): void {
  const item = items.find((t) => t.id === id)
  if (!item || item.leaving) return
  if (exitMs <= 0) {
    removeToast(id)
    return
  }
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t))
  emit()
  setTimeout(() => removeToast(id), exitMs)
}

function removeToast(id: number): void {
  const next = items.filter((t) => t.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}
