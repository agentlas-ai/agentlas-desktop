/**
 * Internal tool-call / host-protocol JSON is never answer text.
 *
 * Measured 2026-10-24 (real Windows 1.3.89, local qwen3:1.7b through the local tool loop):
 *  - a chat answer showed `{"name": "agentlas-ask", "arguments": {"question": …}}` as a JSON code block — the model
 *    wrote a tool request as text instead of calling a tool, so nothing ran it;
 *  - a Work answer showed `Host work reference: {"action_id":"…","step_id":"runtime"}` — the model echoed the host's
 *    internal work identity that the local tool loop appends to tool results (runtime/local-tool-loop.ts).
 *
 * Same principle as the `<<agentlas-surface>>` backstop (electron/mcp/final-display-backstop.ts): detection is a host
 * function on the final answer, never a prompt rule, and it is strict — only payloads with the exact protocol shape
 * are touched, so JSON the person asked for stays:
 *  - a tool call is `{name, arguments|parameters}` (optionally `id`/`type`) or `{type:"function", function:{name,
 *    arguments}}` whose name is an Agentlas/MCP host tool, or any such call inside `<tool_call>…</tool_call>`;
 *  - a work reference is an object whose keys are only `action_id`/`step_id`/`regenerate_read` with a string action_id.
 * Tool calls are replaced by one plain notice (they were not run); work references are dropped silently (the action
 * they name did run — the reference is bookkeeping, not content).
 *
 * Pure and dependency-free so Main, the daemon and the renderer can share it.
 */

export interface ProtocolPayloadStripResult {
  text: string;
  toolCalls: number;
  workReferences: number;
}

/** Host tool names a model may spell as text: Agentlas tools, MCP-qualified names, and the turn/harness tools. */
const HOST_TOOL_NAME = /^(?:agentlas[-_.:]|mcp__|agentlas$|harness_call$|read_tool_result$|ask_user$|ask_form$|one_chat_send$|goal_complete$)/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:\-]{0,127}$/;
const TOOL_CALL_KEYS = new Set(["name", "arguments", "parameters", "id", "type"]);
const WORK_REFERENCE_KEYS = new Set(["action_id", "step_id", "regenerate_read"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function argumentsLike(value: unknown): boolean {
  if (isPlainObject(value)) return true;
  if (typeof value !== "string") return false;
  try {
    return isPlainObject(JSON.parse(value));
  } catch {
    return false;
  }
}

function toolCallName(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  if (value.type === "function" && isPlainObject(value.function)) {
    const fn = value.function;
    const keys = Object.keys(value);
    if (keys.some((key) => !["type", "function", "id"].includes(key))) return null;
    return typeof fn.name === "string" && argumentsLike(fn.arguments ?? fn.parameters) ? fn.name : null;
  }
  const keys = Object.keys(value);
  if (!keys.includes("name") || keys.some((key) => !TOOL_CALL_KEYS.has(key))) return null;
  const args = "arguments" in value ? value.arguments : value.parameters;
  if (!("arguments" in value) && !("parameters" in value)) return null;
  return typeof value.name === "string" && argumentsLike(args) ? value.name : null;
}

type PayloadKind = "tool-call" | "work-reference";

function classify(value: unknown, insideToolCallTag: boolean): PayloadKind | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const kinds = value.map((item) => classify(item, insideToolCallTag));
    return kinds.every((kind) => kind === "tool-call") ? "tool-call" : null;
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => WORK_REFERENCE_KEYS.has(key))
    && typeof value.action_id === "string" && value.action_id.trim()
    && (value.step_id === undefined || typeof value.step_id === "string")) {
    return "work-reference";
  }
  const name = toolCallName(value);
  if (!name || !IDENTIFIER.test(name)) return null;
  return insideToolCallTag || HOST_TOOL_NAME.test(name) ? "tool-call" : null;
}

/** Index of the bracket closing the JSON value opening at `start`, string- and escape-aware; -1 when it never closes. */
function endOfJson(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  const limit = Math.min(text.length, start + MAX_PAYLOAD_CHARS);
  for (let index = start; index < limit; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return char === close ? index : -1;
    }
  }
  return -1;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A protocol payload is small; never scan further than this from one opening brace. */
const MAX_PAYLOAD_CHARS = 16_384;
/** Adversarial output (thousands of unclosed `{"name"`) must stay bounded. */
const MAX_CANDIDATES = 256;

/** A cheap pre-filter so long answers are not parsed at every brace. */
const CANDIDATE_START = /^[{[]\s*(?:\{\s*)?"(?:name|type|action_id|step_id|function|id|regenerate_read)"/;

interface Span { start: number; end: number; kind: PayloadKind }

const TOOL_CALL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const FENCE = /(^|\n)([ \t]*)```[^\n`]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/g;

function collectSpans(text: string): Span[] {
  const spans: Span[] = [];
  const covered = (start: number, end: number) => spans.some((span) => start < span.end && end > span.start);
  // 1. Qwen/Hermes chat-template tags: the content is a tool call whatever its name.
  for (const match of text.matchAll(TOOL_CALL_TAG)) {
    const inner = match[1].replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
    if (classify(parseJson(inner), true) === "tool-call") {
      spans.push({ start: match.index!, end: match.index! + match[0].length, kind: "tool-call" });
    }
  }
  // 2. A code fence whose whole body is one protocol payload.
  for (const match of text.matchAll(FENCE)) {
    const start = match.index! + match[1].length;
    const end = match.index! + match[0].length;
    if (covered(start, end)) continue;
    const kind = classify(parseJson(match[3].trim()), false);
    if (kind) spans.push({ start, end, kind });
  }
  // 3. Bare or inline-code JSON in prose.
  let candidates = 0;
  for (let index = 0; index < text.length && candidates < MAX_CANDIDATES; index += 1) {
    const char = text[index];
    if (char !== "{" && char !== "[") continue;
    if (covered(index, index + 1)) continue;
    if (!CANDIDATE_START.test(text.slice(index, index + 48))) continue;
    candidates += 1;
    const end = endOfJson(text, index);
    if (end < 0) continue;
    const kind = classify(parseJson(text.slice(index, end + 1)), false);
    if (!kind) continue;
    let start = index;
    let stop = end + 1;
    if (text[start - 1] === "`" && text[stop] === "`") {
      start -= 1;
      stop += 1;
    }
    spans.push({ start, end: stop, kind });
    index = stop - 1;
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** What is left of a line that only labelled a removed work reference ("🔧 **Host work reference**:"). */
const LABEL_LEAD = String.raw`^[\s>*_\x60~\-•·:|\p{Extended_Pictographic}️]*`;
const LABEL_WORDS = String.raw`(?:(?:host\s+)?work\s+reference|_?agentlas_work(?:\.action_id)?|action[_\s]id|(?:호스트\s*)?작업\s*참조)`;
const LABEL_TAIL = String.raw`[\s*_\x60:.|\p{Extended_Pictographic}️]*$`;
/** Empty, decoration only, or decoration around a label. */
const WORK_REFERENCE_LABEL = new RegExp(`${LABEL_LEAD}${LABEL_WORDS}?${LABEL_TAIL}`, "iu");
/** A line that names the reference (checked on the line above a reference that stood on its own line). */
const WORK_REFERENCE_LABEL_ONLY = new RegExp(`${LABEL_LEAD}${LABEL_WORDS}${LABEL_TAIL}`, "iu");

export function stripProtocolPayloads(input: string): ProtocolPayloadStripResult {
  if (typeof input !== "string" || (!input.includes("{") && !input.includes("["))) {
    return { text: typeof input === "string" ? input : "", toolCalls: 0, workReferences: 0 };
  }
  const spans = collectSpans(input);
  if (spans.length === 0) return { text: input, toolCalls: 0, workReferences: 0 };
  let out = "";
  let cursor = 0;
  const touchedLines = new Set<number>();
  for (const span of spans) {
    out += input.slice(cursor, span.start);
    if (span.kind === "work-reference") touchedLines.add(out.split("\n").length - 1);
    cursor = span.end;
  }
  out += input.slice(cursor);
  const lines = out.split("\n");
  const drop = new Set<number>();
  for (const index of touchedLines) {
    if (!WORK_REFERENCE_LABEL.test(lines[index] ?? "")) continue;
    drop.add(index);
    // `Host work reference:` on one line and the JSON alone on the next: the label goes with it.
    if (!WORK_REFERENCE_LABEL_ONLY.test(lines[index] ?? "") && index > 0 && WORK_REFERENCE_LABEL_ONLY.test(lines[index - 1])) {
      drop.add(index - 1);
    }
  }
  const kept = lines.filter((_line, index) => !drop.has(index));
  const text = kept.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    text,
    toolCalls: spans.filter((span) => span.kind === "tool-call").length,
    workReferences: spans.filter((span) => span.kind === "work-reference").length,
  };
}

export function protocolToolCallNotice(locale: string): string {
  return locale === "ko"
    ? "모델이 도구를 실행하지 않고 도구 요청을 글로 적어서, 그 요청은 실행되지 않았어요."
    : "The model wrote a tool request as text instead of running the tool, so that request was not run.";
}

/** Display text without protocol payloads; a removed tool call leaves one plain notice so the gap is explained. */
export function sanitizeProtocolPayloads(input: string, locale: string): { text: string; changed: boolean } {
  const result = stripProtocolPayloads(input);
  if (result.toolCalls === 0 && result.workReferences === 0) return { text: input, changed: false };
  const notice = result.toolCalls > 0 ? protocolToolCallNotice(locale) : "";
  const text = [result.text, notice].filter(Boolean).join("\n\n");
  return { text, changed: true };
}
