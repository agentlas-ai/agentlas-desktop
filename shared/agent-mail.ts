// Agent mail (One's own address) — Desktop ↔ web contract.
// The web server owns the address, the monthly recipient meter and the
// entitlement; Desktop only reads and asks. Nothing here is decided locally.

export interface AgentMailEntitlement {
  available: boolean;
  mailbox: { read: boolean; send: boolean };
  addressLimit: number;
  monthlyRecipientLimit: number;
  usedThisMonth: number;
  remainingThisMonth: number;
  period: { key: string; start: string; end: string };
  address: string | null;
}

export interface AgentMailMailbox {
  id: string;
  address: string;
  status: "provisioning" | "active" | "deleted";
  provider: string;
  createdAt: string;
}

export interface AgentMailMessageSummary {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  preview: string;
  receivedAt: string;
  threadId: string | null;
  inReplyTo: string | null;
  providerMessageId: string;
  attachments: Array<{ filename: string | null; contentType: string | null; size: number }>;
}

export interface AgentMailMessage extends AgentMailMessageSummary {
  text: string;
  html: string;
}

export interface AgentMailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  /** Same key → same send (no second email). Desktop mints one per compose. */
  idempotencyKey?: string;
}

export interface AgentMailSendReceipt {
  id: string;
  status: "reserved" | "accepted" | "rejected" | "uncertain" | "delivered" | "bounced" | "complained";
  recipientCount: number;
  providerMessageId: string | null;
  errorCode: string | null;
  createdAt: string;
}

/** Machine-readable refusal. `code` comes from the server (e.g. agent_mail_monthly_limit_reached). */
export interface AgentMailError {
  ok: false;
  code: string;
  message: string;
  status: number | null;
  detail?: Record<string, unknown>;
}

export type AgentMailResult<T> = ({ ok: true } & T) | AgentMailError;

export type AgentMailStatus = AgentMailResult<{
  signedIn: boolean;
  entitlement: AgentMailEntitlement | null;
  mailbox: AgentMailMailbox | null;
}>;

export interface AgentMailIpc {
  status: () => Promise<AgentMailStatus>;
  issue: (input?: { displayName?: string }) => Promise<AgentMailResult<{ mailbox: AgentMailMailbox; created: boolean; entitlement: AgentMailEntitlement | null }>>;
  list: (input?: { cursor?: string | null; limit?: number; direction?: "inbound" | "outbound" }) => Promise<AgentMailResult<{ messages: AgentMailMessageSummary[]; nextCursor: string | null }>>;
  get: (id: string) => Promise<AgentMailResult<{ message: AgentMailMessage }>>;
  send: (input: AgentMailSendInput) => Promise<AgentMailResult<{ send: AgentMailSendReceipt; replay: boolean; remainingThisMonth: number }>>;
  remove: (id: string) => Promise<AgentMailResult<{ deleted: true }>>;
}

export const AGENT_MAIL_IPC_CHANNELS = {
  status: "agentMail:status",
  issue: "agentMail:issue",
  list: "agentMail:list",
  get: "agentMail:get",
  send: "agentMail:send",
  remove: "agentMail:remove",
} as const;
