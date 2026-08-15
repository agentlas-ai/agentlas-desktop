/**
 * 도구 이름 → 무슨 일을 했는가.
 *
 * 출력 패널은 도구를 `/bash|shell|terminal|exec|command/` 같은 **단어 매칭**으로 갈랐다.
 * 그 방식은 런타임이 하나일 때만 맞는다. 실측한 이름들:
 *
 *   claude    Write · Edit · Bash · Read · Glob · Grep · WebFetch
 *   codex     bash · apply_patch
 *   grok      write · read_file · list_dir
 *   agy       write_to_file · view_file · run_command
 *   ACP       (이름 대신 프로토콜 kind: read/edit/execute/fetch/search/delete/move)
 *
 * `write` 도, `write_to_file` 도, `apply_patch` 도 단어 매칭에는 걸리지 않는다. 그래서
 * 명령 칸과 컴퓨터 사용 칸은 대부분의 런타임에서 늘 0이었다.
 *
 * ACP 는 이미 정답을 갖고 있다 — 프로토콜이 kind 를 고정해 준다. 그 어휘를 공통 분모로
 * 삼고, 이름만 주는 런타임을 거기에 맞춘다. 새 런타임이 늘면 이 표에 줄을 더하면 되고,
 * 모르는 이름은 조용히 사라지지 않고 "other" 로 남는다.
 */

export type ToolAction =
  | "file"      // 파일을 만들거나 고친다
  | "command"   // 셸/프로세스를 실행한다
  | "browser"   // 브라우저·화면을 조작한다
  | "read"      // 파일을 읽는다
  | "search"    // 찾는다
  | "fetch"     // 네트워크에서 가져온다
  | "delegate"  // 하위 에이전트에 맡긴다
  | "other";

/** ACP 프로토콜 kind → 행위. 프로토콜이 보장하는 값이라 추측이 없다. */
const ACP_KIND_ACTION: Record<string, ToolAction> = {
  edit: "file",
  delete: "file",
  move: "file",
  execute: "command",
  read: "read",
  search: "search",
  fetch: "fetch",
  think: "other",
  other: "other",
};

/**
 * 이름 → 행위. 소문자·구분자 제거 후 비교하므로 `write_to_file`·`writeToFile`·`Write`가
 * 같은 줄에 걸린다. 부분 일치가 아니라 정확 일치다 — `read_file`이 `file` 규칙에 걸려
 * 쓰기로 분류되는 사고를 막는다.
 */
const NAME_ACTION: Record<string, ToolAction> = {
  // 파일 쓰기/편집
  write: "file", writetofile: "file", edit: "file", multiedit: "file", strreplace: "file",
  strreplaceeditor: "file", applypatch: "file", patch: "file", createfile: "file",
  notebookedit: "file", editfile: "file", writefile: "file", replaceinfile: "file",
  deletefile: "file", movefile: "file", renamefile: "file",
  // 명령 실행
  bash: "command", shell: "command", runcommand: "command", runterminalcmd: "command",
  terminal: "command", exec: "command", execcommand: "command", bashoutput: "command",
  killshell: "command", localshell: "command", process: "command",
  // 브라우저·컴퓨터 사용
  browser: "browser", computer: "browser", computeruse: "browser", screenshot: "browser",
  playwright: "browser", navigate: "browser", browseraction: "browser",
  // 읽기
  read: "read", readfile: "read", viewfile: "read", view: "read", cat: "read",
  listdir: "read", ls: "read", listfiles: "read",
  // 검색
  grep: "search", glob: "search", search: "search", searchfiles: "search",
  codebasesearch: "search", findfiles: "search", ripgrep: "search",
  // 네트워크
  webfetch: "fetch", fetch: "fetch", websearch: "fetch", curl: "fetch", httprequest: "fetch",
  // 위임
  task: "delegate", agent: "delegate", subagent: "delegate", delegate: "delegate", dispatch: "delegate",
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 도구가 한 일을 정한다. `acpKind`가 있으면 그것이 먼저다 — 프로토콜이 보장한 값이
 * 이름 추정보다 낫다.
 */
export function classifyTool(name: string | undefined, acpKind?: string): ToolAction {
  if (acpKind) {
    const fromKind = ACP_KIND_ACTION[acpKind.toLowerCase()];
    if (fromKind) return fromKind;
  }
  const key = normalize(name ?? "");
  if (!key) return "other";
  const exact = NAME_ACTION[key];
  if (exact) return exact;
  /*
   * 정확 일치가 없을 때만 접미/접두를 본다. 도구 이름은 대개 동사+대상이라
   * (`write_to_file`, `create_file`) 동사 쪽이 행위를 결정한다.
   */
  if (/^(write|create|edit|patch|append|delete|remove|rename|move)/.test(key)) return "file";
  if (/^(run|exec|spawn|launch)/.test(key)) return "command";
  if (/^(read|view|open|cat|list)/.test(key)) return "read";
  if (/^(search|find|grep|glob)/.test(key)) return "search";
  if (/^(fetch|http|web|download)/.test(key)) return "fetch";
  if (/(browser|screenshot|mouse|keyboard|click)/.test(key)) return "browser";
  return "other";
}

/** 출력 패널의 "명령" 칸에 들어가는가. */
export function isCommandTool(name: string | undefined, acpKind?: string): boolean {
  return classifyTool(name, acpKind) === "command";
}

/** 출력 패널의 "컴퓨터 사용" 칸에 들어가는가. */
export function isComputerUseTool(name: string | undefined, acpKind?: string): boolean {
  return classifyTool(name, acpKind) === "browser";
}

/** 파일을 바꾼 호출인가 — 무엇이 바뀌었는지 사람에게 보여줄 값. */
export function isFileMutatingTool(name: string | undefined, acpKind?: string): boolean {
  return classifyTool(name, acpKind) === "file";
}
