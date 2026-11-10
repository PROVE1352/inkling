import type en from '../en/integration-018'

// 0.18 통합: 여러 0.18 기능이 함께 쓰는 문구 (오프라인, 자동화 상태).
export default {
  'offline.noConnection': '연결되어 있지 않습니다. 다시 연결되면 시도하세요.',
  'adminStatus.app.automations': '데이터베이스 자동화',
  'adminStatus.app.automations.ok': '켜진 규칙 {rules}개 · 대기 중 실행 {queued}건 · 24시간 실패 {failed}건',
  'adminStatus.app.automations.off': '규칙 없음',
  'adminStatus.app.automations.backlog': '실행 {queued}건 대기 중(가장 오래된 것 {minutes}분): 자동화 대기열이 밀려 있습니다',
} satisfies Partial<Record<keyof typeof en, string>>
