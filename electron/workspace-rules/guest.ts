import type Database from "better-sqlite3";
import { readsPersonal } from "./scope";
import { memoryClassificationRules, workspaceRulesOn } from "../memory/classification";

/*
 * What a team run's nodes read of the owner's (Agentlas 2.0 P3b, and the matrix rows I and I').
 *
 * A BORROWED node is a Hub or Cloud package the owner does not have installed: a guest. A guest neither writes nor reads the owner's things (P10, decision): no approved
 * operating principles, no approved One memory (the node's `owner-substance`/`profile` parts stay empty text), no Personal line and no team-shared line in its recall. Its own
 * project lines are unchanged. "Borrowed" is read from the spec (`source`), never from a subject prefix: the guest's recall subject is `null`, not `hub:...`.
 *
 * The guest isolation does NOT wait for the workspace-rules switch ("do not tie P3b to the switch"; a Hub-called agent is a third party today). Only `personalRead` for a
 * not-guest reader is behind the switch: off gives `{}`, so those reads are what they were. No model output, no word list.
 */

/** The same condition the borrowed node's own career memory uses (borrowed-task-force.ts `borrowedNodeMemory`): a Hub or Cloud package, or a spec that says nothing. */
export function isBorrowedGuestSpec(spec: { source?: string | null }): boolean {
  return spec.source === "hub" || spec.source === "cloud" || !spec.source;
}

/** The extra reader facts a team run's memory read carries (they ride `MemoryRecallScope`; `{}` = the read is what it was). */
export interface TaskForceRecallReader { guest?: true; personalRead?: boolean }

/**
 * `guest`: this node is a borrowed one (the caller asked `isBorrowedGuestSpec` once per node turn, so the node's parts and its memory agree). Not a guest: with the switch on, Personal lines are read only by the personal agent's own conversation (`readsPersonal`, the same function the collector asks, on this team run's
 * chat); a reader that cannot tell reads none. The switch off gives `{}`.
 */
export function taskForceRecallReader(
  db: Database.Database,
  input: { guest: boolean; chatId: string | null | undefined; agentId: string | null | undefined; agentAppMode?: boolean },
): TaskForceRecallReader {
  if (input.guest) return { guest: true };
  try {
    const rules = memoryClassificationRules();
    if (!workspaceRulesOn() || rules === null) return {};
    return { personalRead: readsPersonal(db, { chatId: input.chatId, agentAppMode: input.agentAppMode }, input.agentId, true, rules) };
  } catch { return {}; }
}
