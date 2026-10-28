// 복구 턴을 받을 수 있는 실행기 — 실행기 종류마다 한 칸, 근거와 함께.
// runtime-kinds.ts · runtime-capabilities.ts 와 같은 규율: Record<RuntimeKind, …> 라서 새 실행기는
// 이 칸에 답하지 않으면 컴파일이 실패한다. 손으로 적은 허용 목록을 따로 두지 않는다.
//
// 복구 턴 = 히스토리 없음, 저장된 공급자 세션 없음, 무인, Main 이 발급한 복구 능력을 들고 감.
// "entry-guarded" = 그 실행기의 어댑터가 공급자 세션을 찾거나 프롬프트를 만들기 전에 능력을
// 다시 확인한다(electron/science-host/recovery-authority.ts assertScienceRecoveryRequest /
// assertScienceRecoveryAcpRequest). 낡거나 바뀐 복구가 공급자에 닿지 못한다.
//
// ★2026-10-28: recovery-authority.ts 의 손 목록이 ollama 를 빠뜨렸다. ollama 는 lmstudio·mlx·
// agentlas-local 과 같은 로컬 도구 루프(local-tool-loop.ts runLocalOpenAiChat)와 같은 확인을 쓴다.
import type { RuntimeKind } from "./types";

export interface RuntimeFreshRecovery {
  admission: "entry-guarded" | "refused";
  /** Where the adapter re-checks the recovery capability (symbol names, not line numbers). */
  guard: string;
}

export const RUNTIME_FRESH_RECOVERY: Record<RuntimeKind, RuntimeFreshRecovery> = {
  "claude-code": { admission: "entry-guarded", guard: "electron/runtime/claude-code.ts runClaudeTurn entry and saved-session lookup" },
  codex: { admission: "entry-guarded", guard: "electron/runtime/codex.ts runCodex entry and saved-session lookup" },
  antigravity: { admission: "entry-guarded", guard: "electron/runtime/antigravity.ts runAntigravity entry and runPreparedAntigravityAttempt saved-session lookup" },
  grok: { admission: "entry-guarded", guard: "ACP (default): electron/runtime/acp.ts assertScienceRecoveryAcpRequest; legacy electron/runtime/grok.ts entry" },
  cursor: { admission: "entry-guarded", guard: "ACP (default): electron/runtime/acp.ts assertScienceRecoveryAcpRequest; legacy electron/runtime/cursor.ts entry" },
  kimi: { admission: "entry-guarded", guard: "ACP (default): electron/runtime/acp.ts assertScienceRecoveryAcpRequest; legacy electron/runtime/kimi.ts entry" },
  acp: { admission: "entry-guarded", guard: "electron/runtime/acp.ts assertScienceRecoveryAcpRequest before session/new or session/load" },
  byok: { admission: "entry-guarded", guard: "electron/runtime/byok.ts prepareContext and every backend call (backend allowlist stays in recovery-authority.ts)" },
  ollama: { admission: "entry-guarded", guard: "electron/runtime/ollama.ts runOllama -> local-tool-loop.ts runLocalOpenAiChat entry" },
  lmstudio: { admission: "entry-guarded", guard: "electron/runtime/lmstudio.ts -> local-openai.ts makeLocalOpenAiRunner entry -> local-tool-loop.ts runLocalOpenAiChat" },
  mlx: { admission: "entry-guarded", guard: "electron/runtime/mlx.ts -> local-openai.ts makeLocalOpenAiRunner entry -> local-tool-loop.ts runLocalOpenAiChat" },
  "agentlas-local": { admission: "entry-guarded", guard: "electron/local-model-hub/runner.ts entry -> local-tool-loop.ts runLocalOpenAiChat" },
  agentlas: { admission: "entry-guarded", guard: "electron/runtime/agentlas-serving.ts runAgentlasServing entry" },
};

/** Kinds whose adapter re-checks a recovery capability at entry. */
export const ENTRY_GUARDED_RECOVERY_KINDS: ReadonlySet<string> = new Set(
  (Object.entries(RUNTIME_FRESH_RECOVERY) as Array<[string, RuntimeFreshRecovery]>)
    .filter(([, row]) => row.admission === "entry-guarded").map(([kind]) => kind));
