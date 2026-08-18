import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import { runHephaestus } from "../hephaestus/engine";
import type { WorkforceSelectionResult } from "./workforce-orchestrator";

type JsonRecord = Record<string, unknown>;

export interface DesktopWorkforceRuntimePlan {
  revision: number;
  status: "ready" | "lease-refresh-required";
  rosterKeys: string[];
  agentReleaseIds: string[];
  leaseExpiresAt: string | null;
  preparation?: {
    schemaVersion: "agentlas.workforce-desktop-continuation.v1";
    status: "prepared";
    specs: unknown[];
    workOrder: JsonRecord;
    candidateSet: JsonRecord;
    selection: JsonRecord;
    validation: JsonRecord;
    receipt: JsonRecord;
    prepareCheckpointReceipt: JsonRecord;
    leaseExpiresAt: string | null;
    executionPlan: JsonRecord;
  };
}

export interface DesktopWorkforceRuntimeContext {
  schemaVersion: "agentlas.workforce-goal-runtime-context.v1";
  status: "not-bound" | "ready" | "refresh-required";
  goals: Array<{
    goalId: string;
    bindingId: string;
    status: "active";
    executionAllowed: boolean;
    plans: DesktopWorkforceRuntimePlan[];
  }>;
}

interface AccountContext {
  schemaVersion: "agentlas.account-context.v1";
  accountSubject: string;
  leaseWindowHours: 24;
  billingAuthority: "agentlas-web";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function desktopWorkforceGoalId(taskId: string): string {
  const value = String(taskId || "").trim();
  if (!value) throw new Error("workforce_goal_task_id_missing");
  return `goal:desktop:${sha256(value).slice(0, 40)}`;
}

/**
 * 이 실행이 속한 편성 목표의 id.
 *
 * 예전에는 대화(또는 그 대화의 Task) 하나가 곧 목표였다. 그래서 같은 프로젝트에서
 * 새 대화를 열 때마다 편성이 처음부터였고, "프로젝트에 팀이 붙어 있다"가 성립하지
 * 않았다. 프로젝트가 있으면 프로젝트가 목표의 단위다 — 대화는 그 안의 한 세션이다.
 *
 * 사용자가 명시적으로 묶어 둔 goalId가 있으면 그것이 언제나 우선한다.
 */
export function resolveDesktopWorkforceGoalId(input: {
  chatGoalId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  chatId: string;
}): string {
  const explicit = String(input.chatGoalId ?? "").trim();
  if (explicit) return explicit;
  const projectId = String(input.projectId ?? "").trim();
  if (projectId) return desktopWorkforceGoalId(`project:${projectId}`);
  return desktopWorkforceGoalId(String(input.taskId ?? "").trim() || input.chatId);
}

function requireAccountContext(value: unknown): AccountContext {
  const row = value && typeof value === "object" ? value as Partial<AccountContext> : {};
  if (
    row.schemaVersion !== "agentlas.account-context.v1"
    || !/^sha256:[a-f0-9]{64}$/.test(String(row.accountSubject || ""))
    || row.leaseWindowHours !== 24
    || row.billingAuthority !== "agentlas-web"
  ) {
    throw new Error("workforce_account_context_invalid");
  }
  return row as AccountContext;
}

async function accountContext(): Promise<AccountContext> {
  const cookie = getSessionCookieHeader();
  if (!cookie) throw new Error("workforce_account_sign_in_required");
  const response = await fetch(`${webBaseUrl()}/api/mcp/v1/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      method: "agentlas.account_context",
      params: {
        name: "agentlas.account_context",
        arguments: {},
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`workforce_account_context_http_${response.status}`);
  const payload = await response.json() as JsonRecord;
  if (payload.error) throw new Error("workforce_account_context_rejected");
  return requireAccountContext(payload.result);
}

async function coreJson<T>(args: string[], projectDir: string): Promise<T> {
  const result = await runHephaestus<T>("agentlas_cloud", args, {
    cwd: projectDir,
    timeoutMs: 30_000,
  });
  if (!result.ok || !result.json) {
    throw new Error(result.error || result.stderr || "workforce_goal_core_failed");
  }
  return result.json;
}

async function accountArgs(): Promise<string[]> {
  const account = await accountContext();
  return [
    "--account-subject", account.accountSubject,
    "--hub-base-url", webBaseUrl(),
  ];
}

export async function loadDesktopWorkforceGoal(
  projectDir: string,
  goalId?: string | null,
): Promise<DesktopWorkforceRuntimeContext> {
  const args = ["workforce", "goal-runtime", "--project", path.resolve(projectDir), ...await accountArgs()];
  if (goalId) args.push("--goal-id", goalId);
  return coreJson<DesktopWorkforceRuntimeContext>(args, projectDir);
}

function executionPlan(workforce: WorkforceSelectionResult): JsonRecord {
  return {
    schemaVersion: "agentlas.workforce-desktop-runtime-plan.v1",
    status: "prepared",
    preparationReceiptId: workforce.receipt.preparationReceiptId,
    executionRoster: workforce.specs.map((spec, index) => ({
      slotId: workforce.receipt.preparedReleases[index]?.slotId,
      agentDefinitionId: spec.agentDefinitionId,
      agentReleaseId: spec.agentReleaseId,
      releaseVersion: spec.releaseVersion,
      packageHash: spec.packageHash,
      contentDigest: spec.contentDigest,
      bundleDigest: spec.bundleDigest,
      entityKind: spec.entityKind,
    })),
  };
}

export async function bindDesktopWorkforceGoal(input: {
  goalId: string;
  projectDir: string;
  workforce: WorkforceSelectionResult;
}): Promise<JsonRecord> {
  const plan = executionPlan(input.workforce);
  const continuation = {
    schemaVersion: "agentlas.workforce-desktop-continuation.v1",
    status: "prepared",
    runtimeSourcePins: input.workforce.receipt.preparedReleases.map((row) => ({
      slotId: row.slotId,
      agentReleaseId: row.agentReleaseId,
      source: "hub",
    })),
    specs: input.workforce.specs,
    workOrder: input.workforce.workOrder,
    candidateSet: input.workforce.candidateSet,
    selection: input.workforce.selection,
    validation: input.workforce.validation,
    receipt: input.workforce.receipt,
    prepareCheckpointReceipt: input.workforce.prepareCheckpointReceipt,
    leaseExpiresAt: input.workforce.leaseExpiresAt,
    executionPlan: plan,
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-desktop-workforce-goal-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "continuation.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify(continuation)}\n`, { mode: 0o600, flag: "wx" });
    return await coreJson<JsonRecord>([
      "workforce", "goal-bind", input.goalId, file,
      "--project", path.resolve(input.projectDir),
      ...await accountArgs(),
      "--label", "automatic Desktop canonical Task continuity",
    ], input.projectDir);
  } finally {
    try { fs.unlinkSync(file); } catch { /* OS temp cleanup is the fallback */ }
    try { fs.rmdirSync(directory); } catch { /* OS temp cleanup is the fallback */ }
  }
}

export async function recordDesktopWorkforceTurn(input: {
  projectDir: string;
  goalId: string;
  decision: "reuse" | "recruit" | "local-only" | "blocked" | "standby";
  rosterKeys?: string[];
  gapCodes?: string[];
  turnId?: string;
}): Promise<JsonRecord> {
  const args = [
    "workforce", "goal-turn", input.goalId,
    input.turnId || `turn:desktop:${randomUUID()}`,
    input.decision,
    "--project", path.resolve(input.projectDir),
    "--host-runtime", "runtime:agentlas-desktop",
    ...await accountArgs(),
  ];
  for (const key of input.rosterKeys || []) args.push("--use-roster", key);
  for (const code of input.gapCodes || []) args.push("--gap", code);
  return coreJson<JsonRecord>(args, input.projectDir);
}

export async function completeDesktopWorkforceGoal(input: {
  projectDir: string;
  goalId: string;
  status?: "completed" | "cancelled";
}): Promise<JsonRecord> {
  return coreJson<JsonRecord>([
    "workforce", "goal-complete", input.goalId,
    "--project", path.resolve(input.projectDir),
    "--status", input.status || "completed",
    "--reason", "explicit-desktop-task-terminal",
    "--explicit",
    ...await accountArgs(),
  ], input.projectDir);
}
