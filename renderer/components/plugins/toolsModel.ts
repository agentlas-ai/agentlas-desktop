// The tool library's three item types, mapped onto data the app already has.
//
//  · Skill     — an instruction document (SKILL.md plus helper files). Source:
//                Hub plugin manifests' `skills[]` (name, description, files with
//                content) — shared/bundled-hub-catalog.json, and the live manifest
//                read by mcpTools.previewHubPlugin (electron/mcp-tools/hub-plugin-bridge.ts:443-490).
//                Installed state: the bundle marker probed by previewHubPlugin's
//                `skillsAlreadyInstalled` (hub-plugin-bridge.ts:207-213, 489).
//  · Connector — an MCP server. Source: the registry rows (mcpTools.listInstalled,
//                electron/mcp-tools/registry.ts:59-64) and the connector catalog
//                (mcpTools.listCatalog → MCP_TOOL_CATALOG, electron/mcp-tools/catalog.ts).
//  · Plugin    — a Hub package that bundles connectors (`manifest.mcp[]`) and skills
//                (`manifest.skills[]`). Source: usePluginCatalog (marketplace.search +
//                bundled snapshot). A plugin's installed connectors are the registry
//                rows the Hub bridge names `<slug>:<server>` (hub-plugin-bridge.ts:596, 705, 722).
import snapshot from "../../../shared/bundled-hub-catalog.json";
import type { InstalledMcpServer, MarketplaceListing, McpServerStatus } from "@/lib/types";

export type ItemType = "plugin" | "connector" | "skill";

export interface ManifestConnector {
  name: string;
  transport: "http" | "sse" | "stdio" | string;
  url?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
}

export interface SkillFile { path: string; content: string }

export interface SkillRef {
  pluginSlug: string;
  name: string;
  description: string;
  /** Present only when the catalog carries the files themselves. */
  files: SkillFile[];
}

export interface PluginFacts {
  description: string;
  capabilities: string[];
  defaultPrompts: string[];
  connectors: ManifestConnector[];
  skills: SkillRef[];
}

interface RawSkill { name?: unknown; description?: unknown; descriptionKo?: unknown; files?: unknown }
interface RawPlugin {
  slug: string;
  description?: string;
  descriptionKo?: string;
  capabilities?: string[];
  defaultPrompts?: string[];
  monogram?: string;
  brandColor?: string;
  manifest?: { mcp?: unknown; skills?: unknown };
}

const RAW = (snapshot as unknown as { plugins: RawPlugin[] }).plugins;

/** The Hub catalog's own Latin monogram and brand colour for a slug. */
export function bundledBrand(slug: string): { monogram?: string; brandColor?: string } | null {
  const row = RAW.find((plugin) => plugin.slug === slug || plugin.slug.replace(/[-_]mcp$/, "") === slug);
  return row ? { monogram: row.monogram, brandColor: row.brandColor } : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function skillsOf(slug: string, raw: unknown, ko: boolean): SkillRef[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawSkill[]).flatMap((skill) => {
    const name = text(skill?.name);
    if (!name) return [];
    const files = Array.isArray(skill.files)
      ? (skill.files as Array<{ path?: unknown; content?: unknown }>).flatMap((file) => {
        const path = text(file?.path);
        return path && typeof file.content === "string" ? [{ path, content: file.content }] : [];
      })
      : [];
    return [{ pluginSlug: slug, name, description: (ko ? text(skill.descriptionKo) : "") || text(skill.description), files }];
  });
}

function connectorsOf(raw: unknown): ManifestConnector[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).flatMap((row) => {
    const name = text(row?.name);
    const transport = text(row?.transport);
    if (!name || !transport) return [];
    return [{
      name, transport,
      ...(text(row.url) ? { url: text(row.url) } : {}),
      ...(text(row.command) ? { command: text(row.command) } : {}),
      ...(Array.isArray(row.args) ? { args: (row.args as unknown[]).filter((arg): arg is string => typeof arg === "string") } : {}),
      ...(Array.isArray(row.envKeys) ? { envKeys: (row.envKeys as unknown[]).filter((key): key is string => typeof key === "string") } : {}),
    }];
  });
}

/** Facts the bundled Hub snapshot carries for a plugin. Null when the slug is not bundled. */
export function bundledPluginFacts(slug: string, ko: boolean): PluginFacts | null {
  const row = RAW.find((plugin) => plugin.slug === slug);
  if (!row) return null;
  return {
    description: (ko ? text(row.descriptionKo) : "") || text(row.description),
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter((value) => typeof value === "string") : [],
    defaultPrompts: Array.isArray(row.defaultPrompts) ? row.defaultPrompts.filter((value) => typeof value === "string" && value.trim()) : [],
    connectors: connectorsOf(row.manifest?.mcp),
    skills: skillsOf(slug, row.manifest?.skills, ko),
  };
}

/** Skills every bundled plugin manifest declares. */
export function bundledSkills(ko: boolean): SkillRef[] {
  return RAW.flatMap((plugin) => skillsOf(plugin.slug, plugin.manifest?.skills, ko));
}

/** Live manifest preview → the same shapes. Files are not part of the preview. */
export function factsFromPreview(slug: string, preview: { rows?: unknown; skills?: unknown }): Pick<PluginFacts, "connectors" | "skills"> {
  return { connectors: connectorsOf(preview.rows), skills: skillsOf(slug, preview.skills, false) };
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/** The Hub plugin a registry row was installed from, by the bridge's own `<slug>:<server>` naming. */
export function pluginSlugOfServer(server: InstalledMcpServer): string | null {
  if (server.catalogId) {
    const hub = server.catalogId.startsWith("hub:") ? server.catalogId.slice(4) : null;
    return hub && SLUG.test(hub) ? hub : null;
  }
  const index = server.name.indexOf(":");
  if (index <= 0) return null;
  const slug = server.name.slice(0, index);
  return SLUG.test(slug) ? slug : null;
}

/** The connector part of a plugin-owned row name (`github-mcp:github` → `github`). */
export function connectorDisplayName(server: InstalledMcpServer, ko: boolean): string {
  const base = ko ? server.name : server.nameEn || server.name;
  const slug = pluginSlugOfServer(server);
  if (slug && !server.catalogId && base.startsWith(`${slug}:`)) return base.slice(slug.length + 1) || base;
  return base;
}

/**
 * `saved` / `rejected` / `down` (VD): the connection has keys, and what a real call proved about them is word for word the server's `keyVerdict` (electron/mcp-tools/key-verdict.ts). "ready" ("Connected") is for a connection
 * whose keys the provider accepted (or that has none); a local program whose keys no call has used yet is `saved`, a refused key is `rejected`, a service that did not answer is `down` (the key is not blamed).
 */
export type ConnectionState = "unknown" | "off" | "keys" | "login" | "ready" | "unverified" | "pending" | "saved" | "rejected" | "down";

/** Typed status only — prose errors are never classified. */
export function connectionState(server: InstalledMcpServer, status: McpServerStatus | undefined, loadFailed: boolean): ConnectionState {
  if (loadFailed) return "unknown";
  if (!server.enabled) return "off";
  if (!status) return "pending";
  if (status.missingEnv.length > 0) return "keys";
  if (status.keyVerdict === "rejected") return "rejected";
  if (status.keyVerdict === "provider_down") return "down";
  if (status.failureCode === "authentication_required") return "login";
  if (status.connected && status.tools.length > 0) return status.keyVerdict === "saved" ? "saved" : "ready";
  return "unverified";
}

/** "12 tools · checked 14:07" - the proof line for a connection that answered a real tools/list; empty when nothing was proven. */
export function connectionProof(status: McpServerStatus | undefined, ko: boolean): string {
  if (!status || !status.connected || status.tools.length === 0) return "";
  const at = new Date(status.checkedAt);
  const time = Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString(ko ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  return ko ? `도구 ${status.tools.length}개${time ? ` · ${time} 확인` : ""}` : `${status.tools.length} tools${time ? ` · checked ${time}` : ""}`;
}

export function connectionLabel(state: ConnectionState, ko: boolean): string {
  switch (state) {
    case "unknown": return ko ? "상태 확인 불가" : "State unverified";
    case "off": return ko ? "꺼짐" : "Off";
    case "keys": return ko ? "키 필요" : "Key needed";
    case "login": return ko ? "로그인 필요" : "Sign-in needed";
    case "ready": return ko ? "연결됨" : "Connected";
    case "pending": return ko ? "확인 전" : "Not checked";
    case "saved": return ko ? "저장됨 · 첫 사용 뒤 연결됨" : "Saved · connected after first use";
    case "rejected": return ko ? "키를 받아 주지 않았어요" : "Key was not accepted";
    case "down": return ko ? "서비스가 응답하지 않아요 · 다시 확인해요" : "Service not answering · will check again";
    default: return ko ? "연결 확인 필요" : "Unverified";
  }
}

export function transportLabel(transport: string, ko: boolean): string {
  if (transport === "http") return "Streamable HTTP";
  if (transport === "sse") return "SSE";
  if (transport === "stdio") return ko ? "로컬 명령" : "Local command";
  return transport;
}

/** First sentence, bounded, for a one-line row. */
export function oneLine(value: string | undefined, max = 140): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The one sentence under a connection that did not answer, chosen from the typed failure the status carries (never from the words of the error).
 * The raw error text stays available to the person as detail, not as the message.
 */
export function connectionNoticeLine(status: Pick<McpServerStatus, "failureCode" | "missingEnv">, transport: string, ko: boolean): string {
  if (status.missingEnv.length > 0 || status.failureCode === "configuration_missing") return ko ? "필요한 키가 아직 없어요. '키 입력'으로 넣어 주세요." : "A required key is missing. Add it with Enter key.";
  if (status.failureCode === "authentication_required") return ko ? "로그인이나 키가 필요해요." : "Sign-in or a key is needed.";
  if (status.failureCode === "connection_cancelled") return ko ? "연결 확인을 취소했어요." : "The connection check was cancelled.";
  if (status.failureCode === "connection_unavailable") {
    return transport === "stdio"
      ? (ko ? "이 프로그램이 시작되지 않았거나 바로 종료됐어요. 명령과 인자를 확인해 주세요." : "This program did not start or ended right away. Check the command and its arguments.")
      : (ko ? "이 주소에 연결하지 못했어요. 주소와 네트워크를 확인해 주세요." : "Could not connect to this address. Check the address and your network.");
  }
  return ko ? "연결을 확인하지 못했어요." : "The connection could not be checked.";
}

export function listingName(listing: MarketplaceListing, ko: boolean): string {
  return ko ? listing.name : listing.nameEn || listing.name;
}

export function listingTagline(listing: MarketplaceListing, ko: boolean): string {
  return ko ? listing.tagline : listing.taglineEn || listing.tagline;
}

/** Hostname for a link label; null when the value is not a URL. */
export function hostOf(value: string | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try { return new URL(value).hostname; } catch { return null; }
}
