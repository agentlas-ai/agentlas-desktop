import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { tryRecordFailureEvent } from "../store/run-events";
import { readSkillCatalogAsset } from "../hephaestus/skill-catalog";
import {
  appendAgentEvolutionLedger,
  computeAgentPackageHash,
  createAgentFile,
  inspectAgentFileText,
  readAgentFileText,
  removeAgentFile,
  writeAgentFile,
} from "./files";
import type {
  AgentEvolutionProposalStatus,
  AgentEvolutionProposalUi,
  AgentEvolutionReceiptUi,
  CreateAgentEvolutionProposalInput,
} from "../../shared/types";

interface AgentEvolutionProposalRow {
  id: string;
  agent_id: string;
  proposal_type: string;
  summary: string;
  target_path: string;
  before_hash: string;
  after_hash: string;
  before_content: string;
  after_content: string;
  risk: string;
  status: AgentEvolutionProposalStatus;
  source_json: string;
  operation_json: string | null;
  decision_note: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  applied_at: string | null;
  measured_at: string | null;
  rolled_back_at: string | null;
}

interface AgentEvolutionReceiptRow {
  id: string;
  proposal_id: string;
  agent_id: string;
  action: "apply" | "rollback";
  target_path: string;
  version_before: number;
  version_after: number;
  target_hash_before: string;
  target_hash_after: string;
  package_hash_before: string;
  package_hash_after: string;
  created_at: string;
}

interface PendingOperation {
  action: "apply" | "rollback";
  packageHashBefore: string;
  versionBefore: number;
  previousStatus: AgentEvolutionProposalStatus;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const ABSENT_TARGET_HASH = sha256("agentlas:absent-agent-asset:v1");

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLimit(limit?: number): number {
  const value = Number(limit ?? 50);
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function parseObject(json: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parsePendingOperation(json: string | null): PendingOperation | null {
  const value = parseObject(json);
  if (
    (value.action !== "apply" && value.action !== "rollback") ||
    typeof value.packageHashBefore !== "string" ||
    !Number.isInteger(value.versionBefore) ||
    typeof value.previousStatus !== "string"
  ) {
    return null;
  }
  return value as unknown as PendingOperation;
}

function toReceiptUi(row: AgentEvolutionReceiptRow): AgentEvolutionReceiptUi {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    agentId: row.agent_id,
    action: row.action,
    targetPath: row.target_path,
    versionBefore: row.version_before,
    versionAfter: row.version_after,
    targetHashBefore: row.target_hash_before,
    targetHashAfter: row.target_hash_after,
    governedAssetHashBefore: row.package_hash_before,
    governedAssetHashAfter: row.package_hash_after,
    packageHashBefore: row.package_hash_before,
    packageHashAfter: row.package_hash_after,
    createdAt: row.created_at,
  };
}

function receiptsForProposal(proposalId: string): AgentEvolutionReceiptUi[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_evolution_receipts
       WHERE proposal_id = ?
       ORDER BY datetime(created_at) ASC, id ASC`,
    )
    .all(proposalId) as AgentEvolutionReceiptRow[];
  return rows.map(toReceiptUi);
}

function toUi(row: AgentEvolutionProposalRow): AgentEvolutionProposalUi {
  return {
    id: row.id,
    agentId: row.agent_id,
    proposalType: row.proposal_type as AgentEvolutionProposalUi["proposalType"],
    summary: row.summary,
    targetPath: row.target_path,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    beforeContent: row.before_content,
    afterContent: row.after_content,
    risk: row.risk as AgentEvolutionProposalUi["risk"],
    status: row.status,
    source: parseObject(row.source_json),
    receipts: receiptsForProposal(row.id),
    decisionNote: row.decision_note ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at ?? undefined,
    appliedAt: row.applied_at ?? undefined,
    measuredAt: row.measured_at ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
  };
}

function proposalRow(proposalId: string): AgentEvolutionProposalRow {
  const row = getDb()
    .prepare("SELECT * FROM agent_evolution_proposals WHERE id = ?")
    .get(proposalId) as AgentEvolutionProposalRow | undefined;
  if (!row) throw new Error("Proposal not found");
  return row;
}

function appendLedger(row: AgentEvolutionProposalRow, event: string): void {
  try {
    appendAgentEvolutionLedger(row.agent_id, {
      kind: "agent_evolution_proposal",
      event,
      proposal_id: row.id,
      agent_id: row.agent_id,
      proposal_type: row.proposal_type,
      summary: row.summary,
      target_path: row.target_path,
      before_hash: row.before_hash,
      after_hash: row.after_hash,
      risk: row.risk,
      status: row.status,
      source: parseObject(row.source_json),
      receipts: receiptsForProposal(row.id).map((receipt) => ({
        id: receipt.id,
        action: receipt.action,
        version_before: receipt.versionBefore,
        version_after: receipt.versionAfter,
        package_hash_before: receipt.packageHashBefore,
        package_hash_after: receipt.packageHashAfter,
        created_at: receipt.createdAt,
      })),
      decision_note: row.decision_note,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
      approved_at: row.approved_at,
      applied_at: row.applied_at,
      measured_at: row.measured_at,
      rolled_back_at: row.rolled_back_at,
    });
  } catch (error) {
    // SQLite is the authoritative receipt store. A read-only local package may
    // prevent the portable JSONL copy, but never rolls back the DB transition.
    console.warn("[agent-evolution] failed to append agent ledger:", error);
  }
}

function validateMemorySources(
  agentId: string,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const source = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const rawIds = source.memoryEntryIds;
  if (rawIds === undefined) return source;
  if (!Array.isArray(rawIds) || rawIds.length > 100) {
    throw new Error("memoryEntryIds must be an array of at most 100 ids");
  }
  const ids = [...new Set(rawIds.map((value) => String(value).trim()).filter(Boolean))];
  const getMemory = getDb().prepare(
    `SELECT id, agent_id, scope, project_path, superseded_at
     FROM memory_entries WHERE id = ?`,
  );
  for (const id of ids) {
    const row = getMemory.get(id) as {
      id: string;
      agent_id: string | null;
      scope: string;
      project_path: string | null;
      superseded_at: string | null;
    } | undefined;
    if (!row || row.superseded_at || row.agent_id !== agentId) {
      throw new Error("Evolution source memory does not belong to this agent");
    }
    // Project memory remains contextual. Only agent-owned, folderless learning
    // can be promoted into the durable agent package prompt.
    if (row.scope !== "agent_repo" || row.project_path !== null) {
      throw new Error("Project-scoped memory cannot be promoted into a global agent asset");
    }
  }
  source.memoryEntryIds = ids;
  return source;
}

function targetExistedBefore(row: AgentEvolutionProposalRow): boolean {
  return parseObject(row.source_json)._agentlasTargetExisted !== false;
}

function currentTargetHash(agentId: string, targetPath: string): { exists: boolean; hash: string } {
  const snapshot = inspectAgentFileText(agentId, targetPath);
  return { exists: snapshot.exists, hash: snapshot.exists ? snapshot.hash : ABSENT_TARGET_HASH };
}

function syncAssetBaseline(agentId: string, packageHash: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT version, package_hash FROM agent_asset_versions WHERE agent_id = ?")
    .get(agentId) as { version: number; package_hash: string } | undefined;
  const now = nowIso();
  if (!row) {
    db.prepare(
      `INSERT INTO agent_asset_versions (agent_id, version, package_hash, updated_at)
       VALUES (?, 1, ?, ?)`,
    ).run(agentId, packageHash, now);
    return 1;
  }
  if (row.package_hash === packageHash) return row.version;
  const next = row.version + 1;
  db.prepare(
    `UPDATE agent_asset_versions
     SET version = ?, package_hash = ?, updated_at = ?
     WHERE agent_id = ?`,
  ).run(next, packageHash, now, agentId);
  return next;
}

function finalizeOperation(
  row: AgentEvolutionProposalRow,
  operation: PendingOperation,
): AgentEvolutionProposalRow {
  const isApply = operation.action === "apply";
  const targetHashBefore = isApply ? row.before_hash : row.after_hash;
  const targetHashAfter = isApply ? row.after_hash : row.before_hash;
  const current = currentTargetHash(row.agent_id, row.target_path);
  if (current.hash !== targetHashAfter) {
    throw new Error(`Cannot finalize ${operation.action}: target hash does not match the approved content`);
  }
  const packageHashAfter = computeAgentPackageHash(row.agent_id, row.target_path);
  const versionAfter = operation.versionBefore + 1;
  const completedAt = nowIso();
  const receiptId = `evo_receipt_${randomUUID()}`;
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_evolution_receipts (
        id, proposal_id, agent_id, action, target_path,
        version_before, version_after, target_hash_before, target_hash_after,
        package_hash_before, package_hash_after, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id, action) DO NOTHING`,
    ).run(
      receiptId,
      row.id,
      row.agent_id,
      operation.action,
      row.target_path,
      operation.versionBefore,
      versionAfter,
      targetHashBefore,
      targetHashAfter,
      operation.packageHashBefore,
      packageHashAfter,
      completedAt,
    );
    db.prepare(
      `INSERT INTO agent_asset_versions (agent_id, version, package_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         version = excluded.version,
         package_hash = excluded.package_hash,
         updated_at = excluded.updated_at`,
    ).run(row.agent_id, versionAfter, packageHashAfter, completedAt);
    if (row.proposal_type === "rule") {
      // The selected source file may be AGENT.md/CLAUDE.md/etc. for imported
      // packages. The runtime reads installed_agents.system_prompt, so the same
      // receipt transaction must advance (or roll back) that runtime authority.
      db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?")
        .run(isApply ? row.after_content : row.before_content, row.agent_id);
    }
    if (isApply) {
      db.prepare(
        `UPDATE agent_evolution_proposals
         SET status = 'applied', applied_at = COALESCE(applied_at, ?),
             operation_json = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'applying'`,
      ).run(completedAt, completedAt, row.id);
    } else {
      db.prepare(
        `UPDATE agent_evolution_proposals
         SET status = 'rolled_back', rolled_back_at = COALESCE(rolled_back_at, ?),
             operation_json = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'rolling_back'`,
      ).run(completedAt, completedAt, row.id);
    }
  });
  tx();
  return proposalRow(row.id);
}

function recordOperationFailure(
  row: AgentEvolutionProposalRow,
  action: "apply" | "rollback",
  message: string,
  recovered: boolean,
  previousStatus?: AgentEvolutionProposalStatus,
): void {
  const failedAt = nowIso();
  const status = action === "apply"
    ? (recovered ? "apply_failed" : "recovery_required")
    : (recovered ? (previousStatus === "measured" ? "measured" : "applied") : "recovery_required");
  getDb().prepare(
    `UPDATE agent_evolution_proposals
     SET status = ?, operation_json = NULL, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, message, failedAt, row.id);
  tryRecordFailureEvent({
    source: "agent_evolution",
    agentId: row.agent_id,
    errorCode: `${action}_failed`,
    errorMessage: message,
    payload: { proposalId: row.id, targetPath: row.target_path, proposalType: row.proposal_type, recovered },
  });
}

/** Resolve crash-interrupted applying/rolling_back rows before presenting state. */
export function recoverIncompleteAgentEvolutionOperations(agentId?: string): void {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM agent_evolution_proposals
     WHERE status IN ('applying', 'rolling_back')
       AND (? IS NULL OR agent_id = ?)
     ORDER BY datetime(updated_at) ASC`,
  ).all(agentId ?? null, agentId ?? null) as AgentEvolutionProposalRow[];

  for (const row of rows) {
    const operation = parsePendingOperation(row.operation_json);
    if (!operation) {
      recordOperationFailure(row, row.status === "rolling_back" ? "rollback" : "apply", "Interrupted operation has no recovery metadata", false);
      continue;
    }
    try {
      const current = currentTargetHash(row.agent_id, row.target_path);
      const destinationHash = operation.action === "apply" ? row.after_hash : row.before_hash;
      const originHash = operation.action === "apply" ? row.before_hash : row.after_hash;
      if (current.hash === destinationHash) {
        const finalized = finalizeOperation(row, operation);
        appendLedger(finalized, `${operation.action}_recovered_and_finalized`);
        continue;
      }
      if (current.hash === originHash) {
        recordOperationFailure(
          row,
          operation.action,
          "Interrupted operation recovered before the atomic file replacement",
          true,
          operation.previousStatus,
        );
        continue;
      }
      recordOperationFailure(
        row,
        operation.action,
        "Interrupted operation found unknown target bytes; preserved them for manual diff and recovery",
        false,
        operation.previousStatus,
      );
    } catch (error) {
      recordOperationFailure(
        row,
        operation.action,
        error instanceof Error ? error.message : String(error),
        false,
        operation.previousStatus,
      );
    }
  }
}

export function listAgentEvolutionProposals(agentId: string, limit?: number): AgentEvolutionProposalUi[] {
  if (!agentId) return [];
  recoverIncompleteAgentEvolutionOperations(agentId);
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_evolution_proposals
       WHERE agent_id = ?
       ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
       LIMIT ?`,
    )
    .all(agentId, normalizeLimit(limit)) as AgentEvolutionProposalRow[];
  return rows.map(toUi);
}

/**
 * 진화 트리거 멱등성 — 같은 증거 키(_triggerEvidenceKey)로 이미 만든 제안이 있으면
 * (승인/적용/롤백/거절 어느 상태든) 다시 만들지 않는다. 사용자가 "안 함"으로 거절했거나
 * 이미 되돌린 근거를 반복 제안하지 않기 위해 status 무관하게 정확 일치로 조회한다.
 */
export function findGrowthProposalByEvidenceKey(
  agentId: string,
  evidenceKey: string,
): AgentEvolutionProposalUi | null {
  if (!agentId || !evidenceKey) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM agent_evolution_proposals
        WHERE agent_id = ?
          AND json_extract(source_json, '$._triggerEvidenceKey') = ?
        ORDER BY datetime(created_at) DESC LIMIT 1`,
    )
    .get(agentId, evidenceKey) as AgentEvolutionProposalRow | undefined;
  return row ? toUi(row) : null;
}

/**
 * 4표면 발화 UX용 — 트리거가 만든 "성장 제안"을 에이전트 무관 전역으로 모은다.
 * pending = 사람이 결정해야 하는 고위험 후보(candidate). applied = 저위험 자동적용분
 * (수동태 "적용됨 · 되돌리기" 표기용, 최근 것만). content-free 카드 문구는 source.humanCard.
 */
export function listPendingGrowthProposals(limit?: number): {
  pending: AgentEvolutionProposalUi[];
  autoApplied: AgentEvolutionProposalUi[];
} {
  const capped = normalizeLimit(limit);
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_evolution_proposals
        WHERE json_extract(source_json, '$._growth') = 1
          AND json_extract(source_json, '$._growthDeletedAt') IS NULL
          AND status IN ('candidate', 'applied', 'measured')
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
        LIMIT ?`,
    )
    .all(capped) as AgentEvolutionProposalRow[];
  const pending: AgentEvolutionProposalUi[] = [];
  const autoApplied: AgentEvolutionProposalUi[] = [];
  for (const row of rows) {
    const ui = toUi(row);
    if (row.status === "candidate") pending.push(ui);
    else if ((ui.source as Record<string, unknown>)._autoApplied === true) autoApplied.push(ui);
  }
  return { pending, autoApplied };
}

/** 발화 배지용 — 사람이 결정해야 하는 고위험 성장 제안(candidate) 개수. */
export function countPendingGrowthProposals(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_evolution_proposals
        WHERE json_extract(source_json, '$._growth') = 1
          AND json_extract(source_json, '$._growthDeletedAt') IS NULL
          AND status = 'candidate'`,
    )
    .get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Remove one growth-proposal session from the user-facing inbox while keeping
 * the governed asset, apply/rollback receipts, and append-only ledger intact.
 * This is deliberately a soft delete: a deleted card must never be mistaken
 * for an undo of an already applied change.
 */
export function deleteAgentGrowthProposalSession(proposalId: string): AgentEvolutionProposalUi {
  recoverIncompleteAgentEvolutionOperations();
  let row = proposalRow(proposalId);
  const source = parseObject(row.source_json);
  if (source._growth !== true) {
    throw new Error("Only a growth proposal session can be deleted from the dashboard");
  }
  const existingDeletedAt = typeof source._growthDeletedAt === "string"
    ? source._growthDeletedAt
    : null;
  if (existingDeletedAt) return toUi(row);
  if (row.status === "applying" || row.status === "rolling_back") {
    throw new Error("Cannot delete a growth proposal while its operation is running");
  }
  const deletedAt = nowIso();
  const nextSource = { ...source, _growthDeletedAt: deletedAt };
  const result = getDb()
    .prepare(
      `UPDATE agent_evolution_proposals
       SET source_json = ?, updated_at = ?
       WHERE id = ?
         AND json_extract(source_json, '$._growth') = 1
         AND json_extract(source_json, '$._growthDeletedAt') IS NULL`,
    )
    .run(JSON.stringify(nextSource), deletedAt, row.id);
  if (result.changes !== 1) {
    row = proposalRow(row.id);
    const racedSource = parseObject(row.source_json);
    if (typeof racedSource._growthDeletedAt === "string") return toUi(row);
    throw new Error("Growth proposal deletion lost a concurrent state race");
  }
  row = proposalRow(row.id);
  appendLedger(row, "proposal_session_deleted");
  return toUi(row);
}

/** Candidate collection only. No approval timestamp and no package file write. */
export function createAgentEvolutionProposal(
  input: CreateAgentEvolutionProposalInput,
): AgentEvolutionProposalUi {
  if (!input.agentId) throw new Error("agentId is required");
  if (!input.targetPath) throw new Error("targetPath is required");
  const proposalType = input.proposalType ?? "rule";
  const currentContent = String(input.currentContent ?? "");
  const proposedContent = String(input.proposedContent ?? "");
  if (Buffer.byteLength(proposedContent, "utf8") > 512 * 1024) {
    throw new Error("Proposed agent asset exceeds the portable 512 KiB evolution limit");
  }
  const authoritative = inspectAgentFileText(input.agentId, input.targetPath);
  const validatedSource = validateMemorySources(input.agentId, input.source);
  if (proposalType === "skill") {
    const skillSlug = typeof validatedSource.skillSlug === "string" ? validatedSource.skillSlug : "";
    const catalogContentHash = typeof validatedSource.catalogContentHash === "string"
      ? validatedSource.catalogContentHash
      : "";
    if (!skillSlug || !catalogContentHash) {
      throw new Error("Skill evolution requires an exact main-owned catalog source");
    }
    const catalogAsset = readSkillCatalogAsset(skillSlug);
    const expectedTarget = `skills/${catalogAsset.slug}/SKILL.md`;
    if (authoritative.relativePath !== expectedTarget) {
      throw new Error("Skill evolution target must use the portable package skills path");
    }
    if (catalogAsset.contentHash !== catalogContentHash || catalogAsset.content !== proposedContent) {
      throw new Error("Skill evolution content does not match the selected catalog source");
    }
    validatedSource.skillSlug = catalogAsset.slug;
    validatedSource.catalogContentHash = catalogAsset.contentHash;
    validatedSource.catalogByteLength = catalogAsset.byteLength;
  } else if (proposalType === "rule") {
    const promptTargets = new Set([
      "system-prompt.md",
      "soul.md",
      "agent.md",
      "claude.md",
      "agents.md",
      "gemini.md",
      "persona.md",
      "prompt.md",
    ]);
    if (authoritative.relativePath.includes("/") || !promptTargets.has(authoritative.relativePath.toLowerCase())) {
      throw new Error("Rule evolution target must be a supported root runtime prompt file");
    }
  } else {
    throw new Error(`Unsupported governed evolution proposal type: ${proposalType}`);
  }
  const beforeHash = authoritative.exists ? authoritative.hash : ABSENT_TARGET_HASH;
  if ((authoritative.exists && authoritative.hash !== sha256(currentContent)) || (!authoritative.exists && currentContent !== "")) {
    throw new Error("Evolution base is stale; reload the agent asset before creating a proposal");
  }
  const afterHash = sha256(proposedContent);
  if (afterHash === authoritative.hash) throw new Error("Evolution proposal does not change the agent asset");

  const source = {
    ...validatedSource,
    _agentlasTargetExisted: authoritative.exists,
  };
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM agent_evolution_proposals
     WHERE agent_id = ? AND target_path = ? AND status IN ('candidate', 'approved', 'applying')
     ORDER BY datetime(created_at) DESC LIMIT 1`,
  ).get(input.agentId, authoritative.relativePath) as AgentEvolutionProposalRow | undefined;
  if (existing) {
    if (existing.before_hash === beforeHash && existing.after_hash === afterHash) return toUi(existing);
    throw new Error("A pending evolution proposal already exists for this agent asset");
  }

  const now = nowIso();
  const id = `evo_${randomUUID()}`;
  const risk = input.risk ?? "medium";
  const summary = input.summary?.trim() || "Prompt self-evolution proposal";
  db.prepare(`
    INSERT INTO agent_evolution_proposals (
      id, agent_id, proposal_type, summary, target_path,
      before_hash, after_hash, before_content, after_content,
      risk, status, source_json, operation_json, decision_note,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, NULL, ?, ?, ?)
  `).run(
    id,
    input.agentId,
    proposalType,
    summary,
    authoritative.relativePath,
    beforeHash,
    afterHash,
    authoritative.content,
    proposedContent,
    risk,
    JSON.stringify(source),
    input.decisionNote ?? null,
    now,
    now,
  );
  const row = proposalRow(id);
  appendLedger(row, "proposal_created");
  return toUi(row);
}

/** Explicit user approval and atomic application of a previously durable candidate. */
export function approveAndApplyAgentEvolutionProposal(
  proposalId: string,
  decisionNote?: string,
): AgentEvolutionProposalUi {
  recoverIncompleteAgentEvolutionOperations();
  let row = proposalRow(proposalId);
  if ((row.status === "applied" || row.status === "measured") && receiptsForProposal(row.id).some((r) => r.action === "apply")) {
    return toUi(row);
  }
  if (row.status !== "candidate") throw new Error("Only a candidate proposal can be approved and applied");

  const current = currentTargetHash(row.agent_id, row.target_path);
  if (current.hash !== row.before_hash) {
    const message = "Agent asset changed after review; create a new proposal from the current version";
    getDb().prepare(
      `UPDATE agent_evolution_proposals SET status = 'conflicted', last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(message, nowIso(), row.id);
    throw new Error(message);
  }
  const packageHashBefore = computeAgentPackageHash(row.agent_id, row.target_path);
  const versionBefore = syncAssetBaseline(row.agent_id, packageHashBefore);
  const approvedAt = nowIso();
  const operation: PendingOperation = {
    action: "apply",
    packageHashBefore,
    versionBefore,
    previousStatus: "candidate",
  };
  const result = getDb().prepare(
    `UPDATE agent_evolution_proposals
     SET status = 'applying', approved_at = COALESCE(approved_at, ?),
         decision_note = COALESCE(?, decision_note), operation_json = ?,
         last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'candidate'`,
  ).run(approvedAt, decisionNote ?? null, JSON.stringify(operation), approvedAt, row.id);
  if (result.changes !== 1) throw new Error("Proposal approval lost a concurrent state race");
  row = proposalRow(row.id);
  appendLedger(row, "proposal_approved");

  const beforeWriteTarget = currentTargetHash(row.agent_id, row.target_path);
  const beforeWritePackage = computeAgentPackageHash(row.agent_id, row.target_path);
  if (beforeWriteTarget.hash !== row.before_hash || beforeWritePackage !== operation.packageHashBefore) {
    const message = "Agent package changed immediately before apply; current bytes were preserved";
    getDb().prepare(
      `UPDATE agent_evolution_proposals
       SET status = 'conflicted', operation_json = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'applying'`,
    ).run(message, nowIso(), row.id);
    throw new Error(message);
  }

  try {
    if (targetExistedBefore(row)) {
      writeAgentFile(row.agent_id, row.target_path, row.after_content);
    } else {
      createAgentFile(row.agent_id, row.target_path, row.after_content);
    }
    const applied = finalizeOperation(row, operation);
    appendLedger(applied, "proposal_applied");
    return toUi(applied);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let restored = false;
    const createRace = !targetExistedBefore(row) && (error as NodeJS.ErrnoException).code === "EEXIST";
    if (!createRace) {
      try {
        const observed = currentTargetHash(row.agent_id, row.target_path);
        if (observed.hash === row.before_hash) {
          restored = true;
        } else if (observed.hash === row.after_hash) {
          if (targetExistedBefore(row)) {
            writeAgentFile(row.agent_id, row.target_path, row.before_content);
          } else {
            removeAgentFile(row.agent_id, row.target_path);
          }
          restored = currentTargetHash(row.agent_id, row.target_path).hash === row.before_hash;
        }
      } catch {
        restored = false;
      }
    }
    recordOperationFailure(row, "apply", createRace ? `${message}; competing file preserved` : message, restored);
    throw new Error(restored ? `${message} (original content restored)` : `${message} (automatic recovery required)`);
  }
}

export function rejectAgentEvolutionProposal(proposalId: string, note?: string): AgentEvolutionProposalUi {
  const rejectedAt = nowIso();
  const result = getDb().prepare(
    `UPDATE agent_evolution_proposals
     SET status = 'rejected', decision_note = COALESCE(?, decision_note),
         last_error = NULL, operation_json = NULL, updated_at = ?
     WHERE id = ? AND status = 'candidate'`,
  ).run(note ?? null, rejectedAt, proposalId);
  const row = proposalRow(proposalId);
  if (result.changes < 1 && row.status !== "rejected") {
    throw new Error("Only a candidate proposal can be rejected");
  }
  appendLedger(row, "proposal_rejected");
  return toUi(row);
}

export function markAgentEvolutionProposalMeasured(proposalId: string, note?: string): AgentEvolutionProposalUi {
  const measuredAt = nowIso();
  const result = getDb()
    .prepare(
      `UPDATE agent_evolution_proposals
       SET status = 'measured', measured_at = ?, decision_note = COALESCE(?, decision_note), updated_at = ?
       WHERE id = ? AND status IN ('applied', 'measured')`,
    )
    .run(measuredAt, note ?? null, measuredAt, proposalId);
  if (result.changes < 1) throw new Error("Proposal is not in an applied state");
  const row = proposalRow(proposalId);
  appendLedger(row, "proposal_measured");
  return toUi(row);
}

export function rollbackAgentEvolutionProposal(proposalId: string): AgentEvolutionProposalUi {
  recoverIncompleteAgentEvolutionOperations();
  let row = proposalRow(proposalId);
  if (row.status === "rolled_back" && receiptsForProposal(row.id).some((r) => r.action === "rollback")) {
    return toUi(row);
  }
  if (row.status !== "applied" && row.status !== "measured") {
    throw new Error("Only applied or measured proposals can be rolled back");
  }
  const previousStatus = row.status;
  const current = currentTargetHash(row.agent_id, row.target_path);
  if (current.hash !== row.after_hash) {
    const message = "Rollback blocked because the agent asset changed after this proposal was applied";
    getDb().prepare(
      `UPDATE agent_evolution_proposals SET last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(message, nowIso(), row.id);
    throw new Error(message);
  }
  const applyReceipt = receiptsForProposal(row.id).find((receipt) => receipt.action === "apply");
  if (!applyReceipt) throw new Error("Rollback requires the verified apply receipt");
  const packageHashBefore = computeAgentPackageHash(row.agent_id, row.target_path);
  if (packageHashBefore !== applyReceipt.packageHashAfter) {
    const message = "Rollback blocked because another governed agent asset changed after apply";
    getDb().prepare(
      `UPDATE agent_evolution_proposals
       SET status = 'conflicted', last_error = ?, updated_at = ?
       WHERE id = ? AND status IN ('applied', 'measured')`,
    ).run(message, nowIso(), row.id);
    throw new Error(message);
  }
  const versionBefore = syncAssetBaseline(row.agent_id, packageHashBefore);
  const operation: PendingOperation = {
    action: "rollback",
    packageHashBefore,
    versionBefore,
    previousStatus,
  };
  const startedAt = nowIso();
  const result = getDb().prepare(
    `UPDATE agent_evolution_proposals
     SET status = 'rolling_back', operation_json = ?, last_error = NULL, updated_at = ?
     WHERE id = ? AND status IN ('applied', 'measured')`,
  ).run(JSON.stringify(operation), startedAt, row.id);
  if (result.changes !== 1) throw new Error("Rollback lost a concurrent state race");
  row = proposalRow(row.id);

  const beforeRollbackTarget = currentTargetHash(row.agent_id, row.target_path);
  const beforeRollbackPackage = computeAgentPackageHash(row.agent_id, row.target_path);
  if (beforeRollbackTarget.hash !== row.after_hash || beforeRollbackPackage !== operation.packageHashBefore) {
    const message = "Agent package changed immediately before rollback; current bytes were preserved";
    getDb().prepare(
      `UPDATE agent_evolution_proposals
       SET status = 'conflicted', operation_json = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'rolling_back'`,
    ).run(message, nowIso(), row.id);
    throw new Error(message);
  }

  try {
    if (targetExistedBefore(row)) {
      writeAgentFile(row.agent_id, row.target_path, row.before_content);
    } else {
      removeAgentFile(row.agent_id, row.target_path);
    }
    const rolledBack = finalizeOperation(row, operation);
    appendLedger(rolledBack, "proposal_rolled_back");
    return toUi(rolledBack);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let restored = false;
    try {
      const observed = currentTargetHash(row.agent_id, row.target_path);
      if (observed.hash === row.after_hash) {
        restored = true;
      } else if (observed.hash === row.before_hash) {
        writeAgentFile(row.agent_id, row.target_path, row.after_content);
        restored = readAgentFileText(row.agent_id, row.target_path).hash === row.after_hash;
      }
    } catch {
      restored = false;
    }
    recordOperationFailure(row, "rollback", message, restored, previousStatus);
    throw new Error(restored ? `${message} (applied content restored)` : `${message} (automatic recovery required)`);
  }
}
