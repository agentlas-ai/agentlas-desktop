import { userDataPath } from "../runtime-paths";
import { ScienceStore } from "./store";
import { ScienceConversationService } from "./conversation-service";
import { ScienceToolGateway } from "./tool-gateway";
import { ScienceChemistryValidator } from "./chemistry-validator";
import { ScienceAcademicSearchService } from "./academic-search";
import { ScienceAcademicFullTextService } from "./academic-full-text";
import { ScienceAstronomyCatalogService } from "./astronomy-catalog";
import { ScienceBiodiversityCatalogService } from "./biodiversity-catalog";
import { SciencePaleontologyCatalogService } from "./paleontology-catalog";
import { SciencePaleontologyAnalysisService } from "./paleontology-analysis";
import { SciencePaleontologyCandidateComparisonService } from "./paleontology-candidate-comparison";
import { ScienceDeextinctionFeasibilityService } from "./deextinction-feasibility";
import { ScienceEarthquakeCatalogService } from "./earthquake-catalog";
import { ScienceNoaaCoopsWaterLevelService } from "./noaa-coops-water-level";
import { ScienceEconomicsCatalogService } from "./economics-catalog";
import { ScienceEconomicsAnalysisService } from "./economics-analysis";
import { ScienceGenomicsCatalogService } from "./genomics-catalog";
import { ScienceComparativeGenomicsService } from "./comparative-genomics";
import { ScienceExtantReferenceAssemblyService } from "./extant-reference-assemblies";
import { ScienceComparativeGenomicsTableService } from "./comparative-genomics-table";
import { ScienceHypotheticalAsrService } from "./hypothetical-asr";
import { ScienceExtantArchosaurLocusPanelService } from "./extant-archosaur-locus-panel";
import { ScienceMaterialsCatalogService } from "./materials-catalog";
import { SciencePhysicsHepDataLiveService, SciencePhysicsInspireLiveService } from "./physics-live-sources";
import { ScienceScientificDataService } from "./scientific-data";
import { ScienceJournalPublicationService } from "./journal-publication";
import { ScienceManuscriptRenderService } from "./manuscript";
import { ScienceArtifactPublicationValidator } from "./artifact-publication-validator";
import { ScienceDomainAnalysisService } from "./domain-analysis";
import { ScienceEarthAnalysisService } from "./earth-analysis";
import { SciencePhysicsAnalysisService } from "./physics-analysis";
import { ScienceAstronomyAnalysisService } from "./astronomy-analysis";
import {
  resolveExactVerifiedScienceRenderer,
  resolveExactVerifiedScienceRendererExecutor,
  resolveExactVerifiedScienceRendererExecutorBinding,
  resolveVerifiedScienceRenderer,
  resolveVerifiedScienceRendererExecutor,
} from "../extensions/science";
import { ScienceLongRunBridge, type ScienceLongRunProjectionSink } from "./long-run-bridge";
import { ScienceEvidenceGraphService } from "./evidence-graph";

let activeStore: ScienceStore | null = null;
let activeConversationService: ScienceConversationService | null = null;
let activeToolGateway: ScienceToolGateway | null = null;
let activeChemistryValidator: ScienceChemistryValidator | null = null;
let activeAcademicSearchService: ScienceAcademicSearchService | null = null;
let activeAcademicFullTextService: ScienceAcademicFullTextService | null = null;
let activeAstronomyCatalogService: ScienceAstronomyCatalogService | null = null;
let activeAstronomyAnalysisService: ScienceAstronomyAnalysisService | null = null;
let activeBiodiversityCatalogService: ScienceBiodiversityCatalogService | null = null;
let activePaleontologyCatalogService: SciencePaleontologyCatalogService | null = null;
let activePaleontologyAnalysisService: SciencePaleontologyAnalysisService | null = null;
let activePaleontologyCandidateComparisonService: SciencePaleontologyCandidateComparisonService | null = null;
let activeDeextinctionFeasibilityService: ScienceDeextinctionFeasibilityService | null = null;
let activeEarthquakeCatalogService: ScienceEarthquakeCatalogService | null = null;
let activeNoaaCoopsWaterLevelService: ScienceNoaaCoopsWaterLevelService | null = null;
let activeEconomicsCatalogService: ScienceEconomicsCatalogService | null = null;
let activeEconomicsAnalysisService: ScienceEconomicsAnalysisService | null = null;
let activeGenomicsCatalogService: ScienceGenomicsCatalogService | null = null;
let activeComparativeGenomicsService: ScienceComparativeGenomicsService | null = null;
let activeExtantReferenceAssemblyService: ScienceExtantReferenceAssemblyService | null = null;
let activeComparativeGenomicsTableService: ScienceComparativeGenomicsTableService | null = null;
let activeHypotheticalAsrService: ScienceHypotheticalAsrService | null = null;
let activeExtantArchosaurLocusPanelService: ScienceExtantArchosaurLocusPanelService | null = null;
let activeMaterialsCatalogService: ScienceMaterialsCatalogService | null = null;
let activePhysicsInspireLiveService: SciencePhysicsInspireLiveService | null = null;
let activePhysicsHepDataLiveService: SciencePhysicsHepDataLiveService | null = null;
let activeScientificDataService: ScienceScientificDataService | null = null;
let activeJournalPublicationService: ScienceJournalPublicationService | null = null;
let activeManuscriptRenderService: ScienceManuscriptRenderService | null = null;
let activeArtifactPublicationValidator: ScienceArtifactPublicationValidator | null = null;
let activeDomainAnalysisService: ScienceDomainAnalysisService | null = null;
let activeEarthAnalysisService: ScienceEarthAnalysisService | null = null;
let activePhysicsAnalysisService: SciencePhysicsAnalysisService | null = null;
let activeLongRunBridge: ScienceLongRunBridge | null = null;
let activeEvidenceGraphService: ScienceEvidenceGraphService | null = null;

export async function installScienceLongRunBridge(
  sink: ScienceLongRunProjectionSink,
  options: { reconcile?: boolean } = {},
): Promise<void> {
  activeLongRunBridge?.close();
  activeLongRunBridge = new ScienceLongRunBridge(scienceStore(), sink);
  await activeLongRunBridge.start({ reconcile: options.reconcile });
}

export function scienceStore(): ScienceStore {
  if (!activeStore) {
    activeStore = new ScienceStore(userDataPath("extensions", "agentlas-science", "science.sqlite"));
  }
  return activeStore;
}

export function scienceConversationService(): ScienceConversationService {
  if (!activeConversationService) activeConversationService = new ScienceConversationService(
    scienceStore(), undefined, scienceToolGateway(), undefined, scienceEvidenceGraphService(),
  );
  return activeConversationService;
}

export function scienceEvidenceGraphService(): ScienceEvidenceGraphService {
  if (!activeEvidenceGraphService) activeEvidenceGraphService = new ScienceEvidenceGraphService(scienceStore());
  return activeEvidenceGraphService;
}

export function scienceToolGateway(): ScienceToolGateway {
  if (!activeToolGateway) activeToolGateway = new ScienceToolGateway(scienceStore(), {
    resolve: (rendererId, artifactKind) => resolveVerifiedScienceRenderer(rendererId, artifactKind)?.binding ?? null,
    resolveExact: (binding, artifactKind) => resolveExactVerifiedScienceRenderer(binding, artifactKind)?.binding ?? null,
    resolveExecutor: (rendererId, artifactKind, executorId) => resolveVerifiedScienceRendererExecutor(rendererId, artifactKind, executorId),
    resolveExactExecutor: (binding, artifactKind, executorId) => resolveExactVerifiedScienceRendererExecutor(binding, artifactKind, executorId),
    resolveExactExecutorBinding: (rendererBinding, executorBinding, artifactKind) =>
      resolveExactVerifiedScienceRendererExecutorBinding(rendererBinding, executorBinding, artifactKind),
  });
  return activeToolGateway;
}

export function scienceChemistryValidator(): ScienceChemistryValidator {
  if (!activeChemistryValidator) activeChemistryValidator = new ScienceChemistryValidator({
    resolveExact: (binding, artifactKind, executorId) => resolveExactVerifiedScienceRendererExecutor(binding, artifactKind, executorId),
  });
  return activeChemistryValidator;
}

export function scienceAcademicSearchService(): ScienceAcademicSearchService {
  if (!activeAcademicSearchService) activeAcademicSearchService = new ScienceAcademicSearchService(scienceStore());
  return activeAcademicSearchService;
}

export function scienceAcademicFullTextService(): ScienceAcademicFullTextService {
  if (!activeAcademicFullTextService) activeAcademicFullTextService = new ScienceAcademicFullTextService(scienceStore());
  return activeAcademicFullTextService;
}

export function scienceAstronomyCatalogService(): ScienceAstronomyCatalogService {
  if (!activeAstronomyCatalogService) activeAstronomyCatalogService = new ScienceAstronomyCatalogService(scienceStore());
  return activeAstronomyCatalogService;
}

export function scienceAstronomyAnalysisService(): ScienceAstronomyAnalysisService {
  if (!activeAstronomyAnalysisService) activeAstronomyAnalysisService = new ScienceAstronomyAnalysisService(scienceStore());
  return activeAstronomyAnalysisService;
}

export function scienceBiodiversityCatalogService(): ScienceBiodiversityCatalogService {
  if (!activeBiodiversityCatalogService) activeBiodiversityCatalogService = new ScienceBiodiversityCatalogService(scienceStore());
  return activeBiodiversityCatalogService;
}

export function sciencePaleontologyCatalogService(): SciencePaleontologyCatalogService {
  if (!activePaleontologyCatalogService) activePaleontologyCatalogService = new SciencePaleontologyCatalogService(scienceStore());
  return activePaleontologyCatalogService;
}

export function sciencePaleontologyAnalysisService(): SciencePaleontologyAnalysisService {
  if (!activePaleontologyAnalysisService) activePaleontologyAnalysisService = new SciencePaleontologyAnalysisService(scienceStore());
  return activePaleontologyAnalysisService;
}

export function sciencePaleontologyCandidateComparisonService(): SciencePaleontologyCandidateComparisonService {
  if (!activePaleontologyCandidateComparisonService) {
    activePaleontologyCandidateComparisonService = new SciencePaleontologyCandidateComparisonService(scienceStore());
  }
  return activePaleontologyCandidateComparisonService;
}

export function scienceDeextinctionFeasibilityService(): ScienceDeextinctionFeasibilityService {
  if (!activeDeextinctionFeasibilityService) activeDeextinctionFeasibilityService = new ScienceDeextinctionFeasibilityService(scienceStore());
  return activeDeextinctionFeasibilityService;
}

export function scienceEarthquakeCatalogService(): ScienceEarthquakeCatalogService {
  if (!activeEarthquakeCatalogService) activeEarthquakeCatalogService = new ScienceEarthquakeCatalogService(scienceStore());
  return activeEarthquakeCatalogService;
}

export function scienceNoaaCoopsWaterLevelService(): ScienceNoaaCoopsWaterLevelService {
  if (!activeNoaaCoopsWaterLevelService) activeNoaaCoopsWaterLevelService = new ScienceNoaaCoopsWaterLevelService(scienceStore());
  return activeNoaaCoopsWaterLevelService;
}

export function scienceEconomicsCatalogService(): ScienceEconomicsCatalogService {
  if (!activeEconomicsCatalogService) activeEconomicsCatalogService = new ScienceEconomicsCatalogService(scienceStore());
  return activeEconomicsCatalogService;
}

export function scienceEconomicsAnalysisService(): ScienceEconomicsAnalysisService {
  if (!activeEconomicsAnalysisService) activeEconomicsAnalysisService = new ScienceEconomicsAnalysisService(scienceStore());
  return activeEconomicsAnalysisService;
}

export function scienceGenomicsCatalogService(): ScienceGenomicsCatalogService {
  if (!activeGenomicsCatalogService) activeGenomicsCatalogService = new ScienceGenomicsCatalogService(scienceStore());
  return activeGenomicsCatalogService;
}

export function scienceComparativeGenomicsService(): ScienceComparativeGenomicsService {
  if (!activeComparativeGenomicsService) activeComparativeGenomicsService = new ScienceComparativeGenomicsService(scienceStore());
  return activeComparativeGenomicsService;
}

export function scienceExtantReferenceAssemblyService(): ScienceExtantReferenceAssemblyService {
  if (!activeExtantReferenceAssemblyService) activeExtantReferenceAssemblyService = new ScienceExtantReferenceAssemblyService(scienceStore());
  return activeExtantReferenceAssemblyService;
}

export function scienceComparativeGenomicsTableService(): ScienceComparativeGenomicsTableService {
  if (!activeComparativeGenomicsTableService) activeComparativeGenomicsTableService = new ScienceComparativeGenomicsTableService(scienceStore());
  return activeComparativeGenomicsTableService;
}

export function scienceHypotheticalAsrService(): ScienceHypotheticalAsrService {
  if (!activeHypotheticalAsrService) activeHypotheticalAsrService = new ScienceHypotheticalAsrService(scienceStore());
  return activeHypotheticalAsrService;
}

export function scienceExtantArchosaurLocusPanelService(): ScienceExtantArchosaurLocusPanelService {
  if (!activeExtantArchosaurLocusPanelService) {
    activeExtantArchosaurLocusPanelService = new ScienceExtantArchosaurLocusPanelService(scienceStore());
  }
  return activeExtantArchosaurLocusPanelService;
}

export function scienceMaterialsCatalogService(): ScienceMaterialsCatalogService {
  if (!activeMaterialsCatalogService) activeMaterialsCatalogService = new ScienceMaterialsCatalogService(scienceStore());
  return activeMaterialsCatalogService;
}

export function sciencePhysicsInspireLiveService(): SciencePhysicsInspireLiveService {
  if (!activePhysicsInspireLiveService) activePhysicsInspireLiveService = new SciencePhysicsInspireLiveService(scienceStore());
  return activePhysicsInspireLiveService;
}

export function sciencePhysicsHepDataLiveService(): SciencePhysicsHepDataLiveService {
  if (!activePhysicsHepDataLiveService) activePhysicsHepDataLiveService = new SciencePhysicsHepDataLiveService(scienceStore());
  return activePhysicsHepDataLiveService;
}

export function scienceScientificDataService(): ScienceScientificDataService {
  if (!activeScientificDataService) activeScientificDataService = new ScienceScientificDataService(scienceStore(), fetch, (toolId) => {
    try {
      if (toolId === "agentlas.source-to-molstar") return Boolean(resolveVerifiedScienceRenderer("agentlas.molstar", "protein.structure"));
      return Boolean(resolveVerifiedScienceRendererExecutor("agentlas.ketcher", "chemistry.document", "agentlas.source-to-ketcher"));
    } catch {
      return false;
    }
  });
  return activeScientificDataService;
}

export function scienceJournalPublicationService(): ScienceJournalPublicationService {
  if (!activeJournalPublicationService) activeJournalPublicationService = new ScienceJournalPublicationService(scienceStore());
  return activeJournalPublicationService;
}

export function scienceManuscriptRenderService(): ScienceManuscriptRenderService {
  if (!activeManuscriptRenderService) activeManuscriptRenderService = new ScienceManuscriptRenderService(scienceStore());
  return activeManuscriptRenderService;
}

export function scienceArtifactPublicationValidator(): ScienceArtifactPublicationValidator {
  if (!activeArtifactPublicationValidator) activeArtifactPublicationValidator = new ScienceArtifactPublicationValidator(scienceStore());
  return activeArtifactPublicationValidator;
}

export function scienceDomainAnalysisService(): ScienceDomainAnalysisService {
  if (!activeDomainAnalysisService) activeDomainAnalysisService = new ScienceDomainAnalysisService(scienceStore());
  return activeDomainAnalysisService;
}

export function scienceEarthAnalysisService(): ScienceEarthAnalysisService {
  if (!activeEarthAnalysisService) activeEarthAnalysisService = new ScienceEarthAnalysisService(scienceStore());
  return activeEarthAnalysisService;
}

export function sciencePhysicsAnalysisService(): SciencePhysicsAnalysisService {
  if (!activePhysicsAnalysisService) activePhysicsAnalysisService = new SciencePhysicsAnalysisService(scienceStore());
  return activePhysicsAnalysisService;
}

export async function recoverScienceRuntimeAtStartup(): Promise<{
  pausedLoops: number;
  tools: Awaited<ReturnType<ScienceToolGateway["reconcileAfterStoreReady"]>>;
  conversations: ReturnType<ScienceConversationService["reconcileAfterRuntimeReady"]>;
}> {
  const store = scienceStore();
  const gateway = scienceToolGateway();
  const conversations = scienceConversationService();
  // Recovery is a closed gate: canonical loops become paused and every
  // projection catches up before any new turn or tool can enter.
  gateway.closeAdmission();
  conversations.closeAdmission();
  const pausedLoops = store.pauseActiveLoopSessionsForHostBoundary("crash_recovery");
  const tools = await gateway.reconcileAfterStoreReady();
  if (activeLongRunBridge) await activeLongRunBridge.reconcileAll();
  const recoveredConversations = conversations.reconcileAfterRuntimeReady();
  gateway.openAdmission();
  conversations.openAdmission();
  return { pausedLoops, tools, conversations: recoveredConversations };
}

export function closeScienceRuntimeAdmission(): void {
  activeConversationService?.closeAdmission();
  activeToolGateway?.closeAdmission();
}

export function scienceRuntimeSettled(): boolean {
  if (!activeStore) return true;
  return (activeToolGateway?.activeRequestCount() ?? 0) === 0
    && activeStore.listRecoverableTurns().length === 0;
}

export async function shutdownScienceRuntimeForAppClose(timeoutMs = 10_000): Promise<{
  pausedLoops: number;
  interruptedTurns: number;
  cancellationRequests: number;
  interruptedToolRequests: number;
  timedOut: boolean;
}> {
  if (!activeStore) return {
    pausedLoops: 0,
    interruptedTurns: 0,
    cancellationRequests: 0,
    interruptedToolRequests: 0,
    timedOut: false,
  };
  activeConversationService?.closeAdmission();
  activeToolGateway?.closeAdmission();
  const pausedLoops = activeStore.pauseActiveLoopSessionsForHostBoundary("app_closed");
  const turns = activeConversationService?.shutdownForAppClose() ?? { interruptedTurns: 0, cancellationRequests: 0 };
  const toolShutdown = activeToolGateway?.shutdownForAppClose() ?? Promise.resolve({ interruptedRequests: 0 });
  let timedOut = false;
  let timeout: NodeJS.Timeout | null = null;
  const tools = await Promise.race([
    toolShutdown,
    new Promise<{ interruptedRequests: number }>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve({ interruptedRequests: activeToolGateway?.activeRequestCount() ?? 0 });
      }, Math.max(1, timeoutMs));
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (activeLongRunBridge) await activeLongRunBridge.flush();
  return {
    pausedLoops,
    interruptedTurns: turns.interruptedTurns,
    cancellationRequests: turns.cancellationRequests,
    interruptedToolRequests: tools.interruptedRequests,
    timedOut,
  };
}

export function closeScienceStore(): void {
  activeLongRunBridge?.close();
  activeLongRunBridge = null;
  activeConversationService?.close();
  activeConversationService = null;
  activeToolGateway = null;
  activeChemistryValidator = null;
  activeAcademicSearchService = null;
  activeAcademicFullTextService = null;
  activeAstronomyCatalogService = null;
  activeAstronomyAnalysisService = null;
  activeBiodiversityCatalogService = null;
  activePaleontologyCatalogService = null;
  activePaleontologyAnalysisService = null;
  activePaleontologyCandidateComparisonService = null;
  activeDeextinctionFeasibilityService = null;
  activeEarthquakeCatalogService = null;
  activeNoaaCoopsWaterLevelService = null;
  activeEconomicsCatalogService = null;
  activeEconomicsAnalysisService = null;
  activeGenomicsCatalogService = null;
  activeComparativeGenomicsService = null;
  activeExtantReferenceAssemblyService = null;
  activeComparativeGenomicsTableService = null;
  activeHypotheticalAsrService = null;
  activeExtantArchosaurLocusPanelService = null;
  activeMaterialsCatalogService = null;
  activePhysicsInspireLiveService = null;
  activePhysicsHepDataLiveService = null;
  activeScientificDataService = null;
  activeJournalPublicationService = null;
  activeManuscriptRenderService = null;
  activeArtifactPublicationValidator = null;
  activeDomainAnalysisService = null;
  activeEarthAnalysisService = null;
  activePhysicsAnalysisService = null;
  activeEvidenceGraphService = null;
  activeStore?.close();
  activeStore = null;
}
