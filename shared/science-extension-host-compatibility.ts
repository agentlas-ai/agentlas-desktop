import { createHash } from "node:crypto";

export const SCIENCE_EXTENSION_HOST_COMPATIBILITY_SCHEMA = "agentlas.science-extension-host-compatibility/v1" as const;
export const SCIENCE_DESKTOP_HOST_API_NAME = "agentlas.science-tool-control" as const;
export const SCIENCE_DESKTOP_HOST_API_VERSION = "1.0.0" as const;
export const SCIENCE_EXTENSION_UPDATE_MODE = "extension-only" as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,79}$/u;
const ROUTE_RE = /^\/v1\/[a-z0-9/._-]+$/u;

type JsonRecord = Record<string, unknown>;

export interface ScienceExtensionHostPlatformToolRequirement {
  name: string;
  route: string;
  inputSchemaSha256: string;
}

export interface ScienceExtensionHostCompatibility {
  schema: typeof SCIENCE_EXTENSION_HOST_COMPATIBILITY_SCHEMA;
  extension: {
    id: "agentlas-science";
    version: string;
    minimumDesktopVersion: string;
    updateMode: typeof SCIENCE_EXTENSION_UPDATE_MODE;
    serviceEntry: "service/descriptor.json";
  };
  service: {
    descriptorSchema: "agentlas.science-service/v2";
    protocolVersion: 2;
  };
  desktopHost: {
    apiName: typeof SCIENCE_DESKTOP_HOST_API_NAME;
    apiVersion: typeof SCIENCE_DESKTOP_HOST_API_VERSION;
    requiredPlatformTools: ScienceExtensionHostPlatformToolRequirement[];
  };
  boundary: {
    extensionOwned: ["lab-descriptor", "renderer-assets", "science-ui"];
    desktopOwned: ["artifact-lineage-validation", "platform-tool-api", "project-store-schema", "trusted-network-brokers"];
  };
}

export interface ScienceDesktopHostCompatibilitySnapshot {
  apiName: typeof SCIENCE_DESKTOP_HOST_API_NAME;
  apiVersion: typeof SCIENCE_DESKTOP_HOST_API_VERSION;
  platformTools: ScienceExtensionHostPlatformToolRequirement[];
}

export interface ScienceExtensionHostCompatibilityContext {
  extensionId: string;
  extensionVersion: string;
  minimumDesktopVersion: string;
  serviceEntry: string;
  descriptorSchema: string;
  protocolVersion: number;
  desktopHost: ScienceDesktopHostCompatibilitySnapshot;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b, "en"));
  const expected = [...keys].sort((a, b) => a.localeCompare(b, "en"));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const source = value as JsonRecord;
  return Object.fromEntries(Object.keys(source).sort((a, b) => a.localeCompare(b, "en")).map((key) => [key, canonicalValue(source[key])]));
}

export function scienceExtensionHostCompatibilityCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function scienceExtensionHostCompatibilitySha256(value: unknown): string {
  return createHash("sha256").update(scienceExtensionHostCompatibilityCanonicalJson(value), "utf8").digest("hex");
}

function parsePlatformToolRequirement(value: unknown): ScienceExtensionHostPlatformToolRequirement {
  const code = "science-extension-host-platform-tool-invalid";
  const tool = record(value, code);
  if (!exactKeys(tool, ["name", "route", "inputSchemaSha256"])
    || typeof tool.name !== "string" || !TOOL_NAME_RE.test(tool.name)
    || typeof tool.route !== "string" || !ROUTE_RE.test(tool.route)
    || typeof tool.inputSchemaSha256 !== "string" || !SHA256_RE.test(tool.inputSchemaSha256)) fail(code);
  return { name: tool.name, route: tool.route, inputSchemaSha256: tool.inputSchemaSha256 };
}

export function parseScienceExtensionHostCompatibility(value: unknown): ScienceExtensionHostCompatibility {
  const code = "science-extension-host-compatibility-invalid";
  const root = record(value, code);
  if (!exactKeys(root, ["schema", "extension", "service", "desktopHost", "boundary"])
    || root.schema !== SCIENCE_EXTENSION_HOST_COMPATIBILITY_SCHEMA) fail(code);
  const extension = record(root.extension, code);
  const service = record(root.service, code);
  const desktopHost = record(root.desktopHost, code);
  const boundary = record(root.boundary, code);
  if (!exactKeys(extension, ["id", "version", "minimumDesktopVersion", "updateMode", "serviceEntry"])
    || extension.id !== "agentlas-science"
    || typeof extension.version !== "string" || !SEMVER_RE.test(extension.version)
    || typeof extension.minimumDesktopVersion !== "string" || !SEMVER_RE.test(extension.minimumDesktopVersion)
    || extension.updateMode !== SCIENCE_EXTENSION_UPDATE_MODE
    || extension.serviceEntry !== "service/descriptor.json") fail(code);
  if (!exactKeys(service, ["descriptorSchema", "protocolVersion"])
    || service.descriptorSchema !== "agentlas.science-service/v2" || service.protocolVersion !== 2) fail(code);
  if (!exactKeys(desktopHost, ["apiName", "apiVersion", "requiredPlatformTools"])
    || desktopHost.apiName !== SCIENCE_DESKTOP_HOST_API_NAME
    || desktopHost.apiVersion !== SCIENCE_DESKTOP_HOST_API_VERSION
    || !Array.isArray(desktopHost.requiredPlatformTools)
    || desktopHost.requiredPlatformTools.length < 1
    || desktopHost.requiredPlatformTools.length > 64) fail(code);
  const requiredPlatformTools = desktopHost.requiredPlatformTools.map(parsePlatformToolRequirement);
  if (new Set(requiredPlatformTools.map((tool) => tool.name)).size !== requiredPlatformTools.length
    || new Set(requiredPlatformTools.map((tool) => tool.route)).size !== requiredPlatformTools.length
    || requiredPlatformTools.some((tool, index) => index > 0 && tool.name.localeCompare(requiredPlatformTools[index - 1]!.name, "en") <= 0)) fail(code);
  const extensionOwned = ["lab-descriptor", "renderer-assets", "science-ui"] as const;
  const desktopOwned = ["artifact-lineage-validation", "platform-tool-api", "project-store-schema", "trusted-network-brokers"] as const;
  if (!exactKeys(boundary, ["extensionOwned", "desktopOwned"])
    || scienceExtensionHostCompatibilityCanonicalJson(boundary.extensionOwned) !== scienceExtensionHostCompatibilityCanonicalJson(extensionOwned)
    || scienceExtensionHostCompatibilityCanonicalJson(boundary.desktopOwned) !== scienceExtensionHostCompatibilityCanonicalJson(desktopOwned)) fail(code);
  return {
    schema: SCIENCE_EXTENSION_HOST_COMPATIBILITY_SCHEMA,
    extension: {
      id: "agentlas-science",
      version: extension.version,
      minimumDesktopVersion: extension.minimumDesktopVersion,
      updateMode: SCIENCE_EXTENSION_UPDATE_MODE,
      serviceEntry: "service/descriptor.json",
    },
    service: { descriptorSchema: "agentlas.science-service/v2", protocolVersion: 2 },
    desktopHost: { apiName: SCIENCE_DESKTOP_HOST_API_NAME, apiVersion: SCIENCE_DESKTOP_HOST_API_VERSION, requiredPlatformTools },
    boundary: { extensionOwned: [...extensionOwned], desktopOwned: [...desktopOwned] },
  };
}

export function assertScienceExtensionHostCompatibility(
  value: unknown,
  context: ScienceExtensionHostCompatibilityContext,
): ScienceExtensionHostCompatibility {
  const compatibility = parseScienceExtensionHostCompatibility(value);
  if (compatibility.extension.id !== context.extensionId
    || compatibility.extension.version !== context.extensionVersion
    || compatibility.extension.minimumDesktopVersion !== context.minimumDesktopVersion
    || compatibility.extension.serviceEntry !== context.serviceEntry
    || compatibility.service.descriptorSchema !== context.descriptorSchema
    || compatibility.service.protocolVersion !== context.protocolVersion) fail("science-extension-package-compatibility-mismatch");
  if (compatibility.desktopHost.apiName !== context.desktopHost.apiName
    || compatibility.desktopHost.apiVersion !== context.desktopHost.apiVersion) fail("science-extension-desktop-host-api-incompatible");
  const actualByName = new Map(context.desktopHost.platformTools.map((tool) => [tool.name, tool]));
  for (const required of compatibility.desktopHost.requiredPlatformTools) {
    const actual = actualByName.get(required.name);
    if (!actual || actual.route !== required.route || actual.inputSchemaSha256 !== required.inputSchemaSha256) {
      fail("science-extension-desktop-host-tool-incompatible");
    }
  }
  return compatibility;
}
