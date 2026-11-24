import type en from '../en/agent-view'

// '에이전트가 보는 화면': find_context와 read_page가 보는 그대로의 페이지 (docs/adr/2389-*).
export default {
  'agentView.menu': '에이전트가 보는 화면',
  'agentView.summary': '이 페이지는 약 {total} 토큰입니다. 섹션 하나를 묻는 에이전트는 그 섹션만 읽습니다.',
  'agentView.sections_other': '섹션 {count}개',
  'agentView.tokens': '약 {tokens} 토큰',
  'agentView.version': 'v={version}',
  'agentView.pct': '{pct}%',
  'agentView.pctUnder': '<1%',
  'agentView.intro': '(첫 제목 앞)',
  'agentView.empty': '이 페이지에는 아직 글이 없습니다.',
  'agentView.loadError': '페이지를 읽지 못했습니다.',
  'agentView.showAll': '{count}개 모두 보기',
  'agentView.truncated': '{total}자 중 앞의 {shown}자만 보여 줍니다.',
  'agentView.ask': '에이전트가 찾을 질문을 넣어 보세요',
  'agentView.result_other': 'find_context는 섹션 {count}개, 약 {used} 토큰을 돌려줍니다 (예산 {budget})',
  'agentView.none': '걸린 섹션이 없습니다. 단어로 찾으므로 노트에 쓴 낱말로 물어보세요.',
  'agentView.more_other': '예산에 들지 못한 섹션이 {count}개 더 있습니다.',
  'agentView.thisPage': '이 페이지',
  'agentView.searchError': '찾지 못했습니다.',
  'agentView.footnote': '토큰 수는 어림입니다. 에이전트 연결 없이 이 워크스페이스에서 내 권한으로 찾았습니다.',
} satisfies Partial<Record<keyof typeof en, string>>
