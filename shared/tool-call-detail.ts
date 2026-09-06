/**
 * ★도구 호출의 의미 정규화 — 러너 무관 단일 계약. 데스크탑·터미널 공용 1벌.
 *
 * 왜 필요한가(2026-08-08 대조 실측):
 * 우리 채팅은 도구 호출을 `{ tool: string, args: string, result: string }`로 들고
 * 있었다. args·result가 **불투명 문자열**이라 렌더러가 "무슨 파일을 고쳤는지",
 * "명령이 몇 번 만에 성공했는지", "검색이 몇 건 맞았는지"를 알 방법이 없었다.
 * 그래서 화면이 접힌 JSON 덩어리밖에 보여줄 수 없었다 — 답변 UX가 나쁜 이유의 절반.
 *
 * 게다가 렌더러의 옛 `toolView`는 Claude Code 도구명에만 하드코딩돼 있어서
 *  · codex / gemini / ollama / MCP 도구는 전부 "기타"로 떨어졌고,
 *  · `bash`는 실제 명령을 버리고 "검증 단계"라는 문구로 치환했다(가장 정보량이 큰
 *    값을 지운 것).
 *
 * 계약: 러너가 무슨 이름으로 무슨 인자를 주든 **여기서 한 번** 의미 유니온으로
 * 정규화하고, 화면·터미널은 그 유니온만 읽는다. 모르는 도구는 억지로 끼워 넣지 않고
 * `unknown`으로 두되 원본을 보존한다.
 *
 * 이 파일은 의존성이 없다(Main·렌더러·터미널 CJS가 모두 로드한다).
 */

export type ToolCallKind =
  | "shell"
  | "read"
  | "list"
  | "edit"
  | "write"
  | "search"
  | "fetch"
  | "sub_agent"
  | "plan"
  | "todo"
  | "browser"
  | "plain_text"
  | "unknown";

export interface ToolCallDiffStat {
  added: number;
  removed: number;
}

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; lines?: number }
  /** 디렉터리 나열 — Codex의 "List path" 줄. 검색(글롭)과 다르다: 질의가 없다. */
  | { type: "list"; path: string }
  | { type: "edit"; filePath: string; unifiedDiff?: string; diffStat?: ToolCallDiffStat }
  | { type: "write"; filePath: string; bytes?: number }
  | {
      type: "search";
      query: string;
      /** grep(내용) / glob(파일명) / web(웹) — 화면 문구가 갈린다. */
      mode: "content" | "files" | "web";
      path?: string;
      numFiles?: number;
      numMatches?: number;
    }
  | { type: "fetch"; url: string; statusCode?: number; bytes?: number }
  | { type: "sub_agent"; subAgentType?: string; description?: string }
  | { type: "plan"; text?: string }
  | { type: "todo"; items: Array<{ text: string; completed: boolean }> }
  | { type: "browser"; action: string; target?: string }
  | { type: "plain_text"; label: string }
  | { type: "unknown"; toolName: string; input?: unknown; output?: unknown };

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled";

export interface NormalizeToolCallInput {
  /** 러너가 준 도구 이름 원문. */
  name: string;
  /** 인자. JSON 문자열이거나 이미 파싱된 객체. */
  args?: string | Record<string, unknown> | null;
  /** 결과 텍스트(있으면 종료코드·건수 같은 사실을 여기서 뽑는다). */
  result?: string | null;
  /** 실행 폴더. 경로를 상대경로로 줄이는 데 쓴다. */
  cwd?: string;
}

// ── 인자 이름 별칭 — 러너별로 같은 값을 다른 키로 준다(실측 기반) ──────────────
const FILE_KEYS = [
  "file_path", "filePath", "path", "absolute_path", "absolutePath",
  "notebook_path", "notebookPath", "file", "filename", "target_file",
];
const COMMAND_KEYS = ["command", "cmd", "script", "shell_command", "commandLine"];
const QUERY_KEYS = ["query", "pattern", "search", "q", "regex", "text"];
const URL_KEYS = ["url", "uri", "href", "link"];
const CONTENT_KEYS = ["content", "contents", "new_string", "newString", "text", "body"];
const DIFF_KEYS = ["unified_diff", "unifiedDiff", "diff", "patch"];
const DESCRIPTION_KEYS = ["description", "prompt", "task", "instruction"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args: NormalizeToolCallInput["args"]): Record<string, unknown> {
  if (!args) return {};
  if (isRecord(args)) return args;
  if (typeof args !== "string") return {};
  const trimmed = args.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * 경로를 작업 폴더 기준 상대경로로. 절대경로는 화면에서 가장 자주 눈을 찌른다.
 * basename만 남기는 것과는 다르다 — 어느 디렉터리인지가 정보다.
 */
export function stripCwdPrefix(filePath: string, cwd?: string): string {
  if (!filePath) return filePath;
  if (!cwd) return filePath;
  const normalizedCwd = cwd.replace(/[/\\]+$/, "");
  if (!normalizedCwd) return filePath;
  if (filePath === normalizedCwd) return ".";
  for (const separator of ["/", "\\"]) {
    const prefix = `${normalizedCwd}${separator}`;
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  }
  return filePath;
}

/** 통합 diff에서 +/- 줄 수. 헤더(`+++`/`---`)는 세지 않는다. */
export function diffStatFromUnifiedDiff(diff: string): ToolCallDiffStat | undefined {
  if (!diff) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

function diffStatFromReplacement(
  oldString: string | undefined,
  newString: string | undefined,
): ToolCallDiffStat | undefined {
  if (oldString === undefined && newString === undefined) return undefined;
  const removed = oldString ? oldString.split("\n").length : 0;
  const added = newString ? newString.split("\n").length : 0;
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

/** 셸 결과 문자열에서 종료코드를 뽑는다(러너가 구조로 안 줄 때의 최후 수단). */
function exitCodeFromResult(result: string | null | undefined): number | null | undefined {
  if (!result) return undefined;
  const head = result.slice(0, 400);
  const match = /\bexit(?:\s+code)?[:=\s]+(-?\d{1,3})\b/i.exec(head);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** grep/glob 결과에서 파일·매치 건수를 뽑는다. */
function searchCountsFromResult(result: string | null | undefined): {
  numFiles?: number;
  numMatches?: number;
} {
  if (!result) return {};
  const lines = result.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return {};
  const files = new Set<string>();
  let matches = 0;
  for (const line of lines) {
    // `path:line:content`(rg/grep) 또는 경로만 있는 줄(glob).
    const withLine = /^([^\s:][^:]*):(\d+):/.exec(line);
    if (withLine?.[1]) {
      files.add(withLine[1]);
      matches += 1;
      continue;
    }
    if (/^[^\s:]+$/.test(line)) files.add(line);
  }
  const result_: { numFiles?: number; numMatches?: number } = {};
  if (files.size > 0) result_.numFiles = files.size;
  if (matches > 0) result_.numMatches = matches;
  return result_;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

/** MCP 도구 이름에서 서버 이름을 꺼낸다: `mcp__<server>__<tool>`. */
export function mcpServerName(name: string): string | null {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return null;
  const server = parts[1]?.replace(/^agentlas-/, "").replace(/[-_]+/g, " ").trim();
  return server && server.length > 0 ? server : null;
}

function todoItems(args: Record<string, unknown>): Array<{ text: string; completed: boolean }> | null {
  const raw = args.todos ?? args.items ?? args.plan;
  if (!Array.isArray(raw)) return null;
  const items: Array<{ text: string; completed: boolean }> = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      items.push({ text: entry, completed: false });
      continue;
    }
    if (!isRecord(entry)) continue;
    const text = pickString(entry, ["content", "text", "title", "task"]);
    if (!text) continue;
    const status = pickString(entry, ["status", "state"]);
    const done = entry.completed === true || status === "completed" || status === "done";
    items.push({ text, completed: done });
  }
  return items.length > 0 ? items : null;
}

/**
 * 러너의 도구 호출 하나를 의미 유니온으로. **이 함수가 유일한 판별 지점이다** —
 * 화면·터미널이 각자 이름을 보고 추측하면 두 표면이 갈라진다.
 */
export function normalizeToolCall(input: NormalizeToolCallInput): ToolCallDetail {
  const args = parseArgs(input.args);
  const name = normalizedName(input.name);
  const result = input.result ?? undefined;

  const todos = todoItems(args);
  if (todos && (name.includes("todo") || name.includes("plan"))) {
    return { type: "todo", items: todos };
  }

  // ── 편집/쓰기 ─────────────────────────────────────────────────────────
  if (/^(edit|multiedit|str_replace|str_replace_editor|apply_patch|replace|replace_file_content|multi_replace_file_content)$/.test(name) || name.includes("edit_file")) {
    const filePath = pickString(args, FILE_KEYS) ?? "";
    const unifiedDiff = pickString(args, DIFF_KEYS);
    const diffStat =
      (unifiedDiff ? diffStatFromUnifiedDiff(unifiedDiff) : undefined) ??
      diffStatFromReplacement(
        pickString(args, ["old_string", "oldString", "old_str"]),
        pickString(args, ["new_string", "newString", "new_str"]),
      );
    return {
      type: "edit",
      filePath: stripCwdPrefix(filePath, input.cwd),
      ...(unifiedDiff ? { unifiedDiff } : {}),
      ...(diffStat ? { diffStat } : {}),
    };
  }
  if (/^(write|create_file|write_file|write_to_file|notebookedit|notebook_edit)$/.test(name)) {
    const filePath = pickString(args, FILE_KEYS) ?? "";
    const content = pickString(args, CONTENT_KEYS);
    return {
      type: "write",
      filePath: stripCwdPrefix(filePath, input.cwd),
      ...(content ? { bytes: content.length } : {}),
    };
  }

  // ── 읽기 ──────────────────────────────────────────────────────────────
  if (/^(read|read_file|view|view_file|view_code_item|view_file_outline|cat|open_file|read_many_files)$/.test(name)) {
    const filePath = pickString(args, FILE_KEYS) ?? "";
    const lines = pickNumber(args, ["limit", "num_lines", "lines"]);
    return {
      type: "read",
      filePath: stripCwdPrefix(filePath, input.cwd),
      ...(lines !== undefined ? { lines } : {}),
    };
  }

  // ── 셸 ────────────────────────────────────────────────────────────────
  if (/^(bash|shell|run_command|exec|execute|run_terminal_cmd|local_shell|terminal)$/.test(name)) {
    const command = pickString(args, COMMAND_KEYS) ?? (Array.isArray(args.command) ? args.command.join(" ") : "");
    const exitCode = pickNumber(args, ["exit_code", "exitCode"]) ?? exitCodeFromResult(result);
    const cwd = pickString(args, ["cwd", "workdir", "working_directory"]);
    return {
      type: "shell",
      // ★실제 명령을 절대 버리지 않는다. 옛 코드는 이 자리를 "검증 단계"로 치환했다.
      command,
      ...(cwd ? { cwd } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(result ? { output: result } : {}),
    };
  }

  // ── 검색 ──────────────────────────────────────────────────────────────
  if (/^(grep|grep_search|search|search_files|search_file_content|ripgrep|rg|codebase_search)$/.test(name)) {
    const counts = searchCountsFromResult(result);
    return {
      type: "search",
      query: pickString(args, QUERY_KEYS) ?? "",
      mode: "content",
      ...(pickString(args, ["path", "dir", "directory"]) ? { path: pickString(args, ["path", "dir", "directory"]) } : {}),
      ...counts,
    };
  }
  if (/^(ls|list_dir|list_directory|dir)$/.test(name)) {
    const path = pickString(args, [...FILE_KEYS, "DirectoryPath", "directory_path", "directoryPath", "dir", "directory"]) ?? "";
    return { type: "list", path: stripCwdPrefix(path, input.cwd) };
  }
  if (/^(glob|find|find_by_name|list_files|file_search)$/.test(name)) {
    const counts = searchCountsFromResult(result);
    return {
      type: "search",
      query: pickString(args, [...QUERY_KEYS, "glob", "pattern"]) ?? "",
      mode: "files",
      ...(counts.numFiles !== undefined ? { numFiles: counts.numFiles } : {}),
    };
  }
  if (name.includes("web_search") || name === "websearch" || name === "search_web" || name.includes("brave") || name.includes("google_search")) {
    return { type: "search", query: pickString(args, QUERY_KEYS) ?? "", mode: "web" };
  }

  // ── 네트워크 ──────────────────────────────────────────────────────────
  if (/^(webfetch|fetch|http_request|curl|web_fetch|read_url_content|url_fetch)$/.test(name)) {
    const url = pickString(args, URL_KEYS) ?? "";
    const statusCode = pickNumber(args, ["status", "status_code", "code"]);
    return {
      type: "fetch",
      url,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(result ? { bytes: result.length } : {}),
    };
  }

  // ── 위임 / 계획 ───────────────────────────────────────────────────────
  if (/^(task|agent|subagent|delegate|dispatch_agent)$/.test(name)) {
    return {
      type: "sub_agent",
      ...(pickString(args, ["subagent_type", "subAgentType", "agent", "role"])
        ? { subAgentType: pickString(args, ["subagent_type", "subAgentType", "agent", "role"]) }
        : {}),
      ...(pickString(args, DESCRIPTION_KEYS) ? { description: pickString(args, DESCRIPTION_KEYS) } : {}),
    };
  }
  if (/^(exitplanmode|plan|planmode|update_plan)$/.test(name)) {
    return { type: "plan", ...(pickString(args, ["plan", "text", ...DESCRIPTION_KEYS]) ? { text: pickString(args, ["plan", "text", ...DESCRIPTION_KEYS]) } : {}) };
  }

  // ── 브라우저 조종 ─────────────────────────────────────────────────────
  if (name.includes("browser_") || name.startsWith("computer")) {
    const action = name.replace(/^.*browser_/, "").replace(/^computer[_-]?/, "") || "browser";
    return {
      type: "browser",
      action,
      ...(pickString(args, [...URL_KEYS, "selector", "element", "ref", "text"])
        ? { target: pickString(args, [...URL_KEYS, "selector", "element", "ref", "text"]) }
        : {}),
    };
  }

  // ── MCP 커넥터: 이름은 모르지만 "어느 서버"는 아는 경우 ────────────────
  const server = mcpServerName(input.name);
  if (server) {
    const leaf = input.name.split("__").slice(2).join("__").replace(/[-_]+/g, " ").trim();
    return { type: "plain_text", label: leaf ? `${server} · ${leaf}` : server };
  }

  // 모르는 도구는 정직하게 unknown. 원본을 보존해 상세에서 보여줄 수 있게 한다.
  return {
    type: "unknown",
    toolName: input.name,
    ...(Object.keys(args).length > 0 ? { input: args } : {}),
    ...(result ? { output: result } : {}),
  };
}

// ── 표시 모델 ──────────────────────────────────────────────────────────────

export interface ToolCallDisplay {
  /** 행의 굵은 앞머리. */
  displayName: string;
  /** 그 도구를 식별하는 **단 하나의 값**(명령·경로·질의·URL). */
  summary?: string;
  /** 오른쪽 보조 사실: `+23 −1`, `exit 0`, `8 files · 31 matches`. */
  facts?: string;
  /** status가 failed일 때만. */
  errorText?: string;
}

function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  if (/[:./]/.test(trimmed) || trimmed.includes("__")) return trimmed;
  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

const DISPLAY_NAMES: Record<string, { ko: string; en: string }> = {
  shell: { ko: "실행", en: "Shell" },
  read: { ko: "읽기", en: "Read" },
  list: { ko: "목록", en: "List" },
  edit: { ko: "편집", en: "Edit" },
  write: { ko: "작성", en: "Write" },
  search: { ko: "검색", en: "Search" },
  fetch: { ko: "가져오기", en: "Fetch" },
  sub_agent: { ko: "위임", en: "Task" },
  plan: { ko: "계획", en: "Plan" },
  todo: { ko: "할 일", en: "Todo" },
  browser: { ko: "브라우저", en: "Browser" },
};

export function buildToolCallDisplay(input: {
  name: string;
  detail: ToolCallDetail;
  status?: ToolCallStatus;
  errorText?: string;
  locale?: "ko" | "en";
}): ToolCallDisplay {
  const locale = input.locale === "en" ? "en" : "ko";
  const detail = input.detail;
  const named = (key: string) => DISPLAY_NAMES[key]?.[locale] ?? humanizeToolName(input.name);
  const failed = input.status === "failed";
  const errorText = failed && input.errorText ? input.errorText : undefined;

  switch (detail.type) {
    case "shell":
      return {
        displayName: named("shell"),
        summary: detail.command,
        ...(detail.exitCode !== undefined && detail.exitCode !== null
          ? { facts: `exit ${detail.exitCode}` }
          : {}),
        ...(errorText ? { errorText } : {}),
      };
    case "read":
      return { displayName: named("read"), summary: detail.filePath, ...(errorText ? { errorText } : {}) };
    case "list":
      return { displayName: named("list"), summary: detail.path, ...(errorText ? { errorText } : {}) };
    case "edit": {
      const stat = detail.diffStat;
      return {
        displayName: named("edit"),
        summary: detail.filePath,
        ...(stat ? { facts: `+${stat.added} −${stat.removed}` } : {}),
        ...(errorText ? { errorText } : {}),
      };
    }
    case "write":
      return { displayName: named("write"), summary: detail.filePath, ...(errorText ? { errorText } : {}) };
    case "search": {
      const parts: string[] = [];
      if (detail.numFiles !== undefined) {
        parts.push(locale === "ko" ? `파일 ${detail.numFiles}개` : `${detail.numFiles} files`);
      }
      if (detail.numMatches !== undefined) {
        parts.push(locale === "ko" ? `${detail.numMatches}건 일치` : `${detail.numMatches} matches`);
      }
      return {
        displayName: named("search"),
        summary: detail.query || (detail.path ?? ""),
        ...(parts.length > 0 ? { facts: parts.join(" · ") } : {}),
        ...(errorText ? { errorText } : {}),
      };
    }
    case "fetch":
      return {
        displayName: named("fetch"),
        summary: detail.url,
        ...(detail.statusCode !== undefined ? { facts: String(detail.statusCode) } : {}),
        ...(errorText ? { errorText } : {}),
      };
    case "sub_agent":
      return {
        displayName: detail.subAgentType ?? named("sub_agent"),
        ...(detail.description ? { summary: detail.description } : {}),
        ...(errorText ? { errorText } : {}),
      };
    case "plan":
      return { displayName: named("plan"), ...(errorText ? { errorText } : {}) };
    case "todo": {
      const done = detail.items.filter((item) => item.completed).length;
      return {
        displayName: named("todo"),
        facts: `${done}/${detail.items.length}`,
        ...(errorText ? { errorText } : {}),
      };
    }
    case "browser":
      return {
        displayName: named("browser"),
        summary: detail.target ? `${detail.action} · ${detail.target}` : detail.action,
        ...(errorText ? { errorText } : {}),
      };
    case "plain_text":
      return { displayName: detail.label, ...(errorText ? { errorText } : {}) };
    case "unknown":
      return { displayName: humanizeToolName(detail.toolName), ...(errorText ? { errorText } : {}) };
    default: {
      const exhaustive: never = detail;
      return { displayName: String(exhaustive) };
    }
  }
}

// ── 연속 호출 요약(overview) ────────────────────────────────────────────────

export interface ToolRunSummary {
  /** 편집된 **서로 다른** 파일 수. 같은 파일을 5번 고쳐도 1이다. */
  editedFileCount: number;
  readFileCount: number;
  commandCount: number;
  searchCount: number;
  fetchCount: number;
  delegateCount: number;
  otherCount: number;
}

/**
 * 연속된 도구 호출 묶음을 한 줄로 접기 위한 집계.
 *
 * 파일은 **집합**으로 센다 — 같은 파일 반복 편집을 5로 세면 요약이 거짓말이 된다.
 */
export function summarizeToolRun(details: readonly ToolCallDetail[]): ToolRunSummary {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  let commandCount = 0;
  let searchCount = 0;
  let fetchCount = 0;
  let delegateCount = 0;
  let otherCount = 0;

  for (const detail of details) {
    switch (detail.type) {
      case "edit":
      case "write":
        editedFiles.add(detail.filePath);
        break;
      case "read":
        readFiles.add(detail.filePath);
        break;
      case "shell":
        commandCount += 1;
        break;
      case "search":
      case "list":
        searchCount += 1;
        break;
      case "fetch":
        fetchCount += 1;
        break;
      case "sub_agent":
        delegateCount += 1;
        break;
      default:
        otherCount += 1;
        break;
    }
  }

  return {
    editedFileCount: editedFiles.size,
    readFileCount: readFiles.size,
    commandCount,
    searchCount,
    fetchCount,
    delegateCount,
    otherCount,
  };
}

/** 집계를 사람 문장으로. "파일 3개 편집, 명령 2개 실행, 파일 5개 읽음" */
export function formatToolRunSummary(summary: ToolRunSummary, locale: "ko" | "en" = "ko"): string {
  const parts: string[] = [];
  const push = (count: number, ko: string, en: string) => {
    if (count > 0) parts.push(locale === "ko" ? ko : en);
  };
  push(summary.editedFileCount, `파일 ${summary.editedFileCount}개 편집`, `edited ${summary.editedFileCount} file${summary.editedFileCount === 1 ? "" : "s"}`);
  push(summary.commandCount, `명령 ${summary.commandCount}개 실행`, `ran ${summary.commandCount} command${summary.commandCount === 1 ? "" : "s"}`);
  push(summary.readFileCount, `파일 ${summary.readFileCount}개 읽음`, `read ${summary.readFileCount} file${summary.readFileCount === 1 ? "" : "s"}`);
  push(summary.searchCount, `검색 ${summary.searchCount}회`, `searched ${summary.searchCount} time${summary.searchCount === 1 ? "" : "s"}`);
  push(summary.fetchCount, `요청 ${summary.fetchCount}회`, `fetched ${summary.fetchCount} URL${summary.fetchCount === 1 ? "" : "s"}`);
  push(summary.delegateCount, `위임 ${summary.delegateCount}회`, `delegated ${summary.delegateCount} time${summary.delegateCount === 1 ? "" : "s"}`);
  push(summary.otherCount, `도구 ${summary.otherCount}개 사용`, `used ${summary.otherCount} other tool${summary.otherCount === 1 ? "" : "s"}`);
  if (parts.length === 0) return "";
  if (locale === "ko") return parts.join(", ");
  if (parts.length === 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * 산문에 적힌 파일 이름은 폴더를 모른다. 렌더러는 그것을 후보 실행 폴더(기본 실행 폴더 →
 * 승인된 작업 폴더 순)로 찍어 절대경로로 만든다 — 첫 후보가 틀리면 그 경로의 파일은
 * **존재하지 않는다.**
 *
 * 같은 이름을 도구 기록이 절대경로로 갖고 있으면 그 기록이 정본이다. 찍어 만든 경로를
 * 산출물로 함께 올리면 결과 레일이 "만든 적 없는 파일"을 한 줄 더 보여준다.
 *
 * 답변 본문과 도구 기록이 같은 파일을 가리키면 도구가 기록한 절대경로만 유지해
 * 추정 경로로 인한 중복 산출물과 존재하지 않는 파일 링크를 방지한다.
 */
export function shadowsToolRecordedPath(
  candidatePath: string | undefined | null,
  toolPaths: readonly string[],
  sourceReference?: string | undefined | null,
): boolean {
  if (!candidatePath) return false;
  const canonical = (value: string) => {
    const normalized = value.replaceAll("\\", "/");
    // macOS exposes only these root paths through their shorter aliases. Do not
    // collapse arbitrary `/private/*` paths (for example `/private/Users`).
    if (["/private/tmp", "/private/var", "/private/etc"].some((root) => (
      normalized === root || normalized.startsWith(`${root}/`)
    ))) return normalized.slice("/private".length);
    return normalized;
  };
  const baseName = (value: string) => canonical(value).split("/").pop() ?? "";
  const candidate = canonical(candidatePath);
  const candidateName = baseName(candidatePath);
  if (!candidateName) return false;
  for (const toolPath of toolPaths) {
    if (canonical(toolPath) === candidate) return false;
  }

  // Once prose names a directory, absolute path, or file URL, that reference
  // is an independent claim. Basename equality cannot erase it. Only a bare
  // filename loses its folder and is guessed against the renderer's base-path
  // candidates, which is the duplicate this guard is allowed to suppress.
  if (sourceReference !== undefined) {
    const reference = sourceReference?.trim().replace(/^<|>$/g, "") ?? "";
    if (!reference || /[\\/]/.test(reference) || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return false;
  }

  return toolPaths.some((toolPath) => baseName(toolPath) === candidateName);
}
