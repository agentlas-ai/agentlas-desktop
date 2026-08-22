import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const taskforces = readFileSync(resolve(root, "renderer/components/one/OneTaskforces.tsx"), "utf8");
const taskforceStyles = readFileSync(resolve(root, "renderer/components/one/OneTaskforces.module.css"), "utf8");
const createAgent = readFileSync(resolve(root, "renderer/components/one/OneCreateAgentDialog.tsx"), "utf8");
const orgChart = readFileSync(resolve(root, "renderer/components/one/OneOrgChart.tsx"), "utf8");
const oneShell = readFileSync(resolve(root, "renderer/components/one/OneShell.tsx"), "utf8");
const modalStyles = readFileSync(resolve(root, "renderer/components/one/OneBottomSheet.module.css"), "utf8");
const activity = readFileSync(resolve(root, "renderer/components/one/OneActivityTimeline.tsx"), "utf8");
const liveView = readFileSync(resolve(root, "electron/browser/live-view.ts"), "utf8");
const shared = readFileSync(resolve(root, "shared/types.ts"), "utf8");
const pluginPicker = readFileSync(resolve(root, "renderer/components/plugins/PluginPickerDialog.tsx"), "utf8");
const pluginPickerStyles = readFileSync(resolve(root, "renderer/components/plugins/PluginPickerDialog.module.css"), "utf8");
const toolLibrary = readFileSync(resolve(root, "renderer/app/(shell)/library/mcps/page.tsx"), "utf8");
const automationSheet = readFileSync(resolve(root, "renderer/components/one/OneAutomationSheet.tsx"), "utf8");

// Taskforces are compact Grok-style group emblems across the top of the left
// rail, not another vertical project/session list. Their copy stays below the
// overlapping portraits and One remains part of the participant count.
assert.match(taskforces, /function TaskforcePortraits/);
assert.match(taskforces, /taskforce\.memberAgentIds\.slice\(0, 2\)/);
assert.match(taskforces, /taskforce\.memberAgentIds\.length \+ 1/);
assert.match(taskforceStyles, /grid-auto-flow:\s*column/);
assert.match(taskforceStyles, /grid-template-rows:\s*40px minmax\(0, auto\)/);
assert.match(taskforceStyles, /\.portraitStack\s*>\s*span\s*\{\s*position:\s*absolute/);
assert.match(taskforceStyles, /\.taskforceCopy strong[^}]*font-size:\s*9px/);

// One Team creation is one in-place workflow. The rail exposes only the plus
// affordance; the modal preserves avatar work and can branch to existing
// Local, cached Cloud, or bookmarked Hub inventory without visiting Build.
assert.match(orgChart, /className=\{styles\.createAgentButton\}[\s\S]*?<IconPlus size=\{15\} \/>[\s\S]*?<\/button>/);
for (const mode of ["Original", "2D Sketch", "Generated", "Upload"]) assert.match(createAgent, new RegExp(`label: "${mode}"`));
assert.doesNotMatch(createAgent, />Advanced</);
assert.match(createAgent, /말투와 성격, 영혼을 부여하세요/);
assert.match(createAgent, /자동 임시저장됨/);
assert.match(createAgent, /캐시된 목록부터 바로 표시/);
assert.match(createAgent, /북마크한 에이전트만 표시/);
assert.match(modalStyles, /\.layer\s*\{[\s\S]*?place-items:\s*center/);
assert.match(orgChart, /setToolsTab\("plugins"\)/);
assert.match(orgChart, /setToolsTab\("mcp"\)/);

// Shared tool discovery uses the product word "tools", keeps Plugin and MCP
// visibly separate, and avoids the bright pastel CTA treatment rejected in QA.
assert.match(pluginPicker, /ko \? "도구 추가" : "Add tools"/);
assert.match(pluginPicker, /role="tablist"/);
assert.match(pluginPicker, /ko \? "플러그인" : "Plugins"/);
assert.match(pluginPickerStyles, /\.primary\s*\{[\s\S]*?background:\s*#303532/);
assert.match(pluginPickerStyles, /\.typeTab\[data-active="true"\]/);
assert.match(toolLibrary, /locale === "en" \? "Add tools" : "도구 추가"/);
assert.match(toolLibrary, /background: "#303532"/);
assert.match(automationSheet, /operationKey="one-automation-create"/);
assert.match(automationSheet, /api\.automations\.create\(input\)/);

// A running task accepts steering and lets the owner prepare next-turn model,
// effort, permission, and fast-mode choices. Only attachment mutation stays
// blocked because it cannot join an already-materialized run safely.
assert.match(oneShell, /const composerInteractionBlocked = \(!busy && !teamPreflightBusy && selectedReadOnly\) \|\| teamDecisionPending/);
assert.match(oneShell, /const composerAttachmentBlocked = busy \|\| teamPreflightBusy/);

// Browser evidence can be inspected as both a normal web viewport and a real
// responsive phone capture. Phone mode must always clear CDP emulation again.
assert.match(shared, /BrowserLiveViewport\s*=\s*"desktop"\s*\|\s*"phone"/);
assert.match(activity, /captureLiveFrame\(preferredUrl, viewport\)/);
assert.match(activity, /data-mode=\{viewport\}/);
assert.match(activity, /\(\["activity", "terminal", "browser"\] as const\)/);
assert.match(activity, /data-one-rail-resize="true"/);
assert.match(activity, /aria-orientation="horizontal"/);
assert.match(activity, /className=\{styles\.artifactHistoryPane\}[\s\S]*?height:\s*historyHeight/);
assert.match(activity, /<img src=\{preview\.capabilityUrl\}/);
assert.match(activity, /<video src=\{preview\.capabilityUrl\} controls/);
assert.match(activity, /<audio src=\{preview\.capabilityUrl\} controls/);
assert.match(liveView, /Emulation\.setDeviceMetricsOverride/);
assert.match(liveView, /width:\s*390/);
assert.match(liveView, /height:\s*844/);
assert.match(liveView, /finally\s*\{/);
assert.match(liveView, /Emulation\.clearDeviceMetricsOverride/);

console.log("One Team surface contract: PASS (horizontal taskforces; web and real phone browser evidence)");
