import { Buffer } from "node:buffer";

import { stripAgentControlBlocks } from "../../shared/agent-control-blocks";
import { MOBILE_BRIDGE_MAX_MESSAGE_BYTES } from "../../shared/mobile-bridge";

const SECRET_RE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\b(?:sk|rk|pk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_=-]{12,}\b|\b(?:api[_-]?key|token|secret|password|passwd|pwd|cookie|session|authorization)\b\s*[:=]\s*["']?[^,\s"'}`\]]{4,}|\bBearer\s+[A-Za-z0-9._~+\/-]{8,})/gi;
const POSIX_ROOT = "(?:Applications|System|Users|home|private|var|tmp|Volumes|opt|etc|usr|Library|root|mnt|media|srv|run|proc|sys|dev|bin|sbin|workspace|workspaces|app|data)";
const POSIX_ABSOLUTE_PATH_RE = new RegExp(
  "(?:file:\\/\\/)?\\/" + POSIX_ROOT + "(?:\\/[^\\/,\\r\\n\"'`<>|}\\]]+)*\\/[^\\s\\/,\\r\\n\"'`<>|}\\]]+\\/?",
  "g",
);
const POSIX_ROOT_PATH_RE = new RegExp(
  "(?:file:\\/\\/)?\\/" + POSIX_ROOT + "(?=$|[\\s,;:\"'`<>|}\\]])",
  "g",
);
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/g;
const WINDOWS_UNC_PATH_RE = /\\\\[^\\\s,\r\n"'`<>|}\]]+\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/g;
const DATA_URL_RE = /\bdata:[^,\s]{1,256},[^\s"'`<>]+/gi;
const TRUNCATION_SUFFIX = "…[truncated]";

/** Keep enough headroom for the response/event envelope and UTF-8 expansion. */
export const MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES = MOBILE_BRIDGE_MAX_MESSAGE_BYTES - 64 * 1024;
export const MOBILE_BRIDGE_TRANSCRIPT_TEXT_BYTES = 64 * 1024;
export const MOBILE_BRIDGE_DISPLAY_TEXT_BYTES = 4 * 1024;

export function mobileBridgeJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function truncateMobileBridgeUtf8(value: string, maxBytes: number): string {
  const budget = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(value, "utf8") <= budget) return value;
  if (budget === 0) return "";
  const suffix = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8") <= budget ? TRUNCATION_SUFFIX : "";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (Buffer.byteLength(candidate, "utf8") + suffixBytes <= budget) low = middle;
    else high = middle - 1;
  }
  // Avoid returning a dangling high surrogate after slicing a UTF-16 string.
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
}

/**
 * JSON permits escaped UTF-16 code units, while Flutter's paragraph builder
 * rejects isolated surrogates. Runtime streaming can briefly split an emoji
 * between two deltas, so repair malformed code units before serialization.
 */
export function repairMobileBridgeUtf16(value: string): string {
  let start = 0;
  let repaired = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      continue;
    }
    repaired += `${value.slice(start, index)}\ufffd`;
    start = index + 1;
  }
  return start === 0 ? value : repaired + value.slice(start);
}

/**
 * Desktop renders these protocol sentinels as controls. Mobile receives the
 * corresponding confirmation as structured data, so raw fence JSON must not
 * appear as assistant copy. A dangling opening fence is also hidden while a
 * streamed response is still being assembled.
 *
 * The ruleset lives in shared/agent-control-blocks.ts because Mobile ports the
 * exact same rules to Dart. Only ONE surface may own the rules; this function
 * stays as the bridge-facing name so existing call sites keep working.
 *
 * NOTE — this is never applied to a streamed `delta`. A delta is one chunk of a
 * client-accumulated string: a control fence can straddle two chunks, so
 * chunk-wise stripping both misses the block and corrupts the accumulation.
 * Stripping a delta would also force `textLen` to be dropped, which is the
 * client's only stream-desync detector. Mobile therefore strips the accumulated
 * text at render time instead.
 */
export function stripMobileBridgeControlFences(value: string): string {
  return stripAgentControlBlocks(value);
}

/**
 * Sanitize every free-form string before it crosses the Desktop/Mobile trust
 * boundary. Ordinary transcript text stays readable; credential material,
 * local absolute paths, and in-memory attachment data URLs never cross.
 */
export function sanitizeMobileBridgeText(value: string, maxBytes: number): string {
  const safe = repairMobileBridgeUtf16(value)
    .replace(DATA_URL_RE, "[redacted-data-url]")
    .replace(SECRET_RE, "[redacted-secret]")
    .replace(POSIX_ABSOLUTE_PATH_RE, "[local-path]")
    .replace(POSIX_ROOT_PATH_RE, "[local-path]")
    .replace(WINDOWS_UNC_PATH_RE, "[local-path]")
    .replace(WINDOWS_ABSOLUTE_PATH_RE, "[local-path]");
  return truncateMobileBridgeUtf8(safe, maxBytes);
}
