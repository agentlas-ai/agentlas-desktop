// Claude Code CLI — 감지 + 실호출.
// 사용자의 Claude Pro/Max 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: claude -p "<user prompt>" --append-system-prompt-file <system>
// 첫 턴은 full-context로 시작하고, 이후 턴은 Claude Code session_id로 resume한다.
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Runner, RunnerRequest, RunnerEvents, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";

const KIND = "claude-code";

// 구형 claude CLI가 --include-partial-messages를 거부하면 false로 전환해(프로세스 수명 동안
// 1회 학습) 이후 실행은 플래그 없이 — 메시지 덩어리 스트리밍으로 — 동작한다.
let includePartialMessagesSupported = true;

const CANDIDATES = [
  // Windows: `.cmd`/`.exe`를 bare `claude`보다 먼저 시도한다. bare `claude`는
  // cross-spawn이 PATHEXT로 해석하다 `claude.ps1`을 잡으면 PowerShell 실행정책
  // (Restricted/RemoteSigned)에 막혀 감지가 실패한다 — 정작 claude 자체는 정상(exit 0)인데도.
  // `.cmd` 심은 cmd.exe로 실행돼 실행정책과 무관하고, `.exe`는 네이티브 인스톨러 산출물이다.
  ...(process.platform === "win32"
    ? [
        "claude.cmd", // PATH의 npm .cmd 심 (실행정책 무관)
        "claude.exe", // 네이티브 인스톨러 exe
        path.join(process.env.APPDATA ?? "", "npm", "claude.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "claude.cmd"),
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude.cmd"),
      ]
    : []),
  "claude",
  path.join(os.homedir(), ".local/bin/claude"), // 네이티브 인스톨러 기본 위치
  path.join(os.homedir(), ".agentlas/npm/bin/claude"), // 앱이 설치한 유저 prefix (sudo 불필요)
  path.join(os.homedir(), ".claude/local/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      // bare 커맨드명 — PATH(+Windows PATHEXT)로 해석. .cmd 심 포함.
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

export interface ClaudeCodeProbe {
  path: string;
  version: string;
}

export async function probeClaudeCode(): Promise<ClaudeCodeProbe | null> {
  const found = await firstExisting(CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  return { path: found, version };
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeClaudeCode();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

// ── 작업량(effort) 자동 동기화 ─────────────────────────────
// 하드코딩 대신 `claude --help`를 파싱해 이 CLI 버전이 실제 지원하는 --effort 레벨만 노출한다.
// CLI가 업데이트돼 레벨이 바뀌면 자동 반영. --effort 자체가 없으면 빈 배열(=작업량 미지원).
const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

function runClaudeHelp(bin: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    const child = spawnCli(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", finish);
    child.on("close", finish);
  });
}

function parseEffortChoices(help: string): string[] {
  // 예: "--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)"
  const m = help.match(/--effort[\s\S]{0,240}?\(([a-z0-9, ]+)\)/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let cachedEfforts: Array<{ id: string; label: string }> | undefined;
/** 이 Claude Code 버전이 지원하는 작업량 레벨 — --help 파싱(1회 캐시). 미지원이면 []. */
export async function probeClaudeEfforts(): Promise<Array<{ id: string; label: string }>> {
  if (cachedEfforts !== undefined) return cachedEfforts;
  const bin = await getBin();
  if (!bin) {
    cachedEfforts = [];
    return cachedEfforts;
  }
  const help = await runClaudeHelp(bin);
  cachedEfforts = parseEffortChoices(help).map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
  return cachedEfforts;
}

function flattenHistory(req: RunnerRequest): string {
  // CLI는 단일 turn — 이전 대화를 user 메시지에 inline으로 prepend.
  if (req.history.length === 0) return req.userPrompt;
  const user = tStatus(req.locale, "speakerUser");
  const assistant = tStatus(req.locale, "speakerAssistant");
  const lines: string[] = [tStatus(req.locale, "histPrev")];
  for (const m of req.history) {
    if (m.role === "user") lines.push(`${user}: ${m.text}`);
    else if (m.role === "assistant") lines.push(`${assistant}: ${m.text}`);
  }
  lines.push(tStatus(req.locale, "histThis"), req.userPrompt);
  return lines.join("\n\n");
}

/**
 * 세션 지문 — 시스템 프롬프트/모델/effort/권한이 바뀌면 기존 Claude 세션을 이어 쓰지 않는다.
 * 사용자 입력은 매 턴 달라지므로 지문에 넣지 않는다. 넣으면 일반 채팅 세션이 매번 끊긴다.
 * Build처럼 runtimeSessionId를 직접 넘기는 표면은 호출자가 세션 수명을 관리한다.
 */
function systemFingerprint(req: RunnerRequest): string {
  return crypto
    .createHash("sha256")
    .update(req.systemPrompt)
    .update("\0")
    .update(req.locale)
    .update("\0")
    .update(req.permission ?? "")
    .update("\0")
    .update(req.forceSurface ? "force-surface" : "normal")
    .update("\0")
    .update(req.model ?? "")
    .update("\0")
    .update(req.effort ?? "")
    .digest("hex");
}

export const runClaudeCode: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingClaude"));
  }

  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;

  const systemPrompt = wrapSystemPrompt(runReq.systemPrompt, runReq.locale, runReq.permission, runReq.userPrompt, runReq.forceSurface);
  const fingerprint = runReq.chatId ? systemFingerprint(runReq) : null;
  const savedSession = runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  const storedSessionId =
    savedSession && fingerprint && savedSession.fingerprint === fingerprint
      ? savedSession.sessionId
      : null;
  if (runReq.chatId && savedSession && fingerprint && savedSession.fingerprint !== fingerprint) {
    clearRuntimeSession(runReq.chatId, KIND);
  }
  const resumeSessionId = runReq.runtimeSessionId ?? storedSessionId;
  const flatUser = resumeSessionId ? runReq.userPrompt : flattenHistory(runReq);

  if (stagedImages.images.length > 0) {
    events.onStatus(
      tStatus(runReq.locale, "cliImageReady", {
        backend: runReq.backendLabel,
        count: stagedImages.images.length,
      }),
    );
  } else if (resumeSessionId) {
    events.onStatus(
      runReq.locale === "ko"
        ? `${runReq.backendLabel} 세션 이어가는 중...`
        : `Resuming ${runReq.backendLabel} session...`,
    );
  } else {
    events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  }

  // 권한 칩 → claude 권한 모드. read=기본(헤드리스에서 위험 툴 자동 거부), write=편집 허용, full=전체.
  const permArgs =
    req.permission === "full"
      ? ["--permission-mode", "bypassPermissions"]
      : req.permission === "write"
        ? ["--permission-mode", "acceptEdits"]
        : [];

  // 모델 선택 — opus/sonnet/haiku 별칭(또는 풀 ID). 미지정이면 구독 기본 모델.
  const modelArgs = req.model && req.model.trim() ? ["--model", req.model.trim()] : [];
  // 작업량(reasoning effort) — low/medium/high/xhigh/max. 미지정이면 CLI 기본.
  const effortArgs = req.effort && req.effort.trim() ? ["--effort", req.effort.trim()] : [];

  // MCP 서버 구성 주입 — mcp/client.ts가 설치·활성 서버를 .mcp.json으로 직렬화해 경로를 넘긴다.
  // 이게 있어야 에이전트가 브라우저(Playwright) 등 실제 MCP 툴을 호출한다. (사용자 config와 병합)
  const mcpArgs = req.mcpConfigPath ? ["--mcp-config", req.mcpConfigPath] : [];
  // write/full 권한이면 헤드리스에서 권한 프롬프트로 막히지 않도록 MCP 툴을 미리 허용.
  const allowedToolArgs =
    req.mcpConfigPath &&
    req.mcpAllowedTools &&
    req.mcpAllowedTools.length > 0 &&
    (req.permission === "write" || req.permission === "full")
      ? ["--allowedTools", req.mcpAllowedTools.join(",")]
      : [];

  // 시스템 프롬프트(Agentlas 헤더+스킬+프로토콜만 ~24KB)는 argv가 아니라 파일로 전달한다.
  // Windows에서 claude는 `.cmd` 심 → cmd.exe로 실행되고 커맨드라인은 ~8191자 한계라,
  // `--append-system-prompt`에 24KB를 실으면 잘려서 exit 1. `--append-system-prompt-file`은
  // 경로만 넘기므로 안전. 사용자 프롬프트(+히스토리)는 stdin으로 보낸다(`-p`는 stdin을 읽음).
  const sysPromptFile = path.join(
    os.tmpdir(),
    `agentlas-claude-sys-${process.pid}-${Date.now()}.txt`,
  );
  await fs.writeFile(sysPromptFile, systemPrompt, "utf8");
  const cleanupSysFile = () => {
    void fs.unlink(sysPromptFile).catch(() => {});
  };

  return new Promise<RunnerResult>((resolve, reject) => {
    // stream-json + verbose: tool_use / 텍스트 / 토큰(usage) 이벤트를 NDJSON으로 받아
    // Claude Code식 tool-use 블록 + 토큰 표시를 가능하게 한다.
    // --include-partial-messages: 텍스트를 메시지 블록 덩어리가 아니라 토큰 델타로 받아
    // 타자기 스트리밍을 가능하게 한다(미지원 구형 CLI는 close 핸들러에서 자동 폴백).
    const partialFlagArgs = includePartialMessagesSupported ? ["--include-partial-messages"] : [];
    const args = resumeSessionId
      ? [
          "--resume",
          resumeSessionId,
          "--fork-session",
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          ...partialFlagArgs,
          ...modelArgs,
          ...effortArgs,
          ...permArgs,
          ...mcpArgs,
          ...allowedToolArgs,
        ]
      : [
          "-p",
          "--append-system-prompt-file",
          sysPromptFile,
          "--output-format",
          "stream-json",
          "--verbose",
          ...partialFlagArgs,
          ...modelArgs,
          ...effortArgs,
          ...permArgs,
          ...mcpArgs,
          ...allowedToolArgs,
        ];
    const child = spawnCli(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: req.env ?? process.env,
      // 사용자가 워킹 폴더(프로젝트)를 지정했으면 거기서 실행 — 빌드/파일 생성이 프로젝트에 일어난다.
      // 미지정이면 쓰기 가능한 전용 폴더(packaged 앱은 cwd가 비쓰기/루트라 claude가 exit 1).
      cwd: req.cwd ?? agentRunCwd(),
      // POSIX 그룹킬 대상 — 취소/앱종료 시 CLI가 띄운 MCP 서버·빌드 손자까지 정리.
      ...detachedSpawnOpts(),
    });
    trackRunChild(child);
    writeStdin(child, flatUser);

    // 취소 — 사용자가 Stop을 누르면 자식 프로세스 트리 종료. 병렬 세션 각각 독립 취소.
    const onAbort = () => killCliTree(child);
    if (req.signal) {
      if (req.signal.aborted) killCliTree(child);
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let buffer = "";
    let acc = "";
    // 현재 메시지의 토큰 델타(stream_event) 누적분 — assistant 메시지 이벤트가 오면
    // 그 권위 전문으로 acc에 폴드되고 비워진다(델타 누락/중복이 있어도 자가 교정).
    let cur = "";
    let finalText = "";
    let tokens: number | undefined;
    let stderr = "";
    let lastEmit = 0;
    let sessionId: string | undefined;
    let accCapped = false;
    // 런어웨이 출력(예: 장기 실행 GUI/서버 로그가 끝없이 스트리밍되는 명령)으로부터
    // 메모리를 보호한다. acc를 무제한 누적 + 매 partial마다 전체를 렌더러로 보내면
    // 메인 문자열과 렌더러 DOM이 동시에 폭주해 앱이 OOM된다(수십 GB). 2MB로 상한.
    const MAX_ACC = 2 * 1024 * 1024;
    const combined = () => (cur ? (acc ? acc + "\n" : "") + cur : acc);
    const capCombined = () => {
      if (accCapped || acc.length + cur.length < MAX_ACC) return;
      acc =
        combined().slice(0, MAX_ACC) +
        (req.locale === "ko"
          ? "\n\n[출력이 너무 길어 잘렸습니다 — 런어웨이 출력 메모리 보호]"
          : "\n\n[Output truncated — runaway output memory guard]");
      cur = "";
      accCapped = true;
    };
    const emitPartial = () => {
      const now = Date.now();
      if (now - lastEmit <= 60) return;
      events.onPartial(combined());
      lastEmit = now;
    };

    const toolNameById = new Map<string, string>();

    const truncateUi = (s: string, max = 12000): string =>
      s.length > max ? `${s.slice(0, max)}…` : s;
    const stringifyToolPayload = (payload: unknown): string => {
      if (typeof payload === "string") return payload;
      if (Array.isArray(payload)) {
        const text = payload
          .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object" && "text" in item) {
              const text = (item as { text?: unknown }).text;
              return typeof text === "string" ? text : "";
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }
      try {
        return JSON.stringify(payload ?? "", null, 2);
      } catch {
        return String(payload ?? "");
      }
    };

    function handleEvent(ev: {
      type?: string;
      session_id?: string;
      message?: {
        content?: Array<{
          type?: string;
          text?: string;
          name?: string;
          input?: unknown;
          id?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
      };
      result?: unknown;
      usage?: { output_tokens?: number };
      event?: { type?: string; delta?: { type?: string; text?: string } };
    }): void {
      if (typeof ev.session_id === "string" && ev.session_id) {
        sessionId = ev.session_id;
      }
      // --include-partial-messages: 토큰 델타를 즉시 이어붙여 글자 단위 스트리밍을 만든다.
      // thinking/tool-input 델타는 무시(text_delta만 본문).
      if (ev.type === "stream_event") {
        const delta = ev.event?.type === "content_block_delta" ? ev.event.delta : undefined;
        if (delta?.type === "text_delta" && delta.text && !accCapped) {
          cur += delta.text;
          capCombined();
          emitPartial();
        }
        return;
      }
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text) {
            if (!accCapped) {
              // 메시지 완결 — 델타 누적분(cur)을 권위 전문으로 대체해 acc에 폴드.
              cur = "";
              acc += (acc ? "\n" : "") + block.text;
              capCombined();
              emitPartial();
            }
          } else if (block.type === "tool_use" && block.name) {
            let argStr = "";
            try {
              argStr = JSON.stringify(block.input ?? {});
            } catch {
              argStr = "";
            }
            if (block.id) toolNameById.set(block.id, block.name);
            events.onTool?.(
              block.name,
              argStr.length > 2000 ? argStr.slice(0, 2000) + "…" : argStr,
              undefined,
              block.id,
              false,
            );
          } else if (block.type === "tool_result") {
            const toolId = block.tool_use_id;
            const toolName = toolId ? toolNameById.get(toolId) ?? "tool_result" : "tool_result";
            const result = truncateUi(stringifyToolPayload(block.content));
            events.onTool?.(toolName, undefined, result, toolId, block.is_error === true);
          }
        }
      } else if (ev.type === "user" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type !== "tool_result") continue;
          const toolId = block.tool_use_id;
          const toolName = toolId ? toolNameById.get(toolId) ?? "tool_result" : "tool_result";
          const result = truncateUi(stringifyToolPayload(block.content));
          events.onTool?.(toolName, undefined, result, toolId, block.is_error === true);
        }
      } else if (ev.type === "result") {
        if (typeof ev.result === "string") finalText = ev.result;
        if (ev.usage?.output_tokens != null) tokens = ev.usage.output_tokens;
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // 비-JSON 라인은 무시
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      cleanupSysFile();
      reject(err);
    });
    child.on("close", (code) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      cleanupSysFile();
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        // 취소여도 CLI가 이미 세션을 디스크에 남겼으면 저장한다 → 사용자가 이어서 보내는
        // steering 메시지가 이 세션을 resume해 "실행 중 방향 전환"처럼 문맥을 유지한다.
        if (req.chatId && fingerprint && sessionId) {
          saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint);
        }
        reject(new Error(tStatus(req.locale, "aborted")));
        return;
      }
      if (code === 0) {
        const streamed = combined();
        if (streamed) events.onPartial(finalText || streamed);
        if (req.chatId && fingerprint && sessionId) {
          saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint);
        }
        resolve({ text: (finalText || streamed).trim(), sessionId, tokens });
      } else {
        // 구형 CLI가 --include-partial-messages를 모르면 그 플래그만 빼고 즉시 재시도 —
        // 델타 스트리밍만 포기하고 채팅 자체는 살린다(전역 1회 학습).
        if (includePartialMessagesSupported && /include-partial-messages/i.test(stderr)) {
          includePartialMessagesSupported = false;
          void runClaudeCode(req, events).then(resolve, reject);
          return;
        }
        if (resumeSessionId && req.chatId) clearRuntimeSession(req.chatId, KIND);
        if (resumeSessionId) {
          // 저장된 CLI 세션이 만료/손상되면 같은 턴을 full-context로 즉시 복구한다.
          // Build는 req.history를 갖고 있고, Chat은 DB history를 갖고 있으므로 문맥은 유지된다.
          void runClaudeCode({ ...req, runtimeSessionId: undefined }, events).then(resolve, reject);
          return;
        }
        reject(new Error(`claude CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`));
      }
    });
  });
};
