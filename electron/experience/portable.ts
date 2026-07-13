import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  PortableExperienceBundle,
  PortableExperienceItem,
  PortableExperienceMcpRequirement,
  PortableExperienceVisibility,
  ExperienceMcpRequirement,
} from "../../shared/types";
import { getAgentById } from "../mcp/registry";
import { listInstalledServers } from "../mcp-tools/registry";
import { getDb } from "../store/db";
import { normalizeExperienceMcpRequirements } from "./relation-index";
import { publicExperienceSafetyIssues } from "./store";
import { EXPERIENCE_ENV_PREFIX, isCanonicalTaskId, parseCanonicalEnvironmentProfile } from "./taxonomy";
import { confirmedOperationalPublicProjections } from "./operational-generalization";

export const PORTABLE_EXPERIENCE_MAX_CANONICAL_BYTES = 3 * 1024 * 1024;
const PORTABLE_EXPERIENCE_MAX_ITEMS = 256;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const LOCAL_OR_RAW_KEY_RE = /^(?:projectPath|project_path|sourceMemoryId|source_memory_id|rawEvidence|evidenceRefs|transcript|prompt|command|args|cwd|headers|token|secret|credentialValue)$/i;
const PORTABLE_RAW_STRING_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "absolute-local-path", pattern: /(?:file:\/\/|\/(?:Users|home|private|Volumes|var\/folders)\/)/i },
  { code: "windows-local-path", pattern: /\b[A-Za-z]:\\+(?:Users|Documents|Desktop|Downloads|AppData)\\+/i },
  { code: "raw-role-material", pattern: /(?:^|\n)\s*(?:system|developer|assistant|user|tool)\s*:\s+|["']role["']\s*:\s*["'](?:system|developer|assistant|user|tool)["']/i },
  { code: "prompt-injection", pattern: /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|hidden)\s+(?:instructions?|prompts?|rules?)\b/i },
  { code: "base-package-material", pattern: /\b(?:contentBase64|cloudPackage|basePackageFiles|systemPrompt)\b|\bBEGIN AGENTLAS (?:AGENT|PACKAGE)\b/i },
  { code: "opaque-encoded-blob", pattern: /(?:[A-Fa-f0-9]{128,}|[A-Za-z0-9+/]{124,}={0,2})/ },
];

const portablePublicId = z.string().min(3).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/);
const portablePublicHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const portableIsoDate = z.string().datetime({ offset: true });
const portableSemanticVersion = z.string().max(64).regex(/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/);
const portableBoundedString = (min: number, max: number) => z.string().min(min).max(max);

const PortableMcpRuntimeSchema = z.object({
  schemaVersion: z.literal("agentlas.mcp-requirement.v1"),
  kind: z.literal("agentlas-mcp-requirement"),
  requirementId: portablePublicId,
  catalogId: portablePublicId,
  reason: portableBoundedString(1, 300),
  capabilities: z.array(portablePublicId).min(1).max(32),
  required: z.boolean(),
  requiresKey: z.boolean(),
  priority: z.number().int().min(1).max(1_000),
  permissions: z.array(portablePublicId).max(64),
  alternatives: z.array(portablePublicId).max(32),
  credentialMetadata: z.object({
    provider: portablePublicId,
    env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).max(32),
    allowedHosts: z.array(z.string().min(1).max(255).regex(/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/)).min(1).max(64).optional(),
    scopes: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/)).min(1).max(64).optional(),
    setupUrl: z.string().max(2048).url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash;
    }, "setupUrl must be an HTTPS hostname/path URL without userinfo, port, query, or fragment.").optional(),
    brokerMode: z.enum(["host-bound-broker", "runtime-env-injection", "provider-managed-oauth", "manual-provider-page"]).optional(),
  }).strict().optional(),
  unavailablePolicy: z.object({
    build: z.literal("degrade"),
    rental: z.enum(["exclude-variant", "continue-degraded"]),
    execution: z.enum(["use-alternative", "disable-capability", "continue-degraded"]),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.required && value.unavailablePolicy.rental !== "exclude-variant") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Required MCP absence must exclude only that variant.", path: ["unavailablePolicy", "rental"] });
  }
  if (!value.required && value.unavailablePolicy.rental !== "continue-degraded") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Optional MCP absence must continue degraded.", path: ["unavailablePolicy", "rental"] });
  }
  if (value.requiresKey && !value.credentialMetadata) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "requiresKey needs value-free credentialMetadata.", path: ["credentialMetadata"] });
  }
  if (value.alternatives.includes(value.catalogId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "alternatives cannot repeat catalogId.", path: ["alternatives"] });
  }
});

const PortableItemRuntimeSchema = z.object({
  schemaVersion: z.literal("agentlas.experience-item.v1"),
  kind: z.literal("agentlas-experience-item"),
  experienceItemId: portablePublicId,
  experiencePackId: portablePublicId,
  experiencePackReleaseId: portablePublicId,
  type: z.enum(["procedure", "failure-recovery", "environment-gotcha", "tool-affordance", "warning", "supersedes"]),
  summary: portableBoundedString(1, 320),
  instructions: z.array(portableBoundedString(1, 600)).min(1).max(8),
  taskSignatures: z.array(portablePublicId).min(1).max(32),
  environmentConstraints: z.array(portableBoundedString(1, 240)).max(32),
  evidenceReceiptIds: z.array(portablePublicId).min(1).max(24),
  supersedesItemIds: z.array(portablePublicId).max(256),
  confidence: z.number().min(0).max(1),
  status: z.enum(["candidate", "promoted", "deprecated", "rejected"]),
  privacyScope: z.enum(["private", "public-safe"]),
  createdAt: portableIsoDate.optional(),
}).strict();

const PortablePackRuntimeSchema = z.object({
  schemaVersion: z.literal("agentlas.experience-pack.v1"),
  kind: z.literal("agentlas-experience-pack"),
  experiencePackId: portablePublicId,
  releaseId: portablePublicId,
  ownerRef: portablePublicId,
  version: portableSemanticVersion,
  baseCompatibility: z.object({
    agentDefinitionId: portablePublicId,
    compatibleBaseReleaseIds: z.array(portablePublicId).min(1).max(64),
  }).strict(),
  itemIds: z.array(portablePublicId).max(256),
  evidenceReceiptIds: z.array(portablePublicId).max(256 * 24),
  mcpRequirements: z.array(PortableMcpRuntimeSchema).max(64),
  containsBasePackageMaterial: z.literal(false),
  contentHash: portablePublicHash,
  visibility: z.enum(["private", "unlisted", "public"]),
  status: z.enum(["draft", "active", "suspended", "withdrawn", "deleted"]),
  createdAt: portableIsoDate.optional(),
  releasedAt: portableIsoDate.nullable().optional(),
  withdrawnAt: portableIsoDate.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "active" && value.itemIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An active source pack needs at least one item.", path: ["itemIds"] });
  }
});

const PortableBundleRuntimeSchema = z.object({
  schemaVersion: z.literal("agentlas.experience-bundle.v1"),
  kind: z.literal("agentlas-experience-bundle"),
  bundleId: z.string().regex(/^exb_[0-9a-f]{48}$/),
  bundleHash: portablePublicHash,
  requestedVisibility: z.enum(["private", "unlisted", "public"]),
  pack: PortablePackRuntimeSchema,
  items: z.array(PortableItemRuntimeSchema).min(1).max(256),
  sourceAttestations: z.array(z.object({
    kind: z.literal("user-attested"),
    experienceItemId: portablePublicId,
    evidenceHash: portablePublicHash,
  }).strict()).max(256 * 24),
  privacy: z.object({
    basePackageMaterialIncluded: z.literal(false),
    rawPromptIncluded: z.literal(false),
    rawTranscriptIncluded: z.literal(false),
    rawLocalPathsIncluded: z.literal(false),
    credentialValuesIncluded: z.literal(false),
  }).strict(),
}).strict();

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

type PortablePackRow = {
  id: string;
  agent_id: string;
  environment_key: string;
  environment_profile_json: string | null;
  name: string;
  description: string;
  base_package_hash: string | null;
  base_agent_definition_id: string | null;
  base_agent_release_id: string | null;
  base_package_hash_version: string | null;
  mcp_requirements_json: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
};

type PortableItemRow = {
  id: string;
  summary: string;
  task_terms_json: string;
  confidence: "high" | "medium" | "low";
  public_safe: number;
  created_at: string;
  receipt_id: string;
  evidence_hash: string;
  verification_status: "attested" | "verified";
};

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function normalizeJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Portable Experience canonical JSON forbids non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const normalized = new Map<string, CanonicalJson>();
    for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.normalize("NFC");
      if (normalized.has(key)) throw new Error(`Portable Experience NFC key collision: ${key}`);
      normalized.set(key, normalizeJson(child));
    }
    return Object.fromEntries([...normalized.entries()].sort(([left], [right]) => compareCodePoints(left, right)));
  }
  throw new Error(`Portable Experience canonical JSON forbids ${typeof value}.`);
}

export function portableExperienceCanonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function sortedUnique<T>(values: readonly T[]): T[] {
  const entries = new Map(values.map((value) => [portableExperienceCanonicalJson(value), value] as const));
  return [...entries.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([, value]) => value);
}

function normalizeMcp(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeJson(value) as Record<string, unknown>;
  for (const key of ["capabilities", "permissions", "alternatives"] as const) {
    if (Array.isArray(normalized[key])) normalized[key] = sortedUnique(normalized[key] as unknown[]);
  }
  if (normalized.credentialMetadata && typeof normalized.credentialMetadata === "object") {
    const metadata = { ...(normalized.credentialMetadata as Record<string, unknown>) };
    for (const key of ["env", "allowedHosts", "scopes"] as const) {
      if (Array.isArray(metadata[key])) metadata[key] = sortedUnique(metadata[key] as unknown[]);
    }
    normalized.credentialMetadata = metadata;
  }
  return normalized;
}

function normalizeItem(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeJson(value) as Record<string, unknown>;
  for (const key of ["taskSignatures", "environmentConstraints", "evidenceReceiptIds", "supersedesItemIds"] as const) {
    if (Array.isArray(normalized[key])) normalized[key] = sortedUnique(normalized[key] as unknown[]);
  }
  return normalized;
}

export function normalizePortableExperienceBundle(value: unknown): unknown {
  const normalized = normalizeJson(value) as Record<string, unknown>;
  if (normalized.pack && typeof normalized.pack === "object") {
    const pack = { ...(normalized.pack as Record<string, unknown>) };
    if (pack.baseCompatibility && typeof pack.baseCompatibility === "object") {
      const compatibility = { ...(pack.baseCompatibility as Record<string, unknown>) };
      if (Array.isArray(compatibility.compatibleBaseReleaseIds)) {
        compatibility.compatibleBaseReleaseIds = sortedUnique(compatibility.compatibleBaseReleaseIds);
      }
      pack.baseCompatibility = compatibility;
    }
    for (const key of ["itemIds", "evidenceReceiptIds"] as const) {
      if (Array.isArray(pack[key])) pack[key] = sortedUnique(pack[key] as unknown[]);
    }
    if (Array.isArray(pack.mcpRequirements)) {
      pack.mcpRequirements = sortedUnique(pack.mcpRequirements.map((entry) =>
        entry && typeof entry === "object" ? normalizeMcp(entry as Record<string, unknown>) : entry));
    }
    normalized.pack = pack;
  }
  if (Array.isArray(normalized.items)) {
    normalized.items = sortedUnique(normalized.items.map((entry) =>
      entry && typeof entry === "object" ? normalizeItem(entry as Record<string, unknown>) : entry));
  }
  if (Array.isArray(normalized.sourceAttestations)) {
    normalized.sourceAttestations = sortedUnique(normalized.sourceAttestations);
  }
  return normalized;
}

export function portableExperiencePackContentPayload(bundle: PortableExperienceBundle | unknown): Record<string, unknown> {
  const normalized = normalizePortableExperienceBundle(bundle) as Record<string, unknown>;
  const pack = normalized.pack as Record<string, unknown> | undefined;
  if (!pack || !Array.isArray(normalized.items)) throw new Error("Portable Experience Bundle needs a Pack and items.");
  return {
    schemaVersion: pack.schemaVersion,
    kind: pack.kind,
    experiencePackId: pack.experiencePackId,
    releaseId: pack.releaseId,
    version: pack.version,
    baseCompatibility: pack.baseCompatibility,
    itemIds: pack.itemIds,
    items: normalized.items,
    evidenceReceiptIds: pack.evidenceReceiptIds,
    mcpRequirements: pack.mcpRequirements,
    containsBasePackageMaterial: pack.containsBasePackageMaterial,
  };
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(portableExperienceCanonicalJson(value), "utf8").digest("hex")}`;
}

export function portableExperiencePackContentHash(bundle: PortableExperienceBundle | unknown): string {
  return canonicalHash(portableExperiencePackContentPayload(bundle));
}

export function portableExperienceBundleHashPayload(bundle: PortableExperienceBundle | unknown): Record<string, unknown> {
  const normalized = normalizePortableExperienceBundle(bundle) as Record<string, unknown>;
  return {
    content: portableExperiencePackContentPayload(normalized),
    sourceAttestations: normalized.sourceAttestations,
    privacy: normalized.privacy,
  };
}

export function portableExperienceBundleHash(bundle: PortableExperienceBundle | unknown): string {
  return canonicalHash(portableExperienceBundleHashPayload(bundle));
}

export function portableExperienceBundleId(bundle: PortableExperienceBundle | unknown): string {
  return `exb_${portableExperienceBundleHash(bundle).slice("sha256:".length, "sha256:".length + 48)}`;
}

function digest(...parts: string[]): string {
  const value = createHash("sha256");
  for (const part of parts) value.update(part.normalize("NFC")).update("\0");
  return value.digest("hex");
}

function opaqueId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${digest(...parts)}`;
}

function codePointSlice(value: string, max: number): string {
  return Array.from(value.normalize("NFC")).slice(0, max).join("");
}

function instructionChunks(value: string): string[] {
  const points = Array.from(value.trim().normalize("NFC"));
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += 600) chunks.push(points.slice(index, index + 600).join(""));
  return chunks.slice(0, 8);
}

function parsedStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function confidenceNumber(value: PortableItemRow["confidence"]): number {
  if (value === "high") return 1;
  if (value === "low") return 0.25;
  return 0.5;
}

function portableMcpRequirements(pack: PortablePackRow): PortableExperienceMcpRequirement[] {
  let localRequirements: ExperienceMcpRequirement[];
  try {
    localRequirements = normalizeExperienceMcpRequirements(JSON.parse(pack.mcp_requirements_json));
  } catch {
    localRequirements = [];
  }
  const keyMetadata = new Map<string, string[]>();
  for (const server of listInstalledServers()) {
    if (!server.catalogId) continue;
    const env = sortedUnique(server.envKeys.filter((key) => /^[A-Z][A-Z0-9_]{0,79}$/.test(key))).slice(0, 32);
    if (env.length > 0 && !keyMetadata.has(server.catalogId)) keyMetadata.set(server.catalogId, env);
  }
  return localRequirements.map((requirement, index) => {
    const env = keyMetadata.get(requirement.catalogId) ?? [];
    return {
      schemaVersion: "agentlas.mcp-requirement.v1",
      kind: "agentlas-mcp-requirement",
      requirementId: opaqueId("mcr", pack.id, requirement.catalogId),
      catalogId: requirement.catalogId,
      reason: "Referenced by this Experience Pack; executable configuration remains host-local.",
      capabilities: [opaqueId("cap", requirement.catalogId)],
      required: requirement.required,
      requiresKey: env.length > 0,
      priority: index + 1,
      permissions: [],
      alternatives: requirement.alternatives,
      ...(env.length > 0
        ? {
            credentialMetadata: {
              provider: requirement.catalogId,
              env,
              brokerMode: "runtime-env-injection" as const,
            },
          }
        : {}),
      unavailablePolicy: {
        build: "degrade",
        rental: requirement.required ? "exclude-variant" : "continue-degraded",
        execution: requirement.alternatives.length > 0
          ? "use-alternative"
          : requirement.required
            ? "disable-capability"
            : "continue-degraded",
      },
    };
  });
}

function assertNoRawPortableMaterial(value: unknown): void {
  const issues: string[] = [];
  const strings: Array<{ text: string; path: string }> = [];
  const walk = (node: unknown, path = "bundle"): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (LOCAL_OR_RAW_KEY_RE.test(key)) issues.push(`forbidden field ${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof node === "string") strings.push({ text: node, path });
  };
  walk(value);
  const protocolMetadata = (text: string): boolean =>
    HASH_RE.test(text)
    || /^exb_[0-9a-f]{48}$/.test(text)
    || /^[a-z]{3}[_:][0-9a-f]{32,64}$/.test(text)
    || /^environment:[0-9a-f]{64}$/.test(text)
    || /^(?:user|workspace|owner):[A-Za-z0-9._@-]{2,240}$/.test(text)
    || /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(text)
    || /^\d{4}-\d{2}-\d{2}T\S+$/.test(text);
  for (const { text, path } of strings) {
    const safetyIssues = publicExperienceSafetyIssues(text);
    const isSetupUrl = path.endsWith(".credentialMetadata.setupUrl");
    if (protocolMetadata(text)) {
      // Typed hashes/ids may look opaque, but secrets and personal identifiers
      // never become safe merely because they use an owner:/user: prefix.
      const metadataDenied = new Set(["secret-value", "email", "local-path-or-url"]);
      if (path.endsWith(".ownerRef")) metadataDenied.add("phone-or-long-number");
      issues.push(...safetyIssues.filter((code) => metadataDenied.has(code)));
    } else if (isSetupUrl) {
      // setupUrl is a schema-validated, value-free HTTPS provider page. Keep all
      // privacy checks except the generic URL category itself.
      issues.push(...safetyIssues.filter((code) => code !== "local-path-or-url"));
    } else {
      issues.push(...safetyIssues);
    }
    for (const { code, pattern } of PORTABLE_RAW_STRING_PATTERNS) {
      if (pattern.test(text)) issues.push(code);
    }
  }
  if (issues.length > 0) {
    throw new Error(`Portable Experience Bundle contains non-portable raw material (${[...new Set(issues)].join(", ")}).`);
  }
}

function assertPortableShape(bundle: PortableExperienceBundle): void {
  if (bundle.schemaVersion !== "agentlas.experience-bundle.v1" || bundle.kind !== "agentlas-experience-bundle") {
    throw new Error("Portable Experience Bundle has an unsupported schema.");
  }
  if (!/^exb_[0-9a-f]{48}$/.test(bundle.bundleId) || !HASH_RE.test(bundle.bundleHash)) {
    throw new Error("Portable Experience Bundle identity is invalid.");
  }
  if (!ID_RE.test(bundle.pack.experiencePackId) || !ID_RE.test(bundle.pack.releaseId)) {
    throw new Error("Portable Experience Pack identity is invalid.");
  }
  if (!ID_RE.test(bundle.pack.ownerRef)) throw new Error("Portable Experience Pack owner reference is invalid.");
  if (bundle.items.length < 1 || bundle.items.length > PORTABLE_EXPERIENCE_MAX_ITEMS) {
    throw new Error("Portable Experience Bundle requires 1-256 items.");
  }
  if (bundle.pack.itemIds.length !== bundle.items.length || new Set(bundle.pack.itemIds).size !== bundle.items.length) {
    throw new Error("Portable Experience Pack item references are inconsistent.");
  }
  if (bundle.pack.contentHash !== portableExperiencePackContentHash(bundle)) {
    throw new Error("Portable Experience Pack content hash mismatch.");
  }
  if (bundle.bundleHash !== portableExperienceBundleHash(bundle) || bundle.bundleId !== portableExperienceBundleId(bundle)) {
    throw new Error("Portable Experience Bundle hash mismatch.");
  }
  if (Buffer.byteLength(portableExperienceCanonicalJson(bundle), "utf8") > PORTABLE_EXPERIENCE_MAX_CANONICAL_BYTES) {
    throw new Error("Portable Experience Bundle exceeds the 3 MiB canonical limit.");
  }
  assertNoRawPortableMaterial(bundle);
}

export function validatePortableExperienceBundle(value: unknown): PortableExperienceBundle {
  const normalized = normalizePortableExperienceBundle(value);
  const bundle = PortableBundleRuntimeSchema.parse(normalized) as PortableExperienceBundle;
  const itemIds = bundle.items.map((item) => item.experienceItemId);
  if (new Set(itemIds).size !== itemIds.length) throw new Error("Portable Experience items contain duplicate ids.");
  if (portableExperienceCanonicalJson(bundle.pack.itemIds) !== portableExperienceCanonicalJson(sortedUnique(itemIds))) {
    throw new Error("Portable Experience Pack item references are inconsistent.");
  }
  const evidenceIds = sortedUnique(bundle.items.flatMap((item) => item.evidenceReceiptIds));
  if (portableExperienceCanonicalJson(bundle.pack.evidenceReceiptIds) !== portableExperienceCanonicalJson(evidenceIds)) {
    throw new Error("Portable Experience Pack evidence references are inconsistent.");
  }
  for (const item of bundle.items) {
    if (item.experiencePackId !== bundle.pack.experiencePackId || item.experiencePackReleaseId !== bundle.pack.releaseId) {
      throw new Error("Portable Experience item references the wrong Pack or release.");
    }
    if (item.taskSignatures.some((task) => !isCanonicalTaskId(task))) {
      throw new Error("Portable Experience item uses a non-canonical task signature.");
    }
    const environment = {
      schema: "agentlas.experience-environment-profile.v1",
      os: item.environmentConstraints.find((value) => value.startsWith(`${EXPERIENCE_ENV_PREFIX}os/`)),
      arch: item.environmentConstraints.find((value) => value.startsWith(`${EXPERIENCE_ENV_PREFIX}arch/`)),
      runtime: item.environmentConstraints.find((value) => value.startsWith(`${EXPERIENCE_ENV_PREFIX}runtime/`)),
      constraints: item.environmentConstraints,
    };
    if (item.environmentConstraints.length !== 3 || !parseCanonicalEnvironmentProfile(environment)) {
      throw new Error("Portable Experience item uses a non-canonical environment profile.");
    }
  }
  const knownItems = new Set(itemIds);
  if (bundle.sourceAttestations.some((attestation) => !knownItems.has(attestation.experienceItemId))) {
    throw new Error("Portable Experience attestation references a missing item.");
  }
  assertPortableShape(bundle);
  return bundle;
}

function getPortablePack(packId: string): PortablePackRow {
  const row = getDb().prepare("SELECT * FROM experience_packs WHERE id = ?").get(packId) as PortablePackRow | undefined;
  if (!row) throw new Error("Experience Pack not found.");
  if (row.status !== "active") throw new Error("Archived Experience Packs cannot be uploaded.");
  const agent = getAgentById(row.agent_id);
  if (!agent || !row.base_package_hash || agent.packageHash !== row.base_package_hash) {
    throw new Error("Experience Pack base package is missing or stale.");
  }
  if (!row.base_agent_definition_id || !row.base_agent_release_id || !row.base_package_hash_version) {
    throw new Error("Experience Pack exact base release has not been resolved by Agent Cloud.");
  }
  return row;
}

function getPortableItems(packId: string): PortableItemRow[] {
  return getDb().prepare(
    `SELECT c.id, c.summary, c.task_terms_json, c.confidence, c.public_safe,
            c.created_at, r.id AS receipt_id, r.evidence_hash,
            r.verification_status
       FROM experience_candidates c
       JOIN experience_promotion_receipts r
         ON r.candidate_id = c.id AND r.action = 'promote'
      WHERE c.pack_id = ? AND c.status = 'promoted'
        AND c.outcome_status IN ('attested','verified')
      ORDER BY c.id ASC
      LIMIT 257`,
  ).all(packId) as PortableItemRow[];
}

/**
 * Materialize the full portable item bodies from curated local Experience.
 * Local project paths, Memory ids and raw evidence refs are intentionally not
 * selected from SQLite, so they cannot accidentally enter the canonical JSON.
 */
export function materializePortableExperienceBundle(
  packId: string,
  requestedVisibility: PortableExperienceVisibility,
): PortableExperienceBundle {
  if (!new Set<PortableExperienceVisibility>(["private", "unlisted", "public"]).has(requestedVisibility)) {
    throw new Error("Experience visibility is invalid.");
  }
  const pack = getPortablePack(packId);
  let environmentProfile: ReturnType<typeof parseCanonicalEnvironmentProfile> = null;
  try {
    environmentProfile = parseCanonicalEnvironmentProfile(JSON.parse(pack.environment_profile_json || "null"));
  } catch {
    environmentProfile = null;
  }
  if (!environmentProfile) {
    throw new Error("Legacy opaque Experience environments cannot auto-activate or export as canonical portable Experience.");
  }
  const rows = requestedVisibility === "private" ? getPortableItems(pack.id) : [];
  const publicProjections = requestedVisibility === "private"
    ? []
    : confirmedOperationalPublicProjections(pack.id);
  if (requestedVisibility === "private" && (rows.length < 1 || rows.length > PORTABLE_EXPERIENCE_MAX_ITEMS)) {
    throw new Error("Portable Experience upload requires 1-256 promoted items.");
  }
  if (requestedVisibility !== "private" && (publicProjections.length < 1 || publicProjections.length > PORTABLE_EXPERIENCE_MAX_ITEMS)) {
    throw new Error("Public or unlisted verification requires an owner-confirmed generalized public projection.");
  }
  const experiencePackId = opaqueId("exp", pack.id);
  const itemSeeds = requestedVisibility === "private"
    ? rows.map((row) => {
        const tasks = parsedStringArray(row.task_terms_json).filter(isCanonicalTaskId);
        if (tasks.length === 0) {
          throw new Error("Legacy or unclassified Experience task terms cannot export as canonical task taxonomy.");
        }
        return {
          id: row.id,
          summary: row.summary.normalize("NFC"),
          instructions: instructionChunks(row.summary),
          tasks,
          confidence: confidenceNumber(row.confidence),
          publicSafe: false,
          evidenceHash: row.evidence_hash,
          evidenceSeed: `${row.receipt_id}:${row.evidence_hash}`,
          createdAt: row.created_at,
        };
      })
    : publicProjections.map((projection) => ({
        id: projection.projectionId,
        summary: projection.title.normalize("NFC"),
        instructions: projection.instructions,
        tasks: projection.taskSignatures,
        confidence: 0.5,
        publicSafe: true,
        evidenceHash: projection.confirmationHash!,
        evidenceSeed: `${projection.projectionId}:${projection.confirmationHash}`,
        createdAt: projection.confirmedAt!,
      }));
  // Preserve the established private release-id derivation exactly. Public
  // projections use their own generalized fields and confirmation hash, so a
  // private draft and its public verification request cannot alias.
  const releaseItemSeeds = requestedVisibility === "private"
    ? rows.map((row) => ({
        id: row.id,
        summary: row.summary.normalize("NFC"),
        tasks: parsedStringArray(row.task_terms_json).filter(isCanonicalTaskId),
        confidence: row.confidence,
        publicSafe: row.public_safe === 1,
        evidenceHash: row.evidence_hash,
      }))
    : publicProjections.map((projection) => ({
        id: projection.projectionId,
        title: projection.title,
        instructions: projection.instructions,
        taskSignatures: projection.taskSignatures,
        environmentConstraints: projection.environmentConstraints,
        sourceSnapshotHash: projection.sourceSnapshotHash,
        proposalHash: projection.proposalHash,
        confirmationHash: projection.confirmationHash,
      }));
  const sourceDigest = createHash("sha256")
    .update(portableExperienceCanonicalJson({
      experiencePackId,
      baseDefinitionId: pack.base_agent_definition_id,
      baseReleaseId: pack.base_agent_release_id,
      environmentProfile,
      items: releaseItemSeeds,
      mcpRequirements: portableMcpRequirements(pack),
    }), "utf8")
    .digest("hex");
  const experienceReleaseId = opaqueId("exr", experiencePackId, sourceDigest);
  const semanticPatch = Number.parseInt(sourceDigest.slice(0, 8), 16);
  const items: PortableExperienceItem[] = itemSeeds.map((seed) => {
    if ([seed.summary, ...seed.instructions].some((text) => publicExperienceSafetyIssues(text).length > 0)) {
      throw new Error("A portable Experience item contains local, personal, secret, prompt, transcript, or opaque raw material.");
    }
    const itemId = opaqueId("exi", pack.id, seed.id);
    const evidenceId = opaqueId("evr", seed.evidenceSeed);
    return {
      schemaVersion: "agentlas.experience-item.v1",
      kind: "agentlas-experience-item",
      experienceItemId: itemId,
      experiencePackId,
      experiencePackReleaseId: experienceReleaseId,
      type: "procedure",
      summary: codePointSlice(seed.summary.trim(), 320),
      instructions: seed.instructions,
      taskSignatures: sortedUnique(seed.tasks),
      environmentConstraints: environmentProfile.constraints,
      evidenceReceiptIds: [evidenceId],
      supersedesItemIds: [],
      confidence: seed.confidence,
      status: "promoted",
      privacyScope: seed.publicSafe ? "public-safe" : "private",
      createdAt: seed.createdAt,
    };
  });
  const evidenceReceiptIds = sortedUnique(items.flatMap((item) => item.evidenceReceiptIds));
  const sourceAttestations = sortedUnique(itemSeeds.map((seed, index) => ({
    kind: "user-attested" as const,
    experienceItemId: items[index].experienceItemId,
    evidenceHash: `sha256:${seed.evidenceHash}`,
  })));
  const draft = {
    schemaVersion: "agentlas.experience-bundle.v1" as const,
    kind: "agentlas-experience-bundle" as const,
    bundleId: "exb_" + "0".repeat(48),
    bundleHash: `sha256:${"0".repeat(64)}`,
    requestedVisibility,
    pack: {
      schemaVersion: "agentlas.experience-pack.v1" as const,
      kind: "agentlas-experience-pack" as const,
      experiencePackId,
      releaseId: experienceReleaseId,
      ownerRef: "owner:authenticated",
      version: `1.0.${semanticPatch}`,
      baseCompatibility: {
        agentDefinitionId: pack.base_agent_definition_id!,
        compatibleBaseReleaseIds: [pack.base_agent_release_id!],
      },
      itemIds: sortedUnique(items.map((item) => item.experienceItemId)),
      evidenceReceiptIds,
      mcpRequirements: portableMcpRequirements(pack),
      containsBasePackageMaterial: false as const,
      contentHash: `sha256:${"0".repeat(64)}`,
      // Every first commit is an owner-private draft. requestedVisibility is a
      // separate verification request and cannot activate public rental.
      visibility: "private" as const,
      status: "draft" as const,
      createdAt: pack.created_at,
    },
    items,
    sourceAttestations,
    privacy: {
      basePackageMaterialIncluded: false as const,
      rawPromptIncluded: false as const,
      rawTranscriptIncluded: false as const,
      rawLocalPathsIncluded: false as const,
      credentialValuesIncluded: false as const,
    },
  } satisfies PortableExperienceBundle;
  draft.pack.contentHash = portableExperiencePackContentHash(draft);
  draft.bundleHash = portableExperienceBundleHash(draft);
  draft.bundleId = portableExperienceBundleId(draft);
  return validatePortableExperienceBundle(draft);
}
