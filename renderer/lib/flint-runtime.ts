import type { AgentlasSurfaceFlintInput, JsonObject } from "@/lib/types";

/** Input accepted by the local chart runtime. Data is deliberately inline. */
export type FlintChartRenderInput = AgentlasSurfaceFlintInput & {
  data: { values: JsonObject[] };
};

export interface FlintChartRenderHandle {
  destroy(): void;
}

const MAX_INPUT_BYTES = 300_000;
const MAX_ROWS = 2_000;
const MAX_COLUMNS = 64;
const MAX_ENCODINGS = 12;
const MIN_WIDTH = 160;
const MAX_WIDTH = 1_200;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 900;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeKey(key: string): boolean {
  return key.length >= 1
    && key.length <= 120
    && !["__proto__", "prototype", "constructor"].includes(key)
    && !/[\u0000-\u001F\u007F]/.test(key);
}

function finiteDimension(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cloneJson(value: unknown, path: string, depth = 0): unknown {
  if (depth > 6) throw new Error(`Flint input is too deeply nested (${path})`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Flint input contains a non-finite number (${path})`);
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item, index) => cloneJson(item, `${path}[${index}]`, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (!isSafeKey(key)) throw new Error(`Flint input contains an invalid key (${path}.${key})`);
      out[key] = cloneJson(item, `${path}.${key}`, depth + 1);
    }
    return out;
  }
  throw new Error(`Flint input contains an unsupported value (${path})`);
}

function normalizeInput(input: FlintChartRenderInput): FlintChartRenderInput {
  if (!isRecord(input) || !isRecord(input.data) || !Array.isArray(input.data.values)) {
    throw new Error("Flint chart data must use inline data.values");
  }
  if (!isRecord(input.chart_spec)) throw new Error("Flint chart_spec is required");
  const chartType = typeof input.chart_spec.chartType === "string" ? input.chart_spec.chartType.trim().slice(0, 80) : "";
  if (!chartType) throw new Error("Flint chart_spec.chartType is required");
  if (!isRecord(input.chart_spec.encodings) || Object.keys(input.chart_spec.encodings).length === 0) {
    throw new Error("Flint chart_spec.encodings is required");
  }
  if (Object.keys(input.chart_spec.encodings).length > MAX_ENCODINGS) throw new Error("Flint chart has too many encodings");
  if (input.data.values.length === 0 || input.data.values.length > MAX_ROWS) throw new Error(`Flint chart rows must be between 1 and ${MAX_ROWS}`);

  const rows = input.data.values.map((row, index) => {
    if (!isRecord(row)) throw new Error(`Flint chart row ${index + 1} is not an object`);
    return cloneJson(row, `data.values[${index}]`) as JsonObject;
  });
  const columns = new Set(rows.flatMap((row) => Object.keys(row)));
  if (columns.size === 0 || columns.size > MAX_COLUMNS) throw new Error(`Flint chart columns must be between 1 and ${MAX_COLUMNS}`);

  const encodings: Record<string, string | JsonObject> = {};
  for (const [channel, raw] of Object.entries(input.chart_spec.encodings)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(channel)) throw new Error(`Invalid Flint encoding channel: ${channel}`);
    if (typeof raw === "string") {
      if (!columns.has(raw)) throw new Error(`Flint encoding refers to missing field: ${raw}`);
      encodings[channel] = raw;
      continue;
    }
    if (!isRecord(raw)) throw new Error(`Invalid Flint encoding for channel: ${channel}`);
    const field = raw.field;
    if (field !== undefined && (typeof field !== "string" || !columns.has(field))) {
      throw new Error(`Flint encoding refers to missing field: ${String(field)}`);
    }
    encodings[channel] = cloneJson(raw, `chart_spec.encodings.${channel}`) as JsonObject;
  }

  const chartSpec: AgentlasSurfaceFlintInput["chart_spec"] = {
    chartType,
    encodings,
    ...(typeof input.chart_spec.title === "string" ? { title: input.chart_spec.title.slice(0, 240) } : {}),
    ...(typeof input.chart_spec.subtitle === "string" ? { subtitle: input.chart_spec.subtitle.slice(0, 240) } : {}),
    ...(isRecord(input.chart_spec.baseSize) ? {
      baseSize: {
        width: finiteDimension(input.chart_spec.baseSize.width, 560, MIN_WIDTH, MAX_WIDTH),
        height: finiteDimension(input.chart_spec.baseSize.height, 320, MIN_HEIGHT, MAX_HEIGHT),
      },
    } : {}),
    ...(isRecord(input.chart_spec.canvasSize) ? {
      canvasSize: {
        width: finiteDimension(input.chart_spec.canvasSize.width, 900, MIN_WIDTH, MAX_WIDTH),
        height: finiteDimension(input.chart_spec.canvasSize.height, 520, MIN_HEIGHT, MAX_HEIGHT),
      },
    } : {}),
    ...(isRecord(input.chart_spec.chartProperties)
      ? { chartProperties: cloneJson(input.chart_spec.chartProperties, "chart_spec.chartProperties") as JsonObject }
      : {}),
  };

  const normalized: FlintChartRenderInput = {
    data: { values: rows },
    chart_spec: chartSpec,
    ...(isRecord(input.semantic_types)
      ? { semantic_types: cloneJson(input.semantic_types, "semantic_types") as Record<string, string | JsonObject> }
      : {}),
    ...(typeof input.theme_spec === "string"
      ? { theme_spec: input.theme_spec.slice(0, 80) }
      : isRecord(input.theme_spec)
        ? { theme_spec: cloneJson(input.theme_spec, "theme_spec") as JsonObject }
        : {}),
    ...(isRecord(input.options) ? { options: cloneJson(input.options, "options") as JsonObject } : {}),
    ...(isRecord(input.field_display_names)
      ? { field_display_names: cloneJson(input.field_display_names, "field_display_names") as Record<string, string> }
      : {}),
  };
  const byteLength = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
  if (byteLength > MAX_INPUT_BYTES) throw new Error("Flint chart input is too large");
  return normalized;
}

/**
 * Compile and render one trusted, inline Flint chart. The heavy modules are
 * loaded only when a chart is actually visible, keeping the initial renderer
 * path small while still making the Desktop build fully offline-capable.
 */
export async function renderFlintChart(
  container: HTMLElement,
  input: FlintChartRenderInput,
): Promise<FlintChartRenderHandle> {
  const normalized = normalizeInput(input);
  const [{ assembleVegaLite }, vegaLite, vega, interpreter] = await Promise.all([
    import("flint-chart/vegalite"),
    import("vega-lite"),
    import("vega"),
    import("vega-interpreter"),
  ]);
  const assembled = assembleVegaLite(normalized as never);
  const compiled = vegaLite.compile(assembled).spec;
  // AST + vega-interpreter keeps the renderer CSP-safe; no Function constructor
  // is needed for chart expressions emitted by a Surface manifest.
  const runtime = vega.parse(compiled as never, undefined, { ast: true });
  const view = new vega.View(runtime, {
    renderer: "svg",
    container,
    hover: true,
    expr: interpreter.expressionInterpreter,
  });
  await view.runAsync();
  return {
    destroy() {
      view.finalize();
      container.replaceChildren();
    },
  };
}
