/**
 * 좌석 사건 줄 — 자리에 무슨 일이 있었는지 대화 안에 남기는 한 줄
 * (SEAT-SESSION-PLAN-v2 §4-5·T2·T10).
 *
 * ★ 왜 표식이 필요한가. One 화면은 `role:"system"` 메시지를 **전부 숨긴다** — 그 자리는
 * One 이 사용자 대신 모델에게 보내는 내부 프롬프트가 쓰는 자리라, 사람이 쓴 말처럼
 * 재생되면 안 되기 때문이다(OneShell `visibleOneMessageText`). 그래서 "이 자리를 누가
 * 맡았습니다" 같은 **사실 기록**을 그냥 system 으로 남기면 저장은 되는데 화면에는 영원히
 * 안 뜬다(라이브 실측으로 확인). 문구를 정규식으로 알아보는 방식은 번역·표현이 바뀌면
 * 조용히 깨지므로, 우리가 붙이는 **구조적 표식**으로 가른다.
 *
 * 표식은 저장된 텍스트의 맨 앞에만 온다. 화면은 표식을 벗겨서 보여주고, 표식이 붙지 않은
 * system 줄은 지금처럼 숨긴다.
 */
export const SEAT_EVENT_MARKER = "<<agentlas-seat>>";

/** 저장할 좌석 사건 줄을 만든다(표식 + 사람이 읽는 문장). */
export function seatEventText(line: string): string {
  return `${SEAT_EVENT_MARKER}${line}`;
}

/**
 * 한국어 주격 조사 — 이름 끝소리에 받침이 있으면 "이", 없으면 "가".
 * "기획자이(가) 맡았습니다" 같은 기계 티를 내지 않기 위해서다(오너: 렌더링 UX 중요).
 * 한글이 아닌 이름(영문·숫자·이모지)은 판정 근거가 없으므로 "이(가)"로 정직하게 둔다.
 */
export function koSubjectParticle(name: string): string {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (!Number.isFinite(code) || code < 0xac00 || code > 0xd7a3) return "이(가)";
  return (code - 0xac00) % 28 === 0 ? "가" : "이";
}

/**
 * 좌석 사건 줄이면 사람이 읽는 부분을 돌려주고, 아니면 null.
 * 표식만 있고 문장이 비면 null — 빈 줄을 그리지 않는다(I9: 지어낸 값·빈 줄 금지).
 */
export function seatEventLine(text: string): string | null {
  if (!text.startsWith(SEAT_EVENT_MARKER)) return null;
  const line = text.slice(SEAT_EVENT_MARKER.length).trim();
  return line.length > 0 ? line : null;
}
