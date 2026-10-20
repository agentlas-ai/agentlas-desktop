import { getDb } from "../store/db";

/**
 * Evidence the host attaches to a learning, as opposed to what the model wrote about it.
 *
 * A learning's own evidence is mostly a memory-ticket id. That says a turn happened, not what the host saw during it.
 * These references name rows the host itself recorded for the run the learning came from, so a reader can tell a
 * learning backed by a tool error, a failed invocation or an owner correction from one that only the worker described:
 *
 *   run:<runId>            the run the learning came from
 *   event:<kind>:<eventId> one host-recorded observation in that run
 *
 * The kinds below are rows written by Main (not model text) and kept by the 3-day run-detail trim
 * (storage/run-detail-retention.ts keeps terminals, errors and owner steering; it removes reasoning text and chat
 * tool-call rows). Nothing here classifies text.
 */
export const MACHINE_OBSERVATION_KINDS = ["invoke_failed", "mcp_error", "user_steering"] as const;
const MAX_EVENT_REFS = 6;

const RUN_REF = /^run:[A-Za-z0-9_.:-]{1,128}$/;
const EVENT_REF = /^event:([a-z_]{1,40}):[A-Za-z0-9_.:-]{1,128}$/;

export function machineObservationRefs(runId: string | null | undefined): string[] {
  if (!runId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId)) return [];
  try {
    const rows = getDb().prepare(`SELECT id, kind FROM run_events
      WHERE run_id = ? AND kind IN (${MACHINE_OBSERVATION_KINDS.map(() => "?").join(",")})
      ORDER BY seq DESC LIMIT ?`).all(runId, ...MACHINE_OBSERVATION_KINDS, MAX_EVENT_REFS) as Array<{ id: string; kind: string }>;
    return [`run:${runId}`, ...rows.map(row => `event:${row.kind}:${row.id}`)];
  } catch {
    return []; // Evidence is an addition; a store that cannot answer leaves the learning with the evidence it already has.
  }
}

/** Host references an earlier learning carries, to keep on a consolidated learning that replaces it. */
export function hostObservationRefs(evidence: readonly string[]): string[] {
  return evidence.filter(line => RUN_REF.test(line) || EVENT_REF.test(line));
}

export interface EvidenceBreakdown {
  /** Distinct runs the learning came from. */
  runs: number;
  /** Host-recorded observations behind it. */
  machine: number;
  /** Evidence lines that are neither host references nor consolidation provenance. */
  narrated: number;
}

export function evidenceBreakdown(evidence: readonly string[]): EvidenceBreakdown {
  const runs = new Set<string>();
  let machine = 0, narrated = 0;
  for (const line of evidence) {
    const text = line.trim();
    if (RUN_REF.test(text)) runs.add(text);
    else if (EVENT_REF.test(text)) machine += 1;
    else if (!/^(supersedes|dreaming):/i.test(text)) narrated += 1;
  }
  return { runs: runs.size, machine, narrated };
}
