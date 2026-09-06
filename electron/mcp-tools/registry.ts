// 외부 MCP 서버 레지스트리 — SQLite 영구화. 전역 공유(모든 에이전트·팀이 함께 사용).
// 값(시크릿)은 keychain의 글로벌 env vault에만; 여기엔 어떤 env 키를 쓰는지만 저장.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getCatalogEntry } from "./catalog";
import {
  OPENCRAB_CATALOG_ID,
  OPENCRAB_CREDENTIAL_PATTERN,
  OPENCRAB_MCP_URL_KEY,
  OPENCRAB_MCP_URL_SENTINEL,
  isOpenCrabCredentialUrl,
} from "../opencrab/constants";
import type { InstalledMcpServer, McpTransport } from "../../shared/types";

interface ServerRow {
  id: string;
  catalog_id: string | null;
  name: string;
  name_en: string;
  transport: McpTransport;
  command: string | null;
  args_json: string;
  url: string | null;
  env_keys_json: string;
  enabled: number;
  installed_at: string;
}

function toServer(row: ServerRow): InstalledMcpServer {
  const args = safeJsonArray(row.args_json);
  const envKeys = safeJsonArray(row.env_keys_json);
  return {
    id: row.id,
    catalogId: row.catalog_id,
    name: row.name,
    nameEn: row.name_en || row.name,
    transport: row.transport,
    command: row.command,
    args: args.values,
    url: row.url,
    envKeys: envKeys.values,
    configurationValid: args.valid && envKeys.valid,
    enabled: row.enabled === 1,
    installedAt: row.installed_at,
  };
}

function safeJsonArray(json: string): { values: string[]; valid: boolean } {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.every((item) => typeof item === "string")
      ? { values: v, valid: true }
      : { values: [], valid: false };
  } catch {
    return { values: [], valid: false };
  }
}

export function listInstalledServers(): InstalledMcpServer[] {
  const rows = getDb()
    .prepare("SELECT * FROM mcp_servers ORDER BY installed_at DESC")
    .all() as ServerRow[];
  return rows.map(toServer);
}

export function getServer(id: string): InstalledMcpServer | null {
  const row = getDb().prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
    | ServerRow
    | undefined;
  return row ? toServer(row) : null;
}

/** 카탈로그 항목으로 설치. 같은 카탈로그 id가 이미 있으면 그걸 반환(중복 방지). */
export function installFromCatalog(catalogId: string): InstalledMcpServer {
  const entry = getCatalogEntry(catalogId);
  if (!entry) throw new Error(`Unknown MCP catalog id: ${catalogId}`);

  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM mcp_servers WHERE catalog_id = ?")
    .get(catalogId) as ServerRow | undefined;
  if (existing) return toServer(existing);

  const id = randomUUID();
  const now = new Date().toISOString();
  const envKeys = entry.envRequirements.map((r) => r.key);
  db.prepare(
    `INSERT INTO mcp_servers
       (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    entry.id,
    entry.name,
    entry.nameEn,
    entry.transport,
    entry.command ?? null,
    JSON.stringify(entry.args ?? []),
    entry.url ?? null,
    JSON.stringify(envKeys),
    now,
  );
  return getServer(id)!;
}

/**
 * Reconcile an already installed catalog row with the trusted catalog bundled
 * in this Desktop build. The stable global id, enabled choice, install time,
 * and any agent references stay intact. Used for built-ins whose audited launch
 * payload changes across Desktop updates.
 */
export function refreshInstalledCatalogServer(catalogId: string): InstalledMcpServer | null {
  const entry = getCatalogEntry(catalogId);
  if (!entry) throw new Error(`Unknown MCP catalog id: ${catalogId}`);
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM mcp_servers WHERE catalog_id = ?")
    .get(catalogId) as ServerRow | undefined;
  if (!existing) return null;
  const command = entry.command ?? null;
  const argsJson = JSON.stringify(entry.args ?? []);
  const url = entry.url ?? null;
  const envKeysJson = JSON.stringify(entry.envRequirements.map((requirement) => requirement.key));
  if (
    existing.name === entry.name &&
    existing.name_en === entry.nameEn &&
    existing.transport === entry.transport &&
    existing.command === command &&
    existing.args_json === argsJson &&
    existing.url === url &&
    existing.env_keys_json === envKeysJson
  ) return toServer(existing);
  db.prepare(
    `UPDATE mcp_servers
     SET name = ?, name_en = ?, transport = ?, command = ?, args_json = ?, url = ?, env_keys_json = ?
     WHERE id = ?`,
  ).run(
    entry.name,
    entry.nameEn,
    entry.transport,
    command,
    argsJson,
    url,
    envKeysJson,
    existing.id,
  );
  return getServer(existing.id);
}

export function installCustomServer(def: {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
}): InstalledMcpServer {
  const name = def.name.trim();
  if (!name) throw new Error("MCP server name required");
  if (def.transport === "stdio" && !def.command?.trim()) {
    throw new Error("stdio MCP server requires a command");
  }
  if ((def.transport === "sse" || def.transport === "http") && !def.url?.trim()) {
    throw new Error("sse/http MCP server requires a URL");
  }
  if ((def.transport === "sse" || def.transport === "http") && isOpenCrabCredentialUrl(def.url ?? "")) {
    // OpenCrab credentials are embedded in the path. The generic custom-server
    // path persists URLs to SQLite and runtime config, so it must fail before
    // any write and direct the user to the vault-backed catalog path.
    throw new Error(`Use the ${OPENCRAB_CATALOG_ID} catalog connection for private OpenCrab MCP URLs.`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mcp_servers
         (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      name,
      name,
      def.transport,
      def.command?.trim() ?? null,
      JSON.stringify(def.args ?? []),
      def.url?.trim() ?? null,
      JSON.stringify(def.envKeys ?? []),
      now,
    );
  return getServer(id)!;
}

/**
 * Older builds allowed path-credential OpenCrab URLs through the generic custom
 * MCP form. Fail closed on startup: overwrite those SQLite cells with the safe
 * vault sentinel and disable the row until the user reconnects via Keychain.
 */
export function scrubLegacyOpenCrabCredentialUrls(): { scrubbed: number } {
  const db = getDb();
  // ★ Never fs.open() the live store or its -wal/-shm here (2026-09-05).
  // Until this date the function byte-scanned those files in-process for
  // residual credential bytes. On POSIX, closing *any* descriptor a process
  // holds on a file releases every fcntl lock that process has on it — including
  // SQLite's shared "dead-man switch" lock on -shm. The next peer connection
  // (agentlasd, a headless wake, the terminal follower, a QA instance) then
  // believed it was alone, truncated/unlinked the wal-index this process still
  // had mapped, and the next wal-index access died with
  // EXC_BAD_ACCESS/SIGBUS "FS pagein error" (crash reports 2026-08-28 ×4,
  // 08-29, 08-30, 09-01, 09-04: walIndexAppend/walFindFrame). Reproduced with
  // a scratch WAL store: in-process open/close of -shm → peer close → -shm gone;
  // without the foreign open/close the sidecar stays. The residual-byte branch
  // it fed only toggled secure_delete + a PASSIVE checkpoint, which cannot
  // rewrite freelist pages of a live multi-process database anyway; inactive
  // recovery copies keep their own exclusive scrub path (updater/continuity).
  const rows = db
    .prepare("SELECT id, catalog_id, url, enabled, installed_at FROM mcp_servers WHERE url IS NOT NULL ORDER BY installed_at DESC")
    .all() as Array<{ id: string; catalog_id: string | null; url: string; enabled: number; installed_at: string }>;
  const legacy = rows.filter((row) => row.url !== OPENCRAB_MCP_URL_SENTINEL && isOpenCrabCredentialUrl(row.url));
  if (legacy.length === 0) return { scrubbed: 0 };

  // This is a live, multi-process database: Desktop, agentlasd, and a headless
  // wake can all hold WAL read marks. Never VACUUM, truncate a checkpoint, or
  // overwrite/remove -wal/-shm here. Resizing a mapped WAL index underneath a
  // peer caused native walIndexAppend/page-in SIGBUS crashes. The row mutation
  // remains atomic and secure_delete covers the main database cell; inactive
  // recovery databases have their own exclusive scrub path.
  db.pragma("secure_delete = ON");
  if (legacy.length > 0) {
    const safeCatalogRows = rows.filter(
      (row) => row.catalog_id === OPENCRAB_CATALOG_ID && row.url === OPENCRAB_MCP_URL_SENTINEL,
    );
    const canonical = safeCatalogRows.find((row) => row.enabled === 1) ?? safeCatalogRows[0] ?? legacy[0];
    const openCrabRows = [...safeCatalogRows, ...legacy].filter(
      (row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index,
    );
    db.transaction(() => {
      db.prepare(
        `UPDATE mcp_servers
         SET catalog_id = ?, name = ?, name_en = ?, transport = 'http', command = NULL,
             args_json = '[]', url = ?, env_keys_json = ?
         WHERE id = ?`,
      ).run(
        OPENCRAB_CATALOG_ID,
        "OpenCrab 온톨로지",
        "OpenCrab Ontology",
        OPENCRAB_MCP_URL_SENTINEL,
        JSON.stringify([OPENCRAB_MCP_URL_KEY]),
        canonical.id,
      );
      if (!safeCatalogRows.some((row) => row.id === canonical.id)) {
        db.prepare("UPDATE mcp_servers SET enabled = 0 WHERE id = ?").run(canonical.id);
      }

      for (const row of openCrabRows) {
        if (row.id === canonical.id) continue;
        db.prepare(
          `INSERT OR IGNORE INTO agent_mcp_servers (agent_id, server_id)
           SELECT agent_id, ? FROM agent_mcp_servers WHERE server_id = ?`,
        ).run(canonical.id, row.id);
        db.prepare("UPDATE agent_tools SET installed_server_id = ? WHERE installed_server_id = ?")
          .run(canonical.id, row.id);
        db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(row.id);
      }
    }).immediate();
  }
  // PASSIVE copies what it safely can and never waits for, truncates, or
  // invalidates another process's mapped WAL/SHM pages.
  try { db.pragma("wal_checkpoint(PASSIVE)"); } catch { /* next normal checkpoint retries */ }
  return { scrubbed: legacy.length };
}

export function removeServer(id: string): void {
  getDb().prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  // agent_mcp_servers는 FK ON DELETE CASCADE로 자동 정리됨
}

export function setServerEnabled(id: string, enabled: boolean): InstalledMcpServer {
  getDb().prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  const server = getServer(id);
  if (!server) throw new Error(`MCP server not found: ${id}`);
  return server;
}
