export type OneContextPermission = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
export type OneContextMode = "observe" | "interact";
export interface OneContextScope { oneId: string; taskId: string }
export interface OneContextTarget {
  kind: "window" | "display";
  sourceId: string;
  label: string;
  captureAvailable: boolean;
  interactionAvailable: boolean;
}
export interface OneContextTargetSelection {
  selectionId: string;
  expiresAt: string;
  targets: OneContextTarget[];
}
export interface OneContextGrant extends OneContextScope {
  grantId: string;
  target: OneContextTarget;
  mode: OneContextMode;
  createdAt: string;
  expiresAt: string;
  state: "active" | "revoked" | "expired";
  reasonCode?: string;
}
export interface OneContextReadiness {
  available: boolean;
  platform: string;
  screenPermission: OneContextPermission;
  accessibility: OneContextPermission;
  session: "awake" | "locked" | "sleeping" | "unknown";
  driverAvailable: boolean;
  humanBusy: boolean;
  observedAt: string;
  reasonCode?: string;
}
export interface OneContextCapture {
  grantId: string;
  target: OneContextTarget;
  capturedAt: string;
  staleAt: string;
  state: "fresh" | "stale";
  dataUrl: string;
}
export interface OneContextLeaseState {
  state: "idle" | "held" | "waiting";
  oneId?: string;
  taskId?: string;
  runId?: string;
  target?: string;
  expiresAt?: string;
  reasonCode?: string;
}
export interface OneContextSnapshot {
  oneId: string;
  observedAt: string;
  grants: OneContextGrant[];
  readiness: OneContextReadiness;
  latest: OneContextCapture | null;
  lease: OneContextLeaseState;
}
export interface OneContextGrantInput extends OneContextScope {
  selectionId: string;
  sourceId: string;
  durationMs: number;
  mode: OneContextMode;
}
export interface OneContextAPI {
  snapshot(input: { oneId: string; taskId?: string }): Promise<OneContextSnapshot>;
  targets(input: OneContextScope & { kind: "window" | "display" }): Promise<OneContextTargetSelection>;
  grant(input: OneContextGrantInput): Promise<OneContextSnapshot>;
  revoke(input: { oneId: string; grantId?: string }): Promise<OneContextSnapshot>;
  capture(input: OneContextScope & { grantId: string }): Promise<OneContextSnapshot>;
  openPermissions(input: { kind: "screen" | "accessibility" }): Promise<void>;
}
