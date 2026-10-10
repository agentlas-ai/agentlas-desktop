import type { OneVaultBinding } from './one-vault';
export const ONE_PROVIDER_SCHEMA='agentlas.one-provider.v1' as const;
export type OneProviderErrorCode='authority_denied'|'authority_unavailable'|'generation_changed'|'input_changed'|'operation_conflict'|'provider_unauthenticated'|'provider_expired'|'provider_revoked'|'provider_permission'|'provider_ip_restricted'|'provider_workspace'|'provider_region'|'provider_quota'|'provider_billing'|'provider_rate_limited'|'provider_network'|'provider_failure'|'provider_uncertain'|'audio_invalid'|'cost_unknown'|'cost_exceeded'|'provider_route_unavailable';
export class OneProviderError extends Error{constructor(readonly code:OneProviderErrorCode){super(code);this.name='OneProviderError';}}
/** Read only from the current Main/Supervisor authority; never a free-form model DTO. */
export interface OneProviderAction {
  schema:typeof ONE_PROVIDER_SCHEMA;operationId:string;kind:'verify'|'tts';binding:OneVaultBinding;
  credentialGeneration:number;modelId:string;voiceId:string;outputFormat:'pcm_24000';textDigest:string;
  minDurationMs:number;maxDurationMs:number;expiresAt:number;
  /** Provider retention policy is a disclosed permission, not inferred from key possession. */
  enableProviderLogging:boolean;
}
export interface OneProviderAudio {
  artifactId:string;sha256:string;sizeBytes:number;mime:'audio/wav';container:'wav';codec:'pcm_s16le';
  sampleRate:24000;channels:1;decodedSamples:number;durationMs:number;
}
export interface OneProviderReceipt {
  schema:typeof ONE_PROVIDER_SCHEMA;operationId:string;actionDigest:string;
  taskId:string;runId:string;controlVersion:string|null;authorityRevision:string;permissionRevision:string;
  hostId:string;principalId:string;organizationId:string|null;workspaceId:string;resourceId:string;
  provider:'elevenlabs-audio';providerWorkspace:string;region:string;credentialGeneration:number;
  state:'verified'|'audio_ready'|'failed'|'outcome_unknown';errorCode:OneProviderErrorCode|null;
  audio:OneProviderAudio|null;observedAt:number;hostKeyId:string;signature:string;
}
