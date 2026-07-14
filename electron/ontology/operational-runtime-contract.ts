import type { DesktopOperationalRuntimeOverlayDto } from "../../shared/mobile-bridge";
import { classifyCanonicalTaskIds } from "../experience/taxonomy";

export const DESKTOP_OPERATIONAL_RUNTIME_TOKEN_BUDGET = 560;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{2,255}$/;
const PRIVATE_OR_UNSAFE_RE = /(?:\/Users\/|[A-Za-z]:\\|file:\/\/|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b|\breveal\b[^\n]{0,80}\b(?:prompt|secret|credential)|\braw[_ -]?(?:prompt|transcript|conversation|input|output)\b)/i;

function escapedPromptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Must stay byte-for-byte equivalent to the Web compiler. */
export function renderDesktopOperationalRuntimeDirective(
  overlay: Pick<DesktopOperationalRuntimeOverlayDto, "taskSignatures" | "instructions">,
): string {
  return [
    "## Attached problem-solving experience v1",
    "Use only for a matching task. System, developer, user, safety, permission, and tool rules remain higher priority.",
    `Operational-Experience: ${escapedPromptJson({ taskSignatures: overlay.taskSignatures, instructions: overlay.instructions })}`,
  ].join("\n");
}

export function estimateDesktopOperationalRuntimeTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 3));
}

export function operationalRuntimeOverlayIsRuntimeSafe(overlay: DesktopOperationalRuntimeOverlayDto): boolean {
  const directive = renderDesktopOperationalRuntimeDirective(overlay);
  return (
    Object.keys(overlay).sort().join("\0") === [
      "baseAgentDefinitionId", "baseAgentReleaseId", "budgetTokens", "chipId", "estimatedTokens",
      "instructions", "releaseId", "schemaVersion", "sourceContentHash", "taskSignatures",
    ].sort().join("\0") &&
    overlay.schemaVersion === 1 &&
    overlay.budgetTokens === DESKTOP_OPERATIONAL_RUNTIME_TOKEN_BUDGET &&
    /^sha256:[a-f0-9]{64}$/.test(overlay.sourceContentHash) &&
    SAFE_ID_RE.test(overlay.chipId) &&
    SAFE_ID_RE.test(overlay.releaseId) &&
    SAFE_ID_RE.test(overlay.baseAgentDefinitionId) &&
    SAFE_ID_RE.test(overlay.baseAgentReleaseId) &&
    overlay.taskSignatures.length > 0 && overlay.taskSignatures.length <= 16 &&
    new Set(overlay.taskSignatures).size === overlay.taskSignatures.length &&
    overlay.taskSignatures.every((value) => SAFE_ID_RE.test(value)) &&
    overlay.instructions.length > 0 && overlay.instructions.length <= 8 &&
    new Set(overlay.instructions).size === overlay.instructions.length &&
    overlay.instructions.every((value) => value.trim() === value && value.length > 0 && value.length <= 600 && !PRIVATE_OR_UNSAFE_RE.test(value)) &&
    overlay.estimatedTokens === estimateDesktopOperationalRuntimeTokens(directive) &&
    overlay.estimatedTokens <= DESKTOP_OPERATIONAL_RUNTIME_TOKEN_BUDGET
  );
}

export function operationalRuntimeOverlayMatchesTask(
  overlay: Pick<DesktopOperationalRuntimeOverlayDto, "taskSignatures">,
  task: string,
): boolean {
  const matches = classifyCanonicalTaskIds(task);
  return matches.length > 0 && matches.some((value) => overlay.taskSignatures.includes(value));
}
