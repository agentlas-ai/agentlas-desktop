"use strict";
/*
 * Agentlas terminal splash — small dinosaur mascot (Chrome-dino style) + wordmark + status.
 */
const path = require("node:path");
const os = require("node:os");

// Small T-Rex (side view, facing right) — eye is ●.
const DINO_ART = [
  "          ▟████▙",
  "          █●  ▜█▙",
  "   ▖      ████████",
  "   ▜█▄▄▄▄▄███",
  "    ▀▀▀█▌ █▌",
];

function readVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version || "";
  } catch {
    return "";
  }
}

function shorten(p) {
  if (!p) return "";
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// Just the mascot lines (used by the onboarding wizard header).
function renderMascot(ui) {
  const c = ui.c;
  if (!ui.enabled) {
    ui.line("  Agentlas");
    return;
  }
  for (let i = 0; i < DINO_ART.length; i++) {
    const row = DINO_ART[i];
    ui.line("   " + (i === 1 ? c.text(row).split("●").join(c.emerald("●")) : c.text(row)));
  }
}

function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function fit(value, width) {
  let s = stripAnsi(value);
  if (s.length > width) {
    if (width <= 1) return "…";
    s = s.slice(0, Math.max(0, width - 1)) + "…";
  }
  return s + " ".repeat(Math.max(0, width - s.length));
}

function row(ui, width, text) {
  const inner = Math.max(10, width - 4);
  ui.line(ui.c.faint("│ ") + ui.c.text(fit(text, inner)) + ui.c.faint(" │"));
}

function renderStatusCard(ctx, opts = {}) {
  const ui = ctx.ui;
  const c = ui.c;
  const cols = ui.out.columns || 80;
  const width = Math.max(54, Math.min(cols - 2, 78));
  const version = ctx.version || readVersion();
  const subject = ctx.subjectLabel || "Pick an agent, choose a company, or type a task";
  const permission = ctx.permission || "write";
  const runtime = ctx.runtimeLabel || "(not configured)";
  const cwd = ctx.cwd ? shorten(ctx.cwd) : process.cwd();

  ui.line("");
  ui.line(c.faint("╭" + "─".repeat(width - 2) + "╮"));
  row(ui, width, `>_ Agentlas${version ? " (v" + version + ")" : ""}`);
  row(ui, width, "");
  row(ui, width, `model:       ${runtime}`);
  row(ui, width, `agent:       ${subject}`);
  row(ui, width, `directory:   ${cwd}`);
  row(ui, width, `permissions: ${permission}`);
  ui.line(c.faint("╰" + "─".repeat(width - 2) + "╯"));
  if (!opts.noTip) {
    ui.line(
      "  " +
        c.bold(c.text("Tip:")) +
        c.dim(" Type ") +
        c.faint("/help") +
        c.dim(" for commands, ") +
        c.faint("/status") +
        c.dim(" for session state, ") +
        c.faint("/exit") +
        c.dim(" to quit."),
    );
  }
}

// Main splash. ctx = { ui, version, runtimeLabel, subjectLabel, permission, cwd }
function renderBanner(ctx) {
  renderStatusCard(ctx);
  ctx.ui.line("");
}

// runtime · subject · permission · working folder
function renderStatus(ctx) {
  renderStatusCard(ctx, { noTip: true });
}

module.exports = { renderBanner, renderStatus, renderMascot, readVersion, shorten, DINO_ART, fit };
