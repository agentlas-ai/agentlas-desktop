import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { userDataPath } from "../runtime-paths";

const CONTRACT = "agentlas.runtime-selection-mirror.v1";

type RuntimeMirror = {
  contract: typeof CONTRACT;
  updatedAt: string;
  selection: RuntimeSelection;
};

function mirrorPath(): string {
  return userDataPath("runtime-selection.v1.json");
}

function portableSelection(value: RuntimeSelection | RuntimeStatus): RuntimeSelection {
  const selected = value as RuntimeSelection;
  const status = value as RuntimeStatus;
  return {
    kind: value.kind,
    ...(value.backend ? { backend: value.backend } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...(value.acpAgentId ? { acpAgentId: value.acpAgentId } : {}),
    ...(value.label ? { label: value.label } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.effort ? { effort: value.effort } : {}),
    longContext: typeof selected.longContext === "boolean"
      ? selected.longContext
      : Boolean(status.longContextEnabled),
    role: "orchestrator",
  };
}

/**
 * DB-independent continuity mirror for One's startup recovery plane.
 * It stores only the exact selected runtime identity, never credentials,
 * prompts, chat content, or a substitute runtime.
 * Written when the selection changes (or the file is missing or unreadable), not on every detect.
 */
export function writeRuntimeSelectionMirror(value: RuntimeSelection | RuntimeStatus): void {
  const file = mirrorPath();
  const parent = path.dirname(file);
  const tmp = `${file}.${process.pid}.tmp`;
  const selection = portableSelection(value);
  // The detect cache expires every few seconds with the same selection. The file itself is the memory of what was written (another
  // process may have changed it), so there is no in-process copy to go stale: same selection on disk, nothing to write.
  const onDisk = readRuntimeSelectionMirror();
  if (onDisk && JSON.stringify(onDisk) === JSON.stringify(selection)) return;
  const payload: RuntimeMirror = {
    contract: CONTRACT,
    updatedAt: new Date().toISOString(),
    selection,
  };
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

export function readRuntimeSelectionMirror(): RuntimeSelection | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorPath(), "utf8")) as Partial<RuntimeMirror>;
    const selection = parsed.selection;
    if (parsed.contract !== CONTRACT || !selection || typeof selection.kind !== "string") return null;
    if (selection.source !== undefined && typeof selection.source !== "string") return null;
    if (selection.acpAgentId !== undefined && typeof selection.acpAgentId !== "string") return null;
    if (selection.label !== undefined && typeof selection.label !== "string") return null;
    if (selection.model !== undefined && typeof selection.model !== "string") return null;
    return portableSelection(selection);
  } catch {
    return null;
  }
}
