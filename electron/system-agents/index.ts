// 시스템 에이전트 컨텍스트 엔지니어링 백본 — 코어 최소화 + 온디맨드 분할.
// provider-portable(claude/codex/gemini 균일). 시스템 에이전트 추가 규칙은 프로젝트 메모리 참고.
export * from "./types";
export { Bm25, tokenize } from "./bm25";
export { selectModules, type SelectOptions } from "./discovery";
export { assembleSystemPrompt, type AssembleResult } from "./assemble";
export { AUTOMATION_SUPERVISOR_SYSTEM_AGENT } from "./automation-supervisor";
export { SYSTEM_OPTIMIZER_SYSTEM_AGENT, buildSystemOptimizerPrompt } from "./system-optimizer";
