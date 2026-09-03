import type { ScienceLabCapabilityCatalog } from "../../shared/science-lab-capability";
import {
  createScienceLabDecisionProjection,
  scienceLabDecisionArtifactBindingsFromCurrent,
  type ScienceLabDecisionProjection,
} from "../../shared/science-lab-decision-projection";
import type { ScienceStore } from "./store";

export function scienceLabDecisionProjectionsForProject(
  store: ScienceStore,
  projectId: string,
  catalog: ScienceLabCapabilityCatalog,
  options: { applyReviewReceipts?: boolean } = {},
): ScienceLabDecisionProjection[] {
  const project = store.getProject(projectId);
  const lifecycle = store.getResearchLifecycleForProject(projectId);
  if (!project) throw new Error("science-project-not-found");
  if (!lifecycle) throw new Error("science-research-lifecycle-canonical-missing");

  const loopSessions = store.listLoopSessions(project.id);
  const episodes = loopSessions.flatMap((session) => store.listResearchEpisodes(project.id, session.id));
  const latestAnalysisPlan = store.listAnalysisSpecs(project.id, 1)[0] ?? null;

  return catalog.labs.map((lab) => {
    const episode = episodes
      .filter((candidate) => candidate.toolIntents.some((toolIntent) => toolIntent.labId === lab.id))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.ordinal - left.ordinal)[0] ?? null;
    const analysisPlan = lab.id === "statistics-analysis" ? latestAnalysisPlan : null;
    const analysisDecision = analysisPlan
      ? store.listDecisionRequests(project.id, analysisPlan.id, ["presented", "queued", "deferred"])[0] ?? null
      : null;
    const lifecycleDecision = episode?.status === "waiting-for-decision"
      ? lifecycle.openBlockingDecisions[0] ?? null
      : null;
    const blockingDecision = analysisDecision
      ? {
        id: analysisDecision.id,
        projectId: project.id,
        contentSha256: analysisDecision.proposalSha256,
        status: analysisDecision.status as "queued" | "presented" | "deferred",
        question: analysisDecision.prompt.question,
      }
      : lifecycleDecision
        ? {
          id: lifecycleDecision.id,
          projectId: project.id,
          contentSha256: lifecycleDecision.contentSha256,
          status: "presented" as const,
          question: lifecycleDecision.summary,
        }
        : null;
    const labArtifacts = (episode?.result?.artifacts ?? []).flatMap((binding) => {
      const context = store.getArtifactContextForProject(project.id, binding.artifactId, binding.artifactVersion);
      if (!context || context.selectedVersion.contentSha256 !== binding.contentSha256) {
        throw new Error("science-lab-decision-artifact-episode-mismatch");
      }
      return context.linkage.labId === lab.id ? [binding] : [];
    });
    const currentArtifacts = labArtifacts.flatMap((binding) => {
      const artifact = store.getArtifactForProject(project.id, binding.artifactId);
      return artifact ? [artifact] : [];
    });

    const projectionInput = {
      project,
      labId: lab.id,
      episode,
      analysisPlan,
      artifacts: labArtifacts,
      currentArtifacts: scienceLabDecisionArtifactBindingsFromCurrent(currentArtifacts),
      blockingDecision,
      matchedTrigger: null,
    } as const;
    const neutral = createScienceLabDecisionProjection(projectionInput);
    const receipt = episode ? store.getLatestEpisodeResultReviewReceipt(project.id, episode.id, lab.id) : null;
    const receiptApplies = Boolean(receipt && episode?.result
      && receipt.projectVersion === neutral.basis.project.version
      && receipt.projectContentSha256 === neutral.basis.project.contentSha256
      && receipt.loopSessionId === episode.loopSessionId
      && receipt.episodeVersion === neutral.basis.episode?.version
      && receipt.episodeStateSha256 === neutral.basis.episode?.stateSha256
      && receipt.resultSha256 === neutral.basis.episode?.resultSha256
      && receipt.basisSha256 === neutral.basis.basisSha256
      && receipt.projectionSha256 === neutral.projectionSha256
      && JSON.stringify(receipt.artifacts) === JSON.stringify(neutral.basis.artifacts));
    return options.applyReviewReceipts !== false && receiptApplies && receipt
      ? createScienceLabDecisionProjection({
        ...projectionInput,
        matchedTrigger: receipt.selectedNextTrigger,
        matchedAction: receipt.selectedNextAction,
      })
      : neutral;
  });
}
