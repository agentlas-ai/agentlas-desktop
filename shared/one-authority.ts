/** Value-free admission contract shared with Business; never renderer-authored identity. */
export interface OneActionAuthorityRequest {
  principalId: string; sessionId: string; oneId: string; hostId: string;
  scope: 'personal' | 'project' | 'organization'; organizationId: string | null;
  workspaceId: string; projectId: string | null; resourceId: string; purpose: string; payerId: string;
  action: string; taskId: string | null; runId: string | null; controlVersion: string | null;
  permissionRevision: string; credentialGeneration: string | null;
  sourceRefs: string[]; audience: 'owner' | 'organization';
}
export interface OneActionAuthorityDecision {
  decision: 'allow' | 'deny' | 'unknown'; revision: string; reason: string;
}
export interface OneActionAuthorityPort {
  /** A live read from the authoritative domain, including revocation and resource ACL. */
  current(request: Readonly<OneActionAuthorityRequest>): OneActionAuthorityDecision;
}
