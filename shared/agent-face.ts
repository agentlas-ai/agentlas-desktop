// 에이전트의 그림(face)을 정하는 함수 하나. 컴퓨터 화면(renderer AgentAvatar)과 폰으로 가는 투영(electron/mobile-bridge)이 둘 다 이것을 쓴다.
// 우선순위: 고른 외형(AgentAppearance 그대로) > 이름으로 정해지는 기본 얼굴(37) > 없음(null = 화면은 한 글자 이니셜).
// 기본 얼굴 규칙의 정본은 shared/agent-default-looks.json(폰 계약 사본):
//   seed = 이름의 앞뒤 공백을 뗀 글자(대소문자·유니코드 정규화 없음), hash = UTF-8 바이트 FNV-1a 32비트, 얼굴 = looks[hash % looks.length].
// 올린 사진(one-avatar)은 이 함수의 몫이 아니다: 사진은 별도 필드(portrait)로 가고, 어느 화면이 사진을 그리는지는 각 화면이 정한다.
import contract from "./agent-default-looks.json";
import { agentDisplayName, type AgentNameFields } from "./agent-display-name";
import type { AgentAppearance } from "./agent-appearance";

export type AgentFace = AgentAppearance | { kind: "look"; id: string };

const LOOKS: readonly string[] = contract.looks;

export function agentDefaultLookSeed(name: string | null | undefined): string {
  return (name ?? "").trim();
}

export function fnv1a32Utf8(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function agentDefaultLookId(name: string | null | undefined): string {
  return LOOKS[fnv1a32Utf8(agentDefaultLookSeed(name)) % LOOKS.length];
}

/**
 * 씨앗으로 쓰는 이름: UI 언어와 무관해야 한다(영어 UI 에서 nameEn 으로 바뀌면 같은 에이전트의 얼굴이 언어마다 달라진다).
 * = 주인이 붙인 이름(localDisplayName) > 패키지 이름(name) > slug. `agentDisplayName` 을 언어 없이 부른 것과 같다.
 */
export function agentFaceSeedName(agent: AgentNameFields | null | undefined): string {
  return agentDisplayName(agent);
}

/** 그림을 정한다. 고른 외형이 있으면 그대로, 없으면 씨앗 이름의 기본 얼굴, 씨앗도 비면 null. */
export function agentFace(appearance: AgentAppearance | null | undefined, seedName: string | null | undefined): AgentFace | null {
  if (appearance) return appearance.kind === "glyph" ? { kind: "glyph", id: appearance.id, color: appearance.color } : { kind: "character", id: appearance.id };
  if (!agentDefaultLookSeed(seedName)) return null;
  return { kind: "look", id: agentDefaultLookId(seedName) };
}
