/**
 * 커넥터 C38 — 커널이 도구 호출을 **중개**한다.
 *
 * 지금까지 커널은 도구 호출을 **보기만** 했다(C05: tool-use 이벤트를 영수증으로 적는다).
 * 보기만 하면 두 가지가 거짓이 된다:
 *
 *  1. 화면에서 에이전트 노드에 도구를 이어 붙이는 행위(C06)가 "이것만 쓴다"는 약속처럼
 *     보이는데, 실제로는 런타임이 다른 도구를 불러도 아무도 막지 않는다.
 *  2. 시뮬레이션(dry-run)이 "바깥을 바꾸지 않는다"고 말하는데, 실제로 한 일은 권한을
 *     read로 낮춘 것뿐이다. 런타임이 그 권한을 어떻게 해석하는지에 보장이 달려 있다.
 *
 * 그래서 **실제로 막을 수 있는 지점**이 어디인지부터 실측했다. 결론은 하나다:
 * 도구 호출 직전에 걸리는 훅(PreToolUse)이 유일한 보편 관문이다. 샌드박스는 MCP 호출에
 * 적용되지 않고, `--allowedTools` 류의 깃발은 **허용만** 할 뿐 거절을 못 한다.
 *
 * 이 머신 실측(2026-08-04):
 *  - claude 2.1.220 — PreToolUse deny가 `--permission-mode bypassPermissions`를 이겼다.
 *    Bash 호출이 실행되지 않고 거절 사유가 모델에게 그대로 돌아갔다.
 *  - codex 0.146.0 — 실행 파일에 PreToolUse / pre_tool_use / permissionDecision 심볼이 있다.
 *
 * ★그리고 가장 중요한 규칙: **막을 수 없는 런타임에서는 막았다고 적지 않는다.**
 * 등급을 세 칸으로 나눠 실행 기록에 그대로 싣는다. 등급을 지어내면 이 파일이 만들려는
 * 보장이 정확히 반대로 작동한다 — 사람은 막힌 줄 알고 안 막힌 자동화를 밤새 돌린다.
 */

/** 중개 보장 등급. 낮은 쪽으로만 떨어지고, 절대 올려 적지 않는다. */
export type ToolBrokerLevel =
  /** 호출 직전 관문이 실제로 걸렸다. 선언되지 않은 도구는 실행되지 않는다. */
  | "enforced"
  /** 관문은 없고, 런타임에 허용 목록을 넘겨 좁히기만 했다. 넘어서는 호출을 거절하지 못한다. */
  | "cooperative"
  /** 아무것도 못 막는다. 무엇을 불렀는지 나중에 영수증으로 볼 뿐이다. */
  | "observed";

export const TOOL_BROKER_LEVELS: readonly ToolBrokerLevel[] = ["enforced", "cooperative", "observed"];

/** 등급별로 사람에게 보여줄 한 줄. 화면·기록 어디서든 같은 문장을 쓴다. */
export const TOOL_BROKER_LEVEL_LABEL: Record<ToolBrokerLevel, string> = {
  enforced: "강제됨 — 선언되지 않은 도구는 실행 직전에 막힙니다",
  cooperative: "협조적 — 도구 목록만 좁혔습니다. 벗어난 호출은 막지 못합니다",
  observed: "관측만 — 무엇을 썼는지 기록만 남습니다. 막지는 못합니다",
};

/**
 * 런타임별로 **실제로 확인된** 관문. 여기 없는 런타임은 자동으로 "observed"다.
 * 새 런타임을 올릴 때는 증거를 적어야 한다 — 적을 증거가 없으면 올리지 않는 게 맞다.
 */
export interface RuntimeChokepoint {
  kind: "pretooluse-hook" | "allowlist-only";
  /** 왜 이 관문을 믿는지. 사람이 나중에 되짚을 수 있어야 한다. */
  evidence: string;
}

export const RUNTIME_CHOKEPOINTS: Record<string, RuntimeChokepoint> = {
  claude: {
    kind: "pretooluse-hook",
    evidence: "실측 2026-08-04 · claude 2.1.220: PreToolUse deny가 bypassPermissions를 이기고 Bash 호출을 실제로 막았다",
  },
  // ★codex는 일부러 한 칸 낮다. 실행 파일에 PreToolUse/pre_tool_use/permissionDecision
  // 심볼이 있는 것은 확인했지만(0.146.0), 실제로 거절이 먹는지 재는 실측이 이 머신에서
  // 응답 없이 끝났다(2026-08-05, hooks.managed_dir + --dangerously-bypass-hook-trust, 5분 초과).
  // 심볼이 있다는 것은 "막을 수 있다"의 증거가 아니다. 재서 확인되면 그때 올린다.
  codex: {
    kind: "allowlist-only",
    evidence: "electron/runtime/codex.ts가 MCP 허용 목록을 좁힌다 · PreToolUse 거절은 미실측(2026-08-05 실측 시도 무응답)",
  },
  /*
   * ★grok 은 claude 와 **같은 stdout JSON 계약**을 쓴다. 실측 2026-08-19(grok 1.0.5
   * 바이너리 내장 문서): "For `PreToolUse`, a `deny` decision in stdout JSON is
   * honored regardless of exit code". 그래서 훅 스크립트는 claude 것을 그대로 쓰고
   * (판단이 두 벌이 되면 갈라진다), 포장만 TOML 로 바꾼다.
   *
   * ★배선 위치를 두 번 틀렸다 — 기록해 둔다.
   *  · 최상위 `grok --plugin-dir` → `unexpected argument` 로 **실행이 아예 안 뜬다**.
   *  · 프로젝트 스코프 `./.grok/config.toml` 훅 → 헤드리스에서 **발화하지 않았다**
   *    (훅 0회, 파일은 그대로 생성됨).
   * 맞는 자리는 `grok agent` 하위 명령이고, grok 은 ACP_PREFERRED_KINDS 라 실제
   * 실행이 바로 그 경로다(electron/runtime/acp.ts). "런타임이 그 기능을 가졌다"와
   * "우리가 지나는 길에 그 기능이 있다"는 다른 질문이다.
   *
   * codex 와 등급이 갈리는 이유: codex 는 심볼만 있고 거절이 먹는지 실측이 무응답으로
   * 끝났다. grok 은 벤더가 계약을 문서로 명시했고 주입점이 프로세스별이다.
   */
  grok: {
    kind: "pretooluse-hook",
    evidence:
      "실측 2026-08-19 · grok 1.0.5: `grok agent --plugin-dir <DIR> stdio` 가 정상 기동·initialize 응답(exit 0)하고, 벤더 문서가 그 스코프를 'always trusted — hooks and MCP servers activate without a prompt' 로, PreToolUse 를 'a deny decision in stdout JSON is honored regardless of exit code' 로 명시한다",
  },
};

/** 바깥을 바꾸는 내장 도구. dry-run은 이것들을 실제로 거절한다. */
export const MUTATING_BUILTIN_TOOLS = [
  "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "KillShell",
] as const;

/**
 * Built-ins that can bypass the Agentlas Browser session or expose its cookies.
 * judgment-exempt: this is not "did the tool change the outside world" (that lives in
 * shared/tool-activity couldHaveChangedTheOutsideWorld). Read-only file tools belong here
 * because reading a cookie/profile file leaks the session without changing anything.
 */
export const BROWSER_BYPASS_BUILTIN_TOOLS = [
  "Bash", "BashOutput", "Write", "Edit", "MultiEdit", "NotebookEdit", "KillShell",
  "run_command", "command_status", "send_command_input",
  "view_file", "read_file", "write_to_file", "replace_file_content", "multi_replace_file_content",
  "open_browser_url", "read_browser_page", "execute_browser_javascript", "browser_subagent",
] as const;

export interface ToolBrokerInput {
  /** 이 노드에 화면에서 이어 붙인 도구들의 catalog id (C06). 빈 배열이면 선언이 없다. */
  declaredToolCatalogIds: string[];
  /** 위 선언에서 풀려나온 실제 MCP 도구 이름 prefix (예: "mcp__playwright"). */
  declaredToolNames: string[];
  /** 이번 실행이 시뮬레이션인가. */
  dryRun: boolean;
  /** 이 노드가 실제로 돌 런타임 종류. 모르면 null. */
  runtimeKind: string | null;
}

export interface ToolBrokerPlan {
  level: ToolBrokerLevel;
  /** 등급이 왜 이건지. 실행 기록에 그대로 실린다. */
  reason: string;
  /** 이름이 이 목록의 어느 것으로 시작하면 통과. 비어 있으면 MCP 도구를 안 좁힌다. */
  allowPrefixes: string[];
  /** 이름이 정확히 이 목록에 있으면 거절. dry-run에서 바깥을 바꾸는 내장 도구가 들어온다. */
  denyExact: string[];
  /** 선언되지 않은 MCP 도구를 거절하는가. 선언이 하나도 없으면 좁힐 근거가 없어 false. */
  denyUndeclaredMcp: boolean;
  chokepoint: RuntimeChokepoint["kind"] | "none";
}

/**
 * 이 노드에서 무엇을 막을지, 그리고 **그 약속을 얼마나 지킬 수 있는지**를 함께 정한다.
 * 막을 내용과 등급을 한 함수에서 정하는 이유: 따로 정하면 "막기로 했지만 못 막는데
 * 막았다고 적힌" 조합이 언젠가 반드시 생긴다.
 */
export function planToolBrokerage(input: ToolBrokerInput): ToolBrokerPlan {
  const chokepoint = input.runtimeKind ? RUNTIME_CHOKEPOINTS[input.runtimeKind] : undefined;
  const denyUndeclaredMcp = input.declaredToolNames.length > 0;
  const browserOnly = input.declaredToolCatalogIds.length > 0
    && input.declaredToolCatalogIds.every((id) => id === "agentlas-browser");
  const denyExact = browserOnly
    ? [...BROWSER_BYPASS_BUILTIN_TOOLS]
    : input.dryRun ? [...MUTATING_BUILTIN_TOOLS] : [];
  const nothingToBroker = !denyUndeclaredMcp && denyExact.length === 0;

  if (nothingToBroker) {
    // 좁힐 선언도 없고 시뮬레이션도 아니다. 여기서 "강제됨"이라고 적으면 아무것도
    // 강제하지 않은 실행에 보장 라벨이 붙는다.
    return {
      level: "observed",
      reason: "이 노드에 이어 붙인 도구가 없고 시뮬레이션도 아닙니다 — 좁힐 대상이 없습니다.",
      allowPrefixes: [],
      denyExact: [],
      denyUndeclaredMcp: false,
      chokepoint: "none",
    };
  }

  if (chokepoint?.kind === "pretooluse-hook") {
    return {
      level: "enforced",
      reason: `${input.runtimeKind}는 도구 호출 직전 관문을 지원합니다 (${chokepoint.evidence}).`,
      allowPrefixes: input.declaredToolNames,
      denyExact,
      denyUndeclaredMcp,
      chokepoint: "pretooluse-hook",
    };
  }

  if (chokepoint?.kind === "allowlist-only") {
    return {
      level: "cooperative",
      reason: `${input.runtimeKind}에는 호출 직전 관문이 없어 허용 목록으로 좁히기만 했습니다.`,
      allowPrefixes: input.declaredToolNames,
      denyExact,
      denyUndeclaredMcp,
      chokepoint: "allowlist-only",
    };
  }

  return {
    level: "observed",
    reason: input.runtimeKind
      ? `${input.runtimeKind}에서 도구 호출을 막는 방법이 확인되지 않았습니다 — 기록만 남습니다.`
      : "이 노드가 어느 런타임에서 도는지 정해지지 않아 막을 지점을 걸 수 없습니다.",
    allowPrefixes: input.declaredToolNames,
    denyExact,
    denyUndeclaredMcp,
    chokepoint: "none",
  };
}

/**
 * 시뮬레이션이 사람에게 무엇을 약속해도 되는지. 등급이 강제됨이 아니면 **약속을 낮춘다**.
 * 이 문장이 실행 기록과 화면에 그대로 간다.
 */
export function dryRunPromise(level: ToolBrokerLevel): string {
  if (level === "enforced") {
    return "바깥을 바꾸는 도구는 실행 직전에 막힙니다. 실제로 아무것도 바뀌지 않습니다.";
  }
  if (level === "cooperative") {
    return "바깥을 바꾸지 말라고 지시하고 도구 목록을 좁혔지만, 벗어난 호출은 막지 못합니다.";
  }
  return "바깥을 바꾸지 말라고 지시했을 뿐, 실제로 막지는 못합니다. 무엇을 했는지는 기록에 남습니다.";
}

/** 호출 직전 관문이 판단할 때 쓰는 순수 함수. 훅 스크립트와 게이트가 **같은** 함수를 쓴다. */
export function brokerDecision(
  plan: ToolBrokerPlan,
  toolName: string,
): { allow: boolean; code?: string; reason?: string } {
  if (plan.denyExact.includes(toolName)) {
    return {
      allow: false,
      code: "TOOL_BROKER_MUTATION_IN_SIMULATION",
      reason: `시뮬레이션 중이라 바깥을 바꾸는 도구("${toolName}")를 실행하지 않았습니다.`,
    };
  }
  // 내장 도구는 선언 대상이 아니다. 좁히는 것은 MCP 도구뿐이다 — 내장까지 거절하면
  // 도구를 하나 붙였다는 이유로 에이전트가 파일도 못 읽게 된다.
  if (plan.denyUndeclaredMcp && toolName.startsWith("mcp__")) {
    const declared = plan.allowPrefixes.some((prefix) => toolName.startsWith(prefix));
    if (!declared) {
      return {
        allow: false,
        code: "TOOL_BROKER_TOOL_NOT_DECLARED",
        reason: `이 단계에 이어 붙이지 않은 도구("${toolName}")라 실행하지 않았습니다.`,
      };
    }
  }
  return { allow: true };
}
