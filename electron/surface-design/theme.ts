// Surface 디자인 시스템 — 스캐폴드 산출물이 "AI 티 나는" 인라인 CSS가 아니라
// production-grade로 보이게 하는 빌트인 토큰+컴포넌트 레이어. 외부 디자인 MCP(lazyweb로
// 추출한 토큰)가 있으면 그걸 우선 적용하고, 없으면 이 정제된 기본값으로 fallback한다.
// (목표 2차: 사용자가 보는 모든 아웃풋 디자인이 뛰어나야 한다.)
//
// 스캐폴드는 정적 HTML(빌드 스텝 없음)이라 vanilla CSS로 제공한다. React 앱을 만들 땐
// 에이전트가 shadcn MCP를, 디자인 리서치엔 lazyweb MCP를 쓰도록 안내(surface 디자인 디렉티브).

export interface DesignTokens {
  /** 브랜드 강조색(HEX). lazyweb 추출/사용자 브랜드가 있으면 주입. */
  accent?: string;
  /** 라이트/다크 */
  scheme?: "light" | "dark";
  /** 본문 폰트 스택 */
  fontSans?: string;
}

const DEFAULT_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';

/** 정제된 라이트 팔레트(중립 웜그레이 + 차분한 인디고 강조). 기존 스캐폴드 var 이름을 포함(상위호환). */
function lightVars(accent: string): string {
  return [
    "color-scheme: light;",
    // 중립 스케일 (warm neutral)
    "--bg:#fbfbfa; --paper:#fbfbfa; --panel:#ffffff; --panel-2:#f6f6f4;",
    "--ink:#1a1a17; --ink-2:#3a3a35; --muted:#6b6b63; --faint:#9a9a90;",
    "--line:#e9e8e3; --line-2:#dedcd5;",
    // 강조 + 의미색
    `--accent:${accent}; --accent-ink:#ffffff; --accent-soft:${accent}14;`,
    "--ok:#15803d; --ok-soft:#15803d14; --warn:#b45309; --warn-soft:#b4530914; --risk:#be123c; --risk-soft:#be123c14;",
    // 기존 스캐폴드 호환 별칭(정제값으로 덮어씀)
    `--teal:#0f766e; --coral:#d85c4a; --mint:#e7f6ec; --sky:#e9f0ff; --soft:${accent}10; --dark:#16160f; --white:#ffffff; --field:#f2f2ef;`,
    `--green:#167052; --blue:${accent}; --rose:#c04463; --gold:#94630c;`,
  ].join(" ");
}

function darkVars(accent: string): string {
  return [
    "color-scheme: dark;",
    "--bg:#15140f; --paper:#15140f; --panel:#1d1c16; --panel-2:#232218;",
    "--ink:#f2f1ea; --ink-2:#d6d4c8; --muted:#a6a397; --faint:#76746a;",
    "--line:#2c2a22; --line-2:#3a382e;",
    `--accent:${accent}; --accent-ink:#0c0c08; --accent-soft:${accent}26;`,
    "--ok:#4ade80; --ok-soft:#4ade8022; --warn:#fbbf24; --warn-soft:#fbbf2422; --risk:#fb7185; --risk-soft:#fb718522;",
    `--teal:#5eead4; --coral:#f0a08e; --mint:#16261b; --sky:#171f2e; --soft:${accent}1f; --dark:#0c0c08; --white:#1d1c16; --field:#232218;`,
    `--green:#4ade80; --blue:${accent}; --rose:#fb7185; --gold:#fbbf24;`,
  ].join(" ");
}

/**
 * 스캐폴드 HTML <style>에 넣을 디자인 CSS(토큰 + 베이스 타이포 + 컴포넌트 레이어)를 반환.
 * 기존 컴포넌트 CSS가 쓰는 var 이름(--ink/--accent/--line/--panel...)을 정제값으로 정의하므로,
 * `:root{...}` 한 줄만 이 함수로 교체해도 전체 룩이 즉시 개선된다.
 */
export function buildDesignCss(tokens: DesignTokens = {}): string {
  const accent = sanitizeHex(tokens.accent) ?? "#4f46e5";
  const sans = tokens.fontSans ?? DEFAULT_SANS;
  const root = tokens.scheme === "dark" ? darkVars(accent) : lightVars(accent);
  return `
:root {
  ${root}
  /* spacing (4px grid) */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px; --s8:64px;
  /* radius */
  --r1:6px; --r2:10px; --r3:14px; --r-full:999px;
  /* type scale (modular ~1.2) */
  --t-xs:12px; --t-sm:13px; --t-md:14px; --t-lg:17px; --t-xl:22px; --t-2xl:30px; --t-3xl:clamp(34px,5vw,52px);
  /* elevation (subtle, layered) */
  --sh1:0 1px 2px rgba(20,18,12,.05); --sh2:0 2px 8px rgba(20,18,12,.06),0 1px 2px rgba(20,18,12,.05);
  --sh3:0 8px 28px rgba(20,18,12,.10),0 2px 6px rgba(20,18,12,.06);
  --ring:0 0 0 3px var(--accent-soft);
  --font-sans:${sans}; --font-mono:${DEFAULT_MONO};
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--font-sans); font-size: var(--t-md); line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  font-feature-settings: "cv02","cv03","cv04","ss01"; letter-spacing: -0.006em;
}
h1,h2,h3,h4 { margin: 0 0 var(--s3); line-height: 1.18; letter-spacing: -0.02em; font-weight: 650; }
h1 { font-size: var(--t-3xl); } h2 { font-size: var(--t-2xl); } h3 { font-size: var(--t-xl); } h4 { font-size: var(--t-lg); }
p { margin: 0 0 var(--s3); color: var(--ink-2); }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
small, .muted { color: var(--muted); font-size: var(--t-sm); }
code, kbd, pre { font-family: var(--font-mono); font-size: .92em; }
hr { border: 0; border-top: 1px solid var(--line); margin: var(--s5) 0; }
:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--r1); }

/* ── 컴포넌트 레이어 (production-grade defaults) ── */
.ds-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r3); box-shadow: var(--sh1); padding: var(--s5); }
.ds-card--soft { background: var(--panel-2); box-shadow: none; }
.ds-stack { display: grid; gap: var(--s4); } .ds-row { display: flex; gap: var(--s3); align-items: center; } .ds-row--wrap { flex-wrap: wrap; }
.ds-grid { display: grid; gap: var(--s4); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.ds-btn { appearance: none; cursor: pointer; font: 600 var(--t-sm)/1 var(--font-sans); border-radius: var(--r2);
  padding: 10px 16px; border: 1px solid var(--line-2); background: var(--panel); color: var(--ink); transition: .14s ease; }
.ds-btn:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: var(--sh1); }
.ds-btn--primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.ds-btn--primary:hover { filter: brightness(1.05); }
.ds-btn--ghost { background: transparent; border-color: transparent; color: var(--muted); }
.ds-badge { display: inline-flex; align-items: center; gap: 6px; font-size: var(--t-xs); font-weight: 600;
  padding: 3px 9px; border-radius: var(--r-full); background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
.ds-badge--ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.ds-badge--warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.ds-badge--risk { background: var(--risk-soft); color: var(--risk); border-color: transparent; }
.ds-metric { display: grid; gap: 4px; } .ds-metric .v { font-size: var(--t-2xl); font-weight: 680; letter-spacing: -0.02em; }
.ds-metric .k { font-size: var(--t-xs); color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.ds-table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
.ds-table th { text-align: left; color: var(--muted); font-weight: 600; font-size: var(--t-xs); text-transform: uppercase;
  letter-spacing: .05em; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.ds-table td { padding: 11px 12px; border-bottom: 1px solid var(--line); color: var(--ink-2); }
.ds-table tr:hover td { background: var(--panel-2); }
.ds-field { width: 100%; font: var(--t-md)/1.4 var(--font-sans); color: var(--ink); background: var(--field);
  border: 1px solid var(--line-2); border-radius: var(--r2); padding: 10px 12px; }
.ds-field:focus { background: var(--panel); box-shadow: var(--ring); outline: none; }
.ds-empty { text-align: center; color: var(--muted); padding: var(--s7) var(--s4); border: 1px dashed var(--line-2); border-radius: var(--r3); }
`.trim();
}

function sanitizeHex(v?: string): string | null {
  if (!v) return null;
  const m = /^#?[0-9a-fA-F]{6}$/.exec(v.trim());
  return m ? (v.trim().startsWith("#") ? v.trim() : `#${v.trim()}`) : null;
}
