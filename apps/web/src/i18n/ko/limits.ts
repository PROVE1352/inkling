// 한도와 꺼 둔 기능 문구(제한 모드, docs/adr/2505-* .. 2511-*): 워크스페이스 설정의 사용량과 용량이 찬 워크스페이스 안내.
export default {
  'limits.usageTitle': '사용량',
  'limits.members': '멤버',
  'limits.pages': '페이지(휴지통 포함)',
  'limits.storage': '저장 용량',
  'limits.storageFiles': '파일: {size}',
  'limits.ofLimit': '{limit} 중 {used}',
  'limits.loading': '세는 중…',
  'limits.loadFailed': '사용량을 불러오지 못했습니다.',
  'limits.storageHint': '저장 용량에는 파일, 페이지 본문, 버전 기록, 필기, 댓글, 휴지통에 있는 페이지가 들어갑니다.',
  'limits.fullTitle': '저장 용량이 찼습니다',
  'limits.fullBody': '이 워크스페이스는 저장 용량을 다 써서 읽기 전용입니다. 파일이나 페이지를 지우고 휴지통을 비우면 다시 편집할 수 있습니다.',
  'limits.fullSettings': '사용량 보기',
  'limits.trashCapped': '휴지통의 페이지는 이 기간이 지나면 영구 삭제됩니다. 이 서버는 {cap}일보다 오래 보관하지 않습니다({min}~{cap}일).',
  'limits.featureOff': '이 서버에서는 이 기능을 꺼 두었습니다.',
  'limits.instanceFull': '이 서버의 저장 공간이 가득 찼습니다. 지금은 읽기와 삭제만 됩니다.',
} as const
