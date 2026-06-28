#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const input = require("../cli/agentlas-input.cjs");
const style = require("../cli/agentlas-style.cjs");
const { Ui } = require("../cli/agentlas-ui.cjs");
const banner = require("../cli/agentlas-banner.cjs");
const i18n = require("../cli/agentlas-i18n.cjs");

function captureUi() {
  let body = "";
  const stream = {
    columns: 80,
    isTTY: false,
    write(chunk) {
      body += String(chunk);
    },
  };
  return {
    ui: new Ui({ color: false, lang: "en", stream }),
    text: () => body,
  };
}

function testCommands() {
  const commands = input.SLASH_COMMANDS;
  assert.equal(new Set(commands).size, commands.length, "slash commands should be unique");
  for (const cmd of ["/help", "/skills", "/status", "/ontology", "/compact", "/keybindings", "/permissions", "/diff", "/history", "/cost", "/setup", "/side", "/btw"]) {
    assert.ok(commands.includes(cmd), `missing ${cmd}`);
  }

  const completer = input.makeCompleter({
    getAgentSlugs: () => ["agentlas-pm-soul"],
    getFirmSlugs: () => ["firm-local"],
    getCwd: () => process.cwd(),
  });
  assert.deepEqual(completer("/st")[0], ["/status"]);
  assert.ok(completer("/co")[0].includes("/compact"));
  assert.deepEqual(completer("/permissions f")[0], ["full"]);
}

function testSlashPalette() {
  const statusRows = input.slashCommandSuggestions("/s");
  assert.ok(statusRows.some((row) => row.command === "/status"), "slash palette should suggest /status for /s");
  assert.ok(statusRows.some((row) => row.command === "/skills"), "slash palette should suggest /skills for /s");
  assert.equal(input.isAbsolutePathTask("/Volumes/External/Hephaestus_agent_forge/Wedding_agent_team make a team"), true);
  assert.equal(input.slashCommandSuggestions("/Volumes/External/Hephaestus_agent_forge/Wedding_agent_team").length, 0);
  assert.equal(input.isAbsolutePathTask("/help"), false);
  const ontologyRows = input.slashCommandSuggestions("/ont");
  assert.equal(ontologyRows[0]?.command, "/ontology");
  const rendered = input.renderSlashPalette(statusRows, 0, { columns: 80 });
  assert.match(rendered, /\/status/);
  assert.match(rendered, /Show model\/runtime/);
  assert.match(rendered, /Slash commands/);
  assert.match(rendered, /category:/);
  assert.match(rendered, /↑↓ move/);
  const ontologyRendered = input.renderSlashPalette(ontologyRows, 0, { columns: 100 });
  assert.match(ontologyRendered, /Natural|company knowledge|examples:/);
}

function testGlobalStyle() {
  assert.equal(style.detectResponseLanguage("agentlas 홍보방법", "en"), "ko");
  assert.equal(style.detectResponseLanguage("explain the release", "ko"), "en");
  assert.equal(style.detectResponseLanguage("answer in English: agentlas 홍보방법", "ko"), "en");
  const directive = style.responseDirective("ko");
  assert.match(directive, /응답 언어: 한국어/);
  assert.match(directive, /Do not use Markdown bold markers/);
  const cleaned = style.sanitizeAssistantText("### Title\n> **Bold** 🚀\n* item\nA - B");
  assert.equal(cleaned, "Title\nBold \nitem\nA: B");
}

async function testSlashPaletteKeys() {
  const inputStream = new EventEmitter();
  inputStream.isTTY = true;
  inputStream.setRawMode = () => {};
  const outputStream = new EventEmitter();
  outputStream.isTTY = true;
  outputStream.columns = 80;
  let body = "";
  outputStream.write = (chunk) => {
    body += String(chunk);
  };
  const rl = new EventEmitter();
  rl.terminal = true;
  rl.input = inputStream;
  rl.output = outputStream;
  rl.line = "/s";
  rl.write = (chunk, key) => {
    if (key && key.ctrl && key.name === "u") {
      rl.line = "";
      return;
    }
    if (chunk) rl.line += String(chunk);
  };

  const palette = input.attachSlashPalette(rl, { force: true, stream: outputStream });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(body, /\/status/);
  assert.match(body, /\/skills/);

  inputStream.emit("keypress", "", { name: "down" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rl.line, "/skills", "down arrow should move to the next slash command");

  rl.line = "/s";
  inputStream.emit("keypress", "", { name: "return" });
  assert.equal(rl.line, "/status", "enter should accept the highlighted slash command");
  palette.detach();
}

function testBanner() {
  const cap = captureUi();
  banner.renderBanner({
    ui: cap.ui,
    version: "0.test",
    runtimeLabel: "claude-code",
    subjectLabel: null,
    permission: "write",
    cwd: "/tmp/agentlas-terminal-ux",
  });
  const text = cap.text();
  assert.match(text, />_ Agentlas \(v0\.test\)/);
  assert.match(text, /model:\s+claude-code/);
  assert.match(text, /agent:\s+Pick an agent/);
  assert.match(text, /permissions:\s+write/);
  assert.match(text, /\/status/);
}

function testI18n() {
  assert.equal(i18n.t("en", "help.status"), "show model/runtime, agent, permission, and directory");
  assert.equal(i18n.t("en", "bye"), "Goodbye.");
}

async function main() {
  testCommands();
  testSlashPalette();
  testGlobalStyle();
  await testSlashPaletteKeys();
  testBanner();
  testI18n();
  console.log("cli terminal ux: ok");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
