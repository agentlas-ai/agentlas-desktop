// Codex CLI — 감지 + 실호출.
// 사용자의 ChatGPT Plus/Pro 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: codex exec "<prompt>"  (—— Codex CLI의 exec 모드)
// V0는 single-turn; 이전 대화를 user 입력에 inline.
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult , RunnerFailure } from "./runner";
import { ensureChildCloseAfterExit, startCliHeartbeat, wrapSystemPrompt } from "./runner";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { containsMcpStartupTransportFatal } from "./mcp-startup-fatal";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap,
} from "./continuity";
import { tStatus } from "./status-i18n";
import { agentRunCwd, detachedSpawnOpts, firstExistingCli, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import {
  defaultCodexModelEffort,
  readCodexModelInventory,
  resolveCodexModelEffort,
} from "./codex-models";
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

export interface CodexProbe {
  path: string;
  version: string;
}

export async function probeCodex(): Promise<CodexProbe | null> {
  const found = await firstExistingCli(CANDIDATES);
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
  // 새 세션 시드: 턴 컨텍스트는 시스템 섹션 뒤에, 히스토리는 연속성 프레이밍+압축과 함께.
  const turnContext = req.turnContext?.trim();
  const parts: string[] = [`[SYSTEM]\n${sys}${turnContext ? `\n\n${turnContext}` : ""}`, ""];
  if (req.history.length > 0) {
    const { block } = renderConversationContext(req.history, req.locale, CLI_HISTORY_CONTEXT_TOKENS);
    parts.push(block, "");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

function permissionArgs(permission?: RunnerRequest["permission"]): string[] {
  if (permission === "full") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (permission === "write") {
    // Root cause of "the agent can never reach the browser": codex's
    // workspace-write Seatbelt sandbox DENIES ALL network by default, so a
    // write-mode run (every automation, every acting chat) cannot even curl
    // 127.0.0.1:9222 — the local browser it is supposed to drive. Empirically
    // confirmed: workspace-write curl to CDP exits 7, adding network_access=true
    // reaches Chrome. Keep the filesystem sandbox; open network. The user drives
    // their own machine — a network-blind agent is a dead automation, not safety.
    return ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];
  }
  // `codex exec`는 비대화형이라 approval loop가 없다 — 승인 플래그를 받지 않는다.
  // (`--ask-for-approval`은 대화형 `codex` 전용. exec에 넘기면 0.133+에서
  //  `unexpected argument` 로 exit 2.) read 권한은 도구를 안 쓰는 대화 모드라 read-only.
  return ["--sandbox", "read-only"];
}

function resumePermissionArgs(permission?: RunnerRequest["permission"]): string[] {
  if (permission === "full") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  // `codex exec resume` has no `--sandbox` flag, but accepts the same validated
  // config override. Reassert the boundary — and, for write, keep network open so
  // a resumed automation can still reach the local browser and HTTP.
  if (permission === "write") {
    return ["-c", `sandbox_mode="workspace-write"`, "-c", "sandbox_workspace_write.network_access=true"];
  }
  return ["-c", `sandbox_mode="read-only"`];
}

/**
 * 세션 지문 — 안정 시드(sessionFingerprintSeed)가 있으면 시드만 해시한다. 시드가 곧
 * 세션 정체성의 전부다: 모델/effort/권한은 매 호출 CLI 인자로 다시 적용되므로 세션을
 * 가를 이유가 없고, 지문에 섞으면 설정 하나 바꿀 때마다 대화 연속성이 끊긴다
 * (2026-07-16 세션유지 사고). 시드가 없는 레거시 호출만 전체 해시로 폴백한다.
 */
function systemFingerprint(req: RunnerRequest): string {
  // The model is part of the session identity. A runtime session belongs to the
  // model that created it, so resuming it under a different model is a false
  // resume, not continuity. Leaving the model out made every BYOK model switch
  // reuse the previous model's session id.
  //
  // This does NOT reintroduce the 2026-07-16 세션유지 사고. That incident came
  // from hashing the whole system prompt and settings, so any unrelated setting
  // change severed the conversation; the seed exists to keep those out. The
  // model is different in kind — it genuinely cannot inherit another model's
  // session — and the user does not experience a cut, because the fresh-session
  // path reseeds the compacted conversation history with continuity framing
  // (renderConversationContext). The thread the user sees lives in Agentlas's
  // own store, not in the runtime session.
  if (req.sessionFingerprintSeed) {
    return crypto
      .createHash("sha256")
      .update("seed.v3\0")
      .update(req.sessionFingerprintSeed)
      .update("\0model\0")
      .update(req.model ?? "")
      .digest("hex");
  }
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
  /** Provider's raw session-cumulative counter; never render this directly for resume turns. */
  reportedOutputTokens?: number;
  /** 스트림 표식(또는 exit0 휴리스틱)이 말한 실패 — 있으면 text는 답이 아니다. */
  failure?: RunnerFailure;
}

/**
 * codex `exec`(또는 `exec resume`)를 1회 실행. `--json`(JSONL 이벤트)으로 받아
 * 세션 id(thread.started)와 답변 텍스트(agent_message), 토큰 사용량을 뽑는다.
 * 프롬프트는 stdin으로(`-`) — Windows cmd.exe 인자 한계 회피.
 */

/**
 * codex exec --json 이벤트 하나에서 실패 표식을 읽는다 — 순수 함수(게이트가 픽스처 주입).
 * codex 한도는 표식이 없다(거절문이 agent_message + turn.completed) — 그 케이스는
 * 완주 시점의 detectRuntimeRefusal 휴리스틱이 맡는다(출처 heuristic).
 */
export function codexFailureFromEvent(
  ev: { type?: string; item?: { type?: string; message?: unknown }; error?: { message?: unknown } },
): RunnerFailure | null {
  if (ev.type === "item.completed" && ev.item?.type === "error") {
    const message = typeof ev.item.message === "string" && ev.item.message.trim()
      ? ev.item.message.trim().slice(0, 2000) : "codex error";
    return { kind: "exit", message, runtime: "codex", source: "marker" };
  }
  if (ev.type === "turn.failed") {
    const message = typeof ev.error?.message === "string" && ev.error.message.trim()
      ? ev.error.message.trim().slice(0, 2000) : "codex turn failed";
    return { kind: "exit", message, runtime: "codex", source: "marker" };
  }
  return null;
}

/**
 * `item.completed/error` is not a turn terminal. Codex also uses that item for
 * recoverable diagnostics (for example, clamping a plugin hook timeout) and
 * may subsequently emit a normal agent message followed by `turn.completed`.
 * Only a turn-level failure can override such a completed answer. When no
 * completed answer exists, retain the item error as the best failure evidence.
 */
export function resolveCodexRunFailure(input: {
  code: number | null;
  text: string;
  turnCompleted: boolean;
  terminalFailure: RunnerFailure | null;
  itemFailure: RunnerFailure | null;
}): RunnerFailure | null {
  if (input.terminalFailure) return input.terminalFailure;
  if (input.code === 0 && input.turnCompleted && input.text.trim()) return null;
  return input.itemFailure;
}

function runCodexProcess(
  bin: string,
  args: string[],
  stdinPayload: string,
  req: RunnerRequest,
  events: RunnerEvents,
  reportedOutputTokenBaseline: number | null,
): Promise<CodexRunResult> {
  return new Promise((resolve, reject) => {
    let terminalFailure: RunnerFailure | null = null;
    let itemFailure: RunnerFailure | null = null;
    const child = spawnCli(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: req.env ?? process.env,
      // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
      cwd: req.cwd ?? agentRunCwd(),
      ...detachedSpawnOpts(),
    });
    trackRunChild(child);
    // ★호스트 소유 생존 신호 — 러너 공통 규칙(runner.ts startCliHeartbeat 주석 참고).
    const stopHeartbeat = startCliHeartbeat(child, events.onStatus, "codex");
    // ★죽은 자식이 close를 안 보내면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    ensureChildCloseAfterExit(child, () => {
      events.onStatus("codex: process exited without closing its output — settling the run");
    });

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
    let reportedOutputTokens: number | undefined;
    let stderr = "";
    let lastEmit = 0;
    let turnCompleted = false;
    // Newer Codex runtimes send native tool calls as response items instead of
    // the older `item.started` / `item.completed` command events. Dropping that
    // envelope made a real file edit look like a two-event "thought + final"
    // run in One even though the tool had succeeded. Keep the provider call id
    // so the started and completed notifications update one Activity row.
    const responseTools = new Map<string, { name: string; args?: string }>();
    const settledResponseToolIds = new Set<string>();
    // reasoning 구간/라이브 토큰 추정 상태 — 상태줄 실시간 표시용.
    // 단일 open/close 플래그다(깊이 카운터가 아니다): 이 구간은 진짜 `reasoning`
    // 아이템으로도 열리고, reasoning 아이템을 전혀 내보내지 않는 codex 빌드에서는
    // `turn.started`로 합성 개시된다. 둘을 한 카운터에 섞으면 깊이가 0으로 못 내려와
    // 구간이 영구히 열린 채 남는다.
    let thinkingOpen = false;
    let reasoningStartedAt = 0;
    let estChars = 0;

    const openThinking = (): void => {
      if (thinkingOpen) return;
      thinkingOpen = true;
      reasoningStartedAt = Date.now();
      events.onThinking?.("start");
    };
    const closeThinking = (): void => {
      if (!thinkingOpen) return;
      thinkingOpen = false;
      events.onThinking?.("end", Date.now() - reasoningStartedAt);
    };

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
    const record = (value: unknown): Record<string, unknown> | null => (
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    );
    const nonEmptyText = (value: unknown): string | null => typeof value === "string" && value.trim()
      ? value.trim()
      : null;
    const responseToolName = (name: string, input: string | undefined): string => {
      // The Codex tool host uses a generic `exec` wrapper for the built-in
      // patch tool. The structured patch completion below is host evidence, so
      // preserving `apply_patch` lets One present it as a real file output
      // rather than a vague terminal row.
      if (name === "exec" && /tools\.apply_patch\s*\(/.test(input ?? "")) return "apply_patch";
      return name;
    };
    const outputText = (value: unknown): string | undefined => {
      const direct = nonEmptyText(value);
      if (direct) return truncateUi(direct);
      if (Array.isArray(value)) {
        const joined = value
          .map((entry) => record(entry))
          .map((entry) => entry && (nonEmptyText(entry.text) ?? nonEmptyText(entry.output)))
          .filter((entry): entry is string => Boolean(entry))
          .join("\n");
        if (joined) return truncateUi(joined);
      }
      return value == null ? undefined : truncateUi(stringifyPayload(value));
    };
    const settleResponseTool = (id: string, result: string | undefined, isError = false, artifactPaths?: readonly string[]): void => {
      if (settledResponseToolIds.has(id)) return;
      const pending = responseTools.get(id);
      if (!pending) return;
      settledResponseToolIds.add(id);
      events.onTool?.(pending.name, pending.args, result, id, isError, artifactPaths);
    };
    const latestUnsettledResponseTool = (name?: string): string | null => {
      const candidates = [...responseTools.entries()].reverse();
      for (const [id, pending] of candidates) {
        if (!settledResponseToolIds.has(id) && (!name || pending.name === name)) return id;
      }
      return null;
    };
    const handle = (ev: {
      type?: string;
      thread_id?: string;
      payload?: unknown;
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
      const payload = record(ev.payload);
      if (ev.type === "response_item" && payload?.type === "custom_tool_call") {
        const rawName = nonEmptyText(payload.name);
        const id = nonEmptyText(payload.call_id) ?? nonEmptyText(payload.id);
        if (rawName && id) {
          closeThinking();
          const input = nonEmptyText(payload.input);
          const name = responseToolName(rawName, input ?? undefined);
          responseTools.set(id, { name, ...(input ? { args: input } : {}) });
          events.onTool?.(name, input ?? undefined, undefined, id, false);
        }
        return;
      }
      if (ev.type === "response_item" && payload?.type === "custom_tool_call_output") {
        const id = nonEmptyText(payload.call_id) ?? nonEmptyText(payload.id);
        if (id) settleResponseTool(id, outputText(payload.output), payload.status === "failed");
        return;
      }
      if (ev.type === "event_msg" && payload?.type === "patch_apply_end") {
        // This event is emitted by the host only after its patch operation has
        // completed. It carries a bounded, structured list of changed paths;
        // unlike model prose or command input, these paths are real output
        // evidence and may populate One's artifact rail.
        const id = latestUnsettledResponseTool("apply_patch");
        const changes = record(payload.changes);
        if (id && changes) {
          const paths = Object.keys(changes).filter((candidate) => path.isAbsolute(candidate));
          settleResponseTool(id, JSON.stringify({ changes: paths }), payload.success === false, paths);
        }
        return;
      }
      if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
        threadId = ev.thread_id;
      } else if (ev.type === "turn.started") {
        // codex 0.145 emits NO `reasoning` item events (verified against the
        // live CLI), so `item.started/reasoning` below never fires and nothing
        // marks the start of the model's think time. turn.started is the only
        // event that reliably precedes it — treat it as the opening of a
        // reasoning span so callers get a "thinking" signal instead of silence.
        openThinking();
      } else if (ev.type === "item.completed" && ev.item?.type === "error") {
        // Was dropped on the floor: `isToolItem("error")` is false, so codex's
        // own warnings/errors (hook trust, skill budget, tool failures) never
        // reached the user at all.
        const message = (ev.item as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) {
          events.onStatus(`codex: ${truncateUi(message, 400)}`);
          // Keep the marker as candidate evidence, but do not promote it to a
          // turn failure yet. Codex emits recoverable hook/config diagnostics
          // through this same item and can still complete a valid answer.
          itemFailure = itemFailure ?? codexFailureFromEvent(ev);
        }
      } else if (ev.type === "turn.failed") {
        // ★핸들러가 아예 없던 이벤트 — 프로토콜이 턴 실패를 선언하는 자리다.
        terminalFailure = codexFailureFromEvent(ev as { type?: string; error?: { message?: unknown } }) ?? terminalFailure;
      } else if (ev.type === "item.started" && ev.item?.type === "reasoning") {
        // reasoning 구간 신호 — 상태줄 "생각 중…" 회전의 근거 (Claude 경로와 동일 계약).
        openThinking();
      } else if (ev.type === "item.completed" && ev.item?.type === "reasoning") {
        // reasoning summary 아이템 — `-c model_reasoning_summary=auto`로 켠다(실측 0.147:
        // 켜지 않으면 이 아이템이 아예 안 온다). text는 모델이 낸 헤드라인
        // ("**Counting files in current directory**") — 화면의 진행 헤드라인이자
        // 펼쳤을 때의 생각 요약. 사고 원문이 아니라 요약이므로 그대로 흘린다.
        openThinking();
        const summary = nonEmptyText(ev.item.text);
        if (summary) events.onThinking?.("delta", undefined, summary.endsWith("\n") ? summary : `${summary}\n`);
        closeThinking();
      } else if (
        ev.type === "item.completed" &&
        ev.item?.type === "agent_message" &&
        typeof ev.item.text === "string"
      ) {
        closeThinking();
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
        closeThinking();
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
      } else if (ev.type === "turn.completed") {
        closeThinking();
        turnCompleted = true;
        if (ev.usage?.output_tokens != null) {
          reportedOutputTokens = ev.usage.output_tokens;
          // `codex exec resume` emits the lifetime total for its thread. Only
          // render a subtraction when we have the prior raw counter; old rows
          // begin with a visible-message estimate, then establish the baseline
          // for every later resume turn.
          tokens = reportedOutputTokenBaseline != null && reportedOutputTokens >= reportedOutputTokenBaseline
            ? reportedOutputTokens - reportedOutputTokenBaseline
            : Math.ceil(estChars / 4);
          events.onUsage?.(tokens);
        }
      }
    };

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const consumeStdout = (textChunk: string) => {
      buffer += textChunk;
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
    };
    child.stdout?.on("data", (chunk: Buffer) => consumeStdout(stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      // Pipe chunks can split a Korean UTF-8 code point. Decoding them
      // independently turns the split bytes into permanent U+FFFD in One.
      consumeStdout(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      req.signal?.removeEventListener("abort", onAbort);
      let runnerFailure = resolveCodexRunFailure({
        code,
        text,
        turnCompleted,
        terminalFailure,
        itemFailure,
      });
      /*
       * ★표식 없이 완주(exit 0)했는데 산출물이 거절 고지문인 경우 — 실측: codex 한도는
       * 거절문이 agent_message로 오고 turn.completed(표식 0). 이 한 자리에서만 텍스트
       * 판별을 허용하고 출처를 heuristic으로 남긴다(규칙은 runtime-refusal.ts 한 곳).
       */
      if (code === 0 && !runnerFailure) {
        const refusal = detectRuntimeRefusal(text);
        if (refusal) {
          runnerFailure = { kind: refusal.kind, message: refusal.message, runtime: "codex", source: "heuristic" };
        }
      }
      resolve({
        code,
        stderr,
        text,
        threadId,
        tokens,
        ...(reportedOutputTokens != null ? { reportedOutputTokens } : {}),
        ...(runnerFailure ? { failure: runnerFailure } : {}),
      });
    });
  });
}

export const runCodex: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  if (
    req.untrustedNoTools &&
    (Boolean(req.mcpConfigPath) ||
      Boolean(req.mcpAllowedTools?.length) ||
      Boolean(req.mcpCodexConfigArgs?.length) ||
      Boolean(req.untrustedAllowedMcpTools?.length))
  ) {
    throw new Error(
      req.locale === "ko"
        ? "Codex CLI의 격리 실행은 외부 도구가 전혀 없는 경우에만 검증되었습니다. 이 실행의 MCP 권한은 허용할 수 없습니다."
        : "Codex CLI isolation is verified only with no external tools. This run's MCP grant cannot be admitted.",
    );
  }
  // Codex CLI 0.144.4 still exposes collaboration/delegation authority, and
  // the same measured failure remained on 0.144.5 (2026-07-17): even with
  // `--disable multi_agent` and every other configurable tool feature disabled,
  // the runtime still emitted a collaboration tool call. Read-only filesystem
  // sandboxing does not revoke that delegation authority. Until Codex exposes a
  // release-verified switch that removes the collaboration surface, borrowed
  // packages, Agent Apps, and Workforce turns must stop before CLI discovery or
  // process spawn rather than minting a false no-authority receipt.
  if (req.untrustedNoTools) {
    throw new Error(
      req.locale === "ko"
        ? "현재 Codex CLI에서 서브에이전트 협업 권한을 완전히 제거할 수 없어 격리된 Agent App/Workforce 실행을 차단했습니다."
        : "The current Codex CLI still exposes collaboration/delegation authority after tool features are disabled. Isolated Agent App and Workforce execution is blocked before process spawn.",
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
    runReq.mcpCodexConfigArgs && runReq.mcpCodexConfigArgs.length > 0
      ? runReq.mcpCodexConfigArgs
      : [];
  // 모델/effort를 CLI에 명시 전달 — 예전엔 세션 지문에만 쓰고 인자로는 안 넘겨서, 앱이
  // 뭘 선택했든 기기의 ~/.codex/config.toml(또는 codex 업데이트가 바꾼 내장 기본값)이
  // 이겼다(2026-07-08: 다른 기기에서 지정한 적 없는 Spark 모델로 조용히 실행된 사고).
  // 앱이 모델을 갖고 있으면 그 모델이 반드시 이긴다. 없으면 기기 설정을 따른다(BYOM 존중).
  // `--model`/`-c`는 `exec`와 `exec resume` 둘 다 지원 확인됨(0.133+).
  const modelArgs: string[] = [];
  // reasoning summary 아이템을 켠다 — 실측(codex 0.147): 이 설정 없이는 `--json`에
  // reasoning 아이템이 0건이라 화면이 "생각 중" 외에 아무것도 말할 수 없었다. 켜면
  // 모델이 낸 헤드라인("**Preparing file count command execution**")이 아이템으로 온다.
  modelArgs.push("-c", "model_reasoning_summary=auto");
  let appliedEffort: string | null = null;
  if (runReq.model) modelArgs.push("--model", runReq.model);
  // 모델 캐시의 exact profile을 실행 시점에도 다시 검증한다. 최신 Codex 모델은 max를
  // 지원하지만, 프로필이 없거나 손상된 경우에는 2026-07-12 사고 방지용 max->xhigh
  // legacy guard를 유지한다. 그 외 미지값은 넘기지 않아 기기 설정을 따른다.
  if (runReq.effort || runReq.model) {
    // Read the same account home the child process will use. Main's process env
    // may differ from a runtime-owned CODEX_HOME, and consulting another cache
    // can validate an effort for the wrong account/model catalog.
    const inventory = await readCodexModelInventory(runReq.env?.CODEX_HOME);
    const effort = runReq.effort
      ? resolveCodexModelEffort(inventory, runReq.model, runReq.effort)
      : defaultCodexModelEffort(inventory, runReq.model);
    if (effort) {
      appliedEffort = effort;
      modelArgs.push("-c", `model_reasoning_effort=${effort}`);
    }
  }

  // 세션 resume 가능 여부 — chatId 저장 세션 또는 Build 같은 호출자가 직접 넘긴 세션 id.
  const fingerprint = runReq.chatId ? systemFingerprint(runReq) : null;
  const existing = runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  const storedSessionId =
    existing && fingerprint && existing.fingerprint === fingerprint
      ? existing.sessionId
      : null;
  const resumeSessionId = runReq.runtimeSessionId ?? storedSessionId;
  const reportedOutputTokenBaseline = resumeSessionId && existing?.sessionId === resumeSessionId
    ? existing.reportedOutputTokens
    : 0;
  const canResume = !!resumeSessionId;
  if (existing && fingerprint && existing.fingerprint !== fingerprint) {
    events.onStatus(`[runtime-session] fingerprint_changed kind=${KIND}`);
  }

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
    // gap-replay — 이 세션이 마지막으로 본 이후 다른 경로(스웜/다른 러너)로 진행된 턴을 메운다.
    // 호출자가 세션 수명을 직접 관리하는 runtimeSessionId(Build 등)에는 적용하지 않는다.
    const gapContext = !runReq.runtimeSessionId && storedSessionId && existing
      ? renderGapContext(unseenHistoryGap(runReq.history, existing.updatedAt), runReq.locale)
      : "";
    // resume 턴: 시스템 프롬프트가 재전송되지 않으므로 gap+턴 컨텍스트를 사용자 메시지에 싣는다.
    const r = await runCodexProcess(
      bin,
      args,
      composeResumeTurnPrompt(
        runReq.userPrompt,
        [gapContext, runReq.turnContext ?? ""].filter(Boolean).join("\n\n"),
        runReq.locale,
      ),
      runReq,
      events,
      reportedOutputTokenBaseline,
    );
    if (runReq.signal?.aborted) {
      // 취소여도 스레드가 생겼으면 저장 → steering 메시지가 이 세션을 resume해 문맥 유지.
      if (runReq.chatId && fingerprint && r.threadId) {
        saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint, { reportedOutputTokens: r.reportedOutputTokens ?? null });
      }
      throw new Error(tStatus(runReq.locale, "aborted"));
    }
    if (r.code === 0) {
      if (runReq.chatId && fingerprint && r.threadId) {
        if (!saveRuntimeSession(runReq.chatId, KIND, r.threadId, fingerprint, { reportedOutputTokens: r.reportedOutputTokens ?? null })) {
          events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
        }
      }
      events.onStatus(`[runtime-session] resumed kind=${KIND}`);
      return {
        text: r.text.trim(),
        ...(r.failure ? { failure: r.failure } : {}),
        sessionId: r.threadId ?? resumeSessionId,
        tokens: r.tokens,
        appliedEffort,
      };
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
    events.onStatus(`[runtime-session] resume_failed kind=${KIND} exit=${r.code}`);
    if (runReq.unattended) {
      throw new Error(`Automation runtime session resume failed for ${KIND}; refusing to create a fresh CLI session.`);
    }
    // Interactive chat may recover with the full durable history after an explicit receipt.
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
  const created = await runCodexProcess(bin, createArgs, buildPrompt(runReq), runReq, events, 0);
  if (runReq.signal?.aborted) {
    if (runReq.chatId && fingerprint && created.threadId) {
      saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint, { reportedOutputTokens: created.reportedOutputTokens ?? null });
    }
    throw new Error(tStatus(runReq.locale, "aborted"));
  }
  if (created.code === 0) {
    if (runReq.chatId && fingerprint && created.threadId) {
      if (!saveRuntimeSession(runReq.chatId, KIND, created.threadId, fingerprint, { reportedOutputTokens: created.reportedOutputTokens ?? null })) {
        events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
      }
    }
    events.onStatus(`[runtime-session] created kind=${KIND}`);
    return {
      text: created.text.trim(),
      ...(created.failure ? { failure: created.failure } : {}),
      sessionId: created.threadId ?? undefined,
      tokens: created.tokens,
      appliedEffort,
    };
  }
  // The stream may already have said *why* (turn.failed: "You've hit your
  // usage limit…"). That typed marker is the failure; a generic "exit 1" that
  // drops it left the person a red "실패" with no reason (measured 2026-08-16).
  if (created.failure) {
    return {
      text: created.text.trim(),
      failure: created.failure,
      sessionId: created.threadId ?? undefined,
      tokens: created.tokens,
      appliedEffort,
    };
  }
  throw new Error(
    `codex CLI exit ${created.code}${created.stderr ? `\n${created.stderr.slice(0, 500)}` : ""}`,
  );
};
