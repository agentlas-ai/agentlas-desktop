/**
 * Private values replaced before they can travel (Agentlas 2.0 N-D01 and N-D02, decision).
 *
 * A skill that came from lessons is the one thing an agent keeps that may go to another computer or to the cloud, so what the lessons
 * mention of the owner's own life must not be in it: an e-mail address, a link's query, a path on this computer, a long number or an amount
 * of money, and the names the owner's own data uses (project, project folder, chat title, member of the organization, account).
 * The same replacement runs on what is sent to the compiler model, so the model never sees them either.
 *
 * It replaces; it never blocks: the text stays readable with `[가림]` where the value was. Free sentences the patterns cannot know (a
 * customer's circumstances) stay for the owner's own reading of the diff, the last defence the owner accepted.
 * Pure function, no Electron, no database. Paths are matched in POSIX, Windows (drive, UNC, %VAR%) and file: forms.
 */
export const REDACTION = "[가림]";
export type RedactionKind = "email" | "url" | "path" | "number" | "amount" | "name";
export interface RedactionResult { text: string; count: number; kinds: Partial<Record<RedactionKind, number>> }

/** The most names one replacement run uses. Names come in priority order (account, members, projects, chat titles): the cap drops the last ones, never the first (E-1: it used to keep the longest, which were all chat titles). */
export const NAME_CAP = 1500;
const GENERIC_NAMES = new Set(["app", "test", "main", "docs", "doc", "src", "project", "projects", "agent", "agents", "user", "users", "new", "chat", "new chat", "untitled", "default", "home", "work", "one", "hope"]);
/** Ordinary words a project or folder is often called: not a private name, so they neither blank the text nor refuse a skill name (E-2). A person's name is never judged by this list. */
const COMMON_WORDS = new Set([...GENERIC_NAMES, "apps", "web", "tests", "testing", "api", "apis", "site", "lib", "libs", "core", "server", "client", "tool", "tools", "util", "utils", "data", "demo", "build", "release", "deploy",
  "code", "backend", "frontend", "service", "services", "admin", "mobile", "desktop", "common", "shared", "base", "script", "scripts", "config", "infra", "ops", "dev", "prod", "staging", "tmp", "temp", "sample", "example", "examples",
  "playground", "sandbox", "repo", "monorepo", "website", "landing", "dashboard", "platform", "engine", "bot", "cli", "sdk", "ui", "ux", "notes", "note", "blog", "study", "learn", "practice", "personal", "misc", "stuff", "my", "old",
  "final", "copy", "backup", "archive", "node", "react", "vue", "next", "python", "java", "go", "rust", "swift", "kotlin", "flutter", "android", "ios", "web app", "프로젝트", "테스트", "앱", "웹", "서버", "문서", "메모", "작업", "새", "폴더"]);
const ROOTS = "Users|home|Volumes|private|var|tmp|opt|etc|mnt|root|srv|usr|Library|Applications|System|data|workspace|workspaces|work|app";
const PATH_TAIL = "[^\\s\"'<>)\\]`]*[^\\s\"'<>)\\]`.,;:!?]";

const URL_RE = /https?:\/\/[^\s<>"')\]`]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PATH_RES: RegExp[] = [
  /file:\/\/\/?[^\s"'<>)\]`]*[^\s"'<>)\]`.,;:!?]/gi,
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${PATH_TAIL}`, "g"),
  new RegExp(`\\\\\\\\[\\w.$-]+\\\\${PATH_TAIL}`, "g"),
  new RegExp(`%[A-Za-z_][A-Za-z0-9_]*%[\\\\/]${PATH_TAIL}`, "g"),
  new RegExp(`(?<![\\w])(?:~|\\$HOME|\\$\\{HOME\\})[\\\\/]${PATH_TAIL}`, "g"),
  new RegExp(`(?<![\\w:./~\\\\-])\\/(?:${ROOTS})\\/${PATH_TAIL}`, "g"),
  // Any other absolute path is a file path when its last segment has an extension (a route like /api/v1/orders is not).
  new RegExp(`(?<![\\w:./~\\\\-])(?:\\/[\\w.@+-]+){2,}\\.[A-Za-z0-9]{1,8}(?![\\w/])`, "g"),
];
const AMOUNT_RES: RegExp[] = [
  /(?:US\$|[$€£¥₩￦]|\b(?:KRW|USD|EUR|JPY|GBP|CNY|RMB)\s?)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmMbB](?![A-Za-z])|만|억|천))?/g,
  /\d[\d,]*(?:\.\d+)?\s?(?:[천백십만억조]*\s?원|달러|유로|엔|위안|USD|KRW|EUR|JPY|dollars?|won|bucks)(?![A-Za-z])/gi,
  /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])/g,
];
const LONG_NUMBER_RE = /(?<![\w.:])\+?\d[\d\-. ()]{7,}\d(?![\w])/g;

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function bump(kinds: Partial<Record<RedactionKind, number>>, kind: RedactionKind): void { kinds[kind] = (kinds[kind] ?? 0) + 1; }

/** A project or folder name that is an ordinary word (every part of it is one) or too short to mean one project: not treated as a private name. */
export function isCommonName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return true;
  if (COMMON_WORDS.has(lower)) return true;
  const parts = lower.split(/[^a-z0-9\u3131-\u318e\uac00-\ud7a3]+/).filter(Boolean);
  if (parts.length > 0 && parts.every(part => COMMON_WORDS.has(part))) return true;
  return lower.length < (/[^\x00-\x7f]/.test(lower) ? 2 : 4);
}

/** Names usable for replacing: trimmed, long enough not to garble ordinary words, not a generic word. The first `cap` in the order given are kept (priority order), then longest first. */
export function usableNames(names: readonly string[], cap: number = NAME_CAP): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of names) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    const nonAscii = /[^\x00-\x7f]/.test(name);
    if (name.length < (nonAscii ? 2 : 3) || GENERIC_NAMES.has(name.toLowerCase()) || /^\d+$/.test(name)) continue;
    seen.add(name.toLowerCase()); out.push(name);
  }
  return out.slice(0, cap).sort((a, b) => b.length - a.length);
}

/** One expression per chunk of names (longest first), cached for the list a caller keeps using: a skill is prepared with dozens of replacements on the same list. */
const nameExpressions = new WeakMap<readonly string[], RegExp[]>();
function expressionsFor(list: readonly string[]): RegExp[] {
  const cached = nameExpressions.get(list);
  if (cached) return cached;
  const out: RegExp[] = [];
  const names = usableNames(list);
  for (let start = 0; start < names.length; start += 200) {
    const alternatives = names.slice(start, start + 200).map(name => /[^\x00-\x7f]/.test(name) ? escapeRegExp(name) : `(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`);
    out.push(new RegExp(alternatives.join("|"), "gi"));
  }
  nameExpressions.set(list, out);
  return out;
}

export function redactPrivate(input: string, options: { names?: readonly string[] } = {}): RedactionResult {
  const kinds: Partial<Record<RedactionKind, number>> = {};
  let count = 0;
  const replace = (text: string, re: RegExp, kind: RedactionKind, decide?: (match: string) => string | null): string =>
    text.replace(re, (match) => {
      const next = decide ? decide(match) : REDACTION;
      if (next === null) return match;
      count += 1; bump(kinds, kind);
      return next;
    });
  let text = input;
  // 1. Links: credentials in the address and everything after `?` (or a `#` fragment that carries values) go; the page address stays.
  text = replace(text, URL_RE, "url", (url) => {
    const credentials = /^(https?:\/\/)[^/@\s]+@/i.exec(url);
    let next = url;
    if (credentials) next = next.replace(/^(https?:\/\/)[^/@\s]+@/i, `$1${REDACTION}@`);
    const query = next.search(/\?|#[^\s]*=/);
    if (query >= 0 && next.slice(query + 1).length > 0 && !next.slice(query + 1).startsWith(REDACTION)) next = `${next.slice(0, query)}${next[query] === "?" ? "?" : "#"}${REDACTION}`;
    return next === url ? null : next;
  });
  // 2. Addresses.
  text = replace(text, EMAIL_RE, "email");
  // 3. Paths on a computer.
  for (const re of PATH_RES) text = replace(text, re, "path");
  // 4. Money, then long digit runs (a phone number, an id, a card, an account).
  for (const re of AMOUNT_RES) text = replace(text, re, "amount");
  text = replace(text, LONG_NUMBER_RE, "number", (match) => {
    // A date (and a time after it) is not a number to hide.
    const digits = match.replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, "").replace(/\D/g, "").length;
    if (digits < 9 || /^\d+\.\d+$/.test(match)) return null;
    return REDACTION;
  });
  // 5. The names the owner's own data uses.
  for (const re of expressionsFor(options.names ?? [])) text = replace(text, re, "name");
  return { text, count, kinds };
}

/** A model-facing view of the evidence lines of a memory: pointers (run, ticket, supersedes, ...) stay, quoted words are summarized by a count. */
export function evidencePointersOnly(lines: readonly string[]): string[] {
  const pointers = lines.filter(line => /^(?:(?:run|event|supersedes|dreaming|ticket|turn):\S+|mtk_[A-Za-z0-9_-]+)$/i.test(line.trim()) && line.trim().length <= 120);
  const quoted = lines.length - pointers.length;
  return quoted > 0 ? [...pointers, `(${quoted} quoted evidence line${quoted === 1 ? "" : "s"} left out)`] : pointers;
}
