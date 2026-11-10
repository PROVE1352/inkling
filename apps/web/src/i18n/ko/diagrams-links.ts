import type en from '../en/diagrams-links'

// Korean translations. Keys must exist in ../en/diagrams-links.ts; missing ones fall back to English.
export default {
  'mermaid.error': '다이어그램 오류',
  'mermaid.empty': '여기에 Mermaid 코드를 쓰면 아래에 다이어그램이 그려집니다',
  'mermaid.loading': '다이어그램을 그리는 중…',
  'mermaid.showCode': '코드 보기',
  'mermaid.hideCode': '코드 숨기기',
  'mermaid.editHint': '눌러서 코드 편집',
  'mermaid.alt': 'Mermaid 다이어그램',

  'sectionLink.notFound': '이 페이지에서 "{heading}" 헤딩을 찾지 못했습니다',
  'sectionLink.headingIn': '{page}의 헤딩',
  'sectionLink.noHeadings': '{page}에 헤딩이 없습니다',
  'sectionLink.backlinkMissing': '{heading} (찾지 못함)',
} satisfies Partial<Record<keyof typeof en, string>>
