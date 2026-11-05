/**
 * Literature tools for the agents of an ordinary Work or One conversation (PLAN S9 C1; owner: Science's own tools stay out of
 * the owner's menus but the agents use them internally).
 *
 * Science's literature tools (search_academic_literature, retrieve_open_access_full_text) belong to a Science turn's tool server and
 * save into a Science project. A Work or One turn has no project, so a skill that asked for them ended in "tool not connected" (Thread
 * Marketing). These two operations run the same provider routes through the Science build's project-free functions
 * (searchAcademicLiteratureWithoutProject, retrieveOpenAccessFullTextWithoutProject): nothing is saved, the answer comes back to the agent.
 *
 * Harness operations run in Main for every runtime (7 subscription CLIs, BYOK, serving, local models), so one path serves them all. A
 * build whose Science package lacks the functions, or a Science extension that is not active, answers `unavailable` with what to do instead,
 * never a dead end. Registered into the shared port table by harness/capability-ports.ts beside the Finance ports.
 */
import { z } from "zod";
import type { HarnessCallContext } from "../harness/capability-ports";
import { composeDeclaredPrompt } from "../runtime/prompt-order";

type Outcome = { status: "ok"; data: unknown } | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

/** The two Science functions, as this host calls them. */
export interface ScienceLiteratureSdk {
  search(input: Record<string, unknown>): Promise<LiteratureSearchResult>;
  fullText(input: { doi?: string; pmid?: string; maxChars?: number; signal?: AbortSignal }): Promise<LiteratureFullTextResult>;
}
interface LiteratureRecord {
  canonicalId: string; title: string; abstract: string | null; authors: string[]; publicationYear: number | null; publicationDate: string | null;
  publisher: string | null; containerTitle: string | null; doi: string | null; pmid: string | null; arxivId: string | null; landingUrl: string;
  openAccessUrl: string | null; citationCount: number | null; isRetracted: boolean; isPreprint: boolean; providers: string[]; score: number;
  abstractProvenance?: string;
}
interface LiteratureSearchResult {
  query: string; queryPlan: Record<string, unknown>; records: LiteratureRecord[];
  receipts: Array<{ provider: string; status: string; httpStatus: number | null; resultCount: number; errorCode: string | null; durationMs: number }>;
  coverage: { requestedProviders: number; successfulProviders: number; failedProviders: number; rawRecords: number; deduplicatedRecords: number };
  warnings: string[]; enrichment?: unknown;
}
interface LiteratureFullTextResult {
  evidenceScope: "full-text"; identity: { doi: string | null; pmid: string | null }; pmcid: string; license: string | null; text: string;
  truncated: boolean; totalChars: number; sectionHeadings: string[]; receipt: Record<string, unknown>;
}

let sdkLoader: () => Promise<ScienceLiteratureSdk | null> = async () => {
  const science = await import("agentlas-science") as unknown as { searchAcademicLiteratureWithoutProject?: unknown; retrieveOpenAccessFullTextWithoutProject?: unknown };
  const { searchAcademicLiteratureWithoutProject: search, retrieveOpenAccessFullTextWithoutProject: fullText } = science;
  if (typeof search !== "function" || typeof fullText !== "function") return null;
  return { search: search as ScienceLiteratureSdk["search"], fullText: fullText as ScienceLiteratureSdk["fullText"] };
};
/** Gate-only: a stand-in for the Science package. `null` makes the loader answer "this build has no such function". */
export function setScienceLiteratureSdkForTests(next: ScienceLiteratureSdk | null | undefined): void {
  sdkLoader = next === undefined ? sdkLoader : async () => next;
}

const BROWSER_NEXT = "tell the owner in one sentence which literature step could not run; if the work can go on without it, search a public scholarly index with the browser and cite only what you read; never invent a source";
const unavailable = (reason: string, next: string, data?: unknown): Outcome => ({ status: "unavailable", reason, next, ...(data === undefined ? {} : { data }) });
const refused = (reason: string, next: string): Outcome => ({ status: "refused", reason, next });

const providerList = z.union([z.literal("auto"), z.array(z.string().min(1).max(60)).min(1).max(6)]);
const searchInput = z.object({
  query: z.string().trim().min(1).max(1000),
  domain: z.string().max(160).optional(),
  from_year: z.number().int().min(1000).max(3000).optional(),
  to_year: z.number().int().min(1000).max(3000).optional(),
  sort: z.enum(["relevance", "newest", "cited"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  include_preprints: z.boolean().optional(),
  providers: providerList.optional(),
}).strict();
const fullTextInput = z.object({
  doi: z.string().trim().min(3).max(300).optional(),
  pmid: z.string().trim().min(1).max(30).optional(),
  max_chars: z.number().int().min(1000).max(200_000).optional(),
}).strict().refine((value) => (value.doi === undefined) !== (value.pmid === undefined), { message: "exactly one of doi or pmid" });

const SEARCH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 1000 },
    domain: { type: "string", maxLength: 160, description: "A research field that steers the choice of providers." },
    from_year: { type: "integer", minimum: 1000, maximum: 3000 },
    to_year: { type: "integer", minimum: 1000, maximum: 3000 },
    sort: { type: "string", enum: ["relevance", "newest", "cited"] },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Records returned (default 20)." },
    include_preprints: { type: "boolean" },
    providers: { anyOf: [{ type: "string", enum: ["auto"] }, { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } }] },
  },
};
const FULL_TEXT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    doi: { type: "string", description: "The article's DOI. Give exactly one of doi or pmid." },
    pmid: { type: "string", description: "The article's PubMed id. Give exactly one of doi or pmid." },
    max_chars: { type: "integer", minimum: 1000, maximum: 200000, description: "Characters of text returned (default 60000)." },
  },
};

const ABSTRACT_CHARS = 1_500;
/** The first `ABSTRACT_CHARS` characters, never ending on half of a surrogate pair (an emoji or a rare CJK character at the cut). */
function abstractHead(abstract: string): string {
  const head = abstract.slice(0, ABSTRACT_CHARS);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
/** The agent gets what it needs to cite and judge, bounded: abstracts are cut, receipts keep their outcome only. */
function projectSearch(result: LiteratureSearchResult) {
  return {
    persisted: false, query: result.query, queryPlan: result.queryPlan, coverage: result.coverage, warnings: result.warnings,
    receipts: result.receipts.map((receipt) => ({ provider: receipt.provider, status: receipt.status, httpStatus: receipt.httpStatus, resultCount: receipt.resultCount, errorCode: receipt.errorCode })),
    records: result.records.map((record) => ({
      canonicalId: record.canonicalId, title: record.title, authors: record.authors.slice(0, 8), authorCount: record.authors.length,
      publicationYear: record.publicationYear, publicationDate: record.publicationDate, containerTitle: record.containerTitle, publisher: record.publisher,
      doi: record.doi, pmid: record.pmid, arxivId: record.arxivId, landingUrl: record.landingUrl, openAccessUrl: record.openAccessUrl,
      citationCount: record.citationCount, isRetracted: record.isRetracted, isPreprint: record.isPreprint, providers: record.providers, score: record.score,
      abstract: record.abstract === null ? null : abstractHead(record.abstract), abstractCut: record.abstract !== null && record.abstract.length > ABSTRACT_CHARS,
      ...(record.abstractProvenance ? { abstractProvenance: record.abstractProvenance } : {}),
    })),
  };
}

/** A known Science error code, as data: which outcome, which reason, what to do. */
function mapFailure(error: unknown): Outcome {
  const message = error instanceof Error ? error.message : String(error);
  if (/science-extension-not-active/.test(message)) {
    return unavailable("science_extension_not_active", `Science is not switched on in this app (Settings, Science); ${BROWSER_NEXT}`);
  }
  if (/science-runtime-load-failed|science-runtime-load-reentrant/.test(message)) return unavailable("science_runtime_unavailable", BROWSER_NEXT);
  // A stopped turn: the answer is not read, but the call ends with a typed outcome rather than a provider failure.
  if (/science-academic-search-aborted/.test(message)) return unavailable("cancelled", "the turn was stopped; nothing more to do for this call");
  const invalid = /science-academic-search-(query|year-range|provider)-invalid/.exec(message);
  if (invalid) return refused(`${invalid[1]}_invalid`, "fix that argument and call again (see the operation's input schema)");
  if (/identity-unsupported/.test(message)) return refused("identity_invalid", "give exactly one of doi (10.xxxx/…) or pmid (digits)");
  if (/not-open-access/.test(message)) {
    return refused("not_open_access", "this article has no open-access full text in Europe PMC: cite only what its abstract (from the search result) says and say the body was not read; do not claim body-level evidence");
  }
  if (/identity-mismatch/.test(message)) return refused("article_not_found", "Europe PMC has no record for this identifier; check the DOI or PMID, or find the open-access location in the search result (openAccessUrl)");
  if (/full-text-(metadata-invalid|content-type-invalid|jats-invalid|xml-encoding-invalid|response-size-invalid|http-\d+)/.test(message)) {
    return unavailable("full_text_provider_failed", `the provider answered unusably (${message.slice(0, 80)}); ${BROWSER_NEXT}`);
  }
  return unavailable("literature_call_failed", `${BROWSER_NEXT} (${message.slice(0, 120).replace(/[^\x20-\x7e]/g, "?")})`);
}

async function searchHandler(args: Record<string, unknown>, ctx: Pick<HarnessCallContext, "signal" | "dryRun">): Promise<Outcome> {
  const parsed = searchInput.safeParse(args);
  if (!parsed.success) return refused("arguments_invalid", `see the input schema: ${parsed.error.issues[0]?.path.join(".") || "arguments"} ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const sdk = await sdkLoader().catch(() => null);
  if (!sdk) return unavailable("science_literature_not_in_this_build", `this app's Science build predates project-free literature search; ${BROWSER_NEXT}`);
  const value = parsed.data;
  try {
    const result = await sdk.search({
      query: value.query,
      ...(value.domain === undefined ? {} : { domain: value.domain }),
      ...(value.from_year === undefined ? {} : { fromYear: value.from_year }),
      ...(value.to_year === undefined ? {} : { toYear: value.to_year }),
      ...(value.sort === undefined ? {} : { sort: value.sort }),
      ...(value.limit === undefined ? {} : { limit: value.limit }),
      ...(value.include_preprints === undefined ? {} : { includePreprints: value.include_preprints }),
      ...(value.providers === undefined ? {} : { providers: value.providers }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const projected = projectSearch(result);
    if (result.coverage.successfulProviders === 0) {
      return unavailable("literature_providers_unreachable", `no scholarly provider answered (see receipts); retry later or ${BROWSER_NEXT}`, projected);
    }
    return { status: "ok", data: projected };
  } catch (error) { return mapFailure(error); }
}

async function fullTextHandler(args: Record<string, unknown>, ctx: Pick<HarnessCallContext, "signal" | "dryRun">): Promise<Outcome> {
  const parsed = fullTextInput.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Only a wrong doi/pmid choice is an identity problem; max_chars out of range or an unknown key is an argument problem.
    const identity = !issue || issue.code === "custom" || issue.path[0] === "doi" || issue.path[0] === "pmid";
    return identity ? refused("identity_invalid", "give exactly one of doi or pmid (and optionally max_chars)")
      : refused("arguments_invalid", `see the input schema: ${issue.path.join(".") || "arguments"} ${issue.message}`);
  }
  const sdk = await sdkLoader().catch(() => null);
  if (!sdk) return unavailable("science_literature_not_in_this_build", `this app's Science build predates project-free full-text retrieval; ${BROWSER_NEXT}`);
  const value = parsed.data;
  try {
    const result = await sdk.fullText({ ...(value.doi === undefined ? {} : { doi: value.doi }), ...(value.pmid === undefined ? {} : { pmid: value.pmid }),
      ...(value.max_chars === undefined ? {} : { maxChars: value.max_chars }), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    return { status: "ok", data: { persisted: false, evidenceScope: result.evidenceScope, identity: result.identity, pmcid: result.pmcid, license: result.license,
      text: result.text, truncated: result.truncated, totalChars: result.totalChars, sectionHeadings: result.sectionHeadings.slice(0, 80), receipt: result.receipt } };
  } catch (error) { return mapFailure(error); }
}

const SEARCH_PURPOSE = "Search prior research and academic literature (papers, citations, related work, state of the art, what has been tried) across several public scholarly providers; results are deduplicated and ranked with provider receipts. This is Science's search_academic_literature for a conversation that has no Science project: nothing is saved, so keep what you need in your answer or a file. Abstracts are metadata, not full text.";
const FULL_TEXT_PURPOSE = "Read the open-access full text of one article by DOI or PMID (Europe PMC); this is Science's retrieve_open_access_full_text for a conversation that has no Science project: the parsed text (bounded by max_chars, truncation reported) and the provider receipt come back and nothing is saved. An article that is not open access is refused: then only its abstract can be cited.";

export const SCIENCE_LITERATURE_PORTS = [
  { operationId: "science.literature.search", kind: "query" as const, required: ["query"] as const, inputSchema: SEARCH_SCHEMA as Record<string, unknown>,
    callTimeoutMs: 90_000, effectFreeRead: true as const, foundAsTool: true as const,
    purpose: composeDeclaredPrompt([{ id: "tool.science.literature.search.description", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: SEARCH_PURPOSE }]),
    handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => searchHandler(args, ctx) },
  { operationId: "science.literature.fulltext", kind: "query" as const, required: [] as const, inputSchema: FULL_TEXT_SCHEMA as Record<string, unknown>,
    callTimeoutMs: 90_000, effectFreeRead: true as const, foundAsTool: true as const,
    purpose: composeDeclaredPrompt([{ id: "tool.science.literature.fulltext.description", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: FULL_TEXT_PURPOSE }]),
    handler: (args: Record<string, unknown>, ctx: HarnessCallContext) => fullTextHandler(args, ctx) },
];

// The schemas the model reads, declared as versioned content (same rule as the Finance ports).
composeDeclaredPrompt([{ id: "tool.science.literature.search.schema", revision: 1, stability: "versioned-content", changeTriggers: ["release", "output-schema"], text: JSON.stringify(SEARCH_SCHEMA) }]);
composeDeclaredPrompt([{ id: "tool.science.literature.fulltext.schema", revision: 1, stability: "versioned-content", changeTriggers: ["release", "output-schema"], text: JSON.stringify(FULL_TEXT_SCHEMA) }]);
