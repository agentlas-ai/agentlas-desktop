import { recordRunEvent } from "../store/run-events";
import { scienceStore } from "agentlas-science";
import { recordRunProducedFiles, runProducedFilesConsumerIsOpen } from "../harness/run-produced-files";
import { writeScienceSharedOutputFile } from "./shared-output-file";

interface ScienceArtifactOutputs {
  projectId: string; invocationRunId: string; operationId: string;
  artifacts: Array<{ artifactId: string; artifactVersion: number; contentSha256: string;
    custody?: { eventId: string; sequence: number; runId: string };
    mutationCustody?: { requestId: string; eventId: string; sequence: number } }>;
}
const fail = (): never => { throw new Error("science_artifact_output_scope_changed"); };

/** Lab artifacts keep their native renderer. This exports their actual immutable
 * canonical JSON to the same output ledger/preview rail as every other Task. */
function projectScienceArtifactHostOutputs(input: ScienceArtifactOutputs): number {
  const store = scienceStore(), turn = store.getTurnByInvocationRunId(input.invocationRunId);
  const binding = turn && store.getConversationRuntimeBinding(input.projectId, turn.conversationId);
  if (!turn || turn.projectId !== input.projectId || turn.status !== "running" || !binding
    || binding.runtimeChatId !== turn.runtimeChatId || !Array.isArray(input.artifacts) || input.artifacts.length > 64) return fail();
  store.assertScienceTurnExecutionAuthority(turn);
  const executions = store.listToolExecutionsForInvocation(input.invocationRunId);
  const outputs: string[] = [];
  for (const ref of input.artifacts) {
    const execution = executions.find(item => item.projectId === input.projectId && item.invocationRunId === input.invocationRunId
      && item.turnId === turn.id && item.phase === "committed" && item.artifactId === ref.artifactId && item.artifactVersion === ref.artifactVersion);
    let committed = execution && store.getRunArtifactBinding(input.projectId, execution.runId);
    let imageOutput: { extension: string; bytes: Buffer } | null = null;
    if (!execution && ref.custody) {
      const custody = ref.custody;
      if (!Number.isSafeInteger(custody.sequence) || custody.sequence < 1) return fail();
      const event = store.listTurnEvents(input.projectId, turn.id, custody.sequence - 1, 1)[0];
      const payload = event?.payload;
      const run = store.getResearchRunForProject(input.projectId, custody.runId);
      const candidate = run && store.getRunArtifactBinding(input.projectId, run.id);
      if (!event || event.id !== custody.eventId || event.sequence !== custody.sequence || event.turnId !== turn.id
        || event.invocationRunId !== input.invocationRunId || event.projectId !== input.projectId
        || event.conversationId !== turn.conversationId || event.sourceDeliveryId !== null
        || event.kind !== "tool" || event.code !== "science.materializer-output.committed"
        || payload.schema !== "agentlas.science.materializer-output-custody.v1" || payload.projectId !== input.projectId
        || payload.invocationRunId !== input.invocationRunId || payload.effectId !== input.operationId
        || payload.artifactId !== ref.artifactId || payload.artifactVersion !== ref.artifactVersion || payload.contentSha256 !== ref.contentSha256
        || !run || run.status !== "succeeded" || payload.runId !== run.id || payload.toolId !== run.toolId
        || !candidate || payload.bindingId !== candidate.id || payload.outputId !== candidate.outputId
        || payload.outputSha256 !== candidate.outputSha256) return fail();
      const output = run.outputs.find(item => item.id === candidate.outputId && item.sha256 === candidate.outputSha256
        && item.artifactId === ref.artifactId && item.artifactVersion === ref.artifactVersion);
      if (!output) return fail();
      const savedBytes = store.readRunBlob(output);
      if (output.mimeType === "image/png" || output.mimeType === "image/svg+xml")
        imageOutput = { extension: output.mimeType === "image/png" ? "png" : "svg", bytes: savedBytes };
      committed = candidate;
    }
    let mutationVerified = false;
    if (ref.mutationCustody) {
      const custody = ref.mutationCustody;
      if (typeof custody !== "object" || Array.isArray(custody)
        || Object.keys(custody).length !== 3 || Object.keys(custody).some(key => !["requestId", "eventId", "sequence"].includes(key))) return fail();
      const reader = (require("agentlas-science/dist/artifact-host-outputs") as {
        readScienceArtifactMutationOutput?: (store: unknown, input: unknown) => { artifactId: string; artifactVersion: number; contentSha256: string } | null;
      }).readScienceArtifactMutationOutput;
      const mutation = reader?.(store, { projectId: input.projectId, invocationRunId: input.invocationRunId,
        requestId: custody.requestId, eventId: custody.eventId, sequence: custody.sequence });
      if (!mutation || mutation.artifactId !== ref.artifactId || mutation.artifactVersion !== ref.artifactVersion
        || mutation.contentSha256 !== ref.contentSha256) return fail();
      mutationVerified = true;
    }
    const artifact = store.getResearchAssistantArtifactVersionForProject(input.projectId, ref.artifactId, ref.artifactVersion);
    if ((!mutationVerified && (!committed || committed.artifactId !== ref.artifactId || committed.artifactVersion !== ref.artifactVersion
      || committed.artifactContentSha256 !== ref.contentSha256)) || !artifact || artifact.projectId !== input.projectId
      || artifact.version.contentSha256 !== ref.contentSha256
      || (ref.custody && artifact.version.provenance.sourceRunId !== ref.custody.runId)) return fail();
    const bytes = Buffer.from(JSON.stringify({ schema: "agentlas.science.shared-artifact-output.v1", projectId: input.projectId,
      artifactId: artifact.artifactId, artifactVersion: artifact.version.version, contentSha256: artifact.version.contentSha256,
      kind: artifact.kind, title: artifact.title, rendererId: artifact.version.rendererId, rendererVersion: artifact.version.rendererVersion,
      payload: artifact.version.payload, semantic: artifact.version.semantic, provenance: artifact.version.provenance }, null, 2) + "\n", "utf8");
    const title = artifact.title.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "research-result";
    outputs.push(writeScienceSharedOutputFile("science-artifacts", input.projectId, `${title}-${artifact.artifactId.slice(0, 8)}.artifact.json`, bytes));
    if (imageOutput) outputs.push(writeScienceSharedOutputFile("science-artifacts", input.projectId,
      `${title}-${artifact.artifactId.slice(0, 8)}.${imageOutput.extension}`, imageOutput.bytes));
  }
  store.assertScienceTurnExecutionAuthority(store.getTurnByInvocationRunId(input.invocationRunId) ?? turn);
  return recordRunProducedFiles(input.invocationRunId, input.operationId, outputs);
}

/** Structured evidence for the shared port boundary, independent of prose or
 * provider output. A missing consumer identifies an invocation-owner mismatch. */
export function recordScienceArtifactHostOutputs(input: ScienceArtifactOutputs): number {
  const observe = (phase: "requested" | "recorded" | "refused", projectedCount?: number) => {
    try {
      const store = scienceStore(), turn = store.getTurnByInvocationRunId(input.invocationRunId);
      recordRunEvent({ runId: input.invocationRunId, kind: "science_artifact_output_projection", chatId: turn?.runtimeChatId,
        payload: { phase, processId: process.pid, consumerOpen: runProducedFilesConsumerIsOpen(input.invocationRunId),
          callbackAvailable: true, turnStatus: turn?.status ?? null, turnProjectMatches: turn?.projectId === input.projectId,
          executionCount: store.listToolExecutionsForInvocation(input.invocationRunId).length,
          artifactRefCount: input.artifacts.length, custodyRefCount: input.artifacts.filter(ref => ref.custody).length,
          ...(projectedCount === undefined ? {} : { projectedCount }) } });
    } catch { /* Diagnostics do not decide output custody or invocation progress. */ }
  };
  observe("requested");
  try { const count = projectScienceArtifactHostOutputs(input); observe("recorded", count); return count; }
  catch (error) { observe("refused"); throw error; }
}
