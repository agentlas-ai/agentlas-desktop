import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { instructionDelta, orderInstructionSources, parseInstructionDelta, type InstructionSnapshot, type InstructionSource } from "../../shared/runtime-instructions";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const snapshotFields = ["schemaVersion", "revision", "environmentId", "sources"];
const sourceFields = ["scope", "sourceRef", "authority", "contentHash", "content", "appliesTo", "loadedAt"];
const exactFields = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function semantics(snapshot: Pick<InstructionSnapshot, "environmentId" | "sources">) {
  return { environmentId: snapshot.environmentId, sources: snapshot.sources.map(source => ({
    scope: source.scope, sourceRef: source.sourceRef, authority: source.authority,
    contentHash: source.contentHash, content: source.content, appliesTo: source.appliesTo,
  })) };
}
/** Validate the whole v1 record before reusing its original observation time. */
function validSnapshot(value: unknown): value is InstructionSnapshot {
  if (!object(value) || !exactFields(value, snapshotFields) || value.schemaVersion !== "agentlas.instruction-snapshot.v1"
    || !sha256(value.revision) || typeof value.environmentId !== "string" || !/^workspace:[a-f0-9]{64}$/.test(value.environmentId)
    || !Array.isArray(value.sources)) return false;
  let bytes = 0;
  const refs = new Set<string>();
  for (const source of value.sources) {
    if (!object(source) || !exactFields(source, sourceFields)
      || !["scope", "sourceRef", "appliesTo"].every(field => typeof source[field] === "string" && source[field].length > 0)
      || typeof source.authority !== "string" || !["system", "developer", "user", "project"].includes(source.authority)
      || typeof source.content !== "string" || !sha256(source.contentHash) || hash(source.content) !== source.contentHash
      || typeof source.loadedAt !== "string" || !Number.isFinite(Date.parse(source.loadedAt))
      || new Date(source.loadedAt).toISOString() !== source.loadedAt || refs.has(String(source.sourceRef))) return false;
    refs.add(String(source.sourceRef));
    const size = Buffer.byteLength(source.content);
    if (size > 131_072 || (bytes += size) > 262_144) return false;
  }
  return hash(JSON.stringify(semantics(value as unknown as InstructionSnapshot))) === value.revision;
}
const sameSemantics = (left: InstructionSnapshot, right: InstructionSnapshot) =>
  JSON.stringify(semantics(left)) === JSON.stringify(semantics(right));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Only explicit AGENTS.md sources are loaded. Never discover instructions in tool results. */
export function compileProjectInstructionSnapshot(input: { projectDir: string; previous?: InstructionSnapshot | null }) {
  const cwd = realpathSync(input.projectDir);
  const folders: string[] = [];
  // The person's own home folder holds their personal instructions, not this project's: a product run under
  // ~/Library/Application Support/Agentlas/agent-cwd carried an unrelated ~/AGENTS.md ("File Lister Agent") as a project
  // instruction (owner decision 2026-10-11: product runs carry none of the person's own instructions).
  let home: string | null = null;
  try { home = realpathSync(homedir()); } catch { home = null; }
  for (let folder = cwd;; folder = dirname(folder)) {
    if (home && folder === home && cwd !== home) break;
    folders.push(folder);
    if (folder === parse(folder).root) break;
  }
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
  const revision = hash(JSON.stringify(semantics({ environmentId, sources: ordered })));
  const current: InstructionSnapshot = { schemaVersion: "agentlas.instruction-snapshot.v1", revision, environmentId, sources: ordered };
  const previous = validSnapshot(input.previous) ? input.previous : null;
  // Re-read the actual files, then keep only the immediately preceding identical
  // version's truthful first-observation bytes. A→B→A observes A again.
  const snapshot = previous && sameSemantics(previous, current) ? copy(previous) : current;
  return { snapshot, delta: instructionDelta(previous, snapshot) };
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
  const recorded = recordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "instruction_snapshot",
    sourceEventId: `instruction:${input.runId}:${compiled.snapshot.revision}`,
    correlation: { environmentId: compiled.snapshot.environmentId },
    payload: { instructionSnapshot: compiled.snapshot, instructionRevision: compiled.snapshot.revision,
      instructionDelta: compiled.delta, delivery: "prepared" } });
  // Generic ledger results deliberately omit Main-only snapshots. Read only
  // this exact committed source receipt; never loosen the renderer projection.
  const row = getDb().prepare("SELECT payload_json FROM run_events WHERE id = ? AND run_id = ? AND chat_id = ? AND kind = 'instruction_snapshot'")
    .get(recorded.id, input.runId, input.chatId) as { payload_json: string } | undefined;
  let payload: unknown;
  try { payload = row ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
  if (!object(payload)) throw new Error("instruction_snapshot_receipt_invalid");
  const persisted = payload.instructionSnapshot;
  const legacyDelta = typeof payload.instructionDelta === "string";
  let delta = payload.instructionDelta;
  // Earlier writers bounded this diagnostic JSON text. The exact snapshot is
  // authoritative; an already truncated legacy delta must not block dispatch.
  if (legacyDelta) { try { delta = JSON.parse(delta as string); } catch { delta = null; } }
  const canonicalDelta = parseInstructionDelta(delta);
  if (recorded.runId !== input.runId || recorded.chatId !== input.chatId || recorded.kind !== "instruction_snapshot"
    || payload.delivery !== "prepared" || !validSnapshot(persisted) || !sameSemantics(persisted, compiled.snapshot)
    || payload.instructionRevision !== persisted.revision || (!legacyDelta && !canonicalDelta)
    || (canonicalDelta && canonicalDelta.to !== persisted.revision)) throw new Error("instruction_snapshot_receipt_invalid");
  // recordRunEvent may return the first immutable source receipt on retry.
  return { snapshot: copy(persisted), delta: canonicalDelta ?? instructionDelta(previous, persisted),
    deltaProvenance: canonicalDelta ? "canonical" as const : "legacy-recomputed" as const };
}
