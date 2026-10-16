/** Final execution ceiling, applied after every caller-specific permission policy. */
export function effectiveInvocationPermission(
  permission: unknown,
  planMode: boolean | undefined,
): "read" | "write" | "full" {
  if (planMode === true) return "read";
  return permission === "write" || permission === "full" ? permission : "read";
}

export type OnePermissionSelection = "auto" | "read" | "write" | "full";

// Auto resolves to read (conversation) or write (task), so it sits between them: never wider than write,
// never narrower than read. Anything unrecognised counts as read.
const ONE_PERMISSION_RANK: Record<OnePermissionSelection, number> = { read: 0, auto: 1, write: 2, full: 3 };
function onePermissionSelection(value: unknown): OnePermissionSelection {
  return value === "auto" || value === "write" || value === "full" ? value : "read";
}

/**
 * The narrower of two One permission selections. A turn the host starts on its own (continuation, automatic
 * retry, clarification, decision answer) may keep the authority its source run had, but never more than the
 * owner's current permission chip: lowering the chip must take effect on the next system turn too.
 */
export function narrowerOnePermission(a: unknown, b: unknown): OnePermissionSelection {
  const left = onePermissionSelection(a), right = onePermissionSelection(b);
  return ONE_PERMISSION_RANK[left] <= ONE_PERMISSION_RANK[right] ? left : right;
}
