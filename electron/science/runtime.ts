import { userDataPath } from "../runtime-paths";
import { ScienceStore } from "./store";
import { ScienceConversationService } from "./conversation-service";
import { ScienceToolGateway } from "./tool-gateway";
import { ScienceChemistryValidator } from "./chemistry-validator";
import { ScienceAcademicSearchService } from "./academic-search";
import { ScienceAcademicFullTextService } from "./academic-full-text";
import { ScienceAstronomyCatalogService } from "./astronomy-catalog";
import { ScienceBiodiversityCatalogService } from "./biodiversity-catalog";
import { ScienceEarthquakeCatalogService } from "./earthquake-catalog";
import { ScienceEconomicsCatalogService } from "./economics-catalog";
import { ScienceGenomicsCatalogService } from "./genomics-catalog";
import { ScienceMaterialsCatalogService } from "./materials-catalog";
import { SciencePhysicsHepDataLiveService, SciencePhysicsInspireLiveService } from "./physics-live-sources";
import { ScienceScientificDataService } from "./scientific-data";
import { ScienceJournalPublicationService } from "./journal-publication";
import { ScienceArtifactPublicationValidator } from "./artifact-publication-validator";
import { ScienceDomainAnalysisService } from "./domain-analysis";
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
let activeBiodiversityCatalogService: ScienceBiodiversityCatalogService | null = null;
let activeEarthquakeCatalogService: ScienceEarthquakeCatalogService | null = null;
let activeEconomicsCatalogService: ScienceEconomicsCatalogService | null = null;
let activeGenomicsCatalogService: ScienceGenomicsCatalogService | null = null;
let activeMaterialsCatalogService: ScienceMaterialsCatalogService | null = null;
let activePhysicsInspireLiveService: SciencePhysicsInspireLiveService | null = null;
let activePhysicsHepDataLiveService: SciencePhysicsHepDataLiveService | null = null;
let activeScientificDataService: ScienceScientificDataService | null = null;
let activeJournalPublicationService: ScienceJournalPublicationService | null = null;
let activeArtifactPublicationValidator: ScienceArtifactPublicationValidator | null = null;
let activeDomainAnalysisService: ScienceDomainAnalysisService | null = null;
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

export function scienceBiodiversityCatalogService(): ScienceBiodiversityCatalogService {
  if (!activeBiodiversityCatalogService) activeBiodiversityCatalogService = new ScienceBiodiversityCatalogService(scienceStore());
  return activeBiodiversityCatalogService;
}

export function scienceEarthquakeCatalogService(): ScienceEarthquakeCatalogService {
  if (!activeEarthquakeCatalogService) activeEarthquakeCatalogService = new ScienceEarthquakeCatalogService(scienceStore());
  return activeEarthquakeCatalogService;
}

export function scienceEconomicsCatalogService(): ScienceEconomicsCatalogService {
  if (!activeEconomicsCatalogService) activeEconomicsCatalogService = new ScienceEconomicsCatalogService(scienceStore());
  return activeEconomicsCatalogService;
}

export function scienceGenomicsCatalogService(): ScienceGenomicsCatalogService {
  if (!activeGenomicsCatalogService) activeGenomicsCatalogService = new ScienceGenomicsCatalogService(scienceStore());
  return activeGenomicsCatalogService;
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

export function scienceArtifactPublicationValidator(): ScienceArtifactPublicationValidator {
  if (!activeArtifactPublicationValidator) activeArtifactPublicationValidator = new ScienceArtifactPublicationValidator(scienceStore());
  return activeArtifactPublicationValidator;
}

export function scienceDomainAnalysisService(): ScienceDomainAnalysisService {
  if (!activeDomainAnalysisService) activeDomainAnalysisService = new ScienceDomainAnalysisService(scienceStore());
  return activeDomainAnalysisService;
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
  activeBiodiversityCatalogService = null;
  activeEarthquakeCatalogService = null;
  activeEconomicsCatalogService = null;
  activeGenomicsCatalogService = null;
  activeMaterialsCatalogService = null;
  activePhysicsInspireLiveService = null;
  activePhysicsHepDataLiveService = null;
  activeScientificDataService = null;
  activeJournalPublicationService = null;
  activeArtifactPublicationValidator = null;
  activeDomainAnalysisService = null;
  activeEvidenceGraphService = null;
  activeStore?.close();
  activeStore = null;
}
