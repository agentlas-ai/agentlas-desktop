import fs from "node:fs";
/** Native in-process evidence only. No request/DTO field can recreate these WeakMap identities. */
interface NativeBuildInput {
  runId: string;
  goal: string;
  workspace?: string;
  signal: AbortSignal;
}
interface NativeBuildRequest { request: string; workspace: string }
interface Witness {
  runId: string;
  workspace: string;
  answerText: string;
  signal: AbortSignal;
  current: () => boolean;
  questionCount: number;
  selectedAnswerCount: number;
}
export interface MobileBuildInterviewObservation {
  batchesAsked: 1;
  ownerResponseObserved: 1;
  selectedAnswerCount: number;
  deferredQuestionCount: number;
}
const inputs = new WeakMap<object, Witness>();
const requests = new WeakMap<object, Witness>();
function current(witness: Witness): boolean {
  if (witness.signal.aborted) return false;
  try { return witness.current(); } catch { return false; }
}
function matches(witness: Witness, request: NativeBuildRequest): boolean {
  return request.workspace === witness.workspace && request.request === witness.answerText && current(witness);
}

/** Created only by the native Mobile authority; capture follows its exact active-set/answer checks. */
export function createMobileBuildInterviewWitnessSource() {
  const generations = new WeakMap<object, object>();
  return {
    capture(input: NativeBuildInput, ownerRun: object, binding: {
      questionSetId: string;
      questionCount: number;
      selectedAnswerCount: number;
      stillCurrent: () => boolean;
    }): boolean {
      if (!input.workspace || !input.goal.trim() || !binding.questionSetId
        || !Number.isInteger(binding.questionCount) || binding.questionCount < 1 || binding.questionCount > 64
        || !Number.isInteger(binding.selectedAnswerCount) || binding.selectedAnswerCount < 0
        || binding.selectedAnswerCount > binding.questionCount || input.signal.aborted) return false;
      const generation = {};
      const witness: Witness = {
        runId: input.runId, workspace: input.workspace, answerText: input.goal, signal: input.signal,
        questionCount: binding.questionCount, selectedAnswerCount: binding.selectedAnswerCount,
        current: () => generations.get(ownerRun) === generation && binding.stillCurrent(),
      };
      generations.set(ownerRun, generation);
      if (!current(witness)) return false;
      inputs.set(input, witness);
      return true;
    },
  };
}

/** The same folder, by real path (the Build turn resolves its folder from a grant, which is the real path of what the phone's run recorded). */
function sameFolder(a: string, b: string): boolean {
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return a === b; }
}

/**
 * Aliases one genuine native input to its explicit internal Builder request; never mints evidence.
 * `builder`: the Build turn is a tracked one (hephaestus/build-turn-tracked.ts) and the Builder is handed its own run id and cancel signal, not the phone's: the witness is
 * re-bound to those, after the same checks against the native input. The folder is compared by real path, the answer text exactly.
 */
export function transferMobileBuildInterviewWitness(input: NativeBuildInput, request: NativeBuildRequest, builder?: { runId: string; signal: AbortSignal }): void {
  const witness = inputs.get(input);
  inputs.delete(input);
  if (!witness || witness.runId !== input.runId || witness.signal !== input.signal
    || witness.workspace !== input.workspace || witness.answerText !== input.goal) return;
  if (!builder) {
    if (!matches(witness, request)) return;
    requests.set(request, witness);
    return;
  }
  if (request.request !== witness.answerText || !current(witness) || !sameFolder(request.workspace, witness.workspace)) return;
  requests.set(request, { ...witness, runId: builder.runId, signal: builder.signal, workspace: request.workspace });
}

/** Optional observation only: missing/stale evidence falls back to the ordinary existing Build path. */
export function consumeMobileBuildInterviewWitness(
  request: NativeBuildRequest, runId: string, signal: AbortSignal,
): MobileBuildInterviewObservation | null {
  const witness = requests.get(request);
  requests.delete(request);
  if (!witness || witness.runId !== runId || witness.signal !== signal || !matches(witness, request)) return null;
  return { batchesAsked: 1, ownerResponseObserved: 1, selectedAnswerCount: witness.selectedAnswerCount,
    deferredQuestionCount: witness.questionCount - witness.selectedAnswerCount };
}
