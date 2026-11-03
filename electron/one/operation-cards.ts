/*
 * Host-owned chat cards for what One just did (docs/PROMPT-COMPOSITION-POLICY.md: host code decides, no prompt line asks).
 *
 * Observed in use: the harness has a UI-instance bridge (harness/ui-instances.ts) that draws interactive cards inside the
 * answer bubble, but only a model call to ui.present created one, and in the owner's whole history the model made none (0 of 2091
 * app.call receipts were followed by a ui.* receipt). A teammate list, a steer, an automation run or a settings change therefore
 * reached the owner as prose only. This module reads the finished tool event Main already sees and presents the card itself.
 *
 * It is a pure mapping plus one presenter. Cards carry the host's own wording and a few bounded fields from the tool's result;
 * a button only prepares a draft in the owner's composer (the IntellectUI followup action), it never acts. Anything the owner
 * did not ask to see (credentials, session handles, long outputs) is not copied: a settings change shows the operation and its
 * outcome, never its result body.
 */
import type { InlineUiPresentationContent } from "../../shared/inline-ui-presentation";
import type { IntellectUiNode } from "../../shared/intellect-ui";
import { classifyAppControlPolicy } from "../app-control/policy";

export type OperationCardLocale = "ko" | "en";
export type OperationCardKind =
  | "team.list" | "team.steer" | "team.stop" | "team.start" | "graph.run" | "graph.result" | "graph.save" | "graph.set_enabled" | "app.change";

export interface OperationCard {
  kind: OperationCardKind;
  title: string;
  state: "ready" | "failed" | "running";
  reason: "result" | "decision";
  fallbackText: string;
  content: Extract<InlineUiPresentationContent, { kind: "native" }>;
}

export interface OperationToolEvent {
  /** The tool name the runtime reported: `one-team.one_team_list`, `mcp__one-team__one_team_list`, `agentlas-turn.harness_call`. */
  name: string;
  args?: string;
  result?: string;
  isError?: boolean;
}

/** harness_call operation -> the One Team tool that backs it (canonical-registry.ts). */
const HARNESS_OPERATION_TOOL: Readonly<Record<string, string>> = {
  "team.list": "one_team_list", "team.steer": "one_team_steer", "team.stop": "one_team_stop", "team.start": "one_team_start_session",
  "graph.run": "one_graph_run", "graph.result": "one_graph_result", "graph.build": "one_graph_save",
  "graph.set_enabled": "one_graph_set_enabled", "settings.propose": "one_app_call", "app.call": "one_app_call",
};
const TOOL_KIND: Readonly<Record<string, OperationCardKind>> = {
  one_team_list: "team.list", one_team_steer: "team.steer", one_team_stop: "team.stop", one_team_start_session: "team.start",
  one_graph_run: "graph.run", one_graph_result: "graph.result", one_graph_save: "graph.save",
  one_graph_set_enabled: "graph.set_enabled", one_app_call: "app.change",
};

const NOW_KO: Record<string, string> = { idle: "대기", working: "작업 중", waiting_for_owner: "답변 대기", locked: "잠김" };
const NOW_EN: Record<string, string> = { idle: "Idle", working: "Working", waiting_for_owner: "Waiting for you", locked: "Locked" };
const clip = (value: unknown, limit: number): string => {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1))}…` : flat;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: string, tone?: "muted" | "success" | "warning"): IntellectUiNode => ({ type: "text", text: value, ...(tone ? { tone } : {}) });
const followup = (label: string, prompt: string, includeInputs?: string[]): IntellectUiNode => ({
  type: "button", label: clip(label, 60), action: { type: "followup", prompt: clip(prompt, 1_000), ...(includeInputs ? { includeInputs } : {}) },
});

/** The tool this event is, whichever runtime named it and whether it was called directly or through harness_call. */
export function operationToolOf(event: OperationToolEvent): { tool: string; args: Record<string, unknown> } | null {
  const short = event.name.split(/__|[./:]/u).filter(Boolean).pop() ?? "";
  let args: Record<string, unknown> = {};
  try { args = record(JSON.parse(event.args ?? "{}")) ?? {}; } catch { /* Arguments are optional context. */ }
  if (short in TOOL_KIND) return { tool: short, args };
  if (short === "harness_call") {
    const operation = typeof args.operation === "string" ? args.operation : "";
    const tool = HARNESS_OPERATION_TOOL[operation];
    if (!tool) return null;
    const inner = record(args.args) ?? {};
    // app.call carries the operation it runs one level down.
    return { tool, args: tool === "one_app_call" ? { ...inner, operation: typeof inner.operation === "string" ? inner.operation : "" } : inner };
  }
  return null;
}

/** The tool's own answer: an MCP content wrapper, a harness envelope, or the bare object. */
export function unwrapOperationResult(raw: string | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { message: raw }; }
  for (let depth = 0; depth < 3; depth += 1) {
    const object = record(value);
    if (!object) return value;
    if (Array.isArray(object.content)) {
      const part = object.content.map(record).find((item) => item && item.type === "text" && typeof item.text === "string");
      if (!part) return null;
      try { value = JSON.parse(part.text as string); } catch { return { message: part.text }; }
      continue;
    }
    if (object.schemaVersion === "agentlas.harness-result.v1") {
      if (object.status && object.status !== "ok") return { ok: false, code: object.reason ?? object.status, message: object.next };
      value = object.data;
      continue;
    }
    return object;
  }
  return value;
}

function failureOf(body: Record<string, unknown> | null, isError: boolean | undefined): string | null {
  if (isError === true) return clip(body?.message ?? body?.error ?? body?.code, 240) || "failed";
  if (!body) return null;
  if (body.ok === false) return clip(body.message ?? body.error ?? body.code, 240) || "failed";
  if (typeof body.error === "string" && body.error) return clip(body.error, 240);
  return null;
}

const LABEL: Record<OperationCardKind, { ko: string; en: string }> = {
  "team.list": { ko: "팀원 목록", en: "Teammates" },
  "team.steer": { ko: "팀원에게 방향 전달", en: "Direction sent to a teammate" },
  "team.stop": { ko: "팀원의 일 중지", en: "Teammate job stopped" },
  "team.start": { ko: "팀원에게 일 맡기기", en: "Handing work to a teammate" },
  "graph.run": { ko: "자동화 실행", en: "Automation run" },
  "graph.result": { ko: "자동화 결과", en: "Automation result" },
  "graph.save": { ko: "자동화 저장", en: "Automation saved" },
  "graph.set_enabled": { ko: "자동화 켜기·끄기", en: "Automation switch" },
  "app.change": { ko: "앱 설정 변경", en: "App change" },
};

const SCALAR_ROWS: ReadonlyArray<{ key: string; ko: string; en: string }> = [
  { key: "name", ko: "이름", en: "Name" }, { key: "status", ko: "상태", en: "Status" },
  { key: "event_status", ko: "실행 상태", en: "Run status" }, { key: "enabled", ko: "켜짐", en: "Enabled" },
  { key: "revision", ko: "리비전", en: "Revision" }, { key: "already_requested", ko: "이미 요청됨", en: "Already requested" },
];

function rowsOf(body: Record<string, unknown>, ko: boolean): Array<Array<string>> {
  const rows: Array<Array<string>> = [];
  for (const { key, ko: koLabel, en } of SCALAR_ROWS) {
    const value = body[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") rows.push([ko ? koLabel : en, clip(value, 80)]);
  }
  return rows;
}

function card(kind: OperationCardKind, ko: boolean, title: string, children: IntellectUiNode[], state: OperationCard["state"], reason: OperationCard["reason"]): OperationCard {
  const head = clip(title, 120);
  return {
    kind, title: head, state, reason, fallbackText: head,
    // The card header already shows the title (presentation.title); a second one inside the document read as a duplicate.
    content: { kind: "native", document: { version: 1, children } as never },
  };
}

/** The effect the app-control policy declares for an operation, whether or not the model may call it. */
function declaredOperationEffect(operation: string): string | undefined {
  const classified = classifyAppControlPolicy({ path: operation });
  return classified.policy.allowed ? classified.policy.effect : classified.effect;
}

/** The card for a finished tool event, or null when this event is not one the owner should see as a card. */
export function operationCardFor(event: OperationToolEvent, locale: OperationCardLocale): OperationCard | null {
  if (event.result === undefined) return null;
  const tool = operationToolOf(event);
  if (!tool) return null;
  const kind = TOOL_KIND[tool.tool];
  const ko = locale === "ko";
  const body = record(unwrapOperationResult(event.result));
  const label = LABEL[kind][ko ? "ko" : "en"];
  const failure = failureOf(body, event.isError);
  const operation = clip(tool.args.operation, 80);

  // A change the owner asked for shows its outcome. Reads are not changes and never draw a card, failed or not: a lookup the
  // model made for itself is the model's to retry or route around, not a decision handed to the owner. observed in use:
  // a failed `workLiveView.listTabs` lookup reached the owner's phone as "Could not apply it: operation-failed: …" with a retry
  // button, although the model went on to repeat the lookup itself.
  if (kind === "app.change") {
    if (!failure && (body?.effect === "read" || body?.effect === undefined)) return null;
    if (!operation) return null;
    if (body?.effect === "read" || declaredOperationEffect(operation) === "read") return null;
    const done = !failure;
    return card(kind, ko, done ? (ko ? `${operation} 완료` : `${operation} done`) : (ko ? `${operation} 실패` : `${operation} failed`), [
      text(done ? (ko ? "앱에서 바로 적용했어요." : "Applied in the app.") : (ko ? `적용하지 못했어요: ${failure}` : `Could not apply it: ${failure}`), done ? "success" : "warning"),
      ...(done ? [] : [followup(ko ? "원인 확인하고 다시" : "Check why and retry", ko ? `방금 실패한 ${operation} 작업의 원인을 확인하고 다시 시도해줘.` : `Check why ${operation} just failed and try it again.`)]),
    ], done ? "ready" : "failed", done ? "result" : "decision");
  }

  if (failure) {
    return card(kind, ko, ko ? `${label} 실패` : `${label} failed`, [
      text(ko ? `적용하지 못했어요: ${failure}` : `It did not go through: ${failure}`, "warning"),
      followup(ko ? "원인 확인하고 다시" : "Check why and retry", ko ? `방금 실패한 ${label} 작업의 원인을 확인하고 다시 시도해줘.` : `Check why "${label}" just failed and try it again.`),
    ], "failed", "decision");
  }
  if (!body) return null;

  if (kind === "team.list") {
    const teammates = (Array.isArray(body.teammates) ? body.teammates : []).map(record).filter((item): item is Record<string, unknown> => Boolean(item && item.name));
    if (!teammates.length) return null;
    const nowLabel = ko ? NOW_KO : NOW_EN;
    const shown = teammates.slice(0, 12);
    const startable = shown.filter((item) => item.can_start !== false).slice(0, 4);
    return card(kind, ko, ko ? `팀원 ${teammates.length}명` : `${teammates.length} teammates`, [
      { type: "table", columns: [ko ? "이름" : "Name", ko ? "지금" : "Now"], rows: shown.map((item) => [clip(item.name, 60), nowLabel[String(item.now)] ?? clip(item.now, 20)]) },
      ...startable.map((item) => followup(ko ? `${clip(item.name, 30)}에게 맡기기` : `Hand to ${clip(item.name, 30)}`,
        ko ? `${clip(item.name, 60)}에게 맡길 일: ` : `Work for ${clip(item.name, 60)}: `)),
    ], "ready", "result");
  }

  if (kind === "team.steer") {
    const teammate = clip(body.teammate, 60);
    return card(kind, ko, ko ? `${teammate || "팀원"}에게 방향을 전달했어요` : `Direction sent to ${teammate || "the teammate"}`, [
      text(ko ? "작업 중이면 현재 단계가 끝난 뒤에, 끝난 작업이면 다시 열어서 이어가요." : "A running session takes it after its current step; a finished one reopens."),
      followup(ko ? "진행 상황 보기" : "Check progress", ko ? `${teammate || "팀원"} 작업 진행 상황 알려줘.` : `How is ${teammate || "the teammate"}'s work going?`),
    ], "ready", "result");
  }

  if (kind === "team.stop") {
    // A stop the app did not take because the turn was not written by the owner changed nothing: no card says "stopped" or "already ended".
    if (body.owner_turn_required === true) return null;
    const teammate = clip(body.teammate, 60);
    // A stop that took effect says so; one that was saved for the service, or found the job already over, says that instead. Never a failure.
    const stopped = body.stopped === true;
    return card(kind, ko, stopped ? (ko ? `${teammate || "팀원"}의 일을 중지했어요` : `Stopped ${teammate || "the teammate"}'s job`)
        : body.stop_saved === true ? (ko ? `${teammate || "팀원"}의 일을 멈추도록 저장했어요` : `Stop saved for ${teammate || "the teammate"}'s job`)
        : (ko ? `${teammate || "팀원"}의 일은 이미 끝나 있어요` : `${teammate || "The teammate"}'s job had already ended`), [
      text(stopped ? (ko ? "이 일은 더 이어지지 않고, 결과도 따로 보고하지 않아요." : "It does not continue and nothing is reported for it.")
        : body.stop_saved === true ? (ko ? "서비스가 응답하면 바로 멈춰요." : "It stops as soon as the service answers.")
        : (ko ? "멈출 일이 없었어요." : "There was nothing left to stop."), stopped ? "success" : "muted"),
    ], stopped || body.already_ended === true ? "ready" : "running", "result");
  }

  if (kind === "team.start") {
    // A started session already has its own live card (the dispatch notice with Open session). Only a queued job has none.
    if (body.queued !== true) return null;
    const teammate = clip(body.teammate, 60);
    const position = typeof body.queue_position === "number" ? body.queue_position : null;
    return card(kind, ko, ko ? `${teammate || "팀원"}의 줄에 세웠어요` : `Queued behind ${teammate || "the teammate"}'s current job`, [
      text(ko ? `지금 다른 일을 하고 있어요${position ? ` · 대기 ${position}번째` : ""}. 앞 일이 끝나면 자동으로 시작해요.` : `Busy with another job${position ? ` · position ${position}` : ""}. It starts when that one ends.`),
      ...(clip(body.brief, 240) ? [text(clip(body.brief, 240), "muted")] : []),
      followup(ko ? "진행 상황 보기" : "Check progress", ko ? `${teammate || "팀원"} 작업 진행 상황 알려줘.` : `How is ${teammate || "the teammate"}'s work going?`),
      // A queued job has no hand-off card of its own (that card is drawn when the job starts); this is where the owner can withdraw it.
      followup(ko ? "줄에 선 일 취소하기" : "Cancel this queued job", ko ? `${teammate || "팀원"}에게 줄 세운 일은 시작하지 말고 취소해줘.` : `Cancel the job queued for ${teammate || "the teammate"}; do not start it.`),
    ], "running", "result");
  }

  const rows = rowsOf(body, ko);
  if (!rows.length) return null;
  const children: IntellectUiNode[] = [{ type: "table", columns: [ko ? "항목" : "Item", ko ? "값" : "Value"], rows }];
  if (kind === "graph.run") children.push(followup(ko ? "결과 확인" : "Check the result", ko ? "방금 실행한 자동화 결과 알려줘." : "What did the automation I just ran produce?"));
  if (kind === "graph.save") children.push(followup(ko ? "지금 실행해보기" : "Run it now", ko ? "방금 저장한 자동화를 지금 한 번 실행해줘." : "Run the automation I just saved once now."));
  return card(kind, ko, label, children, "ready", "result");
}

export interface OperationCardContext { chatId: string; runId: string }

/** Presents the card for a finished tool event in the run's own chat. Never throws; a missed card never breaks the run. */
export async function presentOperationCard(context: OperationCardContext, event: OperationToolEvent, locale: OperationCardLocale): Promise<boolean> {
  try {
    const built = operationCardFor(event, locale);
    if (!built) return false;
    const { uiPresent } = await import("../harness/ui-instances");
    const outcome = await uiPresent({
      content: built.content, title: built.title, fallbackText: built.fallbackText, state: built.state, reason: built.reason,
    }, { chatId: context.chatId, runId: context.runId });
    return outcome.status === "ok";
  } catch {
    return false;
  }
}
