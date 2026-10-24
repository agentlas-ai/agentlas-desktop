import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for a secret a local server receives in a request (bearer, capability token, turn nonce) against
 * the value it holds. The length is compared first (the length of a generated token is not the secret); an expected value
 * that is not a non-empty string never matches, and neither does an actual value that is not a string.
 *
 * STRAT review 2026-10-17: electron/ had more than 15 hand-written copies of this helper, and three request-facing sites
 * still compared with !== (mcp-tools/proxy-server.ts bearer, app-factory/live-preview.ts presentation token,
 * runtime/codex-no-tools.ts turn nonce). With !==, a missing presentation token on both sides compared equal.
 */
export function secretEquals(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
