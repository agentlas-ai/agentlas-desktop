import { createHash } from "node:crypto";
import {
  ONE_DECISION_OWNER_ANSWER_CONTRACT_VERSION,
  ONE_DECISION_PRODUCT_SAFE_REJECT_REPLY,
  oneDecisionOwnerSelectableIndexes,
} from "../../shared/one-decision";
import type {
  MobileBridgeOneDecisionDto,
  MobileBridgeOneDecisionOwnerAnswerV4Dto,
} from "../../shared/mobile-bridge";
import type { PendingConfirmation } from "../../shared/types";

// Match V1's whitespace display cleanup without redacting or truncating source
// text. A label changed by either of those operations must still be refused.
function ownerSourceLabel(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** The digest includes full source text, even text truncated in the V1 display. */
export function projectOneDecisionOwnerAnswerV4(
  decision: MobileBridgeOneDecisionDto,
  pending: PendingConfirmation,
): MobileBridgeOneDecisionOwnerAnswerV4Dto | null {
  const { view } = decision;
  const optionLabels = view.options.map((option) => option.label);
  if (!view.taskId || view.chatId !== pending.chatId
    || view.decisionId !== pending.sourceMessageId || view.createdAt !== pending.createdAt
    || optionLabels.length < 2 || optionLabels.length !== pending.options.length
    || new Set(optionLabels).size !== optionLabels.length
    // A redacted/truncated option is not the original answer the owner selected.
    || view.options.some((option, index) => option.index !== index
      || !option.label || option.label !== ownerSourceLabel(pending.options[index].label))) return null;
  // Typed only (native-harness notyet NH25): the judged disposition keeps reject/modify controls out of the quick
  // answers, plus the product's own exact reject reply. Without a verdict an option is a plain "choice": choosing it
  // sends its exact label as the owner's confirmed answer and grants nothing (grantsAuthority stays with "approve").
  const selectableIndexes = oneDecisionOwnerSelectableIndexes(view);
  if (!selectableIndexes.length) return null;
  const bindingDigest = createHash("sha256").update(JSON.stringify([
    ONE_DECISION_OWNER_ANSWER_CONTRACT_VERSION,
    decision.authoritativeHostRef, decision.canonicalTaskVersion,
    view.taskId, pending.chatId, pending.sourceMessageId, pending.createdAt,
    pending.question, pending.header ?? null,
    pending.options.map((option) => [option.label, option.description ?? null]),
    pending.multiSelect,
  ])).digest("hex");
  return {
    contractVersion: ONE_DECISION_OWNER_ANSWER_CONTRACT_VERSION,
    authoritativeHostRef: decision.authoritativeHostRef,
    canonicalTaskVersion: decision.canonicalTaskVersion,
    taskId: view.taskId, chatId: view.chatId, decisionId: view.decisionId,
    createdAt: view.createdAt, optionLabels, multiSelect: pending.multiSelect,
    selectableIndexes, bindingDigest, requiresOwnerConfirmation: true,
  };
}

export interface OneDecisionOwnerAnswerV4Binding {
  authoritativeHostRef: string;
  createdAt: string;
  optionLabels: string[];
  selectionIndexes: number[];
  bindingDigest: string;
  ownerConfirmed: true;
}

/** Advisory risk never grants authority: only an exact, explicitly confirmed answer does. */
export function validateOneDecisionOwnerAnswerV4(
  current: MobileBridgeOneDecisionOwnerAnswerV4Dto | null,
  expected: OneDecisionOwnerAnswerV4Binding,
  reply: string,
): void {
  if (!current || expected.ownerConfirmed !== true
    || expected.authoritativeHostRef !== current.authoritativeHostRef
    || expected.createdAt !== current.createdAt || expected.bindingDigest !== current.bindingDigest
    || expected.optionLabels.length !== current.optionLabels.length
    || expected.optionLabels.some((label, index) => label !== current.optionLabels[index])
    || expected.selectionIndexes.length < 1
    || (!current.multiSelect && expected.selectionIndexes.length !== 1)
    || expected.selectionIndexes.some((index, position) =>
      !current.selectableIndexes.includes(index)
      || (position > 0 && index <= expected.selectionIndexes[position - 1]))
    || reply !== expected.selectionIndexes.map((index) => current.optionLabels[index]).join(", ")
    || reply === ONE_DECISION_PRODUCT_SAFE_REJECT_REPLY) {
    throw new Error("Owner Decision answer is stale, unconfirmed, or does not match the original options");
  }
}
