// Grok CLI text runtime — official xAI CLI (`x.ai/cli`, verified with grok 0.2.x).
// Headless contract: --prompt-file + --cwd + --output-format streaming-json.
// Authentication is normally OAuth (`grok login`); XAI/GROK_API_KEY remains a supported fallback.
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { CLI_HISTORY_CONTEXT_TOKENS, composeResumeTurnPrompt, renderConversationContext } from "./continuity";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild } from "./exec";
import { readEnvVar } from "../secrets/vault";
import { clearProviderHealth, recordProviderHealth } from "../usage/provider-health";
import { invalidateUsage } from "../usage";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import { StringDecoder } from "node:string_decoder";

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

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      if ((await probeCliVersion(p, 2000)) !== null) return p;
      continue;
    }
    try {
      await fs.access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
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

// `grok models` → 모델 id 목록 (best-effort, 짧은 타임아웃). 새 모델이 나오면 자동 반영된다.
// 실패(키 없음/네트워크/포맷 변경)하면 빈 배열 → 호출부가 정적 CLI_MODELS로 폴백.
function listGrokModels(bin: string): Promise<string[]> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (v: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, ["models"], { stdio: ["ignore", "pipe", "ignore"], env: grokEnv(process.env) });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish([]);
    }, 5000);
    const outDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (c: Buffer) => (out += outDecoder.write(c)));
    child.on("error", () => {
      // 프로세스 종료 시 stdout data 리스너를 제거해 누수 방지(stderr는 ignore라 리스너 없음).
      child.stdout?.removeAllListeners("data");
      finish([]);
    });
    child.on("close", () => {
      // 프로세스 종료 시 stdout data 리스너를 제거해 누수 방지(stderr는 ignore라 리스너 없음).
      child.stdout?.removeAllListeners("data");
      // `grok models` 실측 출력: 각 기본 모델이 `  grok-4.3 — Grok 4.3 (reasoning)` 형태(ANSI 컬러 포함).
      // ANSI 제거 후 "id — 설명" 라인의 id만 뽑는다(별칭 줄은 제외 → 드롭다운 깔끔).
      // ANSI(컬러) 무관하게 grok-* 모델 id를 추출한다(별칭 포함이지만 모두 유효한 모델).
      const ids: string[] = [];
      for (const mm of out.matchAll(/grok[\w.-]*\d[\w.-]*/gi)) {
        const id = mm[0].toLowerCase();
        if (!ids.includes(id)) ids.push(id);
      }
      finish(ids);
    });
  });
}

export interface GrokProbe {
  path: string;
  version: string;
  /** `grok models`로 받은 라이브 모델 목록(가능할 때). 비어있으면 정적 카탈로그로 폴백. */
  models: string[];
}

export async function probeGrok(): Promise<GrokProbe | null> {
  const found = await firstExisting(grokCandidates());
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  const models = await listGrokModels(found).catch(() => []);
  return { path: found, version, models };
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const found = await firstExisting(grokCandidates());
  cachedBin = found;
  return cachedBin;
}

function buildPrompt(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(
    req.systemPrompt,
    req.locale,
    req.permission,
    req.userPrompt,
    req.forceSurface,
    req.restrictedReadBoundary,
    req.untrustedNoTools,
  );
  // 세션 미지원 러너 — 매 턴 히스토리를 연속성 프레이밍+압축과 함께 재주입한다.
  const turnContext = req.turnContext?.trim();
  const parts: string[] = [`[SYSTEM]\n${sys}${turnContext ? `\n\n${turnContext}` : ""}`, ""];
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
  if (req.untrustedNoTools) {
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
  const prompt = resumeSessionId
    ? composeResumeTurnPrompt(req.userPrompt, req.turnContext ?? "", req.locale)
    : buildPrompt(req);

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
  const args = ["--prompt-file", promptFile, "--cwd", cwd, "--output-format", "streaming-json", "--no-subagents"];
  if (resumeSessionId) args.unshift("--resume", resumeSessionId);
  if (req.model) args.push("-m", req.model); // grok --help 확인: -m, --model <model>
  if (req.effort) args.push("--effort", req.effort);
  if (!req.untrustedNoTools && req.permission === "full") args.push("--permission-mode", "bypassPermissions");
  else if (!req.untrustedNoTools && req.permission === "write") args.push("--permission-mode", "acceptEdits");

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
    let thoughtActive = false;
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
        if (!thoughtActive) events.onStatus(tStatus(req.locale, "thinking", { agent: req.backendLabel }));
        thoughtActive = true;
      } else if (type === "text" || type === "assistant" || type === "message") {
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
        thoughtActive = false;
        const data = ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : null;
        const name = ev.tool ?? ev.name ?? (typeof data?.name === "string" ? data.name : "tool");
        const argPayload = ev.input ?? ev.args ?? ev.arguments ?? ev.parameters ?? data?.input ?? data?.args;
        const resultPayload = ev.output ?? ev.result ?? data?.output ?? data?.result;
        events.onTool?.(
          String(name),
          argPayload == null ? undefined : truncate(stringify(argPayload), 2000),
          resultPayload == null ? undefined : truncate(stringify(resultPayload)),
          ev.id,
          ev.error != null || ev.is_error === true,
        );
      } else if (type === "step_finish" || type === "done" || type === "final" || type === "end") {
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
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      void fs.rm(promptFile, { force: true });
      reject(err);
    });
    child.on("close", (code) => {
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
