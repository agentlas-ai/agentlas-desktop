/**
 * Which runtime kinds the generic ACP runner serves, kept free of imports so the effect-boundary modules can read it without loading
 * the ACP runner (acp.ts re-exports both names; nothing else defines them).
 */

/** Runtimes whose pickRunner path prefers ACP over the legacy hand driver. */
export const ACP_PREFERRED_KINDS = new Set(["cursor", "grok", "kimi"]);

/** `AGENTLAS_DISABLE_ACP=1` (or `=cursor,grok`) restores the legacy drivers. */
export function acpDisabledFor(kind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AGENTLAS_DISABLE_ACP ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "1" || raw === "true" || raw === "all") return true;
  return raw.split(/[,\s]+/).includes(kind);
}

/**
 * The adapter-effect scope kind a runtime kind reports under. The ACP runner opens its effect scope as "acp" for every agent it
 * serves, so a cursor/grok/kimi turn is attested by an "acp" scope; with ACP disabled for the kind the hand driver runs and reports
 * no scope, so the kind stays its own (and its coverage stays unknown, as before).
 */
export function adapterEffectScopeKind(kind: string, env: NodeJS.ProcessEnv = process.env): string {
  return ACP_PREFERRED_KINDS.has(kind) && !acpDisabledFor(kind, env) ? "acp" : kind;
}
