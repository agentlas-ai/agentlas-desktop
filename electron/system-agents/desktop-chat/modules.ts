// 데스크톱 chat 에이전트의 온디맨드 모듈 — surface / connection / automation.
// 키워드/description = 디스커버리 신호(트리거 신뢰도를 좌우하므로 강신호만, ko+en).
// load(): 실제 무거운 블록 상수를 지연 반환(선택됐을 때만). 이게 (b) 온디맨드의 핵심 —
// 평소엔 컨텍스트를 안 먹고, 의도가 잡힐 때만 16KB/7KB 블록이 들어간다.
import type { OnDemandModule } from "../types";
import { SURFACE_PROTOCOL } from "../../surface-emitter";
import { GLOBAL_CONNECTION_SKILL } from "../../runtime/global-skill";
import { AUTOMATION_PROTOCOL } from "../../automation-emitter";

export const SURFACE_MODULE: OnDemandModule = {
  id: "surface",
  title: "Interactive surface / dashboard builder",
  // 명사·도메인 중심 강신호(generic verb 제외로 over-trigger 억제). under-trigger(와우모먼트 미스)를
  // 줄이려 surface-worthy 명사를 폭넓게: dashboard/app/board/workflow/crm/inventory/orders/track/manage...
  keywords: [
    "dashboard", "app", "mini-app", "service-app", "tool", "board", "workflow",
    "pipeline", "crm", "inventory", "catalog", "orders", "storefront", "store",
    "shop", "operating", "operate", "monitor", "track", "manage", "organize",
    "interactive", "chart", "studio",
    "대시보드", "앱", "도구", "보드", "차트", "스토어", "쇼핑몰", "운영", "관리",
    "추적", "정리", "주문", "재고", "워크플로우",
  ],
  description:
    "Emit an interactive surface manifest (dashboard / service-app / operating OS) when the result is better as a reusable mini-app than plain text. Carries widgets, actions, capabilities, delegation, budget.",
  load: () => SURFACE_PROTOCOL,
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
  load: () => GLOBAL_CONNECTION_SKILL,
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
  load: () => AUTOMATION_PROTOCOL,
};

export const DESKTOP_CHAT_MODULES: OnDemandModule[] = [
  SURFACE_MODULE,
  CONNECTION_MODULE,
  AUTOMATION_MODULE,
];
