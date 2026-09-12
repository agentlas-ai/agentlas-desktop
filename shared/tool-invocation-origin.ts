import type { RuntimeKind } from "./types";
import { isRuntimeKind } from "./runtime-kinds";

export type ToolInvocationOriginKind =
  | "cli"
  | "agentlas-plugin"
  | "agentlas"
  | "mcp"
  | "unknown";

/**
 * Main-authored provenance for one observed tool call.
 *
 * It deliberately carries display-safe identity only. Registry ids, command
 * paths, package digests, credentials and provider call ids stay in their
 * existing authorities.
 */
export interface ToolInvocationOrigin {
  kind: ToolInvocationOriginKind;
  /** Exact provider/runtime or registered server name observed by Main. */
  providerName: string;
  /** Exact native or server tool name, before renderer humanization. */
  toolName: string;
  /** Present only when Main observed a concrete runtime kind. */
  runtimeKind?: RuntimeKind;
}

const ORIGIN_KINDS = new Set<ToolInvocationOriginKind>([
  "cli", "agentlas-plugin", "agentlas", "mcp", "unknown",
]);

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

export function decodeToolInvocationOrigin(value: unknown): ToolInvocationOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  const providerName = boundedText(row.providerName, 160);
  const toolName = boundedText(row.toolName, 256);
  if (typeof kind !== "string" || !ORIGIN_KINDS.has(kind as ToolInvocationOriginKind) || !providerName || !toolName) return null;
  const runtimeKind = row.runtimeKind;
  if (runtimeKind !== undefined && !isRuntimeKind(runtimeKind)) return null;
  return {
    kind: kind as ToolInvocationOriginKind,
    providerName,
    toolName,
    ...(runtimeKind !== undefined ? { runtimeKind } : {}),
  };
}

export function toolInvocationOriginLabel(origin: ToolInvocationOrigin, locale: "ko" | "en"): string {
  const source = origin.kind === "cli"
    ? (locale === "ko" ? "CLI 도구" : "CLI tool")
    : origin.kind === "agentlas-plugin"
      ? (locale === "ko" ? "Agentlas 플러그인" : "Agentlas plugin")
      : origin.kind === "agentlas"
        ? "Agentlas"
        : origin.kind === "mcp"
          ? "MCP"
          : (locale === "ko" ? "출처 확인 안 됨" : "Source unconfirmed");
  return `${source} · ${origin.providerName} · ${origin.toolName}`;
}
