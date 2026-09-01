import { createHash } from "node:crypto";
import {
  isScienceChemistryDocumentPayload,
  type ScienceChemistryDocumentPayload,
  type ScienceRendererBinding,
} from "../../shared/science-renderer-runtime";
import type { ResolvedScienceRendererExecutor } from "./renderer-registry";
import { runSignedScienceExecutor } from "./signed-executor";

const EXECUTOR_ID = "agentlas.smiles-to-ketcher";

export interface ScienceChemistryValidatorAuthority {
  resolveExact(binding: ScienceRendererBinding, artifactKind: "chemistry.document", executorId: string): ResolvedScienceRendererExecutor | null;
}

export interface ScienceChemistryValidationResult {
  payload: ScienceChemistryDocumentPayload;
  semantic: Record<string, unknown>;
  executorEntrySha256: string;
  executorDescriptorSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class ScienceChemistryValidator {
  constructor(private readonly authority: ScienceChemistryValidatorAuthority) {}

  async validateKet(input: { title: string; ket: string; binding: ScienceRendererBinding }): Promise<ScienceChemistryValidationResult> {
    const result = await this.validateSource({ title: input.title, format: "ket", value: input.ket, binding: input.binding });
    if (result.payload.document.ket !== input.ket || result.payload.document.ketSha256 !== sha256(input.ket)) {
      throw new Error("science-chemistry-validation-failed");
    }
    return result;
  }

  async validateSmiles(input: { title: string; smiles: string; binding: ScienceRendererBinding }): Promise<ScienceChemistryValidationResult> {
    return this.validateSource({ title: input.title, format: "smiles", value: input.smiles, binding: input.binding });
  }

  private async validateSource(input: {
    title: string;
    format: "ket" | "smiles";
    value: string;
    binding: ScienceRendererBinding;
  }): Promise<ScienceChemistryValidationResult> {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 240) throw new Error("science-chemistry-validation-title-invalid");
    const maximum = input.format === "ket" ? 3 * 1024 * 1024 : 100_000;
    if (typeof input.value !== "string" || !input.value.trim() || input.value.length > maximum) {
      throw new Error(`science-chemistry-validation-${input.format}-invalid`);
    }
    const resolved = this.authority.resolveExact(input.binding, "chemistry.document", EXECUTOR_ID);
    if (!resolved) throw new Error("science-chemistry-validator-unavailable");
    const bytes = Buffer.from(JSON.stringify({
      schema: "agentlas.science-ketcher-validation-input/v1",
      title: input.title.trim(),
      source: { format: input.format, value: input.value },
    }), "utf8");
    let receipt;
    try {
      receipt = await runSignedScienceExecutor(resolved, bytes);
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
      if (code === "science-signed-executor-os-sandbox-unavailable" || code === "science-signed-executor-managed-node-unavailable") {
        throw new Error("science-chemistry-validator-unavailable");
      }
      throw new Error("science-chemistry-validation-failed");
    }
    let envelope: unknown;
    try { envelope = JSON.parse(receipt.output.toString("utf8")); } catch { throw new Error("science-chemistry-validation-output-invalid"); }
    if (!isRecord(envelope) || envelope.schema !== "agentlas.science-tool-artifact-candidate/v2" || !isRecord(envelope.artifact)) {
      throw new Error("science-chemistry-validation-output-invalid");
    }
    const artifact = envelope.artifact;
    if (artifact.kind !== "chemistry.document" || artifact.rendererId !== "agentlas.ketcher"
      || !isScienceChemistryDocumentPayload(artifact.payload) || !isRecord(artifact.semantic)) throw new Error("science-chemistry-validation-output-invalid");
    const document = isRecord(artifact.payload.document) ? artifact.payload.document : null;
    const validation = isRecord(artifact.payload.validation) ? artifact.payload.validation : null;
    if (!document || document.format !== "ket"
      || document.ketSha256 !== sha256(String(document.ket ?? "")) || !validation
      || validation.schema !== "agentlas.science-chemistry-validation/v1"
      || validation.ketSha256 !== document.ketSha256
      || validation.code !== "structure-valid"
      || !Array.isArray(validation.warnings) || validation.warnings.length !== 0) {
      throw new Error("science-chemistry-validation-failed");
    }
    return {
      payload: artifact.payload,
      semantic: artifact.semantic,
      executorEntrySha256: receipt.entrySha256,
      executorDescriptorSha256: receipt.executorDescriptorSha256,
    };
  }
}
