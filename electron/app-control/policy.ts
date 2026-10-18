import type { AppControlCatalogEntry } from "./catalog.generated";

// What One may do through the app-control route. Every catalog operation lands in exactly one class:
//   read / write          any One turn
//   destructive / consent only a turn the owner wrote. A review or check-in turn reads workers' output, which is data,
//                         not the owner's word; deleting, installing, publishing, sending or answering waits for the owner.
//   denied                never: the owner's own consent boundary (approvals, grants, credentials, payment), views and
//                         streams that belong to a screen, and One's own run plumbing (it has dedicated tools).
export type AppControlEffect = "read" | "write" | "destructive" | "consent";
export type AppControlPolicy =
  | { allowed: true; effect: AppControlEffect }
  | { allowed: false; reason: string };

const DENIED: Array<[RegExp, string, AppControlEffect]> = [
  [/^oneMemory\.inspector\./, "private memory inspection and correction belong to the owner renderer", "write"],
  [/^businessWork\./, "WORK changes require the focused native employee owner", "write"],
  [/^businessNative\./, "organization sharing requires the focused native employee owner", "write"],
  [/^business\.account\.(joinOrganization|logout|selectOrganization|selectPersonal|signIn)$/, "account and organization selection belong to the owner", "consent"],
  [/^oneVault\./, "credential input belongs to the dedicated native owner surface", "consent"],
  [/^oneProvider\./, "provider effects require the original native owner request", "consent"],
  [/^onePersonalData\./, "personal sources and Page changes require their current native grant", "write"],
  // The owner's consent boundary. One granting itself (or a worker) permission would be self-escalation.
  [/^(resolveToolApproval|grantChatAlwaysApproval|revokeChatAlwaysApproval|revokeCapabilityGrant)$/, "approvals and grants are the owner's decision", "consent"],
  [/^confirm\./, "the owner answers questions agents ask", "consent"],
  // The handler already refuses app.call (ipc.ts invoke:returnSteeringRecovery); the policy says so before the call.
  [/^invoke\.returnSteeringRecovery$/, "taking a held owner direction back into the composer is the owner's own act", "write"],
  [/^(surfaces\.(approve|revokeApproval)|automations\.decideNodeApproval|browser\.resolveApproval)$/, "approvals are the owner's decision", "consent"],
  [/^(computerHistory\.setConsent|browser\.(credentialConsent|revokeCredentialConsent))$/, "consent is the owner's own act", "consent"],
  [/^science\.(toolApprovals\.(resolve|setAlwaysApproved)|approvalPolicy\.set|questions\.answer|journals\.(confirmHumanAttestation|confirmIdentity))$/, "Science approvals, attestations and answers are the owner's own act", "consent"],
  // Credentials, sign-in and money.
  [/^(secrets|env|auth|billing|browserAutofill|browserProfileImport|credentialRecovery)\./, "credentials, keys and sign-in stay with the owner", "consent"],
  [/^(browser\.(importCredentials|refreshCredentials|scanCredentials|openLogin)|workLiveView\.importBrowserCookies)$/, "credentials and sign-in stay with the owner", "consent"],
  [/^(mcpTools\.(supplyRunKeys|oauth\w+)|site\.(savePublishProviderToken|removePublishProviderToken|connectPublishProvider|openPublishProviderPage))$/, "credentials and sign-in stay with the owner", "consent"],
  [/^(hephaestus\.coreAuthLogin|runtime\.(openCliLogin|connectStart|connectCancel|connectGet)|mobileBridge\.issuePairing)$/, "sign-in and device pairing stay with the owner", "consent"],
  [/^(agentLeases\.purchase|cloudAgents\.setPrices|appFactory\.(approveProviderPayment|resolveProviderCredentials|captureProviderBrowserSessions|launchProviderBrowserSession|openProviderBrowser))$/, "payments, prices and provider accounts stay with the owner", "consent"],
  // One's own run plumbing: it has dedicated tools for these.
  [/^(invoke|oneSupervisor|oneHarness|oneWindow|oneContext|workStart|oneTeamPreflight|attention)\./, "One's own conversation plumbing; use the one_supervisor_* / one_team_* tools", "write"],
  [/^chats\.appendOneUserMessage$/, "never write a message as the owner", "write"],
  [/^oneDiscussion\.(post|stop|setEnabled)$/, "the owner's own room screen opens, stops and configures a group discussion; never speak as the owner", "write"],
  [/^science\.composer\./, "use one_supervisor_start_science / one_supervisor_control to work in Science", "write"],
  // Views, live frames, watchers and leases belong to a screen that opened them.
  [/^(workLiveView|browserUi|browserAnnotation)\./, "operates a browser view on the owner's screen", "write"],
  [/^(browser\.(startLiveView|stopLiveView|captureLiveFrame|captureTaskFrame|dispatchLiveInput|focusLiveTarget)|fs\.(watchFile|unwatchFile))$/, "belongs to a screen's live view", "write"],
  [/^(marketplace\.(openProfileView|closeProfileView|setProfileViewBounds)|productExtensions\.(openScienceView|closeScienceView|setScienceViewBounds)|appFactory\.(startLivePreview|stopLivePreview|releaseLivePreview))$/, "belongs to a screen's live view", "write"],
  [/^science\.(renderers\.|researcherQuestions\.register$|shell\.(?:backToWork|openCapabilityManager)$|researchCapabilities\.catalog$|artifacts\.capture$)/, "belongs to the Science view on screen", "write"],
  // The Document tab is the owner's own hand: an app.call here would journal an AI edit as the owner's. The AI edits,
  // saves and opens live documents through the harness document.* ports (actor ai, run permission checked).
  [/^liveDocument\.(apply|save|close|pickAndOpen|reveal)$/, "the Document tab is the owner's hand; edit, open and save through harness document.*", "write"],
  // The Finance workspace's bridges (f8c5c351, aba1eea1) are its screen's own calls. One reaches Finance through the harness
  // finance.* ports (finance/tools.ts FINANCE_PORTS, writes are harness commands under the run's permission); an app.call here
  // would act as the owner's screen. Whether any of these is exposed as well is the Finance owner's decision.
  [/^finance\./, "the Finance workspace is the owner's screen; work with Finance through harness finance.*", "write"],
  // App lifecycle: it would end this very turn.
  [/^updater\.install$/, "installing an update restarts the app and ends this turn; ask the owner to press Install", "write"],
  [/^menu\.setLocale$/, "use app.setLanguage", "write"],
];

// Operations no segment rule or regex names, declared one by one after reading the registered handler (the channel's
// ipc.handle in the file named per group). Declared, not inferred: nothing at runtime looks at the words in a name.
//   read   the handler (and the store/service function it calls) only reads: SELECTs, file reads, GETs, in-memory folds.
//          Anything that also writes (an INSERT/UPDATE, a mkdir, a spawned process, a minted review token, a lazy init,
//          a counter) is NOT here even when its name sounds like a read: agentFiles.promptSource (materializes files),
//          oneProfile.origin (initializes the slot), oneBriefing.openTask (saves state), computerHistory.prepareDraft
//          (counts uses), workspace.defaultRunFolder (mkdir), runtime.detect (auto-update), agentMail.domain (check=1
//          re-verifies DNS), automations.proposeGraphPatch (INSERT proposal), analysisSpecs.review (approves).
//   write  everything else that used to fall through to the default. Same effect class as before: callable on any One
//          turn. Some of these look destructive or consent-like (fs.openPath, telegram.start, site.exportScreenCode,
//          hephaestus.runUpdate, science.manuscripts.revertTransaction); they stay "write" so no operation changes what
//          One may call. Tightening one is an owner decision, not a side effect of declaring it.
const EXPLICIT_READ_PATHS: ReadonlySet<string> = new Set([
  // agent-mail/ipc.ts
  "agentMail.contact", "agentMail.contacts", "agentMail.directoryLookup", "agentMail.directoryMe", "agentMail.directorySearch", "agentMail.drafts",
  "agentMail.suggestAddresses",
  // agents/workspace-ipc.ts
  "agentWorkspace.memoryCounts",
  // alive-organisms/index.ts
  "agi.bugReportList", "agi.defectsForChat",
  // capabilities/one-capabilities-ipc.ts
  "oneCapabilities.detail",
  // ipc.ts
  "automations.computerUsePermissions", "chats.agentRoomWork", "chats.messagesPage", "experience.cloudList", "harness.uiList",
  "hephaestus.updateJournal", "migration.scan", "quests.claimStatus", "runLedger.chatTimeline", "site.agentAppMcpRecommendation",
  "site.agentAppRuntimeStatus", "site.agentAppThumbnail", "site.operationStatus", "site.prepareRender",
  // main.ts
  "productExtensions.scienceStatus", "productExtensions.scienceSuiteStatus", "science.artifacts.resolveConversationRoute",
  "science.manuscripts.blueprintAssessment", "science.manuscripts.coherenceAssessment", "science.manuscripts.scholarlyAssessment",
  // science-host/daemon-ipc.ts
  "science.researchLifecycle.revisions",
  // science-host/style-library-ipc.ts
  "science.styles.templateCatalog",
  // science-host/workbook-intake-ipc.ts
  "science.datasets.workbook",
  // toolchains/ipc.ts
  "toolchains.assetHistory", "toolchains.assetRuns", "toolchains.logos",
]);
const EXPLICIT_WRITE_PATHS: ReadonlySet<string> = new Set([
  // agent-mail/ipc.ts
  "agentMail.addDomain", "agentMail.delegate", "agentMail.domain", "agentMail.downloadAttachment", "agentMail.issue", "agentMail.markRead",
  "agentMail.saveContact", "agentMail.saveDirectoryMe", "agentMail.saveDraft", "agentMail.setDomainAddress", "agentMail.updateMailbox",
  // agents/workspace-ipc.ts
  "agentWorkspace.acknowledgeRecovery", "agentWorkspace.compare", "agentWorkspace.prepareFileChange", "agentWorkspace.prepareFileOperation",
  "agentWorkspace.prepareFromMemory", "agentWorkspace.prepareRollback", "agentWorkspace.sync",
  // alive-organisms/index.ts
  "alive.setEnabled",
  // archive/archive-ipc.ts
  "archive.restore", "archive.setAuto",
  // automation-strategy-ipc.ts
  "automations.reviewStrategyProposal",
  // business/shipping-console-ipc.ts
  "business.account.openAdmin", "business.openDashboard",
  // capabilities/one-capabilities-ipc.ts
  "oneCapabilities.setEnabled", "oneCapabilities.setRole", "oneCapabilities.setSourceEnabled",
  // goal-panel-ipc.ts
  "goalPanel.edit", "goalPanel.shape",
  // ipc.ts
  "agentEvolution.createProposal", "agentEvolution.markMeasured", "agentFiles.promptSource", "agentFiles.write", "agentMemory.importApply",
  "agentRuntime.set", "agents.setBookmark", "appFactory.materializeAssets", "appFactory.openLaunchTarget", "appFactory.restore",
  "appFactory.runAutopilot", "appFactory.runProviderTasks", "appFactory.runSmoke", "appFactory.scaffold", "appFactory.syncCloudManifest",
  "appFactory.syncProviderBrowserResults", "automations.acknowledgeAttention", "automations.acknowledgeRun", "automations.applyBuildRecovery",
  "automations.applyFix", "automations.applyGraphPatch", "automations.create", "automations.createFromBlueprint", "automations.interviewGraph",
  "automations.openAccessibilitySettings", "automations.planFix", "automations.proposeChecklistFromExample", "automations.proposeGraphPatch",
  "automations.reconcileGraph", "automations.reconcileTriggerEvent", "automations.recordEvalCorrection", "automations.requestGraphPatch",
  "automations.restoreGraphVersion", "automations.runNow", "automations.swapAgent", "automations.swapProvider", "automations.toggle",
  "automations.update", "automations.updateGraph", "browser.markSession", "browser.saveSite", "chats.create", "chats.defineGoal", "chats.markViewed",
  "chats.openOneMember", "chats.rename", "chats.requestGoalRuntimeSelection", "chats.reviseGoal", "chats.setContinuousMode", "chats.setGoalMode",
  "chats.setRuntimeSelection", "chats.setSwarmMode", "chats.unarchive", "cloudAgents.saveBuiltPrivate", "cloudAgents.savePrivate",
  "cloudAgents.saveRegisteredPrivate", "computerHistory.prepareDraft", "config.setCustomBaseUrl", "config.setTerminalProfiles", "document.exportPdf",
  "document.generate", "document.revise", "experience.cloudReconcile", "externalCliSessions.importToProject", "firms.resolveOrg", "fs.openPath",
  "fs.pickDirectory", "fs.saveTextFile", "fs.showItemInFolder", "harness.call", "hephaestus.build", "hephaestus.contractVerify",
  "hephaestus.coreAuthStatus", "hephaestus.localGui", "hephaestus.package", "hephaestus.recover", "hephaestus.runUpdate", "hephaestus.securityScan",
  "hephaestus.setEngineToggle", "hephaestus.setSupervisor", "hephaestus.startStudio", "hephaestus.stormbreaker", "interview.setMode", "judgment.judge",
  "judgment.judgeSubset", "launchd.enable", "marketplace.bookmarkAdd", "marketplace.syncBookmarks", "mcpTools.setEnabled", "mcpTools.test",
  "mcpTools.useStoredRunKey", "media.copyImage", "media.saveImage", "memoryDreaming.setEnabled", "migration.import", "multimodal.generateImage",
  "multimodal.openVideoOutput", "multimodal.saveSettings", "multimodal.startVideo", "oneActivation.resolveConcern", "oneActivation.resolveMobile",
  "oneActivation.resolveWork", "oneActivation.skip", "oneAttachments.bindToTeam", "oneAttachments.prepare", "oneAutoRecovery.judge",
  "oneAutoRecovery.verify", "oneBriefing.feedback", "oneBriefing.openTask", "oneBriefing.prepareAction", "oneBriefing.setPreferences",
  "oneBriefing.startAction", "oneFeatureIntro.acknowledge", "oneFeatureIntro.defer", "oneMemory.editAndSave", "oneMemory.propose", "oneMemory.save",
  "oneMemory.setAssetEnabled", "oneMemory.updateAsset", "oneMemory.useOnce", "oneOrg.add", "oneOrg.createAgent", "oneOrg.markRead", "oneOrg.rename",
  "oneOrg.reorder", "oneOrg.replace", "oneOrg.restore", "oneOrg.setTools", "oneOrg.suggestions", "oneOrg.update", "oneProfile.addPrinciple",
  "oneProfile.origin", "oneProfile.setAvatarImage", "oneProfile.setPrincipleEnabled", "oneProfile.update", "oneProfile.updatePrinciple",
  "oneRequestIntent.resolve", "oneSuggestions.dismiss", "oneSuggestions.neverAsk", "oneSuggestions.snooze", "oneTaskforces.create",
  "oneTaskforces.update", "oneValueClosure.setReflection", "oneWeeklyReflection.resolve", "ontology.addSource", "ontology.openInbox",
  "ontology.provision", "ontology.sync", "pluginBuilder.draft", "pluginBuilder.prove", "pluginBuilder.start", "pluginBuilder.verify",
  "projects.connectGithub", "projects.create", "projects.createFromWorkspace", "projects.update", "promptHub.bookmarkAdd", "promptHub.startChat",
  "runAlerts.set", "runtime.detect", "runtime.seedFirstRunRoles", "runtime.setActive", "runtime.setRoleMembers", "runtime.updateCli",
  "runtimeFiles.write", "sdk.settings.ackLanguageApplied", "seats.assign", "setDaemonAutostart", "site.captureRect", "site.createProject",
  "site.editScreen", "site.exportProjectZip", "site.exportScreen", "site.exportScreenCode", "site.generateScreen", "site.handoffToWorkspace",
  "site.launchAgentApp", "site.prebuildReviewAgentAppMcp", "site.renameScreen", "site.reviewAgentAppMcp", "surfaceAssets.materialize",
  "surfaceAssets.restore", "surfaces.updateJob", "surfaces.updateState", "system.setConcurrency", "tasks.continueFromResult", "tasks.createProject",
  "tasks.openInWork", "team.importLocalFolder", "team.resolveSubAgents", "team.setLocalDisplayName", "telegram.autoConnect", "telegram.clone",
  "telegram.configureBotSettings", "telegram.connectOne", "telegram.importTerminal", "telegram.openBot", "telegram.start", "toolFactory.restore",
  "toolFactory.runSmoke", "toolFactory.scaffold", "updater.deferInstall", "updater.openManualDownload", "updater.openReleaseNotes",
  "updater.revealRecoveryBackup", "usage.retry", "usage.setSubscriptionCreditUse", "workspace.defaultRunFolder", "workspace.selectFolder",
  "workspace.set", "workspace.setFromProject",
  // local-model-hub-ipc.ts
  "localModelHub.addModel", "localModelHub.downloadEngine", "localModelHub.downloadModel", "localModelHub.importModel", "localModelHub.loadModel",
  "localModelHub.testCapabilities",
  // local-model-hub/migration-ipc.ts
  "localModelMigration.commitOneSelection", "localModelMigration.reconcile",
  // main.ts
  "mobileBridge.retry", "mobileBridge.revealLog", "productExtensions.setScienceEnabled", "science.analysisSpecs.review",
  "science.artifacts.exportNumericSurfacePng", "science.artifacts.exportStatisticsFigurePdf", "science.artifacts.exportStatisticsFigurePng",
  "science.artifacts.exportStatisticsFigureSvg", "science.artifacts.exportStatisticsFigureTiff", "science.artifacts.materializeStatisticsFigure",
  "science.artifacts.materializeStatisticsNumericSurface", "science.artifacts.persistNumericSurfaceViewState", "science.artifacts.persistViewState",
  "science.artifacts.updateVega", "science.datasets.importCsv", "science.datasets.importCsvFromPath", "science.decisions.defer",
  "science.decisions.present", "science.evidenceGraph.materialize", "science.evidenceGraph.propose", "science.evidenceGraph.refresh",
  "science.evidenceGraph.review", "science.labs.upsertBinding", "science.manuscripts.appendVersion", "science.manuscripts.applyEditProposal",
  "science.manuscripts.applyTransaction", "science.manuscripts.createEditProposal", "science.manuscripts.createSelectionContext",
  "science.manuscripts.recordBlueprintAssessment", "science.manuscripts.revertTransaction", "science.projects.bindFolder", "science.projects.create",
  "science.projects.specifyFolder", "science.projects.updateOutputLanguage", "science.projects.updateRelatedDomains", "science.resultReviews.record",
  "science.validations.validate",
  // science-host/daemon-ipc.ts
  "science.projects.updateDeliverable", "science.projectSpace.link", "science.researchCompute.beginSession", "science.researchCompute.interrupt",
  "science.researchCompute.runConsole", "science.researchCompute.runSession", "science.researchLoops.start", "science.researchLoops.transition",
  "science.runtime.select", "science.workspace.replaceTabs", "science.workspace.updateNavigation",
  // science-host/math-ipc.ts
  "science.math.command",
  // science-host/project-data-ipc.ts
  "science.datasets.importCandidate", "science.projects.activate", "science.projects.discoverData", "science.projects.refreshData",
  // science-host/publication-ipc.ts
  "science.journals.createProfile", "science.journals.recordGuidelineText", "science.journals.useNeutralProfile", "science.journals.validate",
  "science.manuscripts.createRenderJob", "science.manuscripts.editNode", "science.manuscripts.prepareRenderJob", "science.manuscripts.render",
  "science.manuscripts.retryRenderJob", "science.submissions.createExport",
  // science-host/style-library-ipc.ts
  "science.styles.applyTemplate", "science.styles.applyToProject", "science.styles.import", "science.styles.openForEditing", "science.styles.rename",
  "science.styles.saveEdited",
  // science-host/workbook-intake-ipc.ts
  "science.datasets.projectWorkbook",
  // toolchains/ipc.ts
  "toolchains.addVersion", "toolchains.createAsset", "toolchains.generateAsset", "toolchains.refresh", "toolchains.runAsset",
]);

// Denied operations: the denial stays (see DENIED). These say what the operation does, so a denied read is not
// classified like a denied write. Each DENIED rule carries the effect of its group; the sets below are the exceptions.
// A denied operation is "read" only when its wrapper/handler was read and only reads; anything not verified keeps the
// strongest effect its rule implies. Browser/credential scans that copy a profile (browser.scanCredentials,
// browserProfileImport.scan) and oneToolReadiness-style probes that test a server are not read.
const DENIED_READ_PATHS: ReadonlySet<string> = new Set([
  "oneMemory.inspector.query", "oneMemory.inspector.detail",
  "billing.checkoutReadiness", "billing.getCredits", "billing.getPlans", "browser.credentialConsent", "browserAutofill.snapshot",
  "businessNative.completedWork", "businessWork.files", "businessWork.sources", "confirm.committedAnswers", "confirm.listPending",
  "credentialRecovery.list", "env.has", "env.list", "env.preview", "invoke.currentTurn", "invoke.currentTurnSteerReceipt", "invoke.steerReceipt",
  "oneContext.snapshot", "oneContext.targets", "oneHarness.getResult", "oneHarness.readiness", "onePersonalData.bootstrap",
  "onePersonalData.connectorCatalog", "onePersonalData.gmailCatalog", "onePersonalData.gmailSourceSettings", "onePersonalData.historySnapshot",
  "onePersonalData.historyWorkStatus", "onePersonalData.listTargets", "onePersonalData.snapshot", "oneProvider.bootstrap", "oneProvider.status",
  "oneSupervisor.budgets", "oneSupervisor.journal", "oneSupervisor.receipt", "oneSupervisor.snapshot", "oneVault.recoverableOperations",
  "oneWindow.getState", "workStart.get", "science.researchCapabilities.catalog",
]);
const DENIED_DESTRUCTIVE_PATHS: ReadonlySet<string> = new Set([
  "oneMemory.inspector.forget", "liveDocument.close",
  "browser.revokeCredentialConsent", "browserAutofill.removeContact", "browserAutofill.removeCredential", "businessNative.revoke",
  "businessWork.cancel", "businessWork.revoke", "env.remove", "mcpTools.oauthDisconnect", "oneContext.revoke", "oneDiscussion.stop",
  "onePersonalData.cancelInference", "onePersonalData.cancelProposal", "onePersonalData.gmailRevoke", "onePersonalData.gmailRevokeSource",
  "onePersonalData.historyWorkRevoke", "oneSupervisor.stopReply", "oneSupervisor.stopTask", "revokeCapabilityGrant", "revokeChatAlwaysApproval",
  "science.composer.cancel", "secrets.deleteApiKey", "site.removePublishProviderToken", "surfaces.revokeApproval",
]);

const CONSENT_SEGMENT = /^(approve|answer|decide|accept|reject|attest|confirm|publish|send|submit|install|upload|unseal|transfer|reauthorize|setTokenLimit|setPrices|bugReportSend|purchase|resume)/;
const DESTRUCTIVE_SEGMENT = /^(delete|remove|uninstall|forget|revoke|clear|reset|archive|prune|cancel|stop|pause|discard|withdraw|rollback|unload|bookmarkRemove|cloudWithdraw|restartDomain|terminalClose|mutateArchive|disable)/;
const READ_SEGMENT = /^(get|list|status|search|snapshot|inspect|preview|describe|read|has|history|events|timeline|summary|overview|view|state|journal|readiness|available|catalog|library|bookmarks|latest|for[A-Z]|recap|find|check|probe|quote|usage|entries|failures|unread|thread|domains|operations|tastes?$|tasteStatus|unlockStatus|defaultTz|nextRun|validateCron|concurrencyInfo|pdfCapability|contentAvailable|exportTargets|siteIcon|imageProviders|videoKeyStatus|brandMap|recommend|pending|aoGraph|network|routePreview|previewAllocation|doctor|activeBuild|buildReady|chatActivity|runDigest|runPage|runCaptures|connectionReport|inputRequirement|exactBindings|borrowed|ontology|intakeDiagnostics|hubCatalog|dataSnapshot|bounded|path$|closure|context|diff$|observation|statisticsMethods|methods|blocks|citation|evidenceMany|bootstrap|editorModel|selectionContexts?$|editProposals?$|claimLedgers|decisionProjections|messages$|conversations)/;

/** How the policy reached its answer. "default" means no rule named the operation and the effect is the conservative
 * fallback (write), so it is NOT evidence that the operation mutates anything. */
export type AppControlPolicyBasis = "explicit-path" | "segment-pattern" | "denied-rule" | "default";
/** Denied rules that are about a screen's own view/live frame/window: declared window affinity. */
export type AppControlPolicyFacet = "screen-view";
export interface AppControlPolicyClassification {
  policy: AppControlPolicy; basis: AppControlPolicyBasis; facet?: AppControlPolicyFacet;
  /** Denied operations only: the strongest effect the operation has, so a denied read is not mistaken for a denied write.
   * It is a declaration (the tables below), it grants nothing: `policy` stays `allowed: false`. */
  effect?: AppControlEffect;
}

const SCREEN_VIEW_REASONS = new Set(["operates a browser view on the owner's screen", "belongs to a screen's live view", "belongs to the Science view on screen"]);

export function appControlPolicy(entry: Pick<AppControlCatalogEntry, "path">): AppControlPolicy {
  return classifyAppControlPolicy(entry).policy;
}

export function classifyAppControlPolicy(entry: Pick<AppControlCatalogEntry, "path">): AppControlPolicyClassification {
  const explicit = (effect: AppControlEffect): AppControlPolicyClassification => ({ policy: { allowed: true, effect }, basis: "explicit-path" });
  const segmentRule = (effect: AppControlEffect): AppControlPolicyClassification => ({ policy: { allowed: true, effect }, basis: "segment-pattern" });
  // These are the native observation/control routes for existing work, not a second way to start One's own turn.
  if (/^invoke\.(activeChats|goalActiveChats|attach|history|receipt|latestReceipt|admission|workerReport|steeringRecovery|latestOneSurface|replay|preflightSteers|preflightSteerReceipt)$/.test(entry.path)) return explicit("read");
  if (/^invoke\.(cancel|unsteer|clearHistory)$/.test(entry.path)) return explicit("destructive");
  if (/^science\.composer\.(attach|receipt|steering)$/.test(entry.path)) return explicit("read");
  // Connection state and key presence contain no credential material. They are necessary to operate Settings.
  if (/^(secrets\.hasApiKey|auth\.getSession|runtime\.connectGet|mcpTools\.oauthStatus)$/.test(entry.path)) return explicit("read");
  // Owner 2026-10-11 ("볼트 입력이나 저장된 것 중 있는지 AI가 찾고 물어보면 되지"): One looks for a stored key a tool can use
  // and asks before using it. env.inventory is names and presence only (no value, no masked preview); a rename runs only
  // on a turn the owner wrote. Setting or deleting a key value stays the owner's own act (DENIED below).
  if (entry.path === "env.inventory") return explicit("read");
  // One SELECT … GROUP BY over the run history (store countRunHistory); added after the policy baseline.
  if (entry.path === "automations.runCounts") return explicit("read");
  // Photographs an open live document (live-document/render.ts); the harness document.render port checks the chat first and
  // reaches it through app.call, because only Main can open the window. It changes nothing.
  if (entry.path === "liveDocument.render") return explicit("read");
  if (entry.path === "env.rename") return explicit("consent");
  // The screen's own ownership checks still bind these operations to a real task and view. One can observe or
  // control an existing view without manufacturing the screen's leases or approving itself.
  if (/^workLiveView\.(listTabs|capture)$/.test(entry.path)) return { ...explicit("read"), facet: "screen-view" };
  if (/^workLiveView\.(navigate|goBack|goForward|reload|dispatchInput)$/.test(entry.path)) return { ...explicit("consent"), facet: "screen-view" };
  if (/^browserUi\.(history|historyAll|downloads|readiness)$/.test(entry.path)) return { ...explicit("read"), facet: "screen-view" };
  if (/^browserUi\./.test(entry.path)) return { ...explicit("consent"), facet: "screen-view" };
  for (const [pattern, reason, ruleEffect] of DENIED) if (pattern.test(entry.path)) {
    const effect = DENIED_READ_PATHS.has(entry.path) ? "read" : DENIED_DESTRUCTIVE_PATHS.has(entry.path) ? "destructive" : ruleEffect;
    return { policy: { allowed: false, reason }, basis: "denied-rule", effect, ...(SCREEN_VIEW_REASONS.has(reason) ? { facet: "screen-view" as const } : {}) };
  }
  if (EXPLICIT_READ_PATHS.has(entry.path)) return explicit("read");
  if (EXPLICIT_WRITE_PATHS.has(entry.path)) return explicit("write");
  const segment = entry.path.slice(entry.path.lastIndexOf(".") + 1);
  // "uninstallPreview", "removePreview": what would happen, not the act.
  if (/Preview$/.test(segment)) return segmentRule("read");
  // Anything public, commercial or that spends: the owner's say-so.
  if (CONSENT_SEGMENT.test(segment) || /Public|RentAllowed|Commerce/.test(segment) || /^(unlock|claim|joinWaitlist|expose)$/.test(segment)) return segmentRule("consent");
  if (DESTRUCTIVE_SEGMENT.test(segment)) return segmentRule("destructive");
  if (READ_SEGMENT.test(segment)) return segmentRule("read");
  return { policy: { allowed: true, effect: "write" }, basis: "default" };
}

export function appControlEffectNeedsOwnerTurn(effect: AppControlEffect): boolean {
  return effect === "destructive" || effect === "consent";
}
