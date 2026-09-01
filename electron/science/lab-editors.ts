import type { AppendScienceArtifactVersionResult } from "../../shared/science-contract";
import {
  SCIENCE_RESIDUE_INTERACTION_SCHEMA,
  type ScienceProteinColorTheme,
  type ScienceProteinRepresentation,
  type ScienceResidueInteraction,
} from "../../shared/science-renderer-runtime";
import type { ScienceChemistryValidator } from "./chemistry-validator";
import { validateScienceResidueInteraction } from "./protein-residue-validator";
import type { ScienceStore } from "./store";

export interface ScienceChemistrySmilesEditInput {
  requestId: string;
  projectId: string;
  artifactId: string;
  expectedArtifactVersion: number;
  expectedContentSha256: string;
  title: string;
  smiles: string;
  actionContext?: { conversationId: string; originMessageId: string; turnId: string };
}

export interface ScienceMolstarViewEditInput {
  requestId: string;
  projectId: string;
  artifactId: string;
  expectedArtifactVersion: number;
  expectedContentSha256: string;
  representation: ScienceProteinRepresentation;
  colorTheme: ScienceProteinColorTheme;
  interaction?: ScienceResidueInteraction;
  actionContext?: { conversationId: string; originMessageId: string; turnId: string };
}

export async function commitScienceChemistrySmilesEdit(
  store: ScienceStore,
  validator: ScienceChemistryValidator,
  input: ScienceChemistrySmilesEditInput,
): Promise<AppendScienceArtifactVersionResult> {
  const context = store.getArtifactContextForProject(input.projectId, input.artifactId, input.expectedArtifactVersion);
  if (!context || context.artifact.kind !== "chemistry.document" || context.selectedVersion.rendererId !== "agentlas.ketcher") {
    throw new Error("science-chemistry-artifact-not-found");
  }
  if (context.artifact.currentVersion !== input.expectedArtifactVersion
    || context.selectedVersion.contentSha256 !== input.expectedContentSha256) throw new Error("science-artifact-version-conflict");
  if (!context.selectedVersion.rendererBinding) throw new Error("science-renderer-binding-conflict");
  const authoritative = await validator.validateSmiles({
    title: input.title,
    smiles: input.smiles,
    binding: context.selectedVersion.rendererBinding,
  });
  const { document, validation } = authoritative.payload;
  const prior = context.selectedVersion.semantic;
  const priorWarnings = prior.warnings.filter((warning) => !warning.startsWith("Indigo validation:"));
  return store.appendArtifactVersion({
    requestId: input.requestId,
    projectId: input.projectId,
    artifactId: input.artifactId,
    expectedArtifactVersion: input.expectedArtifactVersion,
    expectedContentSha256: input.expectedContentSha256,
    payload: { document, validation },
    semantic: {
      ...prior,
      title: input.title.trim(),
      summary: `${input.title.trim()} — AI가 제안한 SMILES를 고정된 Indigo 실행기로 검증한 Chemistry Lab 버전입니다. Canonical SMILES: ${document.canonicalSmiles}`,
      observations: [
        ...prior.observations.filter((observation) => !["Atoms", "Bonds", "Canonical SMILES"].includes(observation.label)),
        { label: "Atoms", value: validation.atomCount, unit: null },
        { label: "Bonds", value: validation.bondCount, unit: null },
        { label: "Canonical SMILES", value: document.canonicalSmiles, unit: null },
      ],
      warnings: [...new Set([...priorWarnings, ...validation.warnings.map((warning) => `Indigo validation: ${warning}`)])],
    },
    provenance: context.selectedVersion.provenance,
    actionContext: input.actionContext,
  });
}

export async function commitScienceMolstarViewEdit(
  store: ScienceStore,
  input: ScienceMolstarViewEditInput,
): Promise<AppendScienceArtifactVersionResult> {
  const context = store.getArtifactContextForProject(input.projectId, input.artifactId, input.expectedArtifactVersion);
  if (!context || context.artifact.kind !== "protein.structure" || context.selectedVersion.rendererId !== "agentlas.molstar") {
    throw new Error("science-molstar-artifact-not-found");
  }
  if (context.artifact.currentVersion !== input.expectedArtifactVersion
    || context.selectedVersion.contentSha256 !== input.expectedContentSha256) throw new Error("science-artifact-version-conflict");
  if (!context.selectedVersion.rendererBinding) throw new Error("science-renderer-binding-conflict");
  const rendererInput = store.artifactRendererInputForProject(input.projectId, input.artifactId);
  if (rendererInput.kind !== "protein-structure") throw new Error("science-molstar-source-conflict");
  const interactionInput = input.interaction ?? {
    schema: SCIENCE_RESIDUE_INTERACTION_SCHEMA,
    granularity: "residue" as const,
    residues: [],
    focus: null,
  };
  const residue = await validateScienceResidueInteraction({
    bytes: rendererInput.bytes,
    format: rendererInput.format,
    structureContentSha256: rendererInput.assetSha256,
    interaction: interactionInput,
  });
  const prior = context.selectedVersion.semantic;
  return store.appendArtifactVersion({
    requestId: input.requestId,
    projectId: input.projectId,
    artifactId: input.artifactId,
    expectedArtifactVersion: input.expectedArtifactVersion,
    expectedContentSha256: input.expectedContentSha256,
    payload: {
      ...context.selectedVersion.payload,
      representation: input.representation,
      colorTheme: input.colorTheme,
      interaction: residue.interaction,
      interactionValidation: residue.validation,
    },
    semantic: {
      ...prior,
      summary: `${prior.title} — Mol* ${input.representation} / ${input.colorTheme} 상태와 검증된 잔기 선택을 저장한 Molecular Structure Lab 버전입니다.`,
      observations: [
        ...prior.observations.filter((observation) => !["Representation", "Color theme", "Pinned residues", "Focused residue"].includes(observation.label)),
        { label: "Representation", value: input.representation, unit: null },
        { label: "Color theme", value: input.colorTheme, unit: null },
        { label: "Pinned residues", value: residue.interaction.residues.length, unit: "residues" },
        { label: "Focused residue", value: residue.interaction.focus
          ? `${residue.interaction.focus.authAsymId}:${residue.interaction.focus.compId}${residue.interaction.focus.authSeqId}${residue.interaction.focus.insertionCode}`
          : "None", unit: null },
      ],
    },
    provenance: context.selectedVersion.provenance,
    actionContext: input.actionContext,
  });
}
