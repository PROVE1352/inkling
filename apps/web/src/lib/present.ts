// Presentation mode (docs/adr/1843-*): a page's top-level blocks split into slides at its
// highest-level headings and at dividers. Works on DOM elements, so the same split serves the live
// editor (cloned blocks) and a public link's server-rendered HTML. Nothing here edits the document.

/** Top-level blocks of BlockNote markup under `root` (server full HTML or the editor's DOM). */
export function topLevelBlocks(root: ParentNode): Element[] {
  const group =
    (root as Element).classList?.contains('bn-block-group')
      ? (root as Element)
      : root.querySelector('.bn-block-group')
  if (group) return Array.from(group.children).filter((c) => c.classList.contains('bn-block-outer'))
  // not BlockNote markup: the root's element children
  return Array.from((root as Element).children ?? [])
}

/** The block's own content element (its first `.bn-block-content`, before any nested children). */
function contentOf(block: Element): Element {
  return block.querySelector('.bn-block-content') ?? block
}

/** 1–6 for a heading block, else null. */
export function headingLevel(block: Element): number | null {
  const c = contentOf(block)
  if (c.getAttribute('data-content-type') === 'heading') {
    const lvl = Number(c.getAttribute('data-level'))
    if (lvl >= 1 && lvl <= 6) return lvl
    const h = c.querySelector('h1, h2, h3, h4, h5, h6')
    return h ? Number(h.tagName.slice(1)) : 1
  }
  if (c === block && /^H[1-6]$/.test(block.tagName)) return Number(block.tagName.slice(1))
  return null
}

export function isDivider(block: Element): boolean {
  const c = contentOf(block)
  return c.getAttribute('data-content-type') === 'divider' || (c === block && block.tagName === 'HR')
}

/** A block with no text and nothing visual (empty paragraphs left between sections). */
export function isBlank(block: Element): boolean {
  if ((block.textContent ?? '').trim() !== '') return false
  return !block.querySelector('img, video, audio, iframe, svg, table, hr, input, .katex, [data-latex]')
}

/**
 * Slides: slide 0 is the opening slide (the page title plus the blocks before the first split,
 * possibly none); every heading of the highest level present starts a slide; a divider ends one
 * (and is not shown). Blank blocks at a slide's edges are dropped, and other empty slides skipped.
 */
export function splitSlides(blocks: Element[]): Element[][] {
  let top = 7
  for (const b of blocks) {
    const l = headingLevel(b)
    if (l !== null && l < top) top = l
  }
  // slides[0] is the opening slide (title + what comes before the first split), always present
  const slides: Element[][] = [[]]
  let opening = true
  for (const b of blocks) {
    if (isDivider(b)) {
      slides.push([])
      opening = false
      continue
    }
    if (headingLevel(b) === top && (opening || slides[slides.length - 1].some((x) => !isBlank(x)))) {
      slides.push([])
      opening = false
    }
    slides[slides.length - 1].push(b)
  }
  return slides.map(trimBlank).filter((s, i) => i === 0 || s.length > 0)
}

function trimBlank(slide: Element[]): Element[] {
  let a = 0
  let z = slide.length
  while (a < z && isBlank(slide[a])) a++
  while (z > a && isBlank(slide[z - 1])) z--
  return slide.slice(a, z)
}

/**
 * Read-only copies of live editor blocks: no ids (fold styles and comment lookups target the
 * originals by data-id), nothing editable or draggable.
 */
export function cloneForSlides(blocks: Element[]): Element[] {
  return blocks.map((b) => {
    const c = b.cloneNode(true) as Element
    for (const el of [c, ...Array.from(c.querySelectorAll('*'))]) {
      el.removeAttribute('data-id')
      el.removeAttribute('contenteditable')
      el.removeAttribute('draggable')
      el.removeAttribute('data-is-empty-and-focused')
      // copies carry no handlers: controls that look pressable are disabled (a button block's button,
      // the pickers of a database view block), and a button block's settings are left out
      if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') el.setAttribute('disabled', '')
    }
    for (const el of Array.from(c.querySelectorAll('[data-button-settings]'))) el.remove()
    return c
  })
}

/** Next slide index for a key, or null when the key does nothing here. */
export function slideKey(key: string, index: number, count: number): number | null {
  if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Enter') return Math.min(count - 1, index + 1)
  if (key === 'ArrowLeft' || key === 'PageUp' || key === 'Backspace') return Math.max(0, index - 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** A horizontal swipe: dx past 50 px and mostly sideways → +1 (next) / -1 (previous) / 0. */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return 0
  return dx < 0 ? 1 : -1
}
