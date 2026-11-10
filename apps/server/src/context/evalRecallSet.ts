import type { EvalPage, EvalQuestion } from './evalSet'

/**
 * Recall set of 0.20 (docs/adr/2400-*): Korean and mixed-language questions written the way a person
 * remembers a page, against fictional notes in three workspaces. Each page is written for this test;
 * no real note is copied. The failure families (tags) are the ones a field query showed: the query
 * writes a longer compound than the note's title ("택배함" for a page titled "택배 한 상자"), and the
 * remaining query words are common across the person's workspaces, so long sections full of them
 * outrank the short page whose title is the answer.
 *
 *   H = a hackathon team's workspace (ideas, judging, presentation)
 *   P = a product team's wiki (release plan, meetings, deploy, on-call)
 *   L = a research archive of long notes that repeat the common words (해커톤, 분석, 서비스, 아이디어,
 *       데이터, 회의, 일정, 팀) in varied sentences: the "other workspace" of the field report
 *
 * Questions name pages as `<label>:<title>` (evalPageKey). The harness (scripts/context-bench.ts,
 * recallEval.db.test.ts) creates one workspace per label and asks every question without a
 * workspace, over all of them.
 */

/** A long section of `n` sentences taken in turn from `lines` (deterministic; varied order per seed). */
function longSection(lines: string[], n: number, seed: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(lines[(seed * 5 + i * 3) % lines.length])
  return out.join(' ')
}

const ARCHIVE_LINES = [
  '해커톤 출품작을 분석해 보면 서비스 아이디어의 절반이 생활 데이터를 다룬다.',
  '심사위원은 데이터 분석보다 서비스가 실제로 쓰일 장면을 먼저 물었다.',
  '아이디어 회의에서 팀마다 문제 정의에 쓴 시간이 달랐다.',
  '공공 데이터를 쓰는 서비스는 데이터 갱신 주기를 발표에서 꼭 설명했다.',
  '해커톤 일정이 짧을수록 분석 범위를 좁힌 팀이 완성도가 높았다.',
  '우승한 서비스들은 사용자 인터뷰 결과를 분석 장표 한 장으로 보여 줬다.',
  '팀 회의는 하루 두 번, 아침과 저녁에 짧게 하는 경우가 많았다.',
  '데이터 수집이 늦어지면 서비스 시연이 멈추는 일이 잦았다.',
  '아이디어 단계에서 택배, 배달, 주차 같은 생활 물류를 고른 팀도 꽤 있었다.',
  '분석 결과를 숫자 하나로 요약한 발표가 기억에 남았다.',
  '해커톤 심사 기준은 문제 정의, 완성도, 확장성, 발표 순서였다.',
  '서비스 이름을 일찍 정한 팀은 회의 시간이 줄었다.',
  '데이터 분석 도구는 대부분 노트북 환경이었고 대시보드는 드물었다.',
  '일정 관리는 칸반 보드 하나로 충분하다는 의견이 많았다.',
  '아이디어를 고를 때 팀원 모두가 써 볼 서비스인지 먼저 따졌다.',
  '해커톤 마지막 날에는 분석보다 시연 준비에 시간을 더 썼다.',
]

const METHOD_LINES = [
  '서비스 기획은 문제, 사용자, 데이터, 분석 순서로 정리한다.',
  '아이디어 회의는 30분을 넘기지 않고 결정 사항을 바로 적는다.',
  '팀 일정은 주 단위로 쪼개고 매주 회의에서 다시 맞춘다.',
  '분석 서비스라면 어떤 데이터를 어디서 받는지 첫 장에 쓴다.',
  '해커톤용 기획서는 한 쪽짜리 요약과 시연 흐름만 있으면 된다.',
  '회의 기록은 결정, 이유, 다음 할 일 세 칸으로 남긴다.',
  '서비스 지표는 하나만 고르고, 분석은 그 지표를 움직이는 데 집중한다.',
  '일정이 밀리면 기능을 빼고 발표 날짜는 지킨다.',
  '데이터가 없는 아이디어는 설문으로 대신 검증한다.',
  '팀 역할은 기획, 개발, 디자인, 발표로 나누고 회의 때 바꾸지 않는다.',
]

export const RECALL_PAGES: EvalPage[] = [
  // ---- H: hackathon team ------------------------------------------------------------------------
  {
    workspace: 'H',
    title: '02-1 아이디어1, 택배 한 상자',
    markdown: `# 택배 한 상자

## 한 줄 요약
공동현관 택배함에 쌓이는 상자를 사진으로 세고, 오래 방치된 상자를 관리실에 알려 주는 서비스.

## 문제
아파트 택배함은 주말마다 넘친다. 주인이 며칠째 찾아가지 않은 상자가 자리를 차지하고, 관리실은 일일이 확인할 수 없다.

## 작동 방식
현관 카메라 사진에서 상자 수와 크기를 세고, 같은 상자가 사흘 넘게 있으면 동·호수 메모를 읽어 알림을 보낸다.

## MVP 범위
사진 업로드, 상자 세기, 관리실 알림 세 가지만 만든다. 동·호수 인식은 발표 뒤로 미룬다.`,
  },
  {
    workspace: 'H',
    title: '02-2 아이디어2, 동네 텃밭',
    markdown: `# 동네 텃밭

## 한 줄 요약
구청 텃밭 분양 정보와 빈 자리를 지도에 모아 보여 주는 서비스. 지도 이름은 텃밭지도로 정했다.

## 수익 모델
씨앗과 모종 판매처를 연결하고 수수료를 받는다. 구청 위탁 운영도 검토한다.

## 데이터
구청 분양 공고는 PDF라서 직접 옮겨 적는다.`,
  },
  {
    workspace: 'H',
    title: '택배 도난 대응',
    markdown: `상자가 사라지면 먼저 현관 카메라 녹화 시간을 확인하고, 관리실에 열람을 요청한다. 같은 동에서 두 번 넘게 생기면 택배함 위치를 엘리베이터 앞으로 옮기자고 건의한다.`,
  },
  {
    workspace: 'H',
    title: '01 아이디어 회의',
    markdown: `# 아이디어 회의

## 후보
택배 한 상자, 동네 텃밭, 독서 모임 매칭 세 가지가 남았다.

## 결정
택배 한 상자를 본선 아이디어로 정했다. 텃밭은 예비로 둔다.`,
  },
  {
    workspace: 'H',
    title: '03 심사 기준',
    markdown: `# 심사 기준

## 배점
문제 정의 30, 완성도 30, 확장성 20, 발표 20점이다.

## 감점
시연 영상만 틀면 완성도에서 10점을 깎는다.`,
  },
  {
    workspace: 'H',
    title: '04 발표 준비',
    markdown: `# 발표 준비

## 발표자료
발표자료는 열 장 안으로 만들고, 셋째 장에 문제를 숫자 하나로 보여 준다.

## 리허설
본선 전날 저녁 9시에 두 번 리허설한다.`,
  },
  {
    workspace: 'H',
    title: '05 사용자 설문 결과',
    markdown: `# 사용자 설문 결과

## 응답 요약
주민 41명이 답했고 그중 29명이 지난달 택배함이 꽉 차서 상자를 문 앞에 두고 갔다고 답했다.

## 원하는 기능
가장 많이 고른 기능은 오래 방치된 상자 알림이었다.`,
  },
  // ---- P: product team wiki ---------------------------------------------------------------------
  {
    workspace: 'P',
    title: '출시 계획 2026 봄',
    markdown: `# 출시 계획

## 일정
베타는 4월 7일, 정식 출시는 5월 12일로 잡았다. 앱 심사 기간을 열흘로 본다.

## 마일스톤
3월 말 기능 동결, 4월 첫 주 베타 배포, 5월 둘째 주 정식 출시.

## 담당
출시 공지는 민서가 쓰고, 스토어 등록은 도윤이 맡는다.`,
  },
  {
    workspace: 'P',
    title: '주간 회의 10월 2주',
    markdown: `# 주간 회의

## 결정
결제 화면 개편은 다음 스프린트로 미룬다. 알림 문구는 디자인팀 안으로 간다.

## 액션 아이템
하린: 결제 오류 로그 정리. 지후: 알림 문구 반영. 금요일까지.`,
  },
  {
    workspace: 'P',
    title: '배포 절차',
    markdown: `# 배포 절차

## 순서
main에 머지하면 스테이징에 자동 배포되고, 스모크 테스트가 통과하면 운영 배포 버튼을 누른다.

## 되돌리기
운영 배포 뒤 오류율이 2%를 넘으면 직전 태그로 되돌린다.`,
  },
  {
    workspace: 'P',
    title: '장애 대응 연락망',
    markdown: `# 장애 대응 연락망

## 순서
당번이 먼저 받고, 15분 안에 해결이 안 되면 백엔드 리드, 그다음 CTO에게 전화한다.

## 연락처
전화번호는 사내 주소록의 장애 대응 그룹에 있다.`,
  },
  {
    workspace: 'P',
    title: 'API 사용 한도',
    markdown: `# API 사용 한도

## Rate limit
키 하나당 분당 600 요청. 넘으면 429와 Retry-After 헤더를 돌려준다.

## 한도 올리기
파트너 계약이 있으면 분당 3,000까지 올려 준다.`,
  },
  {
    workspace: 'P',
    title: 'CI 파이프라인',
    markdown: `# CI 파이프라인

## 단계
lint, typecheck, unit test, build 순서로 돈다.

## 실패했을 때
빨간 단계의 로그를 먼저 보고, flaky 테스트면 재실행 버튼을 한 번만 누른다. 두 번 실패하면 담당자에게 알린다.`,
  },
  {
    workspace: 'P',
    title: '코드 리뷰 규칙',
    markdown: `# 코드 리뷰 규칙

## 기한
PR은 올린 지 이틀 안에 첫 리뷰를 단다.

## 승인
승인 두 개가 있어야 머지한다. 인증 코드는 보안 담당 승인이 따로 필요하다.`,
  },
  {
    workspace: 'P',
    title: '온보딩 안내',
    markdown: `# 온보딩 안내

## 첫 주
노트북 받기, 계정 만들기, 배포 절차 문서 읽기, 짝 개발 한 번.

## 둘째 주
작은 버그 하나를 고쳐서 직접 배포해 본다.`,
  },
  {
    workspace: 'P',
    title: '와이파이',
    markdown: `손님용은 lumen-guest, 비밀번호는 접수처 옆 액자에 있다.`,
  },
  {
    workspace: 'P',
    title: '회의실 예약',
    markdown: `캘린더에서 회의실 이름으로 초대를 보내면 예약된다. 두 시간 넘게는 못 잡는다.`,
  },
  {
    workspace: 'P',
    title: '알림 피로 줄이기',
    markdown: `# 알림 정리안

## 묶어 보내기
같은 종류의 알림은 한 시간에 한 번 묶어서 보낸다.

## 끄기 쉽게
알림마다 끄기 버튼을 바로 붙인다.`,
  },
  {
    workspace: 'P',
    title: '야간 당번표',
    markdown: `# 11월

## 순서
첫째 주 서준, 둘째 주 하은, 셋째 주 지민, 넷째 주 예린. 바꾸려면 하루 전까지 말한다.`,
  },
  {
    workspace: 'P',
    title: 'OKR 2분기',
    markdown: `# 2분기 목표

## 목표 1
결제 성공률 99.5% 이상.

## 목표 2
신규 가입 뒤 7일 잔존율 40%.`,
  },
  // ---- L: research archive (long sections of common words) -------------------------------------
  {
    workspace: 'L',
    title: '해커톤 인사이트 — 출품작 300개 분석',
    markdown: `# 해커톤 인사이트 — 출품작 300개 분석

## 서비스 아이디어 분석
${longSection(ARCHIVE_LINES, 22, 1)}

## 데이터 분석 서비스 사례
${longSection(ARCHIVE_LINES, 22, 2)}

## 해커톤 심사 기준 정리
${longSection(ARCHIVE_LINES, 18, 3)}

## 팀 회의와 일정
${longSection(ARCHIVE_LINES, 18, 4)}`,
  },
  {
    workspace: 'L',
    title: '공공데이터 서비스 사례 분석',
    markdown: `# 공공데이터 서비스 사례 분석

## 생활 물류 서비스
${longSection(ARCHIVE_LINES, 20, 5)} 택배 분실을 줄이는 서비스와 주차 공유 서비스가 대표적이다.

## 동네 서비스 아이디어
${longSection(ARCHIVE_LINES, 20, 6)} 공공 텃밭과 마을 도서관 데이터를 묶은 아이디어도 있었다.

## 분석 방법
${longSection(ARCHIVE_LINES, 16, 7)}`,
  },
  {
    workspace: 'L',
    title: '서비스 기획 방법론 정리',
    markdown: `# 서비스 기획 방법론

## 기획 순서
${longSection(METHOD_LINES, 18, 1)}

## 회의 운영
${longSection(METHOD_LINES, 18, 2)} 회의실은 미리 잡고, 결정은 회의록 한 줄로 남긴다.

## 일정과 출시
${longSection(METHOD_LINES, 18, 3)} 출시 일정은 배포 절차와 함께 공유한다.`,
  },
  {
    workspace: 'L',
    title: '온보딩과 팀 문화 메모',
    markdown: `# 온보딩과 팀 문화

## 첫 주에 하는 일
${longSection(METHOD_LINES, 16, 4)} 첫 주에는 와이파이와 계정 같은 기본 설정부터 안내한다.

## 장애와 당번
${longSection(ARCHIVE_LINES, 16, 8)} 장애가 나면 야간 당번이 먼저 연락을 받는다.

## 알림과 집중
${longSection(METHOD_LINES, 16, 5)} 알림이 많으면 집중 시간이 줄어든다.`,
  },
]

/**
 * Questions on RECALL_PAGES (docs/adr/2400-*), four per family, two dev and two test. Phrased as a
 * person recalls the page: part of a title, a longer or shorter form of its words, a particle, a
 * different spacing, an English abbreviation, or a long sentence of common words around one key word.
 */
export const RECALL_QUESTIONS: EvalQuestion[] = [
  // the query writes a longer compound than the note (택배함 ↔ 택배, 회의록 ↔ 회의, 설문지 ↔ 설문). The
  // two 회의록 questions name a detail of the P page: the padded wiki of the large run has weekly
  // meeting notes titled 주간회의록 with the same sections, which a bare "회의록 결정" rightly finds.
  { q: '해커톤 택배함 분석 서비스', page: 'H:02-1 아이디어1, 택배 한 상자', anchor: '택배-한-상자/한-줄-요약', split: 'dev', tag: 'r-compound-part' },
  { q: '회의록 알림 문구 결정', page: 'P:주간 회의 10월 2주', anchor: '주간-회의/결정', split: 'dev', tag: 'r-compound-part' },
  { q: '설문지 응답 요약', page: 'H:05 사용자 설문 결과', anchor: '사용자-설문-결과/응답-요약', split: 'test', tag: 'r-compound-part' },
  { q: '온보딩 안내서 첫 주', page: 'P:온보딩 안내', anchor: '온보딩-안내/첫-주', split: 'test', tag: 'r-compound-part' },
  // particles and endings on the query words
  { q: '출시 일정을 언제로 잡았나', page: 'P:출시 계획 2026 봄', anchor: '출시-계획/일정', split: 'dev', tag: 'r-particle' },
  { q: '지난번 배포했던 순서', page: 'P:배포 절차', anchor: '배포-절차/순서', split: 'dev', tag: 'r-particle' },
  { q: '택배를 도난당했을 때', page: 'H:택배 도난 대응', anchor: '_intro', split: 'test', tag: 'r-particle' },
  { q: '장애가 나면 연락하는 순서', page: 'P:장애 대응 연락망', anchor: '장애-대응-연락망/순서', split: 'test', tag: 'r-particle' },
  // spacing differs between the query and the note
  { q: '출시계획 마일스톤', page: 'P:출시 계획 2026 봄', anchor: '출시-계획/마일스톤', split: 'dev', tag: 'r-spacing' },
  { q: '텃밭 지도 서비스', page: 'H:02-2 아이디어2, 동네 텃밭', anchor: '동네-텃밭/한-줄-요약', split: 'dev', tag: 'r-spacing' },
  { q: '코드리뷰 기한', page: 'P:코드 리뷰 규칙', anchor: '코드-리뷰-규칙/기한', split: 'test', tag: 'r-spacing' },
  { q: '발표 자료 몇 장', page: 'H:04 발표 준비', anchor: '발표-준비/발표자료', split: 'test', tag: 'r-spacing' },
  // the key word is only in the page title; the other words are common in bodies
  { q: '알림 피로 줄이는 방법', page: 'P:알림 피로 줄이기', anchor: '알림-정리안/묶어-보내기', also: [{ page: 'P:알림 피로 줄이기', anchor: '알림-정리안/끄기-쉽게' }], split: 'dev', tag: 'r-title-only' },
  { q: '야간 당번 순서', page: 'P:야간 당번표', anchor: '11월/순서', split: 'dev', tag: 'r-title-only' },
  { q: '텃밭 아이디어 수익 모델', page: 'H:02-2 아이디어2, 동네 텃밭', anchor: '동네-텃밭/수익-모델', split: 'test', tag: 'r-title-only' },
  { q: 'OKR 목표 잔존율', page: 'P:OKR 2분기', anchor: '2분기-목표/목표-2', split: 'test', tag: 'r-title-only' },
  // long questions made mostly of common words around one or two key words
  { q: '해커톤에서 데이터 분석으로 만든 서비스 아이디어 중 택배 관련된 것', page: 'H:02-1 아이디어1, 택배 한 상자', anchor: '택배-한-상자/한-줄-요약', split: 'dev', tag: 'r-long-common' },
  { q: '팀 회의에서 정한 서비스 출시 일정과 베타 날짜', page: 'P:출시 계획 2026 봄', anchor: '출시-계획/일정', split: 'dev', tag: 'r-long-common' },
  { q: '공공 데이터로 동네 주민을 위한 서비스 아이디어 텃밭 지도', page: 'H:02-2 아이디어2, 동네 텃밭', anchor: '동네-텃밭/한-줄-요약', split: 'test', tag: 'r-long-common' },
  { q: '팀에서 정한 장애 대응 연락 순서와 담당자 전화', page: 'P:장애 대응 연락망', anchor: '장애-대응-연락망/순서', also: [{ page: 'P:장애 대응 연락망', anchor: '장애-대응-연락망/연락처' }], split: 'test', tag: 'r-long-common' },
  // English words and abbreviations in a Korean question (or the other way round)
  { q: 'API rate limit 넘으면', page: 'P:API 사용 한도', anchor: 'api-사용-한도/rate-limit', split: 'dev', tag: 'r-mixed' },
  { q: 'CI 실패 대응', page: 'P:CI 파이프라인', anchor: 'ci-파이프라인/실패했을-때', split: 'dev', tag: 'r-mixed' },
  { q: 'PR 리뷰 이틀', page: 'P:코드 리뷰 규칙', anchor: '코드-리뷰-규칙/기한', split: 'test', tag: 'r-mixed' },
  { q: '택배 아이디어 MVP 범위', page: 'H:02-1 아이디어1, 택배 한 상자', anchor: '택배-한-상자/mvp-범위', split: 'test', tag: 'r-mixed' },
  // a short page with a short title against long sections that use the same words
  { q: '택배 도난', page: 'H:택배 도난 대응', anchor: '_intro', split: 'dev', tag: 'r-short-page' },
  { q: '와이파이 비밀번호', page: 'P:와이파이', anchor: '_intro', split: 'dev', tag: 'r-short-page' },
  { q: '회의실 예약 방법', page: 'P:회의실 예약', anchor: '_intro', split: 'test', tag: 'r-short-page' },
  { q: '야간 당번', page: 'P:야간 당번표', anchor: '11월/순서', split: 'test', tag: 'r-short-page' },
  // the same words in several workspaces; the answer is in one of them
  { q: '해커톤 심사 기준 배점', page: 'H:03 심사 기준', anchor: '심사-기준/배점', split: 'dev', tag: 'r-cross-ws' },
  { q: '아이디어 회의 결정', page: 'H:01 아이디어 회의', anchor: '아이디어-회의/결정', split: 'dev', tag: 'r-cross-ws' },
  { q: '10월 회의록 액션 아이템', page: 'P:주간 회의 10월 2주', anchor: '주간-회의/액션-아이템', split: 'test', tag: 'r-cross-ws' },
  { q: '해커톤 발표 리허설', page: 'H:04 발표 준비', anchor: '발표-준비/리허설', split: 'test', tag: 'r-cross-ws' },
]
