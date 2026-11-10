import type en from '../en/image-viewer'

// 편집기와 공개 페이지의 이미지 확대 보기 (docs/adr/2386-*).
export default {
  'imageViewer.open': '크게 보기',
  'imageViewer.dialog': '이미지 보기',
  'imageViewer.close': '닫기',
  'imageViewer.prev': '이전 이미지',
  'imageViewer.next': '다음 이미지',
  'imageViewer.zoomIn': '확대',
  'imageViewer.zoomOut': '축소',
  'imageViewer.fit': '화면에 맞추기',
  'imageViewer.original': '원본 열기',
  'imageViewer.originalHint': '새 탭에서 이미지 열기',
  'imageViewer.counter': '{n} / {total}',
  'imageViewer.zoom': '배율 {pct}',
  'imageViewer.untitled': '이미지',
  'imageViewer.failed': '이미지를 불러오지 못했습니다.',
  'imageViewer.group': '이미지 보기',
  'imageViewer.fitHint': '더블클릭: 100%',
  'imageViewer.closeHint': '이미지 바깥을 눌러도 됨',
} satisfies Partial<Record<keyof typeof en, string>>
