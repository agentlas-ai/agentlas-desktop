export const SCIENCE_SOURCE_TEXT_INDEX_SCHEMA = "agentlas.science.source-text-index/v1" as const;
export const SCIENCE_SOURCE_TEXT_CHUNK_SCHEMA = "agentlas.science.source-text-chunk/v1" as const;
export const SCIENCE_SOURCE_TEXT_SEARCH_SCHEMA = "agentlas.science.source-text-search/v1" as const;

export type ScienceSourceTextEvidenceScope = "abstract" | "full-text";

export interface ScienceSourceTextIndex {
  schema: typeof SCIENCE_SOURCE_TEXT_INDEX_SCHEMA;
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceVersion: number;
  sourceContentSha256: string;
  evidenceScope: ScienceSourceTextEvidenceScope;
  parserId: "agentlas.source-text-chunker";
  parserVersion: "1.0.0";
  textByteSize: number;
  sectionCount: number;
  chunkCount: number;
  chunkManifestSha256: string;
  createdAt: string;
  contentSha256: string;
}

export interface ScienceSourceTextChunk {
  schema: typeof SCIENCE_SOURCE_TEXT_CHUNK_SCHEMA;
  id: string;
  indexId: string;
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceVersion: number;
  sourceContentSha256: string;
  evidenceScope: ScienceSourceTextEvidenceScope;
  sectionId: string;
  sectionOrdinal: number;
  sectionTitle: string;
  chunkOrdinal: number;
  locator: string;
  startByte: number;
  endByte: number;
  text: string;
  textSha256: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceSourceTextSearchResult {
  schema: typeof SCIENCE_SOURCE_TEXT_SEARCH_SCHEMA;
  projectId: string;
  query: string;
  chunks: ScienceSourceTextChunk[];
  truncated: boolean;
  contentSha256: string;
}
