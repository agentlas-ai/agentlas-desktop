import { createHash } from "node:crypto";
import { appendChatMessage, listChatMessages, listRecentChats } from "../store/chats";
import { getInvocationRunReceipt, getLatestInvocationRunReceipt, getRunEventBySource, isMobileOneInvocationChat, recordRunEvent } from "../store/run-events";
import { getDb } from "../store/db";
import { captureMobileOneInvocationBinding } from "../invocation/workspace-binding";
import type { InvocationService, InvocationSettledEnvelope } from "../invocation/service";
import { judgeOneAutoRecovery } from "./auto-recovery";
import { verifyOneRecoveryOutcome } from "./recovery-verification";
import { getMeta } from "../store/meta";
import { ONE_AUTO_RECOVERY_MAX_ATTEMPTS, oneAutoRecoveryTerminalStop } from "../../shared/one-auto-recovery";

interface MobileRecoveryState {
  originalRunId: string;
  goal: string;
  attemptsSpent: number;
  previousFingerprint: string | null;
  recoveryRunIds: Set<string>;
  processingRunIds: Set<string>;
}

const states = new Map<string, MobileRecoveryState>();
let restartScanStarted = false;

/** Older counts remain a floor; new admissions and lineage use the existing immutable run ledger. */
const RECOVERY_LEDGER_KEY = "one.mobile-auto-recovery.attempts.v1";
const RECOVERY_REQUEST_KIND = "one_mobile_recovery_requested";
const RECOVERY_LINK_SOURCE = "one-mobile-recovery-link";
const RECOVERY_ATTEMPT_HARD_MAX = ONE_AUTO_RECOVERY_MAX_ATTEMPTS;
const goalDigest = (goal: string) => createHash("sha256").update(goal.trim().slice(0, 4_000)).digest("hex");

type RecoveryLedger = Record<string, { attempts: number; at: string }>;

function readRecoveryLedger(): RecoveryLedger {
  const raw = getMeta(RECOVERY_LEDGER_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as RecoveryLedger;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid ledger");
    return parsed;
  } catch {
    throw new Error("mobile_recovery_legacy_ledger_unreadable");
  }
}

interface RecoveryLink { originalRunId: string; ordinal: number; goalDigest: string }
function recoveryLink(runId: string, chatId: string): RecoveryLink | null {
  const event = getRunEventBySource(runId, RECOVERY_LINK_SOURCE);
  const p = event?.payload;
  if (!event || event.chatId !== chatId || event.kind !== "one_mobile_recovery_link" || p?.schemaVersion !== 1
    || typeof p.originalRunId !== "string" || !p.originalRunId || p.originalRunId === runId
    || !Number.isSafeInteger(p.ordinal) || Number(p.ordinal) < 1 || Number(p.ordinal) > RECOVERY_ATTEMPT_HARD_MAX
    || typeof p.goalDigest !== "string" || p.goalDigest.length !== 64
    || Buffer.from(p.goalDigest, "hex").toString("hex") !== p.goalDigest) return null;
  return { originalRunId: p.originalRunId, ordinal: Number(p.ordinal), goalDigest: p.goalDigest };
}

function persistedAttempts(originalRunId: string): number {
  const legacy = readRecoveryLedger()[originalRunId]?.attempts ?? 0;
  if (!Number.isSafeInteger(legacy) || legacy < 0) throw new Error("mobile_recovery_legacy_count_unreadable");
  const row = getDb().prepare(`SELECT max(json_extract(payload_json,'$.ordinal')) AS n
    FROM run_events WHERE run_id=? AND kind=?`).get(originalRunId, RECOVERY_REQUEST_KIND) as { n: number | null };
  return Math.max(legacy, row.n ?? 0);
}

function recoveryAssessment(runId: string, originalRunId: string, chatId: string): "verified" | "retry" | "stopped" | null {
  const row = getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND chat_id=?
    AND kind='one_recovery_outcome_assessed' ORDER BY seq DESC LIMIT 1`).get(runId, chatId) as { payload_json: string } | undefined;
  if (!row) return null;
  const p = JSON.parse(row.payload_json);
  return p.originalRunId === originalRunId && p.recoveryRunId === runId
    && ["verified", "retry", "stopped"].includes(p.outcome) ? p.outcome : null;
}

/** Reserve before service.start. A lost dispatch/link is uncertain, so it cannot open a second start. */
function recordRecoveryAttempt(envelope: InvocationSettledEnvelope, state: MobileRecoveryState): number | null {
  return getDb().transaction(() => {
    const latest = getLatestInvocationRunReceipt(envelope.chatId);
    if (!latest || latest.runId !== envelope.runId) return null;
    const spent = persistedAttempts(state.originalRunId);
    if (spent >= RECOVERY_ATTEMPT_HARD_MAX) return null;
    const previous = getRunEventBySource(state.originalRunId, `one-mobile-recovery:${spent}`);
    if (previous) {
      const linked = getDb().prepare(`SELECT run_id FROM run_events WHERE chat_id=? AND kind='one_mobile_recovery_link'
        AND json_extract(payload_json,'$.originalRunId')=? AND json_extract(payload_json,'$.ordinal')=? LIMIT 1`)
        .get(envelope.chatId, state.originalRunId, spent) as { run_id: string } | undefined;
      const receipt = linked ? getInvocationRunReceipt(linked.run_id) : null;
      if (!receipt?.finishedAt || !["failed", "interrupted", "completed"].includes(receipt.status) || oneAutoRecoveryTerminalStop(receipt)) return null;
      if (receipt.status === "completed" && recoveryAssessment(receipt.runId, state.originalRunId, envelope.chatId) !== "retry") return null;
    }
    const ordinal = spent + 1;
    const event = recordRunEvent({ runId: state.originalRunId, chatId: envelope.chatId, kind: RECOVERY_REQUEST_KIND,
      sourceEventId: `one-mobile-recovery:${ordinal}`, payload: { schemaVersion: 1, ordinal, goalDigest: goalDigest(state.goal) } });
    if (event.payload?.ordinal !== ordinal) throw new Error("mobile_recovery_admission_not_durable");
    return ordinal;
  }).immediate();
}

function recoveryPrompt(input: {
  goal: string;
  diagnosis: string;
}): string {
  return [
    "Continue the person's unfinished request as Agentlas One.",
    "Inspect current state using read-only authority first. Never repeat an outward action merely because its acknowledgement is missing.",
    "Find a different safe route, verify the original requested outcome, and return only the concise useful result.",
    "If new authority, identity, or an irreversible choice is truly required, ask one short contextual question through One's normal decision flow.",
    "Do not expose error codes, stack traces, paths, receipts, attempts, runtime names, databases, or internal component names.",
    `Original request: ${input.goal}`,
    ...(input.diagnosis.trim() ? [`One's private diagnosis: ${input.diagnosis.trim()}`] : []),
  ].join("\n");
}

function presentJudgedDiagnosis(chatId: string, diagnosis: string): void {
  const message = diagnosis.trim();
  if (!message) return;
  try {
    appendChatMessage(chatId, "assistant", message);
  } catch {
    // The durable judgment remains authoritative if the conversation was removed.
  }
}

function startRecovery(
  service: InvocationService,
  envelope: InvocationSettledEnvelope,
  state: MobileRecoveryState,
  diagnosis: string,
): void {
  if (service.activeRunIds().includes(envelope.runId) || service.hasQueuedOwnerRequest(envelope.chatId)) return;
  const currentGoal = listChatMessages(envelope.chatId, 200).filter((message) => message.role === "user").at(-1)?.text;
  if (!currentGoal || goalDigest(currentGoal) !== goalDigest(state.goal)) return;
  const ordinal = recordRecoveryAttempt(envelope, state);
  if (ordinal === null) return;
  state.attemptsSpent = ordinal;
  const result = service.start(
    {
      chatId: envelope.chatId,
      userPrompt: recoveryPrompt({ goal: state.goal, diagnosis }),
      taskIntent: "conversation",
      oneMode: true,
      permissions: "read",
    },
    envelope.workspaceBinding,
  );
  try {
    const link = recordRunEvent({ runId: result.runId, chatId: envelope.chatId, kind: "one_mobile_recovery_link",
      sourceEventId: RECOVERY_LINK_SOURCE, payload: { schemaVersion: 1, originalRunId: state.originalRunId,
        ordinal, goalDigest: goalDigest(state.goal) } });
    if (link.payload?.originalRunId !== state.originalRunId || link.payload?.ordinal !== ordinal) throw new Error("mobile_recovery_link_not_durable");
  } catch (error) {
    service.cancel(result.runId);
    throw error;
  }
  state.recoveryRunIds.add(result.runId);
}

async function handleSettled(
  service: InvocationService,
  envelope: InvocationSettledEnvelope,
): Promise<void> {
  if (!envelope.oneMode || envelope.workspaceBinding?.source !== "mobile-one") return;
  const terminalStop = oneAutoRecoveryTerminalStop(envelope.receipt);
  if (terminalStop) {
    states.delete(envelope.chatId);
    // The ordinary terminal receipt remains authoritative. Surface the same
    // stopped explanation without buying a judge call or a read-only retry.
    if (terminalStop.reason === "no-progress" || terminalStop.reason === "unsafe-to-repeat") {
      const stopped = await judgeOneAutoRecovery({ receipt: envelope.receipt, goal: envelope.goal, attemptsSpent: 0 });
      presentJudgedDiagnosis(envelope.chatId, stopped.diagnosis);
    }
    return;
  }
  let state = states.get(envelope.chatId);
  const link = recoveryLink(envelope.runId, envelope.chatId);
  let isKnownRecovery = state?.recoveryRunIds.has(envelope.runId) === true;
  if (!isKnownRecovery && link) {
    const original = getInvocationRunReceipt(link.originalRunId);
    const goal = listChatMessages(envelope.chatId, 200).filter((message) => message.role === "user").at(-1)?.text.trim().slice(0, 4_000);
    if (!original || original.chatId !== envelope.chatId || oneAutoRecoveryTerminalStop(original)
      || !["failed", "interrupted"].includes(original.status) || !goal || goalDigest(goal) !== link.goalDigest) return;
    state = { originalRunId: link.originalRunId, goal, attemptsSpent: persistedAttempts(link.originalRunId),
      previousFingerprint: null, recoveryRunIds: new Set([envelope.runId]), processingRunIds: new Set() };
    states.set(envelope.chatId, state);
    isKnownRecovery = true;
  }

  if (!isKnownRecovery) {
    if (envelope.receipt.status === "completed" || envelope.receipt.status === "cancelled") {
      states.delete(envelope.chatId);
      return;
    }
    if (envelope.receipt.status !== "failed" && envelope.receipt.status !== "interrupted") return;
    // PRD §4.32 — 이 실행에 이미 쓴 복구 횟수는 프로세스가 아니라 원장이 안다.
    // 상한을 넘었으면 재시작해도 다시 시작하지 않는다(같은 실패에 유료 실행을 반복하지 않는다).
    const spent = persistedAttempts(envelope.runId);
    if (spent >= RECOVERY_ATTEMPT_HARD_MAX) return;
    state = {
      originalRunId: envelope.runId,
      goal: envelope.goal,
      attemptsSpent: spent,
      previousFingerprint: null,
      recoveryRunIds: new Set(),
      processingRunIds: new Set(),
    };
    states.set(envelope.chatId, state);
  }

  if (!state) return;
  const activeState = state;

  if (activeState.processingRunIds.has(envelope.runId)) return;
  activeState.processingRunIds.add(envelope.runId);
  try {
    if (isKnownRecovery && envelope.receipt.status === "completed") {
      const assessment = recoveryAssessment(envelope.runId, activeState.originalRunId, envelope.chatId);
      if (assessment) {
        if (assessment === "retry") startRecovery(service, envelope, activeState, "");
        else states.delete(envelope.chatId);
        return;
      }
      const verification = await verifyOneRecoveryOutcome({
        originalRunId: activeState.originalRunId,
        recoveryRunId: envelope.runId,
        chatId: envelope.chatId,
        goal: activeState.goal,
        attemptsSpent: activeState.attemptsSpent,
      });
      if (states.get(envelope.chatId) !== activeState) return;
      if (!verification) return;
      if (verification.verified) {
        states.delete(envelope.chatId);
        return;
      }
      if (!verification.retry) {
        presentJudgedDiagnosis(envelope.chatId, verification.diagnosis);
        states.delete(envelope.chatId);
        return;
      }
      startRecovery(service, envelope, activeState, verification.diagnosis);
      return;
    }

    if (envelope.receipt.status !== "failed" && envelope.receipt.status !== "interrupted") {
      states.delete(envelope.chatId);
      return;
    }

    // A write-capable attempt is never repeated. A fresh read-only One turn
    // inspects what actually happened and can ask for new authority if needed.
    if (envelope.receipt.executionPermission !== "read") {
      startRecovery(service, envelope, activeState, "");
      return;
    }

    const judgement = await judgeOneAutoRecovery({
      receipt: envelope.receipt,
      goal: activeState.goal,
      attemptsSpent: activeState.attemptsSpent,
      previousFingerprint: activeState.previousFingerprint,
    });
    if (states.get(envelope.chatId) !== activeState) return;
    activeState.previousFingerprint = judgement.fingerprint;
    if (!judgement.decision.retry) {
      presentJudgedDiagnosis(envelope.chatId, judgement.diagnosis);
      states.delete(envelope.chatId);
      return;
    }
    startRecovery(service, envelope, activeState, judgement.diagnosis);
  } finally {
    activeState.processingRunIds.delete(envelope.runId);
  }
}

/** Main-owned and route-independent; Mobile never needs its own recovery controller. */
export function installMobileOneAutoRecovery(service: InvocationService): () => void {
  return service.onSettled((envelope) => handleSettled(service, envelope));
}

/** Rehydrates interrupted Mobile One work after Desktop restarts. */
export async function resumeMobileOneAutoRecovery(service: InvocationService): Promise<void> {
  if (restartScanStarted) return;
  const chats = listRecentChats(500);
  restartScanStarted = true;
  for (const chat of chats) {
    if (!isMobileOneInvocationChat(chat.id)) continue;
    const receipt = getLatestInvocationRunReceipt(chat.id);
    if (!receipt || (!["failed", "interrupted"].includes(receipt.status)
      && !(receipt.status === "completed" && recoveryLink(receipt.runId, chat.id)))) continue;
    const goal = listChatMessages(chat.id, 200)
      .filter((message) => message.role === "user")
      .at(-1)?.text.trim();
    if (!goal) continue;
    await handleSettled(service, {
      runId: receipt.runId,
      chatId: chat.id,
      receipt,
      oneMode: true,
      goal: goal.slice(0, 4_000),
      workspaceBinding: captureMobileOneInvocationBinding(),
    });
  }
}
