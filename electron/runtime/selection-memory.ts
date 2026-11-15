import type { RuntimeBackend, RuntimeKind } from "../../shared/types";
import { getDb } from "../store/db";
import { canonicalRuntimeBackend } from "../../shared/runtime-backends";

export interface RememberedRuntimeSelection {
  model: string | null;
  longContext: boolean;
}

export function runtimeSelectionMemoryKey(
  kind: RuntimeKind,
  backend: RuntimeBackend | null | undefined,
  acpAgentId?: string | null,
): string {
  const base = `runtime_selection:${kind}:${canonicalRuntimeBackend(kind, backend) || "none"}`;
  return kind === "acp" && acpAgentId ? `${base}:profile:${encodeURIComponent(acpAgentId)}` : base;
}

/** Per-runtime choice that survives A→B→A switches and CLI path updates. */
export function rememberRuntimeSelection(
  kind: RuntimeKind,
  backend: RuntimeBackend | null | undefined,
  model: string | null | undefined,
  longContext: boolean,
  acpAgentId?: string | null,
): void {
  if (kind === "acp" && !acpAgentId) return;
  getDb()
    .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
    .run(
      runtimeSelectionMemoryKey(kind, backend, acpAgentId),
      JSON.stringify({ model: model?.trim() || null, longContext: !!longContext }),
    );
}

export function recallRuntimeSelection(
  kind: RuntimeKind,
  backend: RuntimeBackend | null | undefined,
  acpAgentId?: string | null,
): RememberedRuntimeSelection | null {
  if (kind === "acp" && !acpAgentId) return null;
  try {
    const row = getDb()
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(runtimeSelectionMemoryKey(kind, backend, acpAgentId)) as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as { model?: unknown; longContext?: unknown };
    return {
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null,
      longContext: parsed.longContext === true,
    };
  } catch {
    return null;
  }
}
