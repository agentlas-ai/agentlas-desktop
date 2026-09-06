import { createHash } from "node:crypto";
import { RUNTIME_BACKEND_SET } from "../../shared/runtime-backends";
import { RUNTIME_KIND_SET } from "../../shared/runtime-kinds";
import type { RuntimeBackend, RuntimeKind, RuntimeSelection } from "../../shared/types";

const MAX_SOURCE_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 512;
const MAX_EFFORT_LENGTH = 80;
const ALLOWED_KEYS = new Set([
  "kind",
  "backend",
  "source",
  "role",
  "inherit",
  "model",
  "longContext",
  "effort",
]);

function invalidSelection(): never {
  throw new Error("science-runtime-selection-invalid");
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

/**
 * Normalize the stricter Science pin contract.
 *
 * A missing value is the legacy-compatible null case. Any non-null value that
 * is not an exact model-bearing orchestrator pin throws, so a caller cannot
 * silently turn malformed input into a global-runtime fallback.
 */
export function normalizeScienceRuntimeSelection(value: unknown): RuntimeSelection | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSelection();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) invalidSelection();

  const kind = boundedText(input.kind, 64);
  const backend = boundedText(input.backend, 64);
  const source = boundedText(input.source, MAX_SOURCE_LENGTH);
  const model = boundedText(input.model, MAX_MODEL_LENGTH);
  if (!kind || !RUNTIME_KIND_SET.has(kind) || !backend || !RUNTIME_BACKEND_SET.has(backend) || !source || !model) invalidSelection();
  if (input.role !== undefined && input.role !== "orchestrator") invalidSelection();
  if (input.inherit !== undefined && input.inherit !== false) invalidSelection();
  if (input.longContext !== undefined && typeof input.longContext !== "boolean") invalidSelection();

  let effort = "";
  if (input.effort !== undefined && input.effort !== null) {
    if (typeof input.effort !== "string" || input.effort.length > MAX_EFFORT_LENGTH) invalidSelection();
    effort = input.effort.trim();
  }

  return {
    kind: kind as RuntimeKind,
    backend: backend as RuntimeBackend,
    source,
    model,
    role: "orchestrator",
    inherit: false,
    longContext: input.longContext === true,
    effort,
  };
}

/** Stable receipt hash for the exact normalized Science pin. */
export function scienceRuntimeSelectionSha256(selection: RuntimeSelection): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(selection)), "utf8")
    .digest("hex");
}
