// Durable job/cost ledger for agent-made surfaces.
// The manifest remains declarative, while this table lets long-running creative
// or external-service jobs survive app restarts and reconnect to the Workbench.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  AgentlasSurfaceBudget,
  AgentlasSurfaceJob,
  AgentlasSurfaceManifest,
  SurfaceJobCostSummary,
  SurfaceJobRecord,
  SurfaceJobUpdateRequest,
} from "../../shared/types";

interface AgentSurfaceJobRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
  surface_id: string;
  job_id: string;
  label: string;
  status: string;
  cost_estimate: number | null;
  cost_spent: number | null;
  currency: string | null;
  resumable: number;
  manifest_job_json: string;
  created_at: string;
  updated_at: string;
}

export function syncSurfaceJobs(input: {
  chatId: string;
  projectId?: string | null;
  agentId: string;
  surfaceId: string;
  manifest: AgentlasSurfaceManifest;
}): void {
  const jobs = input.manifest.jobs ?? [];
  if (jobs.length === 0) return;

  const now = new Date().toISOString();
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO agent_surface_jobs (
       id, chat_id, project_id, agent_id, surface_id, job_id, label, status,
       cost_estimate, cost_spent, currency, resumable, manifest_job_json,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(surface_id, job_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       project_id = excluded.project_id,
       agent_id = excluded.agent_id,
       label = excluded.label,
       -- A job the host closed (expired, cancelled, finished) is not reopened by re-saving the
       -- surface: the manifest template still says "queued" and nothing executes surface jobs.
       status = CASE WHEN agent_surface_jobs.status IN ('cancelled','failed','succeeded')
                      AND excluded.status IN ('queued','running','paused')
                     THEN agent_surface_jobs.status ELSE excluded.status END,
       cost_estimate = excluded.cost_estimate,
       cost_spent = COALESCE(excluded.cost_spent, agent_surface_jobs.cost_spent),
       currency = COALESCE(excluded.currency, agent_surface_jobs.currency),
       resumable = excluded.resumable,
       manifest_job_json = excluded.manifest_job_json,
       updated_at = excluded.updated_at`,
  );

  const tx = db.transaction((surfaceJobs: AgentlasSurfaceJob[]) => {
    for (const job of surfaceJobs) {
      upsert.run(
        rowId(input.surfaceId, job.id),
        input.chatId,
        input.projectId ?? null,
        input.agentId,
        input.surfaceId,
        job.id,
        job.label,
        job.status,
        typeof job.costEstimate === "number" ? job.costEstimate : null,
        typeof job.costSpent === "number" ? job.costSpent : null,
        typeof job.currency === "string" && job.currency.trim() ? job.currency.trim().toUpperCase() : null,
        job.resumable ? 1 : 0,
        encodeJson(job),
        now,
        now,
      );
    }
  });
  tx(jobs);
}

export function listSurfaceJobs(surfaceId: string): SurfaceJobRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_surface_jobs WHERE surface_id = ? ORDER BY updated_at DESC")
    .all(surfaceId) as AgentSurfaceJobRow[];
  return rows.map(toJobRecord);
}

export function getSurfaceJobSummary(
  surfaceId: string,
  budget?: AgentlasSurfaceBudget,
): SurfaceJobCostSummary | null {
  const jobs = listSurfaceJobs(surfaceId);
  if (jobs.length === 0) return null;
  return summarizeSurfaceJobRecords(jobs, budget);
}

export function updateSurfaceJob(input: SurfaceJobUpdateRequest): SurfaceJobRecord {
  const current = getDb()
    .prepare("SELECT * FROM agent_surface_jobs WHERE surface_id = ? AND job_id = ?")
    .get(input.surfaceId, input.jobId) as AgentSurfaceJobRow | undefined;
  if (!current) throw new Error(`Surface job not found: ${input.surfaceId}/${input.jobId}`);

  const now = new Date().toISOString();
  const manifestJob = decodeJob(current.manifest_job_json, {
    id: current.job_id,
    label: current.label,
    status: current.status,
  });
  if (input.status) manifestJob.status = input.status;
  if (typeof input.costSpent === "number") manifestJob.costSpent = input.costSpent;
  if (input.note) manifestJob.note = input.note;

  getDb()
    .prepare(
      `UPDATE agent_surface_jobs
       SET status = ?,
           cost_spent = ?,
           manifest_job_json = ?,
           updated_at = ?
       WHERE surface_id = ? AND job_id = ?`,
    )
    .run(
      input.status ?? current.status,
      typeof input.costSpent === "number" ? input.costSpent : current.cost_spent,
      encodeJson(manifestJob),
      now,
      input.surfaceId,
      input.jobId,
    );

  const next = getDb()
    .prepare("SELECT * FROM agent_surface_jobs WHERE surface_id = ? AND job_id = ?")
    .get(input.surfaceId, input.jobId) as AgentSurfaceJobRow | undefined;
  if (!next) throw new Error(`Surface job update failed: ${input.surfaceId}/${input.jobId}`);
  return toJobRecord(next);
}

export function summarizeSurfaceJobRecords(
  jobs: SurfaceJobRecord[],
  budget?: AgentlasSurfaceBudget,
): SurfaceJobCostSummary {
  const currency =
    normalizeCurrency(budget?.currency) ??
    normalizeCurrency(jobs.find((job) => job.currency)?.currency) ??
    "USD";
  // Only work that can still spend counts toward the estimate. A finished, failed or expired job
  // kept its $1 template estimate forever and held every guarded action on its surface at the
  // approval threshold (3 surfaces on the owner's store, queued since 2026-06-30).
  const costEstimate = round2(
    jobs.filter((job) => SURFACE_JOB_LIVE_STATUSES.has(job.status))
      .reduce((sum, job) => sum + (typeof job.costEstimate === "number" ? job.costEstimate : 0), 0),
  );
  const costSpent = round2(
    jobs.reduce((sum, job) => sum + (typeof job.costSpent === "number" ? job.costSpent : 0), 0),
  );
  const budgetLimit = typeof budget?.limit === "number" ? budget.limit : undefined;
  const approvalThreshold =
    typeof budget?.approvalThreshold === "number" ? budget.approvalThreshold : undefined;
  const projected = costSpent + costEstimate;

  return {
    currency,
    jobCount: jobs.length,
    queuedCount: countByStatus(jobs, "queued"),
    runningCount: countByStatus(jobs, "running"),
    pausedCount: countByStatus(jobs, "paused"),
    succeededCount: countByStatus(jobs, "succeeded"),
    failedCount: jobs.filter((job) => job.status === "failed" || job.status === "cancelled").length,
    resumableCount: jobs.filter((job) => job.resumable).length,
    costEstimate,
    costSpent,
    ...(budgetLimit !== undefined ? { budgetLimit } : {}),
    ...(approvalThreshold !== undefined ? { approvalThreshold } : {}),
    overLimit: budgetLimit !== undefined ? projected > budgetLimit : false,
    needsApproval: approvalThreshold !== undefined ? projected >= approvalThreshold : false,
  };
}

const SURFACE_JOB_LIVE_STATUSES = new Set(["queued", "running", "paused"]);
/** Nothing in this app executes surface jobs; a live one untouched this long never will. */
const SURFACE_JOB_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;
export const SURFACE_JOB_EXPIRED_EVENT = "job-expired";

/**
 * Startup: close surface jobs that no executor will ever pick up. The row is kept (status
 * 'cancelled', note in its manifest copy) and each close leaves an agent_surface_events row with the
 * previous status, so it can be read back and reopened with updateSurfaceJob. Returns closed row ids.
 */
export function expireOrphanedSurfaceJobs(now = new Date()): string[] {
  const db = getDb();
  const cutoff = new Date(now.getTime() - SURFACE_JOB_EXPIRE_AFTER_MS).toISOString();
  const stamp = now.toISOString();
  const rows = db.prepare(
    `SELECT * FROM agent_surface_jobs WHERE status IN ('queued','running','paused') AND updated_at < ?`,
  ).all(cutoff) as AgentSurfaceJobRow[];
  const closed: string[] = [];
  const tx = db.transaction(() => {
    for (const row of rows) {
      const manifestJob = decodeJob(row.manifest_job_json, { id: row.job_id, label: row.label, status: row.status });
      manifestJob.status = "cancelled";
      manifestJob.note = "Expired: no executor picked this job up.";
      const changed = db.prepare(
        `UPDATE agent_surface_jobs SET status = 'cancelled', manifest_job_json = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
      ).run(encodeJson(manifestJob), stamp, row.id, row.status);
      if (changed.changes !== 1) continue;
      db.prepare(
        `INSERT INTO agent_surface_events (id, chat_id, project_id, agent_id, surface_id, actor, event_type,
           path, value_json, previous_value_json, label, created_at)
         SELECT ?, ?, ?, ?, ?, 'host', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_surfaces WHERE id = ?)`,
      ).run(randomUUID(), row.chat_id, row.project_id, row.agent_id, row.surface_id, SURFACE_JOB_EXPIRED_EVENT,
        `/jobs/${row.job_id}`, encodeJson({ status: "cancelled", reason: "no_executor" }),
        encodeJson({ status: row.status, updatedAt: row.updated_at }), row.label, stamp, row.surface_id);
      closed.push(row.id);
    }
  });
  tx();
  return closed;
}

function toJobRecord(row: AgentSurfaceJobRow): SurfaceJobRecord {
  const fallbackJob: AgentlasSurfaceJob = {
    id: row.job_id,
    label: row.label,
    status: row.status,
  };
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    jobId: row.job_id,
    label: row.label,
    status: row.status,
    costEstimate: row.cost_estimate,
    costSpent: row.cost_spent,
    currency: row.currency,
    resumable: row.resumable === 1,
    manifestJob: decodeJob(row.manifest_job_json, fallbackJob),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function countByStatus(jobs: SurfaceJobRecord[], status: string): number {
  return jobs.filter((job) => job.status === status).length;
}

function rowId(surfaceId: string, jobId: string): string {
  return `${surfaceId}:${jobId}`;
}

function normalizeCurrency(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function encodeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) return "null";
  return serialized;
}

function decodeJob(raw: string, fallback: AgentlasSurfaceJob): AgentlasSurfaceJob {
  try {
    return JSON.parse(raw) as AgentlasSurfaceJob;
  } catch {
    return fallback;
  }
}
