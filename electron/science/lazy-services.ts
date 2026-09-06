import { createScienceLazyBoundary } from "./lazy-boundary";
import type * as Services from "./service-facade";

let isAvailable = () => false;
const boundary = createScienceLazyBoundary(
  () => isAvailable(),
  () => require("./service-facade") as typeof Services,
);

export function configureScienceServiceAvailability(check: () => boolean): void { isAvailable = check; }
// Called only by an explicit request to reopen Science, never a timer or status poll.
export function retryFailedScienceServiceLoad(): void { boundary.retryFailed(); }
export const scienceSchemaVersion = () => boundary.get().SCIENCE_SCHEMA_VERSION;
export const createScienceDatasetIngestionService = (...args: ConstructorParameters<typeof Services.ScienceDatasetIngestionService>) => new (boundary.get().ScienceDatasetIngestionService)(...args);

export const scienceStore: typeof Services.scienceStore = (...args) => boundary.get().scienceStore(...args);
export const recoverScienceRuntimeAtStartup: typeof Services.recoverScienceRuntimeAtStartup = (...args) => boundary.get().recoverScienceRuntimeAtStartup(...args);
export const scienceArtifactPublicationValidator: typeof Services.scienceArtifactPublicationValidator = (...args) => boundary.get().scienceArtifactPublicationValidator(...args);
export const scienceChemistryValidator: typeof Services.scienceChemistryValidator = (...args) => boundary.get().scienceChemistryValidator(...args);
export const scienceConversationService: typeof Services.scienceConversationService = (...args) => boundary.get().scienceConversationService(...args);
export const scienceEvidenceGraphService: typeof Services.scienceEvidenceGraphService = (...args) => boundary.get().scienceEvidenceGraphService(...args);
export const scienceJournalPublicationService: typeof Services.scienceJournalPublicationService = (...args) => boundary.get().scienceJournalPublicationService(...args);
export const scienceManuscriptRenderService: typeof Services.scienceManuscriptRenderService = (...args) => boundary.get().scienceManuscriptRenderService(...args);
export const scienceToolGateway: typeof Services.scienceToolGateway = (...args) => boundary.get().scienceToolGateway(...args);
export const scienceStatisticsMethodCatalogue: typeof Services.scienceStatisticsMethodCatalogue = (...args) => boundary.get().scienceStatisticsMethodCatalogue(...args);
export const scienceLabDecisionProjectionsForProject: typeof Services.scienceLabDecisionProjectionsForProject = (...args) => boundary.get().scienceLabDecisionProjectionsForProject(...args);
export const inspectScienceEpisodeResultReview: typeof Services.inspectScienceEpisodeResultReview = (...args) => boundary.get().inspectScienceEpisodeResultReview(...args);
export const recordScienceEpisodeResultReview: typeof Services.recordScienceEpisodeResultReview = (...args) => boundary.get().recordScienceEpisodeResultReview(...args);
export const commitScienceVegaEdit: typeof Services.commitScienceVegaEdit = (...args) => boundary.get().commitScienceVegaEdit(...args);
export const parseScienceVegaEditInput: typeof Services.parseScienceVegaEditInput = (...args) => boundary.get().parseScienceVegaEditInput(...args);
export const renderScienceStatisticsFigurePdf: typeof Services.renderScienceStatisticsFigurePdf = (...args) => boundary.get().renderScienceStatisticsFigurePdf(...args);
export const renderScienceStatisticsFigurePng: typeof Services.renderScienceStatisticsFigurePng = (...args) => boundary.get().renderScienceStatisticsFigurePng(...args);
export const renderScienceStatisticsFigureSvg: typeof Services.renderScienceStatisticsFigureSvg = (...args) => boundary.get().renderScienceStatisticsFigureSvg(...args);
export const renderScienceStatisticsFigureSvgPreviewPng: typeof Services.renderScienceStatisticsFigureSvgPreviewPng = (...args) => boundary.get().renderScienceStatisticsFigureSvgPreviewPng(...args);
export const renderScienceStatisticsFigureTiff: typeof Services.renderScienceStatisticsFigureTiff = (...args) => boundary.get().renderScienceStatisticsFigureTiff(...args);
export const validateScienceNumericSurfacePngBytes: typeof Services.validateScienceNumericSurfacePngBytes = (...args) => boundary.get().validateScienceNumericSurfacePngBytes(...args);
export const validateScienceResidueInteraction: typeof Services.validateScienceResidueInteraction = (...args) => boundary.get().validateScienceResidueInteraction(...args);
export const draftManuscript: typeof Services.draftManuscript = (...args) => boundary.get().draftManuscript(...args);
export const inspectScienceManuscriptDepth: typeof Services.inspectScienceManuscriptDepth = (...args) => boundary.get().inspectScienceManuscriptDepth(...args);

// MCP can load the shared runtime without this facade. Cache inspection must not
// initialize it, but cleanup still has to settle that already-loaded instance.
function loadedRuntime(): Pick<typeof Services, "closeScienceStore" | "shutdownScienceRuntimeForAppClose"> | undefined {
  const facade = boundary.peek();
  if (facade) return facade;
  try {
    const cached = require.cache[require.resolve("./runtime")];
    return cached?.loaded ? cached.exports : undefined;
  } catch { return undefined; }
}

// Cleanup must remain unconditional and must never load an unused extension.
export const closeScienceStore: typeof Services.closeScienceStore = (...args) => loadedRuntime()?.closeScienceStore(...args);
export const shutdownScienceRuntimeForAppClose: typeof Services.shutdownScienceRuntimeForAppClose = (...args) => {
  const loaded = loadedRuntime();
  return loaded ? loaded.shutdownScienceRuntimeForAppClose(...args) : Promise.resolve({
    pausedLoops: 0, interruptedTurns: 0, cancellationRequests: 0, interruptedToolRequests: 0, timedOut: false,
  });
};
