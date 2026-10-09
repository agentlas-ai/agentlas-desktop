/** Amounts are USD reservations, never inferred provider prices. */
export interface OneBudgetConfigureInput {
  commandId:string;
  oneId:string;
  budgetId:string;
  expectedRevision:number;
  /** null explicitly restores observation-only admission. */
  limitUsd:number|null;
  reserveUsd:number;
  reservationTtlMs?:number;
}
export interface OneBudgetListInput { oneId:string; budgetId?:string }
export interface OneBudgetPolicy {
  oneId:string; budgetId:string; revision:number;
  limitUsd:number|null; reserveUsd:number; reservationTtlMs:number;
}
export interface OneBudgetSnapshot extends OneBudgetPolicy {
  admissionMode:"reservation"|"observe";
  /** This is only the subtotal with original billing receipt references. */
  knownSubtotalUsd:number;
  reservedUsd:number;
  availableUsd:number|null;
  unknownCount:number;
  unresolvedRuns:number;
  providerCapEnforced:false;
}
export interface OneBudgetConfigureReceipt { commandId:string; policy:OneBudgetPolicy }
export const ONE_BUDGET_REJECTION_CODES=["supervisor_budget_amount_invalid","supervisor_budget_revision_invalid",
  "supervisor_budget_reservation_invalid","supervisor_budget_revision_conflict","supervisor_budget_command_conflict",
  "supervisor_identifier_invalid","supervisor_input_invalid"] as const;
export type OneBudgetRejectionCode=typeof ONE_BUDGET_REJECTION_CODES[number];
export type OneBudgetConfigureResult=OneBudgetConfigureReceipt|{commandId:string;state:"rejected";reasonCode:OneBudgetRejectionCode};
export interface OneBudgetUsage {
  sourceId:string; runId:string; kind:"provider"|"inference";
  tokens:{inputTokens:number;outputTokens:number;cachedInputTokens?:number}|null;
  cost:{status:"measured"|"unknown";usd:number|null;sourceRef:string|null};
}
