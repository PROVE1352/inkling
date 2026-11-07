import type en from '../en/large-pages'

// "큰 페이지" 안내 줄과 워크스페이스 설정 목록 (docs/adr/1103-*).
export default {
  'largePage.notice': '큰 페이지: 하위 페이지로 나누면 열기와 편집이 빨라집니다.',
  'largePage.details': '저장 크기 {size} · 약 {tokens} 토큰',
  'largePage.dismiss': '닫기',
  'wsSettings.tabLargePages': '큰 페이지',
  'largePages.title': '큰 페이지',
  'largePages.intro':
    '저장 크기가 {size} 이상이거나 본문이 {tokens} 토큰 이상인 페이지입니다. 사람에게도 AI 에이전트에게도 열기·저장·검색이 느려집니다. 길어지는 기록은 하위 페이지로 나누세요.',
  'largePages.empty': '이 워크스페이스에는 큰 페이지가 없습니다.',
  'largePages.loadError': '목록을 불러오지 못했습니다.',
  'largePages.colPage': '페이지',
  'largePages.colSize': '크기',
  'largePages.colTokens': '토큰',
  'largePages.colUpdated': '마지막 수정',
  'largePages.colHistory': '버전 히스토리',
  'largePages.history': '{size} · 버전 {count}개',
  'errors.SNAPSHOT_UNAVAILABLE': '이 버전은 더 이상 읽을 수 없습니다.',
} satisfies Partial<Record<keyof typeof en, string>>
