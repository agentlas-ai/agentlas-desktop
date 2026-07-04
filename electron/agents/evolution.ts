import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { tryRecordFailureEvent } from "../store/run-events";
import { writeAgentFile } from "./files";
import type {
  AgentEvolutionProposalStatus,
  AgentEvolutionProposalUi,
  CreatePromptEvolutionProposalInput,
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
  decision_note: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  applied_at: string | null;
  measured_at: string | null;
  rolled_back_at: string | null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLimit(limit?: number): number {
  const value = Number(limit ?? 50);
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function parseSource(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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
    risk: row.risk as AgentEvolutionProposalUi["risk"],
    status: row.status,
    source: parseSource(row.source_json),
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

export function listAgentEvolutionProposals(agentId: string, limit?: number): AgentEvolutionProposalUi[] {
  if (!agentId) return [];
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

export function createAndApplyPromptEvolutionProposal(
  input: CreatePromptEvolutionProposalInput,
): AgentEvolutionProposalUi {
  if (!input.agentId) throw new Error("agentId is required");
  if (!input.targetPath) throw new Error("targetPath is required");
  const currentContent = String(input.currentContent ?? "");
  const proposedContent = String(input.proposedContent ?? "");
  const now = nowIso();
  const id = `evo_${randomUUID()}`;
  const sourceJson = JSON.stringify(input.source ?? {});
  const risk = input.risk ?? "medium";
  const proposalType = input.proposalType ?? "rule";
  const summary = input.summary?.trim() || "Prompt self-evolution proposal";

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO agent_evolution_proposals (
      id, agent_id, proposal_type, summary, target_path,
      before_hash, after_hash, before_content, after_content,
      risk, status, source_json, decision_note,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)
  `);
  insert.run(
    id,
    input.agentId,
    proposalType,
    summary,
    input.targetPath,
    sha256(currentContent),
    sha256(proposedContent),
    currentContent,
    proposedContent,
    risk,
    sourceJson,
    input.decisionNote ?? null,
    now,
    now,
  );

  const approvedAt = nowIso();
  db.prepare(
    `UPDATE agent_evolution_proposals
     SET status = 'approved', approved_at = ?, updated_at = ?
     WHERE id = ? AND status = 'candidate'`,
  ).run(approvedAt, approvedAt, id);

  try {
    writeAgentFile(input.agentId, input.targetPath, proposedContent);
    const appliedAt = nowIso();
    db.prepare(
      `UPDATE agent_evolution_proposals
       SET status = 'applied', applied_at = ?, updated_at = ?, last_error = NULL
       WHERE id = ? AND status = 'approved'`,
    ).run(appliedAt, appliedAt, id);
  } catch (error) {
    const failedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(
      `UPDATE agent_evolution_proposals
       SET status = 'apply_failed', last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message, failedAt, id);
    tryRecordFailureEvent({
      source: "agent_evolution",
      agentId: input.agentId,
      errorCode: "apply_failed",
      errorMessage: message,
      payload: { proposalId: id, targetPath: input.targetPath, proposalType },
    });
    throw error;
  }

  const row = db.prepare("SELECT * FROM agent_evolution_proposals WHERE id = ?").get(id) as AgentEvolutionProposalRow;
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
  const row = getDb().prepare("SELECT * FROM agent_evolution_proposals WHERE id = ?").get(proposalId) as AgentEvolutionProposalRow;
  return toUi(row);
}

export function rollbackAgentEvolutionProposal(proposalId: string): AgentEvolutionProposalUi {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_evolution_proposals WHERE id = ?").get(proposalId) as AgentEvolutionProposalRow | undefined;
  if (!row) throw new Error("Proposal not found");
  if (row.status !== "applied" && row.status !== "measured") {
    throw new Error("Only applied or measured proposals can be rolled back");
  }
  writeAgentFile(row.agent_id, row.target_path, row.before_content);
  const rolledBackAt = nowIso();
  db.prepare(
    `UPDATE agent_evolution_proposals
     SET status = 'rolled_back', rolled_back_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(rolledBackAt, rolledBackAt, proposalId);
  const updated = db.prepare("SELECT * FROM agent_evolution_proposals WHERE id = ?").get(proposalId) as AgentEvolutionProposalRow;
  return toUi(updated);
}
