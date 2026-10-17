import { createHash, randomBytes } from "node:crypto";
import { FILE_PREVIEW_HOST, type FilePreviewKind } from "../../shared/file-preview";

/*
 * Read-only file previews served to the owner window: bytes a trusted caller hands to Main become a short-lived,
 * unguessable `agentlas://file-preview/<token>` URL that the Universal File Viewer (the Work right tab's viewer:
 * docx, pdf, xlsx, csv, pptx, hwpx) fetches with Range requests. Nothing here knows who the caller is: Science's
 * Preview tab is the first (electron/science-host/preview-panel.ts), any other extension surface may use it.
 *
 * The caller names no path. It gives a file name (display and extension only) and the bytes; the extension must be a
 * format the viewer renders without running anything (no html, svg, script), and the bytes must look like that
 * format, so a name cannot turn a payload into something else. Entries live in memory only, are bounded per owner
 * and in total, expire, and are served with nosniff and a sandboxing CSP.
 *
 * No electron import: the protocol branch in main.ts only wraps `serve` in a Response, so a plain Node gate runs all of it.
 */

export const FILE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
export const FILE_PREVIEW_MAX_TOTAL_BYTES = 192 * 1024 * 1024;
export const FILE_PREVIEW_MAX_ENTRIES_PER_OWNER = 6;
export const FILE_PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 120;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type Sniff = "zip" | "pdf" | "text";

interface FormatSpec { kind: FilePreviewKind; mimeType: string; sniff: Sniff }

/** The formats the viewer renders as inert content. Order is irrelevant; the key is the lower-case extension. */
const FORMATS: Readonly<Record<string, FormatSpec>> = Object.freeze({
  pdf: { kind: "pdf", mimeType: "application/pdf", sniff: "pdf" },
  docx: { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sniff: "zip" },
  hwpx: { kind: "document", mimeType: "application/vnd.hancom.hwpx", sniff: "zip" },
  xlsx: { kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sniff: "zip" },
  xlsm: { kind: "spreadsheet", mimeType: "application/vnd.ms-excel.sheet.macroenabled.12", sniff: "zip" },
  csv: { kind: "spreadsheet", mimeType: "text/csv", sniff: "text" },
  tsv: { kind: "spreadsheet", mimeType: "text/tab-separated-values", sniff: "text" },
  pptx: { kind: "presentation", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sniff: "zip" },
});

export type FilePreviewRefusal =
  | "preview_name_invalid"
  | "preview_format_unsupported"
  | "preview_bytes_invalid"
  | "preview_empty"
  | "preview_too_large";

export interface FilePreviewEntryInfo {
  token: string;
  name: string;
  extension: string;
  kind: FilePreviewKind;
  mimeType: string;
  size: number;
  sha256: string;
}

interface Entry extends FilePreviewEntryInfo {
  ownerKey: string;
  bytes: Uint8Array;
  createdAt: number;
}

export interface FilePreviewServed {
  status: 200 | 206 | 404 | 416;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface FilePreviewRegistryOptions {
  now?: () => number;
  token?: () => string;
}

function safeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // A name is shown and keyed by its extension only; a path, control or bidi-override characters never survive.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const dot = cleaned.lastIndexOf(".");
  // A stem and an extension are both required: the extension names the format.
  if (dot <= 0 || dot === cleaned.length - 1) return null;
  return clip(cleaned, dot);
}

/** Shortens the stem, never the extension: the extension decides the format. */
function clip(name: string, dot: number): string {
  if (name.length <= MAX_NAME_LENGTH) return name;
  const extension = name.slice(dot);
  return `${name.slice(0, Math.max(1, MAX_NAME_LENGTH - extension.length))}${extension}`;
}

function sniffs(bytes: Uint8Array, kind: Sniff): boolean {
  if (kind === "zip") return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
  if (kind === "pdf") {
    const head = Math.min(bytes.length, 1024);
    for (let index = 0; index + 4 < head; index += 1) {
      if (bytes[index] === 0x25 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x44 && bytes[index + 3] === 0x46 && bytes[index + 4] === 0x2d) return true;
    }
    return false;
  }
  // Text: no NUL in the first 4 KB (a binary file renamed .csv is refused rather than rendered as noise).
  const head = Math.min(bytes.length, 4096);
  for (let index = 0; index < head; index += 1) if (bytes[index] === 0) return false;
  return true;
}

function ownedCopy(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return null;
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`; one range only. Null is unsatisfiable. */
function parseRange(header: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  }
  if (start >= size || end < start) return null;
  return { start, end, partial: true };
}

export function filePreviewExtensions(): string[] {
  return Object.keys(FORMATS);
}

export function filePreviewTokenFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "agentlas:" || url.hostname !== FILE_PREVIEW_HOST || url.search || url.hash) return null;
    const token = url.pathname.replace(/^\//, "");
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export class FilePreviewRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly newToken: () => string;

  constructor(options: FilePreviewRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newToken = options.token ?? (() => randomBytes(32).toString("base64url"));
  }

  private prune(): void {
    const cutoff = this.now() - FILE_PREVIEW_TTL_MS;
    for (const [token, entry] of this.entries) if (entry.createdAt < cutoff) this.entries.delete(token);
  }

  private total(): number {
    let sum = 0;
    for (const entry of this.entries.values()) sum += entry.size;
    return sum;
  }

  private evictOldest(ownerKey: string | null): boolean {
    for (const [token, entry] of this.entries) {
      if (ownerKey !== null && entry.ownerKey !== ownerKey) continue;
      this.entries.delete(token);
      return true;
    }
    return false;
  }

  private static info(entry: Entry): FilePreviewEntryInfo {
    const { token, name, extension, kind, mimeType, size, sha256 } = entry;
    return { token, name, extension, kind, mimeType, size, sha256 };
  }

  /** Registers bytes under a fresh token, or refreshes the identical file the owner already has. */
  register(ownerKey: string, input: { name: unknown; bytes: unknown }): { ok: true; entry: FilePreviewEntryInfo } | { ok: false; reason: FilePreviewRefusal } {
    const name = safeName(input.name);
    if (!name) return { ok: false, reason: "preview_name_invalid" };
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const spec = Object.prototype.hasOwnProperty.call(FORMATS, extension) ? FORMATS[extension] : undefined;
    if (!spec) return { ok: false, reason: "preview_format_unsupported" };
    const bytes = ownedCopy(input.bytes);
    if (!bytes) return { ok: false, reason: "preview_bytes_invalid" };
    if (bytes.length === 0) return { ok: false, reason: "preview_empty" };
    if (bytes.length > FILE_PREVIEW_MAX_BYTES) return { ok: false, reason: "preview_too_large" };
    if (!sniffs(bytes, spec.sniff)) return { ok: false, reason: "preview_bytes_invalid" };
    this.prune();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const entry of this.entries.values()) {
      if (entry.ownerKey === ownerKey && entry.name === name && entry.sha256 === sha256) {
        // The same file again: one chip, newest position, no second copy.
        this.entries.delete(entry.token);
        entry.createdAt = this.now();
        this.entries.set(entry.token, entry);
        return { ok: true, entry: FilePreviewRegistry.info(entry) };
      }
    }
    let owned = [...this.entries.values()].filter((entry) => entry.ownerKey === ownerKey).length;
    while (owned >= FILE_PREVIEW_MAX_ENTRIES_PER_OWNER && this.evictOldest(ownerKey)) owned -= 1;
    while (this.total() + bytes.length > FILE_PREVIEW_MAX_TOTAL_BYTES && this.evictOldest(null)) { /* oldest first, any owner */ }
    let token = this.newToken();
    while (this.entries.has(token)) token = this.newToken();
    const entry: Entry = {
      token, ownerKey, name, extension, kind: spec.kind, mimeType: spec.mimeType, size: bytes.length, sha256, bytes, createdAt: this.now(),
    };
    this.entries.set(token, entry);
    return { ok: true, entry: FilePreviewRegistry.info(entry) };
  }

  /** The owner's live entries, oldest first. */
  list(ownerKey: string): FilePreviewEntryInfo[] {
    this.prune();
    return [...this.entries.values()].filter((entry) => entry.ownerKey === ownerKey).map(FilePreviewRegistry.info);
  }

  /** Removes one entry of this owner; a token of another owner is not theirs to revoke. */
  revoke(ownerKey: string, token: unknown): boolean {
    if (typeof token !== "string") return false;
    const entry = this.entries.get(token);
    if (!entry || entry.ownerKey !== ownerKey) return false;
    return this.entries.delete(token);
  }

  releaseOwner(ownerKey: string): number {
    let removed = 0;
    for (const [token, entry] of this.entries) if (entry.ownerKey === ownerKey) { this.entries.delete(token); removed += 1; }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  /** The protocol boundary for agentlas://file-preview/<token>. */
  serve(rawUrl: string, rangeHeader: string | null): FilePreviewServed {
    const fail = (status: 404 | 416, size?: number): FilePreviewServed => ({
      status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(status === 416 && size !== undefined ? { "Content-Range": `bytes */${size}` } : {}),
      },
      body: null,
    });
    const token = filePreviewTokenFromUrl(rawUrl);
    if (!token) return fail(404);
    this.prune();
    const entry = this.entries.get(token);
    if (!entry) return fail(404);
    const range = parseRange(rangeHeader, entry.size);
    if (!range) return fail(416, entry.size);
    const body = range.partial ? entry.bytes.subarray(range.start, range.end + 1) : entry.bytes;
    return {
      status: range.partial ? 206 : 200,
      headers: {
        "Content-Type": entry.mimeType,
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${entry.size}` } : {}),
      },
      body,
    };
  }
}
