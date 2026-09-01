import * as THREE from "../vendor/three.module.min.js";

(() => {
  "use strict";

  const root = document.getElementById("app");
  const science = window.agentlasScience;
  const i18n = window.agentlasScienceI18n;
  const RAIL_COLLAPSED_STORAGE_KEY = "agentlas.science.left-rail-collapsed.v1";
  const readRailCollapsed = () => {
    try { return window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY) === "true"; } catch { return false; }
  };
  const state = {
    locale: "en",
    projects: [], selectedId: null, lifecycle: null, conversations: [], selectedConversationId: null, messages: [], sources: [], artifacts: [], labs: [], workspaceLabBindings: [], labCatalog: [], rendererPacks: [], manuscripts: [], claimLedger: null, journalProfiles: [], submissionExports: [], analysisSpecs: [], decisions: [],
    artifactContextsByMessage: new Map(), labContextsById: new Map(), artifactHistoryById: new Map(), selectedLabId: null, selectedArtifactOriginVersion: null, inspectedArtifactVersion: null, inspectedArtifactContext: null, artifactComparison: null, draftHistoryGuard: null, labsExpanded: true, expandedLabGroups: new Set(["chemistry"]), projectMenuOpen: false, historyOpen: false, railCollapsed: readRailCollapsed(),
    blocksByMessage: new Map(), citationsByMessage: new Map(), evidenceById: new Map(), selectedSourceId: null, selectedArtifactId: null,
    evidenceGraph: null, evidenceGraphReviews: [], evidenceGraphLoading: false, evidenceGraphError: "", selectedEvidenceGraphNodeId: null, selectedEvidenceGraphCandidateId: null, evidenceGraphReviewSheet: false, evidenceGraphReviewDecision: "accepted", evidenceGraphReviewBusy: false, evidenceGraphReviewError: "", evidenceGraphPathAnchorId: null, evidenceGraphPath: null,
    mode: "session", drawer: null, modal: false, manuscriptModal: false, saving: false, loadingProject: false, projectError: "", activeVegaView: null, activeCytoscape: null, activeNumericSurface: null, activeJBrowseTarget: null, scrollByMode: { session: 0, lab: 0, manuscript: 0 }, returnMessageId: null,
    workspaceTabs: [{ id: "research", kind: "research", dirty: false }], activeWorkspaceTabId: "research", currentDestination: "overview", workspaceSyncError: "",
    activeTurn: null, composerSending: false, composerDraft: "", composerError: "", composerEventDispose: null, lifecycleChangeDispose: null,
    vegaDraft: null, vegaSaving: false, vegaSaveError: "", pendingDraftNavigation: null,
    selectedManuscriptId: null, manuscriptDraft: null, manuscriptSaving: false, manuscriptSaveError: "", manuscriptView: "write", manuscriptInspectorOpen: false, selectedJournalProfileId: null, journalValidation: null, journalSheet: false, submissionSheet: false, submissionDraft: null, journalActionBusy: false, journalActionError: "",
    artifactBindingBusy: false, artifactBindingError: "", pendingManuscriptBinding: null,
    decisionBusy: false, decisionError: "",
    researchContract: null, researchContractSheet: false, researchContractBusy: false, researchContractError: "", researchContractDismissedKey: null,
    datasetImportBusy: false, datasetImportError: "", tablePageByArtifact: new Map(), statisticsViewByArtifact: new Map(),
    statisticsLaunchSourceArtifactId: null, statisticsLaunchTimeColumn: "", statisticsLaunchEventColumn: "", statisticsLaunchBusy: false, statisticsLaunchError: "",
    figureActionBusy: false, figureActionError: "", figureActionNotice: "",
    activeRendererIdentity: null, activeRendererInstance: null, activeRendererPhase: null, activeRendererVisible: null, rendererObserver: null, rendererAbort: null, rendererStatusDispose: null, artifactChangeDispose: null, inlineVegaViews: [], inlinePreviewUrls: [], compareVegaViews: [], comparePreviewUrls: [],
  };
  let selectionEpoch = 0;
  let compareEpoch = 0;
  let workspacePersistChain = Promise.resolve();
  let workspacePersistError = null;
  let jbrowseRuntimePromise = null;
  const domainLabels = {
    general: "일반 과학", "life-science": "생명과학", chemistry: "화학", physics: "물리학",
    "materials-science": "재료과학", genomics: "유전체학", astronomy: "천문학", "earth-ecology": "지구·생태",
    statistics: "통계학", economics: "경제학", finance: "금융 연구",
  };
  const labLabels = { chemistry: "Ketcher", "molecular-structure": "Mol* Structure Viewer", "literature-network": "Citation Network", "data-visualization": "Figure Lab", "data-table": "Data Table", "statistics-analysis": "Statistical Analysis", "economic-indicators": "Economic Indicators", "physics-data": "Physics Measurements", "materials-structures": "OQMD Structures", imaging: "Imaging", "astronomy-sky": "Sky Catalog", "biodiversity-map": "Biodiversity Map", "earthquake-observations": "Earthquake Observations", "genomics-variants": "JBrowse Variants" };
  const labLabel = (labId) => labLabels[labId] || String(labId || "Lab").split(/[._-]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
  const labCapabilityLabel = (labId) => state.labCatalog.find((lab) => lab.id === labId)?.label || `${labLabel(labId)} Lab`;
  const labGroups = [
    { id: "chemistry", label: "Chemistry", icon: "beaker", labIds: ["chemistry"] },
    { id: "molecular-structure", label: "Molecular Structure", icon: "cube", labIds: ["molecular-structure"] },
    { id: "literature", label: "Literature", icon: "book", labIds: ["literature-network"] },
    { id: "data-statistics", label: "Data & Statistics", icon: "chart", labIds: ["statistics-analysis", "data-visualization", "data-table"] },
    { id: "economics-finance", label: "Economics & Finance", icon: "chart", labIds: ["economic-indicators"] },
    { id: "physics", label: "Physics", icon: "chart", labIds: ["physics-data"] },
    { id: "imaging", label: "Imaging", icon: "photo", labIds: ["imaging"] },
    { id: "astronomy", label: "Astronomy", icon: "globe", labIds: ["astronomy-sky"] },
    { id: "earth-ecology", label: "Earth & Ecology", icon: "globe", labIds: ["earthquake-observations", "biodiversity-map"] },
    { id: "genomics", label: "Genomics", icon: "table", labIds: ["genomics-variants"] },
    { id: "materials", label: "Materials", icon: "cube", labIds: ["materials-structures"] },
  ];
  const labIcons = { chemistry: "beaker", "molecular-structure": "cube", "literature-network": "book", "data-visualization": "chart", "data-table": "table", "statistics-analysis": "chart", "economic-indicators": "chart", "physics-data": "chart", "materials-structures": "cube", imaging: "photo", "astronomy-sky": "globe", "biodiversity-map": "globe", "earthquake-observations": "globe", "genomics-variants": "table" };
  const projectDestinationGroups = [
    { label: "Project", items: [
      { id: "overview", label: "Overview", icon: "grid" },
      { id: "logbook", label: "Logbook", icon: "book" },
    ] },
    { label: "Research", items: [
      { id: "scope", label: "Scope", icon: "grid" },
      { id: "literature", label: "Literature & Prior Evidence", icon: "book" },
      { id: "hypotheses", label: "Hypotheses", icon: "sparkles" },
      { id: "plan-protocols", label: "Plan & Protocols", icon: "table" },
      { id: "acquisition", label: "Acquisition", icon: "arrow-down-tray" },
      { id: "analysis-runs", label: "Analysis & Runs", icon: "chart" },
      { id: "interpretation", label: "Interpretation & Decisions", icon: "chart" },
    ] },
    { label: "Outputs", items: [
      { id: "results", label: "Results & Figures", icon: "photo" },
      { id: "manuscript", label: "Manuscript", icon: "book" },
      { id: "submission-archive", label: "Submission & Archive", icon: "arrow-down-tray" },
    ] },
  ];
  const projectDestinationIds = new Set(projectDestinationGroups.flatMap((group) => group.items.map((item) => item.id)));
  const projectDestinationById = (id) => projectDestinationGroups.flatMap((group) => group.items).find((item) => item.id === id) || projectDestinationGroups[0].items[0];
  const RESEARCH_TAB_ID = "research";
  const workspaceTabDomId = (tabId) => `science-workspace-tab-${String(tabId || RESEARCH_TAB_ID).replace(/[^A-Za-z0-9_-]/g, "-")}`;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const heroIcon = (name, className = "uiIcon") => `<svg class="${escapeHtml(className)}" aria-hidden="true" viewBox="0 0 24 24"><use href="./icons/heroicons-outline.svg#${escapeHtml(name)}"></use></svg>`;
  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(state.locale === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "short", day: "numeric" }).format(date);
  };
  const sourceById = (id) => state.sources.find((source) => source.id === id) || null;
  const citationById = (id) => [...state.citationsByMessage.values()].flat().find((citation) => citation.id === id) || null;
  const selectedProject = () => state.projects.find((item) => item.id === state.selectedId) || state.projects[0] || null;
  const selectedConversation = () => state.conversations.find((item) => item.id === state.selectedConversationId) || state.conversations[0] || null;
  const evidenceGraphNodeById = (id) => state.evidenceGraph?.nodes?.find((node) => node.id === id) || null;
  const evidenceGraphCandidateById = (id) => state.evidenceGraph?.inferenceCandidates?.find((candidate) => candidate.id === id) || null;
  const evidenceGraphReviewForCandidate = (candidate) => {
    if (!candidate) return null;
    return state.evidenceGraphReviews
      .filter((review) => review.candidateId === candidate.id && review.candidateContentSha256 === candidate.contentSha256)
      .sort((left, right) => right.revision - left.revision)[0] || null;
  };
  const evidenceGraphCandidateStatus = (candidate) => evidenceGraphReviewForCandidate(candidate)?.decision || "pending";
  const evidenceGraphShortHash = (value) => value ? `${String(value).slice(0, 12)}…` : "—";
  const evidenceGraphStatusLabel = (status) => ({
    supported: "Supported", contradicted: "Contradicted", mixed: "Mixed", inconclusive: "Inconclusive", invalidated: "Invalidated", candidate: "Candidate",
  }[status] || String(status || "Unknown"));
  const evidenceGraphKindLabel = (kind) => String(kind || "node").split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
  const researchContractKey = (contract) => contract?.id && Number.isSafeInteger(contract?.version) ? `${contract.id}:v${contract.version}` : null;
  function applyResearchContractSnapshot(project, contract, { openDraft = true } = {}) {
    if (project?.id) state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)];
    state.researchContract = contract || null;
    const isDraft = contract?.projectId === state.selectedId && contract?.status === "draft";
    const key = researchContractKey(contract);
    if (!isDraft) {
      state.researchContractSheet = false;
      state.researchContractError = "";
      return;
    }
    if (openDraft && key !== state.researchContractDismissedKey) state.researchContractSheet = true;
  }
  const lifecyclePhaseLabels = {
    intake: "Intake", literature: "Literature", hypothesis: "Hypothesis", analysis_plan_draft: "Analysis plan",
    analysis_plan_frozen: "Plan frozen", execution: "Execution", evidence_reconciliation: "Evidence", conclusions: "Conclusions",
    manuscript: "Manuscript", journal_profile: "Journal profile", submission_validation: "Submission validation",
    ready_to_submit: "Ready to submit", blocked: "Blocked", stopped: "Stopped", failed: "Failed",
  };
  const lifecycleLabel = () => state.lifecycle
    ? `${lifecyclePhaseLabels[state.lifecycle.phase] || state.lifecycle.phase} · ${state.lifecycle.status} · r${state.lifecycle.revision}`
    : "Lifecycle unavailable";
  const lifecycleCompactLabel = () => state.lifecycle
    ? `${lifecyclePhaseLabels[state.lifecycle.phase] || state.lifecycle.phase} · r${state.lifecycle.revision}`
    : "Lifecycle";
  const lifecycleBindsExport = (submissionExport) => Boolean(submissionExport && state.lifecycle?.phase === "ready_to_submit"
    && state.lifecycle?.status === "complete"
    && state.lifecycle?.submissionExport?.submissionExportId === submissionExport.id
    && state.lifecycle?.submissionExport?.packageSha256 === submissionExport.packageSha256);
  const claimLedgerIsCurrent = (manuscript, draft = state.manuscriptDraft) => Boolean(
    manuscript && draft && !draft.dirty && state.claimLedger?.gate?.ready === true
    && state.claimLedger?.manifest?.manuscript?.manuscriptId === manuscript.id
    && state.claimLedger?.manifest?.manuscript?.version === manuscript.currentVersion
    && state.claimLedger?.manifest?.manuscript?.contentSha256 === manuscript.version.contentSha256
    && state.claimLedger?.gate?.ledgerManifestSha256 === state.claimLedger?.manifest?.manifestSha256
    && state.claimLedger?.gate?.ledgerRevision === state.claimLedger?.manifest?.revision
  );
  const claimLedgerBindingState = (manuscript) => !state.claimLedger
    ? "missing"
    : state.claimLedger?.manifest?.manuscript?.manuscriptId !== manuscript?.id
      || state.claimLedger?.manifest?.manuscript?.version !== manuscript?.currentVersion
      || state.claimLedger?.manifest?.manuscript?.contentSha256 !== manuscript?.version?.contentSha256
      ? "stale"
      : state.claimLedger?.gate?.ready === true ? "ready" : "blocked";
  const presentedLifecycleDecision = () => {
    const lifecycle = state.lifecycle;
    const decisionRequired = lifecycle?.status === "waiting_for_decision"
      || (lifecycle?.status === "blocked" && lifecycle?.stop?.code === "decision_required");
    if (!decisionRequired || !Array.isArray(lifecycle?.openBlockingDecisions)) return null;
    const presented = state.decisions.filter((decision) => decision?.status === "presented" && typeof decision?.proposalSha256 === "string");
    if (presented.length !== 1) return null;
    const decision = presented[0];
    const bindings = lifecycle.openBlockingDecisions.filter((candidate) => candidate.id === decision.id && candidate.contentSha256 === decision.proposalSha256);
    return bindings.length === 1 ? decision : null;
  };
  const manuscriptById = (id) => state.manuscripts.find((manuscript) => manuscript.id === id) || null;
  const journalProfileById = (id) => state.journalProfiles.find((profile) => profile.id === id) || null;
  const analysisSpecById = (id) => state.analysisSpecs.find((analysisSpec) => analysisSpec.id === id) || null;
  const statisticsMethodLabels = {
    distribution_fit: "Probability distribution fitting",
    kaplan_meier: "Kaplan–Meier survival",
    welch_one_way_anova: "Welch one-way ANOVA",
    friedman_test: "Friedman test",
    roc_curve_analysis: "ROC / precision–recall analysis",
  };
  const statisticsMethodLabel = (method) => statisticsMethodLabels[String(method || "")] || String(method || "Statistical analysis").replaceAll("_", " ");
  const isStatisticsProjectionReceipt = (receipt) => Boolean(receipt && [
    "agentlas.science.statistics.data-table-projection-receipt/v1",
    "agentlas.science.statistics.data-table-projection-receipt/v2",
  ].includes(receipt.schema));
  function statisticsProjectionColumnPairs(receipt) {
    if (!isStatisticsProjectionReceipt(receipt)) return [];
    if (receipt.schema === "agentlas.science.statistics.data-table-projection-receipt/v1") return [
      ["time", receipt.timeColumn],
      ["event", receipt.eventColumn],
    ];
    const columns = receipt.columns || {};
    if (receipt.method === "welch_one_way_anova") return [["group", columns.groupColumn], ["value", columns.valueColumn]];
    if (receipt.method === "friedman_test") return [["block", columns.blockColumn], ["condition", columns.conditionColumn], ["value", columns.valueColumn]];
    if (receipt.method === "roc_curve_analysis") return [["outcome", columns.outcomeColumn], ["score", columns.scoreColumn], ...(columns.observationLabelColumn ? [["label", columns.observationLabelColumn]] : [])];
    return [];
  }
  const statisticsProjectionMappingLabel = (receipt) => statisticsProjectionColumnPairs(receipt)
    .map(([role, column]) => `${role} → ${column}`)
    .join(" · ");
  const statisticsShortHash = (value, length = 12) => value ? `${String(value).slice(0, length)}…` : "—";
  function statisticsProjectionLineageMarkup(receipt, runId, artifactId, artifactVersion, artifactSha256) {
    if (!isStatisticsProjectionReceipt(receipt)) return "";
    const method = receipt.schema.endsWith("/v2") ? statisticsMethodLabel(receipt.method) : "Kaplan–Meier survival";
    const mapping = statisticsProjectionMappingLabel(receipt);
    return `<section class="statisticsLineage" data-statistics-lineage data-projection-schema="${escapeHtml(receipt.schema)}" data-source-artifact-id="${escapeHtml(receipt.sourceArtifact.artifactId)}" data-source-artifact-version="${escapeHtml(receipt.sourceArtifact.artifactVersion)}" data-source-artifact-sha256="${escapeHtml(receipt.sourceArtifact.contentSha256)}" data-projection-receipt-sha256="${escapeHtml(receipt.receiptSha256)}" data-run-id="${escapeHtml(runId)}" data-output-artifact-id="${escapeHtml(artifactId)}" data-output-artifact-version="${escapeHtml(artifactVersion)}" data-output-artifact-sha256="${escapeHtml(artifactSha256)}"><span>Source table <code title="${escapeHtml(receipt.sourceArtifact.artifactId)}">${escapeHtml(statisticsShortHash(receipt.sourceArtifact.artifactId))}</code> · v${escapeHtml(receipt.sourceArtifact.artifactVersion)}</span><i aria-hidden="true">→</i><span>${escapeHtml(method)} · ${escapeHtml(mapping)} · ${escapeHtml(receipt.includedRowCount)} rows</span><i aria-hidden="true">→</i><span>Projection <code title="${escapeHtml(receipt.receiptSha256)}">${escapeHtml(statisticsShortHash(receipt.receiptSha256))}</code></span><i aria-hidden="true">→</i><span>Run <code title="${escapeHtml(runId)}">${escapeHtml(statisticsShortHash(runId))}</code></span></section>`;
  }
  const artifactForLab = (labId, artifactId) => (state.labContextsById.get(labId) || []).map((context) => context.artifact).find((artifact) => artifact.id === artifactId) || null;
  const labForArtifact = (artifactId) => [...state.labContextsById.entries()].find(([, contexts]) => contexts.some((context) => context.artifact.id === artifactId))?.[0] || null;
  const statisticsSourceTables = () => (state.labContextsById.get("data-table") || [])
    .map((context) => context.artifact)
    .filter((artifact) => artifact?.kind === "table" && artifact.version?.payload?.schema === "agentlas.science-table/v1");
  const statisticsSourceTable = () => {
    const tables = statisticsSourceTables();
    return tables.find((artifact) => artifact.id === state.statisticsLaunchSourceArtifactId) || tables[0] || null;
  };
  const statisticsEligibleColumns = (artifact) => Array.isArray(artifact?.version?.payload?.columns)
    ? artifact.version.payload.columns.filter((column) => column && typeof column.name === "string" && column.name.length > 0
      && column.name.length <= 160 && ["integer", "number"].includes(column.logicalType))
    : [];
  function normalizeStatisticsLaunchSelection() {
    const artifact = statisticsSourceTable();
    state.statisticsLaunchSourceArtifactId = artifact?.id || null;
    const columns = statisticsEligibleColumns(artifact);
    const names = new Set(columns.map((column) => column.name));
    if (!names.has(state.statisticsLaunchTimeColumn)) state.statisticsLaunchTimeColumn = columns.find((column) => ["integer", "number"].includes(column.logicalType))?.name || "";
    if (!names.has(state.statisticsLaunchEventColumn) || state.statisticsLaunchEventColumn === state.statisticsLaunchTimeColumn) {
      state.statisticsLaunchEventColumn = columns.find((column) => column.name !== state.statisticsLaunchTimeColumn)?.name || "";
    }
  }
  const artifactWorkspaceTabId = (artifactId, version) => `artifact:${artifactId}:v${version}`;
  const labWorkspaceTabId = (labId) => `lab:${labId}`;
  const manuscriptWorkspaceTabId = (manuscriptId) => `manuscript:${manuscriptId}`;

  function versionBindingForWorkspaceTab(tab) {
    if (Number.isSafeInteger(tab.exactVersion) && /^[a-f0-9]{64}$/.test(String(tab.exactContentSha256 || ""))) {
      return { exactVersion: tab.exactVersion, exactContentSha256: tab.exactContentSha256 };
    }
    if (tab.kind === "artifact") {
      const artifact = artifactForLab(tab.labId, tab.artifactId);
      if (artifact?.currentVersion === tab.exactVersion && /^[a-f0-9]{64}$/.test(String(artifact.version?.contentSha256 || ""))) {
        return { exactVersion: tab.exactVersion, exactContentSha256: artifact.version.contentSha256 };
      }
      const history = state.artifactHistoryById.get(tab.artifactId);
      const entry = history?.entries?.find((item) => item.version === tab.exactVersion);
      if (entry && /^[a-f0-9]{64}$/.test(String(entry.contentSha256 || ""))) {
        return { exactVersion: tab.exactVersion, exactContentSha256: entry.contentSha256 };
      }
    }
    if (tab.kind === "manuscript") {
      const manuscript = manuscriptById(tab.manuscriptId);
      if (manuscript?.currentVersion === tab.exactVersion && /^[a-f0-9]{64}$/.test(String(manuscript.version?.contentSha256 || ""))) {
        return { exactVersion: tab.exactVersion, exactContentSha256: manuscript.version.contentSha256 };
      }
    }
    return { exactVersion: null, exactContentSha256: null };
  }

  function workspaceTabsPayload() {
    return state.workspaceTabs.map((tab, displayOrder) => {
      const version = versionBindingForWorkspaceTab(tab);
      return {
        id: tab.id,
        kind: tab.kind,
        targetId: tab.kind === "research" ? null
          : tab.kind === "conversation" ? tab.conversationId
            : tab.kind === "lab" ? tab.labId
              : tab.kind === "artifact" ? tab.artifactId
                : tab.manuscriptId,
        ...version,
        dirty: Boolean(tab.dirty),
        selected: tab.id === state.activeWorkspaceTabId,
        displayOrder,
      };
    });
  }

  function queueWorkspacePersistence({ navigation = true, tabs = true } = {}) {
    const projectId = state.selectedId;
    if (!projectId || !science.workspace) return Promise.resolve();
    const navigationInput = {
      projectId,
      destination: projectDestinationIds.has(state.currentDestination) ? state.currentDestination : "overview",
      selectedConversationId: selectedConversation()?.id || null,
      selectedLabId: state.workspaceLabBindings.some((binding) => binding.enabled && binding.labId === state.selectedLabId) ? state.selectedLabId : null,
    };
    const tabsInput = { projectId, tabs: workspaceTabsPayload() };
    const write = workspacePersistChain.then(async () => {
      const results = await Promise.all([
        navigation ? science.workspace.updateNavigation(navigationInput) : null,
        tabs ? science.workspace.replaceTabs(tabsInput) : null,
      ]);
      workspacePersistError = null;
      if (state.selectedId === projectId) state.workspaceSyncError = "";
      return results;
    });
    workspacePersistChain = write.catch(() => undefined);
    write.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      workspacePersistError = { projectId, message };
      if (state.selectedId === projectId) {
        state.workspaceSyncError = message;
        render();
      }
    });
    return write;
  }

  function setActiveWorkspaceTabDirty(dirty) {
    const tab = state.workspaceTabs.find((item) => item.id === state.activeWorkspaceTabId);
    if (!tab || tab.kind === "research" || tab.dirty === Boolean(dirty)) return;
    tab.dirty = Boolean(dirty);
    void queueWorkspacePersistence({ navigation: false, tabs: true });
  }

  function localWorkspaceTab(stored) {
    if (!stored || typeof stored !== "object") return null;
    if (stored.kind === "research") return { id: stored.id, kind: "research", dirty: Boolean(stored.dirty) };
    if (stored.kind === "conversation") {
      const conversation = state.conversations.find((item) => item.id === stored.targetId);
      return conversation ? { id: stored.id, kind: "conversation", conversationId: conversation.id, title: conversation.title || "Research conversation", dirty: Boolean(stored.dirty) } : null;
    }
    if (stored.kind === "lab") {
      if (!state.workspaceLabBindings.some((binding) => binding.enabled && binding.labId === stored.targetId)) return null;
      return { id: stored.id, kind: "lab", labId: stored.targetId, title: labLabel(stored.targetId), dirty: Boolean(stored.dirty) };
    }
    if (stored.kind === "artifact") {
      const artifact = state.artifacts.find((item) => item.id === stored.targetId);
      const labId = artifact ? labForArtifact(artifact.id) : null;
      if (!artifact || !labId) return null;
      return { id: stored.id, kind: "artifact", labId, artifactId: artifact.id, exactVersion: stored.exactVersion || artifact.currentVersion, exactContentSha256: stored.exactContentSha256 || artifact.version?.contentSha256 || null, title: artifact.title, originVersion: null, returnMessageId: null, dirty: Boolean(stored.dirty) };
    }
    if (stored.kind === "manuscript") {
      const manuscript = manuscriptById(stored.targetId);
      return manuscript ? { id: stored.id, kind: "manuscript", manuscriptId: manuscript.id, title: manuscript.title, exactVersion: stored.exactVersion || manuscript.currentVersion, exactContentSha256: stored.exactContentSha256 || manuscript.version?.contentSha256 || null, dirty: Boolean(stored.dirty) } : null;
    }
    return null;
  }

  function restoreWorkspaceState(workspaceState) {
    const navigation = workspaceState?.navigation || {};
    state.currentDestination = projectDestinationIds.has(navigation.destination) ? navigation.destination : "overview";
    state.selectedConversationId = state.conversations.some((item) => item.id === navigation.selectedConversationId) ? navigation.selectedConversationId : state.conversations[0]?.id || null;
    state.selectedLabId = state.workspaceLabBindings.some((binding) => binding.enabled && binding.labId === navigation.selectedLabId) ? navigation.selectedLabId : state.labs[0]?.labId || null;
    const restored = Array.isArray(workspaceState?.tabs) ? workspaceState.tabs.map(localWorkspaceTab).filter(Boolean) : [];
    state.workspaceTabs = restored.some((tab) => tab.kind === "research") ? restored : [{ id: RESEARCH_TAB_ID, kind: "research", dirty: false }, ...restored];
    const selectedStored = Array.isArray(workspaceState?.tabs) ? workspaceState.tabs.find((tab) => tab.selected) : null;
    const active = state.workspaceTabs.find((tab) => tab.id === selectedStored?.id) || state.workspaceTabs.find((tab) => tab.kind === "research") || state.workspaceTabs[0];
    state.activeWorkspaceTabId = active.id;
    if (active.kind === "conversation") {
      state.selectedConversationId = active.conversationId;
      state.mode = "session";
    } else if (active.kind === "lab") {
      state.selectedLabId = active.labId;
      state.selectedArtifactId = null;
      state.mode = "lab";
    } else if (active.kind === "artifact") {
      state.selectedLabId = active.labId;
      state.selectedArtifactId = active.artifactId;
      state.mode = "lab";
    } else if (active.kind === "manuscript") {
      const manuscript = manuscriptById(active.manuscriptId);
      state.selectedManuscriptId = manuscript?.id || null;
      state.manuscriptDraft = manuscript ? manuscriptDraftFrom(manuscript) : null;
      state.mode = manuscript ? "manuscript" : "session";
    } else {
      state.mode = "session";
    }
  }

  function resetWorkspaceTabs() {
    state.workspaceTabs = [{ id: RESEARCH_TAB_ID, kind: "research", dirty: false }];
    state.activeWorkspaceTabId = RESEARCH_TAB_ID;
  }

  function ensureArtifactWorkspaceTab(labId, artifactId, exactVersion, originVersion = null, returnMessageId = null) {
    const artifact = artifactForLab(labId, artifactId);
    const version = Number.isSafeInteger(exactVersion) && exactVersion > 0 ? exactVersion : artifact?.currentVersion;
    if (!artifact || !Number.isSafeInteger(version) || version < 1) return null;
    const id = artifactWorkspaceTabId(artifact.id, version);
    const existing = state.workspaceTabs.find((tab) => tab.id === id);
    if (existing) {
      existing.labId = labId;
      existing.title = artifact.title;
      existing.originVersion = Number.isSafeInteger(originVersion) ? originVersion : existing.originVersion;
      existing.returnMessageId = returnMessageId || existing.returnMessageId;
      existing.exactVersion = version;
      if (version === artifact.currentVersion) existing.exactContentSha256 = artifact.version?.contentSha256 || existing.exactContentSha256 || null;
    } else {
      state.workspaceTabs.push({ id, kind: "artifact", labId, artifactId: artifact.id, exactVersion: version, exactContentSha256: version === artifact.currentVersion ? artifact.version?.contentSha256 || null : null, title: artifact.title, originVersion: Number.isSafeInteger(originVersion) ? originVersion : null, returnMessageId, dirty: false });
    }
    state.activeWorkspaceTabId = id;
    return id;
  }

  function ensureLabWorkspaceTab(labId) {
    const id = labWorkspaceTabId(labId);
    const existing = state.workspaceTabs.find((tab) => tab.id === id);
    if (!existing) state.workspaceTabs.push({ id, kind: "lab", labId, title: labLabel(labId), dirty: false });
    state.activeWorkspaceTabId = id;
    return id;
  }

  function ensureManuscriptWorkspaceTab(manuscript) {
    if (!manuscript) return null;
    const id = manuscriptWorkspaceTabId(manuscript.id);
    const existing = state.workspaceTabs.find((tab) => tab.id === id);
    if (existing) {
      existing.title = manuscript.title;
      existing.exactVersion = manuscript.currentVersion;
      existing.exactContentSha256 = manuscript.version?.contentSha256 || null;
      existing.dirty = Boolean(state.manuscriptDraft?.manuscriptId === manuscript.id && state.manuscriptDraft.dirty);
    } else {
      state.workspaceTabs.push({ id, kind: "manuscript", manuscriptId: manuscript.id, title: manuscript.title, exactVersion: manuscript.currentVersion, exactContentSha256: manuscript.version?.contentSha256 || null, dirty: Boolean(state.manuscriptDraft?.manuscriptId === manuscript.id && state.manuscriptDraft.dirty) });
    }
    state.activeWorkspaceTabId = id;
    return id;
  }

  async function loadMessageEvidence(projectId, messages) {
    const evidence = await Promise.all(messages.map(async (message) => {
      const [blocks, citations] = await Promise.all([science.messages.blocks(projectId, message.id), science.messages.citations(projectId, message.id)]);
      const safeCitations = Array.isArray(citations) ? citations : [];
      const spans = await Promise.all(safeCitations.map((citation) => science.evidence.get(projectId, citation.evidenceSpanId)));
      return { messageId: message.id, blocks: Array.isArray(blocks) ? blocks : [], citations: safeCitations, spans: spans.filter(Boolean) };
    }));
    return {
      blocks: new Map(evidence.map((entry) => [entry.messageId, entry.blocks])),
      citations: new Map(evidence.map((entry) => [entry.messageId, entry.citations])),
      spans: new Map(evidence.flatMap((entry) => entry.spans).map((span) => [span.id, span])),
    };
  }

  async function refreshConversationOnly(projectId) {
    const conversation = selectedConversation();
    if (!conversation || projectId !== state.selectedId) return;
    const messages = await science.conversations.messages(projectId, conversation.id);
    const safeMessages = Array.isArray(messages) ? messages : [];
    const [messageEvidence, messageArtifactRows, attached, manuscripts, journalProfiles, analysisSpecs, decisions, lifecycle, project, researchContract, graphSnapshot] = await Promise.all([
      loadMessageEvidence(projectId, safeMessages),
      Promise.all(safeMessages.map(async (message) => [message.id, await science.artifacts.forMessage(projectId, message.conversationId, message.id)])),
      science.composer.attach({ projectId, conversationId: conversation.id }),
      science.manuscripts.list(projectId),
      science.journals.list(projectId),
      science.analysisSpecs.list(projectId),
      science.decisions.list(projectId, undefined, ["presented"]),
      science.researchLifecycle.get(projectId),
      science.projects.get(projectId),
      science.researchContracts.get(projectId),
      science.evidenceGraph.get(projectId).catch((error) => ({ graph: null, reviews: [], error: error instanceof Error ? error.message : String(error) })),
    ]);
    if (projectId !== state.selectedId || conversation.id !== selectedConversation()?.id) return;
    state.messages = safeMessages;
    state.artifactContextsByMessage = new Map(messageArtifactRows.map(([messageId, contexts]) => [messageId, Array.isArray(contexts) ? contexts : []]));
    state.blocksByMessage = messageEvidence.blocks;
    state.citationsByMessage = messageEvidence.citations;
    state.evidenceById = messageEvidence.spans;
    state.activeTurn = attached?.turn || state.activeTurn;
    state.manuscripts = Array.isArray(manuscripts) ? manuscripts : state.manuscripts;
    state.journalProfiles = Array.isArray(journalProfiles) ? journalProfiles : state.journalProfiles;
    state.analysisSpecs = Array.isArray(analysisSpecs) ? analysisSpecs : state.analysisSpecs;
    state.decisions = Array.isArray(decisions) ? decisions : state.decisions;
    state.lifecycle = lifecycle;
    state.evidenceGraph = graphSnapshot?.graph || null;
    state.evidenceGraphReviews = Array.isArray(graphSnapshot?.reviews) ? graphSnapshot.reviews : [];
    state.evidenceGraphError = graphSnapshot?.error || "";
    applyResearchContractSnapshot(project, researchContract);
    if (!journalProfileById(state.selectedJournalProfileId)) state.selectedJournalProfileId = state.journalProfiles[0]?.id || null;
    for (const tab of state.workspaceTabs.filter((item) => item.kind === "manuscript")) {
      const manuscript = manuscriptById(tab.manuscriptId);
      if (manuscript) { tab.title = manuscript.title; tab.exactVersion = manuscript.currentVersion; tab.exactContentSha256 = manuscript.version?.contentSha256 || null; }
    }
    if (state.researchContractSheet) { render(); return; }
    renderWorkspaceTabs();
    renderChatDock();
  }

  async function selectProject(projectId, options = {}) {
    const switchingProject = state.selectedId !== projectId;
    const priorProjectId = state.selectedId;
    if (switchingProject && priorProjectId) {
      try {
        await queueWorkspacePersistence();
      } catch (error) {
        if (state.selectedId !== priorProjectId) return;
        state.projectError = `프로젝트 작업공간을 저장하지 못해 전환을 중단했습니다. ${error instanceof Error ? error.message : String(error)}`;
        render();
        return;
      }
      if (state.selectedId !== priorProjectId) return;
    }
    const epoch = ++selectionEpoch;
    const preservedWorkspace = options.preserveWorkspace && state.selectedId === projectId ? {
      tabs: state.workspaceTabs.map((tab) => ({ ...tab })),
      activeTabId: state.activeWorkspaceTabId,
      mode: state.mode,
      currentDestination: state.currentDestination,
      selectedConversationId: state.selectedConversationId,
      selectedLabId: state.selectedLabId,
      selectedArtifactId: state.selectedArtifactId,
      selectedArtifactOriginVersion: state.selectedArtifactOriginVersion,
      inspectedArtifactVersion: state.inspectedArtifactVersion,
      inspectedArtifactContext: state.inspectedArtifactContext,
      artifactHistoryById: new Map(state.artifactHistoryById),
      returnMessageId: state.returnMessageId,
      selectedManuscriptId: state.selectedManuscriptId,
      manuscriptDraft: state.manuscriptDraft ? { ...state.manuscriptDraft, bindings: state.manuscriptDraft.bindings.map((binding) => ({ ...binding, target: { ...binding.target } })) } : null,
      manuscriptView: state.manuscriptView,
      selectedJournalProfileId: state.selectedJournalProfileId,
    } : null;
    state.selectedId = projectId;
    state.lifecycle = null;
    state.mode = "session";
    if (!preservedWorkspace) resetWorkspaceTabs();
    state.conversations = [];
    state.selectedConversationId = null;
    state.messages = [];
    state.sources = [];
    state.artifacts = [];
    state.labs = [];
    state.workspaceLabBindings = [];
    state.manuscripts = [];
    state.claimLedger = null;
    state.journalProfiles = [];
    state.submissionExports = [];
    state.analysisSpecs = [];
    state.decisions = [];
    state.artifactContextsByMessage = new Map();
    state.labContextsById = new Map();
    state.artifactHistoryById = new Map();
    state.selectedLabId = null;
    state.selectedArtifactOriginVersion = null;
    state.inspectedArtifactVersion = null;
    state.inspectedArtifactContext = null;
    state.artifactComparison = null;
    state.draftHistoryGuard = null;
    state.vegaDraft = null;
    state.vegaSaving = false;
    state.vegaSaveError = "";
    state.pendingDraftNavigation = null;
    state.blocksByMessage = new Map();
    state.citationsByMessage = new Map();
    state.evidenceById = new Map();
    state.selectedSourceId = null;
    state.selectedArtifactId = null;
    state.evidenceGraph = null;
    state.evidenceGraphReviews = [];
    state.evidenceGraphLoading = false;
    state.evidenceGraphError = "";
    state.selectedEvidenceGraphNodeId = null;
    state.selectedEvidenceGraphCandidateId = null;
    state.evidenceGraphReviewSheet = false;
    state.evidenceGraphReviewDecision = "accepted";
    state.evidenceGraphReviewBusy = false;
    state.evidenceGraphReviewError = "";
    state.evidenceGraphPathAnchorId = null;
    state.evidenceGraphPath = null;
    state.returnMessageId = null;
    state.drawer = null;
    state.projectError = "";
    state.workspaceSyncError = "";
    state.activeTurn = null;
    state.composerSending = false;
    state.composerError = "";
    state.selectedManuscriptId = null;
    state.manuscriptDraft = null;
    state.manuscriptSaving = false;
    state.manuscriptSaveError = "";
    state.manuscriptView = "write";
    state.manuscriptInspectorOpen = false;
    state.selectedJournalProfileId = null;
    state.journalValidation = null;
    state.journalSheet = false;
    state.submissionSheet = false;
    state.submissionDraft = null;
    state.journalActionBusy = false;
    state.journalActionError = "";
    state.decisionBusy = false;
    state.decisionError = "";
    state.researchContract = null;
    state.researchContractSheet = false;
    state.researchContractBusy = false;
    state.researchContractError = "";
    if (switchingProject) state.researchContractDismissedKey = null;
    state.loadingProject = true;
    if (!preservedWorkspace) render();
    try {
      const [workspaceState, conversations, sources, artifacts, labs, capabilityCatalog, rendererPacks, manuscripts, journalProfiles, analysisSpecs, decisions, lifecycle, project, researchContract, graphSnapshot] = await Promise.all([
        science.workspace.get(projectId), science.conversations.list(projectId), science.sources.list(projectId), science.artifacts.list(projectId), science.labs.list(projectId), science.labs.catalog(), science.rendererPacks.list(), science.manuscripts.list(projectId), science.journals.list(projectId), science.analysisSpecs.list(projectId), science.decisions.list(projectId, undefined, ["presented"]), science.researchLifecycle.get(projectId), science.projects.get(projectId), science.researchContracts.get(projectId), science.evidenceGraph.get(projectId).catch((error) => ({ graph: null, reviews: [], error: error instanceof Error ? error.message : String(error) })),
      ]);
      if (epoch !== selectionEpoch) return;
      const safeConversations = Array.isArray(conversations) ? conversations : [];
      const safeSources = Array.isArray(sources) ? sources : [];
      const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
      const safeLabs = Array.isArray(labs) ? labs : [];
      const safeManuscripts = Array.isArray(manuscripts) ? manuscripts : [];
      const safeJournalProfiles = Array.isArray(journalProfiles) ? journalProfiles : [];
      const selectedConversationTab = Array.isArray(workspaceState?.tabs) ? workspaceState.tabs.find((tab) => tab.selected && tab.kind === "conversation") : null;
      const preferredConversationId = preservedWorkspace?.selectedConversationId || selectedConversationTab?.targetId || workspaceState?.navigation?.selectedConversationId;
      const conversation = safeConversations.find((item) => item.id === preferredConversationId) || safeConversations[0] || null;
      const messages = conversation ? await science.conversations.messages(projectId, conversation.id) : [];
      const safeMessages = Array.isArray(messages) ? messages : [];
      const [messageEvidence, messageArtifactRows, labRows, attached] = await Promise.all([
        loadMessageEvidence(projectId, safeMessages),
        Promise.all(safeMessages.map(async (message) => [message.id, await science.artifacts.forMessage(projectId, message.conversationId, message.id)])),
        Promise.all(safeLabs.map(async (lab) => [lab.labId, await science.artifacts.forLab(projectId, lab.labId)])),
        conversation ? science.composer.attach({ projectId, conversationId: conversation.id }) : null,
      ]);
      if (epoch !== selectionEpoch) return;
      state.conversations = safeConversations;
      state.selectedConversationId = conversation?.id || null;
      state.sources = safeSources;
      state.artifacts = safeArtifacts;
      state.labs = safeLabs;
      state.workspaceLabBindings = Array.isArray(workspaceState?.labs) ? workspaceState.labs.filter((binding) => binding?.projectId === projectId) : [];
      state.manuscripts = safeManuscripts;
      state.journalProfiles = safeJournalProfiles;
      state.analysisSpecs = Array.isArray(analysisSpecs) ? analysisSpecs : [];
      state.decisions = Array.isArray(decisions) ? decisions : [];
      state.lifecycle = lifecycle;
      state.evidenceGraph = graphSnapshot?.graph || null;
      state.evidenceGraphReviews = Array.isArray(graphSnapshot?.reviews) ? graphSnapshot.reviews : [];
      state.evidenceGraphError = graphSnapshot?.error || "";
      applyResearchContractSnapshot(project, researchContract);
      state.selectedJournalProfileId = safeJournalProfiles.some((profile) => profile.id === preservedWorkspace?.selectedJournalProfileId) ? preservedWorkspace.selectedJournalProfileId : safeJournalProfiles[0]?.id || null;
      state.labCatalog = Array.isArray(capabilityCatalog?.labs) ? capabilityCatalog.labs : [];
      state.artifactContextsByMessage = new Map(messageArtifactRows.map(([messageId, contexts]) => [messageId, Array.isArray(contexts) ? contexts : []]));
      state.labContextsById = new Map(labRows.map(([labId, contexts]) => [labId, Array.isArray(contexts) ? contexts : []]));
      state.selectedLabId = safeLabs[0]?.labId || null;
      state.rendererPacks = Array.isArray(rendererPacks) ? rendererPacks : state.rendererPacks;
      state.selectedSourceId = safeSources[0]?.id || null;
      state.selectedArtifactId = (labRows[0]?.[1]?.[0]?.artifact?.id) || safeArtifacts[0]?.id || null;
      state.messages = safeMessages;
      state.activeTurn = attached?.turn || null;
      state.blocksByMessage = messageEvidence.blocks;
      state.citationsByMessage = messageEvidence.citations;
      state.evidenceById = messageEvidence.spans;
      state.loadingProject = false;
      if (preservedWorkspace) {
        state.currentDestination = projectDestinationIds.has(preservedWorkspace.currentDestination) ? preservedWorkspace.currentDestination : workspaceState?.navigation?.destination || "overview";
        state.selectedConversationId = safeConversations.some((item) => item.id === preservedWorkspace.selectedConversationId) ? preservedWorkspace.selectedConversationId : conversation?.id || null;
        const validTabs = preservedWorkspace.tabs.filter((tab) => tab.kind === "research"
          || (tab.kind === "conversation" && safeConversations.some((item) => item.id === tab.conversationId))
          || (tab.kind === "manuscript" && Boolean(manuscriptById(tab.manuscriptId)))
          || (tab.kind === "lab" && state.workspaceLabBindings.some((binding) => binding.enabled && binding.labId === tab.labId))
          || (tab.kind === "artifact" && Boolean(artifactForLab(tab.labId, tab.artifactId))));
        state.workspaceTabs = validTabs.some((tab) => tab.kind === "research") ? validTabs : [{ id: RESEARCH_TAB_ID, kind: "research", dirty: false }, ...validTabs];
        const activeTab = state.workspaceTabs.find((tab) => tab.id === preservedWorkspace.activeTabId) || state.workspaceTabs[0];
        state.activeWorkspaceTabId = activeTab.id;
        state.artifactHistoryById = new Map([...preservedWorkspace.artifactHistoryById].filter(([artifactId]) => state.artifacts.some((artifact) => artifact.id === artifactId)));
        if (activeTab.kind === "conversation") {
          state.mode = "session";
          state.selectedConversationId = activeTab.conversationId;
        } else if (activeTab.kind === "manuscript") {
          const manuscript = manuscriptById(activeTab.manuscriptId);
          if (manuscript) {
            state.mode = "manuscript";
            state.selectedManuscriptId = manuscript.id;
            state.manuscriptView = preservedWorkspace.manuscriptView || "write";
            const preservedDraft = preservedWorkspace.manuscriptDraft?.manuscriptId === manuscript.id ? preservedWorkspace.manuscriptDraft : null;
            if (preservedDraft?.dirty) {
              state.manuscriptDraft = preservedDraft;
              if (manuscript.currentVersion !== preservedDraft.baseVersion || manuscript.version.contentSha256 !== preservedDraft.baseContentSha256) {
                state.manuscriptSaveError = `원고가 v${manuscript.currentVersion}로 변경되었습니다. 현재 초안은 보존했으며 저장 전에 새 버전을 다시 확인해야 합니다.`;
              }
            } else {
              state.manuscriptDraft = manuscriptDraftFrom(manuscript);
            }
          }
        } else if (activeTab.kind === "lab") {
          state.mode = "lab";
          state.selectedLabId = activeTab.labId;
          state.selectedArtifactId = null;
          state.selectedArtifactOriginVersion = null;
          state.inspectedArtifactVersion = null;
          state.inspectedArtifactContext = null;
          state.returnMessageId = null;
        } else if (activeTab.kind === "artifact") {
          const artifact = artifactForLab(activeTab.labId, activeTab.artifactId);
          state.mode = "lab";
          state.selectedLabId = activeTab.labId;
          state.selectedArtifactId = activeTab.artifactId;
          state.selectedArtifactOriginVersion = Number.isSafeInteger(activeTab.originVersion) ? activeTab.originVersion : activeTab.exactVersion !== artifact?.currentVersion ? activeTab.exactVersion : null;
          state.inspectedArtifactVersion = preservedWorkspace.inspectedArtifactVersion && preservedWorkspace.inspectedArtifactVersion <= (artifact?.currentVersion || 0) ? preservedWorkspace.inspectedArtifactVersion : null;
          state.inspectedArtifactContext = state.inspectedArtifactVersion ? preservedWorkspace.inspectedArtifactContext : null;
          state.returnMessageId = activeTab.returnMessageId || preservedWorkspace.returnMessageId;
        }
      } else {
        restoreWorkspaceState(workspaceState);
      }
      if (state.mode === "manuscript" && state.selectedManuscriptId) {
        state.claimLedger = await science.claimLedgers.getForManuscript(projectId, state.selectedManuscriptId);
        if (epoch !== selectionEpoch) return;
      }
      if (state.mode === "lab" && state.selectedArtifactId && !state.artifactHistoryById.has(state.selectedArtifactId)) {
        const history = await science.artifacts.history(projectId, state.selectedArtifactId);
        if (epoch !== selectionEpoch) return;
        if (history?.artifactId === state.selectedArtifactId) state.artifactHistoryById.set(state.selectedArtifactId, history);
      }
      render();
    } catch (error) {
      if (epoch !== selectionEpoch) return;
      state.loadingProject = false;
      state.projectError = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function projectRail(project) {
    const projects = state.projects.map((item) => `<button class="projectButton" data-project-id="${escapeHtml(item.id)}" data-initial="${escapeHtml(item.title.slice(0, 1).toUpperCase())}" aria-current="${item.id === project.id}">
      <span class="projectTitle">${escapeHtml(item.title)}</span><span class="projectMeta">${escapeHtml(domainLabels[item.domain] || item.domain)} · ${escapeHtml(formatDate(item.updatedAt))}</span>
    </button>`).join("");
    const summaryByLabId = new Map(state.labs.map((lab) => [lab.labId, lab]));
    const enabledLabIds = new Set(state.workspaceLabBindings.filter((binding) => binding.enabled).map((binding) => binding.labId));
    const groups = labGroups.map((group) => ({
      ...group,
      labs: group.labIds.filter((labId) => enabledLabIds.has(labId) && summaryByLabId.has(labId)).map((labId) => ({
        labId,
        artifactCount: Number(summaryByLabId.get(labId)?.artifactCount || 0),
        versionCount: Number(summaryByLabId.get(labId)?.versionCount || 0),
      })),
    })).filter((group) => group.labs.length);
    const labs = groups.map((group) => {
      const expanded = state.expandedLabGroups.has(group.id);
      const count = group.labs.reduce((total, lab) => total + Number(lab.artifactCount || 0), 0);
      const children = group.labs.map((lab) => `<button class="labButton" data-lab-id="${escapeHtml(lab.labId)}" aria-current="${state.mode === "lab" && state.selectedLabId === lab.labId}" title="${lab.artifactCount > 0 ? "아티팩트 보관소 열기" : `${labLabel(lab.labId)} Lab 시작하기`}"><span class="labToolIcon">${heroIcon(labIcons[lab.labId] || "grid")}</span><span class="labToolLabel">${escapeHtml(labLabel(lab.labId))}</span><em>${lab.artifactCount > 0 ? escapeHtml(lab.artifactCount) : ""}</em></button>`).join("");
      return `<section class="labGroup" data-lab-group-id="${escapeHtml(group.id)}"><button class="labGroupDisclosure" data-lab-group="${escapeHtml(group.id)}" aria-expanded="${expanded}" aria-label="${escapeHtml(`${group.label} Lab 그룹`)}" title="${escapeHtml(group.label)}"><span class="labChevron">${heroIcon(expanded ? "chevron-down" : "chevron-right")}</span><span class="labGroupIcon">${heroIcon(group.icon)}</span><span class="labGroupLabel">${escapeHtml(group.label)}</span><em>${count > 0 ? escapeHtml(count) : ""}</em><span class="labEndChevron">${heroIcon("chevron-down", expanded ? "uiIcon isReverse" : "uiIcon")}</span></button><div class="labGroupChildren ${expanded ? "isOpen" : ""}">${children}</div></section>`;
    }).join("");
    const destinations = projectDestinationGroups.map((group) => `<section class="projectNavGroup"><div class="projectNavLabel">${escapeHtml(group.label)}</div>${group.items.map((item) => `<button data-project-destination="${escapeHtml(item.id)}" aria-current="${state.currentDestination === item.id}">${heroIcon(item.icon)}<span>${escapeHtml(item.label)}</span></button>`).join("")}</section>`).join("");
    const currentProjectButton = `<button class="currentProject" data-action="toggle-projects" data-project-id="${escapeHtml(project.id)}" aria-expanded="${state.projectMenuOpen}"><span>${escapeHtml(project.title)}</span>${heroIcon("chevron-down")}</button>`;
    const projectMenu = `<nav class="projectList projectMenu ${state.projectMenuOpen ? "isOpen" : ""}" aria-label="연구 프로젝트">${projects}</nav>`;
    const projectSection = `<div class="railSection currentProjectSection stableProjectSection">
      <div class="railLabel">현재 프로젝트</div>
      <section class="projectContextCard">
        ${currentProjectButton}
        <nav class="projectDestinations projectWorkflowNav" aria-label="현재 프로젝트 연구 흐름">${destinations}</nav>
      </section>
      ${projectMenu}
    </div>`;
    return `<aside class="rail" data-rail-mode="${escapeHtml(state.mode)}">
      <div class="railBrand"><span class="railBrandLockup"><img class="railBrandMark" src="./assets/agentlas-mark.png" alt="" aria-hidden="true"><span class="railBrandWordmark"><strong>Agentlas Science</strong><img class="railBrandLiquid" src="./assets/flask-liquid-exact.png" alt="" aria-hidden="true"></span></span><button class="railCollapseButton" data-action="collapse-rail" aria-label="사이드바 접기" title="사이드바 접기">${heroIcon("chevron-right", "uiIcon isReverse")}</button></div>
      <button class="railBackButton" data-action="back-to-work" aria-label="Agentlas Work로 돌아가기" title="Agentlas Work로 돌아가기">${heroIcon("chevron-right", "uiIcon isReverse")}<strong>Agentlas Work</strong></button>
      <button class="newButton" data-action="new" aria-label="새 연구 시작" title="새 연구">${heroIcon("plus")}<strong>새 연구</strong></button>
      ${projectSection}
      <div class="railSection labSection"><button class="railDisclosure" data-action="toggle-labs" aria-expanded="${state.labsExpanded}"><span>Labs</span>${heroIcon("chevron-down", state.labsExpanded ? "uiIcon isReverse" : "uiIcon")}</button><nav class="labList ${state.labsExpanded ? "isOpen" : ""}" aria-label="현재 프로젝트에 활성화된 Lab 도구와 아티팩트 보관소">${labs || `<span class="railEmpty">이 프로젝트에 활성화된 Lab이 없습니다. 검증된 아티팩트가 생성되거나 Lab을 추가하면 여기에 표시됩니다.</span>`}</nav></div>
      <footer class="researcherCard"><span class="researcherAvatar" aria-hidden="true">MJ</span><span><strong>Researcher</strong><em>Local workspace</em></span><button data-action="toggle-drawer" aria-label="설정과 세부 정보">${heroIcon("ellipsis")}</button></footer>
    </aside>`;
  }

  function citationButtons(messageId, blockId) {
    const citations = (state.citationsByMessage.get(messageId) || []).filter((citation) => citation.blockId === blockId);
    if (!citations.length) return "";
    return `<span class="citationRow">${citations.map((citation) => {
      const source = sourceById(citation.sourceId);
      return `<button class="citationChip" data-citation-id="${escapeHtml(citation.id)}" data-source-id="${escapeHtml(citation.sourceId)}" title="${escapeHtml(source?.title || "저장된 출처")}">[${escapeHtml(citation.ordinal)}]</button>`;
    }).join("")}</span>`;
  }

  function messageMarkup(message) {
    const blocks = state.blocksByMessage.get(message.id) || [];
    const artifactContexts = state.artifactContextsByMessage.get(message.id) || [];
    const artifactCards = artifactContexts.length ? `<div class="inlineArtifacts" aria-label="이 응답에서 Lab 도구로 생성된 아티팩트">${artifactContexts.map((context) => `<button class="inlineArtifact" data-inline-artifact-id="${escapeHtml(context.artifact.id)}" data-inline-artifact-version="${escapeHtml(context.selectedVersion.version)}" data-inline-conversation-id="${escapeHtml(message.conversationId)}" data-inline-message-id="${escapeHtml(message.id)}"><span class="artifactPreviewType">LAB ARTIFACT · ${escapeHtml(context.artifact.kind)}</span><div class="artifactConnection"><span>${escapeHtml(labLabel(context.linkage.labId))} Lab</span><span>이 응답에서 생성 · 보관소에 저장됨</span></div>${context.selectedVersion.rendererId === "agentlas.vega" ? `<span class="inlineArtifactPreview" data-inline-vega-artifact="${escapeHtml(context.artifact.id)}" data-inline-vega-version="${escapeHtml(context.selectedVersion.version)}" aria-label="${escapeHtml(context.artifact.title)} 미리보기"></span>` : `<span class="inlineArtifactPreview" data-inline-capture-artifact="${escapeHtml(context.artifact.id)}" data-inline-capture-version="${escapeHtml(context.selectedVersion.version)}" aria-label="${escapeHtml(context.artifact.title)} 검증 캡처"></span>`}<strong>${escapeHtml(context.artifact.title)}</strong><span>아티팩트 v${escapeHtml(context.selectedVersion.version)}${context.isCurrent ? " · 현재 버전" : ` · 현재 v${escapeHtml(context.artifact.currentVersion)}`}</span><em>${escapeHtml(labLabel(context.linkage.labId))} 보관소에서 열고 조작하기 →</em></button>`).join("")}</div>` : "";
    if (message.role === "user") return `<article class="questionBubble"><div>${escapeHtml(message.content)}</div><span>${escapeHtml(formatDate(message.createdAt))}</span></article>`;
    if (!blocks.length) return `<article class="answer" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" tabindex="-1"><div class="answerMeta">${message.role === "assistant" ? "Agentlas Science" : escapeHtml(message.role)}</div><p>${escapeHtml(message.content)}</p>${artifactCards}</article>`;
    return `<article class="answer" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" tabindex="-1"><div class="answerMeta">Agentlas Science · evidence-linked response</div>${blocks.map((block) => `<div class="answerBlock" data-block-kind="${escapeHtml(block.kind)}"><p>${escapeHtml(block.content)}</p>${citationButtons(message.id, block.id)}</div>`).join("")}${artifactCards}</article>`;
  }

  function evidenceGraphContextMarkup(context) {
    if (!context || typeof context !== "object") return `<p class="evidenceGraphNoContext">No structured conditioning context is stored for this assertion.</p>`;
    const rows = [
      ["Population", context.population], ["Exposure", context.interventionOrExposure], ["Comparator", context.comparator],
      ["Outcome", context.outcome], ["Timeframe", context.timeframe], ["Method", context.method], ["Dataset / setting", context.datasetOrSetting],
    ].filter(([, value]) => value);
    return rows.length ? `<dl class="evidenceGraphContext">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`
      : `<p class="evidenceGraphNoContext">No structured conditioning context is stored for this assertion.</p>`;
  }

  function evidenceGraphCandidateRow(candidate) {
    const status = evidenceGraphCandidateStatus(candidate);
    const selected = state.selectedEvidenceGraphCandidateId === candidate.id;
    return `<button class="evidenceGraphCandidateRow" data-evidence-graph-candidate-id="${escapeHtml(candidate.id)}" data-review-status="${escapeHtml(status)}" aria-current="${selected}"><span class="evidenceGraphCandidateState" aria-hidden="true"></span><span><strong>${escapeHtml(candidate.label)}</strong><em>${escapeHtml(evidenceGraphKindLabel(candidate.kind))} · ${escapeHtml(status)} · ${escapeHtml(candidate.evidencePathNodeIds.length)} path nodes</em></span><span class="evidenceGraphCandidateScore">${escapeHtml(Math.round(Number(candidate.assessmentConfidence || 0) * 100))}%</span></button>`;
  }

  function evidenceGraphInspector(graph, selectedNode, selectedCandidate) {
    if (!selectedNode && !selectedCandidate) return `<aside class="evidenceGraphInspector"><div class="evidenceGraphInspectorEmpty"><strong>Select a node</strong><p>Inspect its exact canonical version, epistemic status, conditioning context, and directed evidence paths.</p></div></aside>`;
    const candidate = selectedCandidate || graph.inferenceCandidates.find((item) => item.nodeId === selectedNode?.id) || null;
    const node = selectedNode || evidenceGraphNodeById(candidate?.nodeId);
    const review = evidenceGraphReviewForCandidate(candidate);
    const pathNodes = candidate?.evidencePathNodeIds?.map(evidenceGraphNodeById).filter(Boolean) || [];
    const missing = candidate?.missingRequirements?.length
      ? `<section class="evidenceGraphInspectorSection"><h3>Missing requirements</h3><ul class="evidenceGraphMissing">${candidate.missingRequirements.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : "";
    const path = pathNodes.length
      ? `<section class="evidenceGraphInspectorSection"><h3>Exact evidence path</h3><div class="evidenceGraphPathNodes">${pathNodes.map((item, index) => `<button data-evidence-graph-node-id="${escapeHtml(item.id)}"><span>${escapeHtml(index + 1)}</span><strong>${escapeHtml(item.label)}</strong><em>${escapeHtml(evidenceGraphStatusLabel(item.epistemicStatus))}</em></button>`).join("")}</div></section>`
      : candidate ? `<section class="evidenceGraphInspectorSection"><h3>Exact evidence path</h3><p class="evidenceGraphNoContext">No surviving exact evidence path is attached. This candidate cannot be treated as supported.</p></section>` : "";
    const pathExplanation = state.evidenceGraphPath
      ? `<div class="evidenceGraphPathResult" data-found="${escapeHtml(state.evidenceGraphPath.found)}"><strong>${state.evidenceGraphPath.found ? "Directed path found" : "No directed path"}</strong><span>${state.evidenceGraphPath.found ? `${state.evidenceGraphPath.nodeIds.length} nodes · ${state.evidenceGraphPath.edgeIds.length} edges` : (state.evidenceGraphPath.blockedBy || []).join(", ") || "The selected direction is not supported by the graph."}</span></div>` : "";
    const openExact = node ? `<button class="secondaryButton evidenceGraphExactButton" data-action="open-evidence-graph-exact" data-evidence-graph-node-id="${escapeHtml(node.id)}">Open exact record</button>` : "";
    const pathAction = node ? (state.evidenceGraphPathAnchorId && state.evidenceGraphPathAnchorId !== node.id
      ? `<button class="secondaryButton" data-action="explain-evidence-graph-path" data-evidence-graph-node-id="${escapeHtml(node.id)}">Explain directed path</button>`
      : `<button class="secondaryButton" data-action="anchor-evidence-graph-path" data-evidence-graph-node-id="${escapeHtml(node.id)}">${state.evidenceGraphPathAnchorId === node.id ? "Path start selected" : "Start path here"}</button>`) : "";
    const reviewAction = candidate ? `<button class="primaryButton" data-action="open-evidence-graph-review" data-evidence-graph-candidate-id="${escapeHtml(candidate.id)}">${review ? "Review decision" : "Review inference"}</button>` : "";
    return `<aside class="evidenceGraphInspector" data-selected-node-id="${escapeHtml(node?.id || "")}" data-selected-candidate-id="${escapeHtml(candidate?.id || "")}">
      <header><div><span>${escapeHtml(node ? evidenceGraphKindLabel(node.kind) : evidenceGraphKindLabel(candidate.kind))}</span><h2>${escapeHtml(node?.label || candidate.label)}</h2></div>${node ? `<span class="evidenceGraphStatus" data-status="${escapeHtml(node.epistemicStatus)}">${escapeHtml(evidenceGraphStatusLabel(node.epistemicStatus))}</span>` : ""}</header>
      <div class="evidenceGraphInspectorScroll">
        ${node ? `<section class="evidenceGraphInspectorSection"><h3>Statement</h3><p>${escapeHtml(node.statement)}</p></section><section class="evidenceGraphInspectorSection"><h3>Conditioning context</h3>${evidenceGraphContextMarkup(node.conditioningContext)}</section><section class="evidenceGraphInspectorSection evidenceGraphCanonical"><h3>Exact canonical record</h3><dl><div><dt>Kind</dt><dd>${escapeHtml(node.canonicalRef.kind)}</dd></div><div><dt>ID</dt><dd><code>${escapeHtml(node.canonicalRef.id)}</code></dd></div><div><dt>Version</dt><dd>v${escapeHtml(node.canonicalRef.version)}</dd></div><div><dt>Content</dt><dd><code title="${escapeHtml(node.canonicalRef.contentSha256)}">${escapeHtml(evidenceGraphShortHash(node.canonicalRef.contentSha256))}</code></dd></div></dl></section>` : ""}
        ${candidate ? `<section class="evidenceGraphInspectorSection evidenceGraphCandidateReview" data-review-status="${escapeHtml(review?.decision || "pending")}"><h3>Inference review</h3><strong>${escapeHtml(review?.decision || "Pending human review")}</strong><p>${escapeHtml(review?.rationale || candidate.rationale)}</p><span>Acceptance records a review decision only. It never promotes this candidate to a scientific fact.</span></section>` : ""}
        ${missing}${path}${pathExplanation}
      </div><footer>${openExact}${pathAction}${reviewAction}</footer>
    </aside>`;
  }

  function evidenceGraphView(project) {
    const graph = state.evidenceGraph;
    if (state.evidenceGraphLoading && !graph) return `<section class="evidenceGraphView"><div class="evidenceGraphState" aria-live="polite"><strong>Building the project Evidence Graph…</strong><span>Canonical sources, evidence spans, hypotheses, runs, artifacts, and conclusions are being projected.</span></div></section>`;
    if (!graph) {
      return `<section class="evidenceGraphView" data-evidence-graph-state="${state.evidenceGraphError ? "error" : "empty"}"><header class="evidenceGraphHeader"><div><span>Interpretation · Evidence Graph</span><h1>${escapeHtml(project.title)}</h1><p>Citations, support, contradictions, experiments, artifacts, and conclusions remain separately typed and version-bound.</p></div></header><div class="evidenceGraphState" role="${state.evidenceGraphError ? "alert" : "status"}"><span class="evidenceGraphStateIcon">${heroIcon(state.evidenceGraphError ? "grid" : "sparkles")}</span><strong>${state.evidenceGraphError ? "The current graph cannot be trusted" : "No Evidence Graph revision yet"}</strong><span>${escapeHtml(state.evidenceGraphError || "Build the first immutable projection from this project's current canonical research records.")}</span><button class="primaryButton" data-action="refresh-evidence-graph">${state.evidenceGraphError ? "Rebuild from canonical records" : "Build Evidence Graph"}</button></div></section>`;
    }
    const selectedCandidate = evidenceGraphCandidateById(state.selectedEvidenceGraphCandidateId);
    const selectedNode = evidenceGraphNodeById(state.selectedEvidenceGraphNodeId)
      || evidenceGraphNodeById(selectedCandidate?.nodeId)
      || graph.nodes.find((node) => node.kind === "conclusion")
      || graph.nodes.find((node) => node.kind === "hypothesis")
      || graph.nodes[0] || null;
    const reviews = graph.inferenceCandidates.map((candidate) => evidenceGraphCandidateStatus(candidate));
    const acceptedCount = reviews.filter((status) => status === "accepted").length;
    const rejectedCount = reviews.filter((status) => status === "rejected").length;
    const pendingCount = reviews.filter((status) => status === "pending").length;
    const candidates = graph.inferenceCandidates.length
      ? graph.inferenceCandidates.map(evidenceGraphCandidateRow).join("")
      : `<div class="evidenceGraphNoCandidates"><strong>No inference candidates</strong><span>The graph contains no machine-proposed gap, qualification, or reconciliation requiring review.</span></div>`;
    const nodeOptions = graph.nodes.map((node) => `<option value="${escapeHtml(node.id)}" ${node.id === selectedNode?.id ? "selected" : ""}>${escapeHtml(`${evidenceGraphKindLabel(node.kind)} · ${node.label}`)}</option>`).join("");
    return `<section class="evidenceGraphView" data-evidence-graph-state="ready" data-evidence-graph-revision="${escapeHtml(graph.revision)}" data-evidence-graph-sha256="${escapeHtml(graph.contentSha256)}">
      <header class="evidenceGraphHeader"><div><span>Interpretation · Evidence Graph</span><h1>${escapeHtml(project.title)}</h1><p>Citation is not support. Accepted inference remains a reviewed candidate until an exact non-invalidated research chain supports a conclusion.</p></div><div class="evidenceGraphHeaderActions"><span>Revision ${escapeHtml(graph.revision)} · <code title="${escapeHtml(graph.contentSha256)}">${escapeHtml(evidenceGraphShortHash(graph.contentSha256))}</code></span><button class="secondaryButton" data-action="refresh-evidence-graph" ${state.evidenceGraphLoading ? "disabled" : ""}>${state.evidenceGraphLoading ? "Refreshing…" : "Refresh graph"}</button></div></header>
      ${state.evidenceGraphError ? `<div class="evidenceGraphWarning" role="alert"><strong>Graph refresh failed closed.</strong><span>${escapeHtml(state.evidenceGraphError)}</span></div>` : ""}
      <div class="evidenceGraphMetrics" aria-label="Evidence Graph summary"><div><span>Nodes</span><strong>${escapeHtml(graph.nodes.length)}</strong></div><div><span>Edges</span><strong>${escapeHtml(graph.edges.length)}</strong></div><div><span>Pending review</span><strong>${escapeHtml(pendingCount)}</strong></div><div><span>Accepted / rejected</span><strong>${escapeHtml(acceptedCount)} / ${escapeHtml(rejectedCount)}</strong></div><div data-alert="${graph.summary.invalidatedNodeCount > 0}"><span>Invalidated</span><strong>${escapeHtml(graph.summary.invalidatedNodeCount)}</strong></div><div data-alert="${graph.summary.unsupportedConclusionCount > 0}"><span>Unsupported conclusions</span><strong>${escapeHtml(graph.summary.unsupportedConclusionCount)}</strong></div></div>
      <div class="evidenceGraphWorkspace"><section class="evidenceGraphCanvasPane"><header><div><strong>Project evidence map</strong><span>${escapeHtml(graph.nodes.length)} canonical nodes · ${escapeHtml(graph.edges.length)} directed edges</span></div><div class="evidenceGraphCanvasControls"><label class="evidenceGraphNodePicker"><span>Inspect node</span><select data-evidence-graph-node-select aria-label="Inspect exact Evidence Graph node">${nodeOptions}</select></label><div class="evidenceGraphLegend"><span data-status="supported">Supported</span><span data-status="candidate">Candidate</span><span data-status="contradicted">Contradicted</span><span data-status="invalidated">Invalidated</span></div></div></header><div class="evidenceGraphCanvas" data-evidence-graph-canvas role="application" aria-label="Interactive project Evidence Graph"></div><footer><span>Click a node to inspect the exact record. Drag, zoom, and pan the real graph.</span><span>Directed edges preserve derivation and evidence paths.</span></footer></section>${evidenceGraphInspector(graph, selectedNode, selectedCandidate)}</div>
      <section class="evidenceGraphCandidateQueue"><header><div><span>Inference review queue</span><strong>AI proposals are never facts</strong></div><span>${escapeHtml(pendingCount)} pending · ${escapeHtml(acceptedCount)} accepted for testing · ${escapeHtml(rejectedCount)} rejected</span></header><div>${candidates}</div></section>
    </section>`;
  }

  function researchView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    if (state.currentDestination === "interpretation") return evidenceGraphView(project);
    const messages = state.messages.filter((message) => message.role !== "user").map(messageMarkup).join("");
    const assistantCount = state.messages.filter((message) => message.role === "assistant").length;
    const contractNotice = state.researchContract?.status === "draft"
      ? `<button class="researchContractNotice" data-action="open-research-contract-sheet"><span>${heroIcon("book")}<strong>연구 계약 초안 v${escapeHtml(state.researchContract.version)}</strong></span><em>사람의 승인 대기 · 목표와 중단 기준 확인 →</em></button>`
      : "";
    const destination = projectDestinationById(state.currentDestination);
    return `<section class="researchView" data-research-destination="${escapeHtml(destination.id)}"><div class="answerColumn">
      <div class="researchKicker">${escapeHtml(domainLabels[project.domain] || project.domain)} · ${escapeHtml(destination.label)} · ${escapeHtml(lifecycleLabel())}</div>
      <h1>${escapeHtml(project.title)}</h1>
      ${contractNotice}
      <div class="messageStream">${messages || `<div class="emptyCopy"><strong>아직 대화 기록이 없습니다.</strong></div>`}</div>
      ${assistantCount === 0 ? `<div class="truthfulEmpty"><strong>아직 생성된 연구 응답이 없습니다.</strong><p>첫 질문은 저장되었습니다. 연구 계약 승인과 Agent runtime 실행이 연결되면 답변 블록, 주장, 정확한 출처 인용이 이 기록에 추가됩니다.</p><span>고정 답변이나 가짜 인용은 표시하지 않습니다.</span></div>` : ""}
    </div></section>`;
  }

  function manuscriptDraftFrom(manuscript) {
    return {
      manuscriptId: manuscript.id,
      baseVersion: manuscript.currentVersion,
      baseContentSha256: manuscript.version.contentSha256,
      markdown: manuscript.version.markdown,
      bindings: manuscript.version.bindings.map(({ ordinal, role, locator, target }) => ({ ordinal, role, locator, target: { ...target } })),
      dirty: false,
    };
  }

  async function openManuscript(manuscriptId) {
    if (!state.selectedId || !manuscriptId) return;
    rememberScroll();
    try {
      const [manuscript, claimLedger] = await Promise.all([
        science.manuscripts.get(state.selectedId, manuscriptId),
        science.claimLedgers.getForManuscript(state.selectedId, manuscriptId),
      ]);
      if (!manuscript || manuscript.projectId !== state.selectedId) throw new Error("science-manuscript-not-found");
      state.manuscripts = [manuscript, ...state.manuscripts.filter((item) => item.id !== manuscript.id)];
      ensureManuscriptWorkspaceTab(manuscript);
      if (state.manuscriptDraft?.manuscriptId !== manuscript.id || !state.manuscriptDraft.dirty) state.manuscriptDraft = manuscriptDraftFrom(manuscript);
      state.selectedManuscriptId = manuscript.id;
      state.claimLedger = claimLedger;
      state.submissionExports = await science.submissions.list(state.selectedId, manuscript.id);
      if (!Array.isArray(state.submissionExports)) state.submissionExports = [];
      state.journalValidation = null;
      state.manuscriptSaveError = "";
      state.mode = "manuscript";
      state.currentDestination = "manuscript";
      state.drawer = null;
      render();
      void queueWorkspacePersistence();
    } catch (error) {
      state.projectError = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function inlineManuscriptMarkdown(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }

  function manuscriptPreview(markdown) {
    const rows = String(markdown || "").split(/\r?\n/);
    const output = [];
    let paragraph = [];
    let list = [];
    let code = [];
    let inCode = false;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${inlineManuscriptMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) return;
      output.push(`<ul>${list.map((item) => `<li>${inlineManuscriptMarkdown(item)}</li>`).join("")}</ul>`);
      list = [];
    };
    const flushCode = () => {
      if (!code.length) return;
      output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      code = [];
    };
    for (const row of rows) {
      if (row.trim().startsWith("```")) {
        flushParagraph();
        flushList();
        if (inCode) flushCode();
        inCode = !inCode;
        continue;
      }
      if (inCode) { code.push(row); continue; }
      const heading = /^(#{1,3})\s+(.+)$/.exec(row);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length;
        output.push(`<h${level}>${inlineManuscriptMarkdown(heading[2])}</h${level}>`);
        continue;
      }
      const item = /^[-*]\s+(.+)$/.exec(row);
      if (item) {
        flushParagraph();
        list.push(item[1]);
        continue;
      }
      if (!row.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      if (row.trim().startsWith("> ")) {
        flushParagraph();
        flushList();
        output.push(`<blockquote>${inlineManuscriptMarkdown(row.trim().slice(2))}</blockquote>`);
        continue;
      }
      paragraph.push(row.trim());
    }
    flushParagraph();
    flushList();
    flushCode();
    return output.join("") || `<p class="manuscriptPreviewEmpty">원고 내용을 입력하면 안전한 서식 미리보기가 여기에 표시됩니다.</p>`;
  }

  function manuscriptReadiness(markdown, bindings, journalProfileReady = false) {
    const normalized = String(markdown || "").toLowerCase();
    const sections = ["abstract", "introduction", "methods", "results", "discussion"].map((name) => ({ name, ready: new RegExp(`^#{1,3}\\s+${name}\\b`, "m").test(normalized) }));
    return {
      sections,
      sectionCount: sections.filter((item) => item.ready).length,
      evidenceCount: bindings.length,
      journalProfileReady,
    };
  }

  function manuscriptOutline(markdown) {
    return String(markdown || "").split(/\r?\n/).map((row, lineIndex) => {
      const match = row.match(/^(#{1,3})\s+(.+?)\s*$/);
      return match ? { depth: match[1].length, label: match[2].replace(/[*_`]/g, ""), lineIndex } : null;
    }).filter(Boolean).slice(0, 40);
  }

  function manuscriptBindingMarkup(binding) {
    if (binding.target.kind === "artifact") {
      const artifact = state.artifacts.find((item) => item.id === binding.target.artifactId);
      return `<button class="manuscriptBinding" data-manuscript-artifact-id="${escapeHtml(binding.target.artifactId)}" data-manuscript-artifact-version="${escapeHtml(binding.target.artifactVersion)}"><span>${escapeHtml(binding.role)} · ${escapeHtml(binding.locator)}</span><strong>${escapeHtml(artifact?.title || "검증된 Lab 아티팩트")} · exact v${escapeHtml(binding.target.artifactVersion)}</strong><em>검증 캡처 열기 →</em></button>`;
    }
    if (binding.target.kind === "citation") {
      const citation = citationById(binding.target.citationId);
      const source = sourceById(citation?.sourceId);
      return `<button class="manuscriptBinding" data-citation-id="${escapeHtml(binding.target.citationId)}" ${citation?.sourceId ? `data-source-id="${escapeHtml(citation.sourceId)}"` : ""}><span>${escapeHtml(binding.role)} · ${escapeHtml(binding.locator)}</span><strong>${escapeHtml(source?.title || "프로젝트 인용 근거")}</strong><em>정확한 근거 열기 →</em></button>`;
    }
    return `<div class="manuscriptBinding"><span>${escapeHtml(binding.role)} · ${escapeHtml(binding.locator)}</span><strong>Source figure · ${escapeHtml(binding.target.sourceFigureId)}</strong><em>원본 figure version에 고정됨</em></div>`;
  }

  function manuscriptWorkbench() {
    const manuscript = manuscriptById(state.selectedManuscriptId);
    const draft = state.manuscriptDraft;
    if (!manuscript || !draft || draft.manuscriptId !== manuscript.id) return `<section class="emptyView"><div><div class="emptyIcon">M</div><strong>원고를 선택해 주세요.</strong><p>저장된 원고는 브라우저형 탭에서 열리고, 우측 연구 채팅과 함께 편집됩니다.</p><button class="primaryButton manuscriptCreateInline" data-action="new-manuscript">새 원고 만들기</button></div></section>`;
    const journalProfile = journalProfileById(state.selectedJournalProfileId);
    const claimReady = claimLedgerIsCurrent(manuscript, draft);
    const claimGateReason = draft.dirty
      ? "원고를 먼저 새 버전으로 저장하세요"
      : !state.claimLedger
        ? "원고의 claim ledger가 아직 없습니다"
        : !claimReady
          ? "현재 원고 버전의 미해결 claim gate를 먼저 닫으세요"
          : "";
    const readiness = manuscriptReadiness(draft.markdown, draft.bindings, Boolean(journalProfile));
    const outline = manuscriptOutline(draft.markdown);
    const wordCount = String(draft.markdown || "").trim().split(/\s+/).filter(Boolean).length;
    const figureCount = draft.bindings.filter((binding) => binding.target.kind === "artifact" || binding.target.kind === "source-figure").length;
    const referenceCount = draft.bindings.filter((binding) => binding.target.kind === "citation").length;
    const guidelineInspectedAt = journalProfile?.version.sources?.[0]?.inspectedAt ? formatDate(journalProfile.version.sources[0].inspectedAt) : "검사 필요";
    const status = state.manuscriptSaving
      ? "새 immutable version 저장 중…"
      : state.manuscriptSaveError
        ? state.manuscriptSaveError
        : draft.dirty
          ? `v${draft.baseVersion} 기반 · 저장되지 않은 변경`
          : `v${draft.baseVersion} · ${draft.baseContentSha256.slice(0, 12)}…`;
    const canvas = state.manuscriptView === "preview"
      ? `<article class="manuscriptPaper manuscriptPreview" data-manuscript-preview><header class="manuscriptDocumentTitle"><span>Research Article</span><h1>${escapeHtml(manuscript.title)}</h1></header>${manuscriptPreview(draft.markdown)}</article>`
      : `<div class="manuscriptEditorDocument"><header class="manuscriptDocumentTitle"><span>Research Article</span><h1>${escapeHtml(manuscript.title)}</h1></header><textarea class="manuscriptEditor" data-manuscript-editor aria-label="원고 Markdown 편집기" spellcheck="true">${escapeHtml(draft.markdown)}</textarea></div>`;
    const outlineRows = outline.length
      ? outline.map((item) => `<button data-manuscript-outline-line="${escapeHtml(item.lineIndex)}" data-depth="${escapeHtml(item.depth)}"><span class="outlineState" data-ready="${readiness.sections.some((section) => section.name === item.label.toLowerCase() && section.ready)}"></span><strong>${escapeHtml(item.label)}</strong></button>`).join("")
      : `<div class="manuscriptOutlineEmpty">원고의 Markdown 제목이 여기에 표시됩니다.</div>`;
    const bindings = draft.bindings.map(manuscriptBindingMarkup).join("") || `<div class="manuscriptNoBindings"><strong>연결된 근거가 없습니다.</strong><span>AI가 주장·인용·그림을 프로젝트의 정확한 citation 또는 검증 캡처에 연결해야 합니다.</span></div>`;
    const profileOptions = state.journalProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === state.selectedJournalProfileId ? "selected" : ""}>${escapeHtml(profile.journalName)} · ${escapeHtml(profile.articleType)} · v${escapeHtml(profile.currentVersion)}</option>`).join("");
    const validationRows = state.journalValidation?.findings?.slice(0, 8).map((finding) => `<div class="journalFinding" data-status="${escapeHtml(finding.status)}" data-severity="${escapeHtml(finding.severity)}"><span>${finding.status === "pass" ? "✓" : finding.status === "manual" ? "?" : "!"}</span><div><strong>${escapeHtml(finding.requirement)}</strong><em>${escapeHtml(finding.observed)}</em></div></div>`).join("") || "";
    const latestExport = state.submissionExports.find((item) => item.status === "ready" && lifecycleBindsExport(item) && item.journalProfileId === journalProfile?.id
      && item.manuscriptVersion === manuscript.currentVersion && claimReady
      && item.claimLedgerId === state.claimLedger.manifest.ledgerId && item.claimLedgerRevision === state.claimLedger.manifest.revision
      && item.claimLedgerManifestSha256 === state.claimLedger.manifest.manifestSha256
      && item.claimGateReportSha256 === state.claimLedger.gate.reportSha256) || null;
    const claimHistory = state.claimLedger?.manifest?.claims?.slice(-5).map((claim) => `<div class="journalFinding" data-status="${claim.status === "supported" || claim.status === "not-applicable" ? "pass" : "fail"}"><span>${claim.status === "supported" || claim.status === "not-applicable" ? "✓" : "!"}</span><div><strong>${escapeHtml(claim.claimClass)} · ${escapeHtml(claim.status)}</strong><em>${escapeHtml(claim.exactText)}</em></div></div>`).join("") || `<div class="manuscriptNoBindings"><strong>Claim ledger 없음</strong><span>AI가 현재 원고의 각 문장을 분류하고 정확한 근거 snapshot에 연결해야 합니다.</span></div>`;
    const claimBindingState = claimLedgerBindingState(manuscript);
    const claimSummary = state.claimLedger
      ? `${escapeHtml(claimBindingState)} · ${escapeHtml(state.claimLedger.counts.active)} active · ${escapeHtml(state.claimLedger.counts.supported)} supported · ${escapeHtml(state.claimLedger.counts.unresolved)} unresolved · coverage ${escapeHtml(state.claimLedger.gate.classifiedSentenceCount)}/${escapeHtml(state.claimLedger.gate.manuscriptSentenceCount)}`
      : "missing · 현재 원고 버전에 고정된 ledger가 없습니다.";
    const journalPanel = journalProfile
      ? `<label class="journalProfileSelect"><span>Target journal</span><select data-journal-profile-select>${profileOptions}</select></label><div class="journalProfileProof"><strong>${escapeHtml(journalProfile.version.rules.length)} verified rules</strong><span>${escapeHtml(journalProfile.version.sources.map((source) => source.officialHost).join(", "))}</span><code>${escapeHtml(journalProfile.version.contentSha256.slice(0, 14))}…</code></div>${state.journalValidation ? `<div class="journalValidationSummary" data-status="${escapeHtml(state.journalValidation.status)}"><strong>${escapeHtml(state.journalValidation.status)}</strong><span>${escapeHtml(state.journalValidation.counts.pass)} pass · ${escapeHtml(state.journalValidation.counts.fail)} fail · ${escapeHtml(state.journalValidation.counts.manual)} manual</span></div>${validationRows}` : ""}<div class="journalActions"><button class="secondaryButton" data-action="open-journal-sheet">저널 변경</button><button class="primaryButton" data-action="open-submission-sheet" ${!claimReady ? `disabled title="${escapeHtml(claimGateReason)}"` : ""}>제출본 검사·생성</button></div>${latestExport ? `<button class="submissionDownload" data-action="download-submission" data-export-id="${escapeHtml(latestExport.id)}"><span>${heroIcon("arrow-down-tray")}</span><strong>${escapeHtml(latestExport.fileName || "submission.zip")}</strong><em>${escapeHtml(Math.round((latestExport.packageByteSize || 0) / 1024))} KB · hash 검증됨</em></button>` : ""}`
      : `<div class="journalEmpty"><strong>타깃 저널이 아직 없습니다.</strong><p>공식 저널 페이지를 먼저 스냅샷으로 고정하고, AI가 인용 가능한 문구만 규칙으로 변환합니다.</p><button class="primaryButton" data-action="open-journal-sheet">저널 타깃 설정</button></div>`;
    return `<section class="manuscriptWorkspace">
      <header class="journalToolbar">
        <button class="journalTargetButton" data-action="open-journal-sheet">${escapeHtml(journalProfile?.journalName || "Target journal")} ${heroIcon("chevron-down")}</button>
        <span class="journalGuideline">가이드라인 검사: ${escapeHtml(guidelineInspectedAt)} ${journalProfile ? `<em>✓</em>` : ""} · ${escapeHtml(lifecycleCompactLabel())}</span>
        <span class="journalArticleType">${escapeHtml(journalProfile?.articleType || "Research Article")}</span>
        <span class="journalMetric">단어 수: ${escapeHtml(wordCount.toLocaleString(state.locale === "ko" ? "ko-KR" : "en-US"))}</span>
        <span class="journalMetric">그림: ${escapeHtml(figureCount)}</span>
        <span class="journalMetric">참고문헌: ${escapeHtml(referenceCount)}</span>
        <button class="primaryButton journalSubmitButton" data-action="open-submission-sheet" ${!claimReady ? `disabled title="${escapeHtml(claimGateReason)}"` : ""}>제출본 검사</button>
      </header>
      <div class="manuscriptEditorToolbar manuscriptToolbar">
        <span class="visuallyHidden">Manuscript · immutable v${escapeHtml(manuscript.currentVersion)}</span>
        <div class="manuscriptViewSwitch" role="group" aria-label="원고 보기"><button data-manuscript-view="write" aria-pressed="${state.manuscriptView === "write"}">Write</button><button data-manuscript-view="preview" aria-pressed="${state.manuscriptView === "preview"}">Preview</button></div>
        <div class="manuscriptStatus" data-manuscript-status data-state="${state.manuscriptSaveError ? "error" : draft.dirty ? "dirty" : "saved"}">${escapeHtml(status)}</div>
        <div class="manuscriptToolbarActions"><button class="secondaryButton manuscriptInspectorToggle" data-action="toggle-manuscript-inspector" aria-controls="manuscript-submission-inspector" aria-pressed="${state.manuscriptInspectorOpen}">제출 준비</button><button class="secondaryButton" data-action="ask-manuscript-review">AI 검토 요청</button><button class="primaryButton" data-action="save-manuscript" ${!draft.dirty || state.manuscriptSaving ? "disabled" : ""}>${state.manuscriptSaving ? "저장 중…" : "새 버전 저장"}</button></div>
      </div>
      <div class="manuscriptWorkGrid" data-inspector-open="${state.manuscriptInspectorOpen}">
        <aside class="manuscriptOutline" aria-label="원고 목차"><header><strong>Manuscript</strong><span>v${escapeHtml(manuscript.currentVersion)}</span></header><nav>${outlineRows}</nav></aside>
        <div class="manuscriptCanvas">${canvas}</div>
        <button class="manuscriptInspectorScrim" type="button" data-action="toggle-manuscript-inspector" aria-label="제출 준비 패널 닫기"></button>
        <aside class="manuscriptInspector" id="manuscript-submission-inspector" aria-label="제출 준비와 근거 검사" tabindex="-1">
          <section><div class="manuscriptInspectorLabel">Submission readiness</div><div class="readinessMetric"><strong>${escapeHtml(readiness.sectionCount)}/5</strong><span>핵심 섹션</span></div><div class="readinessRows">${readiness.sections.map((item) => `<div data-ready="${item.ready}"><span>${item.ready ? "✓" : "○"}</span><strong>${escapeHtml(item.name)}</strong></div>`).join("")}<div data-ready="${readiness.evidenceCount > 0}"><span>${readiness.evidenceCount > 0 ? "✓" : "○"}</span><strong>evidence bindings · ${escapeHtml(readiness.evidenceCount)}</strong></div><div data-ready="${readiness.journalProfileReady}"><span>${readiness.journalProfileReady ? "✓" : "○"}</span><strong>journal profile · ${readiness.journalProfileReady ? "공식 스냅샷 고정" : "선택 필요"}</strong></div></div></section>
          <section><div class="manuscriptInspectorLabel">Claim &amp; evidence ledger</div><div class="journalValidationSummary" data-status="${claimReady ? "ready" : "blocked"}"><strong>${claimReady ? "ready" : "blocked"}</strong><span>${claimSummary}</span></div>${claimHistory}</section>
          <section class="journalProfileSection"><div class="manuscriptInspectorLabel">Journal submission</div>${journalPanel}</section>
          <section><div class="manuscriptInspectorLabel">Evidence bindings</div><div class="manuscriptBindingList">${bindings}</div></section>
          <section class="manuscriptIntegrity"><div class="manuscriptInspectorLabel">Integrity</div><dl><div><dt>Content</dt><dd><code>${escapeHtml(draft.baseContentSha256.slice(0, 16))}…</code></dd></div><div><dt>Bindings</dt><dd><code>${escapeHtml(manuscript.version.bindingManifestSha256.slice(0, 16))}…</code></dd></div></dl></section>
        </aside>
      </div>
    </section>`;
  }

  async function saveManuscriptDraft() {
    const manuscript = manuscriptById(state.selectedManuscriptId);
    const draft = state.manuscriptDraft;
    if (!manuscript || !draft || !draft.dirty || state.manuscriptSaving) return;
    state.manuscriptSaving = true;
    state.manuscriptSaveError = "";
    render();
    try {
      const result = await science.manuscripts.appendVersion({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        manuscriptId: manuscript.id,
        expectedVersion: draft.baseVersion,
        expectedContentSha256: draft.baseContentSha256,
        markdown: draft.markdown,
        bindings: draft.bindings,
      });
      const saved = result.manuscript;
      state.manuscripts = [saved, ...state.manuscripts.filter((item) => item.id !== saved.id)];
      state.manuscriptDraft = manuscriptDraftFrom(saved);
      state.claimLedger = null;
      try { state.claimLedger = await science.claimLedgers.getForManuscript(state.selectedId, saved.id); }
      catch { state.claimLedger = null; }
      state.manuscriptSaving = false;
      ensureManuscriptWorkspaceTab(saved);
      render();
      void queueWorkspacePersistence();
    } catch (error) {
      state.manuscriptSaving = false;
      state.manuscriptSaveError = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  async function connectActiveArtifactToManuscript() {
    if (state.artifactBindingBusy || state.inspectedArtifactVersion || !state.selectedId || !state.selectedArtifactId) return;
    const artifact = state.artifacts.find((item) => item.id === state.selectedArtifactId);
    if (!artifact) return;
    if (state.vegaDraft?.dirty) {
      state.artifactBindingError = "편집 중인 시각 자료를 먼저 새 immutable version으로 저장해 주세요.";
      render();
      return;
    }
    if (artifact.version?.payload?.schema === "agentlas.science.statistics-figure-artifact/v1") {
      state.artifactBindingError = "통계 Figure 원본 캡처는 원고에 연결하지 않습니다. 먼저 PNG 300/600dpi를 내보낸 뒤 생성된 exact image 아티팩트를 연결하세요.";
      render();
      return;
    }
    state.artifactBindingBusy = true;
    state.artifactBindingError = "";
    const action = document.querySelector('[data-action="bind-artifact-manuscript"]');
    if (action) { action.disabled = true; action.textContent = "검증 중…"; }
    try {
      const capture = await science.artifacts.capture({
        projectId: artifact.projectId,
        artifactId: artifact.id,
        artifactVersion: artifact.version.version,
        contentSha256: artifact.version.contentSha256,
      });
      const validation = capture?.publicationValidation || await science.validations.validate({
        requestId: crypto.randomUUID(),
        projectId: artifact.projectId,
        artifactId: artifact.id,
        artifactVersion: artifact.version.version,
      });
      const target = validation?.bindingTarget;
      if (!target || target.kind !== "artifact") throw new Error("검증된 원고 binding target을 만들지 못했습니다.");
      const activeManuscript = manuscriptById(state.selectedManuscriptId) || state.manuscripts[0] || null;
      const role = String(artifact.kind || "").includes("table") ? "table" : "figure";
      if (!activeManuscript) {
        state.pendingManuscriptBinding = { ordinal: 1, role, locator: role === "table" ? "Table 1" : "Figure 1", target };
        state.artifactBindingBusy = false;
        state.manuscriptModal = true;
        render();
        return;
      }
      await openManuscript(activeManuscript.id);
      const draft = state.manuscriptDraft;
      if (!draft) throw new Error("원고 초안을 열지 못했습니다.");
      const duplicate = draft.bindings.some((binding) => binding.target.kind === "artifact"
        && binding.target.artifactId === target.artifactId
        && binding.target.artifactVersion === target.artifactVersion);
      if (!duplicate) {
        const nextOrdinal = Math.max(0, ...draft.bindings.map((binding) => Number(binding.ordinal) || 0)) + 1;
        const roleCount = draft.bindings.filter((binding) => binding.role === role).length + 1;
        draft.bindings = [...draft.bindings, {
          ordinal: nextOrdinal,
          role,
          locator: `${role === "table" ? "Table" : "Figure"} ${roleCount}`,
          target,
        }];
        draft.dirty = true;
        setActiveWorkspaceTabDirty(true);
      }
      state.artifactBindingBusy = false;
      render();
    } catch (error) {
      state.artifactBindingBusy = false;
      state.artifactBindingError = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  async function openLab(labId, artifactId, originVersion = null, returnMessageId = null, exactVersion = null) {
    rememberScroll();
    const owningGroup = labGroups.find((group) => group.labIds.includes(labId));
    if (owningGroup) state.expandedLabGroups = new Set([owningGroup.id]);
    const fallbackArtifactId = (state.labContextsById.get(labId) || [])[0]?.artifact?.id || null;
    const nextArtifactId = artifactId || fallbackArtifactId;
    const nextArtifact = artifactForLab(labId, nextArtifactId);
    if (nextArtifact) ensureArtifactWorkspaceTab(labId, nextArtifactId, exactVersion || originVersion || nextArtifact.currentVersion, originVersion, returnMessageId);
    else ensureLabWorkspaceTab(labId);
    state.selectedLabId = labId;
    if (state.selectedArtifactId !== nextArtifactId) {
      state.vegaDraft = null;
      state.vegaSaveError = "";
    }
    state.selectedArtifactId = nextArtifactId;
    state.selectedArtifactOriginVersion = originVersion;
    state.returnMessageId = returnMessageId;
    state.inspectedArtifactVersion = null;
    state.inspectedArtifactContext = null;
    state.artifactComparison = null;
    state.draftHistoryGuard = null;
    state.historyOpen = false;
    state.mode = "lab";
    state.drawer = null;
    render();
    void queueWorkspacePersistence();
    if (!nextArtifactId) return;
    if (state.artifactHistoryById.has(nextArtifactId)) {
      return;
    }
    try {
      const history = await science.artifacts.history(state.selectedId, nextArtifactId);
      if (!history || history.artifactId !== nextArtifactId) throw new Error("아티팩트 버전 기록을 불러오지 못했습니다.");
      state.artifactHistoryById.set(nextArtifactId, history);
      if (state.mode === "lab" && state.selectedArtifactId === nextArtifactId) {
        render();
      }
    } catch (error) {
      state.artifactHistoryById.set(nextArtifactId, { error: error instanceof Error ? error.message : String(error), entries: [] });
      if (state.mode === "lab" && state.selectedArtifactId === nextArtifactId) render();
    }
  }

  async function importCsvDataset() {
    if (state.datasetImportBusy || !state.selectedId) return;
    const conversation = selectedConversation();
    const originMessage = [...state.messages].reverse().find((message) => message.role === "user");
    if (!conversation || !originMessage || !science.datasets?.importCsv) {
      state.datasetImportError = "현재 연구 대화와 연결된 CSV 가져오기 런타임을 찾지 못했습니다.";
      render();
      return;
    }
    state.datasetImportBusy = true;
    state.datasetImportError = "";
    render();
    try {
      const result = await science.datasets.importCsv({
        requestId: crypto.randomUUID(),
        artifactRequestId: crypto.randomUUID(),
        projectId: state.selectedId,
        conversationId: conversation.id,
        originMessageId: originMessage.id,
      });
      if (result?.canceled) {
        state.datasetImportBusy = false;
        render();
        return;
      }
      if (!result?.artifact?.id || result.artifact.version?.rendererId !== "agentlas.table") throw new Error("CSV는 저장됐지만 검증된 Data Table 아티팩트를 만들지 못했습니다.");
      const projectId = state.selectedId;
      state.datasetImportBusy = false;
      await selectProject(projectId, { preserveWorkspace: true });
      await openLab("data-table", result.artifact.id, null, originMessage.id, result.artifact.currentVersion);
    } catch (error) {
      state.datasetImportBusy = false;
      state.datasetImportError = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function statisticsLaunchCard() {
    normalizeStatisticsLaunchSelection();
    const tables = statisticsSourceTables();
    const artifact = statisticsSourceTable();
    const columns = statisticsEligibleColumns(artifact);
    const timeColumns = columns.filter((column) => ["integer", "number"].includes(column.logicalType));
    const eventColumns = columns;
    if (!tables.length) {
      return `<section class="emptyView labStartView" data-empty-source="science.sqlite" data-statistics-launch><div class="labStartCard"><span class="researchKicker">Data & Statistics · ${escapeHtml(lifecycleLabel())}</span><strong>먼저 검증된 Data Table을 준비하세요.</strong><p>Kaplan–Meier 분석은 임의 배열을 만들지 않습니다. CSV에서 생성된 exact Data Table version과 content hash를 선택한 뒤 해당 행만 결정적으로 투영합니다.</p><dl><div><dt>입력</dt><dd>Data Table artifact version</dd></div><div><dt>계산</dt><dd>time · event exact projection</dd></div><div><dt>보존</dt><dd>source · run · artifact lineage</dd></div></dl><button class="primaryButton" data-lab-id="data-table">Data Table 준비하기</button></div></section>`;
    }
    const sourceOptions = tables.map((table) => `<option value="${escapeHtml(table.id)}" ${table.id === artifact?.id ? "selected" : ""}>${escapeHtml(table.title)} · v${escapeHtml(table.currentVersion)}</option>`).join("");
    const timeOptions = timeColumns.map((column) => `<option value="${escapeHtml(column.name)}" ${column.name === state.statisticsLaunchTimeColumn ? "selected" : ""}>${escapeHtml(column.name)} · ${escapeHtml(column.logicalType)}</option>`).join("");
    const eventOptions = eventColumns.map((column) => `<option value="${escapeHtml(column.name)}" ${column.name === state.statisticsLaunchEventColumn ? "selected" : ""}>${escapeHtml(column.name)} · ${escapeHtml(column.logicalType)}</option>`).join("");
    const ready = Boolean(artifact && typeof artifact.id === "string" && artifact.id.length > 0 && artifact.id.length <= 160
      && timeColumns.some((column) => column.name === state.statisticsLaunchTimeColumn)
      && eventColumns.some((column) => column.name === state.statisticsLaunchEventColumn)
      && state.statisticsLaunchTimeColumn !== state.statisticsLaunchEventColumn
      && Number.isSafeInteger(artifact.currentVersion) && artifact.currentVersion === artifact.version?.version
      && /^[a-f0-9]{64}$/u.test(String(artifact.version?.contentSha256 || "")));
    const status = state.statisticsLaunchBusy
      ? `Research Director가 ${artifact?.title || "Data Table"} exact v${artifact?.currentVersion || ""} 실행을 요청하는 중입니다.`
      : "요청이 시작된 뒤에도 성공으로 표시하지 않습니다. 검증된 artifact가 도착하면 이 Lab에 별도 탭으로 열립니다.";
    return `<section class="emptyView labStartView" data-empty-source="science.sqlite" data-statistics-launch><div class="labStartCard statisticsLaunchCard"><span class="researchKicker">Data & Statistics · ${escapeHtml(lifecycleLabel())}</span><strong>Exact Data Table로 Kaplan–Meier 생존곡선을 만드세요.</strong><p>선택한 immutable table version에서 time/event 열을 Main runtime이 직접 투영합니다. UI나 연구 에이전트가 임의 데이터를 만들지 않습니다.</p><div class="statisticsLaunchGrid"><label class="field statisticsSourceField"><span>Source Data Table</span><select data-statistics-source-artifact>${sourceOptions}</select></label><label class="field"><span>Time column</span><select data-statistics-time-column>${timeOptions}</select></label><label class="field"><span>Event column · 0/1</span><select data-statistics-event-column>${eventOptions}</select></label></div><dl class="statisticsLaunchReceipt"><div><dt>Artifact</dt><dd><code title="${escapeHtml(artifact?.id || "")}">${escapeHtml(String(artifact?.id || "").slice(0, 16))}…</code></dd></div><div><dt>Version</dt><dd>v${escapeHtml(artifact?.currentVersion || "")} · immutable</dd></div><div><dt>Content</dt><dd><code title="${escapeHtml(artifact?.version?.contentSha256 || "")}">${escapeHtml(String(artifact?.version?.contentSha256 || "").slice(0, 16))}…</code></dd></div></dl><button class="primaryButton" data-action="request-statistics-run" ${!ready || state.statisticsLaunchBusy ? "disabled" : ""}>${state.statisticsLaunchBusy ? "Exact version 실행 요청 중…" : "Research Director에게 exact run 요청"}</button><p class="statisticsLaunchStatus">${escapeHtml(status)}</p>${state.statisticsLaunchError ? `<p class="labStartError" role="alert">${escapeHtml(state.statisticsLaunchError)}</p>` : ""}</div></section>`;
  }

  async function requestSourceBoundKaplanMeier() {
    if (state.statisticsLaunchBusy || !state.selectedId) return;
    normalizeStatisticsLaunchSelection();
    const artifact = statisticsSourceTable();
    const columns = statisticsEligibleColumns(artifact);
    const timeColumn = columns.find((column) => column.name === state.statisticsLaunchTimeColumn && ["integer", "number"].includes(column.logicalType));
    const eventColumn = columns.find((column) => column.name === state.statisticsLaunchEventColumn);
    const artifactVersion = Number(artifact?.currentVersion);
    const contentSha256 = String(artifact?.version?.contentSha256 || "");
    if (!artifact || artifact.kind !== "table" || artifact.version?.payload?.schema !== "agentlas.science-table/v1"
      || typeof artifact.id !== "string" || artifact.id.length < 1 || artifact.id.length > 160
      || !Number.isSafeInteger(artifactVersion) || artifactVersion < 1 || artifact.version?.version !== artifactVersion
      || !/^[a-f0-9]{64}$/u.test(contentSha256) || !timeColumn || !eventColumn || timeColumn.name === eventColumn.name
      || timeColumn.name.length > 160 || eventColumn.name.length > 160) {
      state.statisticsLaunchError = "정확한 Data Table ID·version·content hash와 서로 다른 time/event 열을 모두 확인해야 실행할 수 있습니다.";
      render();
      return;
    }
    const inputArtifact = { artifact_id: artifact.id, artifact_version: artifactVersion, content_sha256: contentSha256 };
    const sourceLabel = String(artifact.title || "Kaplan-Meier").slice(0, 128);
    const toolRequest = {
      tool: "run_statistical_analysis",
      arguments: {
        tool_call_id: `statistics-kaplan-meier-${crypto.randomUUID()}`,
        request: {
          schema: "agentlas.science.statistics.request/v1",
          method: "kaplan_meier",
          options: { confidenceLevel: 0.95, timeoutMs: 5000 },
          execution: { purpose: "descriptive", input_artifacts: [inputArtifact], analysis_spec: null },
        },
        source_table: {
          ...inputArtifact,
          time_column: timeColumn.name,
          event_column: eventColumn.name,
          label: sourceLabel,
        },
      },
    };
    state.statisticsLaunchBusy = true;
    state.statisticsLaunchError = "";
    state.composerDraft = i18n.prompt("statisticsRun", {
      title: artifact.title,
      artifactVersion,
      contentSha256,
      timeColumn: timeColumn.name,
      eventColumn: eventColumn.name,
      request: JSON.stringify(toolRequest),
    });
    render();
    try {
      await startComposerTurn({ forceAppend: true });
      if (state.composerError) state.statisticsLaunchError = state.composerError;
    } finally {
      state.statisticsLaunchBusy = false;
      render();
    }
  }

  function statisticsFigureActionError(error, artifact, action) {
    const code = error instanceof Error ? error.message : String(error);
    if (code.includes("version-conflict") || code.includes("statistics-figure-parent-invalid")) {
      const version = artifact?.version?.version || artifact?.currentVersion || "?";
      const sha256 = String(artifact?.version?.contentSha256 || "");
      return `${action} 실패 · exact immutable binding 충돌: ${artifact?.id || "artifact"} v${version} · ${sha256 || "hash 없음"}. 현재 버전을 다시 연 뒤 재시도하세요. (${code})`;
    }
    return `${action} 실패 · ${code}`;
  }

  async function materializeStatisticsFigure(target) {
    if (state.figureActionBusy || !state.selectedId || !state.selectedArtifactId) return;
    const projectId = state.selectedId;
    const artifact = state.artifacts.find((item) => item.id === state.selectedArtifactId);
    const visualizationIndex = Number(target.dataset.visualizationIndex);
    const existingFigureId = target.dataset.figureArtifactId || "";
    if (!artifact || artifact.version?.payload?.schema !== "agentlas.science.statistics-analysis-artifact/v1"
      || !Number.isSafeInteger(visualizationIndex) || visualizationIndex < 0) return;
    state.figureActionBusy = true;
    state.figureActionError = "";
    state.figureActionNotice = "";
    render();
    try {
      let figure = null;
      if (existingFigureId) {
        figure = (await science.artifacts.listStatisticsFigures(projectId, artifact.id)).find((item) => item.id === existingFigureId) || null;
        if (!figure) throw new Error("science-statistics-figure-not-found");
      } else {
        const result = await science.artifacts.materializeStatisticsFigure({
          requestId: crypto.randomUUID(),
          projectId,
          statisticsArtifactId: artifact.id,
          statisticsArtifactVersion: artifact.version.version,
          statisticsArtifactContentSha256: artifact.version.contentSha256,
          visualizationIndex,
          title: String(target.dataset.figureTitle || "").slice(0, 240) || undefined,
        });
        if (!result?.artifact?.id || result.parent?.artifactId !== artifact.id
          || result.parent?.artifactVersion !== artifact.version.version
          || result.parent?.contentSha256 !== artifact.version.contentSha256) {
          throw new Error("science-statistics-figure-materialization-binding-invalid");
        }
        figure = result.artifact;
      }
      state.figureActionBusy = false;
      await selectProject(projectId, { preserveWorkspace: true });
      if (!artifactForLab("data-visualization", figure.id)) throw new Error("science-statistics-figure-lab-binding-missing");
      state.figureActionNotice = existingFigureId ? "저장된 Figure를 exact version으로 열었습니다." : "독립 Figure 아티팩트를 Figure Lab에 저장했습니다.";
      await openLab("data-visualization", figure.id, null, null, figure.currentVersion);
    } catch (error) {
      state.figureActionBusy = false;
      state.figureActionError = statisticsFigureActionError(error, artifact, "Figure Lab 저장");
      render();
    }
  }

  async function exportStatisticsFigureSvg() {
    if (state.figureActionBusy || !state.selectedId || !state.selectedArtifactId) return;
    const artifact = state.artifacts.find((item) => item.id === state.selectedArtifactId);
    if (!artifact || artifact.version?.payload?.schema !== "agentlas.science.statistics-figure-artifact/v1") return;
    state.figureActionBusy = true;
    state.figureActionError = "";
    state.figureActionNotice = "";
    render();
    try {
      const result = await science.artifacts.exportStatisticsFigureSvg({
        projectId: state.selectedId,
        artifactId: artifact.id,
        artifactVersion: artifact.version.version,
        contentSha256: artifact.version.contentSha256,
      });
      if (result?.schema !== "agentlas.science.statistics-figure-svg-export/v1" || result.mimeType !== "image/svg+xml"
        || result.artifactId !== artifact.id || result.artifactVersion !== artifact.version.version
        || result.contentSha256 !== artifact.version.contentSha256 || typeof result.svg !== "string") {
        throw new Error("science-statistics-figure-svg-export-binding-invalid");
      }
      const fileStem = String(artifact.title || "science-figure").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "science-figure";
      const url = URL.createObjectURL(new Blob([result.svg], { type: result.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileStem}-v${artifact.version.version}.svg`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      state.figureActionNotice = `SVG 내보내기 완료 · ${result.width}×${result.height} · ${result.byteSize.toLocaleString()} bytes · ${String(result.sha256).slice(0, 12)}…`;
    } catch (error) {
      state.figureActionError = statisticsFigureActionError(error, artifact, "SVG 내보내기");
    } finally {
      state.figureActionBusy = false;
      render();
    }
  }

  async function exportStatisticsFigurePng() {
    if (state.figureActionBusy || !state.selectedId || !state.selectedArtifactId) return;
    const artifact = state.artifacts.find((item) => item.id === state.selectedArtifactId);
    if (!artifact || artifact.version?.payload?.schema !== "agentlas.science.statistics-figure-artifact/v1") return;
    state.figureActionBusy = true;
    state.figureActionError = "";
    state.figureActionNotice = "";
    render();
    try {
      const result = await science.artifacts.exportStatisticsFigurePng({
        projectId: state.selectedId,
        artifactId: artifact.id,
        artifactVersion: artifact.version.version,
        contentSha256: artifact.version.contentSha256,
        dpi: 600,
      });
      if (result?.schema !== "agentlas.science.statistics-figure-png-export/v1" || result.mimeType !== "image/png"
        || result.exportProfile !== "journal-raster-600dpi" || result.dpi !== 600 || result.colorSpace !== "srgb" || result.background !== "#ffffff"
        || result.artifactId !== artifact.id || result.artifactVersion !== artifact.version.version
        || result.contentSha256 !== artifact.version.contentSha256 || typeof result.dataBase64 !== "string"
        || !result.exportArtifact || result.exportArtifact.kind !== "image" || !result.exportArtifact.id
        || !Number.isSafeInteger(result.exportArtifact.version) || result.exportArtifact.version < 1
        || !/^[a-f0-9]{64}$/.test(String(result.exportArtifact.contentSha256 || ""))
        || !result.exportArtifact.captureId || result.exportArtifact.captureSha256 !== result.sha256
        || result.exportArtifact.exportSha256 !== result.sha256
        || !/^[a-f0-9]{64}$/.test(String(result.exportArtifact.exportReceiptSha256 || ""))) {
        throw new Error("science-statistics-figure-png-export-binding-invalid");
      }
      const binary = atob(result.dataBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (bytes.byteLength !== result.byteSize) throw new Error("science-statistics-figure-png-export-size-mismatch");
      const fileStem = String(artifact.title || "science-figure").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "science-figure";
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileStem}-v${artifact.version.version}-600dpi.png`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      const projectId = state.selectedId;
      const exportArtifactId = result.exportArtifact.id;
      const exportArtifactVersion = result.exportArtifact.version;
      await selectProject(projectId, { preserveWorkspace: true });
      if (!artifactForLab("data-visualization", exportArtifactId)) throw new Error("science-statistics-figure-raster-lab-binding-missing");
      state.figureActionNotice = `원고용 PNG 아티팩트 생성 · 600dpi · sRGB · ${String(result.exportArtifact.exportReceiptSha256).slice(0, 12)}…`;
      await openLab("data-visualization", exportArtifactId, null, null, exportArtifactVersion);
    } catch (error) {
      state.figureActionError = statisticsFigureActionError(error, artifact, "PNG 600dpi 내보내기");
    } finally {
      state.figureActionBusy = false;
      render();
    }
  }

  async function exportNumericSurfacePng() {
    if (state.figureActionBusy || !state.selectedId || !state.selectedArtifactId) return;
    const artifact = state.artifacts.find((item) => item.id === state.selectedArtifactId);
    if (!artifact || artifact.kind !== "chart.numeric-3d" || artifact.version?.rendererId !== "agentlas.three-numeric"
      || artifact.version?.payload?.schema !== "agentlas.science.numeric-surface-artifact/v2") return;
    const liveCanvas = document.querySelector(`[data-artifact-host="${CSS.escape(artifact.id)}"] canvas[data-numeric-surface-ready="true"]`);
    if (!liveCanvas || liveCanvas.dataset.viewStateDurable !== "true") {
      state.figureActionError = "PNG 600dpi 내보내기 실패 · 현재 3D view가 SQLite에 저장된 뒤 다시 시도하세요.";
      render();
      return;
    }
    state.figureActionBusy = true;
    state.figureActionError = "";
    state.figureActionNotice = "";
    render();
    try {
      const viewStateReceipt = await science.artifacts.getNumericSurfaceViewState(
        state.selectedId,
        artifact.id,
        artifact.version.version,
        artifact.version.contentSha256,
      );
      if (!viewStateReceipt || viewStateReceipt.artifactId !== artifact.id
        || viewStateReceipt.artifactVersion !== artifact.version.version
        || viewStateReceipt.artifactContentSha256 !== artifact.version.contentSha256) {
        throw new Error("science-numeric-surface-png-view-state-stale");
      }
      const exported = await renderNumericSurfacePublicationPng(artifact, viewStateReceipt, {
        width: 2008,
        height: 1506,
        dpi: 600,
      });
      const result = await science.artifacts.exportNumericSurfacePng({
        projectId: state.selectedId,
        artifactId: artifact.id,
        artifactVersion: artifact.version.version,
        contentSha256: artifact.version.contentSha256,
        rendered: exported.rendered,
        png: exported.png,
        readbackRgba: exported.readbackRgba,
      });
      if (result?.schema !== NUMERIC_SURFACE_PNG_EXPORT_SCHEMA || result.mimeType !== "image/png"
        || result.renderMode !== "three-offscreen-webgl" || result.renderer?.id !== NUMERIC_SURFACE_RENDERER
        || result.renderer?.version !== artifact.version.rendererVersion || result.renderer?.outputColorSpace !== "srgb"
        || result.exportProfile !== "journal-raster-600dpi" || result.dpi !== 600
        || result.width !== 2008 || result.height !== 1506 || result.colorSpace !== "srgb" || result.background !== "#ffffff"
        || result.artifactId !== artifact.id || result.artifactVersion !== artifact.version.version
        || result.contentSha256 !== artifact.version.contentSha256 || result.surfaceArtifact?.payloadSha256 !== artifact.version.payload.payloadSha256
        || result.viewStateReceiptSha256 !== exported.rendered.viewStateReceiptSha256
        || result.readback?.rgbaSha256 !== exported.rendered.readback.rgbaSha256
        || result.sha256 !== exported.rendered.sha256 || result.byteSize !== exported.png.byteLength
        || typeof result.dataBase64 !== "string" || result.dataBase64 !== exported.rendered.dataBase64
        || !result.exportArtifact || result.exportArtifact.kind !== "image" || !result.exportArtifact.id
        || !Number.isSafeInteger(result.exportArtifact.version) || result.exportArtifact.version < 1
        || !/^[a-f0-9]{64}$/.test(String(result.exportArtifact.contentSha256 || ""))
        || !result.exportArtifact.captureId || result.exportArtifact.captureSha256 !== result.sha256
        || result.exportArtifact.exportSha256 !== result.sha256
        || !/^[a-f0-9]{64}$/.test(String(result.exportArtifact.exportReceiptSha256 || ""))) {
        throw new Error("science-numeric-surface-png-export-binding-invalid");
      }
      const fileStem = String(artifact.title || "numeric-surface").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "numeric-surface";
      const url = URL.createObjectURL(new Blob([exported.png], { type: "image/png" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileStem}-v${artifact.version.version}-2008x1506-600dpi.png`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      const projectId = state.selectedId;
      const exportArtifactId = result.exportArtifact.id;
      const exportArtifactVersion = result.exportArtifact.version;
      await selectProject(projectId, { preserveWorkspace: true });
      if (!artifactForLab("data-visualization", exportArtifactId)) throw new Error("science-numeric-surface-raster-lab-binding-missing");
      state.figureActionNotice = `3D 원고용 PNG 생성 · 2008×1506 · 600dpi · sRGB · ${String(result.exportArtifact.exportReceiptSha256).slice(0, 12)}…`;
      await openLab("data-visualization", exportArtifactId, null, null, exportArtifactVersion);
    } catch (error) {
      state.figureActionError = statisticsFigureActionError(error, artifact, "3D PNG 600dpi 내보내기");
    } finally {
      state.figureActionBusy = false;
      render();
    }
  }

  async function exportStatisticsFigurePublicationBinary(format) {
    if (state.figureActionBusy || !state.selectedId || !state.selectedArtifactId || !["pdf", "tiff"].includes(format)) return;
    const artifact = state.artifacts.find((item) => item.id === state.selectedArtifactId);
    if (!artifact || artifact.version?.payload?.schema !== "agentlas.science.statistics-figure-artifact/v1") return;
    state.figureActionBusy = true;
    state.figureActionError = "";
    state.figureActionNotice = "";
    render();
    try {
      const method = format === "pdf" ? "exportStatisticsFigurePdf" : "exportStatisticsFigureTiff";
      const result = await science.artifacts[method]({
        projectId: state.selectedId,
        artifactId: artifact.id,
        artifactVersion: artifact.version.version,
        contentSha256: artifact.version.contentSha256,
        dpi: 600,
        widthMm: 85,
        colorSpace: "srgb",
      });
      const schema = `agentlas.science.statistics-figure-${format}-export/v1`;
      const mimeType = format === "pdf" ? "application/pdf" : "image/tiff";
      const exportProfile = `journal-raster-${format}-600dpi`;
      if (result?.schema !== schema || result.mimeType !== mimeType || result.exportProfile !== exportProfile
        || result.dpi !== 600 || result.colorSpace !== "srgb" || result.background !== "#ffffff"
        || result.artifactId !== artifact.id || result.artifactVersion !== artifact.version.version
        || result.contentSha256 !== artifact.version.contentSha256 || typeof result.dataBase64 !== "string"
        || !/^[a-f0-9]{64}$/.test(String(result.sha256 || ""))
        || !/^[a-f0-9]{64}$/.test(String(result.iccProfileSha256 || ""))) {
        throw new Error(`science-statistics-figure-${format}-export-binding-invalid`);
      }
      const binary = atob(result.dataBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (bytes.byteLength !== result.byteSize) throw new Error(`science-statistics-figure-${format}-export-size-mismatch`);
      const fileStem = String(artifact.title || "science-figure").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "science-figure";
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileStem}-v${artifact.version.version}-600dpi.${format === "tiff" ? "tif" : "pdf"}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      state.figureActionNotice = `${format.toUpperCase()} 내보내기 완료 · 600dpi · sRGB ICC · ${result.width}×${result.height}px · ${String(result.sha256).slice(0, 12)}…`;
    } catch (error) {
      state.figureActionError = statisticsFigureActionError(error, artifact, `${format.toUpperCase()} 600dpi 내보내기`);
    } finally {
      state.figureActionBusy = false;
      render();
    }
  }

  async function openConversationArtifact(target) {
    if (!state.selectedId) return;
    const artifactVersion = Number(target.dataset.inlineArtifactVersion || target.dataset.chatArtifactVersion);
    if (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1) return;
    try {
      const route = await science.artifacts.resolveConversationRoute(
        state.selectedId,
        target.dataset.inlineConversationId || target.dataset.chatConversationId || "",
        target.dataset.inlineMessageId || target.dataset.chatMessageId || "",
        target.dataset.inlineArtifactId || target.dataset.chatArtifactId || "",
        artifactVersion,
      );
      if (!route || route.schema !== "agentlas.science-conversation-artifact-route/v1") throw new Error("science-conversation-artifact-route-not-found");
      if (!artifactForLab(route.labId, route.artifactId)) await selectProject(state.selectedId, { preserveWorkspace: true });
      await openLab(route.labId, route.artifactId, route.originArtifactVersion, route.messageId);
    } catch {
      state.projectError = "대화 아티팩트와 Lab 보관소의 연결을 검증하지 못했습니다. 프로젝트 기록을 다시 불러와 주세요.";
      render();
    }
  }

  function returnToSession(destination = state.currentDestination) {
    const returnMessageId = state.returnMessageId;
    rememberScroll();
    state.mode = "session";
    state.currentDestination = projectDestinationIds.has(destination) && !["manuscript", "submission-archive"].includes(destination) ? destination : "overview";
    state.activeWorkspaceTabId = RESEARCH_TAB_ID;
    state.drawer = null;
    state.selectedArtifactOriginVersion = null;
    state.inspectedArtifactVersion = null;
    state.inspectedArtifactContext = null;
    state.artifactComparison = null;
    state.historyOpen = false;
    state.returnMessageId = null;
    compareEpoch += 1;
    render();
    void queueWorkspacePersistence();
    if (!returnMessageId) return;
    requestAnimationFrame(() => {
      const message = document.getElementById(`message-${returnMessageId}`);
      if (!message) return;
      message.scrollIntoView({ block: "center" });
      message.focus({ preventScroll: true });
    });
  }

  async function openConversation(conversationId) {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation || !state.selectedId) return;
    state.selectedConversationId = conversation.id;
    state.mode = "session";
    state.currentDestination = "overview";
    const tab = state.workspaceTabs.find((item) => item.kind === "conversation" && item.conversationId === conversation.id);
    state.activeWorkspaceTabId = tab?.id || RESEARCH_TAB_ID;
    state.drawer = null;
    state.projectError = "";
    render();
    try {
      await refreshConversationOnly(state.selectedId);
      void queueWorkspacePersistence();
    } catch (error) {
      state.projectError = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function navigateProjectDestination(destination) {
    if (!projectDestinationIds.has(destination)) return;
    if (destination === "manuscript" || destination === "submission-archive") {
      const manuscript = manuscriptById(state.selectedManuscriptId) || state.manuscripts[0] || null;
      if (!manuscript) {
        state.currentDestination = destination;
        state.manuscriptModal = true;
        render();
        void queueWorkspacePersistence({ navigation: true, tabs: false });
        return;
      }
      void openManuscript(manuscript.id).then(() => {
        if (destination === "submission-archive") {
          state.currentDestination = destination;
          state.manuscriptInspectorOpen = true;
          render();
          void queueWorkspacePersistence({ navigation: true, tabs: false });
        }
      });
      return;
    }
    returnToSession(destination);
  }

  function workspaceTabButtons() {
    return state.workspaceTabs.filter((tab) => tab.kind !== "research").map((tab) => {
      const selected = tab.id === state.activeWorkspaceTabId;
      const tabA11y = `id="${escapeHtml(workspaceTabDomId(tab.id))}" aria-controls="science-workspace-panel" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}"`;
      if (tab.kind === "manuscript") return `<span class="workspaceTabFrame workspaceManuscriptTab" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" data-manuscript-id="${escapeHtml(tab.manuscriptId)}" title="${escapeHtml(`${tab.title} · manuscript v${tab.exactVersion}`)}">${heroIcon("book", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span><span class="workspaceTabVersion">v${escapeHtml(tab.exactVersion)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(`${tab.title} 원고 탭 닫기`)}" title="탭 닫기">×</button></span>`;
      if (tab.kind === "conversation") return `<span class="workspaceTabFrame workspaceConversationTab" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(tab.title)}">${heroIcon("book", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(`${tab.title} 대화 탭 닫기`)}" title="탭 닫기">×</button></span>`;
      if (tab.kind === "lab") return `<span class="workspaceTabFrame" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(`${tab.title} Lab 시작 화면`)}">${heroIcon(labIcons[tab.labId] || "grid", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(`${tab.title} Lab 탭 닫기`)}" title="탭 닫기">×</button></span>`;
      return `<span class="workspaceTabFrame" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(`${labLabel(tab.labId)} · ${tab.title} · exact v${tab.exactVersion}`)}">${heroIcon(labIcons[tab.labId] || "grid", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span><span class="workspaceTabVersion">v${escapeHtml(tab.exactVersion)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(`${tab.title} v${tab.exactVersion} 탭 닫기`)}" title="탭 닫기">×</button></span>`;
    }).join("");
  }

  function researchWorkspaceTabButton() {
    const selected = state.activeWorkspaceTabId === RESEARCH_TAB_ID;
    return `<button class="workspaceTab workspaceResearchTab" role="tab" id="${workspaceTabDomId(RESEARCH_TAB_ID)}" aria-controls="science-workspace-panel" data-workspace-tab-id="${RESEARCH_TAB_ID}" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}">${heroIcon("book", "workspaceTabIcon")}<span class="workspaceTabLabel">Research</span></button>`;
  }

  function syncWorkspaceTabOverflow() {
    const viewport = document.querySelector("[data-workspace-tabs]");
    const shell = document.querySelector("[data-workspace-tabs-shell]");
    if (!viewport || !shell) return;
    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const hasOverflow = maxScroll > 1;
    shell.dataset.overflow = String(hasOverflow);
    const previous = shell.querySelector('[data-action="scroll-workspace-tabs"][data-direction="previous"]');
    const next = shell.querySelector('[data-action="scroll-workspace-tabs"][data-direction="next"]');
    if (previous) previous.hidden = !hasOverflow || viewport.scrollLeft <= 1;
    if (next) next.hidden = !hasOverflow || viewport.scrollLeft >= maxScroll - 1;
  }

  function revealActiveWorkspaceTab() {
    const viewport = document.querySelector("[data-workspace-tabs]");
    const active = viewport?.querySelector('[data-workspace-tab-id][aria-selected="true"]')?.closest(".workspaceTabFrame");
    if (!viewport) return;
    if (!active) { syncWorkspaceTabOverflow(); return; }
    const inset = 38;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < viewport.scrollLeft + inset) viewport.scrollLeft = Math.max(0, left - inset);
    else if (right > viewport.scrollLeft + viewport.clientWidth - inset) viewport.scrollLeft = Math.min(viewport.scrollWidth - viewport.clientWidth, right - viewport.clientWidth + inset);
    syncWorkspaceTabOverflow();
  }

  function renderWorkspaceTabs() {
    const tabs = document.querySelector("[data-workspace-tabs]");
    if (tabs) tabs.innerHTML = workspaceTabButtons();
    const research = document.querySelector('.workspaceResearchTab');
    if (research) {
      const selected = state.activeWorkspaceTabId === RESEARCH_TAB_ID;
      research.setAttribute('aria-selected', String(selected));
      research.tabIndex = selected ? 0 : -1;
    }
    requestAnimationFrame(revealActiveWorkspaceTab);
  }

  function activateWorkspaceTab(tabId) {
    if (!tabId || tabId === state.activeWorkspaceTabId) return;
    const tab = state.workspaceTabs.find((item) => item.id === tabId);
    if (!tab) return;
    const activate = () => {
      if (tab.kind === "research") {
        returnToSession();
        return;
      }
      if (tab.kind === "manuscript") {
        void openManuscript(tab.manuscriptId);
        return;
      }
      if (tab.kind === "conversation") {
        void openConversation(tab.conversationId);
        return;
      }
      if (tab.kind === "lab") {
        void openLab(tab.labId, null, null, null);
        return;
      }
      const artifact = artifactForLab(tab.labId, tab.artifactId);
      if (!artifact) return;
      const originVersion = Number.isSafeInteger(tab.originVersion)
        ? tab.originVersion
        : tab.exactVersion !== artifact.currentVersion ? tab.exactVersion : null;
      void openLab(tab.labId, tab.artifactId, originVersion, tab.returnMessageId, tab.exactVersion);
    };
    if (!guardArtifactDraftNavigation(activate)) activate();
  }

  function closeWorkspaceTab(tabId) {
    const index = state.workspaceTabs.findIndex((tab) => tab.id === tabId);
    if (index <= 0) return;
    const isActive = state.activeWorkspaceTabId === tabId;
    const close = () => {
      const nextTabs = state.workspaceTabs.filter((tab) => tab.id !== tabId);
      state.workspaceTabs = nextTabs.length ? nextTabs : [{ id: RESEARCH_TAB_ID, kind: "research" }];
      if (!isActive) {
        renderWorkspaceTabs();
        void queueWorkspacePersistence({ navigation: false, tabs: true });
        return;
      }
      const next = state.workspaceTabs[Math.max(0, index - 1)] || state.workspaceTabs[0];
      state.activeWorkspaceTabId = "";
      activateWorkspaceTab(next.id);
    };
    if (isActive && !guardArtifactDraftNavigation(close)) close();
    else if (!isActive) close();
  }

  function showDraftHistoryGuard(version) {
    const artifact = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact).find((item) => item.id === state.selectedArtifactId);
    const isMolstar = artifact?.version?.rendererId === "agentlas.molstar";
    state.draftHistoryGuard = { version };
    if (state.activeRendererInstance && science.renderers?.visibility) {
      state.activeRendererVisible = false;
      void science.renderers.visibility(false).catch(() => undefined);
    }
    document.querySelector("[data-draft-history-guard]")?.remove();
    root.insertAdjacentHTML("beforeend", `<div class="draftGuardBackdrop" data-draft-history-guard role="presentation"><section class="draftGuard" role="dialog" aria-modal="true" aria-labelledby="draft-guard-title"><div class="researchKicker">${isMolstar ? "Unsaved structure view" : "Unsaved chemistry draft"}</div><h2 id="draft-guard-title">저장하지 않은 ${isMolstar ? "구조 보기" : "구조"} 변경사항이 있습니다.</h2><p>과거 기록으로 이동하면 현재 ${isMolstar ? "Mol* 보기 초안" : "Ketcher 초안"}이 닫힙니다. 먼저 새 버전으로 저장하거나, 변경사항을 버린 뒤 기록을 확인하세요.</p><div><button data-action="keep-editing">계속 편집</button><button class="dangerButton" data-action="discard-draft-history" data-version="${escapeHtml(version)}">변경사항 버리고 v${escapeHtml(version)} 보기</button></div></section></div>`);
    document.querySelector('[data-action="keep-editing"]')?.focus();
  }

  function showVegaDraftGuard(onDiscard) {
    state.pendingDraftNavigation = onDiscard;
    document.querySelector("[data-draft-history-guard]")?.remove();
    root.insertAdjacentHTML("beforeend", `<div class="draftGuardBackdrop" data-draft-history-guard role="presentation"><section class="draftGuard" role="dialog" aria-modal="true" aria-labelledby="draft-guard-title"><div class="researchKicker">Unsaved visualization draft</div><h2 id="draft-guard-title">저장하지 않은 차트 변경사항이 있습니다.</h2><p>이 화면을 떠나면 현재 초안이 사라집니다. 새 버전으로 저장하거나 변경사항을 버린 뒤 이동하세요.</p><div><button data-action="keep-editing">계속 편집</button><button class="dangerButton" data-action="discard-vega-navigation">변경 버리고 이동</button></div></section></div>`);
    document.querySelector('[data-action="keep-editing"]')?.focus();
  }

  function guardVegaNavigation(onDiscard) {
    if (!state.vegaDraft?.dirty) return false;
    showVegaDraftGuard(onDiscard);
    return true;
  }

  function showManuscriptDraftGuard(onDiscard) {
    state.pendingDraftNavigation = onDiscard;
    document.querySelector("[data-draft-history-guard]")?.remove();
    root.insertAdjacentHTML("beforeend", `<div class="draftGuardBackdrop" data-draft-history-guard role="presentation"><section class="draftGuard" role="dialog" aria-modal="true" aria-labelledby="draft-guard-title"><div class="researchKicker">Unsaved manuscript draft</div><h2 id="draft-guard-title">저장하지 않은 원고 변경사항이 있습니다.</h2><p>다른 Research·Lab·원고 탭으로 이동하면 현재 초안이 사라집니다. immutable 새 버전으로 저장하거나 변경사항을 버린 뒤 이동하세요.</p><div><button data-action="keep-editing">계속 편집</button><button class="dangerButton" data-action="discard-manuscript-navigation">변경 버리고 이동</button></div></section></div>`);
    document.querySelector('[data-action="keep-editing"]')?.focus();
  }

  function showRendererDraftGuard(onDiscard) {
    const artifact = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact).find((item) => item.id === state.selectedArtifactId);
    const isMolstar = artifact?.version?.rendererId === "agentlas.molstar";
    state.pendingDraftNavigation = onDiscard;
    if (state.activeRendererInstance && science.renderers?.visibility) {
      state.activeRendererVisible = false;
      void science.renderers.visibility(false).catch(() => undefined);
    }
    document.querySelector("[data-draft-history-guard]")?.remove();
    root.insertAdjacentHTML("beforeend", `<div class="draftGuardBackdrop" data-draft-history-guard role="presentation"><section class="draftGuard" role="dialog" aria-modal="true" aria-labelledby="draft-guard-title"><div class="researchKicker">${isMolstar ? "Unsaved structure view" : "Unsaved chemistry draft"}</div><h2 id="draft-guard-title">저장하지 않은 ${isMolstar ? "구조 보기" : "구조"} 변경사항이 있습니다.</h2><p>이 화면을 떠나면 현재 초안이 사라집니다. 새 버전으로 저장하거나 변경사항을 버린 뒤 이동하세요.</p><div><button data-action="keep-editing">계속 편집</button><button class="dangerButton" data-action="discard-renderer-navigation">변경 버리고 이동</button></div></section></div>`);
    document.querySelector('[data-action="keep-editing"]')?.focus();
  }

  function showStoredWorkspaceDirtyGuard(onDiscard) {
    state.pendingDraftNavigation = onDiscard;
    document.querySelector("[data-draft-history-guard]")?.remove();
    root.insertAdjacentHTML("beforeend", `<div class="draftGuardBackdrop" data-draft-history-guard role="presentation"><section class="draftGuard" role="dialog" aria-modal="true" aria-labelledby="draft-guard-title"><div class="researchKicker">Unsaved workspace tab</div><h2 id="draft-guard-title">이 탭에 저장되지 않은 변경 표시가 남아 있습니다.</h2><p>현재 프로세스에서 초안 본문을 다시 확인할 수 없어 자동 저장됨으로 간주하지 않습니다. 계속 편집하거나 dirty 표시를 명시적으로 버린 뒤 이동하세요.</p><div><button data-action="keep-editing">계속 편집</button><button class="dangerButton" data-action="discard-workspace-navigation">dirty 표시 버리고 이동</button></div></section></div>`);
    document.querySelector('[data-action="keep-editing"]')?.focus();
  }

  function guardArtifactDraftNavigation(onDiscard) {
    if (state.mode === "manuscript" && state.manuscriptDraft?.dirty) {
      showManuscriptDraftGuard(onDiscard);
      return true;
    }
    if (guardVegaNavigation(onDiscard)) return true;
    if (state.activeRendererPhase === "dirty") {
      showRendererDraftGuard(onDiscard);
      return true;
    }
    if (state.workspaceTabs.find((tab) => tab.id === state.activeWorkspaceTabId)?.dirty) {
      showStoredWorkspaceDirtyGuard(onDiscard);
      return true;
    }
    return false;
  }

  async function inspectArtifactVersion(version, options = {}) {
    const labArtifacts = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact);
    const artifact = labArtifacts.find((item) => item.id === state.selectedArtifactId) || labArtifacts[0];
    if (!artifact) return;
    if (options.discardDirty && artifact.version.rendererId === "agentlas.vega") {
      state.vegaDraft = null;
      state.vegaSaveError = "";
      setActiveWorkspaceTabDirty(false);
    }
    if (version === artifact.currentVersion) {
      state.inspectedArtifactVersion = null;
      state.inspectedArtifactContext = null;
      render();
      return;
    }
    if (!options.discardDirty && ["agentlas.ketcher", "agentlas.molstar"].includes(artifact.version.rendererId) && state.activeRendererPhase === "dirty") {
      showDraftHistoryGuard(version);
      return;
    }
    if (!options.discardDirty && artifact.version.rendererId === "agentlas.vega" && state.vegaDraft?.dirty) {
      showVegaDraftGuard(() => void inspectArtifactVersion(version, { discardDirty: true }));
      return;
    }
    state.inspectedArtifactVersion = version;
    state.inspectedArtifactContext = null;
    render();
    try {
      const context = await science.artifacts.context(state.selectedId, artifact.id, version);
      if (!context || context.artifact.id !== artifact.id || context.selectedVersion.version !== version || context.isCurrent) throw new Error("과거 버전 기록을 검증하지 못했습니다.");
      if (state.mode === "lab" && state.selectedArtifactId === artifact.id && state.inspectedArtifactVersion === version) {
        state.inspectedArtifactContext = context;
        render();
      }
    } catch (error) {
      if (state.mode === "lab" && state.selectedArtifactId === artifact.id && state.inspectedArtifactVersion === version) {
        state.inspectedArtifactContext = { error: error instanceof Error ? error.message : String(error) };
        render();
      }
    }
  }

  function disposeComparePreviews() {
    for (const view of state.compareVegaViews) { try { view.finalize(); } catch {} }
    state.compareVegaViews = [];
    for (const url of state.comparePreviewUrls) { try { URL.revokeObjectURL(url); } catch {} }
    state.comparePreviewUrls = [];
  }

  function compareDetailMarkup(diff) {
    if (!diff?.detail) return "";
    if (diff.detail.kind === "chemistry") {
      const labels = {
        none: "검증된 분자 문서 차이가 없습니다.",
        "serialization-only": "분자 식별자는 같고 저장 직렬화만 달라졌습니다.",
        "same-identity-document-change": "같은 분자 식별자 안에서 문서 배치 또는 표현이 달라졌습니다.",
        "chemical-identity-change": "검증된 분자 식별자가 변경되었습니다.",
      };
      const metric = (label, value) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
      return `<div class="compareHeadline" data-diff-kind="${escapeHtml(diff.detail.classification)}"><strong>${escapeHtml(labels[diff.detail.classification] || diff.detail.classification)}</strong><span>원자 대응 관계를 계산하지 않았으며, 검증된 Indigo 식별자와 수치만 비교합니다.</span></div><div class="compareMetrics">${metric("원자", `${diff.detail.atomCount.from} → ${diff.detail.atomCount.to} · ${diff.detail.atomCount.delta >= 0 ? "+" : ""}${diff.detail.atomCount.delta}`)}${metric("결합", `${diff.detail.bondCount.from} → ${diff.detail.bondCount.to} · ${diff.detail.bondCount.delta >= 0 ? "+" : ""}${diff.detail.bondCount.delta}`)}${metric("Canonical SMILES", diff.detail.canonicalSmilesSha256.from === diff.detail.canonicalSmilesSha256.to ? "동일" : "변경됨")}</div>`;
    }
    if (diff.detail.kind === "vega") {
      const categories = Object.entries(diff.detail.categoryCounts || {}).filter(([, count]) => Number(count) > 0);
      return `<div class="compareHeadline"><strong>${diff.classification === "scientific-change" ? "차트 명세의 연구 관련 요소가 변경되었습니다." : "표현 또는 메타데이터만 변경되었습니다."}</strong><span>inline data 값은 노출하지 않고 canonical JSON 경로와 subtree hash로 비교했습니다.</span></div><div class="compareMetrics">${categories.map(([category, count]) => `<div><span>${escapeHtml(category)}</span><strong>${escapeHtml(count)}개</strong></div>`).join("") || `<div><span>명세</span><strong>차이 없음</strong></div>`}</div>`;
    }
    const detail = diff.detail;
    return `<div class="compareHeadline"><strong>${detail.structureBytesChanged ? "구조 소스가 변경되었습니다." : detail.interactionChanged ? "같은 구조 데이터에서 저장된 잔기 강조가 변경되었습니다." : detail.representationChanged ? "같은 구조 데이터에서 표현 방식만 변경되었습니다." : "구조 입력이 동일합니다."}</strong><span>검증된 구조 정렬 결과가 없으므로 RMSD는 표시하지 않습니다. 잔기 수는 원본 구조에서 다시 검증된 선택만 집계합니다.</span></div><div class="compareMetrics"><div><span>구조 bytes</span><strong>${detail.structureBytesChanged ? "변경됨" : "동일"}</strong></div><div><span>형식</span><strong>${escapeHtml(detail.from.format)} → ${escapeHtml(detail.to.format)}</strong></div><div><span>표현</span><strong>${escapeHtml(detail.from.representation)} → ${escapeHtml(detail.to.representation)}</strong></div><div><span>저장된 잔기</span><strong>${escapeHtml(detail.from.selectedResidueCount)} → ${escapeHtml(detail.to.selectedResidueCount)}</strong></div></div>`;
  }

  function artifactCompareMarkup(artifact, history) {
    const comparison = state.artifactComparison;
    if (!comparison || comparison.artifactId !== artifact.id) return "";
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const fromOptions = entries.map((entry) => `<option value="${escapeHtml(entry.version)}" ${entry.version === comparison.fromVersion ? "selected" : ""} ${entry.version >= comparison.toVersion ? "disabled" : ""}>v${escapeHtml(entry.version)}${entry.linkage.origin.surface === "conversation" ? " · 대화 원본" : entry.isCurrent ? " · 현재" : ""}</option>`).join("");
    const toOptions = entries.map((entry) => `<option value="${escapeHtml(entry.version)}" ${entry.version === comparison.toVersion ? "selected" : ""} ${entry.version <= comparison.fromVersion ? "disabled" : ""}>v${escapeHtml(entry.version)}${entry.isCurrent ? " · 현재" : ""}</option>`).join("");
    const dirtyLabel = artifact.rendererId === "agentlas.molstar" ? "Mol* 구조 보기" : "Ketcher 구조";
    const dirtyNotice = state.activeRendererPhase === "dirty" ? `<div class="compareDraftNotice">저장되지 않은 현재 ${dirtyLabel} 초안은 이 비교에 포함되지 않으며, 편집기에는 그대로 유지됩니다.</div>` : "";
    const pinnedNotice = artifact.currentVersion > comparison.toVersion ? `<div class="comparePinnedNotice">현재 버전은 v${escapeHtml(artifact.currentVersion)}입니다. 이 비교는 v${escapeHtml(comparison.fromVersion)}와 v${escapeHtml(comparison.toVersion)}에 고정되어 있습니다.</div>` : "";
    const body = comparison.loading
      ? `<div class="compareLoading" role="status" aria-live="polite">두 저장 버전의 무결성과 renderer 입력을 검증하는 중…</div>`
      : comparison.error
        ? `<div class="compareError" data-compare-error role="alert">${escapeHtml(comparison.error)}</div>`
        : comparison.diff
          ? `<div class="compareVisualGrid" aria-label="읽기 전용 시각 비교"><article class="comparePane" data-compare-pane="from" data-compare-left-version="${escapeHtml(comparison.fromVersion)}"><header><span>기준 버전</span><strong>v${escapeHtml(comparison.fromVersion)}</strong><code>${escapeHtml(comparison.diff.from.contentSha256.slice(0, 12))}…</code></header><div class="comparePreview" data-compare-preview-version="${escapeHtml(comparison.fromVersion)}" data-compare-side="from"></div></article><article class="comparePane" data-compare-pane="to" data-compare-right-version="${escapeHtml(comparison.toVersion)}"><header><span>비교 버전</span><strong>v${escapeHtml(comparison.toVersion)}</strong><code>${escapeHtml(comparison.diff.to.contentSha256.slice(0, 12))}…</code></header><div class="comparePreview" data-compare-preview-version="${escapeHtml(comparison.toVersion)}" data-compare-side="to"></div></article></div><section class="compareSummary"><div class="researchKicker">Deterministic renderer diff</div>${compareDetailMarkup(comparison.diff)}<div class="diffRows">${comparison.diff.changes.slice(0, 12).map((change) => `<div class="diffRow" data-diff-row data-diff-kind="${escapeHtml(change.kind)}"><span>${escapeHtml(change.kind)}</span><strong>${escapeHtml(change.category)}</strong><code>${escapeHtml(change.path)}</code></div>`).join("") || `<div class="diffEmpty">renderer payload의 구조 차이는 없습니다. semantic·provenance hash는 무결성 정보에서 별도로 비교됩니다.</div>`}</div>${comparison.diff.truncated ? `<div class="diffTruncated">전체 ${escapeHtml(comparison.diff.changeCount)}개 중 ${escapeHtml(comparison.diff.emittedChangeCount)}개를 검증된 순서로 표시합니다.</div>` : ""}<dl class="compareIntegrity"><div><dt>Diff receipt</dt><dd><code>${escapeHtml(comparison.diff.diffSha256.slice(0, 16))}…</code></dd></div><div><dt>Semantic</dt><dd>${comparison.diff.from.semanticSha256 === comparison.diff.to.semanticSha256 ? "동일" : "변경됨"}</dd></div><div><dt>Provenance</dt><dd>${comparison.diff.from.provenanceSha256 === comparison.diff.to.provenanceSha256 ? "동일" : "변경됨"}</dd></div></dl></section>`
          : "";
    return `<section class="artifactCompare" data-artifact-compare data-state="${escapeHtml(comparison.loading ? "loading" : comparison.error ? "error" : "ready")}"><header><div><span>비교 모드</span><strong>저장된 버전만 읽기 전용으로 표시됩니다.</strong></div><div class="compareSelectors"><label>기준 버전<select data-compare-selector="from">${fromOptions}</select></label><span>→</span><label>비교 버전<select data-compare-selector="to">${toOptions}</select></label><button data-action="close-compare">비교 종료</button></div></header>${dirtyNotice}${pinnedNotice}${body}</section>`;
  }

  async function hydrateArtifactComparePreviews(comparison) {
    if (!comparison?.diff || !comparison.fromContext || !comparison.toContext) return;
    const contexts = { from: comparison.fromContext, to: comparison.toContext };
    for (const host of document.querySelectorAll("[data-compare-preview-version]")) {
      const side = host.dataset.compareSide;
      const context = contexts[side];
      if (!context || !host.isConnected) continue;
      if (context.selectedVersion.rendererId === "agentlas.vega") {
        const spec = context.selectedVersion.payload?.spec;
        if (!spec || typeof spec !== "object" || Array.isArray(spec) || !window.vega || !window.vegaExpressionInterpreter) {
          host.textContent = "검증된 Vega 명세를 표시할 수 없습니다.";
          continue;
        }
        try {
          const runtime = window.vega.parse(spec, undefined, { ast: true });
          const view = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host);
          const width = Math.max(220, Math.floor(host.getBoundingClientRect().width) - 24);
          view.width(width).height(250);
          state.compareVegaViews.push(view);
          await view.runAsync();
        } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); }
        continue;
      }
      try {
        const preview = await science.artifacts.preview(state.selectedId, comparison.artifactId, context.selectedVersion.version);
        if (!preview?.bytes || !host.isConnected) {
          host.textContent = "이 버전에는 검증된 캡처가 없어 시각 비교를 열지 않았습니다.";
          host.dataset.previewMissing = "true";
          continue;
        }
        const bytes = preview.bytes instanceof Uint8Array ? preview.bytes : new Uint8Array(preview.bytes);
        const url = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType || "image/png" }));
        state.comparePreviewUrls.push(url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = `${context.artifact.title} v${context.selectedVersion.version} 검증 캡처`;
        image.draggable = false;
        host.replaceChildren(image);
      } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); }
    }
  }

  function updateArtifactCompareDom() {
    const host = document.querySelector("[data-artifact-compare-host]");
    if (!host) return;
    document.querySelector(".artifactWorkspace")?.classList.toggle("compareOpen", Boolean(state.artifactComparison));
    disposeComparePreviews();
    const labArtifacts = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact);
    const artifact = labArtifacts.find((item) => item.id === state.selectedArtifactId) || labArtifacts[0];
    const history = artifact ? state.artifactHistoryById.get(artifact.id) : null;
    host.innerHTML = artifact ? artifactCompareMarkup(artifact, history) : "";
    if (state.artifactComparison?.diff) void hydrateArtifactComparePreviews(state.artifactComparison);
  }

  async function loadArtifactComparison(artifact, fromVersion, toVersion) {
    const epoch = ++compareEpoch;
    state.artifactComparison = { artifactId: artifact.id, fromVersion, toVersion, loading: true, error: "", diff: null, fromContext: null, toContext: null };
    updateArtifactCompareDom();
    try {
      const [diff, fromContext, toContext] = await Promise.all([
        science.artifacts.diff(state.selectedId, artifact.id, fromVersion, toVersion),
        science.artifacts.context(state.selectedId, artifact.id, fromVersion),
        science.artifacts.context(state.selectedId, artifact.id, toVersion),
      ]);
      if (epoch !== compareEpoch || state.selectedArtifactId !== artifact.id) return;
      if (!diff || diff.artifactId !== artifact.id || diff.from.version !== fromVersion || diff.to.version !== toVersion) throw new Error("검증된 버전 비교 결과를 불러오지 못했습니다.");
      if (!fromContext || !toContext || fromContext.selectedVersion.version !== fromVersion || toContext.selectedVersion.version !== toVersion) throw new Error("비교 버전 문맥이 일치하지 않습니다.");
      state.artifactComparison = { artifactId: artifact.id, fromVersion, toVersion, loading: false, error: "", diff, fromContext, toContext };
    } catch (error) {
      if (epoch !== compareEpoch || state.selectedArtifactId !== artifact.id) return;
      state.artifactComparison = { artifactId: artifact.id, fromVersion, toVersion, loading: false, error: error instanceof Error ? error.message : String(error), diff: null, fromContext: null, toContext: null };
    }
    updateArtifactCompareDom();
  }

  function startArtifactComparison() {
    const labArtifacts = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact);
    const artifact = labArtifacts.find((item) => item.id === state.selectedArtifactId) || labArtifacts[0];
    const history = artifact ? state.artifactHistoryById.get(artifact.id) : null;
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    if (!artifact || entries.length < 2) return;
    const preferredFrom = Number.isSafeInteger(state.inspectedArtifactVersion) ? state.inspectedArtifactVersion : Number.isSafeInteger(state.selectedArtifactOriginVersion) ? state.selectedArtifactOriginVersion : entries.at(-2).version;
    const fromVersion = Math.min(preferredFrom, artifact.currentVersion - 1);
    void loadArtifactComparison(artifact, fromVersion, artifact.currentVersion);
  }

  const VEGA_COLORS = ["#3867d6", "#0b7285", "#7b61a8", "#c75d2c", "#2f7d4a"];

  function vegaEditorModel(artifact) {
    if (artifact?.kind !== "chart.vega" || artifact?.version?.rendererId !== "agentlas.vega") return null;
    const spec = artifact.version.payload?.spec;
    const data = Array.isArray(spec?.data) ? spec.data : [];
    const scales = Array.isArray(spec?.scales) ? spec.scales : [];
    const marks = Array.isArray(spec?.marks) ? spec.marks : [];
    const table = data.find((entry) => entry && entry.name === "table");
    const xScale = scales.find((entry) => entry && entry.name === "x");
    const yScale = scales.find((entry) => entry && entry.name === "y");
    const firstMark = marks[0];
    const xField = xScale?.domain?.field;
    const yField = yScale?.domain?.field;
    if (!Array.isArray(table?.values) || typeof xField !== "string" || typeof yField !== "string" || !firstMark) return null;
    const mark = firstMark.type === "line" ? "line" : firstMark.type === "symbol" ? "point" : firstMark.type === "rect" ? "bar" : null;
    if (!mark) return null;
    const rawColor = firstMark.encode?.enter?.fill?.value || firstMark.encode?.enter?.stroke?.value;
    const color = VEGA_COLORS.includes(rawColor) ? rawColor : VEGA_COLORS[0];
    const title = typeof spec.title === "string" ? spec.title : typeof spec.title?.text === "string" ? spec.title.text : artifact.version.semantic.title;
    return { title, mark, color, xField, yField };
  }

  function ensureVegaDraft(artifact) {
    const editor = vegaEditorModel(artifact);
    if (!editor) return null;
    const key = `${artifact.id}:${artifact.currentVersion}:${artifact.version.contentSha256}`;
    if (!state.vegaDraft || state.vegaDraft.key !== key) state.vegaDraft = { key, ...editor, dirty: false };
    return state.vegaDraft;
  }

  function vegaDraftSpec(artifact, draft) {
    const spec = JSON.parse(JSON.stringify(artifact.version.payload.spec));
    spec.title = { text: draft.title, anchor: "middle", fontSize: 16, offset: 12 };
    const xField = draft.xField;
    const yField = draft.yField;
    const position = { x: { scale: "x", field: xField, band: 0.5 }, y: { scale: "y", field: yField } };
    if (draft.mark === "bar") spec.marks = [{ type: "rect", from: { data: "table" }, encode: { enter: { x: { scale: "x", field: xField }, width: { scale: "x", band: 1 }, y: { scale: "y", field: yField }, y2: { scale: "y", value: 0 }, fill: { value: draft.color } } } }];
    else if (draft.mark === "line") spec.marks = [{ type: "line", from: { data: "table" }, encode: { enter: { ...position, stroke: { value: draft.color }, strokeWidth: { value: 2.5 } } } }];
    else spec.marks = [{ type: "symbol", from: { data: "table" }, encode: { enter: { ...position, fill: { value: draft.color }, size: { value: 110 } } } }];
    return spec;
  }

  function vegaEditorMarkup(artifact, draft) {
    if (!draft) return `<div class="vegaViewNotice"><strong>대화형 보기</strong><span>이 Vega 명세는 안전한 Lab 편집 형식과 일치하지 않아 현재 버전은 탐색만 할 수 있습니다.</span></div>`;
    const status = state.vegaSaving ? `v${artifact.currentVersion + 1}로 저장 중…` : state.vegaSaveError ? state.vegaSaveError : draft.dirty ? `v${artifact.currentVersion} 기반 · 저장되지 않은 변경` : `v${artifact.currentVersion} 저장됨 · 대화형 미리보기`;
    return `<form class="vegaEditor" id="vega-editor-form"><div class="vegaEditorFields"><label><span>차트 제목</span><input name="title" maxlength="240" required value="${escapeHtml(draft.title)}" /></label><label><span>표현</span><select name="mark"><option value="bar" ${draft.mark === "bar" ? "selected" : ""}>막대</option><option value="line" ${draft.mark === "line" ? "selected" : ""}>선</option><option value="point" ${draft.mark === "point" ? "selected" : ""}>점</option></select></label><fieldset><legend>색</legend><div class="vegaColors">${VEGA_COLORS.map((color) => `<label title="${color}"><input type="radio" name="color" value="${color}" ${draft.color === color ? "checked" : ""}/><span style="--swatch:${color}"></span></label>`).join("")}</div></fieldset></div><div class="vegaEditorActions"><span data-vega-draft-status aria-live="polite">${escapeHtml(status)}</span><div><button type="button" data-action="reset-vega-draft" ${!draft.dirty || state.vegaSaving ? "disabled" : ""}>변경 취소</button><button class="saveVersionButton" type="submit" ${!draft.dirty || state.vegaSaving ? "disabled" : ""}>새 버전 저장</button></div></div></form>`;
  }

  async function saveVegaDraft(formElement) {
    const artifact = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact).find((item) => item.id === state.selectedArtifactId);
    const draft = artifact ? ensureVegaDraft(artifact) : null;
    if (!artifact || !draft || state.vegaSaving) return;
    const form = new FormData(formElement);
    draft.title = String(form.get("title") || "").trim();
    draft.mark = String(form.get("mark") || "bar");
    draft.color = String(form.get("color") || VEGA_COLORS[0]);
    draft.dirty = true;
    setActiveWorkspaceTabDirty(true);
    if (!draft.title) { state.vegaSaveError = "차트 제목을 입력해 주세요."; render(); return; }
    state.vegaSaving = true;
    state.vegaSaveError = "";
    render();
    try {
      const result = await science.artifacts.updateVega({ schema: "agentlas.science-vega-edit/v1", requestId: crypto.randomUUID(), projectId: artifact.projectId, artifactId: artifact.id, expectedArtifactVersion: artifact.currentVersion, expectedContentSha256: artifact.version.contentSha256, title: draft.title, mark: draft.mark, color: draft.color });
      const projectId = state.selectedId;
      const labId = state.selectedLabId;
      const originVersion = state.selectedArtifactOriginVersion;
      const returnMessageId = state.returnMessageId;
      state.vegaSaving = false;
      state.vegaDraft = null;
      const activeIndex = state.workspaceTabs.findIndex((tab) => tab.id === state.activeWorkspaceTabId);
      if (activeIndex >= 0) {
        const nextId = artifactWorkspaceTabId(result.artifact.id, result.artifact.currentVersion);
        state.workspaceTabs[activeIndex] = {
          ...state.workspaceTabs[activeIndex],
          id: nextId,
          exactVersion: result.artifact.currentVersion,
          exactContentSha256: result.artifact.version.contentSha256,
          dirty: false,
        };
        state.activeWorkspaceTabId = nextId;
      }
      await queueWorkspacePersistence({ navigation: false, tabs: true });
      await selectProject(projectId);
      await openLab(labId, result.artifact.id, originVersion, returnMessageId);
    } catch (error) {
      state.vegaSaving = false;
      state.vegaSaveError = error instanceof Error && error.message.includes("version-conflict") ? "저장하지 못했습니다. Lab 현재 버전이 변경되었습니다. 내 초안은 보존했습니다." : (error instanceof Error ? error.message : String(error));
      render();
    }
  }

  function artifactWorkbench() {
    if (state.loadingProject) return `<div class="loadingState">시각 자료를 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const labContexts = state.labContextsById.get(state.selectedLabId) || [];
    const labArtifacts = labContexts.map((context) => context.artifact);
    if (!labArtifacts.length) {
      if (state.selectedLabId === "data-table") return `<section class="emptyView labStartView" data-empty-source="science.sqlite"><div class="labStartCard"><span class="researchKicker">Data & Statistics · ${escapeHtml(lifecycleLabel())}</span><strong>분석할 CSV를 검증된 Data Table로 가져오세요.</strong><p>원본 파일은 Main 프로세스에서만 읽고, 경로는 UI나 연구 에이전트에 노출하지 않습니다. 전체 파일을 파싱해 SourceVersion · CAS · ResearchRun · immutable source binding을 만든 뒤 표를 엽니다.</p><dl><div><dt>제한</dt><dd>8 MiB · 5,000 rows · 무음 truncation 없음</dd></div><div><dt>보존</dt><dd>typed cells · null · formula-looking text</dd></div><div><dt>출판</dt><dd>exact source/run/table SHA closure</dd></div></dl><button class="primaryButton importDatasetButton" data-action="import-csv-dataset" ${state.datasetImportBusy ? "disabled" : ""}>${state.datasetImportBusy ? "검증하며 가져오는 중…" : "CSV 데이터셋 가져오기"}</button>${state.datasetImportError ? `<p class="labStartError" role="alert">${escapeHtml(state.datasetImportError)}</p>` : ""}</div></section>`;
      if (state.selectedLabId === "statistics-analysis") return statisticsLaunchCard();
      if (state.selectedLabId === "economic-indicators") return `<section class="emptyView labStartView" data-empty-source="science.sqlite"><div class="labStartCard"><span class="researchKicker">Economics & Finance · ${escapeHtml(lifecycleLabel())}</span><strong>공식 World Bank 경제지표를 가져오세요.</strong><p>Economic Indicators는 World Bank의 국가·지표·연도 범위를 지정해 exact provider response, SourceVersion, ResearchRun과 Vega artifact lineage를 보존합니다. 주가·시세·거래 데이터 API는 제공하지 않습니다.</p><dl><div><dt>Economics</dt><dd>공식 World Bank indicator series</dd></div><div><dt>Finance</dt><dd>사용자 CSV → Data Table → Statistical Analysis / Vega</dd></div><div><dt>보존</dt><dd>source · run · artifact hash lineage</dd></div></dl><button class="secondaryButton" data-action="suggest-empty-lab-run">World Bank 지표를 연구 에이전트에게 요청</button></div></section>`;
      return `<section class="emptyView labStartView" data-empty-source="science.sqlite"><div class="labStartCard"><span class="researchKicker">${escapeHtml(labCapabilityLabel(state.selectedLabId))} · ${escapeHtml(lifecycleLabel())}</span><strong>아직 저장된 아티팩트가 없습니다.</strong><p>오른쪽 연구 채팅에서 이 Lab을 사용하도록 요청하면, 실제 실행 결과가 immutable version과 출처·run lineage를 가진 아티팩트로 이 보관소에 연결됩니다.</p><button class="secondaryButton" data-action="suggest-empty-lab-run">연구 에이전트에게 이 Lab 사용 요청</button></div></section>`;
    }
    const artifact = labArtifacts.find((item) => item.id === state.selectedArtifactId) || labArtifacts[0];
    const originVersion = artifact.id === state.selectedArtifactId ? state.selectedArtifactOriginVersion : null;
    const history = state.artifactHistoryById.get(artifact.id) || null;
    const historyEntries = Array.isArray(history?.entries) ? [...history.entries].reverse() : [];
    const inspectingHistory = Number.isSafeInteger(state.inspectedArtifactVersion) && state.inspectedArtifactVersion !== artifact.currentVersion;
    const inspectedContext = inspectingHistory && state.inspectedArtifactContext && !state.inspectedArtifactContext.error ? state.inspectedArtifactContext : null;
    const activeVersion = inspectingHistory ? inspectedContext?.selectedVersion || null : artifact.version;
    const economicPayload = activeVersion?.payload?.schema === "agentlas.science.economic-indicator-artifact/v1" ? activeVersion.payload : null;
    const economicEvidence = economicPayload?.evidence?.schema === "agentlas.science.economic-indicator-evidence/v1" ? economicPayload.evidence : null;
    const economicSeries = economicEvidence?.normalization?.series;
    const statisticsFigurePayload = activeVersion?.payload?.schema === "agentlas.science.statistics-figure-artifact/v1" ? activeVersion.payload : null;
    const statisticsRasterPayload = activeVersion?.payload?.schema === "agentlas.science.statistics-figure-raster-artifact/v1" ? activeVersion.payload : null;
    const numericSurfacePayload = activeVersion?.payload?.schema === NUMERIC_SURFACE_V2_SCHEMA ? activeVersion.payload : null;
    const numericSurfaceRasterPayload = activeVersion?.payload?.schema === NUMERIC_SURFACE_RASTER_SCHEMA ? activeVersion.payload : null;
    const statisticsProjectionReceipt = activeVersion?.payload?.schema === "agentlas.science.statistics-analysis-artifact/v1"
      && isStatisticsProjectionReceipt(activeVersion.payload.projectionReceipt)
      ? activeVersion.payload.projectionReceipt : null;
    const statisticsRunId = activeVersion?.provenance?.sourceRunId || (inspectingHistory ? inspectedContext?.linkage?.origin?.runId : labContexts.find((context) => context.artifact.id === artifact.id)?.linkage?.origin?.runId) || "";
    const vegaDraft = !inspectingHistory && !statisticsFigurePayload ? ensureVegaDraft(artifact) : null;
    const historyError = history?.error || (state.inspectedArtifactContext?.error ?? "");
    const openArtifactIds = new Set(state.workspaceTabs.filter((tab) => tab.kind === "artifact" && tab.artifactId).map((tab) => tab.artifactId));
    const hasUnopenedArtifact = labArtifacts.some((item) => !openArtifactIds.has(item.id));
    const duplicateArtifactTitles = labArtifacts.length > 1 && new Set(labArtifacts.map((item) => item.title)).size === 1;
    const tabs = labArtifacts.length > 1 && hasUnopenedArtifact && !duplicateArtifactTitles
      ? labArtifacts.map((item) => `<button class="artifactTab" data-artifact-id="${escapeHtml(item.id)}" aria-selected="${item.id === artifact.id}">${escapeHtml(item.title)} <span>v${escapeHtml(item.currentVersion)}</span></button>`).join("")
      : "";
    const semanticObservations = Array.isArray(activeVersion?.semantic?.observations) ? activeVersion.semantic.observations : [];
    const observations = semanticObservations.map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}${item.unit ? ` <span>${escapeHtml(item.unit)}</span>` : ""}</dd></div>`).join("");
    const capability = inspectingHistory ? `기록 v${escapeHtml(state.inspectedArtifactVersion)} · 읽기 전용` : artifact.version.rendererId === "agentlas.ketcher" ? `현재 v${escapeHtml(artifact.currentVersion)} · 편집 가능` : artifact.version.rendererId === "agentlas.molstar" ? `현재 v${escapeHtml(artifact.currentVersion)} · 표현 편집 가능` : artifact.version.rendererId === "agentlas.vega" && vegaDraft ? (vegaDraft.dirty ? `현재 v${escapeHtml(artifact.currentVersion)} 기반 · 초안` : `현재 v${escapeHtml(artifact.currentVersion)} · 편집 가능`) : `현재 v${escapeHtml(artifact.currentVersion)} · 대화형 보기`;
    const validator = artifact.version.payload?.validation?.validator;
    const provenanceSteps = economicEvidence ? [
      `World Bank · ${economicSeries?.country?.name || economicEvidence.query.country} · ${economicSeries?.indicator?.code || economicEvidence.query.indicator}`,
      `source ${String(economicEvidence.source.id).slice(0, 12)}… · version ${String(economicEvidence.source.versionId).slice(0, 12)}…`,
      `run ${String(economicEvidence.runId).slice(0, 12)}…`,
      `artifact v${activeVersion?.version || artifact.currentVersion}`,
    ] : statisticsFigurePayload ? [
      `Statistical Analysis ${String(statisticsFigurePayload.statisticsArtifact.artifactId).slice(0, 12)}… · v${statisticsFigurePayload.statisticsArtifact.artifactVersion}`,
      `${statisticsFigurePayload.method} · visualization ${statisticsFigurePayload.visualization.index + 1}`,
      `Figure spec ${String(statisticsFigurePayload.figureSpec?.specSha256 || "").slice(0, 12)}…`,
      `artifact v${activeVersion?.version || artifact.currentVersion}`,
    ] : statisticsProjectionReceipt ? [
      `Data Table ${String(statisticsProjectionReceipt.sourceArtifact.artifactId).slice(0, 12)}… · v${statisticsProjectionReceipt.sourceArtifact.artifactVersion}`,
      `${statisticsMethodLabel(activeVersion.payload.method)} · ${statisticsProjectionMappingLabel(statisticsProjectionReceipt)} · ${statisticsProjectionReceipt.includedRowCount} rows`,
      `run ${String(statisticsRunId).slice(0, 12)}…`,
      `artifact v${activeVersion?.version || artifact.currentVersion}`,
    ] : [
      `${labLabel(state.selectedLabId)} Lab`,
      originVersion ? `세션 응답의 아티팩트 v${originVersion}` : "project artifact",
      validator ? `${validator} validation` : artifact.version.rendererId,
      `artifact v${artifact.currentVersion}`,
    ];
    const originStrip = `<section class="originStrip"><div class="provenanceTrail">${provenanceSteps.map((step) => `<span>${escapeHtml(step)}</span>`).join('<i aria-hidden="true">→</i>')}<em>${escapeHtml(capability)}</em></div><div><button data-action="toggle-history" aria-expanded="${state.historyOpen}">버전 ${escapeHtml(artifact.currentVersion)}</button>${originVersion ? `<button data-artifact-history-version="${escapeHtml(originVersion)}">응답 원본 v${escapeHtml(originVersion)}</button>` : ""}<button data-action="toggle-drawer">세부 정보</button></div></section>`;
    const statisticsLineage = statisticsProjectionLineageMarkup(statisticsProjectionReceipt, statisticsRunId, artifact.id, activeVersion?.version || artifact.currentVersion, activeVersion?.contentSha256 || "");
    const timeline = historyEntries.length ? historyEntries.map((entry) => {
      const selected = inspectingHistory ? entry.version === state.inspectedArtifactVersion : entry.isCurrent;
      const origin = originVersion === entry.version;
      const originLabel = entry.linkage.origin.surface === "conversation" ? "대화" : entry.linkage.origin.surface === "loop" ? "실험 루프" : entry.linkage.origin.surface === "lab" ? "Lab" : "이전 기록";
      return `<button class="versionRow" data-artifact-history-version="${escapeHtml(entry.version)}" aria-current="${entry.isCurrent}" aria-pressed="${selected}"><span class="versionNumber">v${escapeHtml(entry.version)}</span><span class="versionCopy"><strong>${entry.isCurrent ? "현재 버전" : escapeHtml(entry.semanticTitle || `버전 ${entry.version}`)}</strong><small>${escapeHtml(formatDate(entry.createdAt))} · ${escapeHtml(originLabel)}${entry.hasVisualCapture ? " · 캡처됨" : ""}</small></span><span class="versionBadges">${entry.isCurrent ? `<em data-kind="current">현재</em>` : ""}${origin ? `<em data-kind="origin">대화 원본</em>` : ""}</span></button>`;
    }).join("") : `<div class="versionRailState">${escapeHtml(historyError || "버전 기록을 불러오는 중…")}</div>`;
    const citationNodes = Array.isArray(artifact.version.payload?.network?.nodes) ? artifact.version.payload.network.nodes : [];
    const citationOptions = citationNodes.slice(0, 200).map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.title)}</option>`).join("");
    const citationToolbar = artifact.version.rendererId === "agentlas.cytoscape" ? `<div class="citationNetworkToolbar"><div><button data-citation-layout="cose" aria-pressed="true">관계망</button><button data-citation-layout="concentric">인용 규모</button><button data-citation-layout="grid">목록</button><button data-citation-fit="true">전체 보기</button><label class="citationNodePicker"><span>핵심 논문</span><select data-citation-node-select><option value="">논문 선택…</option>${citationOptions}</select></label></div><div class="citationNodeDetail" data-citation-node-detail><strong>논문 노드를 선택하세요</strong><span>제목·저자·연도·출처·인용 수를 여기서 함께 확인합니다.</span></div></div>` : "";
    const skyCatalog = artifact.version.payload?.catalog;
    const skyTypes = Array.isArray(skyCatalog?.objectTypeCounts) ? skyCatalog.objectTypeCounts : [];
    const skyTypeOptions = skyTypes.map((entry) => `<option value="${escapeHtml(entry.type)}">${escapeHtml(entry.type)} · ${escapeHtml(entry.count)}</option>`).join("");
    const skyToolbar = artifact.version.rendererId === "agentlas.d3-sky" ? `<div class="skyCatalogToolbar"><div><button data-sky-action="reset">시야 초기화</button><label><span>천체 유형</span><select data-sky-type-filter><option value="">모든 유형 · ${escapeHtml(Array.isArray(skyCatalog?.objects) ? skyCatalog.objects.length : 0)}</option>${skyTypeOptions}</select></label><span class="skyCoordinateConvention">ICRS · RA는 천구 관례에 따라 반전</span></div><div class="skyObjectDetail" data-sky-object-detail><strong>천체를 선택하세요</strong><span>SIMBAD 식별자·좌표·관측값을 원본 필드 그대로 표시합니다.</span></div></div>` : "";
    const genomicsPayload = artifact.version.payload;
    const genomicsToolbar = artifact.version.rendererId === "agentlas.jbrowse" ? `<div class="genomicsToolbar"><div><span>ASSEMBLY</span><strong>${escapeHtml(genomicsPayload?.assembly?.name || "")}</strong></div><div><span>REGION</span><strong>${escapeHtml(genomicsPayload?.region?.refName || "")}:${escapeHtml(genomicsPayload?.region?.start || "")}–${escapeHtml(genomicsPayload?.region?.end || "")}</strong></div><div><span>VARIANTS</span><strong>${escapeHtml(Array.isArray(genomicsPayload?.variants) ? genomicsPayload.variants.length : 0)} · ClinVar</strong></div><p>Pan · zoom · feature click은 JBrowse 2 세션에서 직접 조작됩니다.</p></div>` : "";
    const statisticsFigureToolbar = statisticsFigurePayload ? `<section class="statisticsFigureToolbar" data-statistics-figure-toolbar><div><span>PUBLICATION FIGURE · EXACT BINDING</span><strong>${escapeHtml(statisticsFigurePayload.visualization.title)}</strong><code title="${escapeHtml(statisticsFigurePayload.statisticsArtifact.contentSha256)}">parent v${escapeHtml(statisticsFigurePayload.statisticsArtifact.artifactVersion)} · ${escapeHtml(String(statisticsFigurePayload.statisticsArtifact.contentSha256).slice(0, 12))}…</code></div><div class="statisticsFigureExport"><div><button type="button" data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>버전 비교</button><button type="button" data-action="export-statistics-figure-svg" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "SVG"}</button><button type="button" data-action="export-statistics-figure-png" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "PNG 600dpi"}</button><button type="button" data-action="export-statistics-figure-pdf" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "PDF 600dpi"}</button><button type="button" data-action="export-statistics-figure-tiff" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "TIFF 600dpi"}</button></div><span>SVG · PNG/PDF/TIFF 300/600dpi · sRGB ICC. CMYK와 vector PDF는 아직 미지원.</span></div>${state.figureActionError ? `<p role="alert">${escapeHtml(state.figureActionError)}</p>` : state.figureActionNotice ? `<p role="status">${escapeHtml(state.figureActionNotice)}</p>` : ""}</section>` : "";
    const statisticsRasterToolbar = statisticsRasterPayload ? `<section class="statisticsRasterToolbar" data-statistics-raster-toolbar data-export-receipt-sha256="${escapeHtml(statisticsRasterPayload.exportSha256)}"><div><span>PUBLICATION RASTER · EXACT EXPORT</span><strong>${escapeHtml(`${statisticsRasterPayload.export.dpi} DPI · ${statisticsRasterPayload.export.colorSpace.toUpperCase()} · ${statisticsRasterPayload.export.widthMm}×${statisticsRasterPayload.export.heightMm} mm`)}</strong><code title="${escapeHtml(statisticsRasterPayload.figureArtifact.contentSha256)}">Figure v${escapeHtml(statisticsRasterPayload.figureArtifact.artifactVersion)} · ${escapeHtml(statisticsShortHash(statisticsRasterPayload.figureArtifact.contentSha256))}</code></div><div><em>원고 연결 가능</em><span>이 image 아티팩트가 journal raster 검증 대상입니다.</span></div></section>` : "";
    const numericSurfaceToolbar = numericSurfacePayload ? `<section class="statisticsFigureToolbar" data-numeric-surface-export-toolbar><div><span>3D RESPONSE SURFACE · EXACT VIEW</span><strong>${escapeHtml(numericSurfacePayload.title)}</strong><code title="${escapeHtml(activeVersion.contentSha256)}">surface v${escapeHtml(activeVersion.version)} · ${escapeHtml(statisticsShortHash(activeVersion.contentSha256))} · view는 SQLite 저장 상태 사용</code></div><div class="statisticsFigureExport"><div><button type="button" data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>버전 비교</button><button type="button" data-action="export-numeric-surface-png" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "PNG 2008×1506 · 600dpi"}</button></div><span>Three.js offscreen WebGL 재렌더 · sRGB · white background · vector/PDF/EPS/TIFF/CMYK 미지원.</span></div>${state.figureActionError ? `<p role="alert">${escapeHtml(state.figureActionError)}</p>` : state.figureActionNotice ? `<p role="status">${escapeHtml(state.figureActionNotice)}</p>` : ""}</section>` : "";
    const numericSurfaceRasterToolbar = numericSurfaceRasterPayload ? `<section class="statisticsRasterToolbar" data-numeric-surface-raster-toolbar data-export-receipt-sha256="${escapeHtml(numericSurfaceRasterPayload.exportSha256)}"><div><span>3D PUBLICATION RASTER · EXACT EXPORT</span><strong>${escapeHtml(`${numericSurfaceRasterPayload.export.width}×${numericSurfaceRasterPayload.export.height}px · ${numericSurfaceRasterPayload.export.dpi} DPI · ${numericSurfaceRasterPayload.export.colorSpace.toUpperCase()}`)}</strong><code title="${escapeHtml(numericSurfaceRasterPayload.surfaceArtifact.contentSha256)}">Surface v${escapeHtml(numericSurfaceRasterPayload.surfaceArtifact.artifactVersion)} · ${escapeHtml(statisticsShortHash(numericSurfaceRasterPayload.surfaceArtifact.contentSha256))} · camera ${escapeHtml(statisticsShortHash(numericSurfaceRasterPayload.viewStateReceipt.viewStateSha256))}</code></div><div><em>원고 연결 가능</em><span>PNG pixels · persisted camera · renderer · parent lineage가 하나의 receipt에 고정됩니다.</span></div></section>` : "";
    const canvasClass = artifact.version.rendererId === "agentlas.cytoscape"
      ? "artifactCanvas citationNetworkCanvas"
      : artifact.version.rendererId === NUMERIC_SURFACE_RENDERER
        ? "artifactCanvas numericSurfaceCanvas"
      : artifact.version.rendererId === "agentlas.d3-sky"
        ? "artifactCanvas skyCatalogCanvas"
        : artifact.version.rendererId === "agentlas.jbrowse"
          ? "artifactCanvas jbrowseGenomeCanvas"
          : artifact.version.rendererId === "agentlas.table"
            ? "artifactCanvas dataTableCanvas"
        : artifact.version.rendererId !== "agentlas.vega" ? "artifactCanvas artifactCanvasExternal" : "artifactCanvas";
    const canvas = inspectingHistory
      ? `<div class="artifactCanvasFrame historicalFrame"><div class="historicalStatus"><span>기록 보기 · v${escapeHtml(state.inspectedArtifactVersion)} · 읽기 전용</span><button data-artifact-history-version="${escapeHtml(artifact.currentVersion)}">현재 v${escapeHtml(artifact.currentVersion)}으로 돌아가기</button></div><div class="artifactCanvas historicalArtifactCanvas"><div class="historicalCaptureNotice"><strong>검증된 캡처</strong><span>이 화면은 기록 보존용이며 조작할 수 없습니다.</span></div><div class="historicalPreviewSurface" data-historical-artifact-host="${escapeHtml(artifact.id)}" data-historical-artifact-version="${escapeHtml(state.inspectedArtifactVersion)}" aria-label="${escapeHtml(artifact.title)} v${escapeHtml(state.inspectedArtifactVersion)} 기록">${historyError ? `<span class="historicalError">${escapeHtml(historyError)}</span>` : inspectedContext ? "" : `<span class="historicalLoading">검증된 과거 버전을 불러오는 중…</span>`}</div></div></div>`
      : `<div class="artifactCanvasFrame"><div class="rendererStatus"><span>${escapeHtml(artifact.kind)}</span><span>${escapeHtml(artifact.version.rendererId)} · ${escapeHtml(artifact.version.rendererVersion)} <em data-runtime-status></em></span></div>${artifact.version.rendererId === "agentlas.vega" ? statisticsFigureToolbar || vegaEditorMarkup(artifact, vegaDraft) : numericSurfaceToolbar || numericSurfaceRasterToolbar || statisticsRasterToolbar || citationToolbar || skyToolbar || genomicsToolbar}<div class="${canvasClass}" data-artifact-host="${escapeHtml(artifact.id)}" data-artifact-version="${escapeHtml(artifact.version.version)}" data-content-sha256="${escapeHtml(artifact.version.contentSha256)}" aria-label="${escapeHtml(artifact.title)}"></div><div class="renderError" data-render-error role="alert"></div></div>`;
    const loopObservation = semanticObservations[0] || null;
    const loopEvidence = loopObservation ? `${loopObservation.label}: ${loopObservation.value}${loopObservation.unit ? ` ${loopObservation.unit}` : ""}` : (activeVersion?.semantic?.summary || "현재 아티팩트의 다음 검증 단계를 연구 채팅에서 함께 결정합니다.");
    return `<section class="artifactWorkspace ${state.historyOpen ? "historyOpen" : ""} ${state.artifactComparison ? "compareOpen" : ""}"><header class="labWorkspaceHeader visuallyHidden"><span>${escapeHtml(labCapabilityLabel(state.selectedLabId))}</span><strong>아티팩트 보관소 · 작업공간</strong><span class="originVersion">${capability}</span><button data-action="back-session">${state.returnMessageId ? "대화의 아티팩트로" : "세션으로 돌아가기"}</button></header>${tabs ? `<nav class="artifactTabs" data-count="${escapeHtml(labArtifacts.length)}" aria-label="Lab 아티팩트">${tabs}</nav>` : ""}${originStrip}${statisticsLineage}<div class="labWorkGrid"><div class="figureColumn">
      ${canvas}
      <section class="artifactInterpretation"><div><div class="researchKicker">${inspectingHistory ? "과거 버전 의미 기록" : "Semantic layer"}</div><h2>${escapeHtml(activeVersion?.semantic?.title || (inspectingHistory ? `v${state.inspectedArtifactVersion} 기록을 불러오는 중…` : artifact.title))}</h2><p>${escapeHtml(activeVersion?.semantic?.summary || (inspectingHistory ? "현재 버전 정보로 대체하지 않고, 선택한 과거 버전의 검증이 끝날 때까지 기다립니다." : ""))}</p></div>${observations ? `<dl class="observationGrid">${observations}</dl>` : ""}</section>
      <div data-artifact-compare-host>${artifactCompareMarkup(artifact, history)}</div>
    </div><aside class="versionRail" data-version-timeline aria-label="아티팩트 버전 기록"><header><span>버전 기록</span><div><strong>${escapeHtml(artifact.currentVersion)}개</strong><button data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>비교</button></div></header><div class="versionRows">${timeline}</div><footer>저장된 버전만 기록됩니다. 과거 버전은 읽기 전용입니다.</footer></aside></div><footer class="experimentLoop"><div><span>연구 생애주기</span><strong>${escapeHtml(lifecycleLabel())}</strong></div><div><span>가설 / 해석</span><strong>${escapeHtml(activeVersion?.semantic?.title || artifact.title)}</strong></div><div><span>최근 관찰</span><strong>${escapeHtml(state.artifactBindingError || state.figureActionNotice || loopEvidence)}</strong></div><div class="experimentActions"><button class="secondaryExperimentAction" data-action="bind-artifact-manuscript" ${inspectingHistory || state.artifactBindingBusy ? "disabled" : ""}>${state.artifactBindingBusy ? "검증 중…" : numericSurfaceRasterPayload ? `${escapeHtml(numericSurfaceRasterPayload.export.dpi)}dpi 3D PNG 원고 연결` : statisticsRasterPayload ? `${escapeHtml(statisticsRasterPayload.export.dpi)}dpi 아티팩트 원고 연결` : numericSurfacePayload || statisticsFigurePayload ? "PNG export 후 원고 연결" : "원고에 연결"}</button><button data-action="suggest-next-experiment">다음 실험 제안</button></div></footer></section>`;
  }

  function errorState() {
    return `<div class="scopedError" role="alert"><strong>프로젝트 기록을 불러오지 못했습니다.</strong><span>${escapeHtml(state.projectError)}</span><button data-action="retry-project">다시 시도</button></div>`;
  }

  function contextDrawer() {
    const selectedCitation = state.drawer?.kind === "citation" ? citationById(state.drawer.id) : null;
    const selectedEvidence = selectedCitation ? state.evidenceById.get(selectedCitation.evidenceSpanId) || null : null;
    const selectedSource = sourceById(selectedCitation?.sourceId || (state.drawer?.kind === "source" ? state.drawer.id : state.selectedSourceId));
    const selectedArtifact = state.artifacts.find((item) => item.id === (state.drawer?.kind === "artifact" ? state.drawer.id : state.selectedArtifactId)) || null;
    const selectedArtifactVersion = state.mode === "lab" && state.inspectedArtifactVersion
      ? state.inspectedArtifactContext && !state.inspectedArtifactContext.error ? state.inspectedArtifactContext.selectedVersion : null
      : selectedArtifact?.version || null;
    let content = "";
    if (state.mode === "manuscript") {
      const manuscript = manuscriptById(state.selectedManuscriptId);
      const draft = state.manuscriptDraft;
      content = manuscript && draft ? `<section class="drawerSection"><div class="drawerLabel">Manuscript ledger</div><strong>${escapeHtml(manuscript.title)}</strong><p>현재 편집 초안은 v${escapeHtml(draft.baseVersion)}와 content hash에 고정되어 있으며 저장 시 새 immutable version이 추가됩니다.</p><dl class="factList"><div><dt>Status</dt><dd>${escapeHtml(manuscript.status)}</dd></div><div><dt>Version</dt><dd>v${escapeHtml(manuscript.currentVersion)}</dd></div><div><dt>Bindings</dt><dd>${escapeHtml(draft.bindings.length)}</dd></div><div><dt>Content</dt><dd><code>${escapeHtml(draft.baseContentSha256.slice(0, 12))}…</code></dd></div></dl></section><section class="drawerSection"><div class="drawerLabel">Submission boundary</div><strong>저널 지침 검증 전</strong><p>저널별 template·word limit·figure·supplement·data availability 규칙은 제출 대상을 선택한 뒤 공식 웹 출처로 확인해야 합니다.</p></section>` : `<section class="drawerSection"><strong>선택된 원고가 없습니다.</strong></section>`;
    } else if (state.mode === "lab") {
      const packRows = state.rendererPacks.map((pack) => `<div class="runtimeRow"><div><strong>${escapeHtml(pack.displayName)}</strong><span>${escapeHtml(pack.engineNames.join(", ") || pack.id)}</span></div><em data-state="${escapeHtml(pack.state)}">${escapeHtml(pack.state)}</em></div>`).join("");
      const economicEvidence = selectedArtifactVersion?.payload?.schema === "agentlas.science.economic-indicator-artifact/v1"
        && selectedArtifactVersion.payload.evidence?.schema === "agentlas.science.economic-indicator-evidence/v1"
        ? selectedArtifactVersion.payload.evidence : null;
      const economicLineage = economicEvidence && selectedArtifact ? `<section class="drawerSection"><div class="drawerLabel">World Bank lineage</div><strong>${escapeHtml(economicEvidence.normalization.series.indicator.name)}</strong><p>${escapeHtml(`${economicEvidence.normalization.series.country.name} · ${economicEvidence.query.startYear}–${economicEvidence.query.endYear} · missing values preserved as null`)}</p><dl class="factList"><div><dt>Source</dt><dd><code title="${escapeHtml(economicEvidence.source.id)}">${escapeHtml(economicEvidence.source.id.slice(0, 16))}…</code></dd></div><div><dt>Source version</dt><dd><code title="${escapeHtml(economicEvidence.source.versionId)}">${escapeHtml(economicEvidence.source.versionId.slice(0, 16))}…</code></dd></div><div><dt>Run</dt><dd><code title="${escapeHtml(economicEvidence.runId)}">${escapeHtml(economicEvidence.runId.slice(0, 16))}…</code></dd></div><div><dt>Artifact</dt><dd><code title="${escapeHtml(selectedArtifact.id)}">${escapeHtml(selectedArtifact.id.slice(0, 16))}…</code> · v${escapeHtml(selectedArtifactVersion.version)}</dd></div><div><dt>Response</dt><dd><code title="${escapeHtml(economicEvidence.response.sha256)}">${escapeHtml(economicEvidence.response.sha256.slice(0, 16))}…</code></dd></div><div><dt>Normalized</dt><dd><code title="${escapeHtml(economicEvidence.normalization.sha256)}">${escapeHtml(economicEvidence.normalization.sha256.slice(0, 16))}…</code></dd></div></dl></section>` : "";
      const statisticsProjectionReceipt = selectedArtifactVersion?.payload?.schema === "agentlas.science.statistics-analysis-artifact/v1"
        && isStatisticsProjectionReceipt(selectedArtifactVersion.payload.projectionReceipt)
        ? selectedArtifactVersion.payload.projectionReceipt : null;
      const statisticsRunId = selectedArtifactVersion?.provenance?.sourceRunId || selectedArtifact?.version?.provenance?.sourceRunId || "";
      const statisticsLineage = statisticsProjectionReceipt && selectedArtifact ? `<section class="drawerSection" data-statistics-lineage data-projection-schema="${escapeHtml(statisticsProjectionReceipt.schema)}" data-source-artifact-id="${escapeHtml(statisticsProjectionReceipt.sourceArtifact.artifactId)}" data-source-artifact-version="${escapeHtml(statisticsProjectionReceipt.sourceArtifact.artifactVersion)}" data-source-artifact-sha256="${escapeHtml(statisticsProjectionReceipt.sourceArtifact.contentSha256)}" data-projection-receipt-sha256="${escapeHtml(statisticsProjectionReceipt.receiptSha256)}" data-run-id="${escapeHtml(statisticsRunId)}" data-output-artifact-id="${escapeHtml(selectedArtifact.id)}" data-output-artifact-version="${escapeHtml(selectedArtifactVersion.version)}" data-output-artifact-sha256="${escapeHtml(selectedArtifactVersion.contentSha256)}"><div class="drawerLabel">Source-bound statistics lineage</div><strong>${escapeHtml(statisticsMethodLabel(selectedArtifactVersion.payload.method))}</strong><p>${escapeHtml(`${statisticsProjectionMappingLabel(statisticsProjectionReceipt)} · ${statisticsProjectionReceipt.includedRowCount} projected rows`)}</p><dl class="factList"><div><dt>Source artifact</dt><dd><code>${escapeHtml(statisticsProjectionReceipt.sourceArtifact.artifactId)}</code></dd></div><div><dt>Source version</dt><dd>v${escapeHtml(statisticsProjectionReceipt.sourceArtifact.artifactVersion)}</dd></div><div><dt>Source content</dt><dd><code>${escapeHtml(statisticsProjectionReceipt.sourceArtifact.contentSha256)}</code></dd></div><div><dt>Table</dt><dd><code>${escapeHtml(statisticsProjectionReceipt.sourceTableSha256)}</code></dd></div><div><dt>Projection</dt><dd><code>${escapeHtml(statisticsProjectionReceipt.receiptSha256)}</code></dd></div><div><dt>Included rows</dt><dd><code>${escapeHtml(statisticsProjectionReceipt.includedRowsSha256)}</code></dd></div><div><dt>Projected data</dt><dd><code>${escapeHtml(statisticsProjectionReceipt.projectedDataSha256)}</code></dd></div><div><dt>Run</dt><dd><code>${escapeHtml(statisticsRunId)}</code></dd></div><div><dt>Artifact</dt><dd><code>${escapeHtml(selectedArtifact.id)}</code> · v${escapeHtml(selectedArtifactVersion.version)}</dd></div><div><dt>Artifact content</dt><dd><code>${escapeHtml(selectedArtifactVersion.contentSha256)}</code></dd></div></dl></section>` : "";
      content = `<section class="drawerSection"><div class="drawerLabel">Renderer runtime</div>${packRows || `<p class="drawerEmpty">검증된 renderer 상태가 없습니다.</p>`}</section>${selectedArtifact && selectedArtifactVersion ? `<section class="drawerSection"><div class="drawerLabel">${state.inspectedArtifactVersion ? "과거 버전" : "선택한 아티팩트"}</div><strong>${escapeHtml(selectedArtifact.title)}</strong><p>${escapeHtml(selectedArtifactVersion.semantic?.summary || "")}</p><dl class="factList"><div><dt>Renderer</dt><dd>${escapeHtml(selectedArtifactVersion.rendererId)}</dd></div><div><dt>Version</dt><dd>v${escapeHtml(selectedArtifactVersion.version)} · ${escapeHtml(selectedArtifactVersion.rendererVersion)}</dd></div><div><dt>Mode</dt><dd>${state.inspectedArtifactVersion ? "읽기 전용 기록" : "현재 편집 버전"}</dd></div><div><dt>Content</dt><dd><code>${escapeHtml(selectedArtifactVersion.contentSha256.slice(0, 12))}…</code></dd></div></dl></section>${economicLineage}${statisticsLineage}` : state.inspectedArtifactVersion ? `<section class="drawerSection"><div class="drawerLabel">과거 버전</div><strong>v${escapeHtml(state.inspectedArtifactVersion)} 기록 검증 중</strong><p>현재 버전 정보로 대체하지 않습니다.</p></section>` : ""}`;
    } else if (selectedSource) {
      content = `${selectedCitation && selectedEvidence ? `<section class="drawerSection evidenceCard"><div class="drawerLabel">Exact evidence</div><blockquote>${escapeHtml(selectedEvidence.excerpt)}</blockquote><dl class="factList"><div><dt>Locator</dt><dd>${escapeHtml(selectedEvidence.locator)}</dd></div><div><dt>Bytes</dt><dd>${escapeHtml(selectedEvidence.startByte)}–${escapeHtml(selectedEvidence.endByte)}</dd></div><div><dt>Relation</dt><dd>${escapeHtml(selectedCitation.relation)}</dd></div><div><dt>Check</dt><dd>${escapeHtml(selectedCitation.verificationStatus)}</dd></div></dl></section>` : ""}<section class="drawerSection"><div class="drawerLabel">Source</div><strong>${escapeHtml(selectedSource.title)}</strong><p>${escapeHtml(selectedSource.abstract || "저장된 초록이 없습니다.")}</p><dl class="factList"><div><dt>Type</dt><dd>${escapeHtml(selectedSource.kind)}</dd></div><div><dt>Access</dt><dd>${escapeHtml(selectedSource.version.accessState)}</dd></div><div><dt>Verified</dt><dd>${escapeHtml(selectedSource.verificationStatus)}</dd></div><div><dt>Version</dt><dd>${escapeHtml(selectedSource.currentVersion)}</dd></div><div><dt>Hash</dt><dd>${selectedSource.version.contentSha256 ? `<code>${escapeHtml(selectedSource.version.contentSha256.slice(0, 12))}…</code>` : "metadata only"}</dd></div></dl><div class="sourceUri">${escapeHtml(selectedSource.canonicalUri)}</div></section>`;
    } else {
      content = `<section class="drawerSection"><div class="drawerLabel">Sources</div><strong>선택된 근거가 없습니다.</strong><p>인용 번호나 출처 행을 선택하면 해당 source version, evidence locator, 검증 상태를 여기서 확인할 수 있습니다.</p><div class="drawerMetric"><span>저장된 출처</span><strong>${state.sources.length}</strong></div></section>`;
    }
    return `<aside class="contextDrawer ${state.drawer ? "isOpen" : ""}" aria-label="프로젝트 문맥"><header><span>${state.mode === "lab" ? "Artifact details" : state.mode === "manuscript" ? "Manuscript details" : "Evidence"}</span><button data-action="close-drawer" aria-label="문맥 패널 닫기">닫기</button></header><div class="drawerBody">${content}</div></aside><button class="drawerScrim ${state.drawer ? "isOpen" : ""}" data-action="close-drawer" aria-label="문맥 패널 닫기"></button>`;
  }

  function compactChatMessage(message) {
    const blocks = state.blocksByMessage.get(message.id) || [];
    const text = blocks.length ? blocks.map((block) => block.content).join("\n\n") : message.content;
    const artifactContexts = state.artifactContextsByMessage.get(message.id) || [];
    const artifacts = artifactContexts.map((context) => `<button class="chatArtifactLink" data-chat-artifact-id="${escapeHtml(context.artifact.id)}" data-chat-artifact-version="${escapeHtml(context.selectedVersion.version)}" data-chat-conversation-id="${escapeHtml(message.conversationId)}" data-chat-message-id="${escapeHtml(message.id)}" title="${escapeHtml(`${labLabel(context.linkage.labId)}에서 exact v${context.selectedVersion.version} 열기`)}"><strong>${escapeHtml(context.artifact.title)}</strong><span>${escapeHtml(labLabel(context.linkage.labId))} · v${escapeHtml(context.selectedVersion.version)} 열기 →</span></button>`).join("");
    const user = message.role === "user";
    return `<article class="chatMessage ${user ? "isUser" : "isAssistant"}"><div class="chatMessageRole">${user ? "You" : "Agentlas Science"}</div><div class="chatMessageContent">${escapeHtml(text)}</div>${artifacts}</article>`;
  }

  function chatThreadMarkup() {
    return state.messages.length
      ? state.messages.map(compactChatMessage).join("")
      : `<div class="chatDockEmpty">이 프로젝트의 대화가 여기에 이어집니다.</div>`;
  }

  function composer(docked = false) {
    const running = state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status);
    const needsInitialRun = !running && state.messages.length === 1 && state.messages[0].role === "user" && !state.messages.some((message) => message.role === "assistant");
    const disabled = state.composerSending || !selectedConversation();
    const status = state.composerError || (running ? (state.activeTurn.status === "cancelling" ? "연구 실행을 중단하는 중…" : "Agent runtime 연구 중…") : needsInitialRun ? "저장된 첫 질문을 실행할 수 있습니다" : "Agent runtime 준비");
    return `<footer class="composer${docked ? " dockedComposer" : ""}"><div class="composerBox"><textarea data-composer-input ${disabled || running || needsInitialRun ? "disabled" : ""} rows="2" aria-label="후속 질문" placeholder="후속 질문, 분석 또는 실험 요청">${escapeHtml(state.composerDraft)}</textarea><div class="composerBar"><div class="composerTools"><span class="composerStatus">${escapeHtml(status)}</span><button class="composerAttachButton" disabled title="첨부는 다음 단계에서 연결됩니다" aria-label="첨부 준비 중">${heroIcon("plus")}</button><span class="composerModePill">${heroIcon("sparkles")} Science</span></div><button class="sendButton" data-action="${running ? "cancel-turn" : "send-turn"}" ${disabled || (!needsInitialRun && !state.composerDraft.trim()) ? "disabled" : ""} aria-label="${running ? "중단" : needsInitialRun ? "첫 질문 실행" : "보내기"}">${running ? "■" : "↑"}</button></div></div></footer>`;
  }

  function chatContextLabel() {
    return state.mode === "lab" && state.selectedLabId
      ? `${labLabel(state.selectedLabId)} Lab와 함께 보는 대화`
      : state.mode === "manuscript"
        ? `${manuscriptById(state.selectedManuscriptId)?.title || "Manuscript"}와 함께 보는 대화`
        : "Research와 함께 보는 대화";
  }

  function chatContextTokensMarkup() {
    if (state.mode !== "lab" || !state.selectedLabId) return "";
    const contexts = state.labContextsById.get(state.selectedLabId) || [];
    const context = contexts.find((item) => item.artifact.id === state.selectedArtifactId) || contexts[0];
    if (!context?.artifact) return "";
    const artifact = context.artifact;
    return `<div class="chatContextTokens" aria-label="현재 연구 채팅 컨텍스트"><span title="${escapeHtml(artifact.title)}">${heroIcon("book")}<strong>${escapeHtml(artifact.title)}</strong><em>v${escapeHtml(artifact.currentVersion)}</em></span><span>${heroIcon(labIcons[state.selectedLabId] || "grid")}<strong>${escapeHtml(labLabel(state.selectedLabId))}</strong></span></div>`;
  }

  function chatDockComposerMarkup() {
    return `<div class="chatContextLine">${heroIcon("book")}<span>연구 컨텍스트: ${escapeHtml(chatContextLabel())}</span></div>${chatContextTokensMarkup()}${composer(true)}`;
  }

  function chatDock() {
    return `<aside class="chatDock" data-chat-dock aria-label="연구 협업 채팅"><div class="chatDockFrame"><header class="chatDockHeader"><div class="chatPartner"><span class="chatPartnerMark">${heroIcon("sparkles")}</span><span><strong>AI 연구 파트너</strong><em><span class="onlineDot" aria-hidden="true"></span>온라인</em></span></div><button class="chatHeaderAction" data-action="toggle-drawer" aria-label="연구 문맥과 세부 정보">${heroIcon("ellipsis")}</button></header><div class="chatDockBody" data-chat-dock-body>${chatThreadMarkup()}</div><div class="chatDockComposer" data-chat-dock-composer>${chatDockComposerMarkup()}</div></div></aside>`;
  }

  function renderChatDock() {
    const body = document.querySelector("[data-chat-dock-body]");
    const composerHost = document.querySelector("[data-chat-dock-composer]");
    if (!body || !composerHost) {
      render();
      return;
    }
    const followLatest = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    body.innerHTML = chatThreadMarkup();
    composerHost.innerHTML = chatDockComposerMarkup();
    if (followLatest) body.scrollTop = body.scrollHeight;
  }

  async function startComposerTurn(options = {}) {
    const project = selectedProject();
    const conversation = selectedConversation();
    if (!project || !conversation || state.composerSending) return;
    const needsInitialRun = !options.forceAppend && state.messages.length === 1 && state.messages[0].role === "user" && !state.messages.some((message) => message.role === "assistant");
    const content = state.composerDraft.trim();
    if (!needsInitialRun && !content) return;
    state.composerSending = true;
    state.composerError = "";
    renderChatDock();
    try {
      const started = await science.composer.start({
        requestId: crypto.randomUUID(),
        projectId: project.id,
        conversationId: conversation.id,
        ...(needsInitialRun
          ? { mode: "existing-user-message", userMessageId: state.messages[0].id }
          : { mode: "append-user-message", content }),
      });
      state.activeTurn = started.turn;
      if (!needsInitialRun) state.composerDraft = "";
      state.composerSending = false;
      if (["completed", "failed", "cancelled", "interrupted"].includes(started.turn.status)) {
        if (state.mode === "lab") await refreshConversationOnly(project.id);
        else await selectProject(project.id, { preserveWorkspace: true });
        return;
      }
      renderChatDock();
    } catch (error) {
      state.composerSending = false;
      state.composerError = error instanceof Error ? error.message : String(error);
      renderChatDock();
    }
  }

  async function cancelComposerTurn() {
    const project = selectedProject();
    const conversation = selectedConversation();
    if (!project || !conversation || !state.activeTurn) return;
    state.composerSending = true;
    renderChatDock();
    try {
      await science.composer.cancel({ projectId: project.id, conversationId: conversation.id, turnId: state.activeTurn.id });
    } catch (error) {
      state.composerError = error instanceof Error ? error.message : String(error);
    } finally {
      state.composerSending = false;
      renderChatDock();
    }
  }

  function modal() {
    if (!state.modal) return "";
    return `<div class="modalBackdrop" role="presentation"><form class="modal" id="new-project-form" aria-labelledby="new-project-title"><h2 id="new-project-title">새 연구</h2><p class="modalLead">첫 질문과 프로젝트가 로컬 Science DB에 저장됩니다. 분석·출처·실험 결과는 실제 runtime이 생성한 뒤에만 표시됩니다.</p><label class="field"><span>연구 질문</span><textarea name="question" required maxlength="20000" placeholder="무엇을 발견하거나 검증하고 싶나요?"></textarea></label><label class="field"><span>분야</span><select name="domain"><option value="general">일반 과학</option><option value="life-science">생명과학</option><option value="chemistry">화학</option><option value="physics">물리학</option><option value="materials-science">재료과학</option><option value="genomics">유전체학</option><option value="astronomy">천문학</option><option value="earth-ecology">지구·생태</option><option value="statistics">통계학</option><option value="economics">경제학</option><option value="finance">금융 연구</option></select></label><label class="field"><span>프로젝트 이름 <span class="optional">선택</span></span><input name="title" maxlength="160" placeholder="비워두면 질문에서 이름을 만듭니다" /></label><div class="formError" id="form-error" role="alert"></div><div class="modalActions"><button class="secondaryButton" type="button" data-action="cancel">취소</button><button class="primaryButton" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "저장 중…" : "프로젝트 만들기"}</button></div></form></div>`;
  }

  function manuscriptModal() {
    if (!state.manuscriptModal) return "";
    const project = selectedProject();
    const skeleton = "## Abstract\n\n\n## Introduction\n\n\n## Methods\n\n\n## Results\n\n\n## Discussion\n\n\n## Data and code availability\n\n";
    return `<div class="modalBackdrop" role="presentation"><form class="modal manuscriptCreateModal" id="new-manuscript-form" aria-labelledby="new-manuscript-title"><h2 id="new-manuscript-title">새 원고</h2><p class="modalLead">원고는 ${escapeHtml(project?.title || "현재 프로젝트")}에 저장되며, 이후 저장할 때마다 덮어쓰지 않고 새 immutable version이 추가됩니다.</p><label class="field"><span>원고 제목</span><input name="title" required maxlength="500" placeholder="연구 결과를 정확히 설명하는 제목" /></label><label class="field"><span>초기 Markdown</span><textarea name="markdown" required maxlength="2000000" spellcheck="true">${escapeHtml(skeleton)}</textarea></label><div class="formError" id="manuscript-form-error" role="alert"></div><div class="modalActions"><button class="secondaryButton" type="button" data-action="cancel-manuscript">취소</button><button class="primaryButton" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "저장 중…" : "원고 만들기"}</button></div></form></div>`;
  }

  function journalTargetSheet() {
    if (!state.journalSheet) return "";
    const profile = journalProfileById(state.selectedJournalProfileId);
    return `<div class="bottomSheetScrim" role="presentation"><form class="bottomSheet" id="journal-target-form" aria-labelledby="journal-target-title"><div class="sheetHandle" aria-hidden="true"></div><header><div><span>Official journal profile</span><h2 id="journal-target-title">제출 저널의 공식 규칙을 연결합니다</h2></div><button type="button" data-action="close-journal-sheet" aria-label="저널 설정 닫기">×</button></header><p>저널 이름을 기준으로 추측하지 않습니다. 아래 공식 URL을 AI가 직접 검사하고, 페이지 원문에 존재하는 문구만 규칙으로 저장합니다.</p><div class="sheetGrid"><label class="field"><span>저널 이름</span><input name="journalName" required maxlength="500" value="${escapeHtml(profile?.journalName || "")}" placeholder="예: Nature" /></label><label class="field"><span>Article type</span><input name="articleType" required maxlength="500" value="${escapeHtml(profile?.articleType || "Research Article")}" placeholder="Research Article" /></label></div><label class="field"><span>공식 author-guideline URL <em>한 줄에 하나</em></span><textarea name="sourceUrls" required maxlength="20000" rows="4" placeholder="https://journal.example.org/for-authors/submission-guidelines"></textarea></label><div class="sheetCallout"><strong>AI가 수행할 작업</strong><span>공식 HTTPS 페이지 검사 → 원문·응답 해시 저장 → 구조·분량·그림·윤리·데이터·파일 규칙 추출 → 인용 문구 대조 → 버전형 프로필 생성</span></div><div class="formError" role="alert">${escapeHtml(state.journalActionError)}</div><footer><button class="secondaryButton" type="button" data-action="close-journal-sheet">취소</button><button class="primaryButton" type="submit" ${state.journalActionBusy ? "disabled" : ""}>${state.journalActionBusy ? "AI 연구 요청 중…" : "AI로 공식 지침 확인"}</button></footer></form></div>`;
  }

  function submissionExportSheet() {
    if (!state.submissionSheet) return "";
    const manuscript = manuscriptById(state.selectedManuscriptId);
    const profile = journalProfileById(state.selectedJournalProfileId);
    const bindings = Array.isArray(manuscript?.version?.bindings) ? manuscript.version.bindings : [];
    const figureCount = bindings.filter((binding) => binding?.target?.kind === "artifact").length;
    const referenceCount = bindings.filter((binding) => binding?.target?.kind === "citation").length;
    const ruleCount = Array.isArray(profile?.version?.rules) ? profile.version.rules.length : 0;
    const manualRules = Array.isArray(profile?.version?.rules) ? profile.version.rules.filter((rule) => rule?.severity === "manual" && rule?.check?.kind === "manual-attestation") : [];
    const manualCount = manualRules.length;
    const manualAttestations = manualRules.length ? `<fieldset class="manualAttestations"><legend>사람이 직접 확인해야 하는 항목</legend>${manualRules.map((rule) => `<label><input type="checkbox" name="humanAttestationCode" value="${escapeHtml(rule.check.code)}" required /><span><strong>${escapeHtml(rule.requirement)}</strong><small>이 확인은 현재 원고 v${escapeHtml(manuscript?.currentVersion || "-")} · 프로필 v${escapeHtml(profile?.currentVersion || "-")}에만 유효하며 한 번만 사용됩니다.</small></span></label>`).join("")}</fieldset>` : "";
    const draft = state.submissionDraft || {};
    const draftValue = (name) => escapeHtml(draft[name] || "");
    const validation = state.journalValidation?.status && state.journalValidation.status !== "ready" ? state.journalValidation : null;
    const validationNotice = validation
      ? `<div class="submissionValidationNotice journalValidationSummary" data-status="${escapeHtml(validation.status)}"><strong>${escapeHtml(validation.status)}</strong><span>${escapeHtml(validation.counts.pass)} pass · ${escapeHtml(validation.counts.fail)} fail · ${escapeHtml(validation.counts.manual)} manual</span></div>${validation.findings.filter((finding) => finding.status !== "pass").slice(0, 5).map((finding) => `<div class="journalFinding" data-status="${escapeHtml(finding.status)}" data-severity="${escapeHtml(finding.severity)}"><span>${finding.status === "manual" ? "?" : "!"}</span><div><strong>${escapeHtml(finding.requirement)}</strong><em>${escapeHtml(finding.observed)}</em></div></div>`).join("")}`
      : "";
    return `<div class="bottomSheetScrim" role="presentation"><form class="bottomSheet submissionSheet" id="submission-export-form" aria-labelledby="submission-export-title"><div class="sheetHandle" aria-hidden="true"></div><header><div><span>Journal submission</span><h2 id="submission-export-title">검증 가능한 제출 패키지 만들기</h2></div><button type="button" data-action="close-submission-sheet" aria-label="제출 정보 닫기">×</button></header>
      <nav class="submissionSteps" aria-label="제출 패키지 진행 단계"><button type="button" data-action="open-journal-sheet"><span>1</span><strong>저널 규칙</strong></button><button type="button" aria-current="step" disabled><span>2</span><strong>저자 정보</strong></button><button type="button" data-action="submission-review"><span>3</span><strong>최종 검증</strong></button></nav>
      <div class="submissionSheetBody"><section class="submissionFormPane"><p>원고 v${escapeHtml(manuscript?.currentVersion || "-")}와 저널 프로필 v${escapeHtml(profile?.currentVersion || "-")}를 정확히 고정합니다. 남은 항목은 AI가 하나씩 확인하고, 필수 규칙이 남으면 제출 ZIP을 만들지 않습니다.</p>
        <div class="submissionIdentityGrid"><label class="field"><span>Corresponding author</span><input name="authorName" required maxlength="500" value="${draftValue("authorName")}" placeholder="Full legal name" /></label><label class="field"><span>Affiliation</span><input name="affiliation" required maxlength="1000" value="${draftValue("affiliation")}" placeholder="Institution, department" /></label><label class="field"><span>Email</span><input name="email" type="email" required maxlength="500" value="${draftValue("email")}" placeholder="name@institution.edu" /></label><label class="field"><span>ORCID <em>선택</em></span><input name="orcid" maxlength="40" value="${draftValue("orcid")}" placeholder="0000-0000-0000-0000" /></label><label class="field submissionKeywords"><span>Keywords <em>쉼표 구분</em></span><input name="keywords" maxlength="5000" value="${draftValue("keywords")}" placeholder="예: catalysis, selectivity, molecular docking" /></label></div>
        <div class="submissionStatementCards"><label class="submissionStatementCard"><span>${heroIcon("book")}<strong>Funding statement</strong></span><small>연구를 지원한 펀딩 기관과 지원 번호</small><textarea name="funding" maxlength="20000" placeholder="지원 정보가 없다면 None을 입력하세요.">${draftValue("funding")}</textarea></label><label class="submissionStatementCard"><span>${heroIcon("grid")}<strong>Competing interests</strong></span><small>잠재적 이해 상충과 관련 관계</small><textarea name="competing" maxlength="20000" placeholder="이해 상충이 없다면 None을 입력하세요.">${draftValue("competing")}</textarea></label><label class="submissionStatementCard"><span>${heroIcon("sparkles")}<strong>Author contributions</strong></span><small>각 저자의 실제 기여와 책임 범위</small><textarea name="contributions" maxlength="40000" placeholder="CRediT 역할을 기준으로 작성하세요.">${draftValue("contributions")}</textarea></label></div>
        <details class="submissionMore"><summary>데이터·코드·윤리 및 커버레터 추가</summary><div class="statementGrid"><label class="field"><span>Data availability</span><textarea name="dataAvailability" maxlength="40000">${draftValue("dataAvailability")}</textarea></label><label class="field"><span>Code availability</span><textarea name="codeAvailability" maxlength="40000">${draftValue("codeAvailability")}</textarea></label><label class="field"><span>Ethics statement</span><textarea name="ethics" maxlength="40000">${draftValue("ethics")}</textarea></label></div><label class="field"><span>Cover letter <em>선택</em></span><textarea name="coverLetter" maxlength="100000" rows="4">${draftValue("coverLetter")}</textarea></label></details>${manualAttestations}
        ${validationNotice}<div class="formError" role="alert">${escapeHtml(state.journalActionError)}</div></section>
        <aside class="submissionSummary"><h3>제출 패키지 요약</h3><dl><div><dt>Target journal</dt><dd>${escapeHtml(profile?.journalName || "선택 필요")}</dd></div><div><dt>Manuscript</dt><dd>${escapeHtml(manuscript?.title || "원고 선택 필요")} · v${escapeHtml(manuscript?.currentVersion || "-")}</dd></div></dl><ul><li><span>검증된 규칙</span><strong>${escapeHtml(ruleCount)} / ${escapeHtml(ruleCount)}</strong></li><li><span>수동 확인 필요</span><strong>${escapeHtml(manualCount)}</strong></li><li><span>정확한 그림</span><strong>${escapeHtml(figureCount)}</strong></li><li><span>참고문헌 연결</span><strong>${escapeHtml(referenceCount)}</strong></li></ul><p>${heroIcon("sparkles")}<span>AI가 남은 항목을 하나씩 질문하며 함께 완성합니다.</span></p></aside></div>
      <footer><span>DOCX · TeX · exact figures · evidence ledger · SHA-256 manifest</span><button class="secondaryButton" type="button" data-action="close-submission-sheet">나중에</button><button class="primaryButton" type="submit" ${state.journalActionBusy ? "disabled" : ""}>${state.journalActionBusy ? "검증 중…" : "다음: 최종 검증"}</button></footer></form></div>`;
  }

  function evidenceGraphInferenceReviewSheet() {
    if (!state.evidenceGraphReviewSheet || !state.evidenceGraph) return "";
    const candidate = evidenceGraphCandidateById(state.selectedEvidenceGraphCandidateId);
    if (!candidate) return "";
    const node = evidenceGraphNodeById(candidate.nodeId);
    const existing = evidenceGraphReviewForCandidate(candidate);
    const decision = existing?.decision || state.evidenceGraphReviewDecision || "accepted";
    return `<div class="bottomSheetScrim evidenceGraphReviewScrim" role="presentation"><form class="bottomSheet evidenceGraphReviewSheet" id="evidence-graph-review-form" role="dialog" aria-modal="true" aria-labelledby="evidence-graph-review-title" data-candidate-id="${escapeHtml(candidate.id)}" data-candidate-sha256="${escapeHtml(candidate.contentSha256)}"><div class="sheetHandle" aria-hidden="true"></div><header><div><span>Evidence Graph · human review</span><h2 id="evidence-graph-review-title">${escapeHtml(candidate.label)}</h2></div><button type="button" data-action="close-evidence-graph-review" aria-label="Close inference review">×</button></header><div class="evidenceGraphReviewBody"><section class="evidenceGraphReviewStatement"><span>${escapeHtml(evidenceGraphKindLabel(candidate.kind))} · ${escapeHtml(candidate.evidencePathNodeIds.length)} exact path nodes · ${escapeHtml(candidate.independentSourceVersionCount)} independent sources</span><strong>${escapeHtml(node?.statement || candidate.label)}</strong><p>${escapeHtml(candidate.rationale)}</p></section><div class="evidenceGraphReviewBoundary"><strong>Review boundary</strong><span>Accepting records that this candidate may proceed to testing or synthesis. It does not change the node from candidate to supported and does not authorize a manuscript conclusion.</span></div><fieldset class="evidenceGraphReviewOptions"><legend>Decision</legend><label data-decision="accepted"><input type="radio" name="decision" value="accepted" ${decision === "accepted" ? "checked" : ""} required><span><strong>Accept for further work</strong><em>Keep it as a reviewed inference candidate.</em></span></label><label data-decision="rejected"><input type="radio" name="decision" value="rejected" ${decision === "rejected" ? "checked" : ""} required><span><strong>Reject this inference</strong><em>Preserve the rejected review in the immutable audit trail.</em></span></label></fieldset><label class="field"><span>Review rationale</span><textarea name="rationale" required maxlength="20000" rows="4" placeholder="Explain why this inference should proceed or be rejected.">${escapeHtml(existing?.rationale || "")}</textarea></label>${candidate.missingRequirements.length ? `<section class="evidenceGraphReviewMissing"><strong>Still missing</strong><ul>${candidate.missingRequirements.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : ""}<div class="formError" role="alert">${escapeHtml(state.evidenceGraphReviewError)}</div></div><footer><span>Candidate <code>${escapeHtml(evidenceGraphShortHash(candidate.contentSha256))}</code> · graph r${escapeHtml(state.evidenceGraph.revision)}</span><button class="secondaryButton" type="button" data-action="close-evidence-graph-review" ${state.evidenceGraphReviewBusy ? "disabled" : ""}>Cancel</button><button class="primaryButton" type="submit" ${state.evidenceGraphReviewBusy ? "disabled" : ""}>${state.evidenceGraphReviewBusy ? "Saving review…" : existing ? "Append review decision" : "Record review"}</button></footer></form></div>`;
  }

  function researchDecisionSheet() {
    if (state.researchContract?.status === "draft") return "";
    const decision = presentedLifecycleDecision();
    if (!decision) return "";
    const analysisSpec = analysisSpecById(decision.analysisSpecId);
    const optionCards = decision.options.map((option) => {
      const benefits = Array.isArray(option.benefits) && option.benefits.length
        ? `<div><strong>장점</strong><ul>${option.benefits.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : "";
      const risks = Array.isArray(option.risks) && option.risks.length
        ? `<div><strong>주의점</strong><ul>${option.risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : "";
      return `<label class="decisionOptionCard" data-recommended="${Boolean(option.recommended)}"><input type="radio" name="optionId" value="${escapeHtml(option.id)}" ${option.recommended ? "checked" : ""} required /><span class="decisionOptionControl" aria-hidden="true"></span><span class="decisionOptionCopy"><span class="decisionOptionTitle"><strong>${escapeHtml(option.label)}</strong>${option.recommended ? `<em>AI 추천</em>` : ""}</span><span class="decisionOptionDescription">${escapeHtml(option.description)}</span><span class="decisionOptionEvidence">${benefits}${risks}</span><span class="decisionOptionImpact"><strong>연구에 미치는 영향</strong>${escapeHtml(option.downstreamImpact)}</span></span></label>`;
    }).join("");
    return `<div class="bottomSheetScrim decisionSheetScrim" role="presentation"><form class="bottomSheet researchDecisionSheet" id="research-decision-form" role="dialog" aria-modal="true" aria-labelledby="research-decision-title"><div class="sheetHandle" aria-hidden="true"></div><header><div><span>Research decision · ${escapeHtml(analysisSpec?.title || "Analysis plan")}</span><h2 id="research-decision-title">${escapeHtml(decision.prompt.title)}</h2></div><button type="button" data-action="defer-research-decision" aria-label="이 결정을 나중에 답하기">×</button></header><div class="decisionSheetBody"><section class="decisionQuestion"><p>${escapeHtml(decision.prompt.question)}</p><div class="decisionWhy"><div><strong>왜 지금 묻나요?</strong><span>${escapeHtml(decision.prompt.whyAsked)}</span></div><div><strong>답하지 않으면</strong><span>${escapeHtml(decision.prompt.impactIfUnanswered)}</span></div></div></section><fieldset class="decisionOptions"><legend>연구 방향을 선택하세요</legend>${optionCards}</fieldset><label class="decisionRationale"><span>선택 이유 <em>선택 사항</em></span><textarea name="rationale" maxlength="8000" rows="3" placeholder="판단 근거, 제약 또는 AI가 다음 단계에서 고려할 내용을 남겨 주세요."></textarea></label><div class="decisionRecommendation"><strong>AI 추천 근거 · 신뢰도 ${escapeHtml(Math.round(Number(decision.recommendation?.confidence || 0) * 100))}%</strong><span>${escapeHtml(decision.recommendation?.rationale || "")}</span></div><div class="formError" role="alert">${escapeHtml(state.decisionError)}</div></div><footer><span>선택은 immutable decision receipt로 저장되며 분석계획 새 버전에 적용됩니다.</span><button class="secondaryButton" type="button" data-action="defer-research-decision" ${state.decisionBusy ? "disabled" : ""}>나중에</button><button class="primaryButton" type="submit" ${state.decisionBusy ? "disabled" : ""}>${state.decisionBusy ? "적용 중…" : "이 선택으로 계속"}</button></footer></form></div>`;
  }

  function researchContractApprovalSheet() {
    const contract = state.researchContract;
    const project = selectedProject();
    if (!state.researchContractSheet || !contract || contract.status !== "draft" || contract.projectId !== state.selectedId) return "";
    const list = (items, emptyLabel) => Array.isArray(items) && items.length
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : `<p class="contractEmpty">${escapeHtml(emptyLabel)}</p>`;
    const projectVersion = Number(project?.version);
    const ready = Number.isSafeInteger(projectVersion) && projectVersion > 0 && Number.isSafeInteger(contract.version) && contract.version > 0;
    return `<div class="bottomSheetScrim contractSheetScrim" role="presentation"><form class="bottomSheet researchContractSheet" id="research-contract-approval-form" role="dialog" aria-modal="true" aria-labelledby="research-contract-title" aria-describedby="research-contract-summary" tabindex="-1" data-contract-id="${escapeHtml(contract.id)}" data-contract-version="${escapeHtml(contract.version)}" data-project-version="${escapeHtml(projectVersion)}"><div class="sheetHandle" aria-hidden="true"></div><header><div class="contractHeaderCopy"><div class="contractHeaderMeta"><span class="contractStatusPill">승인 대기</span><span>AI 초안 · 계약 v${escapeHtml(contract.version)}</span></div><h2 id="research-contract-title">연구 계약 검토</h2><p id="research-contract-summary">실험을 시작하기 전에 목표, 성공 조건과 중단 기준을 확인하세요.</p></div><button class="contractCloseButton" type="button" data-action="close-research-contract-sheet" aria-label="연구 계약 초안을 승인하지 않고 닫기">닫기</button></header><div class="contractSheetBody"><div class="contractMainColumn"><section class="contractObjective"><div class="contractSectionHeading"><strong>연구 목표</strong><span>Objective</span></div><p>${escapeHtml(contract.objective)}</p></section><div class="contractCriteriaGrid"><section class="contractCriteriaCard contractSuccess"><div class="contractCardTitle"><span><strong>성공 기준</strong><em>연구를 계속할 수 있는 조건</em></span></div>${list(contract.successCriteria, "등록된 성공 기준이 없습니다.")}</section><section class="contractCriteriaCard contractFailure"><div class="contractCardTitle"><span><strong>중단 기준</strong><em>중단하거나 다시 설계할 조건</em></span></div>${list(contract.failureCriteria, "등록된 중단 기준이 없습니다.")}</section></div><section class="contractConstraints"><div class="contractSectionHeading"><strong>운영 제약</strong><span>Constraints</span></div>${list(contract.constraints, "추가 운영 제약 없음")}</section></div><aside class="contractSummaryPanel" aria-label="승인할 연구 계약 요약"><div class="contractSummaryHeading"><span>승인 대상</span><strong>현재 버전 고정</strong></div><dl class="contractVersionList"><div><dt>프로젝트</dt><dd>v${escapeHtml(projectVersion)}</dd></div><div><dt>연구 계약</dt><dd>v${escapeHtml(contract.version)}</dd></div><div><dt>계약 ID</dt><dd title="${escapeHtml(contract.id)}">${escapeHtml(contract.id.slice(0, 8))}</dd></div></dl><div class="contractBudget"><span><strong>${escapeHtml(contract.maxEpisodes)}</strong>최대 에피소드</span><span><strong>${escapeHtml(contract.maxWallTimeMinutes)}</strong>최대 시간(분)</span></div><div class="contractApprovalNote"><strong>버전 보호</strong><span>승인 직전에 두 버전을 다시 확인합니다. 변경되면 자동 승인하지 않습니다.</span></div></aside><div class="formError" role="alert">${escapeHtml(state.researchContractError)}</div></div><footer><div class="contractFooterContext"><strong>프로젝트 v${escapeHtml(projectVersion)} · 계약 v${escapeHtml(contract.version)}</strong><span>이 조합만 승인됩니다.</span></div><button class="secondaryButton" type="button" data-action="revise-research-contract" ${state.researchContractBusy ? "disabled" : ""}>수정 요청</button><button class="primaryButton" type="submit" ${!ready || state.researchContractBusy ? "disabled" : ""}>${state.researchContractBusy ? "최신 버전 확인 중…" : `계약 v${escapeHtml(contract.version)} 승인`}</button></footer></form></div>`;
  }

  function captureSubmissionDraft(form) {
    if (!(form instanceof HTMLFormElement)) return;
    const data = new FormData(form);
    state.submissionDraft = Object.fromEntries([
      "authorName", "affiliation", "email", "orcid", "keywords", "funding", "competing", "contributions",
      "dataAvailability", "codeAvailability", "ethics", "coverLetter",
    ].map((name) => [name, String(data.get(name) || "")]));
  }

  async function deferPresentedResearchDecision() {
    const decision = presentedLifecycleDecision();
    if (!decision || !state.selectedId || state.decisionBusy) return;
    state.decisionBusy = true;
    state.decisionError = "";
    render();
    try {
      const result = await science.decisions.defer({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        decisionId: decision.id,
        expectedLockVersion: decision.lockVersion,
        deferUntil: null,
      });
      state.decisions = state.decisions.filter((item) => item.id !== decision.id);
      if (result?.decision?.status === "presented") state.decisions.unshift(result.decision);
    } catch (error) {
      state.decisionError = error instanceof Error ? error.message : String(error);
    } finally {
      state.decisionBusy = false;
      render();
    }
  }

  function welcome() {
    return `<section class="welcome"><div class="welcomeInner"><div class="welcomeLabel">Agentlas Science</div><h1>질문에서 검증 가능한 연구까지.</h1><p>대화, 근거, 실험, 시각 자료와 논문을 하나의 로컬 연구 기록으로 연결합니다. 아직 생성된 연구는 없습니다.</p><button class="startButton" data-action="new">새 연구 시작</button></div>${modal()}</section>`;
  }

  function workspace() {
    const project = selectedProject();
    if (!project) return welcome();
    const main = state.mode === "session" ? researchView(project) : state.mode === "manuscript" ? manuscriptWorkbench() : artifactWorkbench();
    return `<section class="workspace ${state.drawer ? "drawerOpen" : ""}" data-workspace-mode="${escapeHtml(state.mode)}" data-project-destination="${escapeHtml(state.currentDestination)}" data-rail-collapsed="${state.railCollapsed}">${projectRail(project)}<button class="railScrim" data-action="collapse-rail" aria-label="사이드바 닫기"></button><main class="mainPane"><header class="topbar"><div class="topLocation workspaceLocation"><button class="workspaceSidebarReveal" data-action="expand-rail" aria-label="사이드바 열기" title="사이드바 열기">${heroIcon("chevron-right")}</button><div class="workspaceTabGroup" role="tablist" aria-label="연구, 열린 Lab 아티팩트와 원고">${researchWorkspaceTabButton()}<div class="workspaceTabsShell" data-workspace-tabs-shell><button class="workspaceTabOverflow workspaceTabOverflowPrevious" type="button" data-action="scroll-workspace-tabs" data-direction="previous" aria-label="이전 열린 탭 보기" hidden>${heroIcon("chevron-right", "uiIcon isReverse")}</button><nav class="workspaceTabs" data-workspace-tabs role="presentation">${workspaceTabButtons()}</nav><button class="workspaceTabOverflow workspaceTabOverflowNext" type="button" data-action="scroll-workspace-tabs" data-direction="next" aria-label="다음 열린 탭 보기" hidden>${heroIcon("chevron-right")}</button></div></div><button class="workspaceTabAdd" data-action="new" aria-label="새 연구 시작" title="새 연구">${heroIcon("plus")}</button></div><div class="topActions">${state.workspaceSyncError ? `<span class="workspaceSyncWarning" role="status" title="${escapeHtml(state.workspaceSyncError)}">저장 실패</span>` : ""}<span class="statusPill" title="${escapeHtml(`${lifecycleLabel()} · ${state.lifecycle?.stateSha256 || ""}`)}">${escapeHtml(lifecycleCompactLabel())}</span><button data-action="toggle-drawer">${state.mode === "session" ? "근거" : "세부"}</button></div></header><div class="workspaceBody"><div class="contentPane workspaceCenter"><div class="workspaceSurface" id="science-workspace-panel" role="tabpanel" aria-labelledby="${escapeHtml(workspaceTabDomId(state.activeWorkspaceTabId))}" data-workspace-surface>${main}</div></div>${chatDock()}</div></main>${contextDrawer()}${modal()}${manuscriptModal()}${journalTargetSheet()}${submissionExportSheet()}${evidenceGraphInferenceReviewSheet()}${researchContractApprovalSheet()}${researchDecisionSheet()}</section>`;
  }

  function rememberScroll(mode = state.mode) {
    const pane = document.querySelector(".contentPane");
    if (pane) state.scrollByMode[mode] = pane.scrollTop;
  }

  function render() {
    teardownArtifactRenderer();
    root.innerHTML = workspace();
    i18n.localizeTree(root);
    root.setAttribute("aria-busy", "false");
    const contentPane = document.querySelector(".contentPane");
    if (contentPane) contentPane.scrollTop = state.scrollByMode[state.mode] || 0;
    if (state.modal) document.querySelector('textarea[name="question"]')?.focus();
    if (state.researchContractSheet) requestAnimationFrame(() => document.querySelector(".researchContractSheet")?.focus({ preventScroll: true }));
    if (state.mode === "lab" && state.selectedArtifactId && state.artifactHistoryById.has(state.selectedArtifactId)) {
      void hydrateArtifactRenderer();
      if (state.artifactComparison?.diff) void hydrateArtifactComparePreviews(state.artifactComparison);
    }
    if (state.mode === "session") {
      void hydrateInlineArtifactRenderers();
      void hydrateEvidenceGraph();
    }
    syncRailPresentation();
    requestAnimationFrame(revealActiveWorkspaceTab);
  }

  function syncRailPresentation() {
    const workspaceNode = document.querySelector(".workspace");
    const main = workspaceNode?.querySelector(".mainPane");
    if (!workspaceNode || !main) return;
    workspaceNode.dataset.railCollapsed = String(state.railCollapsed);
    const overlayOpen = !state.railCollapsed && window.matchMedia("(max-width: 1279px)").matches;
    if (overlayOpen) main.setAttribute("inert", "");
    else main.removeAttribute("inert");
  }

  function setRailCollapsed(collapsed) {
    state.railCollapsed = Boolean(collapsed);
    try { window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, String(state.railCollapsed)); } catch {}
    syncRailPresentation();
    requestAnimationFrame(syncWorkspaceTabOverflow);
    window.setTimeout(syncWorkspaceTabOverflow, 220);
    if (state.railCollapsed) document.querySelector('.workspaceSidebarReveal')?.focus();
    else document.querySelector('.railCollapseButton')?.focus();
  }

  function teardownArtifactRenderer() {
    for (const view of state.inlineVegaViews) { try { view.finalize(); } catch {} }
    state.inlineVegaViews = [];
    for (const url of state.inlinePreviewUrls) { try { URL.revokeObjectURL(url); } catch {} }
    state.inlinePreviewUrls = [];
    disposeComparePreviews();
    if (state.activeVegaView) { try { state.activeVegaView.finalize(); } catch {} state.activeVegaView = null; }
    if (state.activeCytoscape) { try { state.activeCytoscape.destroy(); } catch {} state.activeCytoscape = null; }
    if (state.activeNumericSurface) { try { state.activeNumericSurface.dispose(); } catch {} state.activeNumericSurface = null; }
    if (state.activeJBrowseTarget) {
      try { window.AgentlasJBrowse?.unmount?.(state.activeJBrowseTarget); } catch {}
      state.activeJBrowseTarget = null;
    }
    if (state.rendererObserver) { try { state.rendererObserver.disconnect(); } catch {} state.rendererObserver = null; }
    if (state.rendererAbort) { state.rendererAbort.abort(); state.rendererAbort = null; }
    if (state.activeRendererIdentity) {
      state.activeRendererIdentity = null;
      state.activeRendererInstance = null;
      state.activeRendererPhase = null;
      state.activeRendererVisible = null;
      void science?.renderers?.dispose?.().catch(() => {});
    }
  }

  async function hydrateInlineArtifactRenderers() {
    if (!window.vega || !window.vegaExpressionInterpreter) return;
    const hosts = [...document.querySelectorAll("[data-inline-vega-artifact]")];
    for (const host of hosts) {
      const artifactId = host.dataset.inlineVegaArtifact;
      const artifactVersion = Number(host.dataset.inlineVegaVersion);
      const context = [...state.artifactContextsByMessage.values()].flat().find((item) => item.artifact.id === artifactId && item.selectedVersion.version === artifactVersion);
      const spec = context?.selectedVersion?.payload?.spec;
      if (!spec || typeof spec !== "object" || Array.isArray(spec) || !host.isConnected) continue;
      try {
        const runtime = window.vega.parse(spec, undefined, { ast: true });
        const view = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host).hover();
        const width = Math.max(220, Math.floor(host.getBoundingClientRect().width) - 110);
        view.width(width).height(230);
        state.inlineVegaViews.push(view);
        await view.runAsync();
      } catch (error) {
        host.textContent = error instanceof Error ? error.message : String(error);
        host.dataset.renderFailed = "true";
      }
    }
    const captureHosts = [...document.querySelectorAll("[data-inline-capture-artifact]")];
    for (const host of captureHosts) {
      try {
        const preview = await science.artifacts.preview(state.selectedId, host.dataset.inlineCaptureArtifact, Number(host.dataset.inlineCaptureVersion));
        if (!preview?.bytes || !host.isConnected) {
          host.textContent = "검증된 시각 캡처가 생성되면 여기에 표시됩니다.";
          host.dataset.previewMissing = "true";
          continue;
        }
        const bytes = preview.bytes instanceof Uint8Array ? preview.bytes : new Uint8Array(preview.bytes);
        const url = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType || "image/png" }));
        state.inlinePreviewUrls.push(url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = host.getAttribute("aria-label") || "Lab artifact preview";
        image.width = preview.width;
        image.height = preview.height;
        host.replaceChildren(image);
      } catch (error) {
        host.textContent = error instanceof Error ? error.message : String(error);
        host.dataset.renderFailed = "true";
      }
    }
  }

  function rendererMountInput(artifact, host) {
    const rect = host.getBoundingClientRect();
    return {
      projectId: artifact.projectId,
      artifactId: artifact.id,
      artifactVersion: artifact.version.version,
      contentSha256: artifact.version.contentSha256,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  function applyRendererStatus(status) {
    if (!status || typeof status !== "object") return;
    const labArtifacts = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact);
    const artifact = labArtifacts.find((item) => item.id === state.selectedArtifactId) || labArtifacts[0];
    if (!artifact || status.artifactId !== artifact.id || status.artifactVersion !== artifact.version.version) return;
    if (artifact.version.rendererId !== "agentlas.vega" && (!state.activeRendererInstance || status.instanceId !== state.activeRendererInstance)) return;
    state.activeRendererPhase = status.phase;
    if (status.phase === "dirty") setActiveWorkspaceTabDirty(true);
    else if (["clean", "ready"].includes(status.phase)) setActiveWorkspaceTabDirty(false);
    const node = document.querySelector("[data-runtime-status]");
    if (node) node.textContent = `· ${status.phase}${status.summary ? ` — ${status.summary}` : ""}`;
    const bar = document.querySelector(".rendererStatus");
    if (bar && status.phase === "ready" && status.captured === true) bar.dataset.visualCapture = "verified";
    const errorNode = document.querySelector("[data-render-error]");
    if (errorNode && status.phase === "failed") errorNode.textContent = status.summary || status.code || "렌더러 실행에 실패했습니다.";
  }

  function citationScalePositions(cy) {
    const nodes = cy.nodes().toArray();
    if (!nodes.length) return new Map();
    const ranked = [...nodes].sort((left, right) => {
      const seedDelta = Number(Boolean(right.data("isSeed"))) - Number(Boolean(left.data("isSeed")));
      if (seedDelta) return seedDelta;
      return Number(right.data("citationCount") || 0) - Number(left.data("citationCount") || 0);
    });
    const seed = ranked[0];
    const satellites = ranked.slice(1);
    const positions = new Map([[seed.id(), { x: 0, y: 0 }]]);
    satellites.forEach((node, index) => {
      const ring = Math.floor(index / 8);
      const ringNodes = satellites.slice(ring * 8, (ring + 1) * 8);
      const ringIndex = index - ring * 8;
      const radius = 155 + ring * 118;
      const angle = (-Math.PI / 2) + ((Math.PI * 2 * ringIndex) / Math.max(1, ringNodes.length));
      positions.set(node.id(), { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
    return positions;
  }

  function citationLayoutOptions(name, cy) {
    if (name === "concentric") {
      const positions = citationScalePositions(cy);
      return {
        name: "preset",
        positions: (node) => positions.get(node.id()) || { x: 0, y: 0 },
        animate: true,
        animationDuration: 260,
        fit: true,
        padding: 54,
      };
    }
    if (name === "grid") return { name: "grid", animate: true, animationDuration: 260, fit: true, padding: 48, avoidOverlap: true, spacingFactor: 1.24 };
    return { name: "cose", animate: true, animationDuration: 320, fit: true, padding: 48, nodeRepulsion: 12000, idealEdgeLength: 118, gravity: .38, randomize: true };
  }

  function renderCitationNetwork(version, host, interactive = true) {
    const network = version?.payload?.network;
    if (!window.cytoscape || !network || !Array.isArray(network.nodes) || !Array.isArray(network.edges)) throw new Error("검증된 문헌 네트워크 데이터 또는 Cytoscape 런타임이 없습니다.");
    const elements = [
      ...network.nodes.map((node) => ({ data: { ...node, label: node.title } })),
      ...network.edges.map((edge) => ({ data: { ...edge } })),
    ];
    const cy = window.cytoscape({
      container: host,
      elements,
      minZoom: .18,
      maxZoom: 3.5,
      wheelSensitivity: .18,
      userPanningEnabled: interactive,
      userZoomingEnabled: interactive,
      boxSelectionEnabled: interactive,
      style: [
        { selector: "node", style: { "background-color": "#2e6f73", "border-width": 2, "border-color": "#ffffff", label: "data(label)", color: "#242321", "font-size": 11, "font-weight": 560, "text-wrap": "wrap", "text-max-width": 160, "text-valign": "bottom", "text-margin-y": 12, "text-background-color": "#ffffff", "text-background-opacity": .84, "text-background-padding": 4, "text-background-shape": "roundrectangle", width: "mapData(citationCount, 0, 1000, 30, 80)", height: "mapData(citationCount, 0, 1000, 30, 80)" } },
        { selector: "node[isSeed]", style: { "background-color": "#b65f3a", "border-color": "#f6ded2", "border-width": 4 } },
        { selector: "node:selected", style: { "border-color": "#171715", "border-width": 4 } },
        { selector: "edge[relation = 'cites']", style: { width: 1.4, "line-color": "#8aa9aa", "target-arrow-color": "#8aa9aa", "target-arrow-shape": "triangle", "curve-style": "bezier", opacity: .78 } },
        { selector: "edge[relation = 'related']", style: { width: 1, "line-color": "#b7afa8", "line-style": "dashed", "curve-style": "bezier", opacity: .58 } },
      ],
      layout: { name: "cose", animate: false, fit: true, padding: 48, nodeRepulsion: 12000, idealEdgeLength: 118, gravity: .38, randomize: true },
    });
    host.dataset.citationNodeCount = String(network.nodes.length);
    host.dataset.citationEdgeCount = String(network.edges.length);
    if (interactive) {
      cy.on("tap", "node", (event) => {
        const data = event.target.data();
        const panel = document.querySelector("[data-citation-node-detail]");
        if (!panel) return;
        panel.replaceChildren();
        const title = document.createElement("strong"); title.textContent = data.title;
        const meta = document.createElement("span"); meta.textContent = [data.publicationYear, data.containerTitle].filter(Boolean).join(" · ") || "출판 메타데이터 없음";
        const authors = document.createElement("span"); authors.textContent = Array.isArray(data.authors) && data.authors.length ? data.authors.slice(0, 6).join(", ") : "저자 정보 없음";
        const citation = document.createElement("span"); citation.textContent = `인용 ${data.citationCount ?? "—"} · ${data.openAlexId ? "OpenAlex 연결" : "메타데이터 노드"}`;
        panel.append(title, meta, authors, citation);
        panel.dataset.selected = "true";
      });
      state.activeCytoscape = cy;
    }
    return cy;
  }

  function renderEvidenceGraph(graph, host) {
    if (!window.cytoscape || !graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error("The verified Evidence Graph or Cytoscape runtime is unavailable.");
    const elements = [
      ...graph.nodes.map((node) => ({ data: {
        id: node.id, label: node.label, kind: node.kind, assertionKind: node.assertionKind,
        epistemicStatus: node.epistemicStatus, invalidated: node.epistemicStatus === "invalidated" ? 1 : 0,
      } })),
      ...graph.edges.map((edge) => ({ data: { id: edge.id, source: edge.fromNodeId, target: edge.toNodeId, kind: edge.kind } })),
    ];
    const cy = window.cytoscape({
      container: host,
      elements,
      minZoom: .16,
      maxZoom: 3.4,
      boxSelectionEnabled: false,
      style: [
        { selector: "node", style: { "background-color": "#c7ccd0", "border-width": 2, "border-color": "#ffffff", label: "data(label)", color: "#2d302f", "font-size": 9, "font-weight": 600, "text-wrap": "wrap", "text-max-width": 118, "text-valign": "bottom", "text-margin-y": 9, "text-background-color": "#ffffff", "text-background-opacity": .9, "text-background-padding": 3, "text-background-shape": "roundrectangle", width: 30, height: 30 } },
        { selector: "node[epistemicStatus = 'supported']", style: { "background-color": "#3f7d5b", width: 36, height: 36 } },
        { selector: "node[epistemicStatus = 'candidate']", style: { "background-color": "#b48335" } },
        { selector: "node[epistemicStatus = 'contradicted']", style: { "background-color": "#a54b43" } },
        { selector: "node[epistemicStatus = 'mixed']", style: { "background-color": "#7b6596" } },
        { selector: "node[epistemicStatus = 'inconclusive']", style: { "background-color": "#6f7478" } },
        { selector: "node[invalidated = 1]", style: { "background-color": "#ffffff", "border-color": "#b42318", "border-width": 3, "border-style": "double", color: "#8f3029", opacity: .82 } },
        { selector: "node:selected", style: { "border-color": "#171715", "border-width": 4, "overlay-color": "#171715", "overlay-opacity": .06 } },
        { selector: "edge", style: { width: 1.15, "line-color": "#c2c5c3", "target-arrow-color": "#c2c5c3", "target-arrow-shape": "triangle", "arrow-scale": .7, "curve-style": "bezier", opacity: .72 } },
        { selector: "edge[kind = 'cites']", style: { "line-color": "#a7aaad", "target-arrow-color": "#a7aaad", "line-style": "dotted", width: 1, opacity: .58 } },
        { selector: "edge[kind = 'supports']", style: { "line-color": "#3f7d5b", "target-arrow-color": "#3f7d5b", width: 2.4, opacity: .9 } },
        { selector: "edge[kind = 'contradicts']", style: { "line-color": "#a54b43", "target-arrow-color": "#a54b43", "line-style": "dashed", width: 2.4, opacity: .9 } },
        { selector: "edge[kind = 'qualifies']", style: { "line-color": "#7b6596", "target-arrow-color": "#7b6596", "line-style": "dashed", width: 1.8 } },
        { selector: "edge[kind = 'invalidated-by']", style: { "line-color": "#b42318", "target-arrow-color": "#b42318", "line-style": "dotted", width: 2 } },
        { selector: "edge[kind = 'identifies-gap']", style: { "line-color": "#b48335", "target-arrow-color": "#b48335", "line-style": "dashed", width: 1.8 } },
      ],
      layout: { name: "cose", animate: false, fit: true, padding: 48, nodeRepulsion: 9000, idealEdgeLength: 96, edgeElasticity: 110, gravity: .45, randomize: true },
    });
    if (state.selectedEvidenceGraphNodeId) cy.getElementById(state.selectedEvidenceGraphNodeId).select();
    cy.on("tap", "node", (event) => {
      const nodeId = event.target.id();
      state.selectedEvidenceGraphNodeId = nodeId;
      state.selectedEvidenceGraphCandidateId = graph.inferenceCandidates.find((candidate) => candidate.nodeId === nodeId)?.id || null;
      state.evidenceGraphPath = null;
      render();
    });
    host.dataset.evidenceGraphReady = "true";
    host.dataset.nodeCount = String(graph.nodes.length);
    host.dataset.edgeCount = String(graph.edges.length);
    host.dataset.citationEdgeCount = String(graph.edges.filter((edge) => edge.kind === "cites").length);
    host.dataset.supportEdgeCount = String(graph.edges.filter((edge) => edge.kind === "supports").length);
    host.dataset.contradictionEdgeCount = String(graph.edges.filter((edge) => edge.kind === "contradicts").length);
    host.dataset.invalidatedNodeCount = String(graph.nodes.filter((node) => node.epistemicStatus === "invalidated").length);
    state.activeCytoscape = cy;
    return cy;
  }

  async function hydrateEvidenceGraph() {
    const host = document.querySelector("[data-evidence-graph-canvas]");
    if (!host || !state.evidenceGraph) return;
    try {
      renderEvidenceGraph(state.evidenceGraph, host);
    } catch (error) {
      host.dataset.renderFailed = "true";
      host.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function renderSkyCatalog(version, host, interactive = true) {
    const d3 = window.d3;
    const catalog = version?.payload?.catalog;
    const view = version?.payload?.view;
    if (!d3 || !catalog || catalog.provider !== "simbad-tap" || !catalog.center
      || !Array.isArray(catalog.objects) || typeof catalog.radiusDeg !== "number"
      || view?.projection !== "local-tangent" || view?.invertRightAscension !== true) {
      throw new Error("검증된 SIMBAD sky catalog 또는 D3 런타임이 없습니다.");
    }
    const width = Math.max(320, Math.floor(host.getBoundingClientRect().width || 720));
    const height = Math.max(420, Math.min(560, Math.round(width * .68)));
    const margin = { top: 28, right: 34, bottom: 46, left: 54 };
    const plotWidth = Math.max(220, width - margin.left - margin.right);
    const plotHeight = Math.max(260, height - margin.top - margin.bottom);
    const ra0 = Number(catalog.center.raDeg) * Math.PI / 180;
    const dec0 = Number(catalog.center.decDeg) * Math.PI / 180;
    const radiusRadians = Number(catalog.radiusDeg) * Math.PI / 180;
    const tangentExtent = Math.tan(radiusRadians);
    if (![ra0, dec0, radiusRadians, tangentExtent].every(Number.isFinite) || tangentExtent <= 0) throw new Error("Sky catalog 중심 좌표 또는 반경이 올바르지 않습니다.");
    const tangent = (object) => {
      const ra = Number(object.raDeg) * Math.PI / 180;
      const dec = Number(object.decDeg) * Math.PI / 180;
      let deltaRa = ra - ra0;
      if (deltaRa > Math.PI) deltaRa -= Math.PI * 2;
      if (deltaRa < -Math.PI) deltaRa += Math.PI * 2;
      const denominator = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(deltaRa);
      if (!Number.isFinite(denominator) || denominator <= 0) return null;
      const x = -(Math.cos(dec) * Math.sin(deltaRa) / denominator);
      const y = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(deltaRa)) / denominator;
      return Number.isFinite(x) && Number.isFinite(y) ? { ...object, x, y } : null;
    };
    const points = catalog.objects.map(tangent).filter(Boolean);
    const x = d3.scaleLinear().domain([-tangentExtent, tangentExtent]).range([0, plotWidth]);
    const y = d3.scaleLinear().domain([-tangentExtent, tangentExtent]).range([plotHeight, 0]);
    const types = [...new Set(points.map((point) => point.objectType))].sort();
    const palette = Array.isArray(d3.schemeTableau10) ? d3.schemeTableau10 : ["#2e6f73", "#b65f3a", "#695d94", "#4f7c50", "#a66d24"];
    const color = d3.scaleOrdinal(types, palette);
    const svg = d3.select(host).append("svg")
      .attr("class", "skyCatalogPlot")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", `${catalog.provider} catalog, ${points.length} objects, local tangent projection`);
    const svgNode = svg.node();
    if (svgNode) svgNode.dataset.scienceCapture = "";
    const defs = svg.append("defs");
    defs.append("clipPath").attr("id", `sky-clip-${version.contentSha256.slice(0, 12)}`)
      .append("rect").attr("width", plotWidth).attr("height", plotHeight).attr("rx", 8);
    const rootGroup = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    rootGroup.append("rect").attr("class", "skyPlotBackground").attr("width", plotWidth).attr("height", plotHeight).attr("rx", 8);
    const scene = rootGroup.append("g").attr("clip-path", `url(#sky-clip-${version.contentSha256.slice(0, 12)})`);
    const ringData = [0.25, 0.5, 0.75, 1].map((ratio) => ({ ratio, degrees: Number(catalog.radiusDeg) * ratio, tangent: Math.tan(radiusRadians * ratio) }));
    scene.selectAll("circle.skyRadiusRing").data(ringData).join("circle")
      .attr("class", "skyRadiusRing").attr("cx", x(0)).attr("cy", y(0))
      .attr("r", (entry) => Math.abs(x(entry.tangent) - x(0)));
    scene.append("line").attr("class", "skyAxisLine").attr("x1", 0).attr("x2", plotWidth).attr("y1", y(0)).attr("y2", y(0));
    scene.append("line").attr("class", "skyAxisLine").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", plotHeight);
    const objectLayer = scene.append("g").attr("class", "skyObjectLayer");
    const detail = document.querySelector("[data-sky-object-detail]");
    const formatMeasurement = (label, value, unit = "") => value === null || value === undefined ? null : `${label} ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 8 })}${unit}`;
    const selectObject = (object) => {
      if (!object || !detail) return;
      host.dataset.skySelectedObject = object.id;
      objectLayer.selectAll("circle.skyObject").attr("aria-current", (candidate) => String(candidate.id === object.id));
      detail.replaceChildren();
      const title = document.createElement("strong"); title.textContent = object.mainId;
      const identity = document.createElement("span"); identity.textContent = `${object.objectType}${object.spectralType ? ` · spectral ${object.spectralType}` : ""}`;
      const coordinate = document.createElement("span"); coordinate.textContent = `ICRS RA ${Number(object.raDeg).toFixed(6)}° · Dec ${Number(object.decDeg).toFixed(6)}°`;
      const measurements = [
        formatMeasurement("parallax", object.parallaxMas, " mas"),
        formatMeasurement("PM RA", object.properMotionRaMasYr, " mas/yr"),
        formatMeasurement("PM Dec", object.properMotionDecMasYr, " mas/yr"),
        formatMeasurement("radial velocity", object.radialVelocityKmS, " km/s"),
        formatMeasurement("redshift", object.redshift),
      ].filter(Boolean);
      const measured = document.createElement("span"); measured.textContent = measurements.length ? measurements.join(" · ") : "SIMBAD가 이 행에 별도 측정값을 제공하지 않았습니다.";
      detail.append(title, identity, coordinate, measured);
      detail.dataset.selected = "true";
    };
    const circles = objectLayer.selectAll("circle.skyObject").data(points, (point) => point.id).join("circle")
      .attr("class", "skyObject").attr("cx", (point) => x(point.x)).attr("cy", (point) => y(point.y))
      .attr("r", 4.6).attr("fill", (point) => color(point.objectType))
      .attr("data-object-id", (point) => point.id).attr("data-object-type", (point) => point.objectType)
      .attr("role", interactive ? "button" : "img").attr("tabindex", interactive ? 0 : -1)
      .attr("aria-label", (point) => `${point.mainId}, ${point.objectType}, RA ${point.raDeg}, Dec ${point.decDeg}`);
    circles.append("title").text((point) => `${point.mainId}\n${point.objectType}\nRA ${point.raDeg}° · Dec ${point.decDeg}°`);
    if (interactive) {
      circles.each(function bindSkyObjectInteraction(point) {
        this.addEventListener("click", () => selectObject(point));
        this.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectObject(point); }
        });
      });
    }
    rootGroup.append("text").attr("class", "skyAxisLabel skyAxisLabelRa").attr("x", plotWidth / 2).attr("y", plotHeight + 34).attr("text-anchor", "middle")
      .text(`Right ascension offset · field radius ${Number(catalog.radiusDeg).toFixed(3)}°`);
    rootGroup.append("text").attr("class", "skyAxisLabel").attr("transform", `translate(${-39},${plotHeight / 2}) rotate(-90)`).attr("text-anchor", "middle")
      .text("Declination offset");
    rootGroup.append("text").attr("class", "skyOrientationLabel").attr("x", 8).attr("y", 18).text("East ←");
    rootGroup.append("text").attr("class", "skyOrientationLabel").attr("x", plotWidth - 8).attr("y", 18).attr("text-anchor", "end").text("→ West");
    host.dataset.skyObjectCount = String(points.length);
    host.dataset.skyProjection = "local-tangent";
    const zoom = d3.zoom().scaleExtent([1, 10]).translateExtent([[-plotWidth, -plotHeight], [plotWidth * 2, plotHeight * 2]])
      .on("zoom", (event) => scene.attr("transform", event.transform));
    if (interactive) svg.call(zoom);
    const reset = document.querySelector('[data-sky-action="reset"]');
    if (interactive && reset) reset.addEventListener("click", () => svg.transition().duration(220).call(zoom.transform, d3.zoomIdentity));
    const filter = document.querySelector("[data-sky-type-filter]");
    if (interactive && filter) filter.addEventListener("change", () => {
      const selected = filter.value;
      objectLayer.selectAll("circle.skyObject").attr("display", (point) => !selected || point.objectType === selected ? null : "none");
      host.dataset.skyTypeFilter = selected;
    });
    const initial = points.find((point) => point.id === view.selectedObjectId) || points[0] || null;
    if (initial) selectObject(initial);
    return svg;
  }

  function ensureJBrowseRuntime() {
    if (window.AgentlasJBrowse?.mount) return Promise.resolve(window.AgentlasJBrowse);
    if (jbrowseRuntimePromise) return jbrowseRuntimePromise;
    jbrowseRuntimePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "../vendor/jbrowse-runtime.js";
      script.async = true;
      script.addEventListener("load", () => {
        if (window.AgentlasJBrowse?.mount) resolve(window.AgentlasJBrowse);
        else reject(new Error("JBrowse 2 runtime이 mount API를 제공하지 않았습니다."));
      }, { once: true });
      script.addEventListener("error", () => reject(new Error("JBrowse 2 runtime을 불러오지 못했습니다.")), { once: true });
      document.head.append(script);
    }).catch((error) => {
      jbrowseRuntimePromise = null;
      throw error;
    });
    return jbrowseRuntimePromise;
  }

  async function renderJBrowseVariantTrack(version, host) {
    if (!version?.payload || version.payload.schema !== "agentlas.science-genomics-variant-track/v1") throw new Error("검증된 Genomics payload가 없습니다.");
    const runtime = await ensureJBrowseRuntime();
    if (!host.isConnected) return null;
    const capture = document.createElement("div");
    capture.className = "jbrowseCaptureSurface";
    capture.dataset.scienceCapture = "";
    const mountTarget = document.createElement("div");
    mountTarget.className = "jbrowseMountTarget";
    capture.append(mountTarget);
    host.replaceChildren(capture);
    const observation = runtime.mount(mountTarget, version.payload);
    state.activeJBrowseTarget = mountTarget;
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!host.isConnected) return null;
      const rect = mountTarget.getBoundingClientRect();
      if (rect.width >= 240 && rect.height >= 200 && mountTarget.querySelectorAll("button, canvas, svg").length >= 3) {
        host.dataset.jbrowseReady = "true";
        host.dataset.jbrowseFeatureCount = String(observation.featureCount);
        return observation;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("JBrowse 2가 제한 시간 안에 인터랙티브 트랙을 만들지 못했습니다.");
  }

  function buildStatisticsExecutionRail(version, payload, result) {
    const projectionReceipt = isStatisticsProjectionReceipt(payload.projectionReceipt) ? payload.projectionReceipt : null;
    const binding = payload.executionBinding || {};
    const plan = binding.analysisPlan;
    const analysisSpec = plan?.analysisSpecId ? analysisSpecById(plan.analysisSpecId) : null;
    const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
    const explicitBoundaries = diagnostics.filter((item) => item && (Object.hasOwn(item, "boundary")
      || (Array.isArray(item.unsupported) && item.unsupported.length > 0)
      || /(?:boundary|only|requires_|warning|not_)/u.test(String(item.status || ""))));
    const rail = document.createElement("section");
    rail.className = "statisticsExecutionRail";
    rail.dataset.statisticsExecutionRail = "";
    rail.dataset.statisticsPurpose = String(binding.purpose || "");
    rail.dataset.statisticsResultStatus = String(result.status || "");
    rail.dataset.statisticsEngineVersion = String(result.engine?.version || "");
    rail.dataset.statisticsRunId = String(version?.provenance?.sourceRunId || "");

    const sourceCard = document.createElement("article");
    sourceCard.className = "statisticsExecutionCard statisticsSourceMapping";
    sourceCard.dataset.statisticsSourceMapping = "";
    const sourceTitle = projectionReceipt
      ? `Data Table v${projectionReceipt.sourceArtifact.artifactVersion}`
      : binding.inputArtifacts?.length ? `${binding.inputArtifacts.length} bound input artifact${binding.inputArtifacts.length === 1 ? "" : "s"}` : "Inline validated input";
    const mappingChips = projectionReceipt ? statisticsProjectionColumnPairs(projectionReceipt)
      .map(([role, column]) => `<span><em>${escapeHtml(role)}</em><strong>${escapeHtml(column)}</strong></span>`).join("") : `<span><em>binding</em><strong>${escapeHtml(binding.inputArtifacts?.length ? "exact artifact" : "request hash")}</strong></span>`;
    const sourceMeta = projectionReceipt
      ? `${projectionReceipt.includedRowCount} rows · projection ${statisticsShortHash(projectionReceipt.receiptSha256)}`
      : `input ${statisticsShortHash(payload.inputSha256)}`;
    sourceCard.innerHTML = `<header><span>01 · SOURCE MAPPING</span><strong>${escapeHtml(sourceTitle)}</strong></header><div class="statisticsMappingChips">${mappingChips}</div><footer title="${escapeHtml(projectionReceipt?.receiptSha256 || payload.inputSha256 || "")}">${escapeHtml(sourceMeta)}</footer>`;

    const planCard = document.createElement("article");
    planCard.className = "statisticsExecutionCard statisticsAnalysisPlan";
    planCard.dataset.statisticsAnalysisPlan = plan ? "frozen" : String(binding.purpose || "unplanned");
    if (plan) {
      const modelParts = [plan.model?.family, plan.model?.formula, plan.model?.distribution, plan.model?.link].filter(Boolean);
      planCard.innerHTML = `<header><span>02 · FROZEN ANALYSISSPEC</span><strong>${escapeHtml(analysisSpec?.title || plan.analysisSpecId)}</strong><em>FROZEN · v${escapeHtml(plan.version)}</em></header><p>${escapeHtml(modelParts.join(" · "))}</p><footer><code title="${escapeHtml(plan.modelSha256)}">model ${escapeHtml(statisticsShortHash(plan.modelSha256))}</code><code title="${escapeHtml(plan.contentSha256)}">spec ${escapeHtml(statisticsShortHash(plan.contentSha256))}</code></footer>`;
    } else {
      planCard.innerHTML = `<header><span>02 · ANALYSIS BOUNDARY</span><strong>${escapeHtml(String(binding.purpose || "descriptive").toUpperCase())}</strong><em>NO FROZEN PLAN</em></header><p>이 실행에는 frozen AnalysisSpec이 연결되지 않았습니다.</p><footer><code title="${escapeHtml(binding.bindingSha256 || "")}">binding ${escapeHtml(statisticsShortHash(binding.bindingSha256))}</code></footer>`;
    }

    const runCard = document.createElement("article");
    runCard.className = "statisticsExecutionCard statisticsRunBoundary";
    runCard.dataset.statisticsRunBoundary = "";
    const diagnosticChips = diagnostics.slice(0, 4).map((diagnostic) => {
      const status = String(diagnostic?.status || "recorded");
      return `<span data-diagnostic-status="${escapeHtml(status)}" title="${escapeHtml(diagnostic?.name || "diagnostic")}: ${escapeHtml(status)}">${escapeHtml(diagnostic?.name || "diagnostic")} · ${escapeHtml(status)}</span>`;
    }).join("");
    runCard.innerHTML = `<header><span>03 · RUN & DIAGNOSTICS</span><strong>${escapeHtml(result.engine?.id || "statistics engine")} · ${escapeHtml(result.engine?.version || "—")}</strong><em data-status="${escapeHtml(result.status || "unknown")}">${escapeHtml(String(result.status || "unknown").toUpperCase())}</em></header><div class="statisticsDiagnosticChips">${diagnosticChips || `<span>진단 기록 없음</span>`}</div><footer><span>${escapeHtml(diagnostics.length)} diagnostics · ${escapeHtml(explicitBoundaries.length)} explicit review boundaries</span><code title="${escapeHtml(version?.provenance?.sourceRunId || "")}">run ${escapeHtml(statisticsShortHash(version?.provenance?.sourceRunId))}</code><code title="${escapeHtml(payload.executionReceipt?.receiptSha256 || "")}">receipt ${escapeHtml(statisticsShortHash(payload.executionReceipt?.receiptSha256))}</code></footer>`;
    rail.append(sourceCard, planCard, runCard);
    return rail;
  }

  function compileStatisticsVisualization(result, visualization) {
    if (!window.vegaLite?.compile || !visualization || !Number.isSafeInteger(visualization.sourceArtifactIndex)) {
      throw new Error("검증된 Vega-Lite 컴파일러 또는 Figure 참조가 없습니다.");
    }
    const sourceArtifact = result.artifacts?.[visualization.sourceArtifactIndex];
    const sourceSpec = sourceArtifact?.kind === "vega-lite" && sourceArtifact.role === visualization.role
      ? sourceArtifact.payload
      : null;
    if (!sourceSpec || typeof sourceSpec !== "object" || Array.isArray(sourceSpec)) {
      throw new Error("Figure 원본이 통계 결과 아티팩트와 연결되지 않았습니다.");
    }
    const nestedSpec = sourceSpec.spec && typeof sourceSpec.spec === "object" && !Array.isArray(sourceSpec.spec)
      ? sourceSpec.spec
      : null;
    const isFaceted = Boolean(
      (sourceSpec.facet && typeof sourceSpec.facet === "object" && !Array.isArray(sourceSpec.facet))
      || (sourceSpec.repeat && typeof sourceSpec.repeat === "object" && !Array.isArray(sourceSpec.repeat)),
    );
    const compilationSource = Object.hasOwn(sourceSpec, "width")
      ? sourceSpec
      : isFaceted && nestedSpec
        ? {
          ...sourceSpec,
          autosize: { type: "pad", contains: "padding" },
          spec: {
            ...nestedSpec,
            ...(Object.hasOwn(nestedSpec, "width") ? {} : { width: 180 }),
            ...(Object.hasOwn(nestedSpec, "height") ? {} : { height: 220 }),
          },
        }
        : { ...sourceSpec, width: 480 };
    const compiled = window.vegaLite.compile(compilationSource, { config: {} })?.spec;
    if (!compiled || typeof compiled !== "object" || Array.isArray(compiled)) {
      throw new Error("Figure Vega 컴파일에 실패했습니다.");
    }
    return compiled;
  }

  async function renderStatisticsAnalysis(version, host, artifactId, interactive = true) {
    const payload = version?.payload;
    const result = payload?.result;
    if (!payload || payload.schema !== "agentlas.science.statistics-analysis-artifact/v1" || !result || result.schema !== "agentlas.science.statistics.result/v1"
      || !Array.isArray(result.artifacts) || !Array.isArray(payload.visualizations)) throw new Error("검증된 Statistical Analysis payload가 없습니다.");
    const tableEntries = result.artifacts.map((artifact, index) => ({ artifact, index })).filter(({ artifact }) => artifact?.kind === "table" && artifact?.payload?.schema === "agentlas.science.statistics-table/v1");
    const chartEntries = payload.visualizations.map((visualization, index) => ({ visualization, index }));
    if (!tableEntries.length) throw new Error("통계 결과에 검증된 출판용 표가 없습니다.");
    const defaultView = `table:${payload.selectedTableIndex}`;
    const requestedView = state.statisticsViewByArtifact.get(artifactId) || defaultView;
    const [viewKind, rawIndex] = String(requestedView).split(":");
    const viewIndex = Number(rawIndex);
    const selectedTable = tableEntries.find((entry) => entry.index === viewIndex) || tableEntries[0];
    const selectedChart = chartEntries.find((entry) => entry.index === viewIndex) || chartEntries[0];
    const activeKind = viewKind === "chart" && selectedChart ? "chart" : "table";
    let savedFigures = [];
    let figureListError = "";
    if (interactive && activeKind === "chart" && selectedChart && science.artifacts?.listStatisticsFigures) {
      try {
        savedFigures = await science.artifacts.listStatisticsFigures(state.selectedId, artifactId);
        if (!host.isConnected || state.selectedArtifactId !== artifactId) return;
      } catch (error) {
        figureListError = error instanceof Error ? error.message : String(error);
      }
    }
    const surface = document.createElement("section");
    surface.className = "statisticsAnalysisSurface";
    surface.dataset.scienceCapture = "";
    surface.dataset.statisticsMethod = String(payload.method || "");
    const header = document.createElement("header");
    header.className = "statisticsAnalysisHeader";
    const identity = document.createElement("div");
    const kicker = document.createElement("span"); kicker.textContent = "RECEIPT-BOUND STATISTICAL ANALYSIS";
    const title = document.createElement("strong"); title.textContent = statisticsMethodLabel(payload.method);
    const receipt = document.createElement("code"); receipt.textContent = `${String(result.receipt?.receiptId || "").slice(0, 12)}…`;
    identity.append(kicker, title, receipt);
    const switcher = document.createElement("nav"); switcher.setAttribute("aria-label", "통계 결과 산출물");
    for (const entry of tableEntries) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.statisticsView = `table:${entry.index}`;
      button.textContent = String(entry.artifact.payload.title || `Table ${entry.index + 1}`); button.disabled = !interactive; button.setAttribute("aria-pressed", String(activeKind === "table" && entry.index === selectedTable.index));
      switcher.append(button);
    }
    for (const entry of chartEntries) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.statisticsView = `chart:${entry.index}`;
      button.textContent = String(entry.visualization.title || `Figure ${entry.index + 1}`); button.disabled = !interactive; button.setAttribute("aria-pressed", String(activeKind === "chart" && entry.index === selectedChart?.index));
      switcher.append(button);
    }
    const controls = document.createElement("div"); controls.className = "statisticsAnalysisControls"; controls.append(switcher);
    if (activeKind === "chart" && selectedChart) {
      const existingFigure = savedFigures.find((item) => item?.version?.payload?.schema === "agentlas.science.statistics-figure-artifact/v1"
        && item.version.payload.statisticsArtifact?.artifactId === artifactId
        && item.version.payload.statisticsArtifact?.artifactVersion === version.version
        && item.version.payload.statisticsArtifact?.contentSha256 === version.contentSha256
        && item.version.payload.visualization?.index === selectedChart.index) || null;
      const actionRow = document.createElement("div"); actionRow.className = "statisticsFigureActions";
      const save = document.createElement("button"); save.type = "button"; save.dataset.action = "materialize-statistics-figure";
      save.dataset.visualizationIndex = String(selectedChart.index); save.dataset.figureTitle = String(selectedChart.visualization.title || "");
      if (existingFigure) save.dataset.figureArtifactId = existingFigure.id;
      save.disabled = !interactive || state.figureActionBusy;
      save.textContent = state.figureActionBusy ? "Figure 확인 중…" : existingFigure ? "Figure Lab에서 열기" : "Figure Lab에 저장";
      const formats = document.createElement("span"); formats.textContent = "SVG · PNG/PDF/TIFF 300/600dpi · sRGB · vector PDF/CMYK 미지원";
      actionRow.append(save, formats);
      const actionStatus = document.createElement("p"); actionStatus.className = "statisticsFigureActionStatus";
      actionStatus.setAttribute("role", state.figureActionError || figureListError ? "alert" : "status");
      actionStatus.textContent = state.figureActionError || (figureListError ? `저장된 Figure 조회 실패 · ${figureListError}` : state.figureActionNotice);
      controls.append(actionRow, actionStatus);
    }
    header.append(identity, controls);
    const executionRail = buildStatisticsExecutionRail(version, payload, result);
    const content = document.createElement("div"); content.className = "statisticsAnalysisContent";
    if (activeKind === "chart" && selectedChart) {
      if (!window.vega || !window.vegaExpressionInterpreter) throw new Error("검증된 Vega 런타임이 없습니다.");
      content.classList.add("statisticsChartHost");
      surface.append(header, executionRail, content);
      host.replaceChildren(surface);
      const runtime = window.vega.parse(compileStatisticsVisualization(result, selectedChart.visualization), undefined, { ast: true });
      state.activeVegaView = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(content).hover();
      state.activeVegaView.width(Math.max(320, content.clientWidth - 48)).height(Math.max(260, content.clientHeight - 48));
      await state.activeVegaView.runAsync();
      const canvas = content.querySelector("canvas");
      if (!canvas) throw new Error("통계 그래프가 캡처 가능한 캔버스를 만들지 못했습니다.");
    } else {
      const tablePayload = selectedTable.artifact.payload;
      const viewport = document.createElement("div"); viewport.className = "dataTableViewport";
      const table = document.createElement("table");
      const thead = document.createElement("thead"); const headRow = document.createElement("tr");
      for (const column of tablePayload.columns) {
        const th = document.createElement("th"); const label = document.createElement("span"); label.textContent = column.label;
        const type = document.createElement("em"); type.textContent = column.type; th.append(label, type); headRow.append(th);
      }
      thead.append(headRow); const tbody = document.createElement("tbody");
      for (const row of tablePayload.rows) {
        const tr = document.createElement("tr");
        for (const column of tablePayload.columns) {
          const td = document.createElement("td"); const value = row[column.key]; td.dataset.logicalType = column.type; td.textContent = value === null || value === undefined ? "—" : String(value); if (value === null || value === undefined) td.dataset.null = "true"; tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody); viewport.append(table);
      const caption = document.createElement("footer");
      const copy = document.createElement("div"); const captionText = document.createElement("strong"); captionText.textContent = tablePayload.caption; copy.append(captionText);
      if (Array.isArray(tablePayload.notes) && tablePayload.notes.length) { const notes = document.createElement("span"); notes.textContent = tablePayload.notes.join(" · "); copy.append(notes); }
      const count = document.createElement("span"); count.textContent = `${tablePayload.rows.length.toLocaleString()} rows · ${tablePayload.columns.length.toLocaleString()} columns`;
      caption.append(copy, count); content.append(viewport, caption); surface.append(header, executionRail, content); host.replaceChildren(surface);
    }
    host.dataset.statisticsReady = "true";
    host.dataset.statisticsView = `${activeKind}:${activeKind === "table" ? selectedTable.index : selectedChart?.index}`;
  }

  function renderDataTable(version, host, artifactId, interactive = true) {
    const payload = version?.payload;
    if (!payload || payload.schema !== "agentlas.science-table/v1" || !Array.isArray(payload.columns) || !Array.isArray(payload.rows) || !payload.profile) {
      throw new Error("검증된 Data Table payload가 없습니다.");
    }
    const pageSize = 100;
    const pageCount = Math.max(1, Math.ceil(payload.rows.length / pageSize));
    const requestedPage = Number(state.tablePageByArtifact.get(artifactId) || 0);
    const page = Math.max(0, Math.min(pageCount - 1, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
    const start = page * pageSize;
    const rows = payload.rows.slice(start, start + pageSize);
    const surface = document.createElement("section");
    surface.className = "dataTableSurface";
    surface.dataset.scienceCapture = "";
    surface.dataset.tableRows = String(payload.profile.rowCount);
    surface.dataset.tableColumns = String(payload.profile.columnCount);
    const summary = document.createElement("header");
    summary.className = "dataTableSummary";
    const title = document.createElement("div");
    const kicker = document.createElement("span"); kicker.textContent = "SOURCE-BOUND DATA TABLE";
    const strong = document.createElement("strong"); strong.textContent = `${payload.profile.rowCount.toLocaleString()} rows · ${payload.profile.columnCount.toLocaleString()} columns`;
    title.append(kicker, strong);
    const receipts = document.createElement("div");
    const missing = document.createElement("span"); missing.textContent = `Missing ${payload.profile.nullCount.toLocaleString()}`;
    const formulas = document.createElement("span"); formulas.textContent = `Formula-like text ${payload.profile.formulaLikeCellCount.toLocaleString()}`;
    const hash = document.createElement("code"); hash.textContent = `${String(payload.receipts?.tableSha256 || "").slice(0, 12)}…`;
    receipts.append(missing, formulas, hash);
    summary.append(title, receipts);
    const viewport = document.createElement("div");
    viewport.className = "dataTableViewport";
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of payload.columns) {
      const cell = document.createElement("th");
      const label = document.createElement("span"); label.textContent = column.name;
      const type = document.createElement("em"); type.textContent = `${column.logicalType}${column.nullable ? " · nullable" : ""}`;
      cell.append(label, type);
      headRow.append(cell);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const column of payload.columns) {
        const td = document.createElement("td");
        const value = row[column.name];
        td.dataset.logicalType = column.logicalType;
        td.textContent = value === null ? "—" : String(value);
        if (value === null) td.dataset.null = "true";
        if (typeof value === "string" && /^[\s]*[=+@-]/.test(value)) td.dataset.formulaLike = "true";
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(head, body);
    viewport.append(table);
    const footer = document.createElement("footer");
    const range = document.createElement("span"); range.textContent = `${start + 1}–${Math.min(start + rows.length, payload.rows.length)} of ${payload.rows.length}`;
    const controls = document.createElement("div");
    const previous = document.createElement("button"); previous.type = "button"; previous.textContent = "이전"; previous.dataset.tablePage = String(page - 1); previous.disabled = !interactive || page === 0;
    const current = document.createElement("span"); current.textContent = `${page + 1} / ${pageCount}`;
    const next = document.createElement("button"); next.type = "button"; next.textContent = "다음"; next.dataset.tablePage = String(page + 1); next.disabled = !interactive || page >= pageCount - 1;
    controls.append(previous, current, next);
    footer.append(range, controls);
    surface.append(summary, viewport, footer);
    host.replaceChildren(surface);
    host.dataset.tableReady = "true";
    return { rowCount: payload.rows.length, columnCount: payload.columns.length, page, pageCount };
  }

  function renderPhysicsDataset(version, host, artifactId, interactive = true) {
    const payload = version?.payload;
    const dataset = payload?.normalized;
    const tablePayload = dataset?.table;
    if (!payload || payload.schema !== "agentlas.science.physics-data-artifact/v1"
      || dataset?.schema !== "agentlas.physics.user-dataset/v1" || tablePayload?.schema !== "agentlas.science-table/v1"
      || !Array.isArray(tablePayload.columns) || !Array.isArray(tablePayload.rows)) throw new Error("검증된 Physics measurement payload가 없습니다.");
    const pageSize = 100;
    const pageCount = Math.max(1, Math.ceil(tablePayload.rows.length / pageSize));
    const requestedPage = Number(state.tablePageByArtifact.get(artifactId) || 0);
    const page = Math.max(0, Math.min(pageCount - 1, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
    const start = page * pageSize;
    const rows = tablePayload.rows.slice(start, start + pageSize);
    const surface = document.createElement("section"); surface.className = "dataTableSurface physicsDataSurface"; surface.dataset.scienceCapture = "";
    surface.dataset.physicsRows = String(dataset.rowCount); surface.dataset.physicsColumns = String(dataset.columnCount);
    const summary = document.createElement("header"); summary.className = "dataTableSummary";
    const title = document.createElement("div");
    const kicker = document.createElement("span"); kicker.textContent = "PLUGIN-NORMALIZED PHYSICS DATA";
    const strong = document.createElement("strong"); strong.textContent = tablePayload.title;
    title.append(kicker, strong);
    const receipts = document.createElement("div");
    const dimensions = document.createElement("span"); dimensions.textContent = `${dataset.rowCount.toLocaleString()} rows · ${dataset.columnCount.toLocaleString()} columns`;
    const units = document.createElement("span"); units.textContent = `${tablePayload.columns.filter((column) => column.unit).length} unit-bearing fields`;
    const hash = document.createElement("code"); hash.textContent = `${String(dataset.normalizedSha256 || "").slice(0, 12)}…`;
    receipts.append(dimensions, units, hash); summary.append(title, receipts);
    const viewport = document.createElement("div"); viewport.className = "dataTableViewport";
    const table = document.createElement("table");
    const head = document.createElement("thead"); const headRow = document.createElement("tr");
    for (const column of tablePayload.columns) {
      const cell = document.createElement("th"); const label = document.createElement("span"); label.textContent = column.name;
      const type = document.createElement("em"); type.textContent = column.unit ? `${column.type} · ${column.unit}` : column.type;
      cell.append(label, type); headRow.append(cell);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (let columnIndex = 0; columnIndex < tablePayload.columns.length; columnIndex += 1) {
        const td = document.createElement("td"); const value = row[columnIndex]; td.dataset.logicalType = tablePayload.columns[columnIndex].type;
        td.textContent = value === null ? "—" : String(value); if (value === null) td.dataset.null = "true"; tr.append(td);
      }
      body.append(tr);
    }
    table.append(head, body); viewport.append(table);
    const footer = document.createElement("footer");
    const provenance = document.createElement("span"); provenance.textContent = "Agentlas Physics runtime · exact rows · no imputation";
    const controls = document.createElement("div");
    const previous = document.createElement("button"); previous.type = "button"; previous.textContent = "이전"; previous.dataset.tablePage = String(page - 1); previous.disabled = !interactive || page === 0;
    const current = document.createElement("span"); current.textContent = `${page + 1} / ${pageCount}`;
    const next = document.createElement("button"); next.type = "button"; next.textContent = "다음"; next.dataset.tablePage = String(page + 1); next.disabled = !interactive || page >= pageCount - 1;
    controls.append(previous, current, next); footer.append(provenance, controls); surface.append(summary, viewport, footer); host.replaceChildren(surface);
    host.dataset.physicsReady = "true";
    return { rowCount: tablePayload.rows.length, columnCount: tablePayload.columns.length, page, pageCount };
  }

  function renderMaterialsDataset(version, host, artifactId, interactive = true) {
    const payload = version?.payload;
    const dataset = payload?.normalized;
    const tablePayload = dataset?.table;
    if (!payload || payload.schema !== "agentlas.science.materials-catalog-artifact/v1"
      || dataset?.schema !== "agentlas.materials.oqmd-optimade/v1" || tablePayload?.schema !== "agentlas.science-table/v1"
      || !Array.isArray(tablePayload.columns) || !Array.isArray(tablePayload.rows)) throw new Error("검증된 Materials structure payload가 없습니다.");
    const pageSize = 100;
    const pageCount = Math.max(1, Math.ceil(tablePayload.rows.length / pageSize));
    const requestedPage = Number(state.tablePageByArtifact.get(artifactId) || 0);
    const page = Math.max(0, Math.min(pageCount - 1, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
    const start = page * pageSize;
    const rows = tablePayload.rows.slice(start, start + pageSize);
    const surface = document.createElement("section"); surface.className = "dataTableSurface materialsDataSurface"; surface.dataset.scienceCapture = "";
    surface.dataset.materialsRows = String(dataset.structureCount);
    const summary = document.createElement("header"); summary.className = "dataTableSummary";
    const title = document.createElement("div");
    const kicker = document.createElement("span"); kicker.textContent = "OQMD · EXACT OPTIMADE STRUCTURES";
    const strong = document.createElement("strong"); strong.textContent = `${dataset.structureCount.toLocaleString()} crystal structures`;
    title.append(kicker, strong);
    const receipts = document.createElement("div");
    const measured = document.createElement("span"); measured.textContent = `${tablePayload.rows.filter((row) => row[4] !== null).length} band gaps · ${tablePayload.rows.filter((row) => row[5] !== null).length} formation energies`;
    const license = document.createElement("span"); license.textContent = "CC-BY-4.0";
    const hash = document.createElement("code"); hash.textContent = `${String(dataset.normalizedSha256 || "").slice(0, 12)}…`;
    receipts.append(measured, license, hash); summary.append(title, receipts);
    const viewport = document.createElement("div"); viewport.className = "dataTableViewport";
    const table = document.createElement("table"); const head = document.createElement("thead"); const headRow = document.createElement("tr");
    for (const column of tablePayload.columns) {
      const cell = document.createElement("th"); const label = document.createElement("span"); label.textContent = column.label;
      const type = document.createElement("em"); type.textContent = column.unit ? `${column.type} · ${column.unit}` : column.type;
      cell.append(label, type); headRow.append(cell);
    }
    head.append(headRow); const body = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (let columnIndex = 0; columnIndex < tablePayload.columns.length; columnIndex += 1) {
        const td = document.createElement("td"); const value = row[columnIndex]; td.dataset.logicalType = tablePayload.columns[columnIndex].type;
        td.textContent = value === null ? "—" : String(value); if (value === null) td.dataset.null = "true"; tr.append(td);
      }
      body.append(tr);
    }
    table.append(head, body); viewport.append(table);
    const footer = document.createElement("footer");
    const provenance = document.createElement("span"); provenance.textContent = "OQMD raw response bound · exact lattice/site records · no imputation";
    const controls = document.createElement("div");
    const previous = document.createElement("button"); previous.type = "button"; previous.textContent = "이전"; previous.dataset.tablePage = String(page - 1); previous.disabled = !interactive || page === 0;
    const current = document.createElement("span"); current.textContent = `${page + 1} / ${pageCount}`;
    const next = document.createElement("button"); next.type = "button"; next.textContent = "다음"; next.dataset.tablePage = String(page + 1); next.disabled = !interactive || page >= pageCount - 1;
    controls.append(previous, current, next); footer.append(provenance, controls); surface.append(summary, viewport, footer); host.replaceChildren(surface);
    host.dataset.materialsReady = "true";
    return { rowCount: tablePayload.rows.length, columnCount: tablePayload.columns.length, page, pageCount };
  }

  const NUMERIC_SURFACE_SCHEMA = "agentlas.science.numeric-surface-artifact/v1";
  const NUMERIC_SURFACE_V2_SCHEMA = "agentlas.science.numeric-surface-artifact/v2";
  const NUMERIC_SURFACE_RENDERER = "agentlas.three-numeric";
  const NUMERIC_SURFACE_PNG_EXPORT_SCHEMA = "agentlas.science.numeric-surface-png-export/v1";
  const NUMERIC_SURFACE_RASTER_SCHEMA = "agentlas.science.numeric-surface-raster-artifact/v1";
  const numericSurfaceViewKey = (artifactId, version, contentSha256) => `agentlas.science.numeric-surface.view.v1:${artifactId}:${version}:${contentSha256}`;

  function canonicalNumericSurfaceValue(value) {
    if (Array.isArray(value)) return value.map(canonicalNumericSurfaceValue);
    if (value === null || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => value[key] === undefined ? [] : [[key, canonicalNumericSurfaceValue(value[key])]]));
  }

  async function numericSurfaceSha256Bytes(bytes) {
    const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function numericSurfaceSha256Json(value) {
    return numericSurfaceSha256Bytes(new TextEncoder().encode(JSON.stringify(canonicalNumericSurfaceValue(value))));
  }

  async function blobDataBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("science-numeric-surface-png-file-reader-failed"));
      reader.onload = () => {
        const value = typeof reader.result === "string" ? reader.result : "";
        const comma = value.indexOf(",");
        if (comma < 0) reject(new Error("science-numeric-surface-png-base64-invalid"));
        else resolve(value.slice(comma + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function renderNumericSurfacePublicationPng(artifact, viewStateReceipt, options) {
    const payload = artifact?.version?.payload;
    const width = Number(options?.width);
    const height = Number(options?.height);
    const dpi = Number(options?.dpi);
    if (!artifact || artifact.kind !== "chart.numeric-3d" || artifact.version?.rendererId !== NUMERIC_SURFACE_RENDERER
      || payload?.schema !== NUMERIC_SURFACE_V2_SCHEMA || payload.renderer?.version !== artifact.version.rendererVersion
      || ![300, 600].includes(dpi) || !Number.isSafeInteger(width) || width < 320 || width > 8192
      || !Number.isSafeInteger(height) || height < 240 || height > 8192 || width * height > 16000000
      || viewStateReceipt?.schema !== "agentlas.science.numeric-surface-view-state/v1"
      || viewStateReceipt.projectId !== artifact.projectId || viewStateReceipt.artifactId !== artifact.id
      || viewStateReceipt.artifactVersion !== artifact.version.version
      || viewStateReceipt.artifactContentSha256 !== artifact.version.contentSha256
      || viewStateReceipt.renderer?.id !== NUMERIC_SURFACE_RENDERER
      || viewStateReceipt.renderer?.version !== artifact.version.rendererVersion) {
      throw new Error("science-numeric-surface-png-export-binding-invalid");
    }
    const view = numericSurfaceView(viewStateReceipt.viewState, null);
    if (!view || await numericSurfaceSha256Json(view) !== viewStateReceipt.viewStateSha256) {
      throw new Error("science-numeric-surface-png-view-state-invalid");
    }
    const x = Array.isArray(payload.grid?.x) ? payload.grid.x.map(Number) : [];
    const y = Array.isArray(payload.grid?.y) ? payload.grid.y.map(Number) : [];
    const z = Array.isArray(payload.grid?.z) ? payload.grid.z.map((row) => Array.isArray(row) ? row.map(Number) : []) : [];
    const supportMask = payload.grid?.supportMask;
    const observedPoints = payload.observations?.points;
    if (x.length < 2 || y.length < 2 || x.length * y.length > 40000 || z.length !== y.length
      || x.some((item, index) => !Number.isFinite(item) || index > 0 && item <= x[index - 1])
      || y.some((item, index) => !Number.isFinite(item) || index > 0 && item <= y[index - 1])
      || z.some((row) => row.length !== x.length || row.some((item) => !Number.isFinite(item)))
      || !Array.isArray(supportMask) || supportMask.length !== y.length
      || supportMask.some((row) => !Array.isArray(row) || row.length !== x.length || row.some((item) => typeof item !== "boolean"))
      || !Array.isArray(observedPoints) || !observedPoints.length
      || observedPoints.some((point) => !point || ![point.x, point.y, point.z, point.residual].every(Number.isFinite))) {
      throw new Error("science-numeric-surface-png-data-invalid");
    }
    const zValues = z.flat();
    const zMin = Math.min(...zValues); const zMax = Math.max(...zValues);
    if (zMin !== Number(payload.grid.zMin) || zMax !== Number(payload.grid.zMax) || zMin === zMax) {
      throw new Error("science-numeric-surface-png-domain-invalid");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    let renderer = null;
    let geometry = null; let material = null; let wire = null; let observedGeometry = null; let observedMaterial = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0xffffff, 1);
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(34, width / height, 0.01, 100);
      const target = new THREE.Vector3(...view.target);
      camera.position.set(...view.cameraPosition); camera.up.set(...view.up); camera.lookAt(target); camera.updateProjectionMatrix();
      scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8d4, 2.3));
      const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(3, 5, 4); scene.add(key);
      const fill = new THREE.DirectionalLight(0xbad7ff, 0.9); fill.position.set(-4, 2, -3); scene.add(fill);
      const gridHelper = new THREE.GridHelper(2.3, 10, 0x8a8a86, 0xd8d7d2); gridHelper.position.y = -1.05; scene.add(gridHelper);
      const axesHelper = new THREE.AxesHelper(1.25); axesHelper.position.set(-1.1, -1.05, 1.1); scene.add(axesHelper);
      const positions = new Float32Array(x.length * y.length * 3);
      const colors = new Float32Array(x.length * y.length * 3);
      const xRange = x.at(-1) - x[0]; const yRange = y.at(-1) - y[0];
      const displayZMin = Math.min(zMin, ...observedPoints.map((point) => point.z));
      const displayZMax = Math.max(zMax, ...observedPoints.map((point) => point.z));
      const displayZRange = displayZMax - displayZMin; const zRange = zMax - zMin;
      const positionFor = (xValue, yValue, zValue) => [
        -1 + 2 * (xValue - x[0]) / xRange,
        -0.75 + 1.5 * (zValue - displayZMin) / displayZRange,
        1 - 2 * (yValue - y[0]) / yRange,
      ];
      for (let row = 0; row < y.length; row += 1) {
        for (let column = 0; column < x.length; column += 1) {
          const index = row * x.length + column;
          positions.set(positionFor(x[column], y[row], z[row][column]), index * 3);
          colors.set(numericSurfacePalette(payload.appearance?.palette || "viridis", (z[row][column] - zMin) / zRange), index * 3);
        }
      }
      const indices = [];
      for (let row = 0; row < y.length - 1; row += 1) {
        for (let column = 0; column < x.length - 1; column += 1) {
          if (!(supportMask[row][column] && supportMask[row][column + 1]
            && supportMask[row + 1][column] && supportMask[row + 1][column + 1])) continue;
          const a = row * x.length + column; const b = a + 1; const c = a + x.length; const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      if (!indices.length) throw new Error("science-numeric-surface-png-supported-cells-empty");
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.72, metalness: 0.02 });
      scene.add(new THREE.Mesh(geometry, material));
      if (payload.appearance?.wireframe) {
        wire = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x343432, transparent: true, opacity: 0.19 }));
        scene.add(wire);
      }
      const observedPositions = new Float32Array(observedPoints.length * 3);
      observedPoints.forEach((point, index) => observedPositions.set(positionFor(point.x, point.y, point.z), index * 3));
      observedGeometry = new THREE.BufferGeometry();
      observedGeometry.setAttribute("position", new THREE.BufferAttribute(observedPositions, 3)); observedGeometry.computeBoundingSphere();
      observedMaterial = new THREE.PointsMaterial({ color: 0xc22b86, size: 0.07, sizeAttenuation: true, depthTest: true, depthWrite: false });
      const observed = new THREE.Points(observedGeometry, observedMaterial); observed.renderOrder = 3; scene.add(observed);
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      gl.finish();
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error("science-numeric-surface-png-webgl-readback-failed");
      const bottomUp = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("science-numeric-surface-png-webgl-readback-failed");
      const readbackRgba = new Uint8Array(bottomUp.length);
      const rowBytes = width * 4;
      for (let row = 0; row < height; row += 1) {
        readbackRgba.set(bottomUp.subarray((height - row - 1) * rowBytes, (height - row) * rowBytes), row * rowBytes);
      }
      let nonBackgroundPixelCount = 0;
      for (let offset = 0; offset < readbackRgba.length; offset += 4) {
        if (readbackRgba[offset + 3] !== 255) throw new Error("science-numeric-surface-png-alpha-invalid");
        if (readbackRgba[offset] !== 255 || readbackRgba[offset + 1] !== 255 || readbackRgba[offset + 2] !== 255) nonBackgroundPixelCount += 1;
      }
      if (nonBackgroundPixelCount < 1 || nonBackgroundPixelCount >= width * height) {
        throw new Error("science-numeric-surface-png-readback-invalid");
      }
      const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("science-numeric-surface-png-encode-failed")), "image/png"));
      const png = new Uint8Array(await blob.arrayBuffer());
      if (png.length < 1024 || png.length > 64 * 1024 * 1024) throw new Error("science-numeric-surface-png-bytes-invalid");
      const viewStateReceiptSha256 = await numericSurfaceSha256Json(viewStateReceipt);
      const rgbaSha256 = await numericSurfaceSha256Bytes(readbackRgba);
      const pngSha256 = await numericSurfaceSha256Bytes(png);
      return {
        rendered: {
          schema: NUMERIC_SURFACE_PNG_EXPORT_SCHEMA,
          mimeType: "image/png",
          renderer: { id: NUMERIC_SURFACE_RENDERER, version: artifact.version.rendererVersion, outputColorSpace: "srgb" },
          surfaceArtifact: {
            artifactId: artifact.id,
            artifactVersion: artifact.version.version,
            contentSha256: artifact.version.contentSha256,
            payloadSha256: payload.payloadSha256,
          },
          viewStateReceipt,
          viewStateReceiptSha256,
          renderMode: "three-offscreen-webgl",
          exportProfile: `journal-raster-${dpi}dpi`,
          dpi,
          width,
          height,
          widthMm: Number(((width / dpi) * 25.4).toFixed(6)),
          heightMm: Number(((height / dpi) * 25.4).toFixed(6)),
          colorSpace: "srgb",
          background: "#ffffff",
          readback: { byteSize: readbackRgba.byteLength, rgbaSha256, nonBackgroundPixelCount },
          byteSize: png.byteLength,
          sha256: pngSha256,
          dataBase64: await blobDataBase64(blob),
        },
        png,
        readbackRgba,
      };
    } finally {
      geometry?.dispose?.(); material?.dispose?.(); wire?.geometry?.dispose?.(); wire?.material?.dispose?.();
      observedGeometry?.dispose?.(); observedMaterial?.dispose?.(); renderer?.dispose?.();
    }
  }

  function numericSurfacePalette(palette, ratio) {
    const t = Math.max(0, Math.min(1, ratio));
    const stops = palette === "cividis"
      ? [[0, 34, 78], [87, 93, 109], [165, 155, 99], [253, 234, 69]]
      : palette === "blue-red"
        ? [[49, 54, 149], [116, 173, 209], [244, 165, 130], [165, 0, 38]]
        : palette === "grayscale"
          ? [[38, 38, 38], [112, 112, 112], [188, 188, 188], [246, 246, 246]]
          : [[68, 1, 84], [49, 104, 142], [53, 183, 121], [253, 231, 37]];
    const scaled = t * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(scaled));
    const local = scaled - index;
    return stops[index].map((value, channel) => (value + (stops[index + 1][channel] - value) * local) / 255);
  }

  function numericSurfaceView(value, fallback) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const vector = (entry) => Array.isArray(entry) && entry.length === 3 && entry.every((item) => Number.isFinite(item) && Math.abs(item) <= 1e6) ? entry.map(Number) : null;
    const cameraPosition = vector(value.cameraPosition);
    const target = vector(value.target);
    const up = vector(value.up);
    return cameraPosition && target && up && Math.hypot(...up) > 1e-9 ? { cameraPosition, target, up } : fallback;
  }

  function renderNumericSurface(version, host, artifactId, interactive, options = {}) {
    const payload = version?.payload;
    const isV2 = payload?.schema === NUMERIC_SURFACE_V2_SCHEMA;
    if (!payload || ![NUMERIC_SURFACE_SCHEMA, NUMERIC_SURFACE_V2_SCHEMA].includes(payload.schema) || payload.renderer?.id !== NUMERIC_SURFACE_RENDERER
      || payload.chartFamily !== "surface3d" || !Array.isArray(payload.grid?.x) || !Array.isArray(payload.grid?.y)
      || !Array.isArray(payload.grid?.z) || payload.grid.y.length !== payload.grid.z.length) {
      throw new Error("science-numeric-surface-payload-invalid");
    }
    const x = payload.grid.x.map(Number);
    const y = payload.grid.y.map(Number);
    const z = payload.grid.z.map((row) => Array.isArray(row) ? row.map(Number) : []);
    if (x.length < 2 || y.length < 2 || x.length * y.length > 40_000
      || x.some((item, index) => !Number.isFinite(item) || index > 0 && item <= x[index - 1])
      || y.some((item, index) => !Number.isFinite(item) || index > 0 && item <= y[index - 1])
      || z.some((row) => row.length !== x.length || row.some((item) => !Number.isFinite(item)))) {
      throw new Error("science-numeric-surface-grid-invalid");
    }
    const zValues = z.flat();
    const zMin = Math.min(...zValues);
    const zMax = Math.max(...zValues);
    if (zMin !== Number(payload.grid.zMin) || zMax !== Number(payload.grid.zMax) || zMin === zMax) throw new Error("science-numeric-surface-domain-invalid");
    const supportMask = isV2 ? payload.grid.supportMask : y.map(() => x.map(() => true));
    const observedPoints = isV2 ? payload.observations?.points : [];
    if (!Array.isArray(supportMask) || supportMask.length !== y.length
      || supportMask.some((row) => !Array.isArray(row) || row.length !== x.length || row.some((item) => typeof item !== "boolean"))
      || !Array.isArray(observedPoints)
      || observedPoints.some((point) => !point || typeof point !== "object" || ![point.x, point.y, point.z, point.residual].every(Number.isFinite)
        || !Number.isSafeInteger(point.row) || point.row < 0 || typeof point.id !== "string" || !point.id)
      || isV2 && (!observedPoints.length || payload.appearance?.showObservedPoints !== true)) {
      throw new Error("science-numeric-surface-support-invalid");
    }
    const supportedValueCount = supportMask.flat().filter(Boolean).length;
    if (isV2 && (!Number.isSafeInteger(payload.grid.supportedValueCount) || payload.grid.supportedValueCount !== supportedValueCount || supportedValueCount < 1)) {
      throw new Error("science-numeric-surface-support-count-invalid");
    }

    const surface = document.createElement("section"); surface.className = "numericSurface3d";
    const viewport = document.createElement("div"); viewport.className = "numericSurfaceViewport";
    const canvas = document.createElement("canvas"); canvas.dataset.scienceCapture = ""; canvas.setAttribute("aria-label", `${payload.title} interactive three-dimensional response surface`);
    const overlay = document.createElement("div"); overlay.className = "numericSurfaceOverlay";
    const title = document.createElement("strong"); title.textContent = payload.title;
    const help = document.createElement("span"); const helpText = interactive
      ? `Drag to rotate · Shift/right-drag to pan · wheel to zoom${isV2 ? " · outside observed support is masked" : ""}`
      : `Saved camera view${isV2 ? " · observed support mask" : ""}`;
    help.textContent = helpText;
    overlay.append(title, help);
    const axisLegend = document.createElement("div"); axisLegend.className = "numericSurfaceAxes";
    for (const axis of ["x", "y", "z"]) {
      const label = document.createElement("span");
      const unit = payload.axes?.[axis]?.unit;
      label.textContent = `${axis.toUpperCase()} · ${payload.axes?.[axis]?.title || axis}${unit ? ` (${unit})` : ""}`;
      axisLegend.append(label);
    }
    if (isV2) {
      const support = document.createElement("span");
      support.className = "numericSurfaceSupportSummary";
      support.textContent = `Observed ${observedPoints.length.toLocaleString()} · supported grid ${supportedValueCount.toLocaleString()}/${(x.length * y.length).toLocaleString()}`;
      axisLegend.append(support);
    }
    const colorbar = document.createElement("div"); colorbar.className = `numericSurfaceColorbar palette-${payload.appearance?.palette || "viridis"}`;
    const maximum = document.createElement("span"); maximum.textContent = Number(zMax).toPrecision(4);
    const ramp = document.createElement("i"); const minimum = document.createElement("span"); minimum.textContent = Number(zMin).toPrecision(4);
    colorbar.append(maximum, ramp, minimum);
    const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "Reset 3D view"; reset.disabled = !interactive;
    surface.append(viewport, axisLegend, colorbar, reset); viewport.append(canvas, overlay); host.replaceChildren(surface);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xffffff, 1);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
    const defaultView = numericSurfaceView(payload.viewState, { cameraPosition: [3.2, 2.5, 3.4], target: [0, 0, 0], up: [0, 1, 0] });
    const initialDurableView = interactive ? numericSurfaceView(options.initialViewState, null) : null;
    let savedView = defaultView;
    if (interactive) {
      if (initialDurableView) savedView = initialDurableView;
      else {
        try { savedView = numericSurfaceView(JSON.parse(localStorage.getItem(numericSurfaceViewKey(artifactId, version.version, version.contentSha256)) || "null"), defaultView); } catch { savedView = defaultView; }
      }
    }
    const target = new THREE.Vector3(...savedView.target);
    camera.position.set(...savedView.cameraPosition); camera.up.set(...savedView.up); camera.lookAt(target);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8d4, 2.3));
    const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(3, 5, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0xbad7ff, 0.9); fill.position.set(-4, 2, -3); scene.add(fill);
    const gridHelper = new THREE.GridHelper(2.3, 10, 0x8a8a86, 0xd8d7d2); gridHelper.position.y = -1.05; scene.add(gridHelper);
    const axesHelper = new THREE.AxesHelper(1.25); axesHelper.position.set(-1.1, -1.05, 1.1); scene.add(axesHelper);

    const positions = new Float32Array(x.length * y.length * 3);
    const colors = new Float32Array(x.length * y.length * 3);
    const xRange = x[x.length - 1] - x[0]; const yRange = y[y.length - 1] - y[0];
    const displayZMin = observedPoints.length ? Math.min(zMin, ...observedPoints.map((point) => point.z)) : zMin;
    const displayZMax = observedPoints.length ? Math.max(zMax, ...observedPoints.map((point) => point.z)) : zMax;
    const displayZRange = displayZMax - displayZMin;
    const zRange = zMax - zMin;
    const positionFor = (xValue, yValue, zValue) => [
      -1 + 2 * (xValue - x[0]) / xRange,
      -0.75 + 1.5 * (zValue - displayZMin) / displayZRange,
      1 - 2 * (yValue - y[0]) / yRange,
    ];
    for (let row = 0; row < y.length; row += 1) {
      for (let column = 0; column < x.length; column += 1) {
        const index = row * x.length + column;
        const ratio = (z[row][column] - zMin) / zRange;
        positions.set(positionFor(x[column], y[row], z[row][column]), index * 3);
        colors.set(numericSurfacePalette(payload.appearance?.palette || "viridis", ratio), index * 3);
      }
    }
    const indices = [];
    let supportedCellCount = 0;
    for (let row = 0; row < y.length - 1; row += 1) {
      for (let column = 0; column < x.length - 1; column += 1) {
        if (!(supportMask[row][column] && supportMask[row][column + 1]
          && supportMask[row + 1][column] && supportMask[row + 1][column + 1])) continue;
        const a = row * x.length + column; const b = a + 1; const c = a + x.length; const d = c + 1;
        indices.push(a, c, b, b, c, d);
        supportedCellCount += 1;
      }
    }
    if (!supportedCellCount) throw new Error("science-numeric-surface-supported-cells-empty");
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.72, metalness: 0.02 });
    const mesh = new THREE.Mesh(geometry, material); scene.add(mesh);
    let wire = null;
    if (payload.appearance?.wireframe) {
      wire = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x343432, transparent: true, opacity: 0.19 }));
      scene.add(wire);
    }
    let observedGeometry = null;
    let observedMaterial = null;
    if (isV2 && payload.appearance?.showObservedPoints) {
      const observedPositions = new Float32Array(observedPoints.length * 3);
      observedPoints.forEach((point, index) => observedPositions.set(positionFor(point.x, point.y, point.z), index * 3));
      observedGeometry = new THREE.BufferGeometry();
      observedGeometry.setAttribute("position", new THREE.BufferAttribute(observedPositions, 3));
      observedGeometry.computeBoundingSphere();
      observedMaterial = new THREE.PointsMaterial({ color: 0xc22b86, size: 0.07, sizeAttenuation: true, depthTest: true, depthWrite: false });
      const observed = new THREE.Points(observedGeometry, observedMaterial);
      observed.renderOrder = 3;
      scene.add(observed);
    }

    let frame = 0; let disposed = false; let pointer = null;
    const renderFrame = () => {
      if (disposed) return;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(renderFrame);
    };
    const resize = () => {
      const rect = viewport.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width)); const height = Math.max(300, Math.floor(rect.height));
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false);
    };
    const viewReceipt = () => ({ cameraPosition: camera.position.toArray().map((item) => Number(item.toFixed(8))), target: target.toArray().map((item) => Number(item.toFixed(8))), up: camera.up.toArray().map((item) => Number(item.toFixed(8))) });
    let durableSequence = 0;
    let durableQueue = Promise.resolve();
    const persist = () => {
      if (!interactive) return;
      const receipt = viewReceipt();
      try { localStorage.setItem(numericSurfaceViewKey(artifactId, version.version, version.contentSha256), JSON.stringify(receipt)); } catch {}
      canvas.dataset.viewState = JSON.stringify(receipt);
      if (typeof options.persistViewState === "function") {
        const sequence = ++durableSequence;
        canvas.dataset.viewStateDurable = "saving";
        durableQueue = durableQueue.catch(() => {}).then(() => options.persistViewState(receipt)).then((saved) => {
          const savedView = numericSurfaceView(saved?.viewState, null);
          if (!savedView || JSON.stringify(savedView) !== JSON.stringify(receipt)) throw new Error("science-numeric-surface-view-state-readback-mismatch");
          if (sequence !== durableSequence) return;
          canvas.dataset.viewStateDurable = "true";
          delete host.dataset.viewStatePersistError;
          help.textContent = helpText;
        }).catch((error) => {
          if (sequence !== durableSequence) return;
          canvas.dataset.viewStateDurable = "false";
          host.dataset.viewStatePersistError = error instanceof Error ? error.message : String(error);
          help.textContent = `${helpText} · view save failed`;
        });
      }
    };
    const orbit = (deltaX, deltaY) => {
      const offset = camera.position.clone().sub(target); const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= deltaX * 0.008; spherical.phi = THREE.MathUtils.clamp(spherical.phi + deltaY * 0.008, 0.12, Math.PI - 0.12);
      camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical)); camera.lookAt(target);
    };
    const pan = (deltaX, deltaY) => {
      const distance = camera.position.distanceTo(target); const scale = distance * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-deltaX * scale);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(deltaY * scale);
      camera.position.add(right).add(up); target.add(right).add(up); camera.lookAt(target);
    };
    if (interactive) {
      canvas.addEventListener("contextmenu", (event) => event.preventDefault());
      canvas.addEventListener("pointerdown", (event) => { pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 2 }; canvas.setPointerCapture(event.pointerId); });
      canvas.addEventListener("pointermove", (event) => {
        if (!pointer || pointer.id !== event.pointerId) return;
        const dx = event.clientX - pointer.x; const dy = event.clientY - pointer.y; pointer.x = event.clientX; pointer.y = event.clientY;
        if (pointer.pan) pan(dx, dy); else orbit(dx, dy);
      });
      const release = (event) => { if (pointer?.id === event.pointerId) { pointer = null; persist(); } };
      canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
      canvas.addEventListener("wheel", (event) => {
        event.preventDefault(); const offset = camera.position.clone().sub(target); const factor = Math.exp(event.deltaY * 0.001);
        offset.multiplyScalar(THREE.MathUtils.clamp(factor, 0.72, 1.38));
        if (offset.length() >= 1.2 && offset.length() <= 12) camera.position.copy(target).add(offset);
        camera.lookAt(target); persist();
      }, { passive: false });
      reset.addEventListener("click", () => { camera.position.set(...defaultView.cameraPosition); target.set(...defaultView.target); camera.up.set(...defaultView.up); camera.lookAt(target); persist(); });
    }
    const observer = new ResizeObserver(resize); observer.observe(viewport); resize();
    if (interactive && initialDurableView) {
      const receipt = viewReceipt();
      try { localStorage.setItem(numericSurfaceViewKey(artifactId, version.version, version.contentSha256), JSON.stringify(receipt)); } catch {}
      canvas.dataset.viewState = JSON.stringify(receipt);
      canvas.dataset.viewStateDurable = "true";
    } else persist();
    renderFrame();
    canvas.dataset.numericSurfaceReady = "true";
    canvas.dataset.numericSurfaceSchema = String(payload.schema);
    canvas.dataset.gridSha256 = String(payload.grid.gridSha256 || "");
    canvas.dataset.supportMaskSha256 = String(payload.grid.supportMaskSha256 || "");
    canvas.dataset.supportedValueCount = String(supportedValueCount);
    canvas.dataset.supportedCellCount = String(supportedCellCount);
    canvas.dataset.surfaceTriangleCount = String(supportedCellCount * 2);
    canvas.dataset.maskedCellCount = String(Math.max(0, (x.length - 1) * (y.length - 1) - supportedCellCount));
    canvas.dataset.observedPointCount = String(observedPoints.length);
    canvas.dataset.observedPointsSha256 = String(payload.observations?.pointsSha256 || "");
    canvas.dataset.supportReceiptSha256 = String(payload.support?.receiptSha256 || "");
    canvas.dataset.payloadSha256 = String(payload.payloadSha256 || "");
    host.dataset.numericSurfaceReady = "true";

    return {
      canvas,
      viewReceipt,
      dispose() {
        disposed = true; cancelAnimationFrame(frame); observer.disconnect();
        geometry.dispose(); material.dispose(); wire?.geometry?.dispose?.(); wire?.material?.dispose?.();
        observedGeometry?.dispose?.(); observedMaterial?.dispose?.(); renderer.dispose();
      },
    };
  }

  async function hydrateHistoricalArtifactRenderer(context, host) {
    if (!context || !host || !host.isConnected) return;
    const version = context.selectedVersion;
    if (version.rendererId === NUMERIC_SURFACE_RENDERER) {
      try { renderNumericSurface(version, host, context.artifact.id, false); } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); host.dataset.renderFailed = "true"; }
      return;
    }
    if (version.rendererId === "agentlas.vega") {
      const spec = version.payload?.spec;
      if (!spec || typeof spec !== "object" || Array.isArray(spec) || !window.vega || !window.vegaExpressionInterpreter) {
        host.textContent = "검증된 Vega 명세 또는 렌더러가 없습니다.";
        host.dataset.renderFailed = "true";
        return;
      }
      try {
        const runtime = window.vega.parse(spec, undefined, { ast: true });
        state.activeVegaView = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host).hover();
        const width = Math.max(260, Math.floor(host.getBoundingClientRect().width) - 48);
        state.activeVegaView.width(width).height(330);
        await state.activeVegaView.runAsync();
      } catch (error) {
        host.textContent = error instanceof Error ? error.message : String(error);
        host.dataset.renderFailed = "true";
      }
      return;
    }
    if (version.rendererId === "agentlas.cytoscape") {
      try { renderCitationNetwork(version, host, false); } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); host.dataset.renderFailed = "true"; }
      return;
    }
    if (version.rendererId === "agentlas.d3-sky") {
      try { renderSkyCatalog(version, host, false); } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); host.dataset.renderFailed = "true"; }
      return;
    }
    if (version.rendererId === "agentlas.table") {
      try {
        if (version.payload?.schema === "agentlas.science.statistics-analysis-artifact/v1") await renderStatisticsAnalysis(version, host, context.artifact.id, false);
        else if (version.payload?.schema === "agentlas.science.physics-data-artifact/v1") renderPhysicsDataset(version, host, context.artifact.id, false);
        else if (version.payload?.schema === "agentlas.science.materials-catalog-artifact/v1") renderMaterialsDataset(version, host, context.artifact.id, false);
        else renderDataTable(version, host, context.artifact.id, false);
      } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); host.dataset.renderFailed = "true"; }
      return;
    }
    try {
      const preview = await science.artifacts.preview(state.selectedId, context.artifact.id, version.version);
      if (!preview?.bytes || !host.isConnected) {
        host.textContent = "이 과거 버전에는 검증된 시각 캡처가 없습니다. 편집기는 안전을 위해 열지 않았습니다.";
        host.dataset.previewMissing = "true";
        return;
      }
      const bytes = preview.bytes instanceof Uint8Array ? preview.bytes : new Uint8Array(preview.bytes);
      const url = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType || "image/png" }));
      state.inlinePreviewUrls.push(url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = `${context.artifact.title} v${version.version} 검증 캡처`;
      image.width = preview.width;
      image.height = preview.height;
      host.replaceChildren(image);
    } catch (error) {
      host.textContent = error instanceof Error ? error.message : String(error);
      host.dataset.renderFailed = "true";
    }
  }

  async function hydrateArtifactRenderer() {
    const labArtifacts = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact);
    const artifact = labArtifacts.find((item) => item.id === state.selectedArtifactId) || labArtifacts[0];
    if (state.inspectedArtifactVersion && state.inspectedArtifactVersion !== artifact?.currentVersion) {
      const historicalHost = document.querySelector("[data-historical-artifact-host]");
      if (state.inspectedArtifactContext && !state.inspectedArtifactContext.error && historicalHost) await hydrateHistoricalArtifactRenderer(state.inspectedArtifactContext, historicalHost);
      return;
    }
    const host = document.querySelector("[data-artifact-host]");
    if (!artifact || !host) return;
    const errorNode = document.querySelector("[data-render-error]");
    if (state.modal || (state.drawer && innerWidth < 1100)) return;
    const imageArtifact = artifact.version?.rendererId === "agentlas.image";
    const usablePack = imageArtifact || state.rendererPacks.some((pack) => ["ready", "verified-unprobed"].includes(pack.state) && pack.rendererIds.includes(artifact.version?.rendererId));
    if (!usablePack) { if (errorNode) errorNode.textContent = `${artifact.version?.rendererId || "unknown"} renderer pack이 설치·검증되지 않았습니다.`; return; }
    if (imageArtifact) {
      try {
        const preview = await science.artifacts.preview(state.selectedId, artifact.id, artifact.version.version);
        const expectedSha256 = artifact.version.payload?.export?.sha256;
        if (!preview?.bytes || preview.mimeType !== "image/png" || expectedSha256 && preview.sha256 && preview.sha256 !== expectedSha256) {
          throw new Error("science-statistics-figure-raster-preview-invalid");
        }
        const bytes = preview.bytes instanceof Uint8Array ? preview.bytes : new Uint8Array(preview.bytes);
        const url = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType }));
        state.inlinePreviewUrls.push(url);
        const image = document.createElement("img");
        image.className = "statisticsRasterPreview";
        image.src = url;
        image.alt = `${artifact.title} exact publication raster`;
        image.width = Number(preview.width) || Number(artifact.version.payload?.export?.width) || 0;
        image.height = Number(preview.height) || Number(artifact.version.payload?.export?.height) || 0;
        image.loading = "eager";
        image.decoding = "sync";
        host.replaceChildren(image);
        await image.decode().catch(() => {});
        if (!host.isConnected) return;
        host.dataset.imageReady = "true";
        host.dataset.imageSha256 = String(preview.sha256 || expectedSha256 || "");
      } catch (error) {
        host.textContent = error instanceof Error ? error.message : String(error);
        host.dataset.renderFailed = "true";
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (!["agentlas.vega", NUMERIC_SURFACE_RENDERER, "agentlas.cytoscape", "agentlas.d3-sky", "agentlas.jbrowse", "agentlas.table"].includes(artifact.version?.rendererId)) {
      if (!science.renderers?.mount || !science.renderers?.bounds) { if (errorNode) errorNode.textContent = "Desktop renderer host가 이 확장 버전을 지원하지 않습니다."; return; }
      try {
        const identity = `${artifact.id}:${artifact.version.version}:${artifact.version.contentSha256}`;
        const mountInput = rendererMountInput(artifact, host);
        state.activeRendererIdentity = identity;
        const status = await science.renderers.mount(mountInput);
        if (state.activeRendererIdentity !== identity) return;
        state.activeRendererInstance = status.instanceId;
        state.activeRendererVisible = true;
        applyRendererStatus(status);
        let queued = false;
        const syncBounds = () => {
          if (state.activeRendererIdentity !== identity || queued) return;
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            if (state.activeRendererIdentity !== identity || !host.isConnected) return;
            const rect = host.getBoundingClientRect();
            const pane = document.querySelector(".contentPane");
            const viewport = pane?.getBoundingClientRect() || { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
            const visibleWidth = Math.max(0, Math.min(rect.right, viewport.right, innerWidth) - Math.max(rect.left, viewport.left, 0));
            const visibleHeight = Math.max(0, Math.min(rect.bottom, viewport.bottom, innerHeight) - Math.max(rect.top, viewport.top, 0));
            const visible = visibleWidth >= 240 && visibleHeight >= 200;
            if (!visible) {
              if (state.activeRendererVisible !== false) {
                state.activeRendererVisible = false;
                void science.renderers.visibility(false).catch((error) => {
                  if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
                });
              }
              return;
            }
            void science.renderers.bounds(rendererMountInput(artifact, host)).then(() => {
              if (state.activeRendererIdentity !== identity || state.activeRendererVisible === true) return;
              state.activeRendererVisible = true;
              return science.renderers.visibility(true);
            }).catch((error) => {
              if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
            });
          });
        };
        state.rendererObserver = new ResizeObserver(syncBounds);
        state.rendererObserver.observe(host);
        state.rendererAbort = new AbortController();
        document.querySelector(".contentPane")?.addEventListener("scroll", syncBounds, { passive: true, signal: state.rendererAbort.signal });
        window.addEventListener("resize", syncBounds, { passive: true, signal: state.rendererAbort.signal });
      } catch (error) {
        state.activeRendererIdentity = null;
        state.activeRendererInstance = null;
        state.activeRendererVisible = null;
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (artifact.version?.rendererId === NUMERIC_SURFACE_RENDERER) {
      try {
        const durableViewState = await science.artifacts.getNumericSurfaceViewState(
          artifact.projectId, artifact.id, artifact.version.version, artifact.version.contentSha256,
        );
        state.activeNumericSurface = renderNumericSurface(artifact.version, host, artifact.id, true, {
          initialViewState: durableViewState?.viewState ?? null,
          persistViewState: (viewState) => science.artifacts.persistNumericSurfaceViewState({
            projectId: artifact.projectId,
            artifactId: artifact.id,
            artifactVersion: artifact.version.version,
            artifactContentSha256: artifact.version.contentSha256,
            viewState,
          }),
        });
        const bundle = await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
        const status = document.querySelector(".rendererStatus");
        if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
      } catch (error) {
        host.dataset.renderFailed = "true";
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (artifact.version?.rendererId === "agentlas.table") {
      try {
        if (artifact.version.payload?.schema === "agentlas.science.statistics-analysis-artifact/v1") await renderStatisticsAnalysis(artifact.version, host, artifact.id, true);
        else if (artifact.version.payload?.schema === "agentlas.science.physics-data-artifact/v1") renderPhysicsDataset(artifact.version, host, artifact.id, true);
        else if (artifact.version.payload?.schema === "agentlas.science.materials-catalog-artifact/v1") renderMaterialsDataset(artifact.version, host, artifact.id, true);
        else renderDataTable(artifact.version, host, artifact.id, true);
        const bundle = await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
        const status = document.querySelector(".rendererStatus");
        if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
      } catch (error) {
        host.dataset.renderFailed = "true";
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (artifact.version?.rendererId === "agentlas.jbrowse") {
      try {
        const observation = await renderJBrowseVariantTrack(artifact.version, host);
        if (!observation || !host.isConnected) return;
        const bundle = await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
        const status = document.querySelector(".rendererStatus");
        if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
      } catch (error) {
        host.dataset.renderFailed = "true";
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (artifact.version?.rendererId === "agentlas.cytoscape") {
      try {
        renderCitationNetwork(artifact.version, host, true);
        host.dataset.scienceCapture = "";
      } catch (error) {
        host.textContent = error instanceof Error ? error.message : String(error);
        host.dataset.renderFailed = "true";
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (artifact.version?.rendererId === "agentlas.d3-sky") {
      try {
        renderSkyCatalog(artifact.version, host, true);
      } catch (error) {
        host.textContent = error instanceof Error ? error.message : String(error);
        host.dataset.renderFailed = "true";
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
        return;
      }
      try {
        const bundle = await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
        const status = document.querySelector(".rendererStatus");
        if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
      } catch (error) {
        host.dataset.captureFailed = "true";
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (artifact.version?.rendererId !== "agentlas.vega") { if (errorNode) errorNode.textContent = `${artifact.version?.rendererId || "unknown"} adapter는 아직 이 화면의 실행 계약에 연결되지 않았습니다.`; return; }
    const draft = ensureVegaDraft(artifact);
    const spec = draft?.dirty ? vegaDraftSpec(artifact, draft) : artifact.version?.payload?.spec;
    if (!spec || typeof spec !== "object" || Array.isArray(spec) || !window.vega || !window.vegaExpressionInterpreter) { if (errorNode) errorNode.textContent = "검증된 Vega 명세 또는 렌더러가 없습니다."; return; }
    try {
      const runtime = window.vega.parse(spec, undefined, { ast: true });
      state.activeVegaView = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host).hover();
      if (artifact.version?.payload?.schema === "agentlas.science.statistics-figure-artifact/v1") {
        const availableWidth = Math.max(320, Math.floor((host.clientWidth || 720) - 44));
        const availableHeight = Math.max(260, Math.floor((host.clientHeight || 520) - 44));
        state.activeVegaView.width(Math.min(960, availableWidth)).height(Math.min(560, availableHeight));
      }
      await state.activeVegaView.runAsync();
      const canvas = host.querySelector("canvas");
      if (!canvas) throw new Error("렌더러가 캡처 가능한 캔버스를 만들지 않았습니다.");
      canvas.dataset.scienceCapture = "";
      const bundle = draft?.dirty ? null : await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
      const status = document.querySelector(".rendererStatus");
      if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
    } catch (error) { if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error); }
  }

  function fatal(error) {
    root.setAttribute("aria-busy", "false");
    root.innerHTML = `<section class="fatal"><div><strong>Science를 열 수 없습니다.</strong><span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span></div></section>`;
  }

  async function refreshEvidenceGraph() {
    if (!state.selectedId || state.evidenceGraphLoading) return;
    state.evidenceGraphLoading = true;
    state.evidenceGraphError = "";
    render();
    try {
      const result = await science.evidenceGraph.refresh({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        expectedRevision: state.evidenceGraph?.revision ?? null,
        expectedContentSha256: state.evidenceGraph?.contentSha256 ?? null,
      });
      const snapshot = await science.evidenceGraph.get(state.selectedId);
      if (!result?.graph || snapshot?.graph?.id !== result.graph.id || snapshot.graph.contentSha256 !== result.graph.contentSha256) throw new Error("science-evidence-graph-refresh-readback-mismatch");
      state.evidenceGraph = snapshot.graph;
      state.evidenceGraphReviews = Array.isArray(snapshot.reviews) ? snapshot.reviews : [];
      if (!evidenceGraphNodeById(state.selectedEvidenceGraphNodeId)) state.selectedEvidenceGraphNodeId = null;
      if (!evidenceGraphCandidateById(state.selectedEvidenceGraphCandidateId)) state.selectedEvidenceGraphCandidateId = null;
      state.evidenceGraphPath = null;
    } catch (error) {
      state.evidenceGraphError = error instanceof Error ? error.message : String(error);
    } finally {
      state.evidenceGraphLoading = false;
      render();
    }
  }

  function openEvidenceGraphExactRecord(nodeId) {
    const node = evidenceGraphNodeById(nodeId);
    if (!node) return;
    const ref = node.canonicalRef;
    if (ref.kind === "source-version") {
      const source = state.sources.find((item) => item.version?.id === ref.id && item.version?.version === ref.version);
      if (source) { state.selectedSourceId = source.id; state.drawer = { kind: "source", id: source.id }; render(); }
      return;
    }
    if (ref.kind === "evidence-span") {
      const citation = [...state.citationsByMessage.values()].flat().find((item) => item.evidenceSpanId === ref.id);
      if (citation) { state.selectedSourceId = citation.sourceId; state.drawer = { kind: "citation", id: citation.id }; render(); }
      return;
    }
    if (ref.kind === "artifact-version") {
      const artifact = state.artifacts.find((item) => item.id === ref.id && item.version?.version === ref.version && item.version?.contentSha256 === ref.contentSha256);
      const labId = artifact ? labForArtifact(artifact.id) : null;
      if (artifact && labId) void openLab(labId, artifact.id, ref.version, null, ref.version);
      return;
    }
    if (ref.kind === "research-run") {
      const artifact = state.artifacts.find((item) => item.sourceRunId === ref.id || item.version?.provenance?.sourceRunId === ref.id);
      const labId = artifact ? labForArtifact(artifact.id) : null;
      if (artifact && labId) void openLab(labId, artifact.id, artifact.currentVersion, null, artifact.currentVersion);
      else navigateProjectDestination("analysis-runs");
      return;
    }
    if (ref.kind === "message-block") {
      const entry = [...state.blocksByMessage.entries()].find(([, blocks]) => blocks.some((block) => block.id === ref.id));
      if (entry) {
        navigateProjectDestination("overview");
        requestAnimationFrame(() => document.querySelector(`[data-message-id="${CSS.escape(entry[0])}"]`)?.focus({ preventScroll: false }));
      }
      return;
    }
    const destination = ({
      project: "overview", hypothesis: "hypotheses", "analysis-plan-version": "plan-protocols", "episode-result": "analysis-runs", "research-lifecycle-revision": "interpretation", "artifact-validation-receipt": "results", "graph-inference-candidate": "interpretation",
    })[ref.kind] || "interpretation";
    navigateProjectDestination(destination);
  }

  async function explainEvidenceGraphPath(toNodeId) {
    if (!state.selectedId || !state.evidenceGraphPathAnchorId || !toNodeId || state.evidenceGraphPathAnchorId === toNodeId) return;
    state.evidenceGraphError = "";
    try {
      const result = await science.evidenceGraph.path(state.selectedId, state.evidenceGraphPathAnchorId, toNodeId);
      if (!result || result.projectId !== state.selectedId || result.graphRevisionId !== state.evidenceGraph?.id) throw new Error("science-evidence-graph-path-readback-mismatch");
      state.evidenceGraphPath = result;
      state.selectedEvidenceGraphNodeId = toNodeId;
      state.selectedEvidenceGraphCandidateId = state.evidenceGraph.inferenceCandidates.find((candidate) => candidate.nodeId === toNodeId)?.id || null;
    } catch (error) {
      state.evidenceGraphError = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  async function submitEvidenceGraphReview(form) {
    const candidate = evidenceGraphCandidateById(state.selectedEvidenceGraphCandidateId);
    if (!candidate || !state.evidenceGraph || !state.selectedId || state.evidenceGraphReviewBusy) return;
    const data = new FormData(form);
    state.evidenceGraphReviewBusy = true;
    state.evidenceGraphReviewError = "";
    render();
    try {
      const result = await science.evidenceGraph.review({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        graphRevisionId: state.evidenceGraph.id,
        expectedGraphContentSha256: state.evidenceGraph.contentSha256,
        candidateId: candidate.id,
        expectedCandidateContentSha256: candidate.contentSha256,
        decision: String(data.get("decision") || ""),
        rationale: String(data.get("rationale") || ""),
        reviewer: { kind: "human", id: "local-researcher" },
      });
      if (!result?.review || result.review.candidateId !== candidate.id || result.review.candidateContentSha256 !== candidate.contentSha256) throw new Error("science-evidence-graph-review-readback-mismatch");
      const snapshot = await science.evidenceGraph.get(state.selectedId);
      const readback = snapshot?.reviews?.find((review) => review.id === result.review.id && review.reviewSha256 === result.review.reviewSha256);
      if (!readback) throw new Error("science-evidence-graph-review-persistence-mismatch");
      state.evidenceGraph = snapshot.graph;
      state.evidenceGraphReviews = snapshot.reviews;
      state.evidenceGraphReviewSheet = false;
    } catch (error) {
      state.evidenceGraphReviewError = error instanceof Error ? error.message : String(error);
    } finally {
      state.evidenceGraphReviewBusy = false;
      render();
    }
  }

  root.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.tablePage !== undefined) {
      const page = Number(target.dataset.tablePage);
      if (Number.isSafeInteger(page) && page >= 0 && state.selectedArtifactId) {
        state.tablePageByArtifact.set(state.selectedArtifactId, page);
        render();
      }
      return;
    }
    if (target.dataset.citationLayout && state.activeCytoscape) {
      const name = target.dataset.citationLayout;
      document.querySelectorAll("[data-citation-layout]").forEach((button) => button.setAttribute("aria-pressed", String(button === target)));
      const host = state.activeCytoscape.container();
      state.activeCytoscape.one("layoutstop", () => {
        if (name === "concentric") state.activeCytoscape.fit(undefined, 96);
        const bounds = state.activeCytoscape.nodes().boundingBox({ includeLabels: false });
        if (!host) return;
        host.dataset.citationLayout = name;
        host.dataset.citationSpreadX = String(Math.round(bounds.w));
        host.dataset.citationSpreadY = String(Math.round(bounds.h));
      });
      state.activeCytoscape.layout(citationLayoutOptions(name, state.activeCytoscape)).run();
      return;
    }
    if (target.dataset.citationFit && state.activeCytoscape) { state.activeCytoscape.fit(undefined, 34); return; }
    if (target.dataset.evidenceGraphNodeId && !target.dataset.action) {
      state.selectedEvidenceGraphNodeId = target.dataset.evidenceGraphNodeId;
      state.selectedEvidenceGraphCandidateId = state.evidenceGraph?.inferenceCandidates?.find((candidate) => candidate.nodeId === target.dataset.evidenceGraphNodeId)?.id || null;
      state.evidenceGraphPath = null;
      render();
      return;
    }
    if (target.dataset.evidenceGraphCandidateId && !target.dataset.action) {
      const candidate = evidenceGraphCandidateById(target.dataset.evidenceGraphCandidateId);
      state.selectedEvidenceGraphCandidateId = candidate?.id || null;
      state.selectedEvidenceGraphNodeId = candidate?.nodeId || null;
      state.evidenceGraphPath = null;
      render();
      return;
    }
    if (target.dataset.action === "refresh-evidence-graph") { void refreshEvidenceGraph(); return; }
    if (target.dataset.action === "open-evidence-graph-exact") { openEvidenceGraphExactRecord(target.dataset.evidenceGraphNodeId); return; }
    if (target.dataset.action === "anchor-evidence-graph-path") {
      state.evidenceGraphPathAnchorId = target.dataset.evidenceGraphNodeId || null;
      state.evidenceGraphPath = null;
      render();
      return;
    }
    if (target.dataset.action === "explain-evidence-graph-path") { void explainEvidenceGraphPath(target.dataset.evidenceGraphNodeId); return; }
    if (target.dataset.action === "open-evidence-graph-review") {
      const candidate = evidenceGraphCandidateById(target.dataset.evidenceGraphCandidateId);
      if (!candidate) return;
      state.selectedEvidenceGraphCandidateId = candidate.id;
      state.selectedEvidenceGraphNodeId = candidate.nodeId;
      state.evidenceGraphReviewDecision = evidenceGraphReviewForCandidate(candidate)?.decision || "accepted";
      state.evidenceGraphReviewError = "";
      state.evidenceGraphReviewSheet = true;
      render();
      return;
    }
    if (target.dataset.action === "close-evidence-graph-review") {
      state.evidenceGraphReviewSheet = false;
      state.evidenceGraphReviewBusy = false;
      state.evidenceGraphReviewError = "";
      render();
      return;
    }
    if (target.dataset.action === "back-to-work") {
      target.disabled = true;
      void science.shell.backToWork().catch((error) => {
        target.disabled = false;
        state.workspaceSyncError = error instanceof Error ? error.message : String(error);
        render();
      });
      return;
    }
    if (target.dataset.action === "collapse-rail") { setRailCollapsed(true); return; }
    if (target.dataset.action === "expand-rail") { setRailCollapsed(false); return; }
    if (target.dataset.action === "scroll-workspace-tabs") {
      const tabs = document.querySelector("[data-workspace-tabs]");
      if (tabs) tabs.scrollBy({ left: (target.dataset.direction === "previous" ? -1 : 1) * Math.max(180, tabs.clientWidth * .72), behavior: "smooth" });
      window.setTimeout(syncWorkspaceTabOverflow, 320);
      return;
    }
    if (target.dataset.closeWorkspaceTab) { closeWorkspaceTab(target.dataset.closeWorkspaceTab); return; }
    if (target.dataset.workspaceTabId) { activateWorkspaceTab(target.dataset.workspaceTabId); return; }
    if (target.dataset.action === "new") {
      const action = () => { state.modal = true; render(); };
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "new-manuscript") { state.manuscriptModal = true; state.saving = false; render(); return; }
    if (target.dataset.action === "cancel-manuscript") { state.manuscriptModal = false; state.saving = false; render(); return; }
    if (target.dataset.action === "save-manuscript") { void saveManuscriptDraft(); return; }
    if (target.dataset.action === "defer-research-decision") { void deferPresentedResearchDecision(); return; }
    if (target.dataset.action === "open-research-contract-sheet") { state.researchContractSheet = state.researchContract?.status === "draft"; state.researchContractError = ""; render(); return; }
    if (target.dataset.action === "close-research-contract-sheet") {
      state.researchContractDismissedKey = researchContractKey(state.researchContract);
      state.researchContractSheet = false;
      state.researchContractBusy = false;
      state.researchContractError = "";
      render();
      requestAnimationFrame(() => document.querySelector(".researchContractNotice")?.focus());
      return;
    }
    if (target.dataset.action === "revise-research-contract") {
      const contract = state.researchContract;
      state.researchContractDismissedKey = researchContractKey(contract);
      state.researchContractSheet = false;
      state.researchContractError = "";
      if (contract?.status === "draft") state.composerDraft = i18n.prompt("reviseContract", { id: contract.id, version: contract.version });
      render();
      requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
      return;
    }
    if (target.dataset.action === "open-journal-sheet") { state.journalSheet = true; state.submissionSheet = false; state.journalActionError = ""; render(); return; }
    if (target.dataset.action === "close-journal-sheet") { state.journalSheet = false; state.journalActionBusy = false; state.journalActionError = ""; render(); return; }
    if (target.dataset.action === "open-submission-sheet") {
      if (!journalProfileById(state.selectedJournalProfileId)) {
        state.journalSheet = true;
        state.submissionSheet = false;
      } else if (!claimLedgerIsCurrent(manuscriptById(state.selectedManuscriptId))) {
        state.submissionSheet = false;
        state.journalActionError = "현재 원고 버전의 claim & evidence ledger가 ready가 아닙니다.";
        state.manuscriptInspectorOpen = true;
        render();
        return;
      } else {
        state.submissionSheet = true;
        state.journalSheet = false;
      }
      state.journalActionError = "";
      render();
      return;
    }
    if (target.dataset.action === "submission-review") { document.querySelector('#submission-export-form')?.requestSubmit(); return; }
    if (target.dataset.action === "close-submission-sheet") { state.submissionSheet = false; state.journalActionBusy = false; state.journalActionError = ""; render(); return; }
    if (target.dataset.action === "download-submission") {
      const exportId = target.dataset.exportId;
      if (!state.selectedId || !exportId || state.journalActionBusy) return;
      state.journalActionBusy = true;
      target.disabled = true;
      void science.submissions.read(state.selectedId, exportId).then((result) => {
        if (!result?.export?.fileName || !result?.bytes) throw new Error("science-submission-export-not-found");
        const url = URL.createObjectURL(new Blob([result.bytes], { type: "application/zip" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.export.fileName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }).catch((error) => {
        state.journalActionError = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        state.journalActionBusy = false;
        render();
      });
      return;
    }
    if (target.dataset.action === "ask-manuscript-review") {
      const manuscript = manuscriptById(state.selectedManuscriptId);
      state.composerDraft = i18n.prompt("reviewManuscript", { title: manuscript?.title || "Manuscript" });
      renderChatDock();
      requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
      return;
    }
    if (target.dataset.action === "toggle-manuscript-inspector") {
      state.manuscriptInspectorOpen = !state.manuscriptInspectorOpen;
      const grid = document.querySelector(".manuscriptWorkGrid");
      const toggle = document.querySelector(".manuscriptInspectorToggle");
      if (grid) grid.dataset.inspectorOpen = String(state.manuscriptInspectorOpen);
      if (toggle) toggle.setAttribute("aria-pressed", String(state.manuscriptInspectorOpen));
      if (state.manuscriptInspectorOpen) document.querySelector("#manuscript-submission-inspector")?.focus({ preventScroll: true });
      else toggle?.focus();
      return;
    }
    if (target.dataset.manuscriptOutlineLine) {
      const lineIndex = Number(target.dataset.manuscriptOutlineLine);
      if (!Number.isSafeInteger(lineIndex) || !state.manuscriptDraft) return;
      state.manuscriptView = "write";
      render();
      requestAnimationFrame(() => {
        const editor = document.querySelector("[data-manuscript-editor]");
        if (!editor) return;
        const rows = state.manuscriptDraft.markdown.split(/\r?\n/);
        const start = rows.slice(0, lineIndex).reduce((total, row) => total + row.length + 1, 0);
        const end = start + (rows[lineIndex]?.length || 0);
        editor.focus();
        editor.setSelectionRange(start, end);
      });
      return;
    }
    if (target.dataset.manuscriptView) { state.manuscriptView = target.dataset.manuscriptView; render(); return; }
    if (target.dataset.action === "send-turn") { void startComposerTurn(); return; }
    if (target.dataset.action === "cancel-turn") { void cancelComposerTurn(); return; }
    if (target.dataset.action === "import-csv-dataset") { void importCsvDataset(); return; }
    if (target.dataset.action === "request-statistics-run") { void requestSourceBoundKaplanMeier(); return; }
    if (target.dataset.action === "materialize-statistics-figure") { void materializeStatisticsFigure(target); return; }
    if (target.dataset.action === "export-statistics-figure-svg") { void exportStatisticsFigureSvg(); return; }
    if (target.dataset.action === "export-statistics-figure-png") { void exportStatisticsFigurePng(); return; }
    if (target.dataset.action === "export-numeric-surface-png") { void exportNumericSurfacePng(); return; }
    if (target.dataset.action === "export-statistics-figure-pdf") { void exportStatisticsFigurePublicationBinary("pdf"); return; }
    if (target.dataset.action === "export-statistics-figure-tiff") { void exportStatisticsFigurePublicationBinary("tiff"); return; }
    if (target.dataset.statisticsView && state.selectedArtifactId) {
      state.figureActionError = "";
      state.figureActionNotice = "";
      state.statisticsViewByArtifact.set(state.selectedArtifactId, target.dataset.statisticsView);
      void hydrateArtifactRenderer();
      return;
    }
    if (target.dataset.action === "suggest-empty-lab-run") {
      state.composerDraft = i18n.prompt("useLab", { lab: labCapabilityLabel(state.selectedLabId) });
      renderChatDock();
      requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
      return;
    }
    if (target.dataset.action === "cancel") { state.modal = false; render(); return; }
    if (target.dataset.action === "retry-project" && state.selectedId) { void selectProject(state.selectedId); return; }
    if (target.dataset.action === "toggle-drawer") { rememberScroll(); state.drawer = state.drawer ? null : { kind: state.mode === "lab" ? "artifact" : state.mode === "manuscript" ? "manuscript" : "source", id: state.mode === "lab" ? state.selectedArtifactId : state.mode === "manuscript" ? state.selectedManuscriptId : state.selectedSourceId }; render(); return; }
    if (target.dataset.action === "close-drawer") { rememberScroll(); state.drawer = null; render(); return; }
    if (target.dataset.action === "toggle-projects") { state.projectMenuOpen = !state.projectMenuOpen; render(); return; }
    if (target.dataset.action === "project-research") { if (!guardArtifactDraftNavigation(returnToSession)) returnToSession(); return; }
    if (target.dataset.projectDestination) {
      const destination = target.dataset.projectDestination;
      const action = () => navigateProjectDestination(destination);
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "toggle-labs") { state.labsExpanded = !state.labsExpanded; render(); return; }
    if (target.dataset.action === "focus-labs") {
      state.labsExpanded = true;
      render();
      requestAnimationFrame(() => document.querySelector(".labSection")?.scrollIntoView({ block: "start" }));
      return;
    }
    if (target.dataset.action === "toggle-history") {
      const action = () => { rememberScroll(); state.historyOpen = !state.historyOpen; render(); };
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "bind-artifact-manuscript") { void connectActiveArtifactToManuscript(); return; }
    if (target.dataset.action === "suggest-next-experiment") {
      const artifact = artifactForLab(state.selectedLabId, state.selectedArtifactId);
      state.composerDraft = i18n.prompt("nextExperiment", { title: artifact?.title || labLabel(state.selectedLabId) });
      renderChatDock();
      requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
      return;
    }
    if (target.dataset.labGroup) {
      if (state.expandedLabGroups.has(target.dataset.labGroup)) state.expandedLabGroups.delete(target.dataset.labGroup);
      else state.expandedLabGroups.add(target.dataset.labGroup);
      render();
      return;
    }
    if (target.dataset.action === "back-session") { if (!guardArtifactDraftNavigation(returnToSession)) returnToSession(); return; }
    if (target.dataset.action === "open-compare") { startArtifactComparison(); return; }
    if (target.dataset.action === "close-compare") { compareEpoch += 1; state.artifactComparison = null; updateArtifactCompareDom(); document.querySelector('[data-action="open-compare"]')?.focus(); return; }
    if (target.dataset.action === "keep-editing") { state.draftHistoryGuard = null; state.pendingDraftNavigation = null; document.querySelector("[data-draft-history-guard]")?.remove(); if (state.activeRendererInstance && science.renderers?.visibility) { state.activeRendererVisible = true; void science.renderers.visibility(true).catch(() => undefined); } return; }
    if (target.dataset.action === "discard-draft-history") { const version = Number(target.dataset.version); state.draftHistoryGuard = null; document.querySelector("[data-draft-history-guard]")?.remove(); void inspectArtifactVersion(version, { discardDirty: true }); return; }
    if (target.dataset.action === "discard-vega-navigation") { const next = state.pendingDraftNavigation; state.pendingDraftNavigation = null; state.vegaDraft = null; state.vegaSaveError = ""; setActiveWorkspaceTabDirty(false); document.querySelector("[data-draft-history-guard]")?.remove(); if (typeof next === "function") next(); return; }
    if (target.dataset.action === "discard-renderer-navigation") { const next = state.pendingDraftNavigation; state.pendingDraftNavigation = null; setActiveWorkspaceTabDirty(false); document.querySelector("[data-draft-history-guard]")?.remove(); if (typeof next === "function") next(); return; }
    if (target.dataset.action === "discard-manuscript-navigation") { const next = state.pendingDraftNavigation; state.pendingDraftNavigation = null; state.manuscriptDraft = null; state.manuscriptSaveError = ""; setActiveWorkspaceTabDirty(false); document.querySelector("[data-draft-history-guard]")?.remove(); if (typeof next === "function") next(); return; }
    if (target.dataset.action === "discard-workspace-navigation") { const next = state.pendingDraftNavigation; state.pendingDraftNavigation = null; setActiveWorkspaceTabDirty(false); document.querySelector("[data-draft-history-guard]")?.remove(); if (typeof next === "function") next(); return; }
    if (target.dataset.action === "reset-vega-draft") { state.vegaDraft = null; state.vegaSaveError = ""; setActiveWorkspaceTabDirty(false); render(); return; }
    if (target.dataset.projectId) { const action = () => void selectProject(target.dataset.projectId); if (!guardArtifactDraftNavigation(action)) action(); return; }
    if (target.dataset.manuscriptId) { const action = () => void openManuscript(target.dataset.manuscriptId); if (!guardArtifactDraftNavigation(action)) action(); return; }
    if (target.dataset.labId) { const action = () => void openLab(target.dataset.labId, null, null, null); if (!guardArtifactDraftNavigation(action)) action(); return; }
    if (target.dataset.manuscriptArtifactId) {
      const labId = labForArtifact(target.dataset.manuscriptArtifactId);
      const exactVersion = Number(target.dataset.manuscriptArtifactVersion);
      if (labId && Number.isSafeInteger(exactVersion)) {
        const action = () => void openLab(labId, target.dataset.manuscriptArtifactId, exactVersion, null, exactVersion);
        if (!guardArtifactDraftNavigation(action)) action();
      }
      return;
    }
    if (target.dataset.inlineArtifactId || target.dataset.chatArtifactId) { const action = () => void openConversationArtifact(target); if (!guardArtifactDraftNavigation(action)) action(); return; }
    if (target.dataset.artifactHistoryVersion) { void inspectArtifactVersion(Number(target.dataset.artifactHistoryVersion)); return; }
    if (target.dataset.citationId) { rememberScroll(); state.selectedSourceId = target.dataset.sourceId; state.drawer = { kind: "citation", id: target.dataset.citationId }; render(); return; }
    if (target.dataset.sourceId) { rememberScroll(); state.selectedSourceId = target.dataset.sourceId; state.drawer = { kind: "source", id: target.dataset.sourceId }; render(); return; }
    if (target.dataset.artifactId) { const action = () => void openLab(state.selectedLabId, target.dataset.artifactId, null); if (!guardArtifactDraftNavigation(action)) action(); }
  });

  root.addEventListener("change", (event) => {
    const evidenceGraphNodeSelect = event.target.closest("[data-evidence-graph-node-select]");
    if (evidenceGraphNodeSelect) {
      const nodeId = evidenceGraphNodeSelect.value;
      state.selectedEvidenceGraphNodeId = nodeId || null;
      state.selectedEvidenceGraphCandidateId = state.evidenceGraph?.inferenceCandidates?.find((candidate) => candidate.nodeId === nodeId)?.id || null;
      state.evidenceGraphPath = null;
      render();
      return;
    }
    const statisticsSource = event.target.closest("[data-statistics-source-artifact]");
    if (statisticsSource) {
      state.statisticsLaunchSourceArtifactId = statisticsSource.value;
      state.statisticsLaunchTimeColumn = "";
      state.statisticsLaunchEventColumn = "";
      state.statisticsLaunchError = "";
      normalizeStatisticsLaunchSelection();
      render();
      return;
    }
    const statisticsTimeColumn = event.target.closest("[data-statistics-time-column]");
    if (statisticsTimeColumn) {
      state.statisticsLaunchTimeColumn = statisticsTimeColumn.value;
      if (state.statisticsLaunchEventColumn === state.statisticsLaunchTimeColumn) state.statisticsLaunchEventColumn = "";
      state.statisticsLaunchError = "";
      normalizeStatisticsLaunchSelection();
      render();
      return;
    }
    const statisticsEventColumn = event.target.closest("[data-statistics-event-column]");
    if (statisticsEventColumn) {
      state.statisticsLaunchEventColumn = statisticsEventColumn.value;
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const journalSelect = event.target.closest("[data-journal-profile-select]");
    if (journalSelect) {
      state.selectedJournalProfileId = journalSelect.value;
      state.journalValidation = null;
      state.journalActionError = "";
      render();
      return;
    }
    const citationSelect = event.target.closest("[data-citation-node-select]");
    if (citationSelect && state.activeCytoscape) {
      state.activeCytoscape.elements().unselect();
      const node = state.activeCytoscape.getElementById(citationSelect.value);
      if (node?.length) {
        node.select();
        state.activeCytoscape.animate({ center: { eles: node }, zoom: Math.max(1, state.activeCytoscape.zoom()) }, { duration: 260 });
        node.emit("tap");
      }
      return;
    }
    const vegaControl = event.target.closest("#vega-editor-form input, #vega-editor-form select");
    if (vegaControl && state.vegaDraft) {
      const form = new FormData(document.getElementById("vega-editor-form"));
      state.vegaDraft.title = String(form.get("title") || "");
      state.vegaDraft.mark = String(form.get("mark") || "bar");
      state.vegaDraft.color = String(form.get("color") || VEGA_COLORS[0]);
      state.vegaDraft.dirty = true;
      setActiveWorkspaceTabDirty(true);
      state.vegaSaveError = "";
      render();
      return;
    }
    const target = event.target.closest("select[data-compare-selector]");
    if (!target || !state.artifactComparison) return;
    const fromVersion = target.dataset.compareSelector === "from" ? Number(target.value) : state.artifactComparison.fromVersion;
    const toVersion = target.dataset.compareSelector === "to" ? Number(target.value) : state.artifactComparison.toVersion;
    if (!Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(toVersion) || fromVersion >= toVersion) return;
    const labArtifacts = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact);
    const artifact = labArtifacts.find((item) => item.id === state.selectedArtifactId) || labArtifacts[0];
    if (artifact) void loadArtifactComparison(artifact, fromVersion, toVersion);
  });

  root.addEventListener("input", (event) => {
    const submissionForm = event.target.closest("#submission-export-form");
    if (submissionForm) {
      captureSubmissionDraft(submissionForm);
      return;
    }
    const manuscriptEditor = event.target.closest("[data-manuscript-editor]");
    if (manuscriptEditor && state.manuscriptDraft) {
      state.manuscriptDraft.markdown = manuscriptEditor.value;
      state.manuscriptDraft.dirty = true;
      setActiveWorkspaceTabDirty(true);
      state.manuscriptSaveError = "";
      const status = document.querySelector("[data-manuscript-status]");
      if (status) {
        status.dataset.state = "dirty";
        status.textContent = `v${state.manuscriptDraft.baseVersion} 기반 · 저장되지 않은 변경`;
      }
      const save = document.querySelector('[data-action="save-manuscript"]');
      if (save) save.disabled = false;
      return;
    }
    const vegaInput = event.target.closest("#vega-editor-form input[name=title]");
    if (vegaInput && state.vegaDraft) {
      state.vegaDraft.title = vegaInput.value;
      state.vegaDraft.dirty = true;
      setActiveWorkspaceTabDirty(true);
      state.vegaSaveError = "";
      const status = document.querySelector("[data-vega-draft-status]");
      if (status) status.textContent = `v${state.vegaDraft.key.split(":")[1]} 기반 · 저장되지 않은 변경`;
      document.querySelectorAll("#vega-editor-form button").forEach((button) => { button.disabled = false; });
      return;
    }
    const target = event.target.closest(".composer textarea[data-composer-input]");
    if (!target) return;
    state.composerDraft = target.value;
    const send = document.querySelector('[data-action="send-turn"]');
    if (send) send.disabled = !state.composerDraft.trim();
  });

  root.addEventListener("keydown", (event) => {
    const researchContractDialog = document.querySelector(".researchContractSheet");
    if (state.researchContractSheet && researchContractDialog) {
      if (event.key === "Escape") {
        event.preventDefault();
        state.researchContractDismissedKey = researchContractKey(state.researchContract);
        state.researchContractSheet = false;
        state.researchContractBusy = false;
        state.researchContractError = "";
        render();
        requestAnimationFrame(() => document.querySelector(".researchContractNotice")?.focus());
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...researchContractDialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute("hidden"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && (event.target === first || event.target === researchContractDialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && event.target === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    if (event.key === "Escape" && !state.railCollapsed && window.matchMedia("(max-width: 1099px)").matches && !document.querySelector("[role=dialog]")) {
      event.preventDefault();
      setRailCollapsed(true);
      return;
    }
    const workspaceTab = event.target.closest?.('[role="tab"][data-workspace-tab-id]');
    if (workspaceTab) {
      const tabs = [...document.querySelectorAll('[role="tab"][data-workspace-tab-id]')];
      const index = tabs.indexOf(workspaceTab);
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs.forEach((tab, tabIndex) => { tab.tabIndex = tabIndex === nextIndex ? 0 : -1; });
        tabs[nextIndex]?.focus();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateWorkspaceTab(workspaceTab.dataset.workspaceTabId);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && event.target.closest("[data-manuscript-editor]")) {
      event.preventDefault();
      void saveManuscriptDraft();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && event.target.closest("#vega-editor-form")) {
      event.preventDefault();
      document.getElementById("vega-editor-form")?.requestSubmit();
      return;
    }
    const target = event.target.closest(".composer textarea[data-composer-input]");
    if (!target || event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void startComposerTurn();
  });

  root.addEventListener("scroll", (event) => {
    if (event.target?.matches?.("[data-workspace-tabs]")) syncWorkspaceTabOverflow();
  }, true);
  window.addEventListener("resize", () => {
    syncRailPresentation();
    requestAnimationFrame(() => {
      revealActiveWorkspaceTab();
      requestAnimationFrame(syncWorkspaceTabOverflow);
    });
    window.setTimeout(syncWorkspaceTabOverflow, 80);
    window.setTimeout(syncWorkspaceTabOverflow, 220);
  }, { passive: true });

  root.addEventListener("submit", async (event) => {
    if (event.target.id === "evidence-graph-review-form") {
      event.preventDefault();
      await submitEvidenceGraphReview(event.target);
      return;
    }
    if (event.target.id === "research-contract-approval-form") {
      event.preventDefault();
      if (!state.selectedId || state.researchContractBusy) return;
      const projectId = state.selectedId;
      const displayedContractId = String(event.target.dataset.contractId || "");
      const displayedContractVersion = Number(event.target.dataset.contractVersion);
      const displayedProjectVersion = Number(event.target.dataset.projectVersion);
      state.researchContractBusy = true;
      state.researchContractError = "";
      render();
      try {
        const [project, latestContract] = await Promise.all([
          science.projects.get(projectId),
          science.researchContracts.get(projectId),
        ]);
        if (projectId !== state.selectedId) return;
        const stale = !project || !latestContract || latestContract.status !== "draft"
          || latestContract.id !== displayedContractId
          || latestContract.version !== displayedContractVersion
          || project.version !== displayedProjectVersion;
        applyResearchContractSnapshot(project, latestContract, { openDraft: true });
        if (stale) {
          state.researchContractSheet = latestContract?.status === "draft";
          state.researchContractError = "연구 계약 또는 프로젝트 버전이 변경되었습니다. 자동 승인하지 않았습니다. 최신 초안을 다시 확인해 주세요.";
          return;
        }
        const result = await science.researchContracts.approve({
          requestId: crypto.randomUUID(),
          projectId,
          contractId: latestContract.id,
          expectedProjectVersion: project.version,
          expectedContractVersion: latestContract.version,
        });
        if (projectId !== state.selectedId) return;
        if (!result?.project || !result?.contract || result.contract.status !== "approved") throw new Error("science-contract-approval-result-invalid");
        state.researchContractDismissedKey = null;
        applyResearchContractSnapshot(result.project, result.contract, { openDraft: false });
        state.researchContractSheet = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/science-(project|contract)-version-conflict/.test(message)) {
          try {
            const [project, latestContract] = await Promise.all([
              science.projects.get(projectId),
              science.researchContracts.get(projectId),
            ]);
            if (projectId === state.selectedId) applyResearchContractSnapshot(project, latestContract, { openDraft: true });
          } catch {}
          state.researchContractSheet = state.researchContract?.status === "draft";
          state.researchContractError = "승인 직전에 버전 충돌이 발생했습니다. 자동 재시도하지 않았습니다. 최신 초안을 확인한 뒤 다시 승인해 주세요.";
        } else {
          state.researchContractError = message;
        }
      } finally {
        state.researchContractBusy = false;
        render();
      }
      return;
    }
    if (event.target.id === "research-decision-form") {
      event.preventDefault();
      const decision = presentedLifecycleDecision();
      if (!decision || !state.selectedId || state.decisionBusy) return;
      const form = new FormData(event.target);
      const optionId = String(form.get("optionId") || "");
      const rationale = String(form.get("rationale") || "").trim() || null;
      if (!decision.options.some((option) => option.id === optionId)) {
        state.decisionError = "연구 방향을 하나 선택해 주세요.";
        render();
        return;
      }
      state.decisionBusy = true;
      state.decisionError = "";
      render();
      try {
        const analysisSpec = await science.analysisSpecs.get(state.selectedId, decision.analysisSpecId);
        if (!analysisSpec) throw new Error("science-analysis-spec-not-found");
        const result = await science.decisions.answer({
          requestId: crypto.randomUUID(),
          projectId: state.selectedId,
          decisionId: decision.id,
          optionId,
          expectedDecisionLockVersion: decision.lockVersion,
          expectedAnalysisSpecVersion: analysisSpec.currentVersion,
          expectedAnalysisSpecContentSha256: analysisSpec.currentDocumentSha256,
          rationale,
        });
        if (result?.analysisSpec) state.analysisSpecs = [result.analysisSpec, ...state.analysisSpecs.filter((item) => item.id !== result.analysisSpec.id)];
        if (result?.outcome === "applied") state.decisions = state.decisions.filter((item) => item.id !== decision.id);
        else {
          if (result?.decision) state.decisions = [result.decision, ...state.decisions.filter((item) => item.id !== result.decision.id)];
          state.decisionError = result?.outcome === "expired"
            ? "연구 전제가 변경되어 이 질문이 만료되었습니다. AI가 최신 계획으로 다시 제안해야 합니다."
            : "연구 계획이 갱신되었습니다. 최신 선택지를 다시 확인해 주세요.";
        }
      } catch (error) {
        state.decisionError = error instanceof Error ? error.message : String(error);
      } finally {
        state.decisionBusy = false;
        render();
      }
      return;
    }
    if (event.target.id === "journal-target-form") {
      event.preventDefault();
      if (!state.selectedId || state.journalActionBusy) return;
      const form = new FormData(event.target);
      const journalName = String(form.get("journalName") || "").trim();
      const articleType = String(form.get("articleType") || "").trim();
      const sourceUrls = String(form.get("sourceUrls") || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (!journalName || !articleType || !sourceUrls.length) {
        state.journalActionError = "저널 이름, article type, 공식 URL을 모두 입력해 주세요.";
        render();
        return;
      }
      try {
        for (const sourceUrl of sourceUrls) {
          const parsed = new URL(sourceUrl);
          if (parsed.protocol !== "https:") throw new Error("공식 HTTPS URL만 사용할 수 있습니다.");
        }
      } catch (error) {
        state.journalActionError = error instanceof Error ? error.message : String(error);
        render();
        return;
      }
      state.journalActionBusy = true;
      state.journalActionError = "";
      try {
        const officialHosts = [...new Set(sourceUrls.map((sourceUrl) => new URL(sourceUrl).hostname.toLowerCase()))].sort();
        const confirmation = await science.journals.confirmIdentity({ requestId: crypto.randomUUID(), projectId: state.selectedId, journalName, articleType, officialHosts });
        state.journalSheet = false;
        state.composerDraft = i18n.prompt("inspectJournalGuidelines", {
          receiptId: confirmation.receipt.id,
          receiptSha256: confirmation.receipt.contentSha256,
          journalName,
          articleType,
          officialHosts,
          sourceUrls,
        });
        render();
        await startComposerTurn({ forceAppend: true });
      } catch (error) {
        state.journalSheet = true;
        state.journalActionError = error instanceof Error ? error.message : String(error);
      } finally {
        state.journalActionBusy = false;
        render();
      }
      return;
    }
    if (event.target.id === "submission-export-form") {
      event.preventDefault();
      if (!state.selectedId || state.journalActionBusy) return;
      const manuscript = manuscriptById(state.selectedManuscriptId);
      const profile = journalProfileById(state.selectedJournalProfileId);
      if (!manuscript || !profile || !state.manuscriptDraft || !claimLedgerIsCurrent(manuscript)) {
        state.journalActionError = "원고 최신 버전, 저널 프로필, ready claim ledger를 먼저 고정해 주세요.";
        render();
        return;
      }
      captureSubmissionDraft(event.target);
      const form = new FormData(event.target);
      const optional = (name) => String(form.get(name) || "").trim() || null;
      const list = (name) => String(form.get(name) || "").split(",").map((value) => value.trim()).filter(Boolean);
      state.journalActionBusy = true;
      state.journalActionError = "";
      const submitButton = event.target.querySelector('button[type="submit"]');
      if (submitButton) { submitButton.disabled = true; submitButton.textContent = "검증 중…"; }
      try {
        const attestationCodes = form.getAll("humanAttestationCode").map((value) => String(value));
        const humanAttestationReceiptIds = [];
        for (const code of attestationCodes) {
          const confirmed = await science.journals.confirmHumanAttestation({
            requestId: crypto.randomUUID(), projectId: state.selectedId, manuscriptId: manuscript.id,
            expectedManuscriptVersion: manuscript.currentVersion, expectedManuscriptContentSha256: manuscript.version.contentSha256,
            journalProfileId: profile.id, expectedJournalProfileVersion: profile.currentVersion, expectedJournalProfileContentSha256: profile.version.contentSha256, code,
          });
          humanAttestationReceiptIds.push(confirmed.receipt.id);
        }
        const result = await science.submissions.createExport({
          requestId: crypto.randomUUID(),
          projectId: state.selectedId,
          manuscriptId: manuscript.id,
          expectedManuscriptVersion: manuscript.currentVersion,
          expectedManuscriptContentSha256: manuscript.version.contentSha256,
          journalProfileId: profile.id,
          expectedJournalProfileVersion: profile.currentVersion,
          expectedJournalProfileContentSha256: profile.version.contentSha256,
          metadata: {
            authors: [{
              name: String(form.get("authorName") || "").trim(),
              affiliations: [String(form.get("affiliation") || "").trim()].filter(Boolean),
              email: optional("email"),
              orcid: optional("orcid"),
              corresponding: true,
            }],
            keywords: list("keywords"),
            fundingStatement: optional("funding"),
            competingInterestsStatement: optional("competing"),
            authorContributionsStatement: optional("contributions"),
            dataAvailabilityStatement: optional("dataAvailability"),
            codeAvailabilityStatement: optional("codeAvailability"),
            ethicsStatement: optional("ethics"),
            coverLetter: optional("coverLetter"),
          },
          humanAttestationReceiptIds,
        });
        state.journalValidation = result.validation;
        const exportReady = result.validation.status === "ready" && result.submissionExport?.status === "ready";
        if (!exportReady) {
          state.submissionSheet = true;
          state.journalActionError = result.validation.status === "manual-review"
            ? "수동 확인이 필요한 저널 규칙이 남아 있습니다. 확인 코드를 보완한 뒤 다시 검증해 주세요."
            : "필수 저널 규칙을 통과하지 못해 제출 ZIP을 만들지 않았습니다. 아래 항목을 수정해 주세요.";
          render();
          const refreshProjectId = state.selectedId;
          void Promise.all([
            science.submissions.list(refreshProjectId, manuscript.id),
            science.researchLifecycle.get(refreshProjectId),
          ]).then(([exports, lifecycle]) => {
            if (state.selectedId !== refreshProjectId) return;
            state.submissionExports = Array.isArray(exports) ? exports : [];
            state.lifecycle = lifecycle;
            render();
          }).catch(() => { /* the blocked validation remains visible even if optional refresh fails */ });
          return;
        }
        state.submissionExports = await science.submissions.list(state.selectedId, manuscript.id);
        if (!Array.isArray(state.submissionExports)) state.submissionExports = [];
        state.lifecycle = await science.researchLifecycle.get(state.selectedId);
        if (lifecycleBindsExport(result.submissionExport)) {
          state.submissionSheet = false;
          state.submissionDraft = null;
        } else {
          state.submissionSheet = true;
          state.journalActionError = "제출 ZIP은 검증되었지만 현재 lifecycle revision에 export ID와 package SHA-256이 아직 정확히 고정되지 않았습니다. Research Director가 canonical lifecycle을 갱신하기 전에는 Ready로 표시하지 않습니다.";
        }
      } catch (error) {
        state.journalActionError = error instanceof Error ? error.message : String(error);
      } finally {
        state.journalActionBusy = false;
        render();
      }
      return;
    }
    if (event.target.id === "vega-editor-form") {
      event.preventDefault();
      await saveVegaDraft(event.target);
      return;
    }
    if (event.target.id === "new-manuscript-form") {
      event.preventDefault();
      const form = new FormData(event.target);
      state.saving = true;
      render();
      try {
        const result = await science.manuscripts.create({
          requestId: crypto.randomUUID(),
          projectId: state.selectedId,
          title: String(form.get("title") || ""),
          markdown: String(form.get("markdown") || ""),
          bindings: state.pendingManuscriptBinding ? [state.pendingManuscriptBinding] : [],
        });
        state.manuscripts = [result.manuscript, ...state.manuscripts.filter((item) => item.id !== result.manuscript.id)];
        state.manuscriptModal = false;
        state.pendingManuscriptBinding = null;
        state.saving = false;
        await openManuscript(result.manuscript.id);
      } catch (error) {
        state.saving = false;
        render();
        const errorNode = document.getElementById("manuscript-form-error");
        if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (event.target.id !== "new-project-form") return;
    event.preventDefault();
    const form = new FormData(event.target);
    state.saving = true;
    render();
    try {
      const result = await science.projects.create({ requestId: crypto.randomUUID(), question: String(form.get("question") || ""), domain: String(form.get("domain") || "general"), title: String(form.get("title") || "") });
      state.projects = [result.project, ...state.projects.filter((item) => item.id !== result.project.id)];
      state.modal = false;
      state.saving = false;
      await selectProject(result.project.id);
    } catch (error) {
      state.saving = false;
      render();
      const errorNode = document.getElementById("form-error");
      if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  async function start() {
    if (!science || typeof science.bootstrap !== "function") throw new Error("Agentlas Desktop의 검증된 Science 확장에서 열어 주세요.");
    const bootstrap = await science.bootstrap();
    state.locale = i18n.setLocale(bootstrap?.locale);
    i18n.observe(root);
    if (science.renderers?.onStatus && !state.rendererStatusDispose) state.rendererStatusDispose = science.renderers.onStatus(applyRendererStatus);
    if (science.artifacts?.onChanged && !state.artifactChangeDispose) state.artifactChangeDispose = science.artifacts.onChanged((change) => {
      if (!change || change.projectId !== state.selectedId || change.artifactId !== state.selectedArtifactId || !state.selectedId) return;
      if (state.vegaSaving) return;
      if (state.vegaDraft?.dirty) {
        state.vegaSaveError = `Lab 현재 버전이 v${Number(change.artifactVersion) || "새 버전"}로 변경되었습니다. 내 초안은 보존했습니다.`;
        const status = document.querySelector("[data-vega-draft-status]");
        if (status) status.textContent = state.vegaSaveError;
        return;
      }
      const priorMode = state.mode;
      const priorLabId = state.selectedLabId;
      const priorOriginVersion = state.selectedArtifactOriginVersion;
      const priorReturnMessageId = state.returnMessageId;
      const priorInspectedVersion = state.inspectedArtifactVersion;
      const priorComparison = state.artifactComparison ? { fromVersion: state.artifactComparison.fromVersion, toVersion: state.artifactComparison.toVersion } : null;
      state.artifactHistoryById.delete(change.artifactId);
      void selectProject(state.selectedId, { preserveWorkspace: true }).then(() => {
        if (priorMode !== "lab") return;
        void openLab(priorLabId, change.artifactId, priorOriginVersion, priorReturnMessageId).then(() => {
          if (priorInspectedVersion && priorInspectedVersion < Number(change.artifactVersion || Number.MAX_SAFE_INTEGER)) void inspectArtifactVersion(priorInspectedVersion);
          if (priorComparison && priorComparison.toVersion < Number(change.artifactVersion || Number.MAX_SAFE_INTEGER)) {
            const artifact = (state.labContextsById.get(priorLabId) || []).map((context) => context.artifact).find((item) => item.id === change.artifactId);
            if (artifact) void loadArtifactComparison(artifact, priorComparison.fromVersion, priorComparison.toVersion);
          }
        });
      });
    });
    if (science.researchLifecycle?.onChanged && !state.lifecycleChangeDispose) state.lifecycleChangeDispose = science.researchLifecycle.onChanged((change) => {
      if (!change || change.projectId !== state.selectedId || !state.selectedId) return;
      const projectId = state.selectedId;
      void Promise.all([
        science.researchLifecycle.get(projectId),
        science.decisions.list(projectId, undefined, ["presented"]),
      ]).then(([lifecycle, decisions]) => {
        if (projectId !== state.selectedId || lifecycle?.projectId !== projectId) return;
        if (lifecycle.studyId !== change.studyId || lifecycle.revision !== change.revision || lifecycle.stateSha256 !== change.stateSha256) {
          throw new Error("science-research-lifecycle-event-integrity-failed");
        }
        state.lifecycle = lifecycle;
        state.decisions = Array.isArray(decisions) ? decisions : [];
        const manuscript = manuscriptById(state.selectedManuscriptId);
        const draft = state.manuscriptDraft;
        const claimReady = manuscript && draft ? claimLedgerIsCurrent(manuscript, draft) : false;
        const lifecycleBoundExport = manuscript && claimReady
          ? state.submissionExports.find((item) => item.status === "ready" && lifecycleBindsExport(item)
            && item.manuscriptId === manuscript.id && item.manuscriptVersion === manuscript.currentVersion
            && item.claimLedgerId === state.claimLedger.manifest.ledgerId
            && item.claimLedgerRevision === state.claimLedger.manifest.revision
            && item.claimLedgerManifestSha256 === state.claimLedger.manifest.manifestSha256
            && item.claimGateReportSha256 === state.claimLedger.gate.reportSha256)
          : null;
        if (state.journalValidation?.status === "ready" && lifecycleBoundExport) {
          state.submissionSheet = false;
          state.submissionDraft = null;
          state.journalActionError = "";
        }
        render();
      }).catch((error) => {
        state.projectError = error instanceof Error ? error.message : String(error);
        render();
      });
    });
    if (science.composer?.onEvent && !state.composerEventDispose) state.composerEventDispose = science.composer.onEvent((event) => {
      if (!event || event.projectId !== state.selectedId || event.conversationId !== selectedConversation()?.id || !state.activeTurn || event.turnId !== state.activeTurn.id) return;
      void science.composer.receipt({ projectId: event.projectId, conversationId: event.conversationId, turnId: event.turnId }).then((turn) => {
        if (!turn || turn.id !== state.activeTurn?.id) return;
        state.activeTurn = turn;
        if (["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) {
          const projectId = state.selectedId;
          state.composerError = turn.status === "completed" ? "" : (turn.errorCode || `연구 실행이 ${turn.status} 상태로 종료되었습니다.`);
          if (projectId) {
            if (state.mode === "lab") void refreshConversationOnly(projectId).catch((error) => {
              state.composerError = error instanceof Error ? error.message : String(error);
              renderChatDock();
            });
            else void selectProject(projectId, { preserveWorkspace: true });
          }
          return;
        }
        renderChatDock();
      }).catch((error) => {
        state.composerError = error instanceof Error ? error.message : String(error);
        renderChatDock();
      });
    });
    state.projects = Array.isArray(bootstrap.projects) ? bootstrap.projects : [];
    state.rendererPacks = Array.isArray(bootstrap.rendererPacks) ? bootstrap.rendererPacks : [];
    if (state.projects[0]) await selectProject(state.projects[0].id); else render();
  }

  void start().catch(fatal);
})();
