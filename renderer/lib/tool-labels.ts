/*
 * the one table that names a tool/capability id to a person. An approval line, an approval card and a record all read it;
 * none of them prints a raw id. Order: this table -> an MCP tool's own name (mcp__<server>__<tool>) as words -> a plain
 * word the host already spells for people -> the generic "permission request". A machine-spelled id (dash, dot, underscore, camelCase)
 * that no row names never reaches the screen.
 */
export type ToolLabelLang = "ko" | "en";

const TOOL_LABELS: Record<string, [string, string]> = {
  "permission-escalation": ["전체 액세스", "Full access"],
  "folder-access": ["폴더 접근", "Folder access"],
  one_app_call: ["앱 설정 변경", "App setting change"],
  bash: ["명령 실행", "Run a command"],
  terminal: ["터미널 명령", "Terminal command"],
  shell: ["명령 실행", "Run a command"],
  write: ["파일 쓰기", "Write a file"],
  edit: ["파일 수정", "Edit a file"],
  multiedit: ["파일 수정", "Edit a file"],
  notebookedit: ["노트북 수정", "Edit a notebook"],
  click: ["화면 클릭", "Click on screen"],
  press_key: ["키 입력", "Press a key"],
  hotkey: ["단축키 입력", "Press a shortcut"],
  set_value: ["입력칸 채우기", "Fill a field"],
  invoke_menu: ["메뉴 실행", "Run a menu item"],
  message_send: ["메시지 보내기", "Send a message"],
  "workforce.search_candidates": ["에이전트 찾기", "Find agents"],
};

/** The language the screen is drawn in right now (the provider writes it on <html lang>); "en" where there is no document. */
export function screenToolLabelLang(): ToolLabelLang {
  return typeof document !== "undefined" && document.documentElement?.lang?.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export const GENERIC_PERMISSION_LABEL: Record<ToolLabelLang, string> = { ko: "권한 요청", en: "Permission request" };

/** A word a person may read as it is: letters/digits and spaces only, no machine separators or camelCase joins. */
const PLAIN_WORDS = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;
const CAMEL_JOIN = /[a-z][A-Z]/;

/**
 * An MCP call's own tool part ("message_send" of "mcp__one-team__message_send") as a person reads it, when a row of this table names it; null
 * otherwise (the caller then spells the name as words). The same table serves the call cells of the turn work.
 */
export function mcpToolLeafLabel(toolName: string, lang: ToolLabelLang = "ko"): string | null {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName.trim());
  if (!mcp) return null;
  const leaf = mcp[2]!;
  const known = TOOL_LABELS[leaf] ?? TOOL_LABELS[leaf.toLowerCase()];
  return known ? known[lang === "ko" ? 0 : 1] : null;
}

export function toolLabel(tool: string | null | undefined, lang: ToolLabelLang = "ko"): string {
  const raw = (tool ?? "").trim();
  if (!raw) return GENERIC_PERMISSION_LABEL[lang];
  const known = TOOL_LABELS[raw] ?? TOOL_LABELS[raw.toLowerCase()];
  if (known) return known[lang === "ko" ? 0 : 1];
  // The server part may itself contain underscores ("claude_ai_Notion"): it ends at the next "__".
  const mcp = /^mcp__(.+?)__(.+)$/.exec(raw);
  const leafKnown = mcpToolLeafLabel(raw, lang);
  if (leafKnown) return leafKnown;
  const spelled = (mcp ? mcp[2]! : raw).replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  if (mcp && spelled) return spelled;
  if (spelled && PLAIN_WORDS.test(spelled) && !CAMEL_JOIN.test(spelled) && !raw.includes("_")) return spelled;
  return GENERIC_PERMISSION_LABEL[lang];
}
