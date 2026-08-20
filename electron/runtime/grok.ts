// Grok CLI text runtime — official xAI CLI (`x.ai/cli`, verified with grok 0.2.x).
// Headless contract: --prompt-file + --cwd + --output-format streaming-json.
// Authentication is normally OAuth (`grok login`); XAI/GROK_API_KEY remains a supported fallback.
import path from "node:path";
import { announceToolDenied } from "./tool-approval";
import { detectApprovalRequired } from "./runtime-refusal";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { ensureChildCloseAfterExit, startCliHeartbeat } from "./runner";
import { cumulativeSurfaceGateText, wrapSystemPrompt } from "./runner";
import { CLI_HISTORY_CONTEXT_TOKENS, composeResumeTurnPrompt, renderConversationContext } from "./continuity";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { agentRunCwd, detachedSpawnOpts, firstExistingCli, killCliTree, probeCliVersion, spawnCli, trackRunChild } from "./exec";
import { readEnvVar } from "../secrets/vault";
import { clearProviderHealth, recordProviderHealth } from "../usage/provider-health";
import { invalidateUsage } from "../usage";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import { StringDecoder } from "node:string_decoder";
import { parseGrokModels, type DiscoveryOutcome } from "../../shared/model-discovery";
import { settleDiscovery } from "./model-discovery-store";

/**
 * 중지 사유를 그대로 전한다. 중지는 사람이 누른 것 외에도 무활동 워치독·단계 시간 초과·
 * 예산 소진으로 일어난다. 예전엔 전부 "사용자가 정지 버튼으로"라고 단정해,
 * 누른 적 없는 사람이 거짓 사유를 받았다(실사용 실측).
 */

const KIND = "grok";

const CANDIDATES = [
  // Windows: `.cmd`/`.exe`를 bare `grok`보다 먼저(bare는 PATHEXT 해석 시 `.ps1`을 잡아 막힐 수 있음).
  ...(process.platform === "win32"
    ? [
        "grok.cmd",
        "grok.exe",
        path.join(process.env.APPDATA ?? "", "npm", "grok.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "grok.cmd"),
        path.join(os.homedir(), ".local", "bin", "grok.exe"),
      ]
    : []),
  path.join(os.homedir(), ".grok/bin/grok"), // 공식 install.sh 기본 설치 경로
  path.join(os.homedir(), ".local/bin/grok"),
  "grok",
  "/opt/homebrew/bin/grok",
  "/usr/local/bin/grok",
  path.join(os.homedir(), ".bun/bin/grok"), // legacy compatibility; official paths above win
];

function grokCandidates(): string[] {
  const override = process.env.AGENTLAS_GROK_BIN?.trim();
  return override ? [override, ...CANDIDATES] : CANDIDATES;
}

/**
 * ★`--no-subagents`(grok --help: "Disable subagent spawning")는 2026-07-11 b3627aee의
 * 플래그 시그니처 이행(`--prompt`→`--prompt-file` 등) 안에서 사유 없이 함께 들어왔다.
 * 커밋 메시지·코드·주석 어디에도 이유가 없고, 이를 정당화할 실측 기록도 남아 있지 않다.
 * 이유를 복원할 수 없는 강제는 강제로 둘 근거가 없으므로 **기본값은 벤더 동작**
 * (서브에이전트 허용)으로 되돌리고, 끄는 길은 남겨 둔다:
 *   AGENTLAS_GROK_SUBAGENTS=0|off|false  → `--no-subagents`
 * 병렬 워커가 실제로 해를 끼치는 실측이 다시 나오면, 그 관측을 여기 적고 기본값을 뒤집을 것.
 */
export function grokSubagentsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AGENTLAS_GROK_SUBAGENTS ?? "").trim().toLowerCase();
  return raw === "0" || raw === "off" || raw === "false" || raw === "no";
}

interface GrokMcpServerConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** `grok mcp add/remove` 한 번을 실행하고 종료를 기다린다(리컨실 전용, 단발성). */
async function runGrokMcpCli(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, { stdio: ["ignore", "ignore", "pipe"], env, cwd });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let stderr = "";
    const grokStderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += grokStderrDecoder.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`grok ${args.slice(0, 2).join(" ")} exit ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`));
    });
  });
}

/**
 * Claude Code의 `--mcp-config <path>`와 달리 grok CLI는 MCP 서버를
 * `~/.grok/config.toml` 또는 `./.grok/config.toml`에 등록하는 방식이다
 * (`grok mcp add/remove`, 확인됨: stdio/http/sse 전부 지원). 이 실행 한 번만을 위해
 * 승인된 서버를 프로젝트 스코프(cwd 기준 `./.grok/config.toml`)에 등록하고, 실행이
 * 끝나면 반드시 제거한다 — 다른 빌드/채팅의 grok 실행에 남아있지 않도록.
 */
async function reconcileGrokMcpServers(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  mcpConfigPath: string | undefined,
): Promise<{ cleanup: () => Promise<void> }> {
  const noop = { cleanup: async () => {} };
  if (!mcpConfigPath) return noop;
  let parsed: { mcpServers?: Record<string, GrokMcpServerConfigEntry> };
  try {
    parsed = JSON.parse(await fs.readFile(mcpConfigPath, "utf8"));
  } catch {
    return noop;
  }
  const entries = Object.entries(parsed.mcpServers ?? {});
  if (entries.length === 0) return noop;

  const added: string[] = [];
  for (const [key, server] of entries) {
    try {
      if (server.command) {
        const args = ["mcp", "add", "--scope", "project"];
        for (const [k, v] of Object.entries(server.env ?? {})) args.push("-e", `${k}=${v}`);
        args.push(key, "--", server.command, ...(server.args ?? []));
        await runGrokMcpCli(bin, args, cwd, env);
      } else if (server.url) {
        const transport = server.url.startsWith("http://") || server.url.startsWith("https://") ? "http" : "sse";
        const args = ["mcp", "add", "--scope", "project", "--transport", transport, key, server.url];
        for (const [h, v] of Object.entries(server.headers ?? {})) args.push("--header", `${h}: ${v}`);
        await runGrokMcpCli(bin, args, cwd, env);
      } else {
        continue;
      }
      added.push(key);
    } catch (err) {
      console.error(`[grok] mcp add failed for "${key}":`, err);
    }
  }
  return {
    cleanup: async () => {
      for (const key of added) {
        try {
          await runGrokMcpCli(bin, ["mcp", "remove", "--scope", "project", key], cwd, env);
        } catch (err) {
          console.error(`[grok] mcp remove failed for "${key}":`, err);
        }
      }
    },
  };
}

// grok-cli는 GROK_API_KEY를 읽는다. 앱은 같은 키를 XAI_API_KEY로 저장하므로 둘 다 채워준다.
function grokEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  const key = env.GROK_API_KEY || env.XAI_API_KEY;
  if (key) {
    env.GROK_API_KEY = key;
    env.XAI_API_KEY = key;
  }
  return env;
}

// `grok models` → DiscoveryOutcome (PRD 2026-08-15 D-1). 파싱은 shared/model-discovery.ts
// (parseGrokModels: 글머리표 `  * grok-4.6 (default)` 우선, 없으면 grok-* 토큰). 실패는
// []가 아니라 `failed`로 돌려주고, 마지막 성공 목록이 있으면 stale로 채운다.
function listGrokModels(bin: string): Promise<DiscoveryOutcome> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (input: { timedOut?: boolean; exitCode?: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(settleDiscovery("grok", { stdout: out, models: parseGrokModels(out), source: "cli", ...input }));
    };
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, ["models"], { stdio: ["ignore", "pipe", "ignore"], env: grokEnv(process.env) });
    } catch {
      resolve(settleDiscovery("grok", { stdout: "", models: [], exitCode: null, source: "cli" }));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ timedOut: parseGrokModels(out).length === 0 });
    }, 5000);
    const outDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (c: Buffer) => (out += outDecoder.write(c)));
    child.on("error", () => {
      child.stdout?.removeAllListeners("data");
      finish({ exitCode: null });
    });
    child.on("close", (code) => {
      child.stdout?.removeAllListeners("data");
      finish({ exitCode: code });
    });
  });
}

export interface GrokProbe {
  path: string;
  version: string;
  /** `grok models` 라이브 목록(실패 시 마지막 성공 목록, discovery.stale 참고). */
  models: string[];
  discovery: DiscoveryOutcome;
}

export async function probeGrok(): Promise<GrokProbe | null> {
  const found = await firstExistingCli(grokCandidates());
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  const discovery = await listGrokModels(found).catch(
    (err): DiscoveryOutcome => ({ status: "failed", models: [], rawLineCount: 0, reason: `spawn-error:${err instanceof Error ? err.message : String(err)}`, source: "cli" }),
  );
  return { path: found, version, models: discovery.models, discovery };
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const found = await firstExistingCli(grokCandidates());
  cachedBin = found;
  return cachedBin;
}

/**
 * ★시스템 프롬프트는 가능하면 **진짜 system 역할**로 넘긴다 — 실측 2026-08-18
 * (grok 1.0.5 help): `--system-prompt-override <PROMPT>` (compat alias
 * --system-prompt). 인라인([SYSTEM] 블록을 유저 프롬프트에 이어붙이기)은
 * (1) 접두사가 매 턴 달라져 프롬프트 캐시를 깨고 (2) 시스템/유저 경계가 흐려져
 * 지시 이행이 약해진다.
 *
 * 단 argv 는 로컬 process listing 에 노출되고 Windows 명령줄 한계(~32KB)가 있다 —
 * 프롬프트 파일을 쓰는 이유가 그것이었다. 그래서 한도 안에서만 플래그를 쓰고,
 * 넘으면 기존 인라인으로 정직하게 폴백한다(조용한 잘림 금지).
 */
export const GROK_SYSTEM_ARGV_LIMIT = 24_000;

function buildSystemText(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(
    req.systemPrompt,
    req.locale,
    req.permission,
    cumulativeSurfaceGateText(req.history, req.userPrompt),
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
  );
  const turnContext = req.turnContext?.trim();
  return `${sys}${turnContext ? `\n\n${turnContext}` : ""}`;
}

function buildPrompt(req: RunnerRequest, systemViaFlag: boolean): string {
  // 세션 미지원 러너 — 매 턴 히스토리를 연속성 프레이밍+압축과 함께 재주입한다.
  const parts: string[] = systemViaFlag ? [] : [`[SYSTEM]\n${buildSystemText(req)}`, ""];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, CLI_HISTORY_CONTEXT_TOKENS);
    parts.push(block, "");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

type GrokEvent = {
  type?: string;
  event?: string;
  text?: string;
  content?: string;
  delta?: string;
  name?: string;
  step?: string;
  title?: string;
  status?: string;
  tool?: string;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  parameters?: unknown;
  output?: unknown;
  result?: unknown;
  id?: string;
  error?: unknown;
  is_error?: boolean;
  message?: string;
  data?: unknown;
  stopReason?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  usage?: { output_tokens?: number; completion_tokens?: number };
  tokens?: number;
};

export function isGrokQuotaExhausted(value: string): boolean {
  const text = String(value ?? "");
  return (
    /usage balance exhausted|grok build[^\n]{0,120}balance exhausted/i.test(text) ||
    (/\b402\b/.test(text) && /payment required|usage balance|balance exhausted/i.test(text))
  );
}

export const runGrok: Runner = async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
  /*
   * ★판정(untrustedNoTools)은 grok 으로도 수행한다 — 단, Agent App 의 무상태 격리는 계속 거절한다.
   *
   * 이 거절의 사유는 "grok 이 대화 기록을 로컬에 저장한다"였는데, 그 문장은 **Agent App**
   * (사용자 대신 앱이 도는 무상태 실행)에는 맞지만 **판정**에는 과했다. 판정은 사용자가 이미
   * 가진 텍스트를 라벨 하나로 분류하는 일이고, 그것까지 막으면 grok 만 쓰는 사용자는 제품의
   * 모든 검증이 죽는다 — 자동화가 산출물을 정확히 만들어도 마지막 채점에서 EVAL_UNAVAILABLE 로
   * 떨어져 실행 전체가 error 가 된다(같은 병을 agy 에서 실측했다, 2026-08-19).
   *
   * 정말 되는지부터 확인했다: `--deny "*"` 로 도구를 끄고 채점표 프롬프트를 주자 grok 이
   * 도구를 못 쓴다는 것을 스스로 인지하고("All tools are denied") 규격 JSON 을 정확히 냈다.
   * 반면 `--disallowed-tools` 만으로는 파일을 찾아다녔다 — 그래서 아래 인자는 deny 규칙이다.
   *
   * Agent App 경계(agentAppMode)는 그대로 거절한다: 거기서 문제는 도구가 아니라 세션 영속이다.
   */
  if (req.untrustedNoTools && !req.judgmentOnly) {
    throw new Error(
      req.locale === "ko"
        ? "Grok CLI는 대화 기록을 로컬에 자동 저장하므로 Agent App의 무상태 격리 모드에서 사용할 수 없습니다. Claude Code, Ollama 또는 API 런타임을 선택하세요."
        : "Grok CLI automatically persists conversation history, so it cannot be used for Agent App's stateless isolation. Select Claude Code, Ollama, or an API runtime.",
    );
  }
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Grok is not enabled for restricted read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  const bin = await getBin();
  if (!bin) throw new Error(tStatus(req.locale, "errCliMissingGrok"));
  // Nested function declarations don't inherit outer const-narrowing in TS —
  // re-bind to a definitely-non-null local for use inside runGrokProcess().
  const grokBin: string = bin;

  const fingerprint = req.chatId
    ? createHash("sha256")
        .update("grok-session-v1\0")
        .update(req.sessionFingerprintSeed ?? req.systemPrompt ?? "")
        .update("\0")
        .update(req.model ?? "")
        .digest("hex")
    : null;
  const savedSession = req.chatId ? getRuntimeSession(req.chatId, KIND) : null;
  const storedSessionId = savedSession && fingerprint && savedSession.fingerprint === fingerprint ? savedSession.sessionId : null;
  const resumeSessionId = req.runtimeSessionId ?? storedSessionId;
  // 새 세션에서만 시스템을 플래그로 승격한다 — resume 턴은 세션이 이미 시스템을 안다.
  const systemText = resumeSessionId ? null : buildSystemText(req);
  const systemViaFlag = systemText != null && systemText.length <= GROK_SYSTEM_ARGV_LIMIT;
  const prompt = resumeSessionId
    ? composeResumeTurnPrompt(req.userPrompt, req.turnContext ?? "", req.locale)
    : buildPrompt(req, systemViaFlag);

  events.onStatus(resumeSessionId
    ? (req.locale === "ko" ? "Grok 세션 이어가는 중..." : "Resuming the Grok session...")
    : tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const cwd = req.cwd ?? agentRunCwd();
  const env = grokEnv(req.env ?? process.env);
  if (!env.GROK_API_KEY && !env.XAI_API_KEY) {
    const key = (await readEnvVar("GROK_API_KEY")) || (await readEnvVar("XAI_API_KEY"));
    if (key) {
      env.GROK_API_KEY = key;
      env.XAI_API_KEY = key;
    }
  }
  // Prompt files keep system/history text out of argv/process listings and avoid Windows command-line limits.
  const promptFile = path.join(os.tmpdir(), `agentlas-grok-${process.pid}-${randomUUID()}.txt`);
  await fs.writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
  const args = ["--prompt-file", promptFile, "--cwd", cwd, "--output-format", "streaming-json"];
  if (systemViaFlag && systemText) args.push("--system-prompt-override", systemText);
  // 출력 형태 계약 — 지원 런타임은 플래그로 강제한다(실측 grok 1.0.5 `--json-schema`).
  if (req.outputSchema) args.push("--json-schema", JSON.stringify(req.outputSchema.schema));
  /*
   * ★`--plugin-dir` 은 여기 없다. 실측 2026-08-19(grok 1.0.5): 최상위 `grok` 에 붙이면
   * `unexpected argument '--plugin-dir'` 로 실행이 아예 안 뜨고, 프로젝트 스코프
   * `./.grok/config.toml` 의 훅은 이 헤드리스 경로에서 **발화하지 않았다**(훅 0회,
   * 파일은 생성됨). 이 플래그는 `grok agent` 하위 명령 전용이고, 그쪽이 우리의
   * 실제 실행 경로다(ACP_PREFERRED_KINDS → electron/runtime/acp.ts). 배선은 거기 있다.
   */
  if (grokSubagentsDisabled(env)) args.push("--no-subagents");
  if (resumeSessionId) args.unshift("--resume", resumeSessionId);
  if (req.model) args.push("-m", req.model); // grok --help 확인: -m, --model <model>
  if (req.effort) args.push("--effort", req.effort);
  if (!req.untrustedNoTools && req.permission === "full") args.push("--permission-mode", "bypassPermissions");
  else if (!req.untrustedNoTools && req.permission === "write") {
    // ★오너 결정(2026-08-15) — 헤드리스는 답할 사람이 없으니 권한 범위 안의 도구는
    // 처음부터 풀어 둔다(claude 형제 규칙: acceptEdits 는 셸·웹을 여전히 묻는다).
    // grok --help 실측: `--allow <RULE>` (compat alias: --allowedTools).
    // judgment-exempt: 위 claude 와 같다 — grok CLI 에 넘길 --allow **열거** 목록이지
    //   관측된 호출의 분류가 아니다.
    args.push("--permission-mode", "acceptEdits", "--allow", "Bash", "--allow", "WebFetch", "--allow", "WebSearch");
  }
  if (req.untrustedNoTools) {
    // ★도구 0개는 선언이 아니라 인자로 만든다. 실측 2026-08-19: `--disallowed-tools` 로
    //   이름을 열거하면 grok 이 여전히 파일을 찾아다녔고, `--deny "*"` 를 주자 스스로
    //   "All tools are denied" 를 인지하고 근거만으로 규격 JSON 판정을 냈다.
    args.push("--deny", "*", "--disable-web-search");
  }

  const truncate = (s: string, max = 12000): string => (s.length > max ? `${s.slice(0, max)}…` : s);
  const stringify = (v: unknown): string => {
    try {
      return typeof v === "string" ? v : JSON.stringify(v ?? "", null, 2);
    } catch {
      return String(v ?? "");
    }
  };

  const mcpReconcile = await reconcileGrokMcpServers(bin, cwd, env, req.mcpConfigPath);
  try {
    return await runGrokProcess();
  } finally {
    await mcpReconcile.cleanup();
  }

  function runGrokProcess(): Promise<RunnerResult> {
    return new Promise<RunnerResult>((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(grokBin, args, { stdio: ["ignore", "pipe", "pipe"], env, cwd, ...detachedSpawnOpts() });
    } catch (e) {
      void fs.rm(promptFile, { force: true });
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    trackRunChild(child);
    // ★자식이 죽었는데 close 가 안 오면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    //   형제 러너(agy·claude·codex)에만 붙어 있던 계약을 여기에도 세운다.
    const stopHeartbeat = startCliHeartbeat(child, events.onStatus, "grok");
    ensureChildCloseAfterExit(child, () => {
      events.onStatus("grok: process exited without closing its output — settling the run");
    });

    const onAbort = () => killCliTree(child);
    if (req.signal) {
      if (req.signal.aborted) killCliTree(child);
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let buffer = "";
    let text = "";
    let stderr = "";
    let tokens: number | undefined;
    let lastEmit = 0;
    /** 같은 도구의 승인 거부를 한 번만 알린다. */
    const announcedGrokDenials = new Set<string>();
    let thoughtActive = false;
    let thoughtStartedAt = 0;
    let sessionId: string | undefined = resumeSessionId ?? undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const handle = (ev: GrokEvent): void => {
      const nested = ev.data && typeof ev.data === "object" ? ev.data as Record<string, unknown> : null;
      const eventSessionId = ev.sessionId ?? ev.session_id
        ?? (typeof nested?.sessionId === "string" ? nested.sessionId : undefined)
        ?? (typeof nested?.session_id === "string" ? nested.session_id : undefined);
      if (eventSessionId) sessionId = eventSessionId;
      const type = ev.type ?? ev.event;
      if (type === "thought") {
        // streaming-json exposes private reasoning deltas. Never render or persist them.
        // The span itself is a typed fact the timeline shows as "Thought for Ns".
        if (!thoughtActive) {
          events.onStatus(tStatus(req.locale, "thinking", { agent: req.backendLabel }));
          thoughtStartedAt = Date.now();
          events.onThinking?.("start");
        }
        thoughtActive = true;
      } else if (type === "text" || type === "assistant" || type === "message") {
        if (thoughtActive) events.onThinking?.("end", Date.now() - thoughtStartedAt);
        thoughtActive = false;
        const t = ev.text ?? ev.content ?? ev.delta ?? (typeof ev.data === "string" ? ev.data : "");
        if (typeof t === "string" && t) {
          text += t;
          const now = Date.now();
          if (now - lastEmit > 60) {
            events.onPartial(text);
            lastEmit = now;
          }
        }
      } else if (type === "step_start") {
        const s = ev.name ?? ev.step ?? ev.title ?? ev.status;
        if (s) events.onStatus(String(s));
      } else if (type === "tool_use" || type === "tool" || type === "tool_call" || type === "tool_start" || type === "tool_end") {
        if (thoughtActive) events.onThinking?.("end", Date.now() - thoughtStartedAt);
        thoughtActive = false;
        const data = ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : null;
        const name = ev.tool ?? ev.name ?? (typeof data?.name === "string" ? data.name : "tool");
        const argPayload = ev.input ?? ev.args ?? ev.arguments ?? ev.parameters ?? data?.input ?? data?.args;
        const resultPayload = ev.output ?? ev.result ?? data?.output ?? data?.result;
        const toolFailed = ev.error != null || ev.is_error === true;
        /*
         * ★형제 규칙 — grok 도 claude 와 같은 `--permission-mode` 를 받는다.
         * 즉 헤드리스에서 승인이 필요한 호출은 여기서도 자동 거부되고, 그 사유가
         * 도구 결과에 실려 온다. claude·agy 만 고치고 여기를 두면 같은 병이 남는다.
         */
        if (toolFailed) {
          const denialText = resultPayload == null ? "" : stringify(resultPayload);
          const blocked = detectApprovalRequired(denialText);
          if (blocked) {
            const key = blocked.blocked ?? blocked.message.slice(0, 120);
            if (!announcedGrokDenials.has(key)) {
              announcedGrokDenials.add(key);
              announceToolDenied({
                runtime: "grok",
                sessionKey: `grok:${req.chatId ?? req.cwd ?? "default"}`,
                tool: String(name),
                detail: blocked.blocked,
                cwd: req.cwd,
                deniedBy: "runtime-headless",
              });
            }
          }
        }
        events.onTool?.(
          String(name),
          argPayload == null ? undefined : truncate(stringify(argPayload), 2000),
          resultPayload == null ? undefined : truncate(stringify(resultPayload)),
          ev.id,
          toolFailed,
        );
      } else if (type === "step_finish" || type === "done" || type === "final" || type === "end") {
        if (thoughtActive) events.onThinking?.("end", Date.now() - thoughtStartedAt);
        thoughtActive = false;
        const fin = ev.text ?? ev.content ?? ev.output ?? (typeof ev.data === "string" ? ev.data : undefined);
        if (typeof fin === "string" && fin && !text) text = fin;
        const tk = ev.usage?.output_tokens ?? ev.usage?.completion_tokens ?? ev.tokens;
        if (typeof tk === "number") tokens = tk;
      } else if (type === "error") {
        stderr += `${ev.message ?? stringify(ev.error) ?? "grok error"}\n`;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line) as GrokEvent);
        } catch {
          // JSON이 아니면(--format json 미지원/plain 모드) 텍스트로 누적.
          text += (text ? "\n" : "") + line;
          events.onPartial(text);
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => {
      stopHeartbeat();
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      void fs.rm(promptFile, { force: true });
      reject(err);
    });
    child.on("close", (code) => {
      stopHeartbeat();
      buffer += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      void fs.rm(promptFile, { force: true });
      if (req.signal?.aborted) {
        reject(abortReasonError(req));
        return;
      }
      if (buffer.trim()) {
        const line = buffer.trim();
        try {
          handle(JSON.parse(line) as GrokEvent);
        } catch {
          text += (text ? "\n" : "") + line;
        }
      }
      // assistant text는 오류 증거가 아니다. streaming-json `type:error`와 실제 stderr만
      // handle()이 stderr에 모으므로, 답변이 같은 문구를 인용해도 상태를 오염시키지 않는다.
      if (code !== 0 && isGrokQuotaExhausted(stderr)) {
        recordProviderHealth("grok", "grok_quota_exhausted");
        invalidateUsage("grok");
        reject(
          new Error(
            req.locale === "ko"
              ? "Grok Build 사용량 잔액이 소진되었습니다(HTTP 402). Grok Settings > Usage에서 리셋 또는 추가 크레딧을 확인해 주세요."
              : "Grok Build usage balance is exhausted (HTTP 402). Check reset or extra credits in Grok Settings > Usage.",
          ),
        );
        return;
      }
      // 텍스트를 받았으면 비정상 종료여도 부분 성공으로 처리.
      if (code === 0 || text.trim()) {
        clearProviderHealth("grok");
        invalidateUsage("grok");
        if (req.chatId && fingerprint && sessionId) saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint);
        resolve({ text: text.trim(), tokens, sessionId });
        return;
      }
      reject(new Error(`grok CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`));
    });
  });
  }
};
