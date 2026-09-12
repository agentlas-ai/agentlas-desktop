/** Final execution ceiling, applied after every caller-specific permission policy. */
export function effectiveInvocationPermission(
  permission: unknown,
  planMode: boolean | undefined,
): "read" | "write" | "full" {
  if (planMode === true) return "read";
  return permission === "write" || permission === "full" ? permission : "read";
}
