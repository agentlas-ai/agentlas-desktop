/**
 * What a study still needs before it can move, stated in words, from the state it is actually in.
 *
 * The workspace already returned `lifecycle.phase` and `researchContract`, and a live model read
 * both, ran thirteen statistical analyses across three turns, and never left `intake` -- because
 * nothing in the response SAID that the study had not formally begun. A null field is not an
 * instruction. By the fourth turn the model worked it out for itself and wrote "the lifecycle is
 * still at intake with a draft contract -- the one thing that gates everything", which is the
 * sentence this function now returns on the first turn instead of the fourth.
 *
 * Derived, never asserted: every branch below is decided by state the caller passes in, so this
 * cannot claim a study is blocked when it is not, or clear when it is. `science-study-progress`
 * runs this function over each state and fails if a branch stops matching.
 */

export type ScienceStudyPhase = string;

export interface ScienceStudyProgressInput {
  /** The lifecycle phase as recorded, or null when a study has no lifecycle yet. */
  readonly phase: ScienceStudyPhase | null;
  /** The latest research contract, or null when none has been drafted. */
  readonly contract: { readonly approvedAt?: string | null; readonly version?: number } | null;
  /**
   * The hash of the APPROVED contract's terms -- the evidence the intake gate requires.
   *
   * This is computed by the store and was never handed to anyone. A live model tried to advance the
   * lifecycle, could not produce the gate evidence, and wrote "gate-token guessing isn't converging"
   * and then "contract carries no hash field -- confirmed by direct field scan". It was right: the
   * value existed and nothing returned it, so the gate could not be passed by any caller.
   */
  readonly approvedTermsSha256?: string | null;
  /**
   * The next transition and the exact code it requires.
   *
   * These codes lived in one private map, were demanded by the store, and appeared in no schema,
   * response or instruction. The director had to produce the exact string "intake.complete" with no
   * way to learn it, and a live model reported "gate-token guessing isn't converging". Requiring a
   * value you never hand out is the same as forbidding the action.
   */
  readonly nextGate?: { readonly toPhase: string; readonly gateCode: string } | null;
  /**
   * A decision that only the RESEARCHER can make, and that the current phase's gate requires.
   *
   * The contract is not the only one. Hypotheses are proposed by the director and approved by a
   * person, and the gate out of `hypothesis` refuses anything still `proposed`. Without this, the
   * progress said `waitingOnResearcher: false` and named advancing as the next step, so a live model
   * spent two turns retrying a gate that could not pass -- being told to walk through a locked door.
   */
  readonly pendingResearcherDecision?: { readonly what: string; readonly count: number } | null;
}

export interface ScienceStudyProgress {
  readonly phase: ScienceStudyPhase | null;
  /** The gate evidence for the next transition, when the state has one to give. */
  readonly gateEvidenceSha256?: string | null;
  /** The exact transition to make next, spelled out: phase, gate code, and what its evidence is. */
  readonly nextGate?: {
    readonly toPhase: string;
    readonly gateCode: string;
    /** Where this edge's evidenceSha256 comes from, in words. */
    readonly evidenceFrom?: string | null;
    /** The exact key set the preconditions object must carry for this edge. */
    readonly preconditionKeys?: readonly string[];
  } | null;
  /** What is holding the study where it is, in a sentence, or null when nothing is. */
  readonly blockedBy: string | null;
  /** The exact next action, named as a tool where the director owns it. */
  readonly nextRequiredStep: string;
  /** True when the next move belongs to the RESEARCHER, not the director. */
  readonly waitingOnResearcher: boolean;
}


/**
 * For each transition: WHICH value satisfies its evidence hash, and where a caller gets it.
 *
 * The gate codes were unobtainable and are now handed over. This is the next layer of the same
 * problem: every edge demands an evidenceSha256, each edge means a DIFFERENT hash, and the append
 * tool's schema declares preconditions as a bare object. So a caller who has the gate code still
 * has to guess which of a dozen hashes this particular edge wants. Audited against
 * research-lifecycle-gates.ts edge by edge; the study-progress contract checks this table covers
 * exactly the edges the store defines, so a new phase cannot be added without one.
 */
const EDGE_EVIDENCE: Record<string, { evidenceFrom: string; extraKeys?: readonly string[] }> = {
  "intake->literature": { evidenceFrom: "the approved research contract's terms hash (handed to you as gateEvidenceSha256)" },
  "literature->hypothesis": { evidenceFrom: "the literature manifest's manifestSha256, from list_project_evidence" },
  "hypothesis->analysis_plan_draft": { evidenceFrom: "the hypothesis manifest's manifestSha256, from list_research_hypotheses" },
  "analysis_plan_draft->analysis_plan_frozen": { evidenceFrom: "the frozen plan's currentDocumentSha256, from list_analysis_plans (send it as frozen_analysis_plan.contentSha256)" },
  "analysis_plan_frozen->execution": { evidenceFrom: "the frozen plan's currentDocumentSha256 again; it must have been frozen BEFORE this revision and bind at least one exact immutable input artifact version" },
  "execution->evidence_reconciliation": { evidenceFrom: "the version contentSha256 of a ready artifact produced by a succeeded run bound to the frozen plan" },
  "evidence_reconciliation->conclusions": {
    evidenceFrom: "the claim ledger's gate.reportSha256, from inspect_manuscript_claim_ledger; the ledger must be sealed and its gate ready",
    extraKeys: ["claimLedgerId", "claimLedgerRevision", "claimLedgerManifestSha256", "claimGateReportSha256", "claimPolicyContentSha256"],
  },
  "conclusions->manuscript": { evidenceFrom: "the claim ledger gate.reportSha256 of a manuscript whose ledger is ready" },
  "manuscript->journal_profile": { evidenceFrom: "the manuscript version's contentSha256, from list_project_manuscripts" },
  "journal_profile->submission_validation": { evidenceFrom: "the journal profile version's contentSha256, from list_journal_profiles; the profile must be verified with complete coverage" },
  "submission_validation->ready_to_submit": { evidenceFrom: "the submission validation receipt's report.reportSha256, from export_journal_submission_bundle (send the export as submission_export)" },
};

/** The exact key set a phase_gate precondition must carry for this edge -- no more, no fewer. */
export function scienceGatePreconditionKeys(fromPhase: string, toPhase: string): string[] {
  const base = ["kind", "fromPhase", "toPhase", "gateCode", "evidenceSha256"];
  return [...base, ...(EDGE_EVIDENCE[`${fromPhase}->${toPhase}`]?.extraKeys ?? [])];
}

/** Where this edge's evidence hash comes from, in words, or null for an edge with no entry. */
export function scienceGateEvidenceSource(fromPhase: string, toPhase: string): string | null {
  return EDGE_EVIDENCE[`${fromPhase}->${toPhase}`]?.evidenceFrom ?? null;
}

const PRE_CONTRACT_PHASES = new Set(["intake"]);


/** The next transition with its evidence source and key set attached, or null when there is none. */
function describeGate(fromPhase: string | null, next: { toPhase: string; gateCode: string } | null | undefined) {
  if (!next || !fromPhase) return null;
  return {
    ...next,
    evidenceFrom: scienceGateEvidenceSource(fromPhase, next.toPhase),
    preconditionKeys: scienceGatePreconditionKeys(fromPhase, next.toPhase),
  };
}

export function scienceStudyProgress(input: ScienceStudyProgressInput): ScienceStudyProgress {
  const phase = input.phase ?? null;
  const contract = input.contract ?? null;

  if (!contract) {
    return {
      phase,
      blockedBy: "No research contract has been drafted, so this study has not formally started and cannot leave intake.",
      nextRequiredStep: "Call propose_research_contract with the objective, success criteria, failure criteria and budgets, then stop and let the researcher approve it.",
      waitingOnResearcher: false,
    };
  }

  if (!contract.approvedAt) {
    return {
      phase,
      blockedBy: `Research contract v${String(contract.version ?? "?")} is a draft awaiting the researcher's approval. The Research Director cannot approve its own contract.`,
      // Naming a tool here would invite the director to try to approve it, which the store refuses.
      // The correct move is to stop, which has to be said as plainly as any other step.
      nextRequiredStep: "Stop and wait. Present the draft contract to the researcher with a recommendation and do not begin analysis work until it is approved.",
      waitingOnResearcher: true,
    };
  }

  // Any phase can be waiting on a person. Checked before the "you may advance" branches, because
  // telling the director to pass a gate a person has not opened is worse than saying nothing.
  const pending = input.pendingResearcherDecision ?? null;
  if (pending && pending.count > 0) {
    return {
      phase,
      blockedBy: `${pending.count} ${pending.what} still need the researcher's approval, and this phase's gate refuses anything unapproved. The Research Director cannot approve them.`,
      nextGate: describeGate(phase, input.nextGate),
      // No tool name: the director has none for this, and pointing it at one sends it back to the
      // same locked door it already tried twice.
      nextRequiredStep: `Stop and wait. Present the ${pending.what} to the researcher with a recommendation, and do not retry the phase gate until they are approved.`,
      waitingOnResearcher: true,
    };
  }

  if (phase !== null && PRE_CONTRACT_PHASES.has(phase)) {
    return {
      phase,
      blockedBy: null,
      // Named, because this door the director CAN open. Measured: with the contract approved the
      // study still sat at intake while the model kept running analyses -- knowing it "should
      // advance" is not the same as knowing which call advances it.
      gateEvidenceSha256: input.approvedTermsSha256 ?? null,
      nextGate: describeGate(phase, input.nextGate),
      nextRequiredStep: input.approvedTermsSha256 && input.nextGate
        ? `The contract is approved. Call append_research_lifecycle_revision with phase "${input.nextGate.toPhase}" and preconditions {kind:"phase_gate", fromPhase:"${phase}", toPhase:"${input.nextGate.toPhase}", gateCode:"${input.nextGate.gateCode}", evidenceSha256:"${input.approvedTermsSha256}"}, then begin literature synthesis.`
        : "The contract is approved. Call append_research_lifecycle_revision to move the phase out of intake, then begin literature synthesis.",
      waitingOnResearcher: false,
    };
  }

  return {
    phase,
    blockedBy: null,
    nextGate: describeGate(phase, input.nextGate),
    // Every later phase has a gate code too, and none of them were obtainable either. Naming the
    // next one costs nothing and removes the same wall eleven times.
    nextRequiredStep: input.nextGate
      ? `Continue the current phase. When its evidence is recorded, advance with append_research_lifecycle_revision to "${input.nextGate.toPhase}" using gateCode "${input.nextGate.gateCode}".`
      : "Continue the current phase and record the evidence its gate requires before advancing.",
    waitingOnResearcher: false,
  };
}
