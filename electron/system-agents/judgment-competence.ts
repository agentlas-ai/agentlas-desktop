import type { RuntimeSelection } from "../../shared/types";

/**
 * May this runtime's model decide which tools a task needs (the optional-tool judge)?
 *
 * judgment-capability.ts answers a different question — whether the adapter can run a judgment WITHOUT tools (isolation).
 * A model that is isolated can still judge badly: the hub's Qwen3-0.6B, pinned as the judge of its own Work turn, sent
 * 4/4 plain file/shell requests to agentlas-browser (QA 2026-10-28), and its hub tool probe had already failed (2/3,
 * receipt 2026-09-13).
 *
 * The verdict comes only from a measurement of that exact model, never from a runner kind or a model-name string:
 * - agentlas-local: the Local Models hub's capability receipt for the installation ("Check capabilities", tool probe —
 *   unforced choice among browser / file / shell tools with correct arguments). verified = pass, failed = fail.
 * - ollama, LM Studio, MLX: external-tool-judgment.ts runs the same probe on the server's model in the background the
 *   first time a judgment needs it, keyed by the model's identity there (Ollama digest); until then: unmeasured.
 * Both read the toolJudgment marker (right tool when needed AND no tool when none is), not toolUse (runs tools).
 *
 * Which runtimes need a measurement at all: those whose model is a weights file the owner loaded on this machine. Their
 * size is unbounded below (a 0.6B and a 30B load the same way), so the adapter cannot vouch for the judgment. Hosted
 * subscription CLIs, BYOK and Agentlas serving keep the prior rule (not_required). The kind only selects whether a
 * measurement is required; it never decides pass or fail.
 *
 * Unmeasured is treated like a failure (the safe side): the judge is skipped — or a measured pool runtime is borrowed —
 * and the run proceeds with its configured tools. A wrong judgment is worse than none: an undecided run attaches nothing
 * optional, while a wrong one attaches the wrong host (and before 2026-10-28 refused the turn).
 */
const OWNER_LOADED_WEIGHTS: ReadonlySet<string> = new Set(["agentlas-local", "ollama", "lmstudio", "mlx"]);

export interface ToolChoiceMeasurement {
  /** Runtime kind the measurement belongs to. */
  kind: string;
  /** Exact model id the runtime serves (agentlas-local: the installed file name). */
  model: string;
  /** agentlas-local: the hub installation the receipt names. */
  installationId?: string;
  result: "verified" | "failed";
  testedAt: string;
  source: "local-model-hub-capability-receipt" | "external-runtime-probe";
  /** external-runtime-probe: the model identity on its server the receipt was measured for. */
  identity?: string;
  reasonCodes?: string[];
}

export interface ToolJudgmentCompetence {
  schemaVersion: "agentlas.tool-judgment-competence.v1";
  status: "measured_pass" | "measured_fail" | "unmeasured" | "not_required";
  /** Machine code; safe for receipts and skip reasons. */
  reason: string;
  measuredAt?: string;
}

export function requiresMeasuredToolJudgment(selection: Pick<RuntimeSelection, "kind">): boolean {
  return OWNER_LOADED_WEIGHTS.has(selection.kind);
}

function installationIdFromSource(source: string | null | undefined): string | null {
  // agentlas-local:<enginePackageId>:<installationId>; the engine id itself contains colons.
  if (!source || !source.startsWith("agentlas-local:")) return null;
  const last = source.slice(source.lastIndexOf(":") + 1);
  return last.length > 0 ? last : null;
}

export function toolJudgmentCompetence(
  selection: Pick<RuntimeSelection, "kind" | "model" | "source">,
  measurements: readonly ToolChoiceMeasurement[],
): ToolJudgmentCompetence {
  const base = { schemaVersion: "agentlas.tool-judgment-competence.v1" as const };
  if (!requiresMeasuredToolJudgment(selection)) return { ...base, status: "not_required", reason: `${selection.kind}_tool_judgment_not_measured_by_policy` };
  const installationId = selection.kind === "agentlas-local" ? installationIdFromSource(selection.source) : null;
  const match = measurements
    .filter((row) => row.kind === selection.kind
      && (installationId ? row.installationId === installationId && (!selection.model || row.model === selection.model)
        : Boolean(selection.model) && row.model === selection.model))
    .sort((a, b) => Date.parse(b.testedAt) - Date.parse(a.testedAt))[0];
  if (!match) return { ...base, status: "unmeasured", reason: `${selection.kind}_tool_judgment_unmeasured` };
  return match.result === "verified"
    ? { ...base, status: "measured_pass", reason: `${selection.kind}_tool_judgment_measured_pass`, measuredAt: match.testedAt }
    : { ...base, status: "measured_fail", reason: `${selection.kind}_tool_judgment_measured_fail`, measuredAt: match.testedAt };
}

/** Pass or not required. Unmeasured and failed models do not judge. */
export function isToolJudgmentCompetent(competence: ToolJudgmentCompetence): boolean {
  return competence.status === "measured_pass" || competence.status === "not_required";
}

const MEASUREMENT_READ_TIMEOUT_MS = 2_000;

/** Every tool-judgment measurement the product holds. A slow or failed read is no measurement (never a pass). */
export async function readToolChoiceMeasurements(
  readLocalHub: () => Promise<Array<{ installationId: string; fileName: string; judgment: "verified" | "failed"; testedAt: string; reasonCodes: string[] }>>
    = async () => (await import("../local-model-hub/runtime-adapter")).readLocalModelToolChoiceReceipts(),
  readExternal: () => Promise<ToolChoiceMeasurement[]>
    = async () => (await import("./external-tool-judgment")).readExternalToolJudgmentMeasurements(),
): Promise<ToolChoiceMeasurement[]> {
  const bounded = async <T>(read: () => Promise<T[]>): Promise<T[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tool_choice_measurement_read_timeout")), MEASUREMENT_READ_TIMEOUT_MS); })]);
    } catch { return []; } finally { if (timer) clearTimeout(timer); }
  };
  const [hub, external] = await Promise.all([bounded(readLocalHub), bounded(readExternal)]);
  return [
    ...hub.map((row) => ({ kind: "agentlas-local", model: row.fileName, installationId: row.installationId, result: row.judgment,
      testedAt: row.testedAt, source: "local-model-hub-capability-receipt" as const, reasonCodes: row.reasonCodes })),
    ...external,
  ];
}
