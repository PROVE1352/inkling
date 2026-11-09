// Small enhancements only; every page works without this file.
;(() => {
  const root = document.documentElement
  root.classList.remove('no-js')
  root.classList.add('js')

  // Header border once the page scrolls.
  const top = document.querySelector('.top')
  if (top) {
    const onScroll = () => top.classList.toggle('scrolled', window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
  }

  // Copy buttons on terminal blocks.
  const label = root.lang === 'ko' ? { copy: '복사', done: '복사됨' } : { copy: 'Copy', done: 'Copied' }
  document.querySelectorAll('.term[data-copy]').forEach((box) => {
    const pre = box.querySelector('pre')
    if (!pre || !navigator.clipboard) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'copy'
    btn.textContent = label.copy
    btn.addEventListener('click', async () => {
      const text = pre.innerText
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n')
        .trim()
      try {
        await navigator.clipboard.writeText(text)
        btn.textContent = label.done
        setTimeout(() => (btn.textContent = label.copy), 1400)
      } catch {
        /* clipboard blocked: leave the text selectable */
      }
    })
    box.appendChild(btn)
  })

  // Agent tool tabs: without JS every panel is shown in a column.
  document.querySelectorAll('[data-tabs]').forEach((group) => {
    const tabs = [...group.querySelectorAll('[role="tab"]')]
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
})()
