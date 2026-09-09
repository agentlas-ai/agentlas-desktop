/**
 * MCP tool-result projection shared by the Desktop renderer surfaces.
 *
 * MCP providers are not required to agree on a provider-specific JSON payload,
 * but the protocol does give us a stable `content[]` envelope.  This module
 * intentionally normalizes only safe, displayable values from that envelope
 * (and a small set of common structured-result keys).  It never returns local
 * filesystem paths or arbitrary protocols for the renderer to open.
 */

export type McpResultStatus =
  | "queued"
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type McpResultBlock =
  | { id: string; kind: "text"; text: string }
  | {
      id: string;
      kind: "image" | "video" | "audio";
      label: string;
      mimeType: string;
      source: "inline" | "url";
      src: string;
    }
  | {
      id: string;
      kind: "file" | "link";
      href: string;
      label: string;
      mimeType?: string;
    }
  | { id: string; kind: "data"; label: string; value: string }
  | { id: string; kind: "status"; jobId?: string; status: McpResultStatus };

export interface McpResultPresentation {
  blocks: McpResultBlock[];
  /** True when the result was a standard MCP CallToolResult envelope. */
  isMcpEnvelope: boolean;
  status?: McpResultStatus;
  jobId?: string;
  warnings: string[];
}

const MAX_BLOCKS = 16;
const MAX_TEXT_CHARS = 2_400;
const MAX_DATA_CHARS = 8_000;
// The runtime normally keeps tool results well below this size.  This guard is
// still needed for persisted/replayed events and protects the renderer from a
// provider returning an unbounded data URL.
const MAX_INLINE_DATA_URL_CHARS = 2_000_000;
const MAX_WALK_DEPTH = 6;

type JsonRecord = Record<string, unknown>;

const MEDIA_KEY_RE = /(?:^|[_-])(image|video|audio|media|thumbnail|poster|preview)(?:$|[_-])/iu;
const FILE_KEY_RE = /(?:^|[_-])(?:file|document|spreadsheet|presentation|download|export)(?:$|[_-])/iu;
const LINK_KEY_RE = /(?:^|[_-])(?:url|uri|href|link|edit|share|preview)(?:$|[_-])/iu;
const JOB_KEY_RE = /(?:^|[_-])(?:job|task|request|operation)(?:[_-]?id)?$/iu;
const STATUS_KEY_RE = /^(?:status|state|phase)$/iu;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeUrl(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function safeMime(value: unknown): string | undefined {
  const text = nonEmptyString(value)?.split(";", 1)[0].toLowerCase();
  return text && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(text) ? text : undefined;
}

function mediaKind(mime: string | undefined, url: string | undefined, hint: string): "image" | "video" | "audio" | null {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  const lowerUrl = (url ?? "").toLowerCase().split(/[?#]/, 1)[0];
  if (/\.(?:png|jpe?g|webp|gif|avif|svg)$/iu.test(lowerUrl)) return "image";
  if (/\.(?:mp4|webm|mov|m4v|mkv)$/iu.test(lowerUrl)) return "video";
  if (/\.(?:mp3|wav|ogg|m4a|aac|flac)$/iu.test(lowerUrl)) return "audio";
  if (MEDIA_KEY_RE.test(hint)) {
    if (/video|movie/iu.test(hint)) return "video";
    if (/audio|sound/iu.test(hint)) return "audio";
    return "image";
  }
  return null;
}

function canonicalBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length > MAX_INLINE_DATA_URL_CHARS || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(compact)) return null;
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length % 4 === 1) return null;
  return normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
}

function dataUrl(mime: string | undefined, value: unknown): string | null {
  if (!mime || mime.includes("*") || (!mime.startsWith("image/") && !mime.startsWith("video/") && !mime.startsWith("audio/"))) return null;
  const encoded = canonicalBase64(nonEmptyString(value) ?? "");
  return encoded ? `data:${mime};base64,${encoded}` : null;
}

/**
 * Native computer-use screenshots may omit MCP's optional mimeType field. Do
 * not guess from a filename or a prose hint: decode only the bounded base64
 * prefix and accept the four image signatures already allowed by the UI.
 */
export function inferInlineImageMime(value: unknown): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined {
  const encoded = canonicalBase64(nonEmptyString(value) ?? "");
  if (!encoded) return undefined;
  const bytes: number[] = [];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let index = 0; index + 3 < encoded.length && bytes.length < 12; index += 4) {
    const a = alphabet.indexOf(encoded[index]);
    const b = alphabet.indexOf(encoded[index + 1]);
    const c = encoded[index + 2] === "=" ? 0 : alphabet.indexOf(encoded[index + 2]);
    const d = encoded[index + 3] === "=" ? 0 : alphabet.indexOf(encoded[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return undefined;
    bytes.push((a << 2) | (b >> 4));
    if (encoded[index + 2] !== "=") bytes.push(((b & 15) << 4) | (c >> 2));
    if (encoded[index + 3] !== "=") bytes.push(((c & 3) << 6) | d);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return undefined;
}

function parseJsonCandidate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return value;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string" && (parsed.trim().startsWith("{") || parsed.trim().startsWith("["))) {
      try { return JSON.parse(parsed) as unknown; } catch { return parsed; }
    }
    return parsed;
  } catch {
    return value;
  }
}

function statusOf(value: unknown): McpResultStatus | undefined {
  const text = nonEmptyString(value)?.toLowerCase().replace(/[ -]+/g, "_");
  if (!text) return undefined;
  if (["queued", "created", "accepted", "submitted", "scheduled"].includes(text)) return "queued";
  if (["pending", "waiting", "waiting_external"].includes(text)) return "pending";
  if (["in_progress", "processing", "running", "generating", "started"].includes(text)) return "in_progress";
  if (["completed", "complete", "succeeded", "success", "done", "ready"].includes(text)) return "completed";
  if (["failed", "failure", "error", "errored"].includes(text)) return "failed";
  if (["cancelled", "canceled", "aborted"].includes(text)) return "cancelled";
  return undefined;
}

function displayLabel(value: unknown, fallback: string): string {
  const text = nonEmptyString(value);
  return text ? text.slice(0, 160) : fallback;
}

function stringifyData(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > MAX_DATA_CHARS ? `${text.slice(0, MAX_DATA_CHARS - 1)}…` : text;
  } catch {
    return null;
  }
}

function providerLooksLikeMcpTool(toolName: string | undefined): boolean {
  const name = toolName?.trim() ?? "";
  return /(?:^|[_:. -])mcp(?:$|[_:. -])/iu.test(name) || /^mcp__?/iu.test(name);
}

/**
 * Parse the bounded string carried by `McpInvocationEvent.tool.result`.
 * Standard MCP content is preferred; structured provider payloads are only
 * interpreted when they carry a media/link/status/data signal.
 */
export function parseMcpResult(raw: string | undefined | null, toolName?: string): McpResultPresentation {
  const blocks: McpResultBlock[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let isMcpEnvelope = providerLooksLikeMcpTool(toolName);
  let status: McpResultStatus | undefined;
  let jobId: string | undefined;
  let sawStructuredData = false;
  let sawStructuredSignal = false;

  const push = (block: McpResultBlock, key = `${block.kind}:${block.id}`) => {
    if (blocks.length >= MAX_BLOCKS || seen.has(key)) return;
    seen.add(key);
    blocks.push(block);
  };

  const addStatus = (value: unknown, candidateJobId?: unknown) => {
    const next = statusOf(value);
    if (!next) return;
    status = status ?? next;
    const id = nonEmptyString(candidateJobId);
    if (id) jobId = jobId ?? id.slice(0, 160);
    push({ id: `status:${status}:${jobId ?? ""}`, kind: "status", status, ...(jobId ? { jobId } : {}) });
    sawStructuredSignal = true;
  };

  const addInline = (mime: string | undefined, encoded: unknown, label: string, hint: string, id: string, inferMime = false) => {
    const effectiveMime = mime ?? (inferMime && hint === "image" ? inferInlineImageMime(encoded) : undefined);
    const src = dataUrl(effectiveMime, encoded);
    if (!src) {
      if (nonEmptyString(encoded)) warnings.push(`${label}: inline media was not safely bounded`);
      return;
    }
    const kind = mediaKind(effectiveMime, undefined, hint);
    if (!kind) return;
    push({ id, kind, label, mimeType: effectiveMime ?? "application/octet-stream", source: "inline", src }, `media:${src.slice(0, 120)}`);
    sawStructuredSignal = true;
  };

  const addUrl = (value: unknown, mime: string | undefined, label: string, hint: string, id: string) => {
    const href = safeUrl(value);
    if (!href) {
      if (nonEmptyString(value)) warnings.push(`${label}: unsafe or unsupported URL omitted`);
      return;
    }
    const kind = mediaKind(mime, href, hint);
    if (kind) {
      push({ id, kind, label, mimeType: mime ?? (kind === "image" ? "image/*" : `${kind}/*`), source: "url", src: href }, `media:${href}`);
    } else if (FILE_KEY_RE.test(hint) || mime === "application/pdf" || mime?.startsWith("text/") || mime?.startsWith("application/vnd.")) {
      push({ id, kind: "file", href, label, ...(mime ? { mimeType: mime } : {}) }, `file:${href}`);
    } else {
      push({ id, kind: "link", href, label, ...(mime ? { mimeType: mime } : {}) }, `link:${href}`);
    }
    sawStructuredSignal = true;
  };

  const visitContent = (value: unknown, path: string, depth: number) => {
    const item = record(value);
    if (!item || depth > MAX_WALK_DEPTH) return;
    const type = nonEmptyString(item.type)?.toLowerCase();
    const rawMime = item.mimeType ?? item.mime_type ?? item.mediaType ?? item.media_type ?? item.contentType ?? item.content_type;
    const mime = safeMime(rawMime);
    const mimeWasDeclared = rawMime !== undefined && rawMime !== null;
    const label = displayLabel(item.name ?? item.filename ?? item.fileName ?? item.title, type === "image" ? "Image" : type === "video" ? "Video" : type === "audio" ? "Audio" : "MCP result");
    if (type === "text") {
      const text = nonEmptyString(item.text);
      if (text) {
        const parsed = parseJsonCandidate(text);
        if (parsed !== text && (record(parsed) || Array.isArray(parsed))) visitStructured(parsed, `${path}.text`, depth + 1);
        else push({ id: `text:${path}`, kind: "text", text: text.slice(0, MAX_TEXT_CHARS) });
      }
      return;
    }
    if (type === "image" || type === "video" || type === "audio") {
      const src = safeUrl(item.url ?? item.uri ?? item.href);
      if (src) addUrl(src, mime ?? `${type}/*`, label, type, `media:${path}`);
      else addInline(mime, item.data ?? item.blob ?? item.base64, label, type, `media:${path}`, !mimeWasDeclared);
      return;
    }
    if (type === "resource_link") {
      addUrl(item.uri ?? item.url ?? item.href, mime, label, "resource_link", `resource-link:${path}`);
      return;
    }
    if (type === "resource") {
      const nested = item.resource ?? item.contents;
      if (nested !== undefined) {
        const nestedRecord = record(nested);
        const nestedMime = safeMime(
          nestedRecord?.mimeType
          ?? nestedRecord?.mime_type
          ?? nestedRecord?.mediaType
          ?? nestedRecord?.media_type
          ?? nestedRecord?.contentType
          ?? nestedRecord?.content_type,
        );
        // MCP EmbeddedResource carries TextResourceContents/BlobResourceContents
        // under `resource`. Project those two standard shapes directly before
        // walking provider-specific extras, otherwise the nested text is lost
        // and only its URI survives as a generic file link.
        const nestedText = nonEmptyString(nestedRecord?.text);
        if (nestedText) push({ id: `resource-text:${path}`, kind: "text", text: nestedText.slice(0, MAX_TEXT_CHARS) });
        if (nestedRecord?.blob !== undefined) addInline(nestedMime, nestedRecord.blob, label, "resource", `resource-media:${path}`);
        if (nestedRecord?.uri !== undefined || nestedRecord?.url !== undefined) {
          addUrl(nestedRecord.uri ?? nestedRecord.url, nestedMime, label, "resource", `resource-link:${path}`);
        }
        if (!nestedText && nestedRecord?.blob === undefined && nestedRecord?.uri === undefined && nestedRecord?.url === undefined) {
          visitStructured(nested, `${path}.resource`, depth + 1);
        }
      }
      if (item.blob !== undefined || item.data !== undefined) addInline(mime, item.blob ?? item.data, label, "resource", `resource-media:${path}`);
      if (item.text !== undefined && nonEmptyString(item.text)) push({ id: `resource-text:${path}`, kind: "text", text: String(item.text).slice(0, MAX_TEXT_CHARS) });
      if (item.uri !== undefined || item.url !== undefined) addUrl(item.uri ?? item.url, mime, label, "resource", `resource-link:${path}`);
      return;
    }
    visitStructured(item, path, depth);
  };

  function visitStructured(value: unknown, path: string, depth: number) {
    if (depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      value.slice(0, MAX_BLOCKS).forEach((item, index) => {
        if (record(item)?.type) visitContent(item, `${path}.${index}`, depth + 1);
        else visitStructured(item, `${path}.${index}`, depth + 1);
      });
      return;
    }
    const item = record(value);
    if (!item) {
      const text = nonEmptyString(value);
      if (text && safeUrl(text)) addUrl(text, undefined, "MCP link", "url", `url:${path}`);
      return;
    }

    const localStatus = Object.entries(item).find(([key]) => STATUS_KEY_RE.test(key));
    const localJob = Object.entries(item).find(([key]) => JOB_KEY_RE.test(key));
    if (localStatus) addStatus(localStatus[1], localJob?.[1]);
    const localMime = safeMime(item.mimeType ?? item.mime_type ?? item.mediaType ?? item.media_type ?? item.contentType ?? item.content_type);
    const localName = displayLabel(item.name ?? item.filename ?? item.fileName ?? item.title, "MCP result");

    for (const [key, valueAtKey] of Object.entries(item)) {
      const keyHint = key.toLowerCase();
      if (JOB_KEY_RE.test(key) && typeof valueAtKey === "string") {
        jobId = jobId ?? valueAtKey.slice(0, 160);
        continue;
      }
      if (STATUS_KEY_RE.test(key)) continue;
      if (key === "mimeType" || key === "mime_type" || key === "mediaType" || key === "media_type" || key === "contentType" || key === "content_type") continue;
      if ((key === "data" || key === "blob" || key === "base64" || key === "bytes") && typeof valueAtKey === "string" && (localMime?.startsWith("image/") || localMime?.startsWith("video/") || localMime?.startsWith("audio/"))) {
        addInline(localMime, valueAtKey, localName, keyHint, `inline:${path}.${key}`);
        continue;
      }
      if (typeof valueAtKey === "string" && (LINK_KEY_RE.test(keyHint) || MEDIA_KEY_RE.test(keyHint) || FILE_KEY_RE.test(keyHint))) {
        addUrl(valueAtKey, localMime, displayLabel(item.name ?? item.filename ?? item.fileName, key.replace(/[_-]+/g, " ")), keyHint, `url:${path}.${key}`);
        continue;
      }
      if (record(valueAtKey) || Array.isArray(valueAtKey)) {
        visitStructured(valueAtKey, `${path}.${key}`, depth + 1);
      }
    }

    if (!sawStructuredSignal && depth <= 1 && Object.keys(item).length > 0) {
      const data = stringifyData(item);
      if (data) {
        push({ id: `data:${path}`, kind: "data", label: "Structured result", value: data });
        sawStructuredData = true;
      }
    }
  }

  const parsed = parseJsonCandidate(raw ?? "");
  const root = record(parsed);
  const standardContent = Array.isArray(root?.content)
    ? root.content
    : Array.isArray(parsed) && parsed.some((item) => record(item)?.type)
      ? parsed
      : null;
  if (standardContent) {
    isMcpEnvelope = true;
    standardContent.slice(0, MAX_BLOCKS).forEach((item, index) => visitContent(item, `content.${index}`, 0));
  }
  if (root?.structuredContent !== undefined) visitStructured(root.structuredContent, "structuredContent", 0);
  // A top-level MCP content array has already been projected above. The
  // optional-chain form `root?.content === undefined` is also true when root
  // is null, which would visit a direct content array a second time.
  if (!standardContent && root?.content === undefined && parsed !== "") visitStructured(parsed, "result", 0);
  if (root?.result !== undefined && !standardContent) visitStructured(root.result, "result", 0);
  if (root?.output !== undefined && !standardContent) visitStructured(root.output, "output", 0);

  // A provider may return a plain text JSON object from a tool-result text
  // block. If it carried no media/link/status signal, retain it as a compact
  // structured card rather than showing an opaque JSON blob only on click.
  if (isMcpEnvelope && blocks.length === 0 && parsed !== "") {
    const data = stringifyData(parsed);
    if (data) push({ id: "data:root", kind: "data", label: "Structured result", value: data });
  }
  if (status && !blocks.some((block) => block.kind === "status")) {
    push({ id: `status:${status}:${jobId ?? ""}`, kind: "status", status, ...(jobId ? { jobId } : {}) });
  }
  // `sawStructuredData` is deliberately unused as an output flag; keeping the
  // local marker makes it explicit that generic JSON is a fallback, not a
  // provider-specific media interpretation.
  void sawStructuredData;
  return { blocks, isMcpEnvelope, ...(status ? { status } : {}), ...(jobId ? { jobId } : {}), warnings: [...new Set(warnings)].slice(0, 4) };
}

export function hasMcpResultPreview(raw: string | undefined | null, toolName?: string): boolean {
  return parseMcpResult(raw, toolName).blocks.length > 0;
}
