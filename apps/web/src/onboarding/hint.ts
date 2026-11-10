// A short speech bubble that points at a place on the screen ("press here"), for the checklist's
// items (docs/adr/2380-*). It never blocks the page: no backdrop, it goes away on any click, on Esc,
// on a route change or after a few seconds. When the place cannot be found (a phone layout, a menu
// that is closed) the bubble sits at the bottom of the window with the same words.

let current: (() => void) | null = null

export function closeHint(): void {
  current?.()
  current = null
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
}

function find(selectors: readonly string[]): Element | null {
  for (const s of selectors) {
    try {
      for (const el of document.querySelectorAll(s)) if (visible(el)) return el
    } catch {
      // a selector built from a translated label can be invalid CSS; try the next one
    }
  }
  return null
}

/** Show the bubble next to the first visible match of `selectors` (waits up to 3 s for it to render). */
export function showHint(selectors: readonly string[], text: string, closeLabel: string): void {
  closeHint()
  let stopped = false
  const started = Date.now()
  const tick = () => {
    if (stopped) return
    const el = find(selectors)
    if (el || Date.now() - started > 3000) place(el)
    else window.setTimeout(tick, 120)
  }
  current = () => {
    stopped = true
  }
  window.setTimeout(tick, 60)

  function place(target: Element | null) {
    const bubble = document.createElement('div')
    bubble.setAttribute('role', 'status')
    bubble.dataset.testid = 'onboarding-hint'
    bubble.style.cssText = [
      'position:fixed',
      'z-index:70',
      'max-width:min(320px,calc(100vw - 32px))',
      'padding:10px 34px 10px 12px',
      'border-radius:var(--radius-lg)',
      'background:var(--color-accent)',
      'color:#fff',
      'font:500 13px/1.45 var(--font-sans)',
      'box-shadow:var(--shadow-lg)',
      'pointer-events:auto',
    ].join(';')
    bubble.textContent = text
    const x = document.createElement('button')
    x.type = 'button'
    x.setAttribute('aria-label', closeLabel)
    x.textContent = '×'
    x.style.cssText = 'position:absolute;top:4px;right:6px;border:0;background:transparent;color:#fff;font:600 16px/1 var(--font-sans);cursor:pointer;padding:4px'
    bubble.appendChild(x)

    const ring = document.createElement('div')
    ring.style.cssText = 'position:fixed;z-index:69;pointer-events:none;border-radius:var(--radius-md);box-shadow:0 0 0 3px var(--color-accent),0 0 0 7px var(--color-accent-soft)'
    document.body.append(bubble)
    if (target) document.body.append(ring)

    const layout = () => {
      const b = bubble.getBoundingClientRect()
      if (!target || !target.isConnected) {
        bubble.style.left = `${Math.max(16, (window.innerWidth - b.width) / 2)}px`
        bubble.style.top = `${window.innerHeight - b.height - 24}px`
        ring.remove()
        return
      }
      const r = target.getBoundingClientRect()
      ring.style.left = `${r.left - 2}px`
      ring.style.top = `${r.top - 2}px`
      ring.style.width = `${r.width + 4}px`
      ring.style.height = `${Math.min(r.height, window.innerHeight) + 4}px`
      const below = r.bottom + 10 + b.height < window.innerHeight
      const top = below ? r.bottom + 10 : Math.max(8, r.top - b.height - 10)
      const left = Math.min(Math.max(8, r.left), window.innerWidth - b.width - 8)
      bubble.style.top = `${Math.min(top, window.innerHeight - b.height - 8)}px`
      bubble.style.left = `${left}px`
    }
    layout()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done()
    }
    const onDown = () => done()
    const startPath = location.pathname
    const iv = window.setInterval(() => {
      if (location.pathname !== startPath) done()
      else layout()
    }, 250)
    const timer = window.setTimeout(done, 9000)
    // the click that opened the hint is still bubbling: listen from the next task on
    window.setTimeout(() => {
      window.addEventListener('pointerdown', onDown, true)
      window.addEventListener('keydown', onKey, true)
    }, 0)
    x.addEventListener('click', done)
    function done() {
      window.clearInterval(iv)
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      bubble.remove()
      ring.remove()
      if (current === done) current = null
    }
    if (!stopped) current = done
  }
}
