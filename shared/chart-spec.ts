/**
 * 대화 안 차트 블록(```chart / ```vega-lite)의 공통 안전 관문 — 순수 함수, DOM·vega 의존 없음.
 *
 * 모델이 쓴 Vega-Lite JSON 은 "코드가 아니라 데이터" 여야 한다(Jupyter MIME 번들과 같은 생각).
 * 그래서 네트워크를 부르거나 식을 평가하는 자리는 **통째로 거절**한다. 조용히 벗겨내면 모델이
 * 뜻한 것과 다른 차트가 그려지고, 사람은 그것이 틀렸다는 걸 모른다. 거절되면 원문 코드블록과
 * 사유 한 줄이 남는다.
 *
 * 렌더는 vega 의 AST 해석기(vega-interpreter)로 한다 — Function 생성자를 쓰지 않는다(CSP).
 * 식을 여기서 막는 것은 그 위에 한 겹 더: 공격면을 0 으로 만든다(CVE-2025-59840 류).
 */

export const CHART_FENCE_LANGUAGES = ["chart", "vega-lite", "vegalite", "vega-lite+json", "vl"] as const;

export const CHART_SPEC_LIMITS = {
  maxBytes: 200_000,
  maxRows: 5_000,
  maxDepth: 16,
  maxArray: 5_000,
  maxKeys: 200,
  maxString: 2_000,
} as const;

export type ChartSpecRejectCode =
  | "empty"
  | "too-large"
  | "invalid-json"
  | "not-an-object"
  | "too-deep"
  | "too-many-items"
  | "forbidden-key"
  | "forbidden-value"
  | "expression"
  | "remote-data"
  | "no-inline-data"
  | "too-many-rows"
  | "unsupported-mark"
  | "unsupported-transform"
  | "full-vega";

export type ChartSpecResult =
  | { ok: true; spec: Record<string, unknown>; rows: number }
  | { ok: false; code: ChartSpecRejectCode; path: string };

export function isChartFenceLanguage(lang: string): boolean {
  return (CHART_FENCE_LANGUAGES as readonly string[]).includes(lang.trim().toLowerCase());
}

/** 네트워크·식·프로토타입을 건드리는 키. 어느 깊이에 있어도 거절. */
const FORBIDDEN_KEYS = new Set([
  "url", "href", "loader", "usermeta", "$ref",
  "__proto__", "prototype", "constructor",
]);
/** 식(expression) 자리. vega-interpreter 가 있어도 모델 차트에는 필요 없다 — 계산된 값을 data.values 에. */
const EXPRESSION_KEYS = new Set(["expr", "signal", "labelExpr", "calculate"]);
const FORBIDDEN_CHANNELS = new Set(["href", "url"]);
const ALLOWED_MARKS = new Set([
  "arc", "area", "bar", "boxplot", "circle", "errorband", "errorbar", "line", "point",
  "rect", "rule", "square", "text", "tick", "trail",
]);
const ALLOWED_TRANSFORMS = new Set([
  "aggregate", "bin", "timeUnit", "fold", "pivot", "window", "joinaggregate", "stack",
  "density", "regression", "loess", "flatten", "sample", "impute", "quantile", "filter",
]);
const SCHEMA_RE = /^https:\/\/vega\.github\.io\/schema\/vega-lite\/v\d+(?:\.\d+)*\.json$/;
const UNSAFE_STRING_RE = /^\s*(?:javascript|vbscript|data|https?|file|ftp|wss?|blob):/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class Reject extends Error {
  constructor(readonly code: ChartSpecRejectCode, readonly path: string) {
    super(code);
  }
}

/**
 * 데이터 행(data.values·datasets)은 그려질 값일 뿐이다 — href/url 채널과 image 마크를 막았으므로
 * 행 안의 "https://…" 문자열은 글자로만 보인다. 여기서는 크기·유한수·프로토타입 키만 본다.
 */
function walkData(value: unknown, path: string, depth: number): void {
  if (depth > CHART_SPEC_LIMITS.maxDepth) throw new Reject("too-deep", path);
  if (typeof value === "string") {
    if (value.length > CHART_SPEC_LIMITS.maxString) throw new Reject("too-many-items", path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Reject("forbidden-value", path);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > CHART_SPEC_LIMITS.maxArray) throw new Reject("too-many-items", path);
    value.forEach((item, index) => walkData(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new Reject("forbidden-value", path);
  const keys = Object.keys(value);
  if (keys.length > CHART_SPEC_LIMITS.maxKeys) throw new Reject("too-many-items", path);
  for (const key of keys) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Reject("forbidden-key", `${path}.${key}`);
    walkData(value[key], `${path}.${key}`, depth + 1);
  }
}

function walk(value: unknown, path: string, depth: number): void {
  if (depth > CHART_SPEC_LIMITS.maxDepth) throw new Reject("too-deep", path);
  if (typeof value === "string") {
    if (UNSAFE_STRING_RE.test(value)) throw new Reject("forbidden-value", path);
    if (value.length > CHART_SPEC_LIMITS.maxString) throw new Reject("too-many-items", path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Reject("forbidden-value", path);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > CHART_SPEC_LIMITS.maxArray) throw new Reject("too-many-items", path);
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new Reject("forbidden-value", path);
  const keys = Object.keys(value);
  if (keys.length > CHART_SPEC_LIMITS.maxKeys) throw new Reject("too-many-items", path);
  for (const key of keys) {
    const at = `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) throw new Reject(key === "url" ? "remote-data" : "forbidden-key", at);
    if (EXPRESSION_KEYS.has(key)) throw new Reject("expression", at);
    const item = value[key];
    if (key === "datasets" && isRecord(item)) {
      for (const [name, rows] of Object.entries(item)) {
        if (FORBIDDEN_KEYS.has(name)) throw new Reject("forbidden-key", `${at}.${name}`);
        walkData(rows, `${at}.${name}`, depth + 2);
      }
      continue;
    }
    if (key === "values" && path.endsWith(".data")) {
      walkData(item, at, depth + 1);
      continue;
    }
    // 문자열 술어("datum.x > 3")는 식이다. 객체 술어({field, gt})만 받는다.
    if ((key === "filter" || key === "test") && typeof item === "string") throw new Reject("expression", at);
    if (key === "mark" && !path.includes(".config")) {
      const type = typeof item === "string" ? item : isRecord(item) ? item.type : undefined;
      if (typeof type !== "string" || !ALLOWED_MARKS.has(type)) throw new Reject("unsupported-mark", at);
    }
    if (key === "encoding" && isRecord(item)) {
      for (const channel of Object.keys(item)) {
        if (FORBIDDEN_CHANNELS.has(channel)) throw new Reject("forbidden-key", `${at}.${channel}`);
      }
    }
    if (key === "transform") {
      if (!Array.isArray(item)) throw new Reject("unsupported-transform", at);
      item.forEach((step, index) => {
        if (!isRecord(step)) throw new Reject("unsupported-transform", `${at}[${index}]`);
        const exprKey = Object.keys(step).find((name) => EXPRESSION_KEYS.has(name));
        if (exprKey) throw new Reject("expression", `${at}[${index}].${exprKey}`);
        if (typeof step.filter === "string") throw new Reject("expression", `${at}[${index}].filter`);
        const kind = Object.keys(step).find((name) => ALLOWED_TRANSFORMS.has(name));
        if (!kind) throw new Reject("unsupported-transform", `${at}[${index}]`);
      });
    }
    walk(item, at, depth + 1);
  }
}

/** data.values 가 있는 곳을 모두 세고, data 가 인라인이 아니면 거절한다. */
function countInlineRows(value: unknown, path: string, depth = 0): { rows: number; hasData: boolean } {
  if (depth > CHART_SPEC_LIMITS.maxDepth || !value || typeof value !== "object") return { rows: 0, hasData: false };
  if (Array.isArray(value)) {
    return value.reduce<{ rows: number; hasData: boolean }>((acc, item, index) => {
      const next = countInlineRows(item, `${path}[${index}]`, depth + 1);
      return { rows: acc.rows + next.rows, hasData: acc.hasData || next.hasData };
    }, { rows: 0, hasData: false });
  }
  let rows = 0;
  let hasData = false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "data") {
      if (item === null) continue;
      if (!isRecord(item)) throw new Reject("no-inline-data", `${path}.data`);
      if (Array.isArray(item.values)) {
        rows += item.values.length;
        hasData = true;
      } else if (isRecord(item.sequence) || item.sphere === true || isRecord(item.graticule)) {
        hasData = true;
      } else if (typeof item.name === "string" && Object.keys(item).length === 1) {
        // 이름만 있는 자리는 datasets 를 가리킨다 — datasets 는 아래에서 센다.
        hasData = true;
      } else {
        throw new Reject("no-inline-data", `${path}.data`);
      }
      continue;
    }
    if (key === "datasets" && isRecord(item)) {
      for (const [name, values] of Object.entries(item)) {
        if (!Array.isArray(values)) throw new Reject("no-inline-data", `${path}.datasets.${name}`);
        rows += values.length;
        hasData = true;
      }
      continue;
    }
    const next = countInlineRows(item, `${path}.${key}`, depth + 1);
    rows += next.rows;
    hasData = hasData || next.hasData;
  }
  return { rows, hasData };
}

/**
 * 원문(펜스 본문) 또는 이미 파싱된 값을 받아, 그려도 되는 Vega-Lite 스펙만 돌려준다.
 * 돌려주는 스펙은 깊은 사본이다 — 원문 객체를 vega 에 넘기지 않는다.
 */
export function sanitizeChartSpec(input: unknown): ChartSpecResult {
  try {
    let parsed: unknown = input;
    if (typeof input === "string") {
      const text = input.trim();
      if (!text) throw new Reject("empty", "$");
      if (new TextEncoder().encode(text).byteLength > CHART_SPEC_LIMITS.maxBytes) throw new Reject("too-large", "$");
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Reject("invalid-json", "$");
      }
    }
    if (!isRecord(parsed)) throw new Reject("not-an-object", "$");
    const spec = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > CHART_SPEC_LIMITS.maxBytes) throw new Reject("too-large", "$");
    // $schema 는 공식 Vega-Lite 스키마만. Vega(전체 문법)는 받지 않는다.
    if ("$schema" in spec) {
      const schema = spec.$schema;
      if (typeof schema !== "string" || !SCHEMA_RE.test(schema)) {
        throw new Reject(typeof schema === "string" && /schema\/vega\/v/.test(schema) ? "full-vega" : "forbidden-value", "$.$schema");
      }
      delete spec.$schema;
    }
    // Vega 전체 문법의 표지 — Vega-Lite 가 아니다.
    if (Array.isArray(spec.signals) || Array.isArray(spec.marks) || Array.isArray(spec.scales)) throw new Reject("full-vega", "$");
    walk(spec, "$", 0);
    const { rows, hasData } = countInlineRows(spec, "$");
    if (!hasData) throw new Reject("no-inline-data", "$.data");
    if (rows > CHART_SPEC_LIMITS.maxRows) throw new Reject("too-many-rows", "$.data");
    return { ok: true, spec, rows };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, code: error.code, path: error.path };
    return { ok: false, code: "invalid-json", path: "$" };
  }
}

/** 거절 사유를 사람 말로 — 기계 코드를 화면에 내지 않는다. */
export function chartRejectMessage(code: ChartSpecRejectCode, ko: boolean): string {
  const messages: Record<ChartSpecRejectCode, [string, string]> = {
    "empty": ["차트 내용이 비어 있어요.", "The chart is empty."],
    "too-large": ["차트가 너무 커서 그리지 않았어요.", "The chart is too large to draw."],
    "invalid-json": ["차트 JSON 을 읽을 수 없어요.", "The chart JSON could not be read."],
    "not-an-object": ["차트 형식이 아니에요.", "This is not a chart specification."],
    "too-deep": ["차트 구조가 너무 깊어요.", "The chart is nested too deeply."],
    "too-many-items": ["차트 항목이 너무 많아요.", "The chart has too many items."],
    "forbidden-key": ["안전 규칙 때문에 그리지 않았어요: 링크·외부 자원은 쓸 수 없어요.", "Not drawn for safety: links and external resources are not allowed."],
    "forbidden-value": ["안전 규칙 때문에 그리지 않았어요: 주소(URL)는 쓸 수 없어요.", "Not drawn for safety: URLs are not allowed."],
    "expression": ["안전 규칙 때문에 그리지 않았어요: 식(expression)은 쓸 수 없어요. 계산된 값을 데이터에 넣어 주세요.", "Not drawn for safety: expressions are not allowed. Put computed values in the data."],
    "remote-data": ["안전 규칙 때문에 그리지 않았어요: 데이터는 차트 안에 직접 넣어야 해요.", "Not drawn for safety: data must be inline, not loaded from a URL."],
    "no-inline-data": ["차트에 데이터(data.values)가 없어요.", "The chart has no inline data (data.values)."],
    "too-many-rows": [`행이 ${CHART_SPEC_LIMITS.maxRows.toLocaleString()}개를 넘어요.`, `More than ${CHART_SPEC_LIMITS.maxRows.toLocaleString()} rows.`],
    "unsupported-mark": ["지원하지 않는 차트 모양이에요.", "Unsupported mark type."],
    "unsupported-transform": ["지원하지 않는 변환이 있어요.", "Unsupported transform."],
    "full-vega": ["Vega-Lite 만 그립니다(전체 Vega 문법은 받지 않아요).", "Only Vega-Lite is drawn (full Vega is not accepted)."],
  };
  return messages[code][ko ? 0 : 1];
}

export interface VisualThemeTokens {
  /** 본문 글자(제목·범례 라벨). */
  ink: string;
  /** 보조 글자(부제). */
  inkSoft: string;
  /** 눈금 글자(3순위). */
  tick: string;
  /** 가로 격자선 — 아주 옅은 따뜻한 회색. */
  grid: string;
  /** 대화 바탕. */
  paper: string;
  /** 보조 바탕(카드·눌림). */
  paperAlt: string;
  accent: string;
  font: string;
  dark: boolean;
}

/**
 * 데이터 색 — 파랑·코랄 두 주색, 그 뒤는 같은 채도의 차분한 확장(청록·호박·보라·회색).
 * Claude 데스크탑 인라인 차트의 실측(2026-09-29, #3965cb/#df6738)을 따르되 다크에서는 한 단계 밝힌다.
 * 브랜드 강조색(--accent)은 데이터 색이 아니다 — 색은 계열 구분에만(Tufte·Bloomberg).
 */
export function visualPalette(tokens: VisualThemeTokens): string[] {
  return tokens.dark
    ? ["#6f93e6", "#ec8a5f", "#4fb3a2", "#d6ae52", "#a58ad8", "#9b9a93"]
    : ["#3965cb", "#df6738", "#2f8f7f", "#c08a1e", "#7d5fb8", "#8c8b85"];
}

/** 범례 견본: 모서리 2px 둥근 10px 사각형(단위 좌표 경로 — vega 가 크기만 곱한다). */
const LEGEND_SWATCH = "M-0.6,-1H0.6Q1,-1 1,-0.6V0.6Q1,1 0.6,1H-0.6Q-1,1 -1,0.6V-0.6Q-1,-1 -0.6,-1Z";

/**
 * Vega-Lite config — 실측 디자인(Claude 인라인 차트)과 data-ink:
 * 틀·축선·눈금선 없음, 가로 격자만 1px, 눈금 글자 11px 회색, 제목 13px/500 + 부제 12px 회색,
 * 범례는 플롯 위 왼쪽(10px 둥근 사각 + 12px 라벨, 16px 간격), 선 2px, 좁은 막대 위 모서리 2px, 플롯 높이 220px.
 * 모든 색은 화면 토큰에서 오므로 다크 모드를 따른다. 모델이 준 config 는 이 위에 얹는다(모델 쪽이 이긴다).
 */
export function chartThemeConfig(tokens: VisualThemeTokens): Record<string, unknown> {
  const palette = visualPalette(tokens);
  return {
    background: null,
    font: tokens.font,
    padding: { top: 0, right: 4, bottom: 0, left: 0 },
    view: { stroke: null, continuousWidth: 520, continuousHeight: 220, discreteHeight: 220 },
    title: {
      anchor: "start", frame: "bounds", color: tokens.ink, fontSize: 13, fontWeight: 500,
      subtitleColor: tokens.inkSoft, subtitleFontSize: 12, subtitleFontWeight: 400, subtitlePadding: 4, offset: 10,
    },
    axis: {
      domain: false, ticks: false, labelColor: tokens.tick, labelFontSize: 11, labelPadding: 8,
      titleColor: tokens.tick, titleFontSize: 11, titleFontWeight: 400, gridColor: tokens.grid, gridOpacity: 1, gridWidth: 1,
      labelFlush: false,
    },
    // 눈금 글자 한 개당 약 110~140px(실측 레퍼런스: 730px 에 6~7개). 폭에 따라 늘고 준다(띠 척도에는 무시됨).
    // 양 끝 글자는 플롯 안쪽으로 붙인다(labelFlush) — 마지막 날짜가 칸 밖으로 잘리던 것.
    axisX: { grid: false, labelOverlap: "greedy", labelSeparation: 12, labelAngle: 0, labelFlush: true, tickCount: { expr: "max(2, ceil(width / 110))" } },
    axisY: { grid: true, labelOverlap: true, tickCount: 6 },
    axisDiscrete: { labelAngle: 0, labelOverlap: true, labelLimit: 120 },
    legend: {
      orient: "top", direction: "horizontal", titleFontSize: 0, titlePadding: 0,
      symbolType: LEGEND_SWATCH, symbolSize: 100, symbolStrokeWidth: 0, symbolOpacity: 1,
      labelColor: tokens.ink, labelFontSize: 12, labelOffset: 6, columnPadding: 16, padding: 0, offset: 10,
    },
    range: { category: palette },
    scale: { bandPaddingInner: 0.28, bandPaddingOuter: 0.15, offsetBandPaddingInner: 0.55, offsetBandPaddingOuter: 0.3 },
    mark: { color: palette[0] },
    bar: { color: palette[0], cornerRadiusEnd: 2, continuousBandSize: 14 },
    line: { color: palette[0], strokeWidth: 2, interpolate: "monotone", strokeCap: "round", strokeJoin: "round", clip: true },
    point: { color: palette[0], filled: true, size: 34, opacity: 1 },
    circle: { size: 34, opacity: 1 },
    area: { color: palette[0], opacity: 0.18, line: { strokeWidth: 2 } },
    rule: { color: tokens.tick, strokeWidth: 1 },
    text: { color: tokens.ink, fontSize: 11 },
  };
}

/**
 * 모델이 제목을 안 준 축·범례에 필드 이름이 제목으로 붙는 것을 막는다(실측 디자인엔 축 제목이 없다).
 * 원본을 바꾸지 않고 사본을 돌려준다.
 */
export function quietDefaultTitles(spec: Record<string, unknown>): Record<string, unknown> {
  // 깊은 사본 위에서만 손댄다 — 관문을 통과한 원본(패널·산출물 목록이 같이 쥔다)을 바꾸지 않는다.
  return tightQuantitativeDomains(presentationDefaults(JSON.parse(JSON.stringify(spec)) as Record<string, unknown>));
}

/**
 * 연속 축의 범위를 데이터에 딱 맞는 "보기 좋은" 눈금으로(리뷰 2026-09-29).
 * vega-lite 기본 nice 는 눈금 10개 기준이라 ① 데이터가 맨 위·아래 격자선 밖으로 나가거나(2.7% < 3.0%)
 * ② 반대로 빈 띠가 크게 남았다(-63 인데 -80). 여기서는 1·2·2.5·5×10ⁿ 간격 중 눈금 4~8개로 데이터를 가장
 * 꽉 채우는 것을 골라 domain 과 눈금 값을 함께 준다 — 끝 눈금이 데이터 끝과 같거나 바로 바깥.
 * 인라인 데이터로 범위를 셀 수 없는 경우(집계·누적 막대·모델이 domain/nice/눈금을 준 경우)는 건드리지 않는다.
 */
export function niceTicks(min: number, max: number): { domain: [number, number]; ticks: number[] } | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  let best: { lo: number; hi: number; step: number; score: number } | null = null;
  const span = max - min;
  const base = Math.floor(Math.log10(span / 6));
  for (let power = base - 1; power <= base + 1; power += 1) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** power;
      const lo = Math.floor(min / step + 1e-9) * step;
      const hi = Math.ceil(max / step - 1e-9) * step;
      const count = Math.round((hi - lo) / step) + 1;
      if (count < 4 || count > 8) continue;
      // 꽉 참(데이터 폭/축 폭)이 먼저, 같으면 눈금 6개에 가까운 쪽, 2.5 는 살짝 불리하게.
      const score = span / (hi - lo) - Math.abs(count - 6) * 0.01 - (m === 2.5 ? 0.015 : 0);
      if (!best || score > best.score) best = { lo, hi, step, score };
    }
  }
  if (!best) return null;
  const decimals = Math.max(0, -Math.floor(Math.log10(best.step)) + 1);
  const round = (value: number) => Number(value.toFixed(decimals));
  const ticks: number[] = [];
  for (let value = best.lo; value <= best.hi + best.step / 2; value += best.step) ticks.push(round(value));
  return { domain: [round(best.lo), round(best.hi)], ticks };
}

type Unit = { def: Record<string, unknown>; mark: string; encoding: Record<string, unknown>; values: unknown[] | null };

function tightQuantitativeDomains(spec: Record<string, unknown>): Record<string, unknown> {
  const units: Unit[] = [];
  const collect = (node: unknown, inherited: unknown[] | null) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;
    const data = n.data as Record<string, unknown> | undefined;
    const values = data && Array.isArray(data.values) ? data.values : inherited;
    const markRaw = n.mark;
    const mark = typeof markRaw === "string" ? markRaw : markRaw && typeof markRaw === "object" ? String((markRaw as Record<string, unknown>).type ?? "") : "";
    if (mark && n.encoding && typeof n.encoding === "object") {
      units.push({ def: n, mark, encoding: n.encoding as Record<string, unknown>, values });
    }
    for (const key of ["layer", "concat", "hconcat", "vconcat"]) {
      if (Array.isArray(n[key])) (n[key] as unknown[]).forEach((child) => collect(child, values));
    }
    if (n.spec) collect(n.spec, values);
  };
  collect(spec, null);
  if (units.length === 0 || ["concat", "hconcat", "vconcat", "facet", "repeat"].some((key) => key in spec)) return spec;
  for (const channel of ["y", "x"] as const) {
    const defs = units.map((unit) => ({ unit, def: unit.encoding[channel] as Record<string, unknown> | undefined }))
      .filter((item) => item.def && item.def.type === "quantitative");
    if (defs.length === 0) continue;
    let usable = true;
    let includeZero = true;
    const numbers: number[] = [];
    for (const { unit, def } of defs) {
      const d = def as Record<string, unknown>;
      const scale = (d.scale ?? {}) as Record<string, unknown>;
      const axis = d.axis as Record<string, unknown> | null | undefined;
      const stackable = (unit.mark === "bar" || unit.mark === "area")
        && !unit.encoding[channel === "y" ? "xOffset" : "yOffset"]
        && (unit.encoding.color || unit.encoding.detail) && d.stack !== null && d.stack !== false;
      if (!unit.values || typeof d.field !== "string" || d.aggregate || d.bin || d.stack || stackable
        || scale.domain !== undefined || scale.nice !== undefined || scale.domainMin !== undefined || scale.domainMax !== undefined
        || (scale.type !== undefined && scale.type !== "linear")
        || (axis && (axis.values !== undefined || axis.tickCount !== undefined))) { usable = false; break; }
      if (scale.zero === false) includeZero = false;
      for (const row of unit.values) {
        const value = row && typeof row === "object" ? (row as Record<string, unknown>)[d.field] : undefined;
        if (typeof value === "number" && Number.isFinite(value)) numbers.push(value);
      }
    }
    if (!usable || numbers.length === 0) continue;
    let min = Math.min(...numbers);
    let max = Math.max(...numbers);
    if (includeZero) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const nice = niceTicks(min, max);
    if (!nice) continue;
    for (const { def } of defs) {
      const d = def as Record<string, unknown>;
      d.scale = { ...((d.scale ?? {}) as Record<string, unknown>), domain: nice.domain, nice: false };
      if (d.axis !== null) d.axis = { ...((d.axis ?? {}) as Record<string, unknown>), values: nice.ticks };
    }
  }
  return spec;
}

function presentationDefaults(spec: Record<string, unknown>): Record<string, unknown> {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
    const encoding = out.encoding;
    if (encoding && typeof encoding === "object" && !Array.isArray(encoding)) {
      const next: Record<string, unknown> = {};
      for (const [channel, def] of Object.entries(encoding as Record<string, unknown>)) {
        if (def && typeof def === "object" && !Array.isArray(def)
          && ["x", "y", "color", "strokeDash", "shape", "size", "opacity", "xOffset", "yOffset", "fill", "stroke"].includes(channel)
          && !("title" in (def as Record<string, unknown>))) {
          next[channel] = { ...(def as Record<string, unknown>), title: null };
        } else {
          next[channel] = def;
        }
      }
      // 범례 순서 = 데이터에 처음 나온 순서(가나다 정렬 아님, 리뷰 2026-09-29). 모델이 sort·domain 을 주면 그대로.
      for (const channel of ["color", "strokeDash", "shape", "fill", "stroke"]) {
        const def = next[channel] as Record<string, unknown> | undefined;
        if (!def || (def.type !== "nominal" && def.type !== undefined) || "sort" in def || !def.field) continue;
        const scale = def.scale as Record<string, unknown> | undefined;
        if (scale && scale.domain !== undefined) continue;
        next[channel] = { ...def, sort: null };
      }
      // 같은 필드를 색과 점선(또는 모양)에 같이 걸고 점선 쪽 legend:null 을 주면, vega-lite 가 두 범례를
      // 하나로 합치면서 null 이 이겨 범례가 통째로 사라진다(실측 2026-09-29). 합쳐질 쪽의 null 만 걷는다.
      const colorField = (next.color as Record<string, unknown> | undefined)?.field;
      for (const channel of ["strokeDash", "shape"]) {
        const def = next[channel] as Record<string, unknown> | undefined;
        if (def && colorField !== undefined && def.field === colorField && def.legend === null) {
          const { legend: _drop, ...rest } = def;
          void _drop;
          next[channel] = rest;
        }
      }
      out.encoding = next;
    }
    for (const key of ["layer", "concat", "hconcat", "vconcat", "spec"]) {
      if (key in out) out[key] = visit(out[key]);
    }
    return out;
  };
  return visit(spec) as Record<string, unknown>;
}
