// 런타임 능력 서술자 — "이 CLI가 무엇을 할 수 있고, 우리는 어떤 통로로 쓰는가"의 정본.
// runtime-mcp.ts 와 같은 규율: Record<RuntimeKind, …> 라서 새 런타임은 모든 칸에
// 답하지 않으면 컴파일이 실패한다. 근거 없는 행은 여기 있을 자격이 없다.
//
// ★수명 규칙 (UNIVERSAL-RUNTIME-FEATURES-PLAN §4.5-a) — 항목마다 휘발성이 다르다:
//   · 구조적(프로토콜·아키텍처): 버전이 올라도 안 바뀐다.
//   · 정책적(벤더 제품 결정): 분기~연 단위로 바뀐다.
//   · 표면적(CLI 플래그·경로): **마이너 버전마다 바뀔 수 있다.**
// 표면적 항목은 scripts/probe-runtime-capabilities.mjs 가 설치된 CLI 의 --help 로
// 실측해 어긋나면 알린다. probedVersion 이 낡은 값은 확신처럼 쓰지 말 것.
import type { RuntimeKind } from "./types";

/** 커스텀 슬래시 명령/스킬이 사는 곳 (홈 디렉터리 기준 세그먼트). */
export interface RuntimeCommandSurface {
  /** os.homedir() 아래 경로 세그먼트. */
  segments: readonly string[];
  /**
   * md-tree: 디렉터리 트리의 *.md 파일 하나가 명령 하나(claude/codex/cursor).
   * skill-dirs: 하위 디렉터리 하나가 스킬 하나, 설명은 SKILL.md frontmatter(antigravity).
   */
  layout: "md-tree" | "skill-dirs";
}

export interface RuntimeCapabilityDescriptor {
  /** 시스템 프롬프트가 CLI에 들어가는 최선의 통로. */
  systemPrompt: {
    delivery: "flag" | "file" | "inline" | "native-role";
    flag?: string;
    evidence: string;
  };
  /** 세션 재개 — none 이면 매 턴 히스토리 재주입(러너가 정직하게 유지). */
  resume: {
    kind: "cli-flag" | "acp-load" | "none";
    flag?: string;
    evidence: string;
  };
  /** 이미지 전달. prose-path = 경로를 산문으로 알려 CLI가 파일을 읽게 함(폴백). */
  image: {
    kind: "native-inline" | "cli-flag" | "prose-path" | "none";
    flag?: string;
    evidence: string;
  };
  /** 커스텀 슬래시 명령 위치 — electron/runtime/commands.ts 가 소비. */
  commandSurfaces: readonly RuntimeCommandSurface[];
  /** 트랜스크립트(압축 요약 수확·외부 세션 임포트 원료). */
  transcript: {
    /** os.homedir() 기준 세그먼트. */
    segments: readonly string[];
    format: "jsonl" | "sqlite";
    evidence: string;
  } | null;
  /**
   * 이 런타임 소속임을 말해 주는 **구별력 있는** 컨텍스트 파일 — runtime-labels 가
   * 소비. "/" 로 끝나면 디렉터리. 여러 런타임이 공유하는 파일(AGENTS.md 를 grok·kimi
   * 도 읽는 것 등)은 구별력이 없으므로 여기 넣지 않고 evidence 에만 적는다.
   */
  distinctiveContextFiles: readonly string[];
  /** 도구 호출 직전 차단(PreToolUse류) 훅. null = 훅 표면 없음/우리 루프가 관문. */
  hook: {
    config: string;
    /** 훅이 죽거나 타임아웃했을 때 CLI 의 기본 행동. */
    failMode: "open" | "closed" | "configurable" | "unprobed";
    evidence: string;
  } | null;
}

export const RUNTIME_CAPABILITIES: Record<RuntimeKind, RuntimeCapabilityDescriptor> = {
  "claude-code": {
    systemPrompt: {
      delivery: "file",
      flag: "--system-prompt-file",
      evidence: "electron/runtime/claude-code.ts passes the wrapped prompt via a stable-path file, which is also what keeps the prompt cache warm",
    },
    resume: { kind: "cli-flag", flag: "--resume", evidence: "claude-code.ts stores and resumes session ids per chat" },
    image: { kind: "native-inline", evidence: "stream-json input carries image blocks; claude-code.ts stages attachments inline" },
    commandSurfaces: [{ segments: [".claude", "commands"], layout: "md-tree" }],
    transcript: {
      segments: [".claude", "projects"],
      format: "jsonl",
      evidence: "memory/compact-summary harvest reads isCompactSummary lines from ~/.claude/projects/<slug>/<uuid>.jsonl",
    },
    distinctiveContextFiles: ["CLAUDE.md", ".claude/"],
    hook: {
      config: "settings.json (PreToolUse, passed per run via --settings)",
      failMode: "open",
      evidence: "measured 2026-08-04 (claude 2.1.220): PreToolUse deny beats bypassPermissions; a crashed hook lets the call through (non-2 exit continues)",
    },
  },
  codex: {
    systemPrompt: {
      delivery: "inline",
      evidence: "codex exec has no system flag (help, codex current as of 2026-08-18); resume turns do not resend it — electron/runtime/codex.ts",
    },
    resume: { kind: "cli-flag", flag: "exec resume", evidence: "probed 2026-08-18: `codex exec resume <SESSION_ID|--last> [PROMPT]` in help" },
    image: { kind: "cli-flag", flag: "-i", evidence: "probed 2026-08-18: `-i, --image <FILE>...` in `codex exec --help`" },
    commandSurfaces: [{ segments: [".codex", "prompts"], layout: "md-tree" }],
    transcript: {
      segments: [".codex", "sessions"],
      format: "jsonl",
      evidence: "measured 2026-08-18: 46GB of session JSONL on this machine; external-cli-sessions.ts already imports the format",
    },
    distinctiveContextFiles: ["AGENTS.md"],
    hook: {
      config: "hooks.json via -c hooks.managed_dir=<dir> (needs --dangerously-bypass-hook-trust for unattended runs)",
      failMode: "unprobed",
      evidence: "flags exist in `codex exec --help` (probed 2026-08-18); deny-shape byte-compatible with claude per vendor docs; enforcement re-probe blocked by usage limit until 2026-08-20",
    },
  },
  antigravity: {
    systemPrompt: {
      delivery: "inline",
      evidence: "agy 1.1.14 help has no system-prompt flag; electron/runtime/antigravity.ts wraps it into the prompt",
    },
    resume: {
      kind: "cli-flag",
      flag: "--conversation",
      evidence: "probed 2026-08-18 (agy 1.1.14 help): `--conversation  Resume a previous conversation by ID`. Not wired yet — the stream's conversation-id source is unverified, and resuming the wrong conversation is worse than resending history",
    },
    image: { kind: "prose-path", evidence: "no attach flag in agy 1.1.14 help; runner tells the model the staged file path" },
    commandSurfaces: [{ segments: [".gemini", "config", "skills"], layout: "skill-dirs" }],
    transcript: {
      segments: [".gemini", "antigravity-cli"],
      format: "sqlite",
      evidence: "conversation store lives under the agy home (capability matrix 2026-08-18); reader not built yet",
    },
    distinctiveContextFiles: ["GEMINI.md"],
    hook: {
      config: "~/.gemini/config/hooks.json — PreInvocation and Stop work (our own hooks run there); PreToolUse does NOT fire on the headless path",
      failMode: "open",
      evidence:
        "measured 2026-08-19 (agy 1.1.14): a PreToolUse hook returning permissionDecision deny never ran (hook script produced no output at all) and write_file created the file anyway. Tried twice — env-prefixed command and a plain wrapper script — same result. The binary contains the PreToolUse string, but a symbol is not a chokepoint. PreInvocation/Stop are proven by our own shipped hooks in that same file",
    },
  },
  grok: {
    systemPrompt: {
      delivery: "flag",
      flag: "--system-prompt-override",
      evidence: "probed 2026-08-18 (grok 1.0.5 help): `--system-prompt-override <PROMPT>` (compat alias --system-prompt)",
    },
    resume: { kind: "cli-flag", flag: "--resume", evidence: "electron/runtime/grok.ts resumes with the session id from streaming-json" },
    image: { kind: "prose-path", evidence: "no image flag in grok 1.0.5 help; prose fallback" },
    commandSurfaces: [],
    transcript: null,
    // grok reads CLAUDE.md/AGENTS.md too (vendor docs) — shared, so not distinctive.
    distinctiveContextFiles: [],
    hook: {
      config: "grok agent --plugin-dir <DIR> — the flag exists ONLY on the agent subcommand, which is the path grok runs on here (ACP)",
      failMode: "open",
      evidence:
        "measured 2026-08-19 (grok 1.0.5): `grok agent --plugin-dir <DIR> stdio` starts and answers initialize (exit 0); wired in electron/runtime/acp.ts. Two wrong placements measured first — the top-level flag refuses to start, and a project-scope .grok/config.toml hook never fired on the headless path. Vendor docs: that scope is always trusted, and a PreToolUse deny in stdout JSON is honored regardless of exit code; a crashed hook still fails open, so the broker treats hook failure as run-abort",
    },
  },
  cursor: {
    systemPrompt: { delivery: "inline", evidence: "routed via ACP (ACP_PREFERRED_KINDS); acp.ts wraps the system prompt into session prompt" },
    resume: { kind: "acp-load", evidence: "acp.ts session/load when the agent declares loadSession" },
    image: { kind: "native-inline", evidence: "ACP prompt blocks carry images; acp.ts stages them" },
    commandSurfaces: [{ segments: [".cursor", "commands"], layout: "md-tree" }],
    transcript: {
      segments: [".cursor"],
      format: "sqlite",
      evidence: "store.db under the cursor home (capability matrix 2026-08-18); reader not built yet",
    },
    distinctiveContextFiles: [".cursor/", ".cursorrules"],
    hook: {
      config: "hooks.json (beforeShellExecution/afterShellExecution only in the CLI)",
      failMode: "configurable",
      evidence: "cursor.com/docs/hooks (fetched 2026-08-18): default fail-open, `failClosed: true` blocks on failure; Cursor staff confirm the CLI fires only the two shell events",
    },
  },
  kimi: {
    systemPrompt: { delivery: "inline", evidence: "routed via ACP; no system flag on the native CLI (`-p` mode) per capability matrix 2026-08-18" },
    resume: { kind: "acp-load", evidence: "acp.ts session/load when declared" },
    image: { kind: "native-inline", evidence: "ACP prompt blocks" },
    commandSurfaces: [],
    transcript: null,
    // kimi reads AGENTS.md only — shared, so not distinctive.
    distinctiveContextFiles: [],
    hook: {
      config: "~/.kimi-code/config.toml [[hooks]]",
      failMode: "open",
      evidence: "capability matrix 2026-08-18; fail-open per vendor docs",
    },
  },
  acp: {
    systemPrompt: { delivery: "inline", evidence: "generic ACP seat: system prompt wrapped into session prompt (acp.ts)" },
    resume: { kind: "acp-load", evidence: "session/load is optional per agent; acp.ts honors the declaration" },
    image: { kind: "native-inline", evidence: "ACP prompt blocks" },
    commandSurfaces: [],
    transcript: null,
    distinctiveContextFiles: [],
    hook: null,
  },
  byok: {
    systemPrompt: { delivery: "native-role", evidence: "electron/runtime/byok.ts sends a real system role message" },
    resume: {
      kind: "none",
      evidence: "provider HTTP APIs are stateless — there is no session to resume; the runner resends compressed history every turn (structural, will not change with versions)",
    },
    image: { kind: "native-inline", evidence: "multimodal content parts on the provider API" },
    commandSurfaces: [],
    transcript: null,
    distinctiveContextFiles: [],
    hook: null, // our in-process loop is the chokepoint — no external CLI to hook.
  },
  ollama: {
    systemPrompt: { delivery: "native-role", evidence: "electron/runtime/ollama.ts sends a system role message" },
    resume: { kind: "none", evidence: "stateless local HTTP API (structural)" },
    image: { kind: "native-inline", evidence: "multimodal content parts" },
    commandSurfaces: [],
    transcript: null,
    distinctiveContextFiles: [],
    hook: null, // in-process loop (local-tool-loop.ts) is the chokepoint.
  },
  lmstudio: {
    systemPrompt: { delivery: "native-role", evidence: "same OpenAI-compatible path as ollama" },
    resume: { kind: "none", evidence: "stateless local HTTP API (structural)" },
    image: { kind: "native-inline", evidence: "multimodal content parts" },
    commandSurfaces: [],
    transcript: null,
    distinctiveContextFiles: [],
    hook: null,
  },
  mlx: {
    systemPrompt: { delivery: "native-role", evidence: "same OpenAI-compatible path as ollama" },
    resume: { kind: "none", evidence: "stateless local HTTP API (structural)" },
    image: { kind: "native-inline", evidence: "multimodal content parts" },
    commandSurfaces: [],
    transcript: null,
    distinctiveContextFiles: [],
    hook: null,
  },
  agentlas: {
    systemPrompt: { delivery: "native-role", evidence: "electron/runtime/agentlas-serving.ts sends the system prompt as its own field" },
    resume: { kind: "none", evidence: "each turn carries its history; the server holds no session (structural)" },
    image: { kind: "none", evidence: "the serving endpoint takes text turns only" },
    commandSurfaces: [],
    transcript: null,
    distinctiveContextFiles: [],
    hook: null, // 도구 관문은 호스트의 도구 고리에 있다.
  },
};

/** 명령 표면이 있는 런타임만 (스캐너 소비용). */
export const COMMAND_SURFACE_RUNTIMES: readonly RuntimeKind[] = (
  Object.keys(RUNTIME_CAPABILITIES) as RuntimeKind[]
).filter((kind) => RUNTIME_CAPABILITIES[kind].commandSurfaces.length > 0);

/**
 * 이 런타임이 최종 답의 형태를 **강제**할 수 있는가, 어떤 통로로.
 *
 * 실측 2026-08-19: claude `--json-schema <schema>`, grok `--json-schema <SCHEMA>`,
 * agy `--json-schema`(문자열 또는 파일 경로), codex `--output-schema <FILE>`.
 * ACP 경유(cursor·kimi·copilot)는 프로토콜에 그 칸이 없고, OpenAI 호환 로컬 런타임은
 * 플래그가 아니라 요청 본문의 `response_format` 으로 제약 디코딩을 건다.
 *
 * `null` 은 "강제 못 함" — 러너가 지시문 폴백을 쓰고 그 사실을 상태줄에 남긴다.
 * 조용히 무시하면 소비자는 계약이 지켜진 줄 알고 파싱하다 빈손이 된다.
 */
export type SchemaOutputDelivery =
  /** 스키마 JSON 을 인자로 직접 넘긴다. */
  | { via: "flag-inline"; flag: string }
  /** 스키마를 파일로 쓰고 그 경로를 넘긴다. */
  | { via: "flag-file"; flag: string }
  /** 요청 본문의 response_format(json_schema) — 제약 디코딩. */
  | { via: "response-format" };

export const RUNTIME_SCHEMA_OUTPUT: Record<RuntimeKind, SchemaOutputDelivery | null> = {
  "claude-code": { via: "flag-inline", flag: "--json-schema" },
  grok: { via: "flag-inline", flag: "--json-schema" },
  antigravity: { via: "flag-inline", flag: "--json-schema" },
  codex: { via: "flag-file", flag: "--output-schema" },
  // ACP 에는 구조화 출력 칸이 없다(v1 스키마 확인). 어댑터가 대신 채워 줄 수도 없다.
  cursor: null,
  kimi: null,
  acp: null,
  // OpenAI 호환 본문을 우리가 직접 만든다 — 여기가 제약 디코딩이 가장 확실한 곳이다.
  byok: { via: "response-format" },
  ollama: { via: "response-format" },
  lmstudio: { via: "response-format" },
  mlx: { via: "response-format" },
  // 서빙은 우리 서버가 본문을 만든다. 지금 창구는 대화 텍스트만 주고받는다.
  agentlas: null,
};

/**
 * 스키마를 강제할 수 없는 런타임에 붙이는 지시문 폴백. 계약을 지킬 **의무**를
 * 말로 전할 뿐이라 깨질 수 있고, 그래서 러너는 이걸 쓸 때 상태줄에 남긴다.
 */
export function schemaFallbackInstruction(schema: Record<string, unknown>): string {
  return [
    "",
    "[OUTPUT CONTRACT]",
    "Your final message must be exactly one JSON document matching this schema,",
    "with no prose, no explanation, and no code fence around it:",
    JSON.stringify(schema),
    "[/OUTPUT CONTRACT]",
  ].join("\n");
}
