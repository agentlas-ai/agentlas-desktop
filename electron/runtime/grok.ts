import { selectionFor } from "../capabilities/one-capabilities";
import { GROK_RUN_MCP_REGISTRY, withForeignCliContext } from "./foreign-cli-context";
import { isAgentlasProductHome } from "./product-home-identity";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
// Grok CLI text runtime — official xAI CLI (`x.ai/cli`, verified with grok 0.2.x).
// Headless contract: --prompt-file + --cwd + --output-format streaming-json.
// Authentication is normally OAuth (`grok login`); XAI/GROK_API_KEY remains a supported fallback.
import path from "node:path";
import { announceToolDenied } from "./tool-approval";
import { detectApprovalRequired } from "./runtime-refusal";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { ensureChildCloseAfterExit, startCliHeartbeat, startCliSilenceGuard, runtimeSilentTimeoutFailure, runtimeProtocolUnrecognizedFailure, cliToolSilenceWindowMs, RuntimeTurnUnsettledError, preDispatchRefusal, runnerRefusedBeforeDispatch } from "./runner";
import { cumulativeSurfaceGateText, wrapSystemPrompt } from "./runner";
import { cliHistoryContextTokens, composeResumeTurnPrompt, renderConversationContext } from "./continuity";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { agentRunCwd, detachedSpawnOpts, firstExistingCli, killCliTree, probeCliVersion, spawnCli, trackRunChild } from "./exec";
import { nativeCliCandidates } from "./native-cli";
import { readEnvVar } from "../secrets/vault";
import { clearProviderHealth, recordProviderHealth } from "../usage/provider-health";
import { invalidateUsage } from "../usage";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import { StringDecoder } from "node:string_decoder";
import { parseGrokModels, type DiscoveryOutcome } from "../../shared/model-discovery";
import { settleDiscovery } from "./model-discovery-store";
import { normalEndToolEvidence, settleNormalEnd, trackReportedToolCalls } from "../../shared/turn-settlement";

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
  const native = nativeCliCandidates("grok");
  return override ? [override, ...native, ...CANDIDATES] : [...native, ...CANDIDATES];
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

/**
 * read 권한에서 grok 에게 주지 않는 도구 — claude 의 READ_ONLY_DENIED_TOOLS 와 같은 자리.
 * 이름은 grok 1.0.14 가 `available_commands` 로 광고한 실물 목록에서 왔다.
 * judgment-exempt: 관측된 이름을 분류하는 게 아니라 이 CLI 에 넘길 --deny **열거** 목록이다.
 */
export const GROK_READ_ONLY_DENIED_TOOLS = [
  // 실측 2026-09-07 (grok 1.0.14): `--deny` 는 **claude 호환 이름을 검증한다.**
  //   `--deny "NotebookEdit"` → `unsupported tool prefix: NotebookEdit` 로 exit 1.
  //   그 앞의 Bash·Write·Edit·MultiEdit 는 통과했다(파서가 순서대로 검증한다).
  //   반대로 grok 자기 내부 이름(`write`, `run_terminal_command` …)은 **조용히 먹히고
  //   아무것도 막지 못했다** — 도구 광고가 그대로였고 파일이 생겼다. 소문자 이름은
  //   셸 명령 규칙으로 해석되는 것으로 보인다.
  "Bash",
  "BashOutput",
  "KillShell",
  "Write",
  "Edit",
  "MultiEdit",
];

/**
 * 권한 칩 → grok 권한 플래그. **순수 함수다.**
 *
 * 모듈 밖으로 꺼내 둔 이유(2026-09-07): 설치된 CLI 로 이 벡터가 아직 통하는지 재는
 * 프로브(scripts/probe-runtime-permission-bypass.mjs)가 벡터를 **베끼지 않고** 이
 * 함수를 그대로 부르게 하기 위해서다. 사본을 두면 러너가 바뀌어도 프로브는 안 바뀌어,
 * 프로브만 초록이고 제품은 막히는 상태가 만들어진다.
 *
 * read 는 플래그를 주지 않는다 — claude 처럼 이름으로 도구를 빼는 자리는 아래
 * untrustedNoTools 경로(`--deny "*"`)가 따로 맡는다.
 */
export function grokPermissionArgs(
  permission: RunnerRequest["permission"],
  opts: { untrustedNoTools?: boolean } = {},
): string[] {
  if (opts.untrustedNoTools) return [];
  if (permission === "full") return ["--permission-mode", "bypassPermissions"];
  if (permission === "write") {
    // ★오너 결정(2026-08-15) — 헤드리스는 답할 사람이 없으니 권한 범위 안의 도구는
    // 처음부터 풀어 둔다(claude 형제 규칙: acceptEdits 는 셸·웹을 여전히 묻는다).
    // grok --help 실측: `--allow <RULE>` (compat alias: --allowedTools).
    // judgment-exempt: 위 claude 와 같다 — grok CLI 에 넘길 --allow **열거** 목록이지
    //   관측된 호출의 분류가 아니다.
    return ["--permission-mode", "acceptEdits", "--allow", "Bash", "--allow", "WebFetch", "--allow", "WebSearch"];
  }
  /*
   * ★read 는 "플래그 없음"이 아니다 — 그렇게 두었더니 경계가 거짓말이었다.
   *
   * 실측 2026-09-07 (grok 1.0.14, scripts/probe-runtime-permission-bypass.mjs --live):
   * 읽기 권한으로 파일 생성을 시켰더니 **그냥 만들었다.** 플래그가 없으면 grok 은
   * run_terminal_command · write · search_replace 를 전부 들고 시작한다. 옛 기록에는
   * grok 이 이 요청을 거절했다고 적혀 있지만(2026-08 claude-code.ts 주석), 지금 판은
   * 거절하지 않는다 — 벤더 기본값이 바뀐 것이고, 우리가 그것을 인식하지 못했다.
   *
   * claude 형제 규칙 그대로 **변경 수단을 이름으로 막는다.** 셸까지 막는 이유도 같다:
   * 셸을 열어 둔 채 "읽기 전용"이라고 말하면 그 경계는 거짓말이다.
   * MCP 도구(use_tool·search_tool)와 웹 읽기는 남긴다 — 오너 결정 2026-08-18(읽기 실행도
   * 승인된 MCP 는 쓴다). 읽기·검색·분석은 그대로 가능하다.
   *
   * ★아직 끝까지 재지 못했다 — 정직하게 적어 둔다. 이 이름들이 CLI 파서를 통과하는
   *   것까지는 확인했지만, 실제로 쓰기를 막는지는 그 측정 도중 grok 무료 한도에
   *   걸려(“You've reached your free Grok Build usage limit”) 확인하지 못했다.
   *   한도가 풀리면 이 한 줄로 끝난다:  npm run probe:permission-live
   *   (거기서 `DRIFT grok read` 가 뜨면 이름 목록이 아직 부족한 것이다.)
   *   그 사이에도 플래그 없음보다는 낫다 — 플래그 없음은 파일 생성이 **재현되는**
   *   상태였다. 후보 둘은 이미 탈락했다: grok 내부 소문자 이름은 무효였고,
   *   `--permission-mode plan` 은 같은 조건에서 만들기도 하고 안 만들기도 했다(비결정적).
   */
  return GROK_READ_ONLY_DENIED_TOOLS.flatMap((tool) => ["--deny", tool]);
}

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











 */
interface GrokRunMcpRegistry { [key: string]: { runs: number; digest: string } }
let grokMcpMutationTail: Promise<void> = Promise.resolve();
async function withGrokMcpLock<T>(action: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = grokMcpMutationTail;
  grokMcpMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await action(); } finally { release(); }
}
async function readGrokRunMcpRegistry(home: string): Promise<GrokRunMcpRegistry> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(home, GROK_RUN_MCP_REGISTRY), "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as GrokRunMcpRegistry : {};
  } catch { return {}; }
}
async function writeGrokRunMcpRegistry(home: string, registry: GrokRunMcpRegistry): Promise<void> {
  const at = path.join(home, GROK_RUN_MCP_REGISTRY);
  const tmp = `${at}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  await fs.rename(tmp, at);
}

export async function reconcileGrokMcpServers(
  bin: string,
  _cwd: string,
  env: NodeJS.ProcessEnv,
  mcpConfigPath: string | undefined,
  onStatus: (message: string) => void = () => {},
): Promise<{ cleanup: () => Promise<void>; failure?: RunnerFailure }> {
  const noop = { cleanup: async () => {} };
  if (!mcpConfigPath) return noop;
  let parsed: { mcpServers?: Record<string, GrokMcpServerConfigEntry> };
  try {
    parsed = JSON.parse(await fs.readFile(mcpConfigPath, "utf8"));
  } catch {
    return noop;
  }
  const entries = Object.entries(parsed.mcpServers ?? {}).filter(([, server]) => server.command || server.url);
  if (entries.length === 0) return noop;
  const home = env.GROK_HOME;
  if (!home || !isAgentlasProductHome(home)) {
    onStatus("[grok-mcp] refused: no product GROK_HOME; the run's MCP servers are never written into the project or ~/.grok");
    return { ...noop, failure: { kind: "unavailable", runtime: "grok", source: "marker", providerCode: "grok_mcp_product_home_unavailable",
      message: "Grok's MCP servers need its product home, which is unavailable here; the run was not started." } };
  }
  // `mcp add/remove` run in the mirror itself, so even a CLI that ignored --scope could not write the work folder.
  const cli = (args: string[]) => runGrokMcpCli(bin, args, home, env);
  const digestOf = (server: GrokMcpServerConfigEntry) => createHash("sha256").update(JSON.stringify(server)).digest("hex");
  const claimed: string[] = [];
  const release = async () => withGrokMcpLock(async () => {
    const registry = await readGrokRunMcpRegistry(home);
    for (const key of claimed.splice(0)) {
      const row = registry[key];
      if (!row) continue;
      if (row.runs > 1) { row.runs -= 1; continue; }
      try { await cli(["mcp", "remove", "--scope", "user", key]); }
      catch (err) { console.error(`[grok] mcp remove failed for "${key}":`, err); }
      delete registry[key];
    }
    await writeGrokRunMcpRegistry(home, registry);
  });
  const busy = await withGrokMcpLock(async (): Promise<string | null> => {
    const registry = await readGrokRunMcpRegistry(home);
    for (const [key] of entries) if (registry[key] && registry[key].digest !== digestOf(parsed.mcpServers![key]!)) return key;
    for (const [key, server] of entries) {
      const digest = digestOf(server);
      if (registry[key]) { registry[key].runs += 1; claimed.push(key); continue; }
      try {
        if (server.command) {
          const args = ["mcp", "add", "--scope", "user"];
          for (const [k, v] of Object.entries(server.env ?? {})) args.push("-e", `${k}=${v}`);
          args.push(key, "--", server.command, ...(server.args ?? []));
          await cli(args);
        } else if (server.url) {
          const transport = server.url.startsWith("http://") || server.url.startsWith("https://") ? "http" : "sse";
          const args = ["mcp", "add", "--scope", "user", "--transport", transport, key, server.url];
          for (const [h, v] of Object.entries(server.headers ?? {})) args.push("--header", `${h}: ${v}`);
          await cli(args);
        }
        registry[key] = { runs: 1, digest };
        claimed.push(key);
      } catch (err) {
        console.error(`[grok] mcp add failed for "${key}":`, err);
      }
    }
    await writeGrokRunMcpRegistry(home, registry);
    return null;
  });
  if (busy) {
    onStatus(`[grok-mcp] refused: ${busy} is held by another run with a different entry`);
    return { ...noop, failure: { kind: "refused", runtime: "grok", source: "marker", providerCode: "grok_mcp_scope_busy",
      message: "Another Grok run holds the same MCP server key with a different entry; this run was not started." } };
  }
  return { cleanup: release };
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









export const GROK_MODEL_DISCOVERY_FRESH_MS = 10 * 60_000;
export const GROK_MODEL_DISCOVERY_FAILED_RETRY_MS = 60_000;
let grokModelsCache: { binary: string; at: number; outcome: DiscoveryOutcome; version: string } | null = null;
let grokModelsFlight: { binary: string; promise: Promise<{ outcome: DiscoveryOutcome; version: string }> } | null = null;

/** Runtime replaced or signed in again: keep the value, refresh it on the next detection. */
export function invalidateGrokModelDiscovery(): void {
  if (grokModelsCache) grokModelsCache = { ...grokModelsCache, at: 0 };
}

export function cachedGrokModelDiscovery(
  binary: string,
  probe: (binary: string) => Promise<{ outcome: DiscoveryOutcome; version: string }>,
  now: number = Date.now(),
): Promise<{ outcome: DiscoveryOutcome; version: string }> {
  const refresh = (): Promise<{ outcome: DiscoveryOutcome; version: string }> => {
    if (grokModelsFlight?.binary === binary) return grokModelsFlight.promise;
    const promise = probe(binary)
      .then((value) => {
        grokModelsCache = { binary, at: Date.now(), ...value };
        return value;
      })
      .finally(() => { if (grokModelsFlight?.promise === promise) grokModelsFlight = null; });
    grokModelsFlight = { binary, promise };
    return promise;
  };
  const cached = grokModelsCache?.binary === binary ? grokModelsCache : null;
  if (!cached) return refresh();
  const ttl = cached.outcome.status === "ok" ? GROK_MODEL_DISCOVERY_FRESH_MS : GROK_MODEL_DISCOVERY_FAILED_RETRY_MS;
  if (now - cached.at >= ttl) void refresh().catch(() => undefined);
  return Promise.resolve({ outcome: cached.outcome, version: cached.version });
}

async function probeGrokModelsAndVersion(found: string): Promise<{ outcome: DiscoveryOutcome; version: string }> {
  const version = (await probeCliVersion(found)) ?? "unknown";
  const outcome = await listGrokModels(found).catch(
    (err): DiscoveryOutcome => ({ status: "failed", models: [], rawLineCount: 0, reason: `spawn-error:${err instanceof Error ? err.message : String(err)}`, source: "cli" }),
  );
  return { outcome, version };
}

export async function probeGrok(): Promise<GrokProbe | null> {
  const found = await firstExistingCli(grokCandidates());
  if (!found) return null;
  const { outcome: discovery, version } = await cachedGrokModelDiscovery(found, probeGrokModelsAndVersion);
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
    undefined,
    undefined,
    undefined,
    req.surfaceGate,
    KIND,
    req.sciencePromptProfile,
    req.judgmentOnly === true ? "host-judgment" : undefined,
      undefined,
      req.systemPromptComposition,
      req.unattendedNoAsk,
  );
  const turnContext = req.turnContext?.trim();
  return `${sys}${turnContext ? `\n\n${turnContext}` : ""}`;
}

function buildPrompt(req: RunnerRequest, systemViaFlag: boolean): string {
  // 세션 미지원 러너 — 매 턴 히스토리를 연속성 프레이밍+압축과 함께 재주입한다.
  const parts: string[] = systemViaFlag ? [] : [`[SYSTEM]\n${buildSystemText(req)}`, ""];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, cliHistoryContextTokens(KIND, req.model));
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

/**
 * True when a streaming-json line is a protocol event this adapter understands: a known `type`/`event` whose payload has
 * the documented type (text-bearing events carry a string, `end` carries a string stopReason). Wrong-shape JSON is not one.
 */
export function grokEventRecognized(ev: unknown): boolean {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
  const e = ev as GrokEvent;
  const type = e.type ?? e.event;
  switch (type) {
    case "text": case "assistant": case "message":
      return [e.text, e.content, e.delta, e.data].some((v) => typeof v === "string");
    case "end":
      return e.stopReason === undefined || typeof e.stopReason === "string";
    case "thought": case "step_start": case "step_finish": case "done": case "final": case "error":
    case "tool_use": case "tool": case "tool_call": case "tool_start": case "tool_end":
      return true;
    default:
      return false;
  }
}

export function isGrokQuotaExhausted(value: string): boolean {
  const text = String(value ?? "");
  return (
    /usage balance exhausted|grok build[^\n]{0,120}balance exhausted/i.test(text) ||
    (/\b402\b/.test(text) && /payment required|usage balance|balance exhausted/i.test(text))
  );
}

/**
 * Every throw before the headless grok turn starts is a refusal before dispatch (RuntimeTurnDelivery "not-dispatched",
 * runner.ts preDispatchRefusal keeps the innermost machine code): the Agent App and restricted-read boundaries, the
 * native-browser boundary, a missing binary, the MCP reconcile. Same rule as the ACP lane (acp.ts) for this legacy driver.
 */
export const runGrok: Runner = async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
  const dispatch = { started: false };
  try {
    return await runGrokTurn(req, events, dispatch);
  } catch (error) {
    if (dispatch.started || req.signal?.aborted || runnerRefusedBeforeDispatch(error)) throw error;
    throw preDispatchRefusal(error, "grok-prepare", "grok_pre_dispatch_refused");
  }
};

async function runGrokTurn(req: RunnerRequest, events: RunnerEvents, dispatch: { started: boolean }): Promise<RunnerResult> {
  // Tool-call evidence of this turn for the shared normal-end rule (R-065).
  const toolEvidence = trackReportedToolCalls(events);
  events = toolEvidence.events;
  if (assertScienceRecoveryRequest(req, "grok"))
    throw new Error("science_recovery_acp_transport_required");
  if (req.env?.AGENTLAS_NATIVE_BROWSER_SCOPE === "task") {
    // This legacy driver cannot bind the exact per-run native browser safely.
    // The supported ACP path carries the Main-approved session configuration.
    throw Object.assign(new Error("native_browser_requires_acp_transport"), {
      code: "native-browser-legacy-transport-unsupported",
    });
  }

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
        // The system `ask:` module is left out for RunnerRequest.unattendedNoAsk (team workers): a thread seeded with it is another conversation.
        .update(!req.sessionFingerprintSeed && req.unattendedNoAsk ? "\0unattended-no-ask" : "")
        .update("\0")
        .digest("hex")
    : null;
  const runtimeSessionOwnerId = req.runtimeSessionOwnerId ?? req.agentId;
  const isolateRuntimeSessionOwner = req.runtimeSessionOwnerId != null;
  const savedSession = req.chatId
    ? getRuntimeSession(req.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
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
  const env = grokEnv(withForeignCliContext("grok", req.env ?? process.env, selectionFor(req.agentId, undefined, req.chatId)));
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
  args.push(...grokPermissionArgs(req.permission, { untrustedNoTools: Boolean(req.untrustedNoTools) }));
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

  const mcpReconcile = await reconcileGrokMcpServers(bin, cwd, env, req.mcpConfigPath, events.onStatus);
  if (mcpReconcile.failure) {
    void fs.rm(promptFile, { force: true });
    return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: mcpReconcile.failure };
  }
  try {
    dispatch.started = true;
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
    const stopHeartbeatOnly = startCliHeartbeat(child, events.onStatus, "grok");
    // ★호스트 소유 침묵 한도(runner.ts startCliSilenceGuard). 이 러너는 도구 시작/끝을 구분해 보고하지 않아, 긴 도구를
    //   침묵으로 오인하지 않도록 한도를 도구 상한(90분)과 같게 둔다. 가드는 트리만 죽이고 close 가 유일한 정산이다.
    const silenceLimitMs = cliToolSilenceWindowMs(req.env ?? process.env);
    const silence = startCliSilenceGuard(child, {
      label: "grok", onStatus: events.onStatus, windowMs: silenceLimitMs, toolWindowMs: silenceLimitMs, kill: () => killCliTree(child),
    });
    const stopHeartbeat = (): void => { stopHeartbeatOnly(); silence.stop(); };
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
    let terminalCompleted = false;
    let terminalError = false;
    /** streaming-json lines of a shape this adapter understands; zero + empty text + exit 0 = runtime_protocol_unrecognized. */
    let recognizedEvents = 0;
    let terminalStopReason: string | undefined;
    let tokens: number | undefined;
    let lastEmit = 0;
    /** 같은 도구의 승인 거부를 한 번만 알린다. */
    const announcedGrokDenials = new Set<string>();
    let thoughtActive = false;
    let thoughtStartedAt = 0;
    let sessionId: string | undefined = resumeSessionId ?? undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    let spawned = Number.isSafeInteger(child.pid) && Number(child.pid) > 0;
    child.once("spawn", () => { spawned = true; });
    const failedResult = (code?: number | null, quota = false): RunnerResult => ({
      text: text.trim(), tokens, sessionId,
      failure: {
        kind: quota ? "quota" : "refused", runtime: KIND, source: "marker",
        providerCode: "runtime_turn_unsettled",
        ...(typeof code === "number" ? { exitCode: code } : {}),
        message: [
          new RuntimeTurnUnsettledError(KIND, req.locale).message,
          quota ? (req.locale === "ko"
            ? "Grok 사용량 잔액 소진(HTTP 402)도 확인됐습니다. Grok Settings > Usage에서 확인해 주세요."
            : "Grok quota exhaustion (HTTP 402) was also observed. Check Grok Settings > Usage.") : "",
          stderr.slice(0, 500),
        ].filter(Boolean).join("\n"),
      },
    });

    const handle = (ev: GrokEvent): void => {
      if (grokEventRecognized(ev)) recognizedEvents += 1;
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
                ...(req.signal ? { signal: req.signal } : {}),
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
        // streaming-json's last `end` is the turn boundary. A step finish or
        // usage line only closes one model response, never the whole turn.
        if (type === "end") {
          terminalStopReason = ev.stopReason;
          terminalCompleted = ev.stopReason === "end_turn" && !terminalError;
        }
        if (thoughtActive) events.onThinking?.("end", Date.now() - thoughtStartedAt);
        thoughtActive = false;
        const fin = ev.text ?? ev.content ?? ev.output ?? (typeof ev.data === "string" ? ev.data : undefined);
        if (typeof fin === "string" && fin && !text) text = fin;
        const tk = ev.usage?.output_tokens ?? ev.usage?.completion_tokens ?? ev.tokens;
        if (typeof tk === "number") tokens = tk;
      } else if (type === "error") {
        terminalError = true;
        terminalCompleted = false;
        stderr += `${ev.message ?? stringify(ev.error) ?? "grok error"}\n`;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      silence.touch();
      buffer += stdoutDecoder.write(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          // Valid JSON that is not an object (`null`, a number) is neither an event nor assistant text.
          if (parsed === null || typeof parsed !== "object") continue;
          handle(parsed as GrokEvent);
        } catch {
          // JSON이 아니면(--format json 미지원/plain 모드) 텍스트로 누적.
          text += (text ? "\n" : "") + line;
          events.onPartial(text);
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      silence.touch();
      stderr += stderrDecoder.write(chunk);
    });
    const flushOutputTail = () => {
      buffer += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (buffer.trim()) {
        const line = buffer.trim();
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === "object") handle(parsed as GrokEvent);
        }
        catch { text += (text ? "\n" : "") + line; }
      }
      buffer = "";
    };
    const finishFailed = (code?: number | null) => {
      const quota = isGrokQuotaExhausted(stderr);
      if (quota) {
        recordProviderHealth("grok", "grok_quota_exhausted");
        invalidateUsage("grok");
      }
      // A quota response cannot prove that earlier tools had no effect.
      resolve(failedResult(code, quota));
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      stopHeartbeat();
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      void fs.rm(promptFile, { force: true });
      if (req.signal?.aborted) reject(abortReasonError(req));
      else if (spawned) {
        flushOutputTail();
        finishFailed();
      }
      else reject(err); // Failed spawn is not evidence that the request ran.
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      stopHeartbeat();
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      void fs.rm(promptFile, { force: true });
      if (req.signal?.aborted) {
        reject(abortReasonError(req));
        return;
      }
      flushOutputTail();
      // ★침묵 한도로 호스트가 끝낸 시도 — 이 close 가 유일한 정산이다(취소는 위에서 이미 처리했다).
      if (silence.tripped) {
        resolve({ text: text.trim(), tokens, sessionId, ownerControlTerminal: "uncertain",
          failure: runtimeSilentTimeoutFailure("grok", silence.trippedWith?.limitMs ?? silenceLimitMs) });
        return;
      }
      // assistant text는 오류 증거가 아니다. streaming-json `type:error`와 실제 stderr만
      // handle()이 stderr에 모으므로, 답변이 같은 문구를 인용해도 상태를 오염시키지 않는다.
      if (code === 0 && recognizedEvents === 0 && !text.trim() && !terminalError) {
        // Exit 0, no recognized streaming-json event and no text: typed failure, not an empty "success".
        const protocolFailure = runtimeProtocolUnrecognizedFailure(KIND, stderr);
        resolve({ text: protocolFailure.message, tokens, sessionId, ownerControlTerminal: "uncertain", failure: protocolFailure });
        return;
      }
      if (code === 0) {
        clearProviderHealth("grok");
        invalidateUsage("grok");
        if (req.chatId && fingerprint && sessionId) saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
        // Grok's own completed terminal is a normal end, settled by the shared rule (R-065): a tool-only turn completed.
        const normalEnd = terminalCompleted && terminalStopReason !== "refusal"
          ? settleNormalEnd({ text, toolCalls: toolEvidence.count() }) : null;
        resolve({ text: text.trim(), tokens, sessionId,
          ...(terminalStopReason === "refusal" ? { failure: { kind: "refused" as const, runtime: KIND,
            source: "marker" as const, providerCode: "refusal", message: "Grok stopReason=refusal" } }
            : normalEnd?.outcome === "empty" ? { failure: { kind: "empty" as const, runtime: KIND, source: "marker" as const,
              message: stderr.trim().slice(-500) || "grok returned no message" } } : {}),
          ...(normalEnd ? normalEndToolEvidence(normalEnd) : {}),
          ownerControlTerminal: normalEnd?.outcome === "completed" ? "completed" : "uncertain" });
        return;
      }
      // Partial output is evidence, not a successful terminal receipt. Keep it
      // beside the failure while the host blocks automatic provider replay.
      finishFailed(code);
    });
  });
  }
}
