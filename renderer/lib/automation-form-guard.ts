// 새 자동화 폼의 보호 규칙(순수 함수 + sessionStorage 한 칸).
//  - 저장 단추가 꺼진 이유를 한 가지 기계 키로 말한다(화면은 그 키를 사람 말로 바꿔 단추 곁에 둔다).
//  - 쓰던 폼을 나가면 사라지던 입력을 같은 창이 살아 있는 동안 보관한다(DB에 쓰지 않는다 — 창을 닫으면 사라진다).
import type {
  AutomationHubMode,
  AutomationToolMode,
  ScheduleSpec,
  TriggerKind,
} from "@/lib/types";
import type { ScheduleProblem } from "@shared/schedule-form";

// ── 감시할 경로 ────────────────────────────────────────────────────────────

export type FsPathProblem = "blank" | "relative";

/**
 * 감시 경로의 형식. 감시기는 `~` 를 풀지 않고 상대 경로를 실행 폴더 기준으로 읽는다 —
 * "~/Downloads" 는 어디에도 없는 폴더를 말없이 지켜본다. 폴더·파일·아직 없는 경로는 모두 쓸 수 있다.
 */
export function fsPathProblem(raw: string): FsPathProblem | null {
  const path = String(raw ?? "").trim();
  if (!path) return "blank";
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) return null;
  return "relative";
}

// ── 저장 단추가 꺼진 이유 ──────────────────────────────────────────────────

export type SaveBlocker =
  | "target_none"
  | "name"
  | "fs_blank"
  | "fs_relative"
  | "chain"
  | "context"
  | "target"
  | `schedule:${ScheduleProblem}`;

export interface SaveBlockerInput {
  name: string;
  triggerType: TriggerKind;
  fsPath: string;
  chainAfter: string;
  /** 일정 빌더가 마지막으로 알린 저장 불가 사유(시간 트리거일 때만 본다). */
  scheduleProblem: ScheduleProblem | null | undefined;
  projectContextChoice: string;
  targetId: string;
  /** 고를 수 있는 회사·에이전트·Hub 가 하나라도 있는가. */
  hasAnyTarget: boolean;
  /** 목록을 못 읽었는가 — 못 읽은 것을 "고를 것이 없음"이라 말하지 않는다. */
  loadFailed: boolean;
}

/** 먼저 풀어야 하는 것 하나. null = 저장해도 된다. 읽는 순서는 위에서 아래다. */
export function saveBlocker(input: SaveBlockerInput): SaveBlocker | null {
  if (!input.hasAnyTarget && !input.loadFailed && !input.targetId) return "target_none";
  if (!input.name.trim()) return "name";
  if (input.triggerType === "fs") {
    const problem = fsPathProblem(input.fsPath);
    if (problem) return problem === "blank" ? "fs_blank" : "fs_relative";
  }
  if (input.triggerType === "chain" && !input.chainAfter) return "chain";
  if (input.triggerType === "schedule" && input.scheduleProblem) return `schedule:${input.scheduleProblem}`;
  if (!input.projectContextChoice) return "context";
  if (!input.targetId) return "target";
  return null;
}

// ── 쓰던 폼 보관 ───────────────────────────────────────────────────────────

const DRAFT_KEY = "agentlas.automation.new-draft.v1";
const DRAFT_VERSION = 1;

export interface NewAutomationDraft {
  version: typeof DRAFT_VERSION;
  name: string;
  prompt: string;
  triggerType: TriggerKind;
  fsPath: string;
  fsOn: "create" | "modify" | "delete";
  chainAfter: string;
  targetType: "agent" | "firm" | "hub";
  targetId: string;
  projectContextChoice: string;
  toolMode: AutomationToolMode;
  hubMode: AutomationHubMode;
  /** 일정 빌더가 마지막으로 알린 값(저장할 수 있는 것만). */
  schedule: { spec: ScheduleSpec; legacyToken: string } | null;
}

/** 아무것도 쓰지 않은 폼은 보관하지 않는다(빈 초안이 다음 진입을 가로막지 않게). */
export function isEmptyNewAutomationDraft(d: NewAutomationDraft): boolean {
  return !d.name.trim() && !d.prompt.trim() && !d.fsPath.trim() && !d.chainAfter && !d.targetId && !d.projectContextChoice;
}

const FS_ON = ["create", "modify", "delete"];
const TARGET_TYPES = ["agent", "firm", "hub"];
const TOOL_MODES = ["auto", "browser", "computer-use"];
const HUB_MODES = ["hub-allowed", "hub-first", "local-only"];

function readSchedule(value: unknown, now: number): NewAutomationDraft["schedule"] {
  if (!value || typeof value !== "object") return null;
  const { spec, legacyToken } = value as { spec?: unknown; legacyToken?: unknown };
  if (typeof legacyToken !== "string" || !spec || typeof spec !== "object") return null;
  const kind = (spec as { kind?: unknown }).kind;
  if (kind === "manual") return { spec: spec as ScheduleSpec, legacyToken };
  if (kind === "once") {
    const at = Date.parse(String((spec as { atIso?: unknown }).atIso ?? ""));
    // 보관 사이에 지나가 버린 한 번짜리 시각은 되살리지 않는다 — 안 도는 일정이 된다.
    return Number.isFinite(at) && at > now ? { spec: spec as ScheduleSpec, legacyToken } : null;
  }
  if (kind === "cron") {
    const { expr, tz } = spec as { expr?: unknown; tz?: unknown };
    return typeof expr === "string" && expr.trim() && typeof tz === "string" ? { spec: spec as ScheduleSpec, legacyToken } : null;
  }
  if (kind === "interval") {
    const { everyMs, anchor } = spec as { everyMs?: unknown; anchor?: unknown };
    return typeof everyMs === "number" && Number.isFinite(everyMs) && everyMs > 0 && (anchor === "wallclock" || anchor === "lastRun")
      ? { spec: spec as ScheduleSpec, legacyToken }
      : null;
  }
  return null;
}

/** 저장된 글을 초안으로. 모양이 맞지 않으면 null(엉뚱한 칸을 채우지 않는다). */
export function parseNewAutomationDraft(raw: string | null | undefined, now: number): NewAutomationDraft | null {
  if (!raw) return null;
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (key: string): string | null => (typeof value[key] === "string" ? (value[key] as string) : null);
  const name = str("name");
  const prompt = str("prompt");
  const fsPath = str("fsPath");
  const chainAfter = str("chainAfter");
  const targetId = str("targetId");
  const projectContextChoice = str("projectContextChoice");
  const triggerType = str("triggerType");
  const fsOn = str("fsOn");
  const targetType = str("targetType");
  const toolMode = str("toolMode");
  const hubMode = str("hubMode");
  if (
    value.version !== DRAFT_VERSION
    || name === null || prompt === null || fsPath === null || chainAfter === null || targetId === null || projectContextChoice === null
    || (triggerType !== "schedule" && triggerType !== "fs" && triggerType !== "chain")
    || !fsOn || !FS_ON.includes(fsOn)
    || !targetType || !TARGET_TYPES.includes(targetType)
    || !toolMode || !TOOL_MODES.includes(toolMode)
    || !hubMode || !HUB_MODES.includes(hubMode)
  ) return null;
  const draft: NewAutomationDraft = {
    version: DRAFT_VERSION,
    name,
    prompt,
    triggerType,
    fsPath,
    fsOn: fsOn as NewAutomationDraft["fsOn"],
    chainAfter,
    targetType: targetType as NewAutomationDraft["targetType"],
    targetId,
    projectContextChoice,
    toolMode: toolMode as AutomationToolMode,
    hubMode: hubMode as AutomationHubMode,
    schedule: readSchedule(value.schedule, now),
  };
  return isEmptyNewAutomationDraft(draft) ? null : draft;
}

function store(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readNewAutomationDraft(): NewAutomationDraft | null {
  try {
    return parseNewAutomationDraft(store()?.getItem(DRAFT_KEY), Date.now());
  } catch {
    return null;
  }
}

/** 비어 있으면 지운다. 저장소가 막혀 있어도 폼은 그대로 쓴다. */
export function writeNewAutomationDraft(draft: NewAutomationDraft): void {
  const area = store();
  if (!area) return;
  try {
    if (isEmptyNewAutomationDraft(draft)) area.removeItem(DRAFT_KEY);
    else area.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // 보관은 편의다 — 실패가 폼을 막지 않는다.
  }
}

export function clearNewAutomationDraft(): void {
  try {
    store()?.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}
