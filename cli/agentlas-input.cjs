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
  { command: "/help", description: "Show Agentlas terminal commands", category: "Help", usage: "/help", detail: "Open the command reference, shortcuts, and common flows." },
  { command: "/status", description: "Show model/runtime, agent, permission, and directory", category: "Session", usage: "/status", detail: "Print the current runtime, active agent or company, permission level, and cwd." },
  { command: "/skills", description: "List available Agentlas terminal skills", category: "Discovery", usage: "/skills", detail: "Show the slash-command skills Agentlas can run inside this terminal." },
  { command: "/ontology", description: "Turn on, list, or add project ontology sources", category: "Knowledge", usage: "/ontology add ./docs", detail: "Also understands natural text like /ontology use ./docs as company knowledge.", examples: ["/ontology list", "/ontology use ./docs as company knowledge", "/ontology open"] },
  { command: "/agents", description: "List installed agents", category: "Routing", usage: "/agents", detail: "Show local agents and their routed runtime." },
  { command: "/team", description: "View or pin each agent runtime", category: "Routing", usage: "/team <agent> <runtime|auto>", detail: "Pin one agent to claude-code, codex, gemini, or automatic routing." },
  { command: "/agent", description: "Switch to another agent", category: "Routing", usage: "/agent <name>", detail: "Switch the current conversation to an installed agent." },
  { command: "/firms", description: "List installed companies", category: "Routing", usage: "/firms", detail: "Show company CEOs available in this terminal." },
  { command: "/firm", description: "Switch to a company CEO", category: "Routing", usage: "/firm <name>", detail: "Switch the current conversation to a company CEO agent." },
  { command: "/runtime", description: "Switch runtime: claude-code, codex, gemini, BYOK, or Ollama", category: "Settings", usage: "/runtime codex", detail: "Change the engine Agentlas uses for subsequent turns." },
  { command: "/model", description: "Set the model for the current runtime", category: "Settings", usage: "/model <id>", detail: "Works for claude/codex/gemini (alias like sonnet/opus, or full id) and BYOK/Ollama." },
  { command: "/effort", description: "Set reasoning effort (low/medium/high/max)", category: "Settings", usage: "/effort high", detail: "Higher effort = deeper reasoning. Maps to codex model_reasoning_effort and claude think-depth." },
  { command: "/permission", description: "Set read/write/full permission", category: "Settings", usage: "/permission full", detail: "No argument shows what read, write, and full mean.", aliases: ["/perm"] },
  { command: "/permissions", description: "Show or set current permission", category: "Settings", usage: "/permissions", detail: "Codex-style permission screen for Agentlas read/write/full." },
  { command: "/setup", description: "Run first-time setup again", category: "Settings", usage: "/setup", detail: "Re-run language, runtime, and default permission setup in-place." },
  { command: "/cwd", description: "Show or change the working folder", category: "Files", usage: "/cwd <path>", detail: "Change the folder used for tools, file mentions, and local commands." },
  { command: "/memory", description: "Show the memory injected into this run", category: "Context", usage: "/memory", detail: "Print the project memory that Agentlas adds to agent turns." },
  { command: "/side", description: "Ask a side question without saving it to chat context", category: "Context", usage: "/side <question>", detail: "Runs a one-off answer using current context, then returns without appending to chat history.", aliases: ["/btw"] },
  { command: "/multimodal", description: "Show or set image, video, and audio fallback providers", category: "Settings", usage: "/multimodal", detail: "Inspect or change fallback providers for media work." },
  { command: "/mcp", description: "List configured MCP servers", category: "Settings", usage: "/mcp", detail: "Show MCP servers and which enabled stdio servers the terminal wires into write/full turns." },
  { command: "/diff", description: "Show the current git diff", category: "Files", usage: "/diff", detail: "Print the working-tree diff for the current cwd." },
  { command: "/history", description: "Show recent inputs", category: "Session", usage: "/history", detail: "Show persisted terminal input history." },
  { command: "/resume", description: "Resume a recent runtime session", category: "Session", usage: "/resume [n]", detail: "List recent agent/runtime sessions and continue one (restores the native session thread)." },
  { command: "/compact", description: "Drop older transcript turns and keep recent context", category: "Context", usage: "/compact", detail: "Keep the newest conversation turns and discard older in-session context." },
  { command: "/cost", description: "Show session usage and cost by runtime", category: "Session", usage: "/cost", detail: "Show usage captured by Agentlas across routed runtimes." },
  { command: "/keybindings", description: "Show terminal shortcuts", category: "Help", usage: "/keybindings", detail: "Show slash, file mention, shell, multiline, history, and Ctrl-C controls." },
  { command: "/clear", description: "Clear the chat and redraw", category: "Session", usage: "/clear", detail: "Clear local conversation state and redraw the Agentlas banner." },
  { command: "/import", description: "Import a local agent or team folder", category: "Files", usage: "/import <path>", detail: "Install a local agent or team into Agentlas." },
  { command: "/marketplace", description: "Browse/install marketplace agents", category: "Routing", usage: "/marketplace", detail: "Show how to install agents from the Agentlas cloud marketplace or a local folder.", aliases: ["/market"] },
  { command: "/install", description: "Install a cloud agent by slug", category: "Routing", usage: "/install <slug>", detail: "Download and install an agent from the Agentlas cloud marketplace by slug." },
  { command: "/doctor", description: "Check runtimes and local data", category: "Health", usage: "/doctor", detail: "Run local checks for runtimes, data, credentials, and setup." },
  { command: "/exit", description: "Quit Agentlas", category: "Session", usage: "/exit", detail: "Close the terminal session.", aliases: ["/quit"] },
];
const SLASH_COMMANDS = SLASH_COMMAND_META.flatMap((entry) => [entry.command].concat(entry.aliases || []));
const RUNTIME_SPECS = ["claude-code", "codex", "gemini", "anthropic", "openai", "google", "ollama", "upstage"];
const PERM_LEVELS = ["read", "write", "full"];

function uniqStartsWith(cands, token) {
  const hits = cands.filter((c) => c.startsWith(token));
  return hits.length ? hits : cands;
}

function slashCommandEntries() {
  const rows = [];
  for (const entry of SLASH_COMMAND_META) {
    rows.push({ ...entry, aliasOf: null });
    for (const alias of entry.aliases || []) {
      rows.push({
        command: alias,
        description: `Alias for ${entry.command}`,
        category: entry.category,
        usage: alias + (entry.usage && entry.usage.includes(" ") ? entry.usage.slice(entry.usage.indexOf(" ")) : ""),
        detail: entry.detail,
        examples: entry.examples,
        aliasOf: entry.command,
      });
    }
  }
  return rows;
}

function slashCommandQuery(line) {
  const value = String(line || "");
  if (!value.startsWith("/")) return null;
  if (isAbsolutePathTask(value)) return null;
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
  const selected = rows[Math.max(0, Math.min(selectedIndex, rows.length - 1))] || rows[0];
  const out = [
    c.faint("Slash commands") + c.dim("  type to search"),
    c.faint("─".repeat(lineWidth)),
  ];
  rows.forEach((row, index) => {
    const command = padVisible(row.command, commandWidth);
    const desc = truncateVisible(row.description, descWidth);
    const body = " " + c.blue(command) + c.text(desc);
    out.push(index === selectedIndex ? c.inverse(body.padEnd(lineWidth)) : body);
  });
  out.push(c.faint("─".repeat(lineWidth)));
  if (selected) {
    const usage = truncateVisible(selected.usage || selected.command, lineWidth - 2);
    const detail = truncateVisible(selected.detail || selected.description || "", lineWidth - 2);
    const category = selected.category ? `category: ${selected.category}` : "";
    out.push(" " + c.text(usage) + (category ? c.dim("  " + category) : ""));
    if (detail) out.push(" " + c.dim(detail));
    if (selected.examples && selected.examples.length) {
      out.push(" " + c.dim("examples: " + selected.examples.slice(0, 2).join("  |  ")));
    }
  }
  out.push(c.dim(" ↑↓ move  Enter run  Tab complete  Esc close"));
  return out.join("\n");
}

function attachSlashPalette(rl, opts = {}) {
  const stream = opts.stream || rl.output || process.stdout;
  const inputStream = rl.input || process.stdin;
  const paletteEnabled = opts.force || process.env.AGENTLAS_SLASH_PALETTE === "1";
  const isTty = paletteEnabled && Boolean(rl.terminal && inputStream.isTTY && stream.isTTY);
  if (!rl || !inputStream || !stream || !isTty) {
    return { clear() {}, detach() {}, setEnabled() {}, active: () => false };
  }
  const colors = opts.colors || (opts.ui && opts.ui.c) || {};
  const state = {
    enabled: true,
    selected: 0,
    selectedCommand: null,
    visible: false,
    dismissedForLine: null,
  };

  readline.emitKeypressEvents(inputStream, rl);

  function rows() {
    if (!state.enabled) return [];
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
    if (!state.enabled) {
      clear();
      return;
    }
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
    if (!state.enabled) return;
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
    setEnabled(value) {
      state.enabled = Boolean(value);
      if (!state.enabled) clear();
    },
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

function isAbsolutePathTask(line) {
  const value = String(line || "").trim();
  if (!value.startsWith("/")) return false;
  const first = value.split(/\s+/)[0] || "";
  if (!first || SLASH_COMMANDS.includes(first)) return false;
  if (!path.isAbsolute(first)) return false;
  if (fs.existsSync(first)) return true;
  const parts = first.split("/").filter(Boolean);
  if (parts.length >= 2) return true;
  return /^(?:\/Users|\/Volumes|\/Applications|\/tmp|\/private|\/var|\/opt|\/home)(?:\/|$)/.test(first);
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
      if (isAbsolutePathTask(lineStr)) return [completePath(lineStr, getCwd(), ""), last];
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
  isAbsolutePathTask,
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
