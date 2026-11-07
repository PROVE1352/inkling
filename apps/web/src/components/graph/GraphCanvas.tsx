import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useTheme } from '../../lib/theme'
import { GraphEngine, type EngineSettings } from './graphEngine'
import { readGraphColors, type GraphModel } from './graphModel'

export type GraphCanvasHandle = {
  fit: () => void
  centerOn: (id: string) => void
}

// Canvas graph renderer (shared by the full graph and the local graph).
// The engine is created once on mount and destroyed on unmount; props are fed in through effects.
export function GraphCanvas({
  model,
  settings,
  focusId = null,
  search = '',
  active = true,
  fontSize,
  onOpen,
  className,
  ref,
}: {
  model: GraphModel
  settings: EngineSettings
  focusId?: string | null
  search?: string
  /** false pauses the animation loop (collapsed panel, behind a modal, etc.) */
  active?: boolean
  fontSize?: number
  onOpen: (id: string) => void
  className?: string
  ref?: Ref<GraphCanvasHandle>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<GraphEngine | null>(null)
  const { resolved } = useTheme()
  // Latest callback/settings live in refs so the engine-creation effect does not depend on them.
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const initRef = useRef({ settings, resolved, fontSize })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const init = initRef.current
    const eng = new GraphEngine(
      host,
      init.settings,
      readGraphColors(init.resolved === 'dark'),
      { onOpen: (id) => onOpenRef.current(id) },
      { fontSize: init.fontSize },
    )
    engineRef.current = eng
    // Instrumentation handle for verification scripts (dev builds only)
    if (import.meta.env.DEV) (window as unknown as { __graphEngine?: GraphEngine }).__graphEngine = eng
    return () => {
      eng.destroy()
      engineRef.current = null
      if (import.meta.env.DEV) {
        const w = window as unknown as { __graphEngine?: GraphEngine }
        if (w.__graphEngine === eng) delete w.__graphEngine
      }
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setData(model.nodes, model.links)
  }, [model])

  useEffect(() => {
    engineRef.current?.setSettings(settings)
  }, [settings])

  useEffect(() => {
    // Re-read the CSS variables after the theme class changes
    engineRef.current?.setColors(readGraphColors(resolved === 'dark'))
  }, [resolved])

  useEffect(() => {
    engineRef.current?.setFocus(focusId)
  }, [focusId])

  useEffect(() => {
    engineRef.current?.setSearch(search)
  }, [search, model])

  // Pause the loop while off-screen (e.g. right panel scrolled out of view)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((es) => setVisible(es[es.length - 1].isIntersecting))
    io.observe(host)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    engineRef.current?.setActive(active && visible)
  }, [active, visible])

  useImperativeHandle(
    ref,
    () => ({
      fit: () => engineRef.current?.fit(),
      centerOn: (id) => engineRef.current?.centerOn(id),
    }),
    [],
  )

  return <div ref={hostRef} className={`relative overflow-hidden ${className ?? ''}`} />
}
