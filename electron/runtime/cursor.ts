// Cursor Agent CLI runtime. The official headless contract is
// `cursor-agent --print --output-format stream-json --model <model> <prompt>`.
//
// ★이 파일은 **기본 경로가 아니다**. cursor 는 ACP_PREFERRED_KINDS 라서 실제 실행은
// electron/runtime/acp.ts 를 지나고, 여기는 `AGENTLAS_DISABLE_ACP` 탈출구에서만 돈다.
// 그래서 세션 연속성(`--resume`/`create-chat`)은 여기가 아니라 ACP 쪽에 세웠다
// (session/load). 이 러너는 이미 매 턴 히스토리를 프롬프트로 재주입하므로 기억을
// 잃지는 않는다 — 남는 차이는 효율뿐이고, 그걸 위해 같은 연속성 계약을 두 벌로
// 늘리면 두 곳이 갈라진다.
//
// `--mode ask`(읽기 전용)는 아래 거절을 풀지 못한다: 저 거절은 "읽기 전용"이 아니라
// **도구 0개**(untrustedNoTools)와 **릴리스 검증된 파일시스템 경계**
// (restrictedReadBoundary)를 요구한다. ask 모드는 읽기 도구를 그대로 갖고 있어
// 둘 중 어느 것도 만족시키지 못한다. 권한→모드 매핑은 ACP 경로의 session/set_mode 가
// 맡는다(read → plan/ask).
import path from "node:path";
import { RuntimeJudgmentRefusal } from "./judgment-refusal";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { ensureChildCloseAfterExit, startCliHeartbeat } from "./runner";
import { cumulativeSurfaceGateText, wrapSystemPrompt } from "./runner";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild } from "./exec";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { CURSOR_MODEL_RE, parseCursorModels, type DiscoveryOutcome } from "../../shared/model-discovery";
import { settleDiscovery } from "./model-discovery-store";

/**
 * 중지 사유를 그대로 전한다. 중지는 사람이 누른 것 외에도 무활동 워치독·단계 시간 초과·
 * 예산 소진으로 일어난다. 예전엔 전부 "사용자가 정지 버튼으로"라고 단정했다.
 */

const CANDIDATES = [
  path.join(os.homedir(), ".cursor", "bin", "cursor-agent"),
  path.join(os.homedir(), ".local", "bin", "cursor-agent"),
  "cursor-agent",
  // Current Cursor CLI also installs the public `agent` command. Verify its
  // help signature so an unrelated command with the same generic name is not
  // mistaken for Cursor.
  path.join(os.homedir(), ".local", "bin", "agent"),
  "agent",
];

function isGenericAgentCandidate(candidate: string): boolean {
  return path.basename(candidate).toLowerCase() === "agent";
}

async function hasCursorAgentSignature(candidate: string): Promise<boolean> {
  if (!isGenericAgentCandidate(candidate)) return true;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawnCli(candidate, ["--help"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish(false);
    }, 2_500);
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(0, 16_000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => finish(false));
    child.on("close", () => finish(/cursor\s+agent|cursor\.com/i.test(output)));
  });
}

async function resolveCursorBinary(): Promise<string | null> {
  for (const candidate of CANDIDATES) {
    if (await probeCliVersion(candidate, 2_500)) {
      if (await hasCursorAgentSignature(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Parse `agent models` output. Delegates to the shared, fixture-tested parser
 * (shared/model-discovery.ts) — the vendor-word allowlist that used to live here
 * silently dropped any new vendor. Kept as an export for callers.
 */
export function parseCursorModelList(stdout: string): string[] {
  return parseCursorModels(stdout);
}

/** `agent models` is the account-authoritative inventory on current Cursor CLI. */
async function listCursorModels(bin: string): Promise<DiscoveryOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (input: { timedOut?: boolean; exitCode?: number | null }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(settleDiscovery("cursor", { stdout, models: parseCursorModels(stdout), source: "cli", idRe: CURSOR_MODEL_RE, ...input }));
    };
    try {
      child = spawnCli(bin, ["models"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch {
      finish({ exitCode: null });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish({ timedOut: parseCursorModels(stdout).length === 0 });
    }, 5_000);
    const probeDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + probeDecoder.write(chunk)).slice(0, 64_000); });
    child.on("error", () => finish({ exitCode: null }));
    child.on("close", (code) => finish({ exitCode: code }));
  });
}

export interface CursorProbe { path: string; version: string; models: string[]; discovery: DiscoveryOutcome; }

export async function probeCursor(): Promise<CursorProbe | null> {
  const bin = await resolveCursorBinary();
  if (!bin) return null;
  const [version, discovery] = await Promise.all([probeCliVersion(bin, 2_500), listCursorModels(bin)]);
  return { path: bin, version: version ?? "unknown", models: discovery.models, discovery };
}

function promptFor(req: RunnerRequest): string {
  const parts = [
    `[SYSTEM]\n${wrapSystemPrompt(
      req.systemPrompt,
      req.locale,
      req.permission,
      cumulativeSurfaceGateText(req.history, req.userPrompt),
      req.forceSurface,
      req.restrictedReadBoundary,
      req.untrustedNoTools,
      req.untrustedAllowedMcpTools,
    )}`,
    "",
  ];
  for (const entry of req.history) parts.push(`${entry.role === "user" ? "[USER]" : "[ASSISTANT]"}\n${entry.text}`, "");
  parts.push(`[USER]\n${req.userPrompt}`);
  return parts.join("\n");
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function eventText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const event = value as Record<string, unknown>;
  for (const key of ["delta", "text", "content", "result", "output"]) {
    const text = contentText(event[key]);
    if (text) return text;
  }
  const message = event.message;
  if (message && typeof message === "object") {
    return contentText((message as Record<string, unknown>).content);
  }
  return "";
}

export const runCursor: Runner = async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
  if (req.env?.AGENTLAS_NATIVE_BROWSER_SCOPE === "task") {
    // This legacy driver cannot bind the exact per-run native browser safely.
    // The supported ACP path carries the Main-approved session configuration.
    throw Object.assign(new Error("native_browser_requires_acp_transport"), {
      code: "native-browser-legacy-transport-unsupported",
    });
  }

  // Cursor print mode exposes built-in file/shell tools and currently has no
  // verified zero-tool switch. Browser-originated and restricted invocations
  // must therefore fail before probing or spawning the CLI.
  if (req.untrustedNoTools || req.restrictedReadBoundary) {
    // 표식을 단다 — 판정이 전멸했을 때 "기다리면 풀리는 사유"와 구분되어야 한다.
    throw new RuntimeJudgmentRefusal(
      "cursor",
      req.locale === "ko"
        ? "Cursor Agent CLI는 현재 검증된 무도구 격리 모드를 지원하지 않습니다. Claude Code, Ollama 또는 API 런타임을 선택하세요."
        : "Cursor Agent CLI does not currently support verified tool-less isolation. Select Claude Code, Ollama, or an API runtime.",
    );
  }
  const bin = await resolveCursorBinary();
  if (!bin) throw new Error(req.locale === "ko" ? "Cursor Agent CLI를 찾지 못했습니다." : "Cursor Agent CLI is not installed.");
  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  const args = ["--print", "--output-format", "stream-json"];
  // Cursor requires --force to apply writes in headless mode. Never add it for
  // read-only invocations; normal Agentlas write/full tasks remain automated.
  if (req.permission === "write" || req.permission === "full") args.push("--force");
  // Cursor's Auto is its own live model selector. Omitting it keeps the account default.
  if (req.model && req.model !== "auto") args.push("--model", req.model);
  args.push(promptFor(req));
  const cwd = req.cwd ?? agentRunCwd();

  return new Promise<RunnerResult>((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd,
        env: req.env ?? process.env,
        ...detachedSpawnOpts(),
      });
    } catch (error) {
      reject(error);
      return;
    }
    trackRunChild(child);
    // ★자식이 죽었는데 close 가 안 오면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    //   형제 러너(agy·claude·codex)에만 붙어 있던 계약을 여기에도 세운다.
    const stopHeartbeat = startCliHeartbeat(child, events.onStatus, "cursor");
    ensureChildCloseAfterExit(child, () => {
      events.onStatus("cursor: process exited without closing its output — settling the run");
    });
    const onAbort = () => killCliTree(child);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let buffer = "";
    let text = "";
    let stderr = "";
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      req.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const consume = (line: string) => {
      try {
        const event = JSON.parse(line);
        const chunk = eventText(event);
        if (!chunk) return;
        if (typeof (event as Record<string, unknown>).delta === "string") text += chunk;
        else if (chunk.length >= text.length || !text.includes(chunk)) text = chunk;
        events.onPartial(text);
      } catch { /* malformed diagnostics stay ignored; stderr is reported on failure */ }
    };
    const bufferDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += bufferDecoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
    });
    const stderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-4_000); });
    child.on("error", (error) => finishReject(error));
    child.on("close", (code) => {
      stopHeartbeat();
      if (settled) return;
      settled = true;
      req.signal?.removeEventListener("abort", onAbort);
      if (buffer.trim()) consume(buffer);
      if (req.signal?.aborted) return reject(abortReasonError(req));
      if (code !== 0) return reject(new Error(`Cursor Agent CLI exit ${code}${stderr ? `\n${stderr}` : ""}`));
      resolve({ text: text.trim() || stderr.trim() || "(Cursor Agent returned no text)" });
    });
  });
};
