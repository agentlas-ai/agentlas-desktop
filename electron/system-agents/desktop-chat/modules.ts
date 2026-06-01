// 데스크톱 chat 에이전트의 온디맨드 모듈 — surface / connection / automation.
// 키워드/description = 디스커버리 신호(트리거 신뢰도를 좌우하므로 강신호만, ko+en).
// load(): consolidation 후 실제 상수로 1줄 연결(아래 WIRE 주석). 지금은 다른 세션 WIP가
// 해당 파일(surface-emitter.ts 등)을 점유 중이라 placeholder로 둔다(충돌 0, 라우팅은 완전 동작).
import type { OnDemandModule } from "../types";

function pending(name: string, source: string): string {
  // WIRE: consolidation 후 `return SOURCE_CONST;` 로 교체.
  return `[on-demand module "${name}" — wire to ${source} on consolidation]`;
}

export const SURFACE_MODULE: OnDemandModule = {
  id: "surface",
  title: "Interactive surface / dashboard builder",
  keywords: [
    "dashboard", "app", "interactive", "chart", "storefront", "operating", "operate",
    "service-app", "mini-app", "build", "scaffold", "deploy",
    "대시보드", "앱", "차트", "스토어", "운영", "자동화 대시보드", "만들어",
  ],
  description:
    "Emit an interactive surface manifest (dashboard / service-app / operating OS) when the result is better as a reusable mini-app than plain text. Carries widgets, actions, capabilities, delegation, budget.",
  // WIRE: return SURFACE_PROTOCOL from electron/surface-emitter.ts
  load: () => pending("surface", "SURFACE_PROTOCOL (surface-emitter.ts)"),
};

export const CONNECTION_MODULE: OnDemandModule = {
  id: "connection",
  title: "Connect external accounts / API keys",
  keywords: [
    "connect", "account", "login", "sign up", "api key", "token", "oauth", "credential",
    "slack", "gmail", "github", "stripe", "notion", "discord", "telegram", "firebase",
    "연결", "계정", "로그인", "가입", "키", "토큰", "발급",
  ],
  description:
    "Hand-hold a non-technical user through signing up / logging in / creating API keys for a third-party provider via the browser, then store credentials in the vault.",
  // WIRE: return GLOBAL_CONNECTION_SKILL from electron/runtime/global-skill.ts
  load: () => pending("connection", "GLOBAL_CONNECTION_SKILL (runtime/global-skill.ts)"),
};

export const AUTOMATION_MODULE: OnDemandModule = {
  id: "automation",
  title: "Schedule a recurring automation",
  keywords: [
    "schedule", "every", "daily", "weekly", "monthly", "monday", "recurring", "cron",
    "automate", "automation", "remind", "routine",
    "매일", "매주", "매월", "반복", "정기", "예약", "스케줄", "자동 실행",
  ],
  description:
    "Register a recurring scheduled automation (## Automation block) that re-runs this agent on a cadence.",
  // WIRE: return AUTOMATION_PROTOCOL from electron/automation-emitter.ts
  load: () => pending("automation", "AUTOMATION_PROTOCOL (automation-emitter.ts)"),
};

export const DESKTOP_CHAT_MODULES: OnDemandModule[] = [
  SURFACE_MODULE,
  CONNECTION_MODULE,
  AUTOMATION_MODULE,
];
