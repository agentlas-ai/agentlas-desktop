import { createHash, randomUUID } from "node:crypto";
import type {
  RecordScienceArtifactValidationResult,
  ScienceArtifactValidationRunArtifactBinding,
  ScienceManuscriptBindingInput,
  ScienceResearchRun,
  ScienceRunArtifactBinding,
} from "../../shared/science-contract";
import type { ScienceStore } from "./store";

const VALIDATOR_ID = "agentlas.publication-provenance-closure";
const VALIDATOR_VERSION = "2.0.0";
const POLICY_ID = "agentlas.science-publication-gate";
const POLICY_VERSION = "1";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableUuid(seed: string): string {
  const hex = sha256(seed).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export interface ValidateScienceArtifactForPublicationInput {
  requestId?: string;
  projectId: string;
  artifactId: string;
  artifactVersion: number;
}

export interface ValidateScienceArtifactForPublicationResult extends RecordScienceArtifactValidationResult {
  runArtifactBinding: ScienceArtifactValidationRunArtifactBinding;
  bindingTarget: Extract<ScienceManuscriptBindingInput["target"], { kind: "artifact" }>;
}

interface PublicationClosureStore {
  getArtifactValidationRunArtifactBindingForProject(
    projectId: string,
    receiptId: string,
  ): ScienceArtifactValidationRunArtifactBinding | null;
}

function exactRunArtifactClosure(
  projectId: string,
  artifactId: string,
  artifactVersion: number,
  artifactContentSha256: string,
  run: ScienceResearchRun,
  binding: ScienceRunArtifactBinding | null,
): Omit<ScienceArtifactValidationRunArtifactBinding, "receiptId" | "createdAt"> {
  if (!binding) throw new Error("science-publication-run-artifact-binding-missing");
  if (binding.projectId !== projectId
    || binding.runId !== run.id
    || binding.artifactId !== artifactId
    || binding.artifactVersion !== artifactVersion
    || binding.artifactContentSha256 !== artifactContentSha256) {
    throw new Error("science-publication-run-artifact-binding-invalid");
  }
  const outputIndex = run.outputs.findIndex((output) => output.id === binding.outputId);
  const output = outputIndex < 0 ? null : run.outputs[outputIndex]!;
  if (!output || output.sha256 !== binding.outputSha256) throw new Error("science-publication-run-output-invalid");
  return {
    projectId,
    runArtifactBindingId: binding.id,
    runId: run.id,
    outputId: output.id,
    outputOrdinal: outputIndex + 1,
    outputRole: output.role,
    outputSha256: output.sha256,
    artifactId,
    artifactVersion,
    artifactContentSha256,
  };
}

function sameClosure(
  actual: ScienceArtifactValidationRunArtifactBinding | null,
  expected: Omit<ScienceArtifactValidationRunArtifactBinding, "receiptId" | "createdAt">,
): actual is ScienceArtifactValidationRunArtifactBinding {
  return Boolean(actual
    && actual.projectId === expected.projectId
    && actual.runArtifactBindingId === expected.runArtifactBindingId
    && actual.runId === expected.runId
    && actual.outputId === expected.outputId
    && actual.outputOrdinal === expected.outputOrdinal
    && actual.outputRole === expected.outputRole
    && actual.outputSha256 === expected.outputSha256
    && actual.artifactId === expected.artifactId
    && actual.artifactVersion === expected.artifactVersion
    && actual.artifactContentSha256 === expected.artifactContentSha256);
}

/**
 * Trusted main-process validator for the narrow claim that an immutable Lab
 * artifact, its succeeded source run, and an adopted render capture form one
 * closed publication-evidence chain. Scientific interpretation and journal
 * policy are deliberately validated by their own later gates.
 */
export class ScienceArtifactPublicationValidator {
  private readonly closureStore: ScienceStore & PublicationClosureStore;

  constructor(private readonly store: ScienceStore) {
    this.closureStore = store as ScienceStore & PublicationClosureStore;
  }

  validate(input: ValidateScienceArtifactForPublicationInput): ValidateScienceArtifactForPublicationResult {
    const context = this.store.getArtifactContextForProject(input.projectId, input.artifactId, input.artifactVersion);
    if (!context || !context.artifact.sourceRunId) throw new Error("science-publication-artifact-run-missing");
    if (context.selectedVersion.version !== input.artifactVersion) throw new Error("science-publication-artifact-version-conflict");
    const run = this.store.getResearchRunForProject(input.projectId, context.artifact.sourceRunId);
    if (!run || run.status !== "succeeded" || !run.outputManifestSha256) throw new Error("science-publication-run-invalid");
    const runArtifactBinding = this.store.getRunArtifactBinding(input.projectId, run.id);
    const expectedClosure = exactRunArtifactClosure(
      input.projectId,
      context.artifact.id,
      input.artifactVersion,
      context.selectedVersion.contentSha256,
      run,
      runArtifactBinding,
    );
    const preview = this.store.artifactVisualPreviewForProject(input.projectId, input.artifactId, input.artifactVersion);
    if (!preview) throw new Error("science-publication-capture-missing");
    if (preview.width < 320 || preview.height < 200) throw new Error("science-publication-capture-too-small");

    const priorEntry = this.store.listArtifactValidationReceipts(input.projectId, input.artifactId, input.artifactVersion)
      .map((receipt) => ({
        receipt,
        closure: this.closureStore.getArtifactValidationRunArtifactBindingForProject(input.projectId, receipt.id),
      }))
      .find(({ receipt, closure }) => receipt.status === "verified"
        && receipt.artifactContentSha256 === context.selectedVersion.contentSha256
        && receipt.artifactLinkageSha256 === context.linkage.linkageSha256
        && receipt.visualAssetSha256 === preview.sha256
        && receipt.researchRunId === run.id
        && receipt.environmentSha256 === run.environmentSha256
        && receipt.validatorId === VALIDATOR_ID
        && receipt.validatorVersion === VALIDATOR_VERSION
        && receipt.policyId === POLICY_ID
        && receipt.policyVersion === POLICY_VERSION
        && sameClosure(closure, expectedClosure));
    if (priorEntry && priorEntry.closure) {
      const prior = priorEntry.receipt;
      return {
        receipt: prior,
        runArtifactBinding: priorEntry.closure,
        replayed: true,
        bindingTarget: {
          kind: "artifact",
          artifactId: prior.artifactId,
          artifactVersion: prior.artifactVersion,
          captureId: prior.visualCaptureId,
          validationReceiptId: prior.id,
        },
      };
    }

    const challengeSha256 = sha256(canonicalJson({
      schema: "agentlas.science-publication-validation-challenge/v2",
      projectId: input.projectId,
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      artifactContentSha256: context.selectedVersion.contentSha256,
      visualAssetSha256: preview.sha256,
      researchRunId: run.id,
      runArtifactBinding: expectedClosure,
    }));
    const inputSha256 = sha256(canonicalJson({
      artifactContentSha256: context.selectedVersion.contentSha256,
      artifactLinkageSha256: context.linkage.linkageSha256,
      visualAssetSha256: preview.sha256,
      researchRunId: run.id,
      runInputManifestSha256: run.inputManifestSha256,
      runOutputManifestSha256: run.outputManifestSha256,
      runArtifactBinding: expectedClosure,
      challengeSha256,
      validatorId: VALIDATOR_ID,
      validatorVersion: VALIDATOR_VERSION,
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
    }));
    const requestId = input.requestId ?? stableUuid(`science-publication-validation:v2:${input.projectId}:${input.artifactId}:${input.artifactVersion}:${preview.sha256}:${expectedClosure.runArtifactBindingId}`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("science-request-id-invalid");
    const recorded = this.store.recordArtifactValidation({
      requestId,
      projectId: input.projectId,
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      validatorId: VALIDATOR_ID,
      validatorVersion: VALIDATOR_VERSION,
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      status: "verified",
      checks: [
        "exact-artifact-version",
        "artifact-linkage-closure",
        "succeeded-source-run",
        "exact-run-manifests",
        "adopted-main-process-capture",
        "visual-asset-cas-integrity",
        "minimum-pixel-dimensions",
      ],
      warnings: [],
      challengeSha256,
      inputSha256,
      environmentSha256: run.environmentSha256,
      runArtifactBindingId: expectedClosure.runArtifactBindingId,
    });
    const recordedClosure = recorded.runArtifactBinding
      ?? this.closureStore.getArtifactValidationRunArtifactBindingForProject(input.projectId, recorded.receipt.id);
    if (!sameClosure(recordedClosure, expectedClosure) || recordedClosure.receiptId !== recorded.receipt.id) {
      throw new Error("science-publication-validation-run-artifact-closure-invalid");
    }
    return {
      ...recorded,
      runArtifactBinding: recordedClosure,
      bindingTarget: {
        kind: "artifact",
        artifactId: recorded.receipt.artifactId,
        artifactVersion: recorded.receipt.artifactVersion,
        captureId: recorded.receipt.visualCaptureId,
        validationReceiptId: recorded.receipt.id,
      },
    };
  }
}

export function sciencePublicationValidationRequestId(seed: string): string {
  return stableUuid(`science-publication-validation-request:v2:${seed || randomUUID()}`);
}
