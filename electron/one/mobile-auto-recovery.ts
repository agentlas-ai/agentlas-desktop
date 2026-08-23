import { appendChatMessage, listChatMessages, listRecentChats } from "../store/chats";
import { getLatestInvocationRunReceipt, isMobileOneInvocationChat } from "../store/run-events";
import { captureMobileOneInvocationBinding } from "../invocation/workspace-binding";
import type { InvocationService, InvocationSettledEnvelope } from "../invocation/service";
import { judgeOneAutoRecovery } from "./auto-recovery";
import { verifyOneRecoveryOutcome } from "./recovery-verification";
import { getMeta, setMeta } from "../store/meta";

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

/**
 * PRD §4.32 — 복구 이력이 메모리에만 있었다. 그래서 데스크탑을 다시 켤 때마다 최근 대화
 * 500개를 훑어 실패한 모바일 One 대화마다 **유료 복구를 처음부터 다시** 시작했고, 계속
 * 실패하는 건은 재시작마다 다시 나갔다. 시도 이력을 지속 저장해 상한을 프로세스 밖에서도 공유한다.
 */
const RECOVERY_LEDGER_KEY = "one.mobile-auto-recovery.attempts.v1";
/** 이력이 무한히 커지지 않게 최근 것만 남긴다. */
const RECOVERY_LEDGER_MAX = 200;
/** 한 실행에 대해 이 횟수를 넘겨 복구하지 않는다(판정기의 회차와 같은 축을 공유한다). */
const RECOVERY_ATTEMPT_HARD_MAX = 3;

type RecoveryLedger = Record<string, { attempts: number; at: string }>;

function readRecoveryLedger(): RecoveryLedger {
  try {
    const parsed = JSON.parse(getMeta(RECOVERY_LEDGER_KEY) || "{}") as RecoveryLedger;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function recordRecoveryAttempt(originalRunId: string, attempts: number): void {
  try {
    const ledger = readRecoveryLedger();
    ledger[originalRunId] = { attempts, at: new Date().toISOString() };
    const entries = Object.entries(ledger)
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, RECOVERY_LEDGER_MAX);
    setMeta(RECOVERY_LEDGER_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 원장을 못 쓰면 이번 프로세스의 상한만 유효하다 — 조용히 무한 재시도로 돌아가지는 않는다.
  }
}

function persistedAttempts(originalRunId: string): number {
  return Math.max(0, Math.floor(readRecoveryLedger()[originalRunId]?.attempts ?? 0));
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
  state.recoveryRunIds.add(result.runId);
}

async function handleSettled(
  service: InvocationService,
  envelope: InvocationSettledEnvelope,
): Promise<void> {
  if (!envelope.oneMode || envelope.workspaceBinding?.source !== "mobile-one") return;
  let state = states.get(envelope.chatId);
  const isKnownRecovery = state?.recoveryRunIds.has(envelope.runId) === true;

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
      const verification = await verifyOneRecoveryOutcome({
        originalRunId: activeState.originalRunId,
        recoveryRunId: envelope.runId,
        chatId: envelope.chatId,
        goal: activeState.goal,
        attemptsSpent: activeState.attemptsSpent,
      });
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
      activeState.attemptsSpent = verification.attempt ?? activeState.attemptsSpent + 1;
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
      activeState.attemptsSpent += 1;
      if (activeState.attemptsSpent > RECOVERY_ATTEMPT_HARD_MAX) {
        states.delete(envelope.chatId);
        return;
      }
      recordRecoveryAttempt(activeState.originalRunId, activeState.attemptsSpent);
      startRecovery(service, envelope, activeState, "");
      return;
    }

    const judgement = await judgeOneAutoRecovery({
      receipt: envelope.receipt,
      goal: activeState.goal,
      attemptsSpent: activeState.attemptsSpent,
      previousFingerprint: activeState.previousFingerprint,
    });
    activeState.previousFingerprint = judgement.fingerprint;
    if (!judgement.decision.retry) {
      presentJudgedDiagnosis(envelope.chatId, judgement.diagnosis);
      states.delete(envelope.chatId);
      return;
    }
    activeState.attemptsSpent = judgement.decision.attempt;
    if (activeState.attemptsSpent > RECOVERY_ATTEMPT_HARD_MAX) {
      states.delete(envelope.chatId);
      return;
    }
    recordRecoveryAttempt(activeState.originalRunId, activeState.attemptsSpent);
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
    if (!receipt || (receipt.status !== "failed" && receipt.status !== "interrupted")) continue;
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
