// The Build window's backend channels (Agentlas 2.0 Build backend). Renderer-only and not in the app-control catalog (the same standing as
// agents:root:* and recoverBuildTurn): a trusted Desktop renderer calls them; every answer is a result object with a machine code, never a
// thrown sentence. The phone does not read any of this (its Build methods are unchanged; see contracts/mobile-bridge-2.0.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import type { BuilderConversationOwner } from "./builder-conversation-store";
import {
  buildFileTree, clearBuildAvatar, folderIdentityKey, closeSession, escapesOfBuild, folderOfBuild, headRecordOf, listBuilds, listChanges, noteAgentCreated, openBuild, openDraft,
  openForAgent, purgeBuildsOfAgent, readBuildFileOf, removeBuild, setBuildAvatar, setBuildName, sweepBuilds, undoFile, type AgentPort, type WorkbenchEnv,
} from "./build-workbench";
import { createBuildFilesSignal, type BuildFilesSignal, type BuildFileSignalEvent } from "./build-files-signal";
import { previewClose, previewMessages, previewRestart, previewSend, type PreviewPorts, type PreviewRunRequest } from "./build-preview";
import { setBuildAgentCreatedListener } from "./build-workbench-hooks";

export const BUILD_WORKBENCH_CHANNELS = {
  list: "buildWorkbench:list", open: "buildWorkbench:open", openForAgent: "buildWorkbench:openForAgent", draft: "buildWorkbench:draft",
  remove: "buildWorkbench:remove", closeSession: "buildWorkbench:closeSession", setName: "buildWorkbench:setName", setAvatar: "buildWorkbench:setAvatar",
  clearAvatar: "buildWorkbench:clearAvatar", changes: "buildWorkbench:changes", undo: "buildWorkbench:undo", files: "buildWorkbench:files",
  readFile: "buildWorkbench:readFile", checkScope: "buildWorkbench:checkScope", previewSend: "buildWorkbench:previewSend",
  previewRestart: "buildWorkbench:previewRestart", previewClose: "buildWorkbench:previewClose", previewMessages: "buildWorkbench:previewMessages",
} as const;
/** Pushed to the window that started the Build turn, one per file state change: `buildWorkbench:files:<runId>`. */
export const buildFilesChannel = (runId: string): string => `buildWorkbench:files:${runId}`;

export interface BuildWorkbenchDeps {
  getDb: () => Database.Database;
  ownerBinding: () => BuilderConversationOwner;
  assertTrustedSender: (event: IpcMainInvokeEvent) => unknown;
  /** A Build turn of this (real) folder is running. */
  isRunning: (folder: string) => boolean;
  activeEvents: (folder: string) => ReadonlyArray<{ kind: string; stage?: string; text?: string }>;
  anyBuildActive: () => boolean;
}

const same = (a: string, b: string): boolean => { try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return a === b; } };

/** The real app: everything the store needs from agents, grants and the OS, loaded lazily (the store itself imports none of it). */
export async function realAgentPort(): Promise<AgentPort> {
  const registry = await import("../mcp/registry");
  const workspace = await import("../agents/workspace-service");
  const rootMove = await import("../agents/root-move");
  const home = await import("../agents/home");
  const avatar = await import("../one/avatar");
  const { isCallOnlyHubAgent } = await import("../../shared/call-only-agent");
  return {
    find(agentId) {
      const agent = registry.getAgentById(agentId);
      if (!agent) return null;
      let folder: string | null = null, writable = false;
      try { const r = workspace.agentWorkspaceRootFor(agentId); folder = r.root; writable = r.writable; } catch { folder = null; }
      return { id: agent.id, slug: agent.slug, folder, editable: writable && !isCallOnlyHubAgent(agent) };
    },
    blocker: (agentId, folder) => workspace.agentFolderMoveBlocker(agentId, folder),
    rootMoveBusy: () => rootMove.agentRootMoveBusy(),
    // The store's own error goes up (openForAgent words `update_busy` as agent_running and anything else as baseline_unavailable).
    headRevision(agentId) { return workspace.getAgentWorkspace(agentId).currentRevisionId; },
    revisionFiles: (agentId, revisionId) => workspace.readAgentWorkspaceRevisionFiles(agentId, revisionId),
    withLock: (agentId, action) => workspace.withAgentFolderMoveLocks([agentId], action),
    setName: (agentId, name) => { registry.setAgentLocalDisplayName(agentId, name); },
    setAvatar: (agentId, dataUrl) => { const r = avatar.setAgentAvatar(agentId, dataUrl); return { ok: r.ok }; },
    clearAvatar: (agentId) => { avatar.clearAgentAvatar(agentId); },
    agentsRootReason() { const status = home.agentHomeRootStatus(); return status.available ? null : (status.reason ?? null); },
    agentsRoot() {
      const status = home.agentHomeRootStatus();
      if (!status.available || !status.path) return null;
      try { fs.mkdirSync(status.path, { recursive: true }); } catch { return null; }
      return status.path;
    },
  };
}

let sweptOnce = false;
let registeredDeps: BuildWorkbenchDeps | null = null;

/**
 * Before a Build turn starts in a folder that belongs to an installed agent (an Edit): refuse, with a machine code, while that agent runs a turn
 * (its run lease), holds a file operation, or its agents root is being moved. null = free to go (and for every folder that is not an agent's).
 */
export async function buildTurnRefusal(folder: string): Promise<"agent_running" | "root_move_active" | null> {
  const deps = registeredDeps;
  if (!deps) return null;
  try {
    const { builderOwnerKey } = await import("./builder-conversation-store");
    const identity = folderIdentityKey(folder);
    if (!identity) return null;
    const prefix = `build-workbench-v1:${builderOwnerKey(deps.ownerBinding())}:`;
    const rows = deps.getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(prefix, prefix.slice(0, -1) + ";") as Array<{ value: string }>;
    for (const row of rows) {
      let meta: { agentId?: string | null; aliases?: string[]; buildKey?: string };
      try { meta = JSON.parse(row.value); } catch { continue; }
      if (!meta.agentId || !(meta.buildKey === identity || meta.aliases?.includes(identity))) continue;
      const agents = await port();
      if (agents.rootMoveBusy()) return "root_move_active";
      const agent = agents.find(meta.agentId);
      if (agent?.folder && agents.blocker(meta.agentId, agent.folder)) return "agent_running";
    }
  } catch { /* a guard that cannot read does not stop the owner's Build: the agent's own lease still protects a running turn */ }
  return null;
}
let cachedPort: Promise<AgentPort> | null = null;
// A load that failed is not kept (desktop 3, B-10): the next call loads again, so a one-time failure of a lazy import does not make every Build and phone read `owner_unavailable` until the app restarts.
const port = (): Promise<AgentPort> => (cachedPort ??= realAgentPort().catch((error) => { cachedPort = null; throw error; }));
const liveSignals = new Map<string, { signal: BuildFilesSignal; folder: string }>();

/**
 * Starts the file signal of one Build turn: events go to the window that started it, and the tree call reads which files are being written.
 * The returned handle's `poke` is for the turn's own tool/stage events; `stop` ends it (after the turn). One signal per folder at a time.
 */
export function startBuildFilesSignal(input: { runId: string; folder: string; window: Pick<BrowserWindow, "isDestroyed" | "webContents"> | null }): { poke(): void; stop(): void } {
  const channel = buildFilesChannel(input.runId);
  const emit = (event: BuildFileSignalEvent): void => {
    const win = input.window;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) { try { win.webContents.send(channel, event); } catch { /* window closed */ } }
  };
  const signal = createBuildFilesSignal({ folder: input.folder, emit });
  const previous = liveSignals.get(input.runId);
  previous?.signal.stop();
  liveSignals.set(input.runId, { signal, folder: input.folder });
  return {
    poke: () => signal.poke(),
    stop: () => { signal.stop(); if (liveSignals.get(input.runId)?.signal === signal) liveSignals.delete(input.runId); },
  };
}

function writingIn(folder: string): ReadonlySet<string> {
  for (const live of liveSignals.values()) if (same(live.folder, folder)) return live.signal.writing();
  return new Set();
}

/** True once Main has registered the Build window's backend (the background service has not): only then does the Desktop hold the running-Build state a phone read needs. */
export function buildWorkbenchAvailable(): boolean { return registeredDeps !== null; }

/**
 * The environment of a phone's read of saved Builds (build2.*): the same store, owner and running-Build state as the window, without the folder grant and the trash
 * (a read needs neither). null when this process did not register the window's backend (the background service): the phone is then answered with a machine code.
 */
export async function phoneBuildEnv(): Promise<WorkbenchEnv | null> {
  const deps = registeredDeps;
  if (!deps) return null;
  return { db: deps.getDb(), owner: deps.ownerBinding(), agents: await port(), isRunning: deps.isRunning, activeEvents: deps.activeEvents, anyBuildActive: deps.anyBuildActive };
}

/**
 * The file tree of one build with the live states (written / writing / pending): what the Build window's `files` channel answers and what the
 * phone's `build2.files` answers, the same function so the two never differ.
 */
export async function filesOfBuild(e: WorkbenchEnv, buildKey: unknown): Promise<ReturnType<typeof buildFileTree>> {
  const folder = folderOfBuild(e, buildKey);
  const record = headRecordOf(e, buildKey);
  let engineRoot: string | null = null;
  try { const { resolveBuilderPromptRoot } = await import("./builder"); const { hephaestusRoot } = await import("./root"); engineRoot = resolveBuilderPromptRoot(hephaestusRoot()); } catch { engineRoot = null; }
  return buildFileTree(e, buildKey, { expected: expectedArtifacts(record?.mode ?? null, engineRoot), writing: folder ? writingIn(folder) : new Set() });
}

function expectedArtifacts(mode: "single" | "team" | "package" | null | undefined, engineRoot: string | null): string[] {
  if (!engineRoot) return [];
  try {
    const contract = JSON.parse(fs.readFileSync(path.join(engineRoot, "package-contract.json"), "utf8")) as { kind?: string; artifacts?: Array<{ path?: string; modes?: string[]; required?: boolean }> };
    if (contract.kind !== "agentlas-package-contract" || !Array.isArray(contract.artifacts)) return [];
    const wanted = mode ?? "single";
    // Literal paths only: a pattern ("agents/*/agent.md") names no single file that could be "not yet".
    return contract.artifacts.filter((a) => typeof a.path === "string" && !/[*?{}\[\]]/.test(a.path) && a.required !== false && (a.modes ?? []).includes(wanted)).map((a) => a.path as string).slice(0, 200);
  } catch { return []; }
}

/** The window's full environment: the store, the owner and the running-Build state, plus the folder grant and the trash (what only Main can give). */
async function fullEnv(deps: BuildWorkbenchDeps): Promise<WorkbenchEnv> {
  const agents = await port();
  return {
    db: deps.getDb(), owner: deps.ownerBinding(), agents, isRunning: deps.isRunning, activeEvents: deps.activeEvents, anyBuildActive: deps.anyBuildActive,
    grant: (folder) => { const { grantPath } = require("../fs/access") as typeof import("../fs/access"); return grantPath(folder, { durable: false }); },
    trashFolder: async (folder) => { const { shell } = require("electron") as typeof import("electron"); await shell.trashItem(folder); return true; },
  };
}

/**
 * The environment a phone's Build TURN needs (a continuation opens the Build the way the window does: the folder grant is made here, in Main, and the resume pointer moves).
 * null when this process did not register the window's backend (the background service). Reads use `phoneBuildEnv` instead, which has no grant.
 */
export async function phoneBuildTurnEnv(): Promise<WorkbenchEnv | null> {
  const deps = registeredDeps;
  return deps ? fullEnv(deps) : null;
}

// Preview -------------------------------------------------------------------------------------------------------------------------
// `stored`: the runtime came from the build's own saved record, not from a choice the owner made in this call. A saved runtime that is not there any more is not a dead end:
// the owner's active runtime answers (desktop 3, B-14). An explicit choice the window sends is never swapped.
export const previewPorts = async (e: WorkbenchEnv, runtimeOverride: unknown, stored = false): Promise<PreviewPorts> => ({
  folderOf: (key) => folderOfBuild(e, key),
  composePrompt: (folder) => {
    const { readCanonicalPromptFromDirectory } = require("../agents/prompt-authority") as typeof import("../agents/prompt-authority");
    const { agentSkillCatalogLine } = require("../agents/files") as typeof import("../agents/files");
    const prompt = readCanonicalPromptFromDirectory(folder);
    if (!prompt?.content.trim()) return null;
    const skills = agentSkillCatalogLine(folder);
    return skills ? `${prompt.content}\n\n${skills}` : prompt.content;
  },
  run: async (request: PreviewRunRequest) => {
    const { detectRuntimes } = await import("../runtime/detect");
    const { pickRunner } = await import("../runtime/selection");
    const { selectBuildRuntimeStatus } = await import("./builder");
    const { runObservedRunnerAs } = await import("../runtime/observed-runner");
    const { buildIsolatedBuildRunnerEnv } = await import("../runtime/build-env");
    const { currentUiLocale } = await import("../ui-locale");
    const runtimes = await detectRuntimes();
    const selection = (runtimeOverride && typeof runtimeOverride === "object" ? runtimeOverride : undefined) as Parameters<typeof selectBuildRuntimeStatus>[1];
    let active = selectBuildRuntimeStatus(runtimes, selection);
    let picked = active ? pickRunner(active) : null;
    if ((!active || !picked) && stored && selection) {
      active = selectBuildRuntimeStatus(runtimes, undefined);
      picked = active ? pickRunner(active) : null;
    }
    if (!active || !picked) return { text: "", failure: "runtime_unavailable" };
    // A CLI runtime's own hooks write through this memory root: it is empty, owned by this turn, and removed after it.
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-preview-"));
    try {
      const now = new Date().toISOString();
      const result = await runObservedRunnerAs("build", "build-workbench-preview", picked.runner, {
        systemPrompt: request.systemPrompt,
        history: request.history.map((m, i) => ({ id: `preview-h${i}`, role: m.role, text: m.text, createdAt: now })),
        userPrompt: request.userPrompt,
        backendLabel: picked.label,
        model: active.model ?? undefined,
        permission: request.permission,
        cwd: request.cwd,
        agentId: request.actor,
        env: { ...buildIsolatedBuildRunnerEnv(active.kind, {}), AGENTLAS_MEMORY_ROOT: memoryRoot },
        signal: request.signal,
        locale: currentUiLocale(),
      } as Parameters<typeof runObservedRunnerAs>[3], { onPartial: request.onPartial, onStatus: () => undefined } as Parameters<typeof runObservedRunnerAs>[4], active.kind);
      return { text: result.text, failure: result.failure ? (result.failure.providerCode ?? result.failure.kind ?? "failed") : null };
    } finally {
      try { fs.rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* a temp folder of ours; the OS clears it */ }
    }
  },
});

export function registerBuildWorkbenchIpc(ipcMain: Pick<IpcMain, "handle">, deps: BuildWorkbenchDeps): void {
  registeredDeps = deps;
  const env = (): Promise<WorkbenchEnv> => fullEnv(deps);
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, input: unknown, e: WorkbenchEnv) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, input: unknown) => {
      deps.assertTrustedSender(event);
      try {
        const e = await env();
        return await fn(event, input, e);
      } catch (error) {
        // A store failure is a code too (the window words it); the cause stays in the log.
        console.warn(`[build-workbench] ${channel} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, code: "owner_unavailable" };
      }
    });
  };
  const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

  setBuildAgentCreatedListener((created) => {
    void env().then((e) => noteAgentCreated(e, created)).catch((error) => console.warn(`[build-workbench] link not recorded: ${error instanceof Error ? error.message : String(error)}`));
  });

  handle(BUILD_WORKBENCH_CHANNELS.list, (_ev, input, e) => {
    if (!sweptOnce) { sweptOnce = true; try { sweepBuilds(e); } catch (error) { console.warn(`[build-workbench] sweep failed: ${error instanceof Error ? error.message : String(error)}`); } }
    return { ok: true, ...listBuilds(e, obj(input)) };
  });
  handle(BUILD_WORKBENCH_CHANNELS.open, (_ev, input, e) => openBuild(e, input));
  handle(BUILD_WORKBENCH_CHANNELS.openForAgent, (_ev, input, e) => openForAgent(e, input));
  handle(BUILD_WORKBENCH_CHANNELS.draft, (_ev, input, e) => openDraft(e, obj(input)));
  handle(BUILD_WORKBENCH_CHANNELS.remove, async (_ev, input, e) => {
    previewClose(String(input));
    const result = await removeBuild(e, input);
    if (result.ok) { try { sweepBuilds(e); } catch { /* the next start sweeps */ } }
    return result;
  });
  handle(BUILD_WORKBENCH_CHANNELS.closeSession, (_ev, input, e) => { previewClose(String(input)); return closeSession(e, input); });
  handle(BUILD_WORKBENCH_CHANNELS.setName, (_ev, input, e) => setBuildName(e, obj(input).buildKey, obj(input).name));
  handle(BUILD_WORKBENCH_CHANNELS.setAvatar, (_ev, input, e) => setBuildAvatar(e, obj(input).buildKey, obj(input).dataUrl));
  handle(BUILD_WORKBENCH_CHANNELS.clearAvatar, (_ev, input, e) => clearBuildAvatar(e, input));
  handle(BUILD_WORKBENCH_CHANNELS.changes, (_ev, input, e) => listChanges(e, input));
  handle(BUILD_WORKBENCH_CHANNELS.undo, (_ev, input, e) => undoFile(e, obj(input).buildKey, obj(input).path));
  handle(BUILD_WORKBENCH_CHANNELS.files, (_ev, input, e) => filesOfBuild(e, input));
  handle(BUILD_WORKBENCH_CHANNELS.readFile, (_ev, input, e) => readBuildFileOf(e, obj(input).buildKey, obj(input).path, obj(input).sinceLine));
  handle(BUILD_WORKBENCH_CHANNELS.checkScope, (_ev, input, e) => ({ ok: true, escapes: escapesOfBuild(e, input) }));

  handle(BUILD_WORKBENCH_CHANNELS.previewSend, async (_ev, input, e) => {
    const value = obj(input);
    const record = headRecordOf(e, value.buildKey);
    const ports = await previewPorts(e, value.runtime ?? record?.runtime ?? undefined, value.runtime === undefined);
    return previewSend(ports, String(value.buildKey ?? ""), value.text);
  });
  handle(BUILD_WORKBENCH_CHANNELS.previewRestart, (_ev, input) => { previewRestart(String(input)); return { ok: true }; });
  handle(BUILD_WORKBENCH_CHANNELS.previewClose, (_ev, input) => { previewClose(String(input)); return { ok: true }; });
  handle(BUILD_WORKBENCH_CHANNELS.previewMessages, (_ev, input) => ({ ok: true, messages: previewMessages(String(input)) }));
}

export { purgeBuildsOfAgent };
