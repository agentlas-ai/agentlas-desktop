// 에이전트가 "멀티모달 엔진이 하나도 연결 안 됨"을 알릴 때 emit하는 마커.
// global-skill.ts가 READY="0"일 때 이 줄을 내보내라고 지시한다. 본문에서는 제거하고,
// 대신 채팅에 "멀티모달 설정으로 가기" 버튼을 렌더한다(브라우저 계정생성 삽질 대신).
const MARKER = "<<agentlas-multimodal-setup>>";

export function stripMultimodalSetup(text: string): { text: string; needsSetup: boolean } {
  if (!text || !text.includes(MARKER)) return { text, needsSetup: false };
  return { text: text.split(MARKER).join("").replace(/\n{3,}/g, "\n\n").trim(), needsSetup: true };
}
