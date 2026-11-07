// Korean for specific English messages the server sends with generic error codes
// (VALIDATION / FORBIDDEN / NOT_FOUND / BAD_REQUEST ...), keyed by the exact English text.
// Specific codes are translated by code in ./core.ts instead (docs/adr/0902-*).
export default {
  // pageTree.ts
  'Invalid parent page': '상위 페이지가 유효하지 않습니다',
  "Can't move a page under its own subpage": '자신의 하위 페이지로 이동할 수 없습니다',
  'The parent page is in the trash': '상위 페이지가 휴지통에 있습니다',
  'Pages can be nested at most 64 levels deep': '페이지 계층은 64단계까지만 만들 수 있습니다',
  'Only workspace owners and admins can create or move pages under a folder that is published to the web':
    '웹에 공개 중인 폴더 아래로는 워크스페이스 소유자와 관리자만 페이지를 만들거나 옮길 수 있습니다',
  // md/taskEdit.ts (sent as-is by routes/tasks.ts)
  'No date found in this task': '이 할 일에서 날짜를 찾지 못했습니다',
  'Edit check failed (block count changed)': '편집 검증 실패(블록 수 변화)',
  'Edit check failed (block lost)': '편집 검증 실패(블록 유실)',
  'Edit check failed (done state)': '편집 검증 실패(완료 상태)',
  'Edit check failed (date)': '편집 검증 실패(날짜)',
  'Edit check failed (text changed)': '편집 검증 실패(본문 변화)',
  // md/importer.ts (limits are constants; the page limit depends on IMPORT_MAX_PAGES, default shown)
  'A file in the archive is too large (max 25MB)': '압축 안의 파일 하나가 너무 큽니다 (최대 25MB)',
  'Archive is too large when unpacked (max 50MB)': '압축 해제 크기가 너무 큽니다 (최대 50MB)',
  'Too many files in the archive (max 300)': 'zip 항목이 너무 많습니다 (최대 300개)',
  'Folders are nested too deeply (max 32 levels)': '폴더가 너무 깊습니다 (최대 32단계)',
  'Too many pages to import (max 5000)': '가져올 페이지가 너무 많습니다 (최대 5000개)',
} satisfies Record<string, string>
