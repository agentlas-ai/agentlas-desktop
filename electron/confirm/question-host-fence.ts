/** Internal host metadata. A persisted digest is a comparison pin, never a capability. */
export interface QuestionContinuationHostFence {
  ownerSha256: string;
  scopeSha256: string;
  controlSha256: string;
}
const SHA = /^[a-f0-9]{64}$/;
export function parseQuestionContinuationHostFence(value: unknown): QuestionContinuationHostFence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !["ownerSha256", "scopeSha256", "controlSha256"].every(key =>
    typeof row[key] === "string" && SHA.test(row[key] as string))) return null;
  return { ownerSha256: row.ownerSha256 as string, scopeSha256: row.scopeSha256 as string,
    controlSha256: row.controlSha256 as string };
}
export function questionContinuationHostFenceMatches(a: QuestionContinuationHostFence | null,
  b: QuestionContinuationHostFence | null): boolean {
  return !!a && !!b && a.ownerSha256 === b.ownerSha256 && a.scopeSha256 === b.scopeSha256
    && a.controlSha256 === b.controlSha256;
}
