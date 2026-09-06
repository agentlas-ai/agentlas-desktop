// 실제 MCP 클라이언트 — @modelcontextprotocol/sdk로 외부 서버에 붙어 tools/list.
// 트랜스포트 3종: stdio(npx) / SSE(레거시 원격) / Streamable HTTP(현대 원격 표준).
// 시크릿은 keychain 글로벌 vault에서 읽어 stdio는 자식 env로, 원격은 HTTP 헤더로 주입.
//
// 현재 범위: 연결 테스트 + 툴 목록 조회(관리 화면용). 채팅 중 실제 tool-call 실행은
// 다음 단계(런너의 function-calling 루프 + CLI mcp.json 주입)로 분리.
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readEnvVar } from "../secrets/vault";
import { listInstalledServers, getServer } from "./registry";
import { withCliPath } from "../runtime/exec";
import { withUvxPath } from "./uv-runtime";
import {
  OPENCRAB_CATALOG_ID,
  OPENCRAB_MCP_URL_KEY,
  isOpenCrabCredentialUrl,
  validateOpenCrabMcpUrl,
  vaultUrlKey,
} from "../opencrab/constants";
import type { InstalledMcpServer, McpServerStatus } from "../../shared/types";
import { isCanonicalSystemTimeMcpServer } from "./system-time-server";
import { isCanonicalComputerUseMcpServer } from "../computer-use/mcp-server";
import { COMPUTER_USE_CONTROL_FILE_ENV, computerUseControlInfoPath } from "../computer-use/channel";
import {
  resetHephaestusCache,
  readHephaestusVersion,
  resolveHephaestusStdioLaunch,
  startHephaestusRuntimeAutoUpdate,
} from "../hephaestus/engine";
import { rejectHephaestusRuntimeRoot } from "../hephaestus/root";
import workforceProtocolContract from "./workforce-protocol-contract.json";
import { electronAppVersion } from "../runtime-paths";

/** npx 첫 다운로드까지 고려한 넉넉한 연결 타임아웃. */
const CONNECT_TIMEOUT_MS = 45_000;
const WORKFORCE_TOOL_TIMEOUT_MAX_MS = 5 * 60_000;
const MAX_REMOTE_URL_CHARS = 4_096;
const DEFAULT_TOOL_TEXT_LIMIT = 256_000;
const MAX_TOOL_TEXT_LIMIT = 16 * 1024 * 1024;
const HEPHAESTUS_NETWORK_CATALOG_ID = "hephaestus-network";
const WORKFORCE_MCP_CAPABILITIES = workforceProtocolContract.tools.requiredNames;
const WORKFORCE_PROTOCOL_METADATA = workforceProtocolContract.protocolMetadata;
const WORKFORCE_PROTOCOL_METADATA_KEYS = [
  ...Object.keys(WORKFORCE_PROTOCOL_METADATA),
  "protocolDigest",
].sort();

function canonicalFlatDigest(value: Record<string, unknown>): string {
  const canonical = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

export const WORKFORCE_EXPECTED_PROTOCOL_DIGEST = canonicalFlatDigest(WORKFORCE_PROTOCOL_METADATA);

type WorkforceMcpInventoryTool = {
  name: string;
  inputSchema?: unknown;
  _meta?: unknown;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Only decide closed, direct object schemas. Composition, references, patterns,
 * and unfamiliar keywords are left to the server; this is not a schema validator.
 * Compare supplied keys without dropping transaction receipts or changing args.
 */
export function explicitlyRejectedMcpArgumentKeys(
  inputSchema: unknown,
  args: Record<string, unknown>,
): string[] {
  const schema = recordValue(inputSchema);
  if (schema?.type !== "object" || schema.additionalProperties !== false) return [];
  const directObjectKeys = new Set([
    "type", "properties", "required", "additionalProperties",
    "$schema", "$id", "$comment", "title", "description", "default", "examples",
    "deprecated", "readOnly", "writeOnly", "minProperties", "maxProperties",
  ]);
  if (Object.keys(schema).some((key) => !directObjectKeys.has(key))) return [];
  const properties = schema.properties === undefined ? {} : recordValue(schema.properties);
  if (!properties) return [];
  return Object.keys(args).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
}

function exactStringSetIssue(
  value: unknown,
  expected: readonly string[],
  label: string,
): string | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return `${label} is not a string array`;
  }
  const actual = value as string[];
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    new Set(actual).size !== actual.length ||
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((entry, index) => entry !== expectedSorted[index])
  ) {
    return `${label} does not exactly match the Desktop contract`;
  }
  return null;
}

function workforceToolProtocolMetadata(
  tool: WorkforceMcpInventoryTool,
): Record<string, unknown> | null {
  const meta = recordValue(tool._meta);
  return recordValue(meta?.["agentlas/workforce-protocol"]);
}

/**
 * Check the complete protocol generation before tools/call. Structural similarity
 * is not compatibility: all tools must advertise the exact canonical metadata and
 * digest shipped with this Desktop generation.
 */
/**
 * 워크포스 계약 대조 결과. **차단(blocking)과 경고(warning)를 가른다.**
 *
 * 오너 결정 2026-07-28: 예전에는 이 함수가 낸 항목이 **전부 차단**이었다. 그래서 Core 가
 * 프로토콜 값 하나(예: `ontologyVersion`)만 올려도 이미 배포된 모든 데스크탑에서
 * 워크포스가 멈췄다 — "엔진은 따로 오픈소스로 굴리고 셸은 최신을 문다"는 설계와 정면으로
 * 부딪치는 성질이었다.
 *
 * 이제 **능력(도구가 있는가)만 차단**하고, 값 드리프트(입력 필드 집합, enum, 메타데이터,
 * 다이제스트)는 경고로 내린다. 도구 이름도 **완전 일치가 아니라 부분집합**으로 본다 —
 * Core 가 도구를 추가하는 것은 미노출일 뿐 결함이 아니라는 오너 규칙과 일치한다.
 *
 * ★경고는 조용히 버리지 않는다. 값 계약이 실제로 달라졌으면 나중에 런타임 오류로
 *   나타나는데, 그때 이 경고가 로그에 없으면 원인을 찾을 수 없다.
 */
export interface WorkforceContractVerdict {
  blocking: string[];
  warnings: string[];
}

export function workforceMcpContractIssues(tools: WorkforceMcpInventoryTool[]): WorkforceContractVerdict {
  const issues: string[] = [];
  const blocking: string[] = [];
  const workforceNames = tools
    .filter((tool) => tool.name.startsWith("workforce."))
    .map((tool) => tool.name);
  // 능력 검사: 필요한 도구가 **있는가**. 추가된 도구는 문제가 아니다.
  const advertised = new Set(workforceNames);
  const missingNames = workforceProtocolContract.tools.requiredNames
    .filter((name) => !advertised.has(name));
  if (missingNames.length) {
    blocking.push(`Workforce tool inventory is missing: ${missingNames.join(", ")}`);
  }
  const extraNames = workforceNames
    .filter((name) => !workforceProtocolContract.tools.requiredNames.includes(name));
  if (extraNames.length) {
    issues.push(`Workforce runtime advertises tools this Desktop does not use: ${extraNames.join(", ")}`);
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const searchContract = workforceProtocolContract.tools.searchCandidates;
  const validateContract = workforceProtocolContract.tools.validateSelection;
  const prepareContract = workforceProtocolContract.tools.prepareExecution;
  const search = byName.get(searchContract.name);
  const validate = byName.get(validateContract.name);
  const prepare = byName.get(prepareContract.name);
  if (!search || !validate || !prepare) {
    blocking.push("required Workforce tools are missing");
    return { blocking, warnings: issues };
  }
  const searchSchema = recordValue(search.inputSchema);
  const searchRequiredIssue = exactStringSetIssue(
    searchSchema?.required,
    searchContract.requiredInputFields,
    "search_candidates required inputs",
  );
  if (searchRequiredIssue) issues.push(searchRequiredIssue);
  const searchProperties = recordValue(searchSchema?.properties);
  const sourceScope = recordValue(searchProperties?.sourceScope);
  const sourceScopeIssue = exactStringSetIssue(
    sourceScope?.enum,
    searchContract.sourceScopeValues,
    "search_candidates sourceScope enum",
  );
  if (sourceScopeIssue) issues.push(sourceScopeIssue);
  const validateSchema = recordValue(validate.inputSchema);
  const validateRequiredIssue = exactStringSetIssue(
    validateSchema?.required,
    validateContract.requiredInputFields,
    "validate_selection required inputs",
  );
  if (validateRequiredIssue) issues.push(validateRequiredIssue);
  const prepareSchema = recordValue(prepare.inputSchema);
  const prepareRequiredIssue = exactStringSetIssue(
    prepareSchema?.required,
    prepareContract.requiredInputFields,
    "prepare_execution required inputs",
  );
  if (prepareRequiredIssue) issues.push(prepareRequiredIssue);
  const prepareProperties = recordValue(prepareSchema?.properties);
  const preparePropertiesIssue = exactStringSetIssue(
    prepareProperties ? Object.keys(prepareProperties) : null,
    prepareContract.inputPropertyFields,
    "prepare_execution properties",
  );
  if (preparePropertiesIssue) issues.push(preparePropertiesIssue);
  const prepareAttempt = recordValue(prepareProperties?.prepareAttempt);
  if (prepareAttempt?.additionalProperties !== false) {
    issues.push("prepareAttempt must reject undeclared fields");
  }
  const prepareAttemptRequiredIssue = exactStringSetIssue(
    prepareAttempt?.required,
    prepareContract.prepareAttemptRequiredFields,
    "prepareAttempt required fields",
  );
  if (prepareAttemptRequiredIssue) issues.push(prepareAttemptRequiredIssue);
  const prepareAttemptProperties = recordValue(prepareAttempt?.properties);
  const prepareAttemptPropertiesIssue = exactStringSetIssue(
    prepareAttemptProperties ? Object.keys(prepareAttemptProperties) : null,
    prepareContract.prepareAttemptRequiredFields,
    "prepareAttempt properties",
  );
  if (prepareAttemptPropertiesIssue) issues.push(prepareAttemptPropertiesIssue);
  const prepareAttemptSchemaVersion = recordValue(prepareAttemptProperties?.schemaVersion);
  if (prepareAttemptSchemaVersion?.const !== WORKFORCE_PROTOCOL_METADATA.prepareAttemptSchemaVersion) {
    issues.push("prepareAttempt schema version is incompatible");
  }

  const metadataRows = [search, validate, prepare]
    .map(workforceToolProtocolMetadata);
  if (!metadataRows.every(Boolean)) {
    issues.push("Workforce protocol metadata is missing or only partially advertised");
  }
  for (const metadata of metadataRows.filter((row): row is Record<string, unknown> => row !== null)) {
    const keys = Object.keys(metadata).sort();
    if (keys.length !== WORKFORCE_PROTOCOL_METADATA_KEYS.length ||
        keys.some((key, index) => key !== WORKFORCE_PROTOCOL_METADATA_KEYS[index])) {
      issues.push("Workforce protocol metadata keys are incompatible");
      continue;
    }
    if (Object.entries(WORKFORCE_PROTOCOL_METADATA).some(([key, value]) => metadata[key] !== value)) {
      issues.push("Workforce protocol metadata is incompatible");
      continue;
    }
    const declaredDigest = metadata.protocolDigest;
    if (typeof declaredDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(declaredDigest)) {
      issues.push("Workforce protocol digest is invalid");
      continue;
    }
    const digestPreimage = Object.fromEntries(
      Object.entries(metadata).filter(([key]) => key !== "protocolDigest"),
    );
    if (canonicalFlatDigest(digestPreimage) !== declaredDigest ||
        declaredDigest !== WORKFORCE_EXPECTED_PROTOCOL_DIGEST) {
      issues.push("Workforce protocol digest does not match the canonical Desktop contract");
    }
  }
  if (metadataRows.every(Boolean)) {
    const digests = new Set(metadataRows.map((row) => String(row?.protocolDigest)));
    if (digests.size !== 1) issues.push("Workforce tools advertise different protocol digests");
  }
  return { blocking: [...new Set(blocking)], warnings: [...new Set(issues)] };
}

export class McpToolCallError extends Error {
  constructor(
    readonly boundary: "pre-request-error" | "ambiguous-transport" | "received-protocol-error",
    readonly mcpCode: number | null,
    message: string,
    readonly reason: "response-too-large" | null = null,
  ) {
    super(message);
    this.name = "McpToolCallError";
  }
}

export class McpToolResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`MCP tool text response exceeded the ${limit}-character limit.`);
    this.name = "McpToolResponseTooLargeError";
  }
}

export function joinMcpToolText(
  content: Array<{ type?: string; text?: string }>,
  maxTextChars: number,
): string {
  const joined = content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  if (joined.length > maxTextChars) throw new McpToolResponseTooLargeError(maxTextChars);
  return joined;
}

export function resolveMcpToolTextLimit(requested?: number): number {
  return Math.max(1, Math.min(requested ?? DEFAULT_TOOL_TEXT_LIMIT, MAX_TOOL_TEXT_LIMIT));
}

export type McpToolCallPhase = "pre-request" | "send-started" | "response-received";

export interface McpToolCallBoundaryState {
  phase: McpToolCallPhase;
  requestId: string | number | null;
}

/**
 * Error classes and codes alone cannot prove where an MCP error originated:
 * the SDK uses McpError for local connection closure/timeouts and exposes a
 * Zod parse error for a malformed received result.  The transport boundary is
 * authoritative instead: before tools/call send is pre-request, after send but
 * before a matching response is ambiguous, and any matching response is a
 * received protocol/payload failure that must never be replayed.
 */
export function classifyMcpToolCallBoundary(
  _error: unknown,
  phase: McpToolCallPhase,
): McpToolCallError["boundary"] {
  if (phase === "pre-request") return "pre-request-error";
  if (phase === "response-received") return "received-protocol-error";
  return "ambiguous-transport";
}

export function instrumentMcpToolCallTransport(
  transport: Transport,
  state: McpToolCallBoundaryState,
): void {
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (
      "method" in message &&
      message.method === "tools/call" &&
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number")
    ) {
      state.phase = "send-started";
      state.requestId = message.id;
    }
    await originalSend(message, options);
  };
  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (
      state.phase === "send-started" &&
      state.requestId !== null &&
      "id" in message &&
      message.id === state.requestId &&
      !("method" in message)
    ) {
      state.phase = "response-received";
    }
    originalOnMessage?.(message as JSONRPCMessage, extra);
  };
}

/** OpenCrab's allowlist applies to the exact validated endpoint. Never let a
 *  30x response pivot the main process to localhost or another network host. */
export const openCrabNoRedirectFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: "error" });

function expandHome(arg: string): string {
  if (arg === "~") return os.homedir();
  if (arg.startsWith("~/")) return os.homedir() + arg.slice(1);
  return arg;
}

/** 서버가 요구하는 env 키를 vault에서 채워 { resolved, missing } 반환. */
async function resolveEnv(envKeys: string[]): Promise<{ resolved: Record<string, string>; missing: string[] }> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of envKeys) {
    const v = await readEnvVar(k);
    if (v) resolved[k] = v;
    else missing.push(k);
  }
  return { resolved, missing };
}

/**
 * 원격(sse/http) 서버의 envKeys→vault 값을 HTTP 요청 헤더로 매핑한다.
 * 헤더 이름은 envKey 그대로(예: `Authorization`), 값은 vault 값(예: `Bearer …`).
 * URL 경로에 토큰이 내장된 서버는 URL 자체를 vault에서 읽고 해당 키를 헤더에 넣지 않는다.
 */
function buildRemoteHeaders(
  envKeys: string[],
  resolved: Record<string, string>,
  urlVaultKey: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const k of envKeys) {
    // URL vault 포인터는 인증 헤더가 아니다. 원격 요청에 키 이름/URL을 중복 노출하지 않는다.
    if (k === urlVaultKey) continue;
    const v = resolved[k];
    if (v) headers[k] = v;
  }
  return headers;
}

function parseRemoteUrl(server: InstalledMcpServer, resolved: Record<string, string>): {
  url: URL;
  urlVaultKey: string | null;
} {
  if (!server.url) throw new Error("sse/http server has no url");
  const urlVaultKey = vaultUrlKey(server.url);
  if (urlVaultKey && !server.envKeys.includes(urlVaultKey)) {
    throw new Error("secure remote MCP endpoint is missing");
  }
  const raw = urlVaultKey ? resolved[urlVaultKey] : server.url;
  if (!raw) throw new Error("secure remote MCP endpoint is missing");
  if (raw.length > MAX_REMOTE_URL_CHARS) throw new Error("secure remote MCP endpoint is invalid");
  const secureOpenCrab = server.catalogId === OPENCRAB_CATALOG_ID;
  if (secureOpenCrab && urlVaultKey !== OPENCRAB_MCP_URL_KEY) {
    throw new Error("secure remote MCP endpoint is invalid");
  }
  if (!secureOpenCrab && (isOpenCrabCredentialUrl(server.url) || isOpenCrabCredentialUrl(raw))) {
    // A legacy/custom row must be migrated to the catalog+Keychain boundary.
    // Never execute it with generic URL or redirect behavior.
    throw new Error("secure remote MCP endpoint is invalid");
  }

  let url: URL;
  try {
    url = secureOpenCrab ? validateOpenCrabMcpUrl(raw) : new URL(raw);
  } catch {
    // URL 파서 오류에는 입력값이 포함될 수 있으므로 원래 예외를 전달하지 않는다.
    throw new Error("secure remote MCP endpoint is invalid");
  }
  // Existing explicit custom URLs retain their current localhost/http support.
  // A vault-backed URL is credential material and must never use plaintext HTTP.
  if (urlVaultKey && (url.protocol !== "https:" || url.username || url.password)) {
    throw new Error("secure remote MCP endpoint is invalid");
  }
  return { url, urlVaultKey };
}

function redactResolvedSecrets(message: string, resolved: Record<string, string>): string {
  let safe = message;
  const candidates = new Set<string>();
  for (const value of Object.values(resolved)) {
    if (!value) continue;
    candidates.add(value);
    candidates.add(encodeURIComponent(value));
    try {
      const url = new URL(value);
      if (url.pathname.length >= 8) candidates.add(url.pathname);
      if (url.pathname.length >= 8) candidates.add(encodeURI(url.pathname));
      for (const segment of url.pathname.split("/")) {
        if (segment.length >= 8) {
          candidates.add(segment);
          candidates.add(encodeURIComponent(segment));
        }
      }
      for (const value of url.searchParams.values()) {
        if (value.length >= 8) candidates.add(value);
      }
    } catch {
      // 일반 env secret은 정확한 전체 값만 가린다.
    }
  }
  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    safe = safe.split(candidate).join("[redacted]");
  }
  // OpenCrab URL 토큰이 서버 오류에 단독으로 반사되는 경우까지 막는다.
  return safe.replace(/ocm_[A-Za-z0-9_-]{12,}/g, "[redacted]");
}

/**
 * 트랜스포트 팩토리 — stdio / sse / http 분기를 한 곳에.
 * stdio는 resolved를 자식 env로, 원격은 HTTP 헤더로 주입한다.
 * http는 현대 표준인 Streamable HTTP로, sse만 레거시 SSE로 연결한다(예전엔 둘 다 SSE라
 * Streamable HTTP 전용 서버 연결이 깨졌다).
 */
interface CreatedTransport {
  transport: Transport;
  runtimeRoot: string | null;
}

export interface McpRuntimePin {
  runtimeRoot: string | null;
  runtimeVersion: string | null;
  protocolDigest: string | null;
}

export function createMcpRuntimePin(): McpRuntimePin {
  return { runtimeRoot: null, runtimeVersion: null, protocolDigest: null };
}

async function createTransport(
  server: InstalledMcpServer,
  resolved: Record<string, string>,
  runtimeRootOverride?: string | null,
): Promise<CreatedTransport> {
  if (server.catalogId === "agentlas-time" && !isCanonicalSystemTimeMcpServer(server)) {
    throw new Error("Agentlas System Time MCP launch contract is invalid");
  }
  if (server.catalogId === "cua-driver" && !isCanonicalComputerUseMcpServer(server)) {
    throw new Error("Agentlas Computer Use MCP launch contract is invalid");
  }
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("stdio server has no command");
    // uvx 로 도는 공식 벤더 서버가 13개다. uv 는 이 앱이 마련해 준다 — 사용자가 따로
    // 깔아 두지 않았다는 이유로 그 13개가 전부 죽으면 안 된다(withUvxPath 안의 사유 참조).
    const baseEnv = withUvxPath(
      server.command,
      withCliPath({ ...getDefaultEnvironment(), PATH: process.env.PATH ?? "" }),
    );
    const stdioEnv = Object.fromEntries(
      Object.entries(baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    if (
      server.catalogId === "agentlas-browser" ||
      server.catalogId === "playwright" ||
      isCanonicalSystemTimeMcpServer(server) ||
      isCanonicalComputerUseMcpServer(server)
    ) {
      stdioEnv.ELECTRON_RUN_AS_NODE = "1";
    }
    if (isCanonicalComputerUseMcpServer(server)) {
      stdioEnv[COMPUTER_USE_CONTROL_FILE_ENV] = computerUseControlInfoPath();
    }
    let command = expandHome(server.command);
    let args = (server.args ?? []).map(expandHome);
    let runtimeRoot: string | null = null;
    if (server.catalogId === HEPHAESTUS_NETWORK_CATALOG_ID) {
      // Workforce is the one caller that acts on its own rejections: when a
      // preflight finds an engine missing required Workforce tools, its retry
      // must land somewhere else. Nothing outside this path is affected.
      const launch = await resolveHephaestusStdioLaunch(
        "agentlas_cloud",
        ["mcp", "serve"],
        runtimeRootOverride ?? undefined,
        { excludeRejected: true },
      );
      if (!launch) throw new Error("Agentlas OS runtime or Python 3.9+ is unavailable");
      command = launch.command;
      args = launch.args;
      runtimeRoot = launch.runtimeRoot;
      for (const [key, value] of Object.entries(launch.env)) {
        if (typeof value === "string") stdioEnv[key] = value;
      }
    }
    const transport = new StdioClientTransport({
      command,
      args,
      // getDefaultEnvironment()는 PATH/HOME 등 안전한 기본값 — 거기에 시크릿을 얹는다.
      env: { ...stdioEnv, ...resolved },
      stderr: "ignore",
    }) as unknown as Transport;
    return { transport, runtimeRoot };
  }
  const { url, urlVaultKey } = parseRemoteUrl(server, resolved);
  const headers = buildRemoteHeaders(server.envKeys, resolved, urlVaultKey);
  const init = {
    ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
    ...(server.catalogId === OPENCRAB_CATALOG_ID ? { fetch: openCrabNoRedirectFetch } : {}),
  };
  const transport = (server.transport === "sse"
    ? new SSEClientTransport(url, init)
    : new StreamableHTTPClientTransport(url, init)) as unknown as Transport;
  return { transport, runtimeRoot: null };
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    throw new Error("MCP tool call aborted");
  }
  let detach = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const listener = () => {
      onAbort();
      reject(new Error("MCP tool call aborted"));
    };
    signal.addEventListener("abort", listener, { once: true });
    detach = () => signal.removeEventListener("abort", listener);
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    detach();
  }
}

async function closeMcpProbeBounded(client: Client, transport: Transport | null): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Some SDK transports can leave close() pending after a failed initialize.
    // A second transport-level close is fire-and-forget so JIT inventory never
    // inherits an unbounded cleanup wait.
    void transport?.close().catch(() => {});
  }
}

/** 한 서버에 붙어 tools/list 해보고 상태 반환. 연결은 즉시 닫는다(테스트 전용). */
export async function testServerConnection(
  server: InstalledMcpServer,
  options?: { timeoutMs?: number },
): Promise<McpServerStatus> {
  const checkedAt = new Date().toISOString();
  const { resolved, missing } = await resolveEnv(server.envKeys);

  // 필수 env가 비어 있으면 굳이 spawn하지 않고 막힌 상태로 반환.
  if (missing.length > 0) {
    return { id: server.id, connected: false, tools: [], error: null, missingEnv: missing, checkedAt };
  }

  const client = new Client(
    { name: "agentlas-desktop", version: electronAppVersion() },
    { capabilities: {} },
  );

  let transport: Transport | null = null;
  try {
    transport = (await createTransport(server, resolved)).transport;

    const timeoutMs = Math.max(250, Math.min(options?.timeoutMs ?? CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS));
    const tools = await withTimeout(
      (async () => {
        await client.connect(transport);
        const res = await client.listTools();
        return res.tools;
      })(),
      timeoutMs,
      () => {
        void transport?.close().catch(() => {});
      },
    );

    await closeMcpProbeBounded(client, transport);
    return { id: server.id, connected: true, tools, error: null, missingEnv: [], checkedAt };
  } catch (err) {
    await closeMcpProbeBounded(client, transport);
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = server.catalogId === OPENCRAB_CATALOG_ID
      ? "OpenCrab connection failed"
      : redactResolvedSecrets(rawMessage, resolved);
    return {
      id: server.id,
      connected: false,
      tools: [],
      error: message.slice(0, 300),
      missingEnv: missing,
      checkedAt,
    };
  }
}

export interface McpToolContentResult {
  text: string;
  images: Array<{ mediaType: "image/png" | "image/jpeg"; data: string }>;
}

export interface McpToolCallOptions {
  timeoutMs?: number;
  maxTextChars?: number;
  signal?: AbortSignal;
  /** Mutable transaction seal. First compatible Workforce call fills it; all
   * later calls must use the exact same real runtime target/version/protocol. */
  runtimePin?: McpRuntimePin;
}

function workforceProtocolDigest(tools: WorkforceMcpInventoryTool[]): string | null {
  const row = tools.find((tool) => tool.name === "workforce.search_candidates");
  const metadata = row ? workforceToolProtocolMetadata(row) : null;
  return typeof metadata?.protocolDigest === "string" ? metadata.protocolDigest : null;
}

async function callServerToolContentInternal(
  server: InstalledMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  options?: McpToolCallOptions,
): Promise<McpToolContentResult | null> {
  let resolved: Record<string, string> = {};
  let client: Client | null = null;
  const boundaryState: McpToolCallBoundaryState = { phase: "pre-request", requestId: null };
  try {
    const environment = await resolveEnv(server.envKeys);
    resolved = environment.resolved;
    if (environment.missing.length > 0) return null; // 자격증명 미충족 — 폴 스킵(needsCredential UI가 안내).

    const workforceCall = server.catalogId === HEPHAESTUS_NETWORK_CATALOG_ID &&
      toolName.startsWith("workforce.");
    const timeoutCeiling = workforceCall ? WORKFORCE_TOOL_TIMEOUT_MAX_MS : CONNECT_TIMEOUT_MS;
    const timeoutMs = Math.max(250, Math.min(options?.timeoutMs ?? CONNECT_TIMEOUT_MS, timeoutCeiling));
    const maxTextChars = resolveMcpToolTextLimit(options?.maxTextChars);
    const result = await withAbortSignal(withTimeout(
      (async () => {
        if (options?.runtimePin && !workforceCall) {
          throw new Error("Runtime transaction pins are supported only for Agentlas Workforce calls");
        }
        // Workforce never changes Core underneath one logical transaction. A
        // background updater may prepare the next run, but this run fails
        // closed instead of silently switching to a different runtime.
        const maxRuntimeAttempts = server.catalogId !== HEPHAESTUS_NETWORK_CATALOG_ID
          ? 1
          : workforceCall
            // Before the first tools/call there is no remote side effect and no
            // transaction root yet. If a newer global Core advertises an
            // incompatible protocol, select the exact Core shipped with this
            // Desktop once, then seal that immutable root for every later
            // Workforce stage. This is runtime compatibility selection, not a
            // Local/Cloud/Hub source fallback.
            ? (options?.runtimePin?.runtimeRoot ? 1 : 2)
            : 2;
        for (let attempt = 0; attempt < maxRuntimeAttempts; attempt += 1) {
          boundaryState.phase = "pre-request";
          boundaryState.requestId = null;
          const activeClient = new Client(
            { name: "agentlas-desktop", version: electronAppVersion() },
            { capabilities: {} },
          );
          client = activeClient;
          const created = await createTransport(server, resolved, options?.runtimePin?.runtimeRoot);
          const transport = created.transport;
          instrumentMcpToolCallTransport(transport, boundaryState);
          await activeClient.connect(transport);

          if (server.catalogId === HEPHAESTUS_NETWORK_CATALOG_ID) {
            const inventory = await activeClient.listTools();
            const available = new Set(inventory.tools.map((tool) => tool.name));
            const required = toolName.startsWith("workforce.")
              ? WORKFORCE_MCP_CAPABILITIES
              : [toolName];
            const missing = required.filter((name) => !available.has(name));
            const verdict = toolName.startsWith("workforce.")
              ? workforceMcpContractIssues(inventory.tools as WorkforceMcpInventoryTool[])
              : { blocking: [], warnings: [] };
            // 값 드리프트는 실행을 막지 않지만 **반드시 남긴다**. 계약이 실제로 달라졌다면
            // 나중에 런타임 오류로 나타나는데, 이 줄이 없으면 원인을 찾을 수 없다.
            for (const warning of verdict.warnings) {
              console.warn(`[workforce] contract drift (non-blocking): ${warning}`);
            }
            const contractIssues = [...verdict.blocking];
            if (workforceCall) {
              const runtimeVersion = readHephaestusVersion(created.runtimeRoot);
              const serverVersion = (
                activeClient as unknown as {
                  getServerVersion?: () => { name?: string; version?: string } | undefined;
                }
              ).getServerVersion?.();
              const protocolDigest = workforceProtocolDigest(
                inventory.tools as WorkforceMcpInventoryTool[],
              );
              if (!created.runtimeRoot || !runtimeVersion) {
                contractIssues.push("Workforce runtime has no canonical root/version identity");
              }
              if (serverVersion?.name !== HEPHAESTUS_NETWORK_CATALOG_ID ||
                  serverVersion.version !== runtimeVersion) {
                contractIssues.push("Workforce MCP server version does not match its runtime artifact");
              }
              const pin = options?.runtimePin;
              if (pin?.runtimeRoot && pin.runtimeRoot !== created.runtimeRoot) {
                contractIssues.push("Workforce runtime root changed inside one transaction");
              }
              if (pin?.runtimeVersion && pin.runtimeVersion !== runtimeVersion) {
                contractIssues.push("Workforce runtime version changed inside one transaction");
              }
              if (pin?.protocolDigest && pin.protocolDigest !== protocolDigest) {
                contractIssues.push("Workforce protocol changed inside one transaction");
              }
              if (missing.length === 0 && contractIssues.length === 0 && pin) {
                pin.runtimeRoot = created.runtimeRoot;
                pin.runtimeVersion = runtimeVersion;
                pin.protocolDigest = protocolDigest;
              }
            }
            if (missing.length > 0 || contractIssues.length > 0) {
              await closeMcpProbeBounded(activeClient, transport);
              client = null;
              if (attempt + 1 < maxRuntimeAttempts && created.runtimeRoot) {
                // No tools/call request has been sent, so changing the official
                // runtime and retrying is not an ambiguous replay. Reject the
                // exact real target (not the mutable `current` symlink), then
                // use the bundled safety floor while its updater repairs global.
                rejectHephaestusRuntimeRoot(created.runtimeRoot);
                resetHephaestusCache();
                void startHephaestusRuntimeAutoUpdate();
                continue;
              }
              const detail = [
                ...(missing.length > 0 ? [`missing tools: ${missing.join(", ")}`] : []),
                ...contractIssues,
              ].join("; ");
              throw new Error(
                `workforce_runtime_incompatible: Agentlas OS runtime is incompatible with Desktop Workforce: ${detail}`,
              );
            }
            const rejectedKeys = explicitlyRejectedMcpArgumentKeys(
              (inventory.tools as WorkforceMcpInventoryTool[]).find((tool) => tool.name === toolName)?.inputSchema,
              args,
            );
            if (rejectedKeys.length > 0) {
              throw new Error(
                `MCP input schema for ${toolName} explicitly rejects supplied arguments: ${rejectedKeys.join(", ")}`,
              );
            }
          }

          const res = (await activeClient.callTool({ name: toolName, arguments: args })) as {
            content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
          };
          const content = res.content ?? [];
          const text = joinMcpToolText(content, maxTextChars);
          const images: McpToolContentResult["images"] = [];
          let imageBytes = 0;
          for (const item of content) {
            if (
              item?.type !== "image" ||
              (item.mimeType !== "image/png" && item.mimeType !== "image/jpeg") ||
              typeof item.data !== "string" ||
              !/^[A-Za-z0-9+/=]+$/.test(item.data)
            ) continue;
            imageBytes += Math.ceil(item.data.length * 0.75);
            if (images.length >= 4 || imageBytes > 8 * 1024 * 1024) {
              throw new McpToolResponseTooLargeError(8 * 1024 * 1024);
            }
            images.push({ mediaType: item.mimeType, data: item.data });
          }
          await activeClient.close().catch(() => {});
          client = null;
          return { text, images };
        }
        throw new Error(`Agentlas OS runtime could not provide MCP tool: ${toolName}`);
      })(),
      timeoutMs,
      () => {
        void client?.close().catch(() => {});
      },
    ), options?.signal, () => {
      void client?.close().catch(() => {});
    });
    return result;
  } catch (err) {
    await (client as Client | null)?.close().catch(() => {});
    const rawMessage = err instanceof Error ? err.message : String(err);
    const mcpCode = err instanceof McpError ? err.code : null;
    const boundary = classifyMcpToolCallBoundary(err, boundaryState.phase);
    const reason = err instanceof McpToolResponseTooLargeError ? "response-too-large" : null;
    throw new McpToolCallError(
      boundary,
      mcpCode,
      server.catalogId === OPENCRAB_CATALOG_ID
        ? "OpenCrab query failed"
        : redactResolvedSecrets(rawMessage, resolved),
      reason,
    );
  }
}

/** Call one MCP tool and retain safe PNG/JPEG content for vision-capable local engines. */
export function callServerToolContent(
  server: InstalledMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  options?: McpToolCallOptions,
): Promise<McpToolContentResult | null> {
  return callServerToolContentInternal(server, toolName, args, options);
}

/**
 * Text-only compatibility wrapper used by poll sources and existing callers.
 * Image-aware local model loops call callServerToolContent instead.
 */
export async function callServerTool(
  server: InstalledMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  options?: McpToolCallOptions,
): Promise<string | null> {
  const result = await callServerToolContentInternal(server, toolName, args, options);
  return result?.text ?? null;
}

export async function testServerById(id: string): Promise<McpServerStatus> {
  const server = getServer(id);
  if (!server) {
    return {
      id,
      connected: false,
      tools: [],
      error: "server not found",
      missingEnv: [],
      checkedAt: new Date().toISOString(),
    };
  }
  return testServerConnection(server);
}

/**
 * Passive health surfaces (Dashboard, startup readiness) must never launch a
 * visible browser merely to ask whether an on-demand browser MCP is usable.
 * `testServerById` remains the explicit path that starts and probes it.
 */
function deferredInteractiveStatus(server: InstalledMcpServer, checkedAt: string): McpServerStatus {
  return {
    id: server.id,
    connected: false,
    tools: [],
    error: null,
    missingEnv: [],
    checkedAt,
    deferred: "interactive",
  };
}

function needsInteractiveLaunchForHealthCheck(server: InstalledMcpServer): boolean {
  // Browser MCPs may boot a dedicated visible browser/profile on their first
  // stdio connection. Treat both built-in browser variants as on-demand;
  // probing Agentlas Browser from Dashboard used to open a blank Chrome tab on
  // every Dashboard visit.
  return server.catalogId === "agentlas-browser" || server.catalogId === "playwright";
}

export interface McpStatusAllDependencies {
  listServers?: () => InstalledMcpServer[];
  probe?: (server: InstalledMcpServer) => Promise<McpServerStatus>;
  now?: () => Date;
}

/**
 * 활성화된 서버를 병렬 점검한다. 사용자에게 보이는 앱을 여는 서버는 설정됨으로만
 * 표시하고, 사용자가 해당 서버의 "테스트" 또는 실제 브라우저 작업을 요청할 때만
 * 연결한다.
 */
export async function statusAllServers(
  deps: McpStatusAllDependencies = {},
): Promise<McpServerStatus[]> {
  const servers = (deps.listServers ?? listInstalledServers)().filter((s) => s.enabled);
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  const probe = deps.probe ?? testServerConnection;
  // 전부 동시에 spawn하면 무거우니 env 누락은 즉시, 나머지는 연결 점검.
  return Promise.all(servers.map((server) =>
    needsInteractiveLaunchForHealthCheck(server)
      ? deferredInteractiveStatus(server, checkedAt)
      : probe(server),
  ));
}
