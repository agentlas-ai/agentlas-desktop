"use client";

import { useEffect, useSyncExternalStore } from "react";
import { ipc } from "./ipc";
import { applyFinanceOperations, createFinanceWorkspace, validateFinanceWorkspace, type FinanceOperation, type FinanceWorkspace } from "@shared/finance";

const STORAGE_KEY = "agentlas.finance.workspace.v1";
const MAX_HISTORY = 30;
export interface FinancePersistence {
  kind: "host" | "browser_local" | "memory";
  load(): Promise<FinanceWorkspace>;
  save(input: { workspace: FinanceWorkspace; expectedRevision: number }): Promise<FinanceWorkspace>;
}
export interface FinanceStoreSnapshot {
  workspace: FinanceWorkspace;
  loading: boolean;
  saving: boolean;
  error: string | null;
  persistence: FinancePersistence["kind"];
  savedAt: string | null;
  canUndo: boolean;
  canRedo: boolean;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "finance_storage_failed"; }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
  }
  return value;
}
function defaultPersistence(): FinancePersistence {
  const host = ipc();
  const bridge = host?.finance;
  if (bridge?.load && bridge?.save) return { kind: "host", load: () => bridge.load(), save: input => bridge.save(input) };
  if (host) return { kind: "host", load: async () => { throw new Error("finance_bridge_unavailable"); }, save: async () => { throw new Error("finance_bridge_unavailable"); } };
  if (typeof window !== "undefined") {
    return {
      kind: "browser_local",
      async load() {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        return saved ? validateFinanceWorkspace(JSON.parse(saved)) : createFinanceWorkspace();
      },
      async save({ workspace, expectedRevision }) {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const current = raw ? validateFinanceWorkspace(JSON.parse(raw)) : createFinanceWorkspace();
        if (current.revision !== expectedRevision) throw new Error("finance_revision_conflict");
        const validated = validateFinanceWorkspace(workspace);
        if (validated.revision !== expectedRevision + 1) throw new Error("finance_invalid_revision");
        const encoded = JSON.stringify(validated);
        window.localStorage.setItem(STORAGE_KEY, encoded);
        if (window.localStorage.getItem(STORAGE_KEY) !== encoded) throw new Error("finance_local_save_unconfirmed");
        return validated;
      },
    };
  }
  return { kind: "memory", load: async () => createFinanceWorkspace(), save: async () => { throw new Error("finance_persistence_unavailable"); } };
}

/** Serial mutations, atomic batches, host CAS, and explicit browser-local persistence. */
export function createFinanceStore(providedPersistence?: FinancePersistence) {
  let adapter: FinancePersistence | null = providedPersistence ?? null;
  let state: FinanceStoreSnapshot = freeze({ workspace: createFinanceWorkspace(), loading: true, saving: false, error: null, persistence: providedPersistence?.kind ?? "memory", savedAt: null, canUndo: false, canRedo: false });
  const listeners = new Set<() => void>();
  let undoStack: FinanceWorkspace[] = []; let redoStack: FinanceWorkspace[] = [];
  let initialized = false; let loadPromise: Promise<void> | null = null;
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  function publish(patch: Partial<FinanceStoreSnapshot>) {
    state = freeze({ ...state, ...patch, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
    listeners.forEach(listener => listener());
  }
  function persistence() { if (!adapter) adapter = defaultPersistence(); return adapter; }
  async function load(force = false): Promise<void> {
    if (loadPromise) return loadPromise;
    if (initialized && !force) return;
    const epoch = generation;
    publish({ loading: !initialized, error: null });
    loadPromise = (async () => {
      try {
        const storage = persistence(); const workspace = validateFinanceWorkspace(await storage.load());
        if (epoch !== generation) throw new Error("finance_scope_changed");
        undoStack = []; redoStack = []; initialized = true;
        publish({ workspace, loading: false, persistence: storage.kind, error: null });
      } catch (error) { if (epoch === generation) publish({ loading: false, error: errorMessage(error) }); throw error; }
      finally { if (epoch === generation) loadPromise = null; }
    })();
    return loadPromise;
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const epoch = generation;
    const guarded = () => { if (epoch !== generation) throw new Error("finance_scope_changed"); return work(); };
    const result = tail.then(guarded, guarded); tail = result.catch(() => undefined); return result;
  }
  async function commit(next: FinanceWorkspace): Promise<FinanceWorkspace> {
    const current = state.workspace;
    const epoch = generation;
    publish({ saving: true, error: null });
    try {
      const storage = persistence();
      const saved = validateFinanceWorkspace(await storage.save({ workspace: next, expectedRevision: current.revision }));
      if (epoch !== generation) throw new Error("finance_scope_changed");
      if (saved.revision !== next.revision || JSON.stringify(saved) !== JSON.stringify(next)) throw new Error("finance_save_receipt_mismatch");
      publish({ workspace: saved, saving: false, persistence: storage.kind, savedAt: new Date().toISOString(), error: null });
      return saved;
    } catch (error) { if (epoch === generation) publish({ saving: false, error: errorMessage(error) }); throw error; }
  }
  function dispatch(operation: FinanceOperation | readonly FinanceOperation[], expectedRevision?: number): Promise<FinanceWorkspace> {
    const epoch = generation;
    return enqueue(async () => {
      await load();
      if (epoch !== generation) throw new Error("finance_scope_changed");
      if (expectedRevision !== undefined && expectedRevision !== state.workspace.revision) {
        publish({ error: "finance_revision_conflict" }); throw new Error("finance_revision_conflict");
      }
      const before = state.workspace;
      let next: FinanceWorkspace;
      try { next = applyFinanceOperations(before, Array.isArray(operation) ? operation : [operation as FinanceOperation]); }
      catch (error) { publish({ error: errorMessage(error) }); throw error; }
      const saved = await commit(next);
      if (epoch !== generation) throw new Error("finance_scope_changed");
      undoStack = [...undoStack.slice(-(MAX_HISTORY - 1)), before]; redoStack = []; publish({}); return saved;
    });
  }
  function undo(): Promise<FinanceWorkspace> {
    const epoch = generation;
    return enqueue(async () => {
      await load(); const previous = undoStack[undoStack.length - 1];
      if (epoch !== generation) throw new Error("finance_scope_changed");
      if (!previous) return state.workspace;
      const before = state.workspace; const restored = validateFinanceWorkspace({ ...previous, revision: before.revision + 1 });
      const saved = await commit(restored);
      if (epoch !== generation) throw new Error("finance_scope_changed");
      undoStack = undoStack.slice(0, -1); redoStack = [...redoStack.slice(-(MAX_HISTORY - 1)), before]; publish({}); return saved;
    });
  }
  function redo(): Promise<FinanceWorkspace> {
    const epoch = generation;
    return enqueue(async () => {
      await load(); const subsequent = redoStack[redoStack.length - 1];
      if (epoch !== generation) throw new Error("finance_scope_changed");
      if (!subsequent) return state.workspace;
      const before = state.workspace; const restored = validateFinanceWorkspace({ ...subsequent, revision: before.revision + 1 });
      const saved = await commit(restored);
      if (epoch !== generation) throw new Error("finance_scope_changed");
      redoStack = redoStack.slice(0, -1); undoStack = [...undoStack.slice(-(MAX_HISTORY - 1)), before]; publish({}); return saved;
    });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load, reload: () => enqueue(() => load(true)),
    reloadIfNewer: (ownerScope: string, revision: number) => enqueue(async () => {
      // Own save events can arrive before the save receipt; recheck inside the queue.
      if (ownerScope !== state.workspace.ownerScope || revision <= state.workspace.revision) return;
      await load(true);
    }), dispatch, undo, redo,
    refreshHostState: () => enqueue(async () => {
      const epoch = generation;
      await load();
      if (epoch !== generation) throw new Error("finance_scope_changed");
      const before = state.workspace;
      const host = validateFinanceWorkspace(await persistence().load());
      if (epoch !== generation) throw new Error("finance_scope_changed");
      // Scheduler metadata can advance without changing the saved document revision.
      // Ignore stale/foreign reads and never replace local document content at the same revision.
      if (host.ownerScope !== before.ownerScope || host.revision < before.revision) return state.workspace;
      if (host.revision > before.revision) {
        undoStack = []; redoStack = [];
        publish({ workspace: host, loading: false, error: null });
        return state.workspace;
      }
      const metadata = (monitor: FinanceWorkspace["monitors"][number]) => {
        const { status, lastCheckedAt, nextCheckAt, note, automationId, executionAvailability, scheduleHuman } = monitor;
        return { status, lastCheckedAt, nextCheckAt, note, automationId, executionAvailability, scheduleHuman };
      };
      const byId = new Map(host.monitors.map(monitor => [monitor.id, monitor]));
      const mergeMetadata = (workspace: FinanceWorkspace): FinanceWorkspace => validateFinanceWorkspace({
        ...workspace,
        monitors: workspace.monitors.map(monitor => {
          const fresh = byId.get(monitor.id);
          return fresh ? { ...monitor, ...metadata(fresh) } : monitor;
        }),
      });
      const next = mergeMetadata(before);
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        // Undo restores authored content, never obsolete host execution metadata.
        undoStack = undoStack.map(mergeMetadata); redoStack = redoStack.map(mergeMetadata);
        publish({ workspace: next });
      }
      return state.workspace;
    }),
    flush: () => enqueue(async () => {
      await load();
      if (state.error) throw new Error(state.error);
      return state.workspace;
    }),
    reset() {
      generation++; adapter = providedPersistence ?? null; initialized = false; loadPromise = null;
      undoStack = []; redoStack = []; tail = Promise.resolve();
      publish({ workspace: createFinanceWorkspace(), loading: true, saving: false, error: null, savedAt: null, persistence: providedPersistence?.kind ?? "memory" });
    },
    clearError() { publish({ error: null }); },
  };
}
export const financeStore = createFinanceStore();
export function useFinanceStore() {
  const state = useSyncExternalStore(financeStore.subscribe, financeStore.getSnapshot, financeStore.getSnapshot);
  useEffect(() => { void financeStore.load().catch(() => undefined); }, []);
  return { ...state, dispatch: financeStore.dispatch, undo: financeStore.undo, redo: financeStore.redo, reload: financeStore.reload, reset: financeStore.reset, clearError: financeStore.clearError, flush: financeStore.flush };
}
export const useFinanceWorkspace = useFinanceStore;
