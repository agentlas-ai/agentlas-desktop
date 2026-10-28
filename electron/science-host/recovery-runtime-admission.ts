import { ENTRY_GUARDED_RECOVERY_KINDS } from "../../shared/runtime-recovery";

/**
 * Runtime kinds a Science recovery turn may run on: exactly the kinds the shared runtime table
 * (shared/runtime-recovery.ts RUNTIME_FRESH_RECOVERY) marks entry-guarded. A new kind must answer
 * there or it does not compile; nothing here names a kind.
 *
 * The hand list this replaces (recovery-authority.ts until 2026-10-28) left ollama out although
 * ollama runs the same local tool loop, with the same guard, as lmstudio, mlx and agentlas-local.
 */
export const SCIENCE_RECOVERY_RUNTIME_KINDS: ReadonlySet<string> = ENTRY_GUARDED_RECOVERY_KINDS;

/** Host-port admission before a recovery capability is minted. Same refusal code as the capability writer. */
export function assertScienceRecoveryRuntimeAdmitted(selection: { kind?: unknown } | null | undefined): void {
  if (typeof selection?.kind !== "string" || !SCIENCE_RECOVERY_RUNTIME_KINDS.has(selection.kind)) {
    throw new Error("science_recovery_scope_invalid");
  }
}
