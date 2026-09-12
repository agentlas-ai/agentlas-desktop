import type { AgentlasIpc, RuntimeSelection } from "@/lib/types";
import type { LocalModelMigrationAPI, OllamaMigrationEntry } from "@shared/local-model-migration";
import { ipc } from "@/lib/ipc";

export const ONE_RUNTIME_STORAGE_KEY = "agentlas.one.runtime-selection.v1";
export const OLLAMA_MIGRATION_UPDATED_EVENT = "agentlas:ollama-migration-updated";

type MigrationBridge = AgentlasIpc & { localModelMigration?: LocalModelMigrationAPI };

export function localModelMigrationApi(): LocalModelMigrationAPI | null {
  return (ipc() as MigrationBridge | null)?.localModelMigration ?? null;
}

export function readOneRuntimeSelection(): RuntimeSelection | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(ONE_RUNTIME_STORAGE_KEY) ?? "null") as Partial<RuntimeSelection> | null;
    if (!value || typeof value.kind !== "string" || typeof value.backend !== "string") return null;
    return value as RuntimeSelection;
  } catch { return null; }
}

export async function reconcileOneOllamaSelection(): Promise<OllamaMigrationEntry | null> {
  const api = localModelMigrationApi();
  const before = window.localStorage.getItem(ONE_RUNTIME_STORAGE_KEY);
  const current = readOneRuntimeSelection();
  if (!api || current?.kind !== "ollama") return null;
  const entry = await api.inspectOneSelection({ selection: current });
  if (entry?.state === "mapped") {
    if (window.localStorage.getItem(ONE_RUNTIME_STORAGE_KEY) !== before) return null;
    const actual: RuntimeSelection = {
      ...current,
      kind: entry.actual.kind,
      backend: entry.actual.backend,
      source: entry.actual.source,
      model: entry.actual.model ?? undefined,
    };
    const actualRaw = JSON.stringify(actual);
    window.localStorage.setItem(ONE_RUNTIME_STORAGE_KEY, actualRaw);
    let committed: OllamaMigrationEntry;
    try {
      committed = await api.commitOneSelection({ requested: current, actual });
    } catch (error) {
      if (window.localStorage.getItem(ONE_RUNTIME_STORAGE_KEY) === actualRaw && before !== null) {
        window.localStorage.setItem(ONE_RUNTIME_STORAGE_KEY, before);
      }
      throw error;
    }
    window.dispatchEvent(new CustomEvent(OLLAMA_MIGRATION_UPDATED_EVENT, { detail: committed }));
    return committed;
  }
  window.dispatchEvent(new CustomEvent(OLLAMA_MIGRATION_UPDATED_EVENT, { detail: entry }));
  return entry;
}
