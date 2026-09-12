import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { instructionDelta, orderInstructionSources, type InstructionSnapshot, type InstructionSource } from "../../shared/runtime-instructions";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Only explicit AGENTS.md sources are loaded. Never discover instructions in tool results. */
export function compileProjectInstructionSnapshot(input: { projectDir: string; previous?: InstructionSnapshot | null }) {
  const cwd = realpathSync(input.projectDir);
  const folders: string[] = [];
  for (let folder = cwd;; folder = dirname(folder)) { folders.push(folder); if (folder === parse(folder).root) break; }
  const loadedAt = new Date().toISOString();
  const sources: InstructionSource[] = [];
  for (const folder of folders.reverse()) {
    const file = join(folder, "AGENTS.md");
    if (!existsSync(file)) continue;
    if (statSync(file).size > 131_072) throw new Error("instruction_source_budget_exceeded");
    const content = readFileSync(file, "utf8");
    sources.push({ scope: folder, sourceRef: file, authority: "project", contentHash: hash(content), content, appliesTo: cwd, loadedAt });
  }
  if (sources.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0) > 262_144) throw new Error("instruction_snapshot_budget_exceeded");
  const environmentId = `workspace:${hash(cwd)}`;
  const ordered = orderInstructionSources(sources);
  const revision = hash(JSON.stringify({ environmentId, sources: ordered.map(({ loadedAt: _at, ...source }) => source) }));
  const snapshot: InstructionSnapshot = { schemaVersion: "agentlas.instruction-snapshot.v1", revision, environmentId, sources: ordered };
  return { snapshot, delta: instructionDelta(input.previous ?? null, snapshot) };
}

import { getDb } from "../store/db";
import { recordRunEvent } from "../store/run-events";
export function latestInvocationInstructionSnapshot(chatId: string): InstructionSnapshot | null {
  const row = getDb().prepare("SELECT payload_json FROM run_events WHERE chat_id = ? AND kind = 'instruction_snapshot' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(chatId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json).instructionSnapshot ?? null : null;
}
export function recordInvocationInstructionSnapshot(input: { runId: string; chatId: string; projectDir: string }) {
  const previous = latestInvocationInstructionSnapshot(input.chatId);
  const compiled = compileProjectInstructionSnapshot({ projectDir: input.projectDir, previous });
  recordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "instruction_snapshot",
    sourceEventId: `instruction:${input.runId}:${compiled.snapshot.revision}`,
    correlation: { environmentId: compiled.snapshot.environmentId },
    payload: { instructionSnapshot: compiled.snapshot, instructionRevision: compiled.snapshot.revision,
      instructionDelta: compiled.delta, delivery: "prepared" } });
  return compiled;
}
