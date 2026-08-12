import { listProjects, getProject } from "../store/projects";
import { getAutomation } from "../store/automations";
import { listGraphsForSurface, submitGraphRunRequest } from "../graph-surface/submit";
import { hepNetwork, hepSearch, networkStatus } from "../hephaestus/commands";
import {
  INLINE_SELECT_PAGE_SIZE,
  clearInlineSelect,
  openInlineSelect,
  readInlineSelectCallback,
  renderInlineSelect,
  type InlineKeyboardMarkup,
  type InlineSelectKind,
  type InlineSelectOption,
} from "./inline-select";
import {
  TELEGRAM_COMMANDS,
  commandAppliesTo,
  findTelegramCommand,
  type TelegramCommandEntry,
} from "./commands-catalog";
// 런타임 의존이 아니라 타입만 빌려 온다 — connect.ts 가 이 모듈을 부르므로
// 값 import 를 하면 순환이 된다.
import type { TelegramBindingRow, TelegramCopyKey, TelegramMessage } from "./connect";

export interface TelegramDispatchDeps {
  /** 이 방으로 보낸다. markup 이 있으면 인라인 버튼이 붙는다. */
  send: (text: string, markup?: InlineKeyboardMarkup) => Promise<void>;
  t: (key: TelegramCopyKey, vars?: Record<string, string | number>) => string;
  /** 이 바인딩의 One 대화 id. 없으면 만들어 준다. */
  ensureChatId: (binding: TelegramBindingRow) => Promise<string>;
  /** 대화 초기화(/new). chat_session_id 를 비운다. */
  resetConversation: (bindingId: string) => Promise<void>;
  /** 진행 중 실행 취소(/stop). 취소할 게 없으면 false. */
  cancelActiveRun: (bindingId: string) => boolean;
  isRunning: (bindingId: string) => boolean;
  setDesignatedProject: (bindingId: string, projectId: string | null) => void;
  setDesignatedGraph: (bindingId: string, graphId: string | null) => void;
  setChatProjectFolder: (chatId: string, folderPath: string | null) => void;
  /** 이 대화가 이미 다른 프로젝트에 묶여 있으면 그 프로젝트 id. */
  chatProjectId: (chatId: string) => string | null;
  setAutomationReport: (bindingId: string, enabled: boolean) => void;
  targetName: (binding: TelegramBindingRow) => string;
}

export type TelegramDispatchOutcome =
  | { kind: "handled" }
  /** 명령이 그대로 실행 요청인 경우(/write). connect.ts 의 실행 경로가 이어받는다. */
  | { kind: "run"; text: string; write: true };

export interface ParsedTelegramCommand {
  entry: TelegramCommandEntry;
  /** 명령 뒤에 남은 인자 문자열. 없으면 "". */
  rest: string;
  /** 사용자가 실제로 친 토큰(별칭일 수 있다). 안내문에 그대로 쓴다. */
  typed: string;
}

export type TelegramCommandParse =
  | { kind: "none" }
  | { kind: "unknown"; typed: string }
  | ({ kind: "known" } & ParsedTelegramCommand);

const COMMAND_RE = /^\/([A-Za-z0-9_-]{1,64})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/;

/**
 * 선행 슬래시 메시지를 명령으로 읽는다.
 *
 * 모르는 명령을 LLM 작업 요청으로 흘려보내지 않는 게 핵심이다 — 오타 하나가
 * 실행으로 이어지면 명령표를 두는 의미가 없다. 그룹방 접미사(`/graphs@bot`)와
 * 하이픈 별칭(`/hep-network`)은 여기서 흡수한다.
 */
export function parseTelegramCommand(
  binding: TelegramBindingRow,
  message: TelegramMessage,
  text: string,
  botUsername: string | null,
): TelegramCommandParse {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "none" };
  const match = COMMAND_RE.exec(trimmed);
  if (!match) return { kind: "none" };
  const [, typed, mention, rest] = match;
  // 그룹방에서 다른 봇을 부른 명령은 우리 것이 아니다.
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) {
    return { kind: "none" };
  }
  const entry = findTelegramCommand(typed);
  if (!entry) return { kind: "unknown", typed };
  return { kind: "known", entry, rest: (rest ?? "").trim(), typed };
}

function listLabels(deps: TelegramDispatchDeps) {
  return {
    prev: deps.t("cmd.list.prev"),
    next: deps.t("cmd.list.next"),
    close: deps.t("cmd.list.close"),
  };
}

function helpText(binding: TelegramBindingRow, deps: TelegramDispatchDeps, locale: "ko" | "en"): string {
  const lines: string[] = [deps.t("cmd.help_header"), ""];
  for (const entry of TELEGRAM_COMMANDS) {
    if (!entry.registered || !commandAppliesTo(entry, binding.target_kind)) continue;
    const args = locale === "ko" ? entry.argsKo ?? entry.args : entry.args;
    const head = args ? `/${entry.name} ${args}` : `/${entry.name}`;
    lines.push(`${head} — ${locale === "ko" ? entry.ko : entry.en}`);
  }
  lines.push("", deps.t("cmd.help_footer"));
  return lines.join("\n");
}

function statusText(binding: TelegramBindingRow, deps: TelegramDispatchDeps): string {
  const lines: string[] = [deps.t("cmd.status.connected_to", { name: deps.targetName(binding) })];
  if (binding.bot_username) lines.push(deps.t("cmd.status.bot", { username: binding.bot_username }));
  if (binding.telegram_chat_title) lines.push(deps.t("cmd.status.chat", { title: binding.telegram_chat_title }));
  if (binding.target_kind === "one") {
    const project = binding.designated_project_id ? getProject(binding.designated_project_id) : null;
    lines.push(
      project
        ? deps.t("cmd.status.project", { name: project.name, folder: project.folderPath ?? "-" })
        : deps.t("cmd.status.project_none"),
    );
    if (!binding.designated_graph_id) {
      lines.push(deps.t("cmd.status.graph_none"));
    } else {
      const graph = getAutomation(binding.designated_graph_id);
      if (!graph) {
        // 삭제된 자동화를 "지정 없음"으로 뭉개면 사용자가 왜 안 도는지 알 길이 없다.
        lines.push(deps.t("cmd.status.graph_missing", { id: binding.designated_graph_id }));
      } else {
        lines.push(
          graph.enabled
            ? deps.t("cmd.status.graph", { name: graph.name })
            : deps.t("cmd.status.graph_disabled", { name: graph.name }),
        );
      }
    }
  }
  lines.push(
    binding.automation_report_enabled === 1
      ? deps.t("cmd.status.reports_on")
      : deps.t("cmd.status.reports_off"),
  );
  lines.push(deps.isRunning(binding.id) ? deps.t("cmd.status.running") : deps.t("cmd.status.idle"));
  return lines.join("\n");
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

async function designateProject(
  binding: TelegramBindingRow,
  deps: TelegramDispatchDeps,
  projectId: string,
): Promise<void> {
  const project = getProject(projectId);
  if (!project) {
    await deps.send(deps.t("cmd.project.not_found", { query: projectId }));
    return;
  }
  if (!project.folderPath) {
    // 폴더 없는 프로젝트를 조용히 건너뛰면 "지정했다는데 아무 데서나 도는" 상태가 된다.
    await deps.send(deps.t("cmd.project.no_folder", { name: project.name }));
    return;
  }
  const chatId = await deps.ensureChatId(binding);
  const boundProjectId = deps.chatProjectId(chatId);
  if (boundProjectId && boundProjectId !== project.id) {
    await deps.send(deps.t("cmd.project.locked"));
    return;
  }
  deps.setChatProjectFolder(chatId, project.folderPath);
  deps.setDesignatedProject(binding.id, project.id);
  binding.designated_project_id = project.id;
  await deps.send(deps.t("cmd.project.set", { name: project.name, folder: project.folderPath }));
}

async function designateGraph(
  binding: TelegramBindingRow,
  deps: TelegramDispatchDeps,
  graphId: string,
): Promise<void> {
  const graph = getAutomation(graphId);
  if (!graph) {
    await deps.send(deps.t("cmd.status.graph_missing", { id: graphId }));
    return;
  }
  deps.setDesignatedGraph(binding.id, graph.id);
  binding.designated_graph_id = graph.id;
  await deps.send(deps.t("cmd.graph.set", { name: graph.name }));
}

async function requestGraphRun(
  binding: TelegramBindingRow,
  deps: TelegramDispatchDeps,
  ref: string,
): Promise<void> {
  const result = submitGraphRunRequest({ ref, source: "telegram" });
  if (!result.ok) {
    // 문 자신이 낸 code/reason/nextAction 을 다시 쓰지 않고 그대로 전달한다.
    await deps.send(
      deps.t("cmd.graph_run.rejected", {
        code: result.code,
        reason: result.reason,
        nextAction: result.nextAction,
      }),
    );
    return;
  }
  // 접수했을 뿐 실행한 게 아니다. 문구를 절대 "실행했습니다"로 바꾸지 말 것.
  await deps.send(deps.t("cmd.graph_run.requested", { name: result.automationName }));
}

function graphOptions(): InlineSelectOption[] {
  return listGraphsForSurface().map((graph) => ({
    id: graph.id,
    // 꺼진 자동화도 목록에 남기되 꺼졌다고 말한다(감추면 "없는 자동화"로 오해된다).
    label: graph.enabled ? graph.name : `${graph.name} (off)`,
  }));
}

async function openList(
  binding: TelegramBindingRow,
  deps: TelegramDispatchDeps,
  input: { kind: InlineSelectKind; command: string; options: InlineSelectOption[]; prompt: string; empty: string },
): Promise<void> {
  if (!input.options.length) {
    await deps.send(input.empty);
    return;
  }
  const render = openInlineSelect(binding.id, {
    kind: input.kind,
    command: input.command,
    options: input.options,
    labels: listLabels(deps),
  });
  const header = render.totalPages > 1
    ? `${input.prompt}\n${deps.t("cmd.list.page", { current: render.currentPage, total: render.totalPages })}`
    : input.prompt;
  await deps.send(header, render.markup);
}

function hepOutput(result: { ok: boolean; stdout: string; stderr: string; error?: string }, deps: TelegramDispatchDeps): string {
  if (!result.ok) {
    return deps.t("cmd.hep.failed", { message: (result.error || result.stderr || "").trim().slice(0, 900) });
  }
  const text = result.stdout.trim();
  return text ? text.slice(0, 3500) : deps.t("cmd.hep.no_result");
}

/** 명령 실행. 반환값이 "run" 이면 connect.ts 가 그 텍스트로 실제 턴을 돌린다. */
export async function dispatchTelegramCommand(
  parsed: ParsedTelegramCommand,
  binding: TelegramBindingRow,
  deps: TelegramDispatchDeps,
  locale: "ko" | "en",
): Promise<TelegramDispatchOutcome> {
  const { entry, rest } = parsed;
  if (!commandAppliesTo(entry, binding.target_kind)) {
    await deps.send(deps.t("cmd.one_only"));
    return { kind: "handled" };
  }
  switch (entry.handler) {
    case "pairing":
      // 페어링은 상위에서 이미 끝났다. 여기까지 왔다면 이미 연결된 방에서 다시 누른
      // 것이므로, 침묵 대신 무엇을 할 수 있는지 보여 준다(텔레그램 Start 버튼 경로).
      await deps.send(helpText(binding, deps, locale));
      return { kind: "handled" };
    case "help":
      await deps.send(helpText(binding, deps, locale));
      return { kind: "handled" };
    case "status":
      await deps.send(statusText(binding, deps));
      return { kind: "handled" };
    case "newChat":
      clearInlineSelect(binding.id);
      await deps.resetConversation(binding.id);
      await deps.send(deps.t("cmd.new.done"));
      return { kind: "handled" };
    case "stopRun":
      await deps.send(deps.cancelActiveRun(binding.id) ? deps.t("cmd.stop.done") : deps.t("cmd.stop.nothing"));
      return { kind: "handled" };
    case "writeTurn": {
      if (!rest) {
        await deps.send(deps.t("cmd.write.needs_text"));
        return { kind: "handled" };
      }
      return { kind: "run", text: rest, write: true };
    }
    case "projects": {
      await openList(binding, deps, {
        kind: "project",
        command: "projects",
        options: listProjects().map((project) => ({ id: project.id, label: project.name })),
        prompt: deps.t("cmd.projects.pick"),
        empty: deps.t("cmd.projects.empty"),
      });
      return { kind: "handled" };
    }
    case "projectSet": {
      if (!rest) {
        await openList(binding, deps, {
          kind: "project",
          command: "projects",
          options: listProjects().map((project) => ({ id: project.id, label: project.name })),
          prompt: deps.t("cmd.projects.pick"),
          empty: deps.t("cmd.projects.empty"),
        });
        return { kind: "handled" };
      }
      if (normalize(rest) === "off") {
        deps.setDesignatedProject(binding.id, null);
        binding.designated_project_id = null;
        const chatId = await deps.ensureChatId(binding);
        deps.setChatProjectFolder(chatId, null);
        await deps.send(deps.t("cmd.project.cleared"));
        return { kind: "handled" };
      }
      const projects = listProjects();
      const exact = projects.find(
        (project) => project.id === rest || normalize(project.name) === normalize(rest),
      );
      if (!exact) {
        await deps.send(deps.t("cmd.project.not_found", { query: rest }));
        return { kind: "handled" };
      }
      await designateProject(binding, deps, exact.id);
      return { kind: "handled" };
    }
    case "projectSearch": {
      if (!rest) {
        // 빈 검색어로 "그 이름을 못 찾았습니다"라고 답하면 콜론 뒤가 비어 말이 안 되고,
        // 사용자는 자기가 무엇을 빠뜨렸는지 모른다(실사용 실측).
        await deps.send(deps.t("cmd.search.needs_query", { command: "project_search" }));
        return { kind: "handled" };
      }
      const needle = normalize(rest);
      const matches = listProjects().filter((project) => normalize(project.name).includes(needle));
      if (matches.length === 1) {
        await designateProject(binding, deps, matches[0].id);
        return { kind: "handled" };
      }
      await openList(binding, deps, {
        kind: "project",
        command: "projects",
        options: matches.map((project) => ({ id: project.id, label: project.name })),
        prompt: deps.t("cmd.projects.pick"),
        empty: deps.t("cmd.project.not_found", { query: rest }),
      });
      return { kind: "handled" };
    }
    case "graphs": {
      await openList(binding, deps, {
        kind: "graph",
        command: "graphs",
        options: graphOptions(),
        prompt: deps.t("cmd.graphs.pick"),
        empty: deps.t("cmd.graphs.empty"),
      });
      return { kind: "handled" };
    }
    case "graphSet": {
      if (!rest) {
        await openList(binding, deps, {
          kind: "graph",
          command: "graphs",
          options: graphOptions(),
          prompt: deps.t("cmd.graphs.pick"),
          empty: deps.t("cmd.graphs.empty"),
        });
        return { kind: "handled" };
      }
      if (normalize(rest) === "off") {
        deps.setDesignatedGraph(binding.id, null);
        binding.designated_graph_id = null;
        await deps.send(deps.t("cmd.graph.cleared"));
        return { kind: "handled" };
      }
      const graphs = listGraphsForSurface();
      const exact = graphs.find((graph) => graph.id === rest || graph.name.trim() === rest.trim());
      if (!exact) {
        await deps.send(deps.t("cmd.project.not_found", { query: rest }));
        return { kind: "handled" };
      }
      await designateGraph(binding, deps, exact.id);
      return { kind: "handled" };
    }
    case "graphSearch": {
      if (!rest) {
        // 검색어가 없는데 "저장된 자동화가 없습니다"라고 답하면 사실과 다르다 — 없는 게
        // 아니라 안 물어본 것이다(실사용 실측).
        await deps.send(deps.t("cmd.search.needs_query", { command: "graph_search" }));
        return { kind: "handled" };
      }
      const needle = normalize(rest);
      const matches = needle
        ? graphOptions().filter((option) => normalize(option.label).includes(needle))
        : [];
      if (matches.length === 1) {
        await designateGraph(binding, deps, matches[0].id);
        return { kind: "handled" };
      }
      await openList(binding, deps, {
        kind: "graph",
        command: "graphs",
        options: matches,
        prompt: deps.t("cmd.graphs.pick"),
        empty: deps.t("cmd.graphs.empty"),
      });
      return { kind: "handled" };
    }
    case "graphRunRequest": {
      const ref = rest || binding.designated_graph_id || "";
      if (!ref) {
        await deps.send(deps.t("cmd.graph.none_designated"));
        return { kind: "handled" };
      }
      await requestGraphRun(binding, deps, ref);
      return { kind: "handled" };
    }
    case "hepSearch": {
      if (!rest) {
        await deps.send(deps.t("cmd.hep.needs_text"));
        return { kind: "handled" };
      }
      await deps.send(deps.t("cmd.hep.searching"));
      const result = await hepSearch(rest, { limit: 5 }).catch((error: unknown) => ({
        ok: false,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      }));
      await deps.send(hepOutput(result, deps));
      return { kind: "handled" };
    }
    case "hepNetwork": {
      if (!rest) {
        await deps.send(deps.t("cmd.hep.needs_text"));
        return { kind: "handled" };
      }
      await deps.send(deps.t("cmd.hep.staffing"));
      const result = await hepNetwork(rest, { noOpen: true }).catch((error: unknown) => ({
        ok: false,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      }));
      await deps.send(hepOutput(result, deps));
      return { kind: "handled" };
    }
    case "hepStatus": {
      const result = await networkStatus().catch((error: unknown) => ({
        ok: false,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      }));
      await deps.send(hepOutput(result, deps));
      return { kind: "handled" };
    }
    case "reportsOn":
      deps.setAutomationReport(binding.id, true);
      binding.automation_report_enabled = 1;
      await deps.send(deps.t("cmd.reports.on"));
      return { kind: "handled" };
    case "reportsOff":
      deps.setAutomationReport(binding.id, false);
      binding.automation_report_enabled = 0;
      await deps.send(deps.t("cmd.reports.off"));
      return { kind: "handled" };
  }
}

/** 인라인 버튼 콜백 처리. 만료는 반드시 말해 준다 — 조용한 무반응이 최악이다. */
export async function handleTelegramSelectCallback(
  binding: TelegramBindingRow,
  deps: TelegramDispatchDeps,
  data: string,
): Promise<void> {
  const event = readInlineSelectCallback(binding.id, data);
  if (event.kind === "expired") {
    await deps.send(deps.t("cmd.list.expired", { command: event.command ?? "help" }));
    return;
  }
  if (event.kind === "closed") {
    await deps.send(deps.t("cmd.list.closed"));
    return;
  }
  if (event.kind === "page") {
    const render = renderInlineSelect(binding.id, event.offset, listLabels(deps));
    if (!render) {
      await deps.send(deps.t("cmd.list.expired", { command: "help" }));
      return;
    }
    const header = deps.t("cmd.list.page", { current: render.currentPage, total: render.totalPages });
    await deps.send(header, render.markup);
    return;
  }
  if (event.select === "project") {
    await designateProject(binding, deps, event.option.id);
    return;
  }
  await designateGraph(binding, deps, event.option.id);
}

export { INLINE_SELECT_PAGE_SIZE };
