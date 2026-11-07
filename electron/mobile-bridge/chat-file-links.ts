import { MOBILE_BRIDGE_POSIX_ROOT_SOURCE, sanitizeMobileBridgeText, stripMobileBridgeControlFences, truncateMobileBridgeUtf8 } from "./sanitize";

/**
 * Local file paths in a stored assistant answer, for a phone that reported `chat.file.v1`.
 *
 * ONE tokenizer serves both sides: the history projection (a path becomes `[name](agentlas-file:<n>)`) and the open request
 * (`chat.file.open {chatId, messageId, ordinal}` re-reads the stored message and takes the n-th token). Tokens are found by
 * regular expressions only; no file system is read here. The ordinal is the token's position among ALL path tokens of the
 * text (links, images, bare paths, tokens inside code), so it can be recomputed from the stored text alone.
 */
export const CHAT_FILE_LINK_SCHEME = "agentlas-file:";
export const CHAT_FILE_MAX_ORDINAL = 10_000;

export interface ChatFileToken {
  ordinal: number;
  /** The path as written, with a file:// URL decoded to a path. `~/` is NOT expanded here. */
  path: string;
  name: string;
  /** Looks like a folder (ends with a separator, or its last name has no extension). Judged from the text only. */
  directory: boolean;
  /**
   * False (name only, no link, never opened) for a folder, a credential-looking name (the bridge mask wins), a secret file or
   * folder (isChatFileSecretPath: login/key folders, .env*, key files, id_*, names with a secret word), or a network path (UNC, \\?\, \\.\).
   */
  linkable: boolean;
}

const ROOT = MOBILE_BRIDGE_POSIX_ROOT_SOURCE;
// Characters that end a bare path: whitespace, quotes, angle brackets, pipes, and CJK sentence punctuation.
const STOP = String.raw`\s\r\n"'\`<>|}\]。，、；：！？」』）”’《》`;
const SEG = `[^${STOP}\\/,]+`;
const POSIX_SRC = String.raw`(?<![\w.~/-])(?:file:\/\/(?:localhost)?)?\/${ROOT}(?![\w.-])(?:\/${SEG})*\/?`;
const TILDE_SRC = String.raw`(?<![\w.~/-])~\/${SEG}(?:\/${SEG})*\/?`;
const WIN_SEG = `(?:[^${STOP}\\\\/,:*?]+)`;
const WIN_SRC = String.raw`(?<![\w])(?:file:\/\/\/)?[A-Za-z]:[\\/](?:${WIN_SEG}[\\/])*${WIN_SEG}?`;
const UNC_SRC = String.raw`(?<![\w\\])\\\\${WIN_SEG}\\${WIN_SEG}(?:\\${WIN_SEG})*\\?`;
// \\?\C:\x and \\.\pipe\x: Win32 device paths. They are tokens (so the path never shows) but are never links.
const LONG_SRC = String.raw`(?<![\w\\])\\\\[?.]\\[^${STOP}]+`;
const BARE_SRC = `${LONG_SRC}|${POSIX_SRC}|${TILDE_SRC}|${WIN_SRC}|${UNC_SRC}`;
// A link or angle target may hold spaces, so it is recognised by how it starts.
const TARGET_START = new RegExp(String.raw`^(?:file:\/\/(?:localhost)?\/?(?=[A-Za-z]:|\/)|)(?:\/${ROOT}(?![\w.-])|~\/|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\)`);
const COMBINED = new RegExp(
  [
    "(?<fence>```[\\s\\S]*?(?:```|$))",
    "(?<code>`[^`\\r\\n]*`)",
    "(?<link>(?<bang>!?)\\[(?<label>[^\\]\\r\\n]{0,300})\\]\\((?<target><[^<>\\r\\n]{1,2048}>|(?:[^()\\s\\r\\n]|\\([^()\\s\\r\\n]*\\)){1,2048})(?:\\s+(?:\"[^\"\\r\\n]*\"|'[^'\\r\\n]*'))?\\s*\\))",
    "(?<angle><(?<anglePath>[^<>\\r\\n]{1,2048})>)",
    `(?<bare>${BARE_SRC})`,
  ].join("|"), "g");
const BARE = new RegExp(BARE_SRC, "g");
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​‎‏‪-‮⁦-⁩﻿]/g;

function trimTail(path: string): string {
  // Parentheses are counted once (a path ending in many ")" used to rescan the whole string per character: quadratic).
  let open = 0, close = 0;
  for (const ch of path) { if (ch === "(") open += 1; else if (ch === ")") close += 1; }
  let end = path.length;
  while (end > 0) {
    const last = path[end - 1];
    if (".,;:!?*".includes(last)) { end -= 1; continue; }
    if (last === ")" && close > open) { end -= 1; close -= 1; continue; }
    break;
  }
  return path.slice(0, end);
}

function decodePath(raw: string): string {
  let value = raw;
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/(?:localhost)?/i, "");
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
    try { value = decodeURIComponent(value); } catch { /* keep as written */ }
  }
  return value;
}

/** Secret material a phone must never be offered or sent: login and key folders, env files, keys. Judged from the path text only. */
const CHAT_FILE_SECRET_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".docker", ".kube", ".codex", ".claude", ".agentlas", "credentials", "signing", "secrets"]);
/** Whole words of a file name (camelCase and separators split): "tokens.css" and "tokenizer.json" are not "token". */
const CHAT_FILE_SECRET_WORDS = new Set(["token", "secret", "secrets", "credential", "credentials", "password", "passwords", "passwd", "apikey"]);
const CHAT_FILE_SECRET_NAMES = new Set([".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", "auth.json", "google-services.json", "googleservice-info.plist"]);
// Not ".key": a Keynote deck shares it (and .key is no openable type, CHAT_FILE_MIME).
const CHAT_FILE_KEY_FILE = /\.(?:pem|p12|pfx|keystore|jks|ppk)$/;
export function isChatFileSecretPath(path: string): boolean {
  const written = path.split(/[\\/]+/).filter(Boolean);
  const parts = written.map((part) => part.toLowerCase());
  const base = parts[parts.length - 1] ?? "";
  // ~/.config holds other tools' logins; on Linux it also holds this app's own data folder (userData ~/.config/Agentlas*),
  // where, as on macOS and Windows, the read grants decide which folders a phone can open.
  if (parts.some((part, index) => CHAT_FILE_SECRET_FOLDERS.has(part) || (part === ".config" && !(parts[index + 1] ?? "").startsWith("agentlas")))) return true;
  const words = (written[written.length - 1] ?? "").replace(/\.[^.]*$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return base.startsWith(".env") || CHAT_FILE_SECRET_NAMES.has(base) || CHAT_FILE_KEY_FILE.test(base) || /^id_[a-z0-9_-]+$/.test(base)
    || /^(?:service[-_]?account|client[-_]?secret).*\.json$/.test(base)
    || words.some((word, index) => CHAT_FILE_SECRET_WORDS.has(word) || (word === "api" && words[index + 1] === "key"));
}

/** UNC, \\?\ and \\.\ paths: they may reach a network share, so the desktop touches no file system for them. */
export function isChatFileNetworkPath(path: string): boolean {
  return /^\\\\/.test(path);
}

function makeToken(ordinal: number, rawPath: string): ChatFileToken {
  const decoded = decodePath(rawPath);
  const endsWithSeparator = /[\\/]$/.test(decoded);
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const directory = endsWithSeparator || !/\.[A-Za-z0-9]{1,10}$/.test(last) || last === "~";
  const cleaned = last.replace(INVISIBLE, "").replace(/\[/g, "(").replace(/\]/g, ")").slice(0, 200) || "file";
  const masked = sanitizeMobileBridgeText(cleaned, 4096);
  return { ordinal, path: decoded, name: masked, directory,
    linkable: !directory && masked === cleaned && !isChatFileSecretPath(decoded) && !isChatFileNetworkPath(decoded) };
}

/** `agentlas-file:<n>/<name>`: the ordinal bound to the file name, so a phone that holds an old link can tell the text moved on. */
function linkTarget(token: ChatFileToken): string {
  const encoded = encodeURIComponent(token.name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${CHAT_FILE_LINK_SCHEME}${token.ordinal}/${encoded}`;
}

/** Replace every bare path of a fragment (a code span, a link label) with its name; counts nothing. */
function namesOnly(fragment: string): string {
  return fragment.replace(BARE, (match) => makeToken(0, trimTail(match)).name + match.slice(trimTail(match).length));
}

export interface ChatFileRewrite { text: string; tokens: ChatFileToken[] }

/**
 * Tokenize `text` and rewrite it. With `links` a safe file becomes `[name](agentlas-file:<n>/<name>)`; without it every path is
 * its name only. The open request calls it with `links:false` and only reads `tokens`. A `agentlas-file:` link the model wrote
 * itself is never a link: it becomes its label as plain text (it adds no token, in either mode).
 */
export function rewriteChatFilePaths(text: string, links: boolean): ChatFileRewrite {
  const tokens: ChatFileToken[] = [];
  const add = (rawPath: string): ChatFileToken => {
    const token = makeToken(tokens.length, rawPath);
    tokens.push(token);
    return token;
  };
  // Inside code every path is a token (it counts) but only its name is shown.
  const inCode = (fragment: string): string => fragment.replace(BARE, (match) => {
    const path = trimTail(match);
    return add(path).name + match.slice(path.length);
  });
  const out = text.replace(COMBINED, (...args) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    if (groups.fence !== undefined) return inCode(groups.fence);
    if (groups.code !== undefined) return inCode(groups.code);
    if (groups.link !== undefined) {
      const target = groups.target!;
      const unwrapped = target.startsWith("<") ? target.slice(1, -1) : target;
      const label = namesOnly(groups.label ?? "");
      if (/^agentlas-file:/i.test(unwrapped)) return label;
      if (!TARGET_START.test(unwrapped)) return groups.link;
      const token = add(unwrapped);
      if (!links || !token.linkable) return label || token.name;
      return `${groups.bang}[${label || token.name}](${linkTarget(token)})`;
    }
    if (groups.angle !== undefined) {
      if (!TARGET_START.test(groups.anglePath!)) return groups.angle;
      const token = add(groups.anglePath!);
      return links && token.linkable ? `[${token.name}](${linkTarget(token)})` : token.name;
    }
    const path = trimTail(groups.bare!);
    if (!path) return groups.bare!;
    const token = add(path);
    const tail = groups.bare!.slice(path.length);
    return (links && token.linkable ? `[${token.name}](${linkTarget(token)})` : token.name) + tail;
  });
  return { text: out, tokens };
}

const TRUNCATION_SUFFIX = "…[truncated]";

/** Fit rewritten text into `maxBytes` without cutting a file link in the middle: the cut moves back to the link's start. */
export function cutChatFileText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const cut = truncateMobileBridgeUtf8(text, maxBytes);
  let body = cut.endsWith(TRUNCATION_SUFFIX) ? cut.slice(0, -TRUNCATION_SUFFIX.length) : cut;
  for (const match of text.matchAll(/!?\[[^\]\r\n]{0,300}\]\(agentlas-file:[^)\s]{0,2048}\)/g)) {
    const start = match.index ?? 0;
    if (start < body.length && start + match[0].length > body.length) { body = text.slice(0, start); break; }
  }
  return body + TRUNCATION_SUFFIX;
}

/**
 * The text a phone sees for one stored assistant row, before any rewriting: the teammate's result when the row is a dispatch
 * result, otherwise the row's own text. The history projection and chat.file.open both start from this one function, so an
 * ordinal always means the same token on both sides.
 */
export function chatFileSourceText(text: string, notice?: unknown): string {
  const result = (notice as { dispatch?: { resultText?: unknown } } | null | undefined)?.dispatch?.resultText;
  return stripMobileBridgeControlFences(typeof result === "string" && result ? result : text);
}

/** The n-th path token of a stored message, or null. */
export function chatFileTokenAt(text: string, ordinal: number): ChatFileToken | null {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > CHAT_FILE_MAX_ORDINAL) return null;
  return rewriteChatFilePaths(text, false).tokens[ordinal] ?? null;
}

/** Extension to media type. Video kinds are the ones legacy.video.* already allowed. */
export const CHAT_FILE_MIME: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm", ".ogv": "video/ogg",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // No ".key": a Keynote file and a private key share the extension, and a phone is never sent a key.
  ".pages": "application/vnd.apple.pages", ".numbers": "application/vnd.apple.numbers",
  ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
};
