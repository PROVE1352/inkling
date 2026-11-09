// Runtime handlers for registry commands (docs/adr/1400-*). The registry says which key does what;
// the component that owns the state (AppLayout's dialogs, PageView's panel and pen mode, HeadingFolds'
// folds, the pen layer's strokes) binds the handler with useCommand(). The key dispatcher, the editor
// keymap and the command palette all run commands through runCommand(), so a command behaves the
// same however it is started.
import { useEffect, useRef } from 'react'

export type CommandHandler = {
  /** Return false when nothing happened (the key then goes on to the browser). */
  run: () => boolean | void
  /** Hidden from the palette and ignored by keys while false (a guest, no page open, …). */
  enabled?: () => boolean
}

// A stack per id: the latest mounted owner wins, an unmount uncovers the previous one.
const table = new Map<string, CommandHandler[]>()
const listeners = new Set<() => void>()

export function bindCommand(id: string, handler: CommandHandler): () => void {
  const list = table.get(id) ?? []
  list.push(handler)
  table.set(id, list)
  listeners.forEach((l) => l())
  return () => {
    const cur = table.get(id)
    if (!cur) return
    const i = cur.lastIndexOf(handler)
    if (i >= 0) cur.splice(i, 1)
    if (cur.length === 0) table.delete(id)
    listeners.forEach((l) => l())
  }
}

function top(id: string): CommandHandler | undefined {
  const list = table.get(id)
  return list?.[list.length - 1]
}

export function isAvailable(id: string): boolean {
  const h = top(id)
  if (!h) return false
  try {
    return h.enabled ? h.enabled() : true
  } catch {
    return false
  }
}

/** Runs the command if it is bound and enabled. True when it did something. */
export function runCommand(id: string): boolean {
  const h = top(id)
  if (!h || !isAvailable(id)) return false
  return h.run() !== false
}

/** Called when the set of bound commands changes (the palette re-reads availability). */
export function onCommandsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Binds `run` to command `id` while the component is mounted. The latest `run`/`enabled` are read
 * through refs, so callers pass plain closures without memoizing them.
 */
export function useCommand(id: string, run: () => boolean | void, enabled?: () => boolean): void {
  const runRef = useRef(run)
  const enabledRef = useRef(enabled)
  runRef.current = run
  enabledRef.current = enabled
  useEffect(
    () =>
      bindCommand(id, {
        run: () => runRef.current(),
        enabled: () => (enabledRef.current ? enabledRef.current() : true),
      }),
    [id],
  )
}
