// the memory write no longer refuses a line for lack of "evidence". Where it came from is a HOST fact, recorded in two closed columns of the K1 shape
// (`memory_entries.origin_class` = the kind of claim, `memory_entries.certainty` = the level of verification;). Two different questions, two columns.
// Nothing here reads a word of the memory text to decide whether the owner "asked to remember"; the only text comparison is the existing `groundedInOwnerWords`
// (a turn that read a tool/file/photo: did the line rest on what the OWNER wrote?). A value the model offers can only LOWER the host's value, never raise it.
// Pure module: no Electron, no store. The one writer of the columns is `stampOrigin` (store.ts calls it inside the row's own write transaction).
import type Database from "better-sqlite3";

export type OriginClass = "user" | "observed" | "result" | "inferred";
export type Certainty = "self_reported" | "run_verified" | "unverified";
export const ORIGIN_CLASSES: readonly OriginClass[] = ["user", "observed", "result", "inferred"];
export const CERTAINTIES: readonly Certainty[] = ["self_reported", "run_verified", "unverified"];

/** What the host saw in the turn a line came from. Absent = nothing known (the conservative reading: no tool, no input, nothing verified). In memory only, never stored. */
export interface TurnFacts {
  /** At least one tool call completed in the turn (its output entered the model's context). */
  toolsRan?: boolean;
  /** A file, attachment, photo or room text entered the turn besides the owner's own message. */
  inputsRead?: boolean;
  /** A verification receipt of the host covers the turn's work. No producer yet: absent = unverified. */
  verified?: boolean;
}

const RANK: Record<OriginClass, number> = { user: 3, observed: 2, result: 2, inferred: 1 };

export function coerceOriginClass(value: unknown): OriginClass | undefined {
  return typeof value === "string" && (ORIGIN_CLASSES as readonly string[]).includes(value) ? value as OriginClass : undefined;
}

export interface OriginInput {
  /** The owner wrote the message that started the turn (a positive host marker, invocation/owner-spoke.ts). */
  ownerSpoke: boolean;
  /** An unattended run, a team member's turn or a synthesised answer: nobody typed it. */
  notAPersonTurn: boolean;
  /** The line was minted by the host itself (`source: host-observed`), not proposed by a model. */
  hostMinted?: boolean;
  kind: string;
  confidence?: string;
  /** A value the model offered; only ever lowers. */
  modelClaim?: OriginClass;
  facts?: TurnFacts;
  /** For a turn that read something besides the owner's message: did the line rest on the owner's own words (groundedInOwnerWords)? */
  groundedInOwnerWords?: boolean;
}

export function deriveOrigin(input: OriginInput): { originClass: OriginClass; certainty: Certainty } {
  const facts = input.facts ?? {};
  const mixed = facts.toolsRan === true || facts.inputsRead === true;
  let host: OriginClass;
  if (input.hostMinted) host = "result";
  else if (input.ownerSpoke && !input.notAPersonTurn) {
    if (input.kind === "hypothesis" || input.confidence === "low") host = "inferred";
    else if (!mixed) host = "user";
    else host = input.groundedInOwnerWords === true ? "user" : "observed";
  } else host = facts.toolsRan === true || facts.inputsRead === true ? (input.kind === "fact" ? "observed" : "result") : "inferred";
  const originClass = input.modelClaim && RANK[input.modelClaim] < RANK[host] ? input.modelClaim : host;
  const certainty: Certainty = originClass === "user" ? "self_reported" : originClass === "result" && facts.verified === true ? "run_verified" : "unverified";
  return { originClass, certainty };
}

const withColumns = new WeakSet<object>();
/** True when the store has the K1 columns (a store that was locked at open may not yet: then the row is written as before, without the two values). Only a positive answer is remembered. */
function hasOriginColumns(db: Database.Database): boolean {
  if (withColumns.has(db)) return true;
  try {
    const have = new Set((db.prepare("PRAGMA table_info(memory_entries)").all() as Array<{ name: string }>).map(column => column.name));
    if (have.has("origin_class") && have.has("certainty")) { withColumns.add(db); return true; }
  } catch { /* an unreadable file is written as before */ }
  return false;
}

/** Writes the two values of a row that was just inserted (same connection, same transaction). It touches neither content, scope nor kind, so the store revision does not move twice. Never throws. */
export function stampOrigin(db: Database.Database, id: string, origin: { originClass?: OriginClass; certainty?: Certainty } | undefined): void {
  if (!origin || (!origin.originClass && !origin.certainty) || !hasOriginColumns(db)) return;
  try { db.prepare("UPDATE memory_entries SET origin_class=?, certainty=? WHERE id=?").run(origin.originClass ?? null, origin.certainty ?? null, id); }
  catch { /* the line stays written; the two values are information, not a condition */ }
}
