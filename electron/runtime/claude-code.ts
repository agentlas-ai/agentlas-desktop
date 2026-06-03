// Claude Code CLI — 감지 + 실호출.
// 사용자의 Claude Pro/Max 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: claude -p "<user prompt>" --append-system-prompt "<system>"
// 이전 메시지 컨텍스트는 V0에서는 system prompt에 inline. M1에서 --resume 옵션 활용 검토.
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Runner, RunnerRequest, RunnerEvents, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { agentRunCwd, probeCliVersion, spawnCli, writeStdin } from "./exec";

const CANDIDATES = [
  "claude",
  path.join(os.homedir(), ".local/bin/claude"), // 네이티브 인스톨러 기본 위치
  path.join(os.homedir(), ".claude/local/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  // Windows npm 전역 심 — GUI 앱이 PATH를 못 받았을 때의 fallback.
  ...(process.platform === "win32"
    ? [
        path.join(process.env.APPDATA ?? "", "npm", "claude.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "claude.cmd"),
      ]
    : []),
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

export const runClaudeCode: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingClaude"));
  }

  if (req.images && req.images.length > 0) {
    events.onStatus(
      tStatus(req.locale, "cliNoImageClaude", { backend: req.backendLabel }),
    );
  } else {
    events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  }

  const systemPrompt = wrapSystemPrompt(req.systemPrompt, req.locale, req.permission, req.userPrompt, req.forceSurface);
  const flatUser = flattenHistory(req);

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
    const args = [
      "-p",
      "--append-system-prompt-file",
      sysPromptFile,
      "--output-format",
      "stream-json",
      "--verbose",
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
    });
    writeStdin(child, flatUser);

    // 취소 — 사용자가 Stop을 누르면 자식 프로세스 종료. 병렬 세션 각각 독립 취소.
    const onAbort = () => child.kill();
    if (req.signal) {
      if (req.signal.aborted) child.kill();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let buffer = "";
    let acc = "";
    let finalText = "";
    let tokens: number | undefined;
    let stderr = "";
    let lastEmit = 0;

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
    }): void {
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text) {
            acc += (acc ? "\n" : "") + block.text;
            const now = Date.now();
            if (now - lastEmit > 60) {
              events.onPartial(acc);
              lastEmit = now;
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
      cleanupSysFile();
      reject(err);
    });
    child.on("close", (code) => {
      cleanupSysFile();
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        reject(new Error(tStatus(req.locale, "aborted")));
        return;
      }
      if (code === 0) {
        if (acc) events.onPartial(finalText || acc);
        resolve({ text: (finalText || acc).trim(), tokens });
      } else {
        reject(new Error(`claude CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`));
      }
    });
  });
};
