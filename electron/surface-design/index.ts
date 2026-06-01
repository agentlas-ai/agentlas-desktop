// Surface 디자인 시스템 — 빌트인 production-grade 토큰/컴포넌트 + 외부 디자인 MCP(lazyweb) 연동 디렉티브.
export { buildDesignCss, type DesignTokens } from "./theme";

/**
 * Surface builder 디자인 디렉티브 — 사용자가 보는 surface/앱을 만들 때 디자인 품질을 강제한다.
 * surface 빌드 컨텍스트(온디맨드 surface 모듈)에만 주입한다(매 턴 X). lazyweb/shadcn MCP가 연결돼
 * 있으면 우선 사용하고, 없으면 빌트인 디자인 시스템(buildDesignCss)으로 fallback한다.
 */
export const SURFACE_DESIGN_DIRECTIVE = [
  "## Design quality (mandatory for anything the user sees)",
  "",
  "Outputs must look production-grade, not 'AI-generated' (no identical cards/gradients/clichés).",
  "- RESEARCH FIRST when a design MCP is connected: use the `lazyweb` tools to pull real-app references and extract evidence-based design tokens (colors, typography, spacing) for the domain. Design with evidence, not vibes.",
  "- For React/Tailwind apps, use the `shadcn` MCP to fetch production components/blocks instead of hand-rolling UI.",
  "- For Agentlas static surface scaffolds (no build step), the built-in design system is applied automatically (refined tokens, type scale, spacing grid, component layer). Use the `ds-*` classes (ds-card, ds-btn, ds-table, ds-metric, ds-badge, ds-field, ds-grid) and the CSS variables; do not invent ad-hoc inline styles.",
  "- Respect a brand accent if the user provides one; otherwise use the system default. Keep spacing on the 4px grid and the type scale.",
  "If no design MCP is connected and the task is user-facing and design-sensitive, suggest connecting `lazyweb` (free) for better results.",
].join("\n");
