import type en from '../en/oauth-cimd'

// Korean translations. Keys must exist in ../en/oauth-cimd.ts; missing ones fall back to English.
export default {
  'oauthCimd.identity': '{host}에서 온 앱',
  'oauthCimd.identityHint':
    '위 앱 이름은 앱이 {host}에 올려 둔 문서에 적힌 값이며 Inkling이 확인하지 않습니다. {host}의 앱을 연결하려던 경우에만 허용하세요.',
  'oauthCimd.loopbackWarn':
    '이 연결은 이 컴퓨터의 프로그램(localhost)으로 돌아갑니다. 여기서 실행 중인 프로그램은 누구나 {host}의 앱이라고 주장할 수 있습니다. 방금 직접 연결을 시작한 경우에만 허용하세요.',
  'oauthCimd.connectionHost': '{host}',
} satisfies Partial<Record<keyof typeof en, string>>
