import { realpathSync } from "node:fs";
import { effectiveInvocationPermission } from "../../shared/invocation-permission";
import { currentNativeExecution } from "../runtime/native-execution-context";
import { DelegatedAuthorityError, mintHostDelegatedGrant, type HostDelegatedGrant } from "../mcp/delegated-authority";
import { readWorkSessionChildAssignment, type WorkSessionChildAssignmentEvidence } from "./session-dispatch";

interface WorkChildAuthorityInput {
  runId?: string;
  chatId: string;
  permission: unknown;
  planMode?: boolean;
  workspace?: string | null;
  signal?: AbortSignal;
}
type ReadAssignment = (chatId: string, runId: string) => WorkSessionChildAssignmentEvidence | null;

/** Reconstitute authority in the child's live host scope from a durable accepted
 * assignment. No parent token crosses the asynchronous request/JSON boundary.
 * The parent turn may have ended; its accepted task, owner and folder must still
 * match. Current read/write/plan permissions never inherit an earlier full mode. */
export function workSessionChildDelegatedAuthority(
  input: WorkChildAuthorityInput,
  readAssignment: ReadAssignment = readWorkSessionChildAssignment,
): { delegatedGrant: HostDelegatedGrant; delegatedScopeKey: string } | undefined {
  if (!input.runId) return undefined;
  const runId = input.runId, chatId = input.chatId;
  const accepted = readAssignment(chatId, runId);
  if (!accepted) return undefined;
  const permission = effectiveInvocationPermission(input.permission, input.planMode);
  const rank = { read: 0, write: 1, full: 2 };
  if (rank[permission] > rank[accepted.acceptedPermission]) {
    throw new DelegatedAuthorityError("work_session_delegated_permission_exceeds_assignment");
  }
  if (permission !== "full") return undefined;
  const execution = currentNativeExecution();
  if (!execution || execution.runId !== runId || execution.chatId !== chatId) {
    throw new DelegatedAuthorityError("work_session_delegated_execution_mismatch");
  }
  const signal = input.signal ?? execution.signal;
  signal.throwIfAborted();
  let workspace: string;
  try { workspace = realpathSync.native(input.workspace ?? ""); }
  catch { throw new DelegatedAuthorityError("work_session_delegated_workspace_unavailable"); }
  if (workspace !== accepted.workspace) throw new DelegatedAuthorityError("work_session_delegated_workspace_mismatch");
  const identity = (value: WorkSessionChildAssignmentEvidence) => JSON.stringify([
    value.dispatchId, value.parentChatId, value.ownerScope, value.projectId, value.acceptedPermission, value.workspace,
  ]);
  const acceptedIdentity = identity(accepted);
  const delegatedScopeKey = `work-session:${accepted.dispatchId}`;
  const delegatedGrant = mintHostDelegatedGrant({
    runId, ownerChatId: chatId, scopeKey: delegatedScopeKey, workspace,
    permission: "full", authorizationRef: `work-session-assignment:${accepted.dispatchId}`,
    source: "owner-approved-step", signal,
    assertCurrent() {
      const current = readAssignment(chatId, runId);
      if (!current || identity(current) !== acceptedIdentity) {
        throw new DelegatedAuthorityError("work_session_delegated_assignment_changed");
      }
    },
  });
  return { delegatedGrant, delegatedScopeKey };
}
