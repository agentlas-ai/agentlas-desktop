/**
 * Agent folder location: the channels and result shapes of the root move, the reconnect, the
 * per-agent definition location and the agent portrait. Renderer-only on purpose: not in the phone bridge and not in the app-control
 * catalog, so no phone-visible response changes shape. The screen that calls them is a later package (decision: backend first).
 *
 * Every refusal is a machine code, never a sentence: the screen words them.
 */
export const AGENT_ROOT_CHANNELS = {
  status: "agents:root:status",
  preview: "agents:root:preview",
  move: "agents:root:move",
  cancel: "agents:root:cancel",
  retire: "agents:root:retire",
  /** Desktop repair 6: the owner's way out of an interrupted move that no code can settle (`settleAgentRootMove`). Deletes no folder, only the journal. */
  settle: "agents:root:settle",
  /** Desktop repair 6: puts a journal this build cannot read aside (renamed, never deleted). */
  setAsideJournal: "agents:root:set-aside-journal",
  reconnect: "agents:root:reconnect",
  folderStatus: "agents:folder:status",
  setLocation: "agents:folder:set-location",
  avatarSet: "agents:avatar:set",
  avatarClear: "agents:avatar:clear",
  /** Agentlas 2.0 D6: the character step of registering (preset id or uploaded picture) and the one answer to "can this agent be used now". */
  characterSet: "agents:character:set",
  usability: "agents:usability",
} as const;

/** Why a root move (or a reconnect) did not start, or stopped. Stable codes. */
export type AgentRootRefusal =
  | "root_pinned_by_env" | "move_in_progress" | "previous_root_retained" | "settings_unreadable" | "source_unavailable"
  | "target_invalid" | "target_is_link" | "target_unsafe" | "same_root" | "target_inside_source" | "source_inside_target"
  | "target_not_empty" | "target_not_writable" | "path_too_long" | "links_unsupported" | "disk_low"
  | "agent_running" | "install_in_progress" | "memory_move_active" | "home_move_active" | "source_changing" | "agent_busy"
  | "cancelled" | "copy_failed" | "verify_failed" | "rename_failed" | "commit_failed"
  | "root_available" | "target_has_no_agents" | "not_retained" | "retire_not_due" | "retire_blocked" | "already_committed";

export type AgentRootMovePhase = "idle" | "planned" | "copied" | "committing" | "committed";

export interface AgentRootStatusView {
  root: { path: string | null; configured: boolean; available: boolean; reason?: "missing" | "settings-invalid" };
  move: {
    phase: AgentRootMovePhase;
    mode?: "rename" | "copy";
    from?: string;
    to?: string;
    /** Only while a move of this process runs. */
    progress?: { files: number; filesTotal: number; bytes: number; bytesTotal: number; pass: number };
    /** A previous root kept after a committed copy: the app removes its agent folders at `retireAfter` (or on request). */
    retained?: { path: string; retireAfter: string; blocked?: string };
    /** A journal this process did not write and cannot read: the move is left for the owner (channel `setAsideJournal`: `setAsideUnreadableRootMoveJournal` in root-move.ts). */
    unreadable?: boolean;
    /** What the last settling of an interrupted move found: `needs-review` = both folders exist and no code can pick (channel `settle` with `keep_old` / `keep_new`: `settleAgentRootMove` in root-move.ts); `in-progress-elsewhere` = another process is writing it. */
    recovery?: "needs-review" | "in-progress-elsewhere";
  };
}

export interface AgentRootPreview {
  ok: true;
  mode: "rename" | "copy";
  from: string;
  to: string;
  /** Agent folders that come along / folders of the old root that stay behind (not owned by an agent). */
  folders: number;
  leftBehind: number;
  bytes: number;
  freeBytes: number | null;
}
export type AgentRootPreviewResult = AgentRootPreview | { ok: false; code: AgentRootRefusal; detail?: string };

export interface AgentRootMoveResult {
  ok: true;
  state: "committed";
  mode: "rename" | "copy";
  from: string;
  to: string;
  folders: number;
  bytes: number;
  passes: number;
  /** Copy form: the old root stays until this time (then the app removes its agent folders after merging late writes). */
  retireAfter?: string;
  /** A step after the commit that could not finish now; the next start finishes it (routes). */
  finishPending?: boolean;
}
export type AgentRootMoveOutcome = AgentRootMoveResult | { ok: false; code: AgentRootRefusal; detail?: string };

export type AgentFolderState =
  | "ok"                   // the folder is there
  | "root-unavailable"     // the agents root is set but not readable now (a drive that left): the row stays, "reconnect" is offered
  | "folder-missing"       // the definition folder the route names is gone: the turn runs from the canonical prompt kept in the database
  | "no-folder";           // no folder yet (a call-only agent): nothing to reconnect

export interface AgentFolderStatusView {
  agentId: string;
  state: AgentFolderState;
  /** The folder the definition is read from (route) or would be created in. */
  path: string | null;
  /** Where this agent's memory lives (always inside the agents root) or null while the root is unavailable. */
  stateDir: string | null;
  reconnectable: boolean;
}

export type AgentLocationRefusal =
  | "agent_not_found" | "folder_invalid" | "folder_unsafe" | "folder_used_by_other_agent" | "not_an_agent_folder" | "agent_running"
  | "root_unavailable" | "route_write_failed";
export interface AgentLocationResult {
  ok: true;
  agentId: string;
  path: string;
  /** The folder the definition used to be read from (null when the agent had none). */
  previousPath: string | null;
  /** registered: the engine learned the new folder (same id); skipped-old-folder-exists: the old folder is still there, the engine registry is left alone;
   *  not-engine-package: the agent is not registered with the engine; unavailable: the engine did not answer (the route is already changed). */
  engine: "registered" | "skipped-old-folder-exists" | "not-engine-package" | "unavailable" | "refused";
  /** The chosen folder carries its own `.agentlas-local` (the owner moved the whole folder): it is left as it is and not read. */
  foreignState: boolean;
}
export type AgentLocationOutcome = AgentLocationResult | { ok: false; code: AgentLocationRefusal; detail?: string };

export type AgentAvatarRefusal = "agent_not_found" | "image_invalid" | "agent_not_visible" | "write_failed";
export type AgentAvatarOutcome = { ok: true; agentId: string; icon: string } | { ok: false; code: AgentAvatarRefusal; detail?: string };
