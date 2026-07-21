#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const shell = read("renderer/components/one/OneShell.tsx");
const card = read("renderer/components/one/OneWeeklyReflectionCard.tsx");
const css = read("renderer/components/one/OneWeeklyReflectionCard.module.css");
const contract = read("shared/one-weekly-reflection.ts");
const runtime = read("electron/one/weekly-reflection.ts");
const ipc = read("electron/ipc.ts");
const preload = read("electron/preload.ts");
const compiledContract = require(path.join(root, "dist/shared/one-weekly-reflection.js"));
const i18n = read("renderer/lib/i18n.tsx");

assert.match(shell, /api\.oneWeeklyReflection\.get\(\)/, "One refreshes the Main-owned weekly projection");
assert.match(shell, /oneWeeklyReflection\?\.reflection\?\.status === "open"/, "resolved weeks are not rendered");
assert.ok(shell.indexOf("one-briefing-title") < shell.indexOf("<OneWeeklyReflectionCard"), "Briefing/Decision remains before weekly reflection");
assert.ok(shell.indexOf("!selected && !conversation") < shell.indexOf("<OneWeeklyReflectionCard"), "reflection remains on One home, not the active Task result");
assert.match(shell, /shouldPresentOneWeeklyReflection/, "home priority is enforced through one shared policy");
const presentable = {
  onHome: true,
  hasOpenReflection: true,
  activationForeground: false,
  busy: false,
  briefingKind: "quiet",
  hasProactiveBriefing: false,
};
assert.equal(compiledContract.shouldPresentOneWeeklyReflection(presentable), true, "quiet One home may show reflection");
for (const [label, override] of [
  ["decision", { briefingKind: "decision" }],
  ["failure", { briefingKind: "failed" }],
  ["working", { briefingKind: "working" }],
  ["proactive", { hasProactiveBriefing: true }],
  ["activation", { activationForeground: true }],
  ["busy", { busy: true }],
  ["task surface", { onHome: false }],
  ["resolved reflection", { hasOpenReflection: false }],
]) {
  assert.equal(
    compiledContract.shouldPresentOneWeeklyReflection({ ...presentable, ...override }),
    false,
    `${label} keeps foreground priority over weekly reflection`,
  );
}

assert.match(card, /weeklyCopy\(locale, "one\.week\.title"\)/);
assert.match(i18n, /이번 주 확인된 변화/);
assert.match(i18n, /A verified change this week/);
assert.doesNotMatch(card, /most useful|가장 유용/i, "no ranking is invented");
assert.match(card, /weeklySummary\(locale, reflection\.outcomes\.length\)/);
assert.match(i18n, /내가 주간 요약에 넣은 결과/);
assert.doesNotMatch(card, /검증 Outcome|Verified Outcome/, "weekly reflection must not expose internal Outcome language");
assert.match(card, /reflection\.outcomes\[0\]\.facts\[0\]\.statement/, "latest verified fact opens the conversation");
assert.match(card, /estimate\.basis/);
assert.match(card, /estimate\.method/);
assert.match(card, /weeklyCopy\(locale, "one\.week\.evidence_summary"\)/);
assert.match(i18n, /Detailed check records/);
assert.match(card, /originalPreservation/);
assert.match(card, /remainingWork/);
assert.match(card, /weeklyCopy\(locale, "one\.week\.action\.got_it"\)/);
assert.match(card, /weeklyCopy\(locale, "one\.week\.action\.hide"\)/);
assert.match(i18n, /확인했어요/);
assert.match(i18n, /이번 주는 숨기기/);
assert.match(card, /confirmedByUser:\s*true/);
assert.match(card, /expectedContentDigest:\s*reflection\.contentDigest/);
assert.match(card, /role="alert"/);

assert.match(css, /min-height:\s*44px/, "weekly actions and disclosure preserve 44px targets");
assert.match(css, /@media \(max-width:\s*620px\)/, "card reflows at narrow and 200% layouts");
assert.match(css, /grid-template-columns:\s*1fr/, "check columns collapse without horizontal scrolling");
assert.match(css, /:focus-visible/, "keyboard focus remains visible");

assert.match(contract, /selectionBasis:\s*typeof ONE_WEEKLY_REFLECTION_SELECTION_BASIS/);
assert.match(contract, /outcomes\.length < 1 \|\| value\.outcomes\.length > 5/);
assert.match(contract, /VALUE_CLOSURE_ID_RE/);
assert.match(contract, /label:\s*"estimate"/);
assert.match(runtime, /item\.source !== "explicit_user_observation"/);
assert.match(runtime, /item\.verificationStatus === "verified"/);
assert.match(runtime, /generated <= latestAllowedAt/);
assert.match(runtime, /occurred > latestAllowedAt/);
assert.match(runtime, /oneValueClosureContainsCompletionClaim/);
assert.match(runtime, /ONE_WEEKLY_REFLECTION_SELECTION_BASIS/);
assert.match(contract, /latest_included_verified_outcome/);
assert.match(runtime, /contentDigest/);
assert.match(runtime, /input\.receipt\.status === "hidden"/, "hide-for-this-week is independent of later same-week content");
assert.match(runtime, /UPDATE meta SET value = \? WHERE key = \? AND value = \?/);
assert.match(ipc, /oneWeeklyReflection:get/);
assert.match(ipc, /oneWeeklyReflection:resolve/);
assert.match(preload, /oneWeeklyReflection:get/);
assert.match(preload, /oneWeeklyReflection:resolve/);

console.log(JSON.stringify({ ok: true, homePriority: true, accessible: true, noRanking: true }));
