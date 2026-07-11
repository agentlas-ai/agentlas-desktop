import type { InvocationRunReceipt } from "@/lib/types";

/**
 * Returns the product-owned expansion state for a receipt transition. Manual
 * toggles remain valid afterwards because callers only apply this when busy,
 * runId, or status changes.
 */
export function receiptAutoExpanded(
  busy: boolean,
  status: InvocationRunReceipt["status"] | null | undefined,
): boolean | null {
  if (!status) return null;
  if (busy || status === "running" || status === "cancelling") return true;
  if (status === "failed" || status === "interrupted" || status === "cancelled") return true;
  if (status === "completed") return false;
  return null;
}
