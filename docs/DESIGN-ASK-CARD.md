# 묻는 카드 (Ask Card) — 앱 어디서나 한 모양

오너 지시 2026-08-24: **승인이든 질문이든 사람에게 무언가 고르게 하는 자리는
토씨 하나 다르지 않게 같은 모양이어야 한다.** 데스크탑·웹·모바일 어디든.

그 전에는 네 곳이 각자 다른 모양이었다 — 도구 승인 시트, 인라인 승인 칩,
브라우저 행동 승인, 질문 시트. 같은 뜻인데 화면마다 다르게 보였고, 인라인
칩은 제목·요약·선택지·승인·항상승인·거절이 **한 줄에 가로로** 늘어서서
무엇을 고르는지 읽을 수 없었다.

## 정본

| 무엇 | 어디 |
|---|---|
| 값(색·크기·간격) | `renderer/app/globals.css` 의 `--ask-*` 토큰 |
| 모양(마크업) | `renderer/components/AskCard.tsx` |
| 스타일 | `renderer/components/AskCard.module.css` (토큰만 참조) |

새 값을 컴포넌트에 직접 쓰지 않는다. 토큰을 고치면 모든 화면이 함께 바뀐다.

## 구조

```
┌────────────────────────────────────────────┐
│ 지금 무엇을 하고 싶어?                   × │  제목 + 닫기
│                                            │
│ ①  작업 계속하기   [추천]              →  │  번호 + 제목 + 배지 + 화살표
│     지금 하던 문제를 계속 해결해.          │  설명(회색, 한 줄)
│                                            │
│ ②  잠시 쉬기                               │
│     당장은 작업을 멈추고 쉬어.             │
│                                            │
│ ③  그냥 대화하기                           │
│     가볍게 이야기만 나눠.                  │
│ ────────────────────────────────────────── │
│ ✎  아니요. 그리고 …            [건너뛰기] │  자유 입력 + 빠져나갈 길
└────────────────────────────────────────────┘
```

- 선택지는 **세로로 쌓는다.** 가로로 늘어놓지 않는다.
- 번호는 원형 배지(`--ask-index-*`). 1부터.
- 지금 고른 선택지만 배경이 깔리고(`--ask-option-active`) 오른쪽에 화살표가 붙는다.
- 배지("추천")는 제목 오른쪽에 알약 모양으로.
- 제목은 한 줄로 자른다(말줄임). 설명은 회색 한 줄.
- 아래 줄은 **빠져나갈 길**이다. 낼 수 있는 질문에는 언제나 안 고르고 넘어갈
  길이 있어야 한다.

## 쓰는 법

```tsx
<AskCard
  title="지금 무엇을 하고 싶어?"
  locale={locale}
  options={[
    { id: "continue", title: "작업 계속하기", note: "지금 하던 문제를 계속 해결해.", badge: "추천", active: true },
    { id: "rest", title: "잠시 쉬기", note: "당장은 작업을 멈추고 쉬어." },
    { id: "chat", title: "그냥 대화하기", note: "가볍게 이야기만 나눠." },
  ]}
  onChoose={(id, freeText) => { /* … */ }}
  onClose={() => { /* … */ }}
  footer={{ placeholder: "아니요. 그리고 …", skipLabel: "건너뛰기", onSkip: (text) => { /* … */ } }}
/>
```

## 웹으로 옮길 때

토큰 블록(`--ask-*`)과 `AskCard.module.css` 를 그대로 복사하고 마크업을 위
구조대로 맞춘다. 값을 새로 정하지 않는다 — 그러면 다시 갈라진다.

## 지금 이 카드를 쓰는 곳 (2026-08-24 기준 전부)

- `renderer/components/one/OneShell.tsx` — One 결정/승인
- `renderer/components/ToolApprovalInline.tsx` — 도구 실행 승인
- `renderer/components/ToolApprovalSheet.tsx` — 위 카드를 그대로 재사용
- `renderer/components/BrowserActionApprovalSheet.tsx` — 브라우저 행동 승인
- `renderer/components/ChatQuestionSheet.tsx` — 실행 중 질문
- `renderer/components/AskUserSheet.tsx` — 에이전트의 질문

새로 묻는 자리를 만들 때 이 목록에 추가한다. 다른 모양을 새로 만들지 않는다.
