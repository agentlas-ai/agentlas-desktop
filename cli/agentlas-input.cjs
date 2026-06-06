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
const readline = require("node:readline");

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
const SLASH_COMMAND_META = [
  ["/help", "Show Agentlas terminal commands"],
  ["/status", "Show model/runtime, agent, permission, and directory"],
  ["/skills", "List available Agentlas terminal skills"],
  ["/ontology", "Turn on, list, or add project ontology sources"],
  ["/agents", "List installed agents"],
  ["/team", "View or pin each agent runtime"],
  ["/agent", "Switch to another agent"],
  ["/firms", "List installed companies"],
  ["/firm", "Switch to a company CEO"],
  ["/runtime", "Switch runtime: claude-code, codex, gemini, BYOK, or Ollama"],
  ["/model", "Set the model for BYOK or Ollama runtimes"],
  ["/permission", "Set read/write/full permission"],
  ["/permissions", "Show or set current permission"],
  ["/perm", "Alias for /permission"],
  ["/cwd", "Show or change the working folder"],
  ["/memory", "Show the memory injected into this run"],
  ["/multimodal", "Show or set image, video, and audio fallback providers"],
  ["/diff", "Show the current git diff"],
  ["/history", "Show recent inputs"],
  ["/compact", "Drop older transcript turns and keep recent context"],
  ["/keybindings", "Show terminal shortcuts"],
  ["/clear", "Clear the chat and redraw"],
  ["/import", "Import a local agent or team folder"],
  ["/doctor", "Check runtimes and local data"],
  ["/exit", "Quit Agentlas"],
  ["/quit", "Quit Agentlas"],
];
const SLASH_COMMANDS = SLASH_COMMAND_META.map(([command]) => command);
const RUNTIME_SPECS = ["claude-code", "codex", "gemini", "anthropic", "openai", "google", "ollama", "upstage"];
const PERM_LEVELS = ["read", "write", "full"];

function uniqStartsWith(cands, token) {
  const hits = cands.filter((c) => c.startsWith(token));
  return hits.length ? hits : cands;
}

function slashCommandEntries() {
  return SLASH_COMMAND_META.map(([command, description]) => ({ command, description }));
}

function slashCommandQuery(line) {
  const value = String(line || "");
  if (!value.startsWith("/")) return null;
  if (/\s/.test(value)) return null;
  return value;
}

function slashCommandSuggestions(line, limit = 12) {
  const query = slashCommandQuery(line);
  if (query == null) return [];
  const q = query.toLowerCase();
  const entries = slashCommandEntries();
  const starts = entries.filter((entry) => entry.command.toLowerCase().startsWith(q));
  const contains = entries.filter(
    (entry) =>
      !entry.command.toLowerCase().startsWith(q) &&
      (entry.command.toLowerCase().includes(q.slice(1)) || entry.description.toLowerCase().includes(q.slice(1))),
  );
  return (starts.length ? starts.concat(contains) : entries).slice(0, limit);
}

function padVisible(value, width) {
  const clean = stripAnsiLite(value);
  if (clean.length >= width) return value;
  return value + " ".repeat(width - clean.length);
}

function stripAnsiLite(value) {
  // eslint-disable-next-line no-control-regex
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function truncateVisible(value, width) {
  const clean = stripAnsiLite(value);
  if (clean.length <= width) return value;
  return clean.slice(0, Math.max(0, width - 1)) + "…";
}

function renderSlashPalette(rows, selectedIndex, opts = {}) {
  if (!rows.length) return "";
  const columns = Math.max(48, Number(opts.columns || 88));
  const fallbackColors = {
    faint: (s) => String(s),
    dim: (s) => String(s),
    text: (s) => String(s),
    blue: (s) => String(s),
    inverse: (s) => String(s),
  };
  const c = { ...fallbackColors, ...(opts.colors || {}) };
  const commandWidth = Math.min(24, Math.max(16, rows.reduce((n, row) => Math.max(n, row.command.length), 0) + 2));
  const descWidth = Math.max(12, columns - commandWidth - 8);
  const lineWidth = Math.min(columns - 1, commandWidth + descWidth + 5);
  const out = [c.faint("─".repeat(lineWidth))];
  rows.forEach((row, index) => {
    const command = padVisible(row.command, commandWidth);
    const desc = truncateVisible(row.description, descWidth);
    const body = " " + c.blue(command) + c.text(desc);
    out.push(index === selectedIndex ? c.inverse(body.padEnd(lineWidth)) : body);
  });
  out.push(c.faint("─".repeat(lineWidth)));
  out.push(c.dim(" ↑↓ move  Enter run  Tab complete  Esc close"));
  return out.join("\n");
}

function attachSlashPalette(rl, opts = {}) {
  const stream = opts.stream || rl.output || process.stdout;
  const inputStream = rl.input || process.stdin;
  const isTty = opts.force || Boolean(rl.terminal && inputStream.isTTY && stream.isTTY);
  if (!rl || !inputStream || !stream || !isTty) {
    return { clear() {}, detach() {}, active: () => false };
  }
  const colors = opts.colors || (opts.ui && opts.ui.c) || {};
  const state = {
    selected: 0,
    selectedCommand: null,
    visible: false,
    dismissedForLine: null,
  };

  readline.emitKeypressEvents(inputStream, rl);

  function rows() {
    return slashCommandSuggestions(rl.line || "");
  }
  function active() {
    return rows().length > 0 && state.dismissedForLine !== (rl.line || "");
  }
  function replaceLine(value) {
    rl.write(null, { ctrl: true, name: "u" });
    rl.write(value);
  }
  function clear() {
    if (!state.visible) return;
    stream.write("\x1b7\x1b[E\x1b[0J\x1b8");
    state.visible = false;
  }
  function render() {
    const list = rows();
    if (!list.length || state.dismissedForLine === (rl.line || "")) {
      clear();
      return;
    }
    const selectedByCommand = state.selectedCommand
      ? list.findIndex((entry) => entry.command === state.selectedCommand)
      : -1;
    if (selectedByCommand >= 0) state.selected = selectedByCommand;
    if (state.selected < 0 || state.selected >= list.length) state.selected = 0;
    const body = renderSlashPalette(list, state.selected, {
      columns: stream.columns || process.stdout.columns || 88,
      colors,
    });
    stream.write("\x1b7\x1b[E\x1b[0J" + body + "\x1b8");
    state.visible = true;
  }
  function move(delta) {
    const list = rows();
    if (!list.length) return false;
    state.selected = (state.selected + delta + list.length) % list.length;
    state.selectedCommand = list[state.selected].command;
    setImmediate(() => {
      replaceLine(state.selectedCommand);
      render();
    });
    return true;
  }
  function select() {
    const list = rows();
    if (!list.length) return false;
    if (state.selected < 0 || state.selected >= list.length) state.selected = 0;
    state.selectedCommand = list[state.selected].command;
    replaceLine(state.selectedCommand);
    clear();
    return true;
  }
  function onKeypress(_str, key = {}) {
    const name = key.name || "";
    if (name === "escape" && state.visible) {
      state.dismissedForLine = rl.line || "";
      clear();
      return;
    }
    if (active() && (name === "down" || name === "up")) {
      move(name === "down" ? 1 : -1);
      return;
    }
    if (active() && (name === "tab" || name === "return")) {
      select();
      return;
    }
    state.dismissedForLine = null;
    setImmediate(render);
  }

  inputStream.prependListener("keypress", onKeypress);
  rl.on("line", clear);
  rl.on("close", clear);
  setImmediate(render);

  return {
    active,
    clear,
    detach() {
      inputStream.removeListener("keypress", onKeypress);
      clear();
    },
  };
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
      case "/permissions":
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
      case "/ontology":
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
  attachSlashPalette,
  isContinuation,
  stripContinuation,
  makeCompleter,
  completePath,
  slashCommandEntries,
  slashCommandSuggestions,
  renderSlashPalette,
  SLASH_COMMANDS,
  RUNTIME_SPECS,
  PERM_LEVELS,
  HISTORY_MAX,
};
