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
const activity = readFileSync(resolve(root, "renderer/components/one/OneActivityTimeline.tsx"), "utf8");
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
assert.match(runtimeSelection, /selected model -> orchestrator's worker role[\s\S]*?fallbackStage: "worker"[\s\S]*?fallbackStage: "connected"/);
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
assert.match(pluginPickerStyles, /\.primary\s*\{[\s\S]*?background:\s*#303532/);
assert.match(pluginPickerStyles, /\.typeTab\[data-active="true"\]/);
assert.match(toolLibrary, /locale === "en" \? "Add tools" : "도구 추가"/);
assert.match(toolLibrary, /background: "#303532"/);
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
assert.doesNotMatch(oneShell, /router\.(?:push|replace)\([`"']\/(?:workspace\/task|dashboard|automation(?:\/|["']))/, "One and @graph must remain conversation-first");
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
assert.match(oneShell, /const composerSettingsBlocked = !busy && !teamPreflightBusy && selectedReadOnly/);
assert.match(oneShell, /const composerInteractionBlocked = composerSettingsBlocked \|\| teamDecisionPending/);
assert.doesNotMatch(oneShell, /const composerSettingsBlocked[^\n]*teamDecisionPending/);
assert.match(oneShell, /data-one-composer-trigger="model"[\s\S]*?disabled=\{composerSettingsBlocked\}/);
assert.match(oneShell, /data-one-composer-trigger="effort"[\s\S]*?disabled=\{composerSettingsBlocked\}/);
assert.match(oneShell, /data-one-composer-trigger="permission"[\s\S]*?disabled=\{composerSettingsBlocked\}/);
assert.match(oneShell, /const composerAttachmentBlocked = busy \|\| teamPreflightBusy/);

// Planning and tool permission gates stay in the shared room immediately
// above the composer. They are compact controls, not navigation or a bottom
// sheet, and a task-force synthesis knows the durable ask-fence contract.
assert.match(oneShell, /<DecisionInline[\s\S]*?<ToolApprovalInline chatId=\{activeThreadChatId\} compact \/>/);
assert.doesNotMatch(oneShell, /function DecisionBottomSheet/);
assert.match(oneShell, /data-testid="one-decision-inline"/);
assert.match(toolApproval, /Allow image generation\?/);
assert.match(toolApproval, /tac-compact/);
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
assert.match(oneShellStyles, /\.taskforceToolbarPortraits\s*\{[\s\S]*?width:\s*94px/);
assert.match(oneShellStyles, /\.taskforceToolbarPortraits\s*>\s*span:nth-child\(2\)[^}]*left:\s*34px/);
assert.match(oneShellStyles, /\.taskforceToolbarPortraits\s*>\s*span:nth-child\(3\)[^}]*left:\s*68px/);
assert.match(oneShellStyles, /data-rail-open="true"\]\s+\.(?:taskSidebarRevealButton|sidebarRevealButton)/);
assert.match(oneShellStyles, /@media \(max-width: 1080px\)[\s\S]*?data-context-rail="true"\][\s\S]*?grid-template-columns:\s*224px minmax\(0, 1fr\) 0/);
assert.match(oneShellStyles, /width:\s*min\(var\(--one-rail-width, 420px\), calc\(100% - 56px\)\) !important/);

// Browser evidence can be inspected as both a normal web viewport and a real
// responsive phone capture. Phone mode must always clear CDP emulation again.
assert.match(shared, /BrowserLiveViewport\s*=\s*"desktop"\s*\|\s*"phone"/);
// The native-style browser can navigate away from the task's first observed
// URL, so the live target must follow the active tab's effective URL. Session
// cleanup is serialized before this call to avoid a late stop killing the new
// tab or viewport stream.
assert.match(activity, /await stopFlightRef\.current\.catch\(\(\) => undefined\)[\s\S]*?startLiveView\(effectiveUrl, viewport\)/);
assert.match(activity, /dispatchLiveInput\(\{ \.\.\.input, sessionId \}/);
assert.match(activity, /browserScopeKey[\s\S]*?browserUrlsByScope/);
// 1.0.31: 자동 열림은 실측된 currentBrowserUrl 이 아니라 스코프가 고른 preferredBrowserUrl 을 알린다.
assert.match(activity, /setRailView\("browser"\)[\s\S]*?onBrowserObserved\?\.\(preferredBrowserUrl\)/);
assert.match(oneShell, /onBrowserObserved=\{presentBrowserOutput\}/);
assert.match(activity, /setFrame\(null\)[\s\S]*?if \(!effectiveUrl\)/);
assert.match(oneShell, /browserScopeKey=\{activeThreadChatId \?\? selected\?\.taskId \?\? conversation\?\.id\}/);
assert.match(activity, /data-mode=\{viewport\}/);
assert.match(activity, /result\s*\|\|\s*openedArtifact \? \["result" as const\] : \[\]/,
  "the output rail must retain the Result view when a result or opened artifact exists");
assert.match(activity, /"activity" as const,[\s\S]{0,80}"terminal" as const/,
  "the output rail must retain Activity and Terminal views");
assert.match(activity, /appPreview \? \["app" as const\] : \[\]/,
  "the output rail must expose a generated-app view only when a live app exists");
assert.match(activity, /"browser" as const/,
  "the output rail must retain the in-app Browser view");
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
