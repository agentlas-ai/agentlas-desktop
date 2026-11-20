import { decodeReceiptCard, isReceiptRowId, receiptPlainLine, type ReceiptCardValue, type ReceiptLive, type ReceiptLocale } from "../../shared/receipt-card";
import type { RemedyAction } from "../../shared/owner-remedy";

export const RECEIPT_CARD_FEATURE = "receipt-card" as const;
export const RECEIPT_CARD_IMPL = "receipt-card" as const;
export const RECEIPT_CARD_ATTRS = { "data-feature": RECEIPT_CARD_FEATURE, "data-impl": RECEIPT_CARD_IMPL } as const;

export function receiptOfRow(row: { id?: string; role?: string; text?: string | null } | null | undefined): ReceiptCardValue | null {
  if (!row || row.role !== "system" || !isReceiptRowId(row.id)) return null;
  return decodeReceiptCard(row.text);
}

export function receiptRowLine(row: { id?: string; role?: string; text?: string | null }, locale: ReceiptLocale, live?: ReceiptLive | null): string {
  const value = receiptOfRow(row);
  return value ? receiptPlainLine(value, live, locale) : "";
}

export type ReceiptTone = "ok" | "stop" | "problem";
export function receiptTone(value: ReceiptCardValue): ReceiptTone {
  if (value.kind === "turn-outcome") return value.cause === "stopped" ? "stop" : "problem";
  if (value.outcome === "done") return "ok";
  return value.outcome === "cancelled" || value.outcome === "expired" ? "stop" : "problem";
}

export const RECEIPT_ACTION_KEY: Readonly<Record<RemedyAction, "receipt.action.resend_other_ai" | "receipt.action.hand_to_personal_one" | "receipt.action.grant_permission"
  | "receipt.action.login" | "receipt.action.pick_project_folder" | "receipt.action.reopen_question">> = {
  resend_other_ai: "receipt.action.resend_other_ai", hand_to_personal_one: "receipt.action.hand_to_personal_one", grant_permission: "receipt.action.grant_permission",
  login: "receipt.action.login", pick_project_folder: "receipt.action.pick_project_folder", reopen_question: "receipt.action.reopen_question",
};
