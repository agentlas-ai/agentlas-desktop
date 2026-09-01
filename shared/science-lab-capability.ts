import {
  SCIENCE_ARTIFACT_KINDS,
  SCIENCE_RENDERER_IDS,
  type ScienceArtifactKind,
  type ScienceRendererId,
} from "./science-contract";

export const SCIENCE_LAB_OPERATIONS = [
  "plan",
  "read",
  "execute",
  "observe",
  "validate",
  "save-version",
  "compare",
  "cite",
] as const;

export type ScienceLabOperation = typeof SCIENCE_LAB_OPERATIONS[number];

export interface ScienceLabDescriptor {
  id: string;
  label: string;
  artifactKinds: ScienceArtifactKind[];
  rendererIds: ScienceRendererId[];
  supportedOperations: ScienceLabOperation[];
  aiCallableOperations: ScienceLabOperation[];
}

export interface ScienceLabToolDescriptor {
  id: string;
  version: string;
  runtime: "native-sidecar" | "electron-main";
  capability: "science:compute";
  network: "deny";
  labId: string;
  operation: ScienceLabOperation;
  primaryArtifact: {
    ordinal: number;
    kind: ScienceArtifactKind;
    rendererId: ScienceRendererId;
    labId: string;
  };
  mcp: {
    name: string;
    route: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
}

export interface ScienceServiceDescriptor {
  schema: "agentlas.science-service/v2";
  protocolVersion: 2;
  labs: ScienceLabDescriptor[];
  tools: ScienceLabToolDescriptor[];
}

export interface ScienceLabCapabilityCatalog {
  schema: "agentlas.science-lab-capability-catalog/v1";
  protocolVersion: 1;
  labs: ScienceLabDescriptor[];
  tools: ScienceLabToolDescriptor[];
}

const ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/i;
const MCP_NAME_RE = /^[a-z][a-z0-9_]{0,79}$/;
const ROUTE_RE = /^\/v1\/labs\/[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?\/tools\/[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) return null;
  return value.trim();
}

function uniqueStrings(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || value.some((item) => typeof item !== "string")) return null;
  const normalized = value.map(String);
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function jsonSchema(value: unknown): Record<string, unknown> | null {
  const schema = record(value);
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false || !record(schema.properties)) return null;
  let serialized = "";
  try { serialized = JSON.stringify(schema); } catch { return null; }
  if (serialized.length < 2 || new TextEncoder().encode(serialized).byteLength > 64 * 1024) return null;
  const properties = schema.properties as Record<string, unknown>;
  const toolCall = record(properties.tool_call_id);
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!toolCall || toolCall.type !== "string" || !required.includes("tool_call_id")) return null;
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function parseScienceServiceDescriptor(value: unknown): ScienceServiceDescriptor {
  const root = record(value);
  if (!root || !exactKeys(root, ["schema", "protocolVersion", "labs", "tools"])
    || root.schema !== "agentlas.science-service/v2" || root.protocolVersion !== 2
    || !Array.isArray(root.labs) || root.labs.length < 1 || root.labs.length > 64
    || !Array.isArray(root.tools) || root.tools.length < 1 || root.tools.length > 256) {
    throw new Error("science-service-descriptor-invalid");
  }

  const labs = root.labs.map((raw): ScienceLabDescriptor => {
    const item = record(raw);
    if (!item || !exactKeys(item, ["id", "label", "artifactKinds", "rendererIds", "supportedOperations", "aiCallableOperations"])) {
      throw new Error("science-service-lab-invalid");
    }
    const id = typeof item.id === "string" && ID_RE.test(item.id) ? item.id : null;
    const label = text(item.label, 120);
    const artifactKinds = uniqueStrings(item.artifactKinds, SCIENCE_ARTIFACT_KINDS.length);
    const rendererIds = uniqueStrings(item.rendererIds, SCIENCE_RENDERER_IDS.length);
    const supportedOperations = uniqueStrings(item.supportedOperations, SCIENCE_LAB_OPERATIONS.length);
    const aiCallableOperations = uniqueStrings(item.aiCallableOperations, SCIENCE_LAB_OPERATIONS.length);
    if (!id || !label || !artifactKinds || artifactKinds.some((kind) => !SCIENCE_ARTIFACT_KINDS.includes(kind as ScienceArtifactKind))
      || !rendererIds || rendererIds.some((rendererId) => !SCIENCE_RENDERER_IDS.includes(rendererId as ScienceRendererId))
      || !supportedOperations || supportedOperations.some((operation) => !SCIENCE_LAB_OPERATIONS.includes(operation as ScienceLabOperation))
      || !aiCallableOperations || aiCallableOperations.some((operation) => !SCIENCE_LAB_OPERATIONS.includes(operation as ScienceLabOperation) || !supportedOperations.includes(operation))) {
      throw new Error("science-service-lab-invalid");
    }
    return {
      id,
      label,
      artifactKinds: artifactKinds as ScienceArtifactKind[],
      rendererIds: rendererIds as ScienceRendererId[],
      supportedOperations: supportedOperations as ScienceLabOperation[],
      aiCallableOperations: aiCallableOperations as ScienceLabOperation[],
    };
  });
  if (new Set(labs.map((lab) => lab.id)).size !== labs.length) throw new Error("science-service-lab-duplicate");
  const labById = new Map(labs.map((lab) => [lab.id, lab]));

  const tools = root.tools.map((raw): ScienceLabToolDescriptor => {
    const item = record(raw);
    if (!item || !exactKeys(item, ["id", "version", "runtime", "capability", "network", "labId", "operation", "primaryArtifact", "mcp"])) {
      throw new Error("science-service-tool-invalid");
    }
    const primary = record(item.primaryArtifact);
    const mcp = record(item.mcp);
    const id = typeof item.id === "string" && ID_RE.test(item.id) ? item.id : null;
    const version = typeof item.version === "string" && VERSION_RE.test(item.version) ? item.version : null;
    const labId = typeof item.labId === "string" && ID_RE.test(item.labId) ? item.labId : null;
    const operation = typeof item.operation === "string" && SCIENCE_LAB_OPERATIONS.includes(item.operation as ScienceLabOperation)
      ? item.operation as ScienceLabOperation : null;
    if (!id || !version || !labId || !operation || !labById.has(labId)
      || !["native-sidecar", "electron-main"].includes(String(item.runtime))
      || item.capability !== "science:compute" || item.network !== "deny"
      || !primary || !exactKeys(primary, ["ordinal", "kind", "rendererId", "labId"])
      || primary.ordinal !== 1 || primary.labId !== labId
      || !SCIENCE_ARTIFACT_KINDS.includes(primary.kind as ScienceArtifactKind)
      || !SCIENCE_RENDERER_IDS.includes(primary.rendererId as ScienceRendererId)
      || !mcp || !exactKeys(mcp, ["name", "route", "description", "inputSchema"])) {
      throw new Error("science-service-tool-invalid");
    }
    const lab = labById.get(labId)!;
    if (!lab.artifactKinds.includes(primary.kind as ScienceArtifactKind)
      || !lab.rendererIds.includes(primary.rendererId as ScienceRendererId)
      || !lab.aiCallableOperations.includes(operation)) throw new Error("science-service-tool-capability-mismatch");
    const name = typeof mcp.name === "string" && MCP_NAME_RE.test(mcp.name) ? mcp.name : null;
    const route = typeof mcp.route === "string" && ROUTE_RE.test(mcp.route) && mcp.route.startsWith(`/v1/labs/${labId}/tools/`) ? mcp.route : null;
    const description = text(mcp.description, 1_000);
    const inputSchema = jsonSchema(mcp.inputSchema);
    if (!name || !route || !description || !inputSchema) throw new Error("science-service-tool-mcp-invalid");
    return {
      id,
      version,
      runtime: item.runtime as ScienceLabToolDescriptor["runtime"],
      capability: "science:compute",
      network: "deny",
      labId,
      operation,
      primaryArtifact: {
        ordinal: 1,
        kind: primary.kind as ScienceArtifactKind,
        rendererId: primary.rendererId as ScienceRendererId,
        labId,
      },
      mcp: { name, route, description, inputSchema },
    };
  });
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length
    || new Set(tools.map((tool) => tool.mcp.name)).size !== tools.length
    || new Set(tools.map((tool) => tool.mcp.route)).size !== tools.length) throw new Error("science-service-tool-duplicate");
  return { schema: "agentlas.science-service/v2", protocolVersion: 2, labs, tools };
}

export function scienceLabCapabilityCatalog(descriptor: ScienceServiceDescriptor): ScienceLabCapabilityCatalog {
  return {
    schema: "agentlas.science-lab-capability-catalog/v1",
    protocolVersion: 1,
    labs: descriptor.labs.map((lab) => ({ ...lab, artifactKinds: [...lab.artifactKinds], rendererIds: [...lab.rendererIds], supportedOperations: [...lab.supportedOperations], aiCallableOperations: [...lab.aiCallableOperations] })),
    tools: descriptor.tools.map((tool) => ({ ...tool, primaryArtifact: { ...tool.primaryArtifact }, mcp: { ...tool.mcp, inputSchema: JSON.parse(JSON.stringify(tool.mcp.inputSchema)) as Record<string, unknown> } })),
  };
}
