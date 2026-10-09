import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AliveAgent } from "./contracts";
import type { AliveResumeBarrier } from "../../shared/alive";

export function aliveWakeRequiresOwnerResume(code: unknown): code is string {
  return code === "alive-host-lost" || code === "runtime_turn_unsettled"
    || code === "serving_reconciliation_required" || code === "automation_no_progress_loop";
}

/** Causal order belongs to the immutable ledger, never receipt timestamps. */
export function readAliveResumeBarrier(db: Database.Database, agent: AliveAgent): AliveResumeBarrier | null {
  const row = db.prepare(`SELECT w.wake_id,w.receipt_json,e.sequence FROM alive_wakes w
    JOIN alive_events e ON e.agent_id=w.agent_id AND e.kind='wake.settled'
      AND json_extract(e.payload_json,'$.wakeId')=w.wake_id
    WHERE w.agent_id=? ORDER BY e.sequence DESC LIMIT 1`).get(agent.agentId) as
    {wake_id:string;receipt_json:string|null;sequence:number}|undefined;
  if (!row) return null;
  let receipt: {runId?:unknown;status?:unknown;errorCode?:unknown};
  try { receipt = JSON.parse(row.receipt_json ?? "null"); } catch { return null; }
  if (!receipt || receipt.runId !== row.wake_id || !["completed","failed","cancelled","interrupted"].includes(String(receipt.status))
    || !aliveWakeRequiresOwnerResume(receipt.errorCode)) return null;
  const attachments = db.prepare("SELECT attachment_id,domain,scope_json,status FROM alive_attachments WHERE agent_id=? ORDER BY attachment_id").all(agent.agentId);
  const receiptDigest = createHash("sha256").update(JSON.stringify({ receipt: row.receipt_json,
    purpose:agent.purpose,status:agent.status,controlEpoch:agent.controlEpoch,budget:agent.budget,
    runtimeBinding:agent.runtimeBinding,attachments })).digest("hex");
  const latest = db.prepare("SELECT MAX(sequence) AS sequence FROM alive_events WHERE agent_id=?").get(agent.agentId) as {sequence:number};
  return {agentId:agent.agentId,agentVersion:agent.version,controlEpoch:agent.controlEpoch,
    wakeId:row.wake_id,settledSequence:row.sequence,latestSequence:latest.sequence,receiptDigest,errorCode:receipt.errorCode};
}

/** Waiting changes neither effects nor consent: account for each version change with its actual event. */
export function aliveResumeMatches(db: Database.Database, current: AliveResumeBarrier, expected: AliveResumeBarrier,
  afterSequence = expected.latestSequence, extraVersions = 0): boolean {
  if (current.agentId !== expected.agentId || current.controlEpoch !== expected.controlEpoch
    || current.wakeId !== expected.wakeId || current.settledSequence !== expected.settledSequence
    || current.receiptDigest !== expected.receiptDigest || current.errorCode !== expected.errorCode
    || current.latestSequence < afterSequence) return false;
  const changes = db.prepare("SELECT kind FROM alive_events WHERE agent_id=? AND sequence>? ORDER BY sequence").all(current.agentId,afterSequence) as {kind:string}[];
  return changes.every((event) => event.kind === "agent.waiting")
    && current.agentVersion === expected.agentVersion + extraVersions + changes.length;
}

export interface AliveResumeAuthorization {
  intentId:string; sequence:number; observed:AliveResumeBarrier; expected:AliveResumeBarrier; consumedWakeId:string|null;
}
export function aliveResumeAuthorized(db: Database.Database, agent: AliveAgent, barrier: AliveResumeBarrier): boolean {
  const auth = agent.state.ownerResume as AliveResumeAuthorization|undefined;
  if (!auth || auth.consumedWakeId !== null || !Number.isSafeInteger(auth.sequence)) return false;
  const event = db.prepare("SELECT payload_json FROM alive_events WHERE agent_id=? AND sequence=? AND kind='owner.resume-uncertain'").get(agent.agentId,auth.sequence) as {payload_json:string}|undefined;
  if (!event) return false;
  let payload: unknown; try { payload = JSON.parse(event.payload_json); } catch { return false; }
  return JSON.stringify(payload) === JSON.stringify({intentId:auth.intentId,observed:auth.observed,expected:auth.expected})
    && aliveResumeMatches(db,barrier,auth.observed,auth.sequence,1);
}
