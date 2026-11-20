/*
 * What THIS computer can do for a service right now, measured (`desktops[].paths`).
 *
 * "Ready" is never declared: a road is reported only after something measured it. The measurements come in through ports so a gate can drive them with fakes and this file imports no Electron
 * (the background service loads it):
 *   local-mcp   the installed program of that service is enabled and its connection test passed (mcp-tools/client.ts testServerConnection / statusAllServers: `connected`)
 *   local-file  the sync folder exists on this machine (Drive for desktop's mount)
 *   local-app   the app's scripting already worked here and the OS has not refused it since (macOS Automation is a permission the OS asks the person for; this file never triggers that question:
 *               `noteDesktopRoadResult` is fed by a real call, so a road whose permission was never granted is simply not reported)
 *   browser     the Agentlas browser holds a signed-in session for the service's host (browser/native-session-status.ts)
 *   screen      no road (an app driven by screen has no service identity; design 4.3)
 * The set is reported to the server when it CHANGES (never a timer; places-link.ts digest) and re-measured at the start of a turn (the caller), so a permission change or a removed program is seen at the next turn.
 * Only ids of roads the card set knows are reported (a card set that does not have the id drops it on the server too).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectorCard, ConnectorPath } from "../../shared/connector-route";
import DESKTOP_FILE from "../../shared/desktop-connector-cards.json";

export type DesktopOs = "macos" | "windows" | "linux";
export const desktopOsOf = (platform: NodeJS.Platform = process.platform): DesktopOs | null => (platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : null);

interface DeclaredFile { identity?: Record<string, { hosts?: string[] }>; paths?: Array<{ card: string; path: ConnectorPath }> }
const DECLARED = DESKTOP_FILE as unknown as DeclaredFile;

/**
 * The cards of this computer's turn: the server's cards (when its list answer carried them) plus this computer's own declared roads, and the hosts the desktop file knows for a card that lists none.
 * A card the server does not have is made here (minimal: id, hosts, the roads). `desktopIds` joins a server card to the id the computer's own catalog uses for the same service (the server list's `desktopId`).
 */
export function mergeDesktopCards(server: Record<string, ConnectorCard> | null | undefined, desktopIds: Readonly<Record<string, string>> = {}, catalog: ReadonlyArray<CatalogRow> = []): Record<string, ConnectorCard> {
  const out: Record<string, ConnectorCard> = {};
  for (const [id, card] of Object.entries(server ?? {})) out[id] = { ...card, paths: [...card.paths], ...(desktopIds[id] ? { desktopId: desktopIds[id] } : {}) };
  // A program of this computer's own catalog that the server's cards do not know (an older server, or a service only the computer lists): its road is built here from the card facts of the row.
  const known = new Set(Object.values(out).flatMap((card) => [card.id, ...(card.desktopId ? [card.desktopId] : [])]));
  for (const row of catalog) {
    const road = catalogRoad(row);
    if (!road || known.has(row.id)) continue;
    out[row.id] = { schema: "agentlas.connector-card.v1", id: row.id, rev: "desktop", names: { en: row.nameEn || row.id }, identity: { hosts: [] }, paths: [road] };
  }
  const need = (id: string): ConnectorCard => (out[id] ??= { schema: "agentlas.connector-card.v1", id, rev: "desktop", names: { en: id }, identity: { hosts: [] }, ...(desktopIds[id] ? { desktopId: desktopIds[id] } : {}), paths: [] });
  for (const [id, who] of Object.entries(DECLARED.identity ?? {})) {
    const card = need(id);
    if (card.identity.hosts.length === 0 && Array.isArray(who.hosts)) card.identity = { hosts: [...who.hosts] };
  }
  for (const item of DECLARED.paths ?? []) {
    const card = need(item.card);
    if (!card.paths.some((p) => p.id === item.path.id)) card.paths.push(item.path);
  }
  return out;
}

/** The slice of a row of the computer's own tool catalog (electron/mcp-tools/catalog.ts; shared/types.ts McpToolCatalogEntry) the card reads. */
export interface CatalogRow { id: string; nameEn?: string; transport: string; auth?: string; needs?: readonly string[]; envRequirements?: ReadonlyArray<{ required?: boolean }> }

/**
 * The road a catalog row is on this computer: only a program this computer launches (stdio) is a desktop road (a hosted MCP is the server's road). A row that did not declare `auth` and `needs` makes no card
 * (a fact that is not declared is not guessed). `needs: key` when the program wants a saved key.
 */
export function catalogRoad(row: CatalogRow): ConnectorPath | null {
  if (row.transport !== "stdio" || row.auth === undefined || row.needs === undefined) return null;
  const keyed = row.auth === "api_key" || row.auth === "token";
  return {
    id: `${row.id}/local`, how: "local-mcp", runsOn: "desktop", needs: ["computer", ...(keyed ? ["key"] : [])], effects: ["read", "write", "send", "delete"],
    review: "none", completes: "host", verify: "none",
    source: `agentlas_desktop/electron/mcp-tools/catalog.ts row ${row.id} (auth ${row.auth}, needs ${row.needs.join("+") || "-"})`,
  };
}

export interface DesktopPathProbes {
  platform: NodeJS.Platform;
  /** Installed programs of this computer: the catalog id each came from (null for a custom one) and whether its last connection test passed. */
  mcp(): Promise<ReadonlyArray<{ catalogId: string | null; connected: boolean }>> | ReadonlyArray<{ catalogId: string | null; connected: boolean }>;
  /** Folders that exist as Drive for desktop's mount on this machine (absolute paths); [] when none. */
  driveFolders(): readonly string[];
  /** The Agentlas browser holds a signed-in session for this host. */
  browserSession(host: string): boolean | Promise<boolean>;
}

/** The sync folder of Drive for desktop: the CloudStorage mount of macOS (`GoogleDrive-<account>`) and the `Google Drive` folder of the person's home on Windows. Linux has no client (no road, honestly). */
export function driveFoldersOf(platform: NodeJS.Platform = process.platform, home: string = os.homedir(), exists: (p: string) => boolean = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }, list: (p: string) => string[] = (p) => { try { return fs.readdirSync(p); } catch { return []; } }): string[] {
  if (platform === "darwin") return list(path.join(home, "Library", "CloudStorage")).filter((n) => n.startsWith("GoogleDrive-")).map((n) => path.join(home, "Library", "CloudStorage", n)).filter(exists);
  if (platform === "win32") return [path.join(home, "Google Drive")].filter(exists);
  return [];
}

const scriptingResults = new Map<string, boolean>();
/** A real call over a local-app road succeeded (true) or the OS refused it (false): the measurement of a permission this file never asks for. In memory only; a restart measures again with the next call. */
export function noteDesktopRoadResult(pathId: string, ok: boolean): void { scriptingResults.set(pathId, ok); while (scriptingResults.size > 64) scriptingResults.delete(scriptingResults.keys().next().value as string); }
export function __resetDesktopRoadResultsForTest(): void { scriptingResults.clear(); }

/** The ids of the roads of `cards` that this computer has measured as ready, sorted (the same set reports the same bytes). */
export async function measureDesktopPaths(cards: Record<string, ConnectorCard>, probes: DesktopPathProbes): Promise<string[]> {
  const mine = desktopOsOf(probes.platform);
  if (!mine) return [];
  let mcp: ReadonlyArray<{ catalogId: string | null; connected: boolean }> = [];
  try { mcp = await probes.mcp(); } catch { mcp = []; }
  let drive: readonly string[] = [];
  try { drive = probes.driveFolders(); } catch { drive = []; }
  const ready: string[] = [];
  for (const card of Object.values(cards)) {
    for (const p of card.paths) {
      if (p.runsOn !== "desktop" || (p.os && !p.os.includes(mine))) continue;
      let ok = false;
      try {
        if (p.how === "local-mcp") ok = mcp.some((m) => m.connected && m.catalogId !== null && (m.catalogId === card.id || m.catalogId === card.desktopId));
        else if (p.how === "local-file") ok = drive.length > 0;
        else if (p.how === "local-app") ok = scriptingResults.get(p.id) === true;
        else if (p.how === "browser") ok = (await Promise.all(card.identity.hosts.map((h) => probes.browserSession(h)))).some(Boolean);
      } catch { ok = false; }
      if (ok) ready.push(p.id);
    }
  }
  return ready.sort();
}

let browserSessionProbe: ((host: string) => boolean | Promise<boolean>) | null = null;
/**
 * Main hands in how it reads "the Agentlas browser holds a signed-in session for this host" (the receipts of imported logins live in the window host, work-live-view.ts, not in a module this file may
 * import from the background service). Until it does, a browser road is not reported (it is not measured).
 */
export function setBrowserSessionProbe(probe: ((host: string) => boolean | Promise<boolean>) | null): void { browserSessionProbe = probe; }

/** The default ports in Desktop Main and the background service: every import is lazy and guarded, so a missing piece measures as "not ready" instead of throwing. */
export function defaultDesktopPathProbes(): DesktopPathProbes {
  return {
    platform: process.platform,
    async mcp() {
      const { listInstalledServers } = await import("../mcp-tools/registry");
      const client = await import("../mcp-tools/client");
      const installed = listInstalledServers().filter((s) => s.enabled);
      const status = await client.statusAllServers();
      return installed.map((s) => ({ catalogId: s.catalogId ?? null, connected: status.some((st) => st.id === s.id && st.connected) }));
    },
    driveFolders: () => driveFoldersOf(),
    browserSession: (host) => (browserSessionProbe ? browserSessionProbe(host) : false),
  };
}
