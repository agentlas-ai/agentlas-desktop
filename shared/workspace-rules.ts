/**
 * The owner's rules ("My rules", Agentlas 2.0 P4; and 6): what Main sends the renderer and what the renderer may ask. The renderer is the only caller: these channels are not in the
 * phone bridge, not in the app-control catalog and not in the One-window role (a phone has no rules screen and no bridge method for them).
 *
 * The file is `<memory owner folder>/WORKSPACE.md` on THIS computer: no server, no sync. Every write is an owner action through `save`, `clear` or `addPicked`.
 * Machine codes only: the screen owns every word the owner reads.
 */
export const WORKSPACE_RULES_CHANNELS = {
  get: "workspaceRules:get",
  save: "workspaceRules:save",
  clear: "workspaceRules:clear",
  candidates: "workspaceRules:candidates",
  addPicked: "workspaceRules:addPicked",
  pickNotice: "workspaceRules:pickNotice",
  /** Desktop repair 6: Main opens the rules file in the computer's own editor. The renderer sends nothing and gets back no path. */
  openFile: "workspaceRules:openFile",
} as const;

/**
 * `openFile` answers: `ok:true` = the computer was asked to open the file in the program the owner has for `.md` (what that program then does is not known to Main).
 * `rules_file_missing` = there is no file yet (the screen offers to create it: a save of the text); `rules_unreadable` = what stands at the path is a link, a folder or a device (never opened);
 * `rules_open_failed` = the computer found no program to open it with, or refused. No other text: the screen owns every word the owner reads.
 */
export type WorkspaceRulesOpenResult = { ok: true } | { ok: false; code: "rules_file_missing" | "rules_unreadable" | "rules_open_failed" };

/** The six refusal codes of a write (/ 6). A refused write leaves the file exactly as it was. */
export const WORKSPACE_RULES_CODES = ["rules_changed", "rules_readonly", "rules_disk_full", "rules_busy", "rules_unreadable", "rules_full"] as const;
export type WorkspaceRulesCode = (typeof WORKSPACE_RULES_CODES)[number];

export type WorkspaceRulesFileState = "missing" | "empty" | "ok" | "rules_unreadable";
/** `off`: the workspace-rules switch is not on yet (the file can be written and read, but no turn loads it). */
export type WorkspaceRulesSwitch = "off" | "on";
/** Whose folder this is. A signed-out owner and a device-local owner each have their own folder; none of them ever shows or writes another's. */
export type WorkspaceRulesAccountKind = "account" | "signed-out" | "device-local";
/** The "shown once" state of the pick list: none < offered < dismissed < done. It only ever moves forward. */
export type WorkspaceRulesPickNotice = "none" | "offered" | "dismissed" | "done";
/** Stored in the owner's root memory store, `memory_store_meta`, key `workspace_rules_pick` (one row per owner, read by `get`, gone when that owner's memory store is deleted). */
export const WORKSPACE_RULES_PICK_META_KEY = "workspace_rules_pick";
export const WORKSPACE_RULES_PICK_RANK: Record<WorkspaceRulesPickNotice, number> = { none: 0, offered: 1, dismissed: 2, done: 3 };

export interface WorkspaceRulesStatus {
  state: WorkspaceRulesSwitch;
  accountKind: WorkspaceRulesAccountKind;
  /** The signed-in account's email (else its name); "" when signed out or when the account has no label. The file belongs to this owner. */
  accountLabel: string;
  fileState: WorkspaceRulesFileState;
  /** What the editor shows: the whole file, comments included, line ends as `\n`, BOM removed. "" when the file is missing, unreadable, binary or too large to edit. */
  text: string;
  /** The content fingerprint to send back as `baseFingerprint`. It carries the owner, so one account's value is never accepted for another's file. Never "". */
  fingerprint: string;
  /** Bytes of the text that loads (comments removed) before the load cap. */
  bytes: number;
  /** Bytes a turn actually receives (the load cap, 4,096). */
  loadedBytes: number;
  /** Lines of the loaded text that fall beyond the load cap and are not loaded. */
  overflowLines: number;
  loadMaxBytes: number;
  /** A runtime that is sent the piece again every turn gets only this many bytes. */
  smallWindowMaxBytes: number;
  /** `save` can replace this file (missing or readable text). */
  editable: boolean;
  /** `clear` can empty this file (missing, text, or a regular file that is binary / too large / refuses to open). */
  clearable: boolean;
  /** Lines the pick list offers now (already deduplicated against the file). */
  candidatesAvailable: number;
  /** The owner has picked lines at least once (`pickNotice` is `done`). */
  seeded: boolean;
  pickNotice: WorkspaceRulesPickNotice;
}

export type WorkspaceRulesWriteResult =
  | { ok: true; fingerprint: string }
  | { ok: false; code: WorkspaceRulesCode };

export interface WorkspaceRulesPersonalCandidate { id: string; text: string; createdAt: string }
export interface WorkspaceRulesHeardCandidate { id: string; text: string; createdAt: string; from: { kind: "agent" | "project"; name: string } }
export interface WorkspaceRulesCandidates { personal: WorkspaceRulesPersonalCandidate[]; heard: WorkspaceRulesHeardCandidate[] }

export type WorkspaceRulesAddPickedResult =
  | { ok: true; fingerprint: string; added: number; alreadyThere: number; unknown: number }
  | { ok: false; code: WorkspaceRulesCode };
