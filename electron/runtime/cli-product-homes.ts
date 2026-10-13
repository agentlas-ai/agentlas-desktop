// Product homes for the subscription CLIs that keep their sessions in a config folder of the person's own: Kimi
// (KIMI_CODE_HOME, default ~/.kimi-code), Cursor Agent (CURSOR_CONFIG_DIR, default ~/.cursor) and GitHub Copilot CLI
// (COPILOT_HOME, default ~/.copilot). Owner order 2026-10-13: the product's sessions live only on the Agentlas side and
// never show up in the person's own apps, without logging the person out. Same pattern as codex-product-home.ts and
// the Grok / Antigravity mirrors (config-home-mirror.ts), with one difference: the mirror is an ALLOWLIST. Only the
// entries below are linked from the real folder; everything else (sessions, chats, history, logs, instruction files,
// skills, MCP lists, hooks, plugins) is the mirror's own, so a CLI that adds a new store never writes it into the
// person's folder, and the person's personal context stays out of product runs (owner 2026-10-11).
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
// Windows: symlinks to files need a privilege, so a failed link makes the run keep the real folder (a copy would fork
// a refreshed token); directories are linked as junctions (config-home-mirror.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import type { CapabilitySelection } from "../capabilities/one-capabilities";

export type ProductHomeKind = "kimi" | "cursor" | "github-copilot-cli";

interface HomeSpec {
  envVar: string;
  folder: string;
  mirrorDir: string;
  /** The only entries linked from the person's folder: sign-in and account records, binaries, update state. */
  linked: readonly string[];
  /** Linked entries that, when present, prove the mirror carries the sign-in. */
  signIn: readonly string[];
}

const SPECS: Record<ProductHomeKind, HomeSpec> = {
  kimi: {
    envVar: "KIMI_CODE_HOME", folder: ".kimi-code", mirrorDir: "kimi-product-home",
    linked: ["config.toml", "credentials", "device_id", "migrations-effort.json", "bin", "updates"],
    signIn: ["config.toml", "credentials"],
  },
  cursor: {
    envVar: "CURSOR_CONFIG_DIR", folder: ".cursor", mirrorDir: "cursor-product-home",
    linked: ["cli-config.json"], signIn: ["cli-config.json"],
  },
  // settings.json is NOT linked: its user-level hooks and instruction switches are the person's own context.
  "github-copilot-cli": {
    envVar: "COPILOT_HOME", folder: ".copilot", mirrorDir: "copilot-product-home",
    linked: ["config.json"], signIn: ["config.json"],
  },
};

export type CliProductHomeSkip = "keep-home" | "links-unavailable" | "unsupported-kind";

export function realCliHome(kind: ProductHomeKind, env: NodeJS.ProcessEnv = process.env): string {
  const spec = SPECS[kind];
  return path.resolve(env[spec.envVar] || path.join(env.HOME || env.USERPROFILE || os.homedir(), spec.folder));
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
  const isOne = selection?.isOne === true;
  const home = cliProductHomePath(kind, realHome, isOne, mirrorRoot);
  try {
    if (fs.existsSync(realHome)) {
      syncConfigHomeMirror({
        realDir: realHome,
        mirrorDir: home,
        hide: (name) => !spec.linked.includes(name),
        ...(kind === "github-copilot-cli" ? { own: { "mcp-config.json": copilotMcpConfig(realHome, selection) } } : {}),
      });
      for (const name of spec.signIn) {
        if (fs.existsSync(path.join(realHome, name)) && !isMirrorLink(home, name)) return { skip: "links-unavailable" };
      }
    } else {
      // Nothing of the person's to link (a CLI they never ran): the run still keeps its sessions in the mirror.
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    }
  } catch {
    return { skip: "links-unavailable" };
  }
  return { home };
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
    const realHome = path.dirname(path.resolve(mirrorHome, fs.readlinkSync(path.join(mirrorHome, "config.json"))));
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
