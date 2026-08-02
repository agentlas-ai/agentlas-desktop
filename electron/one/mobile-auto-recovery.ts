import { appendChatMessage, listChatMessages, listRecentChats } from "../store/chats";
import { getLatestInvocationRunReceipt, isMobileOneInvocationChat } from "../store/run-events";
import { captureMobileOneInvocationBinding } from "../invocation/workspace-binding";
import type { InvocationService, InvocationSettledEnvelope } from "../invocation/service";
import { judgeOneAutoRecovery } from "./auto-recovery";
import { verifyOneRecoveryOutcome } from "./recovery-verification";

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
    state = {
      originalRunId: envelope.runId,
      goal: envelope.goal,
      attemptsSpent: 0,
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
