import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const taskforces = readFileSync(resolve(root, "renderer/components/one/OneTaskforces.tsx"), "utf8");
const taskforceStyles = readFileSync(resolve(root, "renderer/components/one/OneTaskforces.module.css"), "utf8");
const createAgent = readFileSync(resolve(root, "renderer/components/one/OneCreateAgentDialog.tsx"), "utf8");
const orgChart = readFileSync(resolve(root, "renderer/components/one/OneOrgChart.tsx"), "utf8");
const orgChartStyles = readFileSync(resolve(root, "renderer/components/one/OneOrgChart.module.css"), "utf8");
const oneShell = readFileSync(resolve(root, "renderer/components/one/OneShell.tsx"), "utf8");
const oneShellStyles = readFileSync(resolve(root, "renderer/components/one/OneShell.module.css"), "utf8");
const modalStyles = readFileSync(resolve(root, "renderer/components/one/OneBottomSheet.module.css"), "utf8");
const activity = readFileSync(resolve(root, "renderer/components/workspace/TaskSidePanel.tsx"), "utf8");
const taskBrowser = readFileSync(resolve(root, "renderer/components/browser/TaskBrowser.tsx"), "utf8");
const liveOutputViewer = readFileSync(resolve(root, "renderer/components/LiveOutputViewer.tsx"), "utf8");
const liveView = readFileSync(resolve(root, "electron/browser/live-view.ts"), "utf8");
const shared = readFileSync(resolve(root, "shared/types.ts"), "utf8");
const pluginPicker = readFileSync(resolve(root, "renderer/components/plugins/PluginPickerDialog.tsx"), "utf8");
const pluginPickerStyles = readFileSync(resolve(root, "renderer/components/plugins/PluginPickerDialog.module.css"), "utf8");
const toolLibrary = readFileSync(resolve(root, "renderer/app/(shell)/library/mcps/page.tsx"), "utf8");
const describeAutomation = readFileSync(resolve(root, "renderer/components/automation/DescribeAutomation.tsx"), "utf8");
const runtimeSelection = readFileSync(resolve(root, "electron/runtime/selection.ts"), "utf8");
const electronIpc = readFileSync(resolve(root, "electron/ipc.ts"), "utf8");
const taskforceRuntime = readFileSync(resolve(root, "electron/mcp/borrowed-task-force.ts"), "utf8");
const toolApproval = readFileSync(resolve(root, "renderer/components/ToolApprovalInline.tsx"), "utf8");
const adaptiveResult = readFileSync(resolve(root, "renderer/components/one/OneAdaptiveResult.tsx"), "utf8");
const globalsCss = readFileSync(resolve(root, "renderer/app/globals.css"), "utf8");

function cssBlock(source, selector) {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `missing colour token block: ${selector}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated colour token block: ${selector}`);
}

const colourBlocks = {
  light: cssBlock(globalsCss, ":root {"),
  dark: cssBlock(globalsCss, ':root[data-theme="dark"] {'),
};
const colourDeclarations = Object.fromEntries(Object.entries(colourBlocks).map(([theme, block]) => [
  theme,
  Object.fromEntries([...block.matchAll(/(?:^|\n)\s*(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])),
]));

function resolveColour(theme, token, stack = []) {
  if (stack.includes(token)) throw new Error(`colour token cycle: ${[...stack, token].join(" -> ")}`);
  const raw = colourDeclarations[theme][token] ?? colourDeclarations.light[token];
  if (!raw) throw new Error(`undefined colour token: ${token}`);
  const reference = raw.match(/^var\((--[\w-]+)\)$/);
  if (reference) return resolveColour(theme, reference[1], [...stack, token]);
  const rgba = raw.match(/^rgba?\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)$/i);
  if (rgba && Number(rgba[1]) < 1) throw new Error(`non-opaque colour token: ${token}`);
  if (!/^#[0-9a-f]{6}$/i.test(raw) && !rgba) throw new Error(`unresolvable colour token: ${token}`);
  return raw.toLowerCase();
}

function resolveOpaqueHex(theme, token, expected) {
  const value = resolveColour(theme, token);
  assert.match(value, /^#[0-9a-f]{6}$/, `${token} must resolve to an opaque hex colour`);
  assert.equal(value, expected, `${token} ${theme} resolved colour`);
}

// Taskforces are compact Grok-style group emblems across the top of the left
// rail, not another vertical project/session list. Their copy stays below the
// overlapping portraits and One remains part of the participant count.
assert.match(taskforces, /function TaskforcePortraits/);
assert.match(taskforces, /taskforce\.memberAgentIds\.slice\(0, 2\)/);
// One 은 여전히 인원수에 포함된다. 다만 세는 대상은 **명단 길이가 아니라 지금 말할 수 있는
// 사람**이다 — 나간 팀원이 아바타만 회색이 되고 머릿수는 그대로 남던 것을 고쳤다(UX-D-7).
// 포함 규칙(+1)은 공용 헬퍼 안에 한 벌로 있고, 표시 자리는 그 헬퍼만 부른다.
assert.match(taskforces, /speakableCountIncludingOne\(taskforce\.memberAgentIds, org\)/);
assert.doesNotMatch(
  taskforces,
  /taskforce\.memberAgentIds\.length \+ 1/,
  "인원수는 명단 길이로 세지 않는다 — 나간 사람이 계속 세어진다",
);
const availability = readFileSync(resolve(root, "renderer/lib/one-team-availability.ts"), "utf8");
assert.match(availability, /return availableMemberCount\([^)]*\) \+ 1/, "One 은 인원수에 포함된다");
assert.match(
  availability,
  /member\.archivedAt[\s\S]*statusKind === "locked"[\s\S]*statusKind === "failed"/,
  "말할 수 있는지 판정은 아바타를 회색으로 칠하는 조건과 같아야 한다",
);
assert.match(taskforceStyles, /grid-auto-flow:\s*column/);
assert.match(taskforceStyles, /grid-template-rows:\s*40px minmax\(0, auto\)/);
assert.match(taskforceStyles, /\.portraitStack\s*>\s*span\s*\{\s*position:\s*absolute/);
assert.match(taskforceStyles, /\.taskforceCopy strong[^}]*font-size:\s*9px/);

// One Team creation is one in-place workflow. The rail exposes only the plus
// affordance; the modal preserves avatar work and opens the existing-agent
// picker directly. Source tabs belong only to that centered picker.
assert.match(orgChart, /className=\{styles\.createAgentButton\}[\s\S]*?<IconPlus size=\{15\} \/>[\s\S]*?<\/button>/);
assert.match(orgChart, /className=\{styles\.oneRow\}[\s\S]*?role=\{onOpenOne \? "button"/);
assert.match(oneShell, /onOpenOne=\{startNewConversation\}/);
for (const mode of ["Original", "2D Sketch", "Generated", "Upload"]) assert.match(createAgent, new RegExp(`label: "${mode}"`));
assert.doesNotMatch(createAgent, />Advanced</);
assert.match(createAgent, /말투와 성격, 영혼을 부여하세요/);
assert.match(createAgent, /자동 임시저장됨/);
assert.match(createAgent, /에이전트 선택 창 열기/);
assert.match(createAgent, /const addExisting = \(\) =>[\s\S]*?persistDraftNow\(\)[\s\S]*?onAddExisting\(\)/);
assert.doesNotMatch(createAgent, /existingMenu|existingOpen|ExistingSource|Choose from Local, Cloud/);
assert.match(oneShell, /onAddExisting=\{\(\) =>[\s\S]*?source: "my"/);
assert.match(orgChart, /myAgents: "내 에이전트"/);
assert.match(orgChart, /\['my', addCopy\.myAgents\], \['cloud', 'Cloud'\], \['hub', 'Hub'\]/);
assert.match(orgChart, /Only agents you bookmarked in Hub appear here/);
assert.match(createAgent, /LLM 모델/);
assert.match(createAgent, /runtimeSelectionKey\(runtimeSelection\)/);
assert.match(createAgent, /선택한 모델이 안 되면 Worker 런타임, 그다음 연결된 정상 런타임/);
// 2026-08-27 리팩터: "선택 모델 -> orchestrator worker 풀 -> 아무 연결된 런타임"이라는 고정
// 순서 대신, 역할별 우선순위 풀(rolePriorityRuntimes)로 바뀌었다 — 스페셜리스트는 worker
// 풀, CEO/컨트롤러는 orchestrator 풀에서만 대체를 찾고, 탐지 순서를 숨은 폴백으로 쓰지
// 않는다. fallbackStage 두 단계(worker/connected) 계약은 그대로다.
assert.match(runtimeSelection, /Never use detection order as the hidden fallback[\s\S]*?fallbackStage: role === "worker" \|\| unavailableReason === "model-unavailable"[\s\S]*?\? "worker"[\s\S]*?: "connected",[\s\S]*?fallbackStage: "connected",/);
assert.match(modalStyles, /\.layer\s*\{[\s\S]*?place-items:\s*center/);
assert.match(orgChart, /setToolsTab\("plugins"\)/);
assert.match(orgChart, /setToolsTab\("mcp"\)/);
// Sidebar management controls stay quiet until a row is being inspected, but
// remain available to pointer users and keyboard users through focus-within.
assert.match(orgChartStyles, /\.rowActions\s*\{[\s\S]*?opacity:\s*0;/);
assert.match(orgChartStyles, /\.row:hover \.rowActions,\s*\.row:focus-within \.rowActions\s*\{[\s\S]*?opacity:\s*1;/);
assert.match(orgChartStyles, /\.oneEditButton\s*\{[\s\S]*?opacity:\s*0;/);
assert.match(orgChartStyles, /\.oneRow:hover \.oneEditButton,\s*\.oneRow:focus-within \.oneEditButton\s*\{[\s\S]*?opacity:\s*1;/);

// Shared tool discovery uses the product word "tools", keeps Plugin and MCP
// visibly separate, and avoids the bright pastel CTA treatment rejected in QA.
assert.match(pluginPicker, /ko \? "도구 추가" : "Add tools"/);
assert.match(pluginPicker, /role="tablist"/);
assert.match(pluginPicker, /ko \? "플러그인" : "Plugins"/);
assert.match(pluginPickerStyles, /\.primary\s*\{[\s\S]*?background:\s*var\(--one-primary\)/);
assert.match(pluginPickerStyles, /\.primary:hover:not\(:disabled\)\s*\{[\s\S]*?background:\s*var\(--one-primary-hover\)/);
for (const theme of ["light", "dark"]) {
  resolveOpaqueHex(theme, "--one-primary", "#303532");
  resolveOpaqueHex(theme, "--one-primary-hover", "#202421");
}
assert.match(pluginPickerStyles, /\.typeTab\[data-active="true"\]/);
assert.match(toolLibrary, /locale === "en" \? "Add tools" : "도구 추가"/);
assert.match(toolLibrary, /background: "var\(--one-primary\)"/);
assert.match(describeAutomation, /api\.automations\.interviewGraph\(next\)/);
assert.match(describeAutomation, /api\.automations\.createFromBlueprint/);
assert.match(describeAutomation, /자동화 초안을 저장했습니다\. 아직 꺼진 상태입니다/);
assert.match(describeAutomation, /operationKey=\{ready \? "one-graph-preflight-save" : "one-graph-interview"\}/);
assert.match(describeAutomation, /hardMaxSeconds=\{ready \? 46 : 121\}/);
assert.match(oneShell, /function oneGraphRequest[\s\S]*?\^@graph/);
assert.match(oneShell, /appendOneUserMessage\(targetChat\.id, explicitValue\)/);
assert.match(oneShell, /<DescribeAutomation[\s\S]*?presentation="chat"[\s\S]*?openAfterCreate=\{false\}/);
assert.doesNotMatch(oneShell, /OneUseCaseChips|useCaseChipsVisible/, "One's empty home should greet instead of rendering shortcut suggestions");
assert.doesNotMatch(oneShell, /OneTeamUpgradeIntro|<OneActivation(?:\s|>)/, "One's empty home should greet instead of rendering onboarding cards");
// Exception: when a user-triggered "run this automation now" finishes with no
// safe textual summary to show inline, One opens that automation's own durable
// run history instead of faking a generic "completed" toast (see the comment
// above the router.push in OneShell.tsx). That is the only sanctioned
// OneShell-level navigation into /automation; anything else must stay
// conversation-first, same as /workspace/task and /dashboard always must.
assert.doesNotMatch(
  oneShell.replace("router.push(`/automation/flow?id=${encodeURIComponent(automationId)}`)", ""),
  /router\.(?:push|replace)\([`"']\/(?:workspace\/task|dashboard|automation(?:\/|["']))/,
  "One and @graph must remain conversation-first",
);
assert.doesNotMatch(adaptiveResult, /router\.push\(`\/automation\/flow/, "One automation cards must not navigate to Work");
assert.match(adaptiveResult, /intent:\s*"run_automation"[\s\S]*?targetRef:\s*`automation:\$\{automationId\}`/);
assert.match(adaptiveResult, /intent:\s*"open_automation"[\s\S]*?Edit with @graph/);
assert.match(adaptiveResult, /Progress stays in (?:this conversation|One)/);
assert.match(electronIpc, /const interviewDeadline = Date\.now\(\) \+ 120_000/);
assert.match(electronIpc, /timeoutMs: Math\.max\(1, interviewDeadline - Date\.now\(\)\)/);
assert.match(electronIpc, /staffingBudgetMs = Math\.max\(1, Math\.min\(8_000, interviewDeadline - Date\.now\(\)\)\)/);

// A running task accepts steering and lets the owner prepare next-turn model,
// effort, permission, and fast-mode choices. Only attachment mutation stays
// blocked because it cannot join an already-materialized run safely.
// activeDirectSessionUnavailable 이 추가돼(직접 세션이 끊긴 경우도 막는다) 계약이 넓어졌다 —
// 약화가 아니라 강화다.
assert.match(oneShell, /const composerSettingsBlocked = !busy && !teamPreflightBusy && \(selectedReadOnly \|\| activeDirectSessionUnavailable\)/);
assert.match(oneShell, /const composerInteractionBlocked = composerSettingsBlocked \|\| teamDecisionPending/);
assert.doesNotMatch(oneShell, /const composerSettingsBlocked[^\n]*teamDecisionPending/);
assert.match(oneShell, /data-one-composer-trigger="model"[\s\S]*?disabled=\{composerSettingsBlocked\}/);
assert.match(oneShell, /data-one-composer-trigger="effort"[\s\S]*?disabled=\{composerSettingsBlocked\}/);
assert.match(oneShell, /data-one-composer-trigger="permission"[\s\S]*?disabled=\{composerSettingsBlocked\}/);
assert.match(oneShell, /const composerAttachmentBlocked = busy \|\| teamPreflightBusy/);

// Planning and tool permission gates stay in the shared room immediately
// above the composer. They are compact controls, not navigation or a bottom
// sheet, and a task-force synthesis knows the durable ask-fence contract.
assert.match(oneShell, /<DecisionInline[\s\S]*?<ToolApprovalInline chatId=\{activeThreadChatId\}/);
assert.doesNotMatch(oneShell, /function DecisionBottomSheet/);
assert.match(oneShell, /data-testid="one-decision-inline"/);
assert.match(toolApproval, /Allow image generation\?/);
// 도구 승인이 대화 안의 한 줄로 뜬다는 것이 계약이지, 그 줄이 어떤 클래스
// 이름을 쓰는지가 계약은 아니다. 오너 지시 2026-08-24 로 묻는 자리는 전부
// 공용 AskCard 한 모양이 됐다(docs/DESIGN-ASK-CARD.md).
assert.match(toolApproval, /<AskCard/,
  "tool approval must ask through the shared ask card");
assert.match(toolApproval, /data-testid="tool-approval-card"/,
  "the tool approval surface must stay findable by its test id");
assert.match(taskforceRuntime, /TASK_FORCE_ASK_PROTOCOL/);
assert.match(taskforceRuntime, /When the team has reached a real user-approval gate/);
assert.match(taskforceRuntime, /<\/agentlas-ask>>/);
assert.match(taskforceRuntime, /partitionTaskForcePacketsForApproval/);
assert.match(taskforceRuntime, /taskForceTurnHasCommittedApproval/);
assert.match(taskforceRuntime, /kind:\s*"taskforce_approval_gate"/);
assert.match(taskforceRuntime, /taskForceApprovalGateSystemPrompt/);
assert.match(taskforceRuntime, /Do not implement, run a build\/dev server/);
// A Taskforce decision is a continuation of the same room. Approval,
// clarification, and recovery turns must rehydrate that chat's eligible roster
// instead of silently falling back to a solo One run.
assert.match(oneShell, /const effectiveTaskForceTargets: OrchestrationTarget\[\] = options\?\.taskForceTargets !== undefined/);
assert.match(oneShell, /taskforces\.find\(\(item\) => item\.chatId === chatId\)/);
assert.match(oneShell, /effectiveTaskForceTargets\.length \? \{ taskForceTargets: effectiveTaskForceTargets \}/);

// The active Taskforce header reserves real layout columns for controls,
// portraits, and copy. Closing the left rail must move its reveal control out
// of the macOS traffic-light area, while the three header portraits remain
// distinct instead of colliding with one another or the title.
assert.match(oneShellStyles, /\.taskToolbar\s*\{[\s\S]*?grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto auto/);
// 1.0.31: 결과 레일 토글은 툴바에 남는다 — 닫힌 레일을 다시 여는 유일한 손잡이다.
assert.match(oneShell, /결과 패널 열기[\s\S]{0,400}?presentRichOutputRail\(\)/);
assert.match(oneShellStyles, /data-rail-collapsed="true"\]\s+\.taskToolbar\s*\{[\s\S]*?padding-left:\s*76px/);
// 게이트 §7.4 — 여기는 **정확한 픽셀값**을 못박고 있었다. 그러면 정상적인 디자인 조정이
// 게이트를 깨고(오늘 한 번 그랬다), 통과시키려고 디자인을 되돌리게 된다.
// 계약은 "겹쳐 쌓인 초상 세 개가 서로 다른 자리에 있고, 뒤로 갈수록 오른쪽이다"이다.
// 값이 아니라 **순서와 관계**로 검사한다.
{
  const portraitOffset = (nth) => {
    const rule = new RegExp(`\\.taskforceToolbarPortraits\\s*>\\s*span:nth-child\\(${nth}\\)[^}]*left:\\s*(\\d+)px`).exec(oneShellStyles);
    assert.ok(rule, `stacked toolbar portrait ${nth} must be positioned explicitly`);
    return Number(rule[1]);
  };
  const second = portraitOffset(2);
  const third = portraitOffset(3);
  assert.ok(second > 0, "the second portrait must be offset from the first");
  assert.ok(third > second, "portraits must fan out in order, not collide");
  const widthRule = /\.taskforceToolbarPortraits\s*\{[\s\S]*?width:\s*(\d+)px/.exec(oneShellStyles);
  assert.ok(widthRule, "the stacked portrait strip must reserve a width");
  assert.ok(Number(widthRule[1]) > third, "the strip must be wide enough to hold the last portrait");
}
assert.match(oneShellStyles, /data-rail-open="true"\]\s+\.(?:taskSidebarRevealButton|sidebarRevealButton)/);
assert.match(oneShellStyles, /@media \(max-width: 1080px\)[\s\S]*?data-context-rail="true"\][\s\S]*?grid-template-columns:\s*224px minmax\(0, 1fr\) 0/);
assert.match(oneShellStyles, /width:\s*min\(var\(--one-rail-width,\s*\d+px\), calc\(100% - 56px\)\) !important/);

// Browser evidence can be inspected as both a normal web viewport and a real
// responsive phone capture. Phone mode must always clear CDP emulation again.
assert.match(shared, /BrowserLiveViewport\s*=\s*"desktop"\s*\|\s*"phone"/);
// Native tabs use the Main registry and exact task/view identity. A closed
// or folded panel detaches its guest instead of killing a later tab's stream.
assert.match(taskBrowser, /api\.listTabs\(\{ taskScopeId \}\)/);
assert.match(taskBrowser, /workLiveView\.navigate\(\{ viewId: tabId, taskScopeId, url \}\)/);
assert.match(taskBrowser, /mode="browser" bare stableNavigation retainOnUnmount/);
assert.match(taskBrowser, /createPortal\(header, headerHost\)/);
assert.doesNotMatch(activity, /function OneBrowserLiveView/);
assert.match(activity, /browserScopeKey[\s\S]*?browserUrlsByScope/);
// A live native browser event reveals its own task; restoring a stored URL
// must not pretend that the agent has just opened a browser.
assert.match(activity, /status\.taskScopeId !== screenChatId/);
assert.match(activity, /openRailTab\("browser"\);\s*nativeBrowserObservedRef\.current\?\.\(status\.url\)/);
assert.doesNotMatch(activity, /onBrowserObserved\?\.\(preferredBrowserUrl\)/);
assert.match(oneShell, /onBrowserObserved=\{presentBrowserOutput\}/);
assert.match(taskBrowser, /status\.taskScopeId !== taskScopeId/);
assert.match(oneShell, /browserScopeKey=\{activeThreadChatId \?\? selected\?\.taskId \?\? conversation\?\.id\}/);
assert.match(activity, /<TaskBrowser key=\{screenChatId\}/);
/*
 * 오너 지시 2026-08-24: 탭은 고정 목록이 아니다. 계약은 "다섯 보기가 모두
 * 도달 가능하다" 이지, "다섯 개가 언제나 떠 있다" 가 아니다. 결과와 앱은
 * 실제로 생길 때 탭이 되고, 나머지는 + 로 연다.
 */
assert.match(activity, /setOpenTabs\(\(tabs\) => \(tabs\.includes\("result"\) \? tabs : \[\.\.\.tabs, "result"\]\)\)/,
  "a produced result must open its own tab");
assert.match(activity, /setOpenTabs\(\(tabs\) => \(tabs\.includes\("app"\) \? tabs : \[\.\.\.tabs, "app"\]\)\)/,
  "a live generated app must open its own tab");
assert.match(activity, /setOpenTabs\(\(tabs\) => \(tabs\.includes\("browser"\) \? tabs : \[\.\.\.tabs, "browser"\]\)\)/,
  "observed browser work must open its own tab");
assert.match(activity, /\(\["activity", "terminal", "browser", "screen"\] as const\)/,
  "Activity, Terminal and Browser must stay reachable from the add-view menu");
for (const view of ["result", "activity", "terminal", "browser", "app"]) {
  assert.match(activity, new RegExp(`railView === "${view}"`),
    `the output rail must still render the ${view} view`);
}
assert.match(activity, /data-one-rail-resize="true"/);
assert.match(activity, /window\.addEventListener\("pointermove", move/);
assert.match(activity, /drag\.rawWidth <= collapseThreshold/);
assert.match(activity, /aria-orientation="horizontal"/);
assert.match(activity, /className=\{styles\.artifactHistoryPane\}[\s\S]*?height:\s*historyHeight/);
assert.match(activity, /<LiveOutputViewer source=\{preview\.capabilityUrl\}/);
assert.match(liveOutputViewer, /<img src=\{source\}/);
assert.match(liveOutputViewer, /<video src=\{source\}[\s\S]*?controls/);
assert.match(liveOutputViewer, /<audio src=\{source\}[\s\S]*?controls/);
assert.match(liveView, /Emulation\.setDeviceMetricsOverride/);
assert.match(liveView, /width:\s*390/);
assert.match(liveView, /height:\s*844/);
assert.match(liveView, /finally\s*\{/);
assert.match(liveView, /Emulation\.clearDeviceMetricsOverride/);

// 2026-08-23: call-only Hub 좌석은 로컬 프롬프트 실행이 없으므로, 렌더러의 두 실행 타깃
// 빌더(리허드레이션·컴포저 스냅샷)는 반드시 공용 판별기를 거쳐 hub 타깃을 낼 수 있어야 한다.
// (계약: 좌석의 실행은 항상 Hub borrow 경로 — shared/call-only-agent.ts)
assert.match(oneShell, /import \{ isCallOnlyHubAgent \} from "@shared\/call-only-agent"/);
assert.match(oneShell, /const orchestrationTargetForAgentId = useCallback[\s\S]*?isCallOnlyHubAgent\(agent\)[\s\S]*?source: "hub"/);
assert.match(oneShell, /\.map\(\(agentId\) => orchestrationTargetForAgentId\(agentId\)\)/);
assert.match(oneShell, /turnAgentIds\.map\(\(agentId\) => orchestrationTargetForAgentId\(agentId\)\)/);
// 로컬 하드코딩 타깃 스냅샷이 되살아나면 실패해야 한다(재출현 게이트).
assert.doesNotMatch(oneShell, /turnAgentIds\.map\(\(agentId\) => \(\{\s*source: "local"/);

console.log("One Team surface contract: PASS (horizontal taskforces; web and real phone browser evidence)");
