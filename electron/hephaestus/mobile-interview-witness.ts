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

/** Aliases one genuine native input to its explicit internal Builder request; never mints evidence. */
export function transferMobileBuildInterviewWitness(input: NativeBuildInput, request: NativeBuildRequest): void {
  const witness = inputs.get(input);
  inputs.delete(input);
  if (!witness || witness.runId !== input.runId || witness.signal !== input.signal
    || witness.workspace !== input.workspace || witness.answerText !== input.goal || !matches(witness, request)) return;
  requests.set(request, witness);
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
