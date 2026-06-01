// 데스크톱 chat 시스템 에이전트 spec — 코어 + 온디맨드 모듈.
// 런타임은 assembleSystemPrompt(DESKTOP_CHAT_AGENT, userPrompt)로 매 턴 최소 프롬프트를 조립한다.
import type { SystemAgentSpec } from "../types";
import { DESKTOP_CHAT_CORE } from "./core";
import { DESKTOP_CHAT_MODULES } from "./modules";

export const DESKTOP_CHAT_AGENT: SystemAgentSpec = {
  id: "desktop-chat",
  core: DESKTOP_CHAT_CORE,
  modules: DESKTOP_CHAT_MODULES,
};

export { DESKTOP_CHAT_CORE } from "./core";
export { DESKTOP_CHAT_MODULES } from "./modules";
