# Inkling 로드맵

> 목표: Notion(팀 협업, 데이터베이스 보기)과 Obsidian(가벼움, Markdown, 내 데이터는 내 손에)을 합친 셀프호스트 노트 앱입니다.
> 서버는 Docker에서 돌고, 웹/PWA로 씁니다. 블록 수나 멤버 수 제한은 없습니다. English: [ROADMAP.md](ROADMAP.md).

<a id="m1--core-skeleton--done-2026-07-12"></a>
## M1 — 핵심 뼈대 ✅ 완료 (2026-07-12)

- [x] pnpm 모노레포(server / web / shared)
- [x] 가입과 로그인(세션 쿠키): API로 확인
- [x] 워크스페이스 + 초대 코드(예: 개인 워크스페이스와 팀 워크스페이스를 따로 둠): API로 확인
- [x] 페이지 트리(만들기/이름 바꾸기/삭제/계층): API로 확인(순환 방지 포함)
- [x] BlockNote 블록 편집기: 슬래시 메뉴, 표, 코드 블록(shiki 강조), 체크리스트, 서식
- [x] **Yjs + Hocuspocus 실시간 공동 편집**: 헤드리스 E2E 통과(두 클라이언트 양방향 동기화, awareness, 인증 안 된 클라이언트 거부를 dev와 production 모두에서 확인)
- [x] 이미지/파일 업로드: 업로드→다운로드 바이트 일치와 인증 가드 확인
- [x] 다크 모드, Pretendard, PWA: manifest/아이콘/SW 빌드와 제공 확인(홈 화면에 설치하는 것은 아직 실기기 확인이 필요합니다)
- [x] Docker Compose(db + app, 네이티브 ARM64): production 이미지 빌드와 기동 확인

> 남은 화면 확인: 브라우저 UI(편집기와 사이드바의 모양과 느낌)를 눈으로 보는 일. 코드는 타입 검사, 빌드, 계약 테스트를 통과합니다.

<a id="m2--markdown--the-obsidian-feel--done-2026-07-12"></a>
## M2 — Markdown과 Obsidian 느낌 ✅ 완료 (2026-07-12)

- [x] 페이지 → Markdown 내보내기 / Markdown과 zip 가져오기(Obsidian과 맞는 zip 규칙)
- [x] 워크스페이스 전체 → zip(Markdown + 이미지) 내보내기
- [x] `[[wiki link]]` 자동 완성(내부 href 규칙을 쓰고, Markdown으로 오갈 때 `[[]]`로 바뀝니다)
- [x] **오른쪽 패널**: 개요(목차), 백링크, 나가는 링크, 태그, 속성. 섹션 접기 + 패널 켜고 끄기
- [x] **탐색기 편의 기능**: 사이드바 접기/펼치기(⌘\), 폴더 만들기(kind=folder), 지금 페이지를 트리에서 자동으로 보여 주기, 모두 접기
- [x] 드래그로 페이지 순서 바꾸기/옮기기(dnd-kit + 이동 모달), 휴지통(복원/영구 삭제)
- [x] 제목 검색 + ⌘K 모달(→ 나중에 본문 전체 검색으로)

<a id="m3--notion-database-views--done-2026-07-12"></a>
## M3 — Notion 데이터베이스 보기 ✅ 완료 (2026-07-12)

- [x] 컬렉션(속성 스키마: 텍스트/선택/날짜/체크박스/사람)
- [x] 표 보기(정렬, 필터, 칸 안에서 바로 편집)
- [x] 칸반 보기(드래그로 옮기기)
- [x] 행 = 페이지(문서로 열림)

<a id="m35--canvas-obsidian-json-canvas-compatible--done-2026-07-12"></a>
## M3.5 — 캔버스(Obsidian JSON Canvas 호환) ✅ 완료 (2026-07-12)

- [x] kind='canvas' 페이지: React Flow 무한 캔버스(텍스트 카드, 페이지 링크 카드, 연결선)
- [x] Yjs 실시간 협업(기존 Hocuspocus를 그대로 씀)
- [x] `.canvas`(JSON Canvas 1.0) 내보내기/가져오기: Obsidian에서 그대로 열립니다
- [x] 다크 모드, 미니맵/확대·축소 컨트롤

<a id="m4--fully-automated-integrations--cli--done-2026-07-12"></a>
## M4 — 완전 자동 연동(+ CLI) ✅ 완료 (2026-07-12)

- [x] Obsidian: 버튼 하나나 CLI 명령 하나로 Markdown + 이미지를 볼트 폴더에 넣습니다(`inklingctl pull`)
- [x] Notion: Notion API로 페이지를 한 번에 올립니다(블록 매핑, 이미지 포함). 실제 계정 업로드는 NOTION_TOKEN을 넣으면 동작합니다(dryRun으로 확인)
- [x] 왕복 파이프라인: 공모전이 끝나면 Notion으로, 개인 노트는 Obsidian으로

<a id="m5--operations-deploy-pack--ready-in-deploy"></a>
## M5 — 운영 (배포 묶음 ✅ deploy/에 준비됨)

- [x] ARM64 VM에 배포: 같은 이미지를 그대로 씀(멀티 아키텍처)
- [x] Caddy HTTPS + 도메인 오버레이(`deploy/compose.caddy.yaml`)
- [x] 백업: 검증하는 백업 사이드카. GFS 보존, 암호화, 외부 사본([BACKUP.ko.md](BACKUP.ko.md))
- [ ] 초대 링크(코드 대신 URL), 멤버 관리 UI

<a id="m6--sharedprivate-sections--ux-pass--done-2026-07-12"></a>
## M6 — 공유/개인 섹션 + UX 다듬기 ✅ 완료 (2026-07-12)

- [x] 사이드바 공유(👥) / 개인(🔒) 섹션: 개인 페이지는 작성자 말고는 아무에게도 보이지 않습니다(목록, 검색, 백링크, 내보내기, 협업 연결 어디서나 걸러 냄)
- [x] 섹션 사이 이동 규칙(하위 페이지는 따라가고, 남의 하위 페이지를 개인으로 바꾸는 것은 막음): 드래그, 이동 모달, 오른쪽 패널 스위치
- [x] 사이드바에서 끌어 → 본문에 놓으면 위키 링크 넣기, 캔버스에 놓으면 페이지 카드
- [x] UI 움직임 다듬기: 페이지 전환, 사이드바, 오른쪽 패널, 모달, 아코디언. prefers-reduced-motion을 따릅니다

<a id="m7--better-search-and-linking--done-2026-07-12"></a>
## M7 — 더 나은 검색과 링크 ✅ 완료 (2026-07-12)

- [x] 본문 전체 검색(page_texts + pg_trgm, ⌘K 발췌와 강조, 태그 클릭 연결)
- [x] 그래프 보기(/graph, d3-force + React Flow, page_links, 개인 페이지 보이기 필터)

<a id="security-load-and-socket-hardening--done-2026-07-12"></a>
## 보안, 부하, 소켓 강화 ✅ 완료 (2026-07-12)

세 갈래로 나눠 공격자 관점에서 점검한 결과 중 CONFIRMED 항목을 고쳤습니다.
- [x] 보안: 인라인 SVG XSS 차단(nosniff/CSP/attachment), 파일 다운로드에 페이지 보이기 규칙 적용(M6에서 빠진 부분) + purge 정리, 로그인/가입 속도 제한, 캔버스 링크 스킴 검증
- [x] 소켓: WS 업그레이드 때 인증 + maxPayload 2MB + IP당 연결 수 제한(+ 너무 큰 프레임에 서버가 죽지 않게 보호), Fastify 타임아웃, trustProxy 조정
- [x] 부하: 스트리밍 내보내기(OOM 방지) + 전체 크기 가드, 자주 쓰는 열에 인덱스 8개, 작은 호스트에 맞춘 가져오기 한도, compose mem_limit, DB 포트를 loopback에 묶음

<a id="m8--invite-links--member-management--version-history--done-2026-07-12"></a>
## M8 — 초대 링크 · 멤버 관리 · 버전 기록 ✅ 완료 (2026-07-12)

- [x] 초대 링크(/join/:code, 로그인 `next`를 따름) + 코드 다시 만들기, 사이드바 "초대 링크 복사"
- [x] 멤버 관리 모달(역할 바꾸기, 멤버 제외, 나가기, 마지막 소유자 보호), 떠난 멤버의 개인 페이지 정리(감사 항목 L3)
- [x] 버전 기록: Yjs 스냅샷(10분마다 자동 + 수동). 복원은 DirectConnection으로 열린 화면에 바로 퍼집니다(실제 편집기로 확인). 오른쪽 패널에 기록 섹션
- [x] 버그 수정: 본문 없는 POST(로그아웃, 다시 만들기, 복원)를 Content-Type json과 빈 본문으로 보내면 500이 나던 숨은 버그 → 빈 JSON 파서

<a id="m10--keyboard--convenience-pass--done-2026-07-12"></a>
## M10 — 키보드와 편의 기능 다듬기 ✅ 완료 (2026-07-12)

- [x] 트리에서 키보드로 선택/이동(↑↓←→ Enter F2). 선택과 열린 페이지를 분리
- [x] ⌘⌫(Mac) / Del(Windows)로 삭제 → 휴지통 + 되돌리기 토스트(사용자가 알려 준 버그 수정)
- [x] 행 오른쪽 클릭 메뉴(⋯ 동작과 같음), 단축키 도움말(?), 위쪽 경로 표시(breadcrumb)
- [x] 플랫폼 처리: Mac은 ⌘/⌫, Windows는 Ctrl/Del을 자동으로(키 처리는 metaKey‖ctrlKey, 표시는 shortcut() 도우미)

<a id="m9--calendar-view--daily-notes--templates-duplication--done-2026-07-12"></a>
## M9 — 캘린더 보기 · 데일리 노트 · 템플릿(복제) ✅ 완료 (2026-07-12)

- [x] 컬렉션 캘린더 보기: 월 격자, 날짜 속성으로 배치, 칩을 드래그해 날짜 바꾸기(dnd-kit)
- [x] 데일리 노트: 📅 오늘 버튼(내 개인 daily 폴더에 YYYY-MM-DD 페이지를 자동으로 만듭니다)
- [x] 페이지 복제: 하위 페이지 + 문서 상태 + props + 컬렉션(속성/보기)을 재귀로 복제. ⋯/오른쪽 클릭 메뉴의 "복제"

<a id="m11--cheap-quality-of-life-wins--done-2026-07-13"></a>
## M11 — 품이 적게 드는 편의 기능 ✅ 완료 (2026-07-13)

- [x] 즐겨찾기/북마크: 켜고 끄기, 사이드바 ⭐ 섹션, 위쪽 막대와 ⋯ 메뉴의 별(bookmarks 테이블)
- [x] 이모지 아이콘 선택기(골라 둔 250개, 의존성 없음), 커버 이미지(업로드→coverUrl)
- [x] 명령 팔레트 ⌘P/Ctrl+P: 동작 + 페이지 바로 가기
- [x] 전체 태그 색인: 저장 훅이 page_tags를 채움, /tags 페이지, 대소문자 구분 없이 합침

<a id="m12--obsidian-identity--done-2026-07-13"></a>
## M12 — Obsidian다움 ✅ 완료 (2026-07-13)

- [x] 페이지 임베드 ![[transclusion]]: 사용자 정의 블록 + 읽기 전용 두 번째 provider. 서버 내보내기 왕복에서도 안전합니다(모르는 블록은 조용히 빠지고 서버가 죽지 않음을 시연)
- [x] 별칭: [[alias]] 해석과 검색 매칭, 오른쪽 패널에서 칩으로 편집
- [x] 연결 안 된 멘션: page_texts ILIKE 제목/별칭 MINUS page_links, 오른쪽 패널 섹션
- [x] 로컬 그래프: useGraph를 다시 씀, 지금 페이지의 N-hop 이웃, 오른쪽 패널에 넣음

<a id="m13--notion-style-collaboration--done-2026-07-13"></a>
## M13 — Notion식 협업 ✅ 완료 (2026-07-13)

- [x] 인라인 댓글: 블록에 붙는 스레드/답글/해결, 오른쪽 패널 섹션 + 💬 배지, REST 폴링(15s)
- [x] @멘션: 사용자 정의 인라인(사용자 칩/페이지 링크), @ 자동 완성(멤버 + 페이지), 서버 왕복에서도 안전(빠짐)
- [x] 알림: comments/notifications 테이블, 🔔 종 + 안 읽은 개수, comment/comment_mention 생성과 읽음 상태

<a id="m14--formatting-blocks--done-2026-07-13"></a>
## M14 — 서식 블록 ✅ 완료 (2026-07-13)

- [x] 토글 목록과 인용: BlockNote 기본 블록(toggleListItem/quote)을 슬래시 메뉴에 노출, 그대로 왕복
- [x] 콜아웃: 사용자 정의 블록 종류 5개(note/tip/warning/danger/info), 종류 바꾸기, 서버가 죽지 않음(빠짐)
- [x] 템플릿 변수: POST /pages/:id/instantiate({{date}}/{{time}}/{{title}} 치환), isTemplate 켜고 끄기, 갤러리 모달, 변수가 없으면 손실 없이 복제. 이후 구조 템플릿과 템플릿 갤러리로 바뀌었습니다(ADR 0920–0925)

<a id="m15--public-web-sharing--done-2026-07-13"></a>
## M15 — 공개 웹 공유 ✅ 완료 (2026-07-13)

- [x] 읽기 전용 공개 링크 /s/<token>: pages.shareToken, 소유자가 공개/중지, 로그인 안 한 사람도 봄(사이드바 없는 단독 페이지)
- [x] 보안: 토큰으로만 접근, 개인 페이지는 공유 불가, 내부 id와 링크가 새지 않음(위키 링크는 텍스트로 바꿈), 엄격한 CSP, 참조된 파일만 공개
- [x] 폴더 공유(2026-09-23): 폴더 링크 하나로 그 아래 살아 있는 하위 트리를 공개(개인 페이지와 휴지통 페이지 제외), HMAC ref(내부 id가 새지 않음), 하위 트리 안을 가리키는 위키 링크만 공개 링크가 됨, 보기 화면에서 왼쪽 트리 / 휴대폰에서는 위쪽 서랍

<a id="m16--true-real-time-collaboration--done-2026-07-13"></a>
## M16 — 진짜 실시간 협업 ✅ 완료 (2026-07-13)

- [x] 댓글이 바로 보임: Hocuspocus stateless broadcast(페이지 문서 채널 {t:comments}), 폴링→즉시
- [x] 알림이 바로 보임: 사용자마다 inbox:<userId> 채널({t:notifications}), 남의 inbox 구독은 막음
- [x] inbox 문서는 page_docs, 스냅샷, 색인에서 뺌(UUID 길목 가드)

<a id="m17--productivity-due-date-reminders--done-2026-07-13"></a>
## M17 — 생산성: 마감 리마인더 ✅ 완료 (2026-07-13)

- [x] 마감 리마인더: 날짜 속성이 오늘인 컬렉션 행 → 작성자와 담당자에게 알림(하루 한 번으로 중복 제거), M16 실시간 푸시
- [x] 마감 임박 대시보드 /w/:ws/due(오늘/이번 주), 종에 ⏰ 리마인더, 명령 팔레트와 사이드바에서 들어가는 길
- [x] 버그 수정: 컨테이너가 UTC일 때 서버의 "오늘"이 사용자 현지 날짜와 달라 리마인더가 잘못 울렸습니다 → 서버가 `TZ`를 씁니다(설정 가능)

<a id="m18--workspace-wide-calendar--done-2026-07-13"></a>
## M18 — 워크스페이스 전체 캘린더 ✅ 완료 (2026-07-13)

- [x] 전체 캘린더 /w/:ws/calendar: 모든 컬렉션 행(날짜 속성) + 데일리 노트를 월 격자 하나에 모읍니다
- [x] 일정 칩(종류별 색), 누르면 이동, 빈 날짜를 누르면 그날 데일리 노트를 만들거나 엽니다(공용 useDailyNote 훅)
- [x] 사이드바 📆 캘린더(데일리 오늘 버튼과 따로), 데일리가 아닌 제목은 뺌, visibleTo, 월 범위
- [x] 마무리(2026-09-23): 문서 안의 날짜 붙은 체크리스트(page_tasks 색인 + 백필), 주 보기, 종류 필터, 빈 날짜 팝오버(할 일/새 페이지/데일리), 칩을 드래그해 일정 바꾸기(행/페이지/할 일), 마감 섹션 새로 디자인(지남/오늘/내일/이번 주/30일/완료, 체크 + 되돌리기, 빠른 추가, 사이드바 배지), 할 일 리마인더

<a id="m19--obsidian-settings-port--pwa-conveniences-2026-09-23"></a>
## M19 — Obsidian 설정 옮겨 오기 + PWA 편의 기능 (2026-09-23)

- [x] 설정 화면 /w/:ws/settings(⌘, · 사이드바 ⚙ · 팔레트): 기기마다 localStorage(lib/prefs, usePrefs로 바로 적용)
- [x] 편집기: 줄 너비(기기마다, 본문 600–1200 px 또는 전체, 기본 700 px. 페이지별 전체 너비가 우선), 맞춤법 검사(spellcheck), 단어 수 상태 표시줄(1초 debounce)
- [x] 파일과 링크: 시작 페이지(마지막/홈, 첫 방문 때만), 새 페이지 위치(최상위/하위/같은 폴더 → ⌘N과 사이드바), 링크 미리보기(마우스 올리고 500ms, Markdown 내보내기 캐시)
- [x] 휴지통: 삭제 전 확인(기본은 꺼짐). 트리 메뉴, ⌘⌫, 여러 개 삭제가 공용 ConfirmDialog를 씀
- [x] 모양: 확대 80–130%(루트 font-size. CSS zoom은 팝오버/드래그 좌표를 어긋나게 해서 쓰지 않음), 테마
- [x] 단축키: ⌘⌥←/→ 뒤로/앞으로, ⌘O 빠른 전환(제목), ⌘⇧F 전체 검색, ⌘N/⌘⌥N 새 페이지, ⌘G 그래프, F2 제목, ⌘; 속성, ⌘L 체크박스, ⌘D 블록 삭제
- [x] 팔레트: 어제/오늘/내일 데일리 노트, 무작위 페이지, 오른쪽 패널, 휴지통, 뒤로/앞으로, 다시 불러오기
- [x] PWA: standalone 모드에서 위쪽 막대에 ← → 버튼(history idx에 따라 비활성), 외부 링크는 새 창, safe-area, 오버스크롤과 두 번 탭 확대 막기, manifest id/scope

<a id="later"></a>
## 나중에

- [ ] **Rust 백엔드로 조금씩 옮기기(협업 서버를 yrs로 먼저).** 이유: 협업 서버의
  저장 경로(Yjs ⇄ 문서 변환, 색인 추출, bytea 전송)가 편집 한 번마다 서버 메모리와 CPU를 가장 많이
  쓰는 일입니다. `yrs`는 Yjs와 호환되는 Rust 구현이라 클라이언트를 건드리지 않고 이 부분만 옮길 수 있습니다.
  조금씩이라는 것은 기존 Postgres 스키마와 WebSocket 프로토콜은 그대로 두고,
  서비스를 하나씩 옮기며 단계마다 측정값을 보고 정한다는 뜻입니다. 메모: [ADR 0759](adr/0759-hardware-cache-hot-loops-measured-and-rust-notes.md).
