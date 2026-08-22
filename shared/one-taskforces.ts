/**
 * Durable One Taskforce contracts.
 *
 * A Taskforce is a named group conversation controlled by One. One is always
 * present implicitly and cannot be removed. The member list stores standing
 * staff identities only; availability is projected from OneOrgState at read
 * time so an expired, archived, missing, or failed member remains visible for
 * an honest grey-state handoff instead of silently disappearing.
 */

export interface OneTaskforce {
  id: string;
  chatId: string;
  title: string;
  memberAgentIds: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface CreateOneTaskforceInput {
  title: string;
  memberAgentIds: string[];
}

export interface UpdateOneTaskforceInput {
  id: string;
  title: string;
  memberAgentIds: string[];
  expectedRevision?: number;
}

export interface RemoveOneTaskforceInput {
  id: string;
  expectedRevision?: number;
}
