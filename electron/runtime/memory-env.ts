// 실행기에 주는 기억 위치 환경변수. 모든 CLI 실행기가 지나는 `spawnCli` 한 곳에서 붙인다.
//   AGENTLAS_MEMORY_PROJECT_REF   프로젝트 id (없으면 주지 않는다: 대화 id 는 저장소 키가 아니다 — 감사 40 #3) — 엔진이 프로젝트 기억 저장소 키의 첫 후보로 읽는다(memory_stores.project_keys).
//   AGENTLAS_MEMORY_AGENT_FOLDER  앱이 푼 에이전트 폴더(절대 경로) — 엔진이 폴더 스캔 없이 에이전트 저장소를 찾는다(memory_stores._env_agent_home).
//   AGENTLAS_MEMORY_PERSONAL_READ 1 = 이 실행기는 개인 에이전트 자신의 대화를 맡는다(Agentlas 2.0 P3a, 작업공간 규칙 스위치가 켜졌을 때만 호스트가 정한다). 엔진은 이 값이 정확히 "1" 일 때만 훅에서 Personal 줄을 읽는다.
// 값은 한 턴의 비동기 흐름(AsyncLocalStorage)에 묶인다: 턴이 시작된 뒤 프로젝트·에이전트가 정해지는 지점에서 한 번 `bindMemoryEnv` 를 부르면
// 그 흐름에서 나가는 모든 spawn 이 받는다. 값이 없으면 아무것도 붙이지 않는다(= 이 묶음 전과 같은 환경). 호출자가 env 에 직접 둔 값이 이긴다.
// ★부르는 쪽(`mcp/client.ts`, 유일한 호출처)은 분리 스위치가 켜졌을 때만 부른다. 엔진 훅은 중앙 레이아웃에서도 프로젝트 ref 를 읽어 프로젝트 행을 더하므로
//   (감사 23 #4: 훅 줄 4개 → 7개) 스위치가 꺼진 동안 이 값을 주면 "동작 변화 0" 이 거짓이 된다.
// Electron 을 가져오지 않는다(데몬·시험도 읽는다).
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

export const MEMORY_PROJECT_REF_ENV = "AGENTLAS_MEMORY_PROJECT_REF";
export const MEMORY_AGENT_FOLDER_ENV = "AGENTLAS_MEMORY_AGENT_FOLDER";
/** `1` = this executor serves the personal agent's own conversation (Agentlas 2.0 P3a; the engine reads Personal lines for a hook only then, exactly this value). Same name as the rule file's `workspaceRules.personalReadEnv`. */
export const MEMORY_PERSONAL_READ_ENV = "AGENTLAS_MEMORY_PERSONAL_READ";
export interface MemoryEnvValues { projectRef?: string | null; agentFolder?: string | null; personalRead?: boolean }

const scope = new AsyncLocalStorage<MemoryEnvValues>();

/** 지금 비동기 흐름의 나머지 — `enterWith` 라서 *첫 await 뒤에서* 불러야 한다(동기 앞부분에서 부르면 부른 쪽의 흐름까지 묶인다).
 *(와 거기서 시작되는 자식 흐름)에 기억 위치를 묶는다. 이미 묶인 값 위에 필드별로 덮어쓴다. */
export function bindMemoryEnv(values: MemoryEnvValues): void {
  const merged: MemoryEnvValues = { ...scope.getStore() };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  scope.enterWith(merged);
}

/** `spawnCli` 가 env 에 더할 값. 비었거나 모양이 틀린 값(빈 문자열, 상대 경로)은 붙이지 않는다 — 형식 때문에 실행을 멈추지 않는다. */
export function memoryEnvForSpawn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bound = scope.getStore();
  if (!bound) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  // The Personal-read flag (P3a) is the host's word for THIS turn: `true` sets it, an explicit `false` takes off a value that came from the user's shell or an enclosing flow; unbound (the switch off binds
  // nothing) leaves the environment exactly as it was.
  if (bound.personalRead === true) out[MEMORY_PERSONAL_READ_ENV] = "1";
  else if (bound.personalRead === false) delete out[MEMORY_PERSONAL_READ_ENV];
  const ref = typeof bound.projectRef === "string" ? bound.projectRef.trim() : "";
  if (ref && out[MEMORY_PROJECT_REF_ENV] === undefined) out[MEMORY_PROJECT_REF_ENV] = ref;
  const folder = typeof bound.agentFolder === "string" ? bound.agentFolder.trim() : "";
  if (folder && path.isAbsolute(folder) && out[MEMORY_AGENT_FOLDER_ENV] === undefined) out[MEMORY_AGENT_FOLDER_ENV] = folder;
  return out;
}
