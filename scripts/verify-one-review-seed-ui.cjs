#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing bounded source section: ${start}`);
  return source.slice(from, to);
};

const banner = read("renderer/components/one/OneSuggestionReviewHandoff.tsx");
const build = read("renderer/app/(shell)/build/page.tsx");
const groups = read("renderer/app/(shell)/library/agent-groups/page.tsx");
const automation = read("renderer/app/(shell)/automation/new/page.tsx");
const work = read("renderer/app/(shell)/chat/page.tsx");
const preload = read("electron/preload.ts");
const ipc = read("electron/ipc.ts");
const shared = read("shared/types.ts");
const i18n = read("renderer/lib/i18n.tsx");

assert.match(preload, /getReviewSeed:\s*\(input\)\s*=>\s*ipcRenderer\.invoke\("oneSuggestions:getReviewSeed",\s*input\)/);
assert.match(ipc, /ipcMain\.handle\("oneSuggestions:getReviewSeed"[\s\S]{0,180}getOneSuggestionReviewSeed\(input\)/);
assert.match(shared, /getReviewSeed:\s*\(input:\s*OneSuggestionReviewHandoffInput\)\s*=>\s*Promise<OneSuggestionReviewSeed>/);

assert.match(banner, /isOneSuggestionReviewSeed\(resolvedSeed\)/);
assert.match(banner, /materializedDraftRef\.current === seed\.draftId/);
assert.match(banner, /result === "defer"/);
assert.match(banner, /result === "blocked"/);
assert.doesNotMatch(banner, /replaceState|sessionStorage|localStorage/,
  "opaque review bindings must remain reloadable while same-mount hydration is guarded in memory");
assert.match(banner, /reviewCopy\(locale, "one\.rev\.error\.detail"\)/);
assert.match(i18n, /no schedule, prompt, or target prefilled/);
assert.match(i18n, /publishing not started/);

const buildApply = between(build, "const applyOneReviewSeed", "const addDroppedFiles");
assert.match(buildApply, /seed\.kind !== "agent_build"/);
assert.match(buildApply, /current\.phase !== "idle"/);
assert.match(buildApply, /current\.request !== ""/);
assert.match(buildApply, /current\.mode !== ""/);
assert.match(buildApply, /setBuildMode\("single"\)/);
assert.match(buildApply, /setBuildRequest\(/);
assert.doesNotMatch(buildApply, /startBuild|resetBuild|beginBuildCloudSave|hep|publish|systemPrompt/);
assert.match(build, /surface="build" locale=\{locale\} onReviewSeed=\{applyOneReviewSeed\}/);

const groupApply = between(groups, "const applyOneReviewSeed", "const sourceItems");
assert.match(groupApply, /seed\.kind !== "retain_team"/);
assert.match(groupApply, /!rosterLoaded \|\| busy/);
assert.match(groupApply, /editingGroupId !== null/);
assert.match(groupApply, /installed\.installedAt === candidate\.installedAt/);
assert.match(groupApply, /\(installed\.packageHash \?\? null\) === candidate\.packageHash/);
assert.match(groupApply, /setDraftMembers/);
assert.doesNotMatch(groupApply, /saveGroup\(|agentGroups\.create|agentGroups\.update/);
assert.match(groups, /surface="agent_groups" locale=\{locale\} onReviewSeed=\{applyOneReviewSeed\}/);

const automationApply = between(automation, "const applyOneReviewSeed", "useEffect(() =>");
assert.match(automationApply, /seed\.kind !== "automation"/);
assert.match(automationApply, /editId/);
assert.match(automationApply, /reviewUntouchedRef\.current/);
assert.match(automationApply, /setName\(seed\.name\)/);
assert.doesNotMatch(automationApply, /setSched|setPrompt|setTarget|setTrigger|automations\.(?:create|update)|submit\(|enableAutomation|runAutomation/);
assert.match(automation, /onChangeCapture=\{\(\) => \{ reviewUntouchedRef\.current = false; \}\}/);
assert.match(automation, /onClickCapture=\{\(\) => \{ reviewUntouchedRef\.current = false; \}\}/);
assert.match(automation, /surface="automation" locale=\{locale\} onReviewSeed=\{applyOneReviewSeed\}/);

assert.match(work, /<OneSuggestionReviewHandoffBanner surface="work" locale=\{locale\} \/>/);
assert.doesNotMatch(work, /surface="work"[^>]*onReviewSeed/,
  "Hub derivative review must remain scope-only in Work");

console.log(JSON.stringify({
  ok: true,
  mainOwnedSeed: true,
  buildUnsavedOnly: true,
  teamUnsavedOnly: true,
  automationNameOnly: true,
  workScopeOnly: true,
  remountRevalidates: true,
}));
