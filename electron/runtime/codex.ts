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
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
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
  const sys = wrapSystemPrompt(req.systemPrompt, req.locale, req.permission, req.userPrompt, req.forceSurface);
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
  if (permission === "write" || permission === "full") {
    // Agentlas runs Codex as a local, user-owned automation runtime. For browser
    // setup flows, confirmation prompts break the "do it for me" contract.
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  // `codex exec`는 비대화형이라 approval loop가 없다 — 승인 플래그를 받지 않는다.
  // (`--ask-for-approval`은 대화형 `codex` 전용. exec에 넘기면 0.133+에서
  //  `unexpected argument` 로 exit 2.) read 권한은 read-only 샌드박스로 충분.
  return ["--sandbox", "read-only"];
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
      };
      usage?: { output_tokens?: number };
    }): void => {
      if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
        threadId = ev.thread_id;
      } else if (
        ev.type === "item.completed" &&
        ev.item?.type === "agent_message" &&
        typeof ev.item.text === "string"
      ) {
        text += (text ? "\n" : "") + ev.item.text;
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
        const resultPayload = item.output ?? item.result ?? item.error;
        const argsText = argPayload == null ? undefined : stringifyPayload(argPayload);
        const resultText =
          ev.type === "item.completed" && resultPayload != null
            ? truncateUi(stringifyPayload(resultPayload))
            : undefined;
        events.onTool?.(
          name,
          argsText && argsText.length > 2000 ? `${argsText.slice(0, 2000)}…` : argsText,
          resultText,
          item.id,
          item.error != null,
        );
      } else if (ev.type === "turn.completed" && ev.usage?.output_tokens != null) {
        tokens = ev.usage.output_tokens;
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
    runReq.mcpCodexConfigArgs && runReq.mcpCodexConfigArgs.length > 0 ? runReq.mcpCodexConfigArgs : [];
  // 모델/effort를 CLI에 명시 전달 — 예전엔 세션 지문에만 쓰고 인자로는 안 넘겨서, 앱이
  // 뭘 선택했든 기기의 ~/.codex/config.toml(또는 codex 업데이트가 바꾼 내장 기본값)이
  // 이겼다(2026-07-08: 다른 기기에서 지정한 적 없는 Spark 모델로 조용히 실행된 사고).
  // 앱이 모델을 갖고 있으면 그 모델이 반드시 이긴다. 없으면 기기 설정을 따른다(BYOM 존중).
  // `--model`/`-c`는 `exec`와 `exec resume` 둘 다 지원 확인됨(0.133+).
  const modelArgs: string[] = [];
  if (runReq.model) modelArgs.push("--model", runReq.model);
  if (runReq.effort) modelArgs.push("-c", `model_reasoning_effort=${runReq.effort}`);

  // 세션 resume 가능 여부 — chatId 저장 세션 또는 Build 같은 호출자가 직접 넘긴 세션 id.
  const fingerprint = runReq.chatId ? systemFingerprint(runReq) : null;
  const existing = runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  const storedSessionId =
    existing && fingerprint && existing.fingerprint === fingerprint
      ? existing.sessionId
      : null;
  const resumeSessionId = runReq.runtimeSessionId ?? storedSessionId;
  const canResume = !!resumeSessionId;

  // RESUME: 새 user 턴만 stdin으로 — 시스템 프롬프트/히스토리는 세션이 이미 갖고 있다.
  // (`--sandbox`는 resume 서브명령에 없으므로 생략. write/full만 bypass 플래그.)
  if (canResume) {
    const resumePerm =
      runReq.permission === "write" || runReq.permission === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : [];
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
      return { text: r.text.trim(), sessionId: r.threadId ?? resumeSessionId, tokens: r.tokens };
    }
    // resume 실패(세션 만료/손상 등) → 세션 버리고 아래 CREATE로 폴백.
    if (runReq.chatId) clearRuntimeSession(runReq.chatId, KIND);
  }

  // CREATE: 시스템 프롬프트 + 히스토리 + user를 stdin으로 보내 새 세션을 시드한다.
  const createArgs = ["exec", "--json", "--skip-git-repo-check", ...permArgs, ...mcpArgs, ...modelArgs, "-"];
  const created = await runCodexProcess(bin, createArgs, buildPrompt(runReq), runReq, events);
  if (runReq.signal?.aborted) {
    if (runReq.chatId && fingerprint && created.threadId) saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint);
    throw new Error(tStatus(runReq.locale, "aborted"));
  }
  if (created.code === 0) {
    if (runReq.chatId && fingerprint && created.threadId) {
      saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint);
    }
    return { text: created.text.trim(), sessionId: created.threadId ?? undefined, tokens: created.tokens };
  }
  throw new Error(
    `codex CLI exit ${created.code}${created.stderr ? `\n${created.stderr.slice(0, 500)}` : ""}`,
  );
};
