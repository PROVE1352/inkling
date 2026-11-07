// Keeps a just-jumped-to block where the jump put it while the page is still settling
// (docs/adr/0998-*). Content above it can still change size after the jump: formulas render
// (KaTeX arrives asynchronously, in paced batches), images load, embeds expand. Without this a
// `?block=` jump into a long page with math landed thousands of pixels away from its target.
// For `ms` after the jump the target's offset is restored every frame; any user scroll or input
// ends it at once.

function scrollParent(el: Element): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return document.scrollingElement ?? document.documentElement
}

/** `find` returns the target each frame: the editor may replace a block's element while it renders. */
export function pinAnchor(find: () => Element | null, ms = 4000): () => void {
  const first = find()
  if (!first) return () => {}
  const scroller = scrollParent(first)
  const want = first.getBoundingClientRect().top
  const until = performance.now() + ms
  let raf = 0
  const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
  const stop = () => {
    cancelAnimationFrame(raf)
    for (const e of events) window.removeEventListener(e, stop, true)
  }
  const tick = () => {
    const el = find()
    if (!el || performance.now() > until) return stop()
    const drift = el.getBoundingClientRect().top - want
    if (Math.abs(drift) > 1) scroller.scrollTop += drift
    raf = requestAnimationFrame(tick)
  }
  for (const e of events) window.addEventListener(e, stop, { capture: true, passive: true })
  raf = requestAnimationFrame(tick)
  return stop
}
