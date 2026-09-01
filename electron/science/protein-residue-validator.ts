import { createHash } from "node:crypto";
import {
  SCIENCE_RESIDUE_INTERACTION_VALIDATION_SCHEMA,
  compareScienceResidueLocators,
  isScienceResidueInteraction,
  scienceResidueLocatorKey,
  type ScienceResidueInteraction,
  type ScienceResidueInteractionValidation,
  type ScienceResidueLocator,
} from "../../shared/science-renderer-runtime";

const MOLSTAR_VERSION = "5.11.0";
const MAX_STRUCTURE_BYTES = 32 * 1024 * 1024;
const MAX_INDEXED_RESIDUES = 2_000_000;

type MolstarModel = {
  modelNum: number;
  atomicHierarchy: {
    residues: {
      _rowCount: number;
      label_seq_id: { value(index: number): number };
      auth_seq_id: { value(index: number): number };
      pdbx_PDB_ins_code: { value(index: number): string };
    };
    chains: {
      label_asym_id: { value(index: number): string };
      auth_asym_id: { value(index: number): string };
    };
    atoms: {
      label_comp_id: { value(index: number): string };
    };
    residueAtomSegments: { offsets: ArrayLike<number> };
    chainAtomSegments: { index: ArrayLike<number> };
  };
  atomicChainOperatorMappinng?: Map<number, { name?: string }>;
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function interactionDigest(structureContentSha256: string, interaction: ScienceResidueInteraction): string {
  return sha256(JSON.stringify({ structureContentSha256, interaction }));
}

async function parseModels(bytes: Uint8Array, format: "pdb" | "mmcif"): Promise<MolstarModel[]> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_STRUCTURE_BYTES) throw new Error("science-residue-structure-size-invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const { Task } = require("molstar/lib/commonjs/mol-task/index.js") as { Task: { resolveInContext<T>(task: unknown): Promise<T> } };
  let trajectory: { frameCount: number; getFrameAtIndex(index: number): unknown };
  if (format === "pdb") {
    const { parsePDB } = require("molstar/lib/commonjs/mol-io/reader/pdb/parser.js") as { parsePDB(value: string, id: string): { run(): Promise<{ isError: boolean; result: unknown }> } };
    const { trajectoryFromPDB } = require("molstar/lib/commonjs/mol-model-formats/structure/pdb.js") as { trajectoryFromPDB(value: unknown): { run(): Promise<typeof trajectory> } };
    const parsed = await parsePDB(text, "agentlas-science-residue-validation").run();
    if (parsed.isError) throw new Error("science-residue-structure-parse-failed");
    trajectory = await trajectoryFromPDB(parsed.result).run();
  } else {
    const { CIF } = require("molstar/lib/commonjs/mol-io/reader/cif.js") as { CIF: { parse(value: string): { run(): Promise<{ isError: boolean; result: { blocks: unknown[] } }> } } };
    const { trajectoryFromMmCIF } = require("molstar/lib/commonjs/mol-model-formats/structure/mmcif.js") as { trajectoryFromMmCIF(block: unknown, file?: unknown): { run(): Promise<typeof trajectory> } };
    const parsed = await CIF.parse(text).run();
    if (parsed.isError || parsed.result.blocks.length < 1) throw new Error("science-residue-structure-parse-failed");
    trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0], parsed.result).run();
  }
  if (!Number.isSafeInteger(trajectory.frameCount) || trajectory.frameCount < 1 || trajectory.frameCount > 100_000) throw new Error("science-residue-model-count-invalid");
  const models: MolstarModel[] = [];
  for (let index = 0; index < trajectory.frameCount; index += 1) {
    models.push(await Task.resolveInContext<MolstarModel>(trajectory.getFrameAtIndex(index)));
  }
  return models;
}

async function residueIndex(models: MolstarModel[]): Promise<Map<string, ScienceResidueLocator>> {
  const indexed = new Map<string, ScienceResidueLocator>();
  const model = models[0];
  if (!model) throw new Error("science-residue-model-count-invalid");
  const { Structure, StructureElement, StructureProperties, StructureSymmetry, Unit } = require("molstar/lib/commonjs/mol-model/structure.js") as Record<string, any>;
  const { ModelSymmetry } = require("molstar/lib/commonjs/mol-model-formats/structure/property/symmetry.js") as Record<string, any>;
  let structure = Structure.ofModel(model);
  const symmetry = ModelSymmetry.Provider.get(model);
  if (symmetry?.assemblies?.length > 0) structure = await StructureSymmetry.buildAssembly(structure, symmetry.assemblies[0].id).run();
  const location = StructureElement.Location.create(structure);
  for (const unit of structure.units) {
    if (!Unit.isAtomic(unit)) continue;
    location.unit = unit;
    for (const element of unit.elements) {
      location.element = element;
      const rawLabelSeqId = Number(StructureProperties.residue.label_seq_id(location));
      const locator: ScienceResidueLocator = {
        modelNum: Number(StructureProperties.unit.model_num(location)),
        operatorName: String(StructureProperties.unit.operator_name(location) || "1_555"),
        labelAsymId: String(StructureProperties.chain.label_asym_id(location)),
        authAsymId: String(StructureProperties.chain.auth_asym_id(location)),
        labelSeqId: Number.isSafeInteger(rawLabelSeqId) && rawLabelSeqId > 0 ? rawLabelSeqId : null,
        authSeqId: Number(StructureProperties.residue.auth_seq_id(location)),
        insertionCode: String(StructureProperties.residue.pdbx_PDB_ins_code(location) || ""),
        compId: String(StructureProperties.residue.label_comp_id(location)),
      };
      indexed.set(scienceResidueLocatorKey(locator), locator);
      if (indexed.size > MAX_INDEXED_RESIDUES) throw new Error("science-residue-index-limit-exceeded");
    }
  }
  if (indexed.size < 1) throw new Error("science-residue-hierarchy-invalid");
  return indexed;
}

export function canonicalScienceResidueInteraction(value: ScienceResidueInteraction): ScienceResidueInteraction {
  if (!isScienceResidueInteraction(value)) throw new Error("science-residue-interaction-invalid");
  return {
    schema: value.schema,
    granularity: "residue",
    residues: value.residues.map((residue) => ({ ...residue })).sort(compareScienceResidueLocators),
    focus: value.focus ? { ...value.focus } : null,
  };
}

export async function validateScienceResidueInteraction(input: {
  bytes: Uint8Array;
  format: "pdb" | "mmcif";
  structureContentSha256: string;
  interaction: ScienceResidueInteraction;
}): Promise<{ interaction: ScienceResidueInteraction; validation: ScienceResidueInteractionValidation }> {
  if (sha256(input.bytes) !== input.structureContentSha256) throw new Error("science-residue-structure-hash-conflict");
  const interaction = canonicalScienceResidueInteraction(input.interaction);
  const source = await residueIndex(await parseModels(input.bytes, input.format));
  for (const locator of interaction.residues) {
    if (!source.has(scienceResidueLocatorKey(locator))) throw new Error("science-residue-not-found");
  }
  if (interaction.focus && !source.has(scienceResidueLocatorKey(interaction.focus))) throw new Error("science-residue-focus-not-found");
  return {
    interaction,
    validation: {
      schema: SCIENCE_RESIDUE_INTERACTION_VALIDATION_SCHEMA,
      validator: "Mol*",
      validatorVersion: MOLSTAR_VERSION,
      structureContentSha256: input.structureContentSha256,
      interactionSha256: interactionDigest(input.structureContentSha256, interaction),
      resolvedResidueCount: interaction.residues.length,
      focusResolved: interaction.focus !== null,
      code: "residue-interaction-valid",
    },
  };
}
