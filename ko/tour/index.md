# 에이전트가 노트를 고치는 과정을 직접 눌러 보기

> 브라우저 안에서만 도는 시연입니다. 실제 서버나 AI에 연결되지 않고, 입력한 내용은 저장되지 않습니다.

Inkling에서 AI 에이전트는 필요한 섹션만 찾아 읽고, 읽은 버전을 확인한 뒤 섹션 하나만 고칩니다. 아래 다섯 장면을 차례로 실행해 보세요. 계정도 서버도 필요 없습니다.

도구 이름, 인자, 응답의 모양은 실제 Inkling MCP 서버와 같습니다. 노트 내용, 버전 값(v=…), 토큰 수는 이 시연이 만든 예시 값이고, 페이지와 제안의 id는 짧게 줄였습니다.

## 시연에 쓰는 노트

가짜 워크스페이스의 페이지 하나입니다. 섹션이 넷이고, 장면마다 에이전트는 체크리스트 섹션을 다룹니다.

```markdown
# 4분기 출시 계획

## 목표

- 11월 20일에 새 요금제를 출시합니다
- 출시 메일은 전날 보냅니다

## 일정

- 11월 13일: 요금 페이지 문구 확정
- 11월 18일: 상태 페이지 점검
- 11월 19일: 출시 메일 발송

## 체크리스트

- [x] 요금 페이지 문구
- [ ] 상태 페이지, 담당 이지원, 마감 2026-11-20
- [ ] 새 요금제용 고객지원 답변 템플릿

## 담당

- 출시 총괄: 박서준
- 상태 페이지: 이지원
```

## 1. 찾기

에이전트가 `find_context`를 한 번 부르면, 서버가 질문에 맞는 섹션만 순위대로 골라 토큰 예산(기본 3,500) 안에 담아 줍니다. 결과에는 페이지 id, §앵커, 버전(v=…)이 붙고, 고치는 도구가 이 값을 그대로 받습니다.

```text
› find_context(query: "출시 체크리스트 상태 페이지")
1 result(s) for "출시 체크리스트 상태 페이지", ~47/3500 tokens
<untrusted_content source="find_context">
[1] 4분기 출시 계획 › 체크리스트
(page 3e8a2ebe; §체크리스트 v=7dd93bb2a47e; can: read,comment,edit; edited by 박서준)
- [x] 요금 페이지 문구
- [ ] 상태 페이지, 담당 이지원, 마감 2026-11-20
- [ ] 새 요금제용 고객지원 답변 템플릿
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

# 페이지 전체를 읽었다면 약 123 토큰, 이번에 받은 것은 약 47 토큰 (시연용 어림값)
```

실제 제품에서는 내 워크스페이스 전체에서 찾습니다. 성능 기록의 측정에서는 질문당 평균 토큰이 2,254에서 624로 줄었습니다. 이 장면의 비교 숫자는 시연 노트로 어림한 값입니다.

- [MCP 안내: 에이전트를 위한 안내](../../docs/MCP.ko.md)
- [성능 기록: 검색과 MCP](../../docs/PERFORMANCE.ko.md)

## 2. 섹션 하나만 고치기

`patch_section`은 섹션 하나만 고칩니다. 에이전트는 읽을 때 받은 버전을 `baseVersion`으로 보내고, 서버는 그 섹션이 그대로일 때만 씁니다. 다른 섹션은 건드리지 않고, 고친 섹션의 버전만 바뀝니다.

```text
› find_context(query: "출시 체크리스트 상태 페이지")
1 result(s) for "출시 체크리스트 상태 페이지", ~47/3500 tokens
<untrusted_content source="find_context">
[1] 4분기 출시 계획 › 체크리스트
(page 3e8a2ebe; §체크리스트 v=7dd93bb2a47e; can: read,comment,edit; edited by 박서준)
- [x] 요금 페이지 문구
- [ ] 상태 페이지, 담당 이지원, 마감 2026-11-20
- [ ] 새 요금제용 고객지원 답변 템플릿
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

› patch_section(pageId: "3e8a2ebe", section: "체크리스트", mode: "append",
    markdown: "- [ ] 변경 사항 공지", baseVersion: "7dd93bb2a47e")
Done (append): §체크리스트 is now v=ab17c538723e.
```

실제 제품에서는 에이전트가 한 번 쓸 때마다 페이지 기록에 'AI 편집' 버전이 하나 남고, 사람이 그 단계만 되돌릴 수 있습니다.

- [MCP 안내: 에이전트가 쓸 때마다 버전 하나](../../docs/MCP.ko.md)
- [사용 설명서: 에이전트 편집 되돌리기](../../docs/GUIDE.ko.md)

## 3. 충돌

에이전트가 섹션을 읽은 뒤에 사람이 그 섹션을 고치면, 옛 버전으로 보낸 수정은 거절되고 아무것도 쓰이지 않습니다. 응답에 지금 내용과 새 버전이 들어 있어서, 에이전트는 자기 수정을 합쳐 다시 보냅니다. 실행을 누른 다음 체크리스트 섹션을 직접 고쳐 보세요.

```text
› find_context(query: "출시 체크리스트 상태 페이지")
1 result(s) for "출시 체크리스트 상태 페이지", ~47/3500 tokens
<untrusted_content source="find_context">
[1] 4분기 출시 계획 › 체크리스트
(page 3e8a2ebe; §체크리스트 v=7dd93bb2a47e; can: read,comment,edit; edited by 박서준)
- [x] 요금 페이지 문구
- [ ] 상태 페이지, 담당 이지원, 마감 2026-11-20
- [ ] 새 요금제용 고객지원 답변 템플릿
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

# (사람) 에이전트가 읽은 뒤에 체크리스트 섹션을 직접 고침: 상태 페이지 항목을 완료로 표시

› patch_section(pageId: "3e8a2ebe", section: "체크리스트", mode: "append",
    markdown: "- [ ] 고객 안내 메일 초안", baseVersion: "7dd93bb2a47e")
Conflict: Section "체크리스트" changed since baseVersion 7dd93bb2a47e; nothing was written. Merge your edit into the current content and retry with baseVersion 3b87e46a9396.

Current §체크리스트 (v=3b87e46a9396):
## 체크리스트

- [x] 요금 페이지 문구
- [x] 상태 페이지, 담당 이지원, 마감 2026-11-20
- [ ] 새 요금제용 고객지원 답변 템플릿

# (에이전트) 응답에 들어 있는 지금 내용에 자기 줄을 합쳐, 새 버전으로 다시 보냄

› patch_section(pageId: "3e8a2ebe", section: "체크리스트", mode: "append",
    markdown: "- [ ] 고객 안내 메일 초안", baseVersion: "3b87e46a9396")
Done (append): §체크리스트 is now v=296c4cb8f2f6.
```

그래서 사람이 치던 글이 에이전트의 수정에 덮이지 않습니다.

- [MCP 안내: 에이전트를 위한 안내](../../docs/MCP.ko.md)

## 4. 제안으로 남기기

페이지를 "에이전트: 제안만"으로 잠그면 에이전트의 수정은 바로 쓰이지 않고 제안으로 남습니다. 사람이 바뀐 줄을 보고 수락하거나 거절합니다. 에이전트가 제안을 수락하는 도구는 없습니다.

```text
# (사람) 이 페이지를 "에이전트: 제안만"으로 잠금

› find_context(query: "출시 체크리스트 상태 페이지")
1 result(s) for "출시 체크리스트 상태 페이지", ~47/3500 tokens
<untrusted_content source="find_context">
[1] 4분기 출시 계획 › 체크리스트
(page 3e8a2ebe; §체크리스트 v=7dd93bb2a47e; can: read,comment,suggest; edited by 박서준)
- [x] 요금 페이지 문구
- [ ] 상태 페이지, 담당 이지원, 마감 2026-11-20
- [ ] 새 요금제용 고객지원 답변 템플릿
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

› patch_section(pageId: "3e8a2ebe", section: "체크리스트", mode: "append",
    markdown: "- [ ] 출시 후 회고 일정 잡기", baseVersion: "7dd93bb2a47e")
Not written: kept as suggestion a41c07e2 for §체크리스트 of page 3e8a2ebe (append), because this page is locked to "agents: suggestions only".
A person with edit access accepts or rejects it in the web app; the result arrives in inbox as approval_result.
list_suggestions(pageId) shows it; withdraw_suggestion(id) takes it back; a new suggestion from this connection for the same section replaces it.

# (사람) 웹 앱에서 바뀐 줄을 보고 수락하거나 거절함. 수락하면 섹션에 반영되고 버전 기록에 AI 편집이 생기며, 거절하면 노트는 그대로임
```

실제 제품에서는 워크스페이스를 "전부 검토"로 두거나 에이전트가 `suggest=true`를 줘도 같은 흐름이 되고, 결과는 에이전트의 받은 함에 approval_result로 갑니다.

- [MCP 안내: 제안, 편집 방식, 섹션 잡아 두기](../../docs/MCP.ko.md)
- [사용 설명서: 에이전트 제안 검토하기](../../docs/GUIDE.ko.md)

## 5. 편집 잠금

페이지를 잠그고 에이전트를 "코멘트만"으로 두면 에이전트의 쓰기는 PAGE_LOCKED로 거절됩니다. 노트 위의 잠금 단추를 누른 다음 실행해 보세요.

```text
# (사람) 이 페이지를 잠그고 에이전트를 "코멘트만"으로 둠

› find_context(query: "출시 체크리스트 상태 페이지")
1 result(s) for "출시 체크리스트 상태 페이지", ~47/3500 tokens
<untrusted_content source="find_context">
[1] 4분기 출시 계획 › 체크리스트
(page 3e8a2ebe; §체크리스트 v=7dd93bb2a47e; can: read,comment; edited by 박서준)
- [x] 요금 페이지 문구
- [ ] 상태 페이지, 담당 이지원, 마감 2026-11-20
- [ ] 새 요금제용 고객지원 답변 템플릿
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

› patch_section(pageId: "3e8a2ebe", section: "체크리스트", mode: "append",
    markdown: "- [ ] 요금제 비교표 갱신", baseVersion: "7dd93bb2a47e")
"4분기 출시 계획" is locked for agents (comment only). A person must make this edit in the web app; you can add a comment with the suggested change. (PAGE_LOCKED): nothing was written; do not retry or work around the lock (moving or copying the page will not help). Tell the user who can edit it, or leave your suggested change with add_comment if that is allowed (see the can: line of read_page)
```

잠금은 사람만 바꿀 수 있습니다. 에이전트에게는 잠금을 바꾸는 도구가 없고, 거절 응답은 우회하지 말고 사람에게 알리라고 말해 줍니다.

- [MCP 안내: 지침, 잠금, 신뢰할 수 없는 내용](../../docs/MCP.ko.md)
- [사용 설명서: 편집 잠금](../../docs/GUIDE.ko.md)

## 다음 단계

- [직접 설치하기](../../docs/DEPLOY.ko.md): 내 서버에 Inkling을 올리는 순서입니다. 내 컴퓨터에서 써 보는 방법도 있습니다.
- [내 Claude에 연결하기](../../docs/MCP.ko.md): Claude Code, claude.ai와 다른 MCP 클라이언트를 Inkling에 연결하는 방법입니다.
