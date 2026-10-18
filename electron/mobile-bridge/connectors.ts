// Mobile Bridge 커넥터 — 폰의 "도구" 화면이 Desktop 도구 라이브러리(library/mcps)와 같은 커넥터를
// 보고 켜고 끄고 카탈로그에서 추가하게 하는 닫힌 투영 (2026-10-17, 오너: "커넥터 플러그인 이런거
// 모바일에 없지 만들어야지").
//
// ★ Desktop 화면과 같은 규칙
//   - Agentlas 가 스스로 등록한 서버(host-provided)는 Desktop 화면처럼 숨기고, 켜고 끌 수도 없다.
//     규칙은 renderer/components/plugins/hostProvided.ts 와 같다. 다만 Main 은 process.execPath 를
//     직접 알므로 카탈로그에서 실행 파일을 추론하지 않는다.
//   - 켜기/끄기·추가는 Desktop 이 쓰는 그 함수(registry.setServerEnabled / installFromCatalog)를
//     그대로 부른다. 폰 전용 경로를 따로 만들지 않는다.
// ★ 값은 폰으로 가지 않는다
//   - 필수 키가 있는 카탈로그 항목은 폰에서 추가하지 않는다(connector_needs_desktop_setup).
//     키는 Desktop Keychain 에만 들어간다. 원격 로그인(OAuth)도 Desktop 브라우저에서만 끝난다 —
//     폰은 test 결과의 failureCode("authentication_required")로 "Desktop 에서 로그인"을 안내한다.
//   - command/args/url 은 투영하지 않는다(로컬 경로·토큰 URL 이 섞일 수 있다).
import type { InstalledMcpServer, McpServerStatus, McpToolCatalogEntry } from "../../shared/types";
import { MCP_TOOL_CATALOG } from "../mcp-tools/catalog";
import { getServer, installFromCatalog, listInstalledServers, setServerConnectionEnabled } from "../mcp-tools/registry";
import { testServerById } from "../mcp-tools/client";
import { sanitizeMobileBridgeText } from "./sanitize";

const DEDICATED_LAUNCHER = "plugin-tool-launcher.js";
const MAX_ROWS = 100;

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function isDedicatedPluginLaunch(row: { command?: string | null; args?: string[] }): boolean {
  const args = row.args ?? [];
  return Boolean(row.command)
    && args.length >= 8
    && basename(args[0]) === DEDICATED_LAUNCHER
    && args[1] === "--plugin-root"
    && args[3] === "--release-digest"
    && args[5] === "--entry"
    && args.includes("--", 7);
}

function isAgentlasHomeCommand(command: string | null | undefined): boolean {
  return !!command && /^~[\\/]\.agentlas[\\/]/.test(command);
}

function isHostLaunch(row: { transport: string; command?: string | null; args?: string[] }, execPath: string): boolean {
  if (row.transport !== "stdio" || !row.command) return false;
  // Built-in resolvers ([execPath, "-e", …]) and bundled plugin releases both launch the Agentlas
  // executable; the Hephaestus runtime lives under ~/.agentlas/.
  return row.command === execPath || isDedicatedPluginLaunch(row) || isAgentlasHomeCommand(row.command);
}

export interface ConnectorHostFacts {
  execPath: string;
  catalog: readonly McpToolCatalogEntry[];
}

function hostFacts(): ConnectorHostFacts {
  return { execPath: process.execPath, catalog: MCP_TOOL_CATALOG };
}

/** Catalog ids whose launch is a host launch contract (renderer hostProvided.ts catalogIds). */
export function hostCatalogIds(facts: ConnectorHostFacts): Set<string> {
  return new Set(facts.catalog.filter((entry) => isHostLaunch(entry, facts.execPath)).map((entry) => entry.id));
}

export function isHostProvidedConnector(server: InstalledMcpServer, facts: ConnectorHostFacts): boolean {
  if (isHostLaunch(server, facts.execPath)) return true;
  return Boolean(server.catalogId && hostCatalogIds(facts).has(server.catalogId));
}

function text(value: string | null | undefined, maxBytes: number): string {
  return sanitizeMobileBridgeText(value ?? "", maxBytes);
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/** The Hub plugin that installed this row (renderer toolsModel.ts pluginSlugOfServer, mirrored). */
export function pluginSlugOfConnector(server: InstalledMcpServer): string | null {
  if (server.catalogId) {
    const hub = server.catalogId.startsWith("hub:") ? server.catalogId.slice(4) : null;
    return hub && SLUG.test(hub) ? hub : null;
  }
  const index = server.name.indexOf(":");
  if (index <= 0) return null;
  const slug = server.name.slice(0, index);
  return SLUG.test(slug) ? slug : null;
}

function requiresKeys(entry: McpToolCatalogEntry): boolean {
  return entry.envRequirements.some((requirement) => requirement.required !== false);
}

export interface MobileConnectorRow {
  id: string;
  catalogId: string | null;
  /** Hub plugin slug when a plugin installed this connector; the phone groups by it. */
  pluginSlug: string | null;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  category: string;
  remote: boolean;
  enabled: boolean;
  ready: boolean;
  keyCount: number;
}

export interface MobileConnectorCatalogRow {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  category: string;
  remote: boolean;
  official: boolean;
  needsDesktopSetup: boolean;
}

export interface MobileConnectorList {
  installed: MobileConnectorRow[];
  catalog: MobileConnectorCatalogRow[];
}

function projectInstalled(server: InstalledMcpServer, catalogById: Map<string, McpToolCatalogEntry>): MobileConnectorRow {
  const entry = server.catalogId ? catalogById.get(server.catalogId) : undefined;
  const pluginSlug = pluginSlugOfConnector(server);
  // `github-mcp:github` shows as `github` under its plugin, as on Desktop (connectorDisplayName).
  const bare = (name: string) => pluginSlug && !server.catalogId && name.startsWith(`${pluginSlug}:`)
    ? name.slice(pluginSlug.length + 1) || name : name;
  return {
    id: text(server.id, 256),
    catalogId: server.catalogId ? text(server.catalogId, 256) : null,
    pluginSlug: pluginSlug ? text(pluginSlug, 128) : null,
    name: text(bare(server.name || server.nameEn), 256),
    nameEn: text(bare(server.nameEn || server.name), 256),
    description: text(entry?.description ?? "", 1_000),
    descriptionEn: text(entry?.descriptionEn ?? "", 1_000),
    category: entry?.category ?? "custom",
    remote: server.transport !== "stdio",
    enabled: server.enabled,
    ready: server.configurationValid !== false,
    keyCount: server.envKeys.length,
  };
}

export function listMobileConnectors(
  installed: readonly InstalledMcpServer[] = listInstalledServers(),
  facts: ConnectorHostFacts = hostFacts(),
): MobileConnectorList {
  const hostIds = hostCatalogIds(facts);
  const catalogById = new Map(facts.catalog.map((entry) => [entry.id, entry]));
  const visible = installed.filter((server) => !isHostProvidedConnector(server, facts));
  const installedCatalogIds = new Set(installed.map((server) => server.catalogId).filter(Boolean));
  return {
    installed: visible.slice(0, MAX_ROWS).map((server) => projectInstalled(server, catalogById)),
    catalog: facts.catalog
      .filter((entry) => !hostIds.has(entry.id) && !installedCatalogIds.has(entry.id))
      .slice(0, MAX_ROWS)
      .map((entry) => ({
        id: text(entry.id, 256),
        name: text(entry.name, 256),
        nameEn: text(entry.nameEn, 256),
        description: text(entry.description, 1_000),
        descriptionEn: text(entry.descriptionEn, 1_000),
        category: entry.category,
        remote: entry.transport !== "stdio",
        official: entry.trust === "official",
        needsDesktopSetup: requiresKeys(entry),
      })),
  };
}

function refusal(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A connector the phone may change: present, and not one Agentlas registered for itself. */
function userConnector(id: string, facts: ConnectorHostFacts): InstalledMcpServer {
  const server = getServer(id);
  if (!server) throw refusal("connector_not_found");
  if (isHostProvidedConnector(server, facts)) throw refusal("connector_host_provided");
  return server;
}

export function setMobileConnectorEnabled(id: string, enabled: boolean, facts: ConnectorHostFacts = hostFacts()): MobileConnectorRow {
  userConnector(id, facts);
  // Off is a revoke, as on the desktop switch (NH29): a session prepared before cannot return when it is switched on.
  const server = setServerConnectionEnabled(id, enabled);
  return projectInstalled(server, new Map(facts.catalog.map((entry) => [entry.id, entry])));
}

export function installMobileConnector(catalogId: string, facts: ConnectorHostFacts = hostFacts()): MobileConnectorRow {
  const entry = facts.catalog.find((row) => row.id === catalogId);
  if (!entry || hostCatalogIds(facts).has(entry.id)) throw refusal("connector_not_found");
  if (requiresKeys(entry)) throw refusal("connector_needs_desktop_setup");
  const server = installFromCatalog(entry.id);
  return projectInstalled(server, new Map(facts.catalog.map((row) => [row.id, row])));
}

export interface MobileConnectorTest {
  id: string;
  connected: boolean;
  toolCount: number;
  missingKeyCount: number;
  failureCode: McpServerStatus["failureCode"] | null;
  checkedAt: string;
}

export function projectConnectorTest(status: McpServerStatus): MobileConnectorTest {
  return {
    id: text(status.id, 256),
    connected: status.connected,
    toolCount: status.tools.length,
    missingKeyCount: status.missingEnv.length,
    // Typed transport fact only; the prose error never crosses to the phone.
    failureCode: status.failureCode ?? null,
    checkedAt: status.checkedAt,
  };
}

export async function testMobileConnector(id: string, facts: ConnectorHostFacts = hostFacts()): Promise<MobileConnectorTest> {
  userConnector(id, facts);
  return projectConnectorTest(await testServerById(id));
}
