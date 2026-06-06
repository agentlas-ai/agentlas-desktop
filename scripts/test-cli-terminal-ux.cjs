#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const input = require("../cli/agentlas-input.cjs");
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
  for (const cmd of ["/help", "/status", "/compact", "/keybindings", "/permissions", "/diff", "/history"]) {
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

testCommands();
testBanner();
testI18n();
console.log("cli terminal ux: ok");
