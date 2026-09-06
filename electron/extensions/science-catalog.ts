import type { ScienceSuiteComponentId } from "../../shared/product-extension";
import { SCIENCE_DESKTOP_HOST_API_NAME, SCIENCE_DESKTOP_HOST_API_VERSION } from "../../shared/science-extension-host-compatibility";
import type { SciencePackageArchiveSpec } from "./downloader";

const CATALOG_SCHEMA = "agentlas.science-catalog/v1";
const DEFAULT_CATALOG_URL = "https://agentlas.cloud/api/desktop/science/v1/catalog";
const CATALOG_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const COMPONENT_IDS = [
  "agentlas-science",
  "agentlas-science-renderer-ketcher",
  "agentlas-science-renderer-molstar",
] as const satisfies readonly ScienceSuiteComponentId[];

export interface ScienceCatalogPackageSpec extends SciencePackageArchiveSpec {
  displayName: string;
  description: string;
  desktopHostApi?: {
    name: typeof SCIENCE_DESKTOP_HOST_API_NAME;
    version: typeof SCIENCE_DESKTOP_HOST_API_VERSION;
  };
}

export interface ScienceReleaseCatalog {
  schema: typeof CATALOG_SCHEMA;
  releaseTag: string;
  suiteVersion: string;
  generatedAt: string;
  totalDownloadBytes: number;
  components: ScienceCatalogPackageSpec[];
}

let cachedCatalog: { url: string; at: number; value: ScienceReleaseCatalog } | null = null;
const CACHE_MS = 5 * 60_000;

function catalogUrl(isPackaged: boolean): URL {
  const override = !isPackaged ? process.env.AGENTLAS_SCIENCE_CATALOG_URL?.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(override || DEFAULT_CATALOG_URL);
  } catch {
    throw new Error("science-catalog-url-invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (isPackaged && (parsed.hostname !== "agentlas.cloud" || parsed.pathname !== "/api/desktop/science/v1/catalog"))
  ) {
    throw new Error("science-catalog-url-invalid");
  }
  return parsed;
}

function safeString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseComponent(value: unknown): ScienceCatalogPackageSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-catalog-invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "archiveBytes,archiveSha256,archiveUrl,description,desktopHostApi,displayName,id,version"
    && keys !== "archiveBytes,archiveSha256,archiveUrl,description,displayName,id,version") {
    throw new Error("science-catalog-invalid");
  }
  if (
    !COMPONENT_IDS.includes(record.id as ScienceSuiteComponentId)
    || !safeString(record.displayName, 80)
    || !safeString(record.description, 240)
    || !safeString(record.version, 32)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(record.version)
    || !safeString(record.archiveUrl, 2_048)
    || !Number.isSafeInteger(record.archiveBytes)
    || Number(record.archiveBytes) <= 0
    || Number(record.archiveBytes) > MAX_ARCHIVE_BYTES
    || typeof record.archiveSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.archiveSha256)
  ) {
    throw new Error("science-catalog-invalid");
  }
  let desktopHostApi: ScienceCatalogPackageSpec["desktopHostApi"];
  if (record.desktopHostApi !== undefined) {
    if (record.id !== "agentlas-science" || !record.desktopHostApi || typeof record.desktopHostApi !== "object" || Array.isArray(record.desktopHostApi)) {
      throw new Error("science-catalog-invalid");
    }
    const hostApi = record.desktopHostApi as Record<string, unknown>;
    if (Object.keys(hostApi).sort().join(",") !== "name,version"
      || hostApi.name !== SCIENCE_DESKTOP_HOST_API_NAME
      || typeof hostApi.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(hostApi.version)) throw new Error("science-catalog-invalid");
    if (hostApi.version !== SCIENCE_DESKTOP_HOST_API_VERSION) throw new Error("science-catalog-desktop-host-api-incompatible");
    desktopHostApi = { name: SCIENCE_DESKTOP_HOST_API_NAME, version: SCIENCE_DESKTOP_HOST_API_VERSION };
  }
  return {
    id: record.id as ScienceSuiteComponentId,
    displayName: record.displayName,
    description: record.description,
    version: record.version,
    archiveUrl: record.archiveUrl,
    archiveBytes: Number(record.archiveBytes),
    archiveSha256: record.archiveSha256,
    ...(desktopHostApi ? { desktopHostApi } : {}),
  };
}

function parseCatalog(value: unknown): ScienceReleaseCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-catalog-invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "components,generatedAt,releaseTag,schema,suiteVersion,totalDownloadBytes") {
    throw new Error("science-catalog-invalid");
  }
  if (
    record.schema !== CATALOG_SCHEMA
    || !safeString(record.releaseTag, 64)
    || !/^science-v\d+\.\d+\.\d+$/u.test(record.releaseTag)
    || !safeString(record.suiteVersion, 32)
    || !/^\d+\.\d+\.\d+$/u.test(record.suiteVersion)
    || !safeString(record.generatedAt, 64)
    || !Number.isFinite(Date.parse(record.generatedAt))
    || !Array.isArray(record.components)
    || record.components.length !== COMPONENT_IDS.length
    || !Number.isSafeInteger(record.totalDownloadBytes)
  ) {
    throw new Error("science-catalog-invalid");
  }
  const components = record.components.map(parseComponent);
  const ids = new Set(components.map((component) => component.id));
  const totalDownloadBytes = components.reduce((sum, component) => sum + component.archiveBytes, 0);
  if (
    ids.size !== COMPONENT_IDS.length
    || COMPONENT_IDS.some((id) => !ids.has(id))
    || record.releaseTag !== `science-v${record.suiteVersion}`
    || components.some((component) => {
      try {
        const archive = new URL(component.archiveUrl);
        return !archive.pathname.includes(`/releases/download/${record.releaseTag}/`);
      } catch {
        return true;
      }
    })
    || totalDownloadBytes !== record.totalDownloadBytes
  ) {
    throw new Error("science-catalog-invalid");
  }
  return {
    schema: CATALOG_SCHEMA,
    releaseTag: record.releaseTag,
    suiteVersion: record.suiteVersion,
    generatedAt: record.generatedAt,
    totalDownloadBytes,
    components,
  };
}

async function readBoundedJson(response: Response): Promise<ScienceReleaseCatalog> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_CATALOG_BYTES) {
      throw new Error("science-catalog-too-large");
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parseScienceReleaseCatalogBytes(bytes);
}

/**
 * Parse catalog bytes after the caller has fetched and, when required, authenticated them.
 * Release gates use this same parser for a candidate catalog so the candidate path cannot drift
 * from the production catalog schema/normalization rules.
 */
export function parseScienceReleaseCatalogBytes(bytes: Uint8Array): ScienceReleaseCatalog {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_CATALOG_BYTES) throw new Error("science-catalog-too-large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("science-catalog-invalid");
  }
  return parseCatalog(value);
}

export async function fetchScienceReleaseCatalog(isPackaged: boolean): Promise<ScienceReleaseCatalog> {
  const url = catalogUrl(isPackaged);
  const now = Date.now();
  if (cachedCatalog && cachedCatalog.url === url.toString() && now - cachedCatalog.at < CACHE_MS) {
    return cachedCatalog.value;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new Error("science-catalog-network-failed");
  }
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url || url.toString());
  } catch {
    throw new Error("science-catalog-redirect-invalid");
  }
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== url.hostname || finalUrl.pathname !== url.pathname) {
    throw new Error("science-catalog-redirect-invalid");
  }
  if (!response.ok) throw new Error(`science-catalog-http-${response.status}`);
  const catalog = await readBoundedJson(response);
  cachedCatalog = { url: url.toString(), at: now, value: catalog };
  return catalog;
}

export function resetScienceCatalogForTests(): void {
  cachedCatalog = null;
}
