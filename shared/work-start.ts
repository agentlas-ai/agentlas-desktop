import type { FsPathGrant, ImageAttachment, OrchestrationTarget, RuntimeSelection } from './types';

export interface WorkStartOptions {
  permissions?: "read" | "write" | "full";
  planMode?: boolean;
  goalMode?: boolean;
  appsGenerateMode?: boolean;
  sessionRouting?: boolean;
  stormbreakerMode?: boolean;
  images?: ImageAttachment[];
  files?: Array<{ grant: FsPathGrant; name: string; mediaType: string; size: number; kind: 'file' | 'directory' }>;
  taskForceTargets?: OrchestrationTarget[];
}
export interface WorkStartInput {
  intentId: string;
  prompt: string;
  projectId?: string;
  runtimeSelection?: RuntimeSelection;
  options?: WorkStartOptions;
}
export interface WorkStartReceipt {
  intentId: string;
  inputDigest: string;
  projectId: string;
  chatId: string;
  taskId: string;
  prompt: string;
  options: WorkStartOptions;
  runtimeSelection: RuntimeSelection;
  status: 'queued' | 'claimed' | 'accepted' | 'failed';
  errorCode: string | null;
}
export interface WorkStartAPI {
  create(input: WorkStartInput): Promise<WorkStartReceipt>;
  get(input: { intentId: string; chatId: string }): Promise<WorkStartReceipt>;
  claim(input: { intentId: string; chatId: string }): Promise<{ receipt: WorkStartReceipt; claimToken: string | null }>;
  settle(input: { intentId: string; chatId: string; claimToken: string; accepted: boolean }): Promise<WorkStartReceipt>;
}
