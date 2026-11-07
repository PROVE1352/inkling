import type en from '../en/lib'

// Korean translations. Keys must exist in ../en/lib.ts; missing ones fall back to English.
export default {
  'lib.titleColumn': '제목',

  'api.batchFailed': '{total}개 중 {failed}개 실패',

  'confirm.moveToTrash': '휴지통으로',

  'pwa.updateReady': '새 버전이 준비됐습니다.',
  'pwa.updated': '새 버전으로 업데이트됐습니다.',
  'pwa.reload': '새로고침',

  'colors.gray': '회색',
  'colors.red': '빨강',
  'colors.orange': '주황',
  'colors.yellow': '노랑',
  'colors.green': '초록',
  'colors.blue': '파랑',
  'colors.purple': '보라',
  'colors.pink': '분홍',

  'fileDrop.imagesOnly': '이미지 파일(png·jpg·gif·webp·avif)만 넣을 수 있습니다.',
  'fileDrop.unsupportedType': '지원하지 않는 파일 형식입니다.',
  'fileDrop.tooLarge': '파일이 너무 큽니다 (최대 {max}).',
  'fileDrop.uploadFailed': "'{name}' 업로드에 실패했습니다.",

  'daily.folderName': '데일리',

  'dates.kindRow': 'DB 행',
  'dates.kindPage': '페이지',
  'dates.kindDaily': '데일리',
  'dates.kindTask': '할 일',
  'dates.dailyNote': '데일리 노트',
  'dates.topLevel': '최상위',
  'dates.overdueDays_other': '{count}일 지남',
  'dates.rescheduleFailed': '일정을 옮기지 못했습니다',
  'dates.completed': '완료: {title}',
  'dates.uncompleted': '완료 취소: {title}',
  'dates.completeFailed': '완료 처리하지 못했습니다',
  'dates.undo': '실행 취소',
} satisfies Partial<Record<keyof typeof en, string>>
