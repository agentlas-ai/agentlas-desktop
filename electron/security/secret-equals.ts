import { timingSafeEqual } from "node:crypto";

/**







 */
export function secretEquals(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
