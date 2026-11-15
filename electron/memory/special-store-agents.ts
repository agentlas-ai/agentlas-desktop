// 자기 저장소를 가진 특수 에이전트 id 등록처. 엔진의 `memory-scopes.json` `specialAgentIds` 와 같은 답을 내려고 둔다:
// `builtin-agentlas-*` 는 원래 저장소가 없는 시스템 행위자인데 Science·Finance 두 개만 예외로 에이전트 저장소를 가진다.
// 두 id 는 `shared/memory-special-agents.ts` 의 상수다(electron/ 밖이라 Finance 이름 줄 수 래칫 test-finance-harness-unified F6 의 대상이 아니다). 각 모듈은 같은 철자를 다시 등록해도 된다.
// 읽는 곳은 `stores.ts storeAgentId` 와 `store-write.ts ownerScopeOf`. 폴더가 아직 없으면(전) 뿌리를 읽고 쓴다. 가져오는 것은 순수 상수 파일 하나뿐이다.
import { CONTRACT_SPECIAL_STORE_AGENT_IDS } from "../../shared/memory-special-agents";
// ★답이 프로세스 상태에 따라 달라지면 안 된다(감사 40 #9): 모듈이 불렸는지(Main 은 불렀고 데몬·터미널 엔진 쪽 프로세스는 안 불렀을 수 있다)에 따라 같은 Finance 줄이 에이전트 저장소로도, 뿌리로도 갔다.
// 그래서 계약(`memory-scopes.json specialAgentIds`)의 두 id 는 처음부터 들어 있고, 각 모듈의 등록 호출은 같은 철자를 다시 넣을 뿐이다(멱등).
const byFolded = new Map<string, string>(CONTRACT_SPECIAL_STORE_AGENT_IDS.map(id => [id.toLowerCase(), id]));

/** 이 id 를 자기 저장소를 가진 특수 에이전트로 등록한다(대소문자 무시, 먼저 등록한 철자가 정본). 같은 id 를 다시 등록해도 같다. */
export function registerSpecialStoreAgent(id: string): void {
  const text = typeof id === "string" ? id.trim() : "";
  if (text && !byFolded.has(text.toLowerCase())) byFolded.set(text.toLowerCase(), text);
}

/** 등록된 특수 에이전트면 정본 철자의 id, 아니면 null. */
export function specialStoreAgentId(actor: string | null | undefined): string | null {
  return typeof actor === "string" ? byFolded.get(actor.trim().toLowerCase()) ?? null : null;
}
