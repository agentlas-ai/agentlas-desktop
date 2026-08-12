import type { McpInvocationEvent } from "@shared/types";

export type OneRuntimeFeedbackKind = "thinking" | "tool" | "notice" | "file" | "image";

export interface OneRuntimeFeedbackItem {
  id: string;
  kind: OneRuntimeFeedbackKind;
  label: string;
  detail?: string;
  agentName?: string;
  path?: string;
  previewUrl?: string;
  isError?: boolean;
}

const FILE_PATH_PATTERN = /(?:file:\/\/[^\s"'<>]+|agentlas:\/\/localfile\/\?p=[^\s"'<>]+|[A-Za-z]:[\\/][^\r\n"'<>]+|\/(?:private|tmp|var|Users|home|workspace|mnt|opt)[^\r\n"'<>]*)/g;
const FILE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|mdx?|jsonl?|ya?ml|toml|txt|csv|tsv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|avif|svg|mp4|webm|mov)$/i;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

function trimCandidate(value: string): string {
  return value.trim().replace(/[),.;:]+$/g, "");
}

function decodedLocalPath(value: string): string {
  if (value.startsWith("agentlas://localfile/")) {
    try {
      return new URL(value).searchParams.get("p") || value;
    } catch {
      return value;
    }
  }
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return value.slice("file://".length);
    }
  }
  return value;
}

function fileName(value: string): string {
  const normalized = decodedLocalPath(value).replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").pop() || normalized;
}

function collectStringValues(value: unknown, out: string[], depth = 0) {
  if (depth > 4 || out.length > 80) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) collectStringValues(child, out, depth + 1);
}

function stringsInPayload(raw?: string): string[] {
  if (!raw) return [];
  const values: string[] = [];
  try {
    collectStringValues(JSON.parse(raw), values);
  } catch {
    values.push(raw);
  }
  return values;
}

function pathsInPayload(raw?: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of stringsInPayload(raw)) {
    const direct = trimCandidate(value);
    const candidates = [
      ...(FILE_PATH_PATTERN.test(direct) ? (direct.match(FILE_PATH_PATTERN) ?? []) : []),
      ...(FILE_EXTENSION_PATTERN.test(direct) && !/\s/.test(direct) ? [direct] : []),
    ];
    FILE_PATH_PATTERN.lastIndex = 0;
    for (const candidate of candidates) {
      const path = trimCandidate(candidate);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function previewUrlFor(path: string): string | undefined {
  if (/^(?:data:image\/|blob:|https?:\/\/|agentlas:\/\/localfile\/)/i.test(path)) return path;
  const localPath = decodedLocalPath(path);
  if (!IMAGE_EXTENSION_PATTERN.test(localPath)) return undefined;
  if (localPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(localPath)) {
    return `agentlas://localfile/?p=${encodeURIComponent(localPath)}`;
  }
  return undefined;
}

function toolLabel(name: string, locale: "ko" | "en"): string {
  const normalized = name.trim().toLocaleLowerCase();
  const labels: Array<[RegExp, string, string]> = [
    [/read|open|get_file|view/, "파일을 읽는 중", "Reading a file"],
    [/write|create|save/, "파일을 만드는 중", "Creating a file"],
    [/edit|patch|replace/, "파일을 수정하는 중", "Editing a file"],
    [/search|find|query/, "자료를 찾는 중", "Searching"],
    [/test|check|verify|lint|build/, "결과를 검증하는 중", "Verifying the result"],
    [/browser|navigate|click|screenshot/, "화면을 확인하는 중", "Inspecting the screen"],
  ];
  const match = labels.find(([pattern]) => pattern.test(normalized));
  return match ? (locale === "ko" ? match[1] : match[2]) : (name.trim() || (locale === "ko" ? "도구 실행 중" : "Using a tool"));
}

export function oneRuntimeFeedbackFromEvent(
  event: McpInvocationEvent,
  locale: "ko" | "en",
  sequence: number,
): OneRuntimeFeedbackItem[] {
  const idBase = event.tool?.id || `${event.kind}:${sequence}`;
  const agentName = event.agentName?.trim() || undefined;

  if (event.kind === "notice" && event.notice?.message) {
    return [{
      id: `${idBase}:notice`,
      kind: "notice",
      label: event.notice.message,
      detail: event.notice.details,
      agentName,
      isError: event.notice.level === "error" || event.notice.level === "warning",
    }];
  }

  if (event.kind === "thinking" && event.status) {
    return [{ id: `${idBase}:thinking`, kind: "thinking", label: event.status, agentName }];
  }

  if (event.kind !== "tool-use") return [];
  const name = event.tool?.name?.trim() || "";
  const status = event.status?.trim();
  const detail = [event.tool?.args, event.tool?.result].filter(Boolean).join("\n");
  const items: OneRuntimeFeedbackItem[] = [{
    id: `${idBase}:tool`,
    kind: "tool",
    label: status || toolLabel(name, locale),
    detail: detail || undefined,
    agentName,
    isError: event.tool?.isError === true,
  }];

  const paths = [...pathsInPayload(event.tool?.args), ...pathsInPayload(event.tool?.result)];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const previewUrl = previewUrlFor(path);
    items.push({
      id: `${idBase}:artifact:${path}`,
      kind: previewUrl ? "image" : "file",
      label: fileName(path),
      path: decodedLocalPath(path),
      previewUrl,
      agentName,
    });
  }
  return items;
}

export function mergeOneRuntimeFeedback(
  current: OneRuntimeFeedbackItem[],
  incoming: OneRuntimeFeedbackItem[],
): OneRuntimeFeedbackItem[] {
  if (incoming.length === 0) return current;
  const next = [...current];
  for (const item of incoming) {
    const identity = item.path ? `${item.kind}:${item.path}` : item.id;
    const index = next.findIndex((candidate) => (candidate.path ? `${candidate.kind}:${candidate.path}` : candidate.id) === identity);
    if (index >= 0) next[index] = { ...next[index], ...item };
    else next.push(item);
  }
  return next.slice(-80);
}

export function oneRuntimeArtifacts(items: OneRuntimeFeedbackItem[]): OneRuntimeFeedbackItem[] {
  return items.filter((item) => item.kind === "file" || item.kind === "image");
}
