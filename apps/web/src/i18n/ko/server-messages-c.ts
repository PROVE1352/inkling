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
  // routes/public.ts, routes/pages.ts, shareSettings.ts (docs/adr/1170-*, 1171-*, 1172-*)
  'This link has expired': '만료된 링크입니다',
  'This page is protected by a password': '비밀번호가 필요한 페이지입니다',
  'Incorrect password': '비밀번호가 맞지 않습니다',
  'This workspace requires a password on public links': '이 워크스페이스는 웹 공개 링크에 비밀번호를 걸어야 합니다',
  'This page has no public link': '이 페이지에는 웹 공개 링크가 없습니다',
  'Pick an expiry in the future': '지금보다 뒤의 만료 시각을 골라 주세요',
  'Pick an expiry within ten years': '만료는 10년 안으로 골라 주세요',
  'Only owners and admins can change public links': '웹 공개 링크는 소유자와 관리자만 바꿀 수 있습니다',
  'Send expiresAt or expiresInDays, not both': 'expiresAt과 expiresInDays 중 하나만 보내 주세요',
  // routes/pageAccess.ts, pageGrants.ts, tokenRange.ts (docs/adr/1250-* .. 1253-*)
  'Page access is changed in the web app only': '페이지 권한은 웹 앱에서만 바꿀 수 있습니다',
  'Private pages are their author’s only': '개인 페이지는 작성자만 볼 수 있습니다',
  'Owners and admins always have full access': '소유자와 관리자는 항상 전체 권한입니다',
  'Guests can have view, comment or edit access': '게스트에게는 보기, 코멘트, 편집 권한만 줄 수 있습니다',
  'A page can have at most 100 people of its own': '한 페이지에 따로 추가할 수 있는 사람은 최대 100명입니다',
  'Ask someone with full access to change your own access': '내 권한은 전체 권한이 있는 다른 사람에게 바꿔 달라고 하세요',
  'Only people with full access to this page can change members’ access':
    '멤버의 권한은 이 페이지에 전체 권한이 있는 사람만 바꿀 수 있습니다',
  'The workspace settings do not allow you to share this page with people outside the workspace':
    '워크스페이스 설정상 이 페이지를 워크스페이스 밖의 사람과 공유할 수 없습니다',
  'You cannot give more access than you have': '내 권한보다 높은 권한은 줄 수 없습니다',
  'This invitation is not valid any more': '더 이상 유효하지 않은 초대입니다',
  'This invitation is for another email address': '다른 이메일 주소로 보낸 초대입니다',
  'Only owners and admins can see the guests': '게스트 목록은 소유자와 관리자만 볼 수 있습니다',
  'Only owners and admins can remove guests': '게스트는 소유자와 관리자만 내보낼 수 있습니다',
  'You are a guest here: only the pages shared with you are available': '게스트는 공유받은 페이지만 쓸 수 있습니다',
  'You have view access to this page, so you cannot edit it. Ask someone with full access to change your access.':
    '이 페이지는 볼 수만 있어서 편집할 수 없습니다. 권한을 바꾸려면 전체 권한이 있는 사람에게 요청하세요.',
  'You have view access to this page, so you cannot comment on it. Ask someone with full access to change your access.':
    '이 페이지는 볼 수만 있어서 코멘트를 달 수 없습니다. 권한을 바꾸려면 전체 권한이 있는 사람에게 요청하세요.',
  'You have comment access to this page, so you cannot edit it. Ask someone with full access to change your access.':
    '이 페이지는 코멘트만 달 수 있어서 편집할 수 없습니다. 권한을 바꾸려면 전체 권한이 있는 사람에게 요청하세요.',
  'You have no access to this page, so you cannot edit it. Ask someone with full access to change your access.':
    '이 페이지에 권한이 없어 편집할 수 없습니다. 권한을 받으려면 전체 권한이 있는 사람에게 요청하세요.',
  'You have no access to this page, so you cannot comment on it. Ask someone with full access to change your access.':
    '이 페이지에 권한이 없어 코멘트를 달 수 없습니다. 권한을 받으려면 전체 권한이 있는 사람에게 요청하세요.',
} satisfies Record<string, string>
