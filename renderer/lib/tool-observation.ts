import { normalizeToolCall } from "@shared/tool-call-detail";
import { parseMcpResult, type McpResultBlock } from "@shared/mcp-result-rendering";

export const TOOL_OBSERVATION_TEXT_LIMIT = 12_000;
export const TOOL_OBSERVATION_RAW_LIMIT = 64_000;
const MAX_RESULT_INPUT = 2_500_000;
export type ToolObservationIcon = "camera" | "screen" | "search" | "browser" | "tool";

/** Display the actual typed operation; result prose never chooses an action. */
export function toolObservationAction(name: string, label: string, args: string | undefined, locale: "ko" | "en") {
  const boundedArgs = args && args.length <= 32_000 ? args : undefined;
  let suppliedLabel: string | undefined;
  try {
    const supplied = object(boundedArgs ? JSON.parse(boundedArgs) : null);
    const title = [supplied?.title, supplied?.description].find((value) => typeof value === "string" && value.trim());
    if (typeof title === "string" && title.trim()) suppliedLabel = title.trim().slice(0, 240);
  } catch { /* Only exact structured argument fields can supply a title. */ }
  const detail = normalizeToolCall({ name, args: boundedArgs });
  if (detail.type !== "browser") return { label: suppliedLabel ?? label, target: undefined, icon: "tool" as ToolObservationIcon };
  const labels: Record<string, [string, string]> = {
    navigate: ["페이지 열기", "Navigate"], click: ["요소 클릭", "Click"],
    type: ["텍스트 입력", "Type text"], fill_form: ["입력란 채우기", "Fill form"],
    press_key: ["키 누르기", "Press key"], scroll: ["스크롤", "Scroll"],
    snapshot: ["화면 구조 확인", "Inspect page structure"], take_screenshot: ["화면 캡처", "Take screenshot"],
    screenshot: ["화면 캡처", "Take screenshot"], tabs: ["브라우저 탭 확인", "Inspect browser tabs"],
    wait_for: ["페이지 대기", "Wait for page"], evaluate: ["페이지 코드 실행", "Evaluate page"],
  };
  const icon: ToolObservationIcon = ["take_screenshot", "screenshot"].includes(detail.action) ? "camera"
    : detail.action === "snapshot" ? "search" : name.toLowerCase().startsWith("computer") ? "screen" : "browser";
  return { label: suppliedLabel ?? labels[detail.action]?.[locale === "ko" ? 0 : 1] ?? detail.action,
    target: detail.target?.slice(0, 240), icon };
}

export type ToolObservationText = { kind: "text" | "tree" | "diff"; text: string; truncated: boolean };
export interface ToolObservationPresentation {
  text: ToolObservationText[];
  images: Extract<McpResultBlock, { kind: "image" | "video" | "audio" }>[];
  omitted: boolean;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Project only tool-supplied result fields. No text-to-success, invented tree, or path-to-image promotion. */
export function projectToolObservation(result: string | undefined, toolName?: string): ToolObservationPresentation {
  if (!result) return { text: [], images: [], omitted: false };
  if (result.length > MAX_RESULT_INPUT) return { text: [], images: [], omitted: true };
  const projection = parseMcpResult(result, toolName);
  const text: ToolObservationText[] = [];
  let remaining = TOOL_OBSERVATION_TEXT_LIMIT;
  let omitted = projection.warnings.length > 0;
  const add = (kind: ToolObservationText["kind"], value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    if (remaining <= 0 || text.length >= 8) { omitted = true; return; }
    const trimmed = value.trim();
    const shown = trimmed.slice(0, remaining);
    remaining -= shown.length;
    text.push({ kind, text: shown, truncated: shown.length < trimmed.length });
    if (shown.length < trimmed.length) omitted = true;
  };
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { parsed = null; }
  const root = object(parsed);
  const structured = object(root?.structuredContent) ?? root;
  // These explicit result keys label observations; they carry no execution authority.
  if (structured) {
    for (const key of ["accessibilityTree", "axTree", "snapshot"]) add("tree", structured[key]);
    add("diff", structured.diff);
  }
  if (text.length === 0) {
    // Standard MCP text content is the observed receipt, including provider YAML/diffs.
    const content = Array.isArray(root?.content) ? root.content : null;
    if (content) for (const entry of content) {
      const block = object(entry);
      if (block?.type === "text") add("text", block.text);
    }
    else if (!root && !Array.isArray(parsed)) add("text", result);
  }
  const images = projection.blocks.filter((block): block is Extract<McpResultBlock, { kind: "image" | "video" | "audio" }> =>
    block.kind === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(block.mimeType)).slice(0, 4);
  return { text, images, omitted };
}
