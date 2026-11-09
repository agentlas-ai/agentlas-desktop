/**
 * Plain sentences for the host's typed "durable evidence is not ready" codes. A verdict reason is read by the owner (Goal panel,
 * phone) and by the next episode's model; it must say what is missing, not print an internal code. a real installation 643 of 948
 * verification receipts read "unavailable (invocation_failed)", "(verification_boundary_unconfirmed)" or "(durable_evidence_ready)",
 * the last one contradicting itself ("unavailable" while the cause says ready). The code stays the typed source; only the sentence changes.
 */
export function durableEvidenceUnavailableSentence(reason: string): string {
  switch (reason) {
    case "verification_boundary_unconfirmed":
      return "The host could not pin this Goal, its source and the turn's effect record, so nothing could be checked against them yet.";
    case "durable_evidence_ready":
      return "The host evidence for this turn is ready, but this requirement has no proof rule recorded yet, so it will be checked again.";
    case "concrete_evidence_missing":
      return "The turn finished but left no tool result, file or artifact that shows the claimed outcome.";
    case "invocation_receipt_missing":
      return "The turn being checked has no saved start and end record, so its result could not be read.";
    default: {
      const status = /^invocation_([a-z_]+)$/.exec(reason)?.[1];
      if (status === "failed") return "The turn being checked did not finish, so its result could not be read yet.";
      if (status) return `The turn being checked ended as "${status.replace(/_/g, " ")}", not completed, so its result could not be read.`;
      return "The host has no saved evidence of this turn's result yet.";
    }
  }
}
