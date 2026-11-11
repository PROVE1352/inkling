import type en from '../en/public-charts'

// 공개 페이지의 차트: 공유 대화상자의 개수와 링크의 "차트 포함" 설정 (docs/adr/2440-*).
export default {
  'publicCharts.hidden_other': '이 페이지의 차트 {count}개는 공개 링크에 나오지 않습니다.',
  'publicCharts.label': '차트',
  'publicCharts.include': '공개 페이지에 차트 보여 주기',
  'publicCharts.on': '공개 페이지에 나옴',
  'publicCharts.off': '꺼짐',
  'publicCharts.hint': '켜는 순간 차트가 쓰는 데이터베이스를 승인합니다. 승인한 데이터베이스의 항목 이름과 값이 차트로 공개되고, 원본 행은 공개되지 않습니다. 값은 켠 사람의 권한으로 계산하며, 바뀐 값이 반영되기까지 최대 10분 걸릴 수 있습니다.',
  'publicCharts.pending_other': '새로 추가된 차트 {count}개는 아직 공개되지 않습니다.',
  'publicCharts.approve': '이 차트도 공개',
  'publicCharts.hintBeforeLink': '링크를 만든 뒤에 차트를 공개 페이지에 보여 줄지 정할 수 있습니다.',
  'publicCharts.by': '{name} 님의 권한으로 계산한 값입니다.',
  'audit.action.share.charts_changed': '웹 공개 링크 차트 변경',
} satisfies Partial<Record<keyof typeof en, string>>
