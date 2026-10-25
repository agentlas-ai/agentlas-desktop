// Product homes for the subscription CLIs that keep their sessions in a config folder of the person's own: Kimi
// (KIMI_CODE_HOME, default ~/.kimi-code), Cursor Agent (CURSOR_CONFIG_DIR, default ~/.cursor) and GitHub Copilot CLI
// (COPILOT_HOME, default ~/.copilot). Owner order 2026-10-13: the product's sessions live only on the Agentlas side and
// never show up in the person's own apps, without logging the person out. Same pattern as codex-product-home.ts and
// the Grok / Antigravity mirrors (config-home-mirror.ts), with one difference: the mirror is an ALLOWLIST. Only the
// entries below are linked from the real folder; everything else (sessions, chats, history, logs, instruction files,
// skills, MCP lists, hooks, plugins) is the mirror's own, so a CLI that adds a new store never writes it into the
// person's folder, and the person's personal context stays out of product runs (owner 2026-10-11).
//
// A config file that mixes sign-in with the person's policy is the mirror's own file holding only an allowlist of the
// person's (owner 2026-10-06/10-11: the person's settings never drive product agents; 2026-10-17 the Codex and Claude
// copies were found carrying personal MCP servers, hooks and auto-approved command rules into product runs): Kimi's
// config.toml (productKimiConfig) and Cursor's cli-config.json (productCursorCliConfig). Linked whole, the person's
// permission rules, default permission mode (`yolo`), hooks and extra skill folders reached every product turn.
//
// Sign-in: none of these relocations touch the OS keychain or the person's files. Only the environment variable of the
// run changes (HOME is untouched, so the login keychain and its search list resolve exactly as for the person), and
// file sign-ins (Kimi credentials/, the account record in config files) are symlinks to the real files, so a token
// refresh lands in the person's file. A keychain item is keyed by service and account, not by the config folder
// (Copilot: service "copilot-cli"; Cursor: "cursor-access-token"; Linux Cursor keeps auth.json under XDG, outside
// CURSOR_CONFIG_DIR) - taken from the CLIs' docs and `copilot help environment`, NOT measured: only Copilot is
// installed on the measuring machine and `copilot --version` is the only call made (no login, no keychain read).
// `AGENTLAS_<KIND>_KEEP_HOME=1` keeps the real folder.
//
// Windows: symlinks to files need a privilege, so a file is a recorded hard link (or, on another volume, a copy) that
// every sync reconciles both ways, so a refreshed token is never forked; directories are junctions (mirror-link.ts,
// Windows audit 2026-10-24, W-03). A mirror that still cannot hold is reported, never silent.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import { mirrorEntryTarget, reportIsolationUnavailable } from "./mirror-link";
import { scanTomlStatements, tomlKey, type TomlStatement } from "./codex-product-home";
import type { CapabilitySelection } from "../capabilities/one-capabilities";
import { personalHomeDir, personalHomeOverride, productHomeRefusedOnThisHost } from "./product-home-identity";

export type ProductHomeKind = "kimi" | "cursor" | "github-copilot-cli";

interface HomeSpec {
  envVar: string;
  folder: string;
  mirrorDir: string;
  /** The only entries linked from the person's folder: sign-in and account records, binaries, update state. */
  linked: readonly string[];
  /** Linked entries that, when present, prove the mirror carries the sign-in. */
  signIn: readonly string[];
  /** Files the mirror owns, built from the person's folder (name -> text); never linked. */
  own?: (realHome: string, selection: CapabilitySelection | undefined) => Record<string, string>;
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/**
 * The statements of a TOML document whose key path `keep` accepts, written back as dotted root keys (values exactly as
 * written). A file that cannot be read as TOML yields an empty document: a product run then gets the CLI's defaults,
 * never the file. `[[array.of.tables]]` statements cannot be written as dotted keys and are left out.
 */
export function allowlistedToml(text: string, keep: (statement: TomlStatement) => boolean): string {
  let statements: TomlStatement[];
  try { statements = scanTomlStatements(text); } catch { return ""; }
  const lines = statements.filter((s) => !s.inArrayTable && keep(s)).map((s) => `${s.path.map(tomlKey).join(".")} = ${s.value}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Top-level keys of the person's Kimi Code config.toml a product run keeps (Kimi Code 0.28 KimiConfigSchema, read from
 * the installed package), each for one reason:
 *   - sign-in and provider plumbing, without which the account cannot reach its model: `providers` (type, base URL, API
 *     key or OAuth token reference, env and headers), `default_provider`, `services` (the account's Moonshot search and
 *     fetch endpoints and their credentials, which the CLI's built-in web tools call);
 *   - the model default the CLI falls back to when the app passes no `--model` (without one Kimi stops with "No model
 *     configured"): `default_model`, `models` (the aliases mapping a model name to its provider), `thinking`;
 *   - `telemetry = false` only: the person's opt-out of usage data (owner decision 2026-10-17, every product home: carry
 *     telemetry OPT-OUTS, never an opt-in; otherwise the vendor default). It changes nothing an agent does.
 * Everything else is left out by construction: `permission` (rules), `yolo`, `plan_mode`, `default_permission_mode`,
 * `default_plan_mode`, `hooks` (commands run on agent events), `extra_skill_dirs`, `merge_all_available_skills`,
 * `loop_control`, `background`, `subagent`, `image`, `model_catalog`, `experimental` and any key a later release adds.
 */
const KIMI_PRODUCT_CONFIG_KEYS: ReadonlySet<string> = new Set(["providers", "default_provider", "services", "default_model", "models", "thinking"]);

export function productKimiConfig(text: string): string {
  return allowlistedToml(text, (s) => KIMI_PRODUCT_CONFIG_KEYS.has(s.path[0])
    || (s.path.length === 1 && s.path[0] === "telemetry" && s.value.trim() === "false"));
}

/**
 * The mirror's own Cursor Agent cli-config.json. Kept from the person's, each for one reason: `version` (the file's
 * schema version), `authInfo` (the signed-in account's record; the tokens themselves are in the OS keychain, or under
 * XDG on Linux, outside CURSOR_CONFIG_DIR), `privacyCache` (the account's privacy mode as last fetched), `network` (the
 * transport to Cursor's backend, e.g. HTTP/1 behind a proxy), `model` and `hasChangedDefaultModel` (the model default
 * the CLI falls back to when the app passes no `--model`). `editor` and `permissions` are fields the CLI requires; they
 * are written with neutral values (no pre-approved command: Agentlas decides product approvals). Everything else of the
 * person's, above all `permissions.allow` (commands that run without asking), is left out by construction. A file that
 * is not JSON contributes only the neutral fields. Taken from Cursor's CLI documentation, NOT measured: Cursor Agent is
 * not installed on the measuring machine.
 */
const CURSOR_PRODUCT_CONFIG_KEYS: readonly string[] = ["version", "authInfo", "privacyCache", "network", "model", "hasChangedDefaultModel"];

export function productCursorCliConfig(text: string | null): string {
  let source: Record<string, unknown> = {};
  try {
    const parsed = text === null ? {} : JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) source = parsed as Record<string, unknown>;
  } catch { /* not JSON: neutral fields only */ }
  const out: Record<string, unknown> = { version: 1 };
  for (const key of CURSOR_PRODUCT_CONFIG_KEYS) if (key in source) out[key] = source[key];
  out.editor = { vimMode: false };
  out.permissions = { allow: [], deny: [] };
  return `${JSON.stringify(out, null, 2)}\n`;
}

const SPECS: Record<ProductHomeKind, HomeSpec> = {
  // config.toml is the mirror's own allowlisted file; the OAuth tokens (credentials/) stay one and the same file.
  kimi: {
    envVar: "KIMI_CODE_HOME", folder: ".kimi-code", mirrorDir: "kimi-product-home",
    linked: ["credentials", "device_id", "migrations-effort.json", "bin", "updates"],
    signIn: ["credentials"],
    own: (realHome) => ({ "config.toml": productKimiConfig(readText(path.join(realHome, "config.toml")) ?? "") }),
  },
  // Nothing is linked: cli-config.json is the mirror's own allowlisted file and the tokens are not in this folder.
  cursor: {
    envVar: "CURSOR_CONFIG_DIR", folder: ".cursor", mirrorDir: "cursor-product-home",
    linked: [], signIn: [],
    own: (realHome) => ({ "cli-config.json": productCursorCliConfig(readText(path.join(realHome, "cli-config.json"))) }),
  },
  // settings.json is NOT linked: its user-level hooks and instruction switches are the person's own context.
  // config.json is the CLI-managed state the account record lives in ("User settings belong in settings.json"); the
  // user settings (allowedUrls, trustedFolders, defaultPermissionMode, model, hooks) are in settings.json (copilot 1.0.91
  // `copilot help config`).
  "github-copilot-cli": {
    envVar: "COPILOT_HOME", folder: ".copilot", mirrorDir: "copilot-product-home",
    linked: ["config.json"], signIn: ["config.json"],
    own: (realHome, selection) => ({ "mcp-config.json": copilotMcpConfig(realHome, selection) }),
  },
};

export type CliProductHomeSkip = "keep-home" | "links-unavailable" | "unsupported-kind" | "unconfigured-host";

export function realCliHome(kind: ProductHomeKind, env: NodeJS.ProcessEnv = process.env): string {
  const spec = SPECS[kind];
  return path.resolve(personalHomeOverride(env, spec.envVar) || path.join(personalHomeDir(env), spec.folder));
}

export function cliProductHomePath(kind: ProductHomeKind, realHome: string, isOne = false, mirrorRoot = userDataPath(SPECS[kind].mirrorDir)): string {
  return path.join(mirrorRoot, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12) + (isOne ? "-one" : ""));
}

/** Copilot's MCP servers One switched on, cut out of the person's mcp-config.json (nothing else of it is carried). */
function copilotMcpConfig(realHome: string, selection: CapabilitySelection | undefined): string {
  const wanted = new Set(selection?.isOne === true
    ? selection.items.filter((item) => item.source === "copilot" && item.kind === "connector" && item.enabled).map((item) => item.name) : []);
  let servers: Record<string, unknown> = {};
  if (wanted.size > 0) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(realHome, "mcp-config.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
      servers = Object.fromEntries(Object.entries(parsed.mcpServers ?? {}).filter(([name]) => wanted.has(name)));
    } catch { /* unreadable: no servers */ }
  }
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

/** Builds or refreshes the mirror. Never throws; a skip means the run keeps the person's folder. */
export function syncCliProductHome(kind: ProductHomeKind, realHome: string, selection?: CapabilitySelection, mirrorRoot?: string): { home: string } | { skip: CliProductHomeSkip } {
  const spec = SPECS[kind];
  if (!spec) return { skip: "unsupported-kind" };
  // A gate or script (no install identity) never mirrors the account's own CLI folder (product-home-identity.ts).
  if (productHomeRefusedOnThisHost(realHome)) return { skip: "unconfigured-host" };
  const isOne = selection?.isOne === true;
  const home = cliProductHomePath(kind, realHome, isOne, mirrorRoot);
  try {
    if (fs.existsSync(realHome)) {
      // An older mirror's link to a file the mirror now owns is replaced by the allowlisted file (syncConfigHomeMirror
      // drops links it no longer wants and rewrites an own file only when its text changed).
      syncConfigHomeMirror({
        realDir: realHome,
        mirrorDir: home,
        hide: (name) => !spec.linked.includes(name),
        ...(spec.own ? { own: spec.own(realHome, selection) } : {}),
      });
      for (const name of spec.signIn) {
        if (fs.existsSync(path.join(realHome, name)) && !isMirrorLink(home, name)) { reportIsolationUnavailable(kind, "sign-in-not-linked"); return { skip: "links-unavailable" }; }
      }
    } else {
      // Nothing of the person's to link (a CLI they never ran): the run still keeps its sessions in the mirror.
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    }
  } catch (error) {
    reportIsolationUnavailable(kind, error);
    return { skip: "links-unavailable" };
  }
  return { home };
}

/** The account folder a mirror was made from: where its config.json link (symlink, or recorded hard link / copy) points. */
function linkedRealHome(mirrorHome: string): string {
  const target = mirrorEntryTarget(mirrorHome, "config.json");
  if (target === null) throw Object.assign(new Error("mirror_link_absent"), { code: "ENOENT" });
  return path.dirname(path.resolve(mirrorHome, target));
}

/** The run environment with the CLI's config folder variable pointing at the product mirror. */
export function withCliProductHome(kind: ProductHomeKind, env: NodeJS.ProcessEnv, selection?: CapabilitySelection): NodeJS.ProcessEnv {
  const spec = SPECS[kind];
  if (!spec || process.env[`AGENTLAS_${kind.toUpperCase().replace(/-/g, "_")}_KEEP_HOME`] === "1") return env;
  const real = realCliHome(kind, process.env);
  // A folder Main chose for this run is kept; only the person's own folder is swapped for its mirror.
  if (env[spec.envVar] && path.resolve(env[spec.envVar]!) !== real) return env;
  const mirror = syncCliProductHome(kind, real, selection);
  return "home" in mirror ? { ...env, [spec.envVar]: mirror.home } : env;
}

/**
 * Whether a Copilot session no longer exists: the session-state/<id> folder IS the session, and neither the product mirror
 * nor the account folder it was made from (where adoptCopilotSession copies one from) holds it. Only an Agentlas mirror
 * is judged; any other folder, or one that cannot be read, answers false.
 */
export function copilotSessionGone(mirrorHome: string | undefined, sessionId: string, mirrorRoot = userDataPath(SPECS["github-copilot-cli"].mirrorDir)): boolean {
  if (!mirrorHome || !/^[0-9a-f-]{16,64}$/i.test(sessionId)) return false;
  if (path.dirname(path.resolve(mirrorHome)) !== path.resolve(mirrorRoot)) return false;
  try {
    if (fs.existsSync(path.join(mirrorHome, "session-state", sessionId))) return false;
    const realHome = linkedRealHome(mirrorHome);
    return !fs.existsSync(path.join(realHome, "session-state", sessionId));
  } catch {
    return false;
  }
}

const adoptedCopilot = new Set<string>();
/**
 * A Copilot session an older install wrote into the person's own ~/.copilot/session-state, copied into the product
 * mirror before it is resumed from there (the person's copy stays). Returns whether a copy was made.
 */
export function adoptCopilotSession(mirrorHome: string | undefined, sessionId: string, mirrorRoot = userDataPath(SPECS["github-copilot-cli"].mirrorDir)): boolean {
  if (!mirrorHome || !/^[0-9a-f-]{16,64}$/i.test(sessionId) || adoptedCopilot.has(sessionId)) return false;
  if (path.dirname(path.resolve(mirrorHome)) !== path.resolve(mirrorRoot)) return false;
  try {
    const target = path.join(mirrorHome, "session-state", sessionId);
    if (fs.existsSync(target)) { adoptedCopilot.add(sessionId); return false; }
    // The account folder this mirror was made from: its config.json link points there.
    const realHome = linkedRealHome(mirrorHome);
    const source = path.join(realHome, "session-state", sessionId);
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    adoptedCopilot.add(sessionId);
    return true;
  } catch {
    return false;
  }
}
