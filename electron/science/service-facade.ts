// Heavy Science values. Only lazy-services may load this from the Desktop shell.
export {
  closeScienceStore, recoverScienceRuntimeAtStartup, scienceArtifactPublicationValidator,
  scienceChemistryValidator, scienceConversationService, scienceEvidenceGraphService,
  scienceJournalPublicationService, scienceManuscriptRenderService, scienceStore,
  scienceToolGateway, shutdownScienceRuntimeForAppClose,
} from "./runtime";
export { ScienceDatasetIngestionService } from "./dataset-ingestion";
export { SCIENCE_SCHEMA_VERSION } from "./store";
export { scienceStatisticsMethodCatalogue } from "./statistics-method-catalogue";
export { scienceLabDecisionProjectionsForProject } from "./lab-decision-projection-service";
export { inspectScienceEpisodeResultReview, recordScienceEpisodeResultReview } from "./result-review-service";
export { commitScienceVegaEdit, parseScienceVegaEditInput } from "./vega-editor";
export {
  renderScienceStatisticsFigurePdf, renderScienceStatisticsFigurePng, renderScienceStatisticsFigureSvg,
  renderScienceStatisticsFigureSvgPreviewPng, renderScienceStatisticsFigureTiff,
} from "./statistics-figure-export";
export { validateScienceNumericSurfacePngBytes } from "./numeric-surface-export";
export { validateScienceResidueInteraction } from "./protein-residue-validator";
export { draftManuscript } from "./manuscript";
export { inspectScienceManuscriptDepth } from "./manuscript/depth-preflight";
