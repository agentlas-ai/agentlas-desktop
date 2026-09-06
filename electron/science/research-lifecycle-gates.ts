import type {
  ScienceAnalysisSpec,
  ScienceArtifact,
  ScienceArtifactContext,
  ScienceDecisionRequest,
  ScienceEvidenceSpan,
  ScienceHypothesis,
  ScienceJournalProfile,
  ScienceJournalValidationReceipt,
  ScienceManuscript,
  ScienceProject,
  ScienceResearchContract,
  ScienceResearchRun,
  ScienceRunArtifactBinding,
  ScienceSource,
  ScienceSubmissionExport,
} from "../../shared/science-contract";
import type { ScienceClaimLedgerReadModel } from "../../shared/science-claim-ledger";
import type {
  ScienceResearchFrozenPlanBinding,
  ScienceResearchLifecycleRevision,
  ScienceResearchPhaseGatePreconditions,
  ScienceResearchSubmissionExportBinding,
} from "../../shared/science-lifecycle";

type LiteratureManifest = {
  schema: "agentlas.science-literature-evidence-manifest/v1";
  entries: Array<{
    citationId: string;
    evidenceSpanId: string;
    evidenceSha256: string;
    sourceId: string;
    sourceVersionId: string;
    sourceContentSha256: string;
  }>;
  manifestSha256: string;
};

type HypothesisManifest = {
  schema: "agentlas.science-hypothesis-manifest/v1";
  hypotheses: ScienceHypothesis[];
  manifestSha256: string;
};

/**
 * Narrow read adapter used by lifecycle gates. Every lookup is project-scoped;
 * the gate module never accepts caller-supplied records as evidence.
 */
export interface ScienceResearchLifecycleGateReader {
  getProject(projectId: string): ScienceProject | null;
  latestResearchContract(projectId: string): ScienceResearchContract | null;
  /**
   * The content hash of the approved research contract, over the terms the gate cares about.
   *
   * The intake gate used to demand the lifecycle head's own `stateSha256` as its evidence, which
   * proves only that the caller read the row it was already writing to. It gates on the research
   * contract, so its evidence has to name that contract: change an approved objective or a success
   * criterion and the hash moves, and the transition that was authorized against the old terms no
   * longer verifies.
   */
  approvedResearchContractSha256(projectId: string): string | null;
  currentLiteratureEvidenceManifest(projectId: string): LiteratureManifest;
  getSourceVersionForProject(projectId: string, sourceId: string, sourceVersionId: string): ScienceSource | null;
  getEvidenceSpanForProject(projectId: string, evidenceId: string): ScienceEvidenceSpan | null;
  currentHypothesisManifest(projectId: string): HypothesisManifest;
  getAnalysisSpecForProject(projectId: string, analysisSpecId: string): ScienceAnalysisSpec | null;
  listDecisionRequests(projectId: string, analysisSpecId?: string, statuses?: ScienceDecisionRequest["status"][]): ScienceDecisionRequest[];
  listArtifacts(projectId: string, limit?: number): ScienceArtifact[];
  getArtifactContextForProject(projectId: string, artifactId: string, artifactVersion?: number): ScienceArtifactContext | null;
  getResearchRunForProject(projectId: string, runId: string): ScienceResearchRun | null;
  getRunArtifactBinding(projectId: string, runId: string): ScienceRunArtifactBinding | null;
  hasResearchLoopSessions(projectId: string): boolean;
  hasSucceededResearchEpisodeArtifactBinding(projectId: string, artifactId: string, artifactVersion: number, contentSha256: string): boolean;
  getClaimLedgerById(projectId: string, ledgerId: string): ScienceClaimLedgerReadModel | null;
  getClaimLedgerForManuscript(projectId: string, manuscriptId: string): ScienceClaimLedgerReadModel | null;
  listManuscripts(projectId: string, limit?: number): ScienceManuscript[];
  getManuscriptForProject(projectId: string, manuscriptId: string): ScienceManuscript | null;
  listJournalProfiles(projectId: string, limit?: number): ScienceJournalProfile[];
  getJournalProfileForProject(projectId: string, profileId: string): ScienceJournalProfile | null;
  getJournalValidationReceiptForProject(projectId: string, receiptId: string): ScienceJournalValidationReceipt | null;
  submissionExportBytesForProject(projectId: string, exportId: string): { export: ScienceSubmissionExport; bytes: Uint8Array } | null;
}

export interface AssertScienceResearchLifecycleGateInput {
  reader: ScienceResearchLifecycleGateReader;
  projectId: string;
  current: ScienceResearchLifecycleRevision;
  preconditions: ScienceResearchPhaseGatePreconditions;
  frozenAnalysisPlan: ScienceResearchFrozenPlanBinding | null;
  submissionExport: ScienceResearchSubmissionExportBinding | null;
}

function requireEvidenceSha256(actual: string, expected: string, code: string): void {
  if (actual !== expected) throw new Error(code);
}

function requireFrozenPlan(
  reader: ScienceResearchLifecycleGateReader,
  projectId: string,
  binding: ScienceResearchFrozenPlanBinding | null,
): ScienceAnalysisSpec {
  if (!binding) throw new Error("science-research-lifecycle-plan-gate-blocked");
  const plan = reader.getAnalysisSpecForProject(projectId, binding.analysisSpecId);
  if (!plan || plan.projectId !== projectId || plan.status !== "frozen"
    || plan.currentVersion !== binding.version || plan.version.version !== binding.version
    || plan.currentDocumentSha256 !== binding.contentSha256 || plan.version.documentSha256 !== binding.contentSha256
    || plan.latestReview?.decision !== "approve" || plan.latestReview.resultingStatus !== "frozen"
    || plan.latestReview.analysisSpecVersion !== binding.version
    || plan.latestReview.analysisSpecContentSha256 !== binding.contentSha256
    || plan.latestReview.analysisSpecLockVersion + 1 !== plan.lockVersion) {
    throw new Error("science-research-lifecycle-plan-gate-blocked");
  }
  return plan;
}

function requireReadyClaimLedger(
  reader: ScienceResearchLifecycleGateReader,
  projectId: string,
  ledgerId: string,
): ScienceClaimLedgerReadModel {
  const ledger = reader.getClaimLedgerById(projectId, ledgerId);
  if (!ledger?.gate.ready || ledger.manifest.projectId !== projectId) {
    throw new Error("science-research-lifecycle-claim-gate-blocked");
  }
  const manuscript = reader.getManuscriptForProject(projectId, ledger.manifest.manuscript.manuscriptId);
  if (!manuscript || manuscript.currentVersion !== ledger.manifest.manuscript.version
    || manuscript.version.contentSha256 !== ledger.manifest.manuscript.contentSha256) {
    throw new Error("science-research-lifecycle-claim-gate-stale");
  }
  return ledger;
}

function readyManuscripts(reader: ScienceResearchLifecycleGateReader, projectId: string): Array<{
  manuscript: ScienceManuscript;
  ledger: ScienceClaimLedgerReadModel;
}> {
  const candidates: Array<{ manuscript: ScienceManuscript; ledger: ScienceClaimLedgerReadModel }> = [];
  for (const manuscript of reader.listManuscripts(projectId, 500)) {
    const ledger = reader.getClaimLedgerForManuscript(projectId, manuscript.id);
    if (ledger?.gate.ready && ledger.manifest.projectId === projectId
      && ledger.manifest.manuscript.version === manuscript.currentVersion
      && ledger.manifest.manuscript.contentSha256 === manuscript.version.contentSha256) {
      candidates.push({ manuscript, ledger });
    }
  }
  return candidates;
}

function assertExecutionArtifact(
  reader: ScienceResearchLifecycleGateReader,
  projectId: string,
  plan: ScienceAnalysisSpec,
  evidenceSha256: string,
): void {
  const episodeBindingRequired = reader.hasResearchLoopSessions(projectId);
  const activeRuns = reader.listArtifacts(projectId, 500).filter((artifact) => artifact.projectId === projectId
    && artifact.status === "ready" && artifact.version.contentSha256 === evidenceSha256 && artifact.sourceRunId !== null);
  const eligible = activeRuns.some((artifact) => {
    const context = reader.getArtifactContextForProject(projectId, artifact.id, artifact.currentVersion);
    const run = artifact.sourceRunId ? reader.getResearchRunForProject(projectId, artifact.sourceRunId) : null;
    const binding = artifact.sourceRunId ? reader.getRunArtifactBinding(projectId, artifact.sourceRunId) : null;
    if (!context?.isCurrent || context.selectedVersion.contentSha256 !== evidenceSha256 || !run || run.status !== "succeeded"
      || !run.outputManifestSha256 || !run.finishedAt || !binding
      || binding.artifactId !== artifact.id || binding.artifactVersion !== artifact.currentVersion
      || binding.artifactContentSha256 !== artifact.version.contentSha256
      || artifact.version.provenance.sourceRunId !== run.id
      || artifact.version.provenance.environmentSha256 !== run.environmentSha256
      || episodeBindingRequired && !reader.hasSucceededResearchEpisodeArtifactBinding(
        projectId, artifact.id, artifact.currentVersion, artifact.version.contentSha256,
      )) return false;
    return run.analysisPlan?.analysisSpecId === plan.id
      && run.analysisPlan.version === plan.currentVersion
      && run.analysisPlan.contentSha256 === plan.currentDocumentSha256
      && (!plan.frozenAt || run.startedAt >= plan.frozenAt);
  });
  if (!eligible) throw new Error("science-research-lifecycle-execution-gate-blocked");
}

/**
 * Rejects phase progress unless evidenceSha256 names the current immutable
 * project record required by that exact phase edge. A syntactically valid or
 * caller-computed SHA is never sufficient by itself.
 */
export function assertScienceResearchLifecyclePhaseGate(input: AssertScienceResearchLifecycleGateInput): void {
  const { reader, projectId, current, preconditions, frozenAnalysisPlan, submissionExport } = input;
  const project = reader.getProject(projectId);
  if (!project || current.projectId !== projectId || current.phase !== preconditions.fromPhase) {
    throw new Error("science-research-lifecycle-project-gate-blocked");
  }

  const edge = `${preconditions.fromPhase}->${preconditions.toPhase}`;
  if (edge === "intake->literature") {
    const contract = reader.latestResearchContract(projectId);
    if (!contract || contract.projectId !== projectId || contract.status !== "approved"
      || contract.successCriteria.length < 1 || contract.failureCriteria.length < 1 || !contract.approvedAt) {
      throw new Error("science-research-lifecycle-intake-gate-blocked");
    }
    const contractSha256 = reader.approvedResearchContractSha256(projectId);
    if (!contractSha256) throw new Error("science-research-lifecycle-intake-gate-blocked");
    requireEvidenceSha256(preconditions.evidenceSha256, contractSha256, "science-research-lifecycle-intake-gate-blocked");
    return;
  }

  if (edge === "literature->hypothesis") {
    const literature = reader.currentLiteratureEvidenceManifest(projectId);
    if (literature.entries.length < 1) throw new Error("science-research-lifecycle-literature-evidence-gate-blocked");
    for (const entry of literature.entries) {
      const source = reader.getSourceVersionForProject(projectId, entry.sourceId, entry.sourceVersionId);
      const evidence = reader.getEvidenceSpanForProject(projectId, entry.evidenceSpanId);
      if (!source || source.version.id !== entry.sourceVersionId
        || source.version.contentSha256 !== entry.sourceContentSha256
        || !["parsed", "evidence-linked"].includes(source.version.accessState)
        || !evidence || evidence.sourceId !== entry.sourceId || evidence.sourceVersionId !== entry.sourceVersionId
        || evidence.excerptSha256 !== entry.evidenceSha256) {
        throw new Error("science-research-lifecycle-literature-evidence-gate-stale");
      }
    }
    requireEvidenceSha256(preconditions.evidenceSha256, literature.manifestSha256, "science-research-lifecycle-literature-evidence-gate-blocked");
    return;
  }

  if (edge === "hypothesis->analysis_plan_draft") {
    const manifest = reader.currentHypothesisManifest(projectId);
    const primary = manifest.hypotheses.filter((item) => item.role === "primary");
    const alternatives = manifest.hypotheses.filter((item) => item.role === "alternative");
    if (primary.length !== 1 || alternatives.length < 1 || manifest.hypotheses.some((item) => item.projectId !== projectId
      || item.status !== "approved" || item.falsificationCriteria.length < 1 || item.evidenceSpanIds.length < 1
      || item.evidenceSpanIds.some((id) => !reader.getEvidenceSpanForProject(projectId, id)))) {
      throw new Error("science-research-lifecycle-hypothesis-gate-blocked");
    }
    requireEvidenceSha256(preconditions.evidenceSha256, manifest.manifestSha256, "science-research-lifecycle-hypothesis-gate-blocked");
    return;
  }

  if (edge === "analysis_plan_draft->analysis_plan_frozen" || edge === "analysis_plan_frozen->execution") {
    const plan = requireFrozenPlan(reader, projectId, frozenAnalysisPlan);
    const unresolved = reader.listDecisionRequests(projectId, plan.id, ["queued", "presented", "deferred"]);
    if (unresolved.length) throw new Error("science-research-lifecycle-plan-decision-gate-blocked");
    requireEvidenceSha256(preconditions.evidenceSha256, plan.currentDocumentSha256, "science-research-lifecycle-plan-gate-blocked");
    if (edge === "analysis_plan_frozen->execution") {
      if (plan.version.document.data.inputs.length === 0) {
        // A frozen acquisition plan commits the study to sources and retrieval rules before the
        // bytes exist. It cannot authorize analysis: execution requires a separately approved
        // successor plan bound to exact immutable artifact versions.
        throw new Error("science-research-lifecycle-exact-input-plan-required");
      }
      // Freezing a plan and authorizing its execution are different acts, and this edge used to
      // run a check identical to the one before it on identical evidence, so it authorized
      // nothing. What it has to establish is the thing prespecification exists for: that the plan
      // being run is the one that was frozen, and that the freeze happened first. A plan whose
      // freeze timestamp is later than the authorization it is being run under is a plan that
      // moved after the commitment -- which is exactly the sequence a preregistered analysis is
      // supposed to make impossible.
      if (!plan.frozenAt || plan.frozenAt > current.createdAt) {
        throw new Error("science-research-lifecycle-plan-authorization-out-of-order");
      }
    }
    return;
  }

  if (edge === "execution->evidence_reconciliation") {
    const plan = requireFrozenPlan(reader, projectId, frozenAnalysisPlan);
    assertExecutionArtifact(reader, projectId, plan, preconditions.evidenceSha256);
    return;
  }

  if (preconditions.fromPhase === "evidence_reconciliation" && preconditions.toPhase === "conclusions") {
    const ledger = requireReadyClaimLedger(reader, projectId, preconditions.claimLedgerId);
    if (ledger.manifest.revision !== preconditions.claimLedgerRevision
      || ledger.manifest.manifestSha256 !== preconditions.claimLedgerManifestSha256
      || ledger.gate.reportSha256 !== preconditions.claimGateReportSha256
      || ledger.gate.policyContentSha256 !== preconditions.claimPolicyContentSha256) {
      throw new Error("science-research-lifecycle-claim-gate-stale");
    }
    requireEvidenceSha256(preconditions.evidenceSha256, ledger.gate.reportSha256, "science-research-lifecycle-claim-gate-blocked");
    return;
  }

  if (edge === "conclusions->manuscript") {
    const matches = readyManuscripts(reader, projectId).filter(({ ledger }) => ledger.gate.reportSha256 === preconditions.evidenceSha256);
    if (matches.length < 1) throw new Error("science-research-lifecycle-conclusions-gate-blocked");
    return;
  }

  if (edge === "manuscript->journal_profile") {
    const matches = readyManuscripts(reader, projectId).filter(({ manuscript }) => manuscript.version.contentSha256 === preconditions.evidenceSha256);
    if (matches.length < 1) throw new Error("science-research-lifecycle-manuscript-gate-blocked");
    return;
  }

  if (edge === "journal_profile->submission_validation") {
    if (readyManuscripts(reader, projectId).length < 1) throw new Error("science-research-lifecycle-journal-profile-gate-blocked");
    const profiles = reader.listJournalProfiles(projectId, 500).filter((profile) => profile.projectId === projectId
      && profile.status === "verified" && profile.version.contentSha256 === preconditions.evidenceSha256
      && profile.version.identityReceiptId && profile.version.identityReceiptSha256 && profile.version.coverageManifestSha256
      && profile.version.coverage.length > 0 && profile.version.coverage.every((entry) => entry.status !== "unresolved"));
    if (profiles.length < 1) throw new Error("science-research-lifecycle-journal-profile-gate-blocked");
    return;
  }

  if (edge === "submission_validation->ready_to_submit") {
    if (!submissionExport) throw new Error("science-research-lifecycle-submission-gate-blocked");
    const stored = reader.submissionExportBytesForProject(projectId, submissionExport.submissionExportId);
    if (!stored || stored.export.projectId !== projectId || stored.export.status !== "ready"
      || stored.export.packageSha256 !== submissionExport.packageSha256 || !stored.export.packageSha256) {
      throw new Error("science-research-lifecycle-submission-gate-blocked");
    }
    const manuscript = reader.getManuscriptForProject(projectId, stored.export.manuscriptId);
    const profile = reader.getJournalProfileForProject(projectId, stored.export.journalProfileId);
    const receipt = reader.getJournalValidationReceiptForProject(projectId, stored.export.validationReceiptId);
    if (!manuscript || manuscript.currentVersion !== stored.export.manuscriptVersion
      || manuscript.version.contentSha256 !== stored.export.manuscriptContentSha256
      || !profile || profile.status !== "verified" || profile.currentVersion !== stored.export.journalProfileVersion
      || profile.version.contentSha256 !== stored.export.journalProfileContentSha256
      || !receipt || receipt.contentSha256 !== stored.export.validationReceiptSha256 || receipt.report.status !== "ready"
      || receipt.report.reportSha256 !== stored.export.validationReportSha256) {
      throw new Error("science-research-lifecycle-submission-gate-stale");
    }
    requireEvidenceSha256(preconditions.evidenceSha256, receipt.report.reportSha256, "science-research-lifecycle-submission-gate-blocked");
    return;
  }

  throw new Error("science-research-lifecycle-phase-gate-invalid");
}
