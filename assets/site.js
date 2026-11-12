// Enhancements only. Every page shows all of its text without this file: nothing here is needed to read
// a page, and nothing is hidden in CSS waiting for a script to reveal it.
;(() => {
  const root = document.documentElement
  root.classList.remove('no-js')
  root.classList.add('js')

  const ko = root.lang === 'ko'
  const $ = (sel, el = document) => el.querySelector(sel)
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)]
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const canAnimate = () => !reduced() && typeof Element.prototype.animate === 'function'
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const el = (tag, attrs = {}, html = '') => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    if (html) node.innerHTML = html
    return node
  }
  /** One feature failing must not take the others (or the page) with it. */
  const feature = (name, fn) => {
    try {
      fn()
    } catch (err) {
      console.warn(`site: ${name} failed`, err)
    }
  }
  /** Calls fn at most once per frame. */
  const perFrame = (fn) => {
    let queued = false
    return () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        fn()
      })
    }
  }
  const layoutChanged = () => window.dispatchEvent(new Event('site:layout'))

  // -------------------------------------------------------------------------
  // Header: border once the page scrolls, and a reading progress line.
  // -------------------------------------------------------------------------
  feature('header', () => {
    const top = $('.top')
    if (!top) return
    const bar = el('span', { class: 'progress', 'aria-hidden': 'true' })
    top.appendChild(bar)
    const paint = perFrame(() => {
      const max = root.scrollHeight - window.innerHeight
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`
      top.classList.toggle('scrolled', window.scrollY > 8)
    })
    paint()
    window.addEventListener('scroll', paint, { passive: true })
    window.addEventListener('resize', paint)
    window.addEventListener('site:layout', paint)
  })

  // -------------------------------------------------------------------------
  // Copy buttons: terminal blocks on the landing pages, code blocks in the docs.
  // -------------------------------------------------------------------------
  feature('copy', () => {
    if (!navigator.clipboard) return
    const label = ko ? { copy: '복사', done: '복사됨' } : { copy: 'Copy', done: 'Copied' }
    const addButton = (box, pre, skipComments) => {
      const btn = el('button', { type: 'button', class: 'copy' })
      btn.textContent = label.copy
      btn.addEventListener('click', async () => {
        let text = pre.innerText
        if (skipComments)
          text = text
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n')
        try {
          await navigator.clipboard.writeText(text.trim())
          btn.textContent = label.done
          btn.classList.add('done')
          if (canAnimate()) btn.animate([{ transform: 'scale(0.92)' }, { transform: 'scale(1)' }], { duration: 220, easing: EASE })
          setTimeout(() => {
            btn.textContent = label.copy
            btn.classList.remove('done')
          }, 1400)
        } catch {
          /* clipboard blocked: the text stays selectable */
        }
      })
      box.appendChild(btn)
    }
    $$('.term[data-copy]').forEach((box) => {
      const pre = $('pre', box)
      if (!pre) return
      // Several lines: the button gets a row of its own instead of narrowing every line.
      if (pre.textContent.trim().split(/\n/).length > 2) box.classList.add('copy-top')
      addButton(box, pre, true)
    })
    $$('.prose pre').forEach((pre) => {
      const wrap = el('div', { class: 'pre-wrap' })
      pre.replaceWith(wrap)
      wrap.appendChild(pre)
      addButton(wrap, pre, false)
    })
  })

  // -------------------------------------------------------------------------
  // Tabs: without scripts every panel is shown in a column.
  // -------------------------------------------------------------------------
  feature('tabs', () => {
    $$('[data-tabs]').forEach((group) => {
      const tabs = $$('[role="tab"]', group)
      const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')))
      const select = (i, focus) => {
        tabs.forEach((t, j) => {
          const on = i === j
          t.setAttribute('aria-selected', String(on))
          t.tabIndex = on ? 0 : -1
          if (panels[j]) panels[j].hidden = !on
        })
        if (focus) tabs[i].focus()
      }
      tabs.forEach((t, i) => {
        t.addEventListener('click', () => select(i, false))
        t.addEventListener('keydown', (e) => {
          const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
          if (!step) return
          e.preventDefault()
          select((i + step + tabs.length) % tabs.length, true)
        })
      })
      select(0, false)
    })
  })

  // -------------------------------------------------------------------------
  // Scroll spy: marks the link of the section being read with aria-current="location".
  // Positions are read on every frame that scrolls (filters and <details> change heights).
  // A clicked link stays marked until the reader scrolls by hand, so the last short sections,
  // which cannot reach the top of the window, still light up when chosen.
  // -------------------------------------------------------------------------
  function spy(links, { scrollers = [], onChange } = {}) {
    const items = links
      .map((a) => ({ a, target: document.getElementById(decodeURIComponent(a.hash.slice(1))) }))
      .filter((it) => it.target)
    if (items.length < 2) return null
    let current = null
    let locked = null
    const follow = (a) => {
      for (const box of scrollers) {
        if (box.scrollHeight <= box.clientHeight + 1) continue
        const r = a.getBoundingClientRect()
        const b = box.getBoundingClientRect()
        if (r.top < b.top + 48 || r.bottom > b.bottom - 48) box.scrollTop += r.top - b.top - box.clientHeight / 2 + r.height / 2
      }
    }
    const set = (it) => {
      if (it === current) return
      if (current) current.a.removeAttribute('aria-current')
      current = it
      if (it) {
        it.a.setAttribute('aria-current', 'location')
        follow(it.a)
      }
      if (onChange) onChange(it)
    }
    const compute = () => {
      if (locked) return locked
      const shown = items.filter((it) => it.target.offsetParent !== null)
      if (!shown.length) return null
      // A heading counts once it is in the upper part of the window, a little below where a jump puts it.
      const line = (parseFloat(getComputedStyle(root).scrollPaddingTop) || 72) + Math.max(12, window.innerHeight * 0.18)
      let found = null
      for (const it of shown) {
        if (it.target.getBoundingClientRect().top <= line) found = it
        else break
      }
      // At the very end of the page the last section is the one on screen.
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2) found = shown[shown.length - 1]
      return found
    }
    const update = perFrame(() => set(compute()))
    const unlock = () => {
      if (!locked) return
      locked = null
      update()
    }
    items.forEach((it) =>
      it.a.addEventListener('click', () => {
        locked = it
        set(it)
      }),
    )
    window.addEventListener('wheel', unlock, { passive: true })
    window.addEventListener('touchmove', unlock, { passive: true })
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) unlock()
    })
    // Dragging the scrollbar: a press outside the links.
    window.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('a')) unlock()
    })
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    window.addEventListener('site:layout', update)
    const fromHash = () => {
      const hit = items.find((it) => it.a.hash === location.hash)
      if (hit) locked = hit
      set(compute())
    }
    window.addEventListener('hashchange', fromHash)
    fromHash()
    return { update }
  }

  // Docs: the table of contents (a column on wide windows, a bar under the header on narrow ones).
  feature('toc', () => {
    const nav = $('[data-toc]')
    if (!nav) return
    const list = $('ul', nav)
    const toggle = el(
      'button',
      { type: 'button', class: 'toc-toggle', 'aria-expanded': 'false' },
      `<span>${ko ? '목차' : 'On this page'}</span><span class="toc-now"></span><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`,
    )
    const now = $('.toc-now', toggle)
    nav.insertBefore(toggle, list)
    root.classList.add('toc-page')
    const open = (on) => {
      nav.classList.toggle('open', on)
      toggle.setAttribute('aria-expanded', String(on))
    }
    toggle.addEventListener('click', () => open(!nav.classList.contains('open')))
    list.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('a')) open(false)
    })
    document.addEventListener('click', (e) => {
      if (e.target instanceof Node && !nav.contains(e.target)) open(false)
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') open(false)
    })
    spy($$('a[href^="#"]', nav), {
      scrollers: [nav, list],
      onChange: (it) => {
        now.textContent = it ? it.a.textContent : ''
      },
    })
  })

  // Landing pages: the strip of section links under the header.
  feature('landing-spy', () => {
    const strip = $('[data-sections]')
    if (!strip) return
    const row = $('.wrap', strip) || strip
    spy($$('a[href^="#"]', strip), {
      onChange: (it) => {
        // On a narrow window the strip scrolls sideways: keep the marked link in view (the page is not moved).
        if (!it || row.scrollWidth <= row.clientWidth + 1) return
        const r = it.a.getBoundingClientRect()
        const b = row.getBoundingClientRect()
        if (r.left < b.left + 24 || r.right > b.right - 24) row.scrollLeft += r.left - b.left - row.clientWidth / 2 + r.width / 2
      },
    })
  })

  // -------------------------------------------------------------------------
  // Docs: filter the cards and rows of a long page, switch cards back to tables.
  // -------------------------------------------------------------------------
  feature('filter', () => {
    const main = $('main.prose')
    const head = main && $('.doc-head', main)
    if (!head) return
    const cardTables = $$('table.cards', main)
    const items = $$('table.cards tr.rec, li.issue', main).map((node) => ({ node, text: node.textContent.toLowerCase(), sev: node.dataset.sev || '' }))
    const folds = $$('td.c-method details', main)
    const searchable = items.length >= 12
    if (!searchable && !cardTables.length) return

    const t = ko
      ? { ph: '이 쪽에서 걸러 보기', all: '전체', count: (n, m) => (n === m ? `${m}개` : `${m}개 중 ${n}개`), none: '맞는 항목이 없습니다.', clear: '지우기', table: '표로 보기', open: '측정 방법 펼치기', label: '쪽 안 필터' }
      : { ph: 'Filter this page', all: 'All', count: (n, m) => (n === m ? `${m} items` : `${n} of ${m}`), none: 'Nothing matches.', clear: 'Clear', table: 'Show as tables', open: 'Open every method', label: 'Filter this page' }

    const bar = el('div', { class: 'filterbar', role: 'search', 'aria-label': t.label })
    const anchor = el('div', { class: 'filter-anchor', 'aria-hidden': 'true' })
    const empty = el('p', { class: 'filter-empty', hidden: '' }, `${t.none}<button type="button">${t.clear}</button>`)
    let input = null
    let count = null
    let sev = ''
    const chips = []

    if (searchable) {
      const box = el(
        'label',
        { class: 'filter-search' },
        `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
      )
      input = el('input', { type: 'search', placeholder: t.ph, 'aria-label': t.ph, autocomplete: 'off', spellcheck: 'false' })
      box.appendChild(input)
      bar.appendChild(box)
      const sevs = ['high', 'medium', 'low', 'info'].filter((s) => items.some((it) => it.sev === s))
      if (sevs.length) {
        const group = el('div', { class: 'chips', role: 'group' })
        for (const s of ['', ...sevs]) {
          const n = s ? items.filter((it) => it.sev === s).length : items.length
          const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(s === ''), 'data-sev': s }, `${s ? s[0].toUpperCase() + s.slice(1) : t.all}<small>${n}</small>`)
          chip.addEventListener('click', () => {
            sev = s
            chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)))
            apply(true)
          })
          chips.push(chip)
          group.appendChild(chip)
        }
        bar.appendChild(group)
      }
    }
    if (folds.length) {
      const btn = el('button', { type: 'button', class: 'filter-btn', 'aria-pressed': 'false' })
      btn.textContent = t.open
      btn.addEventListener('click', () => {
        const on = btn.getAttribute('aria-pressed') !== 'true'
        btn.setAttribute('aria-pressed', String(on))
        folds.forEach((d) => (d.open = on))
        layoutChanged()
      })
      bar.appendChild(btn)
    }
    if (cardTables.length) {
      const btn = el('button', { type: 'button', class: 'filter-btn', 'aria-pressed': 'false' })
      btn.textContent = t.table
      btn.addEventListener('click', () => {
        const asTable = btn.getAttribute('aria-pressed') !== 'true'
        btn.setAttribute('aria-pressed', String(asTable))
        for (const table of cardTables) {
          table.classList.toggle('cards', !asTable)
          table.parentElement.classList.toggle('has-cards', !asTable)
        }
        layoutChanged()
      })
      bar.appendChild(btn)
    }
    if (searchable) {
      count = el('span', { class: 'filter-count', 'aria-live': 'polite' })
      count.textContent = t.count(items.length, items.length)
      bar.appendChild(count)
    }
    head.after(anchor, bar, empty)
    // While the bar sticks under the header, anchor jumps must land below it.
    const stuck = () => root.style.setProperty('--stuck', getComputedStyle(bar).position === 'sticky' ? `${bar.offsetHeight + 4}px` : '')
    stuck()
    window.addEventListener('resize', stuck)

    // Sections: an h2 and everything up to the next one; inside it, an h3 and everything up to the next heading.
    const blocks = [...main.children].filter((n) => n !== head && n !== bar && n !== anchor && n !== empty && !n.classList.contains('docs-pick') && !n.classList.contains('doc-meta'))
    const tocLinks = new Map($$('[data-toc] a[href^="#"]').map((a) => [decodeURIComponent(a.hash.slice(1)), a]))
    const itemNodes = new Set(items.map((it) => it.node))
    const holders = blocks.map((n) => ({ n, own: $$('tr.rec, li.issue', n).filter((x) => itemNodes.has(x)) }))

    const apply = (jump) => {
      const words = input ? input.value.toLowerCase().split(/\s+/).filter(Boolean) : []
      const active = words.length > 0 || sev !== ''
      const shown = new Set()
      const fresh = []
      for (const it of items) {
        const ok = (!sev || it.sev === sev) && words.every((w) => it.text.includes(w))
        if (ok) shown.add(it.node)
        if (ok && it.node.classList.contains('is-out')) fresh.push(it.node)
        it.node.classList.toggle('is-out', !ok)
      }
      // Hide what holds no match: a table or list, an h3 part, a whole h2 section.
      let h2 = null
      let h3 = null
      const groups = []
      for (const h of holders) {
        const tag = h.n.tagName
        if (tag === 'H2') groups.push((h2 = { head: h, parts: [], lead: [] })), (h3 = null)
        else if (!h2) continue
        else if (tag === 'H3') h2.parts.push((h3 = { head: h, body: [] }))
        else (h3 ? h3.body : h2.lead).push(h)
      }
      const live = (h) => h.own.some((x) => shown.has(x))
      for (const g of groups) {
        const all = [g.head, ...g.lead, ...g.parts.flatMap((p) => [p.head, ...p.body])]
        const any = all.some(live)
        for (const h of all) h.n.classList.toggle('is-out', active && (!any || (h.own.length > 0 && !live(h))))
        if (active && any) for (const p of g.parts) if (![p.head, ...p.body].some(live)) for (const h of [p.head, ...p.body]) h.n.classList.add('is-out')
        const link = tocLinks.get(g.head.n.id)
        if (link) link.classList.toggle('is-dim', active && !any)
      }
      if (count) count.textContent = t.count(shown.size, items.length)
      empty.hidden = shown.size > 0
      if (canAnimate()) for (const node of fresh.slice(0, 24)) node.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE })
      if (jump) {
        const y = anchor.getBoundingClientRect().top + window.scrollY - 72
        if (window.scrollY > y) window.scrollTo({ top: y, behavior: 'instant' })
      }
      layoutChanged()
    }
    if (input) {
      input.addEventListener('input', () => apply(true))
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !input.value) return
        input.value = ''
        apply(true)
      })
    }
    $('button', empty).addEventListener('click', () => {
      if (input) input.value = ''
      sev = ''
      chips.forEach((c, i) => c.setAttribute('aria-pressed', String(i === 0)))
      apply(true)
      if (input) input.focus()
    })
  })

  // -------------------------------------------------------------------------
  // Motion. Elements are animated with the Web Animations API when they come into view; their resting
  // style is always the visible one, so a script error or reduced motion leaves plain, readable pages.
  // -------------------------------------------------------------------------
  const inView = (nodes, fn, options = { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }) => {
    if (!('IntersectionObserver' in window) || !nodes.length) return null
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        fn(e.target)
      }
    }, options)
    nodes.forEach((n) => io.observe(n))
    return io
  }

  // Blocks rise into place as they are scrolled to. Blocks already on screen at load stay as they are.
  feature('reveal', () => {
    if (!canAnimate()) return
    const picked = $$('[data-reveal], .section-head, .step, .grid > .card, .stat, .shot, .fig, .split > *, .points > li, .callout, .ill, .scene, .feature > *').filter(
      (n) => !n.closest('.hero') && n.getBoundingClientRect().top > window.innerHeight * 0.92,
    )
    // A block inside a block that already moves does not move a second time.
    const nodes = picked.filter((n) => !picked.some((m) => m !== n && m.contains(n)))
    inView(nodes, (n) => {
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => nodes.includes(c)) : [n]
      const delay = Math.min(sibs.indexOf(n), 5) * 55
      n.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay, easing: EASE, fill: 'backwards' })
    })
  })

  // Before/after bars (performance cards, landing metrics) grow from zero when first seen.
  feature('bars', () => {
    if (!canAnimate()) return
    const bars = $$('.bar').filter((b) => b.getBoundingClientRect().top > window.innerHeight)
    inView(bars, (b) => b.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 700, easing: EASE }), { threshold: 0.6 })
  })

  // Numbers count up to the value that is already in the HTML.
  feature('count', () => {
    if (!canAnimate()) return
    inView(
      $$('[data-count]'),
      (node) => {
        const final = node.textContent
        const m = final.match(/^(\D*)([\d,]+(?:\.\d+)?)(.*)$/s)
        if (!m) return
        const target = Number(m[2].replace(/,/g, ''))
        const decimals = (m[2].split('.')[1] || '').length
        const from = Number(node.dataset.count) || 0
        const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        // Hold the final width so the line does not shift while the digits change.
        node.style.display = 'inline-block'
        node.style.minWidth = `${node.getBoundingClientRect().width}px`
        const t0 = performance.now()
        const dur = 900
        const tick = (now) => {
          const p = Math.min(1, (now - t0) / dur)
          const eased = 1 - Math.pow(1 - p, 3)
          node.textContent = p < 1 ? `${m[1]}${fmt(from + (target - from) * eased)}${m[3]}` : final
          if (p < 1) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        // Whatever happens to the frames, the real text is back within a second and a half.
        setTimeout(() => (node.textContent = final), dur + 600)
      },
      { threshold: 0.6 },
    )
  })

  // Hero demo: tool calls appear line by line and the note beside them changes, on a loop.
  // Each element carries data-at="seconds"; the static HTML is the finished state.
  feature('demo', () => {
    const demo = $('[data-demo]')
    if (!demo || !canAnimate() || !('IntersectionObserver' in window)) return
    const total = Number(demo.dataset.demo) || 14
    const out = total - 0.6
    const anims = []
    for (const node of $$('[data-at]', demo)) {
      const at = Number(node.dataset.at)
      const kind = node.dataset.fx || 'line'
      const a = at / total
      const b = Math.min((at + 0.35) / total, 0.98)
      const o = out / total
      let frames
      if (kind === 'line') frames = [{ opacity: 0, offset: 0 }, { opacity: 0, offset: a }, { opacity: 1, offset: b }, { opacity: 1, offset: o }, { opacity: 0, offset: 1 }]
      else if (kind === 'grow')
        frames = [
          { opacity: 0, transform: 'translateY(6px)', offset: 0 },
          { opacity: 0, transform: 'translateY(6px)', offset: a },
          { opacity: 1, transform: 'none', offset: b },
          { opacity: 1, transform: 'none', offset: o },
          { opacity: 0, transform: 'none', offset: 1 },
        ]
      else if (kind === 'ring')
        // an outline that shows while the agent reads or writes that section
        frames = [{ opacity: 0, offset: 0 }, { opacity: 0, offset: a }, { opacity: 1, offset: b }, { opacity: 1, offset: Math.min((at + Number(node.dataset.hold || 3)) / total, o) }, { opacity: 0, offset: Math.min((at + Number(node.dataset.hold || 3) + 0.4) / total, 0.99) }, { opacity: 0, offset: 1 }]
      else continue
      anims.push(node.animate(frames, { duration: total * 1000, iterations: Infinity, easing: 'linear' }))
    }
    demo.classList.add('is-live')
    anims.forEach((a) => a.pause())
    new IntersectionObserver(
      (entries) => {
        const on = entries.some((e) => e.isIntersecting)
        anims.forEach((a) => (on ? a.play() : a.pause()))
      },
      { threshold: 0.25 },
    ).observe(demo)
  })

  // Promo video: plays (muted) while it is on screen and stops when it leaves. Not with reduced motion or
  // data saver, and not again once the viewer has paused it.
  feature('video', () => {
    const video = $('.promo-shot video')
    if (!video || reduced() || !('IntersectionObserver' in window)) return
    if (navigator.connection && navigator.connection.saveData) return
    let auto = false
    let stopped = false
    video.addEventListener('pause', () => {
      if (!auto) stopped = true
      auto = false
    })
    new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !stopped && video.paused) {
            video.muted = true
            const p = video.play()
            if (p && p.catch) p.catch(() => {})
          } else if (!e.isIntersecting && !video.paused) {
            auto = true
            video.pause()
          }
        }
      },
      { threshold: 0.6 },
    ).observe(video)
  })
})()
