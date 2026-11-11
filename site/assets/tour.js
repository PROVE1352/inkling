// The tour: a walk-through that runs in the page. Nothing here talks to a server or to a model.
//
// One file, two users:
//   - build.mjs loads it (no document there) and calls InklingTour.transcript() to print every scenario as
//     static text, so the pages read the same without scripts;
//   - in the browser it mounts the stage on top of that static text.
// The tool names, arguments and the shape of each answer follow docs/MCP.md and the server's own messages.
// The note, its version values (a hash of the section text) and the token counts (bytes / 4) are made up
// for the tour, and the pages say so.
;(function (G) {
  'use strict'

  const T = {
    ko: {
      title: '둘러보기',
      h1: '에이전트가 노트를 고치는 과정을 직접 눌러 보기',
      lede: 'Inkling에서 AI 에이전트는 필요한 섹션만 찾아 읽고, 읽은 버전을 확인한 뒤 섹션 하나만 고칩니다. 아래 다섯 장면을 차례로 실행해 보세요. 계정도 서버도 필요 없습니다.',
      notice: '브라우저 안에서만 도는 시연입니다. 실제 서버나 AI에 연결되지 않고, 입력한 내용은 저장되지 않습니다.',
      made: '도구 이름, 인자, 응답의 모양은 실제 Inkling MCP 서버와 같습니다. 노트 내용, 버전 값(v=…), 토큰 수는 이 시연이 만든 예시 값이고, 페이지와 제안의 id는 짧게 줄였습니다.',
      startTitle: '시연에 쓰는 노트',
      startText: '가짜 워크스페이스의 페이지 하나입니다. 섹션이 넷이고, 장면마다 에이전트는 체크리스트 섹션을 다룹니다.',
      scriptLabel: '이 장면에서 오가는 도구 호출과 응답',
      ws: 'Acme 제품팀',
      tree: ['4분기 출시 계획', '주간 회의', '요금 페이지 문구', '상태 페이지'],
      pageTitle: '4분기 출시 계획',
      who: '박서준',
      via: '박서준 (Claude Code 경유)',
      you: '나',
      target: '체크리스트',
      sections: [
        ['목표', '목표', '- 11월 20일에 새 요금제를 출시합니다\n- 출시 메일은 전날 보냅니다'],
        ['일정', '일정', '- 11월 13일: 요금 페이지 문구 확정\n- 11월 18일: 상태 페이지 점검\n- 11월 19일: 출시 메일 발송'],
        ['체크리스트', '체크리스트', '- [x] 요금 페이지 문구\n- [ ] 상태 페이지, 담당 이지원, 마감 2026-11-20\n- [ ] 새 요금제용 고객지원 답변 템플릿'],
        ['담당', '담당', '- 출시 총괄: 박서준\n- 상태 페이지: 이지원'],
      ],
      query: '출시 체크리스트 상태 페이지',
      newLine: { patch: '- [ ] 변경 사항 공지', conflict: '- [ ] 고객 안내 메일 초안', suggest: '- [ ] 출시 후 회고 일정 잡기', lock: '- [ ] 요금제 비교표 갱신' },
      editFrom: '- [ ] 상태 페이지',
      editTo: '- [x] 상태 페이지',
      sc: {
        find: ['찾기', '에이전트가 `find_context`를 한 번 부르면, 서버가 질문에 맞는 섹션만 순위대로 골라 토큰 예산(기본 3,500) 안에 담아 줍니다. 결과에는 페이지 id, §앵커, 버전(v=…)이 붙고, 고치는 도구가 이 값을 그대로 받습니다.', '실제 제품에서는 내 워크스페이스 전체에서 찾습니다. 성능 기록의 측정에서는 질문당 평균 토큰이 2,254에서 624로 줄었습니다. 이 장면의 비교 숫자는 시연 노트로 어림한 값입니다.'],
        patch: ['섹션 하나만 고치기', '`patch_section`은 섹션 하나만 고칩니다. 에이전트는 읽을 때 받은 버전을 `baseVersion`으로 보내고, 서버는 그 섹션이 그대로일 때만 씁니다. 다른 섹션은 건드리지 않고, 고친 섹션의 버전만 바뀝니다.', "실제 제품에서는 에이전트가 한 번 쓸 때마다 페이지 기록에 'AI 편집' 버전이 하나 남고, 사람이 그 단계만 되돌릴 수 있습니다."],
        conflict: ['충돌', '에이전트가 섹션을 읽은 뒤에 사람이 그 섹션을 고치면, 옛 버전으로 보낸 수정은 거절되고 아무것도 쓰이지 않습니다. 응답에 지금 내용과 새 버전이 들어 있어서, 에이전트는 자기 수정을 합쳐 다시 보냅니다. 실행을 누른 다음 체크리스트 섹션을 직접 고쳐 보세요.', '그래서 사람이 치던 글이 에이전트의 수정에 덮이지 않습니다.'],
        suggest: ['제안으로 남기기', '페이지를 "에이전트: 제안만"으로 잠그면 에이전트의 수정은 바로 쓰이지 않고 제안으로 남습니다. 사람이 바뀐 줄을 보고 수락하거나 거절합니다. 에이전트가 제안을 수락하는 도구는 없습니다.', '실제 제품에서는 워크스페이스를 "전부 검토"로 두거나 에이전트가 `suggest=true`를 줘도 같은 흐름이 되고, 결과는 에이전트의 받은 함에 approval_result로 갑니다.'],
        lock: ['편집 잠금', '페이지를 잠그고 에이전트를 "코멘트만"으로 두면 에이전트의 쓰기는 PAGE_LOCKED로 거절됩니다. 노트 위의 잠금 단추를 누른 다음 실행해 보세요.', '잠금은 사람만 바꿀 수 있습니다. 에이전트에게는 잠금을 바꾸는 도구가 없고, 거절 응답은 우회하지 말고 사람에게 알리라고 말해 줍니다.'],
      },
      links: {
        find: [['MCP 안내: 에이전트를 위한 안내', 'MCP', 'guide-for-agents', 'guide-for-agents'], ['성능 기록: 검색과 MCP', 'PERFORMANCE', 'retrieval--mcp', 'retrieval--mcp']],
        patch: [['MCP 안내: 에이전트가 쓸 때마다 버전 하나', 'MCP', 'versions-one-per-agent-write', 'versions-one-per-agent-write'], ['사용 설명서: 에이전트 편집 되돌리기', 'GUIDE', 'reverting-agent-edits', '에이전트-편집-되돌리기']],
        conflict: [['MCP 안내: 에이전트를 위한 안내', 'MCP', 'guide-for-agents', 'guide-for-agents']],
        suggest: [['MCP 안내: 제안, 편집 방식, 섹션 잡아 두기', 'MCP', 'suggestions-edit-policy-and-claims', 'suggestions-edit-policy-and-claims'], ['사용 설명서: 에이전트 제안 검토하기', 'GUIDE', 'reviewing-what-agents-suggest', '에이전트-제안-검토하기']],
        lock: [['MCP 안내: 지침, 잠금, 신뢰할 수 없는 내용', 'MCP', 'workspace-instructions-locks-and-untrusted-content', 'workspace-instructions-locks-and-untrusted-content'], ['사용 설명서: 편집 잠금', 'GUIDE', 'edit-lock', '편집-잠금']],
      },
      nEdit: '(사람) 에이전트가 읽은 뒤에 체크리스트 섹션을 직접 고침: 상태 페이지 항목을 완료로 표시',
      nMerge: '(에이전트) 응답에 들어 있는 지금 내용에 자기 줄을 합쳐, 새 버전으로 다시 보냄',
      nSuggestLock: '(사람) 이 페이지를 "에이전트: 제안만"으로 잠금',
      nLock: '(사람) 이 페이지를 잠그고 에이전트를 "코멘트만"으로 둠',
      nAccept: '(사람) 제안을 수락함. 섹션에 반영되고 버전 기록에 AI 편집이 생김. 결과는 에이전트의 inbox에 approval_result로 감',
      nReject: '(사람) 제안을 거절함. 노트는 바뀌지 않음. 결과는 에이전트의 inbox에 approval_result로 감',
      nDecide: '(사람) 웹 앱에서 바뀐 줄을 보고 수락하거나 거절함. 수락하면 섹션에 반영되고 버전 기록에 AI 편집이 생기며, 거절하면 노트는 그대로임',
      cmp: (all, got) => `페이지 전체를 읽었다면 약 ${all} 토큰, 이번에 받은 것은 약 ${got} 토큰 (시연용 어림값)`,
      run: '에이전트에게 시키기',
      cont: '이어서 실행',
      reset: '처음으로',
      example: '예시로 한 줄 고치기',
      lockOn: '페이지 잠그기 (에이전트: 코멘트만)',
      lockOff: '잠금 풀기',
      lockChip: { none: '잠금 없음', suggest: '잠금 · 에이전트: 제안만', comment: '잠금 · 에이전트: 코멘트만' },
      accept: '수락',
      reject: '거절',
      sugHead: '제안',
      hist: '버전 기록',
      histEmpty: '아직 편집이 없습니다.',
      histAi: (n, a, v) => `AI 편집 · ${n}단계 · ${v} · patch_section append §${a} +1줄`,
      histYou: (a) => `사람 편집 · 나 · §${a}`,
      editLabel: '체크리스트 섹션 본문 (직접 고칠 수 있습니다)',
      editHint: '이 섹션은 직접 고칠 수 있습니다.',
      waitEdit: '에이전트가 섹션을 읽었습니다. 이제 체크리스트 섹션을 직접 고친 다음 이어서 실행하세요.',
      waitLock: '먼저 노트 위의 "페이지 잠그기"를 누르세요.',
      waitDecide: '노트에 뜬 제안을 수락하거나 거절하세요.',
      doneFind: '체크리스트 섹션 하나만 돌려받았습니다.',
      donePatch: (a, o, n) => `§${a}의 버전이 v=${o}에서 v=${n}으로 바뀌었습니다. 다른 섹션 셋은 그대로입니다.`,
      doneConflict: '첫 시도는 거절됐고, 합쳐서 다시 보낸 수정이 들어갔습니다. 직접 고친 줄도 남아 있습니다.',
      doneAccept: '제안을 수락했습니다. 섹션에 반영됐고 버전 기록에 AI 편집이 생겼습니다.',
      doneReject: '제안을 거절했습니다. 노트는 바뀌지 않았습니다.',
      doneLock: '쓰기가 PAGE_LOCKED로 거절됐습니다. 노트는 바뀌지 않았습니다.',
      resetDone: '처음 상태로 되돌렸습니다.',
      aTabs: '장면 고르기',
      aTree: '페이지 목록 (시연용)',
      aNote: '노트',
      aAgent: '에이전트의 도구 호출 기록',
      editedBy: '마지막 편집',
      nextTitle: '다음 단계',
      next: [['직접 설치하기', '내 서버에 Inkling을 올리는 순서입니다. 내 컴퓨터에서 써 보는 방법도 있습니다.', 'DEPLOY'], ['내 Claude에 연결하기', 'Claude Code, claude.ai와 다른 MCP 클라이언트를 Inkling에 연결하는 방법입니다.', 'MCP']],
      mdNote: 'Markdown 원문',
    },
    en: {
      title: 'Tour',
      h1: 'Press the buttons and watch an agent edit a note',
      lede: 'In Inkling an AI agent finds only the sections it needs, checks the version it read, and changes one section. Run the five scenes below in order. No account and no server needed.',
      notice: 'This is a demonstration that runs in your browser only. It is not connected to a real server or an AI, and nothing you type is saved.',
      made: 'Tool names, arguments and the shape of each answer are those of the real Inkling MCP server. The note, the version values (v=…) and the token counts are examples made up by this tour, and page and suggestion ids are shortened.',
      startTitle: 'The note used in the tour',
      startText: 'One page of a made-up workspace. It has four sections, and in every scene the agent works on the Checklist section.',
      scriptLabel: 'Tool calls and answers in this scene',
      ws: 'Acme product',
      tree: ['Q4 launch plan', 'Weekly sync', 'Pricing page copy', 'Status page'],
      pageTitle: 'Q4 launch plan',
      who: 'Priya Nair',
      via: 'Priya Nair (via Claude Code)',
      you: 'You',
      target: 'checklist',
      sections: [
        ['goals', 'Goals', '- Launch the new plans on November 20\n- Send the launch email the day before'],
        ['schedule', 'Schedule', '- Nov 13: pricing page copy final\n- Nov 18: status page check\n- Nov 19: launch email goes out'],
        ['checklist', 'Checklist', '- [x] Pricing page copy\n- [ ] Status page, owner Sam Ortiz, due 2026-11-20\n- [ ] Support macros for the new plans'],
        ['owners', 'Owners', '- Launch lead: Priya Nair\n- Status page: Sam Ortiz'],
      ],
      query: 'launch checklist status page',
      newLine: { patch: '- [ ] Changelog post', conflict: '- [ ] Draft the customer email', suggest: '- [ ] Schedule the launch retro', lock: '- [ ] Update the plan comparison table' },
      editFrom: '- [ ] Status page',
      editTo: '- [x] Status page',
      sc: {
        find: ['Find', 'The agent calls `find_context` once and the server answers with the sections that match the question, ranked and packed into a token budget (3,500 by default). Each result carries the page id, a §anchor and a version (v=…), which the editing tools take as they are.', 'In the product the search covers all your workspaces. In the measurement in the performance log the average per question went from 2,254 to 624 tokens. The comparison in this scene is an estimate for the tour note.'],
        patch: ['Change one section', '`patch_section` changes one section. The agent sends the version it read as `baseVersion`, and the server writes only if the section is still at that version. The other sections are not touched; only the edited section gets a new version.', 'In the product every write of an agent is one "AI edit" version in the page history, and a person can undo that step alone.'],
        conflict: ['Conflict', 'If a person edits a section after the agent read it, the edit sent with the old version is refused and nothing is written. The answer contains the current text and its version, so the agent merges its change and sends it again. Press run, then edit the Checklist section yourself.', "That is how a person's typing is not overwritten by an agent's edit."],
        suggest: ['Leave a suggestion', 'When a page is locked to "agents: suggestions only", an agent\'s edit is not written; it waits as a suggestion. A person looks at the changed lines and accepts or rejects it. There is no tool for an agent to accept a suggestion.', 'In the product the same happens when the workspace is set to "review everything" or the agent passes `suggest=true`, and the decision reaches the agent\'s inbox as approval_result.'],
        lock: ['Edit lock', 'When a page is locked with agents set to "comment only", an agent\'s write is refused with PAGE_LOCKED. Press the lock button above the note, then run.', 'Only people change locks. Agents have no tool for it, and the refusal tells the agent to inform a person instead of working around the lock.'],
      },
      links: {
        find: [['MCP guide: Guide for agents', 'MCP', 'guide-for-agents', 'guide-for-agents'], ['Performance log: Retrieval & MCP', 'PERFORMANCE', 'retrieval--mcp', 'retrieval--mcp']],
        patch: [['MCP guide: Versions, one per agent write', 'MCP', 'versions-one-per-agent-write', 'versions-one-per-agent-write'], ['User guide: Reverting agent edits', 'GUIDE', 'reverting-agent-edits', '에이전트-편집-되돌리기']],
        conflict: [['MCP guide: Guide for agents', 'MCP', 'guide-for-agents', 'guide-for-agents']],
        suggest: [['MCP guide: Suggestions, edit policy and claims', 'MCP', 'suggestions-edit-policy-and-claims', 'suggestions-edit-policy-and-claims'], ['User guide: Reviewing what agents suggest', 'GUIDE', 'reviewing-what-agents-suggest', '에이전트-제안-검토하기']],
        lock: [['MCP guide: Workspace instructions, locks and untrusted content', 'MCP', 'workspace-instructions-locks-and-untrusted-content', 'workspace-instructions-locks-and-untrusted-content'], ['User guide: Edit lock', 'GUIDE', 'edit-lock', '편집-잠금']],
      },
      nEdit: '(person) edits the Checklist section after the agent read it: ticks the status page item',
      nMerge: '(agent) merges its line into the current text from the answer and sends it again with the new version',
      nSuggestLock: '(person) locks this page to "agents: suggestions only"',
      nLock: '(person) locks this page with agents set to "comment only"',
      nAccept: '(person) accepts the suggestion. The section is updated and the history gets an AI edit. The decision reaches the agent\'s inbox as approval_result',
      nReject: '(person) rejects the suggestion. The note does not change. The decision reaches the agent\'s inbox as approval_result',
      nDecide: '(person) looks at the changed lines in the web app and accepts or rejects. Accepting updates the section and adds an AI edit to the history; rejecting leaves the note as it is',
      cmp: (all, got) => `reading the whole page would have been about ${all} tokens; this answer is about ${got} tokens (estimates for the tour)`,
      run: 'Ask the agent',
      cont: 'Continue',
      reset: 'Start over',
      example: 'Edit a line for me',
      lockOn: 'Lock the page (agents: comment only)',
      lockOff: 'Unlock',
      lockChip: { none: 'Not locked', suggest: 'Locked · agents: suggestions only', comment: 'Locked · agents: comment only' },
      accept: 'Accept',
      reject: 'Reject',
      sugHead: 'Suggestion',
      hist: 'Version history',
      histEmpty: 'No edits yet.',
      histAi: (n, a, v) => `AI edit · step ${n} · ${v} · patch_section append §${a} +1 line`,
      histYou: (a) => `Edit by a person · You · §${a}`,
      editLabel: 'Body of the Checklist section (you can edit it)',
      editHint: 'You can edit this section.',
      waitEdit: 'The agent has read the section. Now edit the Checklist section yourself, then continue.',
      waitLock: 'First press "Lock the page" above the note.',
      waitDecide: 'Accept or reject the suggestion shown in the note.',
      doneFind: 'Only the Checklist section came back.',
      donePatch: (a, o, n) => `§${a} went from v=${o} to v=${n}. The other three sections are unchanged.`,
      doneConflict: 'The first attempt was refused and the merged retry was written. The line you edited is still there.',
      doneAccept: 'You accepted the suggestion. The section is updated and the history has an AI edit.',
      doneReject: 'You rejected the suggestion. The note did not change.',
      doneLock: 'The write was refused with PAGE_LOCKED. The note did not change.',
      resetDone: 'Back to the starting state.',
      aTabs: 'Choose a scene',
      aTree: 'Pages (made up for the tour)',
      aNote: 'Note',
      aAgent: "The agent's tool calls",
      editedBy: 'last edited by',
      nextTitle: 'Next',
      next: [['Install it yourself', 'How to put Inkling on your own server. There is also a local trial on your computer.', 'DEPLOY'], ['Connect your Claude', 'How to connect Claude Code, claude.ai and other MCP clients to Inkling.', 'MCP']],
      mdNote: 'Markdown source',
    },
  }
  const ORDER = ['find', 'patch', 'conflict', 'suggest', 'lock']
  const PAGE_ID = '3e8a2ebe'
  const SUG_ID = 'a41c07e2'

  // ---- made-up values: a version is a hash of the section text, tokens are bytes / 4 ----
  const fnv = (s, seed) => {
    let h = seed >>> 0
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
    return h.toString(16).padStart(8, '0')
  }
  const version = (s) => (fnv(s, 2166136261) + fnv(s, 3141592653)).slice(0, 12)
  const tokens = (s) => {
    let bytes = 0
    for (let i = 0; i < s.length; i++) bytes += s.charCodeAt(i) < 0x80 ? 1 : s.charCodeAt(i) < 0x800 ? 2 : 3
    return Math.ceil(bytes / 4)
  }

  // ---- state and the two tools ----
  function create(lang) {
    const t = T[lang]
    return {
      lang,
      t,
      lock: 'none', // none | suggest | comment
      read: {}, // anchor -> the version the agent last read
      sug: null,
      steps: 0,
      history: [],
      lastFind: 0,
      conflictV: '',
      sections: t.sections.map(([anchor, heading, body]) => ({ anchor, heading, body, v: version(body), by: t.who })),
    }
  }
  const sec = (S, a) => S.sections.find((s) => s.anchor === (a || S.t.target))
  const md = (s) => `## ${s.heading}\n\n${s.body}`
  const pageMd = (S) => `# ${S.t.pageTitle}\n\n${S.sections.map(md).join('\n\n')}`
  const can = (S) => (S.lock === 'comment' ? 'read,comment' : S.lock === 'suggest' ? 'read,comment,suggest' : 'read,comment,edit')

  function write(S, s, body, kind) {
    const old = s.v
    s.body = body
    s.v = version(body)
    s.by = kind === 'ai' ? S.t.who : S.t.you
    const last = S.history[S.history.length - 1]
    if (kind === 'ai') S.history.push({ kind, step: ++S.steps, anchor: s.anchor })
    else if (!(last && last.kind === 'you' && last.anchor === s.anchor)) S.history.push({ kind: 'you', anchor: s.anchor })
    return old
  }
  const humanEdit = (S, body) => write(S, sec(S), body, 'you')

  function findContext(S) {
    const t = S.t
    const s = sec(S)
    const head = `[1] ${t.pageTitle} › ${s.heading}`
    S.lastFind = tokens(`${head}\n${s.body}`)
    S.read[s.anchor] = s.v
    return {
      call: `find_context(query: "${t.query}")`,
      hit: s.anchor,
      out: [
        `1 result(s) for "${t.query}", ~${S.lastFind}/3500 tokens`,
        '<untrusted_content source="find_context">',
        head,
        `(page ${PAGE_ID}; §${s.anchor} v=${s.v}; can: ${can(S)}; edited by ${s.by})`,
        s.body,
        '</untrusted_content>',
        '',
        'Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.',
      ].join('\n'),
    }
  }

  function patch(S, base, line) {
    const t = S.t
    const s = sec(S)
    const call = `patch_section(pageId: "${PAGE_ID}", section: "${s.anchor}", mode: "append",\n    markdown: "${line}", baseVersion: "${base}")`
    if (S.lock === 'comment')
      return {
        call,
        err: 'locked',
        out:
          `"${t.pageTitle}" is locked for agents (comment only). A person must make this edit in the web app; you can add a comment with the suggested change. (PAGE_LOCKED): ` +
          'nothing was written; do not retry or work around the lock (moving or copying the page will not help). Tell the user who can edit it, or leave your suggested change with add_comment if that is allowed (see the can: line of read_page)',
      }
    if (base !== s.v) {
      S.conflictV = s.v
      return {
        call,
        err: 'conflict',
        out: `Conflict: Section "${s.anchor}" changed since baseVersion ${base}; nothing was written. Merge your edit into the current content and retry with baseVersion ${s.v}.\n\nCurrent §${s.anchor} (v=${s.v}):\n${md(s)}`,
      }
    }
    if (S.lock === 'suggest') {
      S.sug = { id: SUG_ID, anchor: s.anchor, line }
      return {
        call,
        sug: true,
        out: [
          `Not written: kept as suggestion ${SUG_ID} for §${s.anchor} of page ${PAGE_ID} (append), because this page is locked to "agents: suggestions only".`,
          'A person with edit access accepts or rejects it in the web app; the result arrives in inbox as approval_result.',
          'list_suggestions(pageId) shows it; withdraw_suggestion(id) takes it back; a new suggestion from this connection for the same section replaces it.',
        ].join('\n'),
      }
    }
    const old = write(S, s, `${s.body}\n${line}`, 'ai')
    return { call, wrote: [old, s.v], out: `Done (append): §${s.anchor} is now v=${s.v}.` }
  }

  function decide(S, accept) {
    if (!S.sug) return null
    const s = sec(S, S.sug.anchor)
    const line = S.sug.line
    S.sug = null
    if (accept) write(S, s, `${s.body}\n${line}`, 'ai')
    return { note: accept ? S.t.nAccept : S.t.nReject }
  }

  // A scene is a list of steps. Each step acts on the state when it is reached and says what to show:
  // a tool call with its answer, a line about what a person did, or a pause for the visitor.
  function script(id, S) {
    const t = S.t
    const base = () => S.read[t.target]
    const free = () => {
      S.lock = 'none'
      S.sug = null
    }
    if (id === 'find') return [() => (free(), findContext(S)), () => ({ cmp: [tokens(pageMd(S)), S.lastFind] })]
    const line = t.newLine[id]
    if (id === 'patch') return [() => (free(), findContext(S)), () => patch(S, base(), line)]
    if (id === 'conflict') return [() => (free(), findContext(S)), () => ({ wait: 'edit' }), () => patch(S, base(), line), () => ({ note: t.nMerge }), () => patch(S, S.conflictV || sec(S).v, line)]
    if (id === 'suggest') return [() => ((S.lock = 'suggest'), { note: t.nSuggestLock }), () => findContext(S), () => patch(S, base(), line), () => ({ wait: 'decide' })]
    if (id === 'lock') return [() => (S.lock === 'comment' ? { note: t.nLock } : ((S.lock = 'none'), (S.sug = null), { wait: 'lock' })), () => findContext(S), () => patch(S, base(), line)]
    return []
  }
  const exampleEdit = (S) => {
    const s = sec(S)
    return s.body.includes(S.t.editFrom) ? s.body.replace(S.t.editFrom, S.t.editTo) : `${s.body} `.replace(/ $/, '\n- [ ] …')
  }

  /** A scene from a fresh note as plain text, with the visitor's part played by the example. */
  function transcript(lang, id) {
    const S = create(lang)
    const t = S.t
    const out = []
    for (const step of script(id, S)) {
      let e = step()
      if (e.wait === 'edit') (humanEdit(S, exampleEdit(S)), (e = { note: t.nEdit }))
      else if (e.wait === 'lock') ((S.lock = 'comment'), (e = { note: t.nLock }))
      else if (e.wait === 'decide') e = { note: t.nDecide }
      if (e.call) out.push(`› ${e.call}`, e.out, '')
      else if (e.cmp) out.push(`# ${t.cmp(e.cmp[0], e.cmp[1])}`)
      else if (e.note) out.push(`# ${e.note}`, '')
    }
    return out.join('\n').trim()
  }

  G.InklingTour = { T, ORDER, PAGE_ID, create, script, transcript, pageMd, tokens, version }
  if (typeof document === 'undefined') return

  // ===========================================================================
  // In the browser
  // ===========================================================================
  const root = document.querySelector('[data-tour]')
  if (!root) return
  const lang = document.documentElement.lang === 'ko' ? 'ko' : 'en'
  const t = T[lang]
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const h = (html) => {
    const d = document.createElement('div')
    d.innerHTML = html.trim()
    return d.firstElementChild
  }
  const panels = [...root.querySelectorAll('.tour-sc')]
  if (panels.length !== ORDER.length) return

  let S = create(lang)
  let current = ORDER[0]
  let queue = null // the steps of the scene being played
  let at = 0
  let waiting = '' // '', edit, lock, decide
  let busy = false
  let gen = 0 // a newer run, a scene change or "start over" cancels an older run
  let hit = ''
  let fresh = ''

  const bar = h(
    `<div class="tour-bar"><div class="tour-tabs" role="group" aria-label="${esc(t.aTabs)}">${ORDER.map((id, i) => `<button type="button" class="tour-tab" data-sc="${id}" aria-pressed="false"><b>${i + 1}</b>${esc(t.sc[id][0])}</button>`).join('')}</div><button type="button" class="btn tour-reset">${esc(t.reset)}</button></div>`,
  )
  // The scene (what it shows, the run button, the outcome) sits beside the app window and the agent's
  // terminal, so pressing the button and seeing the note change happen in one view.
  const stage = h(`<div class="tour-stage">
    <div class="tour-side"></div>
    <section class="tour-note win" aria-label="${esc(t.aNote)}">
      <div class="win-bar" aria-hidden="true"><i></i><i></i><i></i><span>${esc(t.ws)} / ${esc(t.pageTitle)}</span></div>
      <div class="tour-app">
        <nav class="tour-tree" aria-label="${esc(t.aTree)}"><b>${esc(t.ws)}</b><ul>${t.tree.map((p, i) => `<li${i ? '' : ' aria-current="page"'}>${esc(p)}</li>`).join('')}</ul></nav>
        <div class="tour-note-body">
          <div class="tour-note-head"><h3>${esc(t.pageTitle)}</h3><span class="tour-lock"></span><button type="button" class="tour-lockbtn" aria-pressed="false"></button></div>
          <div class="tour-inline"></div>
          <div class="tour-secs"></div>
          <div class="tour-hist"><h4>${esc(t.hist)}</h4><ol></ol></div>
        </div>
      </div>
    </section>
    <section class="tour-agent win term" aria-label="${esc(t.aAgent)}">
      <div class="win-bar" aria-hidden="true"><i></i><i></i><i></i><span>Claude Code · inkling (MCP)</span></div>
      <pre class="tour-log" role="log" aria-live="polite" tabindex="0"></pre>
    </section>
  </div>`)
  const status = h('<p class="tour-status" role="status" aria-live="polite"></p>')
  panels[0].before(bar)
  bar.after(stage, status)
  stage.querySelector('.tour-side').append(...panels)
  // The button, its prompt and the outcome come right after the first paragraph, above the background
  // paragraph and the links, so they stay on screen however long the text is.
  for (const p of panels) p.querySelector('.tour-does').after(h(`<div class="tour-run"><span class="tour-hint"></span><button type="button" class="btn primary tour-go"></button><button type="button" class="btn tour-example" hidden>${esc(t.example)}</button></div>`), h('<div class="tour-result"></div>'))

  const $ = (sel, el = root) => el.querySelector(sel)
  const secsBox = $('.tour-secs', stage)
  const log = $('.tour-log', stage)
  const panel = () => panels[ORDER.indexOf(current)]
  const lines = (body) =>
    body
      .split('\n')
      .map((l) => {
        const m = l.match(/^- \[( |x)\] (.*)$/)
        return m ? `<div class="tl-item${m[1] === 'x' ? ' is-done' : ''}">${esc(m[2])}</div>` : `<div class="tl-line">${esc(l.replace(/^- /, ''))}</div>`
      })
      .join('')

  function renderSecs() {
    secsBox.innerHTML = S.sections
      .map((s) => {
        const target = s.anchor === t.target
        const body = target
          ? `<textarea class="tour-edit" spellcheck="false" rows="${s.body.split('\n').length}" aria-label="${esc(t.editLabel)}">${esc(s.body)}</textarea><p class="tour-edit-hint">${esc(t.editHint)}</p>${waiting === 'edit' ? `<div class="tour-wait"><span>${esc(t.waitEdit)}</span><button type="button" class="btn tour-example">${esc(t.example)}</button><button type="button" class="btn primary tour-go">${esc(t.cont)}</button></div>` : ''}`
          : `<div class="tour-lines">${lines(s.body)}</div>`
        const sug =
          target && S.sug
            ? `<div class="tour-sug" role="group" aria-label="${esc(t.sugHead)}"><div class="tour-sug-head"><b>${esc(t.sugHead)}</b> ${esc(t.via)} · append</div><div class="tour-diff">${s.body.split('\n').map((l) => `<div class="d-ctx">  ${esc(l)}</div>`).join('')}<div class="d-add">+ ${esc(S.sug.line)}</div></div><div class="tour-sug-actions"><button type="button" class="btn primary" data-decide="accept">${esc(t.accept)}</button><button type="button" class="btn" data-decide="reject">${esc(t.reject)}</button></div></div>`
            : ''
        return `<div class="tour-sec${s.anchor === hit ? ' is-hit' : ''}${s.anchor === fresh ? ' is-fresh' : ''}" data-anchor="${esc(s.anchor)}" data-version="${s.v}"><div class="tour-sec-head"><h4>${esc(s.heading)}</h4><code class="tour-ver">v=${s.v}</code><span class="tour-by">${esc(t.editedBy)} ${esc(s.by)}</span></div>${body}${sug}</div>`
      })
      .join('')
    if (fresh && !reduced() && secsBox.animate) {
      const el = $('.is-fresh', secsBox)
      if (el) el.animate([{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }], { duration: 1400, easing: 'ease-out' })
    }
    renderMeta()
  }
  // Everything that can change while the visitor types (the text box itself is left alone).
  function renderMeta() {
    for (const s of S.sections) {
      const el = secsBox.querySelector(`[data-anchor="${s.anchor}"]`)
      if (!el) continue
      el.dataset.version = s.v
      $('.tour-ver', el).textContent = `v=${s.v}`
      $('.tour-by', el).textContent = `${t.editedBy} ${s.by}`
    }
    const chip = $('.tour-lock', stage)
    chip.textContent = t.lockChip[S.lock]
    chip.dataset.lock = S.lock
    stage.dataset.lock = S.lock
    const lb = $('.tour-lockbtn', stage)
    lb.textContent = S.lock === 'none' ? t.lockOn : t.lockOff
    lb.setAttribute('aria-pressed', String(S.lock !== 'none'))
    const ol = $('.tour-hist ol', stage)
    ol.innerHTML = S.history.length ? S.history.map((e) => `<li data-kind="${e.kind}">${esc(e.kind === 'ai' ? t.histAi(e.step, e.anchor, t.via) : t.histYou(e.anchor))}</li>`).join('') : `<li class="is-empty">${esc(t.histEmpty)}</li>`
    renderRun()
  }
  function ready() {
    if (busy) return false
    if (waiting === 'edit') return sec(S).v !== S.read[t.target]
    if (waiting === 'lock') return S.lock === 'comment'
    return waiting !== 'decide'
  }
  function renderRun() {
    root.dataset.busy = String(busy)
    root.dataset.waiting = waiting
    root.dataset.scene = current
    panels.forEach((p, i) => {
      const on = ORDER[i] === current
      p.hidden = !on
      bar.querySelectorAll('.tour-tab')[i].setAttribute('aria-pressed', String(on))
      if (!on) return
      const go = $('.tour-go', p)
      go.textContent = waiting ? t.cont : t.run
      go.disabled = !ready()
      $('.tour-example', p).hidden = waiting !== 'edit'
      $('.tour-hint', p).textContent = waiting === 'edit' ? t.waitEdit : waiting === 'lock' ? t.waitLock : waiting === 'decide' ? t.waitDecide : ''
    })
    // the same prompt (or the outcome) inside the note; CSS shows it only where the scene panel is not beside the note
    $('.tour-inline', stage).innerHTML =
      waiting === 'lock'
        ? `<span>${esc(t.waitLock)}</span><button type="button" class="btn primary tour-go">${esc(t.cont)}</button>`
        : waiting === 'decide'
          ? `<span>${esc(t.waitDecide)}</span>`
          : said
            ? `<span>${esc(said)}</span>`
            : ''
    for (const g of stage.querySelectorAll('.tour-note .tour-go')) g.disabled = !ready()
  }
  // The continue button the visitor can see: the one in the note on a narrow window, else the scene's.
  const focusGo = () => ([...stage.querySelectorAll('.tour-note .tour-go')].find((g) => g.offsetParent !== null) || $('.tour-go', panel())).focus()
  let said = ''
  const say = (text, extra = '') => {
    said = text
    $('.tour-result', panel()).innerHTML = text ? `<p>${esc(text)}</p>${extra}` : ''
    status.textContent = text
  }
  const print = (cls, text) => {
    const span = document.createElement('span')
    span.className = cls
    span.textContent = text
    log.append(span, '\n')
    log.scrollTop = log.scrollHeight
  }
  const pause = (ms) => (reduced() ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

  async function run() {
    if (!ready()) return
    const my = ++gen
    if (!queue) {
      queue = script(current, S)
      at = 0
      hit = fresh = ''
      say('')
      if (log.textContent) print('tl-rule', '')
    }
    waiting = ''
    busy = true
    renderRun()
    // On a narrow window the note is below the scene: bring it into view when a run starts.
    const note = $('.tour-note', stage)
    if (note.getBoundingClientRect().top > window.innerHeight - 160) note.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' })
    let last = null
    let conflicts = 0
    while (at < queue.length) {
      const e = queue[at++]()
      if (e.wait) {
        waiting = e.wait
        busy = false
        renderSecs()
        if (e.wait === 'edit') $('.tour-edit', secsBox).focus()
        if (e.wait === 'lock') $('.tour-lockbtn', stage).focus()
        if (e.wait === 'decide') {
          const b = $('[data-decide="accept"]', secsBox)
          if (b) b.focus()
        }
        return
      }
      if (e.call) {
        print('tl-call', `› ${e.call}`)
        await pause(650)
        if (my !== gen) return
        print(e.err ? 'tl-err' : e.sug ? 'tl-held' : e.wrote ? 'tl-ok' : 'tl-out', e.out)
        if (e.hit) hit = e.hit
        if (e.wrote) fresh = t.target
        if (e.err === 'conflict') conflicts++
        last = e
      } else if (e.note) print('tl-note', `# ${e.note}`)
      else if (e.cmp) {
        print('tl-note', `# ${t.cmp(e.cmp[0], e.cmp[1])}`)
        last = e
      }
      renderSecs()
      await pause(550)
      if (my !== gen) return
    }
    queue = null
    busy = false
    renderRun()
    if (current === 'find' && last && last.cmp) {
      const pct = Math.max(3, Math.round((last.cmp[1] / last.cmp[0]) * 100))
      say(`${t.doneFind} ${t.cmp(last.cmp[0], last.cmp[1])}`, `<span class="vs" aria-hidden="true"><span class="bar" style="--w:100%"></span><span class="bar is-after" style="--w:${pct}%"></span></span>`)
    } else if (last && last.err === 'locked') say(t.doneLock)
    else if (last && last.wrote) say(current === 'conflict' && conflicts ? t.doneConflict : t.donePatch(t.target, last.wrote[0], last.wrote[1]))
    renderRun()
  }

  function choose(id) {
    if (id === current && !queue) return
    gen++
    current = id
    queue = null
    waiting = ''
    busy = false
    said = ''
    renderRun()
  }
  function reset() {
    gen++
    S = create(lang)
    queue = null
    waiting = ''
    busy = false
    hit = fresh = ''
    log.textContent = ''
    panels.forEach((p) => ($('.tour-result', p).innerHTML = ''))
    said = ''
    renderSecs()
    status.textContent = t.resetDone
  }

  bar.addEventListener('click', (e) => {
    const tab = e.target.closest('.tour-tab')
    if (tab) choose(tab.dataset.sc)
    else if (e.target.closest('.tour-reset')) reset()
  })
  root.addEventListener('click', (e) => {
    if (e.target.closest('.tour-go')) run()
    else if (e.target.closest('.tour-example')) {
      humanEdit(S, exampleEdit(S))
      renderSecs()
      focusGo()
    } else if (e.target.closest('.tour-lockbtn')) {
      S.lock = S.lock === 'none' ? 'comment' : 'none'
      if (S.lock === 'none') S.sug = null
      print('tl-note', `# ${S.lock === 'comment' ? t.nLock : `(${t.you}) ${t.lockOff}`}`)
      renderSecs()
      if (waiting === 'lock' && ready()) focusGo()
    } else if (e.target.closest('[data-decide]')) {
      const accept = e.target.closest('[data-decide]').dataset.decide === 'accept'
      const e2 = decide(S, accept)
      if (!e2) return
      if (accept) fresh = t.target
      print('tl-note', `# ${e2.note}`)
      queue = null
      waiting = ''
      renderSecs()
      say(accept ? t.doneAccept : t.doneReject)
      renderRun()
      $('.tour-go', panel()).focus({ preventScroll: true })
    }
  })
  secsBox.addEventListener('input', (e) => {
    if (!e.target.classList.contains('tour-edit')) return
    humanEdit(S, e.target.value.replace(/\s+$/, ''))
    e.target.rows = Math.max(2, e.target.value.split('\n').length)
    renderMeta()
  })

  renderSecs()
  // From here on the static transcripts are folded away: the stage shows the same calls live.
  document.documentElement.classList.add('tour-on')
})(typeof globalThis !== 'undefined' ? globalThis : this)
