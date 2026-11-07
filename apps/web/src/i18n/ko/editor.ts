import type en from '../en/editor'

// Korean translations. Keys must exist in ../en/editor.ts; missing ones fall back to English.
export default {
  // CollabEditor
  'editor.connecting': '연결 중…',
  'editor.placeholder': '글을 쓰거나 /를 눌러 블록을 고르세요',

  // 제목 접기, 오른쪽 목차 (docs/adr/1220-*, 1221-*)
  'fold.fold': '접기',
  'fold.unfold': '펼치기',
  'toc.label': '목차',

  // Slash menu
  'slash.calloutTitle': '콜아웃',
  'slash.calloutSubtext': '강조 박스 — 블록 안에서 종류(노트·팁·주의·위험·정보) 전환',

  // Callout block
  'callout.note': '노트',
  'callout.tip': '팁',
  'callout.warning': '주의',
  'callout.danger': '위험',
  'callout.info': '정보',
  'callout.changeType': '콜아웃 종류 변경',
  'callout.typeTitle': '콜아웃: {type}',
  'slash.mathTitle': '수식 블록',
  'slash.mathSubtext': 'LaTeX 수식을 한 줄 가운데에 표시 (KaTeX)',
  'slash.inlineMathTitle': '인라인 수식',
  'slash.inlineMathSubtext': '문장 안의 수식 — $x^2$ 처럼 입력하거나 {shortcut}',
  'math.edit': '수식 편집',
  'math.placeholder': 'LaTeX 예: E = mc^2',
  'math.emptyBlock': '클릭해서 수식 입력',
  'math.emptyInline': '수식',
  'math.emptyPreview': '여기에 미리보기가 나타납니다',
  'math.hintBlock': '{mod} 완료 · Esc 취소',
  'math.hintInline': 'Enter 완료 · Esc 취소 · 비우면 삭제',
  'math.blocked': '수식에 쓸 수 없는 명령: {command}',
  'math.tooLong': '수식이 너무 깁니다 (최대 {max}자)',

  // [[ / ![[ menus
  'wikilink.newPage': '＋ 새 페이지: "{title}"',
  'wikilink.embed': '임베드',
  'wikilink.newPageEmbed': '＋ 새 페이지 임베드: "{title}"',

  // @ mentions
  'mention.noName': '이름 없음',
  'mention.fallback': '멘션',

  // Page embed block
  'pageEmbed.noPage': '임베드할 페이지가 지정되지 않았습니다.',
  'pageEmbed.noAccess': '접근할 수 없는 페이지',
  'pageEmbed.loadFailed': '본문을 불러오지 못했습니다.',
  'pageEmbed.loadingBody': '본문 불러오는 중…',

  // Query block
  'queryBlock.slashTitle': '쿼리',
  'queryBlock.slashSubtext': '페이지를 실시간 표나 목록으로 (Dataview 문법)',
  'queryBlock.languageName': 'Dataview 쿼리',
  'queryBlock.empty': '쿼리를 입력하세요. 예: LIST FROM #project',
  'queryBlock.noResults': '일치하는 페이지가 없습니다',
  'queryBlock.loading': '쿼리 실행 중…',
  'queryBlock.value': '값',
  'queryBlock.truncated_other': '처음 {count}개 결과만 표시 · {ms} ms',
  'queryBlock.syntaxError': '쿼리 오류',
  'queryBlock.at': '{line}행 {col}열',
  'queryBlock.failed': '쿼리 실패',
  'queryBlock.footer_other': '결과 {count}개 · {ms} ms',

  // Link embed block
  'linkEmbed.placeholder': '링크(YouTube, Figma, Google Docs 등)를 붙여넣고 Enter',
  'linkEmbed.invalid': '올바른 http(s) 링크를 입력하세요',
  'linkEmbed.supported': '임베드 지원: {providers}',
  'linkEmbed.embed': '임베드',
  'linkEmbed.card': '카드',
  'linkEmbed.link': '링크',
  'linkEmbed.asEmbed': '임베드로 보기',
  'linkEmbed.asCard': '미리보기 카드로 보기',
  'linkEmbed.asLink': '일반 링크로 바꾸기',
  'linkEmbed.openNew': '새 탭에서 열기',
  'linkEmbed.loading': '미리보기 불러오는 중…',
  'linkEmbed.frameTitle': '{label} 임베드',
  'linkEmbed.slashTitle': '임베드 / 링크 카드',
  'linkEmbed.slashSubtext': 'YouTube, Figma, Google Docs 등 임베드 또는 링크 미리보기 카드',
  'linkEmbed.slashGroup': '임베드',

  // Share modal
  'share.title': '웹에 공유',
  'share.folderNotice': '이 폴더와 하위 페이지 전체가 링크로 공개됩니다 (개인 🔒 페이지 제외)',
  'share.exposedShared_other': '현재 {count}개 페이지 공개 중',
  'share.exposedPending_other': '현재 {count}개 페이지 공개 예정',
  'share.shareFailed': '공개에 실패했습니다.',
  'share.unshareFailed': '공유 중지에 실패했습니다.',
  'share.copyFailed': '클립보드 복사에 실패했습니다. 링크를 직접 선택해 복사해 주세요.',
  'share.privateTitle': '개인 페이지는 공유할 수 없습니다',
  'share.privateHint': '이 페이지를 웹에 공개하려면 먼저 공유 섹션으로 옮겨 주세요.',
  'share.sharedHintPage': '누구나 이 링크로 페이지를 볼 수 있습니다(읽기 전용).',
  'share.sharedHintFolder': '누구나 이 링크로 폴더를 볼 수 있습니다(읽기 전용).',
  'share.openNewTab': '새 탭에서 열기',
  'share.stop': '공유 중지',
  'share.stopOwnerOnly': '공유 중지는 워크스페이스 소유자와 관리자만 할 수 있습니다.',
  'share.publishHintPage': '이 페이지를 웹에 공개하면 로그인 없이 누구나 읽기 전용으로 볼 수 있습니다.',
  'share.publishHintFolder': '이 폴더를 웹에 공개하면 로그인 없이 누구나 읽기 전용으로 볼 수 있습니다.',
  'share.publishOwnerOnly': '워크스페이스 소유자와 관리자만 공개할 수 있습니다.',
  'share.publishDisabled': '워크스페이스 설정에서 웹 공개가 꺼져 있습니다.',
  'share.publish': '웹에 공개',

  // Template gallery
  'templates.title': '템플릿에서 시작',
  'templates.applyFailed': '템플릿을 적용하지 못했습니다.',
  'templates.deleteFailed': '템플릿을 삭제하지 못했습니다.',
  'templates.delete': '템플릿 삭제',
  'templates.builtin': '기본 템플릿',
  'templates.mine': '내 템플릿',
  'templates.mineEmpty': '페이지 ⋯ 메뉴의 “템플릿으로 저장”으로 만들 수 있어요.',
  'templates.date': '날짜',
  'templates.titlePlaceholder': '제목 (비우면 “{name}” 사용)',

  // Save as template
  'saveTemplate.title': '템플릿으로 저장',
  'saveTemplate.nameRequired': '이름을 입력하세요.',
  'saveTemplate.saved': '\'{name}\' 템플릿으로 저장됨',
  'saveTemplate.saveFailed': '템플릿을 저장하지 못했습니다.',
  'saveTemplate.icon': '아이콘',
  'saveTemplate.namePlaceholder': '템플릿 이름',
  'saveTemplate.description': '설명 (선택)',
  'saveTemplate.descriptionPlaceholder': '언제 쓰는 템플릿인지',

  // Version history
  'history.autosave': '자동 저장',
  'history.labelManual': '수동',
  'history.labelBeforeRestore': '복원 전',
  'history.labelBeforeAiEdit': 'AI 편집 전',
  'history.labelAiEdit': 'AI 편집',
  'history.byVia': '{name} ({client} 경유)',
  'history.snapshotFailed': '스냅샷 저장에 실패했습니다.',
  'history.restoreFailed': '복원에 실패했습니다.',
  'history.title': '버전 히스토리',
  'history.snapshotNow': '지금 스냅샷',
  'history.empty': '저장된 버전이 없습니다.',
  'history.selectHint': '왼쪽에서 버전을 선택하면 내용을 미리 볼 수 있습니다.',
  'history.previewFailed': '미리보기를 불러오지 못했습니다.',
  'history.emptyDoc': '(빈 문서)',
  'history.restoreConfirm': '현재 내용을 이 버전으로 덮어씁니다. 복원 직전 상태도 스냅샷으로 남습니다.',
  'history.restoreThis': '이 버전으로 복원',

  // Emoji picker
  'emoji.smileys': '표정·사람',
  'emoji.objects': '작업·사물',
  'emoji.symbols': '기호',
  'emoji.nature': '자연·동물',
  'emoji.food': '음식',
  'emoji.activity': '활동·장소',
  'emoji.pickIcon': '아이콘 선택',
  'emoji.customPlaceholder': '이모지 직접 입력…',
  'emoji.useCustom': '이 문자를 아이콘으로 사용',

  // Search modal
  'search.quickSwitch': '빠른 전환',
  'search.quickSwitchPlaceholder': '페이지로 빠르게 이동…',
  'search.placeholder': '제목·본문 검색…',
  'search.typeToSearch': '검색어를 입력해 주세요.',
  'search.searching': '검색 중…',

  // Trash
  'trash.title': '휴지통',
  'trash.empty': '휴지통이 비어 있습니다.',
  'trash.deletedAt': '삭제 {when}',
  'trash.purgeConfirm': '영구 삭제하면 복구할 수 없습니다. 계속할까요?',
  'trash.purge': '영구 삭제',

  // Move modal
  'move.title': '페이지 이동',
  'move.failed': '이동에 실패했습니다.',
  'move.shared': '공유',
  'move.private': '개인',
  'move.toRoot': '{section} 루트로',
  'move.hint': '선택한 페이지의 하위로 이동합니다. 다른 섹션으로 옮기면 하위 페이지까지 함께 이동합니다. 자기 자신과 하위 페이지는 선택할 수 없습니다.',

  // Page cover
  'cover.uploadFailed': '커버 업로드에 실패했습니다.',
  'cover.alt': '커버',
  'cover.change': '변경',
  'cover.dropToSet': '놓으면 커버로',
  'cover.add': '커버 추가',

  // Pager
  'pager.label': '페이지',
  'pager.previousPage': '이전 페이지',
  'pager.nextPage': '다음 페이지',

  // Notion publish
  'notion.title': '노션으로 보내기',
  'notion.created_other': '노션에 페이지를 만들었습니다. (블록 {count}개)',
  'notion.warnings_other': '경고 {count}건',
  'notion.intro': '{title} 을(를) 노션의 대상 페이지 아래 새 하위 페이지로 업로드합니다.',
  'notion.parentUrl': '대상 페이지 URL',
  'notion.disabled': '노션 업로드가 비활성 상태입니다. 서버 {env} 에 {token} 을 설정한 뒤 다시 시도하세요.',
  'notion.sending': '보내는 중…',
  'notion.send': '보내기',

  // Comments
  'comments.badgeTitle_other': '코멘트 {count}개',
  'comments.editPlaceholder': '코멘트 수정…',
  'comments.via': '({client} 경유)',
  'comments.delete': '코멘트 삭제',
  'comments.block': '블록',
  'comments.goToBlock': '블록으로 이동',
  'comments.replyPlaceholder': '답글…',
  'comments.reply': '답글',
  'comments.resolved': '해결됨',
  'comments.resolve': '해결',
  'comments.commentOnBlock': '현재 블록에 코멘트',
  'comments.newThread': '새 스레드',
  'comments.placeholder': '코멘트를 입력하세요. @로 멘션',
  'comments.submit': '코멘트',
  'comments.empty': '코멘트가 없습니다.',
  'comments.showResolved_other': '해결됨 {count}개 보기',
  'comments.hideResolved_other': '해결됨 {count}개 접기',

  // Drag and drop
  'dnd.moveSomeFailed': '일부 페이지를 옮기지 못했습니다.',
  'dnd.count': '{count}개',

  // Ink toolbar
  'ink.sizeThin': '가늘게',
  'ink.sizeMedium': '보통',
  'ink.sizeThick': '굵게',
  'ink.pen': '펜',
  'ink.highlighter': '형광펜',
  'ink.eraser': '지우개',
  'ink.color': '색 {color}',
  'ink.undo': '되돌리기',
  'ink.clearTitle': '이 페이지 필기 전체 지우기',
  'ink.clear': '전체',
  'ink.strokes_other': '{count}획',
  'ink.build': '배포 빌드',
  'ink.exitTitle': '필기 모드 끄기 (Esc)',
  'ink.saveFailed': '필기 저장에 실패했습니다. 연결을 확인해 주세요.',
  'ink.layer': '필기 레이어',
} satisfies Partial<Record<keyof typeof en, string>>
