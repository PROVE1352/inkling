import type en from '../en/legal'

// 약관, 개인정보 처리방침, 동의, 인스턴스 표시 (LEGAL_DIR, INSTANCE_LABEL; 제한 모드, docs/adr/2519-*).
export default {
  'legal.terms': '이용약관',
  'legal.privacy': '개인정보 처리방침',
  'legal.linksLabel': '약관과 개인정보 처리방침',
  'legal.itemsLegend': '동의 항목',
  'legal.required': '필수',
  'legal.optional': '선택',
  'legal.readFull': '{doc} 전문 보기',
  'legal.details': '자세히 보기',
  'legal.missingSignup': '필수 항목에 체크해야 가입할 수 있습니다.',
  'legal.missingContinue': '필수 항목에 체크해야 계속할 수 있습니다.',
  'legal.loadFailed': '이 서버의 약관을 불러오지 못했습니다. 페이지를 새로 고쳐 다시 시도하세요.',
  'legal.versionChanged': '이 화면을 연 사이에 약관이 바뀌었습니다. 다시 읽고 항목에 다시 체크하세요.',
  'legal.agreeFailed': '동의를 저장하지 못했습니다. 다시 시도하세요.',
  'legal.consentTitle': '계속하려면 약관에 동의하세요',
  'legal.consentDesc': '이 서버는 이용하기 전에 약관 동의를 받습니다. 지난번에 동의한 뒤 약관이 바뀌었다면 다시 읽어 주세요.',
  'legal.agree': '동의하고 계속하기',
  'legal.signOut': '동의하지 않고 로그아웃',
  'legal.deleteAccount': '계정 삭제',
  'legal.settingsTermsDesc': '이 서버의 이용약관입니다.',
  'legal.settingsPrivacyDesc': '이 서버가 개인정보를 처리하는 방법입니다.',
  'legal.back': '돌아가기',
  'legal.onlyIn': '이 문서는 {language}판만 있습니다.',
  'legal.version': '문서 버전 {version}',
  'legal.instanceTitle': '이 서버: {label}',
} satisfies Partial<Record<keyof typeof en, string>>
