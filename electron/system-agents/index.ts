// 시스템 에이전트 — 코어 + 모듈(단어장 선택 없음, 오너 2026-10-13).
// provider-portable(claude/codex/gemini 균일). 시스템 에이전트 추가 규칙은 프로젝트 메모리 참고.
export * from "./types";
export { assembleSystemPrompt, type AssembleResult } from "./assemble";
export { AUTOMATION_SUPERVISOR_SYSTEM_AGENT } from "./automation-supervisor";
export { SYSTEM_OPTIMIZER_SYSTEM_AGENT, buildSystemOptimizerPrompt } from "./system-optimizer";
