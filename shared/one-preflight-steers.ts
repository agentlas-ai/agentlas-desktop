import type { RuntimeSelection } from "./types";

export interface OnePreflightSubmissionInput {
  submissionId: string;
  chatId: string;
  userPrompt: string;
  runtimeSelection?: RuntimeSelection;
}

export interface OnePreflightSubmissionReceipt {
  submissionId: string;
  chatId: string;
  state: "open" | "reserved" | "bound" | "held" | "cancelled";
  parentRunId: string | null;
  createdAt: string;
}

export interface OnePreflightSteerInput {
  steerId: string;
  submissionId: string;
  chatId: string;
  userPrompt: string;
}

/** Exact recovery key; a chat's bounded display list is not a receipt lookup. */
export interface OnePreflightSteerLookupInput {
  steerId: string;
  submissionId: string;
  chatId: string;
}

export interface OnePreflightSteerReceipt {
  steerId: string;
  submissionId: string;
  chatId: string;
  userPrompt: string;
  status: "queued" | "claimed" | "attached" | "held" | "cancelled";
  parentRunId: string | null;
  createdAt: string;
}
