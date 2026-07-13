import { createHash } from "node:crypto";
import type {
  OperationalPublicProjectionConfirmInput,
  OperationalPublicProjectionRecord,
  OperationalPublicProjectionSaveInput,
  OperationalPublicProjectionSourceBinding,
} from "../../shared/types";
import { getAgentById } from "../mcp/registry";
import { getDb } from "../store/db";
import { publicExperienceSafetyIssues } from "./store";
import { copiesPrivateSource } from "./source-copy-guard";
import { isCanonicalTaskId, parseCanonicalEnvironmentProfile } from "./taxonomy";

const LOCAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PORTABLE_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const PRIVATE_CONTEXT_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  {
    code: "non-generalized-private-context",
    pattern: /\b(?:our|my|this)\s+(?:company|team|client|customer|workspace|project)\b|\b(?:internal|company|client)[ -]only\b|우리\s*(?:회사|팀|고객사|프로젝트)|사내(?:용)?|내부용|고객사\s*(?:전용|용)/i,
  },
  {
    code: "literal-local-filename",
    pattern: /(?:^|[\s`"'(])(?:[A-Za-z0-9가-힣][A-Za-z0-9가-힣._-]{1,80})\.(?:csv|xlsx?|docx?|pdf|json|ya?ml|env|pem|key|sqlite|db)(?=$|[\s`"'),.;])/i,
  },
];

type PackRow = {
  id: string;
  agent_id: string;
  environment_key: string;
  environment_profile_json: string | null;
  base_package_hash: string | null;
  base_agent_definition_id: string | null;
  base_agent_release_id: string | null;
  base_package_hash_version: string | null;
  status: "active" | "archived";
};

type SourceRow = {
  id: string;
  pack_id: string;
  agent_id: string;
  environment_key: string;
  summary: string;
  task_terms_json: string;
  confidence: "high" | "medium" | "low";
  status: "promoted";
  outcome_status: "attested" | "verified";
  public_safe: number;
  created_at: string;
  updated_at: string;
  receipt_id: string;
  evidence_hash: string;
  verification_status: "attested" | "verified";
  verification_method: string;
};

type ProjectionRow = {
  projection_id: string;
  pack_id: string;
  agent_id: string;
  base_package_hash: string;
  base_agent_definition_id: string;
  base_agent_release_id: string;
  environment_key: string;
  source_bindings_json: string;
  source_snapshot_hash: string;
  title: string;
  instructions_json: string;
  task_signatures_json: string;
  environment_constraints_json: string;
  proposal_hash: string;
  privacy_issue_codes_json: string;
  status: "proposal" | "confirmed";
  confirmation_hash: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

function digest(...parts: string[]): string {
  const value = createHash("sha256");
  for (const part of parts) value.update(part.normalize("NFC")).update("\0");
  return value.digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key.normalize("NFC"))}:${canonical(child)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  return JSON.stringify(value);
}

function exactKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (Object.keys(value as Record<string, unknown>).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function cleanId(value: unknown, label: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!LOCAL_ID_RE.test(clean)) throw new Error(`${label} is invalid.`);
  return clean;
}

function cleanText(value: unknown, label: string, max: number): string {
  const clean = typeof value === "string" ? value.trim().normalize("NFC") : "";
  if (!clean || Array.from(clean).length > max) throw new Error(`${label} is required and must be at most ${max} characters.`);
  return clean;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function getPack(packId: string): PackRow {
  const row = getDb().prepare("SELECT * FROM experience_packs WHERE id = ?").get(packId) as PackRow | undefined;
  if (!row) throw new Error("Experience Pack not found.");
  if (row.status !== "active") throw new Error("Archived Experience Packs cannot create a public projection.");
  const currentPackageHash = getAgentById(row.agent_id)?.packageHash ?? null;
  if (!row.base_package_hash || !HASH_RE.test(row.base_package_hash) || currentPackageHash !== row.base_package_hash) {
    throw new Error("Experience Pack base package is missing or stale.");
  }
  if (!row.base_agent_definition_id || !row.base_agent_release_id || !row.base_package_hash_version) {
    throw new Error("Save the Experience privately first so Agent Cloud can resolve the exact base release.");
  }
  return row;
}

function environmentConstraints(pack: PackRow): string[] {
  let profile: ReturnType<typeof parseCanonicalEnvironmentProfile> = null;
  try {
    profile = parseCanonicalEnvironmentProfile(JSON.parse(pack.environment_profile_json || "null"));
  } catch {
    profile = null;
  }
  if (!profile) throw new Error("A canonical exact environment is required for public projection.");
  return profile.constraints;
}

function sourceRows(pack: PackRow, candidateIds: readonly string[]): SourceRow[] {
  const ids = uniqueSorted(candidateIds.map((value) => cleanId(value, "sourceCandidateId")));
  if (ids.length < 1 || ids.length > 32) throw new Error("Select 1-32 private promoted Operational items.");
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT c.id, c.pack_id, c.agent_id, c.environment_key, c.summary,
            c.task_terms_json, c.confidence, c.status, c.outcome_status,
            c.public_safe, c.created_at, c.updated_at,
            r.id AS receipt_id, r.evidence_hash, r.verification_status,
            r.verification_method
       FROM experience_candidates c
       JOIN experience_promotion_receipts r
         ON r.candidate_id = c.id AND r.action = 'promote'
      WHERE c.id IN (${placeholders})
      ORDER BY c.id ASC`,
  ).all(...ids) as SourceRow[];
  if (rows.length !== ids.length || rows.some((row) =>
    row.pack_id !== pack.id || row.agent_id !== pack.agent_id || row.environment_key !== pack.environment_key ||
    row.status !== "promoted" || !["attested", "verified"].includes(row.outcome_status) || row.public_safe !== 0)) {
    throw new Error("Public projection sources must be private promoted items from this exact Pack and environment.");
  }
  return rows;
}

function sourceBinding(row: SourceRow): OperationalPublicProjectionSourceBinding {
  const sourceItemHash = digest("operational-private-source-v1", canonical({
    candidateId: row.id,
    packId: row.pack_id,
    agentId: row.agent_id,
    environmentKey: row.environment_key,
    summaryHash: digest("private-summary-v1", row.summary),
    taskSignatures: uniqueSorted(parseStringArray(row.task_terms_json).filter(isCanonicalTaskId)),
    confidence: row.confidence,
    status: row.status,
    outcomeStatus: row.outcome_status,
    publicSafe: false,
    receiptId: row.receipt_id,
    evidenceHash: row.evidence_hash,
    verificationStatus: row.verification_status,
    verificationMethod: row.verification_method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return { candidateId: row.id, sourceItemHash: `sha256:${sourceItemHash}` };
}

function sourceSnapshotHash(pack: PackRow, bindings: readonly OperationalPublicProjectionSourceBinding[]): string {
  return digest("operational-public-source-snapshot-v1", canonical({
    packId: pack.id,
    agentId: pack.agent_id,
    basePackageHash: pack.base_package_hash,
    baseAgentDefinitionId: pack.base_agent_definition_id,
    baseAgentReleaseId: pack.base_agent_release_id,
    environmentKey: pack.environment_key,
    bindings,
  }));
}

function proposalHash(input: {
  pack: PackRow;
  sourceSnapshotHash: string;
  title: string;
  instructions: string[];
  taskSignatures: string[];
  environmentConstraints: string[];
}): string {
  return digest("operational-public-projection-v1", canonical({
    packId: input.pack.id,
    agentId: input.pack.agent_id,
    basePackageHash: input.pack.base_package_hash,
    baseAgentDefinitionId: input.pack.base_agent_definition_id,
    baseAgentReleaseId: input.pack.base_agent_release_id,
    environmentKey: input.pack.environment_key,
    sourceSnapshotHash: input.sourceSnapshotHash,
    title: input.title,
    instructions: input.instructions,
    taskSignatures: input.taskSignatures,
    environmentConstraints: input.environmentConstraints,
  }));
}

function privacyIssues(title: string, instructions: readonly string[], sources: readonly SourceRow[]): string[] {
  const texts = [title, ...instructions];
  const issues = texts.flatMap(publicExperienceSafetyIssues);
  for (const text of texts) {
    for (const rule of PRIVATE_CONTEXT_PATTERNS) if (rule.pattern.test(text)) issues.push(rule.code);
  }
  const combined = texts.join("\n");
  if (sources.some((source) => copiesPrivateSource(combined, source.summary))) issues.push("source-copy-overlap");
  return uniqueSorted(issues);
}

function rowRecord(row: ProjectionRow): OperationalPublicProjectionRecord {
  const sourceBindings = (() => {
    try {
      const parsed = JSON.parse(row.source_bindings_json) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is OperationalPublicProjectionSourceBinding =>
        Boolean(item) && typeof item === "object" &&
        LOCAL_ID_RE.test(String((item as Record<string, unknown>).candidateId ?? "")) &&
        PORTABLE_HASH_RE.test(String((item as Record<string, unknown>).sourceItemHash ?? "")));
    } catch {
      return [];
    }
  })();
  return {
    projectionId: row.projection_id,
    packId: row.pack_id,
    agentId: row.agent_id,
    basePackageHash: row.base_package_hash,
    baseAgentDefinitionId: row.base_agent_definition_id,
    baseAgentReleaseId: row.base_agent_release_id,
    environmentKey: row.environment_key,
    sourceBindings,
    title: row.title,
    instructions: parseStringArray(row.instructions_json),
    taskSignatures: parseStringArray(row.task_signatures_json).filter(isCanonicalTaskId),
    environmentConstraints: parseStringArray(row.environment_constraints_json),
    sourceSnapshotHash: row.source_snapshot_hash,
    proposalHash: row.proposal_hash,
    privacyIssueCodes: parseStringArray(row.privacy_issue_codes_json),
    status: row.status,
    confirmationHash: row.confirmation_hash,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function invalidateChangedSource(row: ProjectionRow): ProjectionRow {
  if (row.status !== "confirmed") return row;
  try {
    const pack = getPack(row.pack_id);
    const bindings = rowRecord(row).sourceBindings;
    const sources = sourceRows(pack, bindings.map((binding) => binding.candidateId));
    const liveBindings = sources.map(sourceBinding);
    const liveSnapshot = sourceSnapshotHash(pack, liveBindings);
    const exact = row.agent_id === pack.agent_id && row.base_package_hash === pack.base_package_hash &&
      row.base_agent_definition_id === pack.base_agent_definition_id &&
      row.base_agent_release_id === pack.base_agent_release_id && row.environment_key === pack.environment_key;
    if (exact && canonical(bindings) === canonical(liveBindings) && liveSnapshot === row.source_snapshot_hash) return row;
  } catch {
    // Any missing/rejected/rebound source invalidates confirmation fail-closed.
  }
  const issues = uniqueSorted([...parseStringArray(row.privacy_issue_codes_json), "source-material-changed"]);
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE experience_public_projections
        SET status = 'proposal', confirmation_hash = NULL, confirmed_at = NULL,
            privacy_issue_codes_json = ?, updated_at = ?
      WHERE projection_id = ? AND status = 'confirmed'`,
  ).run(JSON.stringify(issues), now, row.projection_id);
  return getDb().prepare("SELECT * FROM experience_public_projections WHERE projection_id = ?")
    .get(row.projection_id) as ProjectionRow;
}

export function listOperationalPublicProjections(packIdValue: string): OperationalPublicProjectionRecord[] {
  const packId = cleanId(packIdValue, "packId");
  const rows = getDb().prepare(
    "SELECT * FROM experience_public_projections WHERE pack_id = ? ORDER BY updated_at DESC",
  ).all(packId) as ProjectionRow[];
  return rows.map(invalidateChangedSource).map(rowRecord);
}

export function saveOperationalPublicProjection(
  input: OperationalPublicProjectionSaveInput,
): OperationalPublicProjectionRecord {
  exactKeys(input, ["packId", "sourceCandidateIds", "title", "instructions", "taskSignatures", "environmentConstraints"], "Operational public projection");
  const pack = getPack(cleanId(input.packId, "packId"));
  if (!Array.isArray(input.sourceCandidateIds)) throw new Error("sourceCandidateIds must be a list.");
  const sources = sourceRows(pack, input.sourceCandidateIds);
  const bindings = sources.map(sourceBinding);
  const liveSourceHash = sourceSnapshotHash(pack, bindings);
  const title = cleanText(input.title, "Portable title", 320);
  if (!Array.isArray(input.instructions) || input.instructions.length < 1 || input.instructions.length > 8) {
    throw new Error("Portable instructions require 1-8 steps.");
  }
  const instructions = input.instructions.map((value, index) => cleanText(value, `Instruction ${index + 1}`, 600));
  if (!Array.isArray(input.taskSignatures)) throw new Error("taskSignatures must be a list.");
  const tasks = uniqueSorted(input.taskSignatures.map((value) => cleanText(value, "taskSignature", 120)));
  if (tasks.length < 1 || tasks.length > 32 || tasks.some((value) => !isCanonicalTaskId(value))) {
    throw new Error("Public projection requires 1-32 canonical task signatures.");
  }
  const sourceTasks = new Set(sources.flatMap((source) => parseStringArray(source.task_terms_json).filter(isCanonicalTaskId)));
  if (tasks.some((task) => !sourceTasks.has(task))) {
    throw new Error("Public projection task signatures must be evidenced by the selected private items.");
  }
  if (!Array.isArray(input.environmentConstraints)) throw new Error("environmentConstraints must be a list.");
  const constraints = input.environmentConstraints.map((value) => cleanText(value, "environmentConstraint", 240));
  const exactConstraints = environmentConstraints(pack);
  if (canonical(constraints) !== canonical(exactConstraints)) {
    throw new Error("Public projection environment must match the Pack's exact canonical environment.");
  }
  const issues = privacyIssues(title, instructions, sources);
  const nextProposalHash = proposalHash({
    pack,
    sourceSnapshotHash: liveSourceHash,
    title,
    instructions,
    taskSignatures: tasks,
    environmentConstraints: constraints,
  });
  const existing = getDb().prepare("SELECT * FROM experience_public_projections WHERE pack_id = ?")
    .get(pack.id) as ProjectionRow | undefined;
  if (
    existing && existing.source_snapshot_hash === liveSourceHash && existing.proposal_hash === nextProposalHash &&
    canonical(parseStringArray(existing.privacy_issue_codes_json)) === canonical(issues)
  ) return rowRecord(existing);

  const now = new Date().toISOString();
  const projectionId = existing?.projection_id ?? `opx_${digest("operational-public-projection-id-v1", pack.id).slice(0, 48)}`;
  getDb().prepare(
    `INSERT INTO experience_public_projections (
       projection_id, pack_id, agent_id, base_package_hash,
       base_agent_definition_id, base_agent_release_id, environment_key,
       source_bindings_json, source_snapshot_hash, title, instructions_json,
       task_signatures_json, environment_constraints_json, proposal_hash,
       privacy_issue_codes_json, status, confirmation_hash, confirmed_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposal', NULL, NULL, ?, ?)
     ON CONFLICT(pack_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       base_package_hash = excluded.base_package_hash,
       base_agent_definition_id = excluded.base_agent_definition_id,
       base_agent_release_id = excluded.base_agent_release_id,
       environment_key = excluded.environment_key,
       source_bindings_json = excluded.source_bindings_json,
       source_snapshot_hash = excluded.source_snapshot_hash,
       title = excluded.title,
       instructions_json = excluded.instructions_json,
       task_signatures_json = excluded.task_signatures_json,
       environment_constraints_json = excluded.environment_constraints_json,
       proposal_hash = excluded.proposal_hash,
       privacy_issue_codes_json = excluded.privacy_issue_codes_json,
       status = 'proposal', confirmation_hash = NULL, confirmed_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(
    projectionId,
    pack.id,
    pack.agent_id,
    pack.base_package_hash,
    pack.base_agent_definition_id,
    pack.base_agent_release_id,
    pack.environment_key,
    JSON.stringify(bindings),
    liveSourceHash,
    title,
    JSON.stringify(instructions),
    JSON.stringify(tasks),
    JSON.stringify(constraints),
    nextProposalHash,
    JSON.stringify(issues),
    existing?.created_at ?? now,
    now,
  );
  getDb().prepare("UPDATE experience_packs SET updated_at = ? WHERE id = ?").run(now, pack.id);
  return rowRecord(getDb().prepare("SELECT * FROM experience_public_projections WHERE projection_id = ?")
    .get(projectionId) as ProjectionRow);
}

export function confirmOperationalPublicProjection(
  input: OperationalPublicProjectionConfirmInput,
): OperationalPublicProjectionRecord {
  exactKeys(input, ["projectionId", "proposalHash", "explicitConsent"], "Operational public projection confirmation");
  if (input.explicitConsent !== true) throw new Error("Public projection confirmation requires explicit consent.");
  const projectionId = cleanId(input.projectionId, "projectionId");
  if (!HASH_RE.test(input.proposalHash)) throw new Error("proposalHash is invalid.");
  let row = getDb().prepare("SELECT * FROM experience_public_projections WHERE projection_id = ?")
    .get(projectionId) as ProjectionRow | undefined;
  if (!row) throw new Error("Operational public projection not found.");
  const pack = getPack(row.pack_id);
  const record = rowRecord(row);
  const sources = sourceRows(pack, record.sourceBindings.map((binding) => binding.candidateId));
  const bindings = sources.map(sourceBinding);
  const liveSourceHash = sourceSnapshotHash(pack, bindings);
  const liveProposalHash = proposalHash({
    pack,
    sourceSnapshotHash: liveSourceHash,
    title: record.title,
    instructions: record.instructions,
    taskSignatures: record.taskSignatures,
    environmentConstraints: record.environmentConstraints,
  });
  const exact = row.agent_id === pack.agent_id && row.base_package_hash === pack.base_package_hash &&
    row.base_agent_definition_id === pack.base_agent_definition_id &&
    row.base_agent_release_id === pack.base_agent_release_id && row.environment_key === pack.environment_key;
  if (
    !exact || canonical(record.sourceBindings) !== canonical(bindings) ||
    row.source_snapshot_hash !== liveSourceHash || row.proposal_hash !== liveProposalHash ||
    input.proposalHash !== liveProposalHash
  ) {
    row = invalidateChangedSource(row);
    throw new Error("The source or generalized proposal changed. Save and review it again before confirming.");
  }
  const issues = privacyIssues(record.title, record.instructions, sources);
  if (issues.length > 0) {
    getDb().prepare(
      `UPDATE experience_public_projections
          SET status = 'proposal', confirmation_hash = NULL, confirmed_at = NULL,
              privacy_issue_codes_json = ?, updated_at = ?
        WHERE projection_id = ?`,
    ).run(JSON.stringify(issues), new Date().toISOString(), row.projection_id);
    throw new Error(`Public projection privacy/generalization scan failed (${issues.join(", ")}).`);
  }
  const confirmationHash = digest(
    "operational-public-confirmation-v1",
    row.proposal_hash,
    row.source_snapshot_hash,
    row.base_agent_definition_id,
    row.base_agent_release_id,
    row.environment_key,
  );
  if (row.status === "confirmed" && row.confirmation_hash === confirmationHash) return rowRecord(row);
  const now = new Date().toISOString();
  const result = getDb().prepare(
    `UPDATE experience_public_projections
        SET status = 'confirmed', confirmation_hash = ?, confirmed_at = ?,
            privacy_issue_codes_json = '[]', updated_at = ?
      WHERE projection_id = ? AND proposal_hash = ? AND source_snapshot_hash = ?`,
  ).run(confirmationHash, now, now, row.projection_id, liveProposalHash, liveSourceHash);
  if (result.changes !== 1) throw new Error("Public projection changed before confirmation; no confirmation was recorded.");
  return rowRecord(getDb().prepare("SELECT * FROM experience_public_projections WHERE projection_id = ?")
    .get(row.projection_id) as ProjectionRow);
}

/** Fail-closed read used only by public/unlisted portable materialization. */
export function confirmedOperationalPublicProjections(packId: string): OperationalPublicProjectionRecord[] {
  return listOperationalPublicProjections(packId).filter((projection) =>
    projection.status === "confirmed" && projection.privacyIssueCodes.length === 0 &&
    Boolean(projection.confirmationHash && projection.confirmedAt));
}
