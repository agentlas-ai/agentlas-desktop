// 얼굴을 고르지 않은 에이전트의 기본 캐릭터 얼굴. 규칙·계산은 shared/agent-face.ts 하나(폰 투영과 같은 함수)이고, 여기는 그림 주소만 만든다.
export { agentDefaultLookSeed, agentDefaultLookId, fnv1a32Utf8 } from "@shared/agent-face";
import { agentFace, type AgentFace } from "@shared/agent-face";

/** 기본 얼굴(look)의 그림 주소. 고른 외형이거나 얼굴이 없으면 null. */
export function agentFaceLookSrc(face: AgentFace | null): string | null {
  return face?.kind === "look" ? `/brand/one-characters/looks/${face.id}.webp` : null;
}

/** 이름이 비어 있으면 null(이니셜 원으로 떨어진다). */
export function agentDefaultLookSrc(name: string | null | undefined): string | null {
  return agentFaceLookSrc(agentFace(null, name));
}
