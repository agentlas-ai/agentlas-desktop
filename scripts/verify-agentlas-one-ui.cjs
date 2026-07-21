#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const i18n = read("renderer/lib/i18n.tsx");

const route = read("renderer/app/(no-shell)/one/page.tsx");
const shell = read("renderer/components/one/OneShell.tsx");
const shellCss = read("renderer/components/one/OneShell.module.css");
const oneBrand = read("renderer/components/one/OneBrand.tsx");
const oneBrandCss = read("renderer/components/one/OneBrand.module.css");
const adapter = read("renderer/lib/one-task-adapter.ts");
const conversationLocaleSource = read("renderer/lib/one-conversation-locale.ts");
const result = read("renderer/components/one/OneAdaptiveResult.tsx");
const intro = read("renderer/components/one/OneFeatureIntro.tsx");
const activation = read("renderer/components/one/OneActivation.tsx");
const activationCss = read("renderer/components/one/OneActivation.module.css");
const activationContract = read("shared/one-activation.ts");
const activationRuntime = read("electron/one/activation.ts");
const appShell = read("renderer/components/AppShell.tsx");
const authGate = read("renderer/components/AuthGate.tsx");
const introContract = read("shared/one-feature-intro.ts");
const memorySheet = read("renderer/components/one/OneMemorySheet.tsx");
const memorySheetCss = read("renderer/components/one/OneMemorySheet.module.css");
const memoryRuntime = read("electron/one/memory-candidates.ts");
const profileSheet = read("renderer/components/one/OneProfileSheet.tsx");
const suggestionCard = read("renderer/components/one/OneSuggestionCard.tsx");
const suggestionCardCss = read("renderer/components/one/OneSuggestionCard.module.css");
const suggestionReviewHandoff = read("renderer/components/one/OneSuggestionReviewHandoff.tsx");
const suggestionRuntime = read("electron/one/suggestions.ts");
const buildPage = read("renderer/app/(shell)/build/page.tsx");
const agentGroupsPage = read("renderer/app/(shell)/library/agent-groups/page.tsx");
const automationPage = read("renderer/app/(shell)/automation/new/page.tsx");
const valueClosureCard = read("renderer/components/one/OneValueClosureCard.tsx");
const valueClosureCardCss = read("renderer/components/one/OneValueClosureCard.module.css");
const improvementProofCard = read("renderer/components/one/OneImprovementProofCard.tsx");
const improvementProofCardCss = read("renderer/components/one/OneImprovementProofCard.module.css");
const productMenu = read("renderer/components/one/ProductModeMenu.tsx");
const surfaceAdapter = read("shared/one-surface.ts");
const workChat = read("renderer/app/(shell)/chat/page.tsx");
const invocationService = read("electron/invocation/service.ts");
const invocationClient = read("electron/mcp/client.ts");
const borrowedTaskForce = read("electron/mcp/borrowed-task-force.ts");
const firmOrchestrator = read("electron/mcp/firm-orchestrator.ts");
const swarmRun = read("electron/mcp/swarm-run.ts");
const claudeRuntime = read("electron/runtime/claude-code.ts");
const briefingActions = read("electron/one/briefing-actions.ts");
const briefingRuntime = read("electron/one/briefing.ts");
const mainRuntime = read("electron/main.ts");
const searchRuntime = read("electron/one/search.ts");
const oneSurfaceStore = read("electron/store/one-surface-results.ts");
const runLedger = read("electron/store/run-events.ts");
const preload = read("electron/preload.ts");
const ipcSource = read("electron/ipc.ts");
const attachmentContract = read("shared/one-attachments.ts");
const attachmentRuntime = read("electron/one/attachments.ts");
const taskContinuationRuntime = read("electron/one/task-continuation.ts");
const oneCopyRuntime = read("electron/one/one-copy.ts");
const acceptedClosureRuntime = read("electron/one/accepted-result-value-closure.ts");

function loadStandaloneTs(source, filename) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  const localRequire = (specifier) => specifier === "./secret-patterns"
    ? { redactSecrets: (value) => value }
    : require(specifier);
  Function("exports", "module", "require", output)(mod.exports, mod, localRequire);
  return mod.exports;
}

const conversationLocale = loadStandaloneTs(conversationLocaleSource, "one-conversation-locale.ts");

assert.match(route, /<OneShell\s*\/>/, "the /one route must mount the isolated One shell");
assert.match(route, /Suspense/, "useSearchParams route must be behind Suspense for static export");
assert.match(authGate, /DEV_QA_ROUTES\s*=\s*\[[^\]]*"\/one"/, "dev visual QA must be able to render the real One shell without a preload bridge");
assert.match(authGate, /process\.env\.NODE_ENV\s*!==\s*"production"[\s\S]*DEV_QA_ROUTES/, "the /one QA auth bypass must remain impossible in production");
assert.equal(conversationLocale.detectOneTextLocale("오늘 우선할 일을 정해줘"), "ko", "Korean user turns must localize One system chrome to Korean");
assert.equal(conversationLocale.detectOneTextLocale("Choose today's priority"), "en", "English user turns must localize One system chrome to English");
assert.equal(conversationLocale.detectOneTextLocale("ok"), null, "a short acknowledgement must not unexpectedly flip an established thread language");
assert.equal(conversationLocale.inferOneConversationLocale([
  { role: "user", text: "Please compare these options" },
  { role: "assistant", text: "어떤 기준이 중요한가요?" },
  { role: "user", text: "가격과 성능이 중요해" },
], "en"), "ko", "the latest user-authored language must own One system chrome");
assert.equal(conversationLocale.inferOneRecentContextLocale([
  { text: "Compare two launch plans", updatedAt: "2026-07-18T03:00:00.000Z" },
  { text: "오늘 출시 전에 확인할 일", updatedAt: "2026-07-19T03:00:00.000Z" },
], "en"), "ko", "the One home must follow the newest recent user language before app fallback");
assert.match(shell, /const runLocale = detectOneTextLocale\(text\) \?\? normalizedLocale;/, "the first submitted turn must set the invocation locale before React state catches up");
assert.match(shell, /inferOneRecentContextLocale\(\[/, "the empty One home must infer system chrome from recent user context");
assert.match(shell, /const activeContextLocale = detectOneTextLocale\(selected\?\.display\.title \?\? conversation\?\.title \?\? ""\)/, "the active request language must outrank a stale profile or app locale");

assert.match(adapter, /api\.tasks\.list\(/, "One must read the canonical Task store first");
assert.match(adapter, /api\.tasks\.get\(/, "One must open canonical Task detail by Task id");
assert.match(adapter, /listProjections/, "One must prefer the frozen canonical projection bridge when present");
assert.match(adapter, /getProjection/, "One must prefer canonical projection detail when present");
assert.match(adapter, /openInWork/, "One must delegate Work opening by canonical Task id when the bridge supports it");
assert.match(adapter, /task\.originChatId/, "Work and conversation projection must use the canonical origin chat binding");
assert.match(adapter, /api\.invoke\.latestReceipt/, "run closure evidence must be backed by the invocation receipt");
assert.match(adapter, /mayClaimNewCompletion:\s*task\.status === "completed"/, "only canonical Task status may grant completion truth");
assert.doesNotMatch(adapter, /mayClaimNewCompletion:\s*receipt\?\.status/, "a completed run receipt must not complete a canonical Task");
assert.match(adapter, /!task[\s\S]*task\.version !== projection\.canonicalVersion/, "Task lists must discard projections with absent or stale canonical authority");
assert.match(adapter, /!task[\s\S]*task\.version !== normalized\.canonicalVersion[\s\S]*return null;/, "Task detail must fail closed when canonical authority is absent or stale");
assert.doesNotMatch(adapter, /chat\.taskId \?\?/, "a chat id must never manufacture a canonical Task identity");
assert.match(adapter, /localizedFailureBriefingBody\(failed\.latestReceipt\?\.errorMessage, locale\)/, "failed briefings must localize runtime errors into beginner copy");
assert.doesNotMatch(adapter, /failed\.latestReceipt\?\.errorMessage \?\? failed\.display\.title/, "failed briefings must never show raw runtime errors");
assert.match(adapter, /isAgentlasOneTaskProjectionV1/, "projection semantic actions must pass the shared closed-contract validator");
assert.match(adapter, /completion is never inferred/i, "fallback truth boundary must be documented in code");
assert.ok(
  adapter.indexOf('status.value === "failed"', adapter.indexOf("export function chooseOneBriefing")) <
    adapter.indexOf('status.value === "working"', adapter.indexOf("export function chooseOneBriefing")),
  "a stopped Task must outrank ordinary in-progress work in the reactive Briefing",
);

assert.match(shell, /sessionRouting:\s*false/, "One execution must stay solo-locked unless Main restores an exact confirmed roster");
assert.ok(shell.includes("사용\\s*(?:에이전트|스킬)"), "One must remove Korean router-worker banners from visible assistant messages");
assert.ok(shell.includes("Agents used|Skills used"), "One must remove English router-worker banners from visible assistant messages");
assert.ok(shell.includes('/gim, "")'), "One must strip router-worker banner lines even when they appear after an introduction");
assert.match(invocationClient, /최종 답변에 '사용 에이전트:', '사용 스킬:' 같은 라우팅 보고를 쓰지 말고/, "One must prevent Korean router-worker banners at generation time");
assert.match(invocationClient, /Never include routing reports such as 'Agents used:' or 'Skills used:'/, "One must prevent English router-worker banners at generation time");
assert.match(shell, /api\.oneTeamPreflight\.prepare\(/, "complex first turns must cross Main's adaptive-team preflight before invocation");
assert.match(shell, /api\.oneTeamPreflight\.autoResolve\(/, "One must make the safe staffing decision without asking novice users to operate the router");
assert.match(preload, /oneTeamPreflight:[\s\S]*autoResolve:\s*\(input\) => ipcRenderer\.invoke\("oneTeamPreflight:autoResolve"/, "the sandbox bridge must expose the closed automatic staffing capability");
assert.match(ipcSource, /oneTeamPreflight:autoResolve[\s\S]*autoResolveOneTeamPreflight/, "Main must own the automatic staffing policy");
assert.doesNotMatch(shell, /Use an expert|Let One do it|Start with this team|Other options|전문가와 하기|One 혼자 하기|이 팀으로 시작|다른 선택|Why use an expert|왜 전문가가 필요한가요/, "One must never ask a novice user to choose its internal execution topology");
assert.doesNotMatch(shell, /확인 코드|Check code|정본 Task와 정확한 요청 메시지|Canonical Task and exact request message|이 R2 이상 요청|This R2\+ request|범위 불명확|scope unclear|추론됨|inferred/, "One must not expose internal identifiers, risk codes, or inference jargon in beginner-facing decisions and briefings");
assert.match(shell, /event\.oneSurface/, "Desktop One must consume the exact Main-projected surface shared with Mobile");
assert.match(shell, /api\.invoke\.latestOneSurface\(\{/, "One reload must ask Main for the durable semantic result");
assert.match(shell, /const taskReceipt = taskId \? selected\?\.latestReceipt \?\? null : null;/, "surface restore must use only the Main-validated Task receipt");
assert.match(shell, /runId:\s*taskReceipt\.runId/, "surface restore must be bound to the exact Task receipt instead of an earlier conversation run");
assert.match(shell, /taskId,/, "surface restore must carry the canonical Task binding");
assert.match(shell, /setSurface\(durableSurface\?\.manifest \?\? null\)/, "Task re-entry must hydrate the exact persisted manifest");
assert.doesNotMatch(shell, /event\.surface\)/, "Desktop One must not reinterpret the legacy Work manifest");
assert.match(shell, /taskMode:\s*"conversation"/, "a first One message must begin as a Task-free general conversation");
assert.match(shell, /liveRunOwnsThread[\s\S]*runIdRef\.current[\s\S]*runChatIdRef\.current === chatId[\s\S]*!liveRunOwnsThread\) setMessages/, "an empty first history snapshot must not erase the live first turn");
assert.doesNotMatch(shell, /className=\{styles\.taskHeader\}/, "the conversation timeline must not repeat the prompt as a page header");
assert.match(invocationClient, /const persistUserMessage = \(\) =>[\s\S]*persistUserMessage\(\);[\s\S]*restrictedReadBoundary/, "the user's local turn must persist before routing or provider failures");
assert.ok(
  invocationClient.indexOf("const priorHistory =") < invocationClient.indexOf("persistUserMessage();"),
  "One must freeze earlier turns before the current request becomes durable",
);
assert.match(invocationClient, /const hasPriorContext = hadPriorConversationContext;/, "first-turn routing must not mistake the newly stored request for prior context");
assert.ok(
  /const history = priorHistory;/.test(invocationClient)
    || /const history = req\.agentAppMode \? \[\] : listChatMessages\(chat\.id, 80\);[\s\S]*const priorHistory = history;/.test(invocationClient),
  "the ordinary model run must receive only earlier turns as history",
);
assert.match(invocationClient, /runBorrowedTaskForceInvocation\(\{[\s\S]*?priorHistory,/, "top-level task-force runs must receive the frozen earlier-turn history");
assert.match(invocationClient, /runFirmInvocation\(\{[\s\S]*?priorHistory,/, "top-level firm runs must receive the frozen earlier-turn history");
assert.match(borrowedTaskForce, /suppliedPriorHistory[\s\S]*!suppliedPriorHistory[\s\S]*appendChatMessage/, "task-force orchestration must not store its internally expanded prompt over the exact visible user turn");
assert.match(firmOrchestrator, /suppliedPriorHistory[\s\S]*!suppliedPriorHistory[\s\S]*appendChatMessage/, "firm orchestration must not duplicate a Main-owned visible user turn");
assert.match(swarmRun, /p\.priorHistory \?\? listChatMessages/, "swarm continuity must prefer Main's frozen earlier-turn history");
assert.match(claudeRuntime, /authentication_failed[\s\S]*Claude Code is signed out[\s\S]*Reconnect Claude in Settings/, "Claude authentication expiry must produce an actionable One error");
assert.match(shell, /taskIntent,/, "invocation must carry the explicit conversation-versus-Task intent boundary");
assert.match(shell, /taskIntent === "conversation" \? "read" : "write"/, "general conversation must never begin with write authority");
assert.match(shell, /api\.tasks\.findForChat\(chatId\)/, "One must observe runtime promotion without materializing a Task itself");
assert.doesNotMatch(shell, /api\.tasks\.forChat\(chat\.id\)/, "the first prompt must not unconditionally materialize a Task");
assert.doesNotMatch(shell, /api\.tasks\.setStatus/, "renderer must never race the Main-owned canonical Task lifecycle");
assert.match(shell, /api\.tasks\.acceptResult\(\{/, "Task completion must use the exact Main-owned result acceptance API");
assert.match(shell, /expectedVersion:\s*selected\.canonicalVersion/, "result acceptance must carry the exact canonical Task version");
assert.match(shell, /expectedRunId:\s*receipt\.runId/, "result acceptance must carry the exact completed run id");
assert.match(shell, /await refreshAll\(\)/, "successful result acceptance must refresh canonical projections");
assert.doesNotMatch(shell, /api\.tasks\.continueFromResult\(\{/, "One follow-ups must not fork a hidden conversation or Task");
assert.match(shell, /canContinueInPlace/, "result-ready work must remain writable in the same visible conversation");
assert.match(shell, /prepareOrRun\(selected\.chatId, selected\.taskId, selected\.canonicalVersion, "task"\)/, "a result follow-up must continue through the exact visible chat and Task identity");
assert.doesNotMatch(shell, /다음 메시지는 새 일로 시작해요\./, "the composer must not claim that a same-chat follow-up starts separate work");
assert.match(taskContinuationRuntime, /task\.status !== "partial" && task\.status !== "completed"/, "only result-ready or completed work may start a follow-up");
assert.match(taskContinuationRuntime, /continueFromChatId:\s*source\.id/, "Main may carry only the source chat's approved working folder");
assert.match(taskContinuationRuntime, /taskMode:\s*"conversation"/, "a result follow-up must begin without manufacturing a canonical Task");
assert.match(taskContinuationRuntime, /oneText\(input\.locale, "one\.cont\.newRequestNote"\)/, "the continuity cue must use the Main-owned localized copy contract");
assert.match(oneCopyRuntime, /previous team, permissions, and temporary attachments were not carried over/i, "the continuity cue must disclose that execution authority was not reused");
assert.doesNotMatch(taskContinuationRuntime, /hiredAgents|setChatHiredAgents|listChatMessages/, "the continuation runtime must not copy a roster or raw transcript");
assert.match(shell, /api\.confirm\.commitAnswer/, "decision cards must commit a durable answer receipt");
assert.match(shell, /chat\?id=.*task=/s, "the safe fallback Work route must carry the same Task identity");
assert.match(shell, /openOneTaskInWork/, "Work transitions must prefer the canonical Task action bridge");
assert.match(shell, /selected\.truth\.mayStartExecution/, "the composer must honor canonical execution truth");
assert.match(shell, /chooseOneBriefing/, "the start screen must use the evidence-bounded proactive briefing selector");
assert.match(shell, /BRIEFING_DISMISS_MS/, "dismissed Briefings must have an explicit cooldown instead of immediately reappearing");
assert.match(shell, /writeBriefingDismissal/, "the dismiss action must persist the exact Briefing signature");
assert.match(shell, /aria-live="polite"/, "Task conversation must announce live result changes");
assert.match(shell, /nativeEvent\.isComposing/, "composer must not submit in the middle of IME composition");
assert.match(shell, /rows=\{1\}/, "composer must start as a compact single-line input");
assert.match(shell, /maximumHeight = 210/, "composer must grow only with typed line breaks up to about ten lines");
assert.match(shellCss, /\.composer\s*\{[\s\S]*min-height:\s*82px/, "composer shell must start compact and leave growth to the textarea");
assert.match(shellCss, /\.composer textarea\s*\{[\s\S]*min-height:\s*24px/, "composer textarea must start at one line");
assert.match(shellCss, /\.composer textarea\s*\{[\s\S]*max-height:\s*210px/, "composer textarea must stop at the bounded ten-line height");
assert.match(shell, /grantForDroppedFile\(file\)/, "One picker and drop input must cross the existing opaque filesystem-grant boundary");
assert.match(shell, /api\.oneAttachments\.prepare\(\{ chatId, userPrompt: value, attachments \}\)/, "Main must prepare the exact attachment set only when the user submits");
assert.match(shell, /api\.oneAttachments\.bindToTeam\(\{/, "team review must freeze the same prepared attachment capability");
assert.match(shell, /const resolvedIntent = preparedAttachments[\s\S]*classifyOneRequestIntent\(value\)[\s\S]*resolvedIntent,/, "attachments and ordinary user work must resolve to a Task before invocation");
assert.match(invocationService, /classifyOneRequestIntent\(invocationRequest\.userPrompt\)[\s\S]*permissions: "write"/, "Main must revalidate a work-shaped One request instead of trusting renderer intent");
assert.match(shell, /type="file"[\s\S]*multiple/, "the minimal composer must accept multiple files");
assert.match(shell, /onDrop=\{\(event\)/, "the composer must support file drop");
assert.match(shell, /IconPlus/, "the composer must expose the reference-style add control");
assert.match(shell, /aria-label=\{tFor\(appLocale, "one\.shell\.composer\.attach_aria"\)\}/, "the add control must have an accessible localized name");
assert.match(i18n, /"one\.shell\.composer\.attach_aria": "(?:파일 첨부|Attach files)"/, "the attachment name must exist in both locale catalogs");
assert.match(shell, /className=\{styles\.attachmentTray\}/, "selected files must render in a removable tray");
assert.match(shell, /role="alert"/, "attachment validation errors must be announced");
assert.match(shell, /URL\.revokeObjectURL/, "image preview object URLs must be released");
assert.doesNotMatch(shell, /grant\.path|oneAttachmentRef\.[A-Za-z]*path/, "renderer UI and invocation payloads must never display or derive a raw attachment path");
assert.match(shellCss, /\.attachmentButton[\s\S]*min-height:\s*44px/, "composer tool controls must meet the 44px accessibility target");
assert.match(shellCss, /\.attachmentChip[\s\S]*min-height:\s*44px/, "attachment rows must remain touch accessible");
assert.match(attachmentContract, /interface OneAttachmentRef \{[\s\S]*attachmentSetId:[\s\S]*capabilityToken:/, "renderer authority must be an opaque single-use ref");
assert.doesNotMatch(attachmentContract.match(/interface OneAttachmentRef \{[\s\S]*?\n\}/)?.[0] ?? "", /path|name|size/, "the opaque ref must contain no file metadata or path");
assert.match(attachmentRuntime, /pathFromGrant\(item\.grant, "file"\)/, "Main must resolve the exact file grant");
assert.match(attachmentRuntime, /O_NOFOLLOW/, "Main must reject symlink file opens");
assert.match(attachmentRuntime, /identitiesEqual[\s\S]*hashFd/, "Main must revalidate identity and digest immediately before claim");
assert.match(attachmentRuntime, /\.agentlas", "one-attachments"/, "Main must use run-scoped private staging copies");
assert.match(attachmentRuntime, /record\.status = "claimed"/, "attachment capabilities must be single-use");
assert.match(shell, /useDismissibleLayer\(\{[\s\S]*open:\s*searchOpen[\s\S]*restoreFocusRef:\s*searchTriggerRef/, "search must close on outside interaction or Escape and restore trigger focus");
assert.match(shell, /trapSearchFocus[\s\S]*event\.key\s*!==\s*"Tab"[\s\S]*last\.focus\(\)[\s\S]*first\.focus\(\)/, "the modal search surface must keep keyboard focus inside its controls");
assert.match(shell, /api\.oneSearch\.search\(\{/, "One search must query Main-owned full history instead of filtering only recent renderer rows");
assert.doesNotMatch(shell, /className=\{styles\.railFilter\}/, "the sidebar must not duplicate full-history search with a second inline filter");
assert.match(shell, /cursor:\s*input\.cursor \?\? null/, "One search pagination must carry the opaque Main cursor");
assert.match(shell, /includeArchived:\s*input\.includeArchived/, "One search must expose an explicit archive scope");
assert.match(shell, /api\.oneSearch\.mutateArchive\(\{[\s\S]*expectedTaskVersion:[\s\S]*expectedOriginChatUpdatedAt:/, "Task archive actions must bind both canonical Task and origin-chat versions");
assert.match(shell, /searchHits\.map\(\(hit\)/, "Main search pointers must render as bounded result rows");
assert.match(searchRuntime, /queryHash:[\s\S]*includeArchived:[\s\S]*updatedAt:[\s\S]*sortKey:/, "opaque cursors must bind the query, archive scope, and deterministic position");
assert.match(searchRuntime, /redactPrivatePaths\(redactSecrets\(value\)\)/, "search snippets must remove credentials and private host paths before IPC");
assert.match(searchRuntime, /const mutate = db\.transaction/, "Task and origin-chat archive changes must share one atomic transaction");
assert.match(searchRuntime, /taskResult\.changes !== 1 \|\| chatResult\.changes !== 1/, "archive mutation must fail closed on either CAS mismatch");
assert.match(searchRuntime, /priorStatusForRestore\(task, chat\)/, "restoring a Task must recover its receipt-bound pre-archive canonical status");
assert.match(preload, /oneSearch:[\s\S]*search:[\s\S]*mutateArchive:/, "the sandbox bridge must expose only closed One search and archive methods");
assert.match(ipcSource, /oneSearch:search[\s\S]*searchOneHistory/, "Main must own the full-history search handler");
assert.match(ipcSource, /oneSearch:mutateArchive[\s\S]*activeChatIds\(\)/, "Main must reject archive changes while the origin Task is running");
assert.match(shell, /api\.oneMemory\.getState\(\)/, "One must hydrate Memory from Main instead of renderer-local state");
assert.match(shell, /<OneMemorySheet/, "One must expose the explicit Memory review surface");

assert.match(memorySheet, /api\.oneMemory\.save\(\{/, "a Memory candidate must require an explicit Save action");
assert.match(memorySheet, /api\.oneMemory\.editAndSave\(\{/, "a Memory candidate must support edit-and-approve");
assert.match(memorySheet, /api\.oneMemory\.useOnce\(\{/, "a Memory candidate must support non-durable one-time use");
assert.match(memorySheet, /target:\s*useOnceTarget/, "one-time use must bind the exact visible conversation or Task target");
assert.doesNotMatch(memorySheet, /useOnceReceipt\.content/, "the renderer receipt must never expose one-time Memory content");
assert.match(memorySheet, /tFor\(locale, "one\.mem\.once\.title"\)/, "one-time use must render the localized next-request lifecycle");
assert.match(i18n, /다음 요청에 1회 적용|Applies to the next request once/, "one-time use must state its exact next-request lifecycle");
assert.match(memorySheet, /tFor\(locale, "one\.mem\.once\.note"\)/, "the UI must render the localized expiry disclosure");
assert.match(i18n, /앱을 다시 켜거나, 시간이 지나면 사라집니다|an app restart, or expiry/, "the UI must disclose process-local expiry truth in plain language");
assert.match(shell, /oneMemoryUseOnceRef:\s*\{[\s\S]*receiptId:/, "the next One invocation must carry only the opaque one-time reference");
assert.match(shell, /setArmedOneMemoryUseOnce[\s\S]*finally/, "the renderer must not auto-attach the same receipt after a start attempt");
assert.match(memoryRuntime, /const oneMemoryUseOnceGrants = new Map/, "one-time content must live only in Main process memory");
assert.match(memoryRuntime, /findCanonicalTaskForChat\(chat\.id\)/, "Main must revalidate optional canonical Task authority without creating one");
assert.match(memoryRuntime, /candidate\.version !== grant\.candidateVersion/, "claim must revalidate the exact candidate version");
assert.match(memorySheet, /api\.oneMemory\.reject\(\{/, "a Memory candidate must support explicit rejection");
assert.match(memorySheet, /approvedByUser:\s*true/, "durable Memory writes must carry explicit user approval");
assert.match(i18n, /오래 기억하지 않습니다|not saved long term/, "one-time use must disclose in plain language that it is not durable Memory");
assert.doesNotMatch(memorySheet, /정확한 범위 ID|Exact scope ID/, "beginners must never be asked to enter an internal memory scope id");
assert.match(memorySheet, /tFor\(locale, "one\.mem\.candidate\.why_summary"\)/, "memory provenance must render through localized copy");
assert.match(i18n, /왜 기억하자고 했는지 보기|Why One suggested this/, "memory provenance must stay behind a plain-language disclosure");
assert.match(memorySheet, /role="dialog"/, "Memory review must expose dialog semantics");
assert.match(memorySheet, /event\.key\s*!==\s*"Tab"[\s\S]*last\.focus\(\)[\s\S]*first\.focus\(\)/, "Memory review must trap keyboard focus while modal");
assert.match(memorySheetCss, /min-height:\s*44px/, "Memory controls must meet the 44px accessibility target");
assert.match(profileSheet, /role="dialog"/, "One profile must expose dialog semantics");
assert.match(profileSheet, /event\.key\s*!==\s*"Tab"[\s\S]*last\.focus\(\)[\s\S]*first\.focus\(\)/, "One profile must trap keyboard focus while modal");
assert.doesNotMatch(profileSheet, /profile\.oneId\.slice|identityRef/, "One profile must not expose an internal identity id to beginners");
assert.match(result, /friendlyFailureMessage\(receipt\.errorMessage, locale, stopped\)/, "failure details must use beginner-friendly localized copy");
assert.doesNotMatch(result, /receipt\.errorMessage\s*\?\s*sanitizeText/, "raw runtime errors must not be shown to beginners");

assert.match(shell, /api\.oneSuggestions\.getState\(\)/, "One must hydrate ecosystem suggestions from Main's durable arbiter");
assert.match(shell, /suggestion\.status === "open" && actionableConfirmations\.length === 0 && !briefingSnapshot\?\.candidate/, "an important decision or Briefing must suppress an open ecosystem suggestion");
assert.match(shell, /<OneSuggestionCard/, "eligible evidence-gated suggestions must render after the result flow");
assert.match(suggestionCard, /reviewOnly:\s*true/, "accepting a suggestion must create a review draft only");
assert.match(suggestionCard, /tFor\(locale, "one\.sug\.receipt\.title"\)/, "accepted suggestions must render the localized no-execution boundary");
assert.match(i18n, /Nothing has been saved or started yet|아직 저장하거나 시작하지 않았어요/, "accepted suggestions must disclose the no-execution boundary in beginner language");
assert.match(suggestionCard, /oneSuggestions\.getReviewHandoff\(\{/, "Continue review must re-resolve the exact canonical handoff in Main");
assert.match(suggestionCard, /expectedSuggestionVersion:\s*suggestion\.version/, "review handoff must bind the exact suggestion version");
assert.match(suggestionCard, /reviewRequestId:\s*review\.id[\s\S]*draftId:\s*review\.draftId[\s\S]*originTaskId:\s*suggestion\.originTaskId/, "review handoff must bind the review, draft, and origin Task ids");
assert.match(suggestionCard, /tFor\(locale, "one\.sug\.receipt\.continue"\)/, "accepted receipts must expose a localized draft continuation action");
assert.match(i18n, /초안 계속 보기|Continue with draft/, "accepted receipts must expose a real draft continuation action");
assert.match(suggestionCard, /oneSuggestions\.neverAsk/, "suggestions must expose Never ask again");
assert.match(i18n, /earnings are not guaranteed|수익은 보장되지 않아요|수익은 보장되지 않습니다/i, "Hub derivatives must not promise earnings");
assert.match(suggestionCard, /accepted_internal_result/, "accepted-result suggestions must render as internal completions rather than external success");
assert.match(suggestionCard, /tFor\(locale, "one\.sug\.basis\.accepted"/, "accepted-result suggestion copy must come from the locale catalog");
assert.match(i18n, /외부 성과가 성공했다는 뜻은 아닙니다|does not prove an external outcome succeeded/, "accepted-result suggestion copy must disclose its weaker truth boundary");
assert.match(suggestionCardCss, /min-height:\s*44px/, "suggestion controls must meet the 44px accessibility target");
assert.match(preload, /oneSuggestions:[\s\S]*getReviewHandoff:/, "the renderer must consume a real Main-owned review handoff instead of a dead query");
assert.match(ipcSource, /oneSuggestions:getReviewHandoff/, "Main must expose the review handoff validator");
assert.match(suggestionReviewHandoff, /oneSuggestions\.getReviewHandoff\(parsed\.input\)/, "destination surfaces must consume and revalidate the handoff query");
assert.match(suggestionReviewHandoff, /resolved\.targetSurface !== surface/, "a handoff opened on the wrong product surface must fail closed");
assert.match(suggestionReviewHandoff, /currentParams\.get\("task"\) !== parsed\.input\.originTaskId/, "Work fallback must fail closed unless the visible Task is the exact origin Task");
assert.match(suggestionReviewHandoff, /resolved\.reviewOnly !== true[\s\S]*resolved\.actionState !== "not_started"/, "destination surfaces must preserve the no-action boundary");
assert.match(suggestionReviewHandoff, /resolved\.externalOutcomeVerified !== \(resolved\.evidenceBasis === "verified_outcomes"\)/, "destination surfaces must preserve the exact evidence-strength boundary");
assert.match(suggestionReviewHandoff, /(?:tFor|reviewCopy)\(locale, "one\.rev\.error\.detail"\)/, "blocked handoffs must render the localized no-action boundary");
assert.match(i18n, /Nothing was saved, started, or published|아무것도 저장하거나 시작하거나 공개하지 않았습니다/, "blocked handoffs must state that no product action occurred in beginner language");
assert.doesNotMatch(suggestionCard, /정본|canonical|스캐폴드|scaffold|Current Task|현재 Task|Asset ref|자산 참조/, "suggestion cards must not expose developer terminology");
assert.doesNotMatch(suggestionReviewHandoff, /정본|canonical|스캐폴드|scaffold|Current Task|현재 Task|Asset ref|자산 참조/, "review handoffs must keep developer terminology out of the beginner surface");
assert.match(buildPage, /OneSuggestionReviewHandoffBanner surface="build"/, "Build must consume agent-definition review handoffs");
assert.match(agentGroupsPage, /OneSuggestionReviewHandoffBanner surface="agent_groups"/, "Agent Groups must consume team review handoffs");
assert.match(automationPage, /OneSuggestionReviewHandoffBanner surface="automation"/, "Automation must consume automation review handoffs");
assert.match(workChat, /OneSuggestionReviewHandoffBanner surface="work"/, "Work must consume explicit fallback review handoffs");
assert.match(suggestionRuntime, /return \{ surface: "work", baseRoute: "\/chat", fallbackReason: null \}/, "local public-derivative review must use Work without claiming an unsupported-editor fallback");
assert.match(suggestionRuntime, /fallbackToOriginTaskWork:\s*target\.surface === "work" && suggestion\.type !== "hub_derivative"/, "Hub derivative review must be a first-class Work review surface rather than a generic origin-Task fallback");
assert.match(suggestionReviewHandoff, /api\.oneHubDerivative\.getDraft\(parsed\.input\)/, "Hub derivative review must resolve the durable local draft from Main");
assert.match(suggestionReviewHandoff, /input:\s*\{\s*suggestionId,\s*expectedSuggestionVersion,\s*reviewRequestId,\s*draftId,\s*originTaskId\s*\}/, "review handoff transport must remain the exact opaque five-field binding");
assert.doesNotMatch(suggestionReviewHandoff, /\b(?:privateContext|transcript|credentialValue|localPath|rawContext)\s*[:=]/i, "review handoff UI must not transport private raw context or secret values");

assert.match(shell, /api\.oneValueClosure\.getState\(\)/, "One must hydrate Value Closure from Main's trusted receipt store");
assert.match(shell, /record\.closure\.taskId === selected\.taskId/, "Value Closure must bind to the exact canonical Task");
assert.match(shell, /record\.closure\.valueClosureId === declaredRef/, "a manifest ValueClosure reference must bind to the exact trusted record");
assert.doesNotMatch(result, /<OneValueClosureCard|<OneImprovementProofCard|<OneExperienceReuseCard/, "internal compounding records must stay out of the beginner-facing One result");
assert.match(valueClosureCard, /lifecycleClaims\.map/, "Value Closure must separate discovery, preparation, execution, and verification phases");
assert.match(valueClosureCard, /item\.kind === "fact"/, "verified facts must remain distinct from estimates");
assert.match(valueClosureCard, /item\.estimate\.basis/, "estimates must disclose their basis");
assert.match(valueClosureCard, /originalPreservation/, "Value Closure must disclose original preservation truth");
assert.match(valueClosureCard, /remainingWork/, "Value Closure must disclose remaining work and ownership");
assert.match(valueClosureCard, /setReflection/, "weekly reflection must remain an explicit user choice");
assert.match(valueClosureCardCss, /min-height:\s*44px/, "Value Closure controls must meet the 44px accessibility target");
assert.match(preload, /oneValueClosure:[\s\S]*getState:[\s\S]*latestForTask:[\s\S]*setReflection:/, "renderer bridge may read Value Closure and set reflection only");
assert.doesNotMatch(preload, /oneValueClosure:[\s\S]{0,500}create/, "renderer must never create trusted Value Closure evidence");
assert.match(shell, /api\.oneImprovementProof\.getState\(\)/, "One must hydrate Improvement Proof from Main's durable store");
assert.match(shell, /record\.currentTaskVersion === selected\.canonicalVersion/, "Improvement Proof must bind to the exact canonical Task version");
assert.match(shell, /record\.proof\.improvementProofId === declaredRef/, "a manifest ImprovementProof reference must bind to the exact trusted record");
assert.match(improvementProofCard, /<details className=\{styles\.card\}(?![^>]*\bopen\b)[^>]*>/, "Improvement Proof must remain collapsed by default");
assert.match(improvementProofCard, /improved[\s\S]*no_change[\s\S]*regression/, "Improvement Proof must preserve improved, no-change, and regression outcomes");
assert.match(improvementProofCard, /evidenceType === "measured"[\s\S]*evidenceType === "estimate"/, "measured and estimated improvements must stay distinct");
assert.match(improvementProofCard, /tFor\(locale, "one\.proof\.title"\)/, "Improvement Proof must render its localized observed-comparison title");
assert.match(i18n, /What changed since last time/, "Improvement Proof must describe an observed comparison in plain language");
assert.doesNotMatch(improvementProofCard, /What prior experience changed this time|이전 경험이 이번 결과에 준 변화/, "Improvement Proof must not use the former causal title");
assert.match(improvementProofCard, /data-attribution-status=\{proof\.attributionStatus\}/, "Improvement Proof must expose the closed attribution status");
assert.match(improvementProofCard, /proof\.attributionStatus === "established"/, "Improvement Proof must render established and not-established attribution distinctly");
assert.match(improvementProofCard, /tFor\(locale, "one\.proof\.attribution_correlated"\)/, "unestablished attribution must render the localized causal boundary");
assert.match(i18n, /cannot claim that one caused the other/, "unestablished attribution must disclose the causal boundary in plain language");
assert.match(improvementProofCard, /onManageAsset\(asset\)/, "reused assets must lead to their real management surface");
assert.doesNotMatch(improvementProofCard, /engagementScore|participationScore/i, "Improvement Proof must never become an engagement score");
assert.match(improvementProofCardCss, /min-height:\s*44px/, "Improvement Proof controls must meet the 44px accessibility target");
assert.match(preload, /oneImprovementProof:[\s\S]*getState:[\s\S]*list:[\s\S]*latestForTask:/, "renderer bridge may read Improvement Proof only");
assert.doesNotMatch(preload, /oneImprovementProof:[\s\S]{0,500}create/, "renderer must never create trusted Improvement Proof evidence");
assert.match(ipcSource, /evidence:\s*_mainOnlyEvidence,[\s\S]*readState/, "Main-only Improvement attestations must not cross renderer IPC");

assert.match(result, /RunClosure/, "terminal runs must render a receipt-bounded Run Closure");
assert.match(acceptedClosureRuntime, /\["startedAt", "updatedAt", "finishedAt", "eventCount"\]/, "Value Closure authority must compare the durable receipt event count");
assert.match(result, /receipt\.status !== "completed"/, "Run Closure must be reserved for work that stopped instead of decorating a successful result");
assert.doesNotMatch(result, /Your result is ready|also check the final confirmation screen/, "successful results must not add a separate technical closure card");
assert.match(result, /projection\.canonicalStatus === "partial"/, "Finish result must appear only for canonical partial work");
assert.match(result, /tFor\(locale, "one\.res\.finish_here"\)/, "a completed run must expose localized explicit user acceptance instead of auto-completing the work");
assert.match(result, /canAcceptResult\s*&&\s*!hasManifest/, "plain-text final runs must expose result acceptance even without a structured manifest");
assert.match(result, /standaloneAcceptance/, "plain-text result acceptance must render after the Run Closure");
assert.match(result, /<RunClosure[\s\S]*canAcceptResult\s*&&\s*!hasManifest/, "plain-text result acceptance must follow the receipt-bounded Run Closure");
assert.match(result, /tFor\(locale, "one\.res\.acceptance_boundary"\)/, "result acceptance must render the localized reuse boundary");
assert.match(i18n, /One will ask before reusing anything next time/, "result acceptance must explain reuse in ordinary user language");
assert.doesNotMatch(result, /Run completed|Finish with this result|external outcomes require separate evidence/, "developer-facing closure copy must not return to the primary result flow");
assert.doesNotMatch(result, /receipt\.runId\.slice|receipt\.eventCount} events|처리 \$\{receipt\.eventCount}/, "the expandable work record must not expose run identifiers or event counters");
assert.doesNotMatch(valueClosureCard, /outcomeRefs\.join|receiptRefs\.join|trustedEvidenceRefs\.join/, "the beginner-facing value card must show understandable check counts, not internal evidence identifiers");
assert.match(result, /isInternalColumnLabel/, "renderer must hide internal evidence and provenance columns from older durable results");
assert.match(result, /isStepTable[\s\S]*StepTable/, "ordered table data must become an easy step layout instead of a wide developer table");
assert.match(result, /hasSourceListBlock/, "a result with a source block must not repeat the same evidence disclosure");
assert.match(result, /friendlySurfaceSummary/, "generic adapter prose must become plain user-facing result copy");
assert.match(invocationClient, /deterministicOneCompletionCopy/, "deterministic results must receive task-aware completion copy");
assert.match(invocationClient, /요청한 결과와 파일을 준비했어요/, "office results must not claim that research and source cross-checking occurred");
assert.match(invocationClient, /일정과 비용, 준비할 내용을 한눈에 정리했어요/, "travel results must receive travel-specific completion copy");
assert.match(shell, /tFor\(locale, "one\.shell\.receipt\.change_mind"\)/, "resolved choices must render the localized next step");
assert.match(i18n, /If you change your mind, just tell One/, "resolved choices must explain the next step in ordinary user language");
assert.doesNotMatch(shell, /This receipt proves only that the response was committed/, "decision receipts must not lead with audit language");
assert.match(shell, /detectOneTextLocale\(pendingTeamPrompt\?\.text/, "automatic preparation chrome must immediately follow the pending request language");
assert.match(shell, /setTeamPreflightBusy\(true\);[\s\S]*api\.chats\.create/, "a brand-new request must stay visibly in motion while its chat and Task are created");
assert.match(shell, /teamPreflightBusy && !busy/, "the first request transition must show a plain-language preparing state instead of an empty chat");
assert.match(shell, /activeThreadPromptFallback \|\| proposal\.goalSummary/, "a reloaded preparation must keep the user's active request visible instead of showing an internal summary");
assert.match(shell, /message\.id === structuredResultMessageId/, "a structured result must replace, not duplicate, the final long Markdown answer");
assert.doesNotMatch(shell, /Your next message starts new work/, "the composer must not describe an invisible session fork");
assert.match(adapter, /localizedBriefingBody/, "briefing must not expose foreign-language generated summaries in the selected UI language");
assert.match(adapter, /Open the result to review what One prepared/, "English result-ready briefing must have a safe English fallback");
assert.match(shell, /const resultTopRef = useRef<HTMLDivElement>\(null\)/, "a completed result must have a stable top anchor");
assert.match(shell, /scrollResultToTop\("auto"\)/, "a completed result must open at its title instead of jumping to its bottom actions");
assert.match(shell, /receipt\?\.runId, scrollResultToTop, surface\?\.manifestId/, "result scrolling must react to the exact receipt and surface layout");
assert.match(shell, /ref=\{resultTopRef\}[\s\S]*<OneAdaptiveResult/, "the adaptive result must render inside the stable top anchor");
assert.match(shellCss, /\.resultAnchor\s*\{[\s\S]*scroll-margin-top:\s*24px/, "the result top anchor must keep comfortable space below the window bar");
assert.doesNotMatch(shell, /resultAutoScrollRef/, "a result title must not depend on a fragile one-frame auto-scroll flag");
assert.match(shell, /if \(busy \|\| \(!surface && !receipt\)\) return;/, "every completed or reopened result must start at its title");
assert.match(oneBrand, /agentlas-one-mark\.png/, "One must use the transparent symbol-only Agentlas One logo asset");
assert.doesNotMatch(shellCss, /\.briefingOne span:first-child/, "the real One mark must not be replaced by the legacy black circle styling");
assert.match(oneBrandCss, /mask:\s*url\("\/brand\/agentlas-one-mark\.png"\)[\s\S]*@keyframes sweepLight/, "thinking must sweep a broad light from left to right across the real logo mark");
assert.doesNotMatch(oneBrandCss, /offset-path|@keyframes travel/, "the old dot-following-the-logo-path animation must not return");
assert.match(shell, /<OneBrandMark size="thinking" thinking \/>/, "run progress must use the animated One mark instead of generic dots");
assert.doesNotMatch(shell, /runProgressDots/, "generic progress dots must not remain in One thinking UI");
assert.doesNotMatch(result, /Verified complete/, "a final invocation receipt must not be presented as externally verified completion");
assert.match(result, /deliberately absent from the ordinary One conversation surface/, "internal improvement evidence must stay quiet in the ordinary One result");
assert.match(result, /surface\?\.primaryAction\?\.label/, "the result must expose only the closed semantic primary action");
assert.match(result, /redactSecrets/, "One result rendering must redact shared credential shapes");
assert.match(result, /localLocationLabel/, "One must collapse host paths before display");
assert.doesNotMatch(result, /adaptLegacySurfaceToOneV1/, "renderer must not repeat the Main-owned legacy conversion");
assert.match(result, /OneSurfaceManifestV1/, "the result path must consume the shared closed One manifest type");
assert.match(result, /ONE_SURFACE_BLOCK_TYPES/, "renderer support decisions must derive from the authoritative shared 17-block vocabulary");
for (const kind of ["Comparison", "Map", "Document", "SourceList", "Decision", "Status", "Budget"]) {
  assert.match(result, new RegExp(`block\\.type === "${kind}"`), `Desktop must natively preserve the ${kind} semantic layout`);
}
assert.match(result, /"Gallery"|DESKTOP_FALLBACK_BLOCK_TYPES/, "artifact media without a trusted resolver must remain on the shared Work fallback");
assert.match(result, /tFor\(locale, "one\.res\.decision\.choose_hint"\)/, "embedded Decision results must render the localized One continuation cue");
assert.match(i18n, /Choose an option, then tell One to continue|선택한 뒤 One에게 말하면 다음 단계로 넘어갑니다/, "embedded Decision results must direct the user back through One instead of becoming an independent approval authority");
assert.match(result, /block\.type !== "ValueClosure" && block\.type !== "ImprovementProof"/, "receipt-backed closure blocks must render after the result instead of inside its model-authored body");
assert.match(result, /fallback\.markdown/, "unsupported or invalid surfaces must render their safe Markdown fallback");
assert.match(result, /fallback\.artifacts/, "unsupported or invalid surfaces must render their safe artifact summaries");
assert.match(result, /data-fallback-markdown/, "the safe Markdown fallback must be visible in the result surface");
assert.match(result, /data-artifact-ref/, "safe artifact references must retain semantic identity without becoming executable links");
assert.match(result, /allowedKeys/, "fallback artifacts must expose only the closed artifact summary fields");
assert.match(result, /data-semantic-id/, "native blocks must expose cross-platform semantic identity");
assert.match(result, /data-block-kind/, "native blocks must expose the frozen semantic block kind");
assert.doesNotMatch(result, /dangerouslySetInnerHTML/, "One result rendering must never execute model-provided HTML");

assert.match(invocationService, /tryRecordDurableOneSurfaceResult\(\{/, "Main must durably bind each projected surface before reload");
assert.match(invocationService, /const durableSurfaceRecorded = tryRecordDurableOneSurfaceResult/, "manifest claims must wait for durable storage success");
assert.match(invocationService, /durableSurfaceRecorded && surfaceTask/, "a failed durable write must not emit a manifest-ready claim");
assert.match(invocationService, /eventType: "run\.step_changed"/, "observable runtime steps must produce exact domain events");
assert.match(invocationService, /eventType: "artifact\.created"/, "durable artifact summaries must produce creation evidence");
assert.match(invocationService, /eventType: "artifact\.verified"/, "verified artifact summaries must produce verification evidence");
assert.match(invocationService, /detectExplicitOneMemoryIntent\(invocationRequest\.userPrompt\)/, "Main may propose Memory only from an explicit remember instruction after Main-owned request narrowing");
assert.match(invocationService, /terminalKind === "invoke_completed"/, "an explicit Memory proposal must wait for a completed run");
assert.match(invocationService, /proposeUnverifiedOneMemoryCandidateFromRun\(\{/, "a completed explicit instruction may create only an unverified review candidate before acceptance");
assert.doesNotMatch(invocationService, /saveOneMemoryCandidate\(/, "invocation completion must never auto-save long-term Memory");
assert.ok(
  invocationService.lastIndexOf("prepareOneMemoryUseOnceClaim(") < invocationService.indexOf("registerDurableInvocationStart({")
    && invocationService.lastIndexOf("claimPreparedOneMemoryUseOnce(") > invocationService.indexOf("registerDurableInvocationStart({"),
  "Main must validate before and consume only after durable invocation-start acceptance",
);
assert.match(invocationService, /kind:\s*"one_memory_use_once_claimed"/, "actual one-time consumption must leave a content-free run receipt");
assert.match(invocationService, /eventType:\s*"receipt\.recorded"/, "Task-bound one-time consumption must leave domain evidence");
assert.match(oneSurfaceStore, /run_id = \? AND chat_id = \? AND kind = \?/, "restore must query one exact run and chat");
assert.match(oneSurfaceStore, /input\.manifest\.taskId !== task\.id/, "durable writes must fail closed on Task/chat mismatch");
assert.match(runLedger, /delete payload\.oneSurfaceJson/, "the generic run ledger must not leak exact structured results");
assert.match(preload, /invoke:latestOneSurface/, "the sandbox bridge must expose only the dedicated restore API");
assert.match(shell, /api\.oneBriefing\.prepareAction\(/, "the first Briefing action must prepare a review packet only");
assert.match(shell, /api\.oneBriefing\.startAction\(/, "the second explicit Briefing action must request the Main-owned read-only Task");
assert.match(shell, /api\.oneBriefing\.openTask\(\{[\s\S]*expectedTaskVersion:/, "canonical Task findings must use exact Main-revalidated navigation");
assert.match(shell, /tFor\(appLocale, "one\.shell\.briefing\.channel_desktop"\)/, "One settings must expose localized Desktop notification opt-in");
assert.match(shell, /tFor\(appLocale, "one\.shell\.briefing\.quiet_hours"\)/, "One settings must expose localized quiet hours");
assert.match(shell, /tFor\(appLocale, "one\.shell\.briefing\.phone_label"\)/, "unsupported phone notifications must be visibly disabled and truthful");
assert.match(shell, /source\.kind === "canonical_task"[\s\S]*one\.shell\.briefing\.packet_canonical/, "current-work review copy must not claim file or automation review");
assert.match(shell, /source\.kind === "canonical_task"[\s\S]*one\.shell\.briefing\.meta_current_progress/, "current-work detail metadata must never be mislabeled as an automation record");
assert.match(shell, /<details className=\{styles\.briefingPacketDetails\}>[\s\S]*one\.shell\.briefing\.what_checked/, "internal briefing checks must stay collapsed behind everyday language");
assert.doesNotMatch(shell, />검토 패킷 준비됨<|>Review packet ready</, "internal packet language must not remain visible");
assert.match(preload, /oneBriefing:[\s\S]*openTask:/, "the sandbox bridge must expose exact Task navigation without execution authority");
assert.match(ipcSource, /oneBriefing:openTask[\s\S]*resolveOneBriefingTaskNavigation/, "Main must revalidate the exact Briefing Task binding");
assert.match(briefingRuntime, /task\.status === "running"[\s\S]*!activeRunPresent/, "running Task findings must prove that no live run exists");
assert.match(briefingRuntime, /task\.status === "failed" && failures\.length >= 2/, "repeated failure findings must use durable failure receipts");
assert.match(briefingRuntime, /notificationReceipts[\s\S]*mutateStateCas/, "Desktop notification dedupe must be persistent and CAS guarded");
assert.match(mainRuntime, /setInterval\(checkOneBriefingDesktopNotification, 15 \* 60 \* 1_000\)/, "Main must use a low-frequency Briefing scheduler");
assert.match(mainRuntime, /checkOneBriefingDesktopNotification[\s\S]*!getAuthSession\(\)\.signedIn[\s\S]*return/, "signed-out Desktop must not claim or show a prior opt-in notification");
assert.match(mainRuntime, /oneBriefingLaunchTimer\.unref\(\)[\s\S]*oneBriefingInterval\.unref\(\)/, "Briefing timers must not keep Desktop alive");
assert.match(mainRuntime, /body: "One found something that may need your attention\. Open Agentlas to review it\."/, "OS notification copy must remain generic and privacy-safe");
assert.match(mainRuntime, /notification\.on\("click"[\s\S]*openOneFromNotification/, "notification clicks must open One through a non-executing navigation path");
assert.match(shell, /one\.shell\.briefing\.phone_label[\s\S]*checked=\{false\} disabled/, "phone notifications must remain a disabled truthful control");
assert.match(shell, /tFor\(appLocale, "one\.shell\.briefing\.why_noticed"\)/, "the second action must remain a localized evidence-review action");
assert.match(shell, /tFor\(appLocale, "one\.shell\.briefing\.files_unchanged"\)/, "the evidence review must disclose its localized no-change boundary");
assert.match(briefingActions, /status:\s*"task_reserved"/, "Briefing Task creation must cross a durable reservation boundary");
assert.match(briefingActions, /status:\s*"start_reserved"/, "Briefing invocation must cross a distinct durable start reservation boundary");
assert.match(briefingActions, /ownerInstanceId:\s*PROCESS_INSTANCE_ID/, "only the live Main owner may consume a Briefing reservation");
assert.match(invocationService, /permissions:\s*"read"[\s\S]*sessionRouting:\s*false[\s\S]*hubMode:\s*"local-only"/, "Briefing review invocation must be narrowed in Main, independent of renderer fields");
assert.ok(
  invocationService.lastIndexOf("prepareOneBriefingActionClaim(") < invocationService.indexOf("registerDurableInvocationStart({")
    && invocationService.lastIndexOf("claimPreparedOneBriefingAction(") > invocationService.indexOf("registerDurableInvocationStart({"),
  "Main must validate a Briefing packet before and claim it only after durable invocation-start acceptance",
);

assert.match(surfaceAdapter, /ONE_SURFACE_BLOCK_TYPES/, "the shared contract must freeze the 17-block vocabulary");
assert.match(surfaceAdapter, /EXECUTABLE_RE/, "executable-looking legacy content must fail closed");
assert.match(surfaceAdapter, /return \[\]/, "unknown dataset semantics must fail to the shared fallback");
const surfaceRuntime = loadStandaloneTs(surfaceAdapter, "one-surface-adapter.ts");
assert.equal(surfaceRuntime.ONE_SURFACE_BLOCK_TYPES.length, 17, "the shared vocabulary must contain exactly 17 block kinds");
const safePlan = surfaceRuntime.adaptLegacySurfaceToOneV1({
  surfaceId: "surface:test", taskId: "task:test", syncedAt: "2026-07-18T00:00:00.000Z",
  manifest: {
    version: "0.1",
    kind: "surface",
    title: "Comparison",
    domain: "research",
    layout: "table",
    data: {
      comparison: { type: "table", columns: ["name", "price"], rows: [{ name: "A", price: 10 }] },
      summary: { type: "markdown", value: "A is the current candidate." },
    },
    widgets: [{ type: "table", data: "comparison" }, { type: "report", data: "summary" }],
    actions: [{ id: "copy-result", label: "Copy", type: "copy" }],
  },
});
assert.deepEqual(safePlan.blocks.map((block) => block.type), ["Table", "Narrative"], "legacy datasets must map to stable block semantics");
assert.ok(safePlan.blocks.every((block) => block.blockId.startsWith("block:")), "every native block must expose a stable semantic id");
const internalColumnPlan = surfaceRuntime.adaptLegacySurfaceToOneV1({
  surfaceId: "surface:internal-columns", taskId: "task:internal-columns", syncedAt: "2026-07-18T00:00:00.000Z",
  manifest: {
    version: "0.1", kind: "surface", title: "체크리스트", domain: "operations", layout: "table",
    data: { items: { type: "table", columns: ["순서", "내용", "EvidenceIds"], rows: [{ "순서": "1", "내용": "확인", EvidenceIds: ["src_1"] }] } },
    widgets: [{ type: "table", data: "items", title: "Items" }],
  },
});
assert.deepEqual(internalColumnPlan.blocks[0]?.columns.map((column) => column.label), ["순서", "내용"], "internal evidence ids must never become user-facing table columns");
const unknownPlan = surfaceRuntime.adaptLegacySurfaceToOneV1({
  surfaceId: "surface:test", taskId: "task:test", syncedAt: "2026-07-18T00:00:00.000Z",
  manifest: { version: "0.1", kind: "surface", title: "Unknown", domain: "test", layout: "report", data: { custom: { type: "cards", items: [{ title: "Ambiguous" }] } }, widgets: [] },
});
assert.equal(unknownPlan.blocks[0]?.blockId, "block:fallback", "ambiguous legacy semantics must fall back to Work as a whole");
const executablePlan = surfaceRuntime.adaptLegacySurfaceToOneV1({
  surfaceId: "surface:test", taskId: "task:test", syncedAt: "2026-07-18T00:00:00.000Z",
  manifest: { version: "0.1", kind: "surface", title: "Unsafe", domain: "test", layout: "report", data: { note: { type: "markdown", value: "<script>alert(1)</script>" } }, widgets: [] },
});
assert.equal(executablePlan.blocks[0]?.blockId, "block:fallback", "executable-looking content must never enter the native renderer");

assert.doesNotMatch(intro, /localStorage|sessionStorage/, "feature intro component must never treat renderer storage as authority");
assert.match(intro, /needsAcknowledgement/, "feature intro must receive Main-owned version eligibility");
assert.match(intro, /onResolve/, "feature intro must persist an explicit Main-owned resolution");
assert.match(intro, /!eligible\s*&&\s*needsAcknowledgement[\s\S]*setOpen\(false\)/, "a newly blocking state must close the optional intro without acknowledgement");
assert.match(intro, /"skipped"/, "feature intro must distinguish an explicit skip");
assert.match(intro, /"opened_one"/, "feature intro must distinguish opening One");
assert.match(intro, /"kept_work"/, "feature intro must distinguish keeping Work");
assert.match(appShell, /api\.oneFeatureIntro\.getState\(\)/, "app shell must load feature-intro authority from Main");
assert.match(appShell, /resolution:\s*"legacy_migrated"/, "app shell must migrate the old renderer acknowledgement once");
assert.match(appShell, /api\.oneFeatureIntro\.defer/, "app shell must record safety deferrals without acknowledging the intro");
assert.match(introContract, /acknowledgedIntroVersion/, "feature-intro contract must expose a semantic acknowledged version");
assert.match(intro, /slides\.length - 1/, "feature intro must be a bounded multi-slide experience");
assert.match(intro, /role="dialog"/, "feature intro must expose dialog semantics");
assert.match(intro, /aria-modal="true"/, "feature intro must expose modal semantics");
assert.match(intro, /ArrowRight/, "feature intro must support keyboard navigation");
assert.match(intro, /querySelectorAll<HTMLElement>/, "feature intro must keep keyboard focus inside the modal");
assert.doesNotMatch(intro, /Task · 7F3A|정본 Task|canonical Task|영수증/, "the beginner intro must not expose internal task ids, canonical language, or receipts");
assert.match(intro, /tFor\(locale, "one\.feat\.slide\.work\.title"\)/, "the intro must render its localized user-experience explanation");
assert.match(i18n, /말하면, 필요한 팀이 움직입니다|Say it once\. The right team gets moving/, "the intro must explain One through the user's experience");

assert.match(shell, /api\.oneActivation\.getState\(\{ platform: "desktop", locale: appLocale \}\)/, "One must load Desktop-first activation authority from Main in the chosen UI language");
assert.match(shell, /setPref\(appLocale === "ko" \? "en" : "ko"\)/, "One must expose a direct language switch without forcing a trip through Work settings");
assert.match(shell, /resolveActivationConcern\(chat\.id\)/, "the first concern must bind only the canonical conversation before the existing invocation path");
assert.match(shell, /taskMode:\s*"conversation"/, "activation must preserve canonical conversation-to-Task promotion");
assert.match(shell, /api\.oneActivation\.resolveWork\(/, "direct Work navigation must leave a value-free Main receipt without completing activation");
assert.match(shell, /api\.oneActivation\.skip\(/, "activation skip must be an explicit Main mutation");
assert.match(shell, /activationBlocksIntro[\s\S]*"route_ineligible"/, "first-use activation must defer the existing-user feature intro");
assert.doesNotMatch(activation, /읽기 전용|read-only|온보딩/, "first-use guidance must use everyday language");
assert.match(shell, /activationBlocked[\s\S]*actionableConfirmations[\s\S]*activeChatIds[\s\S]*selected\?\.status\.value === "failed"/, "activation must yield to live decisions, running Tasks, and errors");
assert.match(activation, /tFor\(locale, "one\.act\.title_concern"\)/, "activation must render its localized real-concern prompt");
assert.match(i18n, /지금 신경 쓰이는 일 한 가지|one thing that is on your mind/i, "activation must ask for one real concern instead of templates or platform setup");
assert.match(activation, /tFor\(locale, "one\.act\.body_concern"\)/, "activation must render the localized safe-first-look explanation");
assert.match(i18n, /먼저 살펴보기만 하고[\s\S]*시작 전에 꼭 물어봅니다|looks first and always asks before changing files or sending anything outside/i, "activation must explain its safe first look without developer language");
assert.match(activation, /tFor\(locale, "one\.act\.go_work"\)/, "activation must provide localized direct Work navigation");
assert.match(activation, /tFor\(locale, "one\.act\.skip_intro"\)/, "activation must provide a localized explicit skip");
assert.match(activation, /tFor\(locale, "one\.act\.open_mobile"\)/, "the verified first value may offer the localized real mobile settings route");
assert.match(activation, /tFor\(locale, "one\.act\.value_body"\)/, "mobile pairing optionality must be rendered from the locale catalog");
assert.match(i18n, /연결하지 않아도 One은 계속 사용할 수|keep using One without pairing/, "mobile pairing must remain optional");
assert.doesNotMatch(activation, /localStorage|sessionStorage/, "activation renderer must never own completion state");
assert.match(activationCss, /min-height:\s*44px/, "activation controls must meet the 44px accessibility target");
assert.match(activationCss, /background:\s*#0b1715/, "activation must preserve the mint-charcoal One surface");
assert.match(activationContract, /completionReason:\s*"verified_first_value" \| "explicit_skip" \| null/, "only verified first value or explicit skip may complete activation");
assert.doesNotMatch(activationContract, /(?:prompt|concernText|rawText|filePath|localPath)\??:/i, "activation state must not accept raw concern, prompt, file, or path values");
assert.match(activationRuntime, /hasPreexistingActivity/, "Main must classify first-use eligibility from durable activity");
assert.match(activationRuntime, /used_at IS NOT NULL[\s\S]*chat_messages/, "used conversations must conservatively suppress first-use activation");
assert.match(activationRuntime, /exactAcceptedClosure/, "first-value completion must verify the exact accepted Value Closure");
assert.match(activationRuntime, /state\.status !== "active" \|\| state\.concern\.status !== "resolved"/, "simple conversation state must not be promoted to activation completion");
assert.match(preload, /oneActivation:[\s\S]*getState:[\s\S]*resolveConcern:[\s\S]*resolveWork:[\s\S]*skip:[\s\S]*resolveMobile:/, "the sandbox bridge must expose only the closed activation mutations");
assert.match(ipcSource, /ensureAcceptedResultValueClosure\([\s\S]{0,1800}tryCompleteOneActivationFirstValue/, "the exact Desktop Value Closure must drive the optional first-value hook");

assert.match(productMenu, /href="\/one"/, "product switch must expose One");
assert.match(productMenu, /href="\/dashboard"/, "product switch must preserve Work");
assert.match(productMenu, /aria-haspopup="menu"/, "product switch must expose accessible menu semantics");
assert.doesNotMatch(productMenu, /개인 비서실장|Personal chief of staff/, "the One product switch must not force a persona label under the product name");
assert.match(shell, /tFor\(detectOneTextLocale\(message\.text\) === "ko" \? "ko" : "en", "one\.shell\.continuation\.body"\)/, "legacy continuation details must render through localized copy");
assert.match(i18n, /이전 결과를 참고해 이 대화에서 이어서 진행해요/, "legacy continuation details must collapse into a same-conversation sentence");

assert.match(workChat, /requestedTaskId\s*=\s*searchParams\.get\("task"\)/, "Work must preserve the requested canonical Task identity");
assert.match(workChat, /api\.tasks\.get\(requestedTaskId\)/, "Work must resolve Task deep links through Main before loading a chat");
assert.match(workChat, /originChatId\s*!==\s*queryChatId[\s\S]*router\.replace\(`\/chat\?id=/, "Work must replace a mismatched chat id with the Task's canonical origin chat");

assert.match(shellCss, /@media \(max-width: 760px\)/, "One must have a narrow responsive layout");
assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)/, "One must preserve meaning with reduced motion");
assert.match(shellCss, /min-height:\s*44px/, "primary controls must meet the 44px accessibility target");

if (process.argv.includes("--built")) {
  const exportedRoute = path.join(root, "dist/renderer/one.html");
  assert.ok(fs.existsSync(exportedRoute), "static renderer build must export dist/renderer/one.html");
  const html = fs.readFileSync(exportedRoute, "utf8");
  assert.match(html, /OneShell/, "built One route must reference the client One shell payload");
  assert.match(html, /app\/\(no-shell\)\/one\/page-/, "built One route must load its exported route chunk");
}

console.log(JSON.stringify({
  ok: true,
  route: "/one",
  contracts: [
    "canonical-task-first",
    "truthful-briefing",
    "durable-decision",
    "receipt-value-closure",
    "safe-adaptive-result",
    "full-history-reentry",
    "version-gated-intro",
    "verified-first-value-activation",
    "responsive-accessible-shell",
  ],
}, null, 2));
