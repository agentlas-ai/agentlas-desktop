// Result → repair loop for Toolchains (docs/2026-10-04-owner-first-goal-scheduling/PLAN.md §0, owner 2026-10-04:
// "AI가 자동화 결과 받고 직접 수정").
//
// Layer rule: a Toolchain is a leaf tool. Whoever calls it never changes it — a Work task, or another of One's
// conversations, reports "this run was wrong for this input" and the event travels up to the conversation that
// made it. That conversation (or the owner) decides: keep it, fix it with one_graph_patch, or ask. A report never
// starts a turn by itself (commands go down, events go up); the maker sees it on its next turn and the owner sees
// it in the room and on the Toolchains screen.
//
// A fix is a new definition: the contract goes stale and the Toolchain leaves search until a fresh-session test
// passes again. Fixes are budgeted (3 per 24 h without the owner speaking in the making conversation) so a repair
// loop cannot become what the minute-by-minute Goal loop was on 2026-10-04.

import { createHash, randomUUID } from "node:crypto";
import { getToolchainAsset } from "./assets";
import { getToolchainCall, listToolchainCalls } from "./calls";
import { TOOLCHAIN_REPORT_POLICY, type ToolchainReport } from "../../shared/toolchain";
import type { Automation } from "../../shared/types";
import { appendChatMessage, getChat } from "../store/chats";
import { getDb } from "../store/db";
import { tryRecordRunEvent } from "../store/run-events";
import { currentUiLocale } from "../ui-locale";
import { mutateToolchainState, readToolchainState } from "./store";

const DAY_MS = 24 * 60 * 60_000;
const REPAIR_BUDGET_EVENT_KIND = "toolchain_repair_budget_reached";

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const clockOf = (iso: string) => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** The live conversation a Toolchain's events travel up to; null for one the owner made in the editor. */
function makingConversation(automation: Automation): string | null {
  const chatId = automation.monitor?.originChatId;
  const chat = chatId ? getChat(chatId) : null;
  return chat && !chat.archivedAt ? chat.id : null;
}

export function openToolchainReports(automationId: string): ToolchainReport[] {
  return (readToolchainState(automationId).reports ?? []).filter((report) => report.state === "open");
}

export type ToolchainReportOutcome =
  | { state: "reported" | "already_reported"; reportId: string; deliveredTo: "making_conversation" | "owner" }
  | { state: "queue_full"; open: number };

/** Record a caller's report and tell the conversation that made the Toolchain (or the owner) once. */
export function reportToolchainProblem(input: { automation: Automation; reporterChatId: string; eventId: string;
  problem: string; expected?: string | null }): ToolchainReportOutcome {
  const { automation } = input;
  const problem = input.problem.trim();
  const expected = input.expected?.trim() || null;
  if (!problem) throw new Error("toolchain_report_problem_required");
  const target = makingConversation(automation);
  const deliveredTo = target ? "making_conversation" as const : "owner" as const;
  let outcome: ToolchainReportOutcome | null = null;
  let created: ToolchainReport | null = null;
  mutateToolchainState(automation.id, (current) => {
    const reports = current.reports ?? [];
    const prior = reports.find((report) => report.reporterChatId === input.reporterChatId && report.eventId === input.eventId);
    if (prior) { outcome = { state: "already_reported", reportId: prior.id, deliveredTo }; return null; }
    const open = reports.filter((report) => report.state === "open").length;
    if (open >= TOOLCHAIN_REPORT_POLICY.maxOpen) { outcome = { state: "queue_full", open }; return null; }
    created = { id: randomUUID(), at: new Date().toISOString(), reporterChatId: input.reporterChatId, eventId: input.eventId,
      problem: clip(problem, 1_000), expected: expected ? clip(expected, 1_000) : null, state: "open" };
    outcome = { state: "reported", reportId: created.id, deliveredTo };
    return { ...current, reports: [...reports, created].slice(-TOOLCHAIN_REPORT_POLICY.keep) };
  });
  const report = created as ToolchainReport | null;
  if (report && target) {
    const name = readToolchainState(automation.id).interface?.name || automation.name;
    const reporter = getChat(input.reporterChatId)?.title?.trim();
    const ko = currentUiLocale() === "ko";
    const from = reporter ? (ko ? `「${clip(reporter, 60)}」에서` : `"${clip(reporter, 60)}"`) : (ko ? "다른 대화에서" : "Another conversation");
    const text = ko
      ? `${from} 툴체인 「${name}」의 결과가 틀렸다고 알려 왔습니다: ${clip(report.problem, 300)}${report.expected ? ` — 기대한 결과: ${clip(report.expected, 200)}` : ""}`
      : `${from} reported a wrong result from the Toolchain "${name}": ${clip(report.problem, 300)}${report.expected ? ` — expected: ${clip(report.expected, 200)}` : ""}`;
    try {
      appendChatMessage(target, "assistant", text, { hostNotice: { purpose: "host-status", runId: `toolchain-report:${report.id}`, status: "needs-owner" } });
    } catch (error) { console.warn("[toolchain-report] notice failed:", error); }
  }
  // Assigned inside the compare-and-set callback above (control flow cannot see that).
  return outcome as unknown as ToolchainReportOutcome;
}

/** The later of: 24 h ago, the owner's last message in the making conversation. */
function repairWindowFloor(chatId: string, now: number): string {
  const day = new Date(now - DAY_MS).toISOString();
  const said = (getDb().prepare("SELECT MAX(created_at) AS at FROM chat_messages WHERE chat_id = ? AND role = 'user'")
    .get(chatId) as { at: string | null } | undefined)?.at ?? null;
  return said && said > day ? said : day;
}

export type ToolchainRepairVerdict = { ok: true } | { ok: false; repairs: number; retryAt: string };

/**
 * May the making conversation change this Toolchain's definition now? Only graphs that are (or were) Toolchains
 * are budgeted; an ordinary graph being authored is not. Reaching the budget is said once in the conversation.
 */
export function toolchainRepairVerdict(automation: Automation, chatId: string, now = Date.now()): ToolchainRepairVerdict {
  const state = readToolchainState(automation.id);
  if (!state.interface) return { ok: true };
  const since = repairWindowFloor(chatId, now);
  const recent = (state.repairs ?? []).filter((repair) => repair.at > since);
  if (recent.length < TOOLCHAIN_REPORT_POLICY.repairBudget) return { ok: true };
  const retryAt = new Date(Date.parse(recent[0].at) + DAY_MS).toISOString();
  const told = getDb().prepare(`SELECT 1 FROM run_events WHERE chat_id = ? AND kind = ? AND ts > ?
    AND json_extract(payload_json, '$.automationId') = ? LIMIT 1`).get(chatId, REPAIR_BUDGET_EVENT_KIND, since, automation.id);
  if (!told) {
    const noticeRunId = `toolchain-repair-budget:${automation.id}:${Date.parse(since)}`;
    tryRecordRunEvent({ runId: noticeRunId, chatId, kind: REPAIR_BUDGET_EVENT_KIND,
      payload: { automationId: automation.id, repairs: recent.length, budget: TOOLCHAIN_REPORT_POLICY.repairBudget, retryAt } });
    const name = state.interface.name || automation.name;
    try {
      appendChatMessage(chatId, "assistant", currentUiLocale() === "ko"
        ? `툴체인 「${name}」을 오늘 ${recent.length}번 고쳤습니다. 다음 수정은 ${clockOf(retryAt)} 이후에 하거나, 이 대화에서 말씀해 주시면 바로 할 수 있습니다.`
        : `The Toolchain "${name}" was changed ${recent.length} times today. The next change waits until ${clockOf(retryAt)}, or send a message here to allow it now.`,
      { hostNotice: { purpose: "host-status", runId: noticeRunId.slice(0, 128), status: "needs-owner" } });
    } catch (error) { console.warn("[toolchain-report] budget notice failed:", error); }
  }
  return { ok: false, repairs: recent.length, retryAt };
}

/** A definition change by the making conversation: counted for the budget, and it answers the open reports. */
export function recordToolchainRepair(automationId: string, chatId: string, now = Date.now()): void {
  if (!readToolchainState(automationId).interface) return;
  const at = new Date(now).toISOString();
  mutateToolchainState(automationId, (current) => ({
    ...current,
    repairs: [...(current.repairs ?? []), { at, chatId }].slice(-TOOLCHAIN_REPORT_POLICY.keep),
    reports: (current.reports ?? []).map((report) => report.state === "open" ? { ...report, state: "repaired" as const, settledAt: at } : report),
  }));
}

/** Independent assets retain the existing report ledger and its limits. Native composition
 * pins distinct current phase admissions; this module never interprets an actor or a hash as a grant. */
export interface NativeToolchainReportRef {
  toolchainId: string; version: number; contentHash: string; callId: string | null;
  callInputHash: string | null; callRunId: string | null; sourceCallerChatId: string | null;
}
export interface NativeToolchainReportRequest {
  action: 'report' | 'notice' | 'read-reports' | 'repair'; ref: NativeToolchainReportRef;
  callerChatId: string; recipientChatId: string; bodyDigest: string;
  replacement?: { version: number; contentHash: string };
  reportId?: string; reportRevision?: string | null;
}
export interface NativeToolchainReportAdmission {
  decision: 'allow' | 'deny' | 'unknown'; revision: string;
  /** Authority-owned exclusion, current through the IMMEDIATE/CAS effect. Revoke acknowledgment
   * waits for this lease's invalidation/exclusion. No notification, TTL or cached decision. */
  current(): boolean;
  release(): void;
}
export interface NativeToolchainReportExclusion {
  current(): boolean;
  /** Selected by the actual registered report/effect owner before admission. */
  reportId: string | null; reportRevision: string | null;
}
export interface NativeToolchainReportEffectResult<T> {
  state: 'committed' | 'denied' | 'unknown'; reason: string; value: T | null;
}
export interface NativeToolchainReportPorts {
  /** Resolves only the original opaque native work scope; never renderer/MCP-authored identity. */
  prepare(request: Readonly<NativeToolchainReportRequest>): Promise<NativeToolchainReportAdmission>;
  /** Calls the existing authority-owned effect domain with its EXACT registered leases.
   * An earlier async allow followed by unrelated SQLite is not an implementation. */
  withCurrentExclusion<T>(requests: readonly Readonly<NativeToolchainReportRequest>[],
    reducer: (scope: Readonly<NativeToolchainReportExclusion>) => T): Promise<NativeToolchainReportEffectResult<T>>;
  ownerConversation(): string | null;
}
let assetReportPorts: NativeToolchainReportPorts | null = null;
export function configureNativeToolchainReportPorts(ports: NativeToolchainReportPorts): void {
  if (assetReportPorts && assetReportPorts !== ports) throw Error('toolchain_report_authority_already_bound');
  assetReportPorts = ports;
}
function reportPorts(): NativeToolchainReportPorts {
  if (!assetReportPorts) throw Error('toolchain_report_current_resource_authority_required');
  return assetReportPorts;
}
function reportBodyDigest(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, child]) => [k, sort(child)])) : v;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
function immutableReportRequest(value: NativeToolchainReportRequest): Readonly<NativeToolchainReportRequest> {
  const copied = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(copied); return copied;
}
function ownedReportCallback(value: unknown, name: 'current' | 'release'): (() => unknown) | null {
  try {
    if (!value || typeof value !== 'object') return null;
    let owner: object | null = value;
    for (let i = 0; owner && i < 4; i++, owner = Object.getPrototypeOf(owner) as object | null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value.bind(value) : null;
    }
  } catch { /* A malformed native reply cannot grant admission. */ }
  return null;
}
/** All required phase leases are obtained before SQL. The synchronous callback remains under
 * every lease until the actual outer transaction has committed or rolled back. */
async function withReportAdmissions<T>(requests: NativeToolchainReportRequest[], effect: (assertCurrent: () => void, revisions: string[], scope: Readonly<NativeToolchainReportExclusion>) => T): Promise<T> {
  const ports = reportPorts(), releases: Array<() => unknown> = [], checks: Array<() => unknown> = [], revisions: string[] = [];
  const assertCurrent = (): void => {
    if (assetReportPorts !== ports) throw Error('toolchain_report_current_resource_authority_required');
    for (const current of checks) if (current() !== true) throw Error('toolchain_report_current_resource_authority_required');
  };
  try {
    for (const request of requests) {
      assertCurrent();
      const issued = await ports.prepare(immutableReportRequest(request));
      const release = ownedReportCallback(issued, 'release'), current = ownedReportCallback(issued, 'current');
      if (release) releases.push(release);
      const decision = issued && Object.getOwnPropertyDescriptor(issued, 'decision')?.value;
      const revision = issued && Object.getOwnPropertyDescriptor(issued, 'revision')?.value;
      if (!release || !current || decision !== 'allow' || typeof revision !== 'string' || !revision)
        throw Error('toolchain_report_current_resource_authority_required');
      checks.push(current); revisions.push(revision); assertCurrent();
    }
    assertCurrent();
    if (typeof ports.withCurrentExclusion !== 'function') throw Error('toolchain_report_owner_effect_domain_required');
    let entered = false, produced = false, value: T | null = null;
    const answer = await ports.withCurrentExclusion(requests.map(immutableReportRequest), scope => {
      if (entered) throw Error('toolchain_report_reducer_repeated');
      entered = true;
      const current = ownedReportCallback(scope, 'current');
      if (!current || current() !== true) throw Error('toolchain_report_owner_effect_domain_required');
      const assertExcluded = (): void => { assertCurrent(); if (current() !== true) throw Error('toolchain_report_owner_effect_domain_required'); };
      assertExcluded();
      const result = effect(assertExcluded, revisions, scope);
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result)
        throw Error('toolchain_report_sync_commit_required');
      assertExcluded(); value = result; produced = true; return result;
    });
    if (!answer || answer.state !== 'committed' || !entered || !produced || answer.value !== value)
      throw Error('toolchain_report_effect_unconfirmed');
    // The real Business facade closes its registered pins after its owner commit.
    // Its adapter revalidates native provenance before returning the settled value;
    // a closed preliminary pin cannot be reused as a new postcommit permission.
    return value as T;
  } finally {
    // Release every reservation even if one authority's terminal release throws.
    let failure: unknown;
    for (const release of releases.reverse()) { try { release(); } catch (error) { failure ??= error; } }
    if (failure) throw Error('toolchain_report_admission_release_unconfirmed');
  }
}
interface AssetReport extends ToolchainReport {
  assetRef: NativeToolchainReportRef; recipientChatId: string; authorityRevision: string;
}
const assetLedger = (id: string): string => `asset:${id}`;
function assetRelease(id: string, version: number, contentHash: string) {
  const asset = getToolchainAsset(id), release = asset?.versions.find(v => v.version === version);
  if (!asset || !release || release.contentHash !== contentHash) throw Error('toolchain_report_version_binding_changed');
  return { asset, release };
}
function reportRecipient(maker: string | null): { chatId: string; deliveredTo: 'making_conversation' | 'owner' } {
  // Provenance chooses the proposed destination only. The independent native notice phase
  // must resolve its canonical same-domain recipient before any content is admitted.
  const original = maker ? getChat(maker) : null;
  if (original && !original.archivedAt) return { chatId: original.id, deliveredTo: 'making_conversation' };
  const ownerId = reportPorts().ownerConversation(), owner = ownerId ? getChat(ownerId) : null;
  if (!owner || owner.archivedAt) throw Error('toolchain_report_owner_audience_required');
  return { chatId: owner.id, deliveredTo: 'owner' };
}
function assetReportNotice(ref: NativeToolchainReportRef, name: string, callerChatId: string, problem: string, expected: string | null): string {
  const title = getChat(callerChatId)?.title?.trim(), ko = currentUiLocale() === 'ko';
  const prefix = title ? (ko ? `「${clip(title, 60)}」에서` : `"${clip(title, 60)}"`) : (ko ? '다른 대화에서' : 'Another conversation');
  const capability = clip(name, 120);
  return ko ? `${prefix} 툴체인 「${capability}」 ${ref.version}의 결과가 틀렸다고 알려 왔습니다: ${clip(problem, 300)}${expected ? ` — 기대한 결과: ${clip(expected, 200)}` : ''}`
    : `${prefix} reported a wrong result from Toolchain "${capability}" version ${ref.version}: ${clip(problem, 300)}${expected ? ` — expected: ${clip(expected, 200)}` : ''}`;
}
export async function reportToolchainAssetProblem(input: { callerChatId: string; callId: string; problem: string; expected?: string | null }): Promise<ToolchainReportOutcome> {
  const call = getToolchainCall(input.callId);
  if (!call || call.schemaVersion !== 'agentlas.toolchain-call.v1' || call.id !== input.callId || call.callerChatId !== input.callerChatId || !Number.isSafeInteger(call.version) || call.version < 1)
    throw Error('toolchain_call_not_in_context');
  const { release } = assetRelease(call.toolchainId, call.version, call.contentHash), target = reportRecipient(release.provenance.creatorChatId);
  const problem = clip(input.problem.trim(), 1000), expected = input.expected?.trim() ? clip(input.expected.trim(), 1000) : null;
  if (!problem) throw Error('toolchain_report_problem_required');
  const ref: NativeToolchainReportRef = { toolchainId: call.toolchainId, version: call.version, contentHash: call.contentHash,
    callId: call.id, callInputHash: call.inputHash, callRunId: call.runId, sourceCallerChatId: call.callerChatId };
  const text = assetReportNotice(ref, release.contract.name, input.callerChatId, problem, expected);
  const report: NativeToolchainReportRequest = { action: 'report', ref, callerChatId: input.callerChatId, recipientChatId: target.chatId,
    bodyDigest: reportBodyDigest({ ref, callerChatId: input.callerChatId, recipientChatId: target.chatId, problem, expected }) };
  const notice: NativeToolchainReportRequest = { ...report, action: 'notice', bodyDigest: reportBodyDigest({ ref, recipientChatId: target.chatId, text }) };
  return withReportAdmissions([report, notice], (assertCurrent, revisions, exclusion) => getDb().transaction(() => {
    assertCurrent();
    if (typeof exclusion.reportId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(exclusion.reportId)) throw Error('toolchain_report_registered_effect_required');
    const currentCall = getToolchainCall(call.id);
    if (!currentCall || JSON.stringify(currentCall) !== JSON.stringify(call)) throw Error('toolchain_report_call_changed');
    const currentRelease = assetRelease(call.toolchainId, call.version, call.contentHash).release;
    if (reportRecipient(currentRelease.provenance.creatorChatId).chatId !== target.chatId) throw Error('toolchain_report_audience_changed');
    let created: AssetReport | null = null, outcome: ToolchainReportOutcome | null = null;
    mutateToolchainState(assetLedger(call.toolchainId), current => {
      assertCurrent();
      const reports = current.reports ?? [], prior = reports.find(r => r.reporterChatId === input.callerChatId && r.eventId === call.id);
      if (prior && prior.id !== exclusion.reportId) throw Error('toolchain_report_registered_effect_changed');
      if (prior) { outcome = { state: 'already_reported', reportId: prior.id, deliveredTo: target.deliveredTo }; return null; }
      const open = reports.filter(r => r.state === 'open').length;
      if (open >= TOOLCHAIN_REPORT_POLICY.maxOpen) { outcome = { state: 'queue_full', open }; return null; }
      created = { id: exclusion.reportId!, at: new Date().toISOString(), reporterChatId: input.callerChatId, eventId: call.id,
        problem, expected, state: 'open', assetRef: ref, recipientChatId: target.chatId, authorityRevision: revisions[0] };
      outcome = { state: 'reported', reportId: created.id, deliveredTo: target.deliveredTo };
      return { ...current, reports: [...reports, created].slice(-TOOLCHAIN_REPORT_POLICY.keep) };
    });
    const createdReport = created as AssetReport | null;
    if (createdReport) {
      assertCurrent();
      appendChatMessage(target.chatId, 'assistant', text, { hostNotice: { purpose: 'host-status', runId: `toolchain-report:${createdReport.id}`, status: 'needs-owner' } });
    }
    assertCurrent(); return outcome as unknown as ToolchainReportOutcome;
  }).immediate());
}
export async function openToolchainAssetReports(input: { callerChatId: string; toolchainId: string; version: number; contentHash: string }): Promise<ToolchainReport[]> {
  const { release } = assetRelease(input.toolchainId, input.version, input.contentHash), target = reportRecipient(release.provenance.creatorChatId);
  const selected = (readToolchainState(assetLedger(input.toolchainId)).reports ?? []).filter(row => {
    const report = row as AssetReport;
    return row.state === 'open' && report.assetRef?.version === input.version && report.assetRef.contentHash === input.contentHash;
  }) as AssetReport[];
  // Each retained report has its own source call, report resource and current
  // reader admission. Never substitute the maker's new run for the source run.
  const sources = selected.length ? selected.map(row => ({ row, call: getToolchainCall(row.eventId) }))
    : [{ row: null, call: listToolchainCalls(input.toolchainId).find(call => call.version === input.version && call.contentHash === input.contentHash) ?? null }];
  const result: ToolchainReport[] = [];
  for (const source of sources) {
    const call = source.call;
    if (!call || call.toolchainId !== input.toolchainId || call.version !== input.version || call.contentHash !== input.contentHash)
      throw Error('toolchain_report_source_call_required');
    const ref: NativeToolchainReportRef = { toolchainId: input.toolchainId, version: input.version, contentHash: input.contentHash,
      callId: call.id, callInputHash: call.inputHash, callRunId: call.runId, sourceCallerChatId: call.callerChatId };
    const request: NativeToolchainReportRequest = { action: 'read-reports', ref, callerChatId: input.callerChatId, recipientChatId: target.chatId,
      ...(source.row ? { reportId: source.row.id } : {}),
      bodyDigest: reportBodyDigest({ ref, callerChatId: input.callerChatId, recipientChatId: target.chatId, selected, reportId: source.row?.id ?? null }) };
    const row = await withReportAdmissions([request], (assertCurrent, _revisions, exclusion) => getDb().transaction(() => {
      assertCurrent(); assetRelease(input.toolchainId, input.version, input.contentHash);
      if (source.row && exclusion.reportId !== source.row.id) throw Error('toolchain_report_registered_effect_changed');
      if (JSON.stringify(getToolchainCall(call.id)) !== JSON.stringify(call)) throw Error('toolchain_report_call_changed');
      if (reportRecipient(release.provenance.creatorChatId).chatId !== target.chatId) throw Error('toolchain_report_audience_changed');
      const current = (readToolchainState(assetLedger(input.toolchainId)).reports ?? []).filter(row => {
        const report = row as AssetReport;
        return row.state === 'open' && report.assetRef?.version === input.version && report.assetRef.contentHash === input.contentHash;
      });
      if (JSON.stringify(current) !== JSON.stringify(selected)) throw Error('toolchain_report_read_revision_changed');
      assertCurrent(); return source.row ? structuredClone(source.row) : null;
    }).immediate());
    if (row) result.push(row);
  }
  return result;
}

// Append to native-toolchain-effects/reports.ts; Main-only, no renderer authority.
import type { ToolchainPreparedProposal } from "./generalizer";
import type { ToolchainGenerationResult } from "../../shared/toolchain-asset";
import type { ToolchainAutomationState } from "../../shared/toolchain";

export interface NativeAssetRepairContext {
  /** These values are resolved by the original registered owner, not by the caller. */
  readonly reportId: string; readonly reportRevision: string; readonly budgetRevision: string;
  readonly assetRevision: number; readonly ledgerRevision: number; readonly observedAt: string;
  readonly ownerMessage: Readonly<{ id: string; chatId: string; at: string; revision: string }> | null;
  current(): boolean; release(): void;
}
export interface NativeAssetRepairContextQuery {
  readonly callerChatId: string; readonly ref: NativeToolchainReportRef;
  readonly reportId: string; readonly reportDigest: string; readonly assetRevision: number;
  readonly ledgerRevision: number;
}
export interface NativeAssetRepairAcceptance {
  readonly reportId: string; readonly reportRevision: string;
  readonly toolchainId: string; readonly version: number; readonly contentHash: string;
  readonly assetRevision: number; readonly repairRequestId: string;
  /** Exact persisted validation calls; a receipt string/approved boolean is insufficient. */
  readonly validationReceiptIds: readonly string[]; readonly approvalRevision: string;
  current(): boolean; release(): void;
}
export interface NativeAssetRepairEvidencePorts {
  prepareContext(query: Readonly<NativeAssetRepairContextQuery>): Promise<NativeAssetRepairContext | null>;
  /** Original context identity, report/budget/reset revisions checked in SAME owner exclusion. */
  assertContext(context: NativeAssetRepairContext, scope: Readonly<NativeToolchainReportExclusion>): void;
  prepareAcceptance(query: Readonly<NativeAssetRepairContextQuery> & Readonly<{ repairRequestId: string }>): Promise<NativeAssetRepairAcceptance | null>;
  /** Required genuine owner sink: exact approval + tested immutable replacement + all current
   * source/audience grants and original call/report lineage. Synchronously invoke once in the
   * SAME owner SQL exclusion, return its actual value. No model, provider, publish or new queue. */
  withAcceptedReplacement<T>(context: NativeAssetRepairContext, evidence: NativeAssetRepairAcceptance,
    scope: Readonly<NativeToolchainReportExclusion>, reducer: () => T): T;
}
let assetRepairEvidence: NativeAssetRepairEvidencePorts | null = null;
export function configureNativeAssetRepairEvidencePorts(ports: NativeAssetRepairEvidencePorts): void {
  if (assetRepairEvidence) throw Error("toolchain_repair_evidence_already_bound");
  assetRepairEvidence = ports;
}
function repairEvidence(): NativeAssetRepairEvidencePorts {
  if (!assetRepairEvidence) throw Error("UNBOUND_toolchain_repair_canonical_owner_evidence");
  return assetRepairEvidence;
}
function immutableRepairValue<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (v: unknown): void => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(clone); return clone;
}
interface AssetRepairRecord {
  at: string; chatId: string; requestId: string; reportId: string; proposalDigest: string;
  version: number; contentHash: string; generalizationId: string; authorityRevision: string;
}
interface AssetRepairState extends ToolchainAutomationState {
  repairs?: Array<{ at: string; chatId: string } | AssetRepairRecord>;
  assetRepairNotices?: Array<{ key: string; at: string }>;
}
function repairSnapshot(input: { callerChatId: string; toolchainId: string; reportId: string }) {
  const state = readToolchainState(assetLedger(input.toolchainId)) as AssetRepairState;
  const report = (state.reports ?? []).find(r => r.id === input.reportId) as AssetReport | undefined;
  if (!report || report.state !== "open" || !report.assetRef || report.assetRef.toolchainId !== input.toolchainId
    || report.recipientChatId !== input.callerChatId) throw Error("toolchain_repair_original_report_required");
  const { asset } = assetRelease(input.toolchainId, report.assetRef.version, report.assetRef.contentHash);
  const call = report.assetRef.callId ? getToolchainCall(report.assetRef.callId) : null;
  if (!call || call.toolchainId !== input.toolchainId || call.version !== report.assetRef.version
    || call.contentHash !== report.assetRef.contentHash || call.inputHash !== report.assetRef.callInputHash
    || call.runId !== report.assetRef.callRunId || call.callerChatId !== report.assetRef.sourceCallerChatId)
    throw Error("toolchain_repair_source_call_changed");
  return { state, report, asset, call, query: immutableRepairValue({ callerChatId: input.callerChatId,
    ref: structuredClone(report.assetRef), reportId: report.id, reportDigest: reportBodyDigest(report),
    assetRevision: asset.revision, ledgerRevision: state.revision }) };
}
function repairLease(context: NativeAssetRepairContext | null, snapshot: ReturnType<typeof repairSnapshot>) {
  if (!context || context.reportId !== snapshot.report.id || !context.reportRevision || !context.budgetRevision
    || context.assetRevision !== snapshot.asset.revision || context.ledgerRevision !== snapshot.state.revision
    || !ownedReportCallback(context, "current") || !ownedReportCallback(context, "release"))
    throw Error("UNBOUND_toolchain_repair_canonical_owner_context");
  const observed = Date.parse(context.observedAt), now = Date.now();
  if (!Number.isFinite(observed) || observed > now + 30_000 || observed < now - 120_000)
    throw Error("toolchain_repair_context_stale");
  return context;
}
async function prepareRepairContext(ports: NativeAssetRepairEvidencePorts, snapshot: ReturnType<typeof repairSnapshot>): Promise<NativeAssetRepairContext> {
  const candidate = await ports.prepareContext(snapshot.query);
  try { return repairLease(candidate, snapshot); }
  catch (error) { ownedReportCallback(candidate, "release")?.(); throw error; }
}
function releaseRepairLeases(...values: unknown[]): void {
  let failed = false;
  for (const value of values) { try { ownedReportCallback(value, "release")?.(); } catch { failed = true; } }
  if (failed) throw Error("toolchain_repair_release_unconfirmed");
}
function repairFloor(context: NativeAssetRepairContext, chatId: string): number {
  let floor = Date.parse(context.observedAt) - DAY_MS;
  if (context.ownerMessage) {
    const m = context.ownerMessage, at = Date.parse(m.at);
    if (!m.id || !m.revision || m.chatId !== chatId || !Number.isFinite(at) || at > Date.parse(context.observedAt))
      throw Error("toolchain_repair_owner_reset_invalid");
    // SQL equality is secondary readback; assertContext must prove the native OWNER authored it.
    const row = getDb().prepare("SELECT created_at FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user'")
      .get(m.id, chatId) as { created_at: string } | undefined;
    if (!row || row.created_at !== m.at) throw Error("toolchain_repair_owner_reset_changed");
    floor = Math.max(floor, at);
  }
  return floor;
}
function repairCount(state: AssetRepairState, context: NativeAssetRepairContext, chatId: string) {
  const floor = repairFloor(context, chatId);
  const recent = (state.repairs ?? []).filter(r => r.chatId === chatId && Date.parse(r.at) > floor);
  return { floor, recent, full: recent.length >= TOOLCHAIN_REPORT_POLICY.repairBudget };
}
function assertRepairSnapshot(input: Parameters<typeof repairSnapshot>[0], snapshot: ReturnType<typeof repairSnapshot>,
  context: NativeAssetRepairContext, scope: Readonly<NativeToolchainReportExclusion>) {
  repairLease(context, snapshot);
  if (scope.reportId !== snapshot.report.id || scope.reportRevision !== context.reportRevision
    || context.current() !== true) throw Error("toolchain_repair_report_authority_changed");
  repairEvidence().assertContext(context, scope);
  const fresh = repairSnapshot(input);
  if (fresh.state.revision !== snapshot.state.revision || fresh.asset.revision !== snapshot.asset.revision
    || reportBodyDigest(fresh.report) !== snapshot.query.reportDigest
    || reportBodyDigest(fresh.call) !== reportBodyDigest(snapshot.call)) throw Error("toolchain_repair_binding_changed");
}
function repairRequest(snapshot: ReturnType<typeof repairSnapshot>, context: NativeAssetRepairContext,
  action: NativeToolchainReportRequest["action"], body: unknown): NativeToolchainReportRequest {
  return { action, ref: snapshot.query.ref, callerChatId: snapshot.query.callerChatId,
    recipientChatId: snapshot.report.recipientChatId, bodyDigest: reportBodyDigest({ body, reportId: context.reportId,
      reportRevision: context.reportRevision, budgetRevision: context.budgetRevision, assetRevision: context.assetRevision,
      ledgerRevision: context.ledgerRevision, ownerMessage: context.ownerMessage }) };
}
async function repairBudgetNotice(input: Parameters<typeof repairSnapshot>[0], snapshot: ReturnType<typeof repairSnapshot>, context: NativeAssetRepairContext): Promise<void> {
  const budget = repairCount(snapshot.state, context, input.callerChatId);
  const retryAt = new Date(Math.min(...budget.recent.map(r => Date.parse(r.at))) + DAY_MS).toISOString();
  const key = reportBodyDigest({ toolchainId: input.toolchainId, chatId: input.callerChatId,
    ownerMessage: context.ownerMessage?.id ?? null });
  const name = clip(snapshot.asset.name, 120);
  const text = currentUiLocale() === "ko"
    ? `툴체인 「${name}」의 수정 초안을 오늘 ${budget.recent.length}번 만들었습니다. 다음 수정은 ${clockOf(retryAt)} 이후 또는 이 대화에서 소유자가 말씀한 뒤에 가능합니다.`
    : `The Toolchain "${name}" has ${budget.recent.length} repair drafts today. Another waits until ${clockOf(retryAt)}, or an owner message in this conversation.`;
  await withReportAdmissions([repairRequest(snapshot, context, "notice", { phase: "repair-budget-notice", key, text })], (current, _rev, scope) =>
    getDb().transaction(() => {
      current(); assertRepairSnapshot(input, snapshot, context, scope);
      if (!repairCount(snapshot.state, context, input.callerChatId).full) throw Error("toolchain_repair_budget_changed");
      if (!(snapshot.state.assetRepairNotices ?? []).some(n => n.key === key && Date.parse(n.at) > budget.floor)) {
        appendChatMessage(input.callerChatId, "assistant", text, { hostNotice: { purpose: "host-status", runId: `repair-budget:${key}`.slice(0, 128), status: "needs-owner" } });
        mutateToolchainState(assetLedger(input.toolchainId), state => ({ ...state,
          assetRepairNotices: [...((state as AssetRepairState).assetRepairNotices ?? []), { key, at: context.observedAt }].slice(-TOOLCHAIN_REPORT_POLICY.keep) } as AssetRepairState));
      }
      current();
    }).immediate());
}
/** Bind to GenerationActor.withPreparedCommit. Async preparation already completed; the real
 * synchronous generalizer commit remains nested in the native owner effect transaction. */
export async function withToolchainAssetRepairCommit(input: { callerChatId: string; toolchainId: string; reportId: string },
  proposal: Readonly<ToolchainPreparedProposal>, commit: () => ToolchainGenerationResult): Promise<ToolchainGenerationResult> {
  input = immutableRepairValue(input); proposal = immutableRepairValue(proposal);
  const ports = repairEvidence(), snapshot = repairSnapshot(input);
  const context = await prepareRepairContext(ports, snapshot);
  try {
    const expectedVersion = Math.max(...snapshot.asset.versions.map(v => v.version)) + 1;
    if (proposal.schema !== "agentlas.toolchain-prepared-proposal.v1" || proposal.decision !== "new_version"
      || proposal.targetToolchainId !== input.toolchainId || proposal.baseRevision !== snapshot.asset.revision
      || proposal.version !== null
      || !proposal.compiledGraph || !proposal.contract || !proposal.runtimeReceipt || !proposal.requestId)
      throw Error("toolchain_repair_genuine_new_version_required");
    const digest = reportBodyDigest(proposal);
    const prior = (snapshot.state.repairs ?? []).find(r => "requestId" in r && r.requestId === proposal.requestId);
    if (prior) throw Error("toolchain_repair_original_request_already_committed");
    if (repairCount(snapshot.state, context, input.callerChatId).full) {
      await repairBudgetNotice(input, snapshot, context); throw Error("toolchain_repair_budget_exhausted");
    }
    return await withReportAdmissions([repairRequest(snapshot, context, "repair", { phase: "repair-draft", proposal, proposalDigest: digest, expectedVersion })], (current, revisions, scope) =>
      getDb().transaction(() => {
        current(); assertRepairSnapshot(input, snapshot, context, scope);
        if (repairCount(snapshot.state, context, input.callerChatId).full) throw Error("toolchain_repair_budget_exhausted");
        const result = commit();
        if (result && typeof result === "object" && "then" in result) throw Error("toolchain_repair_commit_must_be_synchronous");
        const saved = getToolchainAsset(input.toolchainId), release = saved?.versions.find(v => v.version === expectedVersion);
        if (!saved || !release || result.decision !== "new_version" || result.asset.id !== input.toolchainId
          || result.version !== expectedVersion || saved.revision !== snapshot.asset.revision + 1
          || saved.versions.length !== snapshot.asset.versions.length + 1 || saved.stableVersion !== snapshot.asset.stableVersion || saved.status !== snapshot.asset.status
          || reportBodyDigest(release.contract) !== reportBodyDigest(proposal.contract)
          || reportBodyDigest(release.implementation.snapshot.graph) !== reportBodyDigest(proposal.compiledGraph)
          || release.validation.state !== "untested" || release.validation.receipts.length !== 0 || release.validation.problems.length !== 0
          || reportBodyDigest(saved) !== reportBodyDigest(result.asset)
          || snapshot.asset.versions.some(v => reportBodyDigest(v) !== reportBodyDigest(saved.versions.find(next => next.version === v.version)))
          || !result.generalizationId) throw Error("toolchain_repair_actual_private_version_required");
        mutateToolchainState(assetLedger(input.toolchainId), state => {
          if (state.revision !== snapshot.state.revision) throw Error("toolchain_repair_ledger_changed");
          return { ...state, repairs: [...(state.repairs ?? []), { at: context.observedAt, chatId: input.callerChatId,
            requestId: proposal.requestId, reportId: input.reportId, proposalDigest: digest, version: release.version,
            contentHash: release.contentHash, generalizationId: result.generalizationId, authorityRevision: revisions[0] } as AssetRepairRecord].slice(-TOOLCHAIN_REPORT_POLICY.keep) };
        });
        current(); if (context.current() !== true) throw Error("toolchain_repair_authority_changed");
        return result; // Reports deliberately remain OPEN; a draft is not an accepted repair.
      }).immediate());
  } finally { releaseRepairLeases(context); }
}
export async function settleToolchainAssetRepair(input: { callerChatId: string; toolchainId: string; reportId: string; repairRequestId: string }): Promise<ToolchainReport> {
  input = immutableRepairValue(input);
  const ports = repairEvidence(), snapshot = repairSnapshot(input);
  const context = await prepareRepairContext(ports, snapshot);
  let evidence: NativeAssetRepairAcceptance | null = null;
  try {
    evidence = await ports.prepareAcceptance(Object.freeze({ ...snapshot.query, repairRequestId: input.repairRequestId }));
    const accepted = evidence;
    const repair = (snapshot.state.repairs ?? []).find((r): r is AssetRepairRecord => "requestId" in r && r.requestId === input.repairRequestId);
    if (!accepted || !repair || repair.reportId !== input.reportId || accepted.reportId !== input.reportId
      || accepted.reportRevision !== context.reportRevision || accepted.toolchainId !== input.toolchainId
      || accepted.repairRequestId !== repair.requestId || accepted.version !== repair.version || accepted.contentHash !== repair.contentHash
      || accepted.assetRevision !== snapshot.asset.revision || !accepted.approvalRevision
      || !ownedReportCallback(accepted, "current") || !ownedReportCallback(accepted, "release") || typeof ports.withAcceptedReplacement !== "function")
      throw Error("UNBOUND_toolchain_repair_exact_acceptance_sink");
    // read-reports admits reading; the REQUIRED native sink independently admits settlement.
    return await withReportAdmissions([repairRequest(snapshot, context, "read-reports", { phase: "repair-settlement", repair,
      replacement: { version: accepted.version, contentHash: accepted.contentHash }, approvalRevision: accepted.approvalRevision,
      validationReceiptIds: accepted.validationReceiptIds })], (current, _revisions, scope) => getDb().transaction(() => {
      current(); assertRepairSnapshot(input, snapshot, context, scope);
      const release = snapshot.asset.versions.find(v => v.version === accepted.version);
      if (snapshot.asset.status !== "callable" || snapshot.asset.stableVersion !== accepted.version || !release || release.contentHash !== accepted.contentHash
        || release.validation.state !== "passed" || release.validation.problems.length || !release.validation.at
        || release.validation.receipts.length < 2 || reportBodyDigest(release.validation.receipts) !== reportBodyDigest(accepted.validationReceiptIds)
        || accepted.current() !== true) throw Error("toolchain_repair_exact_tested_replacement_required");
      if (new Set(accepted.validationReceiptIds).size !== accepted.validationReceiptIds.length
        || accepted.validationReceiptIds.some((id, index) => {
          const call = getToolchainCall(id);
          return !call || call.toolchainId !== input.toolchainId || call.version !== accepted.version
            || call.contentHash !== accepted.contentHash || call.status !== "succeeded" || call.ok !== true
            || !call.completedAt || call.requestId !== `validation:${accepted.contentHash}:${index}`;
        })) throw Error("toolchain_repair_validation_readback_required");
      let entered = false, open = true, result: ToolchainReport | null = null;
      let returned: ToolchainReport;
      try { returned = ports.withAcceptedReplacement(context, accepted, scope, () => {
        if (!open || entered) throw Error("toolchain_repair_acceptance_once_required"); entered = true;
        current(); if (accepted.current() !== true) throw Error("toolchain_repair_acceptance_changed");
        mutateToolchainState(assetLedger(input.toolchainId), state => ({ ...state, reports: (state.reports ?? []).map(r => {
          if (r.id !== input.reportId) return r;
          if (r.state !== "open" || reportBodyDigest(r) !== snapshot.query.reportDigest) throw Error("toolchain_repair_report_changed");
          result = { ...r, state: "repaired", settledAt: context.observedAt,
            acceptedRepair: { requestId: repair.requestId, version: accepted.version, contentHash: accepted.contentHash,
              approvalRevision: accepted.approvalRevision, validationReceiptIds: [...accepted.validationReceiptIds] } } as ToolchainReport; return result;
        }) }));
        current(); if (accepted.current() !== true) throw Error("toolchain_repair_acceptance_changed");
        return result as unknown as ToolchainReport;
      }); } finally { open = false; }
      if (!entered || !result || returned !== result) throw Error("toolchain_repair_acceptance_result_required");
      return returned;
    }).immediate());
  } finally { releaseRepairLeases(evidence, context); }
}

/** Main-only PRE-MODEL observation. This is neither a paid-runtime grant nor a repair
 * receipt. Root's genuine preparation producer must still check current original work,
 * runtime/candidate/source/audience/payer/budget before dispatch; withPreparedCommit
 * must reacquire native authority after the actual compiled proposal, unchanged. */
export interface ToolchainAssetRepairPreflightObservation {
  readonly schema: "agentlas.toolchain-repair-preflight-observation.v1";
  readonly requestId: string; readonly callerChatId: string;
  readonly ref: Readonly<NativeToolchainReportRef>;
  readonly reportId: string; readonly reportDigest: string; readonly reportRevision: string;
  readonly assetRevision: number; readonly ledgerRevision: number; readonly budgetRevision: string;
  readonly ownerMessage: NativeAssetRepairContext["ownerMessage"];
  readonly observedAt: string; readonly windowStart: string; readonly repairsInWindow: number;
  readonly readAuthorityRevision: string; readonly repairAuthorityRevision: string;
}
/** Called before callToolchainPreparation. requestId is the SAME native original repair
 * command later passed to generateToolchain, not a new per-attempt nonce. Native request
 * registration must recognize phase repair-preflight for this original accepted intent.
 * Missing registration/context/owner ports deny; caller flags convey no authority. */
export async function preflightToolchainAssetRepair(input: {
  callerChatId: string; toolchainId: string; reportId: string; requestId: string;
}): Promise<Readonly<ToolchainAssetRepairPreflightObservation>> {
  input = immutableRepairValue(input);
  if (!input.requestId || input.requestId.length > 256) throw Error("toolchain_repair_original_request_required");
  const ports = repairEvidence(), snapshot = repairSnapshot(input);
  const context = await prepareRepairContext(ports, snapshot);
  try {
    const contextBinding = () => ({ reportId: context.reportId, reportRevision: context.reportRevision,
    assetRevision: context.assetRevision, ledgerRevision: context.ledgerRevision,
    budgetRevision: context.budgetRevision, ownerMessage: context.ownerMessage, observedAt: context.observedAt });
    const contextDigest = reportBodyDigest(contextBinding());
    if (repairCount(snapshot.state, context, input.callerChatId).full) {
      // Same original canonical native notice/exclusion and stable dedupe key as
      // the commit guard; no model turn or repair count is created by this notice.
      await repairBudgetNotice(input, snapshot, context);
      throw Error("toolchain_repair_budget_exhausted");
    }
    const check = (current: () => void, scope: Readonly<NativeToolchainReportExclusion>) => {
      current(); assertRepairSnapshot(input, snapshot, context, scope);
      if (reportBodyDigest(contextBinding()) !== contextDigest)
        throw Error("toolchain_repair_preflight_context_changed");
      if ((snapshot.state.repairs ?? []).some(r => "requestId" in r && r.requestId === input.requestId))
        throw Error("toolchain_repair_original_request_already_committed");
      const budget = repairCount(snapshot.state, context, input.callerChatId);
      if (budget.full) throw Error("toolchain_repair_budget_exhausted");
      current(); if (context.current() !== true) throw Error("toolchain_repair_authority_changed");
      return budget;
    };
    // No read is treated as a paid approval. The repair admission independently checks
    // current native owner source/budget/intent after this read; supported single phases
    // avoid inventing a new report+repair combined native transaction contract.
    const readAuthorityRevision = await withReportAdmissions([
      repairRequest(snapshot, context, "read-reports", { phase: "repair-preflight-read", requestId: input.requestId })
    ], (current, revisions, scope) => getDb().transaction(() => {
      check(current, scope); return revisions[0];
    }).immediate());
    return await withReportAdmissions([
      repairRequest(snapshot, context, "repair", { phase: "repair-preflight", requestId: input.requestId })
    ], (current, revisions, scope) => getDb().transaction(() => {
      const budget = check(current, scope);
      return immutableRepairValue({ schema: "agentlas.toolchain-repair-preflight-observation.v1" as const,
        requestId: input.requestId, callerChatId: input.callerChatId, ref: snapshot.query.ref,
        reportId: context.reportId, reportDigest: snapshot.query.reportDigest,
        reportRevision: context.reportRevision, assetRevision: context.assetRevision,
        ledgerRevision: context.ledgerRevision, budgetRevision: context.budgetRevision,
        ownerMessage: context.ownerMessage, observedAt: context.observedAt,
        windowStart: new Date(budget.floor).toISOString(), repairsInWindow: budget.recent.length,
        readAuthorityRevision, repairAuthorityRevision: revisions[0] });
    }).immediate());
  } finally { releaseRepairLeases(context); }
}
