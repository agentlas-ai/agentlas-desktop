/**
 * 대화 안 HTML 시각물(```visual 펜스, 또는 에이전트가 만든 독립 .html) — 순수 함수, DOM 의존 없음.
 *
 * 오너 2026-09-29: Claude 데스크탑의 차트는 독립 HTML 로 내려받아진다. 우리 것도 그처럼 보이되,
 * 대화 안에 테두리·틀 없이 글의 일부처럼. 그래서:
 *  - 격리: <iframe sandbox="allow-scripts"> — same-origin 없음(부모 DOM·저장소·preload 접근 불가),
 *    top navigation·팝업·폼 없음. 문서 첫머리에 CSP 메타: 네트워크 0(connect/img/font/script 는
 *    인라인·data:·blob: 만). iframe csp 속성으로 한 번 더.
 *  - 높이: 문서 안의 작은 측정 스크립트가 postMessage 로 높이를 알린다. 부모는 event.source 가
 *    그 iframe 인지 확인한다(opaque origin 이라 origin 비교는 "null").
 *  - 모양: 우리 테마 토큰을 --av-* 변수로 넣고, 우리 기본 스타일(투명 배경·본문 폰트·옅은 격자·
 *    강조 하나)을 먼저 깐다. 레퍼런스 차트의 **디자인 언어**를 따르되 그 코드를 복사하지 않는다.
 */
import type { VisualThemeTokens } from "./chart-spec";
import { CHART_FENCE_LANGUAGES, visualPalette } from "./chart-spec";

export const VISUAL_FENCE_LANGUAGES = ["visual", "html-visual", "artifact-html"] as const;
export const VISUAL_HTML_MAX_BYTES = 512 * 1024;
export const VISUAL_MAX_HEIGHT = 1_600;
export const VISUAL_SIZE_MESSAGE = "agentlas-visual:size";
export const VISUAL_PROMPT_MESSAGE = "agentlas-visual:prompt";

/** 네트워크 0. 인라인 스크립트·스타일과 data:/blob: 자원만. */
export const VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** iframe sandbox — allow-scripts 하나만. allow-same-origin 을 절대 같이 주지 않는다. */
export const VISUAL_SANDBOX = "allow-scripts";

export type VisualHtmlRejectCode = "empty" | "too-large" | "meta-refresh" | "base-tag";

const VISUAL_FENCE_LINE_RE = new RegExp(
  `^\`\`\`(?:${[...CHART_FENCE_LANGUAGES, ...VISUAL_FENCE_LANGUAGES].map((lang) => lang.replace(/[+.]/g, "\\$&")).join("|")})(?:[ \t][^\n]*)?$`,
  "im",
);

/**
 * 답에 차트·시각물 펜스가 있는가 — 있으면 One 은 그 답의 말풍선 바탕·테두리를 걷는다(오너 2026-09-29
 * "챗창에 경계선 없게", Claude 처럼 차트가 대화 바탕 위에 바로). 없는 답은 지금 말풍선 그대로.
 */
export function hasInlineVisualBlock(text: string | undefined | null): boolean {
  return typeof text === "string" && text.includes("```") && VISUAL_FENCE_LINE_RE.test(text);
}

export function isVisualFenceLanguage(lang: string): boolean {
  return (VISUAL_FENCE_LANGUAGES as readonly string[]).includes(lang.trim().toLowerCase());
}

export function screenVisualHtml(html: string): { ok: true } | { ok: false; code: VisualHtmlRejectCode } {
  if (!html.trim()) return { ok: false, code: "empty" };
  if (new TextEncoder().encode(html).byteLength > VISUAL_HTML_MAX_BYTES) return { ok: false, code: "too-large" };
  // CSP 는 탐색(navigation)을 막지 못한다. 문서가 스스로 다른 주소로 넘어가는 자리는 먼저 거절하고,
  // 스크립트로 넘어가는 경우는 부모가 두 번째 load 를 보고 막는다.
  if (/<meta[^>]+http-equiv\s*=\s*["']?\s*refresh/i.test(html)) return { ok: false, code: "meta-refresh" };
  if (/<base[\s>]/i.test(html)) return { ok: false, code: "base-tag" };
  return { ok: true };
}

export function visualRejectMessage(code: VisualHtmlRejectCode, ko: boolean): string {
  const messages: Record<VisualHtmlRejectCode, [string, string]> = {
    "empty": ["시각물 내용이 비어 있어요.", "The visual is empty."],
    "too-large": ["시각물이 너무 커서 대화 안에 띄우지 않았어요.", "The visual is too large to show inline."],
    "meta-refresh": ["안전 규칙 때문에 띄우지 않았어요: 다른 주소로 넘어가는 문서예요.", "Not shown for safety: the document redirects elsewhere."],
    "base-tag": ["안전 규칙 때문에 띄우지 않았어요: <base> 태그는 쓸 수 없어요.", "Not shown for safety: <base> tags are not allowed."],
  };
  return messages[code][ko ? 0 : 1];
}

function cssString(value: string | undefined): string {
  return String(value ?? "").replace(/[<>\\]/g, "");
}

/**
 * 시각물 문서에 여는 CSS 변수. 두 이름 체계를 같이 준다:
 *  - --color-text-primary 류: Claude show_widget 계약과 같은 이름(모델이 이미 아는 이름이라 그대로 쓰게).
 *  - --av-* 류: 1차에서 안내한 이름(하위 호환).
 * 값은 모두 우리 테마 토큰에서 오므로 다크 모드를 따른다.
 */
export function visualCssVariables(tokens: VisualThemeTokens): Record<string, string> {
  const palette = visualPalette(tokens).map(cssString);
  const vars: Record<string, string> = {
    "--color-text-primary": tokens.ink,
    "--color-text-secondary": tokens.inkSoft,
    "--color-text-tertiary": tokens.tick,
    "--color-background-primary": tokens.paper,
    "--color-background-secondary": tokens.paperAlt,
    "--color-border-tertiary": tokens.grid,
    "--color-accent": tokens.accent,
    "--font-sans": tokens.font,
    "--border-radius-md": "8px",
    "--border-radius-lg": "12px",
    "--av-ink": tokens.ink,
    "--av-ink-soft": tokens.inkSoft,
    "--av-tick": tokens.tick,
    "--av-grid": tokens.grid,
    "--av-paper": tokens.paper,
    "--av-accent": tokens.accent,
    "--av-font": tokens.font,
  };
  palette.forEach((color, index) => {
    vars[`--color-chart-${index + 1}`] = color;
    vars[`--av-c${index + 1}`] = color;
  });
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, cssString(value)]));
}

/** 우리 시각 언어(실측 디자인): 투명 바탕, 제목 13/500 + 부제 12 회색, 범례 10px 둥근 사각, 눈금 11px, 가로 격자만. */
export function visualBaseCss(tokens: VisualThemeTokens): string {
  const vars = Object.entries(visualCssVariables(tokens)).map(([key, value]) => `${key}:${value};`).join("");
  // color-scheme 을 바꾸지 않는다 — 부모와 다르면 Chromium 이 iframe 바탕을 불투명하게 칠한다(다크 실측).
  return `:root{${vars}}
html,body{margin:0;padding:0;background:transparent;color:var(--color-text-primary);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;overflow:hidden}
body{display:flow-root}
*{box-sizing:border-box}
h1,h2,h3,.av-title{font-size:13px;font-weight:500;margin:0 0 3px;color:var(--color-text-primary);letter-spacing:0}
.av-subtitle,p.av-note,.av-note{font-size:12px;color:var(--color-text-secondary);margin:0 0 8px}
.av-source{font-size:11px;color:var(--color-text-tertiary);margin-top:8px}
.av-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--color-text-primary);margin:0 0 10px}
.av-legend i,.av-legend .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.av-kpis{display:flex;flex-wrap:wrap;gap:28px;margin:4px 0 14px}
.av-kpi b{display:block;font-size:22px;font-weight:500;color:var(--color-text-primary);font-variant-numeric:tabular-nums}
.av-kpi span{font-size:12px;color:var(--color-text-secondary)}
svg{display:block;max-width:100%;height:auto;overflow:visible}
svg text{fill:var(--color-text-tertiary);font-family:var(--font-sans);font-size:11px}
svg .av-label{fill:var(--color-text-primary);font-weight:500}
svg .av-grid line,svg line.av-grid{stroke:var(--color-border-tertiary);stroke-width:1;shape-rendering:crispEdges}
table{border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
th{font-weight:500;text-align:left;color:var(--color-text-secondary);border-bottom:1px solid var(--color-border-tertiary);padding:4px 10px 4px 0}
td{padding:4px 10px 4px 0;border-bottom:1px solid var(--color-border-tertiary)}
td.num,th.num{text-align:right}
button{font:inherit;font-size:12px;color:var(--color-text-primary);background:var(--color-background-secondary);border:1px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);padding:5px 10px;cursor:pointer}`;
}

/** 높이 알림 — 이 문서 안에서만 돈다. 부모 DOM 에 접근하지 못한다(opaque origin). */
function sizeReporter(frameId: string): string {
  const id = JSON.stringify(frameId);
  return `(function(){var id=${id},last=-1;function report(){var d=document.documentElement,b=document.body;if(!b)return;var h=Math.ceil(b.getBoundingClientRect().height);if(h!==last){last=h;parent.postMessage({type:${JSON.stringify(VISUAL_SIZE_MESSAGE)},id:id,height:h},"*");}}
try{var ro=new ResizeObserver(report);ro.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)ro.observe(document.body);});}catch(e){}
window.sendPrompt=function(t){try{parent.postMessage({type:"agentlas-visual:prompt",id:id,text:String(t==null?"":t).slice(0,2000)},"*");}catch(e){}};
window.addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type==="agentlas-visual:overflow"){document.documentElement.style.overflow="auto";if(document.body)document.body.style.overflow="auto";}});
window.addEventListener("load",report);document.addEventListener("DOMContentLoaded",report);setTimeout(report,60);setTimeout(report,400);})();`;
}

/**
 * 격리 문서를 만든다. CSP 메타를 가장 먼저 둔다 — 그 뒤에 파싱되는 모든 자원에 적용된다.
 * 에이전트 HTML 이 자기 <html>/<head> 를 가져와도 파서가 한 문서로 합친다.
 */
export function buildVisualSrcdoc(html: string, tokens: VisualThemeTokens, frameId: string): string {
  const csp = VISUAL_CSP.replace(/"/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${visualBaseCss(tokens)}</style><script>${sizeReporter(frameId)}</script></head><body>${html}</body></html>`;
}

/** 저장(내려받기)용 독립 문서 — 같은 CSP·스타일, 높이 알림 스크립트는 뺀다. */
export function buildStandaloneVisualHtml(html: string, tokens: VisualThemeTokens, title: string): string {
  const csp = VISUAL_CSP.replace(/"/g, "");
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${safeTitle}</title><style>${visualBaseCss(tokens).replace("overflow:hidden", "overflow:auto")}
body{max-width:880px;margin:32px auto;padding:0 24px;background:${cssString(tokens.paper)}}</style></head><body>${html}</body></html>`;
}

/**
 * 펜스 정보 줄의 제목 — ```visual title=q3_summary (Claude show_widget 의 title 과 같은 쓰임: 저장 파일명).
 * 영숫자·밑줄·하이픈·한글만 남긴다.
 */
export function fenceTitle(info: string | undefined): string | null {
  const match = info?.match(/(?:^|\s)title\s*=\s*(?:"([^"]{1,80})"|'([^']{1,80})'|(\S{1,80}))/);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  const clean = raw?.replace(/[^\p{L}\p{N}_ -]+/gu, "").trim();
  return clean || null;
}

/** 첫 제목(h1~h3·title·.av-title)을 이름으로 — 산출물 목록·저장 파일명에 쓴다. */
export function visualTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)
    ?? html.match(/<h[1-3][^>]*>([^<]{1,120})<\/h[1-3]>/i)
    ?? html.match(/class=["'][^"']*av-title[^"']*["'][^>]*>([^<]{1,120})</i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title || fallback;
}
