import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { RuntimeSelection } from "../../shared/types";
import type { OllamaMigrationService } from "./migration";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("local_model_migration_payload_required");
  return value as Record<string, unknown>;
}

function oneSelection(value: unknown): RuntimeSelection | null {
  if (value === null) return null;
  const row = object(value);
  if (row.kind !== "ollama" || (row.backend !== undefined && row.backend !== "ollama")) {
    throw new TypeError("invalid_ollama_migration_selection");
  }
  if (row.model !== undefined && typeof row.model !== "string") throw new TypeError("invalid_ollama_migration_model");
  for (const key of ["source", "effort"] as const) {
    if (row[key] !== undefined && typeof row[key] !== "string") throw new TypeError(`invalid_ollama_migration_${key}`);
  }
  return row as unknown as RuntimeSelection;
}

function managedSelection(value: unknown): RuntimeSelection {
  const row = object(value);
  if (row.kind !== "agentlas-local" || row.backend !== "agentlas-local") throw new TypeError("invalid_one_migration_actual");
  if (typeof row.source !== "string" || !row.source.startsWith("agentlas-local:")) throw new TypeError("invalid_one_migration_actual_source");
  if (typeof row.model !== "string" || !row.model) throw new TypeError("invalid_one_migration_actual_model");
  return row as unknown as RuntimeSelection;
}

export function registerOllamaMigrationIpc(deps: {
  ipc: Pick<IpcMain, "handle">;
  service: OllamaMigrationService;
  assertTrustedSender: (event: IpcMainInvokeEvent) => BrowserWindow;
}): void {
  deps.ipc.handle("localModelMigration:snapshot", (event) => {
    deps.assertTrustedSender(event);
    return deps.service.snapshot();
  });
  deps.ipc.handle("localModelMigration:reconcile", (event) => {
    deps.assertTrustedSender(event);
    return deps.service.reconcile();
  });
  deps.ipc.handle("localModelMigration:inspectOneSelection", (event, input: unknown) => {
    deps.assertTrustedSender(event);
    const payload = object(input);
    return deps.service.inspectOneSelection(oneSelection(payload.selection));
  });
  deps.ipc.handle("localModelMigration:commitOneSelection", (event, input: unknown) => {
    deps.assertTrustedSender(event);
    const payload = object(input);
    const requested = oneSelection(payload.requested);
    if (!requested) throw new TypeError("invalid_one_migration_requested");
    return deps.service.commitOneSelection(requested, managedSelection(payload.actual));
  });
}
