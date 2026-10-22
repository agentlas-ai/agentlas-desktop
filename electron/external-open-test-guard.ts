import { appendFileSync } from "node:fs";

/**
 * Test rigs run the product on a person's own desktop. A flow that would open a window there (a sign-in page, for
 * example) must not do so during an automated run. A rig sets AGENTLAS_E2E_NO_OPEN_EXTERNAL=1; the opener then reports
 * "not opened" and the flow keeps its manual link. The variable can only turn an effect off, it never grants one.
 */
export function externalOpenSuppressedForTest(): boolean {
  return process.env.AGENTLAS_E2E_NO_OPEN_EXTERNAL === "1";
}

/**
 * Records the origin and path of a suppressed open in the file the rig named. The query is never written: it can carry
 * a state value or a challenge. Best effort; a rig that names no file gets no record.
 */
export function noteSuppressedExternalOpen(url: string): void {
  const file = process.env.AGENTLAS_E2E_OPEN_EXTERNAL_LOG?.trim();
  if (!file) return;
  try {
    const parsed = new URL(url);
    appendFileSync(file, `${parsed.origin}${parsed.pathname}\n`, { mode: 0o600 });
  } catch { /* a note is best effort */ }
}
