import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import type { ScienceCapabilityCatalogInput, ScienceCapabilityCatalogItem, ScienceCapabilityCatalogKind,
  ScienceCapabilityCatalogResult, ScienceCapabilityManagerInput } from "../../shared/science-capability-catalog";

type Row = Record<string, unknown>;
const SHA = /^[a-f0-9]{64}$/u;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-capability-input-invalid");
  return value as Row;
}
function only(value: Row, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("science-capability-input-invalid");
}
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max) : "";
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("science-capability-identity-invalid");
  return value;
}

/** Reads two host-owned data files only; never imports a skill/provider or reads a SKILL body. */
export function readScientificSkillCatalogMetadata(root: string): { releaseSha256: string; indexSha256: string; skills: Row[] } {
  const canonicalRoot = fs.realpathSync.native(root);
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("science-capability-library-symlink-denied");
  const generation = () => {
    const s = fs.lstatSync(root);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(root) !== canonicalRoot)
      throw new Error("science-capability-library-changed");
    return `${s.dev}:${s.ino}`;
  };
  const initialGeneration = generation();
  function read(relative: string, maximum: number): Buffer {
    const components = relative.split("/");
    let location = root;
    const ancestors = [root];
    for (const component of components) { location = path.join(location, component); ancestors.push(location); }
    const snapshot = () => ancestors.map((p, i) => {
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink() || (i < ancestors.length - 1 ? !s.isDirectory() : !s.isFile()))
        throw new Error("science-capability-library-file-invalid");
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    });
    const before = snapshot();
    const fd = fs.openSync(location, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.size < 1 || s.size > maximum || `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` !== before.at(-1))
        throw new Error("science-capability-library-file-invalid");
      const bytes = Buffer.alloc(s.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new Error("science-capability-library-changed");
        offset += count;
      }
      const after = fs.fstatSync(fd);
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== before.at(-1)
        || JSON.stringify(snapshot()) !== JSON.stringify(before) || generation() !== initialGeneration)
        throw new Error("science-capability-library-changed");
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  const manifestBytes = read("plugin.json", 2 * 1024 * 1024);
  const manifest = row(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.slug !== "agentlas-science-skills") throw new Error("science-capability-library-invalid");
  const declarations = row(manifest.integrity).files;
  const entries = Array.isArray(declarations) ? declarations.filter(value => row(value).path === "schemas/skill-index.json") : [];
  if (entries.length !== 1 || !SHA.test(String(row(entries[0]).sha256))) throw new Error("science-capability-library-index-undeclared");
  const bytes = read("schemas/skill-index.json", 4 * 1024 * 1024);
  const entry = row(entries[0]);
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256
    || hash(read("plugin.json", 2 * 1024 * 1024)) !== hash(manifestBytes))
    throw new Error("science-capability-library-index-pin-mismatch");
  const index = row(JSON.parse(bytes.toString("utf8")));
  if (index.schema !== "agentlas.science-skill-index/v3" || !Array.isArray(index.skills)
    || index.count !== index.skills.length || index.skills.length > 2000) throw new Error("science-capability-library-index-invalid");
  return { releaseSha256: hash(manifestBytes), indexSha256: hash(bytes), skills: index.skills.map(row) };
}

export interface ScienceCapabilityCatalogPorts {
  skills(): ReturnType<typeof readScientificSkillCatalogMetadata>;
  /** Metadata rows only, never server status/transport preparation. */
  connectors(): Array<{ id: string; name: string; nameEn?: string; catalogId?: string | null;
    transport: string; enabled: boolean; configurationValid?: boolean }>;
  agents(): Array<{ id: string; slug: string; name: string; builtin: number }>;
  routes(): Array<{ agentId: string; kind: string; source?: string; missingSince?: string }>;
}
export function createScienceCapabilityCatalog(ports: ScienceCapabilityCatalogPorts) {
  function registeredAgents(): ScienceCapabilityCatalogItem[] {
    const routes = new Map(ports.routes().map(route => [route.agentId, route]));
    return ports.agents().filter(agent => !agent.builtin).flatMap(agent => {
      const route = routes.get(agent.id);
      if (route?.kind === "team") return [];
      return [{ id: identity(agent.id), name: text(agent.name, 160) || text(agent.slug, 160),
        summary: text(agent.slug, 160), origin: text(route?.source, 64) || "local-import",
        registration: !route || route.missingSince || route.kind !== "agent" ? "source-unavailable" as const : "registered" as const,
        execution: "on-demand" as const }];
    });
  }
  function all(kind: ScienceCapabilityCatalogKind): { items: ScienceCapabilityCatalogItem[]; provenance?: unknown } {
    if (kind === "specialists") return { items: registeredAgents() };
    const connectors = ports.connectors().filter(server => server.catalogId !== "agentlas-science");
    if (kind === "connectors") return { items: connectors.map(server => ({ id: identity(server.id),
      name: text(server.nameEn, 160) || text(server.name, 160), summary: text(server.transport, 24),
      origin: text(server.catalogId, 128) || "custom", registration: server.configurationValid === false ? "invalid"
        : server.enabled ? "enabled" : "disabled", execution: "unknown" })) };
    const library = ports.skills();
    const provider = connectors.find(server => server.catalogId === "agentlas-science-skills");
    const registration = provider?.configurationValid === false ? "invalid" : !provider ? "unregistered" : provider.enabled ? "enabled" : "disabled";
    return { items: library.skills.map(skill => ({ id: identity(skill.name), name: text(skill.name, 160),
      summary: text(skill.description, 420), origin: "bundled-metadata", registration, execution: "on-demand" })),
      provenance: { releaseSha256: library.releaseSha256, indexSha256: library.indexSha256 } };
  }
  return {
    catalog(input: ScienceCapabilityCatalogInput): ScienceCapabilityCatalogResult {
      const value = row(input); only(value, ["kind", "query", "offset", "limit", "expectedCatalogSha256"]);
      if (!["skills", "connectors", "specialists"].includes(String(value.kind))
        || value.query !== undefined && (typeof value.query !== "string" || value.query.length > 160 || /[\u0000-\u001f\u007f]/u.test(value.query)))
        throw new Error("science-capability-input-invalid");
      const kind = value.kind as ScienceCapabilityCatalogKind;
      const offset = value.offset ?? 0, limit = value.limit ?? 40;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 60
        || value.expectedCatalogSha256 !== undefined && !SHA.test(String(value.expectedCatalogSha256))
        || Number(offset) > 0 && !value.expectedCatalogSha256) throw new Error("science-capability-page-invalid");
      const query = text(value.query, 160).toLowerCase();
      const inventory = all(kind);
      const items = inventory.items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("science-capability-duplicate-identity");
      const catalogSha256 = hash(JSON.stringify({ kind, query, items, provenance: inventory.provenance ?? null }));
      if (value.expectedCatalogSha256 && value.expectedCatalogSha256 !== catalogSha256) throw new Error("science-capability-catalog-changed");
      const matches = items.filter(item => `${item.name} ${item.summary} ${item.origin}`.toLowerCase().includes(query));
      if (Number(offset) > matches.length) throw new Error("science-capability-page-invalid");
      return { schema: "agentlas.science-capability-catalog.v1", kind, query, offset: Number(offset), limit: Number(limit),
        total: matches.length, nextOffset: Number(offset) + Number(limit) < matches.length ? Number(offset) + Number(limit) : null,
        catalogSha256, items: matches.slice(Number(offset), Number(offset) + Number(limit)) };
    },
    manager(input: ScienceCapabilityManagerInput): string {
      const value = row(input); only(value, ["manager", "agentId"]);
      if (value.manager !== "specialist-files" && value.agentId !== undefined) throw new Error("science-capability-manager-invalid");
      if (value.manager === "specialist-library") return "/library/agents";
      if (value.manager === "specialist-build") return "/build";
      if (value.manager === "connector-library") return "/library/mcps?observe=1";
      if (value.manager !== "specialist-files") throw new Error("science-capability-manager-invalid");
      const agentId = identity(value.agentId);
      if (!registeredAgents().some(agent => agent.id === agentId)) throw new Error("science-capability-agent-not-registered");
      return `/library/agents?agentId=${encodeURIComponent(agentId)}&tab=files`;
    },
  };
}

/** GUI control plane. It supplies neither a model grant nor a running-author scope. */
export function registerScienceCapabilityCatalogIpc(ports: {
  handle(channel: string, handler: (event: IpcMainInvokeEvent, envelope: unknown) => Promise<unknown>): void;
  authorize(event: IpcMainInvokeEvent, envelope: unknown): void;
  catalog: ReturnType<typeof createScienceCapabilityCatalog>;
  navigate(route: string): void;
}) {
  function admit(event: IpcMainInvokeEvent, envelope: unknown): Row {
    ports.authorize(event, envelope);
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error("science-capability-view-required");
    const value = row(envelope); only(value, ["extensionId", "input"]);
    if (value.extensionId !== "agentlas-science") throw new Error("science-capability-view-required");
    return row(value.input);
  }
  ports.handle("science:researchCapabilities:catalog", async (event, envelope) => {
    const input = admit(event, envelope);
    const result = ports.catalog.catalog(input as unknown as ScienceCapabilityCatalogInput);
    // Yield once so a closed/navigated view cannot receive a stale release's result.
    await Promise.resolve(); admit(event, envelope);
    return result;
  });
  ports.handle("science:shell:openCapabilityManager", async (event, envelope) => {
    const input = admit(event, envelope);
    const route = ports.catalog.manager(input as unknown as ScienceCapabilityManagerInput);
    admit(event, envelope); ports.navigate(route);
    return { ok: true, route };
  });
}
