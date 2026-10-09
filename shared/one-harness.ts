import type { CanonicalTask, InvocationRunReceipt } from './types';
import type { OneSurfaceManifestV1 } from './one-surface';
import type { SupervisorCommandReceipt, SupervisorSurface } from './one-supervisor';

export const ONE_HARNESS_SCHEMA = 'agentlas.one-harness.v1' as const;
/** Confirmed host refusals before any follow-up was dispatched. */
export const ONE_HARNESS_ACTION_REJECTION_CODES = [
  'one_harness_result_stale', 'one_harness_organization_policy_required', 'one_harness_effect_observation_required',
  'one_harness_manifest_changed', 'one_harness_artifact_changed', 'one_selection_artifact_mismatch',
  'one_selection_time_outside_media', 'one_selection_text_changed', 'one_selection_table_changed',
  'one_selection_chart_changed', 'one_selection_chart_point_changed',
] as const;

/** A host-authored view of the existing task scope, never an execution grant. */
export interface OneTaskScope {
  oneIdentityRef: string;
  taskId: string;
  runId: string;
  surface: SupervisorSurface;
  kind: 'personal' | 'project' | 'organization';
  projectId: string | null;
  organizationId: string | null;
  /** Legacy installed agent hierarchy; it is not a Business tenant. */
  legacyFirmId?: string | null;
  label: string;
  authorityRef: string;
  authorization: 'local-owner' | 'organization-policy-required';
  dataClass: 'personal' | 'project' | 'organization';
  payer: 'personal' | 'unknown';
}

export interface OneArtifactManifest {
  artifactRef: string;
  manifestId: string;
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
  revision: string;
  kind: 'document' | 'spreadsheet' | 'image' | 'video' | 'audio' | 'archive' | 'data' | 'other';
  label: string;
  verificationStatus: 'verified' | 'partially_verified' | 'unverified';
  sizeBytes: number | null;
  sha256: string | null;
  previewAvailable: boolean;
}

export interface OneTaskState {
  lifecycle: string;
  process: 'running' | 'stopping' | 'settled' | 'unknown';
  effect: 'settled' | 'uncertain' | 'pending';
  result: 'ready' | 'partial' | 'missing' | 'stale' | 'error';
  freshness: 'current' | 'stale';
}

export interface OneEffectReceipt {
  state: OneTaskState['effect'];
  receiptEventId: string | null;
  terminalEventId: string | null;
  observedBy: string | null;
  sourceRefs: string[];
  pendingEffectRefs: string[];
}

export interface OneHarnessResult {
  schema: typeof ONE_HARNESS_SCHEMA;
  oneId: string;
  taskId: string;
  runId: string;
  controlVersion: string;
  revision: string;
  observedAt: string;
  task: CanonicalTask;
  receipt: InvocationRunReceipt | null;
  scope: OneTaskScope;
  state: OneTaskState;
  text: string | null;
  surface: OneSurfaceManifestV1 | null;
  artifacts: OneArtifactManifest[];
  charts: OneResultChart[];
  effect: OneEffectReceipt;
  fallbackReason: string | null;
}

export interface OneResultChart {
  blockId: string;
  title: string;
  spec: Record<string, unknown>;
  series: Array<{ seriesId: string; label: string; pointCount: number }>;
}

export type OneArtifactSelection =
  | { kind: 'text'; text: string; blockId?: string }
  | { kind: 'table'; blockId: string; rowIds: string[]; columnIds: string[] }
  | { kind: 'chart'; blockId: string; seriesId?: string; pointIndex?: number }
  | { kind: 'media'; artifactRef: string; timeSeconds: number; endSeconds?: number };

export interface OneHarnessResultRequest {
  oneId: string;
  taskId: string;
  runId: string;
  expectedVersion?: string;
}

export interface OneHarnessActionRequest extends OneHarnessResultRequest {
  commandId: string;
  expectedVersion: string;
  revision: string;
  intent: 'follow-up';
  text: string;
  manifestId?: string;
  artifactRef?: string;
  selection?: OneArtifactSelection;
}

export type OneToolReadinessState = 'not-installed' | 'disabled' | 'needs-auth' | 'needs-configuration' | 'ready' | 'offline' | 'unknown';
/** Readiness observations contain no endpoint, launch arguments, or credential values. */
export interface OneToolReadiness {
  id: string;
  installedServerId: string | null;
  label: string;
  description: string;
  category: string;
  state: OneToolReadinessState;
  observedAt: string | null;
  reasonCode: string | null;
  tools: Array<{ name: string; description?: string }>;
  nextAction: 'install' | 'enable' | 'connect' | 'configure' | 'probe' | null;
}

export interface OneHarnessAPI {
  getResult(input: OneHarnessResultRequest): Promise<OneHarnessResult>;
  action(input: OneHarnessActionRequest): Promise<SupervisorCommandReceipt>;
  readiness(input: { oneId: string; query?: string; probeServerId?: string }): Promise<OneToolReadiness[]>;
}
