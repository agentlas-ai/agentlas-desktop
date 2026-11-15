import type Database from "better-sqlite3";
import { getMeta, setMeta } from "../store/meta";

/**
 * TR-desktop (contracts/trust-root.md section 5, "the computer's permission"): a Work or a front turn the SERVER ordered never runs wider than this
 * computer's own setting for the personal agent. The setting is the owner's permission chip of the One screen (auto / read / write / full). The chip
 * itself lives in the renderer (localStorage `agentlas.one.permission-mode.v1`), so Main keeps ONE small copy of it (the daemon reads the same row). Written by:
 *   (a) `pullOwnerChip`: Main READS the key from the main frame of a trusted owner window (ipc.ts supplies the reader) when a window finishes loading, when it closes,
 *       and just before a server-ordered Work or front turn starts - so a chip changed while the window is open is seen at the moment it matters;
 *   (b) `recordOwnerPermissionChip`: the chip the owner's own composer turn carried (ipc.ts `startRendererInvocation`).
 *   readers : `companionWorkPermission` (supervisor.ts `startNative` for a companion Work, companion-front-executor.ts for a front turn)
 *   one `meta` row, written only when the value changed, never grows
 *   never   : written from a phone turn, an app-control call, an automation, a system continuation, or anything the server sent (no IPC channel carries it in)
 * No value in the window either (a fresh install: the key was never set) = "full", the product default (renderer/components/one/OneShell.tsx `readStoredOnePermission`: absent -> "full", HEAD :561-565).
 * No window has answered and no owner turn was recorded (the row does not exist yet): the chip is UNKNOWN and the cap is `read`, the narrowest - never the wider default.
 * Nothing here reads a text: only a closed enum and the order read < write < full.
 */
export type CompanionPermission = "read" | "write" | "full";
const META_KEY = "one:permission-chip:v1";
const RANK: Record<CompanionPermission, number> = { read: 0, write: 1, full: 2 };
const isPermission = (v: unknown): v is CompanionPermission => v === "read" || v === "write" || v === "full";
const isChip = (v: unknown): v is CompanionPermission | "auto" => v === "auto" || isPermission(v);

/** The narrower of two permissions (an unknown value is never wider than the other). */
export function narrowerPermission(a: unknown, b: unknown): CompanionPermission {
  if (!isPermission(a)) return isPermission(b) ? b : "read";
  if (!isPermission(b)) return a;
  return RANK[a] <= RANK[b] ? a : b;
}

/** What a chip allows. `auto` resolves by intent exactly as the owner's own turn does (invocation/service.ts `authoritativeOnePermission`:
 * auto = write for a task (a Work), read for a conversation (a front turn)). Anything that is not a chip = the product default, full. */
export function chipCeiling(chip: unknown, intent: "task" | "conversation" = "task"): CompanionPermission {
  return chip === "auto" ? (intent === "task" ? "write" : "read") : isPermission(chip) ? chip : "full";
}

/** This computer's ceiling for server-ordered work. A store that cannot be read is the product default, never a reason to stop a turn. */
export function companionPermissionCap(intent: "task" | "conversation" = "task"): CompanionPermission {
  // null = NO window has ever answered and no owner turn has been recorded: the chip is unknown, so the narrowest: read. (A window that answered "no key" wrote "", which is the default.)
  try { const row = getMeta(META_KEY); return row === null ? "read" : chipCeiling(row, intent); } catch { return "read"; }
}

/** The permission a server-ordered run really gets: the narrower of what the server asked for and this computer's ceiling. */
export function companionWorkPermission(serverValue: unknown, intent: "task" | "conversation" = "task"): CompanionPermission {
  return narrowerPermission(serverValue, companionPermissionCap(intent));
}

/** The permission for the run of `commandId`: when that command is a server handoff (a row in `one_companion_handoffs`) the narrower of `requested` and this computer's ceiling, else `requested` untouched. */
export function narrowCompanionRun(db: Database.Database, commandId: string, requested: CompanionPermission): CompanionPermission {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_companion_handoffs'").get()) return requested;
  if (!db.prepare("SELECT 1 FROM one_companion_handoffs WHERE command_id=?").get(commandId)) return requested;
  return companionWorkPermission(requested);
}

/** How long a start waits for the owner window to answer. Not a new number: the same 5 s the front executor gives its one local read before a start (companion-front-executor.ts memoryCurrent).
 * If the window does not answer in that time the last copy is used; with no copy at all the cap is `read` (see companionPermissionCap) - never the wider default. */
export const OWNER_WINDOW_READ_WAIT_MS = 5_000;

/** ipc.ts supplies it: the value of the chip key read from the main frame of a trusted owner window. `answered:false` = no such window (nothing is changed). */
export type OwnerChipReader = () => Promise<{ answered: boolean; value: unknown }>;
let reader: OwnerChipReader | null = null;
export function setOwnerChipReader(next: OwnerChipReader | null): void { reader = next; }
/** Copy the window's chip into the row (see the header). A window that answers "no value" means the default: the row is emptied. Never throws, never waits long. */
export async function pullOwnerChip(): Promise<void> {
  try {
    if (!reader) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([reader(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), OWNER_WINDOW_READ_WAIT_MS); })]).finally(() => { if (timer) clearTimeout(timer); });   // a busy window never holds a start for more than OWNER_WINDOW_READ_WAIT_MS
    if (!answer || answer.answered !== true) return;
    const next = isChip(answer.value) ? answer.value : "";
    if ((getMeta(META_KEY) ?? "") !== next) setMeta(META_KEY, next);
  } catch { /* the old copy stays */ }
}

/** What startNative applies to a run it is about to start: a server handoff gets the window's chip read right now, then the narrower permission; any other run is untouched. */
export async function narrowStartPermission(db: Database.Database, commandId: string, requested: CompanionPermission): Promise<CompanionPermission> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_companion_handoffs'").get() || !db.prepare("SELECT 1 FROM one_companion_handoffs WHERE command_id=?").get(commandId)) return requested;
  await pullOwnerChip();
  return companionWorkPermission(requested);
}

/** The owner's own composer turn: remember the chip (see the header). `request` is the sanitised renderer request. */
export function recordOwnerPermissionChip(request: { oneMode?: unknown; promptOrigin?: unknown; onePermissionMode?: unknown }): void {
  try {
    if (request.oneMode !== true || request.promptOrigin === "system" || !isChip(request.onePermissionMode)) return;
    if (getMeta(META_KEY) !== request.onePermissionMode) setMeta(META_KEY, request.onePermissionMode);
  } catch { /* a copy that cannot be written leaves the old one; a turn never waits for it */ }
}
