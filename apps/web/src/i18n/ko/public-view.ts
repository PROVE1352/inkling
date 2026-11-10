import type en from '../en/public-view'

// 공개 페이지 도구 막대(넓게 보기, PDF, Markdown 내려받기)와 링크의 내려받기 설정
// (docs/adr/2360-*, 2361-*, 2362-*, 2363-*).
export default {
  'publicView.toolbar': '페이지 동작',
  'publicView.more': '더 보기',
  'publicView.wide': '넓게 보기',
  'publicView.wideHint': '창 너비를 모두 써서 보기',
  'publicView.pdf': 'PDF로 저장',
  'publicView.markdown': 'Markdown 내려받기',
  'shareLink.download': '내려받기',
  'shareLink.allowDownload': '방문자가 Markdown으로 내려받을 수 있게',
  'shareLink.downloadOn': '방문자가 Markdown을 내려받을 수 있음',
  'shareLink.downloadOff': '꺼짐',
  'shareLink.downloadHint': '공개 페이지에 "Markdown 내려받기" 버튼이 생깁니다. 파일에는 페이지에 보이는 내용만 들어갑니다.',
  'audit.action.share.download_changed': '웹 공개 링크 내려받기 변경',
} satisfies Partial<Record<keyof typeof en, string>>
