import type { OfficeEditIntent, OfficeTaskSelection } from "./office-document";

export interface OfficeTaskContextRequest {
  operationId: string;
  chatId: string;
  expectedContextRevision: number;
  selection: OfficeTaskSelection;
  edit?: OfficeEditIntent;
}

export interface OfficeTaskContextReceipt {
  operationId: string;
  chatId: string;
  taskId: string | null;
  revision: number;
  status: "acknowledged";
  selection: OfficeTaskSelection;
  edit?: OfficeEditIntent;
  fileName: string;
  acknowledgedAt: string;
}

export interface OfficeTaskContextAPI {
  get: (chatId: string) => Promise<{ revision: number; context: OfficeTaskContextReceipt | null }>;
  submit: (request: OfficeTaskContextRequest) => Promise<
    { ok: true; receipt: OfficeTaskContextReceipt } | { ok: false; reasonCode: string; currentRevision?: number }>;
  clear: (input: { chatId: string; expectedContextRevision: number }) => Promise<{ revision: number }>;
}
