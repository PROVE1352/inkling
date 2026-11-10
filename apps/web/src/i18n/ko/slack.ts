// Slack 앱 연동: 워크스페이스 설정 탭(components/SlackPanel.tsx)과 계정 연결 페이지 /slack/link
// (pages/SlackLink.tsx). docs/adr/1800-* .. 1806-*.
export default {
  'slack.tab': 'Slack',
  'slack.intro':
    '이 워크스페이스에 Slack 앱을 연결합니다. 채널로 알림을 보내고, Slack에서 /inkling 으로 검색하고, Inkling 링크를 붙여 넣으면 미리보기를 보여 줍니다. Slack에는 워크스페이스 전체에 공유된 페이지만 나타납니다.',

  // 설정 안내
  'slack.setupTitle': 'Slack 앱 만들기',
  'slack.step1': 'api.slack.com/apps 에서 Create New App → From an app manifest 를 고르고, 연결할 Slack 워크스페이스를 선택한 다음 아래 매니페스트를 붙여 넣으세요.',
  'slack.step2': 'Install App 에서 앱을 Slack 워크스페이스에 설치하세요.',
  'slack.step3': 'OAuth & Permissions 의 Bot User OAuth Token 과 Basic Information 의 Signing Secret 을 복사해 아래 칸에 넣으세요.',
  'slack.step4': '알림을 받을 채널의 ID(C로 시작)를 넣으세요. 채널 정보 창 맨 아래에 있습니다.',
  'slack.step5': '비공개 채널이면 먼저 그 채널에서 /invite @<앱 이름> 으로 봇을 초대해 두세요.',
  'slack.commandUrl': '슬래시 명령 URL',
  'slack.eventsUrl': '이벤트 구독 URL',
  'slack.unfurlDomain': '링크 미리보기 도메인',
  'slack.noPublicUrl':
    '서버에 PUBLIC_URL 이 설정되지 않아, 위 주소는 지금 이 페이지를 연 주소를 따르고 링크 미리보기에 쓸 도메인도 없습니다. PUBLIC_URL(또는 APP_URL)을 설정하고 서버를 다시 시작하세요.',
  'slack.scopes': '봇 권한(scope)',
  'slack.manifest': '앱 매니페스트 (JSON)',
  'slack.manifestHint': '위 주소들이 이미 채워져 있습니다.',

  // 입력 폼
  'slack.connectionTitle': '연결',
  'slack.botToken': '봇 토큰',
  'slack.botTokenDesc': 'Bot User OAuth Token 입니다. xoxb- 로 시작합니다.',
  'slack.signingSecret': '서명 비밀(Signing Secret)',
  'slack.signingSecretDesc': 'Basic Information → App Credentials 에 있습니다. Slack이 보내는 요청마다 이 값으로 서명합니다.',
  'slack.keepSaved': '비워 두면 저장된 값을 그대로 씁니다.',
  'slack.savedPlaceholder': '저장됨',
  'slack.channelId': '채널 ID',
  'slack.channelIdDesc': '#채널이름 말고 ID(C… 또는 G…)를 넣으세요. 이름은 바뀌어도 ID는 그대로입니다.',
  'slack.eventsTitle': '채널 알림',
  'slack.eventsDesc': '채널에 올릴 알림을 고르세요.',
  'slack.eventMention': '멘션',
  'slack.eventMentionDesc': '페이지나 코멘트에서 누군가 @멘션되었을 때',
  'slack.eventAssigned': '담당 지정',
  'slack.eventAssignedDesc': '페이지 담당자로 지정되거나 사람 속성에 들어갔을 때',
  'slack.eventSuggestion': '수정 제안',
  'slack.eventSuggestionDesc': '에이전트가 남긴 수정 제안이 검토를 기다릴 때',
  'slack.eventReply': '답글',
  'slack.eventReplyDesc': '코멘트 스레드에 답글이 달렸을 때',
  'slack.eventDigest': '하루 요약',
  'slack.eventDigestDesc': '하루에 한 번, 지난 하루 동안 바뀐 공유 페이지를 모아서',
  'slack.enabled': '사용',
  'slack.enabledDesc': '끄면 설정은 남겨 둔 채 연동만 잠시 멈춥니다.',
  'slack.connect': '연결하기',
  'slack.saved': '저장했습니다.',
  'slack.secretsRequired': '봇 토큰과 서명 비밀을 모두 넣어 주세요.',
  'slack.invalidToken': '봇 토큰은 xoxb- 로 시작해야 합니다.',
  'slack.invalidSecret': '서명 비밀은 16진수 문자열입니다.',
  'slack.invalidChannel': '채널 이름 말고 채널 ID(C…)를 넣어 주세요.',
  'slack.authFailed': 'Slack이 토큰을 받아 주지 않았습니다({code}). 설치한 앱의 Bot User OAuth Token 을 다시 복사해 넣어 보세요.',
  'slack.noKeyWarning':
    '서버에 APP_SECRET_KEY 가 없어서 봇 토큰과 서명 비밀이 암호화되지 않은 채 저장됩니다. APP_SECRET_KEY 를 설정한 뒤 다시 저장하면 암호화됩니다.',

  // 상태
  'slack.statusTitle': '상태',
  'slack.team': 'Slack 워크스페이스',
  'slack.channel': '채널',
  'slack.storage': '저장된 비밀',
  'slack.sealed': 'APP_SECRET_KEY 로 암호화됨',
  'slack.unsealed': 'APP_SECRET_KEY 가 없어 암호화되지 않은 채 저장됨',
  'slack.unreadable':
    '저장된 토큰과 서명 비밀을 읽을 수 없습니다(APP_SECRET_KEY 가 없거나 바뀌었습니다). 둘 다 다시 넣고 저장하세요.',
  'slack.blocked': '채널 알림이 멈췄습니다: {reason}',
  'slack.blockedHint': 'Slack 쪽 문제를 고친 뒤 저장하거나 테스트 메시지를 보내면 다시 시작합니다.',
  'slack.lastSuccess': '마지막 전송',
  'slack.lastError': '마지막 오류',
  'slack.never': '없음',
  'slack.test': '테스트 메시지 보내기',
  'slack.testOk': '채널에 테스트 메시지를 보냈습니다.',
  'slack.testFail': 'Slack 응답: {error}',
  'slack.disconnect': '연결 끊기',
  'slack.disconnectConfirm':
    '이 워크스페이스에서 Slack 연결을 끊을까요? 저장된 토큰과 서명 비밀을 지우고, 연결된 계정도 모두 해제합니다. Slack에 설치된 앱은 Slack에서 직접 지워야 합니다.',

  // 연결된 계정
  'slack.linksTitle': '연결된 Slack 계정',
  'slack.linksDesc':
    '멤버가 Slack에서 /inkling link 를 입력하면 직접 연결할 수 있습니다. Slack 이메일과 Inkling 이메일이 같으면 자동으로 연결됩니다.',
  'slack.linksEmpty': '아직 연결된 계정이 없습니다.',
  'slack.methodEmail': '이메일로 연결',
  'slack.methodLink': '링크로 연결',

  // /slack/link
  'slack.linkTitle': 'Slack 계정 연결',
  'slack.linkBody': 'Slack 사용자 {slackUser}({team})를 {workspace} 워크스페이스의 내 Inkling 계정과 연결할까요?',
  'slack.linkSignedInAs': '{email} 계정으로 로그인됨',
  'slack.linkOtherAccount': '다른 계정으로 로그인',
  'slack.linkConfirm': '연결',
  'slack.linkDone': 'Slack 계정을 연결했습니다.',
  'slack.linkOpenWorkspace': '워크스페이스로 가기',
  'slack.linkExpired': '만료되었거나 이미 사용한 링크입니다.',
  'slack.linkNewHint': 'Slack에서 /inkling link 를 다시 입력하면 새 링크를 받을 수 있습니다.',
  'slack.linkNoCode': '링크에 연결 코드가 없습니다.',
  'slack.linkNotMember': '{workspace} 워크스페이스의 멤버가 아닙니다.',
  'slack.linkNotMemberGeneric': '이 워크스페이스의 멤버가 아닙니다.',
  'slack.linkNotMemberHint': '워크스페이스 소유자에게 초대를 요청하거나, 멤버인 계정으로 다시 로그인하세요.',
  'slack.linkSignInFirst': 'Inkling에 로그인한 다음 Slack에서 링크를 다시 열어 주세요.',
  'slack.linkFailed': '계정을 연결하지 못했습니다.',
}
