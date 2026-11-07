// Korean for specific English messages the server sends with generic error codes
// (VALIDATION / FORBIDDEN / NOT_FOUND / BAD_REQUEST ...), keyed by the exact English text.
// Specific codes are translated by code in ./core.ts instead (docs/adr/0902-*).
// ('Admins only' and 'File is too large (max 25MB)' are in ./server-messages-a.ts.)
export default {
  // routes/admin.ts
  'Change your own password in Settings': '본인 비밀번호는 설정 화면에서 변경하세요',
  'You cannot remove your own admin rights': '자기 자신의 관리자 권한은 해제할 수 없습니다',
  "You can't remove the last admin's rights": '마지막 관리자의 권한은 해제할 수 없습니다',
  'You cannot delete your own account here': '자기 자신은 탈퇴시킬 수 없습니다',
  'You cannot delete the last admin': '마지막 관리자는 탈퇴시킬 수 없습니다',
  'This reset code is not valid. Issue a new one.': '유효한 재설정 코드가 아닙니다. 새로 발급해 주세요.',
  'This temporary password is no longer valid. Issue a new one.':
    '현재 유효한 임시 비밀번호가 아닙니다. 새로 발급해 주세요.',
  'This email is already verified': '이미 인증된 이메일입니다',
  'Not a valid IP address': 'IP 주소 형식이 아닙니다',
  "IPs on the allowlist (ALLOWLIST_IPS) can't be banned": '허용목록(ALLOWLIST_IPS)에 있는 IP 는 차단할 수 없습니다',
  "You can't ban the IP you are connected from": '지금 접속 중인 내 IP 는 차단할 수 없습니다',
  // Specific codes whose message is more precise than errors.<CODE> (SOLE_OWNER, REQUEST_NOT_FOUND)
  'This user is the only owner of some shared workspaces. An owner of each must use "Transfer ownership" in the workspace menu, or delete the workspace, first.':
    '이 사용자가 유일한 소유자인 워크스페이스가 있습니다. 각 워크스페이스의 소유자가 먼저 워크스페이스 메뉴의 "소유권 넘기기"를 하거나 워크스페이스를 삭제해야 합니다.',
  'Request not found or already handled': '없거나 이미 처리된 요청입니다',
  // routes/files.ts
  'No file to upload': '업로드할 파일이 없습니다',
  // routes/ink.ts (INK_CONFLICT is normally merged silently by the client)
  'Ink was saved from another device first': '다른 기기에서 필기가 먼저 저장되었습니다',
  // index.ts (global error / 404 handlers)
  'Validation failed': '유효성 검사에 실패했습니다',
  'Unsupported media type': '지원하지 않는 형식입니다',
  'The requested resource was not found': '요청한 리소스를 찾을 수 없습니다',
  // md/notionImport.ts, routes/exportImport.ts (Notion export import, docs/adr/0960-*)
  'No Notion pages found in the archive': '압축 파일에서 Notion 페이지를 찾지 못했습니다',
  'Not a readable zip archive': '읽을 수 없는 zip 파일입니다',
  'A Notion export is imported as its .zip file': 'Notion 내보내기는 받은 .zip 파일 그대로 가져옵니다',
  // routes/admin.ts (docs/adr/1061-*)
  'Turn off your own two-step verification in Settings': '본인의 2단계 인증은 설정에서 끄세요',
} satisfies Record<string, string>
