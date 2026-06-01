"use strict";
/*
 * agentlas-input: terminal input ergonomics for the REPL.
 *   - persistent command history (load/save across sessions, per machine)
 *   - tab autocomplete (slash commands, agent/firm slugs, runtime kinds, perm levels, @paths, /cwd /import paths)
 *   - multiline composer (trailing backslash continues the line)
 * Self-contained, zero-dependency, TTY-aware. Pure functions are unit-testable under plain node.
 * (Ctrl-R reverse-i-search needs TTY keypress + rl internals → tracked separately; /history bridges it.)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

const HISTORY_MAX = 500;
function historyPath() {
  return path.join(userDataDir(), "cli-history.json");
}
// readline keeps history with index 0 = most-recent. We persist that array verbatim.
function loadHistory() {
  try {
    const a = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
    return Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}
function saveHistory(list) {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    const clean = (list || []).filter((x) => typeof x === "string" && x.trim()).slice(0, HISTORY_MAX);
    fs.writeFileSync(historyPath(), JSON.stringify(clean), "utf8");
    return true;
  } catch {
    return false;
  }
}
// Seed an interactive readline with saved history (no-op on non-TTY).
function attachHistory(rl) {
  try {
    if (rl && rl.terminal && Array.isArray(rl.history)) rl.history = loadHistory();
  } catch {
    /* ignore */
  }
}
function persistHistory(rl) {
  try {
    if (rl && Array.isArray(rl.history)) saveHistory(rl.history);
  } catch {
    /* ignore */
  }
}

// ── multiline ─────────────────────────────────────────────
// A line ending in an odd number of trailing backslashes is a continuation.
function isContinuation(line) {
  const m = /\\+$/.exec(line || "");
  return !!m && m[0].length % 2 === 1;
}
function stripContinuation(line) {
  return (line || "").replace(/\\$/, "");
}

// ── completion ────────────────────────────────────────────
const SLASH_COMMANDS = [
  "/help", "/agents", "/team", "/agent", "/firms", "/firm", "/runtime", "/model",
  "/permission", "/perm", "/cwd", "/memory", "/clear", "/import", "/doctor",
  "/status", "/cost", "/multimodal", "/diff", "/history", "/exit", "/quit",
];
const RUNTIME_SPECS = ["claude-code", "codex", "gemini", "anthropic", "openai", "google", "ollama", "upstage"];
const PERM_LEVELS = ["read", "write", "full"];

function uniqStartsWith(cands, token) {
  const hits = cands.filter((c) => c.startsWith(token));
  return hits.length ? hits : cands;
}

// List filesystem entries under the partial path `token` relative to `cwd`.
// Returns candidates in the SAME shape as the token (so readline substitutes the last word).
function completePath(token, cwd, prefixChar) {
  let p = token;
  const lead = prefixChar || "";
  try {
    const hasSlash = p.includes("/");
    const dirPart = hasSlash ? p.slice(0, p.lastIndexOf("/") + 1) : "";
    const basePart = hasSlash ? p.slice(p.lastIndexOf("/") + 1) : p;
    const absDir = path.resolve(cwd || ".", dirPart || ".");
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const hits = entries
      .filter((e) => e.name.startsWith(basePart) && !e.name.startsWith("."))
      .slice(0, 100)
      .map((e) => lead + dirPart + e.name + (e.isDirectory() ? "/" : ""))
      .sort();
    return hits;
  } catch {
    return [];
  }
}

// makeCompleter({ getAgentSlugs, getFirmSlugs, getCwd }) → readline completer(line) → [hits, token]
function makeCompleter(ctx) {
  const getAgents = ctx.getAgentSlugs || (() => []);
  const getFirms = ctx.getFirmSlugs || (() => []);
  const getCwd = ctx.getCwd || (() => process.cwd());
  return function completer(line) {
    const lineStr = line || "";
    const tokens = lineStr.split(/\s+/);
    const last = tokens[tokens.length - 1] || "";

    // @file mention anywhere in the last token
    if (last.startsWith("@")) {
      return [completePath(last.slice(1), getCwd(), "@"), last];
    }

    // first token = the command itself
    if (tokens.length === 1) {
      if (lineStr.startsWith("/")) return [uniqStartsWith(SLASH_COMMANDS, last), last];
      return [[], last]; // free-text prompt — no completion
    }

    const cmd = tokens[0];
    switch (cmd) {
      case "/runtime":
        return [uniqStartsWith(RUNTIME_SPECS, last), last];
      case "/permission":
      case "/perm":
        return [uniqStartsWith(PERM_LEVELS, last), last];
      case "/agent":
        return [uniqStartsWith(getAgents(), last), last];
      case "/firm":
        return [uniqStartsWith(getFirms(), last), last];
      case "/team":
        if (tokens.length === 2) return [uniqStartsWith(getAgents(), last), last];
        return [uniqStartsWith(RUNTIME_SPECS.concat(["auto"]), last), last];
      case "/cwd":
      case "/import":
        return [completePath(last, getCwd(), ""), last];
      default:
        return [[], last];
    }
  };
}

module.exports = {
  userDataDir,
  historyPath,
  loadHistory,
  saveHistory,
  attachHistory,
  persistHistory,
  isContinuation,
  stripContinuation,
  makeCompleter,
  completePath,
  SLASH_COMMANDS,
  RUNTIME_SPECS,
  PERM_LEVELS,
  HISTORY_MAX,
};
