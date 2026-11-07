// Progress Blocks — example Inkling plugin (custom blocks, no dependencies).
// Block data lives in the document as JSON (props.data) and is shared with collaborators;
// the plugin only renders it and asks the app to save changes via setData().
/* global inkling */

const style = document.createElement('style')
style.textContent = `
  :root { --fg:#1f2328; --sub:#6b7280; --track:#e5e7eb; --bar:#3b82f6; --btn:#f3f4f6; --line:#d1d5db; }
  :root[data-theme="dark"] { --fg:#e6e6e6; --sub:#9ca3af; --track:#374151; --bar:#60a5fa; --btn:#1f2937; --line:#4b5563; }
  * { box-sizing: border-box; }
  body { padding: 6px 2px; color: var(--fg); }
  .row { display:flex; align-items:center; gap:8px; }
  .label { flex:1; min-width:0; font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .num { font-variant-numeric: tabular-nums; color: var(--sub); font-size:12px; }
  .track { height:10px; border-radius:999px; background:var(--track); overflow:hidden; margin-top:8px; }
  .bar { height:100%; background:var(--bar); border-radius:999px; transition:width .2s ease; }
  button { font:inherit; font-size:12px; min-width:26px; padding:2px 8px; border-radius:6px;
           border:1px solid var(--line); background:var(--btn); color:var(--fg); cursor:pointer; }
  button:disabled { opacity:.4; cursor:default; }
  .count { font-size:20px; font-weight:700; font-variant-numeric: tabular-nums; min-width:3ch; text-align:center; }
`
document.head.appendChild(style)

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const text = (v, d) => (typeof v === 'string' && v.trim() ? v.slice(0, 80) : d)

function el(tag, cls, content) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (content !== undefined) e.textContent = content
  return e
}

// ---------------------------------------------------------------- progress bar
function renderProgress(root, { data, editable, setData }) {
  const max = Math.max(1, num(data.max, 100))
  const value = Math.min(max, Math.max(0, num(data.value, 0)))
  const step = Math.max(1, Math.round(max / 10))
  const pct = Math.round((value / max) * 100)

  const head = el('div', 'row')
  head.append(el('span', 'label', text(data.label, 'Progress')), el('span', 'num', `${value} / ${max} · ${pct}%`))
  const minus = el('button', '', '−')
  const plus = el('button', '', '+')
  minus.disabled = !editable || value <= 0
  plus.disabled = !editable || value >= max
  minus.onclick = () => setData({ ...data, value: Math.max(0, value - step) })
  plus.onclick = () => setData({ ...data, value: Math.min(max, value + step) })
  head.append(minus, plus)

  const track = el('div', 'track')
  const bar = el('div', 'bar')
  bar.style.width = `${pct}%`
  track.append(bar)
  root.replaceChildren(head, track)
}

// ---------------------------------------------------------------- counter
function renderCounter(root, { data, editable, setData }) {
  const count = Math.trunc(num(data.count, 0))
  const row = el('div', 'row')
  const minus = el('button', '', '−')
  const plus = el('button', '', '+')
  const reset = el('button', '', 'Reset')
  minus.disabled = plus.disabled = reset.disabled = !editable
  minus.onclick = () => setData({ ...data, count: count - 1 })
  plus.onclick = () => setData({ ...data, count: count + 1 })
  reset.onclick = () => setData({ ...data, count: 0 })
  row.append(el('span', 'label', text(data.label, 'Count')), minus, el('span', 'count', String(count)), plus, reset)
  root.replaceChildren(row)
}

// `update` is optional; without it the SDK calls render again on every data change.
inkling.blocks.register('progress', { render: renderProgress })
inkling.blocks.register('counter', { render: renderCounter })
