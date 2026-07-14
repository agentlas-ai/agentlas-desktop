// Codex CLI — 감지 + 실호출.
// 사용자의 ChatGPT Plus/Pro 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: codex exec "<prompt>"  (—— Codex CLI의 exec 모드)
// V0는 single-turn; 이전 대화를 user 입력에 inline.
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { containsMcpStartupTransportFatal } from "./mcp-startup-fatal";
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import { readCodexModelInventory, resolveCodexModelEffort } from "./codex-models";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";

const KIND = "codex";

const CANDIDATES = [
  // Windows: `.cmd`/`.exe`를 bare `codex`보다 먼저(bare는 PATHEXT 해석 시 `.ps1`을 잡아
  // PowerShell 실행정책에 막힐 수 있음 — .cmd는 cmd.exe로 실행돼 무관).
  ...(process.platform === "win32"
    ? [
        "codex.cmd",
        "codex.exe",
        path.join(process.env.APPDATA ?? "", "npm", "codex.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "codex.cmd"),
        path.join(os.homedir(), ".local", "bin", "codex.exe"),
      ]
    : []),
  "codex",
  path.join(os.homedir(), ".local/bin/codex"), // 네이티브 인스톨러 기본 위치
  path.join(os.homedir(), ".agentlas/npm/bin/codex"), // 앱이 설치한 유저 prefix (sudo 불필요)
  path.join(os.homedir(), ".codex/bin/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
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

export interface CodexProbe {
  path: string;
  version: string;
}

export async function probeCodex(): Promise<CodexProbe | null> {
  const found = await firstExisting(CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  return { path: found, version };
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeCodex();
  cachedBin = probe?.path ?? null;
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
  const user = tStatus(req.locale, "speakerUser");
  const assistant = tStatus(req.locale, "speakerAssistant");
  const parts: string[] = [`[SYSTEM]\n${sys}`, ""];
  if (req.history.length > 0) {
    parts.push(tStatus(req.locale, "histPrevSection"));
    for (const m of req.history) {
      const tag = m.role === "user" ? user : assistant;
      parts.push(`${tag}: ${m.text}`);
    }
    parts.push("");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

function permissionArgs(permission?: RunnerRequest["permission"]): string[] {
  if (permission === "full") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (permission === "write") return ["--sandbox", "workspace-write"];
  // `codex exec`는 비대화형이라 approval loop가 없다 — 승인 플래그를 받지 않는다.
  // (`--ask-for-approval`은 대화형 `codex` 전용. exec에 넘기면 0.133+에서
  //  `unexpected argument` 로 exit 2.) read 권한은 read-only 샌드박스로 충분.
  return ["--sandbox", "read-only"];
}

function resumePermissionArgs(permission?: RunnerRequest["permission"]): string[] {
  if (permission === "full") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  // `codex exec resume` has no `--sandbox` flag, but accepts the same validated
  // config override. Reassert the boundary instead of inheriting a broader
  // user default when a provider session is resumed.
  const sandboxMode = permission === "write" ? "workspace-write" : "read-only";
  return ["-c", `sandbox_mode="${sandboxMode}"`];
}

/**
 * 세션 지문 — 시스템 프롬프트/권한/표면 모드/모델/effort가 바뀌면 값이 달라져,
 * 기존 세션을 버리고 새 세션을 시작하게 한다(이전 인격/설정을 끌고 가지 않도록).
 * 사용자 입력은 매 턴 달라지므로 지문에 넣지 않는다. 넣으면 chatId 저장 세션이 사실상
 * 재사용되지 않는다.
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

interface CodexRunResult {
  code: number | null;
  stderr: string;
  text: string;
  threadId: string | null;
  tokens?: number;
}

/**
 * codex `exec`(또는 `exec resume`)를 1회 실행. `--json`(JSONL 이벤트)으로 받아
 * 세션 id(thread.started)와 답변 텍스트(agent_message), 토큰 사용량을 뽑는다.
 * 프롬프트는 stdin으로(`-`) — Windows cmd.exe 인자 한계 회피.
 */
function runCodexProcess(
  bin: string,
  args: string[],
  stdinPayload: string,
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<CodexRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: req.env ?? process.env,
      // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
      cwd: req.cwd ?? agentRunCwd(),
      ...detachedSpawnOpts(),
    });
    trackRunChild(child);

    const onAbort = () => killCliTree(child);
    if (req.signal) {
      if (req.signal.aborted) killCliTree(child);
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
    writeStdin(child, stdinPayload);

    let buffer = "";
    let text = "";
    let threadId: string | null = null;
    let tokens: number | undefined;
    let stderr = "";
    let lastEmit = 0;
    // reasoning 구간/라이브 토큰 추정 상태 — 상태줄 실시간 표시용.
    let reasoningDepth = 0;
    let reasoningStartedAt = 0;
    let estChars = 0;

    const truncateUi = (s: string, max = 12000): string =>
      s.length > max ? `${s.slice(0, max)}…` : s;
    const stringifyPayload = (payload: unknown): string => {
      if (typeof payload === "string") return payload;
      try {
        return JSON.stringify(payload ?? "", null, 2);
      } catch {
        return String(payload ?? "");
      }
    };
    const isToolItem = (type: string | undefined): boolean => {
      if (!type || type === "agent_message" || type === "reasoning") return false;
      return /tool|function|command|shell|exec|mcp/i.test(type);
    };
    const handle = (ev: {
      type?: string;
      thread_id?: string;
      item?: {
        id?: string;
        type?: string;
        text?: string;
        name?: string;
        command?: string;
        input?: unknown;
        args?: unknown;
        arguments?: unknown;
        output?: unknown;
        result?: unknown;
        error?: unknown;
        /** codex 0.144+ command_execution 직렬화 필드 — output/result가 없고 이것만 온다. */
        aggregated_output?: unknown;
        exit_code?: number;
        status?: string;
      };
      usage?: { output_tokens?: number };
    }): void => {
      if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
        threadId = ev.thread_id;
      } else if (ev.type === "item.started" && ev.item?.type === "reasoning") {
        // reasoning 구간 신호 — 상태줄 "생각 중…" 회전의 근거 (Claude 경로와 동일 계약).
        if (reasoningDepth === 0) {
          reasoningStartedAt = Date.now();
          events.onThinking?.("start");
        }
        reasoningDepth += 1;
      } else if (ev.type === "item.completed" && ev.item?.type === "reasoning") {
        if (reasoningDepth > 0) {
          reasoningDepth -= 1;
          if (reasoningDepth === 0) {
            events.onThinking?.("end", Date.now() - reasoningStartedAt);
          }
        }
      } else if (
        ev.type === "item.completed" &&
        ev.item?.type === "agent_message" &&
        typeof ev.item.text === "string"
      ) {
        text += (text ? "\n" : "") + ev.item.text;
        // 라이브 토큰 추정 — codex는 중간 usage가 없어 스트리밍 문자 수/4로 추정(단조 증가).
        estChars += ev.item.text.length;
        events.onUsage?.(Math.ceil(estChars / 4));
        const now = Date.now();
        if (now - lastEmit > 60) {
          events.onPartial(text);
          lastEmit = now;
        }
      } else if ((ev.type === "item.started" || ev.type === "item.completed") && isToolItem(ev.item?.type)) {
        const item = ev.item!;
        const name =
          item.name ??
          (item.command ? "bash" : undefined) ??
          item.type ??
          "tool";
        const argPayload =
          item.command != null
            ? { command: item.command }
            : (item.input ?? item.args ?? item.arguments);
        // codex 0.144+의 command_execution은 output/result 없이 aggregated_output/exit_code만
        // 직렬화한다 — completed에 result가 없으면 렌더러가 같은 도구를 2행으로 쌓으므로
        // 어떤 형태로든 result를 채워 completed임을 보장한다.
        const resultPayload = item.output ?? item.result ?? item.aggregated_output ?? item.error;
        const argsText = argPayload == null ? undefined : stringifyPayload(argPayload);
        const resultText =
          ev.type === "item.completed"
            ? resultPayload != null
              ? truncateUi(stringifyPayload(resultPayload))
              : typeof item.exit_code === "number"
                ? `exit ${item.exit_code}`
                : (item.status ?? "completed")
            : undefined;
        const isError =
          item.error != null ||
          item.status === "failed" ||
          (typeof item.exit_code === "number" && item.exit_code !== 0);
        // 도구 이벤트 전에 본문을 플러시 — 렌더러 인터리브 앵커가 최신 좌표를 본다.
        if (text) {
          events.onPartial(text);
          lastEmit = Date.now();
        }
        events.onTool?.(
          name,
          argsText && argsText.length > 2000 ? `${argsText.slice(0, 2000)}…` : argsText,
          resultText,
          item.id,
          isError,
        );
      } else if (ev.type === "turn.completed" && ev.usage?.output_tokens != null) {
        tokens = ev.usage.output_tokens;
        events.onUsage?.(tokens);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          // 비-JSON 라인(헤더 등) 무시
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
      req.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stderr, text, threadId, tokens });
    });
  });
}

export const runCodex: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  if (req.untrustedNoTools) {
    throw new Error(
      req.locale === "ko"
        ? "Codex CLI는 읽기 도구를 완전히 제거할 수 없어 Agent App의 무도구 격리 모드에서 사용할 수 없습니다. Claude Code, Ollama 또는 API 런타임을 선택하세요."
        : "Codex CLI cannot fully remove read tools, so it cannot be used for Agent App's tool-less isolation. Select Claude Code, Ollama, or an API runtime.",
    );
  }
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Codex is not enabled for remote or unattended read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingCodex"));
  }

  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;

  if (stagedImages.images.length > 0) {
    events.onStatus(
      tStatus(runReq.locale, "cliImageReady", {
        backend: runReq.backendLabel,
        count: stagedImages.images.length,
      }),
    );
  } else {
    events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  }

  const permArgs = permissionArgs(runReq.permission);
  const mcpArgs =
    !runReq.untrustedNoTools && runReq.mcpCodexConfigArgs && runReq.mcpCodexConfigArgs.length > 0
      ? runReq.mcpCodexConfigArgs
      : [];
  // 모델/effort를 CLI에 명시 전달 — 예전엔 세션 지문에만 쓰고 인자로는 안 넘겨서, 앱이
  // 뭘 선택했든 기기의 ~/.codex/config.toml(또는 codex 업데이트가 바꾼 내장 기본값)이
  // 이겼다(2026-07-08: 다른 기기에서 지정한 적 없는 Spark 모델로 조용히 실행된 사고).
  // 앱이 모델을 갖고 있으면 그 모델이 반드시 이긴다. 없으면 기기 설정을 따른다(BYOM 존중).
  // `--model`/`-c`는 `exec`와 `exec resume` 둘 다 지원 확인됨(0.133+).
  const modelArgs: string[] = [];
  let appliedEffort: string | null = null;
  if (runReq.model) modelArgs.push("--model", runReq.model);
  // 모델 캐시의 exact profile을 실행 시점에도 다시 검증한다. 최신 Codex 모델은 max를
  // 지원하지만, 프로필이 없거나 손상된 경우에는 2026-07-12 사고 방지용 max->xhigh
  // legacy guard를 유지한다. 그 외 미지값은 넘기지 않아 기기 설정을 따른다.
  if (runReq.effort) {
    const inventory = await readCodexModelInventory();
    const effort = resolveCodexModelEffort(inventory, runReq.model, runReq.effort);
    if (effort) {
      appliedEffort = effort;
      modelArgs.push("-c", `model_reasoning_effort=${effort}`);
    }
  }

  // 세션 resume 가능 여부 — chatId 저장 세션 또는 Build 같은 호출자가 직접 넘긴 세션 id.
  const fingerprint = !runReq.untrustedNoTools && runReq.chatId ? systemFingerprint(runReq) : null;
  const existing = !runReq.untrustedNoTools && runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  const storedSessionId =
    existing && fingerprint && existing.fingerprint === fingerprint
      ? existing.sessionId
      : null;
  const resumeSessionId = runReq.untrustedNoTools ? null : (runReq.runtimeSessionId ?? storedSessionId);
  const canResume = !!resumeSessionId;

  // RESUME: 새 user 턴만 stdin으로 — 시스템 프롬프트/히스토리는 세션이 이미 갖고 있다.
  // Resume reasserts the same permission boundary as the first turn.
  if (canResume) {
    const resumePerm = resumePermissionArgs(runReq.permission);
    const args = [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...resumePerm,
      ...mcpArgs,
      ...modelArgs,
      resumeSessionId!,
      "-",
    ];
    const r = await runCodexProcess(bin, args, runReq.userPrompt, runReq, events);
    if (runReq.signal?.aborted) {
      // 취소여도 스레드가 생겼으면 저장 → steering 메시지가 이 세션을 resume해 문맥 유지.
      if (runReq.chatId && fingerprint && r.threadId) saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint);
      throw new Error(tStatus(runReq.locale, "aborted"));
    }
    if (r.code === 0) {
      if (runReq.chatId && fingerprint && r.threadId) {
        saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint);
      }
      return { text: r.text.trim(), sessionId: r.threadId ?? resumeSessionId, tokens: r.tokens, appliedEffort };
    }
    // Build continuation recovery is owned by Main, which can remove exactly
    // one attributed server and preserve approved peers. Replaying here with
    // the identical broken config would exceed that one-retry bound.
    if (
      !runReq.chatId &&
      mcpArgs.length > 0 &&
      containsMcpStartupTransportFatal(r.stderr)
    ) {
      throw new Error(`codex CLI exit ${r.code}${r.stderr ? `\n${r.stderr.slice(0, 500)}` : ""}`);
    }
    // resume 실패(세션 만료/손상 등) → 세션 버리고 아래 CREATE로 폴백.
    if (runReq.chatId) clearRuntimeSession(runReq.chatId, KIND);
  }

  // CREATE: 시스템 프롬프트 + 히스토리 + user를 stdin으로 보내 새 세션을 시드한다.
  const createArgs = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...permArgs,
    ...mcpArgs,
    ...modelArgs,
    "-",
  ];
  const created = await runCodexProcess(bin, createArgs, buildPrompt(runReq), runReq, events);
  if (runReq.signal?.aborted) {
    if (runReq.chatId && fingerprint && created.threadId) saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint);
    throw new Error(tStatus(runReq.locale, "aborted"));
  }
  if (created.code === 0) {
    if (runReq.chatId && fingerprint && created.threadId) {
      saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint);
    }
    return { text: created.text.trim(), sessionId: created.threadId ?? undefined, tokens: created.tokens, appliedEffort };
  }
  throw new Error(
    `codex CLI exit ${created.code}${created.stderr ? `\n${created.stderr.slice(0, 500)}` : ""}`,
  );
};
