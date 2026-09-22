import { createHash } from "node:crypto";
import type { McpInvocationRequest, RuntimeSelection } from "../../shared/types";
import type { OnePreflightSteerInput, OnePreflightSteerLookupInput, OnePreflightSteerReceipt, OnePreflightSubmissionInput, OnePreflightSubmissionReceipt } from "../../shared/one-preflight-steers";
import { getChat } from "./chats";
import { getDb } from "./db";
import { getInvocationAdmission } from "./invocation-admissions";

type SubmissionRow = {
  submission_id: string; chat_id: string; prompt_digest: string; runtime_digest: string;
  runtime_selection_json: string | null; owner_process_epoch: string;
  state: OnePreflightSubmissionReceipt["state"]; parent_run_id: string | null;
  steer_template_json: string | null; created_at: string; updated_at: string;
};
type SteerRow = {
  steer_id: string; submission_id: string; chat_id: string; prompt_text: string;
  prompt_digest: string; status: OnePreflightSteerReceipt["status"];
  parent_run_id: string | null; created_at: string; updated_at: string;
};
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
function validId(value: string, name: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error("one_preflight_invalid_" + name);
}
function validPrompt(value: string, maxBytes: number): void {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("one_preflight_invalid_prompt");
  }
}
export function canonicalOnePreflightRuntime(selection: RuntimeSelection | null | undefined): string {
  if (!selection) return "null";
  if (typeof selection.kind !== "string" || !selection.kind || selection.kind.length > 64) {
    throw new Error("one_preflight_invalid_runtime");
  }
  const text = (value: unknown): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 512) throw new Error("one_preflight_invalid_runtime");
    return value;
  };
  return JSON.stringify({
    kind: selection.kind, backend: text(selection.backend), source: text(selection.source),
    acpAgentId: text(selection.acpAgentId), model: text(selection.model), effort: text(selection.effort),
    longContext: selection.longContext === true, role: text(selection.role) ?? "orchestrator",
    inherit: selection.inherit === true,
  });
}
function liveRuntimeJson(chatId: string): string {
  const chat = getChat(chatId);
  if (!chat || chat.archivedAt) throw new Error("one_preflight_chat_unavailable");
  return canonicalOnePreflightRuntime(chat.runtimeSelection);
}
function submissionRow(id: string): SubmissionRow | undefined {
  return getDb().prepare("SELECT * FROM one_preflight_submissions WHERE submission_id = ?")
    .get(id) as SubmissionRow | undefined;
}
function steerRow(id: string): SteerRow | undefined {
  return getDb().prepare("SELECT * FROM one_preflight_steers WHERE steer_id = ?")
    .get(id) as SteerRow | undefined;
}
const submissionReceipt = (row: SubmissionRow): OnePreflightSubmissionReceipt => ({
  submissionId: row.submission_id, chatId: row.chat_id, state: row.state,
  parentRunId: row.parent_run_id, createdAt: row.created_at,
});
const steerReceipt = (row: SteerRow): OnePreflightSteerReceipt => ({
  steerId: row.steer_id, submissionId: row.submission_id, chatId: row.chat_id,
  userPrompt: row.prompt_text, status: row.status, parentRunId: row.parent_run_id,
  createdAt: row.created_at,
});

/** A Main-issued receipt is required before the renderer clears a queued direction. */
export function beginOnePreflightSubmission(
  input: OnePreflightSubmissionInput, ownerProcessEpoch: string,
): OnePreflightSubmissionReceipt {
  validId(input.submissionId, "submission_id");
  validId(input.chatId, "chat_id");
  validId(ownerProcessEpoch, "owner_epoch");
  validPrompt(input.userPrompt, 200_000);
  const runtimeJson = canonicalOnePreflightRuntime(input.runtimeSelection);
  const promptHash = hash(input.userPrompt);
  const runtimeHash = hash(runtimeJson);
  const now = new Date().toISOString();
  return getDb().transaction(() => {
    const old = submissionRow(input.submissionId);
    if (old) {
      if (old.chat_id !== input.chatId || old.prompt_digest !== promptHash
        || old.runtime_digest !== runtimeHash || old.owner_process_epoch !== ownerProcessEpoch) {
        throw new Error("one_preflight_submission_identity_conflict");
      }
      return submissionReceipt(old);
    }
    if (liveRuntimeJson(input.chatId) !== runtimeJson) throw new Error("one_preflight_runtime_changed");
    const open = getDb().prepare(
      "SELECT submission_id FROM one_preflight_submissions WHERE chat_id = ? AND state = 'open' LIMIT 1",
    ).get(input.chatId);
    if (open) throw new Error("one_preflight_chat_pending");
    getDb().prepare("INSERT INTO one_preflight_submissions " +
      "(submission_id,chat_id,prompt_digest,runtime_digest,runtime_selection_json,owner_process_epoch," +
      "state,created_at,updated_at) VALUES (?,?,?,?,?,?,'open',?,?)")
      .run(input.submissionId, input.chatId, promptHash, runtimeHash,
        runtimeJson === "null" ? null : runtimeJson, ownerProcessEpoch, now, now);
    return submissionReceipt(submissionRow(input.submissionId)!);
  }).immediate();
}

export function enqueueOnePreflightSteer(input: OnePreflightSteerInput): OnePreflightSteerReceipt {
  validId(input.steerId, "steer_id");
  validId(input.submissionId, "submission_id");
  validId(input.chatId, "chat_id");
  validPrompt(input.userPrompt, 32_000);
  const promptHash = hash(input.userPrompt);
  const now = new Date().toISOString();
  return getDb().transaction(() => {
    const old = steerRow(input.steerId);
    if (old) {
      if (old.submission_id !== input.submissionId || old.chat_id !== input.chatId
        || old.prompt_digest !== promptHash || old.prompt_text !== input.userPrompt) {
        throw new Error("one_preflight_steer_identity_conflict");
      }
      return steerReceipt(old);
    }
    const submission = submissionRow(input.submissionId);
    if (!submission || submission.chat_id !== input.chatId
      || !["open", "bound"].includes(submission.state)) throw new Error("one_preflight_submission_not_receiving");
    if (liveRuntimeJson(input.chatId) !== (submission.runtime_selection_json ?? "null")) {
      throw new Error("one_preflight_runtime_changed");
    }
    getDb().prepare("INSERT INTO one_preflight_steers " +
      "(steer_id,submission_id,chat_id,prompt_text,prompt_digest,status,created_at,updated_at) " +
      "VALUES (?,?,?,?,?,'queued',?,?)")
      .run(input.steerId, input.submissionId, input.chatId, input.userPrompt, promptHash, now, now);
    return steerReceipt(steerRow(input.steerId)!);
  }).immediate();
}

export function onePreflightSteerTemplate(request: McpInvocationRequest): McpInvocationRequest {
  return {
    chatId: request.chatId, userPrompt: "", taskIntent: request.taskIntent, oneMode: true,
    locale: request.locale, onePermissionMode: request.onePermissionMode, permissions: request.permissions,
    ...(request.runtimeSelection ? { runtimeSelection: request.runtimeSelection } : {}),
    sessionRouting: false,
  };
}

export function assertOnePreflightSubmissionReady(
  submissionId: string, request: McpInvocationRequest, ownerProcessEpoch: string,
): void {
  validId(submissionId, "submission_id");
  const row = submissionRow(submissionId);
  if (!row || row.state !== "open" || row.chat_id !== request.chatId
    || row.owner_process_epoch !== ownerProcessEpoch
    || row.prompt_digest !== hash(request.userPrompt)
    || row.runtime_digest !== hash(canonicalOnePreflightRuntime(request.runtimeSelection))
    || liveRuntimeJson(row.chat_id) !== (row.runtime_selection_json ?? "null")) {
    throw new Error("one_preflight_submission_changed");
  }
}

/** Record the exact pending parent before start() can emit any external effect. */
export function reserveOnePreflightParent(
  submissionId: string, parentRunId: string, request: McpInvocationRequest, ownerProcessEpoch: string,
): OnePreflightSubmissionReceipt {
  validId(submissionId, "submission_id");
  validId(parentRunId, "parent_run_id");
  return getDb().transaction(() => {
    const row = submissionRow(submissionId);
    if (!row || row.state !== "open" || row.chat_id !== request.chatId
      || row.owner_process_epoch !== ownerProcessEpoch
      || row.prompt_digest !== hash(request.userPrompt)
      || row.runtime_digest !== hash(canonicalOnePreflightRuntime(request.runtimeSelection))
      || liveRuntimeJson(row.chat_id) !== (row.runtime_selection_json ?? "null")) {
      throw new Error("one_preflight_submission_changed");
    }
    const admission = getInvocationAdmission(parentRunId);
    if (admission?.status !== "pending" || admission.chatId !== row.chat_id
      || admission.ownerProcessEpoch !== ownerProcessEpoch) {
      throw new Error("one_preflight_parent_not_pending");
    }
    getDb().prepare("UPDATE one_preflight_submissions " +
      "SET state = 'reserved', parent_run_id = ?, steer_template_json = ?, updated_at = ? " +
      "WHERE submission_id = ? AND state = 'open'")
      .run(parentRunId, JSON.stringify(onePreflightSteerTemplate(request)),
        new Date().toISOString(), submissionId);
    return submissionReceipt(submissionRow(submissionId)!);
  }).immediate();
}

/** The parent may be bound only after admitted + invoke_started commit. */
export function bindOnePreflightSubmission(
  submissionId: string, parentRunId: string, request: McpInvocationRequest, ownerProcessEpoch: string,
): OnePreflightSubmissionReceipt {
  validId(submissionId, "submission_id");
  validId(parentRunId, "parent_run_id");
  const now = new Date().toISOString();
  return getDb().transaction(() => {
    const row = submissionRow(submissionId);
    if (!row || row.chat_id !== request.chatId || row.owner_process_epoch !== ownerProcessEpoch) {
      throw new Error("one_preflight_submission_identity_conflict");
    }
    const template = JSON.stringify(onePreflightSteerTemplate(request));
    if (row.state === "bound") {
      if (row.parent_run_id !== parentRunId || row.steer_template_json !== template) {
        throw new Error("one_preflight_parent_identity_conflict");
      }
      return submissionReceipt(row);
    }
    if (row.state !== "reserved" || row.parent_run_id !== parentRunId
      || row.steer_template_json !== template
      || row.prompt_digest !== hash(request.userPrompt)
      || row.runtime_digest !== hash(canonicalOnePreflightRuntime(request.runtimeSelection))
      || liveRuntimeJson(row.chat_id) !== (row.runtime_selection_json ?? "null")) {
      throw new Error("one_preflight_submission_changed");
    }
    const admission = getInvocationAdmission(parentRunId);
    const started = getDb().prepare(
      "SELECT chat_id FROM run_events WHERE run_id = ? AND kind = 'invoke_started' LIMIT 1",
    ).get(parentRunId) as { chat_id: string | null } | undefined;
    if (admission?.status !== "admitted" || admission.chatId !== row.chat_id
      || started?.chat_id !== row.chat_id) throw new Error("one_preflight_parent_not_admitted");
    const changed = getDb().prepare("UPDATE one_preflight_submissions " +
      "SET state = 'bound', updated_at = ? " +
      "WHERE submission_id = ? AND state = 'reserved'").run(now, submissionId);
    if (changed.changes !== 1) throw new Error("one_preflight_parent_cas_lost");
    return submissionReceipt(submissionRow(submissionId)!);
  }).immediate();
}

export function listOnePreflightSteers(chatId: string): OnePreflightSteerReceipt[] {
  validId(chatId, "chat_id");
  const rows = getDb().prepare("SELECT * FROM one_preflight_steers WHERE chat_id = ? " +
    "ORDER BY created_at DESC, steer_id DESC LIMIT 100").all(chatId) as SteerRow[];
  return rows.reverse().map(steerReceipt);
}

/** An absent row is unresolved, not evidence that an in-flight IPC was never accepted. */
export function getOnePreflightSteerReceipt(input: OnePreflightSteerLookupInput): OnePreflightSteerReceipt | null {
  validId(input.steerId, "steer_id");
  validId(input.submissionId, "submission_id");
  validId(input.chatId, "chat_id");
  const row = steerRow(input.steerId);
  if (!row) return null;
  if (row.submission_id !== input.submissionId || row.chat_id !== input.chatId) {
    throw new Error("one_preflight_steer_identity_conflict");
  }
  return steerReceipt(row);
}

export function listDispatchableOnePreflightSteers(): OnePreflightSteerReceipt[] {
  const rows = getDb().prepare("SELECT steer.* FROM one_preflight_steers steer " +
    "JOIN one_preflight_submissions submission ON submission.submission_id = steer.submission_id " +
    "WHERE steer.status = 'queued' AND submission.state = 'bound' " +
    "ORDER BY steer.created_at, steer.steer_id").all() as SteerRow[];
  return rows.map(steerReceipt);
}

export function getOnePreflightSubmission(submissionId: string): SubmissionRow | null {
  validId(submissionId, "submission_id");
  return submissionRow(submissionId) ?? null;
}

export function claimOnePreflightSteer(steerId: string, parentRunId: string): boolean {
  validId(steerId, "steer_id");
  validId(parentRunId, "parent_run_id");
  return getDb().transaction(() => {
    const steer = steerRow(steerId);
    if (!steer || steer.status !== "queued") return false;
    const submission = submissionRow(steer.submission_id);
    if (!submission || submission.state !== "bound" || submission.parent_run_id !== parentRunId
      || submission.chat_id !== steer.chat_id
      || liveRuntimeJson(steer.chat_id) !== (submission.runtime_selection_json ?? "null")
      || getInvocationAdmission(parentRunId)?.status !== "admitted") return false;
    return getDb().prepare("UPDATE one_preflight_steers " +
      "SET status = 'claimed', parent_run_id = ?, updated_at = ? " +
      "WHERE steer_id = ? AND status = 'queued'")
      .run(parentRunId, new Date().toISOString(), steerId).changes === 1;
  }).immediate();
}

export function markOnePreflightSteerAttached(steerId: string, parentRunId: string): boolean {
  validId(steerId, "steer_id");
  validId(parentRunId, "parent_run_id");
  return getDb().prepare("UPDATE one_preflight_steers SET status = 'attached', updated_at = ? " +
    "WHERE steer_id = ? AND parent_run_id = ? AND status = 'claimed'")
    .run(new Date().toISOString(), steerId, parentRunId).changes === 1;
}

export function holdOnePreflightSteer(steerId: string): boolean {
  validId(steerId, "steer_id");
  return getDb().prepare("UPDATE one_preflight_steers SET status = 'held', updated_at = ? " +
    "WHERE steer_id = ? AND status IN ('queued','claimed')")
    .run(new Date().toISOString(), steerId).changes === 1;
}

/** A failed or abandoned preparation remains reviewable, never auto-replayed. */
export function holdOnePreflightSubmission(submissionId: string): OnePreflightSubmissionReceipt | null {
  validId(submissionId, "submission_id");
  return getDb().transaction(() => {
    const row = submissionRow(submissionId);
    if (!row) return null;
    if (row.state !== "open" && row.state !== "reserved") return submissionReceipt(row);
    // A reserved parent may already have crossed the start boundary. A local
    // catch is not a no-start proof; only rejected admission permits holding.
    if (row.state === "reserved" && getInvocationAdmission(row.parent_run_id!)?.status !== "rejected") {
      return submissionReceipt(row);
    }
    const now = new Date().toISOString();
    getDb().prepare("UPDATE one_preflight_steers SET status = 'held', updated_at = ? " +
      "WHERE submission_id = ? AND status = 'queued'").run(now, submissionId);
    getDb().prepare("UPDATE one_preflight_submissions SET state = 'held', updated_at = ? " +
      "WHERE submission_id = ? AND state IN ('open','reserved')").run(now, submissionId);
    return submissionReceipt(submissionRow(submissionId)!);
  }).immediate();
}

/** A different Main epoch can never finish an unbound preflight. */
export function recoverOnePreflightSubmissionParents(currentOwnerEpoch: string): { bound: number; held: number } {
  validId(currentOwnerEpoch, "owner_epoch");
  return getDb().transaction(() => {
    const now = new Date().toISOString();
    const rows = getDb().prepare("SELECT * FROM one_preflight_submissions " +
      "WHERE state IN ('open','reserved') AND owner_process_epoch != ?")
      .all(currentOwnerEpoch) as SubmissionRow[];
    let bound = 0;
    let held = 0;
    for (const row of rows) {
      if (row.state === "reserved" && row.parent_run_id && row.steer_template_json) {
        const admission = getInvocationAdmission(row.parent_run_id);
        const started = getDb().prepare(
          "SELECT chat_id FROM run_events WHERE run_id = ? AND kind = 'invoke_started' LIMIT 1",
        ).get(row.parent_run_id) as { chat_id: string | null } | undefined;
        let runtimeUnchanged = false;
        try { runtimeUnchanged = liveRuntimeJson(row.chat_id) === (row.runtime_selection_json ?? "null"); }
        catch { /* An unavailable chat is not a dispatch grant. */ }
        if (admission?.status === "admitted" && admission.chatId === row.chat_id
          && admission.ownerProcessEpoch === row.owner_process_epoch
          && started?.chat_id === row.chat_id && runtimeUnchanged) {
          getDb().prepare("UPDATE one_preflight_submissions SET state = 'bound', updated_at = ? " +
            "WHERE submission_id = ? AND state = 'reserved'").run(now, row.submission_id);
          bound += 1;
          continue;
        }
      }
      getDb().prepare("UPDATE one_preflight_steers SET status = 'held', updated_at = ? " +
        "WHERE submission_id = ? AND status = 'queued'").run(now, row.submission_id);
      getDb().prepare("UPDATE one_preflight_submissions SET state = 'held', updated_at = ? " +
        "WHERE submission_id = ? AND state IN ('open','reserved')").run(now, row.submission_id);
      held += 1;
    }
    return { bound, held };
  }).immediate();
}

export function reconcileClaimedOnePreflightSteers(
  durableSteerExists: (receipt: OnePreflightSteerReceipt) => boolean,
): { attached: number; held: number } {
  const rows = getDb().prepare("SELECT * FROM one_preflight_steers WHERE status = 'claimed'").all() as SteerRow[];
  let attached = 0;
  let held = 0;
  for (const row of rows) {
    if (row.parent_run_id && durableSteerExists(steerReceipt(row))) {
      if (markOnePreflightSteerAttached(row.steer_id, row.parent_run_id)) attached += 1;
    } else if (holdOnePreflightSteer(row.steer_id)) held += 1;
  }
  return { attached, held };
}
