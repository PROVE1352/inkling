import type en from '../en/agent-inclusion'

// 남이 넣어 준 워크스페이스는 내가 포함하기 전까지 에이전트 연결에 보이지 않는다 (docs/adr/2580-*).
export default {
  'agentInclusion.line': '에이전트가 아직 못 보는 워크스페이스: {workspace} ({actor} 님이 추가함)',
  'agentInclusion.lineNoActor': '에이전트가 아직 못 보는 워크스페이스: {workspace}',
  'agentInclusion.include': '포함',
  'agentInclusion.confirm':
    '에이전트가 "{workspace}" 워크스페이스를 보게 할까요? 범위가 "전체"인 연결이 이 워크스페이스의 페이지를 읽고 에이전트 지시 페이지를 따르게 됩니다. 이 워크스페이스를 관리하는 사람을 믿을 때만 포함하세요.',
  'agentInclusion.failed': '포함하지 못했습니다. 다시 시도해 주세요.',
} satisfies Partial<Record<keyof typeof en, string>>
