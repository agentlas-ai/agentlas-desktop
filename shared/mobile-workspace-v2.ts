import type { AgentFace } from "./agent-face";
/**
 * Mobile bridge, workspace v2 (decision): what the redesigned phone reads for its Workspace list, Agents list and
 * agent profile, and the personal agent's "What I know" lines. Two methods, `workspace2.read` and `workspace2.command`, each with a
 * closed list of operations (the harness.read / harness.command shape), advertised by the bridge.ready capability `workspaceV2`.
 *
 * Why new methods: the app in the stores reads every existing reply with a closed key set, so no existing reply gains or loses a
 * key. Every value here is new, and an older Desktop (no capability) or an older phone (never calls them) is unaffected.
 *
 * No Electron import: the wire parser (shared/mobile-bridge.ts), the authority and the gates load this file.
 */

export const MOBILE_WORKSPACE_V2_SCHEMA = 1 as const;

export const MOBILE_WORKSPACE_V2_READ_OPERATIONS = [
  "tree", "projectRows", "search", "agents", "agentProfile", "timeline", "memory", "skills", "knowledge",
  // XS-1 (appended, so a phone that does not know them never asks and never reads them out of the advertised list):
  // the tools a project is always allowed to use, when an automation's run started, the members of a group conversation.
  "projectAllowed", "automationRun", "chatMembers",
  // The text of ONE listed skill of one agent (its SKILL.md), for the phone's skill sheet. Appended: an older Desktop does not advertise it, so the phone never asks.
  "skill",
] as const;
export const MOBILE_WORKSPACE_V2_COMMAND_OPERATIONS = [
  "skill.decide", "knowledge.forget",
  // XS-1: a conversation that belongs to no project, and the personal agent's character.
  "chat.start", "profile.character",
] as const;
export type MobileWorkspaceV2ReadOperation = (typeof MOBILE_WORKSPACE_V2_READ_OPERATIONS)[number];
export type MobileWorkspaceV2CommandOperation = (typeof MOBILE_WORKSPACE_V2_COMMAND_OPERATIONS)[number];

/** Bounds the Desktop enforces on every answer. A phone never needs more than one page at a time. */
export const MOBILE_WORKSPACE_V2_LIMITS = {
  /** Projects whose rows come inline in `tree` (the newest ones); the rest are collapsed until `projectRows` asks. */
  treeOpenProjectsDefault: 3,
  treeOpenProjectsMax: 20,
  rowsPerKindDefault: 20,
  rowsPerKindMax: 50,
  /** `tree` never lists more than this many projects (the rest are counted in `projectsOmitted`). */
  treeProjectsMax: 400,
  projectRowsMax: 100,
  searchRowsMax: 100,
  agentsPageDefault: 60,
  agentsPageMax: 100,
  timelinePageDefault: 20,
  timelinePageMax: 30,
  memoryPageDefault: 30,
  memoryPageMax: 50,
  knowledgePageDefault: 30,
  knowledgePageMax: 50,
  /** Characters of one memory line a page carries (`textTruncated` says when it was cut). */
  lineTextMax: 600,
  /** The Desktop reads at most this many of an agent's newest memory lines for one page (offset + limit); deeper lines are not reachable. */
  memoryReachMax: 1000,
  skillsMax: 300,
} as const;

/**
 * The one safety cap of a `skill` answer: UTF-8 bytes of the body after redaction (`truncated: true` says it was cut). The folder itself admits a file of at most
 * 512 KiB (MAX_WORKSPACE_FILE_BYTES); half of that is far above a real SKILL.md and, even with every character escaped as a six-byte JSON `\uXXXX`, stays near
 * 1.5 MiB: inside the Cloud Relay's 8 MiB message cap (shared/mobile-bridge.ts MOBILE_BRIDGE_VISUAL_FRAME_MAX_BYTES comment; relay.ts MAX_PENDING_BYTES) and the
 * bridge's 30 MiB one (MOBILE_BRIDGE_MAX_MESSAGE_BYTES). Not part of `limits`: that object is what a phone reads key by key, and no existing reply gains a key.
 */
export const MOBILE_WORKSPACE_V2_SKILL_BODY_BYTES = 256 * 1024;
/** The only path a `skill` read may name: one agent's `skills/<folder>/SKILL.md` (the Desktop also requires it to be in that agent's skill list). */
export const MOBILE_WORKSPACE_V2_SKILL_PATH_RE = /^skills\/[^/]+\/SKILL\.md$/;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const CURSOR_RE = /^o[0-9]{1,6}$/;
const CHARACTER_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const HASH_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

type Args = Record<string, unknown>;
const isRecord = (value: unknown): value is Args => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (args: Args, keys: readonly string[]): boolean => Object.keys(args).every((key) => keys.includes(key));
const int = (args: Args, key: string, min: number, max: number): string | null => {
  const value = args[key];
  if (value === undefined) return null;
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? null : `${key} must be an integer between ${min} and ${max}`;
};
const id = (args: Args, key: string): string | null => typeof args[key] === "string" && ID_RE.test(args[key] as string) ? null : `${key} must be an identifier`;
const cursor = (args: Args): string | null => args.cursor === undefined || (typeof args.cursor === "string" && CURSOR_RE.test(args.cursor)) ? null : "cursor must be one this Desktop returned";
const first = (...errors: Array<string | null>): string | null => errors.find((error) => error !== null) ?? null;

/**
 * Closed argument check of one operation: a key it does not know is refused, never ignored. Returns the first problem or null.
 * Used by the wire parser (before the authority) and again by the authority, so an in-process caller meets the same rule.
 */
export function validateMobileWorkspaceV2Args(operation: string, rawArgs: unknown): string | null {
  const args: Args = rawArgs === undefined ? {} : isRecord(rawArgs) ? rawArgs : {};
  if (rawArgs !== undefined && !isRecord(rawArgs)) return "args must be an object";
  const L = MOBILE_WORKSPACE_V2_LIMITS;
  const keys = (...allowed: string[]): string | null => onlyKeys(args, allowed) ? null : `${operation} does not accept ${Object.keys(args).filter((key) => !allowed.includes(key)).join(", ")}`;
  const ifRevision = (): string | null => args.ifRevision === undefined || (typeof args.ifRevision === "string" && /^[a-f0-9]{16,64}$/.test(args.ifRevision)) ? null : "ifRevision must be a revision this Desktop returned";
  switch (operation) {
    case "tree":
      return first(keys("ifRevision", "openProjects", "rowsPerKind"), ifRevision(), int(args, "openProjects", 0, L.treeOpenProjectsMax), int(args, "rowsPerKind", 1, L.rowsPerKindMax));
    case "projectRows":
      return first(keys("projectId", "kind", "cursor", "limit"),
        args.projectId === null || (typeof args.projectId === "string" && ID_RE.test(args.projectId)) ? null : "projectId must be a project id, or null for No project",
        args.kind === "chat" || args.kind === "work" ? null : "kind must be chat or work", cursor(args), int(args, "limit", 1, L.projectRowsMax));
    case "search":
      return first(keys("text"), typeof args.text === "string" && args.text.trim().length >= 2 && args.text.length <= 80 && !/[\u0000-\u001f]/.test(args.text) ? null : "text must be 2 to 80 characters");
    case "agents":
      return first(keys("filter", "cursor", "limit", "ifRevision"),
        args.filter === undefined || args.filter === "computer" || args.filter === "cloud" || args.filter === "hub" ? null : "filter must be computer, cloud or hub",
        cursor(args), int(args, "limit", 1, L.agentsPageMax), ifRevision());
    case "agentProfile":
    case "skills":
      return first(keys("agentId"), id(args, "agentId"));
    case "skill":
      return first(keys("agentId", "path"), id(args, "agentId"),
        typeof args.path === "string" && args.path.length <= 260 && MOBILE_WORKSPACE_V2_SKILL_PATH_RE.test(args.path) ? null : "path must be a skill file the agent's skill list carried");
    case "timeline":
      return first(keys("agentId", "cursor", "limit"), id(args, "agentId"), cursor(args), int(args, "limit", 1, L.timelinePageMax));
    case "memory":
      return first(keys("agentId", "cursor", "limit"), id(args, "agentId"), cursor(args), int(args, "limit", 1, L.memoryPageMax));
    case "knowledge":
      return first(keys("list", "cursor", "limit"), args.list === undefined || args.list === "rules" || args.list === "about" ? null : "list must be rules or about",
        cursor(args), int(args, "limit", 1, L.knowledgePageMax));
    case "skill.decide":
      return first(keys("agentId", "proposalId", "reviewedHash", "decision"), id(args, "agentId"), id(args, "proposalId"),
        typeof args.reviewedHash === "string" && HASH_RE.test(args.reviewedHash) ? null : "reviewedHash must be the hash the timeline carried",
        args.decision === "add" || args.decision === "dismiss" ? null : "decision must be add or dismiss");
    case "projectAllowed":
      return first(keys("projectId"), id(args, "projectId"));
    case "automationRun":
      return first(keys("automationId"), id(args, "automationId"));
    case "chatMembers":
      return first(keys("chatId"), id(args, "chatId"));
    case "chat.start":
      return keys();
    case "profile.character":
      return first(keys("expectedVersion", "characterId"),
        Number.isInteger(args.expectedVersion) && Number(args.expectedVersion) >= 1 && Number(args.expectedVersion) <= Number.MAX_SAFE_INTEGER ? null : "expectedVersion must be the profile version the phone read",
        typeof args.characterId === "string" && CHARACTER_RE.test(args.characterId) ? null : "characterId must be a preset character id");
    case "knowledge.forget":
      return first(keys("memoryId", "expectedRevision"), id(args, "memoryId"),
        typeof args.expectedRevision === "string" && args.expectedRevision.length >= 1 && args.expectedRevision.length <= 200 && !/[\u0000-\u001f]/.test(args.expectedRevision) ? null : "expectedRevision must be the revision the list carried");
    default:
      return `${operation} is not a workspace v2 operation`;
  }
}

/** Machine codes of an answer that is not `ok`. The phone words them; the Desktop never sends a sentence. */
export type MobileWorkspaceV2Refusal =
  | "account_mismatch" | "sign_in_required"
  | "agent_not_found" | "skill_not_found" | "folder_unavailable" | "workspace_busy"
  | "proposal_not_found" | "proposal_changed" | "proposal_stale" | "already_dismissed" | "already_added"
  | "needs_computer_review" | "recovery_required" | "run_active_deferred"
  | "line_not_found" | "line_changed" | "line_not_personal"
  // XS-1: a conversation / automation / project that is not here, the personal agent's home is not this computer, its profile moved on, a character that is not a preset.
  | "chat_not_found" | "automation_not_found" | "project_not_found" | "one_sealed" | "one_away" | "stale_version" | "character_unknown"
  | "unavailable";

export interface MobileWorkspaceV2Row {
  id: string;
  /** solo = a one-to-one with an agent, group = a room, work = a Work session. */
  kind: "solo" | "group" | "work";
  /** A Work row: its title. A group: the room's title. A solo chat: the chat's title, which may be empty (the phone draws `agentNames[0]`). */
  title: string;
  taskId: string | null;
  agentNames: string[];
  /** The same names for an English UI, same length and order. Only when at least one differs from `agentNames` (an older phone ignores it). */
  agentNamesEn?: string[];
  /**
   * The picture the Desktop draws for each of `agentNames` (shared/agent-face.ts), same length and order; `null` for an agent this computer does not know.
   * Only on agent chats, and only when at least one is known (an older phone ignores it and draws the initial).
   */
  agentFaces?: Array<AgentFace | null>;
  memberCount: number;
  updatedAt: string;
  /** The room runs under the lead model (its own mark, never read from a title). */
  lead?: true;
  /** Pending approvals and questions of this conversation. Absent when none. */
  attention?: number;
}
export interface MobileWorkspaceV2Group {
  id: string | null;
  name: string | null;
  agentChats: number;
  workSessions: number;
  /** Sum of `attention` over the conversations of this group. */
  attention: number;
  /** True when `rows` is absent: ask `projectRows`. */
  collapsed: boolean;
  rows?: { chats: MobileWorkspaceV2Row[]; work: MobileWorkspaceV2Row[]; chatsMore: boolean; workMore: boolean };
}
export interface MobileWorkspaceV2Tree {
  schemaVersion: typeof MOBILE_WORKSPACE_V2_SCHEMA;
  hostId: string;
  revision: string;
  projects: MobileWorkspaceV2Group[];
  projectsOmitted: number;
  noProject: MobileWorkspaceV2Group;
  /** The Desktop's tree has a row limit: true when older conversations are not counted. */
  truncated: boolean;
}
export interface MobileWorkspaceV2Unchanged { schemaVersion: typeof MOBILE_WORKSPACE_V2_SCHEMA; unchanged: true; revision: string }
