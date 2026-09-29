/** Authentication evidence from the dedicated browser, never from cookie counts. */
export interface BrowserSessionProbeResult {
  state: "signed-in" | "signed-out" | "unverified";
  checkedAt: string;
  latencyMs: number;
  evidence: string;
  reasonCode?: string;
}
