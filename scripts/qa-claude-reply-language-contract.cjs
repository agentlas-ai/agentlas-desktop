#!/usr/bin/env node
"use strict";
/*
 * 영어 화면·영어 프로젝트인데 연구 디렉터가 한국어로 답했다(프로덕트헌트 촬영, 2026-09-14). 원인은 Claude Code
 * 사용자 설정 "language": "korean" — CLI 가 시스템 수준에 넣어, 우리 시스템 프롬프트의 "Always reply in English" 를
 * 앞에 두든 끝에 두든 이겼다(claude 2.1.270 실측). `--settings` 의 language 만 이겼다.
 * 이 계약은 러너가 넘기는 단 하나의 settings 객체에 화면 언어가 실리고, 기존 설정(샌드박스·관문 훅)을 잃지 않는지 확인한다.
 * 컴파일된 러너가 필요하다: AGENTLAS_ELECTRON_BUILD(기본 dist/electron).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.AGENTLAS_ELECTRON_BUILD || path.join(__dirname, "..", "dist", "electron");
const runtimePath = [path.join(root, "runtime", "claude-code.js"), path.join(root, "electron", "runtime", "claude-code.js")].find((candidate) => fs.existsSync(candidate));
if (!runtimePath) { console.error(`claude runtime build not found under ${root}`); process.exit(1); }
const source = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime", "claude-code.ts"), "utf8");
assert.match(source, /const executionSettings = await withProductReplyLanguage\(await claudeExecutionSettings\(runReq\), runReq\.locale\);/, "the runner passes every settings object through the language merge");
assert.equal((source.match(/"--settings"/g) ?? []).length, 1, "exactly one --settings flag (Claude keeps only the last)");

(async () => {
  const { withProductReplyLanguage } = require(runtimePath);
  assert.deepEqual(JSON.parse(await withProductReplyLanguage(null, "en")), { language: "english" }, "no settings: language only");
  assert.deepEqual(JSON.parse(await withProductReplyLanguage(null, "ko")), { language: "korean" });
  const inline = JSON.stringify({ sandbox: { enabled: true }, hooks: { PreToolUse: [{ matcher: "Bash" }] } });
  assert.deepEqual(JSON.parse(await withProductReplyLanguage(inline, "en")), { sandbox: { enabled: true }, hooks: { PreToolUse: [{ matcher: "Bash" }] }, language: "english" }, "inline write settings keep sandbox and hooks");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reply-language-"));
  const brokerPath = path.join(dir, "broker.json");
  fs.writeFileSync(brokerPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*" }] } }));
  assert.deepEqual(JSON.parse(await withProductReplyLanguage(brokerPath, "en")), { hooks: { PreToolUse: [{ matcher: "*" }] }, language: "english" }, "broker settings file is merged, not replaced");
  const override = JSON.stringify({ language: "korean", hooks: {} });
  assert.equal(JSON.parse(await withProductReplyLanguage(override, "en")).language, "english", "the screen language wins over any language already present");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("PASS qa-claude-reply-language-contract");
})().catch((error) => { console.error(error); process.exit(1); });
