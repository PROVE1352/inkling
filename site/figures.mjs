// Small drawings for the landing pages, written as HTML and CSS so they follow the light and dark themes.
// build.mjs puts them where index.html says {{FIG:name}} or {{ICON:name}}. The words come from the page
// they sit on: the demo lines are a short form of the transcripts printed in the "find" and "edit" sections.
// Text inside a drawing is in <div>/<span>, never <p> or <li>, and each drawing has one text alternative.

const T = {
  ko: {
    heroAlt:
      '움직이는 예시. 에이전트가 find_context로 "4분기 출시 계획" 페이지의 체크리스트 섹션을 찾고, patch_section으로 그 섹션에 "변경 사항 공지" 한 줄을 덧붙입니다. 노트에는 그 줄이 박서준 (Claude Code 경유)로 표시됩니다.',
    heroCaption: '아래 찾기와 고치기 절에 실린 실제 출력을 줄여서 보여 줍니다.',
    page: '4분기 출시 계획',
    sec1: '일정',
    sec2: '체크리스트',
    sec3: '담당',
    item1: '요금 페이지 문구',
    item2: '상태 페이지, 담당 이지원',
    item3: '새 요금제용 고객지원 답변 템플릿',
    itemNew: '변경 사항 공지',
    by: '박서준 (Claude Code 경유)',
    reading: '에이전트가 이 섹션만 읽고 고칩니다',
    q: '출시 체크리스트 상태 페이지',
    hit: '[1] 4분기 출시 계획 › 체크리스트',
    tokens: '~87/3500 tokens',
    anchor: '체크리스트',
    v1: '54b8bd8b3ec8',
    v2: 'ef9b6c9a294f',
    stats: [
      ['48', '', 'MCP 도구', 'core 프로필로는 32개', '#connect'],
      ['72', '%', '적은 토큰', '질문당 평균 2,254 → 624', '#find'],
      ['1.00', '번', '도구 호출', '예전에는 질문당 3.68번', '#find', '3.68'],
      ['6', ' / 6', '사람 글 보존', '에이전트가 고치는 섹션에서', '#edit'],
    ],
    connectAlt: '사람마다 자기 에이전트를 같은 주소 /mcp에 OAuth로 연결하고, 에이전트는 그 사람이 웹에서 볼 수 있는 것만 봅니다.',
    people: [
      ['이', '이지원', 'Claude Code'],
      ['박', '박서준', 'Cursor'],
      ['팀', '팀원', 'claude.ai'],
    ],
    oneAddress: '주소 하나',
    eachSees: '각자 웹에서 볼 수 있는 것만',
    budgetAlt: '순위대로 고른 섹션 세 개가 토큰 예산 안에 담기고, 네 번째 섹션은 예산 밖에 남습니다.',
    question: '질문',
    rank: '순위',
    budget: '토큰 예산 (기본 3,500)',
    outside: '예산 밖',
    before: '전',
    after: '후',
    patchAlt: '페이지의 네 섹션 가운데 체크리스트 섹션 하나만 고쳐지고 버전이 바뀝니다. 나머지 섹션은 그대로입니다.',
    untouched: '그대로',
    onlyThis: '이 섹션만',
    secs: ['목표', '일정', '체크리스트', '담당'],
    flowAlt: '에이전트가 제안하면 사람이 바뀐 줄을 보고 수락하거나 거절하고, 수락한 편집은 버전으로 남아 되돌릴 수 있습니다.',
    flow: [
      ['에이전트', '수정을 제안으로 남김'],
      ['사람', '바뀐 줄을 검토'],
      ['사람', '수락, 거절, 일부만'],
      ['기록', "'AI 편집' 버전, 되돌리기"],
    ],
    scopeAlt: '연결이 볼 범위는 세 가지입니다: 연결한 사람이 볼 수 있는 전부, 일부 워크스페이스, 페이지 하나와 그 아래 페이지들. 연결마다 읽기 전용이나 읽기와 쓰기를 고릅니다.',
    scope: ['연결한 사람이 볼 수 있는 전부', '일부 워크스페이스', '페이지 하나와 그 아래 페이지들'],
    modes: ['읽기 전용', '읽기와 쓰기'],
    stackAlt: '인터넷에서는 Caddy의 80, 443 포트만 보이고, 그 뒤에 Inkling 앱, PostgreSQL, 백업 사이드카가 있습니다.',
    stack: [
      ['인터넷', ':80 · :443'],
      ['Caddy', 'HTTPS 인증서 발급과 갱신'],
      ['Inkling 앱', 'ghcr.io/prove1352/inkling'],
    ],
    stackPair: [
      ['PostgreSQL', '밖에서 보이지 않음'],
      ['백업 사이드카', '예약 실행, 매번 검증'],
    ],
  },
  en: {
    heroAlt:
      'Animated example. An agent finds the Checklist section of the "Q4 launch plan" page with find_context, then appends one line, "Changelog post", to that section with patch_section. In the note the line is marked Priya Nair (via Claude Code).',
    heroCaption: 'A short form of the real output printed in the find and edit sections below.',
    page: 'Q4 launch plan',
    sec1: 'Schedule',
    sec2: 'Checklist',
    sec3: 'Owners',
    item1: 'Pricing page copy',
    item2: 'Status page, owner Sam Ortiz',
    item3: 'Support macros for the new plans',
    itemNew: 'Changelog post',
    by: 'Priya Nair (via Claude Code)',
    reading: 'The agent reads and edits this section only',
    q: 'launch checklist status page',
    hit: '[1] Q4 launch plan › Checklist',
    tokens: '~63/3500 tokens',
    anchor: 'checklist',
    v1: '96198f73e6eb',
    v2: '1ae7c04d3487',
    stats: [
      ['48', '', 'MCP tools', '32 with the core profile', '#connect'],
      ['72', '%', 'fewer tokens', '2,254 → 624 per question', '#find'],
      ['1.00', '', 'tool call', 'was 3.68 per question', '#find', '3.68'],
      ['6', ' of 6', 'typists keep their text', 'in the section an agent patches', '#edit'],
    ],
    connectAlt: 'Each person connects their own agent to the same /mcp address with OAuth, and the agent sees only what that person can see on the web.',
    people: [
      ['P', 'Priya', 'Claude Code'],
      ['S', 'Sam', 'Cursor'],
      ['T', 'Teammate', 'claude.ai'],
    ],
    oneAddress: 'one address',
    eachSees: 'only what each person can see on the web',
    budgetAlt: 'Three ranked sections fit in the token budget; the fourth is left outside it.',
    question: 'question',
    rank: 'rank',
    budget: 'token budget (3,500 by default)',
    outside: 'over budget',
    before: 'before',
    after: 'after',
    patchAlt: 'Of four sections on a page only the Checklist section is edited and gets a new version. The others stay as they are.',
    untouched: 'untouched',
    onlyThis: 'this section only',
    secs: ['Goals', 'Schedule', 'Checklist', 'Owners'],
    flowAlt: 'An agent suggests an edit, a person looks at the changed lines and accepts or rejects it, and an accepted edit becomes a version that can be undone.',
    flow: [
      ['Agent', 'leaves the edit as a suggestion'],
      ['Person', 'reviews the changed lines'],
      ['Person', 'accepts, rejects, or picks parts'],
      ['History', 'an "AI edit" version, undoable'],
    ],
    scopeAlt: 'A connection can reach one of three ranges: everything the person can see, some workspaces, or one page and the pages under it. Each connection is read-only or read and write.',
    scope: ['Everything the person can see', 'Some workspaces', 'One page and the pages under it'],
    modes: ['Read-only', 'Read and write'],
    stackAlt: 'Only ports 80 and 443 of Caddy face the internet; behind it are the Inkling app, PostgreSQL and the backup sidecar.',
    stack: [
      ['Internet', ':80 · :443'],
      ['Caddy', 'gets and renews the HTTPS certificate'],
      ['Inkling app', 'ghcr.io/prove1352/inkling'],
    ],
    stackPair: [
      ['PostgreSQL', 'not reachable from outside'],
      ['Backup sidecar', 'scheduled, verified every run'],
    ],
  },
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const winBar = (title) => `<div class="win-bar" aria-hidden="true"><i></i><i></i><i></i><span>${esc(title)}</span></div>`
const ARROW = '<svg class="ill-arrow" viewBox="0 0 24 12" aria-hidden="true"><path d="M1 6h20M17 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const FIGS = {
  // Hero: a note and the agent's tool calls. data-at is the second at which a piece appears in the loop;
  // the HTML as written is the finished state, which is what shows without scripts or with reduced motion.
  hero(t) {
    const line = (at, html, cls = '') => `<span class="dl${cls ? ' ' + cls : ''}" data-at="${at}">${html}</span>`
    return `<figure class="demo" data-demo="15">
  <div class="demo-stage" role="img" aria-label="${esc(t.heroAlt)}">
    <div class="win demo-note">
      ${winBar(t.page)}
      <div class="note">
        <div class="note-h1">${esc(t.page)}</div>
        <div class="note-sec"><div class="note-h2">${esc(t.sec1)}</div><div class="note-line" style="width:82%"></div><div class="note-line" style="width:58%"></div></div>
        <div class="note-sec is-target">
          <span class="note-ring" data-at="2.4" data-fx="ring" data-hold="9.6"></span>
          <div class="note-h2">${esc(t.sec2)}<span class="note-ver" data-at="9" data-fx="line">v=${t.v2.slice(0, 6)}</span></div>
          <div class="note-item is-done">${esc(t.item1)}</div>
          <div class="note-item is-done">${esc(t.item2)}</div>
          <div class="note-item">${esc(t.item3)}</div>
          <div class="note-item is-new" data-at="9" data-fx="grow">${esc(t.itemNew)}<span class="note-by">${esc(t.by)}</span></div>
        </div>
        <div class="note-sec"><div class="note-h2">${esc(t.sec3)}</div><div class="note-line" style="width:66%"></div></div>
      </div>
    </div>
    <div class="win term demo-term">
      ${winBar('Claude Code · inkling')}
      <pre><code>${[
        line(0.2, `<span class="k">› find_context</span>(query: "${esc(t.q)}")`),
        line(1.5, `1 result(s), ${esc(t.tokens)}`, 'c'),
        line(2.4, esc(t.hit)),
        line(5.2, `<span class="k">› patch_section</span>(section: "${esc(t.anchor)}", mode: "append",`),
        line(5.9, `    markdown: "- [ ] ${esc(t.itemNew)}", baseVersion: "${t.v1}")`),
        line(9, `Done (append): §${esc(t.anchor)} is now v=${t.v2}.<span class="caret" aria-hidden="true"></span>`, 'o'),
      ].join('\n')}</code></pre>
    </div>
  </div>
  <figcaption>${esc(t.heroCaption)}</figcaption>
</figure>`
  },

  stats(t) {
    return `<div class="stats">${t.stats
      .map(([num, unit, label, note, href, from = '']) => `<a class="stat" href="${href}"><span class="stat-num"><span data-count="${from}">${num}</span>${unit ? `<small>${esc(unit)}</small>` : ''}</span><span class="stat-label">${esc(label)}</span><span class="stat-note">${esc(note)}</span></a>`)
      .join('')}</div>`
  },

  connect(t) {
    return `<div class="ill ill-connect" role="img" aria-label="${esc(t.connectAlt)}">
  <div class="ill-people">${t.people.map(([ini, name, client]) => `<div class="ill-person"><span class="ill-avatar">${esc(ini)}</span><span class="ill-name">${esc(name)}<small>${esc(client)}</small></span></div>`).join('')}</div>
  <div class="ill-wires" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="ill-hub"><small>${esc(t.oneAddress)}</small><code>/mcp</code><small>OAuth 2.1</small></div>
  ${ARROW}
  <div class="ill-app"><b>Inkling</b><small>${esc(t.eachSees)}</small></div>
</div>`
  },

  budget(t) {
    const seg = (n, w, out = false) => `<span class="ill-seg${out ? ' is-over' : ''}" style="flex:${w}"><b>${esc(t.rank)} ${n}</b></span>`
    return `<div class="ill ill-budget" role="img" aria-label="${esc(t.budgetAlt)}">
  <div class="ill-row"><span class="ill-chip">${esc(t.question)}</span>${ARROW}<span class="ill-chip is-code">find_context</span></div>
  <div class="ill-pack"><div class="ill-fit">${seg(1, 5)}${seg(2, 3)}${seg(3, 2)}<span class="ill-free" style="flex:1"></span></div>${seg(4, 3, true)}</div>
  <div class="ill-legend"><span>${esc(t.budget)}</span><span>${esc(t.outside)}</span></div>
</div>`
  },

  patch(t) {
    return `<div class="ill ill-patch" role="img" aria-label="${esc(t.patchAlt)}">
  ${t.secs
    .map((name, i) =>
      i === 2
        ? `<div class="ill-sec is-hit"><span class="ill-sec-name">§ ${esc(name)}</span><span class="ill-lines"><i style="width:74%"></i><i style="width:52%"></i><i class="is-new" style="width:40%"></i></span><span class="ill-tag is-accent">${esc(t.onlyThis)}</span><span class="ill-vers"><code>v=${t.v1.slice(0, 6)}</code>${ARROW}<code>v=${t.v2.slice(0, 6)}</code></span></div>`
        : `<div class="ill-sec"><span class="ill-sec-name">§ ${esc(name)}</span><span class="ill-lines"><i style="width:${[64, 80, 0, 58][i]}%"></i><i style="width:${[42, 55, 0, 36][i]}%"></i></span><span class="ill-tag">${esc(t.untouched)}</span></div>`,
    )
    .join('\n  ')}
</div>`
  },

  flow(t) {
    return `<div class="ill ill-flow" role="img" aria-label="${esc(t.flowAlt)}">${t.flow
      .map(([who, what], i) => `${i ? ARROW : ''}<div class="ill-step${i === 2 ? ' is-accent' : ''}"><small>${esc(who)}</small><b>${esc(what)}</b></div>`)
      .join('')}</div>`
  },

  scope(t) {
    return `<div class="ill ill-scope" role="img" aria-label="${esc(t.scopeAlt)}">
  <div class="ill-ring"><span>${esc(t.scope[0])}</span>
    <div class="ill-ring"><span>${esc(t.scope[1])}</span>
      <div class="ill-ring is-accent"><span>${esc(t.scope[2])}</span></div>
    </div>
  </div>
  <div class="ill-modes"><span class="ill-chip">${esc(t.modes[0])}</span><span class="ill-chip is-on">${esc(t.modes[1])}</span></div>
</div>`
  },

  stack(t) {
    const box = ([name, note], cls = '') => `<div class="ill-box${cls}"><b>${esc(name)}</b><small>${esc(note)}</small></div>`
    return `<div class="ill ill-stack" role="img" aria-label="${esc(t.stackAlt)}">
  ${box(t.stack[0], ' is-plain')}<span class="ill-down" aria-hidden="true"></span>${box(t.stack[1])}<span class="ill-down" aria-hidden="true"></span>${box(t.stack[2], ' is-accent')}<span class="ill-down" aria-hidden="true"></span>
  <div class="ill-pair">${box(t.stackPair[0])}${box(t.stackPair[1])}</div>
</div>`
  },
}

const icon = (d) => `<svg class="card-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const ICONS = {
  table: icon('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M9.5 9.5v10M15 9.5v10"/>'),
  link: icon('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  check: icon('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>'),
  people: icon('<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.7-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><path d="M15.5 6.300a3 3 0 0 1 0 5.400M17.5 14.800c1.6.600 2.6 2 3 4.2"/>'),
  share: icon('<circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="6" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="M8.7 10.800l6.6-3.600M8.7 13.200l6.6 3.6"/>'),
  globe: icon('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.500c2.5 2.3 3.8 5.1 3.8 8.500s-1.3 6.2-3.8 8.500c-2.5-2.3-3.8-5.1-3.8-8.500s1.3-6.2 3.8-8.500z"/>'),
}

export function figure(name, lang) {
  const make = FIGS[name]
  return make ? make(T[lang] ?? T.en) : null
}
export function iconSvg(name) {
  return ICONS[name] ?? null
}
