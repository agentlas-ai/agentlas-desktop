// The Codex home a product run uses: the user's own home, minus their personal instruction files,
// personal memories and personal skills.
//
// Codex always reads `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md` as global user
// instructions — there is no config key, flag or app-server parameter that turns it off (codex-rs
// codex-home/src/instructions, agents_md.rs: unconditional). Those files are the person's rules for
// their own coding sessions. In product runs they leaked: on 2026-10-05..06 room agents answered
// 511 of 1,208 replies with a "**[Hope]**" prefix and 247 with a "## Memory Events" envelope, and ran
// `git status` every turn in the non-git agent folder, all from the owner's ~/.codex/AGENTS.md.
// Owner decision 2026-10-06: personal coding rules must not drive product agents, for every user.
//
// So a product run gets a mirror of the real home in which every entry is a symlink to the original
// — sign-in (Codex writes auth.json in place, following the link), plugins, hooks and skills stay one and the
// same — except the two instruction files and the person's command rules (rules/), which are simply absent, config.toml, which is the mirror's own file holding
// only the allowlisted sign-in, provider and model-default keys of the person's (productCodexConfig), and the session store. Product sessions are Agentlas's own
// (owner 2026-10-12: "agentlas 세션은 개인 세션과 분리"): the mirrors share one product store for rollouts
// (codex-product-home/store), and the thread index, logs, prompt history and Codex app state are each mirror's own,
// so nothing an agent runs appears in the person's Codex app. A thread an older install wrote into the person's home
// is copied into the product store when it is next resumed (adoptCodexThreadIntoProductStore). Measured on codex-cli 0.160.1: sign-in, plugins and
// hooks load, a session written through the mirror lands in the real sessions folder and resumes, the
// mirror gains no files of its own, and the model reports no git rule and no Hope identity.
//
// Personal memories, skills and hooks are not mirrored either (owner decision 2026-10-11, all users); One alone
// gets back the ones the person switched on (capabilities/one-capabilities.ts). Measured on
// codex-cli 0.162.1 through the old mirror, every model request carried the person's Codex memory block
// (~4,100 tokens of project notes and preferences) and a skills index of the person's own skills; both are the
// same class of leak as AGENTS.md. A product agent gets Agentlas's own memory context and only the skills that
// belong to it (its folder's skills, the plugins the host routed). Codex rebuilds `skills/.system` (its bundled
// skills) in the mirror itself. Codex would also run a memory-consolidation model call over the shared state
// database when the memory folder is absent, so product runs also pass `features.memories=false`
// (codex-personal-context.ts).
//
// The mirror is skipped (the run keeps the real home) where it cannot hold: no auth.json to link
// (keyring sign-in is keyed by the home's path), or the sign-in cannot be linked at all. On Windows without the symlink
// right a file entry is a recorded hard link or copy instead (mirror-link.ts; Windows audit 2026-10-24, W-03); before
// that every default Windows account ran product codex in the person's own home. A mirror that still cannot hold is
// reported (product_home_isolation_unavailable), never silent.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { inheritedProductHome, personalHomeDir, personalHomeOverride, productHomeRefusedOnThisHost } from "./product-home-identity";
import { MIRROR_LINK_RECORD, adoptMirrorHardLink, isRecordedMirrorEntry, linkMirrorEntry, mirrorEntryLinked, mirrorEntryTarget, reconcileMirrorLinks, reportIsolationUnavailable } from "./mirror-link";

/** Read by Codex as global user instructions; never mirrored. */
export const CODEX_PERSONAL_INSTRUCTION_FILES: ReadonlySet<string> = new Set(["AGENTS.md", "AGENTS.override.md"]);
/**
 * The person's command rules ($CODEX_HOME/rules/*.rules); never mirrored, for One neither. Codex auto-approves a command
 * an `allow` rule matches and lists every approved prefix in the model's instructions whenever approval is on-request,
 * which is the policy of every product read/write turn. Measured 2026-10-17 (codex-cli 0.163.0, `codex debug
 * prompt-input`): through the mirror the owner's 13 rules (`railway up`, `flutter build`, ...) were the only
 * model-visible difference from a home holding nothing but the sign-in. Agentlas decides approvals for product runs; a
 * prefix a product turn approves stays in the mirror's own rules folder instead of being written into the person's.
 */
const CODEX_PERSONAL_RULES_DIR = "rules";
/** The person's Codex memory stores, skills and hooks; mirrored only for One, and only what it switched on. */
export function isCodexPersonalContextEntry(name: string): boolean {
  return name === "skills" || name === "skills_archive" || name === "hooks" || name === "hooks.json" || name === "memories_extensions"
    || /^memories(?:_v\d+)?(?:_\d+\.sqlite(?:-shm|-wal)?)?$/.test(name);
}
function isMemoryEntry(name: string): boolean {
  return name !== "skills" && name !== "skills_archive" && name !== "hooks" && name !== "hooks.json";
}

export interface CodexProductHomeOptions {
  /**
   * One only: which parts of the person's Codex home it switched on (capabilities/one-capabilities.ts). A second
   * mirror ("-one") links them; AGENTS.md stays out. `hooksJson` is the person's hooks.json cut down to the
   * switched-on entries, written into the mirror as its own file.
   */
  personal?: { memories: boolean; skills: boolean; hooksJson: string | null };
  /**
   * A run whose MCP servers are exactly the ones Main bound for it (an isolated grant: browser turns, AGI attempts). Its
   * own mirror ("-isolated") has an empty config.toml, which is what `codex exec --ignore-user-config` gives; the
   * app-server has no such flag, so the home carries the isolation and the run can resume its thread there too.
   * Sessions and sign-in stay shared, so the thread is the same one.
   */
  isolated?: boolean;
}

/** Entries a product run's mirror must not link: personal instruction files, and personal context unless One chose it. */
function mirrorExcludes(name: string, personal: CodexProductHomeOptions["personal"]): boolean {
  // config.toml is the mirror's own file: the allowlisted keys of the person's (productCodexConfig).
  if (CODEX_PERSONAL_INSTRUCTION_FILES.has(name) || name === "skills_archive" || name === "config.toml" || name === CODEX_PERSONAL_RULES_DIR) return true;
  if (!isCodexPersonalContextEntry(name)) return false;
  if (name === "skills") return !personal?.skills;
  if (name === "hooks.json") return true; // never linked: One gets its own cut-down copy
  if (name === "hooks") return !personal?.hooksJson;
  return isMemoryEntry(name) && !personal?.memories;
}

/** Rollout folders the product mirrors share through codex-product-home/store (threads resume from any mirror). */
const CODEX_PRODUCT_SESSION_DIRS = ["sessions", "archived_sessions"] as const;
/**
 * Entries of the person's home that hold their own sessions, history or Codex app state. A product mirror never links
 * them: Codex creates its own thread index, logs and history in the mirror, and rollouts go to the product store.
 * Measured 2026-10-12 (codex-cli 0.162.1): a home with only auth.json linked starts, and a thread whose rollout file
 * alone was copied into its sessions folder resumes with its memory intact.
 */
export function isCodexPersonalSessionEntry(name: string): boolean {
  return (CODEX_PRODUCT_SESSION_DIRS as readonly string[]).includes(name)
    || /^(?:state|logs|goals|queue|thread_history)_\d+\.sqlite(?:-wal|-shm)?$/.test(name)
    || ["history.jsonl", "session_index.jsonl", "shell_snapshots", "thread-writer-locks", ".tmp", "tmp",
      ".codex-global-state.json", ".codex-global-state.json.bak", "app-server-daemon", "app-server-control", "automations",
      "ambient-suggestions", "dictation-history", "attachments", "external_agent_session_imports.json"].includes(name);
}

function productStoreFor(mirrorRoot: string): string {
  return path.join(mirrorRoot, "store");
}

/** Bind an isolated launch home to the same durable rollouts as ordinary
 * product mirrors. Config, credentials and personal instructions stay local.
 * Existing mirrors retain their historical private-directory behavior; a new
 * caller fails closed rather than replacing an existing rollout directory. */
export function bindCodexProductSessionStore(home: string, mirrorRoot = userDataPath("codex-product-home"), existingMirror = false): void {
  function fail(code: string, cause?: unknown): never { throw Object.assign(new Error(code, { cause }), { code }); }
  const directory = (at: string, create: boolean): void => {
    try {
      if (create) fs.mkdirSync(at, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(at);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        if (existingMirror && stat.isSymbolicLink() && fs.statSync(at).isDirectory()) return;
        fail("codex_product_session_directory_invalid");
      }
    } catch (error) {
      if ((error as { code?: string }).code === "codex_product_session_directory_invalid") throw error;
      fail("codex_product_session_directory_unavailable", error);
    }
  };
  if (!path.isAbsolute(home) || !path.isAbsolute(mirrorRoot)) fail("codex_product_session_path_invalid");
  directory(home, false);
  directory(mirrorRoot, true);
  const store = productStoreFor(fs.realpathSync(mirrorRoot));
  directory(store, true);
  const linkTarget = (at: string): string => path.toNamespacedPath(path.resolve(path.dirname(at), fs.readlinkSync(at)));
  const links = CODEX_PRODUCT_SESSION_DIRS.map(name => ({ at: path.join(home, name), target: path.join(store, name) }));
  for (const { at, target } of links) {
    directory(target, true);
    let stat: fs.Stats | undefined;
    try { stat = fs.lstatSync(at); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; fail("codex_product_session_link_unavailable", error); }
    if (!stat) fail("codex_product_session_link_unavailable");
    if (stat.isSymbolicLink()) {
      if (linkTarget(at) === path.toNamespacedPath(target)) continue;
      if (existingMirror) continue;
    } else if (existingMirror) continue;
    fail("codex_product_session_path_conflict");
  }
  for (const { at, target } of links) {
    try {
      const stat = fs.lstatSync(at);
      if (!stat.isSymbolicLink()) {
        if (existingMirror) continue;
        fail("codex_product_session_path_conflict");
      }
      if (linkTarget(at) === path.toNamespacedPath(target)) continue;
      if (!existingMirror) fail("codex_product_session_path_conflict");
      // Only the ordinary mirror's old replaceable links reach this branch.
      fs.unlinkSync(at);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("codex_product_session_link_failed", error); }
    try { fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try { if (fs.lstatSync(at).isSymbolicLink() && linkTarget(at) === path.toNamespacedPath(target)) continue; } catch { /* concurrent foreign entry */ }
      }
      fail("codex_product_session_link_failed", error);
    }
  }
}

/**
 * The only parts of the person's config.toml a product run gets: what it takes to reach the account's model the way the
 * person's own Codex does. An ALLOWLIST (owner 2026-10-06/10-11: the person's settings never drive product agents). The
 * mirror used to copy the whole file minus `[shell_environment_policy]`, so every table a Codex release or the ChatGPT
 * app adds reached product agents until someone noticed (2026-10-17, owner's config through the mirror: `[features]`
 * chronicle/multi_agent, 28 `[plugins]` incl. OAuth ones (canva, github, notion), 10 `[mcp_servers]`, `notify` (the
 * ChatGPT app's computer-use client, run after every product turn), `[hooks.state]` trust for personal and plugin hooks,
 * 672 trusted `[projects]` (Codex loads a project's `.codex/config.toml` layer only for a trusted folder), personal
 * `approval_policy`/`sandbox_mode`, and the `set` table of `[shell_environment_policy]`, whose values Codex applies after
 * every exclude: MONGODB_URI and GOOGLE_APPLICATION_CREDENTIALS in a product shell, 2026-10-12).
 *
 * Kept, each for one reason:
 *   - sign-in and provider plumbing (without it a custom, enterprise or gateway account cannot authenticate):
 *     `model_provider` (which provider requests go to), `model_providers` (those providers' base URL, wire API, auth
 *     env-var names and headers), `openai_base_url` (the built-in OpenAI provider's endpoint override),
 *     `chatgpt_base_url` (the ChatGPT backend Codex signs in and refreshes tokens against), `forced_login_method` and
 *     `forced_chatgpt_workspace_id` (the sign-in and workspace the account is pinned to), `cli_auth_credentials_store`
 *     (where the sign-in lives; a keyring-only home gets no mirror at all);
 *   - the model default the app falls back to only when it passes no `--model` / effort of its own (codex.ts, "앱이
 *     모델을 갖고 있으면 그 모델이 반드시 이긴다"; cli-default-model.ts shows that same `model` as the run's model):
 *     `model`, `model_reasoning_effort`.
 * A selected `profile` is resolved here: its values for the keys above replace the root ones (Codex applies a profile over
 * the root), and nothing else of any profile is carried.
 * Plus the person's telemetry OPT-OUTS, never an opt-in (owner decision 2026-10-17, every product home: a person who
 * turned vendor telemetry off keeps it off in product runs; otherwise the vendor default): `analytics.enabled = false`
 * and `feedback.enabled = false` (PRODUCT_CODEX_OPT_OUTS). `[otel]` (exporters and their endpoints) is never carried.
 * Everything else is left out by construction, including `features`, `plugins`, `marketplaces`, `mcp_servers`,
 * `skills`, `hooks`, `projects`, `notify`, `approval_policy`, `sandbox_mode`, `shell_environment_policy`, instruction
 * keys (`developer_instructions`, `model_instructions_file`, `experimental_*`), `service_tier`, `personality`,
 * `history`/`sqlite_home`/`log_dir`, `model_catalog_json` (read at start-up, and a relative path would resolve against
 * the mirror: a catalog path that does not exist stops Codex before the first turn, codex-cli 0.163.0) and the app's UI
 * tables. Agentlas sets what a product run needs per run (permission,
 * features, skills, its own MCP servers, the shell environment: codex.ts, codex-personal-context.ts, env-key-reach.ts).
 * A file this cannot read as TOML yields an empty config: a product run then uses Codex's defaults, never the file.
 */
export const PRODUCT_CODEX_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "model_provider", "openai_base_url", "chatgpt_base_url", "forced_login_method", "forced_chatgpt_workspace_id",
  "cli_auth_credentials_store", "model", "model_reasoning_effort",
]);
/** Tables kept whole (every key under them). */
export const PRODUCT_CODEX_CONFIG_TABLES: ReadonlySet<string> = new Set(["model_providers"]);
/** Tables whose `enabled = false` (the person's opt-out of Codex's usage analytics / feedback upload) a product run keeps. */
export const PRODUCT_CODEX_OPT_OUTS: ReadonlySet<string> = new Set(["analytics", "feedback"]);

/** `<table>.enabled = false` when the statement is the person's opt-out of an opt-out table (dotted or inline form), else null. */
function codexOptOut(s: TomlStatement): string | null {
  if (s.inArrayTable || !PRODUCT_CODEX_OPT_OUTS.has(s.path[0])) return null;
  const value = s.value.trim();
  if (s.path.length === 2 && s.path[1] === "enabled" && value === "false") return `${s.path[0]}.enabled = false`;
  if (s.path.length === 1 && /^\{\s*enabled\s*=\s*false\s*\}$/.test(value)) return `${s.path[0]}.enabled = false`;
  return null;
}

export function productCodexConfig(text: string): string {
  let statements: TomlStatement[];
  try { statements = scanTomlStatements(text); } catch { return ""; }
  const root = new Map<string, string>(); // key -> raw value, in first-seen order
  const tables: string[] = [];
  let profile: string | null = null;
  for (const s of statements) {
    if (s.path.length === 1 && s.path[0] === "profile") profile = tomlStringValue(s.value);
  }
  const lifted = new Map<string, string>();
  const optOuts = new Set<string>();
  for (const s of statements) {
    const [head] = s.path;
    const optOut = codexOptOut(s);
    if (optOut) optOuts.add(optOut);
    else if (s.path.length === 1 && PRODUCT_CODEX_CONFIG_KEYS.has(head)) root.set(head, s.value);
    else if (PRODUCT_CODEX_CONFIG_TABLES.has(head) && !s.inArrayTable) tables.push(`${s.path.map(tomlKey).join(".")} = ${s.value}`);
    else if (profile !== null && s.path.length === 3 && head === "profiles" && s.path[1] === profile && PRODUCT_CODEX_CONFIG_KEYS.has(s.path[2])) {
      lifted.set(s.path[2], s.value);
    }
  }
  for (const [key, value] of lifted) root.set(key, value);
  const lines = [...[...root].map(([key, value]) => `${tomlKey(key)} = ${value}`), ...tables, ...optOuts];
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export interface TomlStatement {
  /** Full key path: the enclosing table's path plus the statement's own (dotted) key. */
  path: string[];
  /** The value's source text, exactly as written (strings, arrays and inline tables may span lines). */
  value: string;
  /** Under an `[[array.of.tables]]` header: its keys cannot be written back as dotted root keys. */
  inArrayTable: boolean;
}

export function tomlKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

/** A TOML basic or literal single-line string value, decoded; null for anything else. */
function tomlStringValue(value: string): string | null {
  const v = value.trim();
  if (/^'[^'\n]*'$/.test(v)) return v.slice(1, -1);
  if (/^"(?:[^"\\\n]|\\.)*"$/.test(v)) { try { return JSON.parse(v) as string; } catch { return null; } }
  return null;
}

/**
 * Key/value statements of a TOML document with their full key paths and raw value text. Enough of TOML 1.0 to find
 * statement boundaries exactly (comments, the four string forms, nested arrays and inline tables across lines, quoted
 * and dotted keys, table and array-of-table headers); values are never interpreted. Throws on what it cannot follow.
 */
export function scanTomlStatements(text: string): TomlStatement[] {
  const src = text.replace(/\r\n/g, "\n");
  const out: TomlStatement[] = [];
  let i = 0;
  let table: string[] = [];
  let inArrayTable = false;
  const n = src.length;
  const skipSpace = (): void => { while (i < n && (src[i] === " " || src[i] === "\t")) i += 1; };
  const skipComment = (): void => { if (src[i] === "#") while (i < n && src[i] !== "\n") i += 1; };
  const endOfLine = (): void => {
    skipSpace(); skipComment();
    if (i < n && src[i] !== "\n") throw new Error(`toml: unexpected text at ${i}`);
    i += 1;
  };
  const readKeySegment = (): string => {
    skipSpace();
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === "\\") j += 1; if (src[j] === "\n") throw new Error("toml: newline in key"); j += 1; }
      if (j >= n) throw new Error("toml: unterminated key");
      const raw = src.slice(i, j + 1);
      i = j + 1;
      return JSON.parse(raw.replace(/\\U([0-9A-Fa-f]{8})/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)).replace(/[\\"]/g, (ch) => `\\${ch}`))) as string;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0 || src.slice(i + 1, j).includes("\n")) throw new Error("toml: unterminated key");
      const raw = src.slice(i + 1, j);
      i = j + 1;
      return raw;
    }
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
    if (!m) throw new Error(`toml: bad key at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const readKey = (): string[] => {
    const parts = [readKeySegment()];
    for (;;) {
      skipSpace();
      if (src[i] !== ".") return parts;
      i += 1;
      parts.push(readKeySegment());
    }
  };
  /** Scans one value from `i`; returns its source text. Stops before the comment/newline that ends the statement. */
  const readValue = (): string => {
    const start = i;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'") {
        const triple = src.startsWith(c.repeat(3), i);
        if (triple) {
          let j = i + 3;
          for (;;) {
            const k = src.indexOf(c.repeat(3), j);
            if (k < 0) throw new Error("toml: unterminated multi-line string");
            if (c === '"') {
              let backslashes = 0;
              for (let b = k - 1; b >= i + 3 && src[b] === "\\"; b -= 1) backslashes += 1;
              if (backslashes % 2 === 1) { j = k + 1; continue; }
            }
            i = k + 3;
            while (src[i] === c) i += 1; // up to two quotes may close the content
            break;
          }
        } else {
          let j = i + 1;
          while (j < n && src[j] !== c) {
            if (src[j] === "\n") throw new Error("toml: newline in string");
            if (c === '"' && src[j] === "\\") j += 1;
            j += 1;
          }
          if (j >= n) throw new Error("toml: unterminated string");
          i = j + 1;
        }
        continue;
      }
      if (c === "[" || c === "{") { depth += 1; i += 1; continue; }
      if (c === "]" || c === "}") { depth -= 1; if (depth < 0) throw new Error("toml: unbalanced bracket"); i += 1; continue; }
      if (c === "#") {
        if (depth === 0) break;
        while (i < n && src[i] !== "\n") i += 1;
        continue;
      }
      if (c === "\n" && depth === 0) break;
      i += 1;
    }
    if (depth !== 0) throw new Error("toml: unterminated array or inline table");
    const value = src.slice(start, i).trim();
    if (!value) throw new Error("toml: empty value");
    return value;
  };
  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const c = src[i];
    if (c === "\n") { i += 1; continue; }
    if (c === "#") { skipComment(); continue; }
    if (c === "[") {
      const array = src[i + 1] === "[";
      i += array ? 2 : 1;
      table = readKey();
      skipSpace();
      if (!src.startsWith(array ? "]]" : "]", i)) throw new Error("toml: bad table header");
      i += array ? 2 : 1;
      inArrayTable = array;
      endOfLine();
      continue;
    }
    const key = readKey();
    skipSpace();
    if (src[i] !== "=") throw new Error(`toml: expected = at ${i}`);
    i += 1;
    skipSpace();
    const value = readValue();
    out.push({ path: [...table, ...key], value, inArrayTable });
    endOfLine();
  }
  return out;
}

/**
 * Writes the mirror's config.toml from the person's, only when it changed (Codex may be reading it). A mirror an older
 * install filled with the whole copied config is rewritten to the allowlisted one on its next sync, the same way.
 */
function writeProductConfig(realHome: string, home: string, isolated = false): void {
  const at = path.join(home, "config.toml");
  let source: string | null = null;
  try { source = fs.readFileSync(path.join(realHome, "config.toml"), "utf8"); } catch { /* the person has none */ }
  if (source === null && !isolated) { quietly(() => fs.rmSync(at, { force: true })); return; }
  const wanted = isolated ? "" : productCodexConfig(source ?? "");
  try {
    const stat = fs.lstatSync(at);
    if (stat.isFile() && fs.readFileSync(at, "utf8") === wanted) return;
    if (!stat.isFile()) quietly(() => fs.unlinkSync(at));
  } catch { /* not there yet */ }
  const tmp = `${at}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, wanted, { mode: 0o600 });
  fs.renameSync(tmp, at);
}

/**
 * Codex stores that Agentlas reads back by their real path (generated images: image.ts lookup and the
 * browser upload roots). Made to exist in the real home first, so Codex never creates them in the mirror.
 */
const CODEX_SHARED_STORES = ["generated_images"] as const;

export type CodexProductHomeSkip = "no-real-home" | "no-file-sign-in" | "keyring-sign-in" | "links-unavailable" | "unconfigured-host";

export function realCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  // An inherited product mirror is never the person's folder (product-home-identity.ts): mirroring it nested 1.48 GB.
  return path.resolve(personalHomeOverride(env, "CODEX_HOME") || path.join(personalHomeDir(env), ".codex"));
}

function keyringOnly(realHome: string): boolean {
  try {
    const config = fs.readFileSync(path.join(realHome, "config.toml"), "utf8");
    return /^\s*cli_auth_credentials_store\s*=\s*["']keyring["']/m.test(config);
  } catch {
    return false;
  }
}

/** Brings the mirror in line with the real home. Returns the mirror, or why the real home must be used. */
export function syncCodexProductHome(realHome: string, mirrorRoot = userDataPath("codex-product-home"), options: CodexProductHomeOptions = {}): { home: string } | { skip: CodexProductHomeSkip } {
  // A gate or script (no install identity) never mirrors the account's own ~/.codex (product-home-identity.ts).
  if (productHomeRefusedOnThisHost(realHome)) return { skip: "unconfigured-host" };
  const isolated = options.isolated === true;
  const personal = isolated ? undefined : options.personal;
  let entries: string[];
  try {
    entries = fs.readdirSync(realHome);
  } catch {
    return { skip: "no-real-home" };
  }
  if (!entries.includes("auth.json")) return { skip: "no-file-sign-in" };
  if (keyringOnly(realHome)) return { skip: "keyring-sign-in" };
  const home = mirrorPathFor(realHome, mirrorRoot, personal !== undefined, isolated);
  try {
    for (const store of CODEX_SHARED_STORES) {
      if (!entries.includes(store)) { fs.mkdirSync(path.join(realHome, store), { recursive: true }); entries.push(store); }
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const wanted = new Set(entries.filter((name) => name !== MIRROR_LINK_RECORD && !mirrorExcludes(name, personal) && !isCodexPersonalSessionEntry(name)));
    const target = (name: string): string => path.join(realHome, name);
    // Windows hard links / copies first: one no longer wanted goes, the rest behave like the links they stand for.
    reconcileMirrorLinks(home, new Map([...wanted].map((name) => [name, target(name)] as const)));
    for (const name of fs.readdirSync(home)) {
      if ((CODEX_PRODUCT_SESSION_DIRS as readonly string[]).includes(name) || name === MIRROR_LINK_RECORD) continue;
      const at = path.join(home, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(at); } catch { continue; }
      if (CODEX_PERSONAL_INSTRUCTION_FILES.has(name)) { quietly(() => stat.isSymbolicLink() ? fs.unlinkSync(at) : fs.rmSync(at, { recursive: true })); continue; }
      if (stat.isSymbolicLink()) {
        // unlink, not rm: rm stats through a dangling link and reports ENOENT for the link itself.
        if (!wanted.has(name) || fs.readlinkSync(at) !== target(name)) quietly(() => fs.unlinkSync(at));
        continue;
      }
      if (isRecordedMirrorEntry(home, name)) continue; // a link made on Windows, kept in line above
      if (wanted.has(name) && adoptMirrorHardLink(home, name, target(name))) continue;
      // Codex made this here because the real home had none at the time (a store a newer Codex adds).
      // It stays the mirror's own and is never moved or deleted: it may be open. config.toml is rewritten
      // from the person's below (a config Codex rewrote here yields to the person's, which is the authority).
      wanted.delete(name);
    }
    for (const name of wanted) {
      const at = path.join(home, name);
      if (isLink(at) || fs.existsSync(at)) continue;
      quietly(() => { linkMirrorEntry(target(name), at); });
    }
    bindCodexProductSessionStore(home, mirrorRoot, true);
    writeProductConfig(realHome, home, isolated);
    // hooks.json is never a link: One gets a cut-down copy, everyone else none.
    const hooksAt = path.join(home, "hooks.json");
    quietly(() => fs.rmSync(hooksAt, { force: true }));
    if (personal?.hooksJson) fs.writeFileSync(hooksAt, personal.hooksJson, { mode: 0o600 });
    if (!mirrorEntryLinked(home, "auth.json")) { reportIsolationUnavailable("codex", "sign-in-not-linked"); return { skip: "links-unavailable" }; }
  } catch (error) {
    reportIsolationUnavailable("codex", error);
    return { skip: "links-unavailable" };
  }
  return { home };
}

/** Two runs may sync at once: the other one having made or removed the same link is not a failure. */
function quietly(action: () => void): void {
  try {
    action();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
  }
}

function isLink(at: string): boolean {
  try {
    return fs.lstatSync(at).isSymbolicLink();
  } catch {
    return false;
  }
}

function mirrorPathFor(realHome: string, mirrorRoot = userDataPath("codex-product-home"), personal = false, isolated = false): string {
  return path.join(mirrorRoot, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12) + (isolated ? "-isolated" : personal ? "-one" : ""));
}

/** Whether `home` is the isolated mirror (empty config.toml) of the person's own Codex home. */
export function isIsolatedCodexProductHome(home: string | undefined): boolean {
  if (!home) return false;
  try {
    return path.resolve(home) === mirrorPathFor(realCodexHome(process.env), undefined, false, true);
  } catch {
    return false;
  }
}

/**
 * The account home behind a run's CODEX_HOME. Readers that refuse symlinks on purpose (the model cache reader opens
 * with O_NOFOLLOW) must read the real file, not the mirror's link to it; any other home is returned as given.
 */
export function accountCodexHome(home: string | undefined): string | undefined {
  if (!home) return home;
  const realHome = realCodexHome(process.env);
  try {
    const at = path.resolve(home);
    return at === mirrorPathFor(realHome) || at === mirrorPathFor(realHome, undefined, true)
      || at === mirrorPathFor(realHome, undefined, false, true) ? realHome : home;
  } catch {
    return home;
  }
}

/**
 * The home whose config a product run started from `home` actually reads, for readers that decide before the run starts
 * (codex-desktop-surface.ts codexUserConfigOutsideBrowser): the product mirror once it holds the person's sign-in, else
 * `home` itself (a home Main chose, a keyring sign-in, no mirror made yet). Every mirror's config is the allowlisted one.
 */
export function codexProductRunHome(home: string): string {
  try {
    const realHome = realCodexHome(process.env);
    if (path.resolve(home) !== realHome) return home;
    const mirror = mirrorPathFor(realHome);
    return mirrorEntryLinked(mirror, "auth.json") && !keyringOnly(realHome) ? mirror : home;
  } catch {
    return home;
  }
}

/**
 * The environment a product Codex run starts with. A home Main already chose for the run (a Science
 * grant, an observation look) is kept; only the user's own home is swapped for its mirror.
 */
export function withCodexProductHome(env: NodeJS.ProcessEnv = process.env, options: CodexProductHomeOptions = {}): NodeJS.ProcessEnv {
  const realHome = realCodexHome(process.env);
  if (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== realHome && !inheritedProductHome(env, "CODEX_HOME")) return env;
  const mirror = syncCodexProductHome(realHome, undefined, options);
  return "home" in mirror ? { ...env, CODEX_HOME: mirror.home } : env;
}

const adoptedThreads = new Set<string>();
/**
 * A thread an older install wrote into the person's own sessions folder, copied into the product store before it is
 * resumed from a product mirror (the rollout file alone is enough: measured 2026-10-12, the memory carried over). The
 * person's copy is left where it is. Nothing happens for a home that is not a product mirror or a thread already there.
 */
export function adoptCodexThreadIntoProductStore(home: string | undefined, threadId: string, mirrorRoot = userDataPath("codex-product-home")): boolean {
  if (!home || !/^[0-9a-f-]{16,64}$/i.test(threadId) || adoptedThreads.has(threadId)) return false;
  if (path.dirname(path.resolve(home)) !== path.resolve(mirrorRoot) || path.basename(home) === "store") return false;
  // The account home this mirror was made from: its sign-in link (a symlink, or a recorded Windows hard link / copy) points there.
  const signIn = mirrorEntryTarget(home, "auth.json");
  if (signIn === null) return false;
  const realHome = path.dirname(path.resolve(path.resolve(home), signIn));
  const store = productStoreFor(mirrorRoot);
  const suffix = `-${threadId}.jsonl`;
  const find = (root: string): string | null => {
    const walk = (dir: string, depth: number): string | null => {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const entry of names) {
        if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) return path.join(dir, entry.name);
      }
      if (depth >= 3) return null;
      for (const entry of names.filter((e) => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
        const hit = walk(path.join(dir, entry.name), depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root, 0);
  };
  try {
    for (const dir of CODEX_PRODUCT_SESSION_DIRS) {
      if (find(path.join(store, dir))) { adoptedThreads.add(threadId); return false; }
    }
    for (const dir of CODEX_PRODUCT_SESSION_DIRS) {
      const source = find(path.join(realHome, dir));
      if (!source) continue;
      const destination = path.join(store, dir, path.relative(path.join(realHome, dir), source));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      adoptedThreads.add(threadId);
      return true;
    }
  } catch {
    // A failed copy leaves the resume to the runner's own fresh-session recovery.
  }
  return false;
}
