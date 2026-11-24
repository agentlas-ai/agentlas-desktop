// 얼굴을 고르지 않은 에이전트의 기본 캐릭터 얼굴.
// 규칙의 정본은 shared/agent-default-looks.json(폰 계약 사본). 폰·웹과 같은 에이전트는 같은 얼굴이어야 한다.
// seed = 표시 이름의 앞뒤 공백을 뗀 글자(대소문자·유니코드 정규화 없음), hash = UTF-8 바이트 FNV-1a 32비트,
// 얼굴 = looks[hash % looks.length].
import contract from "@shared/agent-default-looks.json";

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

/** 이름이 비어 있으면 null(이니셜 원으로 떨어진다). */
export function agentDefaultLookSrc(name: string | null | undefined): string | null {
  if (!agentDefaultLookSeed(name)) return null;
  return `/brand/one-characters/looks/${agentDefaultLookId(name)}.webp`;
}
