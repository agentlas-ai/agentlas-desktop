import { redactOperationalSecrets } from "./event-secret-redaction";

// Recent V8 versions expose Error.stack through one intrinsic lazy accessor.
// Recognize its identity rather than treating an arbitrary custom getter as safe.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

export interface InvocationErrorDiagnosticContext {
  phase: "completion-chain-catch" | "undispatched-start" | "runner-catch-all";
  executionSource?: string;
  runtimeKind?: string;
  scienceProjectId?: string;
  scienceTurnId?: string;
}

/** Read only data properties. Diagnostic collection must not invoke an error's
 * getters, serialization hooks or arbitrary context/SQL/request objects. */
function dataProperty(error: unknown, name: string): unknown {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined;
  try {
    let owner: object | null = error;
    for (let depth = 0; owner && depth < 3; depth += 1, owner = Object.getPrototypeOf(owner)) {
      const property = Object.getOwnPropertyDescriptor(owner, name);
      if (property) {
        if (Object.hasOwn(property, "value")) return property.value;
        if (name === "stack" && nativeStackGetter && property.get === nativeStackGetter) return nativeStackGetter.call(error);
        return undefined;
      }
    }
  } catch { /* A hostile or revoked proxy supplies no trustworthy diagnostic field. */ }
  return undefined;
}

/** A bounded local ledger payload, separate from the public runtime failure.
 * Typed machine codes are observations; no cause is inferred from error prose.
 * Stack limits match run-events' 20 entries / 240 characters per string entry. */
export function invocationErrorDiagnostic(error: unknown, options: {
  agentAppMode?: boolean;
  context: InvocationErrorDiagnosticContext;
  redactText: (value: string) => string;
}): Record<string, unknown> | null {
  // Browser-originated Agent App failures retain their existing opaque boundary.
  if (options.agentAppMode) return null;
  const text = (value: unknown, limit: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    try {
      // Redact before truncating so a long token cannot leave a plausible prefix.
      return redactOperationalSecrets(options.redactText(value)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, limit);
    } catch { return "[diagnostic-redaction-unavailable]"; }
  };
  const diagnostic: Record<string, unknown> = {
    schemaVersion: "agentlas.invocation-error-diagnostic.v1",
    diagnosticPhase: options.context.phase,
    thrownType: error === null ? "null" : typeof error,
  };
  for (const [property, field] of [["name", "exceptionName"], ["message", "exceptionMessage"]] as const) {
    const value = text(dataProperty(error, property), property === "name" ? 160 : 800);
    if (value !== undefined) diagnostic[field] = value;
  }
  if (typeof error === "string") diagnostic.exceptionMessage = text(error, 800);
  for (const [property, field] of [["code", "exceptionCode"], ["errno", "exceptionErrno"],
    ["sqliteCode", "sqliteCode"], ["sqliteExtendedCode", "sqliteExtendedCode"]] as const) {
    const value = dataProperty(error, property);
    if (typeof value === "number" && Number.isSafeInteger(value)) diagnostic[field] = value;
    else if (typeof value === "string") diagnostic[field] = text(value, 160);
  }
  const stack = text(dataProperty(error, "stack"), 64 * 1024);
  if (stack !== undefined) {
    const lines = stack.split(/\r?\n/gu);
    diagnostic.exceptionStackFrames = lines.slice(0, 20).map(line => line.slice(0, 240));
    diagnostic.exceptionStackTruncated = lines.length > 20 || lines.some(line => line.length > 240);
  }
  for (const field of ["executionSource", "runtimeKind", "scienceProjectId", "scienceTurnId"] as const) {
    const value = text(options.context[field], 160);
    if (value !== undefined) diagnostic[field] = value;
  }
  return diagnostic;
}

export type NativePreparationDiagnosticPhase = "native-ingress" | "native-ingress-authorize" | "native-ingress-read" | "native-ingress-validation" | "native-ingress-cleanup" | "native-prepared-start" | "native-prepared-quiescence" | "native-prepared-cleanup";
const MACHINE_CAUSE_LIMIT = 6;
const CHECKPOINT_DIAGNOSTIC_KINDS = new Set(["preparation.handoff", "judge", "team.prepare", "team.attachments-required", "briefing.prepare", "memory.prepare", "attachments.claim", "team.claim", "briefing.claim", "memory.claim", "images.transfer", "team.fail-start", "attachments.release"]);
/** Lookup must be the process-private driver observation, never a wire field or error property. */
export function nativeMachineCauseDiagnostic(error: unknown, checkpointKindForError?: (error: unknown) => unknown): Record<string, unknown> {
  const chain: Array<Record<string, unknown>> = [], seen = new Set<object>();
  let current: unknown = error, depth = 0, truncated = false, cyclic = false;
  while (current && (typeof current === "object" || typeof current === "function")) {
    if (seen.has(current)) { cyclic = true; break; }
    if (depth >= MACHINE_CAUSE_LIMIT) { truncated = true; break; }
    seen.add(current);
    const observation: Record<string, unknown> = { depth };
    const code = dataProperty(current, "code");
    if (typeof code === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(code)) {
      try { if (redactOperationalSecrets(code) === code) observation.code = code; } catch { /* no trustworthy code */ }
    }
    let kind: unknown; try { kind = checkpointKindForError?.(current); } catch { /* diagnostic lookup is not execution */ }
    if (typeof kind === "string" && CHECKPOINT_DIAGNOSTIC_KINDS.has(kind)) observation.checkpointKind = kind;
    if (Object.keys(observation).length > 1) chain.push(observation);
    current = dataProperty(current, "cause"); depth += 1;
  }
  return { machineCauseChain: chain, machineCauseTruncated: truncated, machineCauseCycle: cyclic };
}
/** Durable cause of a no-start refusal: the checkpoint that failed and the machine codes of the cause chain, outermost
 * first (causeCode is the innermost one). Content-free like the diagnostic below. */
export function preparationRefusalCause(error: unknown, checkpointKindForError?: (error: unknown) => unknown): { checkpointKind?: string; causeCode?: string; causeCodes?: string[] } {
  const chain = nativeMachineCauseDiagnostic(error, checkpointKindForError).machineCauseChain as Array<{ code?: unknown; checkpointKind?: unknown }>;
  const causeCodes = chain.flatMap(item => typeof item.code === "string" ? [item.code] : []);
  const checkpointKind = chain.find(item => typeof item.checkpointKind === "string")?.checkpointKind as string | undefined;
  return { ...(checkpointKind ? { checkpointKind } : {}), ...(causeCodes.length ? { causeCode: causeCodes[causeCodes.length - 1], causeCodes } : {}) };
}
/** Pre-boundary diagnostic is intentionally content-free: no request, prose, stack, SQL or path. */
export function nativePreparationErrorDiagnostic(error: unknown, context: {
  phase: NativePreparationDiagnosticPhase; startBoundaryCrossed?: boolean;
}, checkpointKindForError?: (error: unknown) => unknown): Record<string, unknown> {
  return { schemaVersion: "agentlas.native-preparation-error-diagnostic.v1", diagnosticPhase: context.phase,
    ...(typeof context.startBoundaryCrossed === "boolean" ? { startBoundaryCrossed: context.startBoundaryCrossed } : {}),
    ...nativeMachineCauseDiagnostic(error, checkpointKindForError) };
}
