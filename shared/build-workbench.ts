/**
 * The Build window's backend contract (Agentlas 2.0 Build backend): saved builds, edit session, Preview, live files.
 * Renderer-only channels `buildWorkbench:*` (preload `agentlas.buildWorkbench`), outside the app-control catalog and the phone bridge.
 * Every answer is a result object; a refusal is a machine code, never a sentence — the screen words the codes.
 * Types only: nothing here is read at run time.
 */

export type BuildState = "building" | "question" | "created" | "stopped" | "unfinished";

export type BuildScopeCode =
  | "scope_root_invalid" | "scope_path_invalid" | "scope_escape" | "scope_symlink" | "scope_hardlink"
  | "scope_missing" | "scope_not_file" | "scope_too_large" | "scope_private" | "scope_write_failed";

export type BuildWorkbenchRefusal =
  | "build_not_found" | "build_running" | "build_turn_active" | "agent_not_found" | "agent_not_editable" | "agent_running"
  | "root_move_active" | "folder_unavailable" | "baseline_unavailable" | "no_change" | "avatar_invalid" | "avatar_too_large"
  | "name_invalid" | "no_linked_agent" | "owner_unavailable" | "agent_root_unavailable" | BuildScopeCode
  | PreviewRefusal;

export type PreviewRefusal = "empty_message" | "no_prompt" | "preview_busy" | "runtime_unavailable" | "preview_failed" | "preview_cancelled";

export type BuildWorkbenchResult<T> = ({ ok: true } & T) | { ok: false; code: BuildWorkbenchRefusal; detail?: string };

export interface BuildListItem {
  /** Stable for the life of the build (a hash of its folder's identity). */
  id: string;
  kind: "create" | "edit";
  /** The name chosen in the window, else the first line of the request. */
  title: string;
  lastLine: string;
  state: BuildState;
  /** Only while `building`: stages reached of `total` (the same walk as the Build screen's pipeline). */
  progress: { reached: number; total: number } | null;
  /** Only while `question`: how many questions wait. */
  questionCount: number;
  agentId: string | null;
  name: string | null;
  hasPendingAvatar: boolean;
  /** False when the build's folder is gone: the list still shows it, it cannot be continued. */
  folderAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BuildOpened {
  build: BuildListItem;
  /** The conversation as words: an interview question's `<<agentlas-ask>>` fence is already turned into the question and its choices as plain lines (`questions` has them as data). */
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  /** The open interview questions of a build that waits for the person (empty otherwise): the question card's data. Derived on each open, never stored. Optional; older readers ignore it. */
  questions?: Array<{ question: string; options: Array<{ label: string; description?: string }> }>;
  messagesTruncated: boolean;
  folder: string;
  runtimeSessionId: string | null;
  runtime: unknown;
  runtimePinned: boolean;
  /** What the next `hephaestus.build()` of this window carries besides the text: Edit of an installed agent uses mode "package". */
  turnDefaults: { mode: "package" | null };
  /** Pass as `workspaceGrant` of the next turn. */
  workspaceGrant: unknown;
  continuable: boolean;
  continuableReason: "another_build_active" | "folder_unavailable" | null;
  /**
   * Whether `runtimeSessionId` / `runtime` / `runtimePinned` may be sent back to continue the SAME runtime session. False when the last turn was stopped (a Stop is final for that
   * session) or ended without a receipt (the app closed mid-turn): the host would refuse such a turn with BUILD_SESSION_RECEIPT_REQUIRED every time. The conversation itself is still
   * `continuable`; send the next turn WITHOUT the session values and a new runtime session starts (desktop 3, Workspace B-3). `sessionBlock` says which.
   */
  sessionResumable: boolean;
  sessionBlock: "stopped" | "unfinished" | null;
  pendingAvatar: boolean;
}

export interface BuildFileChange { path: string; status: "added" | "modified" | "removed"; added: number; removed: number; binary: boolean; approximate: boolean }
export interface BuildFileNode { path: string; type: "file" | "dir"; state: "written" | "writing" | "pending"; size: number }
export interface BuildFileRead { path: string; content: string; byteLength: number; lineCount: number; binary: boolean; truncated: boolean; startLine: number }

/** Pushed on `agentlas.buildWorkbench.onFiles(runId, cb)` while a Build turn runs. */
export type BuildFileSignalEvent =
  | { kind: "file"; path: string; state: "writing" | "written" | "removed"; size: number; lineCount: number }
  | { kind: "end"; files: number };

export interface BuildWorkbenchApi {
  list(input?: { cursor?: string; limit?: number }): Promise<BuildWorkbenchResult<{ items: BuildListItem[]; nextCursor: string | null }>>;
  open(buildKey: string): Promise<BuildWorkbenchResult<{ opened: BuildOpened }>>;
  openForAgent(agentId: string): Promise<BuildWorkbenchResult<{ buildKey: string; opened: BuildOpened; sessionResumed: boolean }>>;
  draft(input?: { nameHint?: string }): Promise<BuildWorkbenchResult<{ buildKey: string; folder: string; workspaceGrant: unknown }>>;
  remove(buildKey: string): Promise<BuildWorkbenchResult<{ rows: number; folderTrashed: boolean }>>;
  closeSession(buildKey: string): Promise<BuildWorkbenchResult<{ done?: true }>>;
  setName(input: { buildKey: string; name: string }): Promise<BuildWorkbenchResult<{ name: string | null }>>;
  setAvatar(input: { buildKey: string; dataUrl: string }): Promise<BuildWorkbenchResult<{ applied: "agent" | "pending" }>>;
  clearAvatar(buildKey: string): Promise<BuildWorkbenchResult<{ done?: true }>>;
  changes(buildKey: string): Promise<BuildWorkbenchResult<{ changes: BuildFileChange[]; baseline: "revision" | "empty"; truncated: boolean }>>;
  undo(input: { buildKey: string; path: string }): Promise<BuildWorkbenchResult<{ path: string; restored: "content" | "removed" }>>;
  files(buildKey: string): Promise<BuildWorkbenchResult<{ nodes: BuildFileNode[]; truncated: boolean }>>;
  readFile(input: { buildKey: string; path: string; sinceLine?: number }): Promise<BuildWorkbenchResult<{ file: BuildFileRead }>>;
  checkScope(buildKey: string): Promise<{ ok: true; escapes: Array<{ path: string; kind: "outside" | "dangling" }> }>;
  previewSend(input: { buildKey: string; text: string; runtime?: unknown }): Promise<BuildWorkbenchResult<{ reply: string; messages: Array<{ role: "user" | "assistant"; text: string; at: string }> }>>;
  previewRestart(buildKey: string): Promise<{ ok: true }>;
  previewClose(buildKey: string): Promise<{ ok: true }>;
  previewMessages(buildKey: string): Promise<{ ok: true; messages: Array<{ role: "user" | "assistant"; text: string; at: string }> }>;
  onFiles(runId: string, callback: (event: BuildFileSignalEvent) => void): () => void;
}
