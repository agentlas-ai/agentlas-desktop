import { createHash } from "node:crypto";

export const SCIENCE_MATERIALS_TOOL_ID = "agentlas.oqmd-optimade-structures" as const;
export const SCIENCE_MATERIALS_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_MATERIALS_LAB_ID = "materials-structures" as const;
export const SCIENCE_MATERIALS_ARTIFACT_SCHEMA = "agentlas.science.materials-catalog-artifact/v1" as const;
export const SCIENCE_MATERIALS_RESULT_SCHEMA = "agentlas.materials.oqmd-optimade/v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
type JsonRecord = Record<string, unknown>;

export interface ScienceMaterialsArtifactPayload {
  schema: typeof SCIENCE_MATERIALS_ARTIFACT_SCHEMA;
  inputSha256: string;
  responseSha256: string;
  source: { id: string; versionId: string; canonicalUri: string };
  normalized: {
    schema: typeof SCIENCE_MATERIALS_RESULT_SCHEMA;
    source: { provider: string; canonicalUri: string; license: string };
    structureCount: number;
    structures: Array<Record<string, unknown>>;
    table: {
      schema: "agentlas.science-table/v1";
      columns: Array<{ id: string; label: string; type: "string" | "number"; unit: string | null }>;
      rows: Array<Array<string | number | null>>;
    };
    rendererCompatibility: Record<string, unknown>;
    warnings: string[];
    normalizedSha256: string;
  };
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value.trim();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as JsonRecord).sort().flatMap((key) => {
    const child = (value as JsonRecord)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

export function scienceMaterialsSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

export function validateScienceMaterialsArtifactPayload(value: unknown): ScienceMaterialsArtifactPayload {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { throw new Error("science-materials-artifact-invalid"); }
  if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) throw new Error("science-materials-artifact-size-limit");
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "inputSha256", "responseSha256", "source", "normalized"])
    || payload.schema !== SCIENCE_MATERIALS_ARTIFACT_SCHEMA
    || typeof payload.inputSha256 !== "string" || !SHA256_RE.test(payload.inputSha256)
    || typeof payload.responseSha256 !== "string" || !SHA256_RE.test(payload.responseSha256)) {
    throw new Error("science-materials-artifact-invalid");
  }
  const source = record(payload.source);
  if (!source || !exactKeys(source, ["id", "versionId", "canonicalUri"])) throw new Error("science-materials-source-invalid");
  const sourceId = safeText(source.id, 80, "science-materials-source-invalid");
  const versionId = safeText(source.versionId, 80, "science-materials-source-invalid");
  const canonicalUri = safeText(source.canonicalUri, 4_000, "science-materials-source-invalid");
  let parsedUrl: URL;
  try { parsedUrl = new URL(canonicalUri); } catch { throw new Error("science-materials-source-invalid"); }
  if (parsedUrl.origin !== "https://oqmd.org" || parsedUrl.pathname !== "/optimade/v1/structures") throw new Error("science-materials-source-invalid");

  const normalized = record(payload.normalized);
  if (!normalized || !exactKeys(normalized, ["schema", "source", "structureCount", "structures", "table", "rendererCompatibility", "warnings", "normalizedSha256"])
    || normalized.schema !== SCIENCE_MATERIALS_RESULT_SCHEMA
    || typeof normalized.normalizedSha256 !== "string" || !SHA256_RE.test(normalized.normalizedSha256)
    || !Number.isSafeInteger(normalized.structureCount) || Number(normalized.structureCount) < 0 || Number(normalized.structureCount) > 50
    || !Array.isArray(normalized.structures) || normalized.structures.length !== normalized.structureCount
    || !Array.isArray(normalized.warnings) || normalized.warnings.length > 100 || normalized.warnings.some((item) => typeof item !== "string" || item.length > 2_000)) {
    throw new Error("science-materials-result-invalid");
  }
  const normalizedSource = record(normalized.source);
  if (!normalizedSource || !exactKeys(normalizedSource, ["provider", "canonicalUri", "license"])
    || normalizedSource.provider !== "Open Quantum Materials Database (OQMD)"
    || normalizedSource.canonicalUri !== "optimade:https://oqmd.org/optimade/v1"
    || normalizedSource.license !== "CC-BY-4.0") throw new Error("science-materials-provider-invalid");
  const table = record(normalized.table);
  if (!table || !exactKeys(table, ["schema", "columns", "rows"]) || table.schema !== "agentlas.science-table/v1"
    || !Array.isArray(table.columns) || table.columns.length !== 6 || !Array.isArray(table.rows) || table.rows.length !== normalized.structureCount) {
    throw new Error("science-materials-table-invalid");
  }
  const columns = table.columns.map((entry) => {
    const column = record(entry);
    if (!column || !exactKeys(column, ["id", "label", "type", "unit"])
      || !["string", "number"].includes(String(column.type)) || (column.unit !== null && typeof column.unit !== "string")) {
      throw new Error("science-materials-table-invalid");
    }
    return { id: safeText(column.id, 80, "science-materials-table-invalid"), label: safeText(column.label, 240, "science-materials-table-invalid"), type: column.type as "string" | "number", unit: column.unit === null ? null : safeText(column.unit, 120, "science-materials-table-invalid") };
  });
  if (new Set(columns.map((column) => column.id)).size !== columns.length) throw new Error("science-materials-table-invalid");
  const rows = table.rows.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== columns.length) throw new Error("science-materials-table-invalid");
    return entry.map((cell, index) => {
      if (cell === null) return null;
      if (columns[index]!.type === "number") {
        if (typeof cell !== "number" || !Number.isFinite(cell)) throw new Error("science-materials-table-invalid");
        return Object.is(cell, -0) ? 0 : cell;
      }
      return safeText(cell, 2_000, "science-materials-table-invalid");
    });
  });
  if (normalized.structures.some((entry) => !record(entry))) throw new Error("science-materials-structure-invalid");
  const rendererCompatibility = record(normalized.rendererCompatibility);
  if (!rendererCompatibility) throw new Error("science-materials-renderer-compatibility-invalid");

  return {
    schema: SCIENCE_MATERIALS_ARTIFACT_SCHEMA,
    inputSha256: String(payload.inputSha256),
    responseSha256: String(payload.responseSha256),
    source: { id: sourceId, versionId, canonicalUri },
    normalized: {
      schema: SCIENCE_MATERIALS_RESULT_SCHEMA,
      source: { provider: String(normalizedSource.provider), canonicalUri: String(normalizedSource.canonicalUri), license: String(normalizedSource.license) },
      structureCount: Number(normalized.structureCount),
      structures: normalized.structures as Array<Record<string, unknown>>,
      table: { schema: "agentlas.science-table/v1", columns, rows },
      rendererCompatibility,
      warnings: normalized.warnings as string[],
      normalizedSha256: String(normalized.normalizedSha256),
    },
  };
}
