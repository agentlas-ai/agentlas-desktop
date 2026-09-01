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
): ScienceLabDecisionProjection[] {
  const project = store.getProject(projectId);
  const lifecycle = store.getResearchLifecycleForProject(projectId);
  if (!project) throw new Error("science-project-not-found");
  if (!lifecycle) throw new Error("science-research-lifecycle-canonical-missing");

  const activeLoopSession = store.getActiveLoopSession(project.id);
  const activeEpisodes = activeLoopSession ? store.listResearchEpisodes(project.id, activeLoopSession.id) : [];
  const latestAnalysisPlan = store.listAnalysisSpecs(project.id, 1)[0] ?? null;

  return catalog.labs.map((lab) => {
    const episode = activeEpisodes
      .filter((candidate) => candidate.toolIntents.some((toolIntent) => toolIntent.labId === lab.id))
      .sort((left, right) => right.ordinal - left.ordinal)[0] ?? null;
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

    return createScienceLabDecisionProjection({
      project,
      labId: lab.id,
      episode,
      analysisPlan,
      artifacts: labArtifacts,
      currentArtifacts: scienceLabDecisionArtifactBindingsFromCurrent(currentArtifacts),
      blockingDecision,
      matchedTrigger: null,
    });
  });
}
