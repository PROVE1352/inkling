import type en from '../en/sidebar-order'

// 사이드바 순서(docs/adr/2590-*, 2591-*, 2592-*), 접히는 계정 칸, 에이전트가 만든 워크스페이스 알림(docs/adr/2596-*).
export default {
  'rowMenu.pin': '맨 위에 고정',
  'rowMenu.unpin': '고정 해제',
  'rowMenu.sortByTitle': '하위 페이지 제목순 정렬',
  'rowMenu.agentDefault': '에이전트 새 페이지를 여기에',
  'tree.pinned': '고정됨',
  'tree.orderFailed': '순서를 바꾸지 못했습니다',

  'sidebarOrder.group': '사이드바 순서',
  'sidebarOrder.sharedTitle': '공유 섹션을 제목순으로',
  'sidebarOrder.sharedDesc': '공유 섹션 맨 위 단계를 모두에게 제목순으로 보여 줍니다. 숫자는 숫자로 셉니다("2"가 "10" 앞). 고정한 페이지는 맨 위에 남습니다.',
  'sidebarOrder.privateTitle': '내 개인 섹션을 제목순으로',
  'sidebarOrder.privateDesc': '나에게만 적용됩니다. 고정한 페이지는 맨 위에 남습니다.',

  'agentDefault.group': '에이전트가 만드는 새 페이지',
  'agentDefault.title': '에이전트 새 페이지 위치',
  'agentDefault.desc':
    '에이전트나 API 토큰이 부모를 정하지 않고 공유 페이지를 만들면 이 페이지 아래로 갑니다. 부모를 정한 경우나 여기에 쓸 권한이 없는 에이전트는 전과 같습니다. 페이지는 사이드바 메뉴의 "에이전트 새 페이지를 여기에"로 고릅니다.',
  'agentDefault.none': '맨 위 단계(지정 안 함)',
  'agentDefault.clear': '해제',

  'sidebar.accountCollapse': '계정 정보 접기',
  'sidebar.accountExpand': '계정 정보 펼치기',

  'notifications.agentWorkspace': '에이전트가 워크스페이스 "{workspace}"를 만들었습니다',
} satisfies Record<keyof typeof en, string>
