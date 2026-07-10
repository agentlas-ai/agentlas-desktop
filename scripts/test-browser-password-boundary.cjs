#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const vault = fs.readFileSync(path.join(root, "electron/store/browser-vault.ts"), "utf8");
const connect = fs.readFileSync(path.join(root, "electron/browser/connect.ts"), "utf8");
const browserPage = fs.readFileSync(path.join(root, "renderer/app/(shell)/browser/page.tsx"), "utf8");
const types = fs.readFileSync(path.join(root, "shared/types.ts"), "utf8");

assert.doesNotMatch(vault, /readBrowserPassword|setSecret\(/,
  "browser site storage must not expose or write passwords");
assert.match(vault, /purgeLegacyBrowserPasswords/,
  "legacy password records must have an explicit cleanup path");
assert.doesNotMatch(vault, /deleteSecret\(credKey\(norm\)\)\.catch/,
  "site deletion must preserve its retry marker when legacy Keychain cleanup fails");
assert.match(connect, /await purgeLegacyBrowserPasswords\(\)/,
  "browser inventory must clean legacy credentials before returning sites");
assert.match(connect, /vault\.legacy_passwords_purge_failed/,
  "legacy cleanup failure must be audited without taking down the browser inventory");
assert.doesNotMatch(browserPage, /type="password"|automatic re-login|자동 재로그인|hasPassword/,
  "browser UI must not collect passwords or promise automatic re-login");

const inputType = types.match(/export interface BrowserSiteInput \{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.doesNotMatch(inputType, /password/i,
  "renderer IPC input must not contain a browser password field");
assert.match(browserPage, /Agentlas는 비밀번호를 받거나 저장하지 않습니다/,
  "browser editor must state the actual password boundary");
assert.match(browserPage, /로그인 후 이 화면에서 ‘세션 저장’을 누르세요/,
  "login copy must require the explicit session-save action instead of treating window close as proof");

console.log("browser password boundary contracts ok");
