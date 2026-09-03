import * as THREE from "../vendor/three.module.min.js";
import { formatScienceCell } from "./format-cell.js";

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
    projects: [], selectedId: null, lifecycle: null, conversations: [], selectedConversationId: null, messages: [], sources: [], sourceFigures: [], runs: [], artifacts: [], labs: [], workspaceLabBindings: [], labCatalog: [], labDecisionProjections: [], rendererPacks: [], manuscripts: [], claimLedger: null, journalProfiles: [], submissionExports: [], analysisSpecs: [], decisions: [],
    artifactContextsByMessage: new Map(), labContextsById: new Map(), artifactHistoryById: new Map(), selectedLabId: null, selectedArtifactOriginVersion: null, inspectedArtifactVersion: null, inspectedArtifactContext: null, artifactComparison: null, draftHistoryGuard: null, labsExpanded: true, expandedLabGroups: new Set(["chemistry"]), expandedLabDecisions: new Set(), projectMenuOpen: false, historyOpen: false, railCollapsed: readRailCollapsed(),
    blocksByMessage: new Map(), citationsByMessage: new Map(), evidenceById: new Map(), selectedSourceId: null, selectedArtifactId: null,
    evidenceGraph: null, evidenceGraphReviews: [], evidenceGraphLoading: false, evidenceGraphError: "", selectedEvidenceGraphNodeId: null, selectedEvidenceGraphCandidateId: null, evidenceGraphReviewSheet: false, evidenceGraphReviewDecision: "accepted", evidenceGraphReviewBusy: false, evidenceGraphReviewError: "", evidenceGraphPathAnchorId: null, evidenceGraphPath: null,
    mode: "session", drawer: null, modal: false, manuscriptModal: false, saving: false, loadingProject: false, projectError: "", activeVegaView: null, activeCytoscape: null, activeNumericSurface: null, activeJBrowseTarget: null, scrollByMode: { session: 0, lab: 0, manuscript: 0 }, returnMessageId: null,
    workspaceTabs: [{ id: "research", kind: "research", dirty: false }], activeWorkspaceTabId: "research", currentDestination: "overview", hypotheses: [], hypothesesError: "", approvalPolicy: null, approvalPolicyError: "", workspaceSyncError: "",
    analysisRuns: [], analysisRunArtifacts: [], analysisRunsError: "", analysisRunsProjectId: null,
    resultArtifacts: [], resultFigureIds: new Set(), resultValidations: new Map(), resultsError: "", resultsProjectId: null,
    literatureSources: [], literatureUnresolvedIds: [], literatureLoading: false, literatureError: "",
    acquisitionRuns: [], acquisitionUnresolvedIds: [], acquisitionLoading: false, acquisitionError: "",
    activeTurn: null, composerSending: false, composerDraft: "", composerError: "", composerEventDispose: null, lifecycleChangeDispose: null,
    vegaDraft: null, vegaSaving: false, vegaSaveError: "", pendingDraftNavigation: null,
    selectedManuscriptId: null, selectedAnalysisPlanId: null, manuscriptDraft: null, manuscriptSaving: false, manuscriptSaveError: "", manuscriptView: "paper", manuscriptInspectorOpen: false, selectedJournalProfileId: null, journalValidation: null, journalSheet: false, submissionSheet: false, submissionDraft: null, journalActionBusy: false, journalActionError: "",
    manuscriptEditorModel: null, manuscriptArtifactContexts: new Map(), manuscriptArtifactLineages: new Map(), manuscriptArtifactPreviewUrls: new Map(), manuscriptEditProposals: [], manuscriptSelectionContexts: [], manuscriptSelectionContext: null, manuscriptSelectionBusy: false, manuscriptSelectionError: "", manuscriptInsertion: null, manuscriptInsertBusy: false, manuscriptInsertError: "", manuscriptTransactionBusy: false, manuscriptProposalBusy: null, manuscriptNotice: "",
    manuscriptPreviewHtml: null, manuscriptPreviewKey: "", manuscriptPreviewBusy: false, manuscriptPreviewWarnings: [], manuscriptPreviewReport: null, manuscriptExportBusy: "",
    // The generated .tex / .bib and the toolchain probe: the LaTeX view reads these. Kept beside the
    // preview state so the typeset proof and the source it was compiled from cannot drift apart.
    manuscriptPreviewLatex: "", manuscriptPreviewBibtex: "", manuscriptPreviewCapabilities: null,
    artifactBindingBusy: false, artifactBindingError: "", pendingManuscriptBinding: null, manuscriptDraftJob: null,
    decisionBusy: false, decisionError: "", labDecisionActionBusy: false, labDecisionActionError: "",
    resultReviewSheet: false, resultReviewInspection: null, resultReviewBusy: false, resultReviewError: "", resultReviewStale: false, resultReviewOpener: null, resultReviewDraft: { verdict: "", trigger: "", rationale: "" },
    researchContract: null, researchContractSheet: false, researchContractBusy: false, researchContractError: "", researchContractDismissedKey: null,
    scopeProject: null, scopeContract: null, scopeLoading: false, scopeError: "",
    logbookRevisions: [], logbookLoading: false, logbookError: "",
    submissionArchiveProfiles: [], submissionArchiveExports: [], submissionArchiveLoading: false, submissionArchiveError: "",
    datasetImportBusy: false, datasetImportError: "", tablePageByArtifact: new Map(), statisticsViewByArtifact: new Map(), paleontologyViewByArtifact: new Map(),
    statisticsLaunchSourceArtifactId: null, statisticsLaunchTimeColumn: "", statisticsLaunchEventColumn: "", statisticsLaunchBusy: false, statisticsLaunchError: "", statisticsLaunchOpen: false,
    // The launch screen used to offer one analysis, because one analysis was written into it. These
    // hold the engine's own catalogue and the column mapping the chosen method declares it needs.
    statisticsMethodCatalogue: [], statisticsMethodQuery: "", statisticsLaunchMethod: "kaplan_meier", statisticsLaunchMapping: {},
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
  const labLabels = { chemistry: "Ketcher", "molecular-structure": "Mol* Structure Viewer", "literature-network": "Citation Network", "data-visualization": "Figure Lab", "data-table": "Data Table", "statistics-analysis": "Statistical Analysis", "economic-indicators": "Economic Indicators", "physics-data": "Physics Measurements", "materials-structures": "OQMD Structures", imaging: "Imaging", "astronomy-sky": "Sky Catalog", "biodiversity-map": "Biodiversity Map", "earthquake-observations": "Earthquake Observations", "paleontology-evidence": "Paleontology Evidence", "genomics-variants": "JBrowse Variants", "comparative-genomics": "Comparative Genomics" };
  const labLabel = (labId) => labLabels[labId] || String(labId || "Lab").split(/[._-]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
  const labCapabilityLabel = (labId) => state.labCatalog.find((lab) => lab.id === labId)?.label || `${labLabel(labId)} Lab`;
  const labDecisionProjection = (labId = state.selectedLabId) => state.labDecisionProjections.find((projection) => projection?.labId === labId) || null;
  const labGroups = [
    { id: "chemistry", label: "Chemistry", icon: "beaker", labIds: ["chemistry"] },
    { id: "molecular-structure", label: "Molecular Structure", icon: "cube", labIds: ["molecular-structure"] },
    { id: "literature", label: "Literature", icon: "book", labIds: ["literature-network"] },
    { id: "data-statistics", label: "Data & Statistics", icon: "chart", labIds: ["statistics-analysis", "data-visualization", "data-table"] },
    { id: "economics-finance", label: "Economics & Finance", icon: "chart", labIds: ["economic-indicators"] },
    { id: "physics", label: "Physics", icon: "chart", labIds: ["physics-data"] },
    { id: "imaging", label: "Imaging", icon: "photo", labIds: ["imaging"] },
    { id: "astronomy", label: "Astronomy", icon: "globe", labIds: ["astronomy-sky"] },
    { id: "earth-ecology", label: "Earth & Ecology", icon: "globe", labIds: ["earthquake-observations", "biodiversity-map", "paleontology-evidence"] },
    { id: "genomics", label: "Genomics", icon: "table", labIds: ["genomics-variants", "comparative-genomics"] },
    { id: "materials", label: "Materials", icon: "cube", labIds: ["materials-structures"] },
  ];
  const labIcons = { chemistry: "beaker", "molecular-structure": "cube", "literature-network": "book", "data-visualization": "chart", "data-table": "table", "statistics-analysis": "chart", "economic-indicators": "chart", "physics-data": "chart", "materials-structures": "cube", imaging: "photo", "astronomy-sky": "globe", "biodiversity-map": "globe", "earthquake-observations": "globe", "paleontology-evidence": "chart", "genomics-variants": "table", "comparative-genomics": "chart" };
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

  const PALEONTOLOGY_CATALOG_TOOL_ID = "agentlas.pbdb-taxon-occurrences";
  const PALEONTOLOGY_ANALYSIS_TOOL_ID = "agentlas.paleontology-stratigraphic-support";
  const PALEONTOLOGY_ARTIFACT_SCHEMA = "agentlas.science.paleontology-stratigraphic-analysis-artifact/v1";
  const PALEONTOLOGY_BOUNDARY = "Fossil occurrence and stratigraphic support only. Molecular evidence: none.";

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const heroIcon = (name, className = "uiIcon") => `<svg class="${escapeHtml(className)}" aria-hidden="true" viewBox="0 0 24 24"><use href="./icons/heroicons-outline.svg#${escapeHtml(name)}"></use></svg>`;
  function compileArtifactVegaSpec(spec) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("science-vega-spec-invalid");
    const schema = typeof spec.$schema === "string" ? spec.$schema.toLowerCase() : "";
    if (!schema.includes("/vega-lite/")) return spec;
    if (!window.vegaLite?.compile) throw new Error("science-vega-lite-compiler-unavailable");
    const compiled = window.vegaLite.compile(spec, { config: {} })?.spec;
    if (!compiled || typeof compiled !== "object" || Array.isArray(compiled)) throw new Error("science-vega-lite-compile-failed");
    return compiled;
  }
  function fitArtifactVegaCanvas(host, { capture = false, gutter = 10 } = {}) {
    const canvas = host?.querySelector?.("canvas");
    if (!canvas) throw new Error("science-vega-canvas-missing");
    const initial = canvas.getBoundingClientRect();
    const naturalWidth = Number(canvas.dataset.vegaNaturalCssWidth) || initial.width;
    const naturalHeight = Number(canvas.dataset.vegaNaturalCssHeight) || initial.height;
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) throw new Error("science-vega-canvas-size-invalid");
    canvas.dataset.vegaNaturalCssWidth = String(naturalWidth);
    canvas.dataset.vegaNaturalCssHeight = String(naturalHeight);
    canvas.style.width = `${naturalWidth}px`;
    canvas.style.height = `${naturalHeight}px`;
    const naturalRect = canvas.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const rightEdge = Math.min(window.innerWidth - gutter, hostRect.right - gutter);
    const bottomEdge = window.innerHeight - gutter;
    const availableWidth = Math.max(1, rightEdge - naturalRect.left);
    const availableHeight = Math.max(1, bottomEdge - naturalRect.top);
    const scale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
    const fittedWidth = Math.max(1, Math.floor(naturalWidth * scale));
    const fittedHeight = Math.max(1, Math.floor(naturalHeight * scale));
    canvas.style.width = `${fittedWidth}px`;
    canvas.style.height = `${fittedHeight}px`;
    canvas.style.marginInline = "auto";
    if (capture) canvas.dataset.scienceCapture = "";
    const fitted = canvas.getBoundingClientRect();
    const fits = fitted.left >= -1 && fitted.top >= -1 && fitted.right <= window.innerWidth + 1 && fitted.bottom <= window.innerHeight + 1;
    host.dataset.vegaCaptureScale = scale.toFixed(6);
    host.dataset.vegaCaptureFits = String(fits);
    host.dataset.vegaCaptureRect = JSON.stringify({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    if (!fits) throw new Error("science-vega-capture-layout-out-of-bounds");
    return { canvas, scale, rect: fitted, availableWidth, availableHeight };
  }
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
  const labDecisionStateLabels = {
    "input-needed": "입력 확인 필요",
    "human-decision-needed": "연구자 결정 필요",
    ready: "실행 준비됨",
    "review-needed": "결과 검토 필요",
  };
  const labDecisionFreshnessLabels = { current: "현재 근거", stale: "근거 변경됨", superseded: "새 실험으로 대체됨" };
  const labDecisionActionLabels = {
    "open-required-input": "필요 입력 준비",
    "answer-human-decision": "연구 방향 결정",
    "inspect-approved-plan": "승인된 계획 열기",
    "review-result": "결과 검토 및 다음 동작 선택",
    "follow-intent-next-action": "다음 연구 동작",
    "refresh-stale-projection": "현재 근거 다시 확인",
    "open-superseding-context": "최신 실험 열기",
  };

  function labDecisionPanelMarkup(projection = labDecisionProjection(), { showAction = true } = {}) {
    if (!projection) return "";
    const mustSee = Array.isArray(projection.mustSee) ? projection.mustSee.slice(0, 3) : [];
    const actionEnabled = projection.action?.enabled === true && !state.labDecisionActionBusy;
    const expanded = state.expandedLabDecisions.has(projection.labId);
    return `<section class="labDecisionPanel" data-lab-decision-projection="${escapeHtml(projection.projectionSha256)}" data-lab-decision-state="${escapeHtml(projection.state)}" data-lab-decision-freshness="${escapeHtml(projection.freshness?.status)}" data-expanded="${expanded}"><header><div><span>WHY THIS LAB NOW</span><strong>${escapeHtml(projection.currentDecision)}</strong></div><div class="labDecisionHeaderActions"><div class="labDecisionStatus"><span class="progressGlyph" data-fill="${{"input-needed":"0","human-decision-needed":"33","ready":"66","result-review-needed":"100"}[projection.state] || "0"}" aria-hidden="true"></span><em>${escapeHtml(labDecisionStateLabels[projection.state] || projection.state)}</em><span>${escapeHtml(labDecisionFreshnessLabels[projection.freshness?.status] || projection.freshness?.status)}</span></div><button type="button" data-action="toggle-lab-decision-details" data-lab-id="${escapeHtml(projection.labId)}" aria-expanded="${expanded}">${expanded ? "판단 기준 접기" : "판단 기준 보기"}</button></div></header><div class="labDecisionBody"><section><span>이 분석이 필요한 때</span><p>${escapeHtml(projection.researchIntent?.neededWhen || projection.action?.reason || "현재 프로젝트 결정을 위해 이 Lab의 근거가 필요합니다.")}</p><span class="labDecisionSubquestion">연구자가 이걸로 하려는 일</span><p>${escapeHtml(projection.researchIntent?.userGoal || projection.currentDecision)}</p></section><section><span>반드시 확인할 것</span><ol>${mustSee.map((item) => `<li>${escapeHtml(item.requirement)}</li>`).join("")}</ol></section><section class="labDecisionBoundary boundaryNote"><span>이 분석을 쓰면 안 되는 때</span><p>${escapeHtml(projection.researchIntent?.notWhen || projection.boundary)}</p><span class="labDecisionSubquestion">이 화면만으로 말할 수 없는 것</span><p>${escapeHtml(projection.boundary)}</p></section></div><footer><span>${escapeHtml(projection.action?.reason || "")} · Project v${escapeHtml(projection.basis?.project?.version || "-")} · <code title="${escapeHtml(projection.basis?.basisSha256 || "")}">${escapeHtml(String(projection.basis?.basisSha256 || "").slice(0, 12))}…</code></span>${showAction ? `<button type="button" data-action="lab-decision-primary" data-lab-decision-sha256="${escapeHtml(projection.projectionSha256)}" ${actionEnabled ? "" : "disabled"}>${escapeHtml(state.labDecisionActionBusy ? "현재 근거 확인 중…" : labDecisionActionLabels[projection.action?.kind] || projection.action?.action || "다음 동작")}</button>` : `<span class="labDecisionActionHint">아래의 한 동작으로 이어집니다.</span>`}</footer>${state.labDecisionActionError ? `<p class="labDecisionError" role="alert">${escapeHtml(state.labDecisionActionError)}</p>` : ""}</section>`;
  }
  const labDecisionEmptyMarkup = (content) => {
    const projection = labDecisionProjection();
    const showAction = ["review-result", "follow-intent-next-action"].includes(projection?.action?.kind);
    return `<div class="labDecisionEmptyShell">${labDecisionPanelMarkup(projection, { showAction })}${content}</div>`;
  };
  const lifecycleBindsExport = (submissionExport) => Boolean(submissionExport && state.lifecycle?.phase === "ready_to_submit"
    && state.lifecycle?.status === "complete"
    && state.lifecycle?.submissionExport?.submissionExportId === submissionExport.id
    && state.lifecycle?.submissionExport?.packageSha256 === submissionExport.packageSha256);
  const submissionExportBindsResearchState = (submissionExport, manuscript, claimLedger = state.claimLedger) => Boolean(
    submissionExport?.status === "ready" && manuscript && claimLedger && lifecycleBindsExport(submissionExport)
    && submissionExport.projectId === state.selectedId
    && submissionExport.manuscriptId === manuscript.id
    && submissionExport.manuscriptVersion === manuscript.currentVersion
    && submissionExport.manuscriptContentSha256 === manuscript.version?.contentSha256
    && submissionExport.claimLedgerId === claimLedger.manifest?.ledgerId
    && submissionExport.claimLedgerRevision === claimLedger.manifest?.revision
    && submissionExport.claimLedgerManifestSha256 === claimLedger.manifest?.manifestSha256
    && submissionExport.claimGateReportSha256 === claimLedger.gate?.reportSha256
  );
  const submissionExportBindsJournalProfile = (submissionExport, journalProfile) => Boolean(
    submissionExport && journalProfile?.status === "verified"
    && submissionExport.journalProfileId === journalProfile.id
    && submissionExport.journalProfileVersion === journalProfile.currentVersion
    && submissionExport.journalProfileContentSha256 === journalProfile.version?.contentSha256
  );
  const restoreSubmissionExportState = (manuscript, claimLedger, exports, { preferBoundProfile = true } = {}) => {
    state.submissionExports = Array.isArray(exports) ? exports : [];
    const lifecycleBoundExport = state.submissionExports.find((item) => submissionExportBindsResearchState(item, manuscript, claimLedger)) || null;
    if (preferBoundProfile && lifecycleBoundExport) {
      const lifecycleBoundProfile = state.journalProfiles.find((profile) => submissionExportBindsJournalProfile(lifecycleBoundExport, profile));
      if (lifecycleBoundProfile) state.selectedJournalProfileId = lifecycleBoundProfile.id;
    }
    return lifecycleBoundExport;
  };
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
  const labIdForArtifact = (artifactId) => {
    for (const [labId, contexts] of state.labContextsById) {
      if ((contexts || []).some((context) => context?.artifact?.id === artifactId)) return labId;
    }
    return null;
  };
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
  // --- Choosing an analysis, and telling it which columns to read ---------------------------------
  //
  // This screen offered exactly one analysis because one analysis was written into it: the request
  // it built had `method: "kaplan_meier"` as a literal, and its only two column pickers were named
  // `time` and `event`. The engine registers 178 methods. Everything below derives from the
  // engine's own catalogue instead, so a method that is registered tomorrow appears here without
  // anyone editing this file.

  /** The catalogue is loaded once per session; it changes only when the plugin does. */
  async function loadStatisticsMethodCatalogue() {
    if (state.statisticsMethodCatalogue.length || !science.artifacts?.statisticsMethods) return;
    try {
      const catalogue = await science.artifacts.statisticsMethods();
      state.statisticsMethodCatalogue = Array.isArray(catalogue) ? catalogue : [];
    } catch (error) {
      state.statisticsMethodCatalogue = [];
      state.statisticsLaunchError = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  const statisticsMethodEntry = (method) => state.statisticsMethodCatalogue.find((entry) => entry.method === method) || null;

  /**
   * Methods a researcher can actually run on the table they uploaded.
   *
   * Kaplan-Meier keeps its own hand-written projection in the runtime and is offered alongside the
   * projectable ones. A method that cannot read a table at all -- a power calculation takes
   * parameters, not data -- is not listed here, because listing it would be offering something this
   * screen cannot deliver.
   */
  function statisticsLaunchableMethods() {
    const query = state.statisticsMethodQuery.trim().toLowerCase();
    return state.statisticsMethodCatalogue
      .filter((entry) => entry.projectable || entry.method === "kaplan_meier")
      .filter((entry) => !query
        || entry.method.includes(query)
        || entry.family.toLowerCase().includes(query)
        || String(entry.neededWhen || "").toLowerCase().includes(query));
  }

  /**
   * One control per data property the chosen method declares.
   *
   * The shape comes from the method, never from a list kept here: a flat array asks for one column,
   * a named series asks for either several columns (the wide layout a spreadsheet has) or a
   * name/value pair (the long layout), a row-object array asks for one column per declared field,
   * and a parameter asks for a value. An unmapped REQUIRED property leaves the button disabled --
   * the screen refuses rather than sending a request the runtime will reject.
   */
  function statisticsMappingControls(entry, columns) {
    if (!entry || entry.method === "kaplan_meier") return "";
    // A column already given to another property is not offered again. Without this the outcome
    // column sits in the factor list, and a researcher can regress a variable on itself with one
    // stray click -- the screen would have handed them a perfect fit and no warning.
    const claimedBy = new Map();
    for (const [property, spec] of Object.entries(state.statisticsLaunchMapping)) {
      if (!spec) continue;
      for (const name of [spec.column, spec.nameColumn, spec.valueColumn, ...(spec.columns || []), ...Object.values(spec.rowColumns || {}), ...Object.values(spec.valueColumns || {})]) {
        if (name) claimedBy.set(name, property);
      }
    }
    const availableFor = (property, list) => list.filter((column) => !claimedBy.has(column.name) || claimedBy.get(column.name) === property);
    const numericAll = columns.filter((column) => ["integer", "number"].includes(column.logicalType));
    const columnOptions = (list, selected) => list.map((column) => `<option value="${escapeHtml(column.name)}" ${column.name === selected ? "selected" : ""}>${escapeHtml(column.name)} · ${escapeHtml(column.logicalType)}</option>`).join("");
    return entry.dataProperties.map((property) => {
      const current = state.statisticsLaunchMapping[property.property] || {};
      const label = `${escapeHtml(property.property)}${property.required ? "" : " · optional"}`;
      if (property.accepts === "column") {
        return `<label class="field statisticsMappingField"><span>${label}</span><select data-statistics-map-column="${escapeHtml(property.property)}"><option value="">선택 안 함</option>${columnOptions(availableFor(property.property, columns), current.column)}</select></label>`;
      }
      if (property.accepts === "columns-or-long") {
        const wide = !current.nameColumn;
        const chosen = new Set(Array.isArray(current.columns) ? current.columns : []);
        const numeric = availableFor(property.property, numericAll);
        const checkboxes = numeric.map((column) => `<label class="statisticsMappingCheck"><input type="checkbox" data-statistics-map-series="${escapeHtml(property.property)}" value="${escapeHtml(column.name)}" ${chosen.has(column.name) ? "checked" : ""}><span>${escapeHtml(column.name)}</span></label>`).join("");
        const longControls = `<select data-statistics-map-name="${escapeHtml(property.property)}"><option value="">이름 열</option>${columnOptions(availableFor(property.property, columns).filter((column) => column.logicalType === "string"), current.nameColumn)}</select><select data-statistics-map-value="${escapeHtml(property.property)}"><option value="">값 열</option>${columnOptions(numeric, current.valueColumn)}</select>`;
        return `<div class="field statisticsMappingField" data-statistics-mapping-mode="${wide ? "wide" : "long"}"><span>${label}</span><div class="statisticsMappingModes"><button type="button" data-statistics-map-mode="${escapeHtml(property.property)}" value="wide" ${wide ? "aria-pressed=\"true\"" : ""}>열마다 하나</button><button type="button" data-statistics-map-mode="${escapeHtml(property.property)}" value="long" ${wide ? "" : "aria-pressed=\"true\""}>이름·값 열</button></div>${wide ? `<div class="statisticsMappingChecks">${checkboxes}</div>` : longControls}</div>`;
      }
      if (property.accepts === "choice-list") {
        // Options the method itself declares, offered as checkboxes: this is a choice the
        // researcher makes, not a column, and it is recorded in the projection receipt as chosen.
        const chosen = new Set(Array.isArray(current.choices) ? current.choices : []);
        const boxes = (property.options || []).map((option) => `<label class="statisticsMappingCheck"><input type="checkbox" data-statistics-map-choice="${escapeHtml(property.property)}" value="${escapeHtml(option)}" ${chosen.has(option) ? "checked" : ""}><span>${escapeHtml(option)}</span></label>`).join("");
        return `<div class="field statisticsMappingField"><span>${label}</span><div class="statisticsMappingChecks">${boxes}</div></div>`;
      }
      if (property.accepts === "grouped-columns") {
        // A survival sheet: one column says which arm a subject is in, and one column per declared
        // field carries that subject's numbers. Same table a researcher already keeps.
        const groupSelect = `<label class="statisticsMappingRowField"><span>그룹 열</span><select data-statistics-map-name="${escapeHtml(property.property)}"><option value="">선택 안 함</option>${columnOptions(availableFor(property.property, columns).filter((column) => column.logicalType === "string"), current.nameColumn)}</select></label>`;
        const fields = property.fields.map((field) => `<label class="statisticsMappingRowField"><span>${escapeHtml(field)}</span><select data-statistics-map-grouped="${escapeHtml(property.property)}" data-field="${escapeHtml(field)}"><option value="">선택 안 함</option>${columnOptions(availableFor(property.property, numericAll), (current.valueColumns || {})[field])}</select></label>`).join("");
        return `<div class="field statisticsMappingField"><span>${label} · 그룹마다 하나</span><div class="statisticsMappingRow">${groupSelect}${fields}</div></div>`;
      }
      if (property.accepts === "row-columns") {
        const fields = property.fields.map((field) => `<label class="statisticsMappingRowField"><span>${escapeHtml(field)}</span><select data-statistics-map-field="${escapeHtml(property.property)}" data-field="${escapeHtml(field)}"><option value="">선택 안 함</option>${columnOptions(availableFor(property.property, columns), (current.rowColumns || {})[field])}</select></label>`).join("");
        return `<div class="field statisticsMappingField"><span>${label} · 행마다 하나</span><div class="statisticsMappingRow">${fields}</div></div>`;
      }
      if (property.accepts === "value") {
        return `<label class="field statisticsMappingField"><span>${label}</span><input type="text" data-statistics-map-value-literal="${escapeHtml(property.property)}" value="${escapeHtml(current.value === undefined ? "" : String(current.value))}"></label>`;
      }
      return "";
    }).join("");
  }

  /** A mapping is complete when every required property has been given something to read. */
  function statisticsMappingReady(entry) {
    if (!entry || entry.method === "kaplan_meier") return true;
    return entry.dataProperties.filter((property) => property.required).every((property) => {
      const current = state.statisticsLaunchMapping[property.property];
      if (!current) return false;
      if (property.accepts === "column") return Boolean(current.column);
      if (property.accepts === "columns-or-long") return Boolean((current.columns || []).length) || Boolean(current.nameColumn && current.valueColumn);
      if (property.accepts === "choice-list") return Boolean((current.choices || []).length);
      if (property.accepts === "grouped-columns") return Boolean(current.nameColumn) && property.fields.every((field) => Boolean((current.valueColumns || {})[field]));
      if (property.accepts === "row-columns") return property.fields.every((field) => !entryFieldRequired(entry, property, field) || Boolean((current.rowColumns || {})[field]));
      if (property.accepts === "value") return current.value !== undefined && String(current.value).length > 0;
      return false;
    });
  }

  // The catalogue does not carry per-field requiredness, so a row-object field counts as needed when
  // the researcher has begun mapping that property at all. Being generous here and letting the
  // runtime refuse by name is better than blocking a valid mapping the screen guessed wrong about.
  function entryFieldRequired() { return false; }

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
    const [messageEvidence, messageArtifactRows, attached, manuscripts, journalProfiles, analysisSpecs, decisions, lifecycle, project, researchContract, graphSnapshot, labDecisionProjections, runs] = await Promise.all([
      loadMessageEvidence(projectId, safeMessages),
      Promise.all(safeMessages.map(async (message) => [message.id, await science.artifacts.forMessage(projectId, message.conversationId, message.id)])),
      science.composer.attach({ projectId, conversationId: conversation.id }),
      science.manuscripts.list(projectId),
      science.journals.list(projectId),
      science.analysisSpecs.list(projectId),
      science.decisions.list(projectId, undefined, ["queued", "presented", "deferred"]),
      science.researchLifecycle.get(projectId),
      science.projects.get(projectId),
      science.researchContracts.get(projectId),
      science.evidenceGraph.get(projectId).catch((error) => ({ graph: null, reviews: [], error: error instanceof Error ? error.message : String(error) })),
      science.labs.decisionProjections(projectId),
      science.runs.list(projectId),
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
    state.labDecisionProjections = Array.isArray(labDecisionProjections) ? labDecisionProjections : [];
    state.runs = Array.isArray(runs) ? runs : [];
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
    if (await maybeOpenDraftJobManuscript(projectId, { terminal: ["completed", "failed", "cancelled", "interrupted"].includes(state.activeTurn?.status) })) return;
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
    if (switchingProject && state.manuscriptDraftJob?.projectId !== projectId) state.manuscriptDraftJob = null;
    state.lifecycle = null;
    state.mode = "session";
    if (!preservedWorkspace) resetWorkspaceTabs();
    state.conversations = [];
    state.selectedConversationId = null;
    state.messages = [];
    state.sources = [];
    state.sourceFigures = [];
    state.runs = [];
    state.artifacts = [];
    state.labs = [];
    state.workspaceLabBindings = [];
    state.labDecisionProjections = [];
    state.manuscripts = [];
    state.claimLedger = null;
    state.journalProfiles = [];
    state.submissionExports = [];
    state.scopeProject = null;
    state.scopeContract = null;
    state.scopeLoading = false;
    state.scopeError = "";
    state.logbookRevisions = [];
    state.logbookLoading = false;
    state.logbookError = "";
    state.submissionArchiveProfiles = [];
    state.submissionArchiveExports = [];
    state.submissionArchiveLoading = false;
    state.submissionArchiveError = "";
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
    state.paleontologyViewByArtifact = new Map();
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
    state.selectedAnalysisPlanId = null;
    state.manuscriptDraft = null;
    state.manuscriptSaving = false;
    state.manuscriptSaveError = "";
    state.manuscriptPreviewHtml = null;
    state.manuscriptPreviewLatex = "";
    state.manuscriptPreviewBibtex = "";
    state.manuscriptPreviewCapabilities = null;
    state.manuscriptPreviewKey = "";
    state.manuscriptPreviewBusy = false;
    state.manuscriptPreviewWarnings = [];
    state.manuscriptPreviewReport = null;
    state.manuscriptView = "paper";
    state.manuscriptInspectorOpen = false;
    state.manuscriptEditorModel = null;
    disposeManuscriptArtifactPreviews();
    state.manuscriptArtifactContexts = new Map();
    state.manuscriptArtifactLineages = new Map();
    state.manuscriptEditProposals = [];
    state.manuscriptSelectionContexts = [];
    state.manuscriptSelectionContext = null;
    state.manuscriptSelectionBusy = false;
    state.manuscriptSelectionError = "";
    disposeManuscriptInsertion();
    state.manuscriptInsertBusy = false;
    state.manuscriptInsertError = "";
    state.manuscriptTransactionBusy = false;
    state.manuscriptProposalBusy = null;
    state.manuscriptNotice = "";
    state.selectedJournalProfileId = null;
    state.journalValidation = null;
    state.journalSheet = false;
    state.submissionSheet = false;
    state.submissionDraft = null;
    state.journalActionBusy = false;
    state.journalActionError = "";
    state.decisionBusy = false;
    state.decisionError = "";
    state.labDecisionActionBusy = false;
    state.labDecisionActionError = "";
    state.researchContract = null;
    state.researchContractSheet = false;
    state.researchContractBusy = false;
    state.researchContractError = "";
    if (switchingProject) state.researchContractDismissedKey = null;
    state.loadingProject = true;
    if (!preservedWorkspace) render();
    try {
      const [workspaceState, conversations, sources, sourceFigures, artifacts, labs, capabilityCatalog, labDecisionProjections, rendererPacks, manuscripts, journalProfiles, analysisSpecs, decisions, lifecycle, project, researchContract, graphSnapshot, runs] = await Promise.all([
        science.workspace.get(projectId), science.conversations.list(projectId), science.sources.list(projectId), science.sourceFigures?.list ? science.sourceFigures.list(projectId).catch(() => []) : [], science.artifacts.list(projectId), science.labs.list(projectId), science.labs.catalog(), science.labs.decisionProjections(projectId), science.rendererPacks.list(), science.manuscripts.list(projectId), science.journals.list(projectId), science.analysisSpecs.list(projectId), science.decisions.list(projectId, undefined, ["queued", "presented", "deferred"]), science.researchLifecycle.get(projectId), science.projects.get(projectId), science.researchContracts.get(projectId), science.evidenceGraph.get(projectId).catch((error) => ({ graph: null, reviews: [], error: error instanceof Error ? error.message : String(error) })), science.runs.list(projectId),
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
      state.sourceFigures = Array.isArray(sourceFigures) ? sourceFigures : [];
      state.runs = Array.isArray(runs) ? runs : [];
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
      state.labDecisionProjections = Array.isArray(labDecisionProjections) ? labDecisionProjections : [];
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
            // A view name saved by an older build is not a view this build has. Fall back rather
            // than restore a tab that no longer renders anything.
            state.manuscriptView = ["paper", "write", "preview", "latex"].includes(preservedWorkspace.manuscriptView) ? preservedWorkspace.manuscriptView : "paper";
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
        const manuscript = manuscriptById(state.selectedManuscriptId);
        const [claimLedger, submissionExports, editorWorkspace] = await Promise.all([
          science.claimLedgers.getForManuscript(projectId, state.selectedManuscriptId),
          science.submissions.list(projectId, state.selectedManuscriptId),
          loadManuscriptEditorWorkspace(projectId, state.selectedManuscriptId),
        ]);
        if (epoch !== selectionEpoch) return;
        applyManuscriptEditorWorkspace(editorWorkspace);
        state.claimLedger = claimLedger;
        restoreSubmissionExportState(manuscript, claimLedger, submissionExports, { preferBoundProfile: !preservedWorkspace });
      }
      if (state.mode === "lab" && state.selectedArtifactId && !state.artifactHistoryById.has(state.selectedArtifactId)) {
        const history = await science.artifacts.history(projectId, state.selectedArtifactId);
        if (epoch !== selectionEpoch) return;
        if (history?.artifactId === state.selectedArtifactId) state.artifactHistoryById.set(state.selectedArtifactId, history);
      }
      // Another project's sources and runs must never survive a project switch: clear them, then
      // load only if the restored workspace put the researcher on that destination -- arriving by
      // restore is still arriving. This runs before the draft-job hand-off below, which can return
      // early; the stale rows must already be gone by then.
      state.literatureSources = [];
      state.literatureUnresolvedIds = [];
      state.literatureError = "";
      state.acquisitionRuns = [];
      state.acquisitionUnresolvedIds = [];
      state.acquisitionError = "";
      if (await maybeOpenDraftJobManuscript(projectId, { terminal: ["completed", "failed", "cancelled", "interrupted"].includes(state.activeTurn?.status) })) return;
      render();
      // Read the hypotheses on opening the project, not only on arriving at their screen: the rail
      // badge tells the researcher that something is waiting on them, and a badge that only appears
      // once you are already looking at the thing it points to is not a signal.
      void loadHypotheses(projectId);
      if (state.currentDestination === "literature") void loadLiterature(projectId);
      if (state.currentDestination === "acquisition") void loadAcquisition(projectId);
      // A restored workspace lands on its saved destination without passing through the navigation
      // handler, so the same arrival read has to happen here or the screen shows a false empty.
      if (state.currentDestination === "scope") { void loadScope(projectId); void loadApprovalPolicy(projectId); }
      if (state.currentDestination === "logbook") void loadLogbook(projectId);
      if (state.currentDestination === "submission-archive") void loadSubmissionArchive(projectId);
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
    // A decision the researcher owns has to be visible from wherever they are standing. Approving a
    // hypothesis is human-only -- the agent's tool refuses those states -- so a study can sit
    // waiting on it indefinitely while the only sign lives on a screen nobody opened. The count
    // rides the rail so it is legible from every destination.
    const pendingHypotheses = (Array.isArray(state.hypotheses) ? state.hypotheses : [])
      .filter((item) => item && item.status !== "approved" && item.status !== "rejected").length;
    const destinationBadge = (id) => (id === "hypotheses" && pendingHypotheses
      ? `<em class="destinationPending" title="${escapeHtml(String(pendingHypotheses))}건이 연구자의 결정을 기다립니다">${escapeHtml(String(pendingHypotheses))}</em>`
      : "");
    const destinations = projectDestinationGroups.map((group) => `<section class="projectNavGroup"><div class="projectNavLabel">${escapeHtml(group.label)}</div>${group.items.map((item) => `<button data-project-destination="${escapeHtml(item.id)}" aria-current="${state.currentDestination === item.id}" ${item.id === "hypotheses" && pendingHypotheses ? `data-pending-decisions="${escapeHtml(String(pendingHypotheses))}"` : ""}>${heroIcon(item.icon)}<span>${escapeHtml(item.label)}</span>${destinationBadge(item.id)}</button>`).join("")}</section>`).join("");
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
      <div class="railBrand"><span class="railBrandLockup"><img class="railBrandMark" src="./assets/agentlas-mark.png" alt="" aria-hidden="true"><span class="railBrandWordmark"><strong><span class="brandAgentlas">Agentlas</span><span class="brandScience">Science<span class="brandStar">*</span></span></strong></span></span><button class="railCollapseButton" data-action="collapse-rail" aria-label="사이드바 접기" title="사이드바 접기">${heroIcon("chevron-right", "uiIcon isReverse")}</button></div>
      <button class="railBackButton" data-action="back-to-work" aria-label="Agentlas Work로 돌아가기" title="Agentlas Work로 돌아가기">${heroIcon("chevron-right", "uiIcon isReverse")}<strong>Agentlas Work</strong></button>
      <button class="newButton" data-action="new" aria-label="새 연구 시작" title="새 연구">${heroIcon("plus")}<strong>새 연구</strong></button>
      ${projectSection}
      <div class="railSection labSection"><button class="railDisclosure" data-action="toggle-labs" aria-expanded="${state.labsExpanded}"><span>Labs</span>${heroIcon("chevron-down", state.labsExpanded ? "uiIcon isReverse" : "uiIcon")}</button><nav class="labList ${state.labsExpanded ? "isOpen" : ""}" aria-label="현재 프로젝트에 활성화된 Lab 도구와 아티팩트 보관소">${labs || `<span class="railEmpty">이 프로젝트에는 아직 Lab이 없습니다.<em>연구 채팅에서 필요한 분석을 말하면 그 Lab이 여기에 열립니다. 예: “이 표로 생존곡선을 그려줘”</em></span>`}</nav></div>
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

  function analysisPlanView(project) {
    const plan = analysisSpecById(state.selectedAnalysisPlanId) || state.analysisSpecs[0] || null;
    // The header wraps its three parts in one div, exactly as the filled screen does. Left bare,
    // the row's flex rule laid the label, the title and the sentence out as three columns: the
    // label was squeezed into two stacked words and the title broke across three lines.
    if (!plan) return `<section class="analysisPlanView analysisPlanEmpty"><header><div><span>Plan & Protocols</span><h1>${escapeHtml(project.title)}</h1><p>아직 project-bound 분석계획이 없습니다. 연구 질문, estimand, 의존구조와 입력 데이터가 확정되기 전에는 분석을 실행하지 않습니다.</p></div></header><div><strong>다음에 필요한 것</strong><span>오른쪽 연구 채팅에서 분석 목적과 데이터 구조를 함께 정의하세요.</span></div></section>`;
    const document = plan.version?.document || {};
    const estimand = document.estimand;
    const model = document.model;
    const decisions = state.decisions.filter((decision) => decision.analysisSpecId === plan.id && ["queued", "presented", "deferred"].includes(decision.status));
    const values = (items, empty = "정의되지 않음") => Array.isArray(items) && items.length ? items.join(", ") : empty;
    return `<section class="analysisPlanView" data-analysis-plan-id="${escapeHtml(plan.id)}" data-analysis-plan-version="${escapeHtml(plan.currentVersion)}" data-analysis-plan-sha256="${escapeHtml(plan.currentDocumentSha256)}"><header><div><span>PLAN & PROTOCOLS · EXACT VERSION</span><h1>${escapeHtml(plan.title)}</h1><p>${escapeHtml(document.researchQuestion || project.question)}</p></div><div class="analysisPlanIdentity"><em data-status="${escapeHtml(plan.status)}">${escapeHtml(plan.status)}</em><strong>v${escapeHtml(plan.currentVersion)}</strong><code title="${escapeHtml(plan.currentDocumentSha256)}">${escapeHtml(plan.currentDocumentSha256.slice(0, 12))}…</code></div></header><div class="analysisPlanGrid"><section><span>Estimand</span>${estimand ? `<dl><div><dt>Population</dt><dd>${escapeHtml(estimand.population)}</dd></div><div><dt>Exposure</dt><dd>${escapeHtml(estimand.treatmentOrExposure)}</dd></div><div><dt>Comparator</dt><dd>${escapeHtml(estimand.comparator || "없음")}</dd></div><div><dt>Outcome</dt><dd>${escapeHtml(estimand.outcome)}</dd></div><div><dt>Measure</dt><dd>${escapeHtml(estimand.summaryMeasure)}</dd></div></dl>` : `<p>연구자가 estimand를 아직 확정하지 않았습니다.</p>`}</section><section><span>Design & dependence</span><dl><div><dt>Study</dt><dd>${escapeHtml(document.design?.studyType || "미정")}</dd></div><div><dt>Observation unit</dt><dd>${escapeHtml(document.design?.observationUnit || "미정")}</dd></div><div><dt>Dependence</dt><dd>${escapeHtml(document.design?.dependence?.kind || "unresolved")}</dd></div><div><dt>Inputs</dt><dd>${escapeHtml(document.data?.inputs?.length || 0)} exact artifact version(s)</dd></div></dl></section><section><span>Model</span>${model ? `<dl><div><dt>Family</dt><dd>${escapeHtml(model.family)}</dd></div><div><dt>Formula</dt><dd><code>${escapeHtml(model.formula)}</code></dd></div><div><dt>Distribution / link</dt><dd>${escapeHtml(`${model.distribution || "—"} / ${model.link || "—"}`)}</dd></div><div><dt>Rationale</dt><dd>${escapeHtml(model.rationale)}</dd></div></dl>` : `<p>모델이 아직 확정되지 않았습니다.</p>`}</section><section><span>Validity checks</span><dl><div><dt>Diagnostics</dt><dd>${escapeHtml(values(document.requiredDiagnostics))}</dd></div><div><dt>Sensitivity</dt><dd>${escapeHtml(values(document.sensitivityAnalyses))}</dd></div><div><dt>Missing data</dt><dd>${escapeHtml(document.missingData?.strategy || "unresolved")}</dd></div><div><dt>Multiplicity</dt><dd>${escapeHtml(document.multiplicity?.strategy || "unresolved")}</dd></div></dl></section></div><footer><div><span>Human decisions</span><strong>${escapeHtml(decisions.length ? `${decisions.length}개 미해결` : "미해결 결정 없음")}</strong></div><div><span>Expected outputs</span><strong>${escapeHtml(values(document.expectedArtifacts?.map((item) => item.title), "등록 없음"))}</strong></div><div><span>Runtime boundary</span><strong>${escapeHtml(`${document.runtimePolicy?.network || "deny"} network · ${document.runtimePolicy?.maxWallTimeMinutes || "-"} min`)}</strong></div></footer></section>`;
  }

  // Approving or rejecting a hypothesis is reserved for a person: the agent-visible tool refuses
  // those states and only the Main-owned decide channel writes them. That refusal is correct, and
  // it is also why the surface has to exist -- without it the study reaches the hypothesis gate,
  // stops, and the refusal is the only thing the researcher ever sees. Unstyled on purpose; the
  // Science UI session owns the visual treatment.
  async function loadHypotheses(projectId) {
    try {
      const rows = await science.hypotheses.list(projectId);
      if (projectId !== state.selectedId) return;
      state.hypotheses = Array.isArray(rows) ? rows : [];
      state.hypothesesError = "";
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.hypotheses = [];
      state.hypothesesError = String(error?.message ?? error);
    }
    render();
  }

  // The decision carries the version and hash the researcher was looking at. If the hypothesis
  // moved while they read it the store refuses, and refusing is right: an approval has to be an
  // approval of what was on screen.
  async function decideHypothesis(dataset) {
    const projectId = state.selectedId;
    if (!projectId || !dataset.hypothesisId) return;
    try {
      await science.hypotheses.decide({
        requestId: crypto.randomUUID(),
        projectId,
        hypothesisId: dataset.hypothesisId,
        decision: dataset.decision,
        expectedVersion: Number(dataset.hypothesisVersion),
        expectedContentSha256: dataset.hypothesisSha,
      });
      state.hypothesesError = "";
    } catch (error) {
      state.hypothesesError = `가설 결정을 저장하지 못했습니다. 최신 상태를 다시 확인해 주세요. (${String(error?.message ?? error)})`;
    }
    await loadHypotheses(projectId);
  }

  function hypothesesView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const rows = Array.isArray(state.hypotheses) ? state.hypotheses : [];
    const body = rows.length === 0
      ? `<div class="emptyCopy pageEmpty"><strong>아직 기록된 가설이 없습니다.</strong><p>연구가 가설을 제안하면 여기에서 승인하거나 기각할 수 있습니다.</p></div>`
      : rows.map((hypothesis) => {
        const decided = hypothesis.status === "approved" || hypothesis.status === "rejected";
        // The decision carries the exact version and content hash it was shown against, so a
        // hypothesis that changed while the researcher was reading it cannot be approved blind.
        const stamp = `data-hypothesis-id="${escapeHtml(hypothesis.id)}" data-hypothesis-version="${escapeHtml(String(hypothesis.currentVersion ?? hypothesis.version ?? 1))}" data-hypothesis-sha="${escapeHtml(hypothesis.version?.contentSha256 ?? hypothesis.contentSha256 ?? "")}"`;
        return `<article class="hypothesisCard" data-hypothesis-status="${escapeHtml(hypothesis.status ?? "proposed")}">
          <header><strong>${escapeHtml(hypothesis.role ?? "hypothesis")}</strong> · <span>${escapeHtml(hypothesis.status ?? "proposed")}</span></header>
          <p class="hypothesisStatement">${escapeHtml(hypothesis.statement ?? "")}</p>
          ${hypothesis.rationale ? `<p class="hypothesisRationale">${escapeHtml(hypothesis.rationale)}</p>` : ""}
          ${Array.isArray(hypothesis.falsificationCriteria) && hypothesis.falsificationCriteria.length
            ? `<ul class="hypothesisFalsification">${hypothesis.falsificationCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
            : ""}
          ${decided ? "" : `<div class="hypothesisDecision">
            <button data-action="decide-hypothesis" data-decision="approved" ${stamp}>승인</button>
            <button data-action="decide-hypothesis" data-decision="rejected" ${stamp}>기각</button>
          </div>`}
        </article>`;
      }).join("");
    // How many are waiting on this person, said before the cards. Approving or rejecting is
    // human-only, so a study stops here until someone acts -- and "three cards, some already
    // decided" is not something a reader should have to work out by counting.
    const pending = rows.filter((item) => item && item.status !== "approved" && item.status !== "rejected").length;
    const waitingNotice = pending
      ? `<div class="researcherWaiting" role="status" data-pending-decisions="${escapeHtml(String(pending))}"><span class="stateGlyph" data-state="awaiting-human" aria-hidden="true"></span><strong>${escapeHtml(String(pending))}건이 당신의 결정을 기다립니다.</strong><p>연구는 이 결정 없이 다음 단계로 가지 않습니다. 승인하거나 기각해 주세요.</p></div>`
      : "";
    return `<section class="researchView hypothesesView" data-research-destination="hypotheses" data-waiting-on="${pending ? "researcher" : "none"}"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>가설</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      ${state.hypothesesError ? `<div class="errorCopy">${escapeHtml(state.hypothesesError)}</div>` : ""}
      ${waitingNotice}
      ${body}
    </div></section>`;
  }

  // Literature & Prior Evidence. A source row is not a citable source: what decides whether a
  // claim may rest on it is how much of the paper was actually acquired. `sourceScope()` in
  // electron/science/evidence-graph.ts is the authority -- `parsed` describes byte availability,
  // not coverage, so an abstract promoted into immutable bytes is still abstract-only. The same
  // rule is repeated here because the researcher has to see it before they cite, not after.
  const literatureAccessLabels = {
    "metadata-only": "서지정보만 있음",
    retrieved: "원문 바이트 수신됨",
    parsed: "본문 파싱됨",
    "evidence-linked": "근거 구간까지 연결됨",
  };
  const literatureVerificationLabels = {
    unverified: "미검증",
    "metadata-checked": "서지정보 확인됨",
    "content-checked": "본문 대조 완료",
    retracted: "철회된 출처",
  };
  const literatureTextScope = (version) => {
    if (!version) return "metadata";
    if (typeof version.retrievalMethod === "string" && version.retrievalMethod.startsWith("agentlas.abstract-promotion/v1:")) return "abstract";
    if (version.accessState === "parsed" || version.accessState === "evidence-linked") return "full-text";
    if (version.accessState === "retrieved") return "abstract";
    return "metadata";
  };
  const literatureScopeLabels = { "full-text": "본문 확보", abstract: "초록만 확보", metadata: "서지정보만 확보" };
  // The span's own scope is recorded separately from the source's: a span cut before the body was
  // acquired stays abstract-scoped even after the body arrives.
  const literatureSpanScopeLabels = {
    "full-text": "본문에서 잘라낸 구간", abstract: "초록에서 잘라낸 구간", metadata: "서지정보에서 잘라낸 구간",
    computed: "계산 결과에서 나온 구간", human: "연구자가 직접 넣은 구간", system: "시스템이 기록한 구간",
  };
  const literatureShortHash = (value) => (value ? `${String(value).slice(0, 12)}…` : "기록된 내용 해시 없음");
  // Evidence spans live in the stored Evidence Graph revision, which the project load already
  // fetched. An evidence-span node is bound to the exact source version it was cut from by a
  // `derived-from` edge, so a span is never shown under a source it did not come from.
  function literatureSpansBySourceVersion() {
    const graph = state.evidenceGraph;
    const spans = new Map();
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return spans;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      if (edge?.kind !== "derived-from") continue;
      const from = nodeById.get(edge.fromNodeId);
      const to = nodeById.get(edge.toNodeId);
      if (from?.kind !== "evidence-span" || to?.kind !== "source-version") continue;
      const sourceVersionId = to.canonicalRef?.id;
      const spanId = from.canonicalRef?.id || from.id;
      if (!sourceVersionId || !spanId) continue;
      const bucket = spans.get(sourceVersionId) || [];
      if (bucket.some((item) => item.id === spanId)) continue;
      bucket.push({
        id: spanId,
        locator: from.label || "",
        excerpt: from.statement || "",
        scope: from.evidenceScope || "",
        status: from.epistemicStatus || "",
        contentSha256: from.canonicalRef?.contentSha256 || "",
      });
      spans.set(sourceVersionId, bucket);
    }
    return spans;
  }

  async function loadLiterature(projectId) {
    if (!projectId) return;
    state.literatureLoading = true;
    render();
    try {
      const listed = await science.sources.list(projectId);
      if (projectId !== state.selectedId) return;
      const rows = Array.isArray(listed) ? listed : [];
      // The list row is a projection; the project-scoped single-source read is what proves the
      // source still belongs to this project at its current version. A row that no longer
      // resolves is shown as unresolved rather than quietly rendered as citable.
      const exact = await Promise.all(rows.map((row) => science.sources.get(projectId, row.id).catch(() => null)));
      if (projectId !== state.selectedId) return;
      state.literatureSources = rows.map((row, index) => exact[index] || row);
      state.literatureUnresolvedIds = rows.filter((row, index) => !exact[index]).map((row) => row.id);
      state.literatureError = "";
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.literatureSources = [];
      state.literatureUnresolvedIds = [];
      state.literatureError = `출처 기록을 불러오지 못했습니다. (${String(error?.message ?? error)})`;
    } finally {
      if (projectId === state.selectedId) state.literatureLoading = false;
    }
    render();
  }

  function literatureSourceCard(source, spansBySourceVersion, unresolved) {
    const version = source.version || null;
    const scope = literatureTextScope(version);
    const spans = version?.id ? spansBySourceVersion.get(version.id) || [] : [];
    const retracted = source.verificationStatus === "retracted";
    const spanBody = spans.length === 0
      ? `<div class="literatureSpanEmpty"><strong>승격된 근거 구간이 없습니다.</strong><p>이 출처의 문장이 주장을 받치려면 먼저 근거 구간으로 인용되어 Evidence Graph에 기록되어야 합니다. ${state.evidenceGraph ? "연구 채팅에서 이 출처를 인용하면 여기에 나타납니다." : "해석·결정 화면에서 Evidence Graph를 먼저 만들면 이미 인용된 구간도 여기에 나타납니다."}</p></div>`
      : `<ul class="literatureSpanList">${spans.map((span) => `<li class="literatureSpan" data-evidence-span-id="${escapeHtml(span.id)}" data-evidence-scope="${escapeHtml(span.scope)}" data-evidence-status="${escapeHtml(span.status)}">
          <div class="literatureSpanMeta"><code>${escapeHtml(span.locator || "위치 표기 없음")}</code><span>${escapeHtml(literatureSpanScopeLabels[span.scope] || "구간 범위가 기록되지 않음")}</span>${span.status === "invalidated" ? `<em>무효화됨</em>` : ""}<code title="${escapeHtml(span.contentSha256)}">${escapeHtml(literatureShortHash(span.contentSha256))}</code></div>
          <blockquote class="literatureSpanExcerpt">${escapeHtml(span.excerpt || "발췌 본문이 기록되지 않았습니다.")}</blockquote>
        </li>`).join("")}</ul>`;
    return `<article class="literatureSource" data-source-id="${escapeHtml(source.id)}" data-access-state="${escapeHtml(version?.accessState || "unknown")}" data-text-scope="${escapeHtml(scope)}" data-verification-status="${escapeHtml(source.verificationStatus || "unverified")}">
      <header class="literatureSourceHeader">
        <strong>${escapeHtml(source.title || "제목이 기록되지 않은 출처")}</strong>
        <span class="literatureSourceKind">${escapeHtml(source.kind || "kind 미기록")}${source.publicationYear ? ` · ${escapeHtml(source.publicationYear)}` : ""}${source.containerTitle ? ` · ${escapeHtml(source.containerTitle)}` : ""}</span>
      </header>
      <p class="literatureSourceUri"><code>${escapeHtml(source.canonicalUri || "정규 URI가 기록되지 않았습니다.")}</code></p>
      <dl class="literatureSourceFacts">
        <div><dt>확보 상태</dt><dd>${escapeHtml(literatureAccessLabels[version?.accessState] || version?.accessState || "기록 없음")}</dd></div>
        <div><dt>본문 범위</dt><dd>${escapeHtml(literatureScopeLabels[scope])}</dd></div>
        <div><dt>검증</dt><dd>${escapeHtml(literatureVerificationLabels[source.verificationStatus] || source.verificationStatus || "기록 없음")}</dd></div>
        <div><dt>내용 해시</dt><dd><code title="${escapeHtml(version?.contentSha256 || "")}">${escapeHtml(literatureShortHash(version?.contentSha256))}</code></dd></div>
      </dl>
      ${unresolved ? `<p class="literatureSourceUnresolved" role="alert">이 출처는 프로젝트 기록에서 다시 조회되지 않았습니다. 인용하기 전에 출처가 아직 이 프로젝트에 남아 있는지 확인하세요.</p>` : ""}
      ${retracted ? `<p class="literatureSourceRetracted" role="alert">철회된 출처입니다. 이 출처에 기댄 주장은 다시 세워야 합니다.</p>` : ""}
      ${scope === "full-text" ? "" : `<p class="literatureAbstractOnly" role="note">${scope === "abstract"
        ? "초록만 확보된 출처입니다. 초록은 논문 본문 주장을 뒷받침할 수 없습니다 — 본문을 확보하기 전에는 본문 근거로 인용하지 마세요."
        : "서지정보만 있는 출처입니다. 아직 읽은 본문이 없으므로 어떤 주장도 이 출처에 기댈 수 없습니다."}</p>`}
      <section class="literatureSpans"><h3>근거 구간 ${escapeHtml(spans.length)}개</h3>${spanBody}</section>
    </article>`;
  }

  function literatureView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const sources = Array.isArray(state.literatureSources) ? state.literatureSources : [];
    const unresolved = new Set(Array.isArray(state.literatureUnresolvedIds) ? state.literatureUnresolvedIds : []);
    const spansBySourceVersion = literatureSpansBySourceVersion();
    const body = state.literatureLoading && sources.length === 0
      ? `<div class="loadingState" aria-live="polite">출처 기록을 불러오는 중…</div>`
      : sources.length === 0
        ? `<div class="emptyCopy pageEmpty"><strong>아직 이 연구에 등록된 출처가 없습니다.</strong><p>연구 채팅에서 문헌 검색을 실행하거나 DOI·URL을 알려주면, 정규화된 출처와 확보된 원문 바이트가 여기에 쌓입니다.</p></div>`
        : sources.map((source) => literatureSourceCard(source, spansBySourceVersion, unresolved.has(source.id))).join("");
    return `<section class="researchView literatureView" data-research-destination="literature"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>문헌·선행근거</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      <p class="literatureBoundary">출처가 목록에 있다는 것과 그 출처로 인용할 수 있다는 것은 다릅니다. 확보 범위와 근거 구간을 확인한 뒤 인용하세요.</p>
      ${state.literatureError ? `<div class="errorCopy" role="alert">${escapeHtml(state.literatureError)}</div>` : ""}
      ${body}
    </div></section>`;
  }

  // Acquisition. A study stalls on a fetch that failed quietly, so a failed run's recorded
  // failure summary is shown as the loudest thing on the card rather than folded away, and every
  // output keeps the byte size and hash the bytes were committed under.
  const acquisitionStatusLabels = { running: "실행 중", succeeded: "성공", failed: "실패", cancelled: "취소됨" };
  const acquisitionTimestamp = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(state.locale === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const acquisitionBytes = (value) => (Number.isFinite(Number(value)) ? `${Number(value).toLocaleString()} bytes` : "크기 미기록");
  const acquisitionShortHash = (value) => (value ? `${String(value).slice(0, 12)}…` : "해시 미기록");

  async function loadAcquisition(projectId) {
    if (!projectId) return;
    state.acquisitionLoading = true;
    render();
    try {
      const listed = await science.runs.list(projectId);
      if (projectId !== state.selectedId) return;
      const rows = Array.isArray(listed) ? listed : [];
      // Re-read each run through the project-scoped single-run channel: the roster row and the
      // authoritative record must agree before a researcher treats a fetch as complete.
      const exact = await Promise.all(rows.map((row) => science.runs.get(projectId, row.id).catch(() => null)));
      if (projectId !== state.selectedId) return;
      state.acquisitionRuns = rows.map((row, index) => exact[index] || row);
      state.acquisitionUnresolvedIds = rows.filter((row, index) => !exact[index]).map((row) => row.id);
      state.acquisitionError = "";
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.acquisitionRuns = [];
      state.acquisitionUnresolvedIds = [];
      state.acquisitionError = `수집 실행 기록을 불러오지 못했습니다. (${String(error?.message ?? error)})`;
    } finally {
      if (projectId === state.selectedId) state.acquisitionLoading = false;
    }
    render();
  }

  function acquisitionRunCard(run, unresolved) {
    const outputs = Array.isArray(run.outputs) ? run.outputs : [];
    const failed = run.status === "failed" || run.status === "cancelled";
    const outputBody = outputs.length === 0
      ? `<div class="acquisitionOutputEmpty"><strong>저장된 산출물이 없습니다.</strong><p>${run.status === "running"
          ? "실행이 아직 끝나지 않았습니다. 끝나면 내려받은 바이트와 그 해시가 여기에 기록됩니다."
          : failed
            ? "실행이 끝나기 전에 중단되어 검증할 바이트가 남지 않았습니다."
            : "이 실행은 성공으로 기록됐지만 바이트를 하나도 남기지 않았습니다. 산출물이 있어야 할 실행이라면 도구 쪽을 확인하세요."}</p></div>`
      : `<ul class="acquisitionOutputList">${outputs.map((output) => `<li class="acquisitionOutput" data-output-role="${escapeHtml(output.role || "")}">
          <div class="acquisitionOutputMeta"><strong>${escapeHtml(output.role || "역할 미기록")}</strong><span>${escapeHtml(output.mimeType || "형식 미기록")}</span><span>${escapeHtml(acquisitionBytes(output.byteSize))}</span></div>
          <code title="${escapeHtml(output.sha256 || "")}">${escapeHtml(acquisitionShortHash(output.sha256))}</code>
          ${output.artifactId ? `<span class="acquisitionOutputArtifact">아티팩트 ${escapeHtml(output.artifactId)} v${escapeHtml(output.artifactVersion)}</span>` : ""}
        </li>`).join("")}</ul>`;
    return `<article class="acquisitionRun" data-run-id="${escapeHtml(run.id)}" data-run-status="${escapeHtml(run.status || "unknown")}">
      <header class="acquisitionRunHeader">
        <strong>${escapeHtml(run.toolId || "도구 미기록")}</strong>
        <span class="acquisitionRunTool">v${escapeHtml(run.toolVersion || "—")} · ${escapeHtml(run.runtime || "runtime 미기록")}</span>
        <em class="acquisitionRunStatus">${escapeHtml(acquisitionStatusLabels[run.status] || run.status || "상태 미기록")}</em>
      </header>
      <dl class="acquisitionRunFacts">
        <div><dt>시작</dt><dd>${run.startedAt ? `<time datetime="${escapeHtml(run.startedAt)}">${escapeHtml(acquisitionTimestamp(run.startedAt))}</time>` : "기록 없음"}</dd></div>
        <div><dt>종료</dt><dd>${run.finishedAt ? `<time datetime="${escapeHtml(run.finishedAt)}">${escapeHtml(acquisitionTimestamp(run.finishedAt))}</time>` : run.status === "running" ? "아직 실행 중" : "기록 없음"}</dd></div>
        <div><dt>입력 매니페스트</dt><dd><code title="${escapeHtml(run.inputManifestSha256 || "")}">${escapeHtml(acquisitionShortHash(run.inputManifestSha256))}</code></dd></div>
        <div><dt>산출 매니페스트</dt><dd><code title="${escapeHtml(run.outputManifestSha256 || "")}">${escapeHtml(acquisitionShortHash(run.outputManifestSha256))}</code></dd></div>
      </dl>
      ${unresolved ? `<p class="acquisitionRunUnresolved" role="alert">이 실행은 프로젝트 기록에서 다시 조회되지 않았습니다. 결과를 쓰기 전에 실행이 아직 남아 있는지 확인하세요.</p>` : ""}
      ${failed ? `<p class="acquisitionRunFailure" role="alert"><strong>${escapeHtml(run.status === "cancelled" ? "이 수집은 취소됐습니다." : "이 수집은 실패했습니다.")}</strong> ${escapeHtml(run.summary || "실패 원인이 기록되지 않았습니다. 이 실행에서는 원인을 알 수 없으므로 다시 실행해 확인해야 합니다.")}</p>`
        : run.summary ? `<p class="acquisitionRunSummary">${escapeHtml(run.summary)}</p>` : ""}
      <section class="acquisitionOutputs"><h3>산출물 ${escapeHtml(outputs.length)}개</h3>${outputBody}</section>
    </article>`;
  }

  function acquisitionView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const runs = Array.isArray(state.acquisitionRuns) ? state.acquisitionRuns : [];
    const unresolved = new Set(Array.isArray(state.acquisitionUnresolvedIds) ? state.acquisitionUnresolvedIds : []);
    const failedCount = runs.filter((run) => run.status === "failed").length;
    const body = state.acquisitionLoading && runs.length === 0
      ? `<div class="loadingState" aria-live="polite">수집 실행 기록을 불러오는 중…</div>`
      : runs.length === 0
        ? `<div class="emptyCopy pageEmpty"><strong>아직 이 연구가 가져온 데이터가 없습니다.</strong><p>연구 채팅에서 검색·수집 도구를 실행하면, 어떤 도구가 어디에서 무엇을 가져왔는지와 그 바이트의 크기·해시가 실행 단위로 여기에 기록됩니다.</p></div>`
        : runs.map((run) => acquisitionRunCard(run, unresolved.has(run.id))).join("");
    return `<section class="researchView acquisitionView" data-research-destination="acquisition"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>데이터 수집</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      <p class="acquisitionBoundary">${runs.length ? `실행 ${escapeHtml(runs.length)}건${failedCount ? ` · 실패 ${escapeHtml(failedCount)}건` : ""} · 실패한 수집은 조용히 넘어가지 않습니다.` : "실행 기록만 표시합니다. 기록되지 않은 수집은 일어나지 않은 것으로 취급합니다."}</p>
      ${state.acquisitionError ? `<div class="errorCopy" role="alert">${escapeHtml(state.acquisitionError)}</div>` : ""}
      ${body}
    </div></section>`;
  }

  // Scope, Logbook and Submission & Archive each read the study's own committed record rather than
  // the message stream. They load on arrival, not on project open, because the record keeps moving
  // while a study runs, and each one drops its answer if the researcher switched project mid-read.
  const studyRecordShortHash = (value) => value ? `${String(value).slice(0, 12)}…` : "—";
  const studyRecordStamp = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(state.locale === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };

  async function loadScope(projectId) {
    if (!projectId) return;
    state.scopeLoading = true;
    try {
      const [scopeProject, contract] = await Promise.all([
        science.projects.get(projectId),
        science.researchContracts.get(projectId),
      ]);
      if (projectId !== state.selectedId) return;
      state.scopeProject = scopeProject || null;
      state.scopeContract = contract || null;
      state.scopeError = "";
      // Keep the approval sheet reading the same contract Scope shows, but never pop it open on
      // arrival: the researcher opens it from the button below.
      applyResearchContractSnapshot(scopeProject, contract, { openDraft: false });
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.scopeProject = null;
      state.scopeContract = null;
      state.scopeError = `연구 계약을 불러오지 못했습니다. (${String(error?.message ?? error)})`;
    } finally {
      if (projectId === state.selectedId) state.scopeLoading = false;
      render();
    }
  }

  function scopeView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const contract = state.scopeContract && state.scopeContract.projectId === state.selectedId ? state.scopeContract : null;
    const scopeProject = state.scopeProject && state.scopeProject.id === state.selectedId ? state.scopeProject : project;
    const criteria = (items, empty) => Array.isArray(items) && items.length
      ? `<ul class="scopeList">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : `<p class="scopeEmpty">${escapeHtml(empty)}</p>`;
    const body = contract
      ? `<div class="scopeContract" data-contract-id="${escapeHtml(contract.id)}" data-contract-version="${escapeHtml(contract.version)}" data-contract-status="${escapeHtml(contract.status)}">
        <section class="scopeObjective"><h2>연구 목표</h2><p>${escapeHtml(contract.objective)}</p></section>
        <section class="scopeCriteria scopeSuccess"><h2>성공 기준</h2>${criteria(contract.successCriteria, "등록된 성공 기준이 없습니다. 연구 채팅에서 계약을 수정 요청하면 추가됩니다.")}</section>
        <section class="scopeCriteria scopeFailure"><h2>중단 기준</h2>${criteria(contract.failureCriteria, "등록된 중단 기준이 없습니다. 중단 조건이 없으면 연구는 스스로 멈추지 않습니다.")}</section>
        <section class="scopeCriteria scopeConstraints"><h2>운영 제약</h2>${criteria(contract.constraints, "추가 운영 제약이 없습니다.")}</section>
        <section class="scopeBudget"><h2>예산</h2><dl>
          <div><dt>최대 에피소드</dt><dd>${escapeHtml(contract.maxEpisodes)}</dd></div>
          <div><dt>최대 실행 시간</dt><dd>${escapeHtml(contract.maxWallTimeMinutes)}분</dd></div>
        </dl></section>
        <section class="scopeStatus"><h2>상태</h2><dl>
          <div><dt>계약 상태</dt><dd>${escapeHtml(contract.status)}</dd></div>
          <div><dt>계약 버전</dt><dd>v${escapeHtml(contract.version)}</dd></div>
          <div><dt>프로젝트 버전</dt><dd>v${escapeHtml(scopeProject?.version ?? "—")}</dd></div>
          <div><dt>승인 시각</dt><dd>${escapeHtml(contract.approvedAt ? studyRecordStamp(contract.approvedAt) : "아직 승인되지 않았습니다")}</dd></div>
        </dl></section>
        ${contract.status === "draft"
          ? `<div class="scopeApproval"><p>이 계약은 아직 사람의 승인을 기다리는 초안입니다. 승인하면 이 목표와 중단 기준으로 연구가 시작됩니다.</p><button class="primaryButton" data-action="open-research-contract-sheet">계약 v${escapeHtml(contract.version)} 검토·승인</button></div>`
          : ""}
      </div>`
      : `<div class="emptyCopy"><strong>아직 연구 계약이 없습니다.</strong><p>연구 채팅에서 첫 질문을 보내면 목표와 중단 기준을 담은 계약 초안이 만들어지고, 여기에서 승인할 수 있습니다.</p></div>`;
    return `<section class="researchView scopeView" data-research-destination="scope"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>범위</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      ${(() => { const q = scopeProject?.question ?? project.question ?? ""; return q && q.trim() !== String(project.title || "").trim() ? `<p class="scopeQuestion">${escapeHtml(q)}</p>` : ""; })()}
      ${state.scopeError ? `<div class="errorCopy" role="alert">${escapeHtml(state.scopeError)}</div>` : ""}
      ${state.scopeLoading && !contract ? `<div class="loadingState" aria-live="polite">연구 계약을 불러오는 중…</div>` : body}
      ${approvalPolicyPanel()}
    </div></section>`;
  }

  // How this project wants to be asked. Three lifecycle gates and the hypothesis decision would
  // otherwise stop a run four times; a standing grant lets them proceed and records who granted
  // it, so the trail is the same shape as a click. The submission attestation is listed separately
  // because it is a statement made in the researcher's name to a publisher.
  function approvalPolicyPanel() {
    const policy = state.approvalPolicy && state.approvalPolicy.projectId === state.selectedId ? state.approvalPolicy : null;
    if (!policy) return "";
    const scopeLabels = {
      "research-contract": "연구 계약 승인",
      hypothesis: "가설 승인·기각",
      "journal-identity": "저널 신원 확인",
      "submission-attestation": "제출 최종 확인 (연구자 이름으로 출판사에 나가는 진술)",
    };
    // Each row delegates a different decision. One shared sentence made four
    // checkboxes read as one switch, which is how a blanket grant gets clicked.
    const scopeGranted = {
      "research-contract": "목표와 중단 기준을 연구자 확인 없이 확정합니다",
      hypothesis: "제안된 가설을 스스로 채택하거나 기각합니다",
      "journal-identity": "투고할 저널의 요건을 스스로 확정합니다",
      "submission-attestation": "제출 진술을 연구자 확인 없이 확정합니다",
    };
    const scopeAsked = {
      "research-contract": "계약을 확정하기 전에 묻습니다",
      hypothesis: "가설을 채택·기각하기 전에 묻습니다",
      "journal-identity": "저널 요건을 확정하기 전에 묻습니다",
      "submission-attestation": "제출 진술을 확정하기 전에 묻습니다",
    };
    const rows = Object.entries(scopeLabels).map(([scope, label]) => {
      const standing = policy.mode === "autonomous" && policy.scopes.includes(scope);
      return `<li class="approvalScope" data-approval-scope="${escapeHtml(scope)}" data-approval-standing="${standing ? "yes" : "no"}">
        <label><input type="checkbox" data-action="toggle-approval-scope" data-scope="${escapeHtml(scope)}" ${standing ? "checked" : ""}>
        ${escapeHtml(label)}</label>
        ${standing ? "" : `<span class="approvalScopeBadge">기본에서 제외</span>`}
        <span class="approvalScopeState">${escapeHtml(standing ? scopeGranted[scope] : scopeAsked[scope])}</span>
      </li>`;
    }).join("");
    return `<section class="approvalPolicyPanel">
      <h2>승인 방식</h2>
      <p class="approvalPolicyNote">체크한 항목은 연구가 멈추지 않고 진행하며, 누가 언제 허용했는지는 그대로 기록됩니다. 해제하면 그 지점에서 묻습니다.</p>
      ${state.approvalPolicyError ? `<div class="errorCopy" role="alert">${escapeHtml(state.approvalPolicyError)}</div>` : ""}
      <ul class="approvalScopes">${rows}</ul>
      <p class="approvalPolicyProvenance">현재 정책 r${escapeHtml(String(policy.revision))} · ${escapeHtml(policy.grantedBy)}</p>
    </section>`;
  }

  async function loadApprovalPolicy(projectId) {
    if (!projectId) return;
    try {
      const policy = await science.approvalPolicy.get(projectId);
      if (projectId !== state.selectedId) return;
      state.approvalPolicy = policy;
      state.approvalPolicyError = "";
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.approvalPolicy = null;
      state.approvalPolicyError = String(error?.message ?? error);
    }
    render();
  }

  async function toggleApprovalScope(scope) {
    const projectId = state.selectedId;
    const policy = state.approvalPolicy;
    if (!projectId || !policy || !scope) return;
    const standing = policy.mode === "autonomous" && policy.scopes.includes(scope);
    const next = standing ? policy.scopes.filter((item) => item !== scope) : [...new Set([...policy.scopes, scope])];
    try {
      // Turning everything off is `checkpoint`: a mode, not an empty list, so the intent survives
      // a later scope being added to the product.
      await science.approvalPolicy.set({
        requestId: crypto.randomUUID(),
        projectId,
        mode: next.length ? "autonomous" : "checkpoint",
        scopes: next,
        grantedBy: "researcher",
      });
      state.approvalPolicyError = "";
    } catch (error) {
      state.approvalPolicyError = `승인 방식을 저장하지 못했습니다. (${String(error?.message ?? error)})`;
    }
    await loadApprovalPolicy(projectId);
  }

  async function loadLogbook(projectId) {
    if (!projectId) return;
    state.logbookLoading = true;
    try {
      // Main answers revisions only for the canonical study of this project, so the head read has
      // to come first: its studyId is the only one the channel accepts.
      const lifecycle = await science.researchLifecycle.get(projectId);
      if (projectId !== state.selectedId) return;
      state.lifecycle = lifecycle || state.lifecycle;
      const revisions = lifecycle?.studyId ? await science.researchLifecycle.revisions(projectId, lifecycle.studyId) : [];
      if (projectId !== state.selectedId) return;
      state.logbookRevisions = Array.isArray(revisions) ? revisions : [];
      state.logbookError = "";
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.logbookRevisions = [];
      state.logbookError = `연구 이력을 불러오지 못했습니다. (${String(error?.message ?? error)})`;
    } finally {
      if (projectId === state.selectedId) state.logbookLoading = false;
      render();
    }
  }

  // The gate code is the whole point of the row: it is the rule that authorized the study to move,
  // so it is printed verbatim instead of being translated into prose.
  function logbookAuthorization(revision) {
    const preconditions = revision?.preconditions || {};
    if (preconditions.kind === "phase_gate") return { code: preconditions.gateCode, evidence: preconditions.evidenceSha256 };
    if (preconditions.kind === "state_update") return { code: `state_update · ${preconditions.reason}`, evidence: preconditions.evidenceSha256 };
    if (preconditions.kind === "resume") return { code: `resume → ${preconditions.resumePhase}`, evidence: preconditions.resolutionSha256 };
    if (preconditions.kind === "initialize") return { code: "initialize", evidence: null };
    return { code: String(preconditions.kind || "unknown"), evidence: preconditions.evidenceSha256 ?? null };
  }

  function logbookView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const revisions = Array.isArray(state.logbookRevisions) ? [...state.logbookRevisions].sort((left, right) => left.revision - right.revision) : [];
    const body = revisions.length === 0
      ? `<div class="emptyCopy pageEmpty"><strong>아직 기록된 연구 이력이 없습니다.</strong><p>연구가 단계를 넘어가거나 상태가 바뀔 때마다 그 근거와 함께 여기에 한 줄씩 쌓입니다.</p></div>`
      : `<ol class="logbookRevisions">${revisions.map((revision) => {
        const authorization = logbookAuthorization(revision);
        return `<li class="logbookRevision" data-logbook-revision="${escapeHtml(revision.revision)}" data-logbook-phase="${escapeHtml(revision.phase)}">
          <span class="logbookRevisionNumber">r${escapeHtml(revision.revision)}</span>
          <span class="logbookRevisionPhase">${escapeHtml(lifecyclePhaseLabels[revision.phase] || revision.phase)}</span>
          <span class="logbookRevisionStatus">${escapeHtml(revision.status)}</span>
          <code class="logbookRevisionGate" title="${escapeHtml(authorization.code)}">${escapeHtml(authorization.code)}</code>
          <code class="logbookRevisionEvidence" title="${escapeHtml(authorization.evidence || "근거 해시 없음")}">${escapeHtml(studyRecordShortHash(authorization.evidence))}</code>
          <time class="logbookRevisionTime" datetime="${escapeHtml(revision.createdAt)}">${escapeHtml(studyRecordStamp(revision.createdAt))}</time>
          ${Array.isArray(revision.blockers) && revision.blockers.length ? `<span class="logbookRevisionBlockers">차단 ${escapeHtml(revision.blockers.length)}건</span>` : ""}
          ${Array.isArray(revision.openBlockingDecisions) && revision.openBlockingDecisions.length ? `<span class="logbookRevisionDecisions">대기 중인 결정 ${escapeHtml(revision.openBlockingDecisions.length)}건</span>` : ""}
        </li>`;
      }).join("")}</ol>`;
    return `<section class="researchView logbookView" data-research-destination="logbook"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>기록</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      <p class="logbookIntro">이 연구가 지나온 모든 단계를, 각 단계를 허가한 규칙과 그 근거 해시와 함께 순서대로 보여줍니다.</p>
      ${state.logbookError ? `<div class="errorCopy" role="alert">${escapeHtml(state.logbookError)}</div>` : ""}
      ${state.logbookLoading && revisions.length === 0 ? `<div class="loadingState" aria-live="polite">연구 이력을 불러오는 중…</div>` : body}
    </div></section>`;
  }

  async function loadSubmissionArchive(projectId) {
    if (!projectId) return;
    state.submissionArchiveLoading = true;
    try {
      const profiles = await science.journals.list(projectId);
      if (projectId !== state.selectedId) return;
      state.submissionArchiveProfiles = Array.isArray(profiles) ? profiles : [];
      // Exports belong to a manuscript, not to the project, so the archive is the union over every
      // manuscript this project has.
      const manuscripts = Array.isArray(state.manuscripts) ? state.manuscripts : [];
      const perManuscript = await Promise.all(manuscripts.map(async (manuscript) => {
        const exports = await science.submissions.list(projectId, manuscript.id);
        return (Array.isArray(exports) ? exports : []).map((item) => ({ ...item, manuscriptTitle: manuscript.title }));
      }));
      if (projectId !== state.selectedId) return;
      state.submissionArchiveExports = perManuscript.flat();
      state.submissionArchiveError = "";
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.submissionArchiveProfiles = [];
      state.submissionArchiveExports = [];
      state.submissionArchiveError = `저널 프로필과 제출본 기록을 불러오지 못했습니다. (${String(error?.message ?? error)})`;
    } finally {
      if (projectId === state.selectedId) state.submissionArchiveLoading = false;
      render();
    }
  }

  function submissionArchiveView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const profiles = Array.isArray(state.submissionArchiveProfiles) ? state.submissionArchiveProfiles : [];
    // An export that is not ready is the one a researcher has to see, so it is sorted to the top
    // instead of being left in date order where it can scroll away.
    const exports = [...(Array.isArray(state.submissionArchiveExports) ? state.submissionArchiveExports : [])]
      .sort((left, right) => (left.status === "ready" ? 1 : 0) - (right.status === "ready" ? 1 : 0)
        || String(right.createdAt).localeCompare(String(left.createdAt)));
    const blockedCount = exports.filter((item) => item.status !== "ready").length;
    const profileList = profiles.length === 0
      ? `<div class="emptyCopy"><strong>연결된 저널 프로필이 없습니다.</strong><p>공식 author-guideline 페이지를 검사해 인용 가능한 문구만 규칙으로 저장하면 여기에 프로필이 생깁니다.</p><button class="primaryButton" data-action="open-journal-sheet">저널 타깃 설정</button></div>`
      : `<ul class="submissionJournalProfiles">${profiles.map((profile) => `<li class="submissionJournalProfile" data-journal-profile-id="${escapeHtml(profile.id)}" data-journal-profile-status="${escapeHtml(profile.status)}">
        <strong>${escapeHtml(profile.journalName)}</strong>
        <span>${escapeHtml(profile.articleType)} · v${escapeHtml(profile.currentVersion)} · ${escapeHtml(profile.status)}</span>
        <span>규칙 ${escapeHtml(profile.version?.rules?.length ?? 0)}개 · 공식 출처 ${escapeHtml(profile.version?.sources?.length ?? 0)}건</span>
        <code title="${escapeHtml(profile.version?.contentSha256 || "")}">${escapeHtml(studyRecordShortHash(profile.version?.contentSha256))}</code>
      </li>`).join("")}</ul>`;
    const exportList = exports.length === 0
      ? `<div class="emptyCopy"><strong>아직 만들어진 제출본이 없습니다.</strong><p>원고 버전과 저널 프로필이 모두 고정되고 claim gate가 닫히면, 검증된 제출 패키지를 만들 수 있고 그 기록이 여기 남습니다.</p></div>`
      : `<ul class="submissionExports">${exports.map((item) => `<li class="submissionExport" data-submission-export-id="${escapeHtml(item.id)}" data-submission-export-status="${escapeHtml(item.status)}">
        <strong>${escapeHtml(item.fileName || "패키지 파일 없음")}</strong>
        <span class="submissionExportStatus">${escapeHtml(item.status)}</span>
        <span>${escapeHtml(item.manuscriptTitle || "원고")} v${escapeHtml(item.manuscriptVersion)}</span>
        <code title="${escapeHtml(item.packageSha256 || "패키지 해시 없음")}">${escapeHtml(studyRecordShortHash(item.packageSha256))}</code>
        <time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(studyRecordStamp(item.createdAt))}</time>
        ${item.status === "ready" && item.packageRef ? `<button class="secondaryButton" data-action="download-submission" data-export-id="${escapeHtml(item.id)}">내려받기</button>` : `<em class="submissionExportBlocked">이 제출본은 아직 완성되지 않았습니다. 검증 결과를 확인하세요.</em>`}
      </li>`).join("")}</ul>`;
    return `<section class="researchView submissionArchiveView" data-research-destination="submission-archive"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>제출·보관</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      ${state.submissionArchiveError ? `<div class="errorCopy" role="alert">${escapeHtml(state.submissionArchiveError)}</div>` : ""}
      ${blockedCount ? `<div class="submissionArchiveWarning" role="status"><strong>완성되지 않은 제출본 ${escapeHtml(blockedCount)}건</strong><span>아래 목록 맨 위에 있습니다.</span></div>` : ""}
      <section class="submissionArchiveSection"><h2>저널 프로필</h2>${state.submissionArchiveLoading && profiles.length === 0 ? `<div class="loadingState" aria-live="polite">저널 프로필을 불러오는 중…</div>` : profileList}</section>
      <section class="submissionArchiveSection"><h2>제출본</h2>${state.submissionArchiveLoading && exports.length === 0 ? `<div class="loadingState" aria-live="polite">제출본 기록을 불러오는 중…</div>` : exportList}</section>
    </div></section>`;
  }

  // Analysis & Runs answers what a reviewer asks first: which analyses actually ran, under which
  // frozen plan, and whether the result on screen is still the exact thing that run computed. A run
  // recorded as succeeded that bound no artifact is the failure worth showing, because nothing else
  // in the product ever says it out loud. Unstyled on purpose; the Science UI session owns styling.
  const ANALYSIS_RUN_EXACT_RECHECK_LIMIT = 20;
  const RESULTS_VALIDATION_LOOKUP_LIMIT = 60;
  const runResultShortHash = (value) => (value ? `${String(value).slice(0, 12)}…` : "—");
  const analysisRunStatusLabels = { running: "실행 중", succeeded: "성공", failed: "실패", cancelled: "취소됨" };
  const analysisRunBoundOutputs = (run) => (Array.isArray(run?.outputs) ? run.outputs : []).filter((output) => output?.artifactId);
  const analysisRunSucceededWithoutArtifact = (run) => run?.status === "succeeded" && analysisRunBoundOutputs(run).length === 0;

  async function loadAnalysisRuns(projectId) {
    if (!projectId) return;
    try {
      const [runs, artifacts] = await Promise.all([science.runs.list(projectId), science.artifacts.list(projectId)]);
      if (projectId !== state.selectedId) return;
      const rows = Array.isArray(runs) ? runs : [];
      // The "succeeded but produced nothing" claim is re-read from the exact run record rather than
      // trusted from a list snapshot, so the accusation is against the store's current truth.
      const suspect = rows.filter(analysisRunSucceededWithoutArtifact).slice(0, ANALYSIS_RUN_EXACT_RECHECK_LIMIT);
      const exact = await Promise.all(suspect.map(async (run) => {
        try { return await science.runs.get(projectId, run.id); } catch { return null; }
      }));
      if (projectId !== state.selectedId) return;
      const exactById = new Map(exact.filter((run) => run && run.id).map((run) => [run.id, run]));
      state.analysisRuns = rows.map((run) => exactById.get(run.id) || run);
      state.analysisRunArtifacts = Array.isArray(artifacts) ? artifacts : [];
      state.analysisRunsError = "";
      state.analysisRunsProjectId = projectId;
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.analysisRuns = [];
      state.analysisRunArtifacts = [];
      state.analysisRunsError = String(error?.message ?? error);
      state.analysisRunsProjectId = projectId;
    }
    render();
  }

  function analysisRunRow(run, artifactsById) {
    const status = String(run?.status ?? "running");
    const plan = run?.analysisPlan || null;
    const planSpec = plan ? analysisSpecById(plan.analysisSpecId) : null;
    const planLine = plan
      ? `${planSpec?.title || plan.analysisSpecId} · v${plan.version} · ${runResultShortHash(plan.contentSha256)}`
      : "고정된 분석계획 없음 — 이 실행은 사전 등록된 계획 아래에서 돌지 않았습니다.";
    const inputCount = (Array.isArray(run?.inputs) ? run.inputs : []).length;
    const outputs = analysisRunBoundOutputs(run);
    const outputRows = outputs.map((output) => {
      const artifact = artifactsById.get(output.artifactId) || null;
      const boundVersion = Number(output.artifactVersion);
      const binding = !artifact
        ? "이 프로젝트의 아티팩트 목록에 없습니다. 결과를 열 수 없습니다."
        : Number(artifact.currentVersion) === boundVersion
          ? "현재 버전이 이 실행이 계산한 그 버전입니다."
          : `아티팩트가 v${artifact.currentVersion}로 갱신됐습니다. 지금 열리는 결과는 이 실행이 계산한 버전이 아닙니다.`;
      return `<li class="analysisRunOutput" data-artifact-id="${escapeHtml(output.artifactId)}" data-artifact-version="${escapeHtml(boundVersion)}" data-output-current="${Boolean(artifact && Number(artifact.currentVersion) === boundVersion)}">
        <strong>${escapeHtml(artifact?.title || output.artifactId)}</strong>
        <span>${escapeHtml(artifact?.kind || output.mimeType || "unknown")} · v${escapeHtml(boundVersion)} · <code title="${escapeHtml(output.sha256)}">${escapeHtml(runResultShortHash(output.sha256))}</code></span>
        <em>${escapeHtml(binding)}</em>
      </li>`;
    }).join("");
    const unbound = analysisRunSucceededWithoutArtifact(run);
    return `<article class="analysisRun" data-run-id="${escapeHtml(run.id)}" data-run-status="${escapeHtml(status)}" data-run-unbound="${Boolean(unbound)}">
      <header>
        <strong>${escapeHtml(`${run.toolId ?? "unknown"} ${run.toolVersion ?? ""}`.trim())}</strong>
        <span>${escapeHtml(analysisRunStatusLabels[status] || status)} · ${escapeHtml(run.runtime ?? "unknown")}</span>
        <code title="${escapeHtml(run.id)}">${escapeHtml(runResultShortHash(run.id))}</code>
      </header>
      <dl class="analysisRunFacts">
        <div><dt>분석계획</dt><dd>${escapeHtml(planLine)}</dd></div>
        <div><dt>입력</dt><dd>${escapeHtml(`${inputCount}개 · 매니페스트 ${runResultShortHash(run.inputManifestSha256)}`)}</dd></div>
        <div><dt>출력 매니페스트</dt><dd>${escapeHtml(run.outputManifestSha256 ? runResultShortHash(run.outputManifestSha256) : "없음")}</dd></div>
        <div><dt>시작 · 종료</dt><dd>${escapeHtml(`${run.startedAt ?? "—"} · ${run.finishedAt || "진행 중"}`)}</dd></div>
      </dl>
      ${run.summary ? `<p class="analysisRunSummary">${escapeHtml(run.summary)}</p>` : ""}
      ${outputs.length
        ? `<ul class="analysisRunOutputs">${outputRows}</ul>`
        : `<p class="analysisRunNoOutput">이 실행에 묶인 아티팩트가 없습니다.</p>`}
      ${unbound ? `<p class="analysisRunUnbound" role="alert"><strong>성공으로 기록됐지만 결과물을 남기지 않았습니다.</strong><span>정확한 실행 기록을 다시 읽어 확인했습니다. 묶인 아티팩트가 없으므로 이 실행은 그림·표·해석 어디에도 연결할 수 없고, 성공으로 세어서도 안 됩니다. 다시 실행해야 합니다.</span></p>` : ""}
    </article>`;
  }

  function analysisRunsView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const loaded = state.analysisRunsProjectId === state.selectedId;
    const runs = loaded && Array.isArray(state.analysisRuns) ? state.analysisRuns : [];
    const artifactsById = new Map((Array.isArray(state.analysisRunArtifacts) ? state.analysisRunArtifacts : []).map((artifact) => [artifact.id, artifact]));
    const unboundCount = runs.filter(analysisRunSucceededWithoutArtifact).length;
    const body = !loaded
      ? `<div class="loadingState" aria-live="polite">실행 기록을 불러오는 중…</div>`
      : state.analysisRunsError
        ? ""
        : runs.length === 0
          ? `<div class="emptyCopy pageEmpty"><strong>아직 실행된 분석이 없습니다.</strong><p>Plan &amp; Protocols 에서 분석계획을 고정한 뒤 연구 채팅에서 실행을 요청하면, 어떤 계획 아래 무엇이 돌았고 무엇을 만들었는지가 여기에 기록됩니다.</p></div>`
          : runs.map((run) => analysisRunRow(run, artifactsById)).join("");
    return `<section class="researchView analysisRunsView" data-research-destination="analysis-runs"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>분석 실행</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      ${state.analysisRunsError ? `<div class="errorCopy" role="alert">${escapeHtml(`실행 기록을 불러오지 못했습니다. ${state.analysisRunsError}`)}</div>` : ""}
      ${loaded && runs.length ? `<div class="analysisRunsSummary"><span>총 ${escapeHtml(runs.length)}회</span><span>성공 ${escapeHtml(runs.filter((run) => run.status === "succeeded").length)}</span><span>실패·취소 ${escapeHtml(runs.filter((run) => run.status === "failed" || run.status === "cancelled").length)}</span><span data-alert="${unboundCount > 0}">결과 없는 성공 ${escapeHtml(unboundCount)}</span></div>` : ""}
      ${body}
    </div></section>`;
  }

  // Results & Figures is the manuscript's shopping list. A figure without a verified pixel capture
  // cannot be bound into a manuscript at all, so it is labelled as unusable rather than shown as a
  // ready result. Previews reuse the existing capture host, which calls science.artifacts.preview
  // and prints its own boundary when no capture exists -- never a stand-in image.
  const resultArtifactKindLabels = {
    "chart.vega": "차트", "chart.numeric-3d": "3D 수치 표면", "literature.citation-network": "인용 네트워크",
    "astronomy.sky-catalog": "천체 카탈로그", "genomics.variant-track": "변이 트랙", "phylogeny.radial": "계통수",
    "protein.structure": "단백질 구조", "chemistry.document": "화학 구조", table: "표", image: "게재용 래스터",
  };
  const resultReceiptWithStatus = (receipts, status) => (Array.isArray(receipts) ? receipts : []).find((receipt) => receipt?.status === status) || null;
  const resultIsPublicationReady = (artifactId) => Boolean(resultReceiptWithStatus(state.resultValidations.get(artifactId)?.receipts, "verified"));

  async function loadResults(projectId) {
    if (!projectId) return;
    try {
      const [artifacts, figures] = await Promise.all([
        science.artifacts.list(projectId),
        science.artifacts.listStatisticsFigures(projectId),
      ]);
      if (projectId !== state.selectedId) return;
      const rows = Array.isArray(artifacts) ? artifacts : [];
      const looked = await Promise.all(rows.slice(0, RESULTS_VALIDATION_LOOKUP_LIMIT).map(async (artifact) => {
        try { return { id: artifact.id, receipts: await science.validations.list(projectId, artifact.id, artifact.currentVersion), error: "" }; }
        catch (error) { return { id: artifact.id, receipts: [], error: String(error?.message ?? error) }; }
      }));
      if (projectId !== state.selectedId) return;
      const validations = new Map();
      for (const entry of looked) validations.set(entry.id, { receipts: Array.isArray(entry.receipts) ? entry.receipts : [], error: entry.error });
      state.resultArtifacts = rows;
      state.resultFigureIds = new Set((Array.isArray(figures) ? figures : []).map((figure) => figure?.id).filter(Boolean));
      state.resultValidations = validations;
      state.resultsError = "";
      state.resultsProjectId = projectId;
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.resultArtifacts = [];
      state.resultFigureIds = new Set();
      state.resultValidations = new Map();
      state.resultsError = String(error?.message ?? error);
      state.resultsProjectId = projectId;
    }
    render();
  }

  function resultArtifactRow(artifact) {
    const lookup = state.resultValidations.get(artifact.id) || null;
    const receipts = lookup?.receipts || [];
    const verified = resultReceiptWithStatus(receipts, "verified");
    const rejected = resultReceiptWithStatus(receipts, "rejected");
    const warned = resultReceiptWithStatus(receipts, "warning");
    const version = Number(artifact.currentVersion);
    const contentSha256 = artifact.version?.contentSha256 || "";
    const warningLine = (receipt) => [...(Array.isArray(receipt?.warnings) ? receipt.warnings : [])].join(" · ");
    const validation = !lookup
      ? `<p class="resultArtifactValidation" data-result-validation="unchecked"><strong>검증 상태를 확인하지 않았습니다.</strong><span>${escapeHtml(`한 번에 조회하는 상한 ${RESULTS_VALIDATION_LOOKUP_LIMIT}개를 넘은 아티팩트입니다. 검증이 없다는 뜻이 아니라 묻지 않았다는 뜻입니다.`)}</span></p>`
      : lookup.error
        ? `<p class="resultArtifactValidation" data-result-validation="error" role="alert"><strong>검증 기록을 읽지 못했습니다.</strong><span>${escapeHtml(lookup.error)}</span></p>`
        : verified
          ? `<p class="resultArtifactValidation" data-result-validation="verified"><strong>게재 검증됨 — 원고에 연결할 수 있습니다.</strong><span>${escapeHtml(`${verified.validatorId} ${verified.validatorVersion} · 정책 ${verified.policyId} ${verified.policyVersion} · 캡처 ${runResultShortHash(verified.visualAssetSha256)}`)}</span><code title="${escapeHtml(verified.receiptSha256)}">${escapeHtml(runResultShortHash(verified.receiptSha256))}</code></p>`
          : rejected
            ? `<p class="resultArtifactValidation" data-result-validation="rejected" role="alert"><strong>검증이 거부됐습니다 — 원고에 연결할 수 없습니다.</strong><span>${escapeHtml(warningLine(rejected) || "거부 사유가 영수증에 기록되지 않았습니다.")}</span></p>`
            : warned
              ? `<p class="resultArtifactValidation" data-result-validation="warning"><strong>경고와 함께 검증됐습니다 — 사람 검토 전에는 게재 준비된 결과가 아닙니다.</strong><span>${escapeHtml(warningLine(warned) || "경고 내용이 영수증에 기록되지 않았습니다.")}</span></p>`
              : `<p class="resultArtifactValidation" data-result-validation="none"><strong>원고에 연결할 수 없습니다.</strong><span>이 버전에는 검증된 시각 캡처가 없습니다. 정확한 픽셀 캡처와 검증 영수증이 남기 전까지 이 그림·표는 논문에 묶을 수 없습니다.</span></p>`;
    const preview = verified
      ? `<figure class="resultArtifactPreview" data-inline-capture-artifact="${escapeHtml(artifact.id)}" data-inline-capture-version="${escapeHtml(version)}" aria-label="${escapeHtml(`${artifact.title} v${version} 검증 캡처`)}">검증 캡처를 불러오는 중…</figure>`
      : `<p class="resultArtifactNoPreview">검증된 캡처가 없어 미리보기를 만들지 않았습니다.</p>`;
    return `<article class="resultArtifact" data-artifact-id="${escapeHtml(artifact.id)}" data-artifact-kind="${escapeHtml(artifact.kind)}" data-artifact-version="${escapeHtml(version)}" data-result-ready="${Boolean(verified)}">
      <header>
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(`${resultArtifactKindLabels[artifact.kind] || artifact.kind}${state.resultFigureIds.has(artifact.id) ? " · 통계 Figure" : ""}`)} · v${escapeHtml(version)}</span>
        <code title="${escapeHtml(contentSha256)}">${escapeHtml(runResultShortHash(contentSha256))}</code>
      </header>
      ${artifact.status === "failed" ? `<p class="resultArtifactFailed" role="alert">이 아티팩트는 failed 상태로 저장돼 있습니다. 내용을 신뢰할 수 없습니다.</p>` : ""}
      ${validation}
      ${preview}
    </article>`;
  }

  function resultsView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    const loaded = state.resultsProjectId === state.selectedId;
    const artifacts = loaded && Array.isArray(state.resultArtifacts) ? state.resultArtifacts : [];
    const readyCount = artifacts.filter((artifact) => resultIsPublicationReady(artifact.id)).length;
    const body = !loaded
      ? `<div class="loadingState" aria-live="polite">결과 아티팩트를 불러오는 중…</div>`
      : state.resultsError
        ? ""
        : artifacts.length === 0
          ? `<div class="emptyCopy pageEmpty"><strong>아직 논문에 넣을 그림·표가 없습니다.</strong><p>Analysis &amp; Runs 에서 분석을 실행하고 그 결과를 Figure Lab 에 저장하면, 각 그림·표가 게재 검증을 통과했는지와 함께 여기에 모입니다.</p></div>`
          : artifacts.map((artifact) => resultArtifactRow(artifact)).join("");
    return `<section class="researchView resultsView" data-research-destination="results"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · <span>결과와 그림</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      ${state.resultsError ? `<div class="errorCopy" role="alert">${escapeHtml(`결과 목록을 불러오지 못했습니다. ${state.resultsError}`)}</div>` : ""}
      ${loaded && artifacts.length ? `<div class="resultsSummary"><span>총 ${escapeHtml(artifacts.length)}개</span><span>게재 검증됨 ${escapeHtml(readyCount)}</span><span data-alert="${artifacts.length - readyCount > 0}">원고 연결 불가 ${escapeHtml(artifacts.length - readyCount)}</span></div>` : ""}
      ${body}
    </div></section>`;
  }

  // Empty state shows the shape of the answer that will land here, not an illustration:
  // three skeleton cards, the middle one sharp and the flanking two blurred back. It is
  // deliberately colourless — a coloured empty state reads as a warning, and "아직 없음"
  // is not a failure.
  // A refusal is a designed answer, not an error: it says the evidence does not exist
  // yet, or that the product will not draw something it cannot verify. It gets the same
  // structure everywhere — state glyph, one-line claim, the reason in body text.
  function refusalMarkup(state, title, detail, action) {
    return `<div class="rendererRefusal" data-state="${escapeHtml(state)}">`
      + `<span class="stateGlyph" data-state="${escapeHtml(state)}" aria-hidden="true"></span>`
      + `<strong>${escapeHtml(title)}</strong>`
      + (detail ? `<p>${escapeHtml(detail)}</p>` : "")
      + (action || "")
      + `</div>`;
  }

  // Three cards, middle one sharp: the shape of what will land here once a run
  // produces verified output. Colourless on purpose — an absence is not a warning.
  function skeletonRowMarkup() {
    const card = (rows) => `<div class="skeletonCard">${`<span class="skeletonBar isTitle"></span>`}${Array.from({ length: rows }, (_, i) => `<span class="skeletonBar${i === rows - 1 ? " isShort" : ""}"></span>`).join("")}<span class="skeletonChip"></span></div>`;
    return `<div class="skeletonRow" aria-hidden="true">${card(2)}${card(3)}${card(2)}</div>`;
  }

  function answerSkeleton() {
    const card = (rows) => `<div class="answerSkeletonCard">
      <span class="answerSkeletonTitle"></span>
      ${Array.from({ length: rows }, () => `<span class="answerSkeletonLine"></span>`).join("")}
      <span class="answerSkeletonCite"></span>
    </div>`;
    return `<div class="answerSkeleton" aria-hidden="true">${card(2)}${card(3)}${card(2)}</div>`;
  }

  function researchView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    if (state.currentDestination === "scope") return scopeView(project);
    if (state.currentDestination === "logbook") return logbookView(project);
    if (state.currentDestination === "submission-archive") return submissionArchiveView(project);
    if (state.currentDestination === "interpretation") return evidenceGraphView(project);
    if (state.currentDestination === "plan-protocols") return analysisPlanView(project);
    if (state.currentDestination === "hypotheses") return hypothesesView(project);
    if (state.currentDestination === "analysis-runs") return analysisRunsView(project);
    if (state.currentDestination === "results") return resultsView(project);
    if (state.currentDestination === "literature") return literatureView(project);
    if (state.currentDestination === "acquisition") return acquisitionView(project);
    const messages = state.messages.filter((message) => message.role !== "user").map(messageMarkup).join("");
    const assistantCount = state.messages.filter((message) => message.role === "assistant").length;
    const contractNotice = state.researchContract?.status === "draft"
      ? `<button class="researchContractNotice" data-action="open-research-contract-sheet"><span>${heroIcon("book")}<strong>연구 계약 초안 v${escapeHtml(state.researchContract.version)}</strong></span><em>사람의 승인 대기 · 목표와 중단 기준 확인 →</em></button>`
      : "";
    const destination = projectDestinationById(state.currentDestination);
    return `<section class="researchView" data-empty="${assistantCount === 0 && !messages ? "true" : "false"}" data-research-destination="${escapeHtml(destination.id)}"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabels[project.domain] || project.domain)}</span> · ${escapeHtml(destination.label)} · ${escapeHtml(lifecycleLabel())}</div>
      <h1>${escapeHtml(project.title)}</h1>
      ${contractNotice}
      ${runFailureNotice()}
      <div class="messageStream">${messages}</div>
      ${assistantCount === 0 ? `<div class="truthfulEmpty" data-waiting-on="${state.researchContract?.status === "draft" ? "researcher" : (state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status) ? "agent" : "none")}">${answerSkeleton()}${(() => {
        // "AI 가 일하는 중" 과 "당신이 결정해야 함" 은 사용자에게 완전히 다른 상태다.
        // 한 문장으로 둘을 덮으면 기다려야 하는지 움직여야 하는지 알 수 없다.
        //
        // 실행이 실패했을 때 "승인되면 나타납니다" 를 그대로 두면 위의 실패 안내와 모순된다 --
        // 위는 시작하지 못했다고 하는데 아래는 기다리면 된다고 읽힌다. 실패는 위가 설명하므로
        // 여기서는 되풀이하지 않고 결과가 없는 이유만 가리킨다.
        if (String(state.composerError || "").trim()) {
          return `<strong>아직 결과가 없습니다.</strong><p>이 실행은 시작되지 않았습니다. 위의 안내에 이유가 적혀 있습니다.</p>`;
        }
        if (state.researchContract?.status === "draft") {
          return `<strong><span class="stateGlyph" data-state="awaiting-human" aria-hidden="true"></span>이 연구는 아직 시작되지 않았습니다.</strong><p>연구 계약을 승인하면 시작됩니다. 위의 초안에서 목표와 중단 기준을 확인해 주세요.</p>`;
        }
        if (state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status)) {
          return `<strong><span class="stateGlyph" data-state="progress" aria-hidden="true"></span>연구 에이전트가 실행 중입니다.</strong><p>결과가 나오는 대로 답변 블록, 주장, 정확한 출처 인용이 이 기록에 추가됩니다.</p>`;
        }
        return `<strong>아직 생성된 연구 응답이 없습니다.</strong><p>첫 질문은 저장되었습니다. 연구 계약 승인과 Agent runtime 실행이 연결되면 답변 블록, 주장, 정확한 출처 인용이 이 기록에 추가됩니다.</p>`;
      })()}</div><div class="principledRefusal"><p>고정 답변이나 가짜 인용은 표시하지 않습니다.</p></div>` : ""}
    </div></section>`;
  }

  /**
   * Why a research run did not produce anything, written where the result would have gone.
   *
   * A turn that never starts is invisible today: the composer status carries a code like
   * `science-research-director-package-version-mismatch:installed=1.24.0:expected=1.16.0` and the
   * body still says "no research response yet", which reads as "nothing has happened" rather than
   * "this cannot start". A failure is a kind of result, so it belongs in the place a result goes.
   */
  function runFailureNotice() {
    const raw = String(state.composerError || "").trim();
    if (!raw) return "";
    const mismatch = /science-research-director-package-version-mismatch:installed=([^\s:]+):expected=([^\s:]+)/.exec(raw);
    if (mismatch) {
      return `<div class="failClosed" role="status"><strong>${heroIcon("book")}연구를 시작하지 못했습니다</strong><p>이 연구는 연구 총괄 <code>${escapeHtml(mismatch[2])}</code>을 요구하는데 이 컴퓨터에 설치된 판은 <code>${escapeHtml(mismatch[1])}</code>입니다. 판이 맞지 않으면 같은 입력에서 같은 결과가 나온다고 보장할 수 없어 실행을 시작하지 않았습니다.</p></div>`;
    }
    // 랩에 에이전트용 도구가 없어서 실행이 못 선 경우. 세 랩을 한 덩어리로 말하면 안 된다 --
  // 표·경제지표 랩에는 사람이 직접 시작할 길이 있고, 정말 막다른 곳은 유전체 변이 랩뿐이다.
  // 사유 형식: science-lab-has-no-agent-tools:lab=<slug>
  const noTools = /science-lab-has-no-agent-tools:lab=([\w-]+)/.exec(raw);
  if (noTools) {
    const lab = noTools[1];
    const selfStart = { "data-table": "CSV 데이터셋 가져오기", "economic-indicators": "CSV 데이터셋 가져오기" }[lab];
    if (selfStart) {
      return `<div class="failClosed" role="status"><strong>${heroIcon("book")}연구 에이전트가 이 Lab을 직접 실행하지는 못합니다</strong><p>대신 이 화면의 <strong>${escapeHtml(selfStart)}</strong>로 직접 시작할 수 있습니다. 그렇게 만든 결과도 같은 출처·run 기록을 갖습니다.</p></div>`;
    }
    return `<div class="failClosed" role="status"><strong>${heroIcon("book")}이 Lab은 아직 연구 에이전트가 쓸 수 있는 도구가 없습니다</strong><p>지금은 여기서 실행할 수 있는 것이 없습니다. 도구가 준비되면 이 자리에서 바로 실행할 수 있게 됩니다.</p></div>`;
  }
  if (/science-research-director-package-(identity-invalid|integrity-failed)|science-research-director-prompt-integrity-failed/.test(raw)) {
      return `<div class="failClosed" role="status"><strong>${heroIcon("book")}연구를 시작하지 못했습니다</strong><p>설치된 연구 총괄 패키지가 이 앱이 확인한 내용과 달라 실행을 시작하지 않았습니다. 확인되지 않은 패키지로 돌리면 결과의 출처를 보장할 수 없습니다.</p></div>`;
    }
    // Anything else: say that it did not start and show what came back, rather than swallowing it.
    return `<div class="failClosed" role="status"><strong>${heroIcon("book")}연구를 시작하지 못했습니다</strong><p>${escapeHtml(raw.slice(0, 400))}</p></div>`;
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

  async function loadManuscriptEditorWorkspace(projectId, manuscriptId) {
    const [editorModel, proposals, selectionContexts] = await Promise.all([
      science.manuscripts.editorModel(projectId, manuscriptId),
      science.manuscripts.editProposals(projectId, manuscriptId, 100),
      science.manuscripts.selectionContexts(projectId, manuscriptId, 100),
    ]);
    if (!editorModel?.manuscript || !editorModel?.document) throw new Error("science-manuscript-editor-model-not-found");
    const artifactTargets = editorModel.manuscript.version.bindings
      .filter((binding) => binding?.target?.kind === "artifact")
      .map((binding) => ({ role: binding.role, target: binding.target }));
    const artifactContexts = await Promise.all(artifactTargets.map(async ({ role, target }) => {
      try {
        const context = await science.artifacts.context(projectId, target.artifactId, target.artifactVersion);
        if (!context) return null;
        let previewUrl = null;
        if (role === "figure") {
          const preview = await science.artifacts.preview(projectId, target.artifactId, target.artifactVersion);
          if (preview?.contentSha256 === context.selectedVersion.contentSha256) previewUrl = URL.createObjectURL(new Blob([preview.bytes], { type: preview.mimeType || "image/png" }));
        }
        const lineage = target.validationReceiptId
          ? await science.validations.closure(projectId, target.validationReceiptId)
          : null;
        return [target.artifactId, context, previewUrl, lineage];
      } catch {
        return null;
      }
    }));
    const safeSelections = Array.isArray(selectionContexts) ? selectionContexts : [];
    const currentSelection = safeSelections.find((context) => context.manuscriptVersion === editorModel.manuscript.currentVersion
      && context.manuscriptContentSha256 === editorModel.manuscript.version.contentSha256
      && context.manuscriptDocumentSha256 === editorModel.document.documentSha256) || null;
    return {
      editorModel,
      proposals: Array.isArray(proposals) ? proposals : [],
      selectionContexts: safeSelections,
      selectionContext: currentSelection,
      artifactContexts: new Map(artifactContexts.filter(Boolean).map(([artifactId, context]) => [artifactId, context])),
      artifactLineages: new Map(artifactContexts.filter((item) => item?.[3]).map(([artifactId, , , lineage]) => [artifactId, lineage])),
      artifactPreviewUrls: new Map(artifactContexts.filter((item) => item?.[2]).map(([artifactId, , previewUrl]) => [artifactId, previewUrl])),
    };
  }

  function disposeManuscriptArtifactPreviews(urls = state.manuscriptArtifactPreviewUrls) {
    for (const url of urls?.values?.() || []) URL.revokeObjectURL(url);
    if (urls === state.manuscriptArtifactPreviewUrls) state.manuscriptArtifactPreviewUrls = new Map();
  }

  function applyManuscriptEditorWorkspace(snapshot) {
    disposeManuscriptArtifactPreviews();
    state.manuscriptEditorModel = snapshot.editorModel;
    state.manuscriptEditProposals = snapshot.proposals;
    state.manuscriptSelectionContexts = snapshot.selectionContexts;
    state.manuscriptSelectionContext = snapshot.selectionContext;
    state.manuscriptArtifactContexts = snapshot.artifactContexts;
    state.manuscriptArtifactLineages = snapshot.artifactLineages;
    state.manuscriptArtifactPreviewUrls = snapshot.artifactPreviewUrls;
    const manuscript = snapshot.editorModel.manuscript;
    state.manuscripts = [manuscript, ...state.manuscripts.filter((item) => item.id !== manuscript.id)];
    state.manuscriptDraft = manuscriptDraftFrom(manuscript);
    const tab = state.workspaceTabs.find((item) => item.kind === "manuscript" && item.manuscriptId === manuscript.id);
    if (tab) {
      tab.title = manuscript.title;
      tab.exactVersion = manuscript.currentVersion;
      tab.exactContentSha256 = manuscript.version.contentSha256;
      tab.dirty = false;
    }
  }

  async function refreshManuscriptEditorWorkspace(notice = "") {
    if (!state.selectedId || !state.selectedManuscriptId) return;
    const projectId = state.selectedId;
    const manuscriptId = state.selectedManuscriptId;
    const snapshot = await loadManuscriptEditorWorkspace(projectId, manuscriptId);
    if (state.selectedId !== projectId || state.selectedManuscriptId !== manuscriptId) {
      disposeManuscriptArtifactPreviews(snapshot.artifactPreviewUrls);
      return;
    }
    applyManuscriptEditorWorkspace(snapshot);
    state.manuscriptNotice = notice;
    state.manuscriptInsertError = "";
    disposeManuscriptInsertion();
    render();
  }

  async function openManuscript(manuscriptId) {
    if (!state.selectedId || !manuscriptId) return;
    rememberScroll();
    try {
      const [manuscript, claimLedger, editorWorkspace] = await Promise.all([
        science.manuscripts.get(state.selectedId, manuscriptId),
        science.claimLedgers.getForManuscript(state.selectedId, manuscriptId),
        loadManuscriptEditorWorkspace(state.selectedId, manuscriptId),
      ]);
      if (!manuscript || manuscript.projectId !== state.selectedId) throw new Error("science-manuscript-not-found");
      ensureManuscriptWorkspaceTab(manuscript);
      state.selectedManuscriptId = manuscript.id;
      applyManuscriptEditorWorkspace(editorWorkspace);
      state.claimLedger = claimLedger;
      restoreSubmissionExportState(manuscript, claimLedger, await science.submissions.list(state.selectedId, manuscript.id));
      state.journalValidation = null;
      state.manuscriptSaveError = "";
      state.manuscriptSelectionError = "";
      state.manuscriptInsertError = "";
      disposeManuscriptInsertion();
      state.manuscriptNotice = "";
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

  // Main-process manuscript rendering (electron/science/manuscript): numbered figures/tables,
  // embedded verified assets, editable tables from exact rows, math, references. The local
  // manuscriptPreview() below is only the instant fallback while the render is in flight.
  function manuscriptDraftKey(draft) {
    return JSON.stringify([draft.markdown, draft.bindings.map((binding) => [binding.ordinal, binding.role, binding.locator, binding.target])]);
  }
  function ensureManuscriptPaperCss(css) {
    if (!css || document.querySelector("style[data-manuscript-paper-css]")) return;
    const style = document.createElement("style");
    style.dataset.manuscriptPaperCss = "true";
    style.textContent = css;
    document.head.append(style);
  }
  async function requestManuscriptPreview() {
    const manuscript = manuscriptById(state.selectedManuscriptId);
    const draft = state.manuscriptDraft;
    if (!manuscript || !draft || !science.manuscripts?.render) return;
    const key = manuscriptDraftKey(draft);
    if (state.manuscriptPreviewKey === key && state.manuscriptPreviewHtml) return;
    if (state.manuscriptPreviewBusy === key) return;
    state.manuscriptPreviewBusy = key;
    const projectId = state.selectedId;
    try {
      const result = await science.manuscripts.render({
        projectId,
        draft: { title: manuscript.title, markdown: draft.markdown, bindings: draft.bindings },
        outputs: ["html", "latex"],
        lineNumbers: true,
      });
      if (state.selectedId !== projectId || !state.manuscriptDraft || manuscriptDraftKey(state.manuscriptDraft) !== key) return;
      ensureManuscriptPaperCss(result.css);
      state.manuscriptPreviewHtml = result.bodyHtml;
      state.manuscriptPreviewLatex = result.latex || "";
      state.manuscriptPreviewBibtex = result.bibtex || "";
      state.manuscriptPreviewCapabilities = result.capabilities || null;
      state.manuscriptPreviewKey = key;
      state.manuscriptPreviewWarnings = Array.isArray(result.warnings) ? result.warnings : [];
      state.manuscriptPreviewReport = result.document || null;
      if (state.mode === "manuscript" && state.manuscriptView !== "write") render();
    } catch (error) {
      state.manuscriptPreviewWarnings = [{ code: "render-failed", message: error instanceof Error ? error.message : String(error), line: null }];
      if (state.mode === "manuscript" && state.manuscriptView !== "write") render();
    } finally {
      if (state.manuscriptPreviewBusy === key) state.manuscriptPreviewBusy = false;
    }
  }
  async function exportManuscript(format) {
    const manuscript = manuscriptById(state.selectedManuscriptId);
    const draft = state.manuscriptDraft;
    if (!manuscript || !draft || state.manuscriptExportBusy || !science.manuscripts?.render) return;
    state.manuscriptExportBusy = format;
    render();
    try {
      const outputs = format === "pdf" ? ["pdf"] : format === "docx" ? ["docx"] : ["latex"];
      const result = draft.dirty
        ? await science.manuscripts.render({ projectId: state.selectedId, draft: { title: manuscript.title, markdown: draft.markdown, bindings: draft.bindings }, outputs, lineNumbers: format === "pdf" })
        : await science.manuscripts.render({ projectId: state.selectedId, manuscriptId: manuscript.id, outputs, lineNumbers: format === "pdf" });
      const base = (manuscript.title || "manuscript").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "manuscript";
      const journalProfile = journalProfileById(state.selectedJournalProfileId);
      const claimReady = claimLedgerIsCurrent(manuscript, draft);
      const readiness = manuscriptReadinessView(manuscript, draft, state.manuscriptEditorModel, journalProfile, claimReady);
      const version = readiness.publicationReady ? `v${manuscript.currentVersion}` : `DRAFT-v${manuscript.currentVersion}`;
      const payload = format === "pdf" ? result.pdf?.bytes : format === "docx" ? result.docx : result.latex;
      if (!payload) throw new Error(result.pdfFailure || `manuscript-${format}-render-failed`);
      const blob = new Blob([payload], { type: format === "pdf" ? "application/pdf" : format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/x-tex" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${base}-${version}.${format === "latex" ? "tex" : format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      state.manuscriptPreviewWarnings = Array.isArray(result.warnings) ? result.warnings : state.manuscriptPreviewWarnings;
      if (result.pdf?.degraded) state.manuscriptPreviewWarnings = [...state.manuscriptPreviewWarnings.filter((warning) => !String(warning.code).startsWith("pdf-")), { code: `pdf-${result.pdf.degraded}`, message: result.pdf.degraded === "toolchain-missing" ? "LaTeX 조판기(tectonic)가 없어 HTML 인쇄본 PDF로 내보냈습니다." : `LaTeX 조판에 실패해 HTML 인쇄본 PDF로 내보냈습니다: ${result.pdf.degradedReason || ""}`, line: null }];
    } catch (error) {
      state.manuscriptSaveError = error instanceof Error ? error.message : String(error);
    } finally {
      state.manuscriptExportBusy = "";
      render();
    }
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

  function manuscriptBlueprintAssessmentView(assessment) {
    const receipt = assessment?.receipt;
    const available = receipt?.schema === "agentlas.science.manuscript-blueprint-assessment/v1";
    return {
      available,
      status: available ? String(assessment.status || "stale") : "missing",
      staleReasons: available && Array.isArray(assessment.staleReasons) ? assessment.staleReasons : [],
      receipt: available ? receipt : null,
      sections: available && Array.isArray(receipt.sections) ? receipt.sections : [],
      findings: available && Array.isArray(receipt.findings) ? receipt.findings : [],
    };
  }

  function manuscriptReadinessView(manuscript, draft, editorModel, journalProfile, claimReady) {
    const blueprint = editorModel?.blueprint || null;
    const binding = manuscript?.version?.blueprintBinding || null;
    const comparableCount = Number(blueprint?.version?.document?.corpusSummary?.comparableCount || 0);
    const blueprintReady = Boolean(!draft?.dirty && binding && blueprint?.status === "current"
      && blueprint.currentVersion === binding.blueprintVersion
      && blueprint.version?.contentSha256 === binding.blueprintContentSha256
      && comparableCount >= 5);
    const structural = manuscriptBlueprintAssessmentView(editorModel?.blueprintAssessment);
    const structuralReady = Boolean(blueprintReady && structural.status === "current" && structural.receipt?.structuralStatus === "passed");
    const scholarly = manuscriptScholarlyAssessmentView(editorModel?.scholarlyAssessment);
    const scholarlyReady = Boolean(structuralReady && scholarly.status === "current" && scholarly.receipt?.scholarlyStatus === "passed");
    const assessedReady = Boolean(scholarlyReady && claimReady);
    const readyExport = assessedReady && journalProfile
      ? state.submissionExports.find((item) => submissionExportBindsResearchState(item, manuscript) && submissionExportBindsJournalProfile(item, journalProfile)) || null
      : null;
    const validation = state.journalValidation;
    const validationReady = Boolean(validation?.status === "ready"
      && validation.projectId === manuscript?.projectId
      && validation.manuscriptId === manuscript?.id
      && validation.manuscriptVersion === manuscript?.currentVersion
      && validation.manuscriptContentSha256 === manuscript?.version?.contentSha256
      && validation.journalProfileId === journalProfile?.id
      && validation.journalProfileVersion === journalProfile?.currentVersion
      && validation.journalProfileContentSha256 === journalProfile?.version?.contentSha256);
    const publicationReady = Boolean(assessedReady && (readyExport || validationReady));
    const activeIndex = !binding ? 0 : !structuralReady ? 1 : !assessedReady ? 2 : !publicationReady ? 3 : 4;
    const steps = [
      { id: "scratch", label: "Scratch", detail: "Editable working copy" },
      { id: "blueprint-collecting", label: "Blueprint collecting", detail: `${comparableCount}/5 full-text comparables` },
      { id: "draft-calibrated", label: "Draft calibrated", detail: "Length, flow, and visual density match corpus ranges" },
      { id: "assessed", label: "Assessed", detail: "Scholarly flow and claims checked" },
      { id: "submission-ready", label: "Submission-ready", detail: "Current journal validation passed" },
    ];
    const blocker = !binding
      ? "Bind a full-text Blueprint to begin calibration."
      : comparableCount < 5
        ? `${5 - comparableCount} more full-text comparable${5 - comparableCount === 1 ? "" : "s"} required.`
        : !structuralReady
          ? "Resolve missing and under-range manuscript sections."
          : !scholarlyReady
            ? "A current scholarly-flow assessment is required."
            : !claimReady
              ? "Resolve the sentence-level claim ledger."
              : !publicationReady
                ? "Run journal validation for this exact manuscript version."
                : "Exact Blueprint, assessments, claims, and journal validation are current.";
    return { activeIndex, steps, comparableCount, blueprint, blueprintReady, structuralReady, scholarlyReady, assessedReady, publicationReady, blocker };
  }

  function manuscriptReadinessMarkup(readiness) {
    const steps = readiness.steps.map((step, index) => {
      const status = index < readiness.activeIndex ? "complete" : index === readiness.activeIndex ? "current" : "pending";
      return `<li data-readiness-step="${escapeHtml(step.id)}" data-state="${status}" ${status === "current" ? 'aria-current="step"' : ""}><span>${index < readiness.activeIndex ? "✓" : index + 1}</span><div><strong>${escapeHtml(step.label)}</strong><em>${escapeHtml(step.detail)}</em></div></li>`;
    }).join("");
    return `<nav class="manuscriptReadinessRail" aria-label="Manuscript readiness" data-manuscript-readiness-stage="${escapeHtml(readiness.steps[readiness.activeIndex].id)}"><ol>${steps}</ol><p data-preview-boundary="${readiness.publicationReady ? "publication" : "draft"}"><strong>${escapeHtml(readiness.steps[readiness.activeIndex].label)}</strong><span>${escapeHtml(readiness.blocker)}</span></p></nav>`;
  }

  function manuscriptAssessmentRange(range, unit) {
    if (!range || !Number.isFinite(Number(range.minimum)) || !Number.isFinite(Number(range.maximum))) return `target ${unit} unresolved`;
    return `target ${Number(range.minimum).toLocaleString("en-US")}–${Number(range.maximum).toLocaleString("en-US")} ${unit}`;
  }

  function manuscriptAssessmentMark(status) {
    return ({ "within-range": "✓", "above-range": "↑", "below-range": "△", "gross-shortfall": "!", missing: "!", unresolved: "○" })[status] || "○";
  }

  function manuscriptCorpusMetric(metric, fallback = "unresolved") {
    if (!metric || !Number.isFinite(Number(metric.minimum)) || !Number.isFinite(Number(metric.median)) || !Number.isFinite(Number(metric.maximum))) return fallback;
    const minimum = Number(metric.minimum).toLocaleString("en-US");
    const median = Number(metric.median).toLocaleString("en-US");
    const maximum = Number(metric.maximum).toLocaleString("en-US");
    return `${minimum}–${maximum} · median ${median}`;
  }

  function manuscriptCorpusStructureMarkup(blueprint) {
    const document = blueprint?.version?.document || null;
    const corpus = document?.corpusSummary || null;
    const structure = document?.structureProfile || null;
    if (!corpus) return `<p>Collect at least five exact full-text papers before calibration.</p>`;
    const countSummary = structure?.countSummary || null;
    const roleOrder = Array.isArray(structure?.consensus?.roleOrder)
      ? structure.consensus.roleOrder.filter((role) => role && role !== "other")
      : [];
    const metrics = [
      ["Words", manuscriptCorpusMetric(corpus.wordCount)],
      ["Paragraphs", manuscriptCorpusMetric(corpus.paragraphCount)],
      ["Sections", manuscriptCorpusMetric(corpus.sectionCount)],
      ["Figures", manuscriptCorpusMetric(countSummary?.figures)],
      ["Tables", manuscriptCorpusMetric(countSummary?.tables)],
      ["Equations", manuscriptCorpusMetric(countSummary?.equations)],
      ["References", manuscriptCorpusMetric(countSummary?.references)],
      ["Confidence", corpus.confidence || "unresolved"],
    ];
    const metricRows = metrics.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    const flow = roleOrder.length
      ? `<p class="manuscriptCorpusFlow" data-manuscript-corpus-role-order><strong>Observed flow</strong><span>${roleOrder.map((role) => escapeHtml(role)).join(" → ")}</span></p>`
      : `<p class="manuscriptCorpusFlow" data-manuscript-corpus-role-order><strong>Observed flow</strong><span>unresolved until full-text section mapping is complete</span></p>`;
    return `<dl>${metricRows}</dl>${flow}`;
  }

  function manuscriptBlueprintAssessmentMarkup(view, blueprint = null) {
    const corpus = blueprint?.version?.document?.corpusSummary || null;
    const comparableCount = Number(corpus?.comparableCount || 0);
    const corpusStatus = blueprint?.status === "current" && comparableCount >= 5 ? "ready" : "blocked";
    const corpusSummary = `<div class="manuscriptCorpusSummary" data-status="${corpusStatus}" data-blueprint-comparable-count="${escapeHtml(comparableCount)}"><div><span>Full-text comparison corpus</span><strong>${escapeHtml(comparableCount)} <em>/ 5 minimum</em></strong></div>${manuscriptCorpusStructureMarkup(blueprint)}</div>`;
    if (!view.available || !view.receipt) {
      return `<section data-manuscript-blueprint-assessment data-assessment-status="missing"><div class="manuscriptInspectorLabel">Blueprint assessment</div>${corpusSummary}<div class="journalValidationSummary" data-status="blocked"><strong>assessment missing</strong><span>No immutable host assessment is bound to this exact manuscript version.</span></div><p class="manuscriptDepthBoundary">Final journal validation remains host-blocked until an exact Blueprint assessment receipt exists.</p></section>`;
    }
    const receipt = view.receipt;
    const visualStatus = view.status === "current" && receipt.structuralStatus === "passed" ? "ready" : "blocked";
    const sectionRows = view.sections.map((section) => {
      const observed = `${Number(section.observedWords || 0).toLocaleString("en-US")} words · ${Number(section.observedParagraphs || 0).toLocaleString("en-US")} paragraphs`;
      const target = `${manuscriptAssessmentRange(section.targetWords, "words")} · ${manuscriptAssessmentRange(section.targetParagraphs, "paragraphs")}`;
      const locator = section.observedHeadingNode
        ? `node ${String(section.observedHeadingNode.id).slice(0, 8)}… · r${Number(section.observedHeadingNode.revision || 0)}`
        : "heading node unavailable";
      const visuallyInRange = section.status === "within-range" || section.status === "above-range";
      return `<div data-ready="${visuallyInRange}" data-section-assessment-status="${escapeHtml(section.status)}" data-heading-node-id="${escapeHtml(section.observedHeadingNode?.id || "")}"><span>${manuscriptAssessmentMark(section.status)}</span><strong>${escapeHtml(section.title || section.role)} · ${escapeHtml(section.status)}</strong><em>Observed ${escapeHtml(observed)}<br>${escapeHtml(target)}<br>${escapeHtml(locator)}</em></div>`;
    }).join("");
    const findings = view.findings.map((finding) => `<li data-status="${escapeHtml(finding.status)}" data-severity="${escapeHtml(finding.severity)}"><strong>${escapeHtml(finding.code)} · ${escapeHtml(finding.status)}</strong><span>${escapeHtml(finding.observed)} · requires ${escapeHtml(finding.required)}</span></li>`).join("");
    const staleReasons = view.staleReasons.length
      ? `<ul class="manuscriptDepthIssues" data-assessment-stale-reasons>${view.staleReasons.map((reason) => `<li><strong>Stale binding</strong><span>${escapeHtml(reason)}</span></li>`).join("")}</ul>`
      : "";
    return `<section data-manuscript-blueprint-assessment data-assessment-status="${escapeHtml(view.status)}" data-structural-status="${escapeHtml(receipt.structuralStatus)}"><div class="manuscriptInspectorLabel">Blueprint assessment</div>${corpusSummary}<div class="journalValidationSummary" data-status="${visualStatus}"><strong>${escapeHtml(view.status)}</strong><span>Structural ${escapeHtml(receipt.structuralStatus)} · assessment ${escapeHtml(receipt.id.slice(0, 8))}… · report ${escapeHtml(receipt.reportSha256.slice(0, 12))}…</span></div><div class="readinessRows manuscriptDepthRows">${sectionRows}</div>${findings ? `<ul class="manuscriptDepthIssues" data-assessment-findings>${findings}</ul>` : ""}${staleReasons}<div class="manuscriptIntegrity"><dl><div><dt>Blueprint</dt><dd><code>v${escapeHtml(receipt.blueprint.version)} · ${escapeHtml(receipt.blueprint.contentSha256.slice(0, 12))}…</code></dd></div><div><dt>Journal</dt><dd><code>v${escapeHtml(receipt.journalProfile.version)} · ${escapeHtml(receipt.journalProfile.contentSha256.slice(0, 12))}…</code></dd></div><div><dt>Policy</dt><dd><code>v${escapeHtml(receipt.policy.version)} · ${escapeHtml(receipt.policy.contentSha256.slice(0, 12))}…</code></dd></div></dl></div><p class="manuscriptDepthBoundary">Host-owned immutable receipt. This renderer displays its ranges, findings, and stable heading locators without recalculating submission readiness.</p></section>`;
  }

  function manuscriptScholarlyAssessmentView(assessment) {
    const receipt = assessment?.receipt;
    const available = receipt?.schema === "agentlas.science.manuscript-scholarly-assessment/v1";
    return {
      available,
      status: available ? String(assessment.status || "stale") : "missing",
      staleReasons: available && Array.isArray(assessment.staleReasons) ? assessment.staleReasons : [],
      receipt: available ? receipt : null,
      sections: available && Array.isArray(receipt.sections) ? receipt.sections : [],
      findings: available && Array.isArray(receipt.findings) ? receipt.findings : [],
    };
  }

  function manuscriptScholarlyAssessmentMarkup(view) {
    if (!view.available || !view.receipt) {
      return `<section data-manuscript-scholarly-assessment data-assessment-status="missing"><div class="manuscriptInspectorLabel">Scholarly assessment</div><div class="journalValidationSummary" data-status="blocked"><strong>assessment missing</strong><span>No immutable Research Director reading is bound to this exact manuscript version.</span></div><p class="manuscriptDepthBoundary">Only the host can record this receipt. The renderer has no scholarly-assessment write path.</p></section>`;
    }
    const receipt = view.receipt;
    const visualStatus = view.status === "current" && receipt.scholarlyStatus === "passed" ? "ready" : "blocked";
    const sectionRows = view.sections.map((section) => {
      const rhetoricalMoves = Array.isArray(section.rhetoricalMoves) ? section.rhetoricalMoves : [];
      const evidenceRoles = Array.isArray(section.evidenceRoleCoverage) ? section.evidenceRoleCoverage : [];
      const movesSatisfied = rhetoricalMoves.filter((item) => item.status === "satisfied").length;
      const rolesSatisfied = evidenceRoles.filter((item) => item.status === "satisfied").length;
      const visual = section.visualExpectationCoverage || {};
      return `<div data-ready="${section.status === "passed"}" data-scholarly-section-status="${escapeHtml(section.status)}" data-heading-node-id="${escapeHtml(section.heading?.nodeId || "")}"><span>${section.status === "passed" ? "✓" : "!"}</span><strong>${escapeHtml(section.title || section.role)} · ${escapeHtml(section.status)}</strong><em>${escapeHtml(section.observedParagraphNodeIds?.length || 0)} paragraph nodes · requires ${escapeHtml(section.requiredParagraphs || 0)}<br>${escapeHtml(movesSatisfied)}/${escapeHtml(rhetoricalMoves.length)} moves · ${escapeHtml(rolesSatisfied)}/${escapeHtml(evidenceRoles.length)} evidence roles<br>flow ${escapeHtml(section.flow?.status || "unresolved")} · visual ${escapeHtml(visual.expectation || "unresolved")}/${escapeHtml(visual.status || "unresolved")}</em></div>`;
    }).join("");
    const failedFindings = view.findings.filter((finding) => finding.status !== "pass");
    const findings = failedFindings.map((finding) => `<li data-status="${escapeHtml(finding.status)}" data-severity="${escapeHtml(finding.severity)}"><strong>${escapeHtml(finding.code)} · ${escapeHtml(finding.status)}</strong><span>${escapeHtml(finding.observed)} · requires ${escapeHtml(finding.required)}</span></li>`).join("");
    const staleReasons = view.staleReasons.length
      ? `<ul class="manuscriptDepthIssues" data-scholarly-assessment-stale-reasons>${view.staleReasons.map((reason) => `<li><strong>Stale binding</strong><span>${escapeHtml(reason)}</span></li>`).join("")}</ul>`
      : "";
    const limitations = Array.isArray(receipt.limitations) && receipt.limitations.length
      ? `<ul class="manuscriptDepthIssues" data-scholarly-limitations>${receipt.limitations.slice(0, 3).map((limitation) => `<li><strong>Assessment limitation</strong><span>${escapeHtml(limitation)}</span></li>`).join("")}</ul>`
      : "";
    return `<section data-manuscript-scholarly-assessment data-assessment-status="${escapeHtml(view.status)}" data-scholarly-status="${escapeHtml(receipt.scholarlyStatus)}"><div class="manuscriptInspectorLabel">Scholarly assessment</div><div class="journalValidationSummary" data-status="${visualStatus}"><strong>${escapeHtml(view.status)}</strong><span>Scholarly ${escapeHtml(receipt.scholarlyStatus)} · confidence ${escapeHtml(Math.round(Number(receipt.overallConfidence || 0) * 100))}% · report ${escapeHtml(receipt.reportSha256.slice(0, 12))}…</span></div><p class="manuscriptDepthBoundary">${escapeHtml(receipt.summary)}</p><div class="readinessRows manuscriptDepthRows">${sectionRows}</div>${findings ? `<ul class="manuscriptDepthIssues" data-scholarly-findings>${findings}</ul>` : ""}${staleReasons}${limitations}<div class="manuscriptIntegrity"><dl><div><dt>Evaluator</dt><dd><code>${escapeHtml(receipt.evaluator.agentSlug)} · v${escapeHtml(receipt.evaluator.packageVersion)}</code></dd></div><div><dt>Policy</dt><dd><code>v${escapeHtml(receipt.policy.version)} · ${escapeHtml(receipt.policy.contentSha256.slice(0, 12))}…</code></dd></div><div><dt>Receipt</dt><dd><code>${escapeHtml(receipt.id.slice(0, 8))}… · ${escapeHtml(receipt.contentSha256.slice(0, 12))}…</code></dd></div></dl></div><p class="manuscriptDepthBoundary">Host-owned Research Director attestation. This renderer presents exact section judgments and cannot create or alter the receipt.</p></section>`;
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
      const context = state.manuscriptArtifactContexts.get(binding.target.artifactId);
      const lineage = state.manuscriptArtifactLineages.get(binding.target.artifactId);
      const lineageClosed = Boolean(lineage
        && lineage.receiptId === binding.target.validationReceiptId
        && lineage.artifactId === binding.target.artifactId
        && lineage.artifactVersion === binding.target.artifactVersion
        && lineage.artifactContentSha256 === context?.selectedVersion?.contentSha256
        && lineage.runId === context?.artifact?.sourceRunId);
      const lineageLabel = lineageClosed
        ? `Closed lineage · run ${lineage.runId.slice(0, 8)}… → ${lineage.outputRole} #${lineage.outputOrdinal} → artifact v${lineage.artifactVersion}`
        : "Lineage closure unavailable for this receipt";
      return `<button class="manuscriptBinding" data-manuscript-artifact-id="${escapeHtml(binding.target.artifactId)}" data-manuscript-artifact-version="${escapeHtml(binding.target.artifactVersion)}" data-lineage-status="${lineageClosed ? "closed" : "unavailable"}"><span>${escapeHtml(binding.role)} · ${escapeHtml(binding.locator)}</span><strong>${escapeHtml(artifact?.title || "Verified Lab artifact")} · exact v${escapeHtml(binding.target.artifactVersion)}</strong><em>${escapeHtml(lineageLabel)}</em><small>Open verified capture →</small></button>`;
    }
    if (binding.target.kind === "citation") {
      const citation = citationById(binding.target.citationId);
      const source = sourceById(citation?.sourceId);
      return `<button class="manuscriptBinding" data-citation-id="${escapeHtml(binding.target.citationId)}" ${citation?.sourceId ? `data-source-id="${escapeHtml(citation.sourceId)}"` : ""}><span>${escapeHtml(binding.role)} · ${escapeHtml(binding.locator)}</span><strong>${escapeHtml(source?.title || "프로젝트 인용 근거")}</strong><em>정확한 근거 열기 →</em></button>`;
    }
    return `<div class="manuscriptBinding"><span>${escapeHtml(binding.role)} · ${escapeHtml(binding.locator)}</span><strong>Source figure · ${escapeHtml(binding.target.sourceFigureId)}</strong><em>원본 figure version에 고정됨</em></div>`;
  }

  function manuscriptNodeSelectionText(node) {
    if (!node) return "";
    if (node.kind === "heading") return node.text;
    if (node.kind === "paragraph") return node.markdown;
    if (node.kind === "equation") return node.tex;
    if (node.kind === "figure" || node.kind === "table") return node.caption || "";
    if (node.kind === "code") return node.text;
    if (node.kind === "list") return node.items.map((item) => item.nodes.map(manuscriptNodeSelectionText).join("\n\n")).join("\n");
    if (node.kind === "blockquote") return node.children.map(manuscriptNodeSelectionText).join("\n\n");
    return "";
  }

  function manuscriptBindingForLocator(locator) {
    return state.manuscriptEditorModel?.manuscript?.version?.bindings?.find((binding) => binding.locator === locator && binding.target?.kind === "artifact") || null;
  }

  function manuscriptTablePreviewMarkup(payload, { compact = false } = {}) {
    if (payload?.schema !== "agentlas.science-table/v1" || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)) {
      return `<div class="manuscriptTableUnavailable">Validated table data is unavailable.</div>`;
    }
    const columns = payload.columns.slice(0, compact ? 4 : 6);
    const rows = payload.rows.slice(0, compact ? 3 : 5);
    const header = columns.map((column) => `<th>${escapeHtml(column.name || column.label || column.key || "Column")}</th>`).join("");
    const body = rows.map((row) => `<tr>${columns.map((column) => {
      const key = column.name || column.key;
      const value = row?.[key];
      return `<td>${value === null || value === undefined || value === "" ? "—" : escapeHtml(value)}</td>`;
    }).join("")}</tr>`).join("");
    return `<div class="manuscriptSemanticTableViewport"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div><div class="manuscriptTableMeta">${escapeHtml(payload.profile?.rowCount ?? payload.rows.length)} rows · ${escapeHtml(payload.profile?.columnCount ?? payload.columns.length)} columns</div>`;
  }

  function paleontologyArtifactPayload(versionOrPayload) {
    const payload = versionOrPayload?.payload || versionOrPayload;
    return payload?.schema === PALEONTOLOGY_ARTIFACT_SCHEMA && payload.analysis?.publicationTable?.schema === "agentlas.science-table/v1"
      ? payload : null;
  }

  function paleontologyPublicationTablePayload(versionOrPayload) {
    const payload = paleontologyArtifactPayload(versionOrPayload);
    const table = payload?.analysis?.publicationTable;
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
    const sourceColumns = table.columns.map((column) => ({
      name: column.id,
      label: column.label || column.id,
      logicalType: column.type === "number" ? "number" : "string",
      nullable: true,
      unit: column.unit || null,
    }));
    const rows = table.rows.map((row) => Object.fromEntries(sourceColumns.map((column, index) => [column.name, row[index] ?? null])));
    const preferredOrder = ["occurrenceId", "identifiedName", "maxMa", "minMa", "intervalWidthMa", "formation", "earlyInterval", "collectionId"];
    const columns = [...sourceColumns].sort((left, right) => {
      const leftIndex = preferredOrder.indexOf(left.name);
      const rightIndex = preferredOrder.indexOf(right.name);
      if (leftIndex === -1 && rightIndex === -1) return sourceColumns.indexOf(left) - sourceColumns.indexOf(right);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
    return {
      schema: "agentlas.science-table/v1",
      title: table.title,
      columns,
      rows,
      notes: Array.isArray(table.notes) ? table.notes : [],
      profile: { rowCount: rows.length, columnCount: columns.length, nullCount: rows.reduce((count, row) => count + columns.filter((column) => row[column.name] === null).length, 0), formulaLikeCellCount: 0 },
      receipts: { tableSha256: payload.analysis.contentReceipts?.publicationTable?.sha256 || payload.source?.publicationTableSha256 || "" },
    };
  }

  // Statistics results deliberately keep their publication tables nested inside the immutable
  // analysis artifact. The renderer and manuscript exporter use the same selection rule: a
  // locator ending in #N addresses the Nth table in result.artifacts; without a suffix the
  // artifact's selectedTableIndex is used. Never flatten the result or invent rows here.
  function statisticsAnalysisTablePublicationPayload(versionOrPayload, locator = "") {
    const payload = versionOrPayload?.payload || versionOrPayload;
    if (payload?.schema !== "agentlas.science.statistics-analysis-artifact/v1") return null;
    const result = payload.result;
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
    const tableEntries = artifacts
      .map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => artifact?.kind === "table" && artifact?.payload?.schema === "agentlas.science.statistics-table/v1");
    if (!tableEntries.length) return null;
    const selector = /#(\d+)$/u.exec(String(locator || ""));
    // The persisted manuscript resolver addresses tables by their ordinal among table outputs
    // (not by the raw result.artifacts index). Keep the UI locator and the backend exporter in
    // the same namespace so a second statistics table cannot silently render the first one.
    const selected = selector
      ? tableEntries[Number(selector[1])] || null
      : tableEntries.find((entry) => entry.index === Number(payload.selectedTableIndex)) || tableEntries[0];
    // An explicit but out-of-range #N is a stale/corrupt manuscript locator. The backend resolver
    // returns no table for it; falling back to table 1 here would silently show the wrong numbers.
    if (!selected) return null;
    const table = selected?.artifact?.payload;
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
    const columns = table.columns.map((column) => {
      const key = String(column?.key ?? "").trim();
      return {
        name: key,
        key,
        label: String(column?.label ?? key),
        logicalType: column?.type === "number" || column?.type === "integer" ? "number" : column?.type === "boolean" ? "boolean" : "string",
        nullable: true,
        unit: null,
      };
    }).filter((column) => column.name);
    if (!columns.length) return null;
    const rows = table.rows.map((row) => Object.fromEntries(columns.map((column) => [column.name, row?.[column.name] ?? null])));
    return {
      schema: "agentlas.science-table/v1",
      title: String(table.title ?? selected.artifact.role ?? `Table ${selected.index + 1}`),
      caption: typeof table.caption === "string" ? table.caption : null,
      columns,
      rows,
      notes: Array.isArray(table.notes) ? table.notes.filter((note) => typeof note === "string") : [],
      profile: {
        rowCount: rows.length,
        columnCount: columns.length,
        nullCount: rows.reduce((count, row) => count + columns.filter((column) => row[column.name] === null).length, 0),
        formulaLikeCellCount: 0,
      },
      receipts: { sourceArtifactIndex: selected.index, tableSha256: result.artifactReceipts?.[selected.index]?.sha256 || "" },
    };
  }

  function statisticsAnalysisTableEntries(versionOrPayload) {
    const payload = versionOrPayload?.payload || versionOrPayload;
    if (payload?.schema !== "agentlas.science.statistics-analysis-artifact/v1") return [];
    const artifacts = Array.isArray(payload.result?.artifacts) ? payload.result.artifacts : [];
    return artifacts.map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => artifact?.kind === "table" && artifact?.payload?.schema === "agentlas.science.statistics-table/v1")
      .map((entry, tableIndex) => ({ ...entry, tableIndex, tablePayload: statisticsAnalysisTablePublicationPayload(payload, `#${tableIndex}`) }))
      .filter((entry) => entry.tablePayload);
  }

  function paleontologyCandidateCaption(context, role) {
    const payload = paleontologyArtifactPayload(context?.selectedVersion);
    if (!payload) return context?.selectedVersion?.semantic?.summary || context?.artifact?.title || "Verified project evidence";
    const table = payload.analysis.publicationTable;
    const notes = Array.isArray(table.notes) ? table.notes : [];
    const base = role === "table"
      ? `${table.title}. ${notes.join(" ")}`
      : `${context.selectedVersion.semantic?.summary || context.artifact.title} ${PALEONTOLOGY_BOUNDARY}`;
    return base.slice(0, 500);
  }

  function manuscriptCandidateCaption(candidate) {
    if (candidate?.tablePayload?.title) {
      const notes = Array.isArray(candidate.tablePayload.notes) ? candidate.tablePayload.notes : [];
      return `${candidate.tablePayload.title}${notes.length ? `. ${notes.join(" ")}` : ""}`.slice(0, 500);
    }
    if (candidate?.sourceFigure?.title) return String(candidate.sourceFigure.title).slice(0, 500);
    return paleontologyCandidateCaption(candidate?.context, candidate?.role);
  }

  function manuscriptCandidateTitle(candidate) {
    return candidate?.artifact?.title || candidate?.sourceFigure?.figureLabel || candidate?.sourceFigure?.locator || "Source figure";
  }

  function manuscriptCandidateSummary(candidate) {
    return candidate?.context?.selectedVersion?.semantic?.summary
      || candidate?.sourceFigure?.caption
      || candidate?.sourceFigure?.rightsNote
      || "Source figure asset from a verified project source.";
  }

  function manuscriptInsertionRole(artifact, context) {
    if (artifact?.kind === "table" && context?.selectedVersion?.payload?.schema === "agentlas.science-table/v1") return "table";
    if (artifact?.kind && artifact.kind !== "table" && context?.selectedVersion?.rendererId !== "agentlas.table") return "figure";
    return null;
  }

  function manuscriptInsertionTypeLabel(candidate) {
    if (candidate.role === "table") return "Table";
    if (candidate.sourceFigure) return "Source figure";
    if (candidate.artifact?.kind === "image") return "Image";
    if (String(candidate.artifact?.kind || "").startsWith("chart.")) return "Chart";
    return "Figure";
  }

  function disposeManuscriptInsertion() {
    for (const candidate of state.manuscriptInsertion?.candidates || []) {
      if (candidate.previewUrl) URL.revokeObjectURL(candidate.previewUrl);
    }
    state.manuscriptInsertion = null;
  }

  function manuscriptArtifactTableMarkup(node) {
    const binding = manuscriptBindingForLocator(node.locator);
    const context = binding ? state.manuscriptArtifactContexts.get(binding.target.artifactId) : null;
    const version = context?.selectedVersion;
    return `<figure class="manuscriptEmbeddedTable" data-manuscript-artifact-table data-locator="${escapeHtml(node.locator)}">
      <div class="manuscriptEmbeddedTableHeader"><span>Table</span><strong>${escapeHtml(context?.artifact?.title || node.locator)}</strong>${version ? `<em>validated · exact v${escapeHtml(version.version)}</em>` : `<em>binding unavailable</em>`}</div>
      ${manuscriptTablePreviewMarkup(paleontologyPublicationTablePayload(version) || statisticsAnalysisTablePublicationPayload(version, node.locator) || version?.payload)}
      <figcaption>${escapeHtml(node.caption || context?.artifact?.version?.semantic?.summary || "Validated project table")}</figcaption>
    </figure>`;
  }

  function manuscriptArtifactFigureMarkup(node) {
    const binding = manuscriptBindingForLocator(node.locator);
    const context = binding ? state.manuscriptArtifactContexts.get(binding.target.artifactId) : null;
    const version = context?.selectedVersion;
    const previewUrl = binding ? state.manuscriptArtifactPreviewUrls.get(binding.target.artifactId) : null;
    const caption = node.caption || version?.semantic?.summary || context?.artifact?.title || node.locator;
    return `<figure class="manuscriptEmbeddedFigure" data-manuscript-artifact-figure data-locator="${escapeHtml(node.locator)}">
      ${previewUrl ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(context?.artifact?.title || node.locator)}">` : `<div class="manuscriptEmbeddedFigureMissing">${heroIcon("photo")}<span>Verified figure preview unavailable</span></div>`}
      <figcaption><strong>Figure.</strong> ${escapeHtml(caption)}</figcaption>
      <div class="manuscriptEmbeddedFigureMeta"><span>${escapeHtml(context?.artifact?.title || node.locator)}</span>${version ? `<em>publication verified · exact v${escapeHtml(version.version)}</em>` : `<em>binding unavailable</em>`}</div>
    </figure>`;
  }

  function manuscriptNodeMarkup(node) {
    const identity = `data-manuscript-node-id="${escapeHtml(node.id)}" data-node-kind="${escapeHtml(node.kind)}" data-node-revision="${escapeHtml(node.revision)}" data-node-content-sha256="${escapeHtml(node.contentSha256)}"`;
    if (node.kind === "heading") {
      const level = Math.max(2, Math.min(4, Number(node.level) + 1));
      return `<section class="manuscriptBlock manuscriptHeadingBlock" ${identity}><h${level}>${escapeHtml(node.text)}</h${level}></section>`;
    }
    if (node.kind === "paragraph") return `<section class="manuscriptBlock manuscriptParagraphBlock" ${identity}><p>${escapeHtml(node.markdown)}</p></section>`;
    if (node.kind === "equation") return `<section class="manuscriptBlock manuscriptEquationBlock" ${identity}><pre>${escapeHtml(node.tex)}</pre>${node.label ? `<span>${escapeHtml(node.label)}</span>` : ""}</section>`;
    if (node.kind === "figure") return `<section class="manuscriptBlock manuscriptFigureBlock" ${identity}>${manuscriptArtifactFigureMarkup(node)}</section>`;
    if (node.kind === "table" && node.mode === "artifact") return `<section class="manuscriptBlock manuscriptTableBlock" ${identity}>${manuscriptArtifactTableMarkup(node)}</section>`;
    if (node.kind === "table") {
      const payload = { schema: "agentlas.science-table/v1", columns: node.header.map((name) => ({ name })), rows: node.rows.map((row) => Object.fromEntries(node.header.map((name, index) => [name, row[index]]))), profile: { rowCount: node.rows.length, columnCount: node.header.length } };
      return `<section class="manuscriptBlock manuscriptTableBlock" ${identity}><figure class="manuscriptEmbeddedTable">${manuscriptTablePreviewMarkup(payload)}<figcaption>${escapeHtml(node.caption || "Inline table")}</figcaption></figure></section>`;
    }
    if (node.kind === "list") {
      const tag = node.ordered ? "ol" : "ul";
      return `<section class="manuscriptBlock manuscriptListBlock" ${identity}><${tag}>${node.items.map((item) => `<li>${escapeHtml(item.nodes.map(manuscriptNodeSelectionText).join(" "))}</li>`).join("")}</${tag}></section>`;
    }
    if (node.kind === "blockquote") return `<section class="manuscriptBlock manuscriptQuoteBlock" ${identity}><blockquote>${escapeHtml(manuscriptNodeSelectionText(node))}</blockquote></section>`;
    if (node.kind === "code") return `<section class="manuscriptBlock manuscriptCodeBlock" ${identity}><pre><code>${escapeHtml(node.text)}</code></pre></section>`;
    if (node.kind === "rule") return `<section class="manuscriptBlock manuscriptRuleBlock" ${identity}><hr></section>`;
    return "";
  }

  function manuscriptInsertionPanelMarkup(afterNodeId) {
    const insertion = state.manuscriptInsertion;
    if (!insertion || insertion.afterNodeId !== afterNodeId) return "";
    if (insertion.phase === "loading") return `<div class="manuscriptInsertPanel" role="dialog" aria-label="Insert verified project evidence"><header><div><span>Project evidence</span><strong>Loading verified artifacts…</strong></div><button data-action="close-manuscript-insert" aria-label="Close">×</button></header></div>`;
    const candidates = Array.isArray(insertion.candidates) ? insertion.candidates : [];
    if (insertion.phase === "preview") {
      const candidate = candidates.find((item) => item.candidateId === insertion.selectedCandidateId)
        || candidates.find((item) => item.artifact?.id === insertion.selectedArtifactId);
      if (!candidate) return "";
      const typeLabel = manuscriptInsertionTypeLabel(candidate);
      const preview = candidate.role === "table"
        ? `${manuscriptTablePreviewMarkup(candidate.tablePayload || candidate.context?.selectedVersion?.payload, { compact: true })}${candidate.notes?.length ? `<ul class="manuscriptDepthIssues">${candidate.notes.map((note) => `<li><strong>Table note</strong><span>${escapeHtml(note)}</span></li>`).join("")}</ul>` : ""}`
        : candidate.previewUrl
          ? `<figure class="manuscriptFigurePreview"><img src="${escapeHtml(candidate.previewUrl)}" alt="Verified preview of ${escapeHtml(manuscriptCandidateTitle(candidate))}"><figcaption>${escapeHtml(manuscriptCandidateSummary(candidate))}</figcaption></figure>`
          : `<div class="manuscriptFigurePreview manuscriptSourceFigurePreview"><strong>${escapeHtml(manuscriptCandidateTitle(candidate))}</strong><span>${escapeHtml(manuscriptCandidateSummary(candidate))}</span><small>Source figure bytes stay in the verified source store; this picker has no image preview for this record.</small></div>`;
      const versionLabel = candidate.context?.selectedVersion?.version ? `exact v${candidate.context.selectedVersion.version}` : "source version exact";
      const receiptLabel = candidate.receipt?.receiptSha256 || candidate.sourceFigure?.assetSha256 || "";
      const insertDisabled = state.manuscriptInsertBusy || candidate.insertable === false;
      return `<div class="manuscriptInsertPanel manuscriptInsertPreview" role="dialog" aria-label="Preview verified project ${escapeHtml(candidate.role)}">
        <header><div><span>Verified ${escapeHtml(typeLabel)}</span><strong>${escapeHtml(manuscriptCandidateTitle(candidate))}</strong></div><button data-action="close-manuscript-insert" aria-label="Close">×</button></header>
        <div class="manuscriptValidationLine">${heroIcon(candidate.role === "table" ? "table" : "photo")}<span>${candidate.sourceFigure ? "Source figure · " : "Publication verified · "}${escapeHtml(versionLabel)}</span><code>${escapeHtml(receiptLabel.slice(0, 10))}…</code></div>
        ${preview}
        <label class="manuscriptCaptionField"><span>Caption</span><textarea data-manuscript-insert-caption rows="2" maxlength="500">${escapeHtml(insertion.caption)}</textarea></label>
        ${candidate.insertable === false ? `<p class="manuscriptInsertError" role="status">Source figure metadata is recognized, but this UI build has no atomic source-figure insertion operation. It remains selectable without fabricating a preview or binding.</p>` : ""}
        ${state.manuscriptInsertError ? `<p class="manuscriptInsertError" role="alert">${escapeHtml(state.manuscriptInsertError)}</p>` : ""}
        <footer><button class="secondaryButton" data-action="back-manuscript-insert">Back</button><button class="primaryButton" data-action="confirm-manuscript-insert" ${insertDisabled ? "disabled" : ""}>${state.manuscriptInsertBusy ? "Inserting…" : candidate.insertable === false ? "Source figure insertion unavailable" : "Insert as new version"}</button></footer>
      </div>`;
    }
    const filter = ["all", "figure", "table"].includes(insertion.filter) ? insertion.filter : "all";
    const query = String(insertion.query || "").trim().toLocaleLowerCase(state.locale || "en");
    const visible = candidates.filter((candidate) => (filter === "all" || candidate.role === filter)
      && (!query || [manuscriptCandidateTitle(candidate), candidate.artifact?.kind, candidate.context?.linkage?.labId, labLabel(candidate.context?.linkage?.labId), manuscriptCandidateSummary(candidate)]
        .filter(Boolean).join(" ").toLocaleLowerCase(state.locale || "en").includes(query)));
    const counts = { all: candidates.length, figure: candidates.filter((item) => item.role === "figure").length, table: candidates.filter((item) => item.role === "table").length };
    return `<div class="manuscriptInsertPanel" role="dialog" aria-label="Insert verified project evidence">
      <header><div><span>Project evidence</span><strong>Insert a verified artifact</strong></div><button data-action="close-manuscript-insert" aria-label="Close">×</button></header>
      <div class="manuscriptInsertTools"><div class="manuscriptInsertFilters" role="tablist" aria-label="Artifact type">${[["all", "All"], ["figure", "Figures"], ["table", "Tables"]].map(([value, label]) => `<button role="tab" data-action="filter-manuscript-insert" data-manuscript-insert-filter="${value}" aria-selected="${filter === value}">${label}<span>${escapeHtml(counts[value])}</span></button>`).join("")}</div><label class="manuscriptInsertSearch">${heroIcon("search")}<span class="visuallyHidden">Search project artifacts</span><input data-manuscript-insert-search value="${escapeHtml(insertion.query || "")}" placeholder="Search title, lab, or type" autocomplete="off"></label></div>
      <div class="manuscriptInsertList">${visible.length ? visible.map((candidate) => {
        const tableRows = candidate.tablePayload?.profile?.rowCount || candidate.context?.selectedVersion?.payload?.profile?.rowCount || candidate.context?.selectedVersion?.payload?.rows?.length || 0;
        const meta = candidate.role === "table" ? `${tableRows} rows` : manuscriptInsertionTypeLabel(candidate);
        const versionLabel = candidate.context?.selectedVersion?.version ? `exact v${candidate.context.selectedVersion.version}` : "source version exact";
        const sourceLabel = candidate.sourceFigure ? "Source figure" : candidate.role === "table" ? "Publication table" : "Publication figure";
        return `<button data-action="preview-manuscript-artifact" data-manuscript-candidate data-candidate-id="${escapeHtml(candidate.candidateId)}" data-artifact-id="${escapeHtml(candidate.artifact?.id || "")}"><span>${heroIcon(candidate.role === "table" ? "table" : "photo")}</span><span><strong>${escapeHtml(manuscriptCandidateTitle(candidate))} · ${escapeHtml(sourceLabel)}</strong><em>${escapeHtml(candidate.context ? labLabel(candidate.context.linkage?.labId) : "Literature source" )} · ${escapeHtml(meta)} · ${escapeHtml(versionLabel)}</em></span><span class="manuscriptVerifiedBadge">${candidate.insertable === false ? "Source" : "Verified"}</span></button>`;
      }).join("") : `<div class="manuscriptNoValidatedTables"><strong>${candidates.length ? "No matching artifacts" : "No verified artifacts yet"}</strong><span>${candidates.length ? "Try another search or artifact type." : "Validate a project output before inserting it into the manuscript."}</span></div>`}</div>
      ${state.manuscriptInsertError ? `<p class="manuscriptInsertError" role="alert">${escapeHtml(state.manuscriptInsertError)}</p>` : ""}
    </div>`;
  }

  function manuscriptInsertSlotMarkup(afterNode) {
    const afterNodeId = afterNode?.id || "";
    const open = state.manuscriptInsertion?.afterNodeId === afterNodeId;
    return `<div class="manuscriptInsertSlot" data-insert-open="${open}"><button class="manuscriptMarginAdd" data-action="open-manuscript-insert" data-after-node-id="${escapeHtml(afterNodeId)}" aria-label="Insert a validated project artifact here">+</button>${manuscriptInsertionPanelMarkup(afterNodeId)}</div>`;
  }

  function manuscriptBlockPaperMarkup(manuscript, document) {
    if (!document) return `<article class="manuscriptBlockPaper manuscriptDocumentLoading" aria-busy="true">Loading the versioned manuscript…</article>`;
    return `<article class="manuscriptBlockPaper" data-manuscript-document-id="${escapeHtml(document.documentId)}" data-manuscript-document-sha256="${escapeHtml(document.documentSha256)}">
      <header class="manuscriptDocumentTitle"><span>Research article · versioned blocks</span><h1>${escapeHtml(manuscript.title)}</h1><p>Every block has stable identity. Select text to ask Science, or use the margin to insert validated project output.</p></header>
      <div class="manuscriptBlocks">${manuscriptInsertSlotMarkup(null)}${document.nodes.map((node) => `${manuscriptNodeMarkup(node)}${manuscriptInsertSlotMarkup(node)}`).join("")}</div>
    </article>`;
  }

  function manuscriptSourceEditorMarkup(manuscript, draft) {
    return `<article class="manuscriptEditorDocument" data-manuscript-source-editor data-manuscript-id="${escapeHtml(manuscript.id)}" data-manuscript-version="${escapeHtml(manuscript.currentVersion)}">
      <header class="manuscriptDocumentTitle"><span>Editable source · immutable v${escapeHtml(manuscript.currentVersion)}</span><h1>${escapeHtml(manuscript.title)}</h1><p>Edit the manuscript source, then save a new immutable version. Figures, tables, captions, and citations remain bound to their exact project evidence.</p></header>
      <label class="manuscriptEditorLabel" for="science-manuscript-editor"><span class="visuallyHidden">Manuscript source</span><textarea id="science-manuscript-editor" class="manuscriptEditor" data-manuscript-editor spellcheck="true" aria-label="Editable manuscript source">${escapeHtml(draft.markdown)}</textarea></label>
    </article>`;
  }

  function manuscriptWorkbench() {
    // Submission & Archive opens a manuscript so the exports have something to hang from, which
    // leaves the workspace in manuscript mode. The destination still owns its own surface: without
    // this the archive would only ever be visible to a project that has no manuscript at all.
    if (state.currentDestination === "submission-archive") {
      const archiveProject = selectedProject();
      if (archiveProject) return submissionArchiveView(archiveProject);
    }
    const manuscript = manuscriptById(state.selectedManuscriptId);
    const draft = state.manuscriptDraft;
    const editorModel = state.manuscriptEditorModel;
    const document = editorModel?.document || null;
    // "No manuscripts at all" and "one exists but none is selected" are different situations and
    // need different next steps, so the empty state asks which one this is before it speaks.
    if (!manuscript || !draft || draft.manuscriptId !== manuscript.id) {
      const noManuscripts = !(state.manuscripts && state.manuscripts.length);
      return `<section class="emptyView"><div><div class="emptyIcon">M</div><strong>${noManuscripts ? "아직 원고가 없습니다." : "원고를 선택해 주세요."}</strong><p>${noManuscripts ? "제목과 첫 Markdown만 정하면 원고가 열립니다. 이후 저장할 때마다 덮어쓰지 않고 새 버전이 쌓입니다." : "저장된 원고는 브라우저형 탭에서 열리고, 우측 연구 채팅과 함께 편집됩니다."}</p><button class="primaryButton manuscriptCreateInline" data-action="new-manuscript">${noManuscripts ? "첫 원고 만들기" : "새 원고 만들기"}</button></div></section>`;
    }
    const journalProfile = journalProfileById(state.selectedJournalProfileId);
    const claimReady = claimLedgerIsCurrent(manuscript, draft);
    // A disabled button with no reason beside it is a dead end: the researcher can see that the
    // door is shut and nothing about which key opens it. The same sentence fills the tooltip and
    // the visible line, so it reads the same whether or not a pointer is hovering.
    const claimGateReason = draft.dirty
      ? "원고를 먼저 새 버전으로 저장하세요"
      : !state.claimLedger
        ? "원고의 claim ledger가 아직 없습니다"
        : !claimReady
          ? "현재 원고 버전의 미해결 claim gate를 먼저 닫으세요"
          : "";
    const figureCount = draft.bindings.filter((binding) => binding.target.kind === "artifact" || binding.target.kind === "source-figure").length;
    const referenceCount = draft.bindings.filter((binding) => binding.target.kind === "citation").length;
    const guidelineInspectedOn = journalProfile?.version.sources?.[0]?.inspectedAt || null;
    const guidelineInspectedAt = guidelineInspectedOn ? formatDate(guidelineInspectedOn) : "검사 필요";
    const blueprintAssessment = manuscriptBlueprintAssessmentView(editorModel?.blueprintAssessment);
    const scholarlyAssessment = manuscriptScholarlyAssessmentView(editorModel?.scholarlyAssessment);
    const readiness = manuscriptReadinessView(manuscript, draft, editorModel, journalProfile, claimReady);
    const previewLabel = readiness.publicationReady ? "Publication preview" : "Typeset preview";
    const exportPrefix = readiness.publicationReady ? "" : "DRAFT ";
    const draftBoundary = readiness.publicationReady ? "" : `<div class="manuscriptDraftBoundary" role="status"><strong>DRAFT · NOT FOR SUBMISSION</strong><span>${escapeHtml(readiness.blocker)}</span></div>`;
    const draftWatermark = readiness.publicationReady ? "" : `<span class="manuscriptDraftWatermark" aria-hidden="true">DRAFT</span>`;
    const outline = (document?.nodes || []).filter((node) => node.kind === "heading");
    const wordCount = String(draft.markdown || "").trim().split(/\s+/).filter(Boolean).length;
    const previewKey = manuscriptDraftKey(draft);
    const typesetterStatus = state.manuscriptPreviewCapabilities?.tectonic === true
      ? "Tectonic available"
      : state.manuscriptPreviewCapabilities?.tectonic === false
        ? "HTML proof · PDF fallback"
        : "Checking LaTeX toolchain";
    // Both the typeset proof and the generated .tex come from the same render call, so the LaTeX
    // view asks for it too. Without this the tab would sit there showing "generating…" forever.
    const needsRender = state.manuscriptView === "preview" || state.manuscriptView === "latex";
    const renderedPreview = state.manuscriptView === "preview" && state.manuscriptPreviewKey === previewKey && state.manuscriptPreviewHtml;
    const latexReady = state.manuscriptPreviewKey === previewKey && state.manuscriptPreviewLatex;
    if (needsRender && !(renderedPreview || (state.manuscriptView === "latex" && latexReady))) {
      queueMicrotask(() => { void requestManuscriptPreview(); });
    }
    const previewWarnings = needsRender && state.manuscriptPreviewWarnings.length
      ? `<div class="manuscriptPaperWarnings" role="status"><strong><span class="stateGlyph" data-state="awaiting-human" aria-hidden="true"></span>${escapeHtml(String(state.manuscriptPreviewWarnings.length))}건 확인 필요</strong><ul>${state.manuscriptPreviewWarnings.slice(0, 12).map((warning) => `<li data-code="${escapeHtml(warning.code)}">${escapeHtml(warning.message)}${warning.line ? ` <em>(line ${escapeHtml(String(warning.line))})</em>` : ""}</li>`).join("")}</ul></div>`
      : "";
    const canvas = state.manuscriptView === "preview"
      ? renderedPreview
        ? `${draftBoundary}${previewWarnings}<div class="manuscriptPaperHost" data-manuscript-preview data-rendered="true" data-preview-kind="${readiness.publicationReady ? "publication" : "draft"}">${draftWatermark}${state.manuscriptPreviewHtml}</div>`
        : `${draftBoundary}${previewWarnings}<article class="manuscriptPaper manuscriptPreview" data-manuscript-preview data-rendered="false" data-preview-kind="${readiness.publicationReady ? "publication" : "draft"}" aria-busy="true">${draftWatermark}<header class="manuscriptDocumentTitle"><span>Research Article</span><h1>${escapeHtml(manuscript.title)}</h1></header>${manuscriptPreview(draft.markdown)}</article>`
      : state.manuscriptView === "latex"
        // What the typesetter is actually handed. A proof can look right while the source that
        // produces it is wrong, and the researcher is the one who has to send that source to a
        // journal -- so it is readable here, and downloadable, rather than only inferable.
        ? `<section class="manuscriptLatexWorkspace"><header><div><span>제출용 생성 소스</span><strong>main.tex</strong></div><div><span>${escapeHtml(typesetterStatus)}</span><span>그림 ${escapeHtml(state.manuscriptPreviewReport?.figures?.length || 0)} · 표 ${escapeHtml(state.manuscriptPreviewReport?.tables?.length || 0)} · 인용 ${escapeHtml(state.manuscriptPreviewReport?.citations?.length || 0)}</span></div></header>${previewWarnings}<pre aria-label="Generated LaTeX source"><code>${latexReady ? escapeHtml(state.manuscriptPreviewLatex) : "% LaTeX 소스를 생성하는 중…"}</code></pre>${state.manuscriptPreviewBibtex ? `<details><summary>references.bib</summary><pre><code>${escapeHtml(state.manuscriptPreviewBibtex)}</code></pre></details>` : ""}<footer><span>정확한 원고 버전과 결합된 연구 아티팩트에서 생성됩니다.</span><button class="secondaryButton ghostButton" data-action="export-manuscript" data-format="latex">.tex 내려받기</button></footer></section>`
      : state.manuscriptView === "write"
        ? manuscriptSourceEditorMarkup(manuscript, draft)
        : manuscriptBlockPaperMarkup(manuscript, document);
    const sourceOutline = manuscriptOutline(draft.markdown);
    const outlineRows = outline.length
      ? outline.map((item, index) => {
        const sourceLine = sourceOutline[index]?.lineIndex;
        const lineAttribute = Number.isSafeInteger(sourceLine) ? ` data-manuscript-outline-line="${escapeHtml(sourceLine)}"` : "";
        return `<button data-manuscript-outline-node="${escapeHtml(item.id)}"${lineAttribute} data-depth="${escapeHtml(item.level)}"><span class="outlineState" data-ready="true"></span><strong>${escapeHtml(item.text)}</strong></button>`;
      }).join("")
      : `<div class="manuscriptOutlineEmpty">Headings will appear here.</div>`;
    const bindings = draft.bindings.map(manuscriptBindingMarkup).join("") || `<div class="manuscriptNoBindings"><strong>No evidence bindings yet</strong><span>Insert a validated project artifact from a block margin.</span></div>`;
    const profileOptions = state.journalProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === state.selectedJournalProfileId ? "selected" : ""}>${escapeHtml(profile.journalName)} · ${escapeHtml(profile.articleType)} · v${escapeHtml(profile.currentVersion)}</option>`).join("");
    const latestTransaction = editorModel?.recentTransactions?.find((transaction) => transaction.resultVersion === manuscript.currentVersion) || null;
    const notice = state.manuscriptNotice ? `<div class="manuscriptVersionNotice undoStrip" role="status"><span>${heroIcon("table")} ${escapeHtml(state.manuscriptNotice)}</span>${editorModel?.canUndo && latestTransaction ? `<button data-action="undo-manuscript-transaction" data-transaction-id="${escapeHtml(latestTransaction.id)}">Undo</button>` : ""}</div>` : "";
    const error = state.manuscriptInsertError || state.manuscriptSelectionError || state.manuscriptSaveError;
    const evidenceCount = draft.bindings.length;
    const claimSummary = state.claimLedger ? `${state.claimLedger.counts.supported} supported · ${state.claimLedger.counts.unresolved} unresolved` : "No ledger for this exact version";
    return `<section class="manuscriptWorkspace">
      <header class="journalToolbar">
        <div class="manuscriptToolbarIdentity"><span>Manuscript</span><strong>${escapeHtml(manuscript.title)}</strong></div>
        <button class="journalTargetButton" data-action="open-journal-sheet">${escapeHtml(journalProfile?.journalName || "Choose target journal")} ${heroIcon("chevron-down")}</button>
        <!-- The tick means "these guidelines were actually read", not "a journal is selected".
             It used to appear whenever a profile existed, so the line read "Guidelines checked:
             not yet inspected ✓" -- a claim contradicting the words beside it. -->
        <span class="journalGuideline">가이드라인 검사: ${escapeHtml(guidelineInspectedAt)} ${guidelineInspectedOn ? `<em>✓</em>` : ""} · ${escapeHtml(lifecycleCompactLabel())}</span>
        <span class="journalMetric">단어 수: ${escapeHtml(wordCount.toLocaleString(state.locale === "ko" ? "ko-KR" : "en-US"))}</span>
        <span class="journalMetric">그림: ${escapeHtml(figureCount)}</span>
        <span class="journalMetric">참고문헌: ${escapeHtml(referenceCount)}</span>
        <span class="journalMetric">근거 연결: ${escapeHtml(evidenceCount)}</span>
        <button class="primaryButton journalSubmitButton" data-action="open-submission-sheet" ${!claimReady ? `disabled title="${escapeHtml(claimGateReason)}"` : ""}>${readiness.publicationReady ? "제출본 검사" : "초안 검사"}</button>${!claimReady ? `<span class="gateReason" role="status">${escapeHtml(claimGateReason)}</span>` : ""}
      </header>
      ${manuscriptReadinessMarkup(readiness)}
      <div class="manuscriptEditorToolbar manuscriptToolbar">
        <span class="visuallyHidden">Manuscript · immutable v${escapeHtml(manuscript.currentVersion)}</span>
        <div class="manuscriptViewSwitch segmentTrack" role="tablist" aria-label="Manuscript view"><button role="tab" data-manuscript-view="paper" aria-selected="${state.manuscriptView === "paper"}" aria-pressed="${state.manuscriptView === "paper"}">Block editor</button><button role="tab" data-manuscript-view="write" aria-selected="${state.manuscriptView === "write"}" aria-pressed="${state.manuscriptView === "write"}">Edit source</button><button role="tab" data-manuscript-view="preview" aria-selected="${state.manuscriptView === "preview"}" aria-pressed="${state.manuscriptView === "preview"}">${previewLabel}</button><button role="tab" data-manuscript-view="latex" aria-selected="${state.manuscriptView === "latex"}" aria-pressed="${state.manuscriptView === "latex"}">LaTeX</button></div>
        <div class="manuscriptStatus" data-manuscript-status data-state="${error ? "error" : "saved"}">v${escapeHtml(manuscript.currentVersion)} · ${escapeHtml(document?.documentSha256?.slice(0, 10) || draft.baseContentSha256.slice(0, 10))}…${error ? ` · ${escapeHtml(error)}` : " · saved"}</div>
        <div class="manuscriptToolbarActions"><button class="primaryButton manuscriptSaveButton" data-action="save-manuscript" ${!draft.dirty || state.manuscriptSaving ? "disabled" : ""}>${state.manuscriptSaving ? "Saving…" : draft.dirty ? "Save version" : "Saved"}</button><button class="secondaryButton" data-action="ask-manuscript-review">${heroIcon("sparkles")} Ask Science</button><button class="secondaryButton manuscriptInspectorToggle" data-action="toggle-manuscript-inspector" aria-controls="manuscript-submission-inspector" aria-pressed="${state.manuscriptInspectorOpen}">${heroIcon("book")} Checks</button><span class="manuscriptExportGroup" data-draft-export="${!readiness.publicationReady}"><button class="secondaryButton ghostButton" data-action="export-manuscript" data-format="pdf" ${state.manuscriptExportBusy ? "disabled" : ""}>${exportPrefix}PDF</button><button class="secondaryButton ghostButton" data-action="export-manuscript" data-format="docx" ${state.manuscriptExportBusy ? "disabled" : ""}>${exportPrefix}DOCX</button><button class="secondaryButton ghostButton" data-action="export-manuscript" data-format="latex" ${state.manuscriptExportBusy ? "disabled" : ""}>${state.manuscriptExportBusy === "latex" ? "Building…" : ".tex"}</button></span></div>
      </div>
      ${notice}
      <div class="manuscriptWorkGrid" data-inspector-open="${state.manuscriptInspectorOpen}" data-manuscript-view="${escapeHtml(state.manuscriptView)}">
        <aside class="manuscriptOutline" aria-label="Manuscript outline"><header><strong>Outline</strong><span>${escapeHtml(outline.length)} sections</span></header><nav>${outlineRows}</nav><footer><span>Stable blocks</span><strong>${escapeHtml(document?.nodes?.length || 0)}</strong></footer></aside>
        <div class="manuscriptCanvas">${canvas}</div>
        <button class="manuscriptInspectorScrim" type="button" data-action="toggle-manuscript-inspector" aria-label="Close manuscript checks"></button>
        <aside class="manuscriptInspector" id="manuscript-submission-inspector" aria-label="Submission readiness and evidence checks" tabindex="-1">
          <header><div><span>Manuscript checks</span><strong>Submission readiness</strong></div><button data-action="toggle-manuscript-inspector" aria-label="Close">×</button></header>
          ${manuscriptBlueprintAssessmentMarkup(blueprintAssessment, editorModel?.blueprint)}
          ${manuscriptScholarlyAssessmentMarkup(scholarlyAssessment)}
          <section><div class="manuscriptInspectorLabel">Claim &amp; evidence ledger</div><div class="journalValidationSummary" data-status="${claimReady ? "ready" : "blocked"}"><strong>${claimReady ? "ready" : "blocked"}</strong><span>${escapeHtml(claimSummary)}</span></div></section>
          <section class="journalProfileSection"><div class="manuscriptInspectorLabel">Target journal</div>${journalProfile ? `<label class="journalProfileSelect"><span>Profile</span><select data-journal-profile-select>${profileOptions}</select></label><div class="journalProfileProof"><strong>${escapeHtml(journalProfile.version.rules.length)} verified rules</strong><span>${escapeHtml(journalProfile.version.sources.map((source) => source.officialHost).join(", "))}</span></div><button class="primaryButton manuscriptSubmissionAction" data-action="open-submission-sheet">Review submission package</button>` : `<div class="journalEmpty"><strong>No target journal</strong><p>Pin the official journal rules before creating a submission package.</p><button class="primaryButton" data-action="open-journal-sheet">Choose journal</button></div>`}</section>
          <section><div class="manuscriptInspectorLabel">Evidence bindings</div><div class="manuscriptBindingList">${bindings}</div></section>
          <section class="manuscriptIntegrity"><div class="manuscriptInspectorLabel">Exact version</div><dl><div><dt>Content</dt><dd><code>${escapeHtml(draft.baseContentSha256.slice(0, 16))}…</code></dd></div><div><dt>Document</dt><dd><code>${escapeHtml(document?.documentSha256?.slice(0, 16) || "unavailable")}…</code></dd></div></dl></section>
        </aside>
      </div>
    </section>`;
  }

  async function openManuscriptInsertion(afterNodeId) {
    if (!state.selectedId || !state.manuscriptEditorModel || state.manuscriptInsertBusy) return;
    disposeManuscriptInsertion();
    state.manuscriptInsertion = { afterNodeId: afterNodeId || "", phase: "loading", candidates: [], selectedCandidateId: null, selectedArtifactId: null, caption: "", filter: "all", query: "" };
    state.manuscriptInsertError = "";
    render();
    const projectId = state.selectedId;
    const manuscriptId = state.selectedManuscriptId;
    try {
      const rows = await Promise.all(state.artifacts.map(async (artifact) => {
        const [context, receipts] = await Promise.all([
          science.artifacts.context(projectId, artifact.id, artifact.currentVersion),
          science.validations.list(projectId, artifact.id, artifact.currentVersion),
        ]);
        const paleontologyPayload = paleontologyArtifactPayload(context?.selectedVersion);
        const statisticsTableEntries = statisticsAnalysisTableEntries(context?.selectedVersion);
        const statisticsFigurePayload = context?.selectedVersion?.payload?.schema === "agentlas.science.statistics-figure-artifact/v1"
          ? context.selectedVersion.payload : null;
        // Materialized statistical source figures are emitted by their parent analysis candidate
        // above, where the parent/version/visualization link can be checked. Do not list the same
        // child a second time through the generic artifact branch.
        if (statisticsFigurePayload?.statisticsArtifact?.artifactId
          && state.artifacts.some((item) => item.id === statisticsFigurePayload.statisticsArtifact.artifactId)) return [];
        const role = manuscriptInsertionRole(artifact, context);
        if (!role && !paleontologyPayload && !statisticsTableEntries.length) return [];
        const exactReceipts = (Array.isArray(receipts) ? receipts : []).filter((item) => item.status === "verified"
          && item.artifactVersion === context?.selectedVersion?.version
          && item.artifactContentSha256 === context?.selectedVersion?.contentSha256);
        const receipt = exactReceipts[0] || null;
        if (!context || !receipt) return [];
        const candidates = [];
        if (role === "table") candidates.push({ candidateId: `${artifact.id}:table`, artifact, context, receipt, role, previewUrl: null, tablePayload: context.selectedVersion.payload, notes: [] });
        if (paleontologyPayload) {
          const tablePayload = paleontologyPublicationTablePayload(context.selectedVersion);
          if (!tablePayload) return [];
          candidates.push({ candidateId: `${artifact.id}:table`, artifact, context, receipt, role: "table", previewUrl: null, tablePayload, notes: tablePayload.notes });
        }
        if (statisticsTableEntries.length) {
          for (const entry of statisticsTableEntries) {
            candidates.push({
              candidateId: `${artifact.id}:table:${entry.tableIndex}`,
              artifact,
              context,
              receipt,
              role: "table",
              tableIndex: entry.tableIndex,
              sourceArtifactIndex: entry.index,
              previewUrl: null,
              tablePayload: entry.tablePayload,
              notes: entry.tablePayload.notes,
            });
          }
          // A statistics analysis keeps the source Vega figures nested in its result. Only expose
          // a figure here after the explicit materializer has created a child artifact with its own
          // exact capture and validation receipt; the raw spec is not a publication asset.
          if (science.artifacts?.listStatisticsFigures) {
            let savedFigures = [];
            try { savedFigures = await science.artifacts.listStatisticsFigures(projectId, artifact.id); } catch { savedFigures = []; }
            const analysisPayload = context.selectedVersion.payload;
            for (const figure of Array.isArray(savedFigures) ? savedFigures : []) {
              const figurePayload = figure?.version?.payload;
              const parent = figurePayload?.statisticsArtifact;
              const visualizationIndex = figurePayload?.visualization?.index;
              const sourceFigure = Number.isSafeInteger(visualizationIndex) ? analysisPayload.visualizations?.[visualizationIndex] : null;
              if (figure?.kind !== "chart.vega"
                || figurePayload?.schema !== "agentlas.science.statistics-figure-artifact/v1"
                || parent?.artifactId !== artifact.id
                || parent?.artifactVersion !== context.selectedVersion.version
                || parent?.contentSha256 !== context.selectedVersion.contentSha256
                || !sourceFigure) continue;
              const [figureContext, figureReceipts] = await Promise.all([
                science.artifacts.context(projectId, figure.id, figure.currentVersion),
                science.validations.list(projectId, figure.id, figure.currentVersion),
              ]);
              const figureExactReceipts = (Array.isArray(figureReceipts) ? figureReceipts : []).filter((item) => item.status === "verified"
                && item.artifactVersion === figureContext?.selectedVersion?.version
                && item.artifactContentSha256 === figureContext?.selectedVersion?.contentSha256);
              const figurePreview = figureContext ? await science.artifacts.preview(projectId, figure.id, figureContext.selectedVersion.version) : null;
              const figureReceipt = figureExactReceipts.find((item) => item.visualAssetSha256 && item.visualAssetSha256 === figurePreview?.sha256) || null;
              if (!figureContext || !figureReceipt || !figurePreview || figurePreview.contentSha256 !== figureContext.selectedVersion.contentSha256) continue;
              const previewUrl = URL.createObjectURL(new Blob([figurePreview.bytes], { type: figurePreview.mimeType || "image/png" }));
              candidates.push({
                candidateId: `${artifact.id}:source-figure:${visualizationIndex}:${figure.id}`,
                artifact: figure,
                context: figureContext,
                receipt: figureReceipt,
                role: "figure",
                previewUrl,
                tablePayload: null,
                notes: [],
                sourceFigure,
                sourceFigureIndex: visualizationIndex,
              });
            }
          }
          return candidates;
        }
        if (role === "table" && !paleontologyPayload) return candidates;
        const preview = await science.artifacts.preview(projectId, artifact.id, context.selectedVersion.version);
        const visualReceipt = exactReceipts.find((item) => item.visualAssetSha256 && item.visualAssetSha256 === preview?.sha256) || null;
        if (!preview || !visualReceipt || preview.contentSha256 !== context.selectedVersion.contentSha256) return candidates;
        const previewUrl = URL.createObjectURL(new Blob([preview.bytes], { type: preview.mimeType || "image/png" }));
        candidates.push({ candidateId: `${artifact.id}:figure`, artifact, context, receipt: visualReceipt, role: "figure", previewUrl, tablePayload: null, notes: paleontologyPayload?.analysis?.publicationTable?.notes || [] });
        return candidates;
      }));
      if (state.selectedId !== projectId || state.selectedManuscriptId !== manuscriptId || state.manuscriptInsertion?.afterNodeId !== (afterNodeId || "")) return;
      const sourceFigureCandidates = (Array.isArray(state.sourceFigures) ? state.sourceFigures : [])
        .filter((figure) => figure?.id && figure.projectId === projectId)
        .map((sourceFigure) => ({
          candidateId: `source-figure:${sourceFigure.id}`,
          sourceFigure,
          artifact: null,
          context: null,
          receipt: null,
          role: "figure",
          previewUrl: null,
          tablePayload: null,
          notes: [],
          insertable: false,
        }));
      state.manuscriptInsertion = { ...state.manuscriptInsertion, phase: "choose", candidates: [...rows.flat().filter(Boolean), ...sourceFigureCandidates] };
    } catch (error) {
      state.manuscriptInsertError = error instanceof Error ? error.message : String(error);
      if (state.manuscriptInsertion) state.manuscriptInsertion.phase = "choose";
    }
    render();
    requestAnimationFrame(() => document.querySelector(".manuscriptInsertPanel button:not([disabled])")?.focus());
  }

  async function insertValidatedManuscriptArtifact() {
    const insertion = state.manuscriptInsertion;
    const editorModel = state.manuscriptEditorModel;
    const manuscript = editorModel?.manuscript;
    const document = editorModel?.document;
    const candidate = insertion?.candidates?.find((item) => item.candidateId === insertion.selectedCandidateId)
      || insertion?.candidates?.find((item) => item.artifact?.id === insertion.selectedArtifactId);
    if (!insertion || !candidate || !manuscript || !document || !state.selectedId || state.manuscriptInsertBusy) return;
    if (candidate.insertable === false) {
      state.manuscriptInsertError = "This source figure is recognized, but atomic source-figure insertion is not available in the current backend contract.";
      render();
      return;
    }
    const afterNode = insertion.afterNodeId ? document.nodes.find((node) => node.id === insertion.afterNodeId) : null;
    if (insertion.afterNodeId && !afterNode) {
      state.manuscriptInsertError = "The insertion anchor changed. Reopen the margin action.";
      render();
      return;
    }
    state.manuscriptInsertBusy = true;
    state.manuscriptInsertError = "";
    render();
    try {
      const caption = String(insertion.caption || candidate.artifact.title).trim();
      const validation = await science.validations.validate({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        artifactId: candidate.artifact.id,
        artifactVersion: candidate.context.selectedVersion.version,
      });
      const bindingTarget = validation?.bindingTarget;
      if (!bindingTarget || bindingTarget.kind !== "artifact"
        || bindingTarget.artifactId !== candidate.artifact.id
        || bindingTarget.artifactVersion !== candidate.context.selectedVersion.version) {
        throw new Error("The verified artifact binding changed. Reopen the project evidence picker.");
      }
      const locatorBase = `${candidate.role}-${candidate.artifact.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
      // The backend manuscript asset resolver uses a #N suffix to select the Nth nested
      // statistics table. Preserve that selection in the immutable node locator; without it a
      // second table would render as the analysis default even though the picker showed another.
      const locator = Number.isSafeInteger(candidate.tableIndex) ? `${locatorBase}#${candidate.tableIndex}` : locatorBase;
      const result = await science.manuscripts.applyTransaction({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        manuscriptId: manuscript.id,
        expectedVersion: manuscript.currentVersion,
        expectedContentSha256: manuscript.version.contentSha256,
        expectedDocumentSha256: document.documentSha256,
        actor: "user",
        reason: `Insert validated project ${candidate.role} from manuscript margin`,
        operations: [{
          kind: "insert-artifact",
          nodeId: crypto.randomUUID(),
          nodeKind: candidate.role,
          locator,
          caption,
          validationReceiptId: bindingTarget.validationReceiptId,
          afterNodeId: afterNode?.id || null,
          expectedAfterNodeRevision: afterNode?.revision || null,
          expectedAfterNodeContentSha256: afterNode?.contentSha256 || null,
        }],
      });
      state.claimLedger = await science.claimLedgers.getForManuscript(state.selectedId, manuscript.id);
      await refreshManuscriptEditorWorkspace(`${candidate.role === "table" ? "Table" : "Figure"} inserted as immutable v${result.manuscript.currentVersion}`);
    } catch (error) {
      state.manuscriptInsertError = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.manuscriptInsertBusy = false;
      if (state.manuscriptInsertion) render();
    }
  }

  async function undoManuscriptTransaction(transactionId) {
    const editorModel = state.manuscriptEditorModel;
    const manuscript = editorModel?.manuscript;
    if (!transactionId || !state.selectedId || !manuscript || !editorModel?.document || state.manuscriptTransactionBusy) return;
    state.manuscriptTransactionBusy = true;
    try {
      const result = await science.manuscripts.revertTransaction({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        manuscriptId: manuscript.id,
        transactionId,
        expectedVersion: manuscript.currentVersion,
        expectedContentSha256: manuscript.version.contentSha256,
        expectedDocumentSha256: editorModel.document.documentSha256,
        actor: "user",
        reason: "Undo the latest manuscript block edit",
      });
      await refreshManuscriptEditorWorkspace(`Reverted as immutable v${result.manuscript.currentVersion}`);
    } catch (error) {
      state.manuscriptSaveError = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.manuscriptTransactionBusy = false;
    }
  }

  async function persistManuscriptSelection(target) {
    const editorModel = state.manuscriptEditorModel;
    const manuscript = editorModel?.manuscript;
    const node = editorModel?.document?.nodes?.find((item) => item.id === target.dataset.nodeId);
    if (!state.selectedId || !manuscript || !editorModel?.document || !node || state.manuscriptSelectionBusy) return;
    state.manuscriptSelectionBusy = true;
    state.manuscriptSelectionError = "";
    target.disabled = true;
    try {
      const result = await science.manuscripts.createSelectionContext({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        manuscriptId: manuscript.id,
        expectedVersion: manuscript.currentVersion,
        expectedContentSha256: manuscript.version.contentSha256,
        expectedDocumentSha256: editorModel.document.documentSha256,
        nodeId: node.id,
        expectedNodeRevision: node.revision,
        expectedNodeContentSha256: node.contentSha256,
        startOffset: Number(target.dataset.startOffset),
        endOffset: Number(target.dataset.endOffset),
        selectedText: target.dataset.selectedText || "",
      });
      state.manuscriptSelectionContext = result.selectionContext;
      state.manuscriptSelectionContexts = [result.selectionContext, ...state.manuscriptSelectionContexts.filter((item) => item.id !== result.selectionContext.id)];
      state.composerDraft = "";
      renderChatDock();
      target.remove();
      requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
    } catch (error) {
      state.manuscriptSelectionError = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.manuscriptSelectionBusy = false;
    }
  }

  async function decideManuscriptProposal(proposalId, decision) {
    const proposal = state.manuscriptEditProposals.find((item) => item.id === proposalId);
    if (!proposal || !state.selectedId || !state.manuscriptEditorModel || state.manuscriptProposalBusy) return;
    state.manuscriptProposalBusy = proposal.id;
    renderChatDock();
    try {
      if (decision === "apply") {
        const result = await science.manuscripts.applyEditProposal({
          requestId: crypto.randomUUID(),
          projectId: state.selectedId,
          manuscriptId: proposal.manuscriptId,
          proposalId: proposal.id,
          expectedVersion: proposal.baseVersion,
          expectedContentSha256: proposal.baseContentSha256,
          expectedDocumentSha256: proposal.baseDocumentSha256,
        });
        await refreshManuscriptEditorWorkspace(`Science edit applied as immutable v${result.manuscript.currentVersion}`);
      } else {
        await science.manuscripts.rejectEditProposal({ requestId: crypto.randomUUID(), projectId: state.selectedId, manuscriptId: proposal.manuscriptId, proposalId: proposal.id, reason: "Rejected in manuscript review" });
        await refreshManuscriptEditorWorkspace("Science edit rejected");
      }
    } catch (error) {
      state.composerError = error instanceof Error ? error.message : String(error);
      try { await refreshManuscriptEditorWorkspace(); } catch { render(); }
    } finally {
      state.manuscriptProposalBusy = null;
      renderChatDock();
    }
  }

  function prepareStaleProposalRegeneration(proposalId) {
    const proposal = state.manuscriptEditProposals.find((item) => item.id === proposalId);
    if (!proposal) return;
    const selection = proposal.selectionContextIds.map((id) => state.manuscriptSelectionContexts.find((item) => item.id === id)).find(Boolean) || null;
    state.manuscriptSelectionContext = selection?.manuscriptVersion === state.manuscriptEditorModel?.manuscript?.currentVersion ? selection : null;
    state.composerDraft = `Regenerate the stale manuscript edit against the current exact version. Preserve the intent: ${proposal.summary}. Re-check the selected block and return a new persisted proposal for review.`;
    renderChatDock();
    requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
  }

  async function saveManuscriptDraft() {
    const manuscript = manuscriptById(state.selectedManuscriptId);
    const draft = state.manuscriptDraft;
    if (!manuscript || !draft || !draft.dirty || state.manuscriptSaving) return;
    state.manuscriptSaving = true;
    state.manuscriptSaveError = "";
    render();
    let saved;
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
      saved = result.manuscript;
    } catch (error) {
      state.manuscriptSaving = false;
      state.manuscriptSaveError = error instanceof Error ? error.message : String(error);
      render();
      return;
    }
    state.manuscripts = [saved, ...state.manuscripts.filter((item) => item.id !== saved.id)];
    state.manuscriptDraft = manuscriptDraftFrom(saved);
    state.claimLedger = null;
    try { state.claimLedger = await science.claimLedgers.getForManuscript(state.selectedId, saved.id); }
    catch { state.claimLedger = null; }
    state.manuscriptSaving = false;
    ensureManuscriptWorkspaceTab(saved);
    // Reload the immutable document model after a source save. The block
    // editor, outline, checks, and artifact bindings must all point at the
    // same version/hash as the source textarea that was just persisted.
    try {
      await refreshManuscriptEditorWorkspace(`Saved as immutable v${saved.currentVersion}`);
    } catch (error) {
      state.manuscriptSaveError = `Saved immutable v${saved.currentVersion}, but the editor could not refresh: ${error instanceof Error ? error.message : String(error)}`;
      render();
    }
    void queueWorkspacePersistence();
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
      if (!target || target.kind !== "artifact"
        || target.artifactId !== artifact.id
        || target.artifactVersion !== artifact.version.version
        || !target.captureId
        || !target.validationReceiptId) {
        throw new Error("검증된 원고 binding target을 만들지 못했습니다.");
      }
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
      const editorModel = state.manuscriptEditorModel;
      const manuscript = editorModel?.manuscript;
      const document = editorModel?.document;
      if (!manuscript || manuscript.id !== activeManuscript.id || !document) throw new Error("원고 편집 모델을 열지 못했습니다.");
      const duplicate = manuscript.version.bindings.some((binding) => binding.target.kind === "artifact"
        && binding.target.artifactId === target.artifactId
        && binding.target.artifactVersion === target.artifactVersion);
      if (duplicate) {
        state.manuscriptNotice = `${role === "table" ? "Table" : "Figure"} artifact is already linked to this manuscript version.`;
        state.artifactBindingBusy = false;
        render();
        return;
      }
      const roleCount = manuscript.version.bindings.filter((binding) => binding.role === role).length + 1;
      const locator = `${role === "table" ? "Table" : "Figure"} ${roleCount}`;
      const afterNode = document.nodes.at(-1) || null;
      const caption = String(artifact.version.semantic?.summary || artifact.title || "Verified project evidence")
        .replace(/\s+/gu, " ").trim().slice(0, 500);
      const result = await science.manuscripts.applyTransaction({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        manuscriptId: manuscript.id,
        expectedVersion: manuscript.currentVersion,
        expectedContentSha256: manuscript.version.contentSha256,
        expectedDocumentSha256: document.documentSha256,
        actor: "user",
        reason: `Connect verified project ${role} from Lab to manuscript`,
        operations: [{
          kind: "insert-artifact",
          nodeId: crypto.randomUUID(),
          nodeKind: role,
          locator,
          caption,
          validationReceiptId: target.validationReceiptId,
          afterNodeId: afterNode?.id || null,
          expectedAfterNodeRevision: afterNode?.revision || null,
          expectedAfterNodeContentSha256: afterNode?.contentSha256 || null,
        }],
      });
      state.claimLedger = await science.claimLedgers.getForManuscript(state.selectedId, manuscript.id);
      await refreshManuscriptEditorWorkspace(`${role === "table" ? "Table" : "Figure"} connected as immutable v${result.manuscript.currentVersion}`);
      state.artifactBindingBusy = false;
    } catch (error) {
      state.artifactBindingBusy = false;
      state.artifactBindingError = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  async function openLab(labId, artifactId, originVersion = null, returnMessageId = null, exactVersion = null) {
    rememberScroll();
    state.labDecisionActionError = "";
    // The analysis catalogue is what the statistics launch screen offers. Fetch it when that Lab is
    // opened rather than on every render, and once per session: it changes only when the plugin does.
    if (labId === "statistics-analysis") void loadStatisticsMethodCatalogue();
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
    // Opening an artifact leaves the launch card. Without this, asking for a new analysis and then
    // clicking a saved one did nothing at all: the launch card kept rendering over the artifact the
    // researcher had just chosen, and the only way back was a button at the bottom of the form.
    state.statisticsLaunchOpen = false;
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

  async function runLabDecisionPrimary(projectionSha256) {
    if (!state.selectedId || state.labDecisionActionBusy) return;
    const clicked = state.labDecisionProjections.find((projection) => projection?.projectionSha256 === projectionSha256);
    if (!clicked || clicked.labId !== state.selectedLabId) {
      state.labDecisionActionError = "현재 Lab 결정 근거가 바뀌었습니다. 최신 상태를 다시 불러와 주세요.";
      render();
      return;
    }
    state.labDecisionActionBusy = true;
    state.labDecisionActionError = "";
    render();
    try {
      const rows = await science.labs.decisionProjections(state.selectedId);
      const latest = Array.isArray(rows) ? rows.find((projection) => projection?.labId === clicked.labId) : null;
      if (!latest) throw new Error("현재 프로젝트의 Lab 결정 근거를 찾지 못했습니다.");
      state.labDecisionProjections = rows;
      if (latest.projectionSha256 !== clicked.projectionSha256
        || latest.basis?.basisSha256 !== clicked.basis?.basisSha256
        || latest.action?.basisSha256 !== clicked.action?.basisSha256) {
        throw new Error("프로젝트·계획·결과 중 하나가 변경되었습니다. 갱신된 질문과 다음 동작을 확인해 주세요.");
      }
      if (latest.action?.enabled !== true) throw new Error("현재 근거에서는 이 동작을 실행할 수 없습니다.");
      if (latest.action.kind === "review-result") {
        const episodeId = latest.basis?.episode?.id;
        if (!episodeId || !science.resultReviews?.inspect) throw new Error("정확한 에피소드 결과 검토 런타임이 없습니다.");
        const inspection = await science.resultReviews.inspect({
          projectId: state.selectedId,
          labId: latest.labId,
          episodeId,
          expectedProjectionSha256: latest.projectionSha256,
        });
        if (!inspection || inspection.project?.id !== state.selectedId || inspection.episode?.id !== episodeId
          || inspection.projectContentSha256 !== latest.basis?.project?.contentSha256
          || inspection.projectionSha256 !== latest.projectionSha256 || inspection.basisSha256 !== latest.basis?.basisSha256
          || inspection.episode?.result?.resultSha256 !== latest.basis?.episode?.resultSha256) {
          throw new Error("결과 검토 read-back이 현재 Lab 결정 근거와 일치하지 않습니다.");
        }
        const exactArtifact = latest.basis?.artifacts?.length === 1 ? latest.basis.artifacts[0] : null;
        if (exactArtifact) {
          const context = await science.artifacts.context(state.selectedId, exactArtifact.artifactId, exactArtifact.artifactVersion);
          if (!context || context.selectedVersion?.contentSha256 !== exactArtifact.contentSha256 || context.linkage?.labId !== latest.labId) {
            throw new Error("결과 아티팩트의 exact version 또는 content hash가 변경되었습니다.");
          }
          if (state.selectedArtifactId !== exactArtifact.artifactId || state.mode !== "lab") {
            await openLab(latest.labId, exactArtifact.artifactId, null, null, exactArtifact.artifactVersion);
          }
        }
        state.evidenceGraphReviewSheet = false;
        state.researchContractSheet = false;
        state.journalSheet = false;
        state.submissionSheet = false;
        state.resultReviewInspection = inspection;
        state.resultReviewSheet = true;
        state.resultReviewStale = false;
        state.resultReviewError = "";
        state.resultReviewOpener = latest.projectionSha256;
        state.resultReviewDraft = { verdict: "", trigger: "", rationale: "" };
        if (state.activeRendererInstance && state.activeRendererVisible !== false && science.renderers?.visibility) {
          state.activeRendererVisible = false;
          await science.renderers.visibility(false);
        }
        render();
        requestAnimationFrame(() => document.querySelector(".episodeResultReviewSheet")?.focus({ preventScroll: true }));
        return;
      }
      const destination = latest.action.destination;
      if (latest.action.kind === "refresh-stale-projection") {
        state.composerDraft = `현재 ${labCapabilityLabel(latest.labId)}의 입력 아티팩트 버전이 변경되었습니다. 변경된 exact version을 기준으로 같은 분석을 다시 실행하고 새 결과를 저장해 주세요.`;
        renderChatDock();
        requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
        return;
      }
      if (latest.action.kind === "open-superseding-context") {
        await selectProject(state.selectedId, { preserveWorkspace: true });
        await openLab(latest.labId, null, null, null);
        return;
      }
      if (destination?.kind === "artifact") {
        if (!destination.id || !Number.isSafeInteger(destination.exactVersion) || !destination.exactContentSha256) {
          throw new Error("정확한 결과 버전이 없어 아티팩트를 열지 않았습니다.");
        }
        const context = await science.artifacts.context(state.selectedId, destination.id, destination.exactVersion);
        if (!context || context.projectId !== state.selectedId
          || context.selectedVersion?.version !== destination.exactVersion
          || context.selectedVersion?.contentSha256 !== destination.exactContentSha256) {
          throw new Error("결과 아티팩트의 exact version 또는 content hash가 변경되었습니다.");
        }
        if (state.selectedArtifactId === destination.id && state.mode === "lab") {
          state.drawer = { kind: "artifact", id: destination.id };
          render();
        } else {
          await openLab(context.linkage.labId, destination.id, null, null, destination.exactVersion);
        }
        return;
      }
      if (destination?.kind === "human-decision") {
        if (!destination.id || !destination.exactContentSha256) throw new Error("정확한 연구 결정 바인딩이 없습니다.");
        let decision = await science.decisions.get(state.selectedId, destination.id);
        if (!decision || decision.proposalSha256 !== destination.exactContentSha256) {
          throw new Error("연구 결정 질문의 content hash가 변경되었습니다.");
        }
        if (["queued", "deferred"].includes(decision.status)) {
          const result = await science.decisions.present({
            requestId: crypto.randomUUID(), projectId: state.selectedId, decisionId: decision.id, expectedLockVersion: decision.lockVersion,
          });
          decision = result?.decision;
        }
        if (!decision || decision.status !== "presented") throw new Error("현재 상태에서는 이 연구 결정을 열 수 없습니다.");
        state.decisions = [decision, ...state.decisions.filter((item) => item.id !== decision.id)];
        state.lifecycle = await science.researchLifecycle.get(state.selectedId);
        render();
        requestAnimationFrame(() => document.getElementById("research-decision-form")?.focus());
        return;
      }
      if (destination?.kind === "analysis-plan") {
        const plan = destination.id ? await science.analysisSpecs.get(state.selectedId, destination.id) : null;
        if (!plan || plan.currentVersion !== destination.exactVersion || plan.currentDocumentSha256 !== destination.exactContentSha256) {
          throw new Error("승인된 분석계획의 exact version 또는 content hash가 변경되었습니다.");
        }
        state.analysisSpecs = [plan, ...state.analysisSpecs.filter((item) => item.id !== plan.id)];
        state.selectedAnalysisPlanId = plan.id;
        state.currentDestination = "plan-protocols";
        state.activeWorkspaceTabId = RESEARCH_TAB_ID;
        state.mode = "session";
        render();
        void queueWorkspacePersistence();
        return;
      }
      if (destination?.kind === "manuscript") {
        const manuscript = destination.id ? manuscriptById(destination.id) : null;
        if (!manuscript) throw new Error("정확히 연결된 원고가 없습니다.");
        await openManuscript(manuscript.id);
        return;
      }
      if (destination?.kind === "lab") {
        if (latest.action.kind === "open-required-input") {
          if (latest.labId === "data-table") {
            await importCsvDataset();
            return;
          }
          if (latest.labId === "statistics-analysis") {
            // Canonical Science artifacts use kind="table". dataset.table is the
            // materialization operation name, not a persisted artifact kind.
            const source = state.artifacts.find((artifact) => artifact.kind === "table" && artifact.version?.rendererId === "agentlas.table");
            if (!source) {
              await openLab("data-table", null, null, null);
              return;
            }
            render();
            requestAnimationFrame(() => document.querySelector("[data-statistics-source-artifact]")?.focus());
            return;
          }
          state.composerDraft = `현재 연구 질문 “${latest.currentDecision}”에 답하려면 ${labCapabilityLabel(latest.labId)}에 어떤 exact 입력이 필요한지 확인하고, 부족한 입력만 질문해 주세요.`;
          renderChatDock();
          requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
          return;
        }
        await openLab(destination.id || latest.labId, null, null, null);
        return;
      }
      throw new Error("이 결정의 다음 목적지가 아직 제품 화면에 연결되지 않았습니다.");
    } catch (error) {
      state.labDecisionActionError = error instanceof Error ? error.message : String(error);
    } finally {
      state.labDecisionActionBusy = false;
      render();
    }
  }

  function closeResultReviewSheet({ restoreFocus = true } = {}) {
    const opener = state.resultReviewOpener;
    state.resultReviewSheet = false;
    state.resultReviewInspection = null;
    state.resultReviewBusy = false;
    state.resultReviewError = "";
    state.resultReviewStale = false;
    state.resultReviewOpener = null;
    state.resultReviewDraft = { verdict: "", trigger: "", rationale: "" };
    render();
    if (restoreFocus) requestAnimationFrame(() => {
      const selector = opener
        ? `[data-action="lab-decision-primary"][data-lab-decision-sha256="${CSS.escape(opener)}"]`
        : '[data-action="lab-decision-primary"]';
      document.querySelector(selector)?.focus({ preventScroll: true });
    });
  }

  async function reloadResultReviewSheet() {
    const current = state.resultReviewInspection;
    if (!current || !state.selectedId || state.resultReviewBusy) return;
    const projectId = state.selectedId;
    const labId = current.labId;
    state.resultReviewBusy = true;
    state.resultReviewError = "";
    render();
    try {
      const rows = await science.labs.decisionProjections(projectId);
      if (projectId !== state.selectedId) return;
      state.labDecisionProjections = Array.isArray(rows) ? rows : [];
      const latest = state.labDecisionProjections.find((projection) => projection?.labId === labId) || null;
      if (!latest || latest.action?.kind !== "review-result" || !latest.basis?.episode?.id) {
        state.labDecisionActionError = "연구 상태가 다음 단계로 이동했습니다. 최신 Lab 결정을 확인해 주세요.";
        closeResultReviewSheet();
        return;
      }
      const inspection = await science.resultReviews.inspect({
        projectId,
        labId,
        episodeId: latest.basis.episode.id,
        expectedProjectionSha256: latest.projectionSha256,
      });
      if (!inspection || inspection.project?.id !== projectId || inspection.labId !== labId
        || inspection.episode?.id !== latest.basis.episode.id
        || inspection.projectContentSha256 !== latest.basis.project?.contentSha256
        || inspection.projectionSha256 !== latest.projectionSha256
        || inspection.basisSha256 !== latest.basis.basisSha256) {
        throw new Error("최신 결과 검토 read-back이 Lab 결정 근거와 일치하지 않습니다.");
      }
      state.resultReviewInspection = inspection;
      state.resultReviewOpener = latest.projectionSha256;
      state.resultReviewStale = false;
      if (!inspection.availableActions.some((action) => action.trigger === state.resultReviewDraft.trigger)) {
        state.resultReviewDraft.trigger = "";
      }
    } catch (error) {
      state.resultReviewStale = true;
      state.resultReviewError = error instanceof Error ? error.message : String(error);
    } finally {
      state.resultReviewBusy = false;
      render();
      requestAnimationFrame(() => document.querySelector(state.resultReviewStale ? ".resultReviewStale" : ".episodeResultReviewSheet")?.focus({ preventScroll: true }));
    }
  }

  async function submitEpisodeResultReview(formNode) {
    const inspection = state.resultReviewInspection;
    if (!inspection?.episode?.result || !state.selectedId || state.resultReviewBusy || state.resultReviewStale) return;
    const form = new FormData(formNode);
    const verdict = String(form.get("verdict") || "");
    const selectedNextTrigger = String(form.get("selectedNextTrigger") || "");
    const rationale = String(form.get("rationale") || "").trim();
    state.resultReviewDraft = { verdict, trigger: selectedNextTrigger, rationale };
    if (!['accepted', 'rejected'].includes(verdict)) {
      state.resultReviewError = "결과를 수락할지 반려할지 선택해 주세요.";
      render();
      requestAnimationFrame(() => document.querySelector('#episode-result-review-form input[name="verdict"]')?.focus());
      return;
    }
    if (!inspection.availableActions.some((action) => action.trigger === selectedNextTrigger)) {
      state.resultReviewError = "현재 결과에 정확히 연결된 다음 동작을 하나 선택해 주세요.";
      render();
      requestAnimationFrame(() => document.querySelector('#episode-result-review-form input[name="selectedNextTrigger"]')?.focus());
      return;
    }
    if (!rationale) {
      state.resultReviewError = "이 결과가 다음 동작으로 이어져야 하는 근거를 기록해 주세요.";
      render();
      requestAnimationFrame(() => document.querySelector('#episode-result-review-form textarea[name="rationale"]')?.focus());
      return;
    }
    const projectId = inspection.project.id;
    const requestId = crypto.randomUUID();
    const expectedReceipt = inspection.latestReceipt;
    state.resultReviewBusy = true;
    state.resultReviewError = "";
    render();
    let recordedReceipt = null;
    try {
      const result = await science.resultReviews.record({
        requestId,
        projectId,
        loopSessionId: inspection.session.id,
        episodeId: inspection.episode.id,
        labId: inspection.labId,
        expectedProjectVersion: inspection.project.version,
        expectedProjectContentSha256: inspection.projectContentSha256,
        expectedLoopVersion: inspection.session.version,
        expectedLoopStateSha256: inspection.session.stateSha256,
        expectedEpisodeVersion: inspection.episode.version,
        expectedEpisodeStateSha256: inspection.episode.stateSha256,
        expectedResultSha256: inspection.episode.result.resultSha256,
        expectedBasisSha256: inspection.basisSha256,
        expectedProjectionSha256: inspection.projectionSha256,
        expectedReviewRevision: expectedReceipt?.revision || 0,
        expectedReviewSha256: expectedReceipt?.reviewSha256 || null,
        verdict,
        rationale,
        selectedNextTrigger,
      });
      if (!result || result.outcome === "refresh-required") {
        state.resultReviewInspection = result?.inspection || inspection;
        state.resultReviewStale = true;
        state.resultReviewError = result?.reason || "저장 직전에 연구 상태가 변경되었습니다. 자동 저장하지 않았습니다.";
        return;
      }
      if (result.outcome !== "recorded" || !result.receipt || result.receipt.requestId !== requestId) {
        throw new Error("결과 검토 저장 응답이 요청과 일치하지 않습니다.");
      }
      recordedReceipt = result.receipt;
      const [readback, rows] = await Promise.all([
        science.resultReviews.inspect({
          projectId,
          labId: inspection.labId,
          episodeId: inspection.episode.id,
          expectedProjectionSha256: inspection.projectionSha256,
        }),
        science.labs.decisionProjections(projectId),
      ]);
      if (projectId !== state.selectedId) return;
      if (readback?.latestReceipt?.id !== recordedReceipt.id
        || readback.latestReceipt.reviewSha256 !== recordedReceipt.reviewSha256) {
        throw new Error("저장된 결과 검토 receipt를 다시 읽어 확인하지 못했습니다.");
      }
      state.labDecisionProjections = Array.isArray(rows) ? rows : [];
      const nextProjection = state.labDecisionProjections.find((projection) => projection?.labId === inspection.labId) || null;
      if (!nextProjection || nextProjection.action?.kind !== "follow-intent-next-action"
        || nextProjection.action?.trigger !== recordedReceipt.selectedNextTrigger
        || nextProjection.action?.basisSha256 !== inspection.basisSha256) {
        throw new Error("저장된 선택이 단일 다음 행동 projection에 반영되지 않았습니다.");
      }
      const focusSha = nextProjection.projectionSha256;
      closeResultReviewSheet({ restoreFocus: false });
      requestAnimationFrame(() => document.querySelector(`[data-action="lab-decision-primary"][data-lab-decision-sha256="${CSS.escape(focusSha)}"]`)?.focus({ preventScroll: true }));
    } catch (error) {
      state.resultReviewStale = Boolean(recordedReceipt);
      state.resultReviewError = recordedReceipt
        ? `검토 receipt는 저장됐지만 최신 화면 연결을 확인하지 못했습니다. 새로고침 후 receipt ${recordedReceipt.reviewSha256.slice(0, 12)}…를 확인해 주세요.`
        : error instanceof Error ? error.message : String(error);
    } finally {
      state.resultReviewBusy = false;
      if (state.resultReviewSheet) {
        render();
        requestAnimationFrame(() => document.querySelector(state.resultReviewStale ? ".resultReviewStale" : ".episodeResultReviewSheet")?.focus({ preventScroll: true }));
      }
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

  /** Whether this lab already holds analyses -- if it does, the launch card needs a way back. */
  function labHasStatisticsArtifacts() {
    return (state.labContextsById.get("statistics-analysis") || []).length > 0;
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
    const entry = statisticsMethodEntry(state.statisticsLaunchMethod);
    const sourceOptions = tables.map((table) => `<option value="${escapeHtml(table.id)}" ${table.id === artifact?.id ? "selected" : ""}>${escapeHtml(table.title)} · v${escapeHtml(table.currentVersion)}</option>`).join("");
    const methods = statisticsLaunchableMethods();
    const byFamily = new Map();
    for (const method of methods) {
      const group = byFamily.get(method.family) || [];
      group.push(method);
      byFamily.set(method.family, group);
    }
    const methodOptions = [...byFamily.entries()]
      .map(([family, group]) => `<optgroup label="${escapeHtml(family)}">${group.map((item) => `<option value="${escapeHtml(item.method)}" ${item.method === state.statisticsLaunchMethod ? "selected" : ""}>${escapeHtml(item.method.replaceAll("_", " "))}</option>`).join("")}</optgroup>`)
      .join("");
    const kaplanMeier = state.statisticsLaunchMethod === "kaplan_meier";
    const timeOptions = timeColumns.map((column) => `<option value="${escapeHtml(column.name)}" ${column.name === state.statisticsLaunchTimeColumn ? "selected" : ""}>${escapeHtml(column.name)} · ${escapeHtml(column.logicalType)}</option>`).join("");
    const eventOptions = eventColumns.map((column) => `<option value="${escapeHtml(column.name)}" ${column.name === state.statisticsLaunchEventColumn ? "selected" : ""}>${escapeHtml(column.name)} · ${escapeHtml(column.logicalType)}</option>`).join("");
    const columnControls = kaplanMeier
      ? `<label class="field"><span>Time column</span><select data-statistics-time-column>${timeOptions}</select></label><label class="field"><span>Event column · 0/1</span><select data-statistics-event-column>${eventOptions}</select></label>`
      : statisticsMappingControls(entry, columns);
    const exactSource = Boolean(artifact && typeof artifact.id === "string" && artifact.id.length > 0 && artifact.id.length <= 160
      && Number.isSafeInteger(artifact.currentVersion) && artifact.currentVersion === artifact.version?.version
      && /^[a-f0-9]{64}$/u.test(String(artifact.version?.contentSha256 || "")));
    const ready = exactSource && (kaplanMeier
      ? (timeColumns.some((column) => column.name === state.statisticsLaunchTimeColumn)
        && eventColumns.some((column) => column.name === state.statisticsLaunchEventColumn)
        && state.statisticsLaunchTimeColumn !== state.statisticsLaunchEventColumn)
      : statisticsMappingReady(entry));
    const status = state.statisticsLaunchBusy
      ? `Research Director가 ${artifact?.title || "Data Table"} exact v${artifact?.currentVersion || ""} 실행을 요청하는 중입니다.`
      : "요청이 시작된 뒤에도 성공으로 표시하지 않습니다. 검증된 artifact가 도착하면 이 Lab에 별도 탭으로 열립니다.";
    // The method's own sentence about when it is the right choice. A researcher picks by question,
    // not by remembering a name, and that sentence lives beside the method in the engine so it can
    // never describe a method it no longer matches.
    const guidance = entry?.neededWhen
      ? `<p class="statisticsMethodGuidance">${escapeHtml(entry.neededWhen)}</p>`
      : `<p class="statisticsMethodGuidance" data-empty="true">이 분석에는 아직 선택 안내 문장이 없습니다.</p>`;
    return `<section class="emptyView labStartView" data-empty-source="science.sqlite" data-statistics-launch><div class="labStartCard statisticsLaunchCard"><span class="researchKicker">Data & Statistics · ${escapeHtml(lifecycleLabel())}</span><strong>검증된 Data Table에서 분석을 실행합니다.</strong><p>선택한 immutable table version의 열을 Main runtime이 그 분석이 선언한 모양으로 직접 투영합니다. UI나 연구 에이전트가 임의 데이터를 만들지 않습니다.</p><div class="statisticsLaunchGrid"><label class="field statisticsSourceField"><span>Source Data Table</span><select data-statistics-source-artifact>${sourceOptions}</select></label><label class="field statisticsMethodField"><span><span class="fieldLabelText">분석 종류</span> · ${escapeHtml(methods.length)}</span><input type="search" data-statistics-method-search placeholder="질문이나 이름으로 찾기" value="${escapeHtml(state.statisticsMethodQuery)}"><select data-statistics-method>${methodOptions}</select></label></div>${guidance}<div class="statisticsLaunchGrid statisticsMappingGrid">${columnControls}</div><dl class="statisticsLaunchReceipt"><div><dt>Artifact</dt><dd><code title="${escapeHtml(artifact?.id || "")}">${escapeHtml(String(artifact?.id || "").slice(0, 16))}…</code></dd></div><div><dt>Version</dt><dd>v${escapeHtml(artifact?.currentVersion || "")} · immutable</dd></div><div><dt>Content</dt><dd><code title="${escapeHtml(artifact?.version?.contentSha256 || "")}">${escapeHtml(String(artifact?.version?.contentSha256 || "").slice(0, 16))}…</code></dd></div></dl><button class="primaryButton" data-action="request-statistics-run" ${!ready || state.statisticsLaunchBusy ? "disabled" : ""}>${state.statisticsLaunchBusy ? "Exact version 실행 요청 중…" : "Research Director에게 exact run 요청"}</button><p class="statisticsLaunchStatus">${escapeHtml(status)}</p>${labHasStatisticsArtifacts() ? `<button class="secondaryButton" data-action="close-statistics-launch">저장된 분석으로 돌아가기</button>` : ""}${state.statisticsLaunchError ? `<p class="labStartError" role="alert">${escapeHtml(state.statisticsLaunchError)}</p>` : ""}</div></section>`;
  }

  /**
   * Asks the Research Director to run the chosen analysis against the exact table version.
   *
   * The request names the artifact by id, version and content hash, and the projection by the
   * columns the researcher mapped. It carries no `data`: the numbers are read from the immutable
   * artifact by the runtime, never transcribed here or by the agent. That was already true for
   * Kaplan-Meier, which had the only projection anyone had written; it is now true for every method
   * the engine declares a data shape for.
   */
  async function requestSourceBoundAnalysis() {
    if (state.statisticsLaunchBusy || !state.selectedId) return;
    normalizeStatisticsLaunchSelection();
    const artifact = statisticsSourceTable();
    const columns = statisticsEligibleColumns(artifact);
    const artifactVersion = Number(artifact?.currentVersion);
    const contentSha256 = String(artifact?.version?.contentSha256 || "");
    const method = state.statisticsLaunchMethod;
    const entry = statisticsMethodEntry(method);
    const exactSource = artifact && artifact.kind === "table" && artifact.version?.payload?.schema === "agentlas.science-table/v1"
      && typeof artifact.id === "string" && artifact.id.length >= 1 && artifact.id.length <= 160
      && Number.isSafeInteger(artifactVersion) && artifactVersion >= 1 && artifact.version?.version === artifactVersion
      && /^[a-f0-9]{64}$/u.test(contentSha256);
    if (!exactSource) {
      state.statisticsLaunchError = "정확한 Data Table ID·version·content hash를 확인해야 실행할 수 있습니다.";
      render();
      return;
    }
    const inputArtifact = { artifact_id: artifact.id, artifact_version: artifactVersion, content_sha256: contentSha256 };
    let sourceTable = null;
    if (method === "kaplan_meier") {
      const timeColumn = columns.find((column) => column.name === state.statisticsLaunchTimeColumn && ["integer", "number"].includes(column.logicalType));
      const eventColumn = columns.find((column) => column.name === state.statisticsLaunchEventColumn);
      if (!timeColumn || !eventColumn || timeColumn.name === eventColumn.name) {
        state.statisticsLaunchError = "서로 다른 time/event 열을 모두 선택해야 합니다.";
        render();
        return;
      }
      sourceTable = { ...inputArtifact, time_column: timeColumn.name, event_column: eventColumn.name, label: String(artifact.title || "Kaplan-Meier").slice(0, 128) };
    } else {
      if (!entry || !statisticsMappingReady(entry)) {
        state.statisticsLaunchError = "이 분석이 요구하는 열을 모두 지정해야 합니다.";
        render();
        return;
      }
      // Only properties the researcher actually mapped are sent. An optional property left blank is
      // absent from the request rather than present and empty, which the runtime would refuse.
      const mapping = {};
      for (const property of entry.dataProperties) {
        const current = state.statisticsLaunchMapping[property.property];
        if (!current) continue;
        if (property.accepts === "column" && current.column) mapping[property.property] = { column: current.column };
        if (property.accepts === "columns-or-long") {
          if ((current.columns || []).length) mapping[property.property] = { columns: [...current.columns] };
          else if (current.nameColumn && current.valueColumn) mapping[property.property] = { nameColumn: current.nameColumn, valueColumn: current.valueColumn };
        }
        if (property.accepts === "choice-list" && (current.choices || []).length) {
          mapping[property.property] = { choices: [...current.choices] };
        }
        if (property.accepts === "grouped-columns" && current.nameColumn && current.valueColumns && Object.keys(current.valueColumns).length) {
          mapping[property.property] = { nameColumn: current.nameColumn, valueColumns: { ...current.valueColumns } };
        }
        if (property.accepts === "row-columns" && current.rowColumns && Object.keys(current.rowColumns).length) {
          const rowColumns = {};
          for (const [field, column] of Object.entries(current.rowColumns)) if (column) rowColumns[field] = column;
          if (Object.keys(rowColumns).length) mapping[property.property] = { rowColumns };
        }
        if (property.accepts === "value" && current.value !== undefined && String(current.value).length) {
          const numeric = Number(current.value);
          mapping[property.property] = { value: Number.isFinite(numeric) && String(numeric) === String(current.value).trim() ? numeric : String(current.value) };
        }
      }
      sourceTable = { ...inputArtifact, method, projection_kind: "declared-columns", columns: mapping };
    }
    const toolRequest = {
      tool: "run_statistical_analysis",
      arguments: {
        tool_call_id: `statistics-${method.replaceAll("_", "-")}-${crypto.randomUUID()}`,
        request: {
          schema: "agentlas.science.statistics.request/v1",
          method,
          options: { confidenceLevel: 0.95, timeoutMs: 5000 },
          // `descriptive` is accepted for only four methods; anything else is refused at the tool
          // boundary. An unplanned run a researcher starts from this screen is exploratory by
          // definition -- confirmatory needs a frozen analysis plan, which this screen does not have.
          execution: {
            purpose: ["descriptive", "distribution_fit", "confidence_interval", "kaplan_meier"].includes(method) ? "descriptive" : "exploratory",
            input_artifacts: [inputArtifact],
            analysis_spec: null,
          },
        },
        source_table: sourceTable,
      },
    };
    state.statisticsLaunchBusy = true;
    state.statisticsLaunchError = "";
    state.composerDraft = i18n.prompt("statisticsRun", {
      title: artifact.title,
      artifactVersion,
      contentSha256,
      timeColumn: state.statisticsLaunchTimeColumn,
      eventColumn: state.statisticsLaunchEventColumn,
      request: JSON.stringify(toolRequest),
    });
    render();
    try {
      await startComposerTurn({ forceAppend: true });
      if (state.composerError) state.statisticsLaunchError = state.composerError;
    } finally {
      state.statisticsLaunchBusy = false;
      // The request has been made; leave the launch card so the result is what the researcher sees
      // next. Staying on the form after asking for a run reads as though nothing happened.
      if (!state.statisticsLaunchError) state.statisticsLaunchOpen = false;
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
    if (destination === "hypotheses") {
      // `returnToSession` is what leaves Lab mode. Setting the destination alone left a researcher
      // arriving from a Lab looking at the Lab, which is the one navigation that has to work: the
      // hypothesis decision is the human-only gate, and a screen that does not appear is the same
      // as not having built it.
      returnToSession(destination);
      // Load on arrival rather than on project open: a study accumulates hypotheses as it runs,
      // and the list a researcher decides from has to be the current one.
      void loadHypotheses(state.selectedId);
      void queueWorkspacePersistence({ navigation: true, tabs: false });
      return;
    }
    if (destination === "analysis-runs" || destination === "results") {
      // Load on arrival rather than on project open: runs and results accumulate while the study
      // executes, so what a researcher audits has to be what the store holds right now. Each loader
      // re-checks state.selectedId before writing, so a project switch mid-flight is discarded.
      returnToSession(destination);
      if (destination === "analysis-runs") void loadAnalysisRuns(state.selectedId);
      else void loadResults(state.selectedId);
      return;
    }
    if (destination === "literature") {
      // Load on arrival: sources and their acquired byte state change as the study runs, and the
      // question this screen answers -- may I cite this yet -- has to be asked of the current record.
      // returnToSession is what leaves Lab mode; setting the destination alone left a
      // researcher arriving from a Lab still looking at the Lab.
      returnToSession(destination);
      void loadLiterature(state.selectedId);
      void queueWorkspacePersistence({ navigation: true, tabs: false });
      return;
    }
    if (destination === "acquisition") {
      // Load on arrival: a fetch that failed after the project was opened is exactly the thing a
      // researcher comes here to find.
      // returnToSession is what leaves Lab mode; setting the destination alone left a
      // researcher arriving from a Lab still looking at the Lab.
      returnToSession(destination);
      void loadAcquisition(state.selectedId);
      void queueWorkspacePersistence({ navigation: true, tabs: false });
      return;
    }
    if (destination === "scope") {
      // Load on arrival: the contract is redrafted while the study runs, and an approval has to be
      // an approval of the version on screen.
      // returnToSession is what leaves Lab mode; setting the destination alone left a
      // researcher arriving from a Lab still looking at the Lab.
      returnToSession(destination);
      void loadScope(state.selectedId);
      void loadApprovalPolicy(state.selectedId);
      void queueWorkspacePersistence({ navigation: true, tabs: false });
      return;
    }
    if (destination === "logbook") {
      // Load on arrival: every gate the study passes appends a revision, so the audit trail a
      // reviewer asks for is only complete if it is read now.
      // returnToSession is what leaves Lab mode; setting the destination alone left a
      // researcher arriving from a Lab still looking at the Lab.
      returnToSession(destination);
      void loadLogbook(state.selectedId);
      void queueWorkspacePersistence({ navigation: true, tabs: false });
      return;
    }
    if (destination === "manuscript" || destination === "submission-archive") {
      const manuscript = manuscriptById(state.selectedManuscriptId) || state.manuscripts[0] || null;
      if (destination === "submission-archive") void loadSubmissionArchive(state.selectedId);
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
          host.innerHTML = refusalMarkup("blocked", "검증된 Vega 명세를 표시할 수 없습니다.", "명세는 있으나 이 버전에서 검증을 통과하지 못했습니다. 검증된 버전을 선택하면 여기에 그려집니다.");
          continue;
        }
        try {
          const runtime = window.vega.parse(compileArtifactVegaSpec(spec), undefined, { ast: true });
          const view = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host);
          const width = Math.max(220, Math.floor(host.getBoundingClientRect().width) - 24);
          view.width(width).height(250);
          state.compareVegaViews.push(view);
          await view.runAsync();
          fitArtifactVegaCanvas(host, { gutter: 8 });
        } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); }
        continue;
      }
      try {
        const preview = await science.artifacts.preview(state.selectedId, comparison.artifactId, context.selectedVersion.version);
        if (!preview?.bytes || !host.isConnected) {
          host.innerHTML = refusalMarkup("absent", "이 버전에는 검증된 캡처가 없습니다.", "비교는 두 쪽 모두 검증된 캡처가 있을 때만 열립니다. 없는 쪽을 추정해 그리지 않습니다.");
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
  const PUBLICATION_FIGURE_FAMILIES = [
    { id: "distribution", icon: "chart", label: "Distribution", examples: "Dot plot · box/violin · ECDF · ridgeline", guidance: "Show individual observations and the distribution instead of hiding them behind a mean-only bar." },
    { id: "estimation", icon: "chart", label: "Estimates & uncertainty", examples: "Effect estimate · 95% CI · forest · coefficient", guidance: "Put the estimate and its interval on the same visual axis; identify SD, SE, or CI explicitly." },
    { id: "diagnostics", icon: "grid", label: "Model diagnostics", examples: "Residual · Q–Q/P–P · calibration · ROC/PR", guidance: "Keep model checks separate from the headline result and preserve the exact analysis-run binding." },
    { id: "longitudinal", icon: "chart", label: "Time & survival", examples: "Time series · Kaplan–Meier · cumulative incidence", guidance: "Expose censoring, uncertainty, group counts, and the analysis window instead of a decorative trend line." },
    { id: "study-flow", icon: "book", label: "Study flow", examples: "CONSORT · PRISMA · cohort attrition", guidance: "Use a traceable participant or evidence flow with counts at every exclusion and analysis stage." },
    { id: "multi-panel", icon: "grid", label: "Multi-panel figure", examples: "A/B/C labels · shared legend · aligned axes", guidance: "Assemble related panels as one figure file and keep the full caption in the manuscript." },
  ];

  function publicationFigureStartMarkup() {
    const cards = PUBLICATION_FIGURE_FAMILIES.map((family) => `<button type="button" class="publicationFigureFamily" data-action="suggest-publication-figure" data-figure-family="${escapeHtml(family.id)}" data-figure-prompt="${escapeHtml(`Plan a publication figure for the current project using the ${family.label} family. Select the appropriate installed statistics template from the verified catalog, explain why it fits the study design, bind it to the exact analysis run, and prepare the journal-ready exports.`)}"><span class="publicationFigureFamilyIcon">${heroIcon(family.icon)}</span><span><strong>${escapeHtml(family.label)}</strong><em>${escapeHtml(family.examples)}</em><small>${escapeHtml(family.guidance)}</small></span>${heroIcon("chevron-right")}</button>`).join("");
    return `<section class="publicationFigureStart" data-empty-source="science.sqlite">
      <header><div><span>FIGURE LAB · PUBLICATION WORKFLOW</span><h1>Choose the evidence shape before the chart style.</h1><p>Start from the study design and estimand. Science selects from the installed figure catalog, binds the output to an exact analysis run, and keeps captions outside the image.</p></div><button class="primaryButton" type="button" data-action="suggest-publication-figure" data-figure-prompt="Plan the next publication figure for this project. Inspect the study design and current analysis artifacts, choose the most informative installed template, avoid mean-only bar charts when the distribution matters, bind it to the exact run, and prepare journal-ready exports.">Plan figure with Science</button></header>
      <div class="publicationFigureFamilies" role="list">${cards}</div>
      <footer><div><span>JOURNAL OUTPUTS</span><strong>Vector first; 300–600 dpi raster when required</strong></div><dl><div><dt>Width</dt><dd>Single 89 mm · double 183 mm</dd></div><div><dt>Type</dt><dd>8–12 pt final size · legible panel labels</dd></div><div><dt>Color</dt><dd>sRGB · grayscale-safe contrast</dd></div><div><dt>Package</dt><dd>SVG · PNG/PDF/TIFF · exact hash lineage</dd></div></dl><p>Exact limits are validated against the selected journal profile before submission.</p></footer>
    </section>`;
  }

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
    return `<form class="vegaEditor" id="vega-editor-form"><header class="vegaEditorHeader"><div><span>EXPLORATORY VEGA VIEW</span><strong>Visual encoding</strong></div><p>This editor preserves the current chart as a new immutable version. Manuscript figures should be generated from a source-bound statistics template in Figure Lab.</p><button type="button" data-action="suggest-publication-figure" data-figure-prompt="Convert the current exploratory Vega chart into an appropriate publication figure. Inspect the source data and study design, choose a verified statistics template, include uncertainty or individual observations where appropriate, bind it to the exact analysis run, and prepare journal-ready exports.">Prepare publication figure</button></header><div class="vegaEditorFields"><label><span>Figure title</span><input name="title" maxlength="240" required value="${escapeHtml(draft.title)}" /></label><label><span>Mark</span><select name="mark"><option value="bar" ${draft.mark === "bar" ? "selected" : ""}>Bar</option><option value="line" ${draft.mark === "line" ? "selected" : ""}>Line</option><option value="point" ${draft.mark === "point" ? "selected" : ""}>Points</option></select></label><fieldset><legend>Color</legend><div class="vegaColors">${VEGA_COLORS.map((color) => `<label title="${color}"><input type="radio" name="color" value="${color}" ${draft.color === color ? "checked" : ""}/><span style="--swatch:${color}"></span></label>`).join("")}</div></fieldset></div><div class="vegaEditorActions"><span data-vega-draft-status aria-live="polite">${escapeHtml(status)}</span><div><button type="button" data-action="reset-vega-draft" ${!draft.dirty || state.vegaSaving ? "disabled" : ""}>Reset</button><button class="saveVersionButton" type="submit" ${!draft.dirty || state.vegaSaving ? "disabled" : ""}>Save version</button></div></div></form>`;
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
      if (state.selectedLabId === "data-table") return labDecisionEmptyMarkup(`<section class="emptyView labStartView" data-empty-source="science.sqlite"><div class="labStartCard"><span class="researchKicker">Data & Statistics · ${escapeHtml(lifecycleLabel())}</span><strong>분석할 CSV를 검증된 Data Table로 가져오세요.</strong><p>원본 파일은 Main 프로세스에서만 읽고, 경로는 UI나 연구 에이전트에 노출하지 않습니다. 전체 파일을 파싱해 SourceVersion · CAS · ResearchRun · immutable source binding을 만든 뒤 표를 엽니다.</p><dl><div><dt>제한</dt><dd>8 MiB · 5,000 rows · 무음 truncation 없음</dd></div><div><dt>보존</dt><dd>typed cells · null · formula-looking text</dd></div><div><dt>출판</dt><dd>exact source/run/table SHA closure</dd></div></dl><button class="primaryButton importDatasetButton" data-action="import-csv-dataset" ${state.datasetImportBusy ? "disabled" : ""}>${state.datasetImportBusy ? "검증하며 가져오는 중…" : "CSV 데이터셋 가져오기"}</button>${state.datasetImportError ? `<p class="labStartError" role="alert">${escapeHtml(state.datasetImportError)}</p>` : ""}</div></section>`);
      if (state.selectedLabId === "statistics-analysis") return labDecisionEmptyMarkup(statisticsLaunchCard());
      if (state.selectedLabId === "data-visualization") return labDecisionEmptyMarkup(publicationFigureStartMarkup());
      if (state.selectedLabId === "economic-indicators") return labDecisionEmptyMarkup(`<section class="emptyView labStartView" data-empty-source="science.sqlite"><div class="labStartCard"><span class="researchKicker">Economics & Finance · ${escapeHtml(lifecycleLabel())}</span><strong>공식 World Bank 경제지표를 가져오세요.</strong><p>Economic Indicators는 World Bank의 국가·지표·연도 범위를 지정해 exact provider response, SourceVersion, ResearchRun과 Vega artifact lineage를 보존합니다. 주가·시세·거래 데이터 API는 제공하지 않습니다.</p><dl><div><dt>Economics</dt><dd>공식 World Bank indicator series</dd></div><div><dt>Finance</dt><dd>사용자 CSV → Data Table → Statistical Analysis / Vega</dd></div><div><dt>보존</dt><dd>source · run · artifact hash lineage</dd></div></dl><button class="secondaryButton" data-action="suggest-empty-lab-run">World Bank 지표를 연구 에이전트에게 요청</button></div></section>`);
      return labDecisionEmptyMarkup(`<section class="emptyView labStartView" data-empty-source="science.sqlite"><div class="labStartCard"><span class="researchKicker">${escapeHtml(labCapabilityLabel(state.selectedLabId))} · ${escapeHtml(lifecycleLabel())}</span>${skeletonRowMarkup()}<strong>아직 저장된 아티팩트가 없습니다.</strong><p>오른쪽 연구 채팅에서 이 Lab을 사용하도록 요청하면, 실제 실행 결과가 immutable version과 출처·run lineage를 가진 아티팩트로 이 보관소에 연결됩니다.</p><button class="secondaryButton" data-action="suggest-empty-lab-run">연구 에이전트에게 이 Lab 사용 요청</button></div></section>`);
    }
    // Asked for explicitly. The launch card used to render ONLY when the lab was empty, so a
    // researcher could start exactly one analysis from the screen: after the first result the
    // control that runs an analysis was gone, and the second one had to be asked for in chat. The
    // first thing anyone wants after a result is another analysis.
    if (state.selectedLabId === "statistics-analysis" && state.statisticsLaunchOpen) return labDecisionEmptyMarkup(statisticsLaunchCard());
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
    const paleontologyPayload = paleontologyArtifactPayload(activeVersion);
    const statisticsRasterPayload = activeVersion?.payload?.schema === "agentlas.science.statistics-figure-raster-artifact/v1" ? activeVersion.payload : null;
    const numericSurfacePayload = activeVersion?.payload?.schema === NUMERIC_SURFACE_V2_SCHEMA ? activeVersion.payload : null;
    const numericSurfaceRasterPayload = activeVersion?.payload?.schema === NUMERIC_SURFACE_RASTER_SCHEMA ? activeVersion.payload : null;
    const statisticsProjectionReceipt = activeVersion?.payload?.schema === "agentlas.science.statistics-analysis-artifact/v1"
      && isStatisticsProjectionReceipt(activeVersion.payload.projectionReceipt)
      ? activeVersion.payload.projectionReceipt : null;
    const statisticsRunId = activeVersion?.provenance?.sourceRunId || (inspectingHistory ? inspectedContext?.linkage?.origin?.runId : labContexts.find((context) => context.artifact.id === artifact.id)?.linkage?.origin?.runId) || "";
    const vegaDraft = !inspectingHistory && !statisticsFigurePayload && !paleontologyPayload ? ensureVegaDraft(artifact) : null;
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
    const selectedLabLabel = labLabel(state.selectedLabId);
    const selectedLabTitle = selectedLabLabel.endsWith("Lab") ? selectedLabLabel : `${selectedLabLabel} Lab`;
    const provenanceSteps = paleontologyPayload ? [
      `PBDB · ${paleontologyPayload.analysis.source.taxonName}`,
      `catalog run ${String(paleontologyPayload.source.parentRunId).slice(0, 12)}…`,
      `analysis ${String(paleontologyPayload.analysis.analysisSha256).slice(0, 12)}…`,
      `artifact v${activeVersion?.version || artifact.currentVersion}`,
    ] : economicEvidence ? [
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
      selectedLabTitle,
      originVersion ? `세션 응답의 아티팩트 v${originVersion}` : "project artifact",
      validator ? `${validator} validation` : artifact.version.rendererId,
      `artifact v${artifact.currentVersion}`,
    ];
    const originStrip = `<section class="originStrip"><div class="provenanceTrail">${provenanceSteps.map((step) => `<span>${escapeHtml(step)}</span>`).join('<i aria-hidden="true">→</i>')}<em>${escapeHtml(capability)}</em></div><div><button data-action="toggle-history" aria-expanded="${state.historyOpen}">버전 ${escapeHtml(artifact.currentVersion)}</button>${originVersion ? `<button data-artifact-history-version="${escapeHtml(originVersion)}">응답 원본 v${escapeHtml(originVersion)}</button>` : ""}<button data-action="toggle-drawer">세부 정보</button>${state.selectedLabId === "statistics-analysis" ? `<button data-action="open-statistics-launch">새 분석</button>` : ""}</div></section>`;
    const paleontologyLineage = paleontologyPayload ? `<section class="statisticsLineage" data-paleontology-lineage data-catalog-run-id="${escapeHtml(paleontologyPayload.source.parentRunId)}" data-analysis-run-id="${escapeHtml(paleontologyPayload.source.analysisRunId)}" data-analysis-sha256="${escapeHtml(paleontologyPayload.analysis.analysisSha256)}"><span>${escapeHtml(PALEONTOLOGY_BOUNDARY)}</span><i aria-hidden="true">→</i><span>${escapeHtml(paleontologyPayload.analysis.estimates.occurrenceCount)} exact rows · ${escapeHtml(paleontologyPayload.analysis.estimates.oldestBoundMa)}–${escapeHtml(paleontologyPayload.analysis.estimates.youngestBoundMa)} Ma</span><i aria-hidden="true">→</i><span>${paleontologyPayload.analysis.source.parentTruncated ? "Bounded retrieval · descriptive counts" : "Complete retrieved set"}</span></section>` : "";
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
    const statisticsFigureToolbar = statisticsFigurePayload ? `<section class="statisticsFigureToolbar" data-statistics-figure-toolbar><div class="statisticsFigureIdentity"><span>PUBLICATION FIGURE · EXACT BINDING</span><strong>${escapeHtml(statisticsFigurePayload.visualization.title)}</strong><code title="${escapeHtml(statisticsFigurePayload.statisticsArtifact.contentSha256)}">analysis v${escapeHtml(statisticsFigurePayload.statisticsArtifact.artifactVersion)} · ${escapeHtml(String(statisticsFigurePayload.statisticsArtifact.contentSha256).slice(0, 12))}…</code></div><dl class="statisticsFigureSpecs"><div><dt>단 폭</dt><dd>1단 89 mm · 2단 183 mm</dd></div><div><dt>글자</dt><dd>최종 크기에서 8–12 pt</dd></div><div><dt>색</dt><dd>sRGB · 흑백 확인됨</dd></div></dl><div class="statisticsFigureExport"><div><button type="button" data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>버전 비교</button><button type="button" data-action="export-statistics-figure-svg" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "SVG"}</button><button type="button" data-action="export-statistics-figure-png" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "PNG 600dpi"}</button><button type="button" data-action="export-statistics-figure-pdf" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "PDF 600dpi"}</button><button type="button" data-action="export-statistics-figure-tiff" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "TIFF 600dpi"}</button></div><span class="supportBoundary">SVG · PNG/PDF/TIFF 300/600dpi · sRGB ICC. CMYK와 vector PDF는 아직 미지원. 저널별 정확한 한도는 제출 시 검사합니다.</span></div>${state.figureActionError ? `<p role="alert">${escapeHtml(state.figureActionError)}</p>` : state.figureActionNotice ? `<p role="status">${escapeHtml(state.figureActionNotice)}</p>` : ""}</section>` : "";
    const statisticsRasterToolbar = statisticsRasterPayload ? `<section class="statisticsRasterToolbar" data-statistics-raster-toolbar data-export-receipt-sha256="${escapeHtml(statisticsRasterPayload.exportSha256)}"><div><span>PUBLICATION RASTER · EXACT EXPORT</span><strong>${escapeHtml(`${statisticsRasterPayload.export.dpi} DPI · ${statisticsRasterPayload.export.colorSpace.toUpperCase()} · ${statisticsRasterPayload.export.widthMm}×${statisticsRasterPayload.export.heightMm} mm`)}</strong><code title="${escapeHtml(statisticsRasterPayload.figureArtifact.contentSha256)}">Figure v${escapeHtml(statisticsRasterPayload.figureArtifact.artifactVersion)} · ${escapeHtml(statisticsShortHash(statisticsRasterPayload.figureArtifact.contentSha256))}</code></div><div><em>원고 연결 가능</em><span>이 image 아티팩트가 journal raster 검증 대상입니다.</span></div></section>` : "";
    const numericSurfaceToolbar = numericSurfacePayload ? `<section class="statisticsFigureToolbar" data-numeric-surface-export-toolbar><div><span>3D RESPONSE SURFACE · EXACT VIEW</span><strong>${escapeHtml(numericSurfacePayload.title)}</strong><code title="${escapeHtml(activeVersion.contentSha256)}">surface v${escapeHtml(activeVersion.version)} · ${escapeHtml(statisticsShortHash(activeVersion.contentSha256))} · view는 SQLite 저장 상태 사용</code></div><div class="statisticsFigureExport"><div><button type="button" data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>버전 비교</button><button type="button" data-action="export-numeric-surface-png" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "PNG 2008×1506 · 600dpi"}</button></div><span class="supportBoundary">Three.js offscreen WebGL 재렌더 · sRGB · white background · vector/PDF/EPS/TIFF/CMYK 미지원.</span></div>${state.figureActionError ? `<p role="alert">${escapeHtml(state.figureActionError)}</p>` : state.figureActionNotice ? `<p role="status">${escapeHtml(state.figureActionNotice)}</p>` : ""}</section>` : "";
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
      : `<div class="artifactCanvasFrame"><div class="rendererStatus"><span>${escapeHtml(artifact.kind)}</span><span>${escapeHtml(artifact.version.rendererId)} · ${escapeHtml(artifact.version.rendererVersion)} <em data-runtime-status></em></span></div>${artifact.version.rendererId === "agentlas.vega" ? statisticsFigureToolbar || (paleontologyPayload ? "" : vegaEditorMarkup(artifact, vegaDraft)) : numericSurfaceToolbar || numericSurfaceRasterToolbar || statisticsRasterToolbar || citationToolbar || skyToolbar || genomicsToolbar}<div class="${canvasClass}" data-artifact-host="${escapeHtml(artifact.id)}" data-artifact-version="${escapeHtml(artifact.version.version)}" data-content-sha256="${escapeHtml(artifact.version.contentSha256)}" aria-label="${escapeHtml(artifact.title)}"></div><div class="renderError" data-render-error role="alert"></div></div>`;
    const loopObservation = semanticObservations[0] || null;
    const loopEvidence = loopObservation ? `${loopObservation.label}: ${loopObservation.value}${loopObservation.unit ? ` ${loopObservation.unit}` : ""}` : (activeVersion?.semantic?.summary || "현재 아티팩트의 다음 검증 단계를 연구 채팅에서 함께 결정합니다.");
    return `<section class="artifactWorkspace ${state.historyOpen ? "historyOpen" : ""} ${state.artifactComparison ? "compareOpen" : ""}"><header class="labWorkspaceHeader visuallyHidden"><span>${escapeHtml(labCapabilityLabel(state.selectedLabId))}</span><strong>아티팩트 보관소 · 작업공간</strong><span class="originVersion">${capability}</span><button data-action="back-session">${state.returnMessageId ? "대화의 아티팩트로" : "세션으로 돌아가기"}</button></header>${tabs ? `<nav class="artifactTabs" data-count="${escapeHtml(labArtifacts.length)}" aria-label="Lab 아티팩트">${tabs}</nav>` : ""}${originStrip}${statisticsLineage}${paleontologyLineage}${labDecisionPanelMarkup()}<div class="labWorkGrid"><div class="figureColumn">
      ${canvas}
      <section class="artifactInterpretation"><div><div class="researchKicker">${inspectingHistory ? "과거 버전 의미 기록" : "Semantic layer"}</div><h2>${escapeHtml(activeVersion?.semantic?.title || (inspectingHistory ? `v${state.inspectedArtifactVersion} 기록을 불러오는 중…` : artifact.title))}</h2><p>${escapeHtml(activeVersion?.semantic?.summary || (inspectingHistory ? "현재 버전 정보로 대체하지 않고, 선택한 과거 버전의 검증이 끝날 때까지 기다립니다." : ""))}</p></div>${observations ? `<dl class="observationGrid">${observations}</dl>` : ""}</section>
      <div data-artifact-compare-host>${artifactCompareMarkup(artifact, history)}</div>
    </div><aside class="versionRail" data-version-timeline aria-label="아티팩트 버전 기록"><header><span>버전 기록</span><div><strong>${escapeHtml(artifact.currentVersion)}개</strong><button data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>비교</button></div></header><div class="versionRows">${timeline}</div><footer>저장된 버전만 기록됩니다. 과거 버전은 읽기 전용입니다.</footer></aside></div></section>`;
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
      content = manuscript && draft ? `<section class="drawerSection"><div class="drawerLabel">Manuscript ledger</div><strong>${escapeHtml(manuscript.title)}</strong><p>The editor is pinned to v${escapeHtml(draft.baseVersion)} and its exact content hash. Every accepted edit creates a new immutable version.</p><dl class="factList"><div><dt>Status</dt><dd>${escapeHtml(manuscript.status)}</dd></div><div><dt>Version</dt><dd>v${escapeHtml(manuscript.currentVersion)}</dd></div><div><dt>Bindings</dt><dd>${escapeHtml(draft.bindings.length)}</dd></div><div><dt>Content</dt><dd><code>${escapeHtml(draft.baseContentSha256.slice(0, 12))}…</code></dd></div></dl></section><section class="drawerSection"><div class="drawerLabel">Submission boundary</div><strong>Journal rules not verified</strong><p>Verify the target journal's template, word limit, figure, supplement, and data-availability rules against official web sources before submission.</p></section>` : `<section class="drawerSection"><strong>No manuscript selected.</strong></section>`;
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

  function paleontologyCatalogReceiptMarkup(message) {
    if (message.role !== "user") return "";
    const catalogRuns = state.runs.filter((run) => run.originMessageId === message.id
      && run.toolId === PALEONTOLOGY_CATALOG_TOOL_ID && run.status === "succeeded" && run.parentRunId === null);
    if (!catalogRuns.length) return "";
    return catalogRuns.slice(0, 2).map((run) => {
      const result = run.outputs.find((output) => output.role === "paleontology-catalog") || null;
      const child = state.runs.find((candidate) => candidate.parentRunId === run.id && candidate.toolId === PALEONTOLOGY_ANALYSIS_TOOL_ID) || null;
      const artifact = child ? state.artifacts.find((candidate) => candidate.sourceRunId === child.id
        && candidate.version?.payload?.schema === PALEONTOLOGY_ARTIFACT_SCHEMA) || null : null;
      const terminal = child?.status === "succeeded" && artifact;
      const action = terminal
        ? `<button class="chatArtifactLink" data-paleontology-artifact-id="${escapeHtml(artifact.id)}" data-artifact-version="${escapeHtml(artifact.currentVersion)}"><strong>Stratigraphic analysis ready</strong><span>Open interval chart and publication table →</span></button>`
        : `<button class="primaryButton" data-action="run-paleontology-analysis" data-catalog-run-id="${escapeHtml(run.id)}" ${state.composerSending || state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status) ? "disabled" : ""}>Analyze stratigraphic support</button>`;
      return `<section class="manuscriptProposalCard" data-paleontology-catalog-receipt data-catalog-run-id="${escapeHtml(run.id)}"><header><div><span>PBDB search receipt</span><strong>${escapeHtml(run.summary || "Exact occurrence catalog stored")}</strong></div><em data-status="${escapeHtml(child?.status || "ready")}">${escapeHtml(child?.status || "ready")}</em></header><div class="manuscriptValidationLine">${heroIcon("book")}<span>${escapeHtml(result ? `${result.byteSize.toLocaleString("en-US")} bytes · exact catalog output` : "Exact catalog output")}</span><code title="${escapeHtml(result?.sha256 || run.outputManifestSha256 || "")}">${escapeHtml(String(result?.sha256 || run.outputManifestSha256 || "").slice(0, 12))}…</code></div><p>${PALEONTOLOGY_BOUNDARY}</p>${action}</section>`;
    }).join("");
  }

  function runPaleontologyAnalysis(catalogRunId) {
    const run = state.runs.find((candidate) => candidate.id === catalogRunId && candidate.toolId === PALEONTOLOGY_CATALOG_TOOL_ID
      && candidate.status === "succeeded" && candidate.parentRunId === null);
    if (!run || state.composerSending || state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status)) return;
    state.composerDraft = `Run analyze_paleontology_stratigraphic_support for the exact PBDB catalog_run_id ${run.id}. Preserve every maxMa and minMa bound, create the interval-bar Vega figure and full publication table, and keep this boundary verbatim: ${PALEONTOLOGY_BOUNDARY} Treat counts as descriptive if retrieval is truncated.`;
    void startComposerTurn({ forceAppend: true });
  }

  function compactChatMessage(message) {
    const blocks = state.blocksByMessage.get(message.id) || [];
    const rawText = blocks.length ? blocks.map((block) => block.content).join("\n\n") : message.content;
    const text = String(rawText || "")
      .replace(/\n*<<agentlas-manuscript-selection:v1 \{[^\n]*\}>>\s*$/u, "")
      .replace(/\n*<<agentlas-manuscript-draft-job:v1 \{[^\n]*\}>>\s*$/u, "");
    const artifactContexts = state.artifactContextsByMessage.get(message.id) || [];
    const artifacts = artifactContexts.map((context) => `<button class="chatArtifactLink" data-chat-artifact-id="${escapeHtml(context.artifact.id)}" data-chat-artifact-version="${escapeHtml(context.selectedVersion.version)}" data-chat-conversation-id="${escapeHtml(message.conversationId)}" data-chat-message-id="${escapeHtml(message.id)}" title="${escapeHtml(`Open exact v${context.selectedVersion.version} in ${labLabel(context.linkage.labId)}`)}"><strong>${escapeHtml(context.artifact.title)}</strong><span>${escapeHtml(labLabel(context.linkage.labId))} · open v${escapeHtml(context.selectedVersion.version)} →</span></button>`).join("");
    const user = message.role === "user";
    return `<article class="chatMessage ${user ? "isUser" : "isAssistant"}"><div class="chatMessageRole">${user ? "You" : "Agentlas Science"}</div><div class="chatMessageContent">${escapeHtml(text)}</div>${artifacts}${paleontologyCatalogReceiptMarkup(message)}</article>`;
  }

  function manuscriptProposalCardsMarkup() {
    if (state.mode !== "manuscript" || !state.manuscriptEditProposals.length) return "";
    return state.manuscriptEditProposals.slice(0, 8).map((proposal) => {
      const operation = proposal.operations.find((item) => item.kind === "replace-node") || proposal.operations[0];
      const selection = proposal.selectionContextIds.map((id) => state.manuscriptSelectionContexts.find((item) => item.id === id)).find(Boolean) || null;
      const currentNode = operation?.nodeId ? state.manuscriptEditorModel?.document?.nodes?.find((node) => node.id === operation.nodeId) : null;
      const replacement = operation?.kind === "replace-node" ? operation.replacement : proposal.previewDocument?.nodes?.find((node) => node.id === operation?.nodeId);
      const before = manuscriptNodeSelectionText(currentNode) || selection?.selectedText || "Exact base block";
      const after = manuscriptNodeSelectionText(replacement) || proposal.previewMarkdown;
      const compact = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 360);
      const busy = state.manuscriptProposalBusy === proposal.id;
      const actions = proposal.status === "pending"
        ? `<div class="manuscriptProposalActions"><button class="secondaryButton" data-action="reject-manuscript-proposal" data-proposal-id="${escapeHtml(proposal.id)}" ${busy ? "disabled" : ""}>Reject</button><button class="primaryButton" data-action="apply-manuscript-proposal" data-proposal-id="${escapeHtml(proposal.id)}" ${busy ? "disabled" : ""}>${busy ? "Applying…" : "Apply edit"}</button></div>`
        : proposal.status === "stale"
          ? `<div class="manuscriptProposalActions"><button class="secondaryButton" disabled>Apply unavailable</button><button class="primaryButton" data-action="regenerate-manuscript-proposal" data-proposal-id="${escapeHtml(proposal.id)}">Regenerate from current</button></div>`
          : `<div class="manuscriptProposalDecision">${proposal.status === "applied" ? "Applied to" : "Rejected from"} this manuscript${proposal.decision?.resultVersion ? ` · v${escapeHtml(proposal.decision.resultVersion)}` : ""}</div>`;
      return `<article class="manuscriptProposalCard" data-manuscript-proposal-id="${escapeHtml(proposal.id)}" data-proposal-status="${escapeHtml(proposal.status)}">
        <header><div><span>Science edit</span><strong>${escapeHtml(proposal.summary)}</strong></div><em data-status="${escapeHtml(proposal.status)}">${escapeHtml(proposal.status)}</em></header>
        <p>${escapeHtml(proposal.rationale)}</p>
        <div class="manuscriptProposalDiff" aria-label="Proposed manuscript diff"><div data-diff="before"><span>Current</span><del>${escapeHtml(compact(before))}</del></div><div data-diff="after"><span>Proposed</span><ins>${escapeHtml(compact(after))}</ins></div></div>
        ${proposal.status === "stale" ? `<div class="manuscriptProposalStale">The manuscript changed after this proposal. Applying it is blocked.</div>` : ""}${actions}
      </article>`;
    }).join("");
  }

  function manuscriptDraftJobMarkup() {
    const job = state.manuscriptDraftJob;
    if (!job || job.projectId !== state.selectedId) return "";
    const label = job.status === "created" ? "Manuscript created" : job.status === "blocked" || job.status === "failed" ? "Manuscript not created" : "Publication draft in progress";
    const detail = job.status === "created"
      ? `Blueprint v${job.receipt?.blueprintVersion || "-"} · ${job.receipt?.eligibilityReceiptIds?.length || 0} eligible comparables`
      : job.error || "Research Director is collecting full text, qualifying 5+ comparable papers, calibrating the Blueprint, and drafting substantive sections.";
    return `<section class="manuscriptDraftJobCard" data-manuscript-draft-status="${escapeHtml(job.status)}"><span>${heroIcon("book")}</span><div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(detail)}</p></div></section>`;
  }

  function chatThreadMarkup() {
    const messages = state.messages.length ? state.messages.map(compactChatMessage).join("") : `<div class="chatDockEmpty">This project conversation continues here.</div>`;
    return `${messages}${manuscriptDraftJobMarkup()}${manuscriptProposalCardsMarkup()}`;
  }

  function manuscriptDraftJobPrompt(job) {
    const target = job.journalTarget || "Not selected";
    const seed = job.seedBinding ? `\nValidated result to bind only after the manuscript gate passes: ${JSON.stringify(job.seedBinding)}` : "";
    return `Start a publication-grade manuscript workflow for this project.\n\nResearch objective: ${job.objective}\nArticle family: ${job.articleFamily}\nTarget journal: ${target}.${seed}\n\nUse the Research Director MCP path only. Do not create a renderer-side manuscript or an empty IMRaD scaffold.\n1. Collect and content-check relevant full-text prior work.\n2. Record immutable quantitative eligibility receipts for at least five comparable sources from one source-domain cohort and one article family; bind exact SourceVersions and two distinct-section byte quotes.\n3. Create a current corpus-calibrated Blueprint, binding verified official journal guidance if a target is supplied.\n4. Map every paragraph job, claim, citation, figure, table, and equation before prose; preserve the corpus-observed section transitions.\n5. Draft substantive sections in durable passes until the corpus-derived word and paragraph ranges are met without repeated-paragraph padding; draft the Abstract last.\n6. Assemble the versioned manuscript only through the gated MCP route, then close scholarly flow, claim, numeric provenance, and journal validation.\n\nIf evidence is missing, ask for the smallest necessary input instead of creating a placeholder.\n\n<<agentlas-manuscript-draft-job:v1 ${JSON.stringify({ requestId: job.requestId, projectId: job.projectId, conversationId: job.conversationId, articleFamily: job.articleFamily, journalTarget: job.journalTarget || null, seedBinding: job.seedBinding || null })}>>`;
  }

  async function maybeOpenDraftJobManuscript(projectId, { terminal = false } = {}) {
    const job = state.manuscriptDraftJob;
    if (!job || job.projectId !== projectId || job.status === "created") return false;
    const candidates = state.manuscripts.filter((item) => !job.existingManuscriptIds.includes(item.id));
    for (const manuscript of candidates) {
      try {
        const model = await science.manuscripts.editorModel(projectId, manuscript.id);
        const blueprint = model?.blueprint;
        const binding = manuscript.version?.blueprintBinding;
        const comparables = blueprint?.version?.document?.comparables || [];
        const closed = Boolean(manuscript.version?.document && binding && blueprint?.status === "current"
          && blueprint.currentVersion === binding.blueprintVersion
          && blueprint.version?.contentSha256 === binding.blueprintContentSha256
          && comparables.length >= 5 && comparables.every((item) => item.eligibilityReceiptId));
        if (!closed) continue;
        state.manuscriptDraftJob = { ...job, status: "created", receipt: { manuscriptId: manuscript.id, manuscriptVersion: manuscript.currentVersion, manuscriptContentSha256: manuscript.version.contentSha256, blueprintId: blueprint.id, blueprintVersion: blueprint.currentVersion, blueprintContentSha256: blueprint.version.contentSha256, eligibilityReceiptIds: comparables.map((item) => item.eligibilityReceiptId) }, error: "" };
        await openManuscript(manuscript.id);
        return true;
      } catch { /* fail closed until the exact closure can be read */ }
    }
    if (terminal) {
      state.manuscriptDraftJob = { ...job, status: "blocked", error: "The Research Director turn ended without a closed manuscript + Blueprint + 5 eligible-comparable receipt. No manuscript tab was opened." };
      state.composerError = state.manuscriptDraftJob.error;
    }
    return false;
  }

  function composer(docked = false) {
    const running = state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status);
    const needsInitialRun = !running && state.messages.length === 1 && state.messages[0].role === "user" && !state.messages.some((message) => message.role === "assistant");
    const disabled = state.composerSending || !selectedConversation();
    // 같은 실패가 두 번 나오면 안 된다. 본문 .failClosed 가 사람 문장으로 설명하는 경우
  // 하단 상태줄까지 오류 원문을 되풀이하면, 사람은 잘린 개발자 문자열
  // ("Error invoking remote method 'scien…")만 읽게 된다. 설명된 실패는 짧게 가리키고
  // 원문은 미지의 실패에만 남긴다.
  const composerStatusText = (rawValue) => {
    const t = String(rawValue || "").trim();
    if (!t) return "";
    const explained = /^Error invoking remote method/i.test(t)
      || /science-research-director-package-version-mismatch/.test(t)
      || /package-integrity|package-signature/.test(t);
    // 본문 안내를 가리키려면 그 안내가 실제로 그려져 있어야 한다. 실물로 확인했다 —
    // .failClosed 가 본문 위쪽(303px)에 폭 760 으로 그려진다. 그래서 가리켜도 된다.
    return explained ? "실행을 시작하지 못했습니다 · 위 안내를 확인하세요" : t;
  };
  const status = composerStatusText(state.composerError) || (running ? (state.activeTurn.status === "cancelling" ? "연구 실행을 중단하는 중…" : "Agent runtime 연구 중…") : needsInitialRun ? "저장된 첫 질문을 실행할 수 있습니다" : "Agent runtime 준비");
    return `<footer class="composer${docked ? " dockedComposer" : ""}"><div class="composerBox"><textarea data-composer-input ${disabled || running || needsInitialRun ? "disabled" : ""} rows="2" aria-label="후속 질문" placeholder="후속 질문, 분석 또는 실험 요청">${escapeHtml(state.composerDraft)}</textarea><div class="composerBar"><div class="composerTools"><span class="composerStatus">${escapeHtml(status)}</span><button class="composerAttachButton" disabled title="첨부는 다음 단계에서 연결됩니다" aria-label="첨부 준비 중">${heroIcon("plus")}</button><span class="composerModePill">${heroIcon("sparkles")} Science</span></div><button class="sendButton" data-action="${running ? "cancel-turn" : "send-turn"}" ${disabled || (!needsInitialRun && !state.composerDraft.trim()) ? "disabled" : ""} aria-label="${running ? "중단" : needsInitialRun ? "첫 질문 실행" : "보내기"}">${running ? "■" : "↑"}</button></div></div></footer>`;
  }

  function chatContextLabel() {
    return state.mode === "lab" && state.selectedLabId
      ? `${labLabel(state.selectedLabId)} Lab와 함께 보는 대화`
      : state.mode === "manuscript"
        ? `${manuscriptById(state.selectedManuscriptId)?.title || "Manuscript"} · exact manuscript context`
        : "Research와 함께 보는 대화";
  }

  function chatContextTokensMarkup() {
    if (state.mode === "manuscript") {
      const context = state.manuscriptSelectionContext;
      if (!context) return state.manuscriptSelectionError ? `<div class="chatContextError" role="alert">${escapeHtml(state.manuscriptSelectionError)}</div>` : "";
      const node = state.manuscriptEditorModel?.document?.nodes?.find((item) => item.id === context.nodeId);
      const label = node?.kind === "heading" ? node.text : node?.kind ? `${node.kind[0].toUpperCase()}${node.kind.slice(1)} block` : "Manuscript selection";
      return `<div class="chatContextTokens manuscriptChatContext" aria-label="Pinned manuscript selection"><span title="${escapeHtml(context.selectedText)}">${heroIcon("book")}<strong>${escapeHtml(label)}</strong><em>“${escapeHtml(context.selectedText.slice(0, 86))}${context.selectedText.length > 86 ? "…" : ""}”</em><button data-action="clear-manuscript-selection" aria-label="Remove pinned manuscript selection">×</button></span></div>`;
    }
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
    return `<aside class="chatDock" data-chat-dock aria-label="연구 협업 채팅"><div class="chatDockFrame"><header class="chatDockHeader"><div class="chatPartner"><span class="chatPartnerMark">${heroIcon("book")}</span><span><strong>연구 채팅</strong><em>${escapeHtml(lifecycleCompactLabel())}</em></span></div><button class="chatHeaderAction" data-action="toggle-drawer" aria-label="연구 문맥과 세부 정보">${heroIcon("ellipsis")}</button></header><div class="chatDockBody" data-chat-dock-body>${chatThreadMarkup()}</div><div class="chatDockComposer" data-chat-dock-composer>${chatDockComposerMarkup()}</div></div></aside>`;
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

  /**
   * Record why a research run did not produce anything, and redraw BOTH places that say so.
   *
   * The five sites that set this used to redraw only the chat dock. The body carries the
   * "did not start" notice, so a failure was recorded and then never drawn: the body still read
   * "no research response yet" while the only visible trace was a truncated developer string beside
   * the composer. Writing good words for a surface that is never redrawn is the same as having no
   * surface, so setting the reason and drawing it are one call now.
   */
  function recordRunFailure(reason) {
    state.composerError = reason ? (reason instanceof Error ? reason.message : String(reason)) : "";
    renderChatDock();
    render();
  }

  async function startComposerTurn(options = {}) {
    const project = selectedProject();
    const conversation = selectedConversation();
    if (!project || !conversation || state.composerSending) return;
    const needsInitialRun = !options.forceAppend && state.messages.length === 1 && state.messages[0].role === "user" && !state.messages.some((message) => message.role === "assistant");
    const content = state.composerDraft.trim();
    const selectionContext = !needsInitialRun && state.mode === "manuscript" ? state.manuscriptSelectionContext : null;
    const runtimeContent = selectionContext ? `${content}\n\n<<agentlas-manuscript-selection:v1 ${JSON.stringify({ selectionContextId: selectionContext.id, manuscriptId: selectionContext.manuscriptId, manuscriptVersion: selectionContext.manuscriptVersion, manuscriptContentSha256: selectionContext.manuscriptContentSha256, manuscriptDocumentSha256: selectionContext.manuscriptDocumentSha256, nodeId: selectionContext.nodeId, nodeRevision: selectionContext.nodeRevision, nodeContentSha256: selectionContext.nodeContentSha256, startOffset: selectionContext.startOffset, endOffset: selectionContext.endOffset, selectedText: selectionContext.selectedText })}>>` : content;
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
          : { mode: "append-user-message", content: runtimeContent }),
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
      // A first question whose turn DIED has to be askable again. The record keeps one turn per
      // message, so re-running that message is refused -- and "Run first question" is the only
      // control a study that never started offers, so the study could not begin at all and nothing
      // on the screen explained why. Asking the same question again as a NEW message is what a
      // researcher does, and the transcript then honestly shows it was asked twice.
      //
      // Driven by the refusal rather than by guessing which turn ran: the screen does not reliably
      // know about a turn that finished before it opened, and a guess here would be wrong in the
      // one state this exists for.
      const refusedAsUsed = String(error?.message ?? error).includes("science-user-message-already-used");
      if (refusedAsUsed && needsInitialRun && state.messages[0]?.content) {
        try {
          const retried = await science.composer.start({
            requestId: crypto.randomUUID(),
            projectId: project.id,
            conversationId: conversation.id,
            mode: "append-user-message",
            content: state.messages[0].content,
          });
          state.activeTurn = retried.turn;
          state.composerSending = false;
          if (["completed", "failed", "cancelled", "interrupted"].includes(retried.turn.status)) {
            if (state.mode === "lab") await refreshConversationOnly(project.id);
            else await selectProject(project.id, { preserveWorkspace: true });
            return;
          }
          renderChatDock();
          return;
        } catch (retryError) {
          state.composerSending = false;
          recordRunFailure(retryError);
          return;
        }
      }
      state.composerSending = false;
      recordRunFailure(error);
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
      render();
      renderChatDock();
    }
  }

  function modal() {
    if (!state.modal) return "";
    return `<div class="modalBackdrop" role="presentation"><form class="modal" id="new-project-form" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><h2 id="new-project-title">새 연구</h2><p class="modalLead">첫 질문과 프로젝트가 로컬 Science DB에 저장됩니다. 분석·출처·실험 결과는 실제 runtime이 생성한 뒤에만 표시됩니다.</p><label class="field"><span>연구 질문</span><textarea name="question" required maxlength="20000" placeholder="무엇을 발견하거나 검증하고 싶나요?"></textarea></label><label class="field"><span>분야</span><select name="domain"><option value="general">일반 과학</option><option value="life-science">생명과학</option><option value="chemistry">화학</option><option value="physics">물리학</option><option value="materials-science">재료과학</option><option value="genomics">유전체학</option><option value="astronomy">천문학</option><option value="earth-ecology">지구·생태</option><option value="statistics">통계학</option><option value="economics">경제학</option><option value="finance">금융 연구</option></select></label><label class="field"><span>프로젝트 이름 <span class="optional">선택</span></span><input name="title" maxlength="160" placeholder="비워두면 질문에서 이름을 만듭니다" /></label><div class="formError" id="form-error" role="alert"></div><div class="modalActions"><button class="secondaryButton" type="button" data-action="cancel">취소</button><button class="primaryButton" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "저장 중…" : "프로젝트 만들기"}</button></div></form></div>`;
  }

  function manuscriptModal() {
    if (!state.manuscriptModal) return "";
    const project = selectedProject();
    const steps = [["01","Collect full text"],["02","Qualify 5+ comparables"],["03","Calibrate length + flow"],["04","Map claims + artifacts"],["05","Draft section by section"],["06","Assemble + assess"]];
    return `<div class="modalBackdrop" role="presentation"><form class="modal manuscriptStartModal" id="start-manuscript-research-form" data-manuscript-start-route="research-director" role="dialog" aria-modal="true" aria-labelledby="manuscript-start-title"><header><span>Research Director workflow</span><h2 id="manuscript-start-title">Start a publication-grade manuscript</h2><p>Science creates no manuscript record until the evidence and corpus-depth gates pass.</p></header><div class="manuscriptStartGrid"><ol class="manuscriptStartFlow">${steps.map(([number,label]) => `<li data-manuscript-start-step><span>${number}</span><strong>${escapeHtml(label)}</strong></li>`).join("")}</ol><div class="manuscriptStartFields"><label class="field"><span>Research objective</span><textarea name="objective" required maxlength="20000" spellcheck="true" placeholder="What claim or research result should this manuscript establish?">${escapeHtml(project?.question || "")}</textarea></label><label class="field"><span>Article family</span><select name="articleFamily"><option value="empirical">Empirical study</option><option value="theoretical-proof">Theoretical / proof</option><option value="review-synthesis">Review / synthesis</option><option value="methods-model">Methods / model</option><option value="data-resource">Data resource</option></select></label><label class="field"><span>Target journal <em>optional</em></span><input name="journalTarget" maxlength="500" placeholder="Science will verify the official author guidance" /></label>${state.pendingManuscriptBinding ? `<div class="manuscriptStartSeed">One validated project result is queued for binding after the draft gate passes.</div>` : ""}</div></div><div class="manuscriptStartGate"><strong>No empty scaffold</strong><span>The manuscript tab opens only after an exact manuscript, current Blueprint, and at least five immutable eligibility receipts are closed together.</span></div><div class="formError" id="manuscript-form-error" role="alert"></div><div class="modalActions"><button class="secondaryButton" type="button" data-action="cancel-manuscript">Cancel</button><button class="primaryButton" type="submit" ${state.saving || state.composerSending ? "disabled" : ""}>Start in Research chat</button></div></form></div>`;
  }

  function journalTargetSheet() {
    if (!state.journalSheet) return "";
    const profile = journalProfileById(state.selectedJournalProfileId);
    return `<div class="dialogScrim journalDialogScrim" role="presentation"><form class="scienceDialog journalDialog" id="journal-target-form" role="dialog" aria-modal="true" aria-labelledby="journal-target-title"><header><div><span>Official journal profile</span><h2 id="journal-target-title">제출 저널의 공식 규칙을 연결합니다</h2></div><button type="button" data-action="close-journal-sheet" aria-label="저널 설정 닫기">×</button></header><p>저널 이름을 기준으로 추측하지 않습니다. 아래 공식 URL을 AI가 직접 검사하고, 페이지 원문에 존재하는 문구만 규칙으로 저장합니다.</p><div class="sheetGrid"><label class="field"><span>저널 이름</span><input name="journalName" required maxlength="500" value="${escapeHtml(profile?.journalName || "")}" placeholder="예: Nature" /></label><label class="field"><span>Article type</span><input name="articleType" required maxlength="500" value="${escapeHtml(profile?.articleType || "Research Article")}" placeholder="Research Article" /></label></div><label class="field"><span>공식 author-guideline URL</span><span class="fieldHint">한 줄에 하나씩 적어 주세요. https 주소만 검사합니다.</span><textarea name="sourceUrls" required maxlength="20000" rows="4" placeholder="https://journal.example.org/for-authors/submission-guidelines"></textarea></label><div class="sheetCallout"><strong>AI가 수행할 작업</strong><span>공식 HTTPS 페이지 검사 → 원문·응답 해시 저장 → 구조·분량·그림·윤리·데이터·파일 규칙 추출 → 인용 문구 대조 → 버전형 프로필 생성</span></div><div class="formError" role="alert">${escapeHtml(state.journalActionError)}</div><footer><button class="secondaryButton" type="button" data-action="close-journal-sheet">취소</button><button class="primaryButton" type="submit" ${state.journalActionBusy ? "disabled" : ""}>${state.journalActionBusy ? "AI 연구 요청 중…" : "AI로 공식 지침 확인"}</button></footer></form></div>`;
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
    const manualAttestations = manualRules.length ? `<fieldset class="manualAttestations"><legend>사람이 직접 확인해야 하는 항목</legend>${manualRules.map((rule) => `<label><input class="manualCheck" type="checkbox" name="humanAttestationCode" value="${escapeHtml(rule.check.code)}" required /><span><strong>${escapeHtml(rule.requirement)}</strong><small>이 확인은 현재 원고 v${escapeHtml(manuscript?.currentVersion || "-")} · 프로필 v${escapeHtml(profile?.currentVersion || "-")}에만 유효하며 한 번만 사용됩니다.</small></span></label>`).join("")}</fieldset>` : "";
    const draft = state.submissionDraft || {};
    const draftValue = (name) => escapeHtml(draft[name] || "");
    const blueprintAssessment = manuscriptBlueprintAssessmentView(state.manuscriptEditorModel?.blueprintAssessment);
    const scholarlyAssessment = manuscriptScholarlyAssessmentView(state.manuscriptEditorModel?.scholarlyAssessment);
    const validation = state.journalValidation?.status && state.journalValidation.status !== "ready" ? state.journalValidation : null;
    const validationNotice = validation
      ? `<div class="submissionValidationNotice journalValidationSummary" data-status="${escapeHtml(validation.status)}"><strong>${escapeHtml(validation.status)}</strong><span class="countTriplet"><span><span class="stateGlyph" data-state="verified" aria-hidden="true"></span>${escapeHtml(validation.counts.pass)} pass</span><span><span class="stateGlyph" data-state="blocked" aria-hidden="true"></span>${escapeHtml(validation.counts.fail)} fail</span><span><span class="stateGlyph" data-state="awaiting-human" aria-hidden="true"></span>${escapeHtml(validation.counts.manual)} manual</span></span></div>${validation.findings.filter((finding) => finding.status !== "pass").slice(0, 5).map((finding) => `<div class="journalFinding" data-status="${escapeHtml(finding.status)}" data-severity="${escapeHtml(finding.severity)}"><span>${finding.status === "manual" ? "?" : "!"}</span><div><strong>${escapeHtml(finding.requirement)}</strong><em>${escapeHtml(finding.observed)}</em></div></div>`).join("")}`
      : "";
    const blueprintValidationFindings = Array.isArray(state.journalValidation?.findings)
      ? state.journalValidation.findings.filter((finding) => [
        "agentlas.submission.manuscript-blueprint",
        "agentlas.submission.manuscript-depth",
        "agentlas.submission.manuscript-blueprint-conformance",
        "agentlas.submission.manuscript-blueprint-assessment",
        "agentlas.submission.manuscript-scholarly-assessment",
      ].includes(finding.ruleId))
      : [];
    const blueprintValidationNotice = blueprintValidationFindings.length
      ? `<section data-submission-blueprint-findings><div class="manuscriptInspectorLabel">Blueprint closeout findings</div>${blueprintValidationFindings.map((finding) => `<div class="journalFinding" data-status="${escapeHtml(finding.status)}" data-severity="${escapeHtml(finding.severity)}" data-rule-id="${escapeHtml(finding.ruleId)}"><span>${finding.status === "pass" ? "✓" : "!"}</span><div><strong>${escapeHtml(finding.ruleId)} · ${escapeHtml(finding.status)}</strong><em>${escapeHtml(finding.observed)}</em></div></div>`).join("")}</section>`
      : "";
    return `<div class="dialogScrim submissionDialogScrim" role="presentation"><form class="scienceDialog submissionSheet" id="submission-export-form" role="dialog" aria-modal="true" aria-labelledby="submission-export-title"><header><div><span>Journal submission</span><h2 id="submission-export-title">검증 가능한 제출 패키지 만들기</h2></div><button type="button" data-action="close-submission-sheet" aria-label="제출 정보 닫기">×</button></header>
      <nav class="submissionSteps stepBars" aria-label="제출 패키지 진행 단계"><button type="button" data-action="open-journal-sheet"><span>1</span><strong>저널 규칙</strong></button><button type="button" aria-current="step" disabled><span>2</span><strong>저자 정보</strong></button><button type="button" data-action="submission-review"><span>3</span><strong>최종 검증</strong></button></nav>
      <div class="submissionSheetBody"><section class="submissionFormPane"><p>원고 v${escapeHtml(manuscript?.currentVersion || "-")}와 저널 프로필 v${escapeHtml(profile?.currentVersion || "-")}를 정확히 고정합니다. 남은 항목은 AI가 하나씩 확인하고, 필수 규칙이 남으면 제출 ZIP을 만들지 않습니다.</p>
        <div class="submissionIdentityGrid"><label class="field"><span>Corresponding author</span><input name="authorName" required maxlength="500" value="${draftValue("authorName")}" placeholder="Full legal name" /></label><label class="field"><span>Affiliation</span><input name="affiliation" required maxlength="1000" value="${draftValue("affiliation")}" placeholder="Institution, department" /></label><label class="field"><span>Email</span><input name="email" type="email" required maxlength="500" value="${draftValue("email")}" placeholder="name@institution.edu" /></label><label class="field"><span>ORCID <em>선택</em></span><input name="orcid" maxlength="40" value="${draftValue("orcid")}" placeholder="0000-0000-0000-0000" /></label><label class="field submissionKeywords"><span>Keywords <em>쉼표 구분</em></span><input name="keywords" maxlength="5000" value="${draftValue("keywords")}" placeholder="예: catalysis, selectivity, molecular docking" /></label></div>
        <div class="submissionStatementCards"><label class="submissionStatementCard"><span>${heroIcon("book")}<strong>Funding statement</strong></span><small>연구를 지원한 펀딩 기관과 지원 번호</small><textarea name="funding" maxlength="20000" placeholder="지원 정보가 없다면 None을 입력하세요.">${draftValue("funding")}</textarea></label><label class="submissionStatementCard"><span>${heroIcon("grid")}<strong>Competing interests</strong></span><small>잠재적 이해 상충과 관련 관계</small><textarea name="competing" maxlength="20000" placeholder="이해 상충이 없다면 None을 입력하세요.">${draftValue("competing")}</textarea></label><label class="submissionStatementCard"><span>${heroIcon("sparkles")}<strong>Author contributions</strong></span><small>각 저자의 실제 기여와 책임 범위</small><textarea name="contributions" maxlength="40000" placeholder="CRediT 역할을 기준으로 작성하세요.">${draftValue("contributions")}</textarea></label></div>
        <details class="submissionMore"><summary>데이터·코드·윤리 및 커버레터 추가</summary><div class="statementGrid"><label class="field"><span>Data availability</span><textarea name="dataAvailability" maxlength="40000">${draftValue("dataAvailability")}</textarea></label><label class="field"><span>Code availability</span><textarea name="codeAvailability" maxlength="40000">${draftValue("codeAvailability")}</textarea></label><label class="field"><span>Ethics statement</span><textarea name="ethics" maxlength="40000">${draftValue("ethics")}</textarea></label></div><label class="field"><span>Cover letter <em>선택</em></span><textarea name="coverLetter" maxlength="100000" rows="4">${draftValue("coverLetter")}</textarea></label></details>${manualAttestations}
        ${validationNotice}${blueprintValidationNotice}<div class="formError" role="alert">${escapeHtml(state.journalActionError)}</div></section>
        <aside class="submissionSummary"><h3>제출 패키지 요약</h3><dl class="summaryPairs"><div><dt>Target journal</dt><dd>${escapeHtml(profile?.journalName || "선택 필요")}</dd></div><div><dt>Manuscript</dt><dd>${escapeHtml(manuscript?.title || "원고 선택 필요")} · v${escapeHtml(manuscript?.currentVersion || "-")}</dd></div></dl><ul><li><span>Blueprint assessment</span><strong>${escapeHtml(blueprintAssessment.status)} · ${escapeHtml(blueprintAssessment.receipt?.structuralStatus || "missing")}</strong></li><li><span>Blueprint closure</span><strong>submission/manuscript-blueprint-assessment.json</strong></li><li><span>Scholarly assessment</span><strong>${escapeHtml(scholarlyAssessment.status)} · ${escapeHtml(scholarlyAssessment.receipt?.scholarlyStatus || "missing")}</strong></li><li><span>Scholarly closure</span><strong>submission/manuscript-scholarly-assessment.json</strong></li><li><span>검증된 규칙</span><strong>${escapeHtml(ruleCount)} / ${escapeHtml(ruleCount)}</strong></li><li><span>수동 확인 필요</span><strong>${escapeHtml(manualCount)}</strong></li><li><span>정확한 그림</span><strong>${escapeHtml(figureCount)}</strong></li><li><span>참고문헌 연결</span><strong>${escapeHtml(referenceCount)}</strong></li></ul><p>${heroIcon("sparkles")}<span>최종 readiness와 ZIP 생성 여부는 host validation이 결정하며, stale assessment는 fail closed 처리됩니다.</span></p></aside></div>
      <footer><span>DOCX · TeX · exact figures · evidence ledger · 2 immutable assessment receipts</span><button class="secondaryButton" type="button" data-action="close-submission-sheet">나중에</button><button class="primaryButton" type="submit" ${state.journalActionBusy ? "disabled" : ""}>${state.journalActionBusy ? "검증 중…" : "다음: 최종 검증"}</button></footer></form></div>`;
  }

  function evidenceGraphInferenceReviewSheet() {
    if (!state.evidenceGraphReviewSheet || !state.evidenceGraph) return "";
    const candidate = evidenceGraphCandidateById(state.selectedEvidenceGraphCandidateId);
    if (!candidate) return "";
    const node = evidenceGraphNodeById(candidate.nodeId);
    const existing = evidenceGraphReviewForCandidate(candidate);
    const decision = existing?.decision || state.evidenceGraphReviewDecision || "accepted";
    return `<div class="dialogScrim evidenceGraphReviewScrim" role="presentation"><form class="scienceDialog evidenceGraphReviewSheet" id="evidence-graph-review-form" role="dialog" aria-modal="true" aria-labelledby="evidence-graph-review-title" data-candidate-id="${escapeHtml(candidate.id)}" data-candidate-sha256="${escapeHtml(candidate.contentSha256)}"><header><div><span>Evidence Graph · human review</span><h2 id="evidence-graph-review-title">${escapeHtml(candidate.label)}</h2></div><button type="button" data-action="close-evidence-graph-review" aria-label="Close inference review">×</button></header><div class="evidenceGraphReviewBody"><section class="evidenceGraphReviewStatement evidenceStatement"><span>${escapeHtml(evidenceGraphKindLabel(candidate.kind))} · ${escapeHtml(candidate.evidencePathNodeIds.length)} exact path nodes · ${escapeHtml(candidate.independentSourceVersionCount)} independent sources</span><strong>${escapeHtml(node?.statement || candidate.label)}</strong><p>${escapeHtml(candidate.rationale)}</p></section><div class="evidenceGraphReviewBoundary"><strong>Review boundary</strong><span>Accepting records that this candidate may proceed to testing or synthesis. It does not change the node from candidate to supported and does not authorize a manuscript conclusion.</span></div><fieldset class="evidenceGraphReviewOptions mirroredChoice"><legend>Decision</legend><label data-decision="accepted"><input type="radio" name="decision" value="accepted" ${decision === "accepted" ? "checked" : ""} required><span><strong>Accept for further work</strong><em>Keep it as a reviewed inference candidate.</em></span></label><label data-decision="rejected"><input type="radio" name="decision" value="rejected" ${decision === "rejected" ? "checked" : ""} required><span><strong>Reject this inference</strong><em>Preserve the rejected review in the immutable audit trail.</em></span></label></fieldset><label class="field"><span>Review rationale</span><textarea name="rationale" required maxlength="20000" rows="4" placeholder="Explain why this inference should proceed or be rejected.">${escapeHtml(existing?.rationale || "")}</textarea></label>${candidate.missingRequirements.length ? `<section class="evidenceGraphReviewMissing"><strong>Still missing</strong><ul>${candidate.missingRequirements.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : ""}<div class="formError" role="alert">${escapeHtml(state.evidenceGraphReviewError)}</div></div><footer><span>Candidate <code>${escapeHtml(evidenceGraphShortHash(candidate.contentSha256))}</code> · graph r${escapeHtml(state.evidenceGraph.revision)}</span><button class="secondaryButton" type="button" data-action="close-evidence-graph-review" ${state.evidenceGraphReviewBusy ? "disabled" : ""}>Cancel</button><button class="primaryButton" type="submit" ${state.evidenceGraphReviewBusy ? "disabled" : ""}>${state.evidenceGraphReviewBusy ? "Saving review…" : existing ? "Append review decision" : "Record review"}</button></footer></form></div>`;
  }

  function episodeResultReviewSheet() {
    const inspection = state.resultReviewInspection;
    if (!state.resultReviewSheet || !inspection?.episode?.result) return "";
    const episode = inspection.episode;
    const result = episode.result;
    const outcome = { supported: "지지됨", contradicted: "반박됨", inconclusive: "결론 유보", "not-tested": "검증되지 않음" }[result.outcome] || result.outcome;
    const disabled = state.resultReviewBusy || state.resultReviewStale;
    const actionLabels = {
      manuscript: "원고에 exact 결과 연결",
      "analysis-plan": "후속 분석계획으로 연결",
      "human-decision": "연구자 결정으로 연결",
      artifact: "exact 아티팩트에서 계속",
      lab: "다음 Lab에서 계속",
    };
    const actionCards = inspection.availableActions.map((action) => `<label class="resultReviewActionCard"><input type="radio" name="selectedNextTrigger" value="${escapeHtml(action.trigger)}" ${state.resultReviewDraft.trigger === action.trigger ? "checked" : ""} ${disabled ? "disabled" : ""} required><span><strong>${escapeHtml(actionLabels[action.destinationKind] || "다음 연구 동작")}</strong><em>${escapeHtml(action.reason)}</em></span></label>`).join("");
    const artifactRows = Array.isArray(result.artifacts) && result.artifacts.length
      ? result.artifacts.map((artifact) => `<li><span>${escapeHtml(artifact.artifactId.slice(0, 8))} · v${escapeHtml(artifact.artifactVersion)}</span><code>${escapeHtml(artifact.contentSha256.slice(0, 12))}…</code></li>`).join("")
      : `<li><span>이 Lab에 바인딩된 아티팩트 없음</span><code>—</code></li>`;
    const stalePanel = state.resultReviewStale
      ? `<section class="resultReviewStale" role="alert" tabindex="-1"><strong>이 결과는 최신 근거가 아닙니다.</strong><span>프로젝트, 계획, 에피소드 또는 아티팩트가 바뀌어 자동 확정하지 않았습니다.</span><button type="button" data-action="reload-result-review">최신 결과 다시 불러오기</button></section>`
      : "";
    const noActions = inspection.availableActions.length ? "" : `<section class="resultReviewStale" role="alert"><strong>이 exact 결과에 연결할 수 있는 다음 동작이 없습니다.</strong><span>선택을 저장하지 않았습니다.</span></section>`;
    return `<div class="bottomSheetScrim episodeResultReviewScrim" role="presentation"><form class="bottomSheet episodeResultReviewSheet" id="episode-result-review-form" role="dialog" aria-modal="true" aria-labelledby="episode-result-review-title" aria-describedby="episode-result-review-summary" tabindex="-1" data-project-id="${escapeHtml(inspection.project.id)}" data-loop-session-id="${escapeHtml(inspection.session.id)}" data-episode-id="${escapeHtml(episode.id)}" data-result-sha256="${escapeHtml(result.resultSha256)}" data-projection-sha256="${escapeHtml(inspection.projectionSha256)}" data-basis-sha256="${escapeHtml(inspection.basisSha256)}"><div class="sheetHandle" aria-hidden="true"></div><header><div><span>결과 검토 · ${escapeHtml(labCapabilityLabel(inspection.labId))} · Episode #${escapeHtml(episode.ordinal)}</span><h2 id="episode-result-review-title">${escapeHtml(episode.objective)}</h2></div><button type="button" data-action="close-result-review" aria-label="결과 검토를 확정하지 않고 닫기" ${state.resultReviewBusy ? "disabled" : ""}>닫기</button></header><div class="resultReviewBody"><section class="resultReviewSummary" id="episode-result-review-summary"><div class="resultReviewOutcome" data-outcome="${escapeHtml(result.outcome)}">${escapeHtml(outcome)}</div><div><strong>관찰 요약</strong><p>${escapeHtml(result.observationSummary)}</p></div><div><strong>결론</strong><p>${escapeHtml(result.conclusion)}</p></div><div><strong>실행이 남긴 제안</strong><p>${escapeHtml(result.nextAction)}</p></div></section><aside class="resultReviewBindings"><strong>정확한 바인딩</strong><dl><div><dt>Episode</dt><dd>v${escapeHtml(episode.version)} · <code>${escapeHtml(result.resultSha256.slice(0, 12))}…</code></dd></div><div><dt>Plan</dt><dd><code>${escapeHtml(episode.planSha256.slice(0, 12))}…</code></dd></div><div><dt>Runs</dt><dd>${escapeHtml(result.runIds.length)}</dd></div><div><dt>Evidence spans</dt><dd>${escapeHtml(result.evidenceSpanIds.length)}</dd></div></dl><ul>${artifactRows}</ul><div class="resultReviewBoundary"><strong>이 화면만으로 말할 수 없는 것</strong><span>${escapeHtml(inspection.boundary)}</span></div></aside>${stalePanel}<section class="resultReviewChoices"><fieldset><legend>결과에 대한 판단</legend><label><input type="radio" name="verdict" value="accepted" ${state.resultReviewDraft.verdict === "accepted" ? "checked" : ""} ${disabled ? "disabled" : ""} required><span><strong>결과를 수락</strong><em>현재 근거를 다음 단계의 입력으로 사용합니다.</em></span></label><label><input type="radio" name="verdict" value="rejected" ${state.resultReviewDraft.verdict === "rejected" ? "checked" : ""} ${disabled ? "disabled" : ""} required><span><strong>결과를 반려</strong><em>감사 기록은 보존하고 재설계 또는 반복 동작을 선택합니다.</em></span></label></fieldset><fieldset><legend>다음 동작을 하나 선택하세요</legend>${actionCards}</fieldset><label class="field resultReviewRationale"><span>선택 근거</span><textarea name="rationale" required maxlength="20000" rows="4" placeholder="이 결과가 선택한 다음 동작으로 이어져야 하는 이유를 기록하세요." ${disabled ? "disabled" : ""}>${escapeHtml(state.resultReviewDraft.rationale)}</textarea></label>${noActions}<div class="formError" role="alert">${escapeHtml(state.resultReviewError)}</div></section></div><footer><span>Episode v${escapeHtml(episode.version)} · result ${escapeHtml(result.resultSha256.slice(0, 12))} · Project v${escapeHtml(inspection.project.version)}</span><button class="secondaryButton" type="button" data-action="close-result-review" ${state.resultReviewBusy ? "disabled" : ""}>결과 화면으로 돌아가기</button><button class="primaryButton" type="submit" ${disabled || !inspection.availableActions.length ? "disabled" : ""}>${state.resultReviewBusy ? "최신 상태 확인 중…" : "다음 동작 확정"}</button></footer></form></div>`;
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
    return `<div class="chatQuestionScrim decisionSheetScrim" role="presentation"><form class="bottomSheet chatQuestionSheet researchDecisionSheet" id="research-decision-form" role="dialog" aria-modal="true" aria-labelledby="research-decision-title" data-chat-question-sheet="true"><header><div><span>Research decision · ${escapeHtml(analysisSpec?.title || "Analysis plan")}</span><h2 id="research-decision-title">${escapeHtml(decision.prompt.title)}</h2></div><button type="button" data-action="defer-research-decision" aria-label="이 결정을 나중에 답하기">×</button></header><div class="decisionSheetBody"><section class="decisionQuestion"><p>${escapeHtml(decision.prompt.question)}</p><div class="decisionWhy"><div><strong>왜 지금 묻나요?</strong><span>${escapeHtml(decision.prompt.whyAsked)}</span></div><div><strong>답하지 않으면</strong><span>${escapeHtml(decision.prompt.impactIfUnanswered)}</span></div></div></section><fieldset class="decisionOptions"><legend>연구 방향을 선택하세요</legend>${optionCards}</fieldset><label class="decisionRationale"><span>선택 이유 <em>선택 사항</em></span><textarea name="rationale" maxlength="8000" rows="3" placeholder="판단 근거, 제약 또는 AI가 다음 단계에서 고려할 내용을 남겨 주세요."></textarea></label><div class="decisionRecommendation"><strong>AI 추천 근거 · 신뢰도 ${escapeHtml(Math.round(Number(decision.recommendation?.confidence || 0) * 100))}%</strong><span>${escapeHtml(decision.recommendation?.rationale || "")}</span></div><div class="formError" role="alert">${escapeHtml(state.decisionError)}</div></div><footer><span>선택은 immutable decision receipt로 저장되며 분석계획 새 버전에 적용됩니다.</span><button class="secondaryButton" type="button" data-action="defer-research-decision" ${state.decisionBusy ? "disabled" : ""}>나중에</button><button class="primaryButton" type="submit" ${state.decisionBusy ? "disabled" : ""}>${state.decisionBusy ? "적용 중…" : "이 선택으로 계속"}</button></footer></form></div>`;
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
    return `<div class="dialogScrim contractSheetScrim" role="presentation"><form class="scienceDialog researchContractSheet" id="research-contract-approval-form" role="dialog" aria-modal="true" aria-labelledby="research-contract-title" aria-describedby="research-contract-summary" tabindex="-1" data-contract-id="${escapeHtml(contract.id)}" data-contract-version="${escapeHtml(contract.version)}" data-project-version="${escapeHtml(projectVersion)}"><header><div class="contractHeaderCopy"><div class="contractHeaderMeta"><span class="contractStatusPill">승인 대기</span><span>AI 초안 · 계약 v${escapeHtml(contract.version)}</span></div><h2 id="research-contract-title">연구 계약 검토</h2><p id="research-contract-summary">실험을 시작하기 전에 목표, 성공 조건과 중단 기준을 확인하세요.</p></div><button class="contractCloseButton" type="button" data-action="close-research-contract-sheet" aria-label="연구 계약 초안을 승인하지 않고 닫기">닫기</button></header><div class="contractSheetBody"><div class="contractMainColumn"><section class="contractObjective"><div class="contractSectionHeading"><strong>연구 목표</strong><span>Objective</span></div><p>${escapeHtml(contract.objective)}</p></section><div class="contractCriteriaGrid"><section class="contractCriteriaCard contractSuccess"><div class="contractCardTitle"><span><strong>성공 기준</strong><em>연구를 계속할 수 있는 조건</em></span></div>${list(contract.successCriteria, "등록된 성공 기준이 없습니다.")}</section><section class="contractCriteriaCard contractFailure"><div class="contractCardTitle"><span><strong>중단 기준</strong><em>중단하거나 다시 설계할 조건</em></span></div>${list(contract.failureCriteria, "등록된 중단 기준이 없습니다.")}</section></div><section class="contractConstraints"><div class="contractSectionHeading"><strong>운영 제약</strong><span>Constraints</span></div>${list(contract.constraints, "추가 운영 제약 없음")}</section></div><aside class="contractSummaryPanel" aria-label="승인할 연구 계약 요약"><div class="contractSummaryHeading"><span>승인 대상</span><strong>현재 버전 고정</strong></div><dl class="contractVersionList"><div><dt>프로젝트</dt><dd>v${escapeHtml(projectVersion)}</dd></div><div><dt>연구 계약</dt><dd>v${escapeHtml(contract.version)}</dd></div><div><dt>계약 ID</dt><dd title="${escapeHtml(contract.id)}">${escapeHtml(contract.id.slice(0, 8))}</dd></div></dl><div class="contractBudget"><span><strong>${escapeHtml(contract.maxEpisodes)}</strong>최대 에피소드</span><span><strong>${escapeHtml(contract.maxWallTimeMinutes)}</strong>최대 시간(분)</span></div><div class="contractApprovalNote"><strong>버전 보호</strong><span>승인 직전에 두 버전을 다시 확인합니다. 변경되면 자동 승인하지 않습니다.</span></div></aside><div class="formError" role="alert">${escapeHtml(state.researchContractError)}</div></div><footer><div class="contractFooterContext"><strong>프로젝트 v${escapeHtml(projectVersion)} · 계약 v${escapeHtml(contract.version)}</strong><span>이 조합만 승인됩니다.</span></div><button class="secondaryButton" type="button" data-action="revise-research-contract" ${state.researchContractBusy ? "disabled" : ""}>수정 요청</button><button class="primaryButton" type="submit" ${!ready || state.researchContractBusy ? "disabled" : ""}>${state.researchContractBusy ? "최신 버전 확인 중…" : `계약 v${escapeHtml(contract.version)} 승인`}</button></footer></form></div>`;
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
    return `<section class="workspace ${state.drawer ? "drawerOpen" : ""}" data-workspace-mode="${escapeHtml(state.mode)}" data-project-destination="${escapeHtml(state.currentDestination)}" data-rail-collapsed="${state.railCollapsed}">${projectRail(project)}<button class="railScrim" data-action="collapse-rail" aria-label="사이드바 닫기"></button><main class="mainPane"><header class="topbar"><div class="topLocation workspaceLocation"><button class="workspaceSidebarReveal" data-action="expand-rail" aria-label="사이드바 열기" title="사이드바 열기">${heroIcon("chevron-right")}</button><div class="workspaceTabGroup" role="tablist" aria-label="연구, 열린 Lab 아티팩트와 원고">${researchWorkspaceTabButton()}<div class="workspaceTabsShell" data-workspace-tabs-shell><button class="workspaceTabOverflow workspaceTabOverflowPrevious" type="button" data-action="scroll-workspace-tabs" data-direction="previous" aria-label="이전 열린 탭 보기" hidden>${heroIcon("chevron-right", "uiIcon isReverse")}</button><nav class="workspaceTabs" data-workspace-tabs role="presentation">${workspaceTabButtons()}</nav><button class="workspaceTabOverflow workspaceTabOverflowNext" type="button" data-action="scroll-workspace-tabs" data-direction="next" aria-label="다음 열린 탭 보기" hidden>${heroIcon("chevron-right")}</button></div></div><button class="workspaceTabAdd" data-action="new" aria-label="새 연구 시작" title="새 연구">${heroIcon("plus")}</button></div><div class="topActions">${state.workspaceSyncError ? `<span class="workspaceSyncWarning" role="status" title="${escapeHtml(state.workspaceSyncError)}">저장 실패</span>` : ""}<span class="statusPill" title="${escapeHtml(`${lifecycleLabel()} · ${state.lifecycle?.stateSha256 || ""}`)}">${escapeHtml(lifecycleCompactLabel())}</span><button data-action="toggle-drawer">${state.mode === "session" ? "근거" : "세부"}</button></div></header><div class="workspaceBody"><div class="contentPane workspaceCenter"><div class="workspaceSurface" id="science-workspace-panel" role="tabpanel" aria-labelledby="${escapeHtml(workspaceTabDomId(state.activeWorkspaceTabId))}" data-workspace-surface>${main}</div></div>${chatDock()}</div></main>${contextDrawer()}${modal()}${manuscriptModal()}${journalTargetSheet()}${submissionExportSheet()}${evidenceGraphInferenceReviewSheet()}${episodeResultReviewSheet()}${researchContractApprovalSheet()}${researchDecisionSheet()}</section>`;
  }

  function rememberScroll(mode = state.mode) {
    const pane = document.querySelector(".contentPane");
    if (pane) state.scrollByMode[mode] = pane.scrollTop;
  }

  function render() {
    const selectedRendererIdentity = (() => {
      if (state.mode !== "lab" || state.inspectedArtifactVersion) return null;
      const artifacts = (state.labContextsById.get(state.selectedLabId) || []).map((context) => context.artifact);
      const artifact = artifacts.find((item) => item.id === state.selectedArtifactId) || artifacts[0];
      return artifact ? `${artifact.id}:${artifact.version.version}:${artifact.version.contentSha256}` : null;
    })();
    const preserveNativeRenderer = Boolean(state.activeRendererIdentity
      && state.activeRendererIdentity === selectedRendererIdentity
      && !state.modal
      && !(state.drawer && innerWidth < 1100));
    teardownArtifactRenderer(preserveNativeRenderer);
    root.innerHTML = workspace();
    i18n.localizeTree(root);
    root.setAttribute("aria-busy", "false");
    const contentPane = document.querySelector(".contentPane");
    if (contentPane) contentPane.scrollTop = state.scrollByMode[state.mode] || 0;
    if (state.modal) document.querySelector('textarea[name="question"]')?.focus();
    if (state.researchContractSheet) requestAnimationFrame(() => document.querySelector(".researchContractSheet")?.focus({ preventScroll: true }));
    if (!state.resultReviewSheet && state.mode === "lab" && state.selectedArtifactId && state.artifactHistoryById.has(state.selectedArtifactId)) {
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

  function focusScienceDialog(selector, controlSelector = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])') {
    requestAnimationFrame(() => document.querySelector(`${selector} ${controlSelector}`)?.focus({ preventScroll: true }));
  }

  function syncRailPresentation() {
    const workspaceNode = document.querySelector(".workspace");
    const main = workspaceNode?.querySelector(".mainPane");
    if (!workspaceNode || !main) return;
    workspaceNode.dataset.railCollapsed = String(state.railCollapsed);
    const overlayOpen = !state.railCollapsed && window.matchMedia("(max-width: 1279px)").matches;
    if (overlayOpen || state.resultReviewSheet) main.setAttribute("inert", "");
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

  function teardownArtifactRenderer(preserveNativeRenderer = false) {
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
    if (state.activeRendererIdentity && !preserveNativeRenderer) {
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
        const runtime = window.vega.parse(compileArtifactVegaSpec(spec), undefined, { ast: true });
        const view = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host).hover();
        const width = Math.max(220, Math.floor(host.getBoundingClientRect().width) - 110);
        view.width(width).height(230);
        state.inlineVegaViews.push(view);
        await view.runAsync();
        fitArtifactVegaCanvas(host, { gutter: 8 });
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
          host.innerHTML = refusalMarkup("absent", "검증된 시각 캡처가 아직 없습니다.", "실행이 캡처를 만들면 이 자리에 그대로 표시됩니다.");
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
    // NOT `statisticsMethod`: the launch card's method picker uses that attribute, and the change
    // handler finds its control with closest("[data-statistics-method]"). While an analysis was on
    // screen, any event inside this surface matched here instead and set the chosen method to
    // undefined -- and a QA looking for the picker found this section first.
    surface.dataset.statisticsAnalysisMethod = String(payload.method || "");
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
      const runtime = window.vega.parse(compileArtifactVegaSpec(compileStatisticsVisualization(result, selectedChart.visualization)), undefined, { ast: true });
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
          const td = document.createElement("td"); const value = row[column.key]; td.dataset.logicalType = column.type;
          // The exact value stays on the cell: the rounding is for reading, and a reader who needs
          // the full precision must be able to get it without going back to the receipt.
          td.textContent = formatScienceCell(value, column.type);
          if (typeof value === "number" && Number.isFinite(value)) td.title = String(value);
          if (value === null || value === undefined) td.dataset.null = "true"; tr.append(td);
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

  async function renderPaleontologyEvidence(version, host, artifactId, interactive = true) {
    state.activeVegaView?.finalize?.();
    state.activeVegaView = null;
    const payload = paleontologyArtifactPayload(version);
    const tablePayload = paleontologyPublicationTablePayload(version);
    if (!payload || !tablePayload || !payload.spec || typeof payload.spec !== "object" || Array.isArray(payload.spec)) {
      throw new Error("science-paleontology-artifact-invalid");
    }
    const requested = state.paleontologyViewByArtifact.get(artifactId);
    const view = requested === "table" ? "table" : "figure";
    const analysis = payload.analysis;
    const estimates = analysis.estimates;
    const surface = document.createElement("section");
    surface.className = "statisticsAnalysisSurface";
    surface.dataset.scienceCapture = "";
    surface.dataset.paleontologyEvidence = artifactId;
    surface.dataset.catalogRunId = String(payload.source.parentRunId || "");
    surface.dataset.analysisRunId = String(payload.source.analysisRunId || "");
    surface.dataset.analysisSha256 = String(analysis.analysisSha256 || "");
    surface.dataset.occurrenceCount = String(estimates.occurrenceCount);
    surface.dataset.oldestBoundMa = String(estimates.oldestBoundMa);
    surface.dataset.youngestBoundMa = String(estimates.youngestBoundMa);
    surface.dataset.parentTruncated = String(analysis.source.parentTruncated === true);
    const header = document.createElement("header");
    header.className = "statisticsAnalysisHeader";
    const identity = document.createElement("div");
    const kicker = document.createElement("span"); kicker.textContent = "PBDB · INTERVAL-PRESERVING EVIDENCE";
    const title = document.createElement("strong"); title.textContent = analysis.source.taxonName;
    const receipt = document.createElement("code"); receipt.title = analysis.analysisSha256; receipt.textContent = `${String(analysis.analysisSha256).slice(0, 12)}…`;
    identity.append(kicker, title, receipt);
    const nav = document.createElement("nav"); nav.setAttribute("aria-label", "Paleontology evidence view");
    for (const [value, label] of [["figure", "Interval chart"], ["table", `Publication table · ${tablePayload.rows.length}`]]) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.paleontologyView = value; button.textContent = label;
      button.setAttribute("aria-pressed", String(view === value)); button.disabled = !interactive;
      nav.append(button);
    }
    header.append(identity, nav);
    const content = document.createElement("div"); content.className = "statisticsAnalysisContent";
    surface.append(header, content);
    host.replaceChildren(surface);
    if (view === "figure") {
      if (!window.vega || !window.vegaExpressionInterpreter) throw new Error("science-paleontology-vega-runtime-missing");
      content.classList.add("statisticsChartHost");
      const runtime = window.vega.parse(compileArtifactVegaSpec(payload.spec), undefined, { ast: true });
      state.activeVegaView = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(content).hover();
      await state.activeVegaView.runAsync();
      const canvas = content.querySelector("canvas");
      if (!canvas) throw new Error("science-paleontology-vega-canvas-missing");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      fitArtifactVegaCanvas(content, { capture: true, gutter: 10 });
      const footer = document.createElement("footer");
      const copy = document.createElement("div");
      const caption = document.createElement("strong"); caption.textContent = `${estimates.oldestBoundMa}–${estimates.youngestBoundMa} Ma reported envelope`;
      const boundary = document.createElement("span"); boundary.dataset.evidenceBoundary = "true"; boundary.textContent = PALEONTOLOGY_BOUNDARY;
      const count = document.createElement("span"); count.textContent = `${estimates.occurrenceCount.toLocaleString("en-US")} occurrences · ${estimates.formationCount.toLocaleString("en-US")} formations`;
      copy.append(caption, boundary); footer.append(copy, count); content.append(footer);
    } else {
      const viewport = document.createElement("div"); viewport.className = "dataTableViewport";
      const table = document.createElement("table");
      const thead = document.createElement("thead"); const headRow = document.createElement("tr");
      for (const column of tablePayload.columns) {
        const th = document.createElement("th"); th.dataset.columnId = column.name;
        if (column.name === "maxMa" || column.name === "minMa") th.dataset.intervalBound = column.name === "maxMa" ? "older" : "younger";
        const label = document.createElement("span"); label.textContent = column.label;
        const type = document.createElement("em"); type.textContent = [column.logicalType, column.unit].filter(Boolean).join(" · ");
        th.append(label, type); headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement("tbody");
      for (const row of tablePayload.rows) {
        const tr = document.createElement("tr"); tr.dataset.occurrenceId = String(row.occurrenceId || "");
        for (const column of tablePayload.columns) {
          const td = document.createElement("td"); const value = row[column.name]; td.dataset.logicalType = column.logicalType;
          if (column.name === "maxMa" || column.name === "minMa") td.dataset.intervalBound = column.name === "maxMa" ? "older" : "younger";
          td.textContent = value === null ? "—" : String(value); if (value === null) td.dataset.null = "true";
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody); viewport.append(table); content.append(viewport);
      const footer = document.createElement("footer");
      const copy = document.createElement("div"); const caption = document.createElement("strong"); caption.textContent = tablePayload.title;
      const notes = document.createElement("span"); notes.textContent = `${PALEONTOLOGY_BOUNDARY} ${tablePayload.notes.join(" ")}`; copy.append(caption, notes);
      const count = document.createElement("span"); count.textContent = `${tablePayload.rows.length.toLocaleString("en-US")} rows · ${tablePayload.columns.length.toLocaleString("en-US")} columns`;
      footer.append(copy, count); content.append(footer);
    }
    host.dataset.paleontologyReady = "true";
    host.dataset.paleontologyView = view;
    host.dataset.tableRows = String(tablePayload.rows.length);
    return { view, rowCount: tablePayload.rows.length, columnCount: tablePayload.columns.length };
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
    if (paleontologyArtifactPayload(version)) {
      try { await renderPaleontologyEvidence(version, host, context.artifact.id, false); } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); host.dataset.renderFailed = "true"; }
      return;
    }
    if (version.rendererId === NUMERIC_SURFACE_RENDERER) {
      try { renderNumericSurface(version, host, context.artifact.id, false); } catch (error) { host.textContent = error instanceof Error ? error.message : String(error); host.dataset.renderFailed = "true"; }
      return;
    }
    if (version.rendererId === "agentlas.vega") {
      const spec = version.payload?.spec;
      if (!spec || typeof spec !== "object" || Array.isArray(spec) || !window.vega || !window.vegaExpressionInterpreter) {
        host.innerHTML = refusalMarkup("absent", "검증된 Vega 명세 또는 렌더러가 없습니다.", "그릴 명세와 그것을 그릴 렌더러 둘 중 하나가 아직 준비되지 않았습니다.");
        host.dataset.renderFailed = "true";
        return;
      }
      try {
        const runtime = window.vega.parse(compileArtifactVegaSpec(spec), undefined, { ast: true });
        state.activeVegaView = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host).hover();
        const width = Math.max(260, Math.floor(host.getBoundingClientRect().width) - 48);
        state.activeVegaView.width(width).height(330);
        await state.activeVegaView.runAsync();
        fitArtifactVegaCanvas(host, { gutter: 8 });
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
        host.innerHTML = refusalMarkup("blocked", "이 과거 버전에는 검증된 시각 캡처가 없습니다.", "편집기는 열지 않았습니다. 캡처 없이 편집하면 그림과 근거가 어긋납니다.");
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
    if (paleontologyArtifactPayload(artifact.version)) {
      try {
        const rendered = await renderPaleontologyEvidence(artifact.version, host, artifact.id, true);
        if (rendered.view === "figure") {
          const bundle = await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
          const status = document.querySelector(".rendererStatus");
          if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
        }
      } catch (error) {
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
        const reusingMountedRenderer = state.activeRendererIdentity === identity && Boolean(state.activeRendererInstance);
        state.activeRendererIdentity = identity;
        const status = reusingMountedRenderer
          ? await science.renderers.bounds(mountInput)
          : await science.renderers.mount(mountInput);
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
        if (state.activeRendererIdentity === identity) {
          state.activeRendererIdentity = null;
          state.activeRendererInstance = null;
          state.activeRendererVisible = null;
        }
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
      const runtime = window.vega.parse(compileArtifactVegaSpec(spec), undefined, { ast: true });
      state.activeVegaView = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host).hover();
      if (artifact.version?.payload?.schema === "agentlas.science.statistics-figure-artifact/v1") {
        const availableWidth = Math.max(320, Math.floor((host.clientWidth || 720) - 44));
        const availableHeight = Math.max(260, Math.floor((host.clientHeight || 520) - 44));
        state.activeVegaView.width(Math.min(960, availableWidth)).height(Math.min(560, availableHeight));
      }
      await state.activeVegaView.runAsync();
      const canvas = host.querySelector("canvas");
      if (!canvas) throw new Error("렌더러가 캡처 가능한 캔버스를 만들지 않았습니다.");
      canvas.scrollIntoView({ block: "nearest", inline: "nearest" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      fitArtifactVegaCanvas(host, { capture: true, gutter: 10 });
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
    if (target.dataset.action === "decide-hypothesis") { void decideHypothesis(target.dataset); return; }
    if (target.dataset.action === "toggle-approval-scope") { void toggleApprovalScope(target.dataset.scope); return; }
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
      focusScienceDialog("#evidence-graph-review-form", 'input:not([disabled]), textarea:not([disabled]), button:not([disabled])');
      return;
    }
    if (target.dataset.action === "close-evidence-graph-review") {
      state.evidenceGraphReviewSheet = false;
      state.evidenceGraphReviewBusy = false;
      state.evidenceGraphReviewError = "";
      render();
      return;
    }
    if (target.dataset.action === "close-result-review") {
      if (!state.resultReviewBusy) closeResultReviewSheet();
      return;
    }
    if (target.dataset.action === "reload-result-review") {
      void reloadResultReviewSheet();
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
    if (target.dataset.action === "open-manuscript-insert") { void openManuscriptInsertion(target.dataset.afterNodeId || ""); return; }
    if (target.dataset.action === "close-manuscript-insert") { disposeManuscriptInsertion(); state.manuscriptInsertError = ""; render(); return; }
    if (target.dataset.action === "filter-manuscript-insert") {
      if (state.manuscriptInsertion) state.manuscriptInsertion = { ...state.manuscriptInsertion, filter: target.dataset.manuscriptInsertFilter || "all" };
      render();
      requestAnimationFrame(() => document.querySelector(`[data-manuscript-insert-filter="${CSS.escape(target.dataset.manuscriptInsertFilter || "all")}"]`)?.focus());
      return;
    }
    if (target.dataset.action === "preview-manuscript-artifact") {
      const insertion = state.manuscriptInsertion;
      const candidate = insertion?.candidates?.find((item) => item.candidateId === target.dataset.candidateId)
        || insertion?.candidates?.find((item) => item.artifact?.id === target.dataset.artifactId);
      if (!insertion || !candidate) return;
      state.manuscriptInsertion = { ...insertion, phase: "preview", selectedCandidateId: candidate.candidateId, selectedArtifactId: candidate.artifact?.id || "", caption: manuscriptCandidateCaption(candidate) };
      state.manuscriptInsertError = "";
      render();
      requestAnimationFrame(() => document.querySelector("[data-manuscript-insert-caption]")?.focus());
      return;
    }
    if (target.dataset.action === "back-manuscript-insert") { if (state.manuscriptInsertion) state.manuscriptInsertion = { ...state.manuscriptInsertion, phase: "choose", selectedCandidateId: null, selectedArtifactId: null }; state.manuscriptInsertError = ""; render(); return; }
    if (target.dataset.action === "confirm-manuscript-insert") { void insertValidatedManuscriptArtifact(); return; }
    if (target.dataset.action === "undo-manuscript-transaction") { void undoManuscriptTransaction(target.dataset.transactionId); return; }
    if (target.dataset.action === "pin-manuscript-selection") { void persistManuscriptSelection(target); return; }
    if (target.dataset.action === "clear-manuscript-selection") { state.manuscriptSelectionContext = null; state.manuscriptSelectionError = ""; renderChatDock(); return; }
    if (target.dataset.action === "apply-manuscript-proposal") { void decideManuscriptProposal(target.dataset.proposalId, "apply"); return; }
    if (target.dataset.action === "reject-manuscript-proposal") { void decideManuscriptProposal(target.dataset.proposalId, "reject"); return; }
    if (target.dataset.action === "regenerate-manuscript-proposal") { prepareStaleProposalRegeneration(target.dataset.proposalId); return; }
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
    if (target.dataset.action === "open-journal-sheet") { state.journalSheet = true; state.submissionSheet = false; state.journalActionError = ""; render(); focusScienceDialog("#journal-target-form"); return; }
    if (target.dataset.action === "close-journal-sheet") { state.journalSheet = false; state.journalActionBusy = false; state.journalActionError = ""; render(); return; }
    if (target.dataset.action === "open-submission-sheet") {
      if (!journalProfileById(state.selectedJournalProfileId)) {
        state.journalSheet = true;
        state.submissionSheet = false;
      } else {
        state.submissionSheet = true;
        state.journalSheet = false;
      }
      state.journalActionError = "";
      render();
      if (state.submissionSheet) focusScienceDialog("#submission-export-form");
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
    if (target.dataset.manuscriptOutlineLine && state.manuscriptView === "write") {
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
    if (target.dataset.manuscriptOutlineNode) {
      const block = document.querySelector(`[data-manuscript-node-id="${CSS.escape(target.dataset.manuscriptOutlineNode)}"]`);
      block?.scrollIntoView({ block: "start", behavior: "smooth" });
      block?.setAttribute("tabindex", "-1");
      window.setTimeout(() => block?.focus({ preventScroll: true }), 260);
      return;
    }
    if (target.dataset.manuscriptView) { state.manuscriptView = target.dataset.manuscriptView; render(); if (state.manuscriptView === "preview" || state.manuscriptView === "latex") void requestManuscriptPreview(); return; }
    if (target.dataset.action === "export-manuscript") { void exportManuscript(target.dataset.format || "pdf"); return; }
    if (target.dataset.action === "send-turn") { void startComposerTurn(); return; }
    if (target.dataset.action === "cancel-turn") { void cancelComposerTurn(); return; }
    if (target.dataset.action === "import-csv-dataset") { void importCsvDataset(); return; }
    const mapMode = target.closest("[data-statistics-map-mode]");
    if (mapMode) {
      const property = mapMode.dataset.statisticsMapMode;
      // Switching layout clears the other layout's columns rather than keeping both: a mapping that
      // carries a wide selection AND a name/value pair is ambiguous, and the runtime would have to
      // pick one for the researcher.
      state.statisticsLaunchMapping[property] = mapMode.value === "wide" ? { columns: [] } : { nameColumn: "", valueColumn: "" };
      state.statisticsLaunchError = "";
      render();
      return;
    }
    if (target.dataset.action === "open-statistics-launch") { state.statisticsLaunchOpen = true; state.statisticsLaunchError = ""; render(); return; }
    if (target.dataset.action === "close-statistics-launch") { state.statisticsLaunchOpen = false; render(); return; }
    if (target.dataset.action === "request-statistics-run") { void requestSourceBoundAnalysis(); return; }
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
    if (target.dataset.paleontologyView && state.selectedArtifactId) {
      state.paleontologyViewByArtifact.set(state.selectedArtifactId, target.dataset.paleontologyView === "table" ? "table" : "figure");
      void hydrateArtifactRenderer();
      return;
    }
    if (target.dataset.action === "suggest-publication-figure") {
      state.composerDraft = target.dataset.figurePrompt || "Plan a publication figure for the current project using the installed statistics catalog and exact analysis-run bindings.";
      renderChatDock();
      requestAnimationFrame(() => document.querySelector(".dockedComposer textarea")?.focus());
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
    if (target.dataset.action === "lab-decision-primary") { void runLabDecisionPrimary(target.dataset.labDecisionSha256 || ""); return; }
    if (target.dataset.action === "toggle-lab-decision-details") {
      const labId = target.dataset.labId;
      if (!labId) return;
      if (state.expandedLabDecisions.has(labId)) state.expandedLabDecisions.delete(labId);
      else state.expandedLabDecisions.add(labId);
      render();
      requestAnimationFrame(() => document.querySelector(`[data-action="toggle-lab-decision-details"][data-lab-id="${CSS.escape(labId)}"]`)?.focus());
      return;
    }
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
    if (target.dataset.action === "run-paleontology-analysis") { runPaleontologyAnalysis(target.dataset.catalogRunId || ""); return; }
    if (target.dataset.paleontologyArtifactId) {
      const exactVersion = Number(target.dataset.artifactVersion);
      const action = () => void openLab("paleontology-evidence", target.dataset.paleontologyArtifactId, Number.isSafeInteger(exactVersion) ? exactVersion : null, null, Number.isSafeInteger(exactVersion) ? exactVersion : null);
      if (!guardArtifactDraftNavigation(action)) action();
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
      // A mapping names columns of the PREVIOUS table. Carrying it over would point the projection
      // at columns that may not exist, so the table changing clears it.
      state.statisticsLaunchMapping = {};
      state.statisticsLaunchError = "";
      normalizeStatisticsLaunchSelection();
      render();
      return;
    }
    const statisticsMethod = event.target.closest("[data-statistics-method]");
    if (statisticsMethod) {
      state.statisticsLaunchMethod = statisticsMethod.value;
      state.statisticsLaunchMapping = {};
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const statisticsMethodSearch = event.target.closest("[data-statistics-method-search]");
    if (statisticsMethodSearch) {
      state.statisticsMethodQuery = statisticsMethodSearch.value;
      render();
      return;
    }
    const mapColumn = event.target.closest("[data-statistics-map-column]");
    if (mapColumn) {
      const property = mapColumn.dataset.statisticsMapColumn;
      state.statisticsLaunchMapping[property] = mapColumn.value ? { column: mapColumn.value } : undefined;
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const mapSeries = event.target.closest("[data-statistics-map-series]");
    if (mapSeries) {
      const property = mapSeries.dataset.statisticsMapSeries;
      const current = state.statisticsLaunchMapping[property] || {};
      const chosen = new Set(Array.isArray(current.columns) ? current.columns : []);
      if (mapSeries.checked) chosen.add(mapSeries.value); else chosen.delete(mapSeries.value);
      // Order follows the table's column order, not the order the boxes were ticked, so the series
      // appear in the figure the way they appear in the researcher's sheet.
      const order = statisticsEligibleColumns(statisticsSourceTable()).map((column) => column.name);
      state.statisticsLaunchMapping[property] = { columns: order.filter((name) => chosen.has(name)) };
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const mapName = event.target.closest("[data-statistics-map-name]");
    if (mapName) {
      const property = mapName.dataset.statisticsMapName;
      state.statisticsLaunchMapping[property] = { ...(state.statisticsLaunchMapping[property] || {}), columns: undefined, nameColumn: mapName.value };
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const mapValue = event.target.closest("[data-statistics-map-value]");
    if (mapValue) {
      const property = mapValue.dataset.statisticsMapValue;
      state.statisticsLaunchMapping[property] = { ...(state.statisticsLaunchMapping[property] || {}), columns: undefined, valueColumn: mapValue.value };
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const mapField = event.target.closest("[data-statistics-map-field]");
    if (mapField) {
      const property = mapField.dataset.statisticsMapField;
      const current = state.statisticsLaunchMapping[property] || {};
      const rowColumns = { ...(current.rowColumns || {}) };
      if (mapField.value) rowColumns[mapField.dataset.field] = mapField.value; else delete rowColumns[mapField.dataset.field];
      state.statisticsLaunchMapping[property] = { rowColumns };
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const mapChoice = event.target.closest("[data-statistics-map-choice]");
    if (mapChoice) {
      const property = mapChoice.dataset.statisticsMapChoice;
      const current = state.statisticsLaunchMapping[property] || {};
      const chosen = new Set(Array.isArray(current.choices) ? current.choices : []);
      if (mapChoice.checked) chosen.add(mapChoice.value); else chosen.delete(mapChoice.value);
      state.statisticsLaunchMapping[property] = { ...current, choices: [...chosen] };
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const mapGrouped = event.target.closest("[data-statistics-map-grouped]");
    if (mapGrouped) {
      const property = mapGrouped.dataset.statisticsMapGrouped;
      const current = state.statisticsLaunchMapping[property] || {};
      const valueColumns = { ...(current.valueColumns || {}) };
      if (mapGrouped.value) valueColumns[mapGrouped.dataset.field] = mapGrouped.value; else delete valueColumns[mapGrouped.dataset.field];
      // Keep the group column: it is chosen by its own select, and rebuilding the whole mapping here
      // would silently drop it the moment a value column changed.
      state.statisticsLaunchMapping[property] = { ...current, valueColumns };
      state.statisticsLaunchError = "";
      render();
      return;
    }
    const mapLiteral = event.target.closest("[data-statistics-map-value-literal]");
    if (mapLiteral) {
      state.statisticsLaunchMapping[mapLiteral.dataset.statisticsMapValueLiteral] = { value: mapLiteral.value };
      state.statisticsLaunchError = "";
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
    const manuscriptInsertSearch = event.target.closest("[data-manuscript-insert-search]");
    if (manuscriptInsertSearch && state.manuscriptInsertion) {
      const value = manuscriptInsertSearch.value;
      state.manuscriptInsertion.query = value;
      render();
      requestAnimationFrame(() => {
        const input = document.querySelector("[data-manuscript-insert-search]");
        if (!input) return;
        input.focus();
        input.setSelectionRange(value.length, value.length);
      });
      return;
    }
    const manuscriptInsertCaption = event.target.closest("[data-manuscript-insert-caption]");
    if (manuscriptInsertCaption && state.manuscriptInsertion) {
      state.manuscriptInsertion.caption = manuscriptInsertCaption.value;
      state.manuscriptInsertError = "";
      return;
    }
    const resultReviewForm = event.target.closest("#episode-result-review-form");
    if (resultReviewForm) {
      const form = new FormData(resultReviewForm);
      state.resultReviewDraft = {
        verdict: String(form.get("verdict") || ""),
        trigger: String(form.get("selectedNextTrigger") || ""),
        rationale: String(form.get("rationale") || ""),
      };
      state.resultReviewError = "";
      return;
    }
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

  root.addEventListener("mouseup", () => {
    document.querySelector(".manuscriptSelectionAction")?.remove();
    if (state.mode !== "manuscript" || state.manuscriptView === "preview" || state.manuscriptSelectionBusy) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
    const block = startElement?.closest?.("[data-manuscript-node-id]");
    if (!block || block !== endElement?.closest?.("[data-manuscript-node-id]") || !["heading", "paragraph", "equation", "code"].includes(block.dataset.nodeKind)) return;
    const node = state.manuscriptEditorModel?.document?.nodes?.find((item) => item.id === block.dataset.manuscriptNodeId);
    if (!node) return;
    const sourceText = manuscriptNodeSelectionText(node);
    const prefix = document.createRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(range.startContainer, range.startOffset);
    const startOffset = prefix.toString().length;
    const selectedText = selection.toString();
    const endOffset = startOffset + selectedText.length;
    if (!selectedText.trim() || selectedText.length > 4_000 || sourceText.slice(startOffset, endOffset) !== selectedText) return;
    const canvas = document.querySelector(".manuscriptCanvas");
    if (!canvas) return;
    const selectionRect = range.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "manuscriptSelectionAction";
    button.dataset.action = "pin-manuscript-selection";
    button.dataset.nodeId = node.id;
    button.dataset.startOffset = String(startOffset);
    button.dataset.endOffset = String(endOffset);
    button.dataset.selectedText = selectedText;
    button.setAttribute("aria-label", "Ask Science about selected manuscript text");
    button.textContent = "Ask Science";
    button.style.left = `${Math.max(10, Math.min(canvas.clientWidth - 110, selectionRect.left - canvasRect.left + selectionRect.width / 2 - 50))}px`;
    button.style.top = `${Math.max(8, selectionRect.top - canvasRect.top + canvas.scrollTop - 40)}px`;
    canvas.append(button);
  });

  root.addEventListener("keydown", (event) => {
    const resultReviewDialog = document.querySelector(".episodeResultReviewSheet");
    if (state.resultReviewSheet && resultReviewDialog) {
      if (event.key === "Escape" && !state.resultReviewBusy) {
        event.preventDefault();
        closeResultReviewSheet();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !state.resultReviewBusy && !state.resultReviewStale) {
        event.preventDefault();
        resultReviewDialog.requestSubmit();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...resultReviewDialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
          .filter((element) => !element.hasAttribute("hidden"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last && event.shiftKey && (event.target === first || event.target === resultReviewDialog)) {
          event.preventDefault();
          last.focus();
        } else if (first && last && !event.shiftKey && event.target === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    const dialog = event.target.closest?.('[role="dialog"]') || document.querySelector('[role="dialog"]');
    if (dialog) {
      if (event.key === "Escape") {
        const closeControl = dialog.querySelector('[data-action^="close-"], [data-action="cancel"], [data-action="cancel-manuscript"], [data-action="defer-research-decision"]');
        if (closeControl) {
          event.preventDefault();
          closeControl.click();
          return;
        }
      }
      if (event.key === "Tab") {
        const focusable = [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute("hidden"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last) {
          if (event.shiftKey && (event.target === first || event.target === dialog)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && event.target === last) {
            event.preventDefault();
            first.focus();
          }
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
    if (event.target.id === "episode-result-review-form") {
      event.preventDefault();
      await submitEpisodeResultReview(event.target);
      return;
    }
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
      if (!manuscript || !profile || !state.manuscriptDraft) {
        state.journalActionError = "원고 최신 버전과 검증된 저널 프로필을 먼저 고정해 주세요.";
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
    if (event.target.id === "start-manuscript-research-form") {
      event.preventDefault();
      const form = new FormData(event.target);
      const project = selectedProject();
      const conversation = selectedConversation();
      if (!project || !conversation || state.composerSending) return;
      const job = {
        requestId: crypto.randomUUID(), projectId: project.id, conversationId: conversation.id,
        objective: String(form.get("objective") || "").trim(),
        articleFamily: String(form.get("articleFamily") || "empirical"),
        journalTarget: String(form.get("journalTarget") || "").trim() || null,
        seedBinding: state.pendingManuscriptBinding ? { ...state.pendingManuscriptBinding, target: { ...state.pendingManuscriptBinding.target } } : null,
        existingManuscriptIds: state.manuscripts.map((item) => item.id), status: "collecting-full-text", receipt: null, error: "",
      };
      if (!job.objective) return;
      state.manuscriptDraftJob = job;
      state.manuscriptModal = false;
      state.pendingManuscriptBinding = null;
      state.mode = "session";
      state.currentDestination = "literature";
      state.activeWorkspaceTabId = RESEARCH_TAB_ID;
      state.composerDraft = manuscriptDraftJobPrompt(job);
      render();
      try {
        await startComposerTurn({ forceAppend: true });
        if (state.composerError) {
          state.manuscriptDraftJob = { ...job, status: "failed", error: state.composerError };
          renderChatDock();
        }
      } catch (error) {
        state.manuscriptDraftJob = { ...job, status: "failed", error: error instanceof Error ? error.message : String(error) };
        state.composerError = state.manuscriptDraftJob.error;
        renderChatDock();
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
      // project.create persists the first question as a user message. Start that
      // exact message immediately so a new project opens on a live Research
      // Director turn instead of looking like an empty shell that needs a second
      // manual send.
      if (state.messages.length === 1 && state.messages[0]?.role === "user" && !state.messages.some((message) => message.role === "assistant")) {
        state.composerDraft = "";
        void startComposerTurn();
      }
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
      if (!change || !state.selectedId || change.projectId !== state.selectedId) return;
      // AI-driven research: while a turn is running, every new artifact opens its own Lab tab
      // so the researcher watches results appear (like an activity rail), without stealing a
      // view that holds unsaved edits. Existing-artifact updates fall through to the exact
      // refresh logic below.
      const isKnownArtifact = state.artifacts.some((artifact) => artifact.id === change.artifactId);
      const turnRunning = Boolean(state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status));
      if (!isKnownArtifact && turnRunning && change.artifactId !== state.selectedArtifactId) {
        const editing = Boolean(state.vegaDraft?.dirty || state.manuscriptDraft?.dirty || state.draftHistoryGuard);
        void selectProject(state.selectedId, { preserveWorkspace: true }).then(() => {
          const labId = labIdForArtifact(change.artifactId);
          if (!labId) return;
          const artifact = artifactForLab(labId, change.artifactId);
          if (!artifact) return;
          if (editing || state.mode === "manuscript") {
            ensureArtifactWorkspaceTab(labId, change.artifactId, artifact.currentVersion, null, null);
            render();
            return;
          }
          void openLab(labId, change.artifactId, null, null);
        });
        return;
      }
      if (change.artifactId !== state.selectedArtifactId) return;
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
        science.decisions.list(projectId, undefined, ["queued", "presented", "deferred"]),
        science.labs.decisionProjections(projectId),
      ]).then(([lifecycle, decisions, labDecisionProjections]) => {
        if (projectId !== state.selectedId || lifecycle?.projectId !== projectId) return;
        if (lifecycle.studyId !== change.studyId || lifecycle.revision !== change.revision || lifecycle.stateSha256 !== change.stateSha256) {
          throw new Error("science-research-lifecycle-event-integrity-failed");
        }
        state.lifecycle = lifecycle;
        state.decisions = Array.isArray(decisions) ? decisions : [];
        state.labDecisionProjections = Array.isArray(labDecisionProjections) ? labDecisionProjections : [];
        const manuscript = manuscriptById(state.selectedManuscriptId);
        const draft = state.manuscriptDraft;
        const claimReady = manuscript && draft ? claimLedgerIsCurrent(manuscript, draft) : false;
        const journalProfile = journalProfileById(state.selectedJournalProfileId);
        const lifecycleBoundExport = manuscript && claimReady
          ? state.submissionExports.find((item) => submissionExportBindsResearchState(item, manuscript) && submissionExportBindsJournalProfile(item, journalProfile))
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
          recordRunFailure(turn.status === "completed" ? "" : (turn.errorCode || `연구 실행이 ${turn.status} 상태로 종료되었습니다.`));
          if (projectId) {
            if (state.mode === "lab") void refreshConversationOnly(projectId).catch((error) => {
              recordRunFailure(error);
            });
            else void selectProject(projectId, { preserveWorkspace: true });
          }
          return;
        }
        renderChatDock();
      }).catch((error) => {
        recordRunFailure(error);
      });
    });
    state.projects = Array.isArray(bootstrap.projects) ? bootstrap.projects : [];
    state.rendererPacks = Array.isArray(bootstrap.rendererPacks) ? bootstrap.rendererPacks : [];
    if (state.projects[0]) await selectProject(state.projects[0].id); else render();
  }

  void start().catch(fatal);
})();
