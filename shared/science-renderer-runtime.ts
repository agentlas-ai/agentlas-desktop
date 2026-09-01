export const SCIENCE_RENDERER_BINDING_SCHEMA = "agentlas.science-renderer-binding/v1" as const;
export const SCIENCE_RENDERER_EXECUTOR_BINDING_SCHEMA = "agentlas.science-renderer-executor-binding/v1" as const;
export const SCIENCE_RENDERER_REQUEST_SCHEMA = "agentlas.science-renderer-request/v1" as const;
export const SCIENCE_RENDERER_STATUS_SCHEMA = "agentlas.science-renderer-status/v1" as const;
export const SCIENCE_CHEMISTRY_VALIDATION_SCHEMA = "agentlas.science-chemistry-validation/v1" as const;
export const SCIENCE_CHEMISTRY_COMMIT_SCHEMA = "agentlas.science-chemistry-commit/v1" as const;
export const SCIENCE_MOLSTAR_COMMIT_SCHEMA_V1 = "agentlas.science-molstar-commit/v1" as const;
export const SCIENCE_MOLSTAR_COMMIT_SCHEMA = "agentlas.science-molstar-commit/v2" as const;
export const SCIENCE_RESIDUE_INTERACTION_SCHEMA = "agentlas.science-residue-interaction/v1" as const;
export const SCIENCE_RESIDUE_INTERACTION_VALIDATION_SCHEMA = "agentlas.science-residue-interaction-validation/v1" as const;

export type ScienceProteinRepresentation = "cartoon" | "ball-and-stick" | "surface";
export type ScienceProteinColorTheme = "chain-id" | "element-symbol" | "secondary-structure";

export interface ScienceResidueLocator {
  modelNum: number;
  operatorName: string;
  labelAsymId: string;
  authAsymId: string;
  labelSeqId: number | null;
  authSeqId: number;
  insertionCode: string;
  compId: string;
}

export interface ScienceResidueInteraction {
  schema: typeof SCIENCE_RESIDUE_INTERACTION_SCHEMA;
  granularity: "residue";
  residues: ScienceResidueLocator[];
  focus: ScienceResidueLocator | null;
}

export interface ScienceResidueInteractionValidation {
  schema: typeof SCIENCE_RESIDUE_INTERACTION_VALIDATION_SCHEMA;
  validator: "Mol*";
  validatorVersion: string;
  structureContentSha256: string;
  interactionSha256: string;
  resolvedResidueCount: number;
  focusResolved: boolean;
  code: "residue-interaction-valid";
}

export interface ScienceRendererBinding {
  schema: typeof SCIENCE_RENDERER_BINDING_SCHEMA;
  packId: string;
  packVersion: string;
  extensionManifestSha256: string;
  packDescriptorSha256: string;
  assetsMerkleRoot: string;
  rendererId: string;
  rendererVersion: string;
  rendererDescriptorSha256: string;
  entrySha256: string;
  inputSchemaSha256: string;
  semanticSchemaSha256: string;
}

export interface ScienceRendererExecutorBinding {
  schema: typeof SCIENCE_RENDERER_EXECUTOR_BINDING_SCHEMA;
  packId: string;
  packVersion: string;
  extensionManifestSha256: string;
  packDescriptorSha256: string;
  assetsMerkleRoot: string;
  rendererId: string;
  executorId: string;
  executorVersion: string;
  executorDescriptorSha256: string;
  entrySha256: string;
  enginesSha256: string;
  assetsSha256: string;
  runtime: "node";
  network: "deny-all";
  sandboxPolicy: "science-child-v1";
}

export interface ScienceRendererBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MountScienceRendererInput {
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  bounds: ScienceRendererBounds;
}

export interface ScienceProteinStructurePayload {
  structure: {
    sourceId: string;
    sourceVersionId: string;
    contentSha256: string;
    format: "pdb" | "mmcif";
  };
  representation: ScienceProteinRepresentation;
  colorTheme?: ScienceProteinColorTheme;
  interaction?: ScienceResidueInteraction;
  interactionValidation?: ScienceResidueInteractionValidation;
}

export interface ScienceMolstarCommitInput {
  schema: typeof SCIENCE_MOLSTAR_COMMIT_SCHEMA | typeof SCIENCE_MOLSTAR_COMMIT_SCHEMA_V1;
  instanceId: string;
  renderRequestId: string;
  requestId: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  viewState: {
    representation: ScienceProteinRepresentation;
    colorTheme: ScienceProteinColorTheme;
    interaction?: ScienceResidueInteraction;
  };
}

export interface ScienceChemistryValidationReceipt {
  schema: typeof SCIENCE_CHEMISTRY_VALIDATION_SCHEMA;
  engine: "Ketcher";
  engineVersion: string;
  validator: "Indigo";
  validatorVersion: string;
  ketSha256: string;
  canonicalSmilesSha256: string;
  atomCount: number;
  bondCount: number;
  warnings: string[];
  code: "structure-valid";
}

export interface ScienceChemistryDocumentPayload {
  document: {
    format: "ket";
    ket: string;
    ketSha256: string;
    canonicalSmiles: string;
    canonicalSmilesSha256: string;
  };
  validation: ScienceChemistryValidationReceipt;
}

export interface ScienceChemistryCommitInput {
  schema: typeof SCIENCE_CHEMISTRY_COMMIT_SCHEMA;
  instanceId: string;
  renderRequestId: string;
  requestId: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  document: ScienceChemistryDocumentPayload["document"];
  validation: ScienceChemistryValidationReceipt;
}

export interface ScienceRendererRenderRequest {
  schema: typeof SCIENCE_RENDERER_REQUEST_SCHEMA;
  instanceId: string;
  renderRequestId: string;
  artifactId: string;
  artifactVersion: number;
  artifactKind: string;
  artifactContentSha256: string;
  binding: ScienceRendererBinding;
  input:
    | {
        kind: "protein-structure";
        format: "pdb" | "mmcif";
        representation: ScienceProteinRepresentation;
        colorTheme: ScienceProteinColorTheme;
        interaction: ScienceResidueInteraction | null;
        interactionSha256: string | null;
        assetSha256: string;
        bytes: Uint8Array;
      }
    | {
        kind: "chemistry-document";
        format: "ket";
        ket: string;
        ketSha256: string;
        canonicalSmiles: string;
        canonicalSmilesSha256: string;
      };
}

export type ScienceRendererRuntimePhase =
  | "launching"
  | "probing"
  | "rendering"
  | "stable"
  | "capturing"
  | "ready"
  | "dirty"
  | "failed"
  | "disposed";

export interface ScienceRendererRuntimeStatus {
  schema: typeof SCIENCE_RENDERER_STATUS_SCHEMA;
  instanceId: string;
  renderRequestId: string;
  artifactId: string;
  artifactVersion: number;
  phase: ScienceRendererRuntimePhase;
  code: string | null;
  summary: string;
  captured: boolean;
}

export interface ScienceRendererGuestReport {
  instanceId: string;
  renderRequestId: string;
  sequence: number;
  phase: "probing" | "rendering" | "stable" | "dirty" | "clean" | "failed";
  sceneRevision: string | null;
  code: string | null;
  summary: string;
  observation: null | ScienceProteinStructureObservation | ScienceChemistryDocumentObservation;
}

export interface ScienceProteinStructureObservation {
  kind: "protein-structure";
  engineVersion: string;
  webgl2: boolean;
  modelCount: number;
  chainCount: number;
  residueCount: number;
  atomCount: number;
  representation: ScienceProteinRepresentation;
  colorTheme: ScienceProteinColorTheme;
  interactionSha256: string | null;
  selectedResidueCount: number;
  focusResolved: boolean;
  canvasWidth: number;
  canvasHeight: number;
}

export interface ScienceChemistryDocumentObservation {
  kind: "chemistry-document";
  engineVersion: string;
  validatorVersion: string;
  editable: boolean;
  documentSha256: string;
  canonicalSmilesSha256: string;
  atomCount: number;
  bondCount: number;
  canvasWidth: number;
  canvasHeight: number;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const RENDERER_ID_RE = /^[a-z][a-z0-9-]{1,31}(?:\.[a-z][a-z0-9-]{1,63})+$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_RESIDUE_TEXT_RE = /^[A-Za-z0-9_.:+-]{0,80}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function isScienceRendererBinding(value: unknown): value is ScienceRendererBinding {
  if (!record(value) || !exact(value, [
    "schema", "packId", "packVersion", "extensionManifestSha256", "packDescriptorSha256",
    "assetsMerkleRoot", "rendererId", "rendererVersion", "rendererDescriptorSha256", "entrySha256",
    "inputSchemaSha256", "semanticSchemaSha256",
  ])) return false;
  return value.schema === SCIENCE_RENDERER_BINDING_SCHEMA
    && typeof value.packId === "string" && ID_RE.test(value.packId)
    && typeof value.packVersion === "string" && VERSION_RE.test(value.packVersion)
    && typeof value.rendererId === "string" && RENDERER_ID_RE.test(value.rendererId)
    && safeText(value.rendererVersion, 80)
    && [value.extensionManifestSha256, value.packDescriptorSha256, value.assetsMerkleRoot, value.rendererDescriptorSha256, value.entrySha256, value.inputSchemaSha256, value.semanticSchemaSha256]
      .every((digest) => typeof digest === "string" && SHA256_RE.test(digest));
}

export function scienceRendererBindingsEqual(left: unknown, right: unknown): left is ScienceRendererBinding {
  if (!isScienceRendererBinding(left) || !isScienceRendererBinding(right)) return false;
  return Object.keys(left).every((key) => left[key as keyof ScienceRendererBinding] === right[key as keyof ScienceRendererBinding]);
}

export function isScienceRendererExecutorBinding(value: unknown): value is ScienceRendererExecutorBinding {
  if (!record(value) || !exact(value, [
    "schema", "packId", "packVersion", "extensionManifestSha256", "packDescriptorSha256", "assetsMerkleRoot",
    "rendererId", "executorId", "executorVersion", "executorDescriptorSha256", "entrySha256", "enginesSha256",
    "assetsSha256", "runtime", "network", "sandboxPolicy",
  ])) return false;
  return value.schema === SCIENCE_RENDERER_EXECUTOR_BINDING_SCHEMA
    && typeof value.packId === "string" && ID_RE.test(value.packId)
    && typeof value.packVersion === "string" && VERSION_RE.test(value.packVersion)
    && typeof value.rendererId === "string" && RENDERER_ID_RE.test(value.rendererId)
    && typeof value.executorId === "string" && RENDERER_ID_RE.test(value.executorId)
    && typeof value.executorVersion === "string" && VERSION_RE.test(value.executorVersion)
    && value.runtime === "node" && value.network === "deny-all" && value.sandboxPolicy === "science-child-v1"
    && [value.extensionManifestSha256, value.packDescriptorSha256, value.assetsMerkleRoot, value.executorDescriptorSha256,
      value.entrySha256, value.enginesSha256, value.assetsSha256]
      .every((digest) => typeof digest === "string" && SHA256_RE.test(digest));
}

export function scienceRendererExecutorBindingsEqual(left: unknown, right: unknown): left is ScienceRendererExecutorBinding {
  if (!isScienceRendererExecutorBinding(left) || !isScienceRendererExecutorBinding(right)) return false;
  return Object.keys(left).every((key) => left[key as keyof ScienceRendererExecutorBinding] === right[key as keyof ScienceRendererExecutorBinding]);
}

export function scienceRendererExecutorMatchesRenderer(
  executor: ScienceRendererExecutorBinding,
  renderer: ScienceRendererBinding,
): boolean {
  return executor.packId === renderer.packId
    && executor.packVersion === renderer.packVersion
    && executor.extensionManifestSha256 === renderer.extensionManifestSha256
    && executor.packDescriptorSha256 === renderer.packDescriptorSha256
    && executor.assetsMerkleRoot === renderer.assetsMerkleRoot
    && executor.rendererId === renderer.rendererId;
}

export function isScienceProteinStructurePayload(value: unknown): value is ScienceProteinStructurePayload {
  if (!record(value)
    || ![
      ["structure", "representation"],
      ["structure", "representation", "colorTheme"],
      ["structure", "representation", "interaction", "interactionValidation"],
      ["structure", "representation", "colorTheme", "interaction", "interactionValidation"],
    ].some((keys) => exact(value, keys))
    || !record(value.structure)) return false;
  if (!exact(value.structure, ["sourceId", "sourceVersionId", "contentSha256", "format"])) return false;
  return typeof value.structure.sourceId === "string" && UUID_RE.test(value.structure.sourceId)
    && typeof value.structure.sourceVersionId === "string" && UUID_RE.test(value.structure.sourceVersionId)
    && typeof value.structure.contentSha256 === "string" && SHA256_RE.test(value.structure.contentSha256)
    && (value.structure.format === "pdb" || value.structure.format === "mmcif")
    && (value.representation === "cartoon" || value.representation === "ball-and-stick" || value.representation === "surface")
    && (value.colorTheme === undefined || value.colorTheme === "chain-id" || value.colorTheme === "element-symbol" || value.colorTheme === "secondary-structure")
    && (value.interaction === undefined
      ? value.interactionValidation === undefined
      : isScienceResidueInteraction(value.interaction)
        && isScienceResidueInteractionValidation(value.interactionValidation, value.structure.contentSha256, value.interaction));
}

export function scienceResidueLocatorKey(value: ScienceResidueLocator): string {
  return [value.modelNum, value.operatorName, value.labelAsymId, value.authAsymId, value.labelSeqId === null ? "~" : value.labelSeqId,
    value.authSeqId, value.insertionCode, value.compId].join("\u001f");
}

export function compareScienceResidueLocators(left: ScienceResidueLocator, right: ScienceResidueLocator): number {
  return scienceResidueLocatorKey(left).localeCompare(scienceResidueLocatorKey(right), "en");
}

export function isScienceResidueLocator(value: unknown): value is ScienceResidueLocator {
  if (!record(value) || !exact(value, [
    "modelNum", "operatorName", "labelAsymId", "authAsymId", "labelSeqId", "authSeqId", "insertionCode", "compId",
  ])) return false;
  return Number.isSafeInteger(value.modelNum) && Number(value.modelNum) >= 1 && Number(value.modelNum) <= 1_000_000
    && typeof value.operatorName === "string" && SAFE_RESIDUE_TEXT_RE.test(value.operatorName) && value.operatorName.length > 0
    && typeof value.labelAsymId === "string" && SAFE_RESIDUE_TEXT_RE.test(value.labelAsymId) && value.labelAsymId.length > 0
    && typeof value.authAsymId === "string" && SAFE_RESIDUE_TEXT_RE.test(value.authAsymId)
    && (value.labelSeqId === null || (Number.isSafeInteger(value.labelSeqId) && Math.abs(Number(value.labelSeqId)) <= 100_000_000))
    && Number.isSafeInteger(value.authSeqId) && Math.abs(Number(value.authSeqId)) <= 100_000_000
    && typeof value.insertionCode === "string" && SAFE_RESIDUE_TEXT_RE.test(value.insertionCode) && value.insertionCode.length <= 8
    && typeof value.compId === "string" && SAFE_RESIDUE_TEXT_RE.test(value.compId) && value.compId.length > 0;
}

export function isScienceResidueInteraction(value: unknown): value is ScienceResidueInteraction {
  if (!record(value) || !exact(value, ["schema", "granularity", "residues", "focus"])) return false;
  if (value.schema !== SCIENCE_RESIDUE_INTERACTION_SCHEMA || value.granularity !== "residue" || !Array.isArray(value.residues) || value.residues.length > 512) return false;
  if (!value.residues.every(isScienceResidueLocator)) return false;
  const keys = value.residues.map(scienceResidueLocatorKey);
  if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) return false;
  if (value.focus !== null && !isScienceResidueLocator(value.focus)) return false;
  return value.focus === null || keys.includes(scienceResidueLocatorKey(value.focus));
}

export function isScienceResidueInteractionValidation(
  value: unknown,
  structureContentSha256?: string,
  interaction?: ScienceResidueInteraction,
): value is ScienceResidueInteractionValidation {
  if (!record(value) || !exact(value, [
    "schema", "validator", "validatorVersion", "structureContentSha256", "interactionSha256", "resolvedResidueCount", "focusResolved", "code",
  ])) return false;
  return value.schema === SCIENCE_RESIDUE_INTERACTION_VALIDATION_SCHEMA
    && value.validator === "Mol*" && safeText(value.validatorVersion, 80)
    && typeof value.structureContentSha256 === "string" && SHA256_RE.test(value.structureContentSha256)
    && (structureContentSha256 === undefined || value.structureContentSha256 === structureContentSha256)
    && typeof value.interactionSha256 === "string" && SHA256_RE.test(value.interactionSha256)
    && Number.isSafeInteger(value.resolvedResidueCount) && Number(value.resolvedResidueCount) >= 0 && Number(value.resolvedResidueCount) <= 512
    && value.focusResolved === (interaction?.focus !== null && interaction?.focus !== undefined)
    && value.resolvedResidueCount === (interaction?.residues.length ?? value.resolvedResidueCount)
    && value.code === "residue-interaction-valid";
}

export function defaultScienceProteinColorTheme(representation: ScienceProteinRepresentation): ScienceProteinColorTheme {
  return representation === "ball-and-stick" ? "element-symbol" : "chain-id";
}

function isScienceChemistryValidationReceipt(value: unknown): value is ScienceChemistryValidationReceipt {
  if (!record(value) || !exact(value, [
    "schema", "engine", "engineVersion", "validator", "validatorVersion", "ketSha256",
    "canonicalSmilesSha256", "atomCount", "bondCount", "warnings", "code",
  ])) return false;
  return value.schema === SCIENCE_CHEMISTRY_VALIDATION_SCHEMA
    && value.engine === "Ketcher" && safeText(value.engineVersion, 80)
    && value.validator === "Indigo" && safeText(value.validatorVersion, 80)
    && typeof value.ketSha256 === "string" && SHA256_RE.test(value.ketSha256)
    && typeof value.canonicalSmilesSha256 === "string" && SHA256_RE.test(value.canonicalSmilesSha256)
    && Number.isSafeInteger(value.atomCount) && Number(value.atomCount) >= 1 && Number(value.atomCount) <= 1_000_000
    && Number.isSafeInteger(value.bondCount) && Number(value.bondCount) >= 0 && Number(value.bondCount) <= 2_000_000
    && Array.isArray(value.warnings) && value.warnings.length <= 200
    && value.warnings.every((warning) => safeText(warning, 2_000))
    && value.code === "structure-valid";
}

export function isScienceChemistryDocumentPayload(value: unknown): value is ScienceChemistryDocumentPayload {
  if (!record(value) || !exact(value, ["document", "validation"]) || !record(value.document)) return false;
  if (!exact(value.document, ["format", "ket", "ketSha256", "canonicalSmiles", "canonicalSmilesSha256"])) return false;
  if (value.document.format !== "ket" || !safeText(value.document.ket, 2 * 1024 * 1024) || !safeText(value.document.canonicalSmiles, 100_000)) return false;
  if (typeof value.document.ketSha256 !== "string" || !SHA256_RE.test(value.document.ketSha256)) return false;
  if (typeof value.document.canonicalSmilesSha256 !== "string" || !SHA256_RE.test(value.document.canonicalSmilesSha256)) return false;
  if (!isScienceChemistryValidationReceipt(value.validation)) return false;
  return value.document.ketSha256 === value.validation.ketSha256
    && value.document.canonicalSmilesSha256 === value.validation.canonicalSmilesSha256;
}

export function isScienceChemistryCommitInput(value: unknown): value is ScienceChemistryCommitInput {
  if (!record(value) || !exact(value, [
    "schema", "instanceId", "renderRequestId", "requestId", "artifactId", "artifactVersion",
    "artifactContentSha256", "document", "validation",
  ])) return false;
  return value.schema === SCIENCE_CHEMISTRY_COMMIT_SCHEMA
    && UUID_RE.test(String(value.instanceId)) && UUID_RE.test(String(value.renderRequestId))
    && UUID_RE.test(String(value.requestId)) && UUID_RE.test(String(value.artifactId))
    && Number.isSafeInteger(value.artifactVersion) && Number(value.artifactVersion) >= 1
    && typeof value.artifactContentSha256 === "string" && SHA256_RE.test(value.artifactContentSha256)
    && isScienceChemistryDocumentPayload({ document: value.document, validation: value.validation });
}

export function isScienceMolstarCommitInput(value: unknown): value is ScienceMolstarCommitInput {
  if (!record(value) || !exact(value, [
    "schema", "instanceId", "renderRequestId", "requestId", "artifactId", "artifactVersion",
    "artifactContentSha256", "viewState",
  ]) || !record(value.viewState)) return false;
  const legacy = value.schema === SCIENCE_MOLSTAR_COMMIT_SCHEMA_V1;
  if (legacy ? !exact(value.viewState, ["representation", "colorTheme"]) : !exact(value.viewState, ["representation", "colorTheme", "interaction"])) return false;
  return (legacy || value.schema === SCIENCE_MOLSTAR_COMMIT_SCHEMA)
    && UUID_RE.test(String(value.instanceId)) && UUID_RE.test(String(value.renderRequestId))
    && UUID_RE.test(String(value.requestId)) && UUID_RE.test(String(value.artifactId))
    && Number.isSafeInteger(value.artifactVersion) && Number(value.artifactVersion) >= 1
    && typeof value.artifactContentSha256 === "string" && SHA256_RE.test(value.artifactContentSha256)
    && (value.viewState.representation === "cartoon" || value.viewState.representation === "ball-and-stick" || value.viewState.representation === "surface")
    && (value.viewState.colorTheme === "chain-id" || value.viewState.colorTheme === "element-symbol" || value.viewState.colorTheme === "secondary-structure")
    && (legacy || isScienceResidueInteraction(value.viewState.interaction));
}

export function isMountScienceRendererInput(value: unknown): value is MountScienceRendererInput {
  if (!record(value) || !exact(value, ["projectId", "artifactId", "artifactVersion", "contentSha256", "bounds"]) || !record(value.bounds)) return false;
  if (!exact(value.bounds, ["x", "y", "width", "height"])) return false;
  const numbers = [value.bounds.x, value.bounds.y, value.bounds.width, value.bounds.height];
  return typeof value.projectId === "string" && UUID_RE.test(value.projectId)
    && typeof value.artifactId === "string" && UUID_RE.test(value.artifactId)
    && Number.isSafeInteger(value.artifactVersion) && Number(value.artifactVersion) >= 1
    && typeof value.contentSha256 === "string" && SHA256_RE.test(value.contentSha256)
    && numbers.every((item) => typeof item === "number" && Number.isFinite(item))
    && Number(value.bounds.width) >= 240 && Number(value.bounds.height) >= 200;
}

export function isScienceRendererGuestReport(value: unknown): value is ScienceRendererGuestReport {
  if (!record(value) || !exact(value, ["instanceId", "renderRequestId", "sequence", "phase", "sceneRevision", "code", "summary", "observation"])) return false;
  if (!UUID_RE.test(String(value.instanceId)) || !UUID_RE.test(String(value.renderRequestId))) return false;
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || Number(value.sequence) > 10_000) return false;
  if (!["probing", "rendering", "stable", "dirty", "clean", "failed"].includes(String(value.phase))) return false;
  if (value.sceneRevision !== null && (typeof value.sceneRevision !== "string" || !SHA256_RE.test(value.sceneRevision))) return false;
  if (value.phase === "stable" && (typeof value.sceneRevision !== "string" || !SHA256_RE.test(value.sceneRevision))) return false;
  if (value.code !== null && !safeText(value.code, 160)) return false;
  if (!safeText(value.summary, 2_000)) return false;
  if (value.observation === null) return value.phase !== "stable";
  if (!record(value.observation) || !safeText(value.observation.engineVersion, 80)) return false;
  if (value.observation.kind === "protein-structure") {
    if (!exact(value.observation, ["kind", "engineVersion", "webgl2", "modelCount", "chainCount", "residueCount", "atomCount", "representation", "colorTheme", "interactionSha256", "selectedResidueCount", "focusResolved", "canvasWidth", "canvasHeight"])) return false;
    if (typeof value.observation.webgl2 !== "boolean") return false;
    if (!(value.observation.representation === "cartoon" || value.observation.representation === "ball-and-stick" || value.observation.representation === "surface")) return false;
    if (!(value.observation.colorTheme === "chain-id" || value.observation.colorTheme === "element-symbol" || value.observation.colorTheme === "secondary-structure")) return false;
    if (value.observation.interactionSha256 !== null && (typeof value.observation.interactionSha256 !== "string" || !SHA256_RE.test(value.observation.interactionSha256))) return false;
    if (!Number.isSafeInteger(value.observation.selectedResidueCount) || Number(value.observation.selectedResidueCount) < 0 || Number(value.observation.selectedResidueCount) > 512) return false;
    if (typeof value.observation.focusResolved !== "boolean") return false;
    if (![value.observation.modelCount, value.observation.atomCount, value.observation.canvasWidth, value.observation.canvasHeight]
      .every((item) => Number.isSafeInteger(item) && Number(item) >= 1 && Number(item) <= 100_000_000)) return false;
    return [value.observation.chainCount, value.observation.residueCount]
      .every((item) => Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 100_000_000);
  }
  if (value.observation.kind === "chemistry-document") {
    if (!exact(value.observation, ["kind", "engineVersion", "validatorVersion", "editable", "documentSha256", "canonicalSmilesSha256", "atomCount", "bondCount", "canvasWidth", "canvasHeight"])) return false;
    return safeText(value.observation.validatorVersion, 80) && value.observation.editable === true
      && typeof value.observation.documentSha256 === "string" && SHA256_RE.test(value.observation.documentSha256)
      && typeof value.observation.canonicalSmilesSha256 === "string" && SHA256_RE.test(value.observation.canonicalSmilesSha256)
      && [value.observation.atomCount, value.observation.bondCount, value.observation.canvasWidth, value.observation.canvasHeight]
        .every((item) => Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 100_000_000);
  }
  return false;
}
