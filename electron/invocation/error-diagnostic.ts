import { redactOperationalSecrets } from "./event-secret-redaction";

// Recent V8 versions expose Error.stack through one intrinsic lazy accessor.
// Recognize its identity rather than treating an arbitrary custom getter as safe.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

export interface InvocationErrorDiagnosticContext {
  phase: "completion-chain-catch" | "undispatched-start";
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
