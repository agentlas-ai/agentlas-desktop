import { realpathSync } from "node:fs";
import { effectiveInvocationPermission } from "../../shared/invocation-permission";

type Permission = "read" | "write" | "full";
declare const hostGrantBrand: unique symbol;
/** Host-local token. Copying its JSON does not copy its authority. */
export interface HostDelegatedGrant { readonly [hostGrantBrand]: true }
interface Grant {
  runId: string; ownerChatId: string; scopeKey: string; workspace: string;
  permission: "write" | "full"; authorizationRef: string;
  source: "owner-approved-step" | "host-step-escalation";
  signal: AbortSignal;
  /** Process-private host evidence revalidation; never a serialized permission claim. */
  assertCurrent?: () => void;
}
const grants = new WeakMap<HostDelegatedGrant, Readonly<Grant>>();
export class DelegatedAuthorityError extends Error {
  readonly turnDelivery = "not-dispatched" as const;
  constructor(readonly code: string, readonly detail: Readonly<Record<string, string>> = {}) {
    super(code); this.name = "DelegatedAuthorityError";
  }
}
function fail(code: string, detail: Record<string, string> = {}): never {
  throw new DelegatedAuthorityError(code, Object.freeze(detail));
}
function workspacePath(value: string): string {
  try { return realpathSync.native(value); } catch { return fail("delegated_authority_workspace_unavailable"); }
}

/** Call only after the host accepted an exact step escalation, never from a planner value or merely because a parent request
 * contains `full`. The authority is the owner's chip or approval (the executor setting); this token only proves to the nested
 * boundaries that the host accepted this step. It pins the grant to one run, step and workspace and lives as long as the caller's
 * signal, on every host (Main, daemon, Telegram, the automation scheduler, site generation, graph steps); it does not authorize
 * any external effect by itself. */
export function mintHostDelegatedGrant(input: Grant): HostDelegatedGrant {
  input.signal.throwIfAborted();
  if (!input.runId.trim() || !input.ownerChatId.trim() || !input.scopeKey.trim() || !input.authorizationRef.trim()
    || (input.permission !== "write" && input.permission !== "full")
    || !["owner-approved-step", "host-step-escalation"].includes(input.source)) {
    fail("delegated_authority_invalid_grant");
  }
  input.assertCurrent?.();
  const token = Object.freeze({}) as HostDelegatedGrant;
  grants.set(token, Object.freeze({ ...input, workspace: workspacePath(input.workspace) }));
  return token;
}

export interface DelegatedAuthorityContext {
  runId?: string; scopeKey?: string; workspace?: string | null;
  permission: unknown; fallbackPermission: Permission;
  planMode?: boolean; restrictedReadBoundary?: boolean; controlPlane?: boolean;
}
/** Revalidate at each nested boundary and immediately before runner dispatch.
 * Attempt IDs may change during repair; the exact accepted step scope may not. */
export function resolveHostDelegatedPermission(
  token: HostDelegatedGrant | undefined, context: DelegatedAuthorityContext,
): Permission {
  const ceiling = effectiveInvocationPermission(context.permission, context.planMode);
  if (context.restrictedReadBoundary || context.controlPlane || ceiling === "read") return "read";
  if (!token) return ceiling === "write" && context.fallbackPermission === "full" ? "write" : context.fallbackPermission;
  const grant = grants.get(token);
  if (!grant) return fail("delegated_authority_unrecognized_grant");
  grant.signal.throwIfAborted();
  grant.assertCurrent?.();
  if (context.runId !== grant.runId || context.scopeKey !== grant.scopeKey) fail("delegated_authority_step_mismatch");
  if (!context.workspace || workspacePath(context.workspace) !== grant.workspace) fail("delegated_authority_workspace_mismatch");
  return ceiling === "full" ? grant.permission : "write";
}

/** Records the permission actually supplied to the runner, not the parent's
 * requested chip. Capability preparation may not silently widen or narrow it. */
export function attestDelegatedPermission(input: {
  grant?: HostDelegatedGrant; context: DelegatedAuthorityContext;
  actualPermission: unknown; actualWorkspace?: string; signal?: AbortSignal;
}): { schemaVersion: "agentlas.delegated-authority.v1"; permission: Permission; scopeKey: string | null; authorizationRef: string | null } {
  input.signal?.throwIfAborted();
  const permission = resolveHostDelegatedPermission(input.grant, input.context);
  if (input.actualPermission !== permission) fail("delegated_authority_permission_mismatch", {
    expectedPermission: permission, actualPermission: String(input.actualPermission),
  });
  if (input.grant && permission !== "read"
    && (!input.actualWorkspace || workspacePath(input.actualWorkspace) !== workspacePath(input.context.workspace!))) {
    fail("delegated_authority_runner_workspace_mismatch");
  }
  const grant = input.grant ? grants.get(input.grant) : undefined;
  return { schemaVersion: "agentlas.delegated-authority.v1", permission,
    scopeKey: grant?.scopeKey ?? null, authorizationRef: grant?.authorizationRef ?? null };
}
