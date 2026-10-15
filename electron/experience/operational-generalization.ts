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

function cleanId(value: unknown, label: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!LOCAL_ID_RE.test(clean)) throw new Error(`${label} is invalid.`);
  return clean;
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
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

/** Reading retired projections preserves their original confirmation evidence. */
export function listOperationalPublicProjections(packIdValue: string): OperationalPublicProjectionRecord[] {
  const packId = cleanId(packIdValue, "packId");
  const rows = getDb().prepare(
    "SELECT * FROM experience_public_projections WHERE pack_id = ? ORDER BY updated_at DESC",
  ).all(packId) as ProjectionRow[];
  return rows.map(rowRecord);
}

/** Fail-closed read used only by public/unlisted portable materialization. */
export function confirmedOperationalPublicProjections(packId: string): OperationalPublicProjectionRecord[] {
  return listOperationalPublicProjections(packId).filter((projection) =>
    projection.status === "confirmed" && projection.privacyIssueCodes.length === 0 &&
    Boolean(projection.confirmationHash && projection.confirmedAt));
}
