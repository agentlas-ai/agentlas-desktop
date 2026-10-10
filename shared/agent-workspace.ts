export type AgentWorkspaceFileRole = "instruction" | "skill" | "knowledge" | "manifest" | "tool" | "asset";
export interface AgentWorkspaceFile {
  path: string;
  role: AgentWorkspaceFileRole;
  blobHash: string;
  byteLength: number;
  executable: boolean;
  kind: "file" | "directory";
  binary?: boolean;
}
export interface AgentWorkspaceMemoryCandidate {
  id: string;
  title: string;
  content: string;
  contentNative?: string;
  kind: string;
  scope: string;
  evidence: string[];
  state: "eligible" | "scope_review" | "needs_evidence" | "proposed" | "applied";
}
export interface AgentWorkspaceChange {
  path: string;
  operation: "create" | "modify" | "delete";
  beforeHash: string | null;
  afterHash: string | null;
  beforeContent: string;
  afterContent: string;
  binary?: boolean;
  beforeExecutable?: boolean;
  afterExecutable?: boolean;
}
export interface AgentWorkspaceRevision {
  id: string;
  parentRevisionIds: string[];
  treeDigest: string;
  createdAt: string;
  operation: "baseline" | "external_edit" | "apply" | "sync" | "rollback";
  proposalId?: string;
  summary: string;
}
export interface AgentWorkspaceProposal {
  id: string;
  agentId: string;
  summary: string;
  status: "review_ready" | "applying" | "applied" | "rejected" | "stale" | "recovery_required";
  baseRevisionId: string;
  baseTreeDigest: string;
  proposedTreeDigest: string;
  proposalDigest: string;
  changes: AgentWorkspaceChange[];
  memoryEntryIds: string[];
  createdAt: string;
  appliedAt?: string;
  appliedRevisionId?: string;
  lastError?: string;
}
export interface AgentWorkspaceDiff extends AgentWorkspaceProposal {
  reviewedHash: string;
  reviewToken?: string;
}
export interface AgentWorkspaceSnapshot {
  agentId: string;
  rootPath: string;
  writable: boolean;
  currentRevisionId: string;
  treeDigest: string;
  canonicalEntry: string | null;
  files: AgentWorkspaceFile[];
  memoryCandidates: AgentWorkspaceMemoryCandidate[];
  proposals: AgentWorkspaceProposal[];
  history: AgentWorkspaceRevision[];
  cloudId: string | null;
  hubRef: string | null;
  activation: "ready" | "run_active" | "recovery_required";
}
export interface AgentWorkspaceReadFile {
  path: string;
  content: string;
  blobHash: string;
  byteLength: number;
  binary: boolean;
  truncated: boolean;
}
export interface AgentWorkspaceComparison {
  agentId: string;
  target: "cloud" | "hub";
  state: "in_sync" | "content_equal" | "local_ahead" | "cloud_ahead" | "diverged" | "unrelated" | "unknown" | "unavailable";
  reason?: string;
  localTreeDigest: string;
  remoteTreeDigest?: string;
  remoteRevisionId?: string;
  cloudETag?: string;
  changes: AgentWorkspaceChange[];
  proposalId?: string;
  outgoingChanges?: AgentWorkspaceChange[];
  canSend?: boolean;
  canReceive?: boolean;
  direction?: AgentWorkspaceSyncDirection;
  reviewedHash?: string;
  reviewToken?: string;
}
export type AgentWorkspaceSyncDirection = "receive" | "send";
export interface AgentWorkspaceRecovery {
  agentId: string;
  proposalId: string;
  currentTreeDigest: string;
  reviewedHash: string;
  reviewToken?: string;
  changes: AgentWorkspaceChange[];
}
export interface AgentWorkspaceMemoryCounts {
  counts: Record<string, number>;
  unavailableAgentIds: string[];
}
export interface AgentWorkspaceIpc {
  getWorkspace(agentId: string): Promise<AgentWorkspaceSnapshot>;
  memoryCounts(agentIds: string[]): Promise<AgentWorkspaceMemoryCounts>;
  listFiles(agentId: string, relativeDir?: string): Promise<AgentWorkspaceFile[]>;
  readFile(agentId: string, relativePath: string): Promise<AgentWorkspaceReadFile>;
  prepareFromMemory(input: { agentId: string; memoryEntryIds: string[]; targetPath?: string }): Promise<AgentWorkspaceProposal>;
  prepareFileChange(input: { agentId: string; targetPath: string; currentContent: string; proposedContent: string }): Promise<AgentWorkspaceProposal>;
  prepareRollback(input: { agentId: string; revisionId: string }): Promise<AgentWorkspaceProposal>;
  prepareFileOperation(input: { agentId: string; operation: "rename" | "delete"; path: string; newPath?: string }): Promise<AgentWorkspaceProposal>;
  getRecoveryDiff(agentId: string): Promise<AgentWorkspaceRecovery>;
  acknowledgeRecovery(input: { agentId: string; reviewedHash: string; reviewToken: string }): Promise<AgentWorkspaceSnapshot>;
  getDiff(proposalId: string): Promise<AgentWorkspaceDiff>;
  approveAndApply(input: { proposalId: string; reviewedHash: string; reviewToken: string }): Promise<AgentWorkspaceProposal>;
  reject(input: { proposalId: string }): Promise<AgentWorkspaceProposal>;
  compare(input: { agentId: string; target: "cloud" | "hub"; direction?: AgentWorkspaceSyncDirection }): Promise<AgentWorkspaceComparison>;
  sync(input: { agentId: string; target: "cloud" | "hub"; direction: AgentWorkspaceSyncDirection; reviewedHash: string; reviewToken: string }): Promise<AgentWorkspaceComparison | AgentWorkspaceProposal>;
}
