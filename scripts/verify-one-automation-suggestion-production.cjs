#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const recurrence = require("../dist/shared/one-recurrence.js");

function selection(overrides = {}) {
  return {
    contractVersion: "1.0.0",
    intentKind: "research",
    cadence: "weekdays",
    weekday: null,
    localTime: "09:15",
    timeZone: "Asia/Seoul",
    startPolicy: "after_review_approval",
    endPolicy: "manual_stop",
    permission: "draft_only",
    ...overrides,
  };
}

function localParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  return Object.fromEntries(parts.map((item) => [item.type, item.value]));
}

for (const valid of [
  selection(),
  selection({ cadence: "daily" }),
  selection({ cadence: "weekly", weekday: 1 }),
  selection({ intentKind: "briefing", permission: "read_only", timeZone: "UTC" }),
  selection({ intentKind: "content_draft", permission: "approval_before_external_change" }),
]) {
  assert.equal(recurrence.isOneRecurrenceSelectionV1(valid), true);
  assert.deepEqual(recurrence.normalizeOneRecurrenceSelectionV1(valid), valid);
}

for (const invalid of [
  "every day at nine",
  null,
  selection({ cadence: "once" }),
  selection({ cadence: "weekly", weekday: null }),
  selection({ cadence: "daily", weekday: 1 }),
  selection({ localTime: "9am" }),
  selection({ localTime: "24:00" }),
  selection({ timeZone: "/Users/private" }),
  selection({ timeZone: "Not/A_Time_Zone" }),
  selection({ startPolicy: "start_now" }),
  selection({ endPolicy: null }),
  selection({ permission: "write" }),
  { ...selection(), rawPrompt: "user: repeat password=secret" },
]) assert.equal(recurrence.isOneRecurrenceSelectionV1(invalid), false,
  "one-off, ambiguous, missing-stop, unsafe, and open-ended values must fail closed");

const after = Date.parse("2026-07-20T00:00:00.000Z");
const next = recurrence.nextOneRecurrenceAt(selection(), after);
assert.ok(Date.parse(next) > after);
assert.ok(Date.parse(next) <= after + 8 * 24 * 60 * 60 * 1_000);
const nextLocal = localParts(next, "Asia/Seoul");
assert.equal(`${nextLocal.hour}:${nextLocal.minute}`, "09:15");

const dstSelection = selection({
  cadence: "daily",
  localTime: "02:30",
  timeZone: "America/New_York",
});
const dstNext = recurrence.nextOneRecurrenceAt(dstSelection, Date.parse("2026-03-08T06:59:00.000Z"));
const dstLocal = localParts(dstNext, "America/New_York");
assert.equal(`${dstLocal.year}-${dstLocal.month}-${dstLocal.day} ${dstLocal.hour}:${dstLocal.minute}`, "2026-03-09 02:30",
  "a DST gap must advance to the next real local occurrence rather than invent a fixed offset");
assert.match(recurrence.oneRecurrenceTriggerPreview(selection()), /Weekdays at 09:15 \(Asia\/Seoul\)/);
assert.match(recurrence.oneRecurrenceStopControl(), /Manual stop/);

const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const service = source("electron/invocation/service.ts");
const ledger = source("electron/store/run-events.ts");
const producer = source("electron/one/completion-suggestion-producer.ts");
const suggestions = source("electron/one/suggestions.ts");
const shell = source("renderer/components/one/OneShell.tsx");
const control = source("renderer/components/one/OneRecurrenceControl.tsx");
const controlCss = source("renderer/components/one/OneRecurrenceControl.module.css");
const card = source("renderer/components/one/OneSuggestionCard.tsx");
const i18n = source("renderer/lib/i18n.tsx");
const reviewSeed = source("electron/one/review-seed.ts");

assert.match(service, /normalizeOneRecurrenceSelectionV1\(requestedOneRecurrenceSelection\)/);
assert.match(service, /kind:\s*"invoke_started"[\s\S]{0,1800}oneRecurrenceSelection/);
assert.match(service, /proposal_evidence_only_review_required/);
assert.match(ledger, /key === "oneRecurrenceSelection"[\s\S]{0,180}isOneRecurrenceSelectionV1/);
assert.doesNotMatch(producer, /userPrompt|getOneMemory|resultFolder|localPath|credentialStore/,
  "the production observer must never read raw comparison inputs");
assert.match(producer, /matchingAutomation[\s\S]{0,2200}automationSignalFor/);
assert.match(producer, /new Set\(observations\.map\(\(item\) => item\.taskId\)\)\.size !== observations\.length/);
assert.match(suggestions, /\["open", "accepted_for_review", "snoozed"\]\.includes\(item\.status\)/);
assert.match(suggestions, /duplicate_active/);
assert.match(suggestions, /MAX_AUTOMATION_PREVIEW_HORIZON_MS/);

assert.match(shell, /<OneRecurrenceControl/);
assert.match(shell, /options\?\.recurrence \? \{ oneRecurrenceSelection: options\.recurrence \} : \{\}/);
assert.doesNotMatch(shell, /detect(?:One)?Recurrence|recurrence.*RegExp|RegExp.*recurrence/i,
  "plain composer text must never be classified as a recurrence");
assert.match(control, /type="checkbox"/);
for (const field of ["intentKind", "cadence", "weekday", "localTime", "timeZone", "permission"]) {
  assert.ok(control.includes(field), `explicit recurrence control is missing ${field}`);
}
assert.match(control, /recurrenceCopy\(locale, "one\.rec\.explainer"\)/);
assert.match(i18n, /This is not automation/);
assert.match(i18n, /accept three separate results/);
assert.match(i18n, /No schedule is saved, enabled, or run/);
assert.match(controlCss, /min-height:\s*44px/g);
assert.match(control, /aria-describedby=\{active \? "one-recurrence-explainer" : undefined\}/);
assert.match(control, /recurrenceCopy\(locale, "one\.rec\.sheet\.aria"\)/);
assert.match(i18n, /Repeat conditions/);
assert.match(controlCss, /\.control\[data-one-recurrence-active="false"\][\s\S]{0,500}background:\s*transparent/);
assert.match(controlCss, /pointer-events:\s*auto/);
assert.match(control, /role="group"/);
assert.match(card, /suggestionCopy\(locale, "one\.sug\.prev\.external_val"\)/);
assert.match(card, /suggestionCopy\(locale, "one\.sug\.auto\.disclaimer"\)/);
assert.match(i18n, /Explicit approval required every time/);
assert.match(i18n, /does not save a schedule, enable automation, or run it/);
assert.match(reviewSeed, /executableScheduleIncluded:\s*false/);
assert.doesNotMatch(control, /automations\.(?:create|update)|invoke\.run|scheduleJson|promptTemplate/);
assert.doesNotMatch(producer, /automations\.(?:create|update)|automation\.enabled|scheduleJson|promptTemplate/);

console.log(JSON.stringify({
  ok: true,
  exactClosedSelection: true,
  plainTextInference: false,
  nextRunAt: next,
  dstNextRunAt: dstNext,
  reviewOnly: true,
  executableScheduleIncluded: false,
}));
