import * as THREE from "../vendor/three.module.min.js";
import { formatScienceCell } from "./format-cell.js";
// Generated presentation-only snapshot of shared/agent-control-blocks.ts and
// the marker constants/stripper in electron/hephaestus/loop-engineering.ts.
// Regenerate from those canonical sources; never change raw receipts or hashes.
const scienceChatPresentation = (() => {
  const exports = {};
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.STORMBREAKER_LONG_RUN_MARKER = exports.STORMBREAKER_CONTINUE_MARKER = exports.AGENT_GOAL_COMPLETE_PREFIX = exports.AGENT_SURFACE_INTENT_MARKER = exports.AGENT_MULTIMODAL_MARKER = exports.AGENT_SURFACE_CLOSE = exports.AGENT_SURFACE_OPEN = exports.AGENT_FOLLOWUPS_CLOSE = exports.AGENT_FOLLOWUPS_OPEN = exports.AGENT_ASK_CLOSE = exports.AGENT_ASK_OPEN = exports.AGENT_CONTROL_HEADINGS = void 0;
  exports.stripAgentIdentityBadges = stripAgentIdentityBadges;
  exports.stripAgentControlBlocks = stripAgentControlBlocks;
  exports.stripOrphanCodeFences = stripOrphanCodeFences;
  exports.trimIncompleteControlTail = trimIncompleteControlTail;
  exports.trimIncompleteMarkerTail = trimIncompleteMarkerTail;
  exports.stripStormbreakerContinueMarker = stripStormbreakerContinueMarker;
  exports.AGENT_CONTROL_HEADINGS = [
      "## Memory Events",
      "## Delegate",
      "## Automation",
  ];
  exports.AGENT_ASK_OPEN = "<<agentlas-ask>>";
  exports.AGENT_ASK_CLOSE = "<</agentlas-ask>>";
  exports.AGENT_FOLLOWUPS_OPEN = "<<agentlas-one-followups>>";
  exports.AGENT_FOLLOWUPS_CLOSE = "<</agentlas-one-followups>>";
  exports.AGENT_SURFACE_OPEN = "<<agentlas-surface>>";
  exports.AGENT_SURFACE_CLOSE = "<</agentlas-surface>>";
  exports.AGENT_MULTIMODAL_MARKER = "<<agentlas-multimodal-setup>>";
  exports.AGENT_SURFACE_INTENT_MARKER = "<<surface-intent>>";
  exports.AGENT_GOAL_COMPLETE_PREFIX = "<<agentlas-goal-complete";
  const IDENTITY_BADGE = /(^|\s)(?:\*\*)?\[\s*(?:[A-Z][A-Za-z .'-]{0,31}|[\u3131-\u318e\uac00-\ud7a3]{1,16})\s*\](?:\*\*)?(?=\s|$)/gu;
  function stripAgentIdentityBadges(value) {
      return value.replace(IDENTITY_BADGE, (match, prefix, offset, source) => {
          const after = source.charAt(offset + match.length);
          return (prefix === " " || prefix === "\t") && (after === " " || after === "\t") ? "" : prefix;
      }).trim();
  }
  const PAIRED_BLOCKS = [
      { probe: "<<agentlas-one-followups", open: exports.AGENT_FOLLOWUPS_OPEN, close: exports.AGENT_FOLLOWUPS_CLOSE },
      { probe: "<<agentlas-ask", open: exports.AGENT_ASK_OPEN, close: exports.AGENT_ASK_CLOSE },
      { probe: "<<agentlas-surface", open: exports.AGENT_SURFACE_OPEN, close: exports.AGENT_SURFACE_CLOSE },
  ];
  const GOAL_COMPLETE_RE = /<<agentlas-goal-complete(?::[\s\S]*?)?>>/g;
  const FENCE_RE = /```(?:json)?\s*[\s\S]*?```/;
  const TAIL_TOKENS = [
      ...exports.AGENT_CONTROL_HEADINGS,
      exports.AGENT_ASK_OPEN,
      exports.AGENT_FOLLOWUPS_OPEN,
      exports.AGENT_SURFACE_OPEN,
      exports.AGENT_MULTIMODAL_MARKER,
      exports.AGENT_SURFACE_INTENT_MARKER,
      exports.AGENT_GOAL_COMPLETE_PREFIX,
  ];
  const BARE_MARKERS = [exports.AGENT_MULTIMODAL_MARKER, exports.AGENT_SURFACE_INTENT_MARKER];
  const MIN_PARTIAL_TAIL = 4;
  const DANGLING_HEADING_DROPS_TAIL = new Set([
      "## Memory Events",
  ]);
  function headingHit(value, heading) {
      const start = value.indexOf(heading);
      if (start < 0)
          return null;
      const after = value.slice(start + heading.length);
      const fence = after.match(FENCE_RE);
      if (fence && fence.index != null) {
          return { index: start, cutTo: start + heading.length + fence.index + fence[0].length };
      }
      return {
          index: start,
          cutTo: DANGLING_HEADING_DROPS_TAIL.has(heading) ? value.length : start + heading.length,
      };
  }
  function pairedHit(value, block) {
      const start = value.indexOf(block.probe);
      if (start < 0)
          return null;
      if (!value.startsWith(block.open, start))
          return { index: start, cutTo: value.length };
      const end = value.indexOf(block.close, start + block.open.length);
      return end < 0
          ? { index: start, cutTo: value.length }
          : { index: start, cutTo: end + block.close.length };
  }
  function stripAgentControlBlocks(value, options) {
      let visible = value.replace(GOAL_COMPLETE_RE, "");
      for (const marker of BARE_MARKERS)
          visible = visible.split(marker).join("");
      for (let guard = 0; guard < 64; guard += 1) {
          let best = null;
          for (const heading of exports.AGENT_CONTROL_HEADINGS) {
              const hit = headingHit(visible, heading);
              if (hit && (best === null || hit.index < best.index))
                  best = hit;
          }
          for (const block of PAIRED_BLOCKS) {
              const hit = pairedHit(visible, block);
              if (hit && (best === null || hit.index < best.index))
                  best = hit;
          }
          if (best === null)
              break;
          const next = visible.slice(0, best.index) + visible.slice(best.cutTo);
          if (next === visible)
              break;
          visible = next;
      }
      visible = visible
          .split(exports.AGENT_ASK_CLOSE)
          .join("")
          .split(exports.AGENT_FOLLOWUPS_CLOSE)
          .join("")
          .split(exports.AGENT_SURFACE_CLOSE)
          .join("");
      visible = failClosedOnRemainingControlToken(visible);
      visible = stripTrailingMemoryTicketEnvelope(visible);
      visible = options?.streaming ? trimIncompleteControlTail(visible) : trimIncompleteMarkerTail(visible);
      visible = stripOrphanCodeFences(visible);
      return visible.replace(/\n{3,}/g, "\n\n").trim();
  }
  const FENCE_LINE_RE = /^[ \t]*```[A-Za-z0-9_+.-]*[ \t]*$/;
  const CLOSING_FENCE_LINE_RE = /^[ \t]*```[ \t]*$/;
  function stripOrphanCodeFences(value) {
      const lines = value.split("\n");
      const out = [];
      let index = 0;
      while (index < lines.length) {
          const line = lines[index];
          if (!FENCE_LINE_RE.test(line)) {
              out.push(line);
              index += 1;
              continue;
          }
          let close = index + 1;
          while (close < lines.length && !CLOSING_FENCE_LINE_RE.test(lines[close]))
              close += 1;
          const bodyIsBlank = lines.slice(index + 1, close).every((body) => body.trim() === "");
          if (close >= lines.length) {
              if (!bodyIsBlank)
                  out.push(...lines.slice(index));
              break;
          }
          if (!bodyIsBlank)
              out.push(...lines.slice(index, close + 1));
          index = close + 1;
      }
      return out.join("\n");
  }
  function failClosedOnRemainingControlToken(value) {
      let cut = value.length;
      for (const token of TAIL_TOKENS) {
          const index = value.indexOf(token);
          if (index >= 0 && index < cut)
              cut = index;
      }
      return cut === value.length ? value : value.slice(0, cut);
  }
  const TAIL_JSON_FENCE_RE = /(?:^|\n)```json\s*([\s\S]*?)```\s*$/i;
  function stripTrailingMemoryTicketEnvelope(value) {
      const match = value.match(TAIL_JSON_FENCE_RE);
      if (!match || match.index == null)
          return value;
      try {
          const data = JSON.parse(match[1].trim());
          if (data?.schema_version === "agentlas.memory-ticket.v1" && Array.isArray(data.candidates)) {
              return value.slice(0, match.index);
          }
      }
      catch {
      }
      return value;
  }
  function trimIncompleteControlTail(value) {
      return trimIncompleteTail(value, TAIL_TOKENS);
  }
  function trimIncompleteMarkerTail(value) {
      return trimIncompleteTail(value, TAIL_TOKENS.filter((token) => token.startsWith("<<")));
  }
  function trimIncompleteTail(value, tokens) {
      let cut = value.length;
      for (const token of tokens) {
          for (let length = Math.min(token.length - 1, value.length); length >= MIN_PARTIAL_TAIL; length -= 1) {
              if (value.endsWith(token.slice(0, length))) {
                  cut = Math.min(cut, value.length - length);
                  break;
              }
          }
      }
      return cut === value.length ? value : value.slice(0, cut);
  }
  exports.STORMBREAKER_CONTINUE_MARKER = "<<stormbreaker-continue>>";
  exports.STORMBREAKER_LONG_RUN_MARKER = "<<stormbreaker-long-run>>";
  function stripStormbreakerContinueMarker(text) {
      const escaped = exports.STORMBREAKER_CONTINUE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const trimmed = text.trimEnd();
      const tail = trimmed.split("\n").slice(-3).join("\n");
      const shouldContinue = new RegExp(escaped).test(tail);
      const cleaned = trimmed
          .replace(new RegExp(`[ \\t]*${escaped}[ \\t]*`, "g"), "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      return { text: cleaned, shouldContinue };
  }
  return exports;
})();
const { stripAgentControlBlocks, stripStormbreakerContinueMarker, STORMBREAKER_CONTINUE_MARKER, STORMBREAKER_LONG_RUN_MARKER } = scienceChatPresentation;

// COMPOSER_EVENT_SYNC_BEGIN
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function composerEventKey(event) {
  return `${event.projectId}:${event.conversationId}:${event.turnId}`;
}

function sameComposerTurn(left, right) {
  return left?.projectId === right?.projectId
    && left?.conversationId === right?.conversationId
    && left?.turnId === right?.turnId;
}

function isNewerComposerEvent(candidate, current) {
  if (!current) return true;
  if (!sameComposerTurn(candidate, current)) return true;
  return Number(candidate.sequence) > Number(current.sequence);
}

/**
 * Coalesce the high-frequency persisted composer event stream into receipt reads.
 * The store remains the source of truth; this only prevents every tiny runtime-usage
 * event from starting its own IPC read and terminal project hydration.
 */
function createComposerEventSync({
  getCurrentScope,
  getCurrentConversationScope,
  readReceipt,
  readAttach,
  onAttach,
  onProgress,
  onTerminal,
  onError,
}) {
  let disposed = false;
  let draining = false;
  let pendingEvent = null;
  const receiptFailures = new Map();
  const terminalFailures = new Map();
  const hydratedTerminalTurns = new Set();

  const currentConversationScope = () => {
    const scope = typeof getCurrentConversationScope === "function" ? getCurrentConversationScope() : getCurrentScope();
    return scope && scope.projectId && scope.conversationId ? scope : null;
  };

  const isCurrentConversationEvent = (event) => {
    const scope = currentConversationScope();
    return Boolean(scope
      && event?.projectId === scope.projectId
      && event.conversationId === scope.conversationId);
  };

  const queueLatest = (event) => {
    if (!pendingEvent || isNewerComposerEvent(event, pendingEvent)) pendingEvent = event;
  };

  const trimTerminalHistory = () => {
    if (hydratedTerminalTurns.size <= 128) return;
    hydratedTerminalTurns.delete(hydratedTerminalTurns.values().next().value);
  };

  const drain = async () => {
    if (disposed || draining) return;
    draining = true;
    try {
      while (!disposed && pendingEvent) {
        const event = pendingEvent;
        pendingEvent = null;
        if (!isCurrentConversationEvent(event)) continue;

        const key = composerEventKey(event);
        let turn;
        try {
          const current = getCurrentScope();
          if (!current || current.turnId !== event.turnId) {
            if (typeof readAttach !== "function") continue;
            const attached = await readAttach({
              projectId: event.projectId,
              conversationId: event.conversationId,
            });
            if (disposed || !isCurrentConversationEvent(event)) continue;
            const attachedTurn = attached?.turn;
            if (!attachedTurn
              || attachedTurn.projectId !== event.projectId
              || attachedTurn.conversationId !== event.conversationId) continue;
            onAttach?.(attachedTurn, event);
            if (attachedTurn.id !== event.turnId) continue;
          }
          turn = await readReceipt({
            projectId: event.projectId,
            conversationId: event.conversationId,
            turnId: event.turnId,
          });
          receiptFailures.delete(key);
        } catch (error) {
          if (disposed || !isCurrentConversationEvent(event)) continue;
          const failures = (receiptFailures.get(key) || 0) + 1;
          receiptFailures.set(key, failures);
          if (failures === 1) {
            queueLatest(event);
          } else {
            receiptFailures.delete(key);
            onError(error, event);
          }
          continue;
        }

        if (disposed) continue;
        const scope = getCurrentScope();
        if (!scope || !turn
          || turn.projectId !== scope.projectId
          || turn.conversationId !== scope.conversationId
          || turn.id !== scope.turnId
          || turn.lastSequence < scope.lastSequence) continue;

        if (pendingEvent && sameComposerTurn(pendingEvent, event)) {
          if (Number(pendingEvent.sequence) > Number(turn.lastSequence)) continue;
          pendingEvent = null;
        }

        if (!TERMINAL_TURN_STATUSES.has(turn.status)) {
          onProgress(turn, event);
          continue;
        }

        if (hydratedTerminalTurns.has(key)) continue;
        hydratedTerminalTurns.add(key);
        trimTerminalHistory();
          try {
            await onTerminal(turn, event);
            terminalFailures.delete(key);
          } catch (error) {
            hydratedTerminalTurns.delete(key);
            if (disposed || !isCurrentConversationEvent(event)) continue;
          const failures = (terminalFailures.get(key) || 0) + 1;
          terminalFailures.set(key, failures);
          if (failures === 1) queueLatest(event);
          else {
            terminalFailures.delete(key);
            onError(error, event);
          }
        }
      }
    } finally {
      draining = false;
      if (!disposed && pendingEvent) void drain();
    }
  };

  return {
    push(event) {
      if (disposed || !isCurrentConversationEvent(event)) return false;
      if (hydratedTerminalTurns.has(composerEventKey(event))) return false;
      queueLatest(event);
      void drain();
      return true;
    },
    dispose() {
      disposed = true;
      pendingEvent = null;
      receiptFailures.clear();
      terminalFailures.clear();
      hydratedTerminalTurns.clear();
    },
  };
}
// COMPOSER_EVENT_SYNC_END

(() => {
  "use strict";

  const root = document.getElementById("app");
  const science = window.agentlasScience;
  const i18n = window.agentlasScienceI18n;
  const RAIL_COLLAPSED_STORAGE_KEY = "agentlas.science.left-rail-collapsed.v1";
  const readRailCollapsed = () => {
    try { return window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY) === "true"; } catch { return false; }
  };
  const blankNewProjectDraft = () => ({ title: "", question: "", folderSelectionId: null, folderPath: "" });
  const state = {
    locale: "en",
    projects: [], selectedId: null, lifecycle: null, researchLoopInspection: null, researchLoopActionBusy: false, researchLoopActionError: "", conversations: [], selectedConversationId: null, messages: [], sources: [], sourceFigures: [], runs: [], artifacts: [], labs: [], workspaceLabBindings: [], labCatalog: [], labDecisionProjections: [], rendererPacks: [], manuscripts: [], claimLedger: null, journalProfiles: [], submissionExports: [], analysisSpecs: [], decisions: [],
    artifactContextsByMessage: new Map(), labContextsById: new Map(), artifactHistoryById: new Map(), selectedLabId: null, selectedArtifactOriginVersion: null, inspectedArtifactVersion: null, inspectedArtifactContext: null, artifactComparison: null, draftHistoryGuard: null, labsExpanded: true, expandedLabGroups: new Set(["chemistry"]), expandedLabDecisions: new Set(), projectMenuOpen: false, projectFolderOpen: false, projectLibrarySummaries: new Map(), projectLibrarySummaryState: "loading", librarySearch: "", librarySelectedProjectId: null, projectFolderSelectedKey: null, newProjectStep: "details", selectedResearchTemplateId: null, newProjectDraft: blankNewProjectDraft(), newProjectFolderError: "", newProjectFolderBusy: false, newProjectGeneration: 0, newProjectRequestId: null, newProjectRequestSignature: "", labManagerOpen: false, labManagerBusyId: null, labManagerGeneration: 0, labManagerError: "", historyOpen: false, railCollapsed: readRailCollapsed(),
    blocksByMessage: new Map(), citationsByMessage: new Map(), evidenceById: new Map(), selectedSourceId: null, selectedArtifactId: null,
    evidenceGraph: null, evidenceGraphReviews: [], evidenceGraphLoading: false, evidenceGraphError: "", selectedEvidenceGraphNodeId: null, selectedEvidenceGraphCandidateId: null, evidenceGraphReviewSheet: false, evidenceGraphReviewDecision: "accepted", evidenceGraphReviewBusy: false, evidenceGraphReviewError: "", evidenceGraphPathAnchorId: null, evidenceGraphPath: null,
    mode: "session", drawer: null, modal: false, manuscriptModal: false, saving: false, loadingProject: false, projectError: "", projectFolderOpenBusy: false, projectFolderOpenError: "", activeVegaView: null, activeCytoscape: null, activeNumericSurface: null, activeJBrowseTarget: null, scrollByMode: { session: 0, lab: 0, manuscript: 0 }, returnMessageId: null,
    workspaceTabs: [{ id: "research", kind: "research", dirty: false }], activeWorkspaceTabId: "research", currentDestination: "overview", hypotheses: [], hypothesesError: "", approvalPolicy: null, approvalPolicyError: "", workspaceSyncError: "",
    analysisRuns: [], analysisRunArtifacts: [], analysisRunsError: "", analysisRunsProjectId: null,
    resultArtifacts: [], resultFigureIds: new Set(), resultValidations: new Map(), resultsError: "", resultsProjectId: null,
    literatureSources: [], literatureUnresolvedIds: [], literatureLoading: false, literatureError: "",
    acquisitionRuns: [], acquisitionUnresolvedIds: [], acquisitionLoading: false, acquisitionError: "",
    activeTurn: null, composerSending: false, composerDraft: "", composerError: "", composerEventDispose: null, lifecycleChangeDispose: null, runtimeQuestions: [], runtimeQuestionDispose: null, runtimeQuestionBusy: false, runtimeQuestionError: "", runtimeQuestionDraft: "", runtimeQuestionDraftRequestId: null,
    runtimeSelection: null, runtimeOptions: [], runtimeUnavailable: false, runtimeSelectionLoading: false, runtimeSelectionBusy: false, runtimeSelectionError: "", runtimeSelectionScope: null, runtimePickerOpen: false, runtimePickerQuery: "",
    vegaDraft: null, vegaSaving: false, vegaSaveError: "", pendingDraftNavigation: null,
    selectedManuscriptId: null, selectedAnalysisPlanId: null, manuscriptDraft: null, manuscriptSaving: false, manuscriptSaveError: "", manuscriptView: "paper", manuscriptInspectorOpen: false, selectedJournalProfileId: null, journalValidation: null, journalSheet: false, submissionSheet: false, submissionDraft: null, journalActionBusy: false, journalActionError: "",
    manuscriptEditorModel: null, manuscriptArtifactContexts: new Map(), manuscriptArtifactLineages: new Map(), manuscriptArtifactPreviewUrls: new Map(), manuscriptEditProposals: [], manuscriptSelectionContexts: [], manuscriptSelectionContext: null, manuscriptSelectionBusy: false, manuscriptSelectionError: "", manuscriptInsertion: null, manuscriptInsertBusy: false, manuscriptInsertError: "", manuscriptTransactionBusy: false, manuscriptProposalBusy: null, manuscriptNotice: "",
    manuscriptPreviewHtml: null, manuscriptPreviewKey: "", manuscriptPreviewBusy: false, manuscriptPreviewWarnings: [], manuscriptPreviewReport: null, manuscriptExportBusy: "",
    // The generated .tex / .bib and the toolchain probe: the LaTeX view reads these. Kept beside the
    // preview state so the typeset proof and the source it was compiled from cannot drift apart.
    manuscriptPreviewLatex: "", manuscriptPreviewBibtex: "", manuscriptPreviewCapabilities: null,
    artifactBindingBusy: false, artifactBindingError: "", pendingManuscriptBinding: null, manuscriptDraftJob: null,
    decisionBusy: false, decisionError: "", analysisPlanReviewSheet: false, analysisPlanReviewBusy: false, analysisPlanReviewError: "", analysisPlanReviewDismissedKey: null, labDecisionActionBusy: false, labDecisionActionError: "",
    resultReviewSheet: false, resultReviewInspection: null, resultReviewBusy: false, resultReviewError: "", resultReviewStale: false, resultReviewOpener: null, resultReviewDraft: { verdict: "", trigger: "", rationale: "" },
    researchContract: null, researchContractSheet: false, researchContractBusy: false, researchContractError: "", researchContractDismissedKey: null,
    scopeLoading: false, scopeError: "",
    logbookRevisions: [], logbookLoading: false, logbookError: "",
    submissionArchiveProfiles: [], submissionArchiveExports: [], submissionArchiveLoading: false, submissionArchiveError: "",
    datasetImportBusy: false, datasetImportError: "", tablePageByArtifact: new Map(), statisticsViewByArtifact: new Map(), paleontologyViewByArtifact: new Map(), visualViewportByArtifact: new Map(),
    spatialViewByArtifact: new Map(), materialsStructureIndexByArtifact: new Map(),
    statisticsLaunchSourceArtifactId: null, statisticsLaunchTimeColumn: "", statisticsLaunchEventColumn: "", statisticsLaunchBusy: false, statisticsLaunchError: "", statisticsLaunchOpen: false,
    // The launch screen used to offer one analysis, because one analysis was written into it. These
    // hold the engine's own catalogue and the column mapping the chosen method declares it needs.
    statisticsMethodCatalogue: [], statisticsMethodQuery: "", statisticsLaunchMethod: "kaplan_meier", statisticsLaunchMapping: {},
    figureActionBusy: false, figureActionError: "", figureActionNotice: "",
    activeRendererIdentity: null, activeRendererInstance: null, activeRendererPhase: null, activeRendererVisible: null, rendererObserver: null, rendererAbort: null, rendererStatusDispose: null, artifactChangeDispose: null, inlineVegaViews: [], inlinePreviewUrls: [], compareVegaViews: [], comparePreviewUrls: [], activeSpatialScene: null,
  };
  let selectionEpoch = 0;
  let scopeLoadEpoch = 0;
  let composerRequestEpoch = 0;
  let compareEpoch = 0;
  let workspacePersistChain = Promise.resolve();
  let workspacePersistError = null;
  let jbrowseRuntimePromise = null;
  let runtimeQuestionTimer = null;
  let librarySearchTimer = null;
  let librarySearchComposing = false;
  let scienceModelSearchComposing = false;
  let scienceModelSearchTimer = null;
  let runtimeSelectionRequestEpoch = 0;
  let projectLibrarySummaryRequestEpoch = 0;
  let manuscriptEditorRequestEpoch = 0;
  let manuscriptSaveRequestEpoch = 0;
  let conversationRefreshInFlight = null;
  let conversationRefreshPending = false;
  let conversationRefreshPendingRuntime = false;
  const uiCopy = (ko, en) => state.locale === "ko" ? ko : en;
  const pendingHypothesisCopy = (pending) => uiCopy(
    `${pending}건이 당신의 결정을 기다립니다.`,
    `${pending} ${pending === 1 ? "hypothesis awaits" : "hypotheses await"} your decision.`,
  );
  const earthquakeProjectionCopy = () => uiCopy(
    "USGS 원본 경도°·위도°·깊이 km · 화면은 축별 정규화",
    "USGS source longitude° · latitude° · depth km · axes normalized for display",
  );
  const domainLabels = {
    general: "인문·사회·융합", "life-science": "생명과학", chemistry: "화학", physics: "물리학",
    "materials-science": "재료과학", genomics: "유전체학", astronomy: "천문학", "earth-ecology": "지구·생태·고생물",
    statistics: "통계학", economics: "경제·경영", finance: "금융 연구",
  };
  const domainLabelsEn = {
    general: "Humanities, social & interdisciplinary", "life-science": "Life science", chemistry: "Chemistry", physics: "Physics",
    "materials-science": "Materials science", genomics: "Genomics", astronomy: "Astronomy", "earth-ecology": "Earth, ecology & paleontology",
    statistics: "Statistics", economics: "Economics & management", finance: "Finance",
  };
  const domainLabel = (domain) => (state.locale === "ko" ? domainLabels : domainLabelsEn)[domain] || domain;
  const researchTemplates = [
    { id: "data-table", domain: "statistics", label: "표 데이터 정리", labelEn: "Data tables", description: "CSV와 표 데이터를 검증 가능한 형태로 정리합니다.", descriptionEn: "Organize CSV and tabular data into a verifiable dataset." },
    { id: "statistics-analysis", domain: "statistics", label: "통계 분석", labelEn: "Statistical analysis", description: "가설과 데이터에 맞는 통계 방법을 선택해 분석합니다.", descriptionEn: "Choose and run statistical methods suited to your hypothesis and data." },
    { id: "data-visualization", domain: "statistics", label: "데이터 시각화", labelEn: "Data visualization", description: "정확한 데이터를 설명하는 차트와 3D 시각화를 만듭니다.", descriptionEn: "Create charts and 3D views grounded in exact data." },
    { id: "economic-indicators", domain: "economics", label: "경제·경영 지표", labelEn: "Economic & management indicators", description: "공식 경제 지표로 경제·경영의 변화와 관계를 분석합니다.", descriptionEn: "Analyze economics and management questions with official indicators." },
    { id: "literature-network", domain: "general", label: "문헌·인문사회", labelEn: "Literature & humanities", description: "인문사회 선행 문헌과 논문 인용 관계를 근거 중심으로 탐색합니다.", descriptionEn: "Explore humanities and social-science literature through evidence-backed citation relationships." },
    { id: "astronomy-sky", domain: "astronomy", label: "천체·우주 관측", labelEn: "Astronomy & sky", description: "천체 목록, 좌표와 관측값을 분석합니다.", descriptionEn: "Analyze astronomical catalogs, coordinates, and observations." },
    { id: "biodiversity-map", domain: "earth-ecology", label: "생물다양성 지도", labelEn: "Biodiversity maps", description: "종 관측 기록과 공간 분포를 지도에서 비교합니다.", descriptionEn: "Compare species observations and spatial distributions on a map." },
    { id: "paleontology-evidence", domain: "earth-ecology", label: "화석·고생물 근거", labelEn: "Paleontology evidence", description: "화석 산출과 지층 기록에서 검증 가능한 근거를 찾습니다.", descriptionEn: "Find verifiable evidence in fossil occurrences and strata." },
    { id: "earthquake-observations", domain: "earth-ecology", label: "지진 관측", labelEn: "Earthquake observations", description: "지진의 위치, 깊이, 규모와 시간 패턴을 분석합니다.", descriptionEn: "Analyze earthquake location, depth, magnitude, and timing." },
    { id: "physics-data", domain: "physics", label: "물리 측정", labelEn: "Physics measurements", description: "물리 실험과 공개 측정 데이터를 비교·분석합니다.", descriptionEn: "Compare and analyze experimental and public physics measurements." },
    { id: "materials-structures", domain: "materials-science", label: "소재·결정 구조", labelEn: "Materials & structures", description: "재료의 결정 구조와 물성 데이터를 살펴봅니다.", descriptionEn: "Inspect crystal structures and material properties." },
    { id: "genomics-variants", domain: "genomics", label: "유전체 변이", labelEn: "Genomic variants", description: "유전체 좌표와 변이 기록을 정확한 참조 위에서 탐색합니다.", descriptionEn: "Explore genomic coordinates and variants against exact references." },
    { id: "comparative-genomics", domain: "genomics", label: "비교 유전체", labelEn: "Comparative genomics", description: "종과 유전체 사이의 보존·차이를 비교합니다.", descriptionEn: "Compare conservation and differences across species and genomes." },
    { id: "molecular-structure", domain: "life-science", label: "분자·단백질 구조", labelEn: "Molecular structures", description: "분자와 단백질 구조를 3D로 조사합니다.", descriptionEn: "Investigate molecular and protein structures in 3D." },
    { id: "chemistry", domain: "chemistry", label: "화학 연구", labelEn: "Chemistry", description: "분자, 반응과 화학적 성질을 근거와 함께 연구합니다.", descriptionEn: "Study molecules, reactions, and chemical properties with evidence." },
  ];
  const researchTemplateById = (id) => researchTemplates.find((template) => template.id === id) || null;
  const researchTemplateLabel = (template) => template ? (state.locale === "ko" ? template.label : template.labelEn) : "";
  const researchTemplateDescription = (template) => template ? (state.locale === "ko" ? template.description : template.descriptionEn) : "";
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
  function paleontologyInteractiveSpec(spec, availableWidth) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec) || !(availableWidth > 0)) return spec;
    const responsive = JSON.parse(JSON.stringify(spec));
    const measuredWidth = Math.max(1, Number(availableWidth) || 1);
    const narrow = measuredWidth < 260;
    const medium = measuredWidth < 480;
    const leftPadding = narrow ? Math.min(88, Math.max(60, Math.floor(measuredWidth * 0.46))) : medium ? 112 : 150;
    const rightPadding = narrow ? 8 : medium ? 12 : 24;
    const rowCount = Number(responsive.data?.find?.((entry) => entry?.name === "occurrences")?.values?.length) || 1;
    const plotWidth = Math.max(1, Math.floor(measuredWidth - leftPadding - rightPadding));
    const plotHeight = Math.max(narrow ? 120 : 160, rowCount * (narrow ? 14 : medium ? 17 : 18));
    const sourceTitle = String(responsive.title?.text || "PBDB fossil-occurrence intervals");
    const taxonName = sourceTitle.replace(/\s+fossil-occurrence age intervals$/iu, "").trim() || "PBDB";
    const titleSuffix = " intervals";
    const titleCharacterLimit = narrow ? Math.max(16, Math.floor(measuredWidth / 7)) : medium ? Math.max(34, Math.floor(measuredWidth / 7)) : Infinity;
    const taxonCharacterLimit = Number.isFinite(titleCharacterLimit) ? Math.max(4, titleCharacterLimit - titleSuffix.length - 1) : Infinity;
    const compactTaxonName = taxonName.length > taxonCharacterLimit
      ? `${taxonName.slice(0, taxonCharacterLimit).trimEnd()}…`
      : taxonName;
    responsive.autosize = { type: "none" };
    responsive.width = plotWidth;
    responsive.height = plotHeight;
    responsive.padding = { left: leftPadding, right: rightPadding, top: narrow ? 26 : medium ? 34 : 44, bottom: narrow || medium ? 96 : 82 };
    responsive.title = {
      ...responsive.title,
      text: narrow ? "Age intervals" : medium ? `${compactTaxonName}${titleSuffix}` : sourceTitle,
      subtitle: narrow ? "PBDB age bounds (Ma)" : medium ? "PBDB bounds in Ma" : responsive.title?.subtitle,
      fontSize: narrow ? 13 : medium ? 14 : responsive.title?.fontSize,
      subtitleFontSize: narrow ? 9 : medium ? 10 : responsive.title?.subtitleFontSize,
      align: narrow || medium ? "left" : responsive.title?.align,
      limit: narrow || medium ? Math.max(80, measuredWidth - 8) : responsive.title?.limit,
    };
    responsive.axes = (Array.isArray(responsive.axes) ? responsive.axes : []).map((axis) => {
      if (axis.orient === "left") return { ...axis, labelLimit: Math.max(60, leftPadding - 6), labelFontSize: narrow ? 9 : medium ? 10 : axis.labelFontSize };
      if (axis.orient === "bottom") return {
        ...axis,
        title: narrow ? "Age (Ma)" : medium ? "Age before present (Ma)" : axis.title,
        tickCount: narrow ? 4 : medium ? 6 : axis.tickCount,
        labelFontSize: narrow ? 9 : medium ? 10 : axis.labelFontSize,
      };
      return axis;
    });
    const legendColumns = narrow || medium ? 1 : 2;
    responsive.legends = (Array.isArray(responsive.legends) ? responsive.legends : []).map((legend) => ({
      ...legend,
      orient: "bottom",
      columns: legendColumns,
      labelLimit: narrow || medium ? Math.min(180, Math.max(40, plotWidth - 8)) : Math.max(40, Math.floor(plotWidth / 2)),
      labelFontSize: narrow ? 9 : medium ? 10 : legend.labelFontSize,
      titleFontSize: narrow ? 9 : medium ? 10 : legend.titleFontSize,
    }));
    return responsive;
  }
  function fitArtifactVegaCanvas(host, { capture = false, gutter = 10, maxHeight = Infinity } = {}) {
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
    // Inline previews live in scrollable articles: being outside the viewport
    // is normal and must not turn a valid chart into a permanent render error.
    // Only an actual viewport capture requires viewport containment.
    const availableWidth = capture
      ? Math.max(1, Math.min(window.innerWidth - gutter, hostRect.right - gutter) - naturalRect.left)
      : Math.max(1, hostRect.width - gutter * 2);
    const availableHeight = capture
      ? Math.max(1, window.innerHeight - gutter - naturalRect.top)
      : Math.min(naturalHeight, maxHeight);
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
    if (capture && !fits) throw new Error("science-vega-capture-layout-out-of-bounds");
    return { canvas, scale, rect: fitted, availableWidth, availableHeight };
  }
  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(state.locale === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "short", day: "numeric" }).format(date);
  };
  function restoreArtifactVegaCanvas(host) {
    const canvas = host?.querySelector?.("canvas");
    if (!canvas) return null;
    const width = Number(canvas.dataset.vegaNaturalCssWidth) || canvas.width;
    const height = Number(canvas.dataset.vegaNaturalCssHeight) || canvas.height;
    if (!(width > 0) || !(height > 0)) return null;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.maxWidth = "none";
    canvas.style.maxHeight = "none";
    canvas.style.marginInline = "0";
    return { canvas, width, height };
  }
  function artifactViewToolbarMarkup() {
    const fitLabel = uiCopy("맞춤", "Fit to view");
    const zoomOutLabel = uiCopy("축소", "Zoom out");
    const zoomInLabel = uiCopy("확대", "Zoom in");
    const resetLabel = uiCopy("확대 배율 초기화", "Reset zoom");
    const panLabel = uiCopy("그림 이동 모드", "Pan figure");
    return `<section class="artifactViewToolbar" data-artifact-view-toolbar aria-label="${escapeHtml(uiCopy("그림 보기 도구", "Figure view controls"))}"><div class="artifactViewToolbarTitle"><strong>${escapeHtml(uiCopy("그림 보기", "Figure view"))}</strong><span data-artifact-view-status aria-live="polite">100%</span></div><div class="artifactViewToolbarActions"><button type="button" data-artifact-view-action="fit" aria-label="${escapeHtml(fitLabel)}" title="${escapeHtml(fitLabel)}">${escapeHtml(uiCopy("맞춤", "Fit"))}</button><button type="button" data-artifact-view-action="zoom-out" aria-label="${escapeHtml(zoomOutLabel)}" title="${escapeHtml(zoomOutLabel)}">−</button><button type="button" data-artifact-view-action="zoom-in" aria-label="${escapeHtml(zoomInLabel)}" title="${escapeHtml(zoomInLabel)}">+</button><button type="button" data-artifact-view-action="reset" aria-label="${escapeHtml(resetLabel)}" title="${escapeHtml(resetLabel)}">${escapeHtml(uiCopy("초기화", "Reset"))}</button><button type="button" data-artifact-view-action="toggle-pan" aria-pressed="false" aria-label="${escapeHtml(panLabel)}" title="${escapeHtml(panLabel)}">${escapeHtml(uiCopy("이동", "Pan"))}</button></div></section>`;
  }
  function bindArtifactVisualViewport(host, { kind = "chart", initialFit = true } = {}) {
    if (!host) return;
    if (typeof host.__scienceVisualViewerCleanup === "function") host.__scienceVisualViewerCleanup();
    if (host.dataset.visualViewerBound === "true") return;
    const viewport = host.querySelector(".statisticsChartHost") || host;
    const surface = viewport.querySelector("img, canvas");
    if (!surface) return;
    const baseWidth = Number(surface.dataset.vegaNaturalCssWidth) || Number(surface.naturalWidth) || Number(surface.width) || surface.getBoundingClientRect().width;
    const baseHeight = Number(surface.dataset.vegaNaturalCssHeight) || Number(surface.naturalHeight) || Number(surface.height) || surface.getBoundingClientRect().height;
    if (!(baseWidth > 0) || !(baseHeight > 0)) return;
    host.dataset.visualViewerBound = "true";
    viewport.classList.add("artifactVisualViewport");
    surface.classList.add("artifactVisualSurface");
    surface.draggable = false;
    const frame = host.closest(".artifactCanvasFrame");
    const toolbar = frame?.querySelector("[data-artifact-view-toolbar]");
    const status = toolbar?.querySelector("[data-artifact-view-status]");
    const visualViewportKey = [
      state.selectedId || "unknown-project",
      host.dataset.artifactHost || "unknown-artifact",
      host.dataset.artifactVersion || "unknown-version",
      host.dataset.contentSha256 || "unknown-content",
    ].join(":");
    const rememberedViewport = state.visualViewportByArtifact.get(visualViewportKey) || null;
    let scale = 1;
    let fitLocked = false;
    let persistentPan = kind === "image";
    let temporarySpacePan = false;
    let panMode = persistentPan;
    let pointer = null;
    const buttonListeners = [];
    const rememberViewport = () => {
      const memory = state.visualViewportByArtifact;
      memory.delete(visualViewportKey);
      memory.set(visualViewportKey, {
        scale,
        fitLocked,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        persistentPan,
      });
      while (memory.size > 64) {
        const oldestKey = memory.keys().next().value;
        if (oldestKey === undefined) break;
        memory.delete(oldestKey);
      }
    };
    const clampScale = (value, minimum = 0.05) => Math.max(minimum, Math.min(4, value));
    const fitScale = () => {
      const styles = getComputedStyle(viewport);
      const horizontalPadding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
      const verticalPadding = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
      return Math.max(0.001, Math.min(1, (viewport.clientWidth - horizontalPadding) / baseWidth, (viewport.clientHeight - verticalPadding) / baseHeight));
    };
    const visualMinimumScale = () => Math.min(0.05, fitScale());
    const updateStatus = () => {
      if (status) status.textContent = `${Math.round(scale * 100)}%`;
      if (toolbar) toolbar.querySelector('[data-artifact-view-action="toggle-pan"]')?.setAttribute("aria-pressed", String(panMode));
      viewport.dataset.visualScale = scale.toFixed(4);
      viewport.dataset.visualFit = String(fitLocked);
    };
    const applyScale = (nextScale, anchor = null, minimumScale = visualMinimumScale()) => {
      const next = clampScale(nextScale, minimumScale);
      const previousScale = scale;
      const rect = viewport.getBoundingClientRect();
      const styles = getComputedStyle(viewport);
      const originX = viewport.clientLeft + (parseFloat(styles.paddingLeft) || 0);
      const originY = viewport.clientTop + (parseFloat(styles.paddingTop) || 0);
      const anchorX = anchor ? anchor.clientX - rect.left - originX : viewport.clientWidth / 2 - originX;
      const anchorY = anchor ? anchor.clientY - rect.top - originY : viewport.clientHeight / 2 - originY;
      const contentX = viewport.scrollLeft + anchorX;
      const contentY = viewport.scrollTop + anchorY;
      scale = next;
      surface.style.width = `${Math.max(1, Math.round(baseWidth * scale))}px`;
      surface.style.height = `${Math.max(1, Math.round(baseHeight * scale))}px`;
      surface.style.maxWidth = "none";
      surface.style.maxHeight = "none";
      surface.style.marginInline = "0";
      viewport.scrollLeft = Math.max(0, contentX * (scale / previousScale) - anchorX);
      viewport.scrollTop = Math.max(0, contentY * (scale / previousScale) - anchorY);
      updateStatus();
      rememberViewport();
    };
    const applyFit = () => {
      fitLocked = true;
      const next = fitScale();
      const rect = viewport.getBoundingClientRect();
      const center = { clientX: rect.left + viewport.clientWidth / 2, clientY: rect.top + viewport.clientHeight / 2 };
      applyScale(next, center, 0.001);
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      rememberViewport();
    };
    const applyReset = () => { fitLocked = false; applyScale(1); };
    const action = (name) => {
      if (name === "fit") { applyFit(); return; }
      if (name === "reset") { applyReset(); return; }
      if (name === "zoom-in") { fitLocked = false; applyScale(scale * 1.2); return; }
      if (name === "zoom-out") { fitLocked = false; applyScale(scale / 1.2); return; }
      if (name === "toggle-pan") { persistentPan = !persistentPan; panMode = persistentPan || temporarySpacePan; updateStatus(); rememberViewport(); }
    };
    toolbar?.querySelectorAll("[data-artifact-view-action]").forEach((button) => {
      const listener = () => action(button.dataset.artifactViewAction);
      button.addEventListener("click", listener);
      buttonListeners.push([button, listener]);
    });
    const onWheel = (event) => {
      if (!surface.contains(event.target)) return;
      const rawDeltaY = Number(event.deltaY);
      if (!Number.isFinite(rawDeltaY) || rawDeltaY === 0) return;
      const rawDeltaX = Number(event.deltaX) || 0;
      if (Math.abs(rawDeltaY) < 0.5 || Math.abs(rawDeltaX) > Math.abs(rawDeltaY) * 1.2) return;
      event.preventDefault();
      event.stopPropagation();
      fitLocked = false;
      const deltaModeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, viewport.clientHeight) : 1;
      const normalizedDeltaY = Math.max(-120, Math.min(120, rawDeltaY * deltaModeScale));
      const direction = Math.exp(-normalizedDeltaY * 0.0012);
      applyScale(scale * direction, event);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    const onScroll = () => { if (!fitLocked) rememberViewport(); };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    const onPointerDown = (event) => {
      if (!surface.contains(event.target) || !(panMode || event.button === 1 || event.shiftKey || event.altKey)) return;
      event.preventDefault();
      fitLocked = false;
      rememberViewport();
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      try { surface.setPointerCapture(event.pointerId); } catch {}
      surface.dataset.visualPanning = "true";
    };
    const onPointerMove = (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      event.preventDefault();
      viewport.scrollLeft -= event.clientX - pointer.x;
      viewport.scrollTop -= event.clientY - pointer.y;
      pointer.x = event.clientX; pointer.y = event.clientY;
      rememberViewport();
    };
    const clearPointer = () => {
      const pointerId = pointer?.id;
      pointer = null;
      delete surface.dataset.visualPanning;
      if (pointerId !== undefined) {
        try { surface.releasePointerCapture(pointerId); } catch {}
      }
    };
    const onPointerUp = (event) => { if (pointer?.id === event.pointerId) clearPointer(); };
    const onLostPointerCapture = (event) => { if (pointer?.id === event.pointerId) clearPointer(); };
    const resetTemporaryPan = () => {
      if (!temporarySpacePan) return;
      temporarySpacePan = false;
      panMode = persistentPan;
      updateStatus();
    };
    const onWindowBlur = () => { clearPointer(); resetTemporaryPan(); };
    const onVisibilityChange = () => { if (document.hidden) { clearPointer(); resetTemporaryPan(); } };
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerUp);
    surface.addEventListener("lostpointercapture", onLostPointerCapture);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const isEditingTarget = (target) => {
      if (!target || typeof target.closest !== "function") return false;
      return Boolean(target.isContentEditable || target.closest("input, textarea, select, button, a, [contenteditable=\"true\"], [contenteditable=\"\"], [role=\"textbox\"]"));
    };
    const canHandleKey = (event) => !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditingTarget(event.target);
    host.tabIndex = 0;
    const onKeyDown = (event) => {
      if (!canHandleKey(event)) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); action("zoom-in"); return; }
      if (event.key === "-") { event.preventDefault(); action("zoom-out"); return; }
      if (event.key === "0") { event.preventDefault(); action("fit"); return; }
      if (event.key === "Home" || event.key.toLowerCase() === "r") { event.preventDefault(); action("reset"); return; }
      const delta = event.shiftKey ? 96 : 48;
      const scrollsViewport = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
      if (scrollsViewport) fitLocked = false;
      if (event.key === "ArrowLeft") { event.preventDefault(); viewport.scrollLeft -= delta; }
      if (event.key === "ArrowRight") { event.preventDefault(); viewport.scrollLeft += delta; }
      if (event.key === "ArrowUp") { event.preventDefault(); viewport.scrollTop -= delta; }
      if (event.key === "ArrowDown") { event.preventDefault(); viewport.scrollTop += delta; }
      if (scrollsViewport) rememberViewport();
      if (event.key === " ") { event.preventDefault(); temporarySpacePan = true; panMode = true; updateStatus(); }
    };
    const onKeyUp = (event) => {
      if (event.key === " " && !event.isComposing && !isEditingTarget(event.target)) { temporarySpacePan = false; panMode = persistentPan; updateStatus(); }
    };
    host.addEventListener("keydown", onKeyDown);
    host.addEventListener("keyup", onKeyUp);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (fitLocked) applyFit(); }) : null;
    observer?.observe(viewport);
    const cleanup = () => {
      observer?.disconnect();
      buttonListeners.forEach(([button, listener]) => button.removeEventListener("click", listener));
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("scroll", onScroll);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerUp);
      surface.removeEventListener("lostpointercapture", onLostPointerCapture);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      host.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("keyup", onKeyUp);
      clearPointer();
      delete host.dataset.visualViewerBound;
      if (host.__scienceVisualViewerCleanup === cleanup) delete host.__scienceVisualViewerCleanup;
    };
    host.__scienceVisualViewerCleanup = cleanup;
    const restoreRememberedViewport = () => {
      if (!rememberedViewport || !Number.isFinite(Number(rememberedViewport.scale))) return false;
      persistentPan = rememberedViewport.persistentPan === true;
      panMode = persistentPan;
      if (rememberedViewport.fitLocked === true) {
        applyFit();
        return true;
      }
      fitLocked = false;
      applyScale(Number(rememberedViewport.scale), null, 0.001);
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollLeft = Math.max(0, Math.min(maxScrollLeft, Number(rememberedViewport.scrollLeft) || 0));
      viewport.scrollTop = Math.max(0, Math.min(maxScrollTop, Number(rememberedViewport.scrollTop) || 0));
      rememberViewport();
      return true;
    };
    const restoredRememberedViewport = restoreRememberedViewport();
    if (!restoredRememberedViewport && initialFit) applyFit();
    updateStatus();
  }
  const formatByteSize = (value) => {
    if (value === null || value === undefined || value === "") return "—";
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1_000) return `${Math.round(bytes)} B`;
    if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
    return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  };
  const sourceById = (id) => state.sources.find((source) => source.id === id) || null;
  const citationById = (id) => [...state.citationsByMessage.values()].flat().find((citation) => citation.id === id) || null;
  const selectedProject = () => state.projects.find((item) => item.id === state.selectedId) || null;
  const setProjectLibrarySummaries = (rows) => {
    state.projectLibrarySummaries = new Map((Array.isArray(rows) ? rows : []).filter((row) => row?.projectId).map((row) => [row.projectId, row]));
    state.projectLibrarySummaryState = "ready";
  };
  async function refreshProjectLibrarySummaries() {
    const requestEpoch = ++projectLibrarySummaryRequestEpoch;
    state.projectLibrarySummaryState = "loading";
    try {
      const rows = await science.projects.library();
      // A project switch can leave the previous library request in flight. The library
      // endpoint returns a whole-project snapshot, so accepting that late response can put
      // an older manuscript count back on the landing page after the user has moved on.
      if (requestEpoch !== projectLibrarySummaryRequestEpoch) return false;
      setProjectLibrarySummaries(rows);
      return true;
    } catch (error) {
      // A superseded request must not turn a newer successful snapshot into an error state.
      if (requestEpoch !== projectLibrarySummaryRequestEpoch) return false;
      throw error;
    }
  }
  const selectedConversation = () => state.conversations.find((item) => item.id === state.selectedConversationId) || state.conversations[0] || null;
  const SCIENCE_RUNTIME_RUNNING_STATUSES = new Set(["queued", "running", "cancelling"]);
  const scienceRuntimeScope = (projectId = state.selectedId, conversationId = selectedConversation()?.id) => ({
    projectId: projectId || null,
    conversationId: conversationId || null,
  });
  const scienceRuntimeScopeKey = (scope) => scope?.projectId && scope?.conversationId
    ? JSON.stringify([scope.projectId, scope.conversationId])
    : null;
  const scienceRuntimeSelectionKey = (selection) => {
    if (!selection || typeof selection !== "object") return "";
    return ["kind", "backend", "source", "model", "role", "inherit", "longContext", "effort"]
      .map((key) => `${key}=${selection[key] === undefined || selection[key] === null ? "" : String(selection[key])}`)
      .join("|");
  };
  const scienceRuntimeSelectionForDisplay = () => {
    const activeTurn = state.activeTurn;
    if (activeTurn && SCIENCE_RUNTIME_RUNNING_STATUSES.has(activeTurn.status) && activeTurn.runtimeSelection) return activeTurn.runtimeSelection;
    const loopSelection = state.researchLoopInspection?.session?.runtimeSelection || state.researchLoopInspection?.runtimeSelection;
    if (state.researchLoopInspection?.active === true && loopSelection) return loopSelection;
    return state.runtimeSelection;
  };
  const scienceRuntimePickerLocked = () => Boolean(
    (state.activeTurn && SCIENCE_RUNTIME_RUNNING_STATUSES.has(state.activeTurn.status))
      || state.researchLoopInspection?.active === true
      || ["queued", "running", "pausing"].includes(state.researchLoopInspection?.session?.status),
  );
  const scienceRuntimeOptionLabel = (option) => String(option?.label || option?.selection?.model || "").trim();
  const scienceRuntimeOptionProvider = (option) => String(option?.provider || option?.selection?.backend || option?.selection?.kind || "").trim();
  const scienceRuntimeDisplayLabel = () => {
    const selection = scienceRuntimeSelectionForDisplay();
    const selectedKey = scienceRuntimeSelectionKey(selection);
    const option = state.runtimeOptions.find((item) => scienceRuntimeSelectionKey(item?.selection) === selectedKey);
    return scienceRuntimeOptionLabel(option) || String(selection?.model || "").trim();
  };
  const scienceRuntimeDisplayProvider = () => {
    const selection = scienceRuntimeSelectionForDisplay();
    const selectedKey = scienceRuntimeSelectionKey(selection);
    const option = state.runtimeOptions.find((item) => scienceRuntimeSelectionKey(item?.selection) === selectedKey);
    return scienceRuntimeOptionProvider(option) || String(selection?.backend || selection?.kind || "").trim();
  };
  const scienceRuntimeErrorText = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/selection-locked|runtime-selection-locked|research.*running|loop.*running/i.test(text)) return uiCopy("현재 연구가 실행 중이라 모델을 바꿀 수 없습니다.", "The current research is running, so its model is locked.");
    if (/receipt-mismatch/i.test(text)) return uiCopy("모델 선택을 확인하지 못했습니다. 다시 선택해 주세요.", "The model selection could not be confirmed. Choose it again.");
    if (/unavailable|no-runtime|runtime/i.test(text)) return uiCopy("연결된 모델을 사용할 수 없습니다.", "No connected model is available.");
    return uiCopy("모델을 불러오지 못했습니다. 다시 시도해 주세요.", "The model list could not be loaded. Try again.");
  };
  const scienceRuntimeSelectionMatchesScope = (scope) => scienceRuntimeScopeKey(scope) === scienceRuntimeScopeKey(state.runtimeSelectionScope)
    && scope?.projectId === state.selectedId
    && scope?.conversationId === selectedConversation()?.id;
  const scienceRuntimeInspectionResult = (result) => ({
    selection: result?.selection && typeof result.selection === "object" ? result.selection : null,
    options: Array.isArray(result?.options)
      ? result.options.filter((option) => option?.selection && typeof option.selection === "object" && scienceRuntimeOptionLabel(option))
      : [],
    unavailable: result?.unavailable === true,
  });

  async function refreshScienceRuntimeSelection(projectId, conversationId, { renderDock = true } = {}) {
    const scope = scienceRuntimeScope(projectId, conversationId);
    const epoch = ++runtimeSelectionRequestEpoch;
    state.runtimeSelectionScope = scope;
    state.runtimeSelectionLoading = true;
    state.runtimeSelectionBusy = false;
    state.runtimeSelectionError = "";
    state.runtimePickerOpen = false;
    state.runtimePickerQuery = "";
    if (renderDock) renderChatDock();
    try {
      if (!scope.projectId || !scope.conversationId || typeof science?.runtime?.inspect !== "function") {
        throw new Error("science-runtime-inspection-unavailable");
      }
      const inspected = scienceRuntimeInspectionResult(await science.runtime.inspect({
        projectId: scope.projectId,
        conversationId: scope.conversationId,
      }));
      if (epoch !== runtimeSelectionRequestEpoch || !scienceRuntimeSelectionMatchesScope(scope)) return;
      state.runtimeSelection = inspected.selection;
      state.runtimeOptions = inspected.options;
      state.runtimeUnavailable = inspected.unavailable;
      state.runtimeSelectionLoading = false;
      state.runtimeSelectionError = "";
    } catch (error) {
      if (epoch !== runtimeSelectionRequestEpoch || !scienceRuntimeSelectionMatchesScope(scope)) return;
      state.runtimeSelection = null;
      state.runtimeOptions = [];
      state.runtimeUnavailable = true;
      state.runtimeSelectionLoading = false;
      state.runtimeSelectionError = error instanceof Error ? error.message : String(error);
    }
    if (renderDock && epoch === runtimeSelectionRequestEpoch && scienceRuntimeSelectionMatchesScope(scope)) renderChatDock();
  }

  async function selectScienceRuntimeOption(optionIndex) {
    const projectId = state.selectedId;
    const conversationId = selectedConversation()?.id;
    const scope = scienceRuntimeScope(projectId, conversationId);
    const requestEpoch = runtimeSelectionRequestEpoch;
    const isCurrent = () => requestEpoch === runtimeSelectionRequestEpoch && scienceRuntimeSelectionMatchesScope(scope);
    const option = Number.isSafeInteger(optionIndex) ? state.runtimeOptions[optionIndex] : null;
    if (!option?.selection || !scope.projectId || !scope.conversationId || scienceRuntimePickerLocked() || state.runtimeSelectionBusy) return;
    if (!scienceRuntimeSelectionMatchesScope(scope) || typeof science?.runtime?.select !== "function") {
      state.runtimeSelectionError = "science-runtime-selection-unavailable";
      state.runtimeUnavailable = true;
      renderChatDock();
      return;
    }
    const previousSelection = state.runtimeSelection;
    state.runtimeSelectionBusy = true;
    state.runtimeSelectionError = "";
    renderChatDock();
    try {
      const selected = await science.runtime.select({
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        selection: option.selection,
      });
      if (!isCurrent()) return;
      const receipt = selected?.selection;
      if (scienceRuntimeSelectionKey(receipt) !== scienceRuntimeSelectionKey(option.selection)) {
        throw new Error("science-runtime-selection-receipt-mismatch");
      }
      state.runtimeSelection = receipt;
      state.runtimeUnavailable = false;
      state.runtimeSelectionError = "";
      state.runtimePickerOpen = false;
      state.runtimePickerQuery = "";
    } catch (error) {
      if (!isCurrent()) return;
      state.runtimeSelection = previousSelection;
      state.runtimeSelectionError = error instanceof Error ? error.message : String(error);
      state.runtimeUnavailable = !previousSelection;
      state.runtimePickerOpen = true;
    } finally {
      if (isCurrent()) {
        state.runtimeSelectionBusy = false;
        renderChatDock();
      }
    }
  }

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
    if ((project?.id && project.id !== state.selectedId) || (contract?.projectId && contract.projectId !== state.selectedId)) return;
    const currentProject = state.projects.find((item) => item.id === state.selectedId);
    const currentContract = state.researchContract;
    // A read started before approval may finish after its authoritative receipt.
    // It must not roll the project back or turn that same approved version into a draft.
    if (project && currentProject && project.version < currentProject.version) return;
    if (contract && currentContract?.projectId === state.selectedId) {
      if (contract.version < currentContract.version) return;
      if (contract.id === currentContract.id && contract.version === currentContract.version
        && currentContract.status === "approved" && contract.status === "draft") return;
    }
    // Accepting a fresher receipt also invalidates older pending Scope reads,
    // including their error/loading callbacks, not just their successful payloads.
    scopeLoadEpoch += 1;
    state.scopeLoading = false;
    state.scopeError = "";
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
  const researchLoopPresentation = () => {
    const inspection = state.researchLoopInspection;
    const session = inspection?.session;
    if (!session || inspection?.active !== true) return null;
    const episode = Array.isArray(inspection.episodes)
      ? inspection.episodes.find((item) => ["planned", "running", "waiting-for-decision"].includes(item.status)) || null
      : null;
    const turnRunning = state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status);
    const attention = ["paused", "pausing"].includes(session.status) || Boolean(episode && !turnRunning);
    return {
      attention,
      label: attention
        ? uiCopy(`Episode ${episode?.ordinal || session.currentEpisode} · 조치 필요`, `Episode ${episode?.ordinal || session.currentEpisode} · action required`)
        : uiCopy(`Episode ${episode?.ordinal || session.currentEpisode} · ${session.status}`, `Episode ${episode?.ordinal || session.currentEpisode} · ${session.status}`),
      detail: `${session.status} · ${session.stage}${episode ? ` · episode ${episode.ordinal} ${episode.status}` : ""}`,
    };
  };
  const scienceResearchLoopActionErrorText = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/version-conflict|state.*conflict/i.test(text)) return uiCopy("연구 상태가 바뀌었습니다. 최신 상태를 다시 확인해 주세요.", "The research changed. Refresh its latest state and try again.");
    if (/terminal|not-paused|not-running/i.test(text)) return uiCopy("연구 상태가 바뀌어 이 동작을 적용하지 못했습니다.", "The research state changed before this action was applied.");
    return uiCopy("연구 상태를 갱신하지 못했습니다. 다시 시도해 주세요.", "The research state could not be updated. Try again.");
  };
  async function transitionScienceResearchLoop(action) {
    const inspection = state.researchLoopInspection;
    const session = inspection?.session;
    const projectId = state.selectedId;
    if (!projectId || !session || session.projectId !== projectId || session.status !== "paused" || state.researchLoopActionBusy
      || !["resume", "cancel"].includes(action) || typeof science?.researchLoops?.transition !== "function") return;
    const requestId = crypto.randomUUID();
    const expectedSessionId = session.id;
    const expectedVersion = session.version;
    const expectedStateSha256 = session.stateSha256;
    state.researchLoopActionBusy = true;
    state.researchLoopActionError = "";
    renderChatDock();
    try {
      const result = await science.researchLoops.transition({
        requestId,
        projectId,
        loopSessionId: expectedSessionId,
        expectedLoopVersion: expectedVersion,
        expectedLoopStateSha256: expectedStateSha256,
        action,
        reason: action === "resume" ? "researcher-requested-resume" : "researcher-requested-stop",
      });
      if (!result?.session || result.session.id !== expectedSessionId) throw new Error("science-loop-transition-receipt-invalid");
      const refreshed = await science.researchLoops.inspect(projectId);
      if (projectId !== state.selectedId) return;
      state.researchLoopInspection = refreshed;
    } catch (error) {
      if (projectId === state.selectedId && state.researchLoopInspection?.session?.id === expectedSessionId) {
        state.researchLoopActionError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (projectId === state.selectedId && state.researchLoopInspection?.session?.id === expectedSessionId) {
        state.researchLoopActionBusy = false;
        renderChatDock();
      }
    }
  }
  const lifecycleCompactLabel = () => researchLoopPresentation()?.label || (state.lifecycle
    ? `${lifecyclePhaseLabels[state.lifecycle.phase] || state.lifecycle.phase} · r${state.lifecycle.revision}`
    : "Lifecycle");
  const labDecisionStateLabels = {
    "input-needed": "입력 확인 필요",
    "human-decision-needed": "연구자 결정 필요",
    ready: "실행 준비됨",
    "review-needed": "결과 검토 필요",
  };
  const labDecisionStateLabelsEn = {
    "input-needed": "Input required",
    "human-decision-needed": "Researcher decision required",
    ready: "Ready to run",
    "review-needed": "Result review required",
  };
  const labDecisionFreshnessLabels = { current: "현재 근거", stale: "근거 변경됨", superseded: "새 실험으로 대체됨" };
  const labDecisionFreshnessLabelsEn = { current: "Current evidence", stale: "Evidence changed", superseded: "Superseded by a new experiment" };
  const labDecisionActionLabels = {
    "open-required-input": "필요 입력 준비",
    "answer-human-decision": "연구 방향 결정",
    "inspect-approved-plan": "승인된 계획 열기",
    "review-result": "결과 검토 및 다음 동작 선택",
    "follow-intent-next-action": "다음 연구 동작",
    "refresh-stale-projection": "현재 근거 다시 확인",
    "open-superseding-context": "최신 실험 열기",
  };
  const labDecisionActionLabelsEn = {
    "open-required-input": "Prepare required inputs",
    "answer-human-decision": "Choose research direction",
    "inspect-approved-plan": "Open approved plan",
    "review-result": "Review result and choose next action",
    "follow-intent-next-action": "Next research action",
    "refresh-stale-projection": "Refresh current evidence",
    "open-superseding-context": "Open latest experiment",
  };

  function labDecisionPanelMarkup(projection = labDecisionProjection(), { showAction = true } = {}) {
    if (!projection) return "";
    const mustSee = Array.isArray(projection.mustSee) ? projection.mustSee.slice(0, 3) : [];
    const actionEnabled = projection.action?.enabled === true && !state.labDecisionActionBusy;
    const expanded = state.expandedLabDecisions.has(projection.labId);
    const detailsId = `lab-decision-details-${projection.labId}`;
    const compactDecision = uiCopy(
      `${labLabel(projection.labId)}의 다음 연구 판단`,
      `${labLabel(projection.labId)}: next research decision`,
    );
    const fullQuestion = projection.researchIntent?.userGoal || projection.currentDecision;
    return `<section class="labDecisionPanel" data-lab-decision-projection="${escapeHtml(projection.projectionSha256)}" data-lab-decision-state="${escapeHtml(projection.state)}" data-lab-decision-freshness="${escapeHtml(projection.freshness?.status)}" data-expanded="${expanded}"><header><div><span>WHY THIS LAB NOW</span><strong>${escapeHtml(compactDecision)}</strong></div><div class="labDecisionHeaderActions"><div class="labDecisionStatus"><span class="progressGlyph" data-fill="${{"input-needed":"0","human-decision-needed":"33","ready":"66","result-review-needed":"100"}[projection.state] || "0"}" aria-hidden="true"></span><em>${escapeHtml(uiCopy(labDecisionStateLabels[projection.state], labDecisionStateLabelsEn[projection.state]) || projection.state)}</em><span>${escapeHtml(uiCopy(labDecisionFreshnessLabels[projection.freshness?.status], labDecisionFreshnessLabelsEn[projection.freshness?.status]) || projection.freshness?.status)}</span></div><button type="button" data-action="toggle-lab-decision-details" data-lab-id="${escapeHtml(projection.labId)}" aria-expanded="${expanded}" aria-controls="${escapeHtml(detailsId)}">${expanded ? uiCopy("전체 연구 질문 숨기기", "Hide full research question") : uiCopy("전체 연구 질문 보기", "View full research question")}</button></div></header><div class="labDecisionBody" id="${escapeHtml(detailsId)}"><section><span>${uiCopy("전체 연구 질문", "FULL RESEARCH QUESTION")}</span><p>${escapeHtml(fullQuestion)}</p>${projection.currentDecision !== fullQuestion ? `<span class="labDecisionSubquestion">${uiCopy("현재 판단 질문", "CURRENT DECISION")}</span><p>${escapeHtml(projection.currentDecision)}</p>` : ""}<span class="labDecisionSubquestion">${uiCopy("이 분석이 필요한 때", "WHEN THIS ANALYSIS IS NEEDED")}</span><p>${escapeHtml(projection.researchIntent?.neededWhen || projection.action?.reason || uiCopy("현재 프로젝트 결정을 위해 이 Lab의 근거가 필요합니다.", "This Lab's evidence is needed for the current project decision."))}</p></section><section><span>${uiCopy("반드시 확인할 것", "MUST VERIFY")}</span><ol>${mustSee.map((item) => `<li>${escapeHtml(item.requirement)}</li>`).join("")}</ol></section><section class="labDecisionBoundary boundaryNote"><span>${uiCopy("이 분석을 쓰면 안 되는 때", "DO NOT USE THIS ANALYSIS WHEN")}</span><p>${escapeHtml(projection.researchIntent?.notWhen || projection.boundary)}</p><span class="labDecisionSubquestion">${uiCopy("이 화면만으로 말할 수 없는 것", "WHAT THIS VIEW CANNOT ESTABLISH")}</span><p>${escapeHtml(projection.boundary)}</p></section></div><footer><span>${escapeHtml(projection.action?.reason || "")} · Project v${escapeHtml(projection.basis?.project?.version || "-")} · <code title="${escapeHtml(projection.basis?.basisSha256 || "")}">${escapeHtml(String(projection.basis?.basisSha256 || "").slice(0, 12))}…</code></span>${showAction ? `<button type="button" data-action="lab-decision-primary" data-lab-decision-sha256="${escapeHtml(projection.projectionSha256)}" ${actionEnabled ? "" : "disabled"}>${escapeHtml(state.labDecisionActionBusy ? uiCopy("현재 근거 확인 중…", "Checking current evidence…") : uiCopy(labDecisionActionLabels[projection.action?.kind], labDecisionActionLabelsEn[projection.action?.kind]) || projection.action?.action || uiCopy("다음 동작", "Next action"))}</button>` : `<span class="labDecisionActionHint">${uiCopy("아래의 한 동작으로 이어집니다.", "Continue with one of the actions below.")}</span>`}</footer>${state.labDecisionActionError ? `<p class="labDecisionError" role="alert">${escapeHtml(state.labDecisionActionError)}</p>` : ""}</section>`;
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
    const analysisSpec = analysisSpecById(decision.analysisSpecId);
    if (!analysisSpec || analysisSpec.status !== "draft"
      || decision.basisVersion !== analysisSpec.currentVersion
      || decision.basisContentSha256 !== analysisSpec.currentDocumentSha256) return null;
    const bindings = lifecycle.openBlockingDecisions.filter((candidate) => candidate.id === decision.id && candidate.contentSha256 === decision.proposalSha256);
    return bindings.length === 1 ? decision : null;
  };
  const manuscriptById = (id) => state.manuscripts.find((manuscript) => manuscript.id === id) || null;
  const invalidateManuscriptRequests = () => {
    manuscriptEditorRequestEpoch += 1;
    manuscriptSaveRequestEpoch += 1;
  };
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
    return `<details class="statisticsLineage provenanceDisclosure" data-statistics-lineage data-projection-schema="${escapeHtml(receipt.schema)}" data-source-artifact-id="${escapeHtml(receipt.sourceArtifact.artifactId)}" data-source-artifact-version="${escapeHtml(receipt.sourceArtifact.artifactVersion)}" data-source-artifact-sha256="${escapeHtml(receipt.sourceArtifact.contentSha256)}" data-projection-receipt-sha256="${escapeHtml(receipt.receiptSha256)}" data-run-id="${escapeHtml(runId)}" data-output-artifact-id="${escapeHtml(artifactId)}" data-output-artifact-version="${escapeHtml(artifactVersion)}" data-output-artifact-sha256="${escapeHtml(artifactSha256)}"><summary><strong>${escapeHtml(uiCopy("근거 연결", "Evidence chain"))}</strong><span>${escapeHtml(method)} · ${escapeHtml(mapping)} · ${escapeHtml(receipt.includedRowCount)} rows</span></summary><div class="provenanceTrail"><span>Source table <code title="${escapeHtml(receipt.sourceArtifact.artifactId)}">${escapeHtml(statisticsShortHash(receipt.sourceArtifact.artifactId))}</code> · v${escapeHtml(receipt.sourceArtifact.artifactVersion)}</span><i aria-hidden="true">→</i><span>${escapeHtml(method)} · ${escapeHtml(mapping)} · ${escapeHtml(receipt.includedRowCount)} rows</span><i aria-hidden="true">→</i><span>Projection <code title="${escapeHtml(receipt.receiptSha256)}">${escapeHtml(statisticsShortHash(receipt.receiptSha256))}</code></span><i aria-hidden="true">→</i><span>Run <code title="${escapeHtml(runId)}">${escapeHtml(statisticsShortHash(runId))}</code></span></div></details>`;
  }
  const labIdForArtifact = (artifactId) => {
    for (const [labId, contexts] of state.labContextsById) {
      if ((contexts || []).some((context) => context?.artifact?.id === artifactId)) return labId;
    }
    return null;
  };
  const artifactForLab = (labId, artifactId) => (state.labContextsById.get(labId) || []).map((context) => context.artifact).find((artifact) => artifact.id === artifactId) || null;
  const labForArtifact = (artifactId) => [...state.labContextsById.entries()].find(([, contexts]) => contexts.some((context) => context.artifact.id === artifactId))?.[0] || null;

  // RESULT_ARTIFACT_ROUTE_HELPER_START
  function mergePreferredLabContext(latestContexts, preferredContext, projectId, labId) {
    const latest = Array.isArray(latestContexts) ? latestContexts : [];
    if (!preferredContext
      || preferredContext.artifact?.projectId !== projectId
      || preferredContext.linkage?.labId !== labId
      || !preferredContext.artifact?.id) {
      return latest;
    }
    return [preferredContext, ...latest.filter((item) => item?.artifact?.id !== preferredContext.artifact.id)];
  }
  // RESULT_ARTIFACT_ROUTE_HELPER_END

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

  async function refreshConversationOnly(projectId, { refreshRuntimeSelection = false } = {}) {
    if (conversationRefreshInFlight) {
      conversationRefreshPending = true;
      conversationRefreshPendingRuntime = conversationRefreshPendingRuntime || refreshRuntimeSelection;
      return conversationRefreshInFlight;
    }
    const performRefresh = async (shouldRefreshRuntime) => {
      const conversation = selectedConversation();
      if (!conversation || projectId !== state.selectedId) return;
      const activeTurnSnapshot = state.activeTurn ? {
        id: state.activeTurn.id,
        lastSequence: state.activeTurn.lastSequence,
      } : null;
      const messages = await science.conversations.messages(projectId, conversation.id);
      const safeMessages = Array.isArray(messages) ? messages : [];
      const [messageEvidence, messageArtifactRows, attached, manuscripts, journalProfiles, analysisSpecs, decisions, lifecycle, project, researchContract, graphSnapshot, labDecisionProjections, loopInspection, runs] = await Promise.all([
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
        science.researchLoops.inspect(projectId).catch(() => null),
        science.runs.list(projectId),
      ]);
      if (projectId !== state.selectedId || conversation.id !== selectedConversation()?.id) return;
      const attachedTurn = attached?.turn || null;
      const currentTurn = state.activeTurn;
      const activeTurnAdvanced = currentTurn?.id !== activeTurnSnapshot?.id
        || Number(currentTurn?.lastSequence) !== Number(activeTurnSnapshot?.lastSequence);
      if (activeTurnAdvanced && currentTurn && attachedTurn?.id !== currentTurn.id) {
        conversationRefreshPending = true;
        conversationRefreshPendingRuntime = conversationRefreshPendingRuntime || shouldRefreshRuntime;
        return;
      }
      if (attachedTurn && currentTurn && attachedTurn.id === currentTurn.id && Number(attachedTurn.lastSequence) < Number(currentTurn.lastSequence)) {
        conversationRefreshPending = true;
        conversationRefreshPendingRuntime = conversationRefreshPendingRuntime || shouldRefreshRuntime;
        return;
      }
      state.messages = safeMessages;
      state.chatMessagesScope = JSON.stringify([projectId, conversation.id]);
      state.artifactContextsByMessage = new Map(messageArtifactRows.map(([messageId, contexts]) => [messageId, Array.isArray(contexts) ? contexts : []]));
      state.blocksByMessage = messageEvidence.blocks;
      state.citationsByMessage = messageEvidence.citations;
      state.evidenceById = messageEvidence.spans;
      state.activeTurn = attachedTurn || null;
      state.composerError = composerTurnError(state.activeTurn);
      if (shouldRefreshRuntime) {
        await refreshScienceRuntimeSelection(projectId, conversation.id, { renderDock: false });
        if (projectId !== state.selectedId || conversation.id !== selectedConversation()?.id) return;
      }
      state.manuscripts = Array.isArray(manuscripts) ? manuscripts : state.manuscripts;
      try {
        await refreshProjectLibrarySummaries();
      } catch {
        if (projectId === state.selectedId && conversation.id === selectedConversation()?.id) {
          state.projectLibrarySummaryState = "unavailable";
        }
      }
      if (projectId !== state.selectedId || conversation.id !== selectedConversation()?.id) return;
      state.journalProfiles = Array.isArray(journalProfiles) ? journalProfiles : state.journalProfiles;
      state.analysisSpecs = Array.isArray(analysisSpecs) ? analysisSpecs : state.analysisSpecs;
      state.decisions = Array.isArray(decisions) ? decisions : [];
      state.labDecisionProjections = Array.isArray(labDecisionProjections) ? labDecisionProjections : [];
      state.runs = Array.isArray(runs) ? runs : [];
      state.lifecycle = lifecycle;
      state.researchLoopInspection = loopInspection;
      state.evidenceGraph = graphSnapshot?.graph || null;
      state.evidenceGraphReviews = Array.isArray(graphSnapshot?.reviews) ? graphSnapshot.reviews : [];
      state.evidenceGraphError = graphSnapshot?.error || "";
      applyResearchContractSnapshot(project, researchContract);
      if (!journalProfileById(state.selectedJournalProfileId)) state.selectedJournalProfileId = state.journalProfiles[0]?.id || null;
      for (const tab of state.workspaceTabs.filter((item) => item.kind === "manuscript")) {
        const manuscript = manuscriptById(tab.manuscriptId);
        if (manuscript) { tab.title = manuscript.title; tab.exactVersion = manuscript.currentVersion; tab.exactContentSha256 = manuscript.version?.contentSha256 || null; }
      }
      if (!state.projectFolderOpen && await maybeOpenDraftJobManuscript(projectId, { terminalStatus: state.activeTurn?.status })) return;
      maybePresentAnalysisPlanReview();
      if (state.researchContractSheet || state.analysisPlanReviewSheet) { render(); return; }
      renderWorkspaceTabs();
      renderChatDock();
    };
    let nextRuntimeRefresh = refreshRuntimeSelection;
    const run = (async () => {
      while (true) {
        conversationRefreshPending = false;
        conversationRefreshPendingRuntime = false;
        await performRefresh(nextRuntimeRefresh);
        if (!conversationRefreshPending || projectId !== state.selectedId) break;
        nextRuntimeRefresh = conversationRefreshPendingRuntime;
      }
    })();
    conversationRefreshInFlight = run;
    try {
      await run;
    } finally {
      if (conversationRefreshInFlight === run) conversationRefreshInFlight = null;
    }
  }

  async function selectProject(projectId, options = {}) {
    state.librarySelectedProjectId = projectId;
    // Invalidate any whole-library snapshot that was started for the project we are leaving.
    // The next successful project load will publish a fresh canonical projection.
    projectLibrarySummaryRequestEpoch += 1;
    invalidateManuscriptRequests();
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
    const preserveRuntimeSelection = Boolean(preservedWorkspace && !switchingProject);
    state.selectedId = projectId;
    state.projectFolderOpen = Boolean(options.openFolder);
    if (window.matchMedia("(max-width: 680px)").matches) state.railCollapsed = true;
    if (switchingProject && state.manuscriptDraftJob?.projectId !== projectId) state.manuscriptDraftJob = null;
    state.lifecycle = null;
    state.mode = "session";
    if (!preservedWorkspace) resetWorkspaceTabs();
    state.conversations = [];
    state.selectedConversationId = null;
    state.messages = [];
    state.chatMessagesScope = null;
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
    state.analysisPlanReviewSheet = false;
    state.analysisPlanReviewBusy = false;
    state.analysisPlanReviewError = "";
    // Dismissal is scoped to the exact plan id/version/hash/lock key. Preserve it across a
    // same-project refresh or artifact-tab move; a new plan revision naturally has a new key and
    // will be presented again. Switching projects must never carry the dismissal across scope.
    if (switchingProject) state.analysisPlanReviewDismissedKey = null;
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
    if (switchingProject) state.visualViewportByArtifact = new Map();
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
    state.labManagerOpen = false;
    state.labManagerBusyId = null;
    state.labManagerError = "";
    state.activeTurn = null;
    state.researchLoopInspection = null;
    state.researchLoopActionBusy = false;
    state.researchLoopActionError = "";
    state.composerSending = false;
    state.composerError = "";
    if (!preserveRuntimeSelection) {
      runtimeSelectionRequestEpoch += 1;
      state.runtimeSelection = null;
      state.runtimeOptions = [];
      state.runtimeUnavailable = false;
      state.runtimeSelectionLoading = false;
      state.runtimeSelectionBusy = false;
      state.runtimeSelectionError = "";
      state.runtimeSelectionScope = null;
    }
    state.runtimePickerOpen = false;
    state.runtimePickerQuery = "";
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
      const [workspaceState, conversations, sources, sourceFigures, artifacts, labs, capabilityCatalog, labDecisionProjections, rendererPacks, manuscripts, journalProfiles, analysisSpecs, decisions, lifecycle, project, researchContract, graphSnapshot, loopInspection, runs] = await Promise.all([
        science.workspace.get(projectId), science.conversations.list(projectId), science.sources.list(projectId), science.sourceFigures?.list ? science.sourceFigures.list(projectId).catch(() => []) : [], science.artifacts.list(projectId), science.labs.list(projectId), science.labs.catalog(), science.labs.decisionProjections(projectId), science.rendererPacks.list(), science.manuscripts.list(projectId), science.journals.list(projectId), science.analysisSpecs.list(projectId), science.decisions.list(projectId, undefined, ["queued", "presented", "deferred"]), science.researchLifecycle.get(projectId), science.projects.get(projectId), science.researchContracts.get(projectId), science.evidenceGraph.get(projectId).catch((error) => ({ graph: null, reviews: [], error: error instanceof Error ? error.message : String(error) })), science.researchLoops.inspect(projectId).catch(() => null), science.runs.list(projectId),
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
      try {
        await refreshProjectLibrarySummaries();
      } catch {
        // A library summary is a landing/folder projection. Do not make a successfully loaded
        // project unusable when that secondary projection is temporarily unavailable.
        state.projectLibrarySummaryState = "unavailable";
      }
      if (epoch !== selectionEpoch) return;
      state.journalProfiles = safeJournalProfiles;
      state.analysisSpecs = Array.isArray(analysisSpecs) ? analysisSpecs : [];
      state.decisions = Array.isArray(decisions) ? decisions : [];
      state.lifecycle = lifecycle;
      state.researchLoopInspection = loopInspection;
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
      state.chatMessagesScope = conversation ? JSON.stringify([projectId, conversation.id]) : null;
      state.activeTurn = attached?.turn || null;
      state.composerError = composerTurnError(state.activeTurn);
      state.blocksByMessage = messageEvidence.blocks;
      state.citationsByMessage = messageEvidence.citations;
      state.evidenceById = messageEvidence.spans;
      if (state.projectFolderOpen && safeManuscripts.length) {
        const exportRows = await Promise.all(safeManuscripts.map((manuscript) => science.submissions.list(projectId, manuscript.id)));
        if (epoch !== selectionEpoch) return;
        state.submissionExports = exportRows.flatMap((rows) => Array.isArray(rows) ? rows : []);
      }
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
      const runtimeConversation = selectedConversation();
      if (runtimeConversation && !preserveRuntimeSelection) {
        await refreshScienceRuntimeSelection(projectId, runtimeConversation.id, { renderDock: false });
      }
      else if (!runtimeConversation) {
        runtimeSelectionRequestEpoch += 1;
        state.runtimeSelection = null;
        state.runtimeOptions = [];
        state.runtimeUnavailable = false;
        state.runtimeSelectionLoading = false;
        state.runtimeSelectionError = "";
        state.runtimeSelectionScope = null;
        state.runtimePickerOpen = false;
        state.runtimePickerQuery = "";
      }
      if (epoch !== selectionEpoch) return;
      if (!state.projectFolderOpen && await maybeOpenDraftJobManuscript(projectId, { terminalStatus: state.activeTurn?.status })) return;
      maybePresentAnalysisPlanReview();
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
    const destinations = projectDestinationGroups.map((group) => `<section class="projectNavGroup"><div class="projectNavLabel">${escapeHtml(group.label)}</div>${group.items.map((item) => `<button data-project-destination="${escapeHtml(item.id)}" aria-current="${state.currentDestination === item.id}" aria-label="${escapeHtml(item.label)}" title="${escapeHtml(item.label)}" ${item.id === "hypotheses" && pendingHypotheses ? `data-pending-decisions="${escapeHtml(String(pendingHypotheses))}"` : ""}>${heroIcon(item.icon)}<span>${escapeHtml(item.label)}</span>${destinationBadge(item.id)}</button>`).join("")}</section>`).join("");
    return `<aside class="rail" data-rail-mode="${escapeHtml(state.mode)}">
      <div class="railBrand"><span class="railBrandLockup"><img class="railBrandMark" src="./assets/agentlas-mark.png" alt="" aria-hidden="true"><span class="railBrandWordmark"><strong><span class="brandAgentlas">Agentlas</span><span class="brandScience">Science<span class="brandStar">*</span></span></strong></span></span></div>
      <button class="railBackButton" data-action="back-to-work" aria-label="${uiCopy("Agentlas Work로 돌아가기", "Back to Agentlas Work")}" title="${uiCopy("Agentlas Work로 돌아가기", "Back to Agentlas Work")}">${heroIcon("chevron-right", "uiIcon isReverse")}<strong>${uiCopy("Agentlas Work로 돌아가기", "Back to Agentlas Work")}</strong></button>
      <button class="projectLibraryBack" data-action="back-to-projects" aria-label="${uiCopy("프로젝트로 돌아가기", "Back to projects")}" title="${uiCopy("프로젝트로 돌아가기", "Back to projects")}">${heroIcon("chevron-right", "uiIcon isReverse")}<span>${uiCopy("프로젝트로 돌아가기", "Back to projects")}</span></button>
      <section class="railProjectIdentity"><strong title="${escapeHtml(project.title)}">${escapeHtml(project.title)}</strong><span>${escapeHtml(domainLabel(project.domain))}</span></section>
      <button class="newButton" data-action="new" aria-label="새 연구 시작" title="새 연구">${heroIcon("plus")}<strong>새 연구</strong></button>
      <div class="railScrollable"><nav class="projectDestinations projectWorkflowNav" aria-label="현재 프로젝트 연구 흐름">${destinations}</nav>
      <div class="railSection labSection"><div class="railDisclosureRow"><button class="railDisclosure" data-action="toggle-labs" aria-expanded="${state.labsExpanded}"><span>Labs</span>${heroIcon("chevron-down", state.labsExpanded ? "uiIcon isReverse" : "uiIcon")}</button><button class="manageLabsButton" data-action="manage-project-labs" aria-label="${uiCopy("프로젝트 Lab 편집", "Edit project Labs")}" title="${uiCopy("프로젝트 Lab 편집", "Edit project Labs")}">${heroIcon("plus")}</button></div><nav class="labList ${state.labsExpanded ? "isOpen" : ""}" aria-label="현재 프로젝트에 활성화된 Lab 도구와 아티팩트 보관소">${labs || `<span class="railEmpty">${uiCopy("이 프로젝트에는 아직 Lab 북마크가 없습니다.", "This project has no Lab bookmarks yet.")}<em>${uiCopy("필요한 Lab을 추가해 두거나 연구 채팅에서 분석을 요청하세요.", "Add the Labs you want available, or request an analysis in Research chat.")}</em></span>`}</nav></div></div>
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

  function safeScienceSourceHref(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 2048 || !/^https?:\/\//i.test(raw)) return "";
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch {
      return "";
    }
  }

  function scienceInlineMarkdown(value) {
    // Private-use sentinels keep already escaped code, math, and links out of
    // later emphasis replacements. Escape matching input first so model text
    // can never manufacture a renderer token.
    const tokens = [];
    const stash = (html) => `\uE000${tokens.push(html) - 1}\uE001`;
    let source = String(value || "")
      .replace(/\uE000/g, "&#57344;")
      .replace(/\uE001/g, "&#57345;");

    source = source.replace(/(`+)([^`\n]+?)\1/g, (_match, _ticks, code) => (
      stash(`<code>${escapeHtml(code)}</code>`)
    ));
    source = source.replace(/\\\([^\n]+?\\\)|\\\[[^\n]+?\\\]|\$\$[^$\n]+?\$\$|\$[^$\n]+?\$/g, (math) => (
      stash(`<code class="scienceInlineMath">${escapeHtml(math)}</code>`)
    ));
    source = source.replace(/\[([^\]\n]+)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)/g, (_syntax, label, rawHref) => {
      const href = safeScienceSourceHref(rawHref);
      if (!href) return stash(`<span class="scienceBlockedSourceLink">${escapeHtml(label)}</span>`);
      return stash(`<a class="scienceSourceLink" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(label)}</a>`);
    });
    source = source.replace(/<(https?:\/\/[^<>\s]+)>/gi, (syntax, rawHref) => {
      const href = safeScienceSourceHref(rawHref);
      return href ? stash(`<a class="scienceSourceLink" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(rawHref)}</a>`) : escapeHtml(syntax);
    });

    return escapeHtml(source)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/\uE000(\d+)\uE001/g, (_match, index) => tokens[Number(index)] || "");
  }

  function scienceArticleMarkdown(text) {
    // Overview owns the page-level heading. Shift model headings below it,
    // but preserve every byte inside fenced code.
    let fenced = false;
    const landmarkSafe = String(text || "").split(/\r?\n/).map((row) => {
      if (row.trim().startsWith("```")) {
        fenced = !fenced;
        return row;
      }
      if (fenced) return row;
      return row.replace(/^(#{1,3})(?=\s)/, (_match, marks) => "#".repeat(Math.min(3, marks.length + 1)));
    }).join("\n");
    return scienceChatMarkdown(landmarkSafe);
  }

  function messageMarkup(message) {
    const blocks = state.blocksByMessage.get(message.id) || [];
    const artifactContexts = state.artifactContextsByMessage.get(message.id) || [];
    const artifactCards = artifactContexts.length ? `<div class="inlineArtifacts" aria-label="${uiCopy("이 응답에서 생성된 Lab 아티팩트", "Lab artifacts created in this response")}">${artifactContexts.map((context) => {
      const title = context.artifact.title;
      const version = context.selectedVersion.version;
      const versionLabel = `${uiCopy("아티팩트", "Artifact")} v${version}${context.isCurrent ? uiCopy(" · 현재 버전", " · Current version") : uiCopy(` · 현재 v${context.artifact.currentVersion}`, ` · Current v${context.artifact.currentVersion}`)}`;
      const previewLabel = uiCopy(`${title} 미리보기`, `${title} preview`);
      const preview = context.selectedVersion.rendererId === "agentlas.vega"
        ? `<span class="inlineArtifactPreview" data-inline-vega-artifact="${escapeHtml(context.artifact.id)}" data-inline-vega-version="${escapeHtml(version)}" aria-label="${escapeHtml(previewLabel)}"></span>`
        : `<span class="inlineArtifactPreview" data-inline-capture-artifact="${escapeHtml(context.artifact.id)}" data-inline-capture-version="${escapeHtml(version)}" aria-label="${escapeHtml(previewLabel)}"></span>`;
      return `<div class="inlineArtifactItem"><button class="inlineArtifact" data-inline-artifact-id="${escapeHtml(context.artifact.id)}" data-inline-artifact-version="${escapeHtml(version)}" data-inline-conversation-id="${escapeHtml(message.conversationId)}" data-inline-message-id="${escapeHtml(message.id)}" aria-label="${escapeHtml(uiCopy(`${title} 아티팩트 v${version} 열기`, `Open ${title}, artifact version ${version}`))}">${preview}<strong>${escapeHtml(title)}</strong><span>${escapeHtml(versionLabel)}</span></button><button class="inlineArtifactRetry" type="button" data-action="retry-inline-preview" hidden>${uiCopy("미리보기 다시 시도", "Retry preview")}</button></div>`;
    }).join("")}</div>` : "";
    if (message.role === "user") return `<article class="questionBubble"><div>${escapeHtml(message.content)}</div><span>${escapeHtml(formatDate(message.createdAt))}</span></article>`;
    if (!blocks.length) return `<article class="answer" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" tabindex="-1"><div class="answerMeta">${message.role === "assistant" ? "Agentlas Science" : escapeHtml(message.role)}</div><div class="scienceArticleMarkdown">${scienceArticleMarkdown(message.content)}</div>${artifactCards}</article>`;
    return `<article class="answer" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" tabindex="-1"><div class="answerMeta">Agentlas Science · evidence-linked response</div>${blocks.map((block) => `<section class="answerBlock" data-block-kind="${escapeHtml(block.kind)}"><div class="scienceArticleMarkdown">${scienceArticleMarkdown(block.content)}</div>${citationButtons(message.id, block.id)}</section>`).join("")}${artifactCards}</article>`;
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
    const reviewState = plan.status === "frozen" ? uiCopy("사람 승인 완료", "Approved by researcher")
      : decisions.length ? uiCopy(`${decisions.length}개 설계 질문 응답 필요`, `${decisions.length} design question${decisions.length === 1 ? "" : "s"} awaiting response`)
        : plan.latestReview?.decision === "revise" ? uiCopy("수정 요청 전달됨", "Changes requested") : uiCopy("계획 승인 필요", "Plan approval required");
    const reviewAction = plan.status === "draft" && decisions.length === 0
      ? `<button class="primaryButton analysisPlanReviewButton" data-action="open-analysis-plan-review">${uiCopy("계획 검토", "Review plan")}</button>` : "";
    const values = (items, empty = "정의되지 않음") => Array.isArray(items) && items.length ? items.join(", ") : empty;
    const exactInputCount = Array.isArray(document.data?.inputs) ? document.data.inputs.length : 0;
    const acquisitionSourceCount = Array.isArray(document.data?.acquisition?.sources) ? document.data.acquisition.sources.length : 0;
    const plannedStatisticsMethods = Array.isArray(document.requiredDiagnostics)
      ? document.requiredDiagnostics.filter((entry) => typeof entry === "string" && entry.startsWith("agentlas.statistics.method:"))
      : [];
    const executionBlocked = plan.status === "frozen" && plannedStatisticsMethods.length > 0
      && (exactInputCount !== 1 || !model);
    const inputBindingSummary = exactInputCount
      ? uiCopy(`정확한 아티팩트 버전 ${exactInputCount}개`, `${exactInputCount} exact artifact version${exactInputCount === 1 ? "" : "s"}`)
      : acquisitionSourceCount
        ? uiCopy(`사전 수집 출처 ${acquisitionSourceCount}개 · 분석 전 정확한 입력 재승인 필요`, `${acquisitionSourceCount} preregistered source${acquisitionSourceCount === 1 ? "" : "s"} · exact inputs require approval before analysis`)
        : uiCopy("입력 데이터 또는 수집 계획 없음", "No input data or acquisition plan");
    const modelBoundary = executionBlocked
      ? uiCopy("실행 차단 — 통계 분석을 시작하려면 정확히 하나의 정렬된 Data Table과 구체적인 호환 모형을 묶은 후속 계획이 필요합니다.", "Execution blocked — statistics require a successor plan binding exactly one aligned Data Table and a concrete compatible model.")
      : uiCopy("분석 실행 전에 구체적인 호환 모형을 묶어야 합니다.", "A concrete compatible model must be bound before analysis can run.");
    const blockedBadge = executionBlocked
      ? `<em class="analysisPlanExecutionBadge" data-status="blocked">${uiCopy("실행 차단", "Execution blocked")}</em>`
      : "";
    return `<section class="analysisPlanView" data-analysis-plan-id="${escapeHtml(plan.id)}" data-analysis-plan-version="${escapeHtml(plan.currentVersion)}" data-analysis-plan-sha256="${escapeHtml(plan.currentDocumentSha256)}" data-execution-ready="${executionBlocked ? "false" : "true"}"><header><div><span>PLAN & PROTOCOLS · EXACT VERSION</span><h1>${escapeHtml(plan.title)}</h1><p>${escapeHtml(document.researchQuestion || project.question)}</p></div><div class="analysisPlanIdentity"><em data-status="${escapeHtml(plan.status)}">${escapeHtml(plan.status)}</em>${blockedBadge}<strong>v${escapeHtml(plan.currentVersion)}</strong><code title="${escapeHtml(plan.currentDocumentSha256)}">${escapeHtml(plan.currentDocumentSha256.slice(0, 12))}…</code>${reviewAction}</div></header><div class="analysisPlanGrid"><section><span>Estimand</span>${estimand ? `<dl><div><dt>Population</dt><dd>${escapeHtml(estimand.population)}</dd></div><div><dt>Exposure</dt><dd>${escapeHtml(estimand.treatmentOrExposure)}</dd></div><div><dt>Comparator</dt><dd>${escapeHtml(estimand.comparator || "없음")}</dd></div><div><dt>Outcome</dt><dd>${escapeHtml(estimand.outcome)}</dd></div><div><dt>Measure</dt><dd>${escapeHtml(estimand.summaryMeasure)}</dd></div></dl>` : `<p>연구자가 estimand를 아직 확정하지 않았습니다.</p>`}</section><section><span>Design & dependence</span><dl><div><dt>Study</dt><dd>${escapeHtml(document.design?.studyType || "미정")}</dd></div><div><dt>Observation unit</dt><dd>${escapeHtml(document.design?.observationUnit || "미정")}</dd></div><div><dt>Dependence</dt><dd>${escapeHtml(document.design?.dependence?.kind || "unresolved")}</dd></div><div><dt>Inputs</dt><dd>${escapeHtml(inputBindingSummary)}</dd></div></dl></section><section><span>Model</span>${model ? `<dl><div><dt>Family</dt><dd>${escapeHtml(model.family)}</dd></div><div><dt>Formula</dt><dd><code>${escapeHtml(model.formula)}</code></dd></div><div><dt>Distribution / link</dt><dd>${escapeHtml(`${model.distribution || "—"} / ${model.link || "—"}`)}</dd></div><div><dt>Rationale</dt><dd>${escapeHtml(model.rationale)}</dd></div></dl>` : `<p class="${executionBlocked ? "analysisPlanExecutionBlock" : ""}">${escapeHtml(modelBoundary)}</p>`}</section><section><span>Validity checks</span><dl><div><dt>Diagnostics</dt><dd>${escapeHtml(values(document.requiredDiagnostics))}</dd></div><div><dt>Sensitivity</dt><dd>${escapeHtml(values(document.sensitivityAnalyses))}</dd></div><div><dt>Missing data</dt><dd>${escapeHtml(document.missingData?.strategy || "unresolved")}</dd></div><div><dt>Multiplicity</dt><dd>${escapeHtml(document.multiplicity?.strategy || "unresolved")}</dd></div></dl></section></div><footer><div><span>Human review</span><strong>${escapeHtml(reviewState)}</strong></div><div><span>Expected outputs</span><strong>${escapeHtml(values(document.expectedArtifacts?.map((item) => item.title), "등록 없음"))}</strong></div><div><span>Runtime boundary</span><strong>${escapeHtml(`${document.runtimePolicy?.network || "deny"} network · ${document.runtimePolicy?.maxWallTimeMinutes || "-"} min`)}</strong></div></footer></section>`;
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
    const waitingLabel = pendingHypothesisCopy(pending);
    const waitingNotice = pending
      ? `<div class="researcherWaiting" role="status" data-pending-decisions="${escapeHtml(String(pending))}"><span class="stateGlyph" data-state="awaiting-human" aria-hidden="true"></span><strong>${escapeHtml(waitingLabel)}</strong><p>${escapeHtml(uiCopy("연구는 이 결정 없이 다음 단계로 가지 않습니다. 승인하거나 기각해 주세요.", "Research cannot advance without this decision. Approve or reject it."))}</p></div>`
      : "";
    return `<section class="researchView hypothesesView" data-research-destination="hypotheses" data-waiting-on="${pending ? "researcher" : "none"}"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>가설</span></div>
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
  const literatureShortHash = (value) => (value ? `${String(value).slice(0, 12)}…` : uiCopy("기록된 내용 해시 없음", "No content hash recorded"));
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
    const emptySpanGuidance = state.evidenceGraph
      ? uiCopy("이 출처의 문장이 주장을 받치려면 먼저 근거 구간으로 인용되어 Evidence Graph에 기록되어야 합니다. 연구 채팅에서 이 출처를 인용하면 여기에 나타납니다.", "A passage from this source must first be cited as an evidence span and recorded in the Evidence Graph before it can support a claim. Cite this source in the research chat and it will appear here.")
      : uiCopy("이 출처의 문장이 주장을 받치려면 먼저 근거 구간으로 인용되어 Evidence Graph에 기록되어야 합니다. 해석·결정 화면에서 Evidence Graph를 먼저 만들면 이미 인용된 구간도 여기에 나타납니다.", "A passage from this source must first be cited as an evidence span and recorded in the Evidence Graph before it can support a claim. Build the Evidence Graph in Interpretation & Decisions and previously cited spans will appear here.");
    const spanBody = spans.length === 0
      ? `<div class="literatureSpanEmpty"><strong>${escapeHtml(uiCopy("승격된 근거 구간이 없습니다.", "No evidence span has been promoted yet."))}</strong><p>${escapeHtml(emptySpanGuidance)}</p></div>`
      : `<ul class="literatureSpanList">${spans.map((span) => `<li class="literatureSpan" data-evidence-span-id="${escapeHtml(span.id)}" data-evidence-scope="${escapeHtml(span.scope)}" data-evidence-status="${escapeHtml(span.status)}">
          <div class="literatureSpanMeta"><code>${escapeHtml(span.locator || "위치 표기 없음")}</code><span>${escapeHtml(literatureSpanScopeLabels[span.scope] || "구간 범위가 기록되지 않음")}</span>${span.status === "invalidated" ? `<em>무효화됨</em>` : ""}<code title="${escapeHtml(span.contentSha256)}">${escapeHtml(literatureShortHash(span.contentSha256))}</code></div>
          <blockquote class="literatureSpanExcerpt">${escapeHtml(span.excerpt || "발췌 본문이 기록되지 않았습니다.")}</blockquote>
        </li>`).join("")}</ul>`;
    return `<article class="literatureSource" data-source-id="${escapeHtml(source.id)}" data-access-state="${escapeHtml(version?.accessState || "unknown")}" data-text-scope="${escapeHtml(scope)}" data-verification-status="${escapeHtml(source.verificationStatus || "unverified")}">
      <header class="literatureSourceHeader">
        <strong>${escapeHtml(source.title || "제목이 기록되지 않은 출처")}</strong>
        <button class="literatureSourceOpen" type="button" data-source-id="${escapeHtml(source.id)}">${uiCopy("파일 열기", "Open file")} ${heroIcon("chevron-right")}</button>
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
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>문헌·선행근거</span></div>
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
          <div class="acquisitionOutputMeta"><strong>${escapeHtml(output.role || "역할 미기록")}</strong><span class="acquisitionOutputMime" title="${escapeHtml(output.mimeType || "형식 미기록")}">${escapeHtml(output.mimeType || "형식 미기록")}</span><span class="acquisitionOutputSize">${escapeHtml(acquisitionBytes(output.byteSize))}</span></div>
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
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>데이터 수집</span></div>
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
    const loadEpoch = ++scopeLoadEpoch;
    const projectEpoch = selectionEpoch;
    const isCurrent = () => projectId === state.selectedId && projectEpoch === selectionEpoch && loadEpoch === scopeLoadEpoch;
    state.scopeLoading = true;
    try {
      const [scopeProject, contract] = await Promise.all([
        science.projects.get(projectId),
        science.researchContracts.get(projectId),
      ]);
      if (!isCurrent()) return;
      state.scopeLoading = false;
      state.scopeError = "";
      // Keep the approval sheet reading the same contract Scope shows, but never pop it open on
      // arrival: the researcher opens it from the button below.
      applyResearchContractSnapshot(scopeProject, contract, { openDraft: false });
      render();
    } catch (error) {
      if (!isCurrent()) return;
      state.scopeLoading = false;
      state.scopeError = `연구 계약을 불러오지 못했습니다. (${String(error?.message ?? error)})`;
      render();
    }
  }

  function scopeView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">프로젝트 기록을 불러오는 중…</div>`;
    if (state.projectError) return errorState();
    // Scope and the approval sheet must render the same accepted snapshot.
    // A second Scope-only copy stayed at "draft" after a successful approval.
    const contract = state.researchContract?.projectId === state.selectedId ? state.researchContract : null;
    const scopeProject = state.projects.find((item) => item.id === state.selectedId) || project;
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
          ? `<div class="scopeApproval"><p>${uiCopy("이 계약은 아직 사람의 승인을 기다리는 초안입니다. 승인 후 연구 채팅에서 이 목표와 중단 기준에 맞춰 다음 작업을 요청할 수 있습니다.", "This contract awaits your approval. After approval, you can request the next step in the research chat under this objective and these stop criteria.")}</p><button class="primaryButton" data-action="open-research-contract-sheet">계약 v${escapeHtml(contract.version)} 검토·승인</button></div>`
          : contract.status === "approved" ? `<div class="scopeApproval"><p>${uiCopy("계약이 승인되었습니다. 연구를 계속하려면 연구 채팅에 다음 작업을 요청하세요. 승인만으로 중단한 실행을 다시 시작하지는 않습니다.", "Contract approved. To continue, request the next step in the research chat. Approval alone does not restart a stopped run.")}</p></div>` : ""}
      </div>`
      : `<div class="emptyCopy"><strong>아직 연구 계약이 없습니다.</strong><p>연구 채팅에서 첫 질문을 보내면 목표와 중단 기준을 담은 계약 초안이 만들어지고, 여기에서 승인할 수 있습니다.</p></div>`;
    return `<section class="researchView scopeView" data-research-destination="scope"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>범위</span></div>
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
      "analysis-plan": "분석 계획 검증·확정",
      "submission-attestation": "제출 최종 확인 (연구자 이름으로 출판사에 나가는 진술)",
    };
    // Each row delegates a different decision. One shared sentence made four
    // checkboxes read as one switch, which is how a blanket grant gets clicked.
    const scopeGranted = {
      "research-contract": "목표와 중단 기준을 연구자 확인 없이 확정합니다",
      hypothesis: "제안된 가설을 스스로 채택하거나 기각합니다",
      "journal-identity": "투고할 저널의 요건을 스스로 확정합니다",
      "analysis-plan": "허용된 범위에서 완전한 계획 버전을 고정합니다",
      "submission-attestation": "제출 진술을 연구자 확인 없이 확정합니다",
    };
    const scopeAsked = {
      "research-contract": "계약을 확정하기 전에 묻습니다",
      hypothesis: "가설을 채택·기각하기 전에 묻습니다",
      "journal-identity": "저널 요건을 확정하기 전에 묻습니다",
      "analysis-plan": "계획 버전을 확정하기 전에 검토를 요청합니다",
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
    return `<section class="approvalPolicyPanel" aria-busy="${approvalPolicyWrites.has(state.selectedId)}">
      <h2>승인 방식</h2>
      <p class="approvalPolicyNote">체크한 항목은 연구가 멈추지 않고 진행하며, 누가 언제 허용했는지는 그대로 기록됩니다. 해제하면 그 지점에서 묻습니다.</p>
      ${state.approvalPolicyError ? `<div class="errorCopy" role="alert">${escapeHtml(state.approvalPolicyError)}</div>` : ""}
      <ul class="approvalScopes">${rows}</ul>
      <p data-approval-save-status role="status">${approvalPolicyWrites.has(state.selectedId) ? uiCopy("승인 설정 저장 중…", "Saving approval settings…") : ""}</p>
      <p class="approvalPolicyProvenance">현재 정책 r${escapeHtml(String(policy.revision))} · ${escapeHtml(policy.grantedBy)}</p>
    </section>`;
  }

  const approvalPolicyWrites = new Map();
  const approvalPolicyWriteErrors = new Map();

  async function loadApprovalPolicy(projectId) {
    if (!projectId) return;
    try {
      const policy = await science.approvalPolicy.get(projectId);
      if (projectId !== state.selectedId) return;
      state.approvalPolicy = policy;
      state.approvalPolicyError = approvalPolicyWriteErrors.get(projectId) || "";
    } catch (error) {
      if (projectId !== state.selectedId) return;
      state.approvalPolicy = null;
      state.approvalPolicyError = String(error?.message ?? error);
    }
    render();
  }

  async function toggleApprovalScope(scope, enabled) {
    const projectId = state.selectedId;
    if (!projectId || !scope || typeof enabled !== "boolean") return;
    const previous = approvalPolicyWrites.get(projectId);
    if (!previous) approvalPolicyWriteErrors.delete(projectId);
    // Capture the requested checked state, not a toggle against a stale snapshot.
    // Serialize within this project and merge each intent with the latest receipt.
    const write = (previous || Promise.resolve()).then(async () => {
      const policy = await science.approvalPolicy.get(projectId);
      const scopes = policy.mode === "autonomous" ? policy.scopes : [];
      const next = enabled ? [...new Set([...scopes, scope])] : scopes.filter((item) => item !== scope);
      // Turning everything off is `checkpoint`: a mode, not an empty list, so the intent survives
      // a later scope being added to the product.
      await science.approvalPolicy.set({
        requestId: crypto.randomUUID(),
        projectId,
        mode: next.length ? "autonomous" : "checkpoint",
        scopes: next,
        grantedBy: "researcher",
      });
      const saved = await science.approvalPolicy.get(projectId);
      if (projectId === state.selectedId) state.approvalPolicy = saved;
    }).catch((error) => {
      approvalPolicyWriteErrors.set(projectId, `승인 방식을 저장하지 못했습니다. (${String(error?.message ?? error)})`);
    });
    approvalPolicyWrites.set(projectId, write);
    root.querySelector(".approvalPolicyPanel")?.setAttribute("aria-busy", "true");
    const status = root.querySelector("[data-approval-save-status]");
    if (status) status.textContent = uiCopy("승인 설정 저장 중…", "Saving approval settings…");
    await write;
    if (approvalPolicyWrites.get(projectId) !== write) return;
    approvalPolicyWrites.delete(projectId);
    if (projectId !== state.selectedId) return;
    state.approvalPolicyError = approvalPolicyWriteErrors.get(projectId) || "";
    render();
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
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>기록</span></div>
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
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>제출·보관</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      ${state.submissionArchiveError ? `<div class="errorCopy" role="alert">${escapeHtml(state.submissionArchiveError)}</div>` : ""}
      ${blockedCount ? `<div class="submissionArchiveWarning" role="status"><strong>완성되지 않은 제출본 ${escapeHtml(blockedCount)}건</strong><span>아래 목록 맨 위에 있습니다.</span></div>` : ""}
      <section class="submissionArchiveSection"><h2>저널 프로필</h2>${state.submissionArchiveLoading && profiles.length === 0 ? `<div class="loadingState" aria-live="polite">저널 프로필을 불러오는 중…</div>` : profileList}</section>
      <section class="submissionArchiveSection"><h2>제출본</h2>${state.submissionArchiveLoading && exports.length === 0 ? `<div class="loadingState" aria-live="polite">제출본 기록을 불러오는 중…</div>` : exportList}</section>
    </div></section>`;
  }

  // Analysis & Runs answers what a reviewer asks first: which analyses actually ran, under which
  // frozen plan, and whether the result on screen is still the exact thing that run computed. A run
  // recorded as succeeded that produced no output is the failure worth showing. A valid output can
  // remain a run manifest without being projected into a scientific artifact; that boundary is
  // shown explicitly instead of turning a successful search into a false rerun warning.
  const ANALYSIS_RUN_EXACT_RECHECK_LIMIT = 20;
  const RESULTS_VALIDATION_LOOKUP_LIMIT = 60;
  const runResultShortHash = (value) => (value ? `${String(value).slice(0, 12)}…` : "—");
  const analysisRunStatusLabels = {
    running: ["실행 중", "Running"], succeeded: ["성공", "Succeeded"],
    failed: ["실패", "Failed"], cancelled: ["취소됨", "Cancelled"],
  };
  const analysisRunOutputs = (run) => (Array.isArray(run?.outputs) ? run.outputs : []);
  const analysisRunBoundOutputs = (run) => (Array.isArray(run?.outputs) ? run.outputs : []).filter((output) => output?.artifactId);
  const analysisRunSucceededWithoutOutput = (run) => run?.status === "succeeded" && analysisRunOutputs(run).length === 0;

  async function loadAnalysisRuns(projectId) {
    if (!projectId) return;
    try {
      const [runs, artifacts] = await Promise.all([science.runs.list(projectId), science.artifacts.list(projectId)]);
      if (projectId !== state.selectedId) return;
      const rows = Array.isArray(runs) ? runs : [];
      // The "succeeded but produced nothing" claim is re-read from the exact run record rather than
      // trusted from a list snapshot, so the accusation is against the store's current truth.
      const suspect = rows.filter(analysisRunSucceededWithoutOutput).slice(0, ANALYSIS_RUN_EXACT_RECHECK_LIMIT);
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
      : uiCopy("고정된 분석계획 없음 — 이 실행은 사전 등록된 계획 아래에서 돌지 않았습니다.", "No pinned analysis plan — this run was not executed under a preregistered plan.");
    const inputCount = (Array.isArray(run?.inputs) ? run.inputs : []).length;
    const outputs = analysisRunOutputs(run);
    const boundOutputs = analysisRunBoundOutputs(run);
    const boundArtifactIds = new Set(boundOutputs.map((output) => output.artifactId));
    // Some acquisition tools keep the output manifest immutable and record the later artifact
    // projection separately. The artifact read model still carries the exact sourceRunId, so show
    // that durable result instead of leaving the researcher with byte/hash rows only.
    const projectedArtifacts = [...artifactsById.values()].filter((artifact) => artifact?.sourceRunId === run.id && !boundArtifactIds.has(artifact.id));
    const outputRows = boundOutputs.map((output) => {
      const artifact = artifactsById.get(output.artifactId) || null;
      const boundVersion = Number(output.artifactVersion);
      const binding = !artifact
        ? uiCopy("이 프로젝트의 아티팩트 목록에 없습니다. 결과를 열 수 없습니다.", "This result is not in the project's artifact list and cannot be opened.")
        : Number(artifact.currentVersion) === boundVersion
          ? uiCopy("현재 버전이 이 실행이 계산한 그 버전입니다.", "The current artifact version is the exact version produced by this run.")
          : uiCopy(`아티팩트가 v${artifact.currentVersion}로 갱신됐습니다. 지금 열리는 결과는 이 실행이 계산한 버전이 아닙니다.`, `The artifact is now v${artifact.currentVersion}. The version currently opened is not the version produced by this run.`);
      return `<li class="analysisRunOutput" data-output-current="${Boolean(artifact && Number(artifact.currentVersion) === boundVersion)}">
        <strong>${escapeHtml(artifact?.title || output.artifactId)}</strong>
        <span>${escapeHtml(artifact?.kind || output.mimeType || "unknown")} · v${escapeHtml(boundVersion)} · <code title="${escapeHtml(output.sha256)}">${escapeHtml(runResultShortHash(output.sha256))}</code></span>
        <em>${escapeHtml(binding)}</em>
        ${artifact ? `<button class="analysisRunArtifactOpen" type="button" data-action="open-result-artifact" data-result-artifact-id="${escapeHtml(artifact.id)}" data-result-artifact-version="${escapeHtml(boundVersion)}">${uiCopy("정확한 아티팩트 열기", "Open exact artifact")}${heroIcon("chevron-right")}</button>` : ""}
      </li>`;
    }).join("");
    const projectedRows = projectedArtifacts.map((artifact) => {
      const artifactVersion = Number(artifact.currentVersion);
      return `<li class="analysisRunOutput analysisRunProjectedArtifact" data-output-current="true">
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(artifact.kind || "artifact")} · v${escapeHtml(artifactVersion)} · <code title="${escapeHtml(artifact.version?.contentSha256 || "")}">${escapeHtml(runResultShortHash(artifact.version?.contentSha256))}</code></span>
        <em>${uiCopy("이 실행에서 생성되어 프로젝트 아티팩트로 연결된 정확한 결과입니다.", "This exact result was created by this run and linked as a project artifact.")}</em>
        <button class="analysisRunArtifactOpen" type="button" data-action="open-result-artifact" data-result-artifact-id="${escapeHtml(artifact.id)}" data-result-artifact-version="${escapeHtml(artifactVersion)}">${uiCopy("정확한 아티팩트 열기", "Open exact artifact")}${heroIcon("chevron-right")}</button>
      </li>`;
    }).join("");
    const manifestRows = outputs.filter((output) => !output?.artifactId).map((output) => `<li class="analysisRunManifestOutput" data-output-role="${escapeHtml(output?.role || "")}">
      <strong>${escapeHtml(output?.role || uiCopy("저장 결과", "Stored result"))}</strong>
      <span title="${escapeHtml(output?.mimeType || uiCopy("형식 미기록", "Format not recorded"))}">${escapeHtml(output?.mimeType || uiCopy("형식 미기록", "Format not recorded"))}</span>
      <span>${escapeHtml(acquisitionBytes(output?.byteSize))}</span>
      <code title="${escapeHtml(output?.sha256 || "")}">${escapeHtml(runResultShortHash(output?.sha256))}</code>
    </li>`).join("");
    const outputless = analysisRunSucceededWithoutOutput(run);
    return `<article class="analysisRun" data-run-id="${escapeHtml(run.id)}" data-run-status="${escapeHtml(status)}" data-run-outputless="${Boolean(outputless)}">
      <header>
        <strong>${escapeHtml(`${run.toolId ?? "unknown"} ${run.toolVersion ?? ""}`.trim())}</strong>
        <span>${escapeHtml(analysisRunStatusLabels[status] ? uiCopy(...analysisRunStatusLabels[status]) : status)} · ${escapeHtml(run.runtime ?? "unknown")}</span>
        <code title="${escapeHtml(run.id)}">${escapeHtml(runResultShortHash(run.id))}</code>
      </header>
      <dl class="analysisRunFacts">
        <div><dt>${uiCopy("분석계획", "Analysis plan")}</dt><dd>${escapeHtml(planLine)}</dd></div>
        <div><dt>${uiCopy("입력", "Inputs")}</dt><dd>${escapeHtml(uiCopy(`${inputCount}개 · 매니페스트 ${runResultShortHash(run.inputManifestSha256)}`, `${inputCount} · manifest ${runResultShortHash(run.inputManifestSha256)}`))}</dd></div>
        <div><dt>${uiCopy("출력 매니페스트", "Output manifest")}</dt><dd>${escapeHtml(run.outputManifestSha256 ? runResultShortHash(run.outputManifestSha256) : uiCopy("없음", "None"))}</dd></div>
        <div><dt>${uiCopy("시작 · 종료", "Started · finished")}</dt><dd>${escapeHtml(`${run.startedAt ?? "—"} · ${run.finishedAt || uiCopy("진행 중", "In progress")}`)}</dd></div>
      </dl>
      ${run.summary ? `<p class="analysisRunSummary">${escapeHtml(run.summary)}</p>` : ""}
      ${boundOutputs.length || projectedArtifacts.length
        ? `<ul class="analysisRunOutputs">${outputRows}${projectedRows}</ul>`
        : ""}
      ${manifestRows ? `<div class="analysisRunManifest"><strong>${uiCopy(`저장된 결과 매니페스트 ${outputs.length - boundOutputs.length}개`, `Stored result manifests: ${outputs.length - boundOutputs.length}`)}</strong><ul>${manifestRows}</ul><p>${projectedArtifacts.length ? uiCopy("원시 출력은 매니페스트로 보존되며, 이 실행에서 생성된 정확한 아티팩트는 위 링크에서 열 수 있습니다.", "Raw outputs remain preserved as manifests; open the exact artifact created by this run from the link above.") : uiCopy("실행 결과는 보존됐지만 과학 아티팩트로 투영되지는 않았습니다. 그림·표·원고에는 아직 연결할 수 없습니다.", "The run result is preserved, but it has not been projected into a scientific artifact. It cannot yet be linked to a figure, table, or manuscript.")}</p></div>` : ""}
      ${outputless ? `<p class="analysisRunUnbound" role="alert"><strong>${uiCopy("성공으로 기록됐지만 출력이 없습니다.", "The run is marked as succeeded, but it has no output.")}</strong><span>${uiCopy("정확한 실행 기록을 다시 읽어 확인했습니다. 출력 매니페스트 항목이 하나도 없어 이 실행은 결과로 셀 수 없습니다. 출력이 필요한 실행이었다면 다시 실행해야 합니다.", "The exact run record was checked again. With no output-manifest entries, this run cannot count as a result. If output was expected, run it again.")}</span></p>` : ""}
    </article>`;
  }

  function analysisRunsView(project) {
    if (state.loadingProject) return `<div class="loadingState" aria-live="polite">${uiCopy("프로젝트 기록을 불러오는 중…", "Loading project records…")}</div>`;
    if (state.projectError) return errorState();
    const loaded = state.analysisRunsProjectId === state.selectedId;
    const runs = loaded && Array.isArray(state.analysisRuns) ? state.analysisRuns : [];
    const artifactsById = new Map((Array.isArray(state.analysisRunArtifacts) ? state.analysisRunArtifacts : []).map((artifact) => [artifact.id, artifact]));
    const outputlessCount = runs.filter(analysisRunSucceededWithoutOutput).length;
    const body = !loaded
      ? `<div class="loadingState" aria-live="polite">${uiCopy("실행 기록을 불러오는 중…", "Loading run records…")}</div>`
      : state.analysisRunsError
        ? ""
        : runs.length === 0
          ? `<div class="emptyCopy pageEmpty"><strong>${uiCopy("아직 실행된 분석이 없습니다.", "No analyses have run yet.")}</strong><p>${uiCopy("분석계획 화면에서 계획을 고정한 뒤 연구 채팅에서 실행을 요청하면, 어떤 계획 아래 무엇이 돌았고 무엇을 만들었는지가 여기에 기록됩니다.", "Pin a plan in Analysis Plans, then request a run in Research Chat. This page will record which plan ran, what it used, and what it produced.")}</p></div>`
          : runs.map((run) => analysisRunRow(run, artifactsById)).join("");
    return `<section class="researchView analysisRunsView" data-research-destination="analysis-runs"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>${uiCopy("분석 실행", "Analysis runs")}</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      ${state.analysisRunsError ? `<div class="errorCopy" role="alert">${escapeHtml(uiCopy(`실행 기록을 불러오지 못했습니다. ${state.analysisRunsError}`, `Could not load run records. ${state.analysisRunsError}`))}</div>` : ""}
      ${loaded && runs.length ? `<div class="analysisRunsSummary"><span>${uiCopy("전체", "Total")} <strong>${escapeHtml(runs.length)}</strong></span><span>${uiCopy("성공", "Succeeded")} <strong>${escapeHtml(runs.filter((run) => run.status === "succeeded").length)}</strong></span><span>${uiCopy("실패·취소", "Failed or cancelled")} <strong>${escapeHtml(runs.filter((run) => run.status === "failed" || run.status === "cancelled").length)}</strong></span><span data-alert="${outputlessCount > 0}">${uiCopy("출력 없는 성공", "Succeeded without output")} <strong>${escapeHtml(outputlessCount)}</strong></span></div>` : ""}
      ${body}
    </div></section>`;
  }

  // Results & Figures is the manuscript's shopping list. A figure without a verified pixel capture
  // cannot be bound into a manuscript at all, so it is labelled as unusable rather than shown as a
  // ready result. Previews reuse the existing capture host, which calls science.artifacts.preview
  // and prints its own boundary when no capture exists -- never a stand-in image.
  const resultArtifactKindLabels = {
    "chart.vega": ["차트", "Chart"], "chart.numeric-3d": ["3D 수치 표면", "3D numeric surface"], "literature.citation-network": ["인용 네트워크", "Citation network"],
    "astronomy.sky-catalog": ["천체 카탈로그", "Sky catalog"], "genomics.variant-track": ["변이 트랙", "Variant track"], "phylogeny.radial": ["계통수", "Phylogeny"],
    "protein.structure": ["단백질 구조", "Protein structure"], "chemistry.document": ["화학 구조", "Chemical structure"], table: ["표", "Table"], image: ["게재용 래스터", "Publication raster"],
  };
  const resultArtifactKindLabel = (kind) => resultArtifactKindLabels[kind] ? uiCopy(...resultArtifactKindLabels[kind]) : kind;
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
    const verifiedProvenance = verified ? uiCopy(
      `${verified.validatorId} ${verified.validatorVersion} · 정책 ${verified.policyId} ${verified.policyVersion} · 캡처 ${runResultShortHash(verified.visualAssetSha256)}`,
      `${verified.validatorId} ${verified.validatorVersion} · policy ${verified.policyId} ${verified.policyVersion} · capture ${runResultShortHash(verified.visualAssetSha256)}`,
    ) : "";
    const validation = !lookup
      ? `<p class="resultArtifactValidation" data-result-validation="unchecked"><strong>검증 상태를 확인하지 않았습니다.</strong><span>${escapeHtml(`한 번에 조회하는 상한 ${RESULTS_VALIDATION_LOOKUP_LIMIT}개를 넘은 아티팩트입니다. 검증이 없다는 뜻이 아니라 묻지 않았다는 뜻입니다.`)}</span></p>`
      : lookup.error
        ? `<p class="resultArtifactValidation" data-result-validation="error" role="alert"><strong>검증 기록을 읽지 못했습니다.</strong><span>${escapeHtml(lookup.error)}</span></p>`
        : verified
          ? `<p class="resultArtifactValidation" data-result-validation="verified"><strong>게재 검증됨 — 원고에 연결할 수 있습니다.</strong><span>${escapeHtml(verifiedProvenance)}</span><code title="${escapeHtml(verified.receiptSha256)}">${escapeHtml(runResultShortHash(verified.receiptSha256))}</code></p>`
          : rejected
            ? `<p class="resultArtifactValidation" data-result-validation="rejected" role="alert"><strong>검증이 거부됐습니다 — 원고에 연결할 수 없습니다.</strong><span>${escapeHtml(warningLine(rejected) || "거부 사유가 영수증에 기록되지 않았습니다.")}</span></p>`
            : warned
              ? `<p class="resultArtifactValidation" data-result-validation="warning"><strong>경고와 함께 검증됐습니다 — 사람 검토 전에는 게재 준비된 결과가 아닙니다.</strong><span>${escapeHtml(warningLine(warned) || "경고 내용이 영수증에 기록되지 않았습니다.")}</span></p>`
              : `<p class="resultArtifactValidation" data-result-validation="none"><strong>원고에 연결할 수 없습니다.</strong><span>이 버전에는 검증된 시각 캡처가 없습니다. 정확한 픽셀 캡처와 검증 영수증이 남기 전까지 이 그림·표는 논문에 묶을 수 없습니다.</span></p>`;
    const preview = verified
      ? `<figure class="resultArtifactPreview" data-inline-capture-artifact="${escapeHtml(artifact.id)}" data-inline-capture-version="${escapeHtml(version)}" aria-label="${escapeHtml(`${artifact.title} v${version} 검증 캡처`)}">검증 캡처를 불러오는 중…</figure>`
      : `<p class="resultArtifactNoPreview">검증된 캡처가 없어 미리보기를 만들지 않았습니다.</p>`;
    const openAction = `<div class="resultArtifactActions"><button class="${verified ? "secondaryButton" : "primaryButton"}" type="button" data-action="open-result-artifact" data-result-artifact-id="${escapeHtml(artifact.id)}" data-result-artifact-version="${escapeHtml(version)}">${verified ? uiCopy("검증된 아티팩트 열기", "Open verified artifact") : uiCopy("아티팩트 열고 시각 검증 실행", "Open artifact and run visual verification")}${heroIcon("chevron-right")}</button>${verified ? "" : `<span>${uiCopy("실제 데이터 렌더러를 열어 캡처와 검증 영수증 생성을 시도합니다. 영수증이 남기 전에는 게재 검증됨으로 표시하지 않습니다.", "Opens the real-data renderer and attempts capture-based validation. It remains unverified until a receipt is recorded.")}</span>`}</div>`;
    return `<article class="resultArtifact" data-artifact-id="${escapeHtml(artifact.id)}" data-artifact-kind="${escapeHtml(artifact.kind)}" data-artifact-version="${escapeHtml(version)}" data-result-ready="${Boolean(verified)}">
      <header>
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(`${resultArtifactKindLabel(artifact.kind)}${state.resultFigureIds.has(artifact.id) ? uiCopy(" · 통계 Figure", " · Statistical figure") : ""}`)} · v${escapeHtml(version)}</span>
        <code title="${escapeHtml(contentSha256)}">${escapeHtml(runResultShortHash(contentSha256))}</code>
      </header>
      ${artifact.status === "failed" ? `<p class="resultArtifactFailed" role="alert">이 아티팩트는 failed 상태로 저장돼 있습니다. 내용을 신뢰할 수 없습니다.</p>` : ""}
      ${validation}
      ${preview}
      ${openAction}
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
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>결과와 그림</span></div>
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
    if (state.currentDestination === "manuscript") return manuscriptLandingView(project);
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
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · ${escapeHtml(destination.label)} · ${escapeHtml(lifecycleLabel())}</div>
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
        if (state.activeTurn?.status === "cancelled") {
          return `<strong>${uiCopy("이번 실행에서 완성된 연구 응답은 없습니다.", "This run produced no completed research response.")}</strong>${state.researchContract?.status === "draft" ? `<p>${uiCopy("연구 계약은 아직 승인 대기 중입니다. 위의 초안에서 목표와 중단 기준을 확인하세요.", "The research contract still awaits approval. Review its objective and stop criteria in the draft above.")}</p>` : ""}`;
        }
        if (state.researchContract?.status === "draft") {
          return `<strong><span class="stateGlyph" data-state="awaiting-human" aria-hidden="true"></span>이 연구는 아직 시작되지 않았습니다.</strong><p>${uiCopy("위의 초안에서 목표와 중단 기준을 확인하고 승인하세요. 이후 연구 채팅에 다음 작업을 요청할 수 있습니다.", "Review and approve the objective and stop criteria in the draft above. Then request the next step in the research chat.")}</p>`;
        }
        if (state.activeTurn && ["queued", "running", "cancelling"].includes(state.activeTurn.status)) {
          return `<strong><span class="stateGlyph" data-state="progress" aria-hidden="true"></span>연구 에이전트가 실행 중입니다.</strong><p>결과가 나오는 대로 답변 블록, 주장, 정확한 출처 인용이 이 기록에 추가됩니다.</p>`;
        }
        return `<strong>아직 생성된 연구 응답이 없습니다.</strong><p>첫 질문은 저장되었습니다. 연구 계약 승인과 Agent runtime 실행이 연결되면 답변 블록, 주장, 정확한 출처 인용이 이 기록에 추가됩니다.</p>`;
      })()}</div><div class="principledRefusal"><p>고정 답변이나 가짜 인용은 표시하지 않습니다.</p></div>` : ""}
    </div></section>`;
  }

  function manuscriptLandingView(project) {
    return `<section class="researchView manuscriptLandingView" data-research-destination="manuscript"><div class="answerColumn">
      <div class="researchKicker"><span>${escapeHtml(domainLabel(project.domain))}</span> · <span>${uiCopy("원고", "Manuscript")}</span></div>
      <h1>${escapeHtml(project.title)}</h1>
      <div class="emptyCopy pageEmpty manuscriptLandingEmpty">
        <strong>${uiCopy("아직 작성된 원고가 없습니다.", "No manuscript has been created yet.")}</strong>
        <p>${uiCopy("연구 결과와 검증된 그림·표가 준비되면 새 원고를 시작할 수 있습니다. 이 화면을 여는 것만으로 원고를 만들거나 연구 대화를 복사하지 않습니다.", "Start a manuscript when the research results and verified figures are ready. Opening this page does not create a draft or copy the research conversation.")}</p>
        <button class="primaryButton" data-action="new-manuscript">${uiCopy("새 원고 시작", "Start a new manuscript")}</button>
      </div>
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
    if (!raw && state.activeTurn?.status === "cancelled") {
      const retryFirst = state.messages.length === 1 && state.messages[0].role === "user";
      const nextAction = retryFirst
        ? uiCopy("화살표 버튼으로 저장된 첫 질문을 다시 실행할 수 있습니다.", "Use the arrow button to run your saved first question again.")
        : uiCopy("후속 질문을 보내면 새 실행을 시작할 수 있습니다.", "Send a follow-up to start a new run.");
      return `<div class="failClosed" data-run-state="cancelled" role="status"><strong>${uiCopy("연구 실행이 중단되었습니다", "Research run stopped")}</strong><p>${nextAction}</p></div>`;
    }
    if (!raw) return "";
    if (raw === "no-runtime") {
      return `<div class="failClosed" role="status"><strong>${uiCopy("연결된 AI 런타임이 없습니다", "No AI runtime is connected")}</strong><p>${uiCopy("질문은 저장됐지만 연구는 실행되지 않았습니다. Agentlas Work에서 AI 런타임을 연결한 뒤 이 프로젝트로 돌아와 다시 요청하세요.", "Your question is saved, but the research did not run. Connect an AI runtime in Agentlas Work, then return to this project and try again.")}</p><button class="secondaryButton" data-action="back-to-work">${uiCopy("Agentlas Work로 이동", "Open Agentlas Work")}</button></div>`;
    }
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
    const requestEpoch = ++manuscriptEditorRequestEpoch;
    const isCurrent = () => requestEpoch === manuscriptEditorRequestEpoch
      && state.selectedId === projectId
      && state.selectedManuscriptId === manuscriptId;
    const snapshot = await loadManuscriptEditorWorkspace(projectId, manuscriptId);
    if (!isCurrent()) {
      disposeManuscriptArtifactPreviews(snapshot.artifactPreviewUrls);
      return;
    }
    applyManuscriptEditorWorkspace(snapshot);
    try {
      await refreshProjectLibrarySummaries();
    } catch {
      if (!isCurrent()) return;
      state.projectLibrarySummaryState = "unavailable";
    }
    if (!isCurrent()) return;
    state.manuscriptNotice = notice;
    state.manuscriptInsertError = "";
    disposeManuscriptInsertion();
    render();
  }

  async function openManuscript(manuscriptId) {
    if (!state.selectedId || !manuscriptId) return;
    const projectId = state.selectedId;
    const requestEpoch = ++manuscriptEditorRequestEpoch;
    manuscriptSaveRequestEpoch += 1;
    state.manuscriptSaving = false;
    const isCurrentProject = () => requestEpoch === manuscriptEditorRequestEpoch && state.selectedId === projectId;
    const isCurrent = () => isCurrentProject() && state.selectedManuscriptId === manuscriptId;
    rememberScroll();
    try {
      const [manuscript, claimLedger, editorWorkspace] = await Promise.all([
        science.manuscripts.get(projectId, manuscriptId),
        science.claimLedgers.getForManuscript(projectId, manuscriptId),
        loadManuscriptEditorWorkspace(projectId, manuscriptId),
      ]);
      if (!isCurrentProject()) return;
      if (!manuscript || manuscript.projectId !== projectId) throw new Error("science-manuscript-not-found");
      ensureManuscriptWorkspaceTab(manuscript);
      state.selectedManuscriptId = manuscript.id;
      applyManuscriptEditorWorkspace(editorWorkspace);
      state.claimLedger = claimLedger;
      const submissionExports = await science.submissions.list(projectId, manuscript.id);
      if (!isCurrent()) return;
      restoreSubmissionExportState(manuscript, claimLedger, submissionExports);
      try {
        await refreshProjectLibrarySummaries();
      } catch {
        if (!isCurrent()) return;
        state.projectLibrarySummaryState = "unavailable";
      }
      if (!isCurrent()) return;
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
      if (!isCurrentProject()) return;
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

  function manuscriptPreview(markdown, inline = inlineManuscriptMarkdown) {
    const rows = String(markdown || "").split(/\r?\n/);
    const output = [];
    let paragraph = [];
    let list = [];
    let code = [];
    let inCode = false;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) return;
      output.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
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
        output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
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
        output.push(`<blockquote>${inline(row.trim().slice(2))}</blockquote>`);
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

  // TABLE_PAYLOAD_ADAPTER_START
  function actualTablePayload(versionOrPayload) {
    const version = versionOrPayload?.payload ? versionOrPayload : null;
    const payload = version ? version.payload : versionOrPayload;
    const failure = (cause) => ({ payload: null, cause, sourceShape: null, contentSha256: "" });
    if (!payload || payload.schema !== "agentlas.science-table/v1") return failure("science-data-table-schema-invalid");
    if (!Array.isArray(payload.columns) || !payload.columns.length || !Array.isArray(payload.rows)) return failure("science-data-table-shape-invalid");

    const domainShape = payload.columns.some((column) => column?.id !== undefined) || payload.rows.some(Array.isArray);
    if (domainShape) {
      if (!payload.rows.length || payload.columns.length > 64 || payload.rows.length > 1_000 || payload.columns.length * payload.rows.length > 20_000) {
        return failure("science-data-table-domain-limit-invalid");
      }
      const columns = [];
      const ids = new Set();
      for (const declared of payload.columns) {
        const name = typeof declared?.id === "string" ? declared.id.trim() : "";
        const label = typeof declared?.label === "string" ? declared.label.trim() : name;
        const logicalType = String(declared?.type ?? "string").toLowerCase();
        const unit = declared?.unit === null || declared?.unit === undefined || declared?.unit === "" ? null
          : typeof declared.unit === "string" ? declared.unit.trim() : null;
        const key = name.toLocaleLowerCase("en-US");
        if (!name || !label || /[\u0000-\u001f\u007f]/u.test(name + label) || ids.has(key)
          || !["integer", "number", "boolean", "string"].includes(logicalType)
          || (declared?.unit !== null && declared?.unit !== undefined && declared?.unit !== "" && !unit)) {
          return failure("science-data-table-domain-column-invalid");
        }
        ids.add(key);
        columns.push({ name, label, logicalType, nullable: false, unit });
      }
      const rows = [];
      let nullCount = 0;
      let formulaLikeCellCount = 0;
      for (const sourceRow of payload.rows) {
        if (!Array.isArray(sourceRow) || sourceRow.length !== columns.length) return failure("science-data-table-domain-row-invalid");
        const row = {};
        for (let index = 0; index < columns.length; index += 1) {
          const column = columns[index];
          const value = sourceRow[index];
          if (value === null || value === undefined) {
            column.nullable = true;
            row[column.name] = null;
            nullCount += 1;
          } else if ((column.logicalType === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value)))
            || (column.logicalType === "number" && (typeof value !== "number" || !Number.isFinite(value)))
            || (column.logicalType === "boolean" && typeof value !== "boolean")
            || (column.logicalType === "string" && (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)))) {
            return failure("science-data-table-domain-cell-invalid");
          } else {
            row[column.name] = value;
            if (typeof value === "string" && /^[\s]*[=+@-]/u.test(value)) formulaLikeCellCount += 1;
          }
        }
        rows.push(row);
      }
      return {
        payload: {
          schema: payload.schema,
          title: typeof payload.title === "string" ? payload.title : "",
          columns,
          rows,
          notes: Array.isArray(payload.notes) ? payload.notes.filter((note) => typeof note === "string") : [],
          profile: { rowCount: rows.length, columnCount: columns.length, nullCount, formulaLikeCellCount },
          receipts: null,
        },
        cause: null,
        sourceShape: "domain-publication-table",
        contentSha256: typeof version?.contentSha256 === "string" ? version.contentSha256 : "",
      };
    }

    if (!payload.profile || payload.profile.rowCount !== payload.rows.length || payload.profile.columnCount !== payload.columns.length
      || !Number.isSafeInteger(payload.profile.nullCount) || payload.profile.nullCount < 0
      || !Number.isSafeInteger(payload.profile.formulaLikeCellCount) || payload.profile.formulaLikeCellCount < 0
      || payload.columns.some((column) => !column || typeof column.name !== "string" || !column.name
        || !["integer", "number", "boolean", "string"].includes(column.logicalType))
      || payload.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      return failure("science-data-table-dataset-shape-invalid");
    }
    return {
      payload,
      cause: null,
      sourceShape: "dataset-table",
      contentSha256: typeof version?.contentSha256 === "string" ? version.contentSha256 : "",
    };
  }
  // TABLE_PAYLOAD_ADAPTER_END

  function manuscriptTablePreviewMarkup(payload, { compact = false } = {}) {
    const actual = actualTablePayload(payload);
    if (!actual.payload) {
      return `<div class="manuscriptTableUnavailable" data-table-payload-cause="${escapeHtml(actual.cause)}">Validated table data is unavailable.</div>`;
    }
    payload = actual.payload;
    const columns = payload.columns.slice(0, compact ? 4 : 6);
    const rows = payload.rows.slice(0, compact ? 3 : 5);
    const header = columns.map((column) => `<th>${escapeHtml(column.label || column.name || column.key || "Column")}</th>`).join("");
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

  /**
   * Table and figure numbers, in document order.
   *
   * A manuscript refers to "Table 2" in its text, so the float has to carry the same number the
   * prose does, and the number depends on everything before it. Tables and figures are counted
   * separately, the way every journal does it.
   */
  /**
   * The one control a block shows, and only while the pointer is on it.
   *
   * The reading view has to look like a paper, so a block carries no border, no badge and no
   * toolbar at rest -- it is indistinguishable from the prose around it. On hover the block lifts
   * slightly and this button appears in its top-right corner. Provenance that used to sit in the
   * printed flow (the source artifact and its exact version) moves into the button's title, where
   * the person editing can still reach it and the reader never sees it.
   */
  function manuscriptBlockAffordanceMarkup(node) {
    if (state.manuscriptView === "preview") return "";
    const provenance = manuscriptBlockProvenanceText(node);
    return `<div class="manuscriptBlockAffordance" contenteditable="false" aria-hidden="false">
      <button type="button" class="manuscriptBlockAction" data-action="open-manuscript-block-menu"
        data-node-id="${escapeHtml(node.id)}"
        title="${escapeHtml(provenance || "블록 동작")}"
        aria-label="블록 동작">${heroIcon("ellipsis")}</button>
    </div>`;
  }

  /** Source artifact and exact version for a bound float, or null for ordinary prose. */
  function manuscriptBlockProvenanceText(node) {
    if (!node || !node.locator) return null;
    const binding = manuscriptBindingForLocator(node.locator);
    const context = binding ? state.manuscriptArtifactContexts.get(binding.target.artifactId) : null;
    if (!context) return null;
    const version = context.selectedVersion;
    return version
      ? `${context.artifact?.title || node.locator} · exact v${version.version}`
      : `${context.artifact?.title || node.locator} · binding unavailable`;
  }

  function manuscriptFloatOrdinals(nodes) {
    const ordinals = new Map();
    let tables = 0;
    let figures = 0;
    for (const node of nodes || []) {
      if (node.kind === "table") ordinals.set(node.id, { label: "Table", number: (tables += 1) });
      else if (node.kind === "figure") ordinals.set(node.id, { label: "Figure", number: (figures += 1) });
    }
    return ordinals;
  }

  /**
   * A table as a journal prints one: numbered caption above the rule, then the table. No card, no
   * header bar, no badge.
   *
   * The provenance the header bar used to show (source artifact and exact version) still matters,
   * but it is apparatus, not manuscript: it belongs to the person editing, not to the page a
   * reviewer reads. It moves to the block's hover affordance, so the reading view is the paper.
   */
  function manuscriptArtifactTableMarkup(node, ordinal) {
    const binding = manuscriptBindingForLocator(node.locator);
    const context = binding ? state.manuscriptArtifactContexts.get(binding.target.artifactId) : null;
    const version = context?.selectedVersion;
    const caption = node.caption || context?.artifact?.version?.semantic?.summary || "Validated project table";
    return `<figure class="manuscriptEmbeddedTable" data-manuscript-artifact-table data-locator="${escapeHtml(node.locator)}">
      <figcaption class="manuscriptFloatCaption manuscriptFloatCaptionTop">${manuscriptFloatLabelMarkup(ordinal, "Table")}${escapeHtml(caption)}</figcaption>
      ${manuscriptTablePreviewMarkup(paleontologyPublicationTablePayload(version) || statisticsAnalysisTablePublicationPayload(version, node.locator) || version?.payload)}
    </figure>`;
  }

  /** `Table 2.` in the caption's own run, bold, exactly as a journal sets it. */
  function manuscriptFloatLabelMarkup(ordinal, fallbackLabel) {
    const label = ordinal?.label || fallbackLabel;
    return `<strong>${escapeHtml(label)}${ordinal ? ` ${escapeHtml(ordinal.number)}` : ""}.</strong> `;
  }

  /** A figure as a journal prints one: the image, then a numbered caption below it. */
  function manuscriptArtifactFigureMarkup(node, ordinal) {
    const binding = manuscriptBindingForLocator(node.locator);
    const context = binding ? state.manuscriptArtifactContexts.get(binding.target.artifactId) : null;
    const previewUrl = binding ? state.manuscriptArtifactPreviewUrls.get(binding.target.artifactId) : null;
    const caption = node.caption || context?.selectedVersion?.semantic?.summary || context?.artifact?.title || node.locator;
    return `<figure class="manuscriptEmbeddedFigure" data-manuscript-artifact-figure data-locator="${escapeHtml(node.locator)}">
      ${previewUrl ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(context?.artifact?.title || node.locator)}">` : `<div class="manuscriptEmbeddedFigureMissing">${heroIcon("photo")}<span>Verified figure preview unavailable</span></div>`}
      <figcaption class="manuscriptFloatCaption">${manuscriptFloatLabelMarkup(ordinal, "Figure")}${escapeHtml(caption)}</figcaption>
    </figure>`;
  }

  function manuscriptNodeMarkup(node, ordinal) {
    const identity = `data-manuscript-node-id="${escapeHtml(node.id)}" data-node-kind="${escapeHtml(node.kind)}" data-node-revision="${escapeHtml(node.revision)}" data-node-content-sha256="${escapeHtml(node.contentSha256)}"`;
    if (node.kind === "heading") {
      const level = Math.max(2, Math.min(4, Number(node.level) + 1));
      return `<section class="manuscriptBlock manuscriptHeadingBlock" ${identity}><h${level}>${escapeHtml(node.text)}</h${level}>${manuscriptBlockAffordanceMarkup(node)}</section>`;
    }
    if (node.kind === "paragraph") return `<section class="manuscriptBlock manuscriptParagraphBlock" ${identity}><p>${escapeHtml(node.markdown)}</p>${manuscriptBlockAffordanceMarkup(node)}</section>`;
    if (node.kind === "equation") return `<section class="manuscriptBlock manuscriptEquationBlock" ${identity}><pre>${escapeHtml(node.tex)}</pre>${node.label ? `<span>${escapeHtml(node.label)}</span>` : ""}${manuscriptBlockAffordanceMarkup(node)}</section>`;
    if (node.kind === "figure") return `<section class="manuscriptBlock manuscriptFigureBlock" ${identity}>${manuscriptArtifactFigureMarkup(node, ordinal)}${manuscriptBlockAffordanceMarkup(node)}</section>`;
    if (node.kind === "table" && node.mode === "artifact") return `<section class="manuscriptBlock manuscriptTableBlock" ${identity}>${manuscriptArtifactTableMarkup(node, ordinal)}${manuscriptBlockAffordanceMarkup(node)}</section>`;
    if (node.kind === "table") {
      const payload = { schema: "agentlas.science-table/v1", columns: node.header.map((name) => ({ name })), rows: node.rows.map((row) => Object.fromEntries(node.header.map((name, index) => [name, row[index]]))), profile: { rowCount: node.rows.length, columnCount: node.header.length } };
      return `<section class="manuscriptBlock manuscriptTableBlock" ${identity}><figure class="manuscriptEmbeddedTable"><figcaption class="manuscriptFloatCaption manuscriptFloatCaptionTop">${manuscriptFloatLabelMarkup(ordinal, "Table")}${escapeHtml(node.caption || "Inline table")}</figcaption>${manuscriptTablePreviewMarkup(payload)}</figure>${manuscriptBlockAffordanceMarkup(node)}</section>`;
    }
    if (node.kind === "list") {
      const tag = node.ordered ? "ol" : "ul";
      return `<section class="manuscriptBlock manuscriptListBlock" ${identity}><${tag}>${node.items.map((item) => `<li>${escapeHtml(item.nodes.map(manuscriptNodeSelectionText).join(" "))}</li>`).join("")}</${tag}>${manuscriptBlockAffordanceMarkup(node)}</section>`;
    }
    if (node.kind === "blockquote") return `<section class="manuscriptBlock manuscriptQuoteBlock" ${identity}><blockquote>${escapeHtml(manuscriptNodeSelectionText(node))}</blockquote>${manuscriptBlockAffordanceMarkup(node)}</section>`;
    if (node.kind === "code") return `<section class="manuscriptBlock manuscriptCodeBlock" ${identity}><pre><code>${escapeHtml(node.text)}</code></pre>${manuscriptBlockAffordanceMarkup(node)}</section>`;
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
      <header class="manuscriptDocumentTitle"><span>Research article · draft v${escapeHtml(manuscript.currentVersion)}</span><h1>${escapeHtml(manuscript.title)}</h1></header>
      <div class="manuscriptBlocks">${manuscriptInsertSlotMarkup(null)}${(() => {
        // Journals number tables and figures in the order they appear, and the caption carries
        // that number. Computed here, once per render, because a node cannot know its own ordinal.
        const ordinals = manuscriptFloatOrdinals(document.nodes);
        return document.nodes.map((node) => `${manuscriptNodeMarkup(node, ordinals.get(node.id) || null)}${manuscriptInsertSlotMarkup(node)}`).join("");
      })()}</div>
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

  /**
   * The block menu. Opened from the hover control, closed by the next click anywhere else.
   *
   * Deliberately a plain DOM popover rather than a rendered state branch: the manuscript re-renders
   * on every editor refresh, and a menu that lives in that state would blink shut under the pointer
   * whenever a background refresh landed.
   */
  function openManuscriptBlockMenu(button) {
    closeManuscriptBlockMenu();
    const nodeId = button?.dataset?.nodeId;
    const block = button?.closest?.("[data-manuscript-node-id]");
    const canvas = document.querySelector(".manuscriptCanvas");
    if (!nodeId || !block || !canvas) return;
    const node = state.manuscriptEditorModel?.document?.nodes?.find((item) => item.id === nodeId);
    if (!node) return;
    const provenance = manuscriptBlockProvenanceText(node);
    const menu = document.createElement("div");
    menu.className = "manuscriptBlockMenu";
    menu.dataset.manuscriptBlockMenu = "";
    menu.setAttribute("role", "menu");
    menu.innerHTML = `${provenance ? `<p class="manuscriptBlockMenuMeta">${escapeHtml(provenance)}</p>` : ""}
      ${node.locator ? `<button type="button" role="menuitem" data-action="preview-manuscript-artifact" data-locator="${escapeHtml(node.locator)}">출처 아티팩트 열기</button>` : ""}
      <button type="button" role="menuitem" class="manuscriptBlockMenuDanger" data-action="delete-manuscript-block" data-node-id="${escapeHtml(nodeId)}">이 블록 삭제</button>`;
    const blockRect = block.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    menu.style.top = `${blockRect.top - canvasRect.top + canvas.scrollTop + 30}px`;
    menu.style.right = `${Math.max(8, canvasRect.right - blockRect.right + 6)}px`;
    canvas.append(menu);
    menu.querySelector("button")?.focus();
  }

  function closeManuscriptBlockMenu() {
    document.querySelector("[data-manuscript-block-menu]")?.remove();
  }

  /**
   * Deletes one block as an immutable transaction.
   *
   * Every expectation the store checks is sent from what is on screen right now -- manuscript
   * version, content hash, document hash, and the node's own revision and hash. A delete that
   * guessed any of them could remove a block the person never saw.
   */
  async function deleteManuscriptBlock(nodeId) {
    const editorModel = state.manuscriptEditorModel;
    const manuscript = editorModel?.manuscript;
    const document_ = editorModel?.document;
    const node = document_?.nodes?.find((item) => item.id === nodeId);
    if (!nodeId || !node || !state.selectedId || !manuscript || !document_ || state.manuscriptTransactionBusy) return;
    closeManuscriptBlockMenu();
    state.manuscriptTransactionBusy = true;
    render();
    try {
      const result = await science.manuscripts.applyTransaction({
        requestId: crypto.randomUUID(),
        projectId: state.selectedId,
        manuscriptId: manuscript.id,
        expectedVersion: manuscript.currentVersion,
        expectedContentSha256: manuscript.version.contentSha256,
        expectedDocumentSha256: document_.documentSha256,
        actor: "user",
        reason: "Delete one manuscript block from the block menu",
        operations: [{
          kind: "delete-node",
          nodeId,
          expectedRevision: node.revision,
          expectedContentSha256: node.contentSha256,
        }],
      });
      state.claimLedger = await science.claimLedgers.getForManuscript(state.selectedId, manuscript.id);
      await refreshManuscriptEditorWorkspace(`Block deleted as immutable v${result.manuscript.currentVersion}`);
    } catch (error) {
      state.manuscriptNotice = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.manuscriptTransactionBusy = false;
      render();
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
    const projectId = state.selectedId;
    const manuscriptId = state.selectedManuscriptId;
    const manuscript = manuscriptById(manuscriptId);
    const draft = state.manuscriptDraft;
    if (!projectId || !manuscript || !draft || !draft.dirty || state.manuscriptSaving) return;
    const requestEpoch = ++manuscriptSaveRequestEpoch;
    const isCurrent = () => requestEpoch === manuscriptSaveRequestEpoch
      && state.selectedId === projectId
      && state.selectedManuscriptId === manuscriptId
      && state.mode === "manuscript";
    state.manuscriptSaving = true;
    state.manuscriptSaveError = "";
    render();
    let saved;
    try {
      const result = await science.manuscripts.appendVersion({
        requestId: crypto.randomUUID(),
        projectId,
        manuscriptId: manuscript.id,
        expectedVersion: draft.baseVersion,
        expectedContentSha256: draft.baseContentSha256,
        markdown: draft.markdown,
        bindings: draft.bindings,
      });
      saved = result.manuscript;
    } catch (error) {
      if (!isCurrent()) return;
      state.manuscriptSaving = false;
      state.manuscriptSaveError = error instanceof Error ? error.message : String(error);
      render();
      return;
    }
    if (!isCurrent()) return;
    state.manuscripts = [saved, ...state.manuscripts.filter((item) => item.id !== saved.id)];
    state.manuscriptDraft = manuscriptDraftFrom(saved);
    state.claimLedger = null;
    let claimLedger = null;
    try { claimLedger = await science.claimLedgers.getForManuscript(projectId, saved.id); }
    catch { claimLedger = null; }
    if (!isCurrent()) return;
    state.claimLedger = claimLedger;
    state.manuscriptSaving = false;
    ensureManuscriptWorkspaceTab(saved);
    // Reload the immutable document model after a source save. The block
    // editor, outline, checks, and artifact bindings must all point at the
    // same version/hash as the source textarea that was just persisted.
    try {
      await refreshManuscriptEditorWorkspace(`Saved as immutable v${saved.currentVersion}`);
    } catch (error) {
      if (!isCurrent()) return;
      state.manuscriptSaveError = `Saved immutable v${saved.currentVersion}, but the editor could not refresh: ${error instanceof Error ? error.message : String(error)}`;
      try {
        await refreshProjectLibrarySummaries();
      } catch {
        if (state.selectedId === projectId) state.projectLibrarySummaryState = "unavailable";
      }
      render();
    }
    if (isCurrent()) void queueWorkspacePersistence();
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

  async function openLab(labId, artifactId, originVersion = null, returnMessageId = null, exactVersion = null, preferredContext = null) {
    rememberScroll();
    state.labDecisionActionError = "";
    // Lab context is a snapshot. Acquisition can materialize an artifact after that snapshot was
    // loaded, so refresh before deciding the Lab is empty or an explicit result is missing.
    const projectId = state.selectedId;
    if (projectId) {
      try {
        const latestContexts = await science.artifacts.forLab(projectId, labId);
        if (projectId !== state.selectedId) return;
        if (Array.isArray(latestContexts)) {
          // A result card resolves an exact artifact version before opening its Lab. forLab can
          // legitimately omit that artifact when the Lab repository has not indexed it yet; do
          // not discard the exact context we just verified while refreshing the surrounding list.
          state.labContextsById.set(labId, mergePreferredLabContext(latestContexts, preferredContext, projectId, labId));
        }
      } catch {
        // Keep the last verified snapshot. An explicit result open still resolves its exact
        // project/Lab context first and fails closed rather than inventing a route.
      }
    }
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

  async function openResultArtifact(artifactId, artifactVersion) {
    const projectId = state.selectedId;
    if (!projectId || !artifactId || !Number.isSafeInteger(artifactVersion) || artifactVersion < 1) return;
    try {
      const context = await science.artifacts.context(projectId, artifactId, artifactVersion);
      if (projectId !== state.selectedId) return;
      if (!context || context.artifact?.id !== artifactId || context.selectedVersion?.version !== artifactVersion
        || context.artifact?.projectId !== projectId || !context.linkage?.labId) {
        throw new Error("science-result-artifact-context-invalid");
      }
      const known = state.labContextsById.get(context.linkage.labId) || [];
      state.labContextsById.set(context.linkage.labId, [context, ...known.filter((item) => item?.artifact?.id !== artifactId)]);
      await openLab(context.linkage.labId, artifactId, null, null, artifactVersion, context);
    } catch (error) {
      state.resultsError = error instanceof Error ? error.message : String(error);
      render();
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
    invalidateManuscriptRequests();
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
    state.manuscriptSaving = false;
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
    invalidateManuscriptRequests();
    composerRequestEpoch += 1;
    state.composerSending = false;
    state.selectedConversationId = conversation.id;
    state.chatMessagesScope = null;
    state.activeTurn = null;
    state.composerError = "";
    state.researchLoopActionBusy = false;
    state.researchLoopActionError = "";
    runtimeSelectionRequestEpoch += 1;
    state.runtimeSelection = null;
    state.runtimeOptions = [];
    state.runtimeUnavailable = false;
    state.runtimeSelectionLoading = false;
    state.runtimeSelectionBusy = false;
    state.runtimeSelectionError = "";
    state.runtimeSelectionScope = null;
    state.runtimePickerOpen = false;
    state.runtimePickerQuery = "";
    state.mode = "session";
    state.manuscriptSaving = false;
    state.currentDestination = "overview";
    const tab = state.workspaceTabs.find((item) => item.kind === "conversation" && item.conversationId === conversation.id);
    state.activeWorkspaceTabId = tab?.id || RESEARCH_TAB_ID;
    state.drawer = null;
    state.projectError = "";
    render();
    try {
      await refreshConversationOnly(state.selectedId, { refreshRuntimeSelection: true });
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
        rememberScroll();
        state.mode = "session";
        state.currentDestination = destination;
        state.activeWorkspaceTabId = RESEARCH_TAB_ID;
        state.drawer = null;
        state.manuscriptModal = false;
        state.manuscriptInspectorOpen = false;
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
      const closeTitle = uiCopy("탭 닫기", "Close tab");
      if (tab.kind === "manuscript") return `<span class="workspaceTabFrame workspaceManuscriptTab" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" data-manuscript-id="${escapeHtml(tab.manuscriptId)}" title="${escapeHtml(`${tab.title} · manuscript v${tab.exactVersion}`)}">${heroIcon("book", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span><span class="workspaceTabVersion">v${escapeHtml(tab.exactVersion)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(uiCopy(`${tab.title} 원고 탭 닫기`, `Close ${tab.title} manuscript tab`))}" title="${closeTitle}">×</button></span>`;
      if (tab.kind === "conversation") return `<span class="workspaceTabFrame workspaceConversationTab" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(tab.title)}">${heroIcon("book", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(uiCopy(`${tab.title} 대화 탭 닫기`, `Close ${tab.title} conversation tab`))}" title="${closeTitle}">×</button></span>`;
      if (tab.kind === "lab") return `<span class="workspaceTabFrame" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(uiCopy(`${tab.title} Lab 시작 화면`, `${tab.title} Lab start screen`))}">${heroIcon(labIcons[tab.labId] || "grid", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(uiCopy(`${tab.title} Lab 탭 닫기`, `Close ${tab.title} Lab tab`))}" title="${closeTitle}">×</button></span>`;
      return `<span class="workspaceTabFrame" role="presentation" data-selected="${selected}"><button class="workspaceTab" role="tab" ${tabA11y} data-workspace-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(`${labLabel(tab.labId)} · ${tab.title} · exact v${tab.exactVersion}`)}">${heroIcon(labIcons[tab.labId] || "grid", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(tab.title)}</span><span class="workspaceTabVersion">v${escapeHtml(tab.exactVersion)}</span></button><button class="workspaceTabClose" data-close-workspace-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(uiCopy(`${tab.title} v${tab.exactVersion} 탭 닫기`, `Close ${tab.title} v${tab.exactVersion} tab`))}" title="${closeTitle}">×</button></span>`;
    }).join("");
  }

  function researchWorkspaceTabButton() {
    const selected = state.activeWorkspaceTabId === RESEARCH_TAB_ID;
    const label = state.mode === "session" ? projectDestinationById(state.currentDestination)?.label || "Research" : "Research";
    return `<button class="workspaceTab workspaceResearchTab" role="tab" id="${workspaceTabDomId(RESEARCH_TAB_ID)}" aria-controls="science-workspace-panel" data-workspace-tab-id="${RESEARCH_TAB_ID}" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}">${heroIcon("book", "workspaceTabIcon")}<span class="workspaceTabLabel">${escapeHtml(label)}</span></button>`;
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
    const capability = inspectingHistory
      ? uiCopy(`기록 v${escapeHtml(state.inspectedArtifactVersion)} · 읽기 전용`, `History v${escapeHtml(state.inspectedArtifactVersion)} · read only`)
      : artifact.version.rendererId === "agentlas.ketcher"
        ? uiCopy(`현재 v${escapeHtml(artifact.currentVersion)} · 편집 가능`, `Current v${escapeHtml(artifact.currentVersion)} · editable`)
        : artifact.version.rendererId === "agentlas.molstar"
          ? uiCopy(`현재 v${escapeHtml(artifact.currentVersion)} · 표현 편집 가능`, `Current v${escapeHtml(artifact.currentVersion)} · representation editable`)
          : artifact.version.rendererId === "agentlas.vega" && vegaDraft
            ? (vegaDraft.dirty
              ? uiCopy(`현재 v${escapeHtml(artifact.currentVersion)} 기반 · 초안`, `Draft based on current v${escapeHtml(artifact.currentVersion)}`)
              : uiCopy(`현재 v${escapeHtml(artifact.currentVersion)} · 편집 가능`, `Current v${escapeHtml(artifact.currentVersion)} · editable`))
            : uiCopy(`현재 v${escapeHtml(artifact.currentVersion)} · 대화형 보기`, `Current v${escapeHtml(artifact.currentVersion)} · interactive view`);
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
    const originStrip = `<section class="originStrip"><div class="originStripMain"><strong>${escapeHtml(selectedLabTitle)}</strong><span>${escapeHtml(capability)}</span></div><div class="originStripActions"><button data-action="toggle-history" aria-expanded="${state.historyOpen}">${escapeHtml(uiCopy(`버전 ${artifact.currentVersion}`, `Version ${artifact.currentVersion}`))}</button>${originVersion ? `<button data-artifact-history-version="${escapeHtml(originVersion)}">${escapeHtml(uiCopy(`응답 원본 v${originVersion}`, `Response source v${originVersion}`))}</button>` : ""}<button data-action="toggle-drawer">${escapeHtml(uiCopy("세부 정보", "Details"))}</button>${state.selectedLabId === "statistics-analysis" ? `<button data-action="open-statistics-launch">${escapeHtml(uiCopy("새 분석", "New analysis"))}</button>` : ""}</div><details class="provenanceDisclosure originProvenance"><summary>${escapeHtml(uiCopy("출처와 버전", "Source and version"))}</summary><div class="provenanceTrail">${provenanceSteps.map((step) => `<span>${escapeHtml(step)}</span>`).join('<i aria-hidden="true">→</i>')}<em>${escapeHtml(capability)}</em></div></details></section>`;
    const paleontologyLineage = paleontologyPayload ? `<details class="statisticsLineage provenanceDisclosure" data-paleontology-lineage data-catalog-run-id="${escapeHtml(paleontologyPayload.source.parentRunId)}" data-analysis-run-id="${escapeHtml(paleontologyPayload.source.analysisRunId)}" data-analysis-sha256="${escapeHtml(paleontologyPayload.analysis.analysisSha256)}"><summary><strong>${escapeHtml(uiCopy("근거 연결", "Evidence chain"))}</strong><span>${escapeHtml(paleontologyPayload.analysis.source.taxonName)} · ${escapeHtml(paleontologyPayload.analysis.estimates.occurrenceCount)} exact rows</span></summary><div class="provenanceTrail"><span>${escapeHtml(PALEONTOLOGY_BOUNDARY)}</span><i aria-hidden="true">→</i><span>${escapeHtml(paleontologyPayload.analysis.estimates.occurrenceCount)} exact rows · ${escapeHtml(paleontologyPayload.analysis.estimates.oldestBoundMa)}–${escapeHtml(paleontologyPayload.analysis.estimates.youngestBoundMa)} Ma</span><i aria-hidden="true">→</i><span>${paleontologyPayload.analysis.source.parentTruncated ? "Bounded retrieval · descriptive counts" : "Complete retrieved set"}</span></div></details>` : "";
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
    const skyDistanceCount = Array.isArray(skyCatalog?.objects) ? skyCatalog.objects.filter((object) => typeof object.parallaxMas === "number" && Number.isFinite(object.parallaxMas) && object.parallaxMas > 0).length : 0;
    const skyView = state.spatialViewByArtifact.get(artifact.id) === "astronomy-distance" && skyDistanceCount ? "astronomy-distance" : "astronomy-sky";
    const skyToolbar = artifact.version.rendererId === "agentlas.d3-sky" ? `<div class="skyCatalogToolbar"><div><span class="scientificViewModes" role="group" aria-label="천체 보기"><button data-spatial-view="astronomy-sky" aria-pressed="${skyView === "astronomy-sky"}">Sky 2D</button><button data-spatial-view="astronomy-distance" aria-pressed="${skyView === "astronomy-distance"}" ${skyDistanceCount ? "" : "disabled"}>Distance 3D · ${escapeHtml(skyDistanceCount)}</button></span>${skyView === "astronomy-distance" ? "" : `<button data-sky-action="reset">시야 초기화</button><label><span>천체 유형</span><select data-sky-type-filter><option value="">모든 유형 · ${escapeHtml(Array.isArray(skyCatalog?.objects) ? skyCatalog.objects.length : 0)}</option>${skyTypeOptions}</select></label>`}<span class="skyCoordinateConvention">${skyView === "astronomy-distance" ? "양의 parallax만 1000/parallax로 변환 · 오차모형 미적용" : "ICRS · RA는 천구 관례에 따라 반전"}</span></div>${skyView === "astronomy-distance" ? "" : `<div class="skyObjectDetail" data-sky-object-detail><strong>천체를 선택하세요</strong><span>SIMBAD 식별자·좌표·관측값을 원본 필드 그대로 표시합니다.</span></div>`}</div>` : "";
    const earthquakeCatalog = artifact.version.payload?.catalog?.provider === "usgs-fdsn-event" ? artifact.version.payload.catalog : null;
    const earthquake3dCount = Array.isArray(earthquakeCatalog?.events) ? earthquakeCatalog.events.filter((event) =>
      typeof event.longitude === "number" && Number.isFinite(event.longitude)
      && typeof event.latitude === "number" && Number.isFinite(event.latitude)
      && typeof event.depthKm === "number" && Number.isFinite(event.depthKm)).length : 0;
    const earthquakeView = state.spatialViewByArtifact.get(artifact.id) === "earthquake-depth" && earthquake3dCount ? "earthquake-depth" : "earthquake-map";
    const earthquakeToolbar = earthquakeCatalog ? `<div class="scientificViewToolbar earthquakeViewToolbar"><div class="scientificViewModes" role="group" aria-label="${escapeHtml(uiCopy("지진 보기", "Earthquake view"))}"><button data-spatial-view="earthquake-map" aria-pressed="${earthquakeView === "earthquake-map"}">Map 2D</button><button data-spatial-view="earthquake-depth" aria-pressed="${earthquakeView === "earthquake-depth"}" ${earthquake3dCount ? "" : "disabled"}>Depth 3D · ${escapeHtml(earthquake3dCount)}</button></div><span>${escapeHtml(earthquakeProjectionCopy())}</span></div>` : "";
    const genomicsPayload = artifact.version.payload;
    const genomicsToolbar = artifact.version.rendererId === "agentlas.jbrowse" ? `<div class="genomicsToolbar"><div><span>ASSEMBLY</span><strong>${escapeHtml(genomicsPayload?.assembly?.name || "")}</strong></div><div><span>REGION</span><strong>${escapeHtml(genomicsPayload?.region?.refName || "")}:${escapeHtml(genomicsPayload?.region?.start || "")}–${escapeHtml(genomicsPayload?.region?.end || "")}</strong></div><div><span>VARIANTS</span><strong>${escapeHtml(Array.isArray(genomicsPayload?.variants) ? genomicsPayload.variants.length : 0)} · ClinVar</strong></div><p>${escapeHtml(uiCopy("Pan · zoom · feature click은 JBrowse 2 세션에서 직접 조작됩니다.", "Pan, zoom, and feature click are driven directly in the JBrowse 2 session."))}</p></div>` : "";
    const statisticsFigureToolbar = statisticsFigurePayload ? `<section class="statisticsFigureToolbar" data-statistics-figure-toolbar><div class="statisticsFigureIdentity"><span>PUBLICATION FIGURE · EXACT BINDING</span><strong>${escapeHtml(statisticsFigurePayload.visualization.title)}</strong><code title="${escapeHtml(statisticsFigurePayload.statisticsArtifact.contentSha256)}">analysis v${escapeHtml(statisticsFigurePayload.statisticsArtifact.artifactVersion)} · ${escapeHtml(String(statisticsFigurePayload.statisticsArtifact.contentSha256).slice(0, 12))}…</code></div><dl class="statisticsFigureSpecs"><div><dt>${escapeHtml(uiCopy("단 폭", "Column"))}</dt><dd>${escapeHtml(uiCopy("1단 89 mm · 2단 183 mm", "1 column 89 mm · 2 columns 183 mm"))}</dd></div><div><dt>${escapeHtml(uiCopy("글자", "Type"))}</dt><dd>${escapeHtml(uiCopy("최종 크기에서 8–12 pt", "8–12 pt at final size"))}</dd></div><div><dt>${escapeHtml(uiCopy("색", "Color"))}</dt><dd>${escapeHtml(uiCopy("sRGB · 흑백 확인됨", "sRGB · grayscale checked"))}</dd></div></dl><div class="statisticsFigureExport"><div><button type="button" data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>${escapeHtml(uiCopy("버전 비교", "Compare versions"))}</button><button type="button" data-action="export-statistics-figure-svg" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? escapeHtml(uiCopy("생성 중…", "Generating…")) : "SVG"}</button><button type="button" data-action="export-statistics-figure-png" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? escapeHtml(uiCopy("생성 중…", "Generating…")) : "PNG 600dpi"}</button><button type="button" data-action="export-statistics-figure-pdf" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? escapeHtml(uiCopy("생성 중…", "Generating…")) : "PDF 600dpi"}</button><button type="button" data-action="export-statistics-figure-tiff" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? escapeHtml(uiCopy("생성 중…", "Generating…")) : "TIFF 600dpi"}</button></div><span class="supportBoundary">${escapeHtml(uiCopy("SVG · PNG/PDF/TIFF 300/600dpi · sRGB ICC. CMYK와 vector PDF는 아직 미지원. 저널별 정확한 한도는 제출 시 검사합니다.", "SVG · PNG/PDF/TIFF at 300/600 dpi · sRGB ICC. CMYK and vector PDF are not supported yet. Exact per-journal limits are checked at submission."))}</span></div>${state.figureActionError ? `<p role="alert">${escapeHtml(state.figureActionError)}</p>` : state.figureActionNotice ? `<p role="status">${escapeHtml(state.figureActionNotice)}</p>` : ""}</section>` : "";
    const statisticsRasterToolbar = statisticsRasterPayload ? `<section class="statisticsRasterToolbar" data-statistics-raster-toolbar data-export-receipt-sha256="${escapeHtml(statisticsRasterPayload.exportSha256)}"><div><span>PUBLICATION RASTER · EXACT EXPORT</span><strong>${escapeHtml(`${statisticsRasterPayload.export.dpi} DPI · ${statisticsRasterPayload.export.colorSpace.toUpperCase()} · ${statisticsRasterPayload.export.widthMm}×${statisticsRasterPayload.export.heightMm} mm`)}</strong><code title="${escapeHtml(statisticsRasterPayload.figureArtifact.contentSha256)}">Figure v${escapeHtml(statisticsRasterPayload.figureArtifact.artifactVersion)} · ${escapeHtml(statisticsShortHash(statisticsRasterPayload.figureArtifact.contentSha256))}</code></div><div><em>원고 연결 가능</em><span>이 image 아티팩트가 journal raster 검증 대상입니다.</span></div></section>` : "";
    const numericSurfaceToolbar = numericSurfacePayload ? `<section class="statisticsFigureToolbar" data-numeric-surface-export-toolbar><div><span>3D RESPONSE SURFACE · EXACT VIEW</span><strong>${escapeHtml(numericSurfacePayload.title)}</strong><code title="${escapeHtml(activeVersion.contentSha256)}">surface v${escapeHtml(activeVersion.version)} · ${escapeHtml(statisticsShortHash(activeVersion.contentSha256))} · view는 SQLite 저장 상태 사용</code></div><div class="statisticsFigureExport"><div><button type="button" data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>버전 비교</button><button type="button" data-action="export-numeric-surface-png" ${state.figureActionBusy ? "disabled" : ""}>${state.figureActionBusy ? "생성 중…" : "PNG 2008×1506 · 600dpi"}</button></div><span class="supportBoundary">Three.js offscreen WebGL 재렌더 · sRGB · white background · vector/PDF/EPS/TIFF/CMYK 미지원.</span></div>${state.figureActionError ? `<p role="alert">${escapeHtml(state.figureActionError)}</p>` : state.figureActionNotice ? `<p role="status">${escapeHtml(state.figureActionNotice)}</p>` : ""}</section>` : "";
    const numericSurfaceRasterToolbar = numericSurfaceRasterPayload ? `<section class="statisticsRasterToolbar" data-numeric-surface-raster-toolbar data-export-receipt-sha256="${escapeHtml(numericSurfaceRasterPayload.exportSha256)}"><div><span>3D PUBLICATION RASTER · EXACT EXPORT</span><strong>${escapeHtml(`${numericSurfaceRasterPayload.export.width}×${numericSurfaceRasterPayload.export.height}px · ${numericSurfaceRasterPayload.export.dpi} DPI · ${numericSurfaceRasterPayload.export.colorSpace.toUpperCase()}`)}</strong><code title="${escapeHtml(numericSurfaceRasterPayload.surfaceArtifact.contentSha256)}">Surface v${escapeHtml(numericSurfaceRasterPayload.surfaceArtifact.artifactVersion)} · ${escapeHtml(statisticsShortHash(numericSurfaceRasterPayload.surfaceArtifact.contentSha256))} · camera ${escapeHtml(statisticsShortHash(numericSurfaceRasterPayload.viewStateReceipt.viewStateSha256))}</code></div><div><em>원고 연결 가능</em><span>PNG pixels · persisted camera · renderer · parent lineage가 하나의 receipt에 고정됩니다.</span></div></section>` : "";
    const imageArtifact = activeVersion?.rendererId === "agentlas.image";
    const statisticsAnalysisPayload = activeVersion?.payload?.schema === "agentlas.science.statistics-analysis-artifact/v1" ? activeVersion.payload : null;
    const statisticsAnalysisRequestedView = statisticsAnalysisPayload ? state.statisticsViewByArtifact.get(artifact.id) || `table:${statisticsAnalysisPayload.selectedTableIndex}` : "";
    const statisticsAnalysisVisual = Boolean(statisticsAnalysisPayload && String(statisticsAnalysisRequestedView).startsWith("chart:"));
    const paleontologyVisual = Boolean(paleontologyPayload && state.paleontologyViewByArtifact.get(artifact.id) !== "table");
    const visualViewerKind = !inspectingHistory && (imageArtifact || paleontologyVisual || activeVersion?.rendererId === "agentlas.vega" && earthquakeView !== "earthquake-depth" || statisticsAnalysisVisual)
      ? (imageArtifact ? "image" : "chart") : null;
    const visualFrameClass = [visualViewerKind ? "visualArtifactFrame" : "", paleontologyVisual ? "paleontologyVisualFrame" : ""].filter(Boolean).join(" ");
    const artifactViewToolbar = visualViewerKind ? artifactViewToolbarMarkup() : "";
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
    const activeToolbar = artifact.version.rendererId === "agentlas.vega"
      ? statisticsFigureToolbar || (paleontologyPayload ? "" : `${earthquakeToolbar}${earthquakeView === "earthquake-depth" ? "" : vegaEditorMarkup(artifact, vegaDraft)}`)
      : numericSurfaceToolbar || numericSurfaceRasterToolbar || statisticsRasterToolbar || citationToolbar || skyToolbar || genomicsToolbar;
    // Economic charts are the primary result. Keep the chart above its editable presentation
    // controls so a 1162x768 window shows the evidence before optional authoring settings.
    const economicChartSettings = !inspectingHistory && economicPayload && activeToolbar
      ? `<details class="vegaEditorDisclosure"><summary><span>${uiCopy("차트 설정", "Chart settings")}</span><small>${uiCopy("제목·크기·표시 옵션과 게재용 그림 준비", "Title, sizing, display options, and publication-figure preparation")}</small></summary>${activeToolbar}</details>`
      : "";
    const toolbarBeforeCanvas = economicChartSettings ? artifactViewToolbar : `${artifactViewToolbar}${activeToolbar}`;
    const canvas = inspectingHistory
      ? `<div class="artifactCanvasFrame historicalFrame"><div class="historicalStatus"><span>기록 보기 · v${escapeHtml(state.inspectedArtifactVersion)} · 읽기 전용</span><button data-artifact-history-version="${escapeHtml(artifact.currentVersion)}">현재 v${escapeHtml(artifact.currentVersion)}으로 돌아가기</button></div><div class="artifactCanvas historicalArtifactCanvas"><div class="historicalCaptureNotice"><strong>검증된 캡처</strong><span>이 화면은 기록 보존용이며 조작할 수 없습니다.</span></div><div class="historicalPreviewSurface" data-historical-artifact-host="${escapeHtml(artifact.id)}" data-historical-artifact-version="${escapeHtml(state.inspectedArtifactVersion)}" aria-label="${escapeHtml(artifact.title)} v${escapeHtml(state.inspectedArtifactVersion)} 기록">${historyError ? `<span class="historicalError">${escapeHtml(historyError)}</span>` : inspectedContext ? "" : `<span class="historicalLoading">검증된 과거 버전을 불러오는 중…</span>`}</div></div></div>`
      : `<div class="artifactCanvasFrame ${visualFrameClass}"><div class="rendererStatus"><span>${escapeHtml(artifact.kind)}</span><span>${escapeHtml(artifact.version.rendererId)} · ${escapeHtml(artifact.version.rendererVersion)}${earthquakeView === "earthquake-depth" || skyView === "astronomy-distance" ? " + Three.js 0.173.0" : ""} <em data-runtime-status></em></span></div>${toolbarBeforeCanvas}<div class="${canvasClass}${visualViewerKind ? " artifactVisualViewport" : ""}" data-artifact-host="${escapeHtml(artifact.id)}" data-artifact-version="${escapeHtml(artifact.version.version)}" data-content-sha256="${escapeHtml(artifact.version.contentSha256)}" tabindex="${visualViewerKind ? "0" : "-1"}" aria-label="${escapeHtml(artifact.title)}"></div><div class="renderError" data-render-error role="alert"></div>${economicChartSettings}</div>`;
    const loopObservation = semanticObservations[0] || null;
    const loopEvidence = loopObservation ? `${loopObservation.label}: ${loopObservation.value}${loopObservation.unit ? ` ${loopObservation.unit}` : ""}` : (activeVersion?.semantic?.summary || "현재 아티팩트의 다음 검증 단계를 연구 채팅에서 함께 결정합니다.");
    const spatialArtifact = (artifact.version.rendererId === "agentlas.table" && artifact.version.payload?.schema === "agentlas.science.materials-catalog-artifact/v1")
      || (artifact.version.rendererId === "agentlas.vega" && Boolean(earthquakeCatalog))
      || artifact.version.rendererId === "agentlas.d3-sky";
    const spatial3dOpen = (artifact.version.rendererId === "agentlas.table" && artifact.version.payload?.schema === "agentlas.science.materials-catalog-artifact/v1" && state.spatialViewByArtifact.get(artifact.id) !== "materials-table")
      || (artifact.version.rendererId === "agentlas.vega" && earthquakeView === "earthquake-depth")
      || (artifact.version.rendererId === "agentlas.d3-sky" && skyView === "astronomy-distance");
    const decisionPanel = labDecisionPanelMarkup();
    const chartPriority = Boolean(economicPayload && !inspectingHistory);
    return `<section class="artifactWorkspace ${state.historyOpen ? "historyOpen" : ""} ${state.artifactComparison ? "compareOpen" : ""} ${spatialArtifact ? "spatialArtifact" : ""} ${spatial3dOpen ? "spatial3dOpen" : ""}" data-chart-priority="${chartPriority}"><header class="labWorkspaceHeader visuallyHidden"><span>${escapeHtml(labCapabilityLabel(state.selectedLabId))}</span><strong>아티팩트 보관소 · 작업공간</strong><span class="originVersion">${capability}</span><button data-action="back-session">${state.returnMessageId ? "대화의 아티팩트로" : "세션으로 돌아가기"}</button></header>${tabs ? `<nav class="artifactTabs" data-count="${escapeHtml(labArtifacts.length)}" aria-label="Lab 아티팩트">${tabs}</nav>` : ""}${originStrip}${statisticsLineage}${paleontologyLineage}<div class="labWorkGrid"><div class="figureColumn">
      ${canvas}
      <section class="artifactInterpretation"><div><div class="researchKicker">${inspectingHistory ? "과거 버전 의미 기록" : "Semantic layer"}</div><h2>${escapeHtml(activeVersion?.semantic?.title || (inspectingHistory ? `v${state.inspectedArtifactVersion} 기록을 불러오는 중…` : artifact.title))}</h2><p>${escapeHtml(activeVersion?.semantic?.summary || (inspectingHistory ? "현재 버전 정보로 대체하지 않고, 선택한 과거 버전의 검증이 끝날 때까지 기다립니다." : ""))}</p></div>${observations ? `<dl class="observationGrid">${observations}</dl>` : ""}</section>
      <div data-artifact-compare-host>${artifactCompareMarkup(artifact, history)}</div>
    </div><aside class="versionRail" data-version-timeline aria-label="아티팩트 버전 기록"><header><span>버전 기록</span><div><strong>${escapeHtml(artifact.currentVersion)}개</strong><button data-action="open-compare" ${historyEntries.length < 2 ? "disabled" : ""}>비교</button></div></header><div class="versionRows">${timeline}</div><footer>저장된 버전만 기록됩니다. 과거 버전은 읽기 전용입니다.</footer></aside></div>${decisionPanel}</section>`;
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

  function manuscriptRequestSummary(message, rawText) {
    if (message.role !== "user") return null;
    const raw = String(rawText || "");
    const marker = /\n\n<<agentlas-manuscript-draft-job:v1 (\{[^\n]*\})>>$/.exec(raw);
    if (!marker) return null;
    try {
      const job = JSON.parse(marker[1]);
      if (job.projectId !== message.projectId || job.conversationId !== message.conversationId) return null;
      const families = { empirical: "Empirical study", "theoretical-proof": "Theoretical / proof", "review-synthesis": "Review / synthesis", "methods-model": "Methods / model", "data-resource": "Data resource" };
      if (!Object.hasOwn(families, job.articleFamily) || typeof job.requestId !== "string" || (job.journalTarget !== null && typeof job.journalTarget !== "string")) return null;
      const prefix = "Start a publication-grade manuscript workflow for this project.\n\nResearch objective: ";
      const end = raw.lastIndexOf(`\nArticle family: ${job.articleFamily}\nTarget journal: `, marker.index);
      if (!raw.startsWith(prefix) || end < prefix.length) return null;
      job.objective = raw.slice(prefix.length, end);
      // Summarize only our exact generated request. Edited/ordinary messages
      // remain verbatim, and the original instructions remain inspectable.
      if (manuscriptDraftJobPrompt(job) !== raw) return null;
      return `${uiCopy("원고 작성 요청", "Manuscript drafting request")}\n\n${job.objective}\n\n${uiCopy("논문 유형", "Article family")}: ${families[job.articleFamily]}\n${uiCopy("대상 학술지", "Target journal")}: ${job.journalTarget || uiCopy("미선택", "Not selected")}`;
    } catch { return null; }
  }

  function analysisPlanReviewContinuationPrompt(review) {
    const exact = `analysis_spec_id=${review.analysisSpecId}, version=${review.analysisSpecVersion}, content_sha256=${review.analysisSpecContentSha256}`;
    const instructions = review.decision === "approve"
      ? review.acquisitionOnly
        ? `사람이 화면에서 ${exact}의 사전 수집 계획을 승인했고 immutable approval receipt ${review.receiptId}가 저장되었습니다. 이 승인은 data.acquisition에 적힌 출처와 수집 방법만 허용합니다. 분석은 실행하지 마세요. 수집 후 실제 아티팩트 ID, 버전, content hash를 data.inputs에 묶은 후속 계획을 제안하고 다시 사람 승인을 요청하세요.`
        : `사람이 화면에서 ${exact}를 승인했고 immutable approval receipt ${review.receiptId}가 저장되었습니다. 최신 research lifecycle을 다시 읽고 이 frozen exact plan만 결합해 허용된 다음 단계로 진행하세요. 계획을 다시 쓰거나 채팅 문구를 승인으로 추론하지 마세요.`
      : `사람이 화면에서 ${exact}의 수정을 요청했습니다. 수정 의견: ${review.rationale}\n\n현재 draft를 승인 또는 freeze하지 마세요. 아직 입력 아티팩트가 없다면 data.inputs=[]와 함께 data.acquisition={strategy:"acquire-before-execution",sources:[{provider,sourceRefs,retrievalPlan,expectedArtifactKind}]}를 작성하세요. 수집이 끝난 뒤에는 실제 아티팩트 ID, 버전, content hash를 data.inputs에 묶은 후속 계획이 다시 사람 승인을 받아야 합니다. 이 의견을 반영한 새 analysis plan을 제안한 뒤 검토를 요청하세요.`;
    return `${instructions}\n\n<<agentlas-analysis-plan-review:v1 ${JSON.stringify(review)}>>`;
  }

  function analysisPlanReviewRequestSummary(message, rawText) {
    if (message.role !== "user") return null;
    const raw = String(rawText || "");
    const marker = /\n\n<<agentlas-analysis-plan-review:v1 (\{[^\n]*\})>>$/.exec(raw);
    if (!marker) {
      // Existing review continuations created before the projection marker remain in immutable
      // conversation history. Recognize only the exact generated prefix and suffix so those rows
      // gain the same compact projection without hiding an ordinary researcher message.
      const legacy = /^사람이 화면에서 analysis_spec_id=([0-9a-f-]{36}), version=(\d+), content_sha256=([a-f0-9]{64})의 수정을 요청했습니다\. 수정 의견: ([\s\S]+)\n\n현재 draft를 승인 또는 freeze하지 마세요\. 아직 입력 아티팩트가 없다면 data\.inputs=\[\]와 함께 data\.acquisition=\{strategy:"acquire-before-execution",sources:\[\{provider,sourceRefs,retrievalPlan,expectedArtifactKind\}\]\}를 작성하세요\. 수집이 끝난 뒤에는 실제 아티팩트 ID, 버전, content hash를 data\.inputs에 묶은 후속 계획이 다시 사람 승인을 받아야 합니다\. 이 의견을 반영한 새 analysis plan을 제안한 뒤 검토를 요청하세요\.$/.exec(raw);
      return legacy ? `${uiCopy("분석계획 수정 요청", "Analysis plan changes requested")}\n\n${legacy[4]}` : null;
    }
    try {
      const review = JSON.parse(marker[1]);
      if (review.projectId !== message.projectId || review.conversationId !== message.conversationId
        || !["approve", "revise"].includes(review.decision)
        || typeof review.analysisSpecId !== "string" || !Number.isSafeInteger(review.analysisSpecVersion)
        || typeof review.analysisSpecContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(review.analysisSpecContentSha256)
        || typeof review.receiptId !== "string" || typeof review.planTitle !== "string"
        || typeof review.acquisitionOnly !== "boolean"
        || (review.rationale !== null && typeof review.rationale !== "string")) return null;
      // Project only messages generated by this exact function. An edited or ordinary user message
      // remains verbatim, while the original controller instructions stay inspectable below it.
      if (analysisPlanReviewContinuationPrompt(review) !== raw) return null;
      return review.decision === "revise"
        ? `${uiCopy("분석계획 수정 요청", "Analysis plan changes requested")}\n\n${review.rationale}`
        : `${uiCopy("분석계획 승인", "Analysis plan approved")}\n\n${review.planTitle}`;
    } catch { return null; }
  }

  function scienceChatMarkdown(text) {
    if (!String(text || "").trim()) return "";
    // Reuse the extension's escaped block renderer, never raw model HTML.
    // Protect inline code before interpreting emphasis inside ordinary prose.
    const inline = scienceInlineMarkdown;
    // Keep list structure and source order in chat. The manuscript fallback's
    // flat-list buffer cannot represent indented children or ordered lists.
    const output = [], prose = [], lists = [];
    const flushProse = () => {
      if (prose.some((row) => row.trim())) output.push(manuscriptPreview(prose.join("\n"), inline));
      prose.length = 0;
    };
    const closeList = () => output.push(`</li></${lists.pop().tag}>`);
    const flushLists = () => { while (lists.length) closeList(); };
    let fence = false;
    for (const rawRow of String(text).split(/\r?\n/)) {
      const row = rawRow.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));
      if (row.trim().startsWith("```")) {
        flushLists();
        prose.push(row);
        fence = !fence;
        continue;
      }
      if (fence) { prose.push(row); continue; }
      const item = /^( *)([-+*]|\d{1,9}[.)])\s+(.+)$/.exec(row);
      if (item) {
        flushProse();
        const indent = item[1].length, tag = /^\d/.test(item[2]) ? "ol" : "ul";
        while (lists.length && lists[lists.length - 1].indent > indent) closeList();
        if (lists.length && lists[lists.length - 1].indent === indent
          && lists[lists.length - 1].tag !== tag) closeList();
        if (lists.length && lists[lists.length - 1].indent === indent) output.push("</li><li>");
        else {
          const start = tag === "ol" ? ` start="${parseInt(item[2], 10)}"` : "";
          output.push(`<${tag}${start}><li>`);
          lists.push({ indent, tag });
        }
        output.push(inline(item[3]));
      } else if (lists.length && row.trim() && /^\s/.test(row)
        && row.length - row.trimStart().length > lists[lists.length - 1].indent) {
        output.push(` ${inline(row.trim())}`);
      } else {
        flushLists();
        prose.push(row);
      }
    }
    flushLists();
    flushProse();
    return output.join("");
  }

  function compactChatMessage(message) {
    const blocks = state.blocksByMessage.get(message.id) || [];
    const rawText = blocks.length ? blocks.map((block) => block.content).join("\n\n") : message.content;
    const requestSummary = manuscriptRequestSummary(message, rawText) || analysisPlanReviewRequestSummary(message, rawText);
    const text = requestSummary || String(rawText || "")
      .replace(/\n*<<agentlas-manuscript-selection:v1 \{[^\n]*\}>>\s*$/u, "");
    const instructions = requestSummary ? `<details class="chatMessageInstructions" data-chat-instructions="${escapeHtml(message.id)}"><summary>${uiCopy("실행 지시문 보기", "View execution instructions")}</summary><div class="chatMessageContent">${escapeHtml(rawText)}</div></details>` : "";
    const artifactContexts = state.artifactContextsByMessage.get(message.id) || [];
    const artifacts = artifactContexts.map((context) => `<button class="chatArtifactLink" data-chat-artifact-id="${escapeHtml(context.artifact.id)}" data-chat-artifact-version="${escapeHtml(context.selectedVersion.version)}" data-chat-conversation-id="${escapeHtml(message.conversationId)}" data-chat-message-id="${escapeHtml(message.id)}" title="${escapeHtml(`Open exact v${context.selectedVersion.version} in ${labLabel(context.linkage.labId)}`)}"><strong>${escapeHtml(context.artifact.title)}</strong><span>${escapeHtml(labLabel(context.linkage.labId))} · open v${escapeHtml(context.selectedVersion.version)} →</span></button>`).join("");
    const user = message.role === "user";
    return `<article class="chatMessage ${user ? "isUser" : "isAssistant"}" data-chat-message-id="${escapeHtml(message.id)}"><div class="chatMessageRole">${user ? "You" : "Agentlas Science"}</div><div class="chatMessageContent${user ? "" : " scienceChatMarkdown"}">${user ? escapeHtml(text) : scienceChatMarkdown(text)}</div>${instructions}${artifacts}${paleontologyCatalogReceiptMarkup(message)}</article>`;
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
    const label = job.status === "created" ? "Manuscript created" : job.status === "cancelled" ? uiCopy("원고 작성이 중단되었습니다", "Manuscript drafting stopped") : job.status === "blocked" || job.status === "failed" ? "Manuscript not created" : "Publication draft in progress";
    const detail = job.status === "created"
      ? `Blueprint v${job.receipt?.blueprintVersion || "-"} · ${job.receipt?.eligibilityReceiptIds?.length || 0} eligible comparables`
      : job.status === "cancelled" ? uiCopy("중단 전에 완료·검증된 원고는 확인되지 않았습니다. 준비되면 원고 작성을 다시 요청할 수 있습니다.", "No completed, validated manuscript was found before this run stopped. You can request manuscript drafting again when ready.")
        : job.error || "Research Director is collecting full text, qualifying 5+ comparable papers, calibrating the Blueprint, and drafting substantive sections.";
    return `<section class="manuscriptDraftJobCard" data-manuscript-draft-status="${escapeHtml(job.status)}"><span>${heroIcon("book")}</span><div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(detail)}</p></div></section>`;
  }

  function scienceLiveResponseText(raw) {
    let visible = stripStormbreakerContinueMarker(String(raw || "")).text.split(STORMBREAKER_LONG_RUN_MARKER).join("");
    // The host owns the full marker constants. Hide unfinished streaming tails
    // without changing the raw receipt or its hash.
    for (const marker of [STORMBREAKER_CONTINUE_MARKER, STORMBREAKER_LONG_RUN_MARKER]) {
      for (let length = marker.length - 1; length >= 4; length -= 1) {
        if (visible.endsWith(marker.slice(0, length))) { visible = visible.slice(0, -length); break; }
      }
    }
    return stripAgentControlBlocks(visible, { streaming: true });
  }

  function liveChatResponseMarkup() {
    const turn = state.activeTurn;
    if (!turn || turn.projectId !== state.selectedId || turn.conversationId !== selectedConversation()?.id
      || !["queued", "running", "cancelling"].includes(turn.status) || !String(turn.partialText || "").trim()) return "";
    // Receipt-backed progress is not a durable assistant message or a completed
    // artifact. Keep it separate from message/citation bindings and scroll IDs.
    if (turn.assistantMessageId && state.messages.some((message) => message.id === turn.assistantMessageId)) return "";
    const visible = scienceLiveResponseText(turn.partialText);
    if (!visible) return "";
    return `<article class="chatMessage isAssistant" data-chat-turn-id="${escapeHtml(turn.id)}"><div class="chatMessageRole">Agentlas Science · ${uiCopy("응답 작성 중", "Response in progress")}</div><div class="chatMessageContent scienceChatMarkdown">${scienceChatMarkdown(visible)}</div></article>`;
  }

  function chatThreadMarkup() {
    if (!chatMessagesReady()) return `<div class="chatDockEmpty" role="status">${uiCopy("대화를 불러오는 중…", "Loading conversation…")}</div>`;
    const messages = state.messages.length ? state.messages.map(compactChatMessage).join("") : `<div class="chatDockEmpty">This project conversation continues here.</div>`;
    const failure = state.mode !== "session" || state.currentDestination !== "overview" ? runFailureNotice() : "";
    return `${messages}${liveChatResponseMarkup()}${failure}${manuscriptDraftJobMarkup()}${manuscriptProposalCardsMarkup()}`;
  }

  function manuscriptDraftJobPrompt(job) {
    const target = job.journalTarget || "Not selected";
    const seed = job.seedBinding ? `\nValidated result to bind only after the manuscript gate passes: ${JSON.stringify(job.seedBinding)}` : "";
    return `Start a publication-grade manuscript workflow for this project.\n\nResearch objective: ${job.objective}\nArticle family: ${job.articleFamily}\nTarget journal: ${target}.${seed}\n\nUse the Research Director MCP path only. Do not create a renderer-side manuscript or an empty IMRaD scaffold.\n1. Collect and content-check relevant full-text prior work.\n2. Record immutable quantitative eligibility receipts for at least five comparable sources from one source-domain cohort and one article family; bind exact SourceVersions and two distinct-section byte quotes.\n3. Create a current corpus-calibrated Blueprint, binding verified official journal guidance if a target is supplied.\n4. Map every paragraph job, claim, citation, figure, table, and equation before prose; preserve the corpus-observed section transitions.\n5. Draft substantive sections in durable passes until the corpus-derived word and paragraph ranges are met without repeated-paragraph padding; draft the Abstract last.\n6. Assemble the versioned manuscript only through the gated MCP route, then close scholarly flow, claim, numeric provenance, and journal validation.\n\nIf evidence is missing, ask for the smallest necessary input instead of creating a placeholder.\n\n<<agentlas-manuscript-draft-job:v1 ${JSON.stringify({ requestId: job.requestId, projectId: job.projectId, conversationId: job.conversationId, articleFamily: job.articleFamily, journalTarget: job.journalTarget || null, seedBinding: job.seedBinding || null })}>>`;
  }

  async function maybeOpenDraftJobManuscript(projectId, { terminalStatus = null } = {}) {
    const job = state.manuscriptDraftJob;
    if (!job || job.projectId !== projectId || ["created", "cancelled"].includes(job.status)) return false;
    if (state.activeTurn?.conversationId && state.activeTurn.conversationId !== job.conversationId) return false;
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
    if (terminalStatus === "cancelled") {
      state.manuscriptDraftJob = { ...job, status: "cancelled", error: "" };
    } else if (["completed", "failed", "interrupted"].includes(terminalStatus)) {
      state.manuscriptDraftJob = { ...job, status: "blocked", error: "The Research Director turn ended without a closed manuscript + Blueprint + 5 eligible-comparable receipt. No manuscript tab was opened." };
      state.composerError = state.manuscriptDraftJob.error;
    }
    return false;
  }

  function composerTurnError(turn) {
    // The terminal status is authoritative; some runtimes retain a generic
    // runner error code even when their receipt explicitly records cancellation.
    return turn && ["failed", "interrupted"].includes(turn.status)
      ? turn.errorCode || `Research run ${turn.status}`
      : "";
  }

  function scienceRuntimePickerMarkup() {
    const locked = scienceRuntimePickerLocked();
    const loading = state.runtimeSelectionLoading;
    const busy = state.runtimeSelectionBusy;
    const selected = scienceRuntimeSelectionForDisplay();
    const selectedKey = scienceRuntimeSelectionKey(selected);
    const label = scienceRuntimeDisplayLabel() || uiCopy("모델 선택", "Select model");
    const provider = scienceRuntimeDisplayProvider();
    const query = String(state.runtimePickerQuery || "").trim().toLocaleLowerCase(state.locale || "en");
    const visibleOptions = state.runtimeOptions
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !query || [scienceRuntimeOptionLabel(option), scienceRuntimeOptionProvider(option), option.selection?.model, option.selection?.backend, option.selection?.kind]
        .filter(Boolean).join(" ").toLocaleLowerCase(state.locale || "en").includes(query));
    const buttonDisabled = locked || loading || busy || !selectedConversation();
    const status = state.runtimeSelectionError
      ? scienceRuntimeErrorText(state.runtimeSelectionError)
      : state.runtimeUnavailable
        ? uiCopy("연결된 모델을 사용할 수 없습니다.", "No connected model is available.")
        : "";
    const optionRows = visibleOptions.length
      ? visibleOptions.map(({ option, index }) => {
        const optionKey = scienceRuntimeSelectionKey(option.selection);
        const optionLabel = scienceRuntimeOptionLabel(option);
        const optionProvider = scienceRuntimeOptionProvider(option);
        return `<button type="button" class="scienceModelOption${optionKey === selectedKey ? " isSelected" : ""}" data-action="select-science-model" data-science-runtime-option-index="${index}" role="option" aria-selected="${optionKey === selectedKey}" ${locked || busy ? "disabled" : ""}><span class="scienceModelOptionCopy"><strong>${escapeHtml(optionLabel)}</strong>${optionProvider ? `<em>${escapeHtml(optionProvider)}</em>` : ""}</span><span class="scienceModelOptionCheck" aria-hidden="true">${optionKey === selectedKey ? "✓" : ""}</span></button>`;
      }).join("")
      : `<div class="scienceModelEmpty">${escapeHtml(state.runtimeUnavailable ? uiCopy("사용 가능한 모델이 없습니다.", "No available models.") : query ? uiCopy("검색 결과가 없습니다.", "No models match this search.") : uiCopy("사용 가능한 모델이 없습니다.", "No models are available."))}</div>`;
    const menu = state.runtimePickerOpen && !locked
      ? `<div class="scienceModelMenu" role="dialog" aria-label="${escapeHtml(uiCopy("모델 선택", "Select model"))}"><div class="scienceModelMenuHeader"><strong>${escapeHtml(uiCopy("연구 모델", "Research model"))}</strong><button type="button" class="scienceModelClose" data-action="close-science-model" aria-label="${escapeHtml(uiCopy("닫기", "Close"))}">×</button></div><label class="scienceModelSearch">${heroIcon("search")}<span class="visuallyHidden">${escapeHtml(uiCopy("모델 검색", "Search models"))}</span><input type="search" data-science-model-search value="${escapeHtml(state.runtimePickerQuery)}" placeholder="${escapeHtml(uiCopy("모델 또는 제공자 검색", "Search model or provider"))}" autocomplete="off"></label><div class="scienceModelOptions" role="listbox" aria-label="${escapeHtml(uiCopy("사용 가능한 모델", "Available models"))}">${optionRows}</div>${status ? `<p class="scienceModelError" role="alert">${escapeHtml(status)}</p>` : ""}</div>`
      : "";
    const triggerTitle = locked
      ? uiCopy("현재 연구 실행의 모델", "Model pinned for the running research")
      : uiCopy("연구 모델 선택", "Choose the research model");
    return `<div class="scienceModelPicker${state.runtimePickerOpen ? " isOpen" : ""}" data-science-model-picker><button type="button" class="scienceModelTrigger${!selected ? " isRequired" : ""}" data-action="toggle-science-model" data-science-model-trigger aria-haspopup="dialog" aria-expanded="${state.runtimePickerOpen && !locked}" aria-label="${escapeHtml(triggerTitle)}" title="${escapeHtml(triggerTitle)}" ${buttonDisabled ? "disabled" : ""}><span class="scienceModelTriggerMark" aria-hidden="true">✦</span><span class="scienceModelTriggerCopy"><strong>${escapeHtml(label)}</strong>${provider ? `<em>${escapeHtml(provider)}</em>` : ""}</span><span class="scienceModelTriggerChevron" aria-hidden="true">⌄</span></button>${menu}</div>`;
  }

  function scienceResearchLoopControlsMarkup() {
    const session = state.researchLoopInspection?.session;
    if (!session || session.status !== "paused" || session.projectId !== state.selectedId) return "";
    const busy = state.researchLoopActionBusy;
    const error = scienceResearchLoopActionErrorText(state.researchLoopActionError);
    const detail = uiCopy(
      `연구 ${session.currentEpisode || 0}회차가 멈췄습니다. 현재 모델은 이 연구에 고정되어 있습니다.`,
      `Research is paused at episode ${session.currentEpisode || 0}. Its pinned model stays fixed until you continue or stop it.`,
    );
    return `<div class="scienceResearchLoopControls" data-research-loop-controls data-loop-session-id="${escapeHtml(session.id)}" data-loop-version="${escapeHtml(session.version)}" data-loop-state-sha256="${escapeHtml(session.stateSha256)}"><div class="scienceResearchLoopCopy"><strong>${escapeHtml(uiCopy("연구가 일시 중지됨", "Research paused"))}</strong><span>${escapeHtml(detail)}</span></div><div class="scienceResearchLoopActions"><button type="button" class="scienceResearchLoopResume" data-action="resume-science-loop" ${busy ? "disabled" : ""}>${escapeHtml(busy ? uiCopy("처리 중…", "Working…") : uiCopy("연구 계속", "Continue research"))}</button><button type="button" class="scienceResearchLoopCancel" data-action="cancel-science-loop" ${busy ? "disabled" : ""}>${escapeHtml(uiCopy("연구 중지", "Stop research"))}</button></div>${error ? `<p class="scienceResearchLoopError" role="alert">${escapeHtml(error)}</p>` : ""}</div>`;
  }

  function composer(docked = false) {
    const running = state.activeTurn && SCIENCE_RUNTIME_RUNNING_STATUSES.has(state.activeTurn.status);
    const needsInitialRun = !running && state.messages.length === 1 && state.messages[0].role === "user" && !state.messages.some((message) => message.role === "assistant");
    const disabled = state.composerSending || !selectedConversation() || !chatMessagesReady();
    const runtimeSelectionBlocked = !state.runtimeSelection || state.runtimeUnavailable || state.runtimeSelectionLoading || state.runtimeSelectionBusy;
    const sendDisabled = !running && (disabled || runtimeSelectionBlocked || (!needsInitialRun && !state.composerDraft.trim()));
    // 같은 실패가 두 번 나오면 안 된다. 본문 .failClosed 가 사람 문장으로 설명하는 경우
  // 하단 상태줄까지 오류 원문을 되풀이하면, 사람은 잘린 개발자 문자열
  // ("Error invoking remote method 'scien…")만 읽게 된다. 설명된 실패는 짧게 가리키고
  // 원문은 미지의 실패에만 남긴다.
  const composerStatusText = (rawValue) => {
    const t = String(rawValue || "").trim();
    if (!t) return "";
    if (t === "no-runtime") return uiCopy("AI 런타임 연결이 필요합니다", "AI runtime connection required");
    const explained = /^Error invoking remote method/i.test(t)
      || /science-research-director-package-version-mismatch/.test(t)
      || /package-integrity|package-signature/.test(t);
    // 본문 안내를 가리키려면 그 안내가 실제로 그려져 있어야 한다. 실물로 확인했다 —
    // .failClosed 가 본문 위쪽(303px)에 폭 760 으로 그려진다. 그래서 가리켜도 된다.
    return explained ? "실행을 시작하지 못했습니다 · 위 안내를 확인하세요" : t;
  };
  const loopPresentation = researchLoopPresentation();
  const status = composerStatusText(state.composerError) || (running
    ? (state.activeTurn.status === "cancelling" ? "연구 실행을 중단하는 중…" : "Agent runtime 연구 중…")
    : state.activeTurn?.status === "cancelled"
      ? uiCopy("연구 실행 중단됨", "Research run stopped")
      : loopPresentation?.attention
        ? loopPresentation.label
        : state.runtimeSelectionError
          ? scienceRuntimeErrorText(state.runtimeSelectionError)
          : state.runtimeUnavailable
            ? uiCopy("연결된 모델을 사용할 수 없습니다.", "No connected model is available.")
            : !state.runtimeSelection && !state.runtimeSelectionLoading
              ? uiCopy("모델을 선택해 주세요.", "Choose a model to begin.")
        : needsInitialRun ? "저장된 첫 질문을 실행할 수 있습니다" : "");
    return `<footer class="composer${docked ? " dockedComposer" : ""}"><div class="composerBox"><textarea data-composer-input ${disabled || running || needsInitialRun ? "disabled" : ""} rows="2" aria-label="후속 질문" placeholder="후속 질문, 분석 또는 실험 요청">${escapeHtml(state.composerDraft)}</textarea><div class="composerBar"><div class="composerTools">${scienceRuntimePickerMarkup()}${scienceResearchLoopControlsMarkup()}${status ? `<span class="composerStatus">${escapeHtml(status)}</span>` : ""}</div><button class="sendButton" data-action="${running ? "cancel-turn" : "send-turn"}" ${sendDisabled ? "disabled" : ""} aria-label="${running ? "중단" : needsInitialRun ? "첫 질문 실행" : "보내기"}">${running ? "■" : "↑"}</button></div></div></footer>`;
  }

  function chatContextTokensMarkup() {
    if (state.mode === "manuscript") {
      const context = state.manuscriptSelectionContext;
      if (!context) return state.manuscriptSelectionError ? `<div class="chatContextError" role="alert">${escapeHtml(state.manuscriptSelectionError)}</div>` : "";
      const node = state.manuscriptEditorModel?.document?.nodes?.find((item) => item.id === context.nodeId);
      const label = node?.kind === "heading" ? node.text : node?.kind ? `${node.kind[0].toUpperCase()}${node.kind.slice(1)} block` : "Manuscript selection";
      return `<div class="chatContextTokens manuscriptChatContext" aria-label="Pinned manuscript selection"><span title="${escapeHtml(context.selectedText)}">${heroIcon("book")}<strong>${escapeHtml(label)}</strong><em>“${escapeHtml(context.selectedText.slice(0, 86))}${context.selectedText.length > 86 ? "…" : ""}”</em><button data-action="clear-manuscript-selection" aria-label="Remove pinned manuscript selection">×</button></span></div>`;
    }
    // Lab and artifact context is already implicit in the active workspace tab. Repeating it as
    // fixed chips above the composer competes with the result and looks like a user attachment.
    // Keep only the removable manuscript-selection token above, because that one is explicitly
    // pinned by the researcher and changes the next request.
    return "";
  }

  function chatDockComposerMarkup() {
    return `${chatContextTokensMarkup()}${composer(true)}`;
  }

  function chatDock() {
    return `<aside class="chatDock" data-chat-dock aria-label="연구 협업 채팅"><div class="chatDockFrame"><header class="chatDockHeader"><div class="chatPartner"><span class="chatPartnerMark">${heroIcon("book")}</span><span><strong>연구 채팅</strong><em>${escapeHtml(lifecycleCompactLabel())}</em></span></div><button class="chatHeaderAction" data-action="toggle-drawer" aria-label="연구 문맥과 세부 정보">${heroIcon("ellipsis")}</button></header><div class="chatDockBody" data-chat-dock-body data-chat-project-id="${escapeHtml(state.selectedId || "")}" data-chat-conversation-id="${escapeHtml(selectedConversation()?.id || "")}" data-chat-hydrated="${chatMessagesReady()}">${chatThreadMarkup()}</div><div class="chatDockComposer" data-chat-dock-composer>${chatDockComposerMarkup()}</div></div></aside>`;
  }

  const chatScrollSnapshots = new Map();

  function chatMessagesReady() {
    const conversation = selectedConversation();
    return Boolean(state.selectedId && conversation && state.chatMessagesScope === JSON.stringify([state.selectedId, conversation.id]));
  }

  function chatScrollKey(body) {
    const { chatProjectId, chatConversationId } = body?.dataset || {};
    return chatProjectId && chatConversationId ? JSON.stringify([chatProjectId, chatConversationId]) : null;
  }

  function rememberChatScroll(body = document.querySelector("[data-chat-dock-body]")) {
    const key = chatScrollKey(body);
    if (!key || body.dataset.chatHydrated !== "true") return;
    const top = body.getBoundingClientRect().top;
    const anchor = [...body.querySelectorAll("article[data-chat-message-id]")].find((message) => message.getBoundingClientRect().bottom > top);
    chatScrollSnapshots.delete(key);
    chatScrollSnapshots.set(key, {
      top: body.scrollTop,
      following: body.scrollHeight - body.scrollTop - body.clientHeight < 80,
      anchorId: anchor?.dataset.chatMessageId,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      openInstructions: [...body.querySelectorAll("details[data-chat-instructions][open]")].map((details) => details.dataset.chatInstructions),
    });
    if (chatScrollSnapshots.size > 100) chatScrollSnapshots.delete(chatScrollSnapshots.keys().next().value);
  }

  function restoreChatScroll(body = document.querySelector("[data-chat-dock-body]")) {
    const key = chatScrollKey(body);
    if (!key) return;
    const saved = chatScrollSnapshots.get(key);
    for (const details of body.querySelectorAll("details[data-chat-instructions]")) details.open = saved?.openInstructions.includes(details.dataset.chatInstructions) || false;
    if (!saved || saved.following) { body.scrollTop = body.scrollHeight; return; }
    body.scrollTop = saved.top;
    const anchor = [...body.querySelectorAll("article[data-chat-message-id]")].find((message) => message.dataset.chatMessageId === saved.anchorId);
    if (anchor) body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - saved.anchorOffset;
  }

  function renderChatDock() {
    const body = document.querySelector("[data-chat-dock-body]");
    const composerHost = document.querySelector("[data-chat-dock-composer]");
    if (!body || !composerHost) {
      render();
      return;
    }
    rememberChatScroll(body);
    body.dataset.chatProjectId = state.selectedId || "";
    body.dataset.chatConversationId = selectedConversation()?.id || "";
    body.dataset.chatHydrated = String(chatMessagesReady());
    body.innerHTML = chatThreadMarkup();
    composerHost.innerHTML = chatDockComposerMarkup();
    restoreChatScroll(body);
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

  function applyStartedComposerReceipt(started, projectId, conversationId) {
    const turn = started?.turn;
    const message = started?.userMessage;
    if (!turn || !message || turn.projectId !== projectId || turn.conversationId !== conversationId
      || message.projectId !== projectId || message.conversationId !== conversationId
      || turn.userMessageId !== message.id || message.role !== "user" || message.visibility !== "visible") {
      throw new Error("science-composer-start-receipt-invalid");
    }
    // This is the committed message returned by Main, never optimistic user text.
    state.messages = [...state.messages.filter((item) => item.id !== message.id), message]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    state.activeTurn = turn;
    if (turn.runtimeSelection && turn.projectId === state.selectedId && turn.conversationId === selectedConversation()?.id) {
      state.runtimeSelection = turn.runtimeSelection;
    }
  }

  async function startComposerTurn(options = {}) {
    const project = selectedProject();
    const conversation = selectedConversation();
    if (!project || !conversation || state.composerSending || !chatMessagesReady()) return;
    const requestEpoch = ++composerRequestEpoch;
    const projectEpoch = selectionEpoch;
    const isCurrent = () => requestEpoch === composerRequestEpoch && projectEpoch === selectionEpoch
      && project.id === state.selectedId && conversation.id === selectedConversation()?.id;
    let requestId = crypto.randomUUID();
    let startInput = null;
    const recoverFailure = async (reason) => {
      if (!isCurrent()) return;
      let recoveredReceiptTurn = null;
      // A controller continuation can become the latest turn before this IPC
      // response arrives. Replay the exact idempotency key, not a guessed latest
      // turn, to recover the user's own committed request.
      if (startInput) {
        try {
          const replayed = await science.composer.start(startInput);
          if (!isCurrent()) return;
          applyStartedComposerReceipt(replayed, project.id, conversation.id);
          recoveredReceiptTurn = replayed.turn;
        } catch {}
      }
      // Main may have committed a message/turn before dispatch or IPC failed.
      // Recover it from the store instead of pretending the send never happened.
      try { await refreshConversationOnly(project.id); } catch {}
      if (!isCurrent()) return;
      // The first refresh may have read messages/turn before dispatch settled
      // while the remaining projections were still loading. Reattach after it
      // so a dropped event during that window cannot leave a stale running UI.
      try {
        const attached = await science.composer.attach({ projectId: project.id, conversationId: conversation.id });
        if (!isCurrent()) return;
        if (attached?.turn?.requestId === requestId) {
          if (state.activeTurn?.id !== attached.turn.id || attached.turn.lastSequence >= state.activeTurn.lastSequence) state.activeTurn = attached.turn;
          if (["completed", "failed", "cancelled", "interrupted"].includes(state.activeTurn.status)) await refreshConversationOnly(project.id);
        }
      } catch {}
      if (!isCurrent()) return;
      state.composerSending = false;
      const recovered = recoveredReceiptTurn || (state.activeTurn?.requestId === requestId ? state.activeTurn : null);
      if (recovered) state.composerDraft = "";
      recordRunFailure(recovered ? composerTurnError(recovered) : reason);
    };
    const needsInitialRun = !options.forceAppend && state.messages.length === 1 && state.messages[0].role === "user" && !state.messages.some((message) => message.role === "assistant");
    const content = state.composerDraft.trim();
    const selectionContext = !needsInitialRun && state.mode === "manuscript" ? state.manuscriptSelectionContext : null;
    const runtimeContent = selectionContext ? `${content}\n\n<<agentlas-manuscript-selection:v1 ${JSON.stringify({ selectionContextId: selectionContext.id, manuscriptId: selectionContext.manuscriptId, manuscriptVersion: selectionContext.manuscriptVersion, manuscriptContentSha256: selectionContext.manuscriptContentSha256, manuscriptDocumentSha256: selectionContext.manuscriptDocumentSha256, nodeId: selectionContext.nodeId, nodeRevision: selectionContext.nodeRevision, nodeContentSha256: selectionContext.nodeContentSha256, startOffset: selectionContext.startOffset, endOffset: selectionContext.endOffset, selectedText: selectionContext.selectedText })}>>` : content;
    if (!needsInitialRun && !content) return;
    const runtimeSelection = state.runtimeSelection;
    if (!runtimeSelection || state.runtimeUnavailable || state.runtimeSelectionLoading || state.runtimeSelectionBusy) {
      state.runtimePickerOpen = true;
      state.composerError = state.runtimeUnavailable ? "science-runtime-selection-unavailable" : "science-runtime-selection-required";
      renderChatDock();
      requestAnimationFrame(() => document.querySelector("[data-science-model-trigger]")?.focus());
      return;
    }
    state.composerSending = true;
    state.composerError = "";
    renderChatDock();
    try {
      startInput = {
        requestId,
        projectId: project.id,
        conversationId: conversation.id,
        runtimeSelection,
        ...(needsInitialRun
          ? { mode: "existing-user-message", userMessageId: state.messages[0].id }
          : { mode: "append-user-message", content: runtimeContent }),
      };
      const started = await science.composer.start(startInput);
      if (!isCurrent()) return;
      applyStartedComposerReceipt(started, project.id, conversation.id);
      if (!needsInitialRun) state.composerDraft = "";
      state.composerSending = false;
      if (["completed", "failed", "cancelled", "interrupted"].includes(started.turn.status)) {
        if (state.mode === "lab") await refreshConversationOnly(project.id);
        else await selectProject(project.id, { preserveWorkspace: true });
        return;
      }
      renderChatDock();
    } catch (error) {
      if (!isCurrent()) return;
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
          requestId = crypto.randomUUID();
          startInput = {
            requestId,
            projectId: project.id,
            conversationId: conversation.id,
            runtimeSelection,
            mode: "append-user-message",
            content: state.messages[0].content,
          };
          const retried = await science.composer.start(startInput);
          if (!isCurrent()) return;
          applyStartedComposerReceipt(retried, project.id, conversation.id);
          state.composerSending = false;
          if (["completed", "failed", "cancelled", "interrupted"].includes(retried.turn.status)) {
            if (state.mode === "lab") await refreshConversationOnly(project.id);
            else await selectProject(project.id, { preserveWorkspace: true });
            return;
          }
          renderChatDock();
          return;
        } catch (retryError) {
          await recoverFailure(retryError);
          return;
        }
      }
      await recoverFailure(error);
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

  function newProjectFolderErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message.includes("expired")) return uiCopy("폴더 선택이 만료되었습니다. 폴더를 다시 선택해 주세요.", "The folder selection expired. Choose the folder again.");
    if (message.includes("folder-selection") || message.includes("folder selection")) return uiCopy("폴더를 다시 선택해 주세요.", "Choose the folder again.");
    return message || uiCopy("폴더를 선택하지 못했습니다.", "The folder could not be selected.");
  }

  async function pickNewProjectFolder() {
    if (!state.modal || state.saving || state.newProjectFolderBusy) return;
    const generation = state.newProjectGeneration;
    state.newProjectFolderBusy = true;
    state.newProjectFolderError = "";
    try {
      // Invoke IPC before the first await while the click's user activation is live;
      // the immediate render only disables repeat taps while the native chooser is open.
      const pendingSelection = science.projects.pickFolder();
      render();
      const result = await pendingSelection;
      if (generation !== state.newProjectGeneration || !state.modal) return;
      if (!result || result.canceled === true) return;
      const selectionId = typeof result.selectionId === "string" ? result.selectionId.trim() : "";
      const folderPath = typeof result.path === "string" ? result.path : "";
      if (!selectionId || !folderPath.trim()) throw new Error("science-folder-selection-invalid");
      state.newProjectDraft = { ...state.newProjectDraft, folderSelectionId: selectionId, folderPath };
      state.newProjectRequestId = null;
      state.newProjectRequestSignature = "";
    } catch (error) {
      if (generation !== state.newProjectGeneration || !state.modal) return;
      state.newProjectFolderError = newProjectFolderErrorMessage(error);
    } finally {
      if (generation !== state.newProjectGeneration || !state.modal) return;
      state.newProjectFolderBusy = false;
      render();
      requestAnimationFrame(() => document.querySelector('[data-action="pick-project-folder"]')?.focus({ preventScroll: true }));
    }
  }

  function resetNewProjectDraft() {
    state.newProjectDraft = blankNewProjectDraft();
    state.newProjectFolderError = "";
  }

  function modal() {
    if (!state.modal) return "";
    const template = researchTemplateById(state.selectedResearchTemplateId);
    const classification = template ? `<div class="projectClassificationHint"><img src="./assets/research-templates/${escapeHtml(template.id)}.png" alt=""><span><small>${uiCopy("바로가기에서 선택한 분류", "Classification from shortcut")}</small><strong>${escapeHtml(researchTemplateLabel(template))}</strong></span><button type="button" data-action="clear-project-classification">${uiCopy("분류 지우기", "Clear")}</button></div>` : "";
    const folderPath = typeof state.newProjectDraft.folderPath === "string" ? state.newProjectDraft.folderPath : "";
    const hasFolder = Boolean(state.newProjectDraft.folderSelectionId && folderPath.trim());
    const folderPicker = `<label class="field projectFolderField"><span>${uiCopy("프로젝트 폴더", "Project folder")}</span><button class="projectFolderPicker" type="button" data-action="pick-project-folder" ${state.saving || state.newProjectFolderBusy ? "disabled" : ""}><span class="projectFolderPickerIcon" aria-hidden="true">${heroIcon("folder")}</span><span class="projectFolderPickerCopy"><strong>${hasFolder ? uiCopy("폴더가 선택되었습니다", "Folder selected") : uiCopy("폴더 선택", "Choose a folder")}</strong><small class="projectFolderPickerPath${hasFolder ? "" : " isPlaceholder"}"${hasFolder ? ` title="${escapeHtml(folderPath)}"` : ""}>${hasFolder ? escapeHtml(folderPath) : uiCopy("프로젝트에 연결할 폴더를 선택하세요", "Choose a folder for this project")}</small></span><span class="projectFolderPickerArrow" aria-hidden="true">${heroIcon("chevron-right")}</span></button>${state.newProjectFolderError ? `<span class="formError projectFolderError" role="alert">${escapeHtml(state.newProjectFolderError)}</span>` : ""}</label>`;
    return `<div class="modalBackdrop projectCreationBackdrop" role="presentation"><form class="modal newProjectModal projectDetailsModal" id="new-project-form" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><header><div><span>${uiCopy("새 프로젝트", "New project")}</span><h2 id="new-project-title">${uiCopy("프로젝트를 시작해 보세요", "Start a project")}</h2></div><button class="newProjectClose" type="button" data-action="cancel" aria-label="${uiCopy("새 프로젝트 닫기", "Close new project")}">×</button></header><p class="modalLead">${uiCopy("프로젝트 이름과 개요를 입력하고 연결할 폴더를 선택하세요.", "Enter a name and overview, then choose a folder for this project.")}</p>${classification}<label class="field"><span>${uiCopy("프로젝트 이름", "Project name")}</span><input name="title" required maxlength="80" autocomplete="off" value="${escapeHtml(state.newProjectDraft.title)}" placeholder="${uiCopy("연구를 구분하기 쉬운 짧은 이름", "A short name to identify your research")}" /></label><label class="field"><span>${uiCopy("개요", "Overview")}</span><textarea name="question" required maxlength="20000" placeholder="${uiCopy("이 프로젝트에서 발견하거나 검증하고 싶은 내용을 적어 주세요.", "Describe what you want to discover or test in this project.")}">${escapeHtml(state.newProjectDraft.question)}</textarea></label>${folderPicker}<div class="formError" id="form-error" role="alert"></div><div class="modalActions"><button class="primaryButton" type="submit" ${state.saving || state.newProjectFolderBusy ? "disabled" : ""}>${state.saving ? uiCopy("저장 중…", "Saving…") : uiCopy("프로젝트 만들기", "Create project")}</button></div></form></div>`;
  }

  function labManagerModal() {
    if (!state.labManagerOpen || !state.selectedId) return "";
    const bindings = new Map(state.workspaceLabBindings.map((binding) => [binding.labId, binding]));
    const candidates = state.labCatalog.length ? state.labCatalog : researchTemplates.map((template) => ({ id: template.id, label: researchTemplateLabel(template) }));
    const rows = candidates.map((lab) => {
      const binding = bindings.get(lab.id);
      const enabled = binding?.enabled === true;
      const busy = state.labManagerBusyId === lab.id;
      const template = researchTemplateById(lab.id);
      return `<button type="button" class="labManagerRow" data-action="toggle-project-lab" data-lab-id="${escapeHtml(lab.id)}" data-lab-enabled="${enabled}" aria-pressed="${enabled}" ${state.labManagerBusyId ? "disabled" : ""}><span class="labManagerCheck" aria-hidden="true">${busy ? "…" : enabled ? "✓" : "+"}</span><span><strong>${escapeHtml(lab.label || labLabel(lab.id))}</strong><em>${escapeHtml(template ? researchTemplateDescription(template) : uiCopy("프로젝트에서 필요할 때 사용할 수 있도록 북마크합니다.", "Bookmark this Lab so it is available when the project needs it."))}</em></span><small>${enabled ? uiCopy("추가됨", "Added") : uiCopy("추가", "Add")}</small></button>`;
    }).join("");
    return `<div class="modalBackdrop labManagerBackdrop" role="presentation"><section class="modal labManagerModal" role="dialog" aria-modal="true" aria-labelledby="lab-manager-title"><header><div><span>Labs</span><h2 id="lab-manager-title">${uiCopy("프로젝트 Lab 편집", "Edit project Labs")}</h2><p>${uiCopy("여기서 추가한 Lab은 북마크입니다. Science는 연구에 필요할 때만 해당 Lab을 실행합니다.", "Added Labs are bookmarks. Science runs a Lab only when the research needs it.")}</p></div><button type="button" data-action="close-project-labs" aria-label="${uiCopy("Lab 편집 닫기", "Close Lab editor")}">×</button></header><div class="labManagerList">${rows}</div>${state.labManagerError ? `<p class="formError" role="alert">${escapeHtml(state.labManagerError)}</p>` : ""}<footer><span>${uiCopy("Lab을 제거해도 기존 아티팩트와 기록은 삭제되지 않습니다.", "Removing a Lab does not delete its existing artifacts or records.")}</span><button class="primaryButton" type="button" data-action="close-project-labs">${uiCopy("완료", "Done")}</button></footer></section></div>`;
  }

  async function toggleProjectLabBookmark(labId, enabled) {
    const projectId = state.selectedId;
    if (!projectId || state.labManagerBusyId) return;
    const generation = state.labManagerGeneration;
    const existing = state.workspaceLabBindings.find((binding) => binding.labId === labId) || null;
    state.labManagerBusyId = labId;
    state.labManagerError = "";
    render();
    try {
      await science.labs.upsertBinding({
        requestId: crypto.randomUUID(),
        projectId,
        labId,
        enabled,
        pinned: existing?.pinned === true,
        ...(Number.isSafeInteger(existing?.displayOrder) ? { displayOrder: existing.displayOrder } : {}),
        activatedBy: existing?.activatedBy || "user",
        config: existing?.config && typeof existing.config === "object" ? existing.config : {},
      });
      if (state.selectedId !== projectId || state.labManagerGeneration !== generation) return;
      const [workspaceState, labs] = await Promise.all([science.workspace.get(projectId), science.labs.list(projectId)]);
      if (state.selectedId !== projectId || state.labManagerGeneration !== generation) return;
      state.workspaceLabBindings = Array.isArray(workspaceState?.labs) ? workspaceState.labs.filter((binding) => binding?.projectId === projectId) : [];
      state.labs = Array.isArray(labs) ? labs : [];
      if (!enabled) {
        state.workspaceTabs = state.workspaceTabs.filter((tab) => tab.kind !== "lab" || tab.labId !== labId);
        if (!state.workspaceTabs.some((tab) => tab.kind === "research")) state.workspaceTabs.unshift({ id: RESEARCH_TAB_ID, kind: "research", dirty: false });
        if (state.selectedLabId === labId || !state.workspaceTabs.some((tab) => tab.id === state.activeWorkspaceTabId)) {
          state.selectedLabId = null;
          state.selectedArtifactId = null;
          state.mode = "session";
          state.activeWorkspaceTabId = RESEARCH_TAB_ID;
        }
      }
      state.labManagerBusyId = null;
      render();
    } catch (error) {
      if (state.selectedId !== projectId || state.labManagerGeneration !== generation) return;
      state.labManagerBusyId = null;
      state.labManagerError = error instanceof Error ? error.message : String(error);
      render();
    }
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

  const analysisPlanReviewKey = (plan) => plan
    ? `${plan.id}:${plan.currentVersion}:${plan.currentDocumentSha256}:${plan.lockVersion}` : null;

  function reviewableAnalysisPlan() {
    const plan = analysisSpecById(state.selectedAnalysisPlanId) || state.analysisSpecs[0] || null;
    if (!plan || plan.status !== "draft") return null;
    const openDecisions = state.decisions.filter((decision) => decision.analysisSpecId === plan.id
      && ["queued", "presented", "deferred"].includes(decision.status));
    return openDecisions.length === 0 ? plan : null;
  }

  function maybePresentAnalysisPlanReview() {
    const plan = reviewableAnalysisPlan();
    const key = analysisPlanReviewKey(plan);
    if (!plan || !key || plan.latestReview?.decision === "revise" || state.analysisPlanReviewDismissedKey === key) return;
    state.selectedAnalysisPlanId = plan.id;
    state.analysisPlanReviewSheet = true;
    state.analysisPlanReviewError = "";
  }

  function analysisPlanReviewMissingReasons(document) {
    const reasons = [];
    if (!document?.estimand) reasons.push(uiCopy("분석 대상과 측정값", "estimand and outcome measure"));
    if (!document?.design || document.design.dependence?.kind === "unresolved") reasons.push(uiCopy("반복·군집 구조", "dependence structure"));
    if (!document?.missingData || document.missingData.strategy === "unresolved") reasons.push(uiCopy("결측값 처리", "missing-data strategy"));
    if (!document?.multiplicity || document.multiplicity.strategy === "unresolved") reasons.push(uiCopy("다중 비교 처리", "multiplicity strategy"));
    if (!Array.isArray(document?.requiredDiagnostics) || document.requiredDiagnostics.length === 0) reasons.push(uiCopy("필수 진단", "required diagnostics"));
    const inputs = Array.isArray(document?.data?.inputs) ? document.data.inputs : [];
    const plannedSources = Array.isArray(document?.data?.acquisition?.sources) ? document.data.acquisition.sources : [];
    if (inputs.length === 0 && plannedSources.length === 0) reasons.push(uiCopy("고정된 입력 데이터 또는 사전 수집 계획", "pinned input data or a preregistered acquisition plan"));
    return reasons;
  }

  function analysisPlanReviewSheet() {
    if (!state.analysisPlanReviewSheet) return "";
    const plan = reviewableAnalysisPlan();
    if (!plan) return "";
    const document = plan.version?.document || {};
    const inputs = Array.isArray(document.data?.inputs) ? document.data.inputs : [];
    const plannedSources = Array.isArray(document.data?.acquisition?.sources) ? document.data.acquisition.sources : [];
    const missingReasons = analysisPlanReviewMissingReasons(document);
    const inputRows = inputs.length
      ? inputs.map((item) => `<li><strong>${escapeHtml(item.artifactId)} · v${escapeHtml(item.artifactVersion)}</strong><code title="${escapeHtml(item.contentSha256)}">${escapeHtml(String(item.contentSha256).slice(0, 16))}…</code></li>`).join("")
      : plannedSources.length
        ? plannedSources.map((source) => `<li class="analysisPlanReviewInputPlanned"><strong>${escapeHtml(source.provider)}</strong><span>${escapeHtml(source.expectedArtifactKind)}</span><span>${escapeHtml(source.retrievalPlan)}</span><code title="${escapeHtml(source.sourceRefs.join("\n"))}">${escapeHtml(uiCopy(`공식 출처 ${source.sourceRefs.length}개`, `${source.sourceRefs.length} source reference${source.sourceRefs.length === 1 ? "" : "s"}`))}</code></li>`).join("")
        : `<li class="analysisPlanReviewInputEmpty"><strong>${uiCopy("입력 데이터나 수집 계획이 없습니다.", "No input data or acquisition plan is defined.")}</strong><span>${uiCopy("수정 요청을 보내 정확한 입력 아티팩트 또는 공식 출처·수집 방법을 계획에 추가하세요.", "Request changes to add exact input artifacts or a plan with authoritative sources and a retrieval method.")}</span></li>`;
    const question = document.researchQuestion || uiCopy("정의되지 않음", "Not defined");
    const estimand = document.estimand
      ? `${document.estimand.population} · ${document.estimand.outcome} · ${document.estimand.summaryMeasure}`
      : uiCopy("아직 정하지 않음", "Not defined yet");
    const design = `${document.design?.studyType || uiCopy("미정", "Not set")} · ${document.design?.dependence?.kind || uiCopy("미정", "Not set")}`;
    const model = document.model
      ? `${document.model.family} · ${document.model.formula}`
      : uiCopy("분석 실행 단계에서 해당 도구가 모형을 확정합니다.", "The analysis tool will define the model when the analysis runs.");
    const incomplete = missingReasons.length
      ? `<div class="analysisPlanReviewIncomplete" role="status"><strong>${uiCopy("승인 전에 계획을 보완해야 합니다.", "This plan needs changes before it can be approved.")}</strong><span>${escapeHtml(missingReasons.join(" · "))}</span></div>` : "";
    return `<div class="chatQuestionScrim analysisPlanReviewScrim" role="presentation"><form class="bottomSheet analysisPlanReviewSheet" id="analysis-plan-review-form" role="dialog" aria-modal="true" aria-labelledby="analysis-plan-review-title" data-analysis-plan-id="${escapeHtml(plan.id)}" data-analysis-plan-version="${escapeHtml(plan.currentVersion)}" data-analysis-plan-sha256="${escapeHtml(plan.currentDocumentSha256)}" data-analysis-plan-lock-version="${escapeHtml(plan.lockVersion)}"><header><div><span>${uiCopy("사람 승인 · 현재 분석계획", "Human approval · current analysis plan")}</span><h2 id="analysis-plan-review-title">${uiCopy("이 분석계획을 승인하시겠습니까?", "Approve this analysis plan?")}</h2></div><button type="button" data-action="close-analysis-plan-review" aria-label="${uiCopy("분석계획 검토를 나중에 하기", "Review this analysis plan later")}">×</button></header><div class="analysisPlanReviewBody">${incomplete}<section class="analysisPlanReviewIdentity"><strong>${escapeHtml(plan.title)}</strong><dl><div><dt>${uiCopy("계획 ID", "Plan ID")}</dt><dd><code>${escapeHtml(plan.id)}</code></dd></div><div><dt>${uiCopy("버전", "Version")}</dt><dd>v${escapeHtml(plan.currentVersion)}</dd></div><div><dt>${uiCopy("콘텐츠 해시", "Content hash")}</dt><dd><code>${escapeHtml(plan.currentDocumentSha256)}</code></dd></div><div><dt>${uiCopy("변경 잠금", "Change lock")}</dt><dd>${escapeHtml(plan.lockVersion)}</dd></div></dl></section><section class="analysisPlanReviewSummary"><div><span>${uiCopy("연구 질문", "Research question")}</span><strong>${escapeHtml(question)}</strong></div><div><span>${uiCopy("분석 대상", "Estimand")}</span><strong>${escapeHtml(estimand)}</strong></div><div><span>${uiCopy("연구 설계", "Study design")}</span><strong>${escapeHtml(design)}</strong></div><div><span>${uiCopy("모형 설정", "Model setup")}</span><strong>${escapeHtml(model)}</strong></div></section><section class="analysisPlanReviewInputs"><span>${uiCopy(inputs.length ? "고정된 입력 데이터" : "사전 수집 계획", inputs.length ? "Pinned input data" : "Preregistered acquisition plan")}</span><ul>${inputRows}</ul></section><label class="decisionRationale"><span>${uiCopy("검토 의견", "Review note")} <em>${uiCopy("수정 요청 시 필수", "Required when requesting changes")}</em></span><textarea name="rationale" maxlength="8000" rows="3" placeholder="${uiCopy("승인 근거 또는 수정할 내용을 구체적으로 적어 주세요.", "Describe your approval rationale or the changes needed.")}"></textarea></label><div class="analysisPlanReviewBoundary"><strong>${uiCopy("승인은 AI 추천과 별개입니다.", "Your approval is separate from any AI recommendation.")}</strong><span>${uiCopy("승인하면 현재 버전과 해시가 고정됩니다. 수집 계획만 있는 경우에는 수집 후 정확한 입력 버전을 묶은 후속 계획을 다시 승인해야 분석을 실행할 수 있습니다.", "Approval pins the current version and hash. If this plan contains only an acquisition plan, analysis can run only after a successor plan binds the exact collected input versions and is approved again.")}</span></div><div class="formError" role="alert">${escapeHtml(state.analysisPlanReviewError)}</div></div><footer><button class="secondaryButton" type="submit" name="decision" value="revise" ${state.analysisPlanReviewBusy ? "disabled" : ""}>${uiCopy("수정 요청", "Request changes")}</button><button class="primaryButton" type="submit" name="decision" value="approve" ${state.analysisPlanReviewBusy || missingReasons.length ? "disabled" : ""} title="${missingReasons.length ? escapeHtml(uiCopy("필수 항목을 먼저 보완하세요.", "Complete the required plan fields first.")) : ""}">${state.analysisPlanReviewBusy ? uiCopy("저장 중…", "Saving…") : uiCopy("계획 승인", "Approve plan")}</button></footer></form></div>`;
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

  function runtimeQuestionMarkup() {
    const request = state.runtimeQuestions[0];
    if (!request) return "";
    const freeTextDraft = state.runtimeQuestionDraftRequestId === request.requestId ? state.runtimeQuestionDraft : "";
    const options = Array.isArray(request.options) ? request.options : [];
    const compact = options.length === 2
      && options.every((option) => !option.description && String(option.label || "").length <= 22);
    const optionRows = options.map((option, index) => `<button type="button" data-action="answer-runtime-question" data-runtime-question-answer="${escapeHtml(option.label)}" ${state.runtimeQuestionBusy ? "disabled" : ""}><span>${index + 1}</span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<em>${escapeHtml(option.description)}</em>` : ""}</button>`).join("");
    const freeText = request.allowFreeText
      ? `<form class="runtimeQuestionFreeText" id="runtime-question-form"><input name="answer" value="${escapeHtml(freeTextDraft)}" required maxlength="2000" autocomplete="off" placeholder="${uiCopy("직접 답하기", "Type an answer")}" aria-label="${uiCopy("직접 답하기", "Type an answer")}" ${state.runtimeQuestionBusy ? "disabled" : ""}><button type="submit" ${state.runtimeQuestionBusy ? "disabled" : ""}>${uiCopy("보내기", "Send")}</button></form>`
      : "";
    return `<div class="runtimeQuestionLayer" data-runtime-question-layer role="presentation"><section class="runtimeQuestionPopover" role="dialog" aria-modal="false" aria-labelledby="runtime-question-title" data-compact="${compact}" data-runtime-question-id="${escapeHtml(request.requestId)}"><header><span>${escapeHtml(request.askedBy || "Agentlas Science")}</span><button type="button" data-action="dismiss-runtime-question" aria-label="${uiCopy("질문 닫기", "Dismiss question")}" ${state.runtimeQuestionBusy ? "disabled" : ""}>×</button></header><p id="runtime-question-title">${escapeHtml(request.question)}</p><div class="runtimeQuestionOptions">${optionRows}</div>${freeText}${state.runtimeQuestionError ? `<div class="runtimeQuestionError" role="alert">${escapeHtml(state.runtimeQuestionError)}</div>` : ""}</section></div>`;
  }

  function syncRuntimeQuestionPopover() {
    document.querySelector("[data-runtime-question-layer]")?.remove();
    if (runtimeQuestionTimer) window.clearTimeout(runtimeQuestionTimer);
    runtimeQuestionTimer = null;
    const request = state.runtimeQuestions[0];
    if (!request) {
      state.runtimeQuestionDraft = "";
      state.runtimeQuestionDraftRequestId = null;
      return;
    }
    if (state.runtimeQuestionDraftRequestId !== request.requestId) {
      state.runtimeQuestionDraft = "";
      state.runtimeQuestionDraftRequestId = request.requestId;
    }
    root.insertAdjacentHTML("beforeend", runtimeQuestionMarkup());
    const remaining = Math.max(0, Number(request.expiresAt) - Date.now());
    runtimeQuestionTimer = window.setTimeout(() => {
      state.runtimeQuestions = state.runtimeQuestions.filter((item) => item.requestId !== request.requestId);
      syncRuntimeQuestionPopover();
    }, remaining);
  }

  function receiveRuntimeQuestion(request) {
    if (!request || typeof request.requestId !== "string" || request.askedBy !== "agentlas-science") return;
    if (!Number.isFinite(Number(request.expiresAt)) || Number(request.expiresAt) <= Date.now()) {
      state.runtimeQuestions = state.runtimeQuestions.filter((item) => item.requestId !== request.requestId);
    } else if (!state.runtimeQuestions.some((item) => item.requestId === request.requestId)) {
      state.runtimeQuestions = [...state.runtimeQuestions, request];
      state.runtimeQuestionError = "";
    }
    syncRuntimeQuestionPopover();
  }

  async function answerRuntimeQuestion(answer) {
    const request = state.runtimeQuestions[0];
    if (!request || state.runtimeQuestionBusy) return;
    state.runtimeQuestionBusy = true;
    state.runtimeQuestionError = "";
    syncRuntimeQuestionPopover();
    try {
      const delivered = await science.questions.answer(request.requestId, typeof answer === "string" && answer.trim() ? answer.trim() : null);
      if (delivered !== true) throw new Error("science-runtime-question-answer-not-delivered");
      state.runtimeQuestions = state.runtimeQuestions.filter((item) => item.requestId !== request.requestId);
    } catch {
      state.runtimeQuestionError = uiCopy("답을 전달하지 못했습니다. 다시 선택해 주세요.", "The answer was not delivered. Choose again.");
    } finally {
      state.runtimeQuestionBusy = false;
      syncRuntimeQuestionPopover();
    }
  }

  function welcome() {
    return `<section class="welcome"><div class="welcomeInner"><div class="welcomeLabel">Agentlas Science</div><h1>질문에서 검증 가능한 연구까지.</h1><p>대화, 근거, 실험, 시각 자료와 논문을 하나의 로컬 연구 기록으로 연결합니다. 아직 생성된 연구는 없습니다.</p><button class="startButton" data-action="new">새 연구 시작</button></div>${modal()}</section>`;
  }

  const emptyProjectSummary = () => ({ fileCount: 0, dataCount: 0, analysisCount: 0, manuscriptCount: 0, pdfCount: 0 });

  function projectSummary(projectId) {
    return state.projectLibrarySummaries.get(projectId) || emptyProjectSummary();
  }

  function projectTemplate(project) {
    return researchTemplateById(project?.researchTemplateId || project?.initialLabId);
  }

  function projectMetricMarkup(summary, compact = false, available = true) {
    if (!available) {
      const label = state.projectLibrarySummaryState === "loading"
        ? uiCopy("집계 중", "Counting…")
        : uiCopy("집계 불가", "Counts unavailable");
      return `<span class="projectHubMetricUnavailable">${escapeHtml(label)}</span>`;
    }
    const items = [
      [uiCopy("파일", "Files"), summary.fileCount],
      [uiCopy("데이터", "Data"), summary.dataCount],
      [uiCopy("분석", "Analyses"), summary.analysisCount],
      [uiCopy("원고", "Manuscripts"), summary.manuscriptCount],
      ["PDF", summary.pdfCount],
    ];
    const visible = compact ? items.slice(0, 3) : items;
    return visible.map(([label, count]) => `<span><strong>${escapeHtml(count)}</strong><em>${escapeHtml(label)}</em></span>`).join("");
  }

  function projectHubSidebar(selectedProjectId, folderMode = false) {
    const query = state.librarySearch.trim().toLocaleLowerCase();
    const projects = state.projects.filter((project) => {
      if (!query) return true;
      const template = projectTemplate(project);
      return [project.title, project.question, template ? researchTemplateLabel(template) : domainLabel(project.domain)].some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
    const projectLinks = projects.map((project) => {
      return `<button type="button" data-action="${folderMode ? "open-sidebar-project" : "select-library-project"}" data-library-project-id="${escapeHtml(project.id)}" aria-current="${project.id === selectedProjectId ? "page" : "false"}"><span class="projectFolderGlyph" aria-hidden="true">${heroIcon("folder")}</span><span title="${escapeHtml(project.title)}">${escapeHtml(project.title)}</span></button>`;
    }).join("");
    const backToWorkLabel = uiCopy("Agentlas Work로 돌아가기", "Back to Agentlas Work");
    return `<aside class="projectHubSidebar"><header><span class="projectHubBrand"><img src="./assets/agentlas-mark.png" alt=""><strong>Agentlas <em>Science*</em></strong></span></header><button class="projectHubBack" type="button" data-action="back-to-work" aria-label="${backToWorkLabel}" title="${backToWorkLabel}"><strong>${backToWorkLabel}</strong></button><label class="projectHubSideSearch">${heroIcon("search")}<input type="search" data-project-search="side" value="${escapeHtml(state.librarySearch)}" placeholder="${uiCopy("프로젝트 검색", "Search projects")}" aria-label="${uiCopy("프로젝트 검색", "Search projects")}"></label><nav class="projectHubPrimaryNav" aria-label="${uiCopy("연구 보관함 메뉴", "Research library menu")}"><button type="button" class="isActive" data-action="back-to-projects">${heroIcon("grid")}<span>${uiCopy("프로젝트", "Projects")}</span></button><button type="button" data-action="new">${heroIcon("plus")}<span>${uiCopy("새 연구", "New research")}</span></button></nav><section class="projectHubProjectList"><header><strong>${uiCopy("프로젝트", "Projects")}</strong><span>${escapeHtml(state.projects.length)}</span></header><div>${projectLinks || `<p>${uiCopy("아직 프로젝트가 없습니다.", "No projects yet.")}</p>`}</div></section></aside>`;
  }

  function projectLibrary() {
    const query = state.librarySearch.trim().toLocaleLowerCase();
    const filteredProjects = state.projects.filter((project) => {
      if (!query) return true;
      const template = projectTemplate(project);
      return [project.title, project.question, template ? researchTemplateLabel(template) : domainLabel(project.domain)].some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
    const preferred = state.projects.find((project) => project.id === state.librarySelectedProjectId);
    const selectedProject = (preferred && (!query || filteredProjects.some((project) => project.id === preferred.id))) ? preferred : filteredProjects[0] || null;
    if (selectedProject && state.librarySelectedProjectId !== selectedProject.id) state.librarySelectedProjectId = selectedProject.id;
    const cards = filteredProjects.map((project) => {
      const summary = projectSummary(project.id);
      const template = projectTemplate(project);
      const fieldLabel = template ? researchTemplateLabel(template) : domainLabel(project.domain);
      return `<article class="projectHubCardWrap"><button class="projectHubCard" type="button" data-action="select-library-project" data-library-project-id="${escapeHtml(project.id)}" aria-pressed="${project.id === selectedProject?.id}"><span class="projectFolderGlyph" aria-hidden="true">${heroIcon("folder")}</span><span class="projectHubCardBody"><small>${escapeHtml(fieldLabel)}</small><strong title="${escapeHtml(project.title)}">${escapeHtml(project.title)}</strong><em title="${escapeHtml(project.question)}">${escapeHtml(project.question)}</em><span class="projectHubCardMetrics">${projectMetricMarkup(summary, true, state.projectLibrarySummaries.has(project.id))}</span></span></button><button class="projectHubCardMobileOpen" type="button" data-action="open-library-project" data-library-project-id="${escapeHtml(project.id)}">${uiCopy("프로젝트 폴더 열기", "Open folder")}${heroIcon("chevron-right")}</button></article>`;
    }).join("");
    const shortcutFields = researchTemplates.map((template) => `<button type="button" data-research-template="${escapeHtml(template.id)}" title="${escapeHtml(researchTemplateDescription(template))}"><img src="./assets/research-templates/${escapeHtml(template.id)}.png" alt=""><span>${escapeHtml(researchTemplateLabel(template))}</span></button>`).join("");
    const summary = selectedProject ? projectSummary(selectedProject.id) : emptyProjectSummary();
    const selectedTemplate = projectTemplate(selectedProject);
    const selectedFolderPath = typeof selectedProject?.folderPath === "string" ? selectedProject.folderPath : "";
    const folderFact = selectedFolderPath.trim() ? `<div><dt>${uiCopy("폴더", "Folder")}</dt><dd class="projectHubPathValue" title="${escapeHtml(selectedFolderPath)}">${escapeHtml(selectedFolderPath)}</dd></div>` : "";
    const detail = selectedProject ? `<div class="projectHubDetailHero"><span class="projectFolderDetailGlyph" aria-hidden="true">${heroIcon("folder")}</span><span class="projectHubDetailLabel">${escapeHtml(selectedTemplate ? researchTemplateLabel(selectedTemplate) : domainLabel(selectedProject.domain))}</span></div><h2>${escapeHtml(selectedProject.title)}</h2><p>${escapeHtml(selectedProject.question)}</p><dl class="projectHubFacts"><div><dt>${uiCopy("업데이트", "Updated")}</dt><dd>${escapeHtml(formatDate(selectedProject.updatedAt))}</dd></div><div><dt>${uiCopy("분야", "Field")}</dt><dd>${escapeHtml(selectedTemplate ? researchTemplateLabel(selectedTemplate) : domainLabel(selectedProject.domain))}</dd></div>${folderFact}</dl><div class="projectHubDetailMetrics">${projectMetricMarkup(summary, false, state.projectLibrarySummaries.has(selectedProject.id))}</div>${state.projectFolderOpenError ? `<p class="projectHubActionError" role="alert">${escapeHtml(state.projectFolderOpenError)}</p>` : ""}<div class="projectHubDetailActions">${selectedFolderPath.trim() ? `<button class="secondaryButton" type="button" data-action="open-project-folder-os" data-project-id="${escapeHtml(selectedProject.id)}" ${state.projectFolderOpenBusy ? "disabled" : ""}>${state.projectFolderOpenBusy ? uiCopy("폴더 여는 중…", "Opening folder…") : uiCopy("폴더 열기", "Open folder")}</button>` : ""}<button class="primaryButton" type="button" data-action="open-library-project" data-library-project-id="${escapeHtml(selectedProject.id)}">${uiCopy("프로젝트 내용 열기", "Open project contents")}${heroIcon("chevron-right")}</button></div>` : `<div class="projectHubDetailEmpty">${heroIcon("folder")}<strong>${uiCopy("프로젝트를 선택하세요", "Select a project")}</strong><span>${uiCopy("실제 프로젝트 정보와 저장 항목 수가 여기에 표시됩니다.", "Project metadata and saved-item counts appear here.")}</span></div>`;
    const projectCount = state.locale === "ko" ? `${filteredProjects.length}개 프로젝트` : `${filteredProjects.length} ${filteredProjects.length === 1 ? "project" : "projects"}`;
    return `<section class="projectHub">${projectHubSidebar(selectedProject?.id || null)}<main class="projectHubMain"><header class="projectHubHeading"><div><span>Research library</span><h1>${uiCopy("연구 프로젝트", "Research projects")}</h1><p>${uiCopy("근거, 데이터, 분석과 원고가 연결된 프로젝트를 엽니다.", "Open projects that connect evidence, data, analysis, and manuscripts.")}</p></div><button class="primaryButton" type="button" data-action="new">${heroIcon("plus")}${uiCopy("새 연구", "New research")}</button></header><label class="projectHubMainSearch">${heroIcon("search")}<input type="search" data-project-search="main" value="${escapeHtml(state.librarySearch)}" placeholder="${uiCopy("이름, 질문 또는 분야로 검색", "Search by name, question, or field")}" aria-label="${uiCopy("연구 프로젝트 검색", "Search research projects")}"><span>${escapeHtml(projectCount)}</span></label><div class="projectHubGrid">${cards || `<div class="projectHubEmpty"><strong>${query ? uiCopy("검색 결과가 없습니다.", "No matching projects.") : uiCopy("아직 연구 프로젝트가 없습니다.", "No research projects yet.")}</strong><span>${query ? uiCopy("다른 이름이나 분야를 검색해 보세요.", "Try another project name or field.") : uiCopy("15개 연구 분야 중 하나를 골라 시작하세요.", "Choose one of 15 research fields to begin.")}</span>${query ? "" : `<button class="secondaryButton" type="button" data-action="new">${uiCopy("새 연구 시작", "Start new research")}</button>`}</div>`}</div><section class="projectHubShortcuts"><header><h2>${uiCopy("연구 분야 바로가기", "Research field shortcuts")}</h2><span>${uiCopy("15개 분야", "15 fields")}</span></header><div>${shortcutFields}</div></section></main><aside class="projectHubDetail" aria-label="${uiCopy("선택한 프로젝트 상세", "Selected project details")}"><header><span>${uiCopy("프로젝트 상세", "Project details")}</span></header>${detail}</aside>${modal()}</section>`;
  }

  function projectFolderRows() {
    const rows = [];
    for (const source of state.sources) {
      rows.push({
        key: `source:${source.id}`,
        kind: source.kind === "dataset" ? uiCopy("데이터", "Data") : uiCopy("출처", "Source"),
        icon: source.kind === "dataset" ? "table" : "book",
        title: source.title || source.url || source.id,
        detail: `${source.kind || "source"} · v${source.currentVersion || source.version?.version || 1}`,
        byteSize: source.byteSize ?? source.version?.byteSize ?? null,
        stamp: source.updatedAt || source.createdAt,
        action: `data-action="open-project-folder-source" data-source-id="${escapeHtml(source.id)}"`,
      });
    }
    for (const figure of state.sourceFigures) {
      rows.push({
        key: `source-figure:${figure.id}`,
        kind: uiCopy("그림", "Figure"),
        icon: "photo",
        title: figure.figureLabel || figure.caption || figure.locator || figure.id,
        detail: `${figure.mimeType || "image"} · ${figure.width || 0}×${figure.height || 0}`,
        byteSize: figure.byteSize,
        stamp: figure.createdAt,
        action: `data-action="open-project-folder-source" data-source-id="${escapeHtml(figure.sourceId)}"`,
      });
    }
    for (const run of state.runs.filter((item) => item?.status === "succeeded")) {
      rows.push({
        key: `run:${run.id}`,
        kind: uiCopy("분석", "Analysis"),
        icon: "chart",
        title: run.title || run.toolId || run.kind || uiCopy("성공한 분석 실행", "Successful analysis run"),
        detail: `${run.status} · ${String(run.id || "").slice(0, 8)}…`,
        byteSize: Array.isArray(run.outputs) && run.outputs.length && run.outputs.every((item) => Number.isFinite(Number(item?.byteSize)))
          ? run.outputs.reduce((total, item) => total + Number(item.byteSize), 0) : null,
        stamp: run.completedAt || run.updatedAt || run.createdAt,
        action: `data-action="open-project-folder-destination" data-destination="analysis-runs"`,
      });
    }
    for (const artifact of state.artifacts.filter((item) => item?.status === "ready")) {
      const labId = labForArtifact(artifact.id);
      rows.push({
        key: `artifact:${artifact.id}`,
        kind: artifact.kind === "table" ? uiCopy("표", "Table") : artifact.kind === "figure" ? uiCopy("그림", "Figure") : uiCopy("결과", "Result"),
        icon: artifact.kind === "table" ? "table" : artifact.kind === "figure" ? "photo" : "chart",
        title: artifact.title || artifact.id,
        detail: `${labId ? labLabel(labId) : artifact.kind || "artifact"} · v${artifact.currentVersion || artifact.version?.version || 1}`,
        byteSize: artifact.byteSize ?? artifact.version?.byteSize ?? null,
        stamp: artifact.updatedAt || artifact.createdAt,
        action: labId
          ? `data-action="open-project-folder-artifact" data-lab-id="${escapeHtml(labId)}" data-artifact-id="${escapeHtml(artifact.id)}"`
          : `data-action="open-project-folder-destination" data-destination="results"`,
      });
    }
    for (const manuscript of state.manuscripts) {
      rows.push({
        key: `manuscript:${manuscript.id}`,
        kind: uiCopy("원고", "Manuscript"),
        icon: "book",
        title: manuscript.title || manuscript.id,
        detail: `v${manuscript.currentVersion || manuscript.version?.version || 1}`,
        byteSize: manuscript.version?.markdown ? new TextEncoder().encode(manuscript.version.markdown).byteLength : null,
        stamp: manuscript.updatedAt || manuscript.createdAt,
        action: `data-action="open-project-folder-manuscript" data-manuscript-id="${escapeHtml(manuscript.id)}"`,
      });
    }
    for (const submission of state.submissionExports.filter((item) => item?.status === "ready")) {
      rows.push({
        key: `submission:${submission.id}`,
        kind: "PDF",
        icon: "arrow-down-tray",
        title: submission.fileName || uiCopy("검증된 제출 패키지", "Verified submission package"),
        detail: `${submission.manuscriptTitle || uiCopy("원고", "Manuscript")} · ${String(submission.packageSha256 || "").slice(0, 12)}…`,
        byteSize: submission.packageByteSize,
        stamp: submission.createdAt,
        action: `data-action="open-project-folder-export" data-manuscript-id="${escapeHtml(submission.manuscriptId || "")}" data-export-id="${escapeHtml(submission.id)}"`,
      });
    }
    return rows.sort((left, right) => String(right.stamp || "").localeCompare(String(left.stamp || "")) || left.key.localeCompare(right.key));
  }

  function projectFolder(project) {
    const template = researchTemplateById(project.researchTemplateId || project.initialLabId);
    const summary = projectSummary(project.id);
    const rows = state.loadingProject ? [] : projectFolderRows();
    const selectedRow = rows.find((row) => row.key === state.projectFolderSelectedKey) || rows[0] || null;
    if (selectedRow && state.projectFolderSelectedKey !== selectedRow.key) state.projectFolderSelectedKey = selectedRow.key;
    const fileRows = rows.map((row) => `<button class="projectHubFileCard" type="button" data-action="select-project-folder-item" data-folder-item-key="${escapeHtml(row.key)}" aria-pressed="${row.key === selectedRow?.key}"><span class="projectHubFileIcon">${heroIcon(row.icon)}</span><span><small>${escapeHtml(row.kind)}</small><strong title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</strong><em>${escapeHtml(row.detail)}</em></span><time>${escapeHtml(formatDate(row.stamp))}</time></button>`).join("");
    const body = state.loadingProject
      ? `<div class="projectHubEmpty" aria-live="polite"><strong>${uiCopy("프로젝트 내용을 불러오는 중…", "Loading project contents…")}</strong></div>`
      : state.projectError
        ? `<div class="projectHubEmpty" role="alert"><strong>${escapeHtml(state.projectError)}</strong></div>`
        : fileRows || `<div class="projectHubEmpty"><strong>${uiCopy("아직 저장된 연구 내용이 없습니다.", "No research contents have been saved yet.")}</strong><span>${uiCopy("워크스페이스에서 출처를 추가하거나 Lab을 실행하면 실제 기록이 나타납니다.", "Add a source or run a Lab in the workspace to create a real record.")}</span></div>`;
    const detail = selectedRow ? `<span class="projectHubDetailKind">${escapeHtml(selectedRow.kind)}</span><h2>${escapeHtml(selectedRow.title)}</h2><p>${escapeHtml(selectedRow.detail)}</p><dl class="projectHubFacts"><div><dt>${uiCopy("크기", "Size")}</dt><dd>${escapeHtml(formatByteSize(selectedRow.byteSize))}</dd></div><div><dt>${uiCopy("수정일", "Modified")}</dt><dd>${escapeHtml(formatDate(selectedRow.stamp))}</dd></div></dl><div class="projectHubDetailActions"><button class="primaryButton" type="button" ${selectedRow.action}>${uiCopy("작업공간에서 열기", "Open workspace")}${heroIcon("chevron-right")}</button></div>` : `<div class="projectHubDetailEmpty">${heroIcon("folder")}<strong>${uiCopy("저장 항목이 없습니다", "No saved items")}</strong><span>${uiCopy("새 출처나 분석 결과가 저장되면 여기에 표시됩니다.", "Saved sources and results will appear here.")}</span></div>`;
    return `<section class="projectHub projectHubFolder">${projectHubSidebar(project.id, true)}<main class="projectHubMain"><header class="projectHubHeading projectHubFolderHeading"><div><button class="projectHubInlineBack" type="button" data-action="back-to-projects">${heroIcon("chevron-right", "uiIcon isReverse")}${uiCopy("프로젝트", "Projects")}</button><span>${escapeHtml(template ? researchTemplateLabel(template) : domainLabel(project.domain))}</span><h1>${escapeHtml(project.title)}</h1><p>${escapeHtml(project.question)}</p></div><button class="primaryButton" type="button" data-action="open-project-workspace">${uiCopy("워크스페이스 열기", "Open workspace")}${heroIcon("chevron-right")}</button></header><div class="projectHubFolderMetrics">${projectMetricMarkup(summary, false, state.projectLibrarySummaries.has(project.id))}</div><section class="projectHubFiles"><header><h2>${uiCopy("저장된 연구 내용", "Saved research contents")}</h2><span>${escapeHtml(uiCopy(`${rows.length}개 항목`, `${rows.length} ${rows.length === 1 ? "item" : "items"}`))}</span></header><div class="projectHubFileGrid">${body}</div></section></main><aside class="projectHubDetail" aria-label="${uiCopy("선택한 항목 상세", "Selected item details")}"><header><span>${uiCopy("항목 상세", "Item details")}</span></header>${detail}</aside>${modal()}</section>`;
  }

  function workspace() {
    const project = selectedProject();
    if (!project) return projectLibrary();
    if (state.projectFolderOpen) return projectFolder(project);
    const main = state.mode === "session" ? researchView(project) : state.mode === "manuscript" ? manuscriptWorkbench() : artifactWorkbench();
    const loopPresentation = researchLoopPresentation();
    const statusTitle = loopPresentation?.attention
      ? `${loopPresentation.detail} · ${lifecycleLabel()} · ${state.lifecycle?.stateSha256 || ""}`
      : `${lifecycleLabel()} · ${state.lifecycle?.stateSha256 || ""}`;
    const sidebarToggleLabel = state.railCollapsed ? uiCopy("사이드바 열기", "Open sidebar") : uiCopy("사이드바 닫기", "Close sidebar");
    const sidebarToggleAction = state.railCollapsed ? "expand-rail" : "collapse-rail";
    const sidebarToggleIcon = heroIcon("chevron-right", state.railCollapsed ? "uiIcon" : "uiIcon isReverse");
    return `<section class="workspace ${state.drawer ? "drawerOpen" : ""}" data-workspace-mode="${escapeHtml(state.mode)}" data-project-destination="${escapeHtml(state.currentDestination)}" data-rail-collapsed="${state.railCollapsed}">${projectRail(project)}<button class="railScrim" data-action="collapse-rail" aria-label="사이드바 닫기"></button><main class="mainPane"><header class="topbar"><div class="topLocation workspaceLocation"><button class="workspaceSidebarReveal" data-action="${sidebarToggleAction}" aria-label="${sidebarToggleLabel}" title="${sidebarToggleLabel}">${sidebarToggleIcon}</button><div class="workspaceTabGroup" role="tablist" aria-label="연구, 열린 Lab 아티팩트와 원고">${researchWorkspaceTabButton()}<div class="workspaceTabsShell" data-workspace-tabs-shell><button class="workspaceTabOverflow workspaceTabOverflowPrevious" type="button" data-action="scroll-workspace-tabs" data-direction="previous" aria-label="이전 열린 탭 보기" hidden>${heroIcon("chevron-right", "uiIcon isReverse")}</button><nav class="workspaceTabs" data-workspace-tabs role="presentation">${workspaceTabButtons()}</nav><button class="workspaceTabOverflow workspaceTabOverflowNext" type="button" data-action="scroll-workspace-tabs" data-direction="next" aria-label="다음 열린 탭 보기" hidden>${heroIcon("chevron-right")}</button></div></div><button class="workspaceTabAdd" data-action="new" aria-label="새 연구 시작" title="새 연구">${heroIcon("plus")}</button></div><div class="topActions">${state.workspaceSyncError ? `<span class="workspaceSyncWarning" role="status" title="${escapeHtml(state.workspaceSyncError)}">저장 실패</span>` : ""}<span class="statusPill" data-tone="${loopPresentation?.attention ? "manual" : "pass"}" title="${escapeHtml(statusTitle)}">${escapeHtml(lifecycleCompactLabel())}</span><button data-action="toggle-drawer">${state.mode === "session" ? "근거" : "세부"}</button></div></header><div class="workspaceBody"><div class="contentPane workspaceCenter"><div class="workspaceSurface" id="science-workspace-panel" role="tabpanel" aria-labelledby="${escapeHtml(workspaceTabDomId(state.activeWorkspaceTabId))}" data-workspace-surface>${main}</div></div>${chatDock()}</div></main>${contextDrawer()}${modal()}${labManagerModal()}${manuscriptModal()}${journalTargetSheet()}${submissionExportSheet()}${evidenceGraphInferenceReviewSheet()}${episodeResultReviewSheet()}${researchContractApprovalSheet()}${researchDecisionSheet()}${analysisPlanReviewSheet()}</section>`;
  }

  function rememberScroll(mode = state.mode) {
    const pane = document.querySelector(".contentPane");
    if (pane) state.scrollByMode[mode] = pane.scrollTop;
  }

  function render() {
    rememberChatScroll();
    if (state.drawer && window.matchMedia("(max-width: 680px)").matches) state.railCollapsed = true;
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
    restoreChatScroll();
    const contentPane = document.querySelector(".contentPane");
    if (contentPane) contentPane.scrollTop = state.scrollByMode[state.mode] || 0;
    if (state.modal) document.querySelector('input[name="title"]')?.focus();
    if (state.researchContractSheet) requestAnimationFrame(() => document.querySelector(".researchContractSheet")?.focus({ preventScroll: true }));
    if (state.analysisPlanReviewSheet) requestAnimationFrame(() => document.querySelector(".analysisPlanReviewSheet textarea")?.focus({ preventScroll: true }));
    if (!state.resultReviewSheet && state.mode === "lab" && state.selectedArtifactId && state.artifactHistoryById.has(state.selectedArtifactId)) {
      void hydrateArtifactRenderer();
      if (state.artifactComparison?.diff) void hydrateArtifactComparePreviews(state.artifactComparison);
    }
    if (state.mode === "session") {
      void hydrateInlineArtifactRenderers();
      void hydrateEvidenceGraph();
    }
    syncRailPresentation();
    syncRuntimeQuestionPopover();
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
    const sidebarToggle = workspaceNode.querySelector('.workspaceSidebarReveal');
    if (sidebarToggle) {
      const label = state.railCollapsed ? uiCopy("사이드바 열기", "Open sidebar") : uiCopy("사이드바 닫기", "Close sidebar");
      sidebarToggle.dataset.action = state.railCollapsed ? "expand-rail" : "collapse-rail";
      sidebarToggle.setAttribute("aria-label", label);
      sidebarToggle.setAttribute("title", label);
      sidebarToggle.setAttribute("aria-expanded", String(!state.railCollapsed));
    }
    const overlayOpen = !state.railCollapsed && window.matchMedia("(max-width: 680px)").matches;
    if (overlayOpen || state.resultReviewSheet) main.setAttribute("inert", "");
    else main.removeAttribute("inert");
  }

  function setRailCollapsed(collapsed) {
    state.railCollapsed = Boolean(collapsed);
    try { window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, String(state.railCollapsed)); } catch {}
    syncRailPresentation();
    requestAnimationFrame(syncWorkspaceTabOverflow);
    window.setTimeout(syncWorkspaceTabOverflow, 220);
    document.querySelector('.workspaceSidebarReveal')?.focus();
  }

  function teardownArtifactRenderer(preserveNativeRenderer = false) {
    document.querySelectorAll("[data-artifact-host]").forEach((host) => host.__scienceVisualViewerCleanup?.());
    for (const view of state.inlineVegaViews) { try { view.finalize(); } catch {} }
    state.inlineVegaViews = [];
    for (const url of state.inlinePreviewUrls) { try { URL.revokeObjectURL(url); } catch {} }
    state.inlinePreviewUrls = [];
    disposeComparePreviews();
    if (state.activeVegaView) { try { state.activeVegaView.finalize(); } catch {} state.activeVegaView = null; }
    if (state.activeCytoscape) { try { state.activeCytoscape.destroy(); } catch {} state.activeCytoscape = null; }
    if (state.activeNumericSurface) { try { state.activeNumericSurface.dispose(); } catch {} state.activeNumericSurface = null; }
    if (state.activeSpatialScene) { try { state.activeSpatialScene.dispose(); } catch {} state.activeSpatialScene = null; }
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

  function setInlineArtifactPreviewState(host, stateName) {
    if (!host?.isConnected) return;
    const card = host.closest(".inlineArtifact");
    const retry = host.closest(".inlineArtifactItem")?.querySelector(".inlineArtifactRetry");
    host.dataset.renderFailed = "true";
    host.dataset.previewMissing = "true";
    const status = document.createElement("span");
    status.className = "inlineArtifactPreviewStatus";
    status.textContent = stateName === "loading"
      ? uiCopy("미리보기를 다시 불러오는 중…", "Reloading preview…")
      : uiCopy("미리보기를 불러오지 못했습니다.", "Preview unavailable.");
    host.replaceChildren(status);
    if (card) {
      card.setAttribute("aria-busy", String(stateName === "loading"));
    }
    if (retry) {
      retry.hidden = false;
      retry.disabled = stateName === "loading";
      retry.textContent = stateName === "loading"
        ? uiCopy("다시 불러오는 중…", "Retrying…")
        : uiCopy("미리보기 다시 시도", "Retry preview");
    }
  }

  function clearInlineArtifactPreviewState(host) {
    delete host.dataset.renderFailed;
    delete host.dataset.previewMissing;
    const card = host.closest(".inlineArtifact");
    const retry = host.closest(".inlineArtifactItem")?.querySelector(".inlineArtifactRetry");
    if (!card) return;
    card.removeAttribute("aria-busy");
    if (retry) {
      retry.hidden = true;
      retry.disabled = false;
    }
  }

  async function hydrateInlineArtifactPreview(host) {
    if (!host?.isConnected || host.dataset.previewLoading === "true") return;
    const isVega = host.matches("[data-inline-vega-artifact]");
    host.dataset.previewLoading = "true";
    setInlineArtifactPreviewState(host, "loading");
    let view = null;
    try {
      if (isVega) {
        if (!window.vega || !window.vegaExpressionInterpreter) throw new Error("science-vega-runtime-unavailable");
        const artifactId = host.dataset.inlineVegaArtifact;
        const artifactVersion = Number(host.dataset.inlineVegaVersion);
        const context = [...state.artifactContextsByMessage.values()].flat().find((item) => item.artifact.id === artifactId && item.selectedVersion.version === artifactVersion);
        const spec = context?.selectedVersion?.payload?.spec;
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("science-vega-spec-invalid");
        host.replaceChildren();
        const runtime = window.vega.parse(compileArtifactVegaSpec(spec), undefined, { ast: true });
        view = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(host).hover();
        const width = Math.max(220, Math.floor(host.getBoundingClientRect().width) - 110);
        view.width(width).height(230);
        await view.runAsync();
        if (!host.isConnected) { try { view.finalize(); } catch {} return; }
        fitArtifactVegaCanvas(host, { gutter: 8, maxHeight: 230 });
        state.inlineVegaViews.push(view);
        view = null;
      } else {
        const preview = await science.artifacts.preview(state.selectedId, host.dataset.inlineCaptureArtifact, Number(host.dataset.inlineCaptureVersion));
        if (!preview?.bytes) throw new Error("science-artifact-preview-unavailable");
        if (!host.isConnected) return;
        const bytes = preview.bytes instanceof Uint8Array ? preview.bytes : new Uint8Array(preview.bytes);
        const url = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType || "image/png" }));
        state.inlinePreviewUrls.push(url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = host.getAttribute("aria-label") || "Lab artifact preview";
        image.width = preview.width;
        image.height = preview.height;
        host.replaceChildren(image);
      }
      clearInlineArtifactPreviewState(host);
    } catch {
      try { view?.finalize(); } catch {}
      setInlineArtifactPreviewState(host, "failed");
    } finally {
      delete host.dataset.previewLoading;
    }
  }

  async function hydrateInlineArtifactRenderers() {
    const hosts = [...document.querySelectorAll("[data-inline-vega-artifact], [data-inline-capture-artifact]")];
    for (const host of hosts) {
      await hydrateInlineArtifactPreview(host);
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
    let restoreInteractiveView = null;
    let captureLayoutError = null;
    if (view === "figure") {
      if (!window.vega || !window.vegaExpressionInterpreter) throw new Error("science-paleontology-vega-runtime-missing");
      content.classList.add("statisticsChartHost");
      const sourceSpec = compileArtifactVegaSpec(payload.spec);
      const chartStyle = getComputedStyle(content);
      const horizontalPadding = (Number.parseFloat(chartStyle.paddingLeft) || 0) + (Number.parseFloat(chartStyle.paddingRight) || 0);
      const availableWidth = Math.max(1, content.clientWidth - horizontalPadding);
      const displaySpec = interactive ? paleontologyInteractiveSpec(sourceSpec, availableWidth) : sourceSpec;
      content.dataset.vegaDisplayLayout = interactive ? "responsive" : "source";
      const runtime = window.vega.parse(displaySpec, undefined, { ast: true });
      state.activeVegaView = new window.vega.View(runtime, { expr: window.vegaExpressionInterpreter }).renderer("canvas").initialize(content).hover();
      await state.activeVegaView.runAsync();
      const canvas = content.querySelector("canvas");
      if (!canvas) throw new Error("science-paleontology-vega-canvas-missing");
      canvas.style.maxWidth = "none";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // The verification capture remains fitted. The interactive Lab restores
      // the exact responsive Vega dimensions afterwards so the first view is
      // readable while the full interval set remains available to inspect.
      if (interactive) restoreInteractiveView = () => {
        if (!canvas.isConnected) return;
        canvas.style.width = `${canvas.dataset.vegaNaturalCssWidth}px`;
        canvas.style.height = `${canvas.dataset.vegaNaturalCssHeight}px`;
        canvas.style.marginInline = "0";
        content.style.placeItems = "start";
        content.scrollTop = 0;
        content.scrollLeft = 0;
        content.dataset.interactiveChartScale = "1";
      };
      try {
        fitArtifactVegaCanvas(content, { capture: true, gutter: 10 });
      } catch (error) {
        if (!interactive) throw error;
        captureLayoutError = error;
        restoreInteractiveView?.();
      }
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
    return { view, rowCount: tablePayload.rows.length, columnCount: tablePayload.columns.length, restoreInteractiveView, captureLayoutError };
  }

  function renderDataTable(version, host, artifactId, interactive = true) {
    const actual = actualTablePayload(version);
    const payload = actual.payload;
    if (!payload) {
      host.dataset.tablePayloadCause = actual.cause;
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
    surface.dataset.tablePayloadShape = actual.sourceShape;
    const summary = document.createElement("header");
    summary.className = "dataTableSummary";
    const title = document.createElement("div");
    const kicker = document.createElement("span"); kicker.textContent = "SOURCE-BOUND DATA TABLE";
    const strong = document.createElement("strong"); strong.textContent = `${payload.profile.rowCount.toLocaleString()} rows · ${payload.profile.columnCount.toLocaleString()} columns`;
    title.append(kicker, strong);
    const receipts = document.createElement("div");
    const missing = document.createElement("span"); missing.textContent = `Missing ${payload.profile.nullCount.toLocaleString()}`;
    const formulas = document.createElement("span"); formulas.textContent = `Formula-like text ${payload.profile.formulaLikeCellCount.toLocaleString()}`;
    const hash = document.createElement("code");
    const exactHash = String(payload.receipts?.tableSha256 || actual.contentSha256 || "");
    hash.textContent = exactHash ? `${exactHash.slice(0, 12)}…` : "Hash unavailable";
    receipts.append(missing, formulas, hash);
    summary.append(title, receipts);
    const viewport = document.createElement("div");
    viewport.className = "dataTableViewport";
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of payload.columns) {
      const cell = document.createElement("th");
      const label = document.createElement("span"); label.textContent = column.label || column.name;
      const type = document.createElement("em"); type.textContent = `${column.logicalType}${column.unit ? ` · ${column.unit}` : ""}${column.nullable ? " · nullable" : ""}`;
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

  function spatialColor(value) {
    let hash = 2166136261;
    for (const character of String(value || "unknown")) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
    return new THREE.Color().setHSL(((hash >>> 0) % 360) / 360, .48, .5);
  }

  const isExactFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

  function renderScientificPointScene(host, {
    points, lines = [], title, subtitle, axisLabel, kind, lineColor = 0x8b8d89, grid = true, normalizePerAxis = false, returnView, returnLabel,
  }, interactive = true) {
    if (!Array.isArray(points) || !points.length) throw new Error("표시할 수 있는 검증된 3D 좌표가 없습니다.");
    const validPoints = points.filter((point) => Array.isArray(point.position) && point.position.length === 3
      && point.position.every(Number.isFinite) && Number.isFinite(point.radius) && point.radius > 0);
    const validLines = lines.filter((line) => Array.isArray(line) && line.length === 2
      && line.every((position) => Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)));
    if (!validPoints.length) throw new Error("표시할 수 있는 검증된 3D 좌표가 없습니다.");

    const surface = document.createElement("section"); surface.className = "scientific3dSurface"; surface.dataset.scienceCapture = "";
    const viewport = document.createElement("div"); viewport.className = "scientific3dViewport";
    const canvas = document.createElement("canvas"); canvas.className = "scientific3dCanvas"; canvas.tabIndex = interactive ? 0 : -1;
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", `${title}. ${axisLabel}`);
    const overlay = document.createElement("div"); overlay.className = "scientific3dOverlay";
    const heading = document.createElement("strong"); heading.textContent = title;
    const copy = document.createElement("span"); copy.textContent = subtitle;
    const axes = document.createElement("span"); axes.textContent = axisLabel;
    overlay.append(heading, copy, axes);
    const fallback = document.createElement("div"); fallback.className = "scientific3dFallback"; fallback.hidden = true;
    const fallbackTitle = document.createElement("strong"); fallbackTitle.textContent = "3D 보기를 사용할 수 없습니다";
    const fallbackCopy = document.createElement("span"); fallbackCopy.textContent = "WebGL/GPU 컨텍스트를 확인하거나 위의 2D 보기로 전환하세요.";
    fallback.append(fallbackTitle, fallbackCopy);
    const detail = document.createElement("aside"); detail.className = "scientific3dDetail"; detail.dataset.spatialPointDetail = ""; detail.dataset.selected = "false";
    const detailTitle = document.createElement("strong"); detailTitle.textContent = "점을 선택하세요";
    const detailCopy = document.createElement("span"); detailCopy.textContent = "검증된 원본 좌표와 측정값을 표시합니다.";
    detail.append(detailTitle, detailCopy);
    const footer = document.createElement("footer"); footer.className = "scientific3dFooter";
    const help = document.createElement("span"); help.textContent = interactive ? "드래그 · 휠 · 키보드 조작" : "읽기 전용 3D 보기";
    if (interactive) help.title = "드래그 회전 · Shift+드래그 이동 · 휠 확대 · 방향키 조작";
    const footerActions = document.createElement("div");
    if (returnView && returnLabel) {
      const leave = document.createElement("button"); leave.type = "button"; leave.textContent = returnLabel; leave.dataset.spatialView = returnView; leave.disabled = !interactive; footerActions.append(leave);
    }
    const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "3D 시야 초기화"; reset.disabled = !interactive;
    footerActions.append(reset); footer.append(help, footerActions); viewport.append(canvas, overlay, detail, fallback); surface.append(viewport, footer); host.replaceChildren(surface);

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    } catch {
      canvas.hidden = true; overlay.hidden = true; detail.hidden = true; fallback.hidden = false;
      help.textContent = "Three.js WebGL 초기화 실패 · 검증된 원본 데이터는 2D 보기에서 계속 사용할 수 있습니다.";
      reset.disabled = true; surface.dataset.webglState = "unavailable"; host.dataset.spatial3dReady = "false";
      return { available: false, dispose() {} };
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xf7f8f6, 1);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, .01, 100);
    const target = new THREE.Vector3();
    const defaultCamera = new THREE.Vector3(3.3, 2.6, 3.5);
    camera.position.copy(defaultCamera); camera.lookAt(target);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd5d8d2, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(4, 6, 3); scene.add(key);
    const fill = new THREE.DirectionalLight(0xb9d8ff, .85); fill.position.set(-4, 2, -4); scene.add(fill);

    const vectors = validPoints.map((point) => new THREE.Vector3(...point.position));
    for (const line of validLines) vectors.push(new THREE.Vector3(...line[0]), new THREE.Vector3(...line[1]));
    const bounds = new THREE.Box3().setFromPoints(vectors);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 2.6 / Math.max(size.x, size.y, size.z, 1e-9);
    const axisScale = new THREE.Vector3(
      2.6 / Math.max(size.x, 1e-9),
      2.6 / Math.max(size.y, 1e-9),
      2.6 / Math.max(size.z, 1e-9),
    );
    const normalized = (position) => {
      const vector = new THREE.Vector3(...position).sub(center);
      return normalizePerAxis ? vector.multiply(axisScale) : vector.multiplyScalar(scale);
    };
    const pointGeometry = new THREE.SphereGeometry(.052, 14, 10);
    const pointMaterial = new THREE.MeshStandardMaterial({ roughness: .62, metalness: .02, vertexColors: true });
    const pointMesh = new THREE.InstancedMesh(pointGeometry, pointMaterial, validPoints.length);
    const transform = new THREE.Matrix4();
    validPoints.forEach((point, index) => {
      const position = normalized(point.position);
      const radius = THREE.MathUtils.clamp(point.radius, .55, 2.8);
      transform.compose(position, new THREE.Quaternion(), new THREE.Vector3(radius, radius, radius));
      pointMesh.setMatrixAt(index, transform);
      pointMesh.setColorAt(index, point.color instanceof THREE.Color ? point.color : new THREE.Color(point.color));
    });
    pointMesh.instanceMatrix.needsUpdate = true;
    if (pointMesh.instanceColor) pointMesh.instanceColor.needsUpdate = true;
    scene.add(pointMesh);

    let lineGeometry = null; let lineMaterial = null;
    if (validLines.length) {
      const positions = new Float32Array(validLines.length * 6);
      validLines.forEach((line, index) => {
        positions.set(normalized(line[0]).toArray(), index * 6);
        positions.set(normalized(line[1]).toArray(), index * 6 + 3);
      });
      lineGeometry = new THREE.BufferGeometry(); lineGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      lineMaterial = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: .76 });
      scene.add(new THREE.LineSegments(lineGeometry, lineMaterial));
    }
    let gridHelper = null;
    if (grid) { gridHelper = new THREE.GridHelper(3, 12, 0xa0a6a0, 0xd9ddd8); gridHelper.position.y = normalized([center.x, bounds.max.y, center.z]).y; scene.add(gridHelper); }
    const axesHelper = new THREE.AxesHelper(1.35); axesHelper.position.set(-1.35, -1.2, 1.35); scene.add(axesHelper);

    let disposed = false; let queued = false; let pointer = null;
    const draw = () => { if (!disposed) renderer.render(scene, camera); };
    const requestDraw = () => { if (disposed || queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); };
    const resize = () => {
      const rect = viewport.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width)); const height = Math.max(320, Math.floor(rect.height));
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); requestDraw();
    };
    const resetView = () => { camera.position.copy(defaultCamera); target.set(0, 0, 0); camera.up.set(0, 1, 0); camera.lookAt(target); requestDraw(); };
    const orbit = (dx, dy) => {
      const offset = camera.position.clone().sub(target); const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * .008; spherical.phi = THREE.MathUtils.clamp(spherical.phi + dy * .008, .12, Math.PI - .12);
      camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical)); camera.lookAt(target); requestDraw();
    };
    const pan = (dx, dy) => {
      const amount = camera.position.distanceTo(target) * .0016;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * amount);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * amount);
      camera.position.add(right).add(up); target.add(right).add(up); camera.lookAt(target); requestDraw();
    };
    const zoom = (delta) => {
      const offset = camera.position.clone().sub(target).multiplyScalar(Math.exp(delta * .001));
      const length = THREE.MathUtils.clamp(offset.length(), .8, 14); offset.setLength(length);
      camera.position.copy(target).add(offset); camera.lookAt(target); requestDraw();
    };
    const selectAt = (event) => {
      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(mouse, camera);
      const hit = raycaster.intersectObject(pointMesh, false)[0];
      if (!hit || !Number.isSafeInteger(hit.instanceId)) return;
      const point = validPoints[hit.instanceId]; detail.replaceChildren();
      const selectedTitle = document.createElement("strong"); selectedTitle.textContent = point.label;
      const selectedCopy = document.createElement("span"); selectedCopy.textContent = point.detail;
      detail.append(selectedTitle, selectedCopy); detail.dataset.selected = "true";
    };
    const controller = new AbortController(); const signal = controller.signal;
    if (interactive) {
      canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
      canvas.addEventListener("pointerdown", (event) => {
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, pan: event.shiftKey || event.button === 2 };
        try { canvas.setPointerCapture(event.pointerId); } catch {}
      }, { signal });
      canvas.addEventListener("pointermove", (event) => {
        if (!pointer || pointer.id !== event.pointerId) return;
        const dx = event.clientX - pointer.x; const dy = event.clientY - pointer.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = true;
        pointer.x = event.clientX; pointer.y = event.clientY; if (pointer.pan) pan(dx, dy); else orbit(dx, dy);
      }, { signal });
      canvas.addEventListener("pointerup", (event) => { if (pointer?.id !== event.pointerId) return; const moved = pointer.moved; pointer = null; if (!moved) selectAt(event); }, { signal });
      canvas.addEventListener("pointercancel", () => { pointer = null; }, { signal });
      canvas.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY); }, { passive: false, signal });
      canvas.addEventListener("keydown", (event) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) event.preventDefault();
        if (event.key === "ArrowLeft") orbit(-12, 0); else if (event.key === "ArrowRight") orbit(12, 0);
        else if (event.key === "ArrowUp") orbit(0, -12); else if (event.key === "ArrowDown") orbit(0, 12);
        else if (event.key === "+" || event.key === "=") zoom(-90); else if (event.key === "-") zoom(90); else if (event.key === "Home") resetView();
      }, { signal });
      reset.addEventListener("click", resetView, { signal });
    }
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault(); surface.dataset.webglState = "lost"; canvas.hidden = true; overlay.hidden = true; detail.hidden = true; fallback.hidden = false;
      help.textContent = "WebGL context가 손실되었습니다. 위의 2D 보기로 전환하세요.";
    }, { signal });
    canvas.addEventListener("webglcontextrestored", () => {
      surface.dataset.webglState = "restored"; canvas.hidden = false; overlay.hidden = false; detail.hidden = false; fallback.hidden = true; resize();
    }, { signal });
    const observer = new ResizeObserver(resize); observer.observe(viewport); resize();
    host.dataset.spatial3dReady = "true"; host.dataset.spatial3dKind = kind; host.dataset.spatial3dPointCount = String(validPoints.length);
    return {
      available: true,
      dispose() {
        disposed = true; controller.abort(); observer.disconnect();
        pointGeometry.dispose(); pointMaterial.dispose(); lineGeometry?.dispose(); lineMaterial?.dispose();
        gridHelper?.geometry?.dispose?.(); gridHelper?.material?.dispose?.(); axesHelper.geometry.dispose(); axesHelper.material.dispose();
        renderer.renderLists?.dispose?.(); renderer.dispose(); renderer.forceContextLoss?.();
      },
    };
  }

  function materialCellLines(lattice) {
    if (!Array.isArray(lattice) || lattice.length !== 3 || lattice.some((row) => !Array.isArray(row) || row.length !== 3 || row.some((value) => !isExactFiniteNumber(value)))) return [];
    const a = [...lattice[0]]; const b = [...lattice[1]]; const c = [...lattice[2]];
    const add = (left, right) => left.map((value, index) => value + right[index]);
    const origin = [0, 0, 0]; const ab = add(a, b); const ac = add(a, c); const bc = add(b, c); const abc = add(ab, c);
    return [[origin, a], [origin, b], [origin, c], [a, ab], [a, ac], [b, ab], [b, bc], [c, ac], [c, bc], [ab, abc], [ac, abc], [bc, abc]];
  }

  function renderMaterialsDataset(version, host, artifactId, interactive = true) {
    const payload = version?.payload;
    const dataset = payload?.normalized;
    const tablePayload = dataset?.table;
    if (!payload || payload.schema !== "agentlas.science.materials-catalog-artifact/v1"
      || dataset?.schema !== "agentlas.materials.oqmd-optimade/v1" || tablePayload?.schema !== "agentlas.science-table/v1"
      || !Array.isArray(tablePayload.columns) || !Array.isArray(tablePayload.rows)) throw new Error("검증된 Materials structure payload가 없습니다.");
    const structures = Array.isArray(dataset.structures) ? dataset.structures : [];
    const renderable = structures.map((structure, index) => ({ structure, index })).filter(({ structure }) =>
      Array.isArray(structure?.cartesianSitePositions) && structure.cartesianSitePositions.length > 0
      && structure.cartesianSitePositions.every((position) => Array.isArray(position) && position.length === 3 && position.every(isExactFiniteNumber))
      && Array.isArray(structure.speciesAtSites) && structure.speciesAtSites.length === structure.cartesianSitePositions.length);
    const requestedStructureIndex = Number(state.materialsStructureIndexByArtifact.get(artifactId));
    const selectedEntry = renderable.find((entry) => entry.index === requestedStructureIndex) || renderable[0] || null;
    const requestedView = state.spatialViewByArtifact.get(artifactId);
    const activeView = !interactive || requestedView === "materials-table" || !selectedEntry ? "materials-table" : "materials-3d";
    const shell = document.createElement("section"); shell.className = "scientificArtifactShell"; shell.dataset.scientificView = activeView;
    const toolbar = document.createElement("div"); toolbar.className = "scientificViewToolbar";
    const modes = document.createElement("div"); modes.className = "scientificViewModes"; modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Materials 보기");
    const tableMode = document.createElement("button"); tableMode.type = "button"; tableMode.textContent = "구조 목록"; tableMode.dataset.spatialView = "materials-table"; tableMode.setAttribute("aria-pressed", String(activeView === "materials-table")); tableMode.disabled = !interactive;
    const structureMode = document.createElement("button"); structureMode.type = "button"; structureMode.textContent = "원자·격자 3D"; structureMode.dataset.spatialView = "materials-3d"; structureMode.setAttribute("aria-pressed", String(activeView === "materials-3d")); structureMode.disabled = !interactive || !renderable.length;
    modes.append(tableMode, structureMode); toolbar.append(modes);
    if (renderable.length) {
      const label = document.createElement("label"); const labelText = document.createElement("span"); labelText.textContent = "결정 구조";
      const select = document.createElement("select"); select.dataset.materialsStructureIndex = ""; select.disabled = !interactive;
      renderable.forEach(({ structure, index }) => {
        const option = document.createElement("option"); option.value = String(index); option.selected = index === selectedEntry?.index;
        option.textContent = `${structure.formulaReduced || structure.formulaDescriptive || structure.id} · ${structure.cartesianSitePositions.length} sites`;
        select.append(option);
      });
      label.append(labelText, select); toolbar.append(label);
    }
    const bodyHost = document.createElement("div"); bodyHost.className = "scientificViewBody";
    shell.append(toolbar, bodyHost); host.replaceChildren(shell);
    if (activeView === "materials-3d" && selectedEntry) {
      const structure = selectedEntry.structure;
      const points = structure.cartesianSitePositions.map((position, index) => {
        const species = String(structure.speciesAtSites[index] || "unknown");
        return {
          position: [...position], color: spatialColor(species), radius: 1,
          label: `${species} · site ${index + 1}`,
          detail: `Cartesian ${position.map((value) => value.toPrecision(7)).join(", ")} Å · OQMD ${structure.id}`,
        };
      });
      state.activeSpatialScene = renderScientificPointScene(bodyHost, {
        points, lines: materialCellLines(structure.latticeVectors), kind: "materials-structure",
        title: `${structure.formulaReduced || structure.formulaDescriptive || structure.id} crystal structure`,
        subtitle: `${points.length.toLocaleString()} exact Cartesian sites · OQMD OPTIMADE ${structure.id}`,
        axisLabel: "X · Y · Z = Cartesian Å · 선 = lattice vectors", grid: false, returnView: "materials-table", returnLabel: "구조 목록",
      }, interactive);
      if (interactive) resetArtifactViewScroll();
      host.dataset.materialsReady = String(state.activeSpatialScene.available); host.dataset.materialsView = "structure-3d"; host.dataset.materialsStructureId = String(structure.id);
      return { rowCount: tablePayload.rows.length, columnCount: tablePayload.columns.length, page: 0, pageCount: 1, view: "structure-3d" };
    }
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
    controls.append(previous, current, next); footer.append(provenance, controls); surface.append(summary, viewport, footer); bodyHost.replaceChildren(surface);
    host.dataset.materialsReady = "true"; host.dataset.materialsView = "table";
    return { rowCount: tablePayload.rows.length, columnCount: tablePayload.columns.length, page, pageCount };
  }

  function renderEarthquakeDepth3d(version, host, interactive = true) {
    const catalog = version?.payload?.catalog;
    if (catalog?.provider !== "usgs-fdsn-event" || !Array.isArray(catalog.events)) throw new Error("검증된 USGS 지진 좌표가 없습니다.");
    const events = catalog.events.filter((event) => isExactFiniteNumber(event.longitude) && isExactFiniteNumber(event.latitude) && isExactFiniteNumber(event.depthKm));
    if (!events.length) throw new Error("3D로 표시할 수 있는 지진 좌표가 없습니다.");
    const depths = events.map((event) => event.depthKm);
    const minimumDepth = Math.min(...depths); const maximumDepth = Math.max(...depths); const depthRange = Math.max(1e-9, maximumDepth - minimumDepth);
    const points = events.map((event) => {
      const depth = event.depthKm; const magnitude = isExactFiniteNumber(event.magnitude) ? event.magnitude : null;
      const ratio = (depth - minimumDepth) / depthRange;
      return {
        position: [event.longitude, -depth, event.latitude],
        color: new THREE.Color().setHSL(.5 - ratio * .42, .62, .43),
        radius: magnitude !== null ? .65 + THREE.MathUtils.clamp((magnitude + 2) / 12, 0, 1) * 1.55 : .65,
        label: event.place || event.id,
        detail: `M${magnitude ?? "—"} · depth ${depth.toLocaleString("en-US", { maximumFractionDigits: 3 })} km · ${event.latitude.toFixed(5)}°, ${event.longitude.toFixed(5)}° · ${event.time}`,
      };
    });
    const scene = renderScientificPointScene(host, {
      points, kind: "earthquake-depth", title: "USGS earthquake depth volume",
      subtitle: `${points.length.toLocaleString()} exact events · depth ${minimumDepth.toLocaleString()}–${maximumDepth.toLocaleString()} km`,
      axisLabel: "X = longitude ° · Y = depth km (down) · Z = latitude ° · 화면 축별 정규화", grid: true, normalizePerAxis: true, returnView: "earthquake-map", returnLabel: "Map 2D",
    }, interactive);
    if (interactive) resetArtifactViewScroll();
    host.dataset.earthquakeDepthReady = String(scene.available); host.dataset.earthquakeEventCount = String(points.length);
    return scene;
  }

  function renderAstronomyDistance3d(version, host, interactive = true) {
    const catalog = version?.payload?.catalog;
    if (catalog?.provider !== "simbad-tap" || !Array.isArray(catalog.objects)) throw new Error("검증된 SIMBAD 천체 좌표가 없습니다.");
    const objects = catalog.objects.filter((object) => isExactFiniteNumber(object.raDeg) && isExactFiniteNumber(object.decDeg)
      && isExactFiniteNumber(object.parallaxMas) && object.parallaxMas > 0);
    if (!objects.length) throw new Error("양의 parallax가 있는 천체가 없어 거리를 임의 생성하지 않았습니다.");
    const distances = objects.map((object) => 1_000 / object.parallaxMas);
    const points = objects.map((object, index) => {
      const ra = object.raDeg * Math.PI / 180; const dec = object.decDeg * Math.PI / 180; const distancePc = distances[index];
      const horizontal = Math.cos(dec) * distancePc;
      return {
        position: [horizontal * Math.cos(ra), horizontal * Math.sin(ra), Math.sin(dec) * distancePc],
        color: spatialColor(object.objectType), radius: 1,
        label: object.mainId,
        detail: `${object.objectType}${object.spectralType ? ` · ${object.spectralType}` : ""} · ${distancePc.toLocaleString("en-US", { maximumFractionDigits: 3 })} pc · parallax ${object.parallaxMas.toLocaleString("en-US", { maximumFractionDigits: 8 })} mas · RA ${object.raDeg.toFixed(6)}° · Dec ${object.decDeg.toFixed(6)}°`,
      };
    });
    const scene = renderScientificPointScene(host, {
      points, kind: "astronomy-distance", title: "SIMBAD parallax distance view",
      subtitle: `${points.length.toLocaleString()} / ${catalog.objects.length.toLocaleString()} objects with positive parallax · ${Math.min(...distances).toLocaleString("en-US", { maximumFractionDigits: 2 })}–${Math.max(...distances).toLocaleString("en-US", { maximumFractionDigits: 2 })} pc`,
      axisLabel: "X · Y · Z = ICRS Cartesian pc · distance = 1000/parallax · 오차모형 미적용", grid: false, returnView: "astronomy-sky", returnLabel: "Sky 2D",
    }, interactive);
    if (interactive) resetArtifactViewScroll();
    host.dataset.astronomyDistanceReady = String(scene.available); host.dataset.astronomyDistanceEligibleCount = String(points.length);
    host.dataset.astronomyDistanceExcludedCount = String(catalog.objects.length - points.length);
    return scene;
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
        bindArtifactVisualViewport(host, { kind: "image" });
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
        if (!host.isConnected || state.selectedArtifactId !== artifact.id) return;
        if (rendered.view === "figure") {
          try {
            if (rendered.captureLayoutError) throw rendered.captureLayoutError;
            const bundle = await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
            if (!host.isConnected || state.selectedArtifactId !== artifact.id) return;
            const status = document.querySelector(".rendererStatus");
            if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
          } catch (error) {
            if (!host.isConnected || state.selectedArtifactId !== artifact.id) return;
            host.dataset.captureFailed = "true";
            if (errorNode) errorNode.textContent = error instanceof Error ? error.message : String(error);
          } finally {
            rendered.restoreInteractiveView?.();
            if (rendered.view === "figure") bindArtifactVisualViewport(host, { kind: "chart", initialFit: false });
          }
        }
      } catch (error) {
        if (!host.isConnected || state.selectedArtifactId !== artifact.id) return;
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
        if (artifact.version.payload?.schema === "agentlas.science.statistics-analysis-artifact/v1") bindArtifactVisualViewport(host, { kind: "chart" });
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
        if (state.spatialViewByArtifact.get(artifact.id) === "astronomy-distance") {
          state.activeSpatialScene = renderAstronomyDistance3d(artifact.version, host, true);
        } else {
          renderSkyCatalog(artifact.version, host, true);
        }
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
    if (artifact.version?.rendererId === "agentlas.vega" && artifact.version.payload?.catalog?.provider === "usgs-fdsn-event"
      && state.spatialViewByArtifact.get(artifact.id) === "earthquake-depth") {
      try {
        state.activeSpatialScene = renderEarthquakeDepth3d(artifact.version, host, true);
        const bundle = await science.artifacts.capture({ projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256 });
        const status = document.querySelector(".rendererStatus");
        if (status && bundle?.visualReviewEligible) status.dataset.visualCapture = "verified";
      } catch (error) {
        host.textContent = error instanceof Error ? error.message : String(error);
        host.dataset.renderFailed = "true";
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
    finally {
      restoreArtifactVegaCanvas(host);
      bindArtifactVisualViewport(host, { kind: "chart" });
    }
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

  function resetArtifactViewScroll() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      let node = root.querySelector("[data-artifact-host]");
      while (node && node !== document.body) {
        if (node instanceof HTMLElement && node.scrollTop !== 0) node.scrollTop = 0;
        node = node.parentElement;
      }
      if (document.scrollingElement?.scrollTop) document.scrollingElement.scrollTop = 0;
    }));
  }

  root.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.action === "resume-science-loop") {
      void transitionScienceResearchLoop("resume");
      return;
    }
    if (target.dataset.action === "cancel-science-loop") {
      void transitionScienceResearchLoop("cancel");
      return;
    }
    if (target.dataset.action === "toggle-science-model") {
      if (scienceRuntimePickerLocked() || state.runtimeSelectionLoading || state.runtimeSelectionBusy) return;
      state.runtimePickerOpen = !state.runtimePickerOpen;
      renderChatDock();
      if (state.runtimePickerOpen) requestAnimationFrame(() => document.querySelector("[data-science-model-search]")?.focus());
      return;
    }
    if (target.dataset.action === "close-science-model") {
      state.runtimePickerOpen = false;
      state.runtimePickerQuery = "";
      renderChatDock();
      requestAnimationFrame(() => document.querySelector("[data-science-model-trigger]")?.focus());
      return;
    }
    if (target.dataset.action === "select-science-model") {
      const optionIndex = Number(target.dataset.scienceRuntimeOptionIndex);
      if (Number.isSafeInteger(optionIndex)) void selectScienceRuntimeOption(optionIndex);
      return;
    }
    if (target.dataset.action === "retry-inline-preview") {
      const host = target.closest(".inlineArtifactItem")?.querySelector("[data-inline-vega-artifact], [data-inline-capture-artifact]");
      if (host) void hydrateInlineArtifactPreview(host);
      return;
    }
    if (target.dataset.action === "answer-runtime-question") { void answerRuntimeQuestion(target.dataset.runtimeQuestionAnswer || ""); return; }
    if (target.dataset.action === "dismiss-runtime-question") { void answerRuntimeQuestion(null); return; }
    if (target.dataset.tablePage !== undefined) {
      const page = Number(target.dataset.tablePage);
      if (Number.isSafeInteger(page) && page >= 0 && state.selectedArtifactId) {
        state.tablePageByArtifact.set(state.selectedArtifactId, page);
        render();
      }
      return;
    }
    if (target.dataset.spatialView && state.selectedArtifactId) {
      const view = target.dataset.spatialView;
      if (!["materials-table", "materials-3d", "earthquake-map", "earthquake-depth", "astronomy-sky", "astronomy-distance"].includes(view)) return;
      state.spatialViewByArtifact.set(state.selectedArtifactId, view);
      render();
      resetArtifactViewScroll();
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
    if (target.dataset.action === "back-to-projects") {
      const action = () => {
        rememberScroll();
        if (state.selectedId) state.librarySelectedProjectId = state.selectedId;
        state.selectedId = null;
        state.visualViewportByArtifact = new Map();
        state.projectFolderOpen = false;
        state.selectedConversationId = null;
        state.drawer = null;
        state.projectMenuOpen = false;
        render();
        void refreshProjectLibrarySummaries().then(render).catch((error) => {
          state.projectLibrarySummaryState = "unavailable";
          state.projectLibrarySummaries = new Map();
          state.workspaceSyncError = error instanceof Error ? error.message : String(error);
          render();
        });
      };
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "select-library-project") {
      state.librarySelectedProjectId = target.dataset.libraryProjectId || null;
      state.projectFolderOpenError = "";
      render();
      return;
    }
    if (target.dataset.action === "open-library-project" || target.dataset.action === "open-sidebar-project") {
      const projectId = target.dataset.libraryProjectId;
      if (!projectId) return;
      const action = () => void selectProject(projectId, { openFolder: true });
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "open-project-folder-os") {
      const projectId = target.dataset.projectId;
      if (!projectId || state.projectFolderOpenBusy) return;
      state.projectFolderOpenBusy = true;
      state.projectFolderOpenError = "";
      target.disabled = true;
      void (async () => {
        try {
          await science.projects.openFolder(projectId);
        } catch (error) {
          if (state.librarySelectedProjectId === projectId || state.selectedId === projectId) {
            state.projectFolderOpenError = error instanceof Error ? error.message : String(error);
          }
        } finally {
          state.projectFolderOpenBusy = false;
          render();
        }
      })();
      return;
    }
    if (target.dataset.action === "select-project-folder-item") {
      state.projectFolderSelectedKey = target.dataset.folderItemKey || null;
      render();
      return;
    }
    if (target.dataset.action === "open-project-workspace") {
      state.projectFolderOpen = false;
      render();
      return;
    }
    if (target.dataset.action === "open-project-folder-source") {
      state.projectFolderOpen = false;
      state.mode = "session";
      state.activeWorkspaceTabId = RESEARCH_TAB_ID;
      state.currentDestination = "literature";
      state.selectedSourceId = target.dataset.sourceId || null;
      state.drawer = state.selectedSourceId ? { kind: "source", id: state.selectedSourceId } : null;
      render();
      if (state.selectedId) void loadLiterature(state.selectedId);
      return;
    }
    if (target.dataset.action === "open-project-folder-destination") {
      state.projectFolderOpen = false;
      navigateProjectDestination(target.dataset.destination || "overview");
      return;
    }
    if (target.dataset.action === "open-project-folder-artifact") {
      state.projectFolderOpen = false;
      const action = () => {
        void openLab(target.dataset.labId, target.dataset.artifactId, null, null).then(() => {
          if (state.selectedArtifactId !== target.dataset.artifactId) return;
          state.drawer = { kind: "artifact", id: target.dataset.artifactId };
          render();
        }).catch((error) => {
          state.projectError = error?.message || String(error);
          render();
        });
      };
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "open-project-folder-manuscript") {
      state.projectFolderOpen = false;
      const action = () => void openManuscript(target.dataset.manuscriptId);
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "open-project-folder-export") {
      state.projectFolderOpen = false;
      state.selectedManuscriptId = target.dataset.manuscriptId || state.selectedManuscriptId;
      navigateProjectDestination("submission-archive");
      return;
    }
    if (target.dataset.researchTemplate) {
      const template = researchTemplateById(target.dataset.researchTemplate);
      if (!template) return;
      state.modal = true;
      state.selectedResearchTemplateId = template.id;
      state.newProjectStep = "details";
      state.newProjectFolderError = "";
      state.newProjectFolderBusy = false;
      state.newProjectGeneration += 1;
      state.newProjectRequestId = null;
      state.newProjectRequestSignature = "";
      render();
      requestAnimationFrame(() => document.querySelector('#new-project-form input[name="title"]')?.focus());
      return;
    }
    if (target.dataset.action === "manage-project-labs") {
      state.labManagerGeneration += 1;
      state.labManagerOpen = true;
      state.labManagerBusyId = null;
      state.labManagerError = "";
      render();
      requestAnimationFrame(() => document.querySelector(".labManagerRow")?.focus());
      return;
    }
    if (target.dataset.action === "close-project-labs") {
      state.labManagerGeneration += 1;
      state.labManagerOpen = false;
      state.labManagerBusyId = null;
      state.labManagerError = "";
      render();
      requestAnimationFrame(() => document.querySelector(".manageLabsButton")?.focus());
      return;
    }
    if (target.dataset.action === "toggle-project-lab") {
      void toggleProjectLabBookmark(target.dataset.labId || "", target.dataset.labEnabled !== "true");
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
      const action = () => {
        state.modal = true;
        state.saving = false;
        state.newProjectStep = "details";
        state.selectedResearchTemplateId = null;
        state.newProjectFolderBusy = false;
        state.newProjectGeneration += 1;
        resetNewProjectDraft();
        state.newProjectRequestId = null;
        state.newProjectRequestSignature = "";
        render();
        requestAnimationFrame(() => document.querySelector('#new-project-form input[name="title"]')?.focus());
      };
      if (!guardArtifactDraftNavigation(action)) action();
      return;
    }
    if (target.dataset.action === "pick-project-folder") {
      void pickNewProjectFolder();
      return;
    }
    if (target.dataset.action === "clear-project-classification") {
      state.selectedResearchTemplateId = null;
      state.newProjectRequestId = null;
      state.newProjectRequestSignature = "";
      render();
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
    // Any click that is not inside the menu closes it -- including the control that opened it, so
    // a second press is a toggle rather than a second identical menu.
    if (!target.closest?.("[data-manuscript-block-menu]")) {
      const alreadyOpen = !!window.document.querySelector("[data-manuscript-block-menu]");
      closeManuscriptBlockMenu();
      if (target.dataset.action === "open-manuscript-block-menu") { if (!alreadyOpen) openManuscriptBlockMenu(target); return; }
    }
    if (target.dataset.action === "delete-manuscript-block") { void deleteManuscriptBlock(target.dataset.nodeId); return; }
    if (target.dataset.action === "undo-manuscript-transaction") { void undoManuscriptTransaction(target.dataset.transactionId); return; }
    if (target.dataset.action === "pin-manuscript-selection") { void persistManuscriptSelection(target); return; }
    if (target.dataset.action === "clear-manuscript-selection") { state.manuscriptSelectionContext = null; state.manuscriptSelectionError = ""; renderChatDock(); return; }
    if (target.dataset.action === "apply-manuscript-proposal") { void decideManuscriptProposal(target.dataset.proposalId, "apply"); return; }
    if (target.dataset.action === "reject-manuscript-proposal") { void decideManuscriptProposal(target.dataset.proposalId, "reject"); return; }
    if (target.dataset.action === "regenerate-manuscript-proposal") { prepareStaleProposalRegeneration(target.dataset.proposalId); return; }
    if (target.dataset.action === "defer-research-decision") { void deferPresentedResearchDecision(); return; }
    if (target.dataset.action === "open-analysis-plan-review") {
      const plan = reviewableAnalysisPlan();
      if (!plan) return;
      state.selectedAnalysisPlanId = plan.id;
      state.analysisPlanReviewSheet = true;
      state.analysisPlanReviewError = "";
      render();
      return;
    }
    if (target.dataset.action === "close-analysis-plan-review") {
      state.analysisPlanReviewDismissedKey = analysisPlanReviewKey(reviewableAnalysisPlan());
      state.analysisPlanReviewSheet = false;
      state.analysisPlanReviewBusy = false;
      state.analysisPlanReviewError = "";
      render();
      return;
    }
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
      const requestedView = target.dataset.statisticsView;
      state.statisticsViewByArtifact.set(state.selectedArtifactId, requestedView);
      render();
      requestAnimationFrame(() => document.querySelector(`[data-statistics-view="${CSS.escape(requestedView)}"]`)?.focus({ preventScroll: true }));
      return;
    }
    if (target.dataset.paleontologyView && state.selectedArtifactId) {
      const requestedView = target.dataset.paleontologyView === "table" ? "table" : "figure";
      state.paleontologyViewByArtifact.set(state.selectedArtifactId, requestedView);
      render();
      requestAnimationFrame(() => document.querySelector(`[data-paleontology-view="${CSS.escape(requestedView)}"]`)?.focus({ preventScroll: true }));
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
    if (target.dataset.action === "cancel") {
      state.modal = false;
      state.saving = false;
      state.newProjectStep = "details";
      state.selectedResearchTemplateId = null;
      state.newProjectFolderBusy = false;
      state.newProjectGeneration += 1;
      resetNewProjectDraft();
      state.newProjectRequestId = null;
      state.newProjectRequestSignature = "";
      render();
      return;
    }
    if (target.dataset.action === "retry-project" && state.selectedId) { void selectProject(state.selectedId); return; }
    if (target.dataset.action === "toggle-drawer") { rememberScroll(); state.drawer = state.drawer ? null : { kind: state.mode === "lab" ? "artifact" : state.mode === "manuscript" ? "manuscript" : "source", id: state.mode === "lab" ? state.selectedArtifactId : state.mode === "manuscript" ? state.selectedManuscriptId : state.selectedSourceId }; render(); return; }
    if (target.dataset.action === "close-drawer") { rememberScroll(); state.drawer = null; render(); return; }
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
    if (target.dataset.projectId) { const action = () => void selectProject(target.dataset.projectId, { openFolder: true }); if (!guardArtifactDraftNavigation(action)) action(); return; }
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
    if (target.dataset.action === "open-result-artifact") {
      void openResultArtifact(target.dataset.resultArtifactId || "", Number(target.dataset.resultArtifactVersion));
      return;
    }
    if (target.dataset.inlineArtifactId || target.dataset.chatArtifactId) { const action = () => void openConversationArtifact(target); if (!guardArtifactDraftNavigation(action)) action(); return; }
    if (target.dataset.artifactHistoryVersion) { void inspectArtifactVersion(Number(target.dataset.artifactHistoryVersion)); return; }
    if (target.dataset.citationId) { rememberScroll(); state.selectedSourceId = target.dataset.sourceId; state.drawer = { kind: "citation", id: target.dataset.citationId }; render(); return; }
    if (target.dataset.sourceId) { rememberScroll(); state.selectedSourceId = target.dataset.sourceId; state.drawer = { kind: "source", id: target.dataset.sourceId }; render(); return; }
    if (target.dataset.artifactId) { const action = () => void openLab(state.selectedLabId, target.dataset.artifactId, null); if (!guardArtifactDraftNavigation(action)) action(); }
  });

  root.addEventListener("change", (event) => {
    const approvalScope = event.target.closest('input[data-action="toggle-approval-scope"]');
    if (approvalScope) { void toggleApprovalScope(approvalScope.dataset.scope, approvalScope.checked); return; }
    const materialsStructure = event.target.closest("[data-materials-structure-index]");
    if (materialsStructure && state.selectedArtifactId) {
      const index = Number(materialsStructure.value);
      if (Number.isSafeInteger(index) && index >= 0) {
        state.materialsStructureIndexByArtifact.set(state.selectedArtifactId, index);
        state.spatialViewByArtifact.set(state.selectedArtifactId, "materials-3d");
        render();
        resetArtifactViewScroll();
      }
      return;
    }
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

  function scheduleProjectSearchRender(projectSearch) {
    const source = projectSearch.dataset.projectSearch || "main";
    const value = projectSearch.value;
    const selectionStart = projectSearch.selectionStart;
    const selectionEnd = projectSearch.selectionEnd;
    state.librarySearch = value;
    if (librarySearchTimer) window.clearTimeout(librarySearchTimer);
    librarySearchTimer = window.setTimeout(() => {
      librarySearchTimer = null;
      if (librarySearchComposing) return;
      render();
      requestAnimationFrame(() => {
        const input = document.querySelector(`[data-project-search="${CSS.escape(source)}"]`);
        if (!input) return;
        input.focus();
        if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd);
      });
    }, 120);
  }

  function scheduleScienceModelSearchRender(modelSearch) {
    const value = modelSearch.value;
    const selectionStart = modelSearch.selectionStart;
    const selectionEnd = modelSearch.selectionEnd;
    state.runtimePickerQuery = value;
    if (scienceModelSearchTimer) window.clearTimeout(scienceModelSearchTimer);
    scienceModelSearchTimer = window.setTimeout(() => {
      scienceModelSearchTimer = null;
      if (scienceModelSearchComposing || !state.runtimePickerOpen) return;
      renderChatDock();
      requestAnimationFrame(() => {
        const input = document.querySelector("[data-science-model-search]");
        if (!input) return;
        input.focus();
        if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd);
      });
    }, 80);
  }

  root.addEventListener("compositionstart", (event) => {
    if (event.target.closest("[data-science-model-search]")) {
      scienceModelSearchComposing = true;
      if (scienceModelSearchTimer) window.clearTimeout(scienceModelSearchTimer);
      scienceModelSearchTimer = null;
      return;
    }
    if (!event.target.closest("[data-project-search]")) return;
    librarySearchComposing = true;
    if (librarySearchTimer) window.clearTimeout(librarySearchTimer);
    librarySearchTimer = null;
  });

  root.addEventListener("compositionend", (event) => {
    const modelSearch = event.target.closest("[data-science-model-search]");
    if (modelSearch) {
      scienceModelSearchComposing = false;
      scheduleScienceModelSearchRender(modelSearch);
      return;
    }
    const projectSearch = event.target.closest("[data-project-search]");
    if (!projectSearch) return;
    librarySearchComposing = false;
    scheduleProjectSearchRender(projectSearch);
  });

  root.addEventListener("input", (event) => {
    const modelSearch = event.target.closest("[data-science-model-search]");
    if (modelSearch) {
      state.runtimePickerQuery = modelSearch.value;
      if (!event.isComposing && !scienceModelSearchComposing) scheduleScienceModelSearchRender(modelSearch);
      return;
    }
    const projectSearch = event.target.closest("[data-project-search]");
    if (projectSearch) {
      state.librarySearch = projectSearch.value;
      if (!event.isComposing && !librarySearchComposing) scheduleProjectSearchRender(projectSearch);
      return;
    }
    const newProjectForm = event.target.closest("#new-project-form");
    if (newProjectForm) {
      const form = new FormData(newProjectForm);
      state.newProjectDraft = { ...state.newProjectDraft, title: String(form.get("title") || ""), question: String(form.get("question") || "") };
      return;
    }
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
    if (send) send.disabled = !state.composerDraft.trim() || !state.runtimeSelection || state.runtimeUnavailable || state.runtimeSelectionLoading || state.runtimeSelectionBusy;
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
    const scienceModelSearch = event.target.closest?.("[data-science-model-search]");
    if (scienceModelSearch) {
      if (event.key === "Escape") {
        event.preventDefault();
        state.runtimePickerOpen = false;
        state.runtimePickerQuery = "";
        renderChatDock();
        requestAnimationFrame(() => document.querySelector("[data-science-model-trigger]")?.focus());
        return;
      }
      if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        return;
      }
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
    if (event.key === "Escape" && !state.railCollapsed && window.matchMedia("(max-width: 680px)").matches && !document.querySelector("[role=dialog]")) {
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
    if (state.drawer && window.matchMedia("(max-width: 680px)").matches) state.railCollapsed = true;
    syncRailPresentation();
    requestAnimationFrame(() => {
      revealActiveWorkspaceTab();
      requestAnimationFrame(syncWorkspaceTabOverflow);
    });
    window.setTimeout(syncWorkspaceTabOverflow, 80);
    window.setTimeout(syncWorkspaceTabOverflow, 220);
  }, { passive: true });

  root.addEventListener("keydown", (event) => {
    if (event.target.closest?.(".runtimeQuestionFreeText input")
      && event.key === "Enter"
      && (event.isComposing || event.keyCode === 229)) event.preventDefault();
  });

  root.addEventListener("input", (event) => {
    const input = event.target.closest?.(".runtimeQuestionFreeText input");
    const requestId = input?.closest("[data-runtime-question-id]")?.dataset.runtimeQuestionId;
    if (!input || !requestId || requestId !== state.runtimeQuestions[0]?.requestId) return;
    state.runtimeQuestionDraftRequestId = requestId;
    state.runtimeQuestionDraft = input.value;
  });

  root.addEventListener("submit", async (event) => {
    if (event.target.id === "analysis-plan-review-form") {
      event.preventDefault();
      const plan = reviewableAnalysisPlan();
      const projectId = state.selectedId;
      const decision = event.submitter?.value === "revise" ? "revise" : "approve";
      const form = new FormData(event.target);
      const rationale = String(form.get("rationale") || "").trim() || null;
      if (!plan || !projectId || state.analysisPlanReviewBusy) return;
      if (decision === "approve") {
        const missingReasons = analysisPlanReviewMissingReasons(plan.version?.document || {});
        if (missingReasons.length) {
          state.analysisPlanReviewError = uiCopy(
            `승인 전에 다음 항목을 보완해야 합니다: ${missingReasons.join(" · ")}`,
            `Complete these items before approval: ${missingReasons.join(" · ")}`,
          );
          render();
          return;
        }
      }
      if (decision === "revise" && !rationale) {
        state.analysisPlanReviewError = uiCopy("수정할 내용을 적어 주세요.", "Describe the changes you need.");
        render();
        return;
      }
      state.analysisPlanReviewBusy = true;
      state.analysisPlanReviewError = "";
      render();
      let routed = false;
      try {
        const current = await science.analysisSpecs.get(projectId, plan.id);
        if (!current || current.status !== "draft"
          || current.currentVersion !== plan.currentVersion
          || current.currentDocumentSha256 !== plan.currentDocumentSha256
          || current.lockVersion !== plan.lockVersion) throw new Error("science-analysis-version-conflict");
        const result = await science.analysisSpecs.review({
          requestId: crypto.randomUUID(), projectId, analysisSpecId: current.id,
          expectedVersion: current.currentVersion, expectedContentSha256: current.currentDocumentSha256,
          expectedLockVersion: current.lockVersion, decision, rationale,
        });
        if (!result?.receipt || result.receipt.actor !== "human" || result.receipt.decision !== decision || !result.analysisSpec) {
          throw new Error("science-analysis-plan-review-result-invalid");
        }
        state.analysisSpecs = [result.analysisSpec, ...state.analysisSpecs.filter((item) => item.id !== result.analysisSpec.id)];
        state.analysisPlanReviewSheet = false;
        state.analysisPlanReviewDismissedKey = null;
        const acquisitionOnly = result.analysisSpec.version.document.data.inputs.length === 0
          && Boolean(result.analysisSpec.version.document.data.acquisition?.sources.length);
        state.composerDraft = analysisPlanReviewContinuationPrompt({
          decision,
          projectId,
          conversationId: selectedConversation()?.id || "",
          analysisSpecId: result.analysisSpec.id,
          analysisSpecVersion: result.analysisSpec.currentVersion,
          analysisSpecContentSha256: result.analysisSpec.currentDocumentSha256,
          receiptId: result.receipt.id,
          planTitle: result.analysisSpec.title,
          acquisitionOnly,
          rationale,
        });
        routed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/science-analysis-version-conflict/.test(message)) {
          state.analysisPlanReviewError = uiCopy("검토 중 계획 버전이 바뀌었습니다. 자동 승인하지 않았습니다. 최신 계획을 다시 확인해 주세요.", "The plan changed while you were reviewing it. It was not approved. Review the latest version.");
        } else if (/science-analysis-spec-incomplete/.test(message)) {
          const missingReasons = analysisPlanReviewMissingReasons(plan.version?.document || {});
          state.analysisPlanReviewError = uiCopy(
            `계획을 승인하지 않았습니다. 다음 항목을 보완하세요: ${missingReasons.join(" · ")}`,
            `The plan was not approved. Complete these items: ${missingReasons.join(" · ")}`,
          );
        } else state.analysisPlanReviewError = message;
      } finally {
        state.analysisPlanReviewBusy = false;
        render();
      }
      if (routed && projectId === state.selectedId) await startComposerTurn({ forceAppend: true });
      return;
    }
    if (event.target.id === "runtime-question-form") {
      event.preventDefault();
      const form = new FormData(event.target);
      const answer = String(form.get("answer") || "").trim();
      if (!answer) return;
      void answerRuntimeQuestion(answer);
      return;
    }
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
        maybePresentAnalysisPlanReview();
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
    if (state.saving || state.newProjectFolderBusy) return;
    const form = new FormData(event.target);
    const template = researchTemplateById(state.selectedResearchTemplateId);
    const title = String(form.get("title") || "").trim();
    const question = String(form.get("question") || "").trim();
    if (!title || !question) {
      const errorNode = document.getElementById("form-error");
      if (errorNode) errorNode.textContent = uiCopy("프로젝트 이름과 개요를 모두 입력해 주세요.", "Enter both a project name and an overview.");
      return;
    }
    const folderSelectionId = typeof state.newProjectDraft.folderSelectionId === "string" ? state.newProjectDraft.folderSelectionId.trim() : "";
    if (!folderSelectionId) {
      const errorNode = document.getElementById("form-error");
      if (errorNode) errorNode.textContent = uiCopy("프로젝트 폴더를 선택해 주세요.", "Choose a project folder.");
      requestAnimationFrame(() => document.querySelector('[data-action="pick-project-folder"]')?.focus());
      return;
    }
    const domain = template?.domain || "general";
    const requestSignature = JSON.stringify({ title, question, domain, folderSelectionId });
    if (!state.newProjectRequestId || state.newProjectRequestSignature !== requestSignature) {
      state.newProjectRequestId = crypto.randomUUID();
      state.newProjectRequestSignature = requestSignature;
    }
    const requestGeneration = state.newProjectGeneration;
    const requestId = state.newProjectRequestId;
    state.saving = true;
    render();
    try {
      const result = await science.projects.create({
        requestId,
        question,
        title,
        domain,
        folderSelectionId,
      });
      state.projects = [result.project, ...state.projects.filter((item) => item.id !== result.project.id)];
      state.projectLibrarySummaries.set(result.project.id, { projectId: result.project.id, fileCount: 0, dataCount: 0, analysisCount: 0, manuscriptCount: 0, pdfCount: 0 });
      const ownsModal = requestGeneration === state.newProjectGeneration && state.modal;
      if (!ownsModal) {
        // The backend create cannot be canceled after dispatch. If the user
        // closed the draft meanwhile, keep the late success in the library but
        // do not take over a newer draft or force a workspace transition.
        render();
        return;
      }
      state.modal = false;
      state.saving = false;
      state.newProjectStep = "details";
      state.selectedResearchTemplateId = null;
      state.newProjectFolderBusy = false;
      state.newProjectGeneration += 1;
      resetNewProjectDraft();
      state.newProjectRequestId = null;
      state.newProjectRequestSignature = "";
      const navigationGeneration = state.newProjectGeneration;
      const createdProjectId = result.project.id;
      await selectProject(createdProjectId, { openFolder: false });
      if (navigationGeneration !== state.newProjectGeneration || state.selectedId !== createdProjectId) {
        // A user can navigate while the newly created project's workspace is
        // loading. Do not start the old project's first turn in a newer view.
        render();
        return;
      }
      // project.create persists the first question as a user message. Start that
      // exact message immediately so a new project opens on a live Research
      // Director turn instead of looking like an empty shell that needs a second
      // manual send.
      if (state.messages.length === 1 && state.messages[0]?.role === "user" && !state.messages.some((message) => message.role === "assistant")) {
        state.composerDraft = "";
        void startComposerTurn();
      }
    } catch (error) {
      if (requestGeneration !== state.newProjectGeneration || !state.modal) {
        render();
        return;
      }
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
    if (science.questions?.onRequest && !state.runtimeQuestionDispose) state.runtimeQuestionDispose = science.questions.onRequest(receiveRuntimeQuestion);
    if (science.questions?.list) {
      const pendingQuestions = await science.questions.list();
      if (Array.isArray(pendingQuestions)) pendingQuestions.forEach(receiveRuntimeQuestion);
    }
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
    if (science.composer?.onEvent && !state.composerEventDispose) {
      const composerEventSync = createComposerEventSync({
        getCurrentScope: () => state.activeTurn ? {
          projectId: state.selectedId,
          conversationId: selectedConversation()?.id,
          turnId: state.activeTurn.id,
          lastSequence: state.activeTurn.lastSequence,
        } : null,
        getCurrentConversationScope: () => ({
          projectId: state.selectedId,
          conversationId: selectedConversation()?.id,
        }),
        readReceipt: (input) => science.composer.receipt(input),
        readAttach: (input) => science.composer.attach(input),
        onAttach: (turn) => {
          if (turn.projectId !== state.selectedId || turn.conversationId !== selectedConversation()?.id) return;
          if (state.activeTurn?.id === turn.id && Number(turn.lastSequence) < Number(state.activeTurn.lastSequence)) return;
          state.activeTurn = turn;
          state.composerError = composerTurnError(turn);
          if (turn.runtimeSelection) state.runtimeSelection = turn.runtimeSelection;
          renderChatDock();
        },
        onProgress: (turn) => {
          state.activeTurn = turn;
          if (turn.runtimeSelection && turn.projectId === state.selectedId && turn.conversationId === selectedConversation()?.id) {
            state.runtimeSelection = turn.runtimeSelection;
          }
          renderChatDock();
        },
        onTerminal: async (turn) => {
          state.activeTurn = turn;
          if (turn.runtimeSelection && turn.projectId === state.selectedId && turn.conversationId === selectedConversation()?.id) {
            state.runtimeSelection = turn.runtimeSelection;
          }
          const projectId = state.selectedId;
          recordRunFailure(composerTurnError(turn));
          if (!projectId) return;
          if (state.projectFolderOpen) await selectProject(projectId, { openFolder: true, preserveWorkspace: true });
          else if (state.mode === "lab") await refreshConversationOnly(projectId);
          else await refreshConversationOnly(projectId);
        },
        onError: (error, event) => {
          if (event.projectId !== state.selectedId || event.conversationId !== selectedConversation()?.id
          ) return;
          recordRunFailure(error);
        },
      });
      const unsubscribe = science.composer.onEvent((event) => composerEventSync.push(event));
      state.composerEventDispose = () => {
        composerEventSync.dispose();
        unsubscribe?.();
      };
    }
    state.projects = Array.isArray(bootstrap.projects) ? bootstrap.projects : [];
    try {
      await refreshProjectLibrarySummaries();
    } catch {
      state.projectLibrarySummaries = new Map();
      state.projectLibrarySummaryState = "unavailable";
    }
    state.rendererPacks = Array.isArray(bootstrap.rendererPacks) ? bootstrap.rendererPacks : [];
    render();
  }

  void start().catch(fatal);
})();
