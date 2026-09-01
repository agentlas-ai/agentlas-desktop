import { createHash } from "node:crypto";
import type { ScienceSource, ScienceSourceKind } from "../../shared/science-contract";
import { ScienceStore } from "./store";

export const ACADEMIC_SEARCH_TOOL_ID = "agentlas.academic-search";
export const ACADEMIC_SEARCH_TOOL_VERSION = "1.0.0";

export const ACADEMIC_SEARCH_PROVIDERS = [
  "openalex",
  "semantic-scholar",
  "crossref",
  "arxiv",
  "europe-pmc",
  "pubmed",
] as const;
export type AcademicSearchProvider = typeof ACADEMIC_SEARCH_PROVIDERS[number];

export interface AcademicSearchInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  query: string;
  domain?: string;
  fromYear?: number;
  toYear?: number;
  sort?: "relevance" | "newest" | "cited";
  limit?: number;
  includePreprints?: boolean;
  providers?: "auto" | AcademicSearchProvider[];
}

export interface AcademicProviderReceipt {
  provider: AcademicSearchProvider;
  endpoint: string;
  requestSha256: string;
  responseSha256: string | null;
  retrievedAt: string;
  durationMs: number;
  status: "ok" | "error";
  httpStatus: number | null;
  resultCount: number;
  rateLimit: { limit: string | null; remaining: string | null; reset: string | null; retryAfter: string | null };
  errorCode: string | null;
}

export interface AcademicSearchRecord {
  canonicalId: string;
  title: string;
  abstract: string | null;
  authors: string[];
  publicationYear: number | null;
  publicationDate: string | null;
  publisher: string | null;
  containerTitle: string | null;
  kind: ScienceSourceKind;
  doi: string | null;
  pmid: string | null;
  arxivId: string | null;
  landingUrl: string;
  openAccessUrl: string | null;
  citationCount: number | null;
  isRetracted: boolean;
  isPreprint: boolean;
  providers: AcademicSearchProvider[];
  providerIds: Partial<Record<AcademicSearchProvider, string>>;
  referencedOpenAlexIds?: string[];
  relatedOpenAlexIds?: string[];
  score: number;
  sourceId: string | null;
  sourceVersionId: string | null;
}

export interface AcademicSearchResult {
  schema: "agentlas.academic-search-result/v1";
  query: string;
  queryPlan: {
    domain: string | null;
    providers: AcademicSearchProvider[];
    fromYear: number | null;
    toYear: number | null;
    sort: "relevance" | "newest" | "cited";
    limit: number;
    includePreprints: boolean;
    ranking: "deterministic-metadata-v1";
  };
  records: AcademicSearchRecord[];
  receipts: AcademicProviderReceipt[];
  coverage: { requestedProviders: number; successfulProviders: number; failedProviders: number; rawRecords: number; deduplicatedRecords: number };
  warnings: string[];
  runId: string;
  replayed: boolean;
}

type Candidate = Omit<AcademicSearchRecord, "canonicalId" | "providers" | "providerIds" | "score" | "sourceId" | "sourceVersionId"> & {
  provider: AcademicSearchProvider;
  providerId: string;
};

type FetchResult = { records: Candidate[]; receipt: AcademicProviderReceipt };

const ENDPOINTS: Record<AcademicSearchProvider, string> = {
  openalex: "https://api.openalex.org/works",
  "semantic-scholar": "https://api.semanticscholar.org/graph/v1/paper/search",
  crossref: "https://api.crossref.org/works",
  arxiv: "https://export.arxiv.org/api/query",
  "europe-pmc": "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
  pubmed: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function text(value: unknown, maximum = 100_000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function stripMarkup(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return decodeXml(raw.replace(/<[^>]*>/g, " "));
}

function year(value: unknown): number | null {
  const match = String(value ?? "").match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function normalizeDoi(value: unknown): string | null {
  const normalized = text(value, 500)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim().toLowerCase();
  return normalized && /^10\.\d{4,9}\/.+/.test(normalized) ? normalized : null;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function safeUrl(value: unknown): string | null {
  const candidate = text(value, 4_000);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch { return null; }
}

function kind(value: unknown, preprint = false): ScienceSourceKind {
  if (preprint) return "preprint";
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("book")) return "book";
  if (normalized.includes("dataset")) return "dataset";
  if (normalized.includes("software")) return "software";
  if (normalized.includes("patent")) return "patent";
  return "journal-article";
}

function abstractFromInvertedIndex(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const terms: Array<{ word: string; position: number }> = [];
  for (const [word, positions] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (Number.isSafeInteger(position)) terms.push({ word, position: Number(position) });
  }
  terms.sort((a, b) => a.position - b.position);
  return text(terms.map((item) => item.word).join(" "));
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function xmlTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return match ? decodeXml(match[1].replace(/<[^>]*>/g, " ")) : null;
}

function xmlTags(block: string, tag: string): string[] {
  return [...block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi"))]
    .map((match) => decodeXml(match[1].replace(/<[^>]*>/g, " "))).filter(Boolean);
}

function rateLimit(headers: Headers): AcademicProviderReceipt["rateLimit"] {
  return {
    limit: headers.get("x-ratelimit-limit") ?? headers.get("x-rate-limit-limit"),
    remaining: headers.get("x-ratelimit-remaining") ?? headers.get("x-rate-limit-remaining"),
    reset: headers.get("x-ratelimit-reset") ?? headers.get("x-rate-limit-reset"),
    retryAfter: headers.get("retry-after"),
  };
}

function retryDelayMs(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(3_000, Math.round(seconds * 1_000)));
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, Math.min(3_000, date - Date.now()));
  }
  return Math.min(2_000, 250 * (2 ** attempt));
}

function openAlexWorkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => text(entry, 500)).filter((entry): entry is string => Boolean(entry && /^https:\/\/openalex\.org\/W\d+$/.test(entry))))].slice(0, 10_000);
}

async function fetchText(provider: AcademicSearchProvider, url: URL, timeoutMs = 12_000): Promise<{ text: string; response: Response; durationMs: number; retrievedAt: string }> {
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: provider === "arxiv" ? "application/atom+xml, application/xml;q=0.9, */*;q=0.1" : "application/json, */*;q=0.1",
          "user-agent": "Agentlas-Science/1.0 (academic metadata search; https://agentlas.ai)",
        },
      });
      const body = await response.text();
      if (!response.ok) {
        if ((response.status === 429 || response.status === 503) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
          continue;
        }
        throw Object.assign(new Error(`http-${response.status}`), { response, body });
      }
      return { text: body, response, durationMs: Date.now() - started, retrievedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("academic-search-retry-exhausted");
}

async function providerSearch(provider: AcademicSearchProvider, query: string, limit: number, fromYear: number | null, toYear: number | null): Promise<FetchResult> {
  const url = new URL(ENDPOINTS[provider]);
  const contactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(process.env.AGENTLAS_ACADEMIC_CONTACT_EMAIL ?? ""))
    ? String(process.env.AGENTLAS_ACADEMIC_CONTACT_EMAIL)
    : null;
  if (provider === "openalex") {
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", String(limit));
    const filters = [fromYear ? `from_publication_date:${fromYear}-01-01` : "", toYear ? `to_publication_date:${toYear}-12-31` : ""].filter(Boolean);
    if (filters.length) url.searchParams.set("filter", filters.join(","));
    if (contactEmail) url.searchParams.set("mailto", contactEmail);
  } else if (provider === "semantic-scholar") {
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fields", "paperId,title,abstract,year,authors,venue,journal,externalIds,url,openAccessPdf,citationCount,publicationTypes,publicationDate");
    if (fromYear || toYear) url.searchParams.set("year", `${fromYear ?? ""}-${toYear ?? ""}`);
  } else if (provider === "crossref") {
    url.searchParams.set("query.bibliographic", query);
    url.searchParams.set("rows", String(limit));
    const filters = [fromYear ? `from-pub-date:${fromYear}-01-01` : "", toYear ? `until-pub-date:${toYear}-12-31` : ""].filter(Boolean);
    if (filters.length) url.searchParams.set("filter", filters.join(","));
    if (contactEmail) url.searchParams.set("mailto", contactEmail);
  } else if (provider === "arxiv") {
    url.searchParams.set("search_query", `all:${query.replace(/[()\[\]{}:\\]/g, " ")}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(limit));
    url.searchParams.set("sortBy", "relevance");
  } else if (provider === "europe-pmc") {
    const yearFilter = fromYear || toYear ? ` AND FIRST_PDATE:[${fromYear ?? 1000}-01-01 TO ${toYear ?? 3000}-12-31]` : "";
    url.searchParams.set("query", `${query}${yearFilter}`);
    url.searchParams.set("pageSize", String(limit));
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
  } else {
    url.searchParams.set("db", "pubmed");
    url.searchParams.set("term", `${query}${fromYear || toYear ? ` AND ${fromYear ?? 1000}:${toYear ?? 3000}[pdat]` : ""}`);
    url.searchParams.set("retmode", "json");
    url.searchParams.set("retmax", String(limit));
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("tool", "agentlas_science");
    if (contactEmail) url.searchParams.set("email", contactEmail);
  }
  const requestSha256 = sha256(url.toString());
  const started = Date.now();
  let retrievedAt = new Date().toISOString();
  try {
    let fetched = await fetchText(provider, url, provider === "arxiv" ? 20_000 : 12_000);
    retrievedAt = fetched.retrievedAt;
    let responseBody = fetched.text;
    let records: Candidate[];
    if (provider === "openalex") {
      const payload = JSON.parse(responseBody) as { results?: any[] };
      records = (payload.results ?? []).flatMap((item) => {
        const title = text(item.title ?? item.display_name, 1_000); if (!title) return [];
        const doi = normalizeDoi(item.doi ?? item.ids?.doi);
        const landingUrl = safeUrl(doi ? `https://doi.org/${doi}` : item.primary_location?.landing_page_url ?? item.id); if (!landingUrl) return [];
        return [{ provider, providerId: String(item.id ?? landingUrl), title, abstract: abstractFromInvertedIndex(item.abstract_inverted_index), authors: (item.authorships ?? []).map((entry: any) => text(entry.author?.display_name, 500)).filter(Boolean), publicationYear: year(item.publication_year), publicationDate: text(item.publication_date, 40), publisher: text(item.primary_location?.source?.host_organization_name, 500), containerTitle: text(item.primary_location?.source?.display_name, 500), kind: kind(item.type, item.type === "preprint"), doi, pmid: text(item.ids?.pmid, 500)?.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, "").replace(/\/$/, "") ?? null, arxivId: text(item.ids?.arxiv, 500)?.replace(/^https?:\/\/arxiv\.org\/abs\//, "") ?? null, landingUrl, openAccessUrl: safeUrl(item.best_oa_location?.pdf_url ?? item.best_oa_location?.landing_page_url), citationCount: Number.isFinite(item.cited_by_count) ? Number(item.cited_by_count) : null, isRetracted: item.is_retracted === true, isPreprint: item.type === "preprint", referencedOpenAlexIds: openAlexWorkIds(item.referenced_works), relatedOpenAlexIds: openAlexWorkIds(item.related_works) }];
      });
    } else if (provider === "semantic-scholar") {
      const payload = JSON.parse(responseBody) as { data?: any[] };
      records = (payload.data ?? []).flatMap((item) => {
        const title = text(item.title, 1_000); if (!title) return [];
        const doi = normalizeDoi(item.externalIds?.DOI);
        const landingUrl = safeUrl(doi ? `https://doi.org/${doi}` : item.url); if (!landingUrl) return [];
        const publicationTypes = Array.isArray(item.publicationTypes) ? item.publicationTypes.map(String) : [];
        const preprint = publicationTypes.some((value: string) => /preprint/i.test(value)) || Boolean(item.externalIds?.ArXiv) && !doi;
        return [{ provider, providerId: String(item.paperId ?? landingUrl), title, abstract: text(item.abstract), authors: (item.authors ?? []).map((entry: any) => text(entry.name, 500)).filter(Boolean), publicationYear: year(item.year), publicationDate: text(item.publicationDate, 40), publisher: null, containerTitle: text(item.journal?.name ?? item.venue, 500), kind: kind(publicationTypes[0], preprint), doi, pmid: text(item.externalIds?.PubMed, 100), arxivId: text(item.externalIds?.ArXiv, 100), landingUrl, openAccessUrl: safeUrl(item.openAccessPdf?.url), citationCount: Number.isFinite(item.citationCount) ? Number(item.citationCount) : null, isRetracted: false, isPreprint: preprint }];
      });
    } else if (provider === "crossref") {
      const payload = JSON.parse(responseBody) as { message?: { items?: any[] } };
      records = (payload.message?.items ?? []).flatMap((item) => {
        const title = text(Array.isArray(item.title) ? item.title[0] : item.title, 1_000); if (!title) return [];
        const doi = normalizeDoi(item.DOI);
        const landingUrl = safeUrl(doi ? `https://doi.org/${doi}` : item.URL); if (!landingUrl) return [];
        const parts = item.published?.["date-parts"]?.[0] ?? item.created?.["date-parts"]?.[0] ?? [];
        const publicationYear = year(parts[0]);
        const publicationDate = publicationYear ? [parts[0], parts[1] ?? 1, parts[2] ?? 1].map((value: number, index: number) => index === 0 ? String(value) : String(value).padStart(2, "0")).join("-") : null;
        const preprint = String(item.type ?? "").toLowerCase() === "posted-content";
        return [{ provider, providerId: String(item.DOI ?? landingUrl), title, abstract: stripMarkup(item.abstract), authors: (item.author ?? []).map((entry: any) => text([entry.given, entry.family].filter(Boolean).join(" "), 500)).filter(Boolean), publicationYear, publicationDate, publisher: text(item.publisher, 500), containerTitle: text(Array.isArray(item["container-title"]) ? item["container-title"][0] : item["container-title"], 500), kind: kind(item.type, preprint), doi, pmid: null, arxivId: null, landingUrl, openAccessUrl: safeUrl(item.link?.find((entry: any) => /pdf|xml|html/i.test(String(entry["content-type"])))?.URL), citationCount: Number.isFinite(item["is-referenced-by-count"]) ? Number(item["is-referenced-by-count"]) : null, isRetracted: false, isPreprint: preprint }];
      });
    } else if (provider === "arxiv") {
      const entries = [...responseBody.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
      records = entries.flatMap((entry) => {
        const landingUrl = safeUrl(xmlTag(entry, "id")); const title = text(xmlTag(entry, "title"), 1_000); if (!landingUrl || !title) return [];
        const arxivId = new URL(landingUrl).pathname.split("/").filter(Boolean).pop()?.replace(/v\d+$/, "") ?? null;
        const doi = normalizeDoi(xmlTag(entry, "arxiv:doi"));
        return [{ provider, providerId: arxivId ?? landingUrl.toString(), title, abstract: text(xmlTag(entry, "summary")), authors: xmlTags(entry, "name"), publicationYear: year(xmlTag(entry, "published")), publicationDate: text(xmlTag(entry, "published"), 40)?.slice(0, 10) ?? null, publisher: "arXiv", containerTitle: "arXiv", kind: "preprint" as const, doi, pmid: null, arxivId, landingUrl: landingUrl.toString(), openAccessUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : null, citationCount: null, isRetracted: false, isPreprint: true }];
      });
    } else if (provider === "europe-pmc") {
      const payload = JSON.parse(responseBody) as { resultList?: { result?: any[] } };
      records = (payload.resultList?.result ?? []).flatMap((item) => {
        const title = text(item.title, 1_000); if (!title) return [];
        const doi = normalizeDoi(item.doi); const pmid = text(item.pmid, 100); const preprint = String(item.source ?? "").toUpperCase() === "PPR";
        const landingUrl = safeUrl(doi ? `https://doi.org/${doi}` : pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : item.fullTextUrlList?.fullTextUrl?.[0]?.url); if (!landingUrl) return [];
        return [{ provider, providerId: String(item.id ?? item.pmid ?? landingUrl), title, abstract: stripMarkup(item.abstractText), authors: Array.isArray(item.authorList?.author) ? item.authorList.author.map((entry: any) => text(entry.fullName, 500)).filter(Boolean) : text(item.authorString, 4_000)?.split(/,\s*/) ?? [], publicationYear: year(item.pubYear ?? item.firstPublicationDate), publicationDate: text(item.firstPublicationDate, 40), publisher: text(item.publisherName, 500), containerTitle: text(item.journalTitle, 500), kind: kind(item.pubType, preprint), doi, pmid, arxivId: null, landingUrl, openAccessUrl: safeUrl(item.fullTextUrlList?.fullTextUrl?.find((entry: any) => String(entry.availability).toLowerCase() === "open access")?.url), citationCount: Number.isFinite(Number(item.citedByCount)) ? Number(item.citedByCount) : null, isRetracted: /retract/i.test(String(item.pubType ?? "")), isPreprint: preprint }];
      });
    } else {
      const search = JSON.parse(responseBody) as { esearchresult?: { idlist?: string[] } };
      const ids = search.esearchresult?.idlist ?? [];
      if (!ids.length) records = [];
      else {
        const summaryUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
        summaryUrl.searchParams.set("db", "pubmed"); summaryUrl.searchParams.set("id", ids.join(",")); summaryUrl.searchParams.set("retmode", "json"); summaryUrl.searchParams.set("version", "2.0"); summaryUrl.searchParams.set("tool", "agentlas_science");
        if (contactEmail) summaryUrl.searchParams.set("email", contactEmail);
        const summary = await fetchText(provider, summaryUrl);
        responseBody += `\n${summary.text}`;
        fetched = { ...summary, text: responseBody, durationMs: fetched.durationMs + summary.durationMs };
        const payload = JSON.parse(summary.text) as { result?: Record<string, any> & { uids?: string[] } };
        records = (payload.result?.uids ?? ids).flatMap((id) => {
          const item = payload.result?.[id]; const title = text(item?.title, 1_000); if (!item || !title) return [];
          const articleIds = Array.isArray(item.articleids) ? item.articleids : [];
          const doi = normalizeDoi(articleIds.find((entry: any) => String(entry.idtype).toLowerCase() === "doi")?.value);
          const landingUrl = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
          return [{ provider, providerId: id, title, abstract: null, authors: (item.authors ?? []).map((entry: any) => text(entry.name, 500)).filter(Boolean), publicationYear: year(item.pubdate ?? item.sortpubdate), publicationDate: text(item.sortpubdate, 40)?.slice(0, 10) ?? null, publisher: null, containerTitle: text(item.fulljournalname ?? item.source, 500), kind: "journal-article" as const, doi, pmid: id, arxivId: null, landingUrl, openAccessUrl: null, citationCount: null, isRetracted: /retract/i.test(String(item.pubtype ?? "")), isPreprint: false }];
        });
      }
    }
    return { records, receipt: { provider, endpoint: url.origin + url.pathname, requestSha256, responseSha256: sha256(responseBody), retrievedAt, durationMs: fetched.durationMs, status: "ok", httpStatus: fetched.response.status, resultCount: records.length, rateLimit: rateLimit(fetched.response.headers), errorCode: null } };
  } catch (error) {
    const response = error && typeof error === "object" && "response" in error ? (error as { response?: Response }).response : undefined;
    const code = error instanceof Error ? error.name === "AbortError" ? "timeout" : error.message.slice(0, 160) : "request-failed";
    return { records: [], receipt: { provider, endpoint: url.origin + url.pathname, requestSha256, responseSha256: null, retrievedAt, durationMs: Date.now() - started, status: "error", httpStatus: response?.status ?? null, resultCount: 0, rateLimit: response ? rateLimit(response.headers) : { limit: null, remaining: null, reset: null, retryAfter: null }, errorCode: code } };
  }
}

function planProviders(domain: string | undefined, requested: AcademicSearchInput["providers"]): AcademicSearchProvider[] {
  if (Array.isArray(requested)) return [...new Set(requested)].filter((value): value is AcademicSearchProvider => ACADEMIC_SEARCH_PROVIDERS.includes(value));
  const value = String(domain ?? "").toLowerCase();
  if (/(bio|med|health|clinical|drug|life|의학|생명|바이오|신약)/i.test(value)) return ["openalex", "semantic-scholar", "crossref", "europe-pmc", "pubmed"];
  if (/(computer|ai|machine|math|physics|astronomy|cs|수학|물리|천문|컴퓨터|인공지능)/i.test(value)) return ["openalex", "semantic-scholar", "crossref", "arxiv"];
  return ["openalex", "semantic-scholar", "crossref", "arxiv", "europe-pmc"];
}

function mergeCandidates(candidates: Candidate[], query: string, sort: "relevance" | "newest" | "cited", includePreprints: boolean): AcademicSearchRecord[] {
  const groups = new Map<string, AcademicSearchRecord>();
  for (const candidate of candidates) {
    if (!includePreprints && candidate.isPreprint) continue;
    const canonicalId = candidate.doi ? `doi:${candidate.doi}` : candidate.pmid ? `pmid:${candidate.pmid}` : candidate.arxivId ? `arxiv:${candidate.arxivId}` : `title:${sha256(normalizeTitle(candidate.title)).slice(0, 24)}`;
    const current = groups.get(canonicalId);
    if (!current) {
      groups.set(canonicalId, { ...candidate, canonicalId, providers: [candidate.provider], providerIds: { [candidate.provider]: candidate.providerId }, score: 0, sourceId: null, sourceVersionId: null });
      continue;
    }
    current.providers.push(candidate.provider); current.providerIds[candidate.provider] = candidate.providerId;
    if (candidate.referencedOpenAlexIds?.length) current.referencedOpenAlexIds = candidate.referencedOpenAlexIds;
    if (candidate.relatedOpenAlexIds?.length) current.relatedOpenAlexIds = candidate.relatedOpenAlexIds;
    if (!current.abstract && candidate.abstract) current.abstract = candidate.abstract;
    if (!current.openAccessUrl && candidate.openAccessUrl) current.openAccessUrl = candidate.openAccessUrl;
    if (!current.doi && candidate.doi) current.doi = candidate.doi;
    if (!current.pmid && candidate.pmid) current.pmid = candidate.pmid;
    if (!current.arxivId && candidate.arxivId) current.arxivId = candidate.arxivId;
    if (candidate.authors.length > current.authors.length) current.authors = candidate.authors;
    current.citationCount = Math.max(current.citationCount ?? 0, candidate.citationCount ?? 0) || null;
    current.isRetracted ||= candidate.isRetracted;
  }
  const tokens = normalizeTitle(query).split(" ").filter((token) => token.length > 1);
  const nowYear = new Date().getUTCFullYear();
  for (const record of groups.values()) {
    const haystack = normalizeTitle(`${record.title} ${record.abstract ?? ""}`);
    const title = normalizeTitle(record.title);
    const titleMatches = tokens.filter((token) => title.includes(token)).length;
    const bodyMatches = tokens.filter((token) => haystack.includes(token)).length;
    const recency = record.publicationYear ? Math.max(0, 20 - Math.min(20, nowYear - record.publicationYear)) : 0;
    const citations = Math.log2(1 + Math.max(0, record.citationCount ?? 0));
    record.score = Number((titleMatches * 8 + bodyMatches * 2 + record.providers.length * 4 + recency * 0.25 + citations).toFixed(4));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.isRetracted !== b.isRetracted) return a.isRetracted ? 1 : -1;
    if (sort === "newest") return (b.publicationYear ?? 0) - (a.publicationYear ?? 0) || b.score - a.score;
    if (sort === "cited") return (b.citationCount ?? 0) - (a.citationCount ?? 0) || b.score - a.score;
    return b.score - a.score || (b.publicationYear ?? 0) - (a.publicationYear ?? 0);
  });
}

export class ScienceAcademicSearchService {
  constructor(private readonly store: ScienceStore) {}

  async search(input: AcademicSearchInput): Promise<AcademicSearchResult> {
    const query = text(input.query, 1_000); if (!query) throw new Error("science-academic-search-query-invalid");
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20)));
    const fromYear = input.fromYear == null ? null : Math.max(1000, Math.min(3000, Math.floor(input.fromYear)));
    const toYear = input.toYear == null ? null : Math.max(1000, Math.min(3000, Math.floor(input.toYear)));
    if (fromYear && toYear && fromYear > toYear) throw new Error("science-academic-search-year-range-invalid");
    const sort = input.sort ?? "relevance";
    const includePreprints = input.includePreprints !== false;
    const providers = planProviders(input.domain, input.providers);
    if (!providers.length) throw new Error("science-academic-search-provider-invalid");
    const canonicalInput = { query, domain: text(input.domain, 160), fromYear, toYear, sort, limit, includePreprints, providers };
    const inputBytes = Buffer.from(canonicalJson(canonicalInput), "utf8");
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = { role: "search-query", mimeType: "application/vnd.agentlas.academic-search-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const runCreation = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      toolId: ACADEMIC_SEARCH_TOOL_ID,
      toolVersion: ACADEMIC_SEARCH_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "academic-search-network-v1", providers: ENDPOINTS, runtime: process.version })),
      inputs: [inputResource],
    });
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, runCreation.run.id) ?? runCreation.run;
    if (runCreation.replayed && authoritativeRun.status === "succeeded" && authoritativeRun.outputs[0]) {
      const output = authoritativeRun.outputs[0];
      const stored = JSON.parse(this.store.readRunBlob({ blobRef: output.blobRef, sha256: output.sha256, byteSize: output.byteSize }).toString("utf8")) as AcademicSearchResult;
      return { ...stored, replayed: true };
    }
    const fetched = await Promise.all(providers.map((provider) => providerSearch(provider, query, Math.min(25, Math.max(8, limit)), fromYear, toYear)));
    const receipts = fetched.map((item) => item.receipt);
    const successful = receipts.filter((receipt) => receipt.status === "ok");
    if (!successful.length) {
      const failureBytes = Buffer.from(canonicalJson({ schema: "agentlas.academic-search-failure/v1", receipts }), "utf8");
      const failureBlob = this.store.putRunBlob(failureBytes);
      const failureResource = { role: "provider-receipts", mimeType: "application/vnd.agentlas.academic-search-failure+json", ...failureBlob, artifactId: null, artifactVersion: null };
      this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: authoritativeRun.id, status: "failed", outputManifestSha256: sha256(canonicalJson([failureResource])), summary: "All academic metadata providers failed.", outputs: [failureResource] });
      throw new Error("science-academic-search-all-providers-failed");
    }
    const rawRecords = fetched.flatMap((item) => item.records);
    const records = mergeCandidates(rawRecords, query, sort, includePreprints).slice(0, limit);
    for (const record of records) {
      const canonicalUri = record.doi
        ? `https://doi.org/${record.doi}`
        : record.pmid
          ? `pmid:${record.pmid}`
          : record.arxivId
            ? `arxiv:${record.arxivId}`
            : record.landingUrl;
      let source: ScienceSource | null = this.store.getSourceByCanonicalUriForProject(input.projectId, canonicalUri);
      if (!source) {
        try {
          source = this.store.createSource({
            requestId: stableUuid(`${input.requestId}:source:${canonicalUri}`), projectId: input.projectId, kind: record.kind,
            canonicalUri, title: record.title, authors: record.authors.slice(0, 500), publicationYear: record.publicationYear,
            publisher: record.publisher, containerTitle: record.containerTitle, abstract: record.abstract, accessState: "metadata-only",
            retrievalMethod: `agentlas-academic-search:${record.providers.join("+")}`,
          }).source;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "science-source-canonical-uri-conflict") throw error;
          source = this.store.getSourceByCanonicalUriForProject(input.projectId, canonicalUri);
          if (!source) throw error;
        }
      }
      record.sourceId = source.id; record.sourceVersionId = source.version.id;
    }
    const warnings = receipts.filter((receipt) => receipt.status === "error").map((receipt) => `${receipt.provider}:${receipt.errorCode ?? "failed"}`);
    const partial: Omit<AcademicSearchResult, "runId" | "replayed"> = {
      schema: "agentlas.academic-search-result/v1", query,
      queryPlan: { domain: canonicalInput.domain, providers, fromYear, toYear, sort, limit, includePreprints, ranking: "deterministic-metadata-v1" },
      records, receipts,
      coverage: { requestedProviders: providers.length, successfulProviders: successful.length, failedProviders: providers.length - successful.length, rawRecords: rawRecords.length, deduplicatedRecords: records.length },
      warnings,
    };
    const result: AcademicSearchResult = { ...partial, runId: authoritativeRun.id, replayed: false };
    const outputBytes = Buffer.from(canonicalJson(result), "utf8");
    const outputBlob = this.store.putRunBlob(outputBytes);
    const outputResource = { role: "search-results", mimeType: "application/vnd.agentlas.academic-search-results+json", ...outputBlob, artifactId: null, artifactVersion: null };
    this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: authoritativeRun.id, status: "succeeded", outputManifestSha256: sha256(canonicalJson([outputResource])), summary: `${records.length} deduplicated records from ${successful.length}/${providers.length} providers.`, outputs: [outputResource] });
    return result;
  }
}
