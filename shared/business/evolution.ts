import type { BusinessCharge, BusinessResourceRef, BusinessScope, BusinessTaskAnchor } from './context';

export const BUSINESS_EVOLUTION_SCHEMA = 'agentlas.business-evolution.v1' as const;
export type BusinessEvolutionStage = 'observe' | 'generate' | 'build' | 'evaluate' | 'review' | 'promote' | 'execute' | 'feedback' | 'restore';
export interface BusinessHistoryPolicy {
  source: BusinessResourceRef;
  principalId: string;
  hostId: string;
  purpose: string;
  revision: number;
  collectionEnabled: boolean;
  analysisEnabled: boolean;
  allowedApplications: string[];
  allowedDomains: string[];
  allowedFields: string[];
  retentionMs: number;
  tombstoned: boolean;
}
/** A caller may supply raw fields, but they are never returned, stored or sent to an authority port. */
export interface BusinessWorkObservation {
  eventId: string;
  source: BusinessResourceRef;
  principalId: string;
  hostId: string;
  applicationId: string;
  domain: string | null;
  observedAt: number;
  kind: 'demonstration' | 'workflow' | 'feedback' | 'tool-schema';
  sensitive: boolean;
  steps: Array<{ action: 'read' | 'calculate' | 'filter' | 'write' | 'approve' | 'manual'; toolRef: string | null; fieldNames: string[]; outcome: 'success' | 'failure' | 'unknown' }>;
  fields?: Record<string, unknown>;
}
export interface BusinessMinimizedObservation {
  schema: typeof BUSINESS_EVOLUTION_SCHEMA;
  eventId: string;
  source: BusinessResourceRef;
  policyRevision: number;
  purpose: string;
  observedAt: number;
  expiresAt: number;
  kind: BusinessWorkObservation['kind'];
  applicationId: string;
  steps: BusinessWorkObservation['steps'];
  /** No field values, window titles, URL paths, pixels, transcripts or credentials. */
  redacted: true;
}
export interface BusinessEvolutionEnvelope {
  id: string;
  revision: number;
  principalId: string;
  deploymentId: string;
  scope: BusinessScope;
  hostId: string;
  purpose: string;
  stages: BusinessEvolutionStage[];
  sources: BusinessResourceRef[];
  tools: string[];
  editablePaths: string[];
  evaluatorRef: string;
  evaluatorRevision: number;
  budget: BusinessCharge;
  maxAttempts: number;
  usedAttempts: number;
  usedMinor: number;
  expiresAt: number;
  promotion: 'exact-review' | 'preapproved-bounded';
  approvalPolicyRevision: number;
  paused: boolean;
  revoked: boolean;
}
export interface BusinessEvolutionCandidate {
  id: string;
  revision: number;
  asset: BusinessResourceRef;
  envelopeId: string;
  envelopeRevision: number;
  sources: BusinessResourceRef[];
  toolRefs: string[];
  changedPaths: string[];
  baseRevision: number;
  proposalDigest: string | null;
  packageDigest: string | null;
  proposedRevision: number | null;
  /** Permission/schema/policy changes are separately approved provisioning, never self-improvement. */
  expandsPermissions: boolean;
  changesEvaluator: boolean;
  changesApprovalPolicy: boolean;
  tombstoned: boolean;
}
export interface BusinessFrozenEvaluation {
  candidateId: string;
  candidateRevision: number;
  proposalDigest: string;
  packageDigest: string;
  evaluatorRef: string;
  evaluatorRevision: number;
  fixtureDigest: string;
  synthetic: true;
  before: 'pass' | 'fail' | 'unknown';
  after: 'pass' | 'fail' | 'unknown';
  heldOut: 'pass' | 'fail' | 'unknown';
  negativeCases: 'pass' | 'fail' | 'unknown';
}
export interface BusinessEvolutionReview {
  receiptId: string;
  candidateId: string;
  candidateRevision: number;
  proposalDigest: string;
  packageDigest: string;
  baseRevision: number;
  evaluatorRevision: number;
  policyRevision: number;
  envelopeRevision: number;
  sourceRevisions: BusinessResourceRef[];
  expiresAt: number;
  /** Existing Workspace consumes this and performs its own one-use grant/base CAS. */
  state: 'issued' | 'consumed' | 'revoked';
}
/** Pinned by the existing Workspace's actual apply + same-package read-back, not a status label. */
export interface BusinessEvolutionRelease {
  id: string;
  candidateId: string;
  candidateRevision: number;
  asset: BusinessResourceRef;
  proposalDigest: string;
  packageDigest: string;
  reviewReceiptId: string;
  sourceRevisions: BusinessResourceRef[];
  applyReceipt: { operationId: string; previousRevision: number; revision: number; state: 'applied'; readBackDigest: string };
}
export interface BusinessEvolutionSnapshot {
  envelope: BusinessEvolutionEnvelope;
  candidate: BusinessEvolutionCandidate;
  evaluation: BusinessFrozenEvaluation | null;
  review: BusinessEvolutionReview | null;
  release: BusinessEvolutionRelease | null;
  liveAssetRevision: number;
  controlRevision: number;
  state: 'candidate' | 'draft' | 'review-ready' | 'active' | 'paused' | 'revoked' | 'unknown';
  operationId: string | null;
}
export interface BusinessEvolutionFeedback extends BusinessTaskAnchor {
  candidateId: string;
  candidateRevision: number;
  assetRevision: number;
  envelopeRevision: number;
  sourceRevisions: BusinessResourceRef[];
  result: BusinessResourceRef;
  resultDigest: string;
  readBackDigest: string;
  effect: 'settled' | 'pending' | 'uncertain';
  outcome: 'pass' | 'fail' | 'unknown';
}
