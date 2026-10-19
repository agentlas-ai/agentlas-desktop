import type { BusinessSession } from './context';
import type { AgentMailStatus, AgentMailResult, AgentMailMailbox, AgentMailEntitlement, AgentMailThreadsInput, AgentMailThreadSummary, AgentMailUnread, AgentMailThreadDetail, AgentMailSendInput, AgentMailSendResult } from '../agent-mail';
export interface BusinessCompanyMailColleague { principalId: string; address: string; displayName: string | null }
export interface BusinessCompanyMailAPI {
  status(session: BusinessSession): Promise<AgentMailStatus>;
  issue(input: { session: BusinessSession; input: { localPart: string; displayName?: string } }): Promise<AgentMailResult<{ mailbox: AgentMailMailbox; created: boolean; revived: boolean; entitlement: AgentMailEntitlement | null }>>;
  threads(input: { session: BusinessSession; input: AgentMailThreadsInput }): Promise<AgentMailResult<{ threads: AgentMailThreadSummary[]; nextCursor: string | null; unread: AgentMailUnread | null }>>;
  thread(input: { session: BusinessSession; input: { threadId: string } }): Promise<AgentMailResult<AgentMailThreadDetail>>;
  colleagues(session: BusinessSession): Promise<AgentMailResult<{ colleagues: BusinessCompanyMailColleague[] }>>;
  pending(session: BusinessSession): Promise<AgentMailResult<{ pending: AgentMailSendInput | null }>>;
  send(input: { session: BusinessSession; input: AgentMailSendInput }): Promise<AgentMailResult<AgentMailSendResult>>;
  delegate(input: { session: BusinessSession; input: { threadId: string; instruction?: string; locale?: 'ko' | 'en' } }): Promise<AgentMailResult<{ chatId: string; runId: string | null }>>;
}
