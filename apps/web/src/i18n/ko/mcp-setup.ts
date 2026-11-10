// 연결 설정 생성기(docs/adr/2020-*)와 지침 페이지 길이 경고(docs/adr/2021-*).
export default {
  'mcpSetup.title': 'AI 앱 연결',
  'mcpSetup.client': '앱',
  'mcpSetup.clientGeneric': '그 밖의 앱 (mcpServers JSON)',
  'mcpSetup.profile': '도구',
  'mcpSetup.profileFull': '전체 도구',
  'mcpSetup.profileFullHint': 'Inkling 도구를 모두 씁니다. 기본값입니다.',
  'mcpSetup.profileCore': '핵심 도구',
  'mcpSetup.profileCoreHint': '에이전트가 자주 쓰는 도구만 씁니다. 도구 목록이 짧아서 세션을 시작할 때마다 드는 토큰이 줄어듭니다. 필요한 도구가 없으면 전체로 바꾸세요.',
  'mcpSetup.auth': '로그인 방식',
  'mcpSetup.authOauth': '이 사이트에서 로그인',
  'mcpSetup.authOauthHint': '앱이 여기 동의 화면을 엽니다. URL만 있으면 됩니다.',
  'mcpSetup.authToken': '에이전트 연결 토큰',
  'mcpSetup.authTokenHint': '로그인용 자동 등록을 못 하는 앱이나 로컬 http, 자체 서명 인증서 환경에서 씁니다. 아래에서 만들면 로그인한 앱과 똑같이 에이전트 연결로 취급되고, 붙인 이름이 에이전트 이름이 됩니다. 토큰을 가진 사람은 누구나 그 에이전트로 내 노트에 접근합니다.',
  'mcpSetup.steps.claudeCode':
    '터미널에서 실행한 다음 Claude Code에서 /mcp → inkling → Authenticate를 누릅니다.',
  'mcpSetup.steps.claudeCodeToken': '터미널에서 실행합니다. Claude Code가 요청마다 이 헤더를 보내므로 로그인을 따로 묻지 않습니다.',
  'mcpSetup.steps.cursor':
    '프로젝트의 .cursor/mcp.json에 넣거나, 모든 프로젝트에서 쓰려면 ~/.cursor/mcp.json에 넣습니다. 파일에 이미 서버가 있으면 mcpServers 안에 "inkling" 항목만 추가합니다.',
  'mcpSetup.steps.vscode':
    '워크스페이스의 .vscode/mcp.json에 넣습니다. 모든 워크스페이스에서 쓰려면 "MCP: Open User Configuration" 명령으로 연 파일에 넣습니다. 파일에 이미 서버가 있으면 servers 안에 "inkling" 항목만 추가합니다. VS Code는 포터블 형식(워크스페이스 루트의 .mcp.json이나 ~/.copilot/mcp-config.json)도 읽는데, 그쪽에는 "그 밖의 앱" JSON을 쓰면 됩니다.',
  'mcpSetup.steps.generic':
    'Claude Code의 .mcp.json과 VS Code 포터블 형식이 쓰는 mcpServers 형식입니다. 앱마다 키 이름이 조금씩 달라서(예를 들어 Cursor는 type 없이 url만 씁니다) 그 앱의 문서를 확인하세요.',
  'mcpSetup.claudeAiHeader':
    '토큰을 쓸 때는 No sign-in을 고르고, Request headers에 authorization 헤더를 이 값으로 추가합니다. Request headers는 베타라 일부 조직에만 보입니다. 그 칸이 없으면 로그인 방식을 쓰세요.',
  'mcpSetup.tokenPlaceholder': '위의 토큰 자리는 비어 있습니다. 새 에이전트 연결 토큰은 만든 직후 한 번만 보이고, 보이는 동안 여기에 채워집니다(개인 API 토큰은 /mcp에서 쓸 수 없습니다).',
  'mcpSetup.tokenCreate': '에이전트 연결 토큰 만들기',
  'mcpSetup.tokenFilled': '방금 만든 토큰을 채워 넣었습니다. 완료를 누르면 다시 볼 수 없으니 지금 복사해 두세요.',
  'mcpSetup.vscodeInput':
    'VS Code는 서버를 처음 띄울 때 토큰을 물어보고 자체 비밀 저장소에 보관합니다. 그래서 파일에는 토큰이 들어가지 않습니다.',
  'mcpSetup.helpTitle': '로컬 서버와 인증서',
  'mcpSetup.helpPublicUrl':
    '서버에 설정한 주소(PUBLIC_URL)로 연결하세요. 로그인은 그 주소에만 발급되므로 같은 서버라도 다른 주소(사설 IP, 다른 포트)로 붙으면 실패합니다.',
  'mcpSetup.helpClaudeAi':
    'claude.ai와 Claude Desktop의 커넥터는 내 컴퓨터가 아니라 Anthropic 서버에서 접속합니다. 인터넷에서 열리는 서버여야 하고, localhost나 사설 주소, VPN 안에만 있는 서버는 붙지 않습니다.',
  'mcpSetup.helpClaudeCodeHttp':
    'Claude Code는 HTTPS이거나 localhost, 127.0.0.1, ::1일 때만 로그인합니다. 그 밖의 주소에서 http://로 열린 서버(같은 네트워크의 다른 기기 등)는 로그인이 실패합니다.',
  'mcpSetup.helpSelfSigned':
    '자체 서명 인증서나 사설 CA: Claude Code는 시스템 인증서 저장소와 내장 목록을 믿고, 사설 CA는 네트워크 설정 문서에 나온 대로 NODE_EXTRA_CA_CERTS=/path/to/ca.pem으로 추가합니다. 다른 앱은 앱마다 설정이 따로 있습니다.',
  'mcpSetup.helpProfileChange':
    '도구 범위를 바꾸면 URL이 바뀝니다. 앱에서 서버를 지우고 다시 추가하세요(Claude Code: claude mcp remove inkling).',

  // 에이전트 연결 토큰(docs/adr/2060-*)과 목록의 제안 전용 표시(docs/adr/2042-*)
  'agentTokens.title': '에이전트 연결 토큰',
  'agentTokens.intro':
    '여기서 로그인하지 못하는 AI 앱용입니다(자동 등록을 못 하는 앱, 로컬 http, 자체 서명 인증서). 로그인한 앱과 똑같은 에이전트 연결이라 편집에는 "내 이름 (via 붙인 이름)"이 남고, 워크스페이스의 에이전트 규칙이 적용되며, 관리자가 막을 수 있습니다. /mcp에서만 쓸 수 있습니다. 스크립트나 inklingctl에는 개인 API 토큰을 쓰세요.',
  'agentTokens.new': '새 토큰',
  'agentTokens.name': '이름 (편집 옆에 "via …"로 보입니다)',
  'agentTokens.namePlaceholder': '예: 노트북의 Claude Code',
  'agentTokens.expiry': '만료',
  'agentTokens.expiryDays': '{days}일',
  'agentTokens.expiryHint': '만료 없음은 없습니다. 기간이 끝나면 새로 만드세요.',
  'agentTokens.create': '토큰 만들기',
  'agentTokens.creating': '만드는 중…',
  'agentTokens.cancel': '취소',
  'agentTokens.createdTitle': '지금 복사하세요. 다시 보여 주지 않습니다.',
  'agentTokens.createdHint': '보이는 동안은 위의 연결 설정에 이 토큰이 들어갑니다. Inkling은 해시만 저장합니다.',
  'agentTokens.done': '완료',
  'agentTokens.empty': '에이전트 연결 토큰이 없습니다.',
  'agentTokens.loadFailed': '에이전트 연결 토큰을 불러오지 못했습니다.',
  'agentTokens.meta': '{created} 발급 · {expires} 만료 · 마지막 사용 {lastUsed}',
  'agentTokens.never': '없음',
  'agentTokens.expired': '만료됨',
  'agentTokens.revoke': '해지',
  'agentTokens.revokeConfirm': '"{name}"을(를) 해지할까요? 이 토큰을 쓰는 앱은 바로 끊깁니다.',
  'suggestOnly.badge': '{time}까지 제안만',
  'suggestOnly.tooltip': '프롬프트 인젝션처럼 보이는 글을 읽어 편집이 검토 대기로 바뀌었습니다.',
  'suggestOnly.release': '편집 다시 허용',
  'suggestOnly.releaseFailed': '풀지 못했습니다. 다시 시도하세요.',

  'instructionLength.badge': '김 · ~{tokens} 토큰',
  'instructionLength.title': '지침 페이지가 깁니다(~{tokens} 토큰).',
  'instructionLength.body':
    '에이전트는 이 워크스페이스에서 일을 시작할 때마다 이 페이지를 통째로 읽습니다. 규칙과 "어디에 무엇이 있는지" 정도의 짧은 색인만 남기고 링크를 거세요. 자세한 내용은 일반 페이지로 옮기면 에이전트가 필요할 때 find_context로 찾아 읽습니다.',
}
