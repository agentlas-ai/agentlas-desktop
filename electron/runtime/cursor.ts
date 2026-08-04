// Cursor Agent CLI runtime. The official headless contract is
// `cursor-agent --print --output-format stream-json --model <model> <prompt>`.
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild } from "./exec";
import { tStatus } from "./status-i18n";

/**
 * 중지 사유를 그대로 전한다. 중지는 사람이 누른 것 외에도 무활동 워치독·단계 시간 초과·
 * 예산 소진으로 일어난다. 예전엔 전부 "사용자가 정지 버튼으로"라고 단정했다.
 */
function abortReasonError(req: { signal?: AbortSignal; locale?: unknown }): Error {
  const reason = req.signal?.reason;
  if (reason instanceof Error && reason.message.trim()) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason);
  return new Error(tStatus(req.locale as never, "aborted"));
}

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

function cleanModelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/\s+\((?:default|selected|recommended)\)\s*$/i, "")
    .trim();
  return cleaned && cleaned.length <= 180 ? cleaned : null;
}

function modelNamesFromJson(value: unknown): string[] {
  const out: string[] = [];
  const add = (raw: unknown) => {
    const name = cleanModelName(raw);
    if (name && !out.includes(name)) out.push(name);
  };
  const visit = (item: unknown) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return add(item);
    const record = item as Record<string, unknown>;
    add(record.id ?? record.model ?? record.name ?? record.slug ?? record.label);
    for (const key of ["models", "data", "items", "availableModels"]) {
      if (Array.isArray(record[key])) visit(record[key]);
    }
  };
  visit(value);
  return out;
}

/** Parse the supported JSON and human-readable `agent models` representations. */
export function parseCursorModelList(stdout: string): string[] {
  try {
    const models = modelNamesFromJson(JSON.parse(stdout));
    if (models.length > 0) return models;
  } catch { /* Cursor normally emits readable text. */ }
  const models: string[] = [];
  for (const rawLine of stdout.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").split("\n")) {
    for (const cell of rawLine.split(/[|│]/)) {
      const name = cleanModelName(cell);
      if (!name || !/(?:\d|auto|composer|opus|sonnet|haiku|gpt|gemini|grok|claude)/i.test(name)) continue;
      if (!models.includes(name)) models.push(name);
    }
  }
  return models;
}

/** `agent models` is the account-authoritative inventory on current Cursor CLI. */
async function listCursorModels(bin: string): Promise<string[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (models: string[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(models);
    };
    try {
      child = spawnCli(bin, ["models"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch {
      finish([]);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish([]);
    }, 5_000);
    const probeDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + probeDecoder.write(chunk)).slice(0, 64_000); });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (code !== 0) return finish([]);
      finish(parseCursorModelList(stdout));
    });
  });
}

export interface CursorProbe { path: string; version: string; models: string[]; }

export async function probeCursor(): Promise<CursorProbe | null> {
  const bin = await resolveCursorBinary();
  if (!bin) return null;
  const [version, models] = await Promise.all([probeCliVersion(bin, 2_500), listCursorModels(bin)]);
  return { path: bin, version: version ?? "unknown", models };
}

function promptFor(req: RunnerRequest): string {
  const parts = [
    `[SYSTEM]\n${wrapSystemPrompt(
      req.systemPrompt,
      req.locale,
      req.permission,
      req.userPrompt,
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
  // Cursor print mode exposes built-in file/shell tools and currently has no
  // verified zero-tool switch. Browser-originated and restricted invocations
  // must therefore fail before probing or spawning the CLI.
  if (req.untrustedNoTools || req.restrictedReadBoundary) {
    throw new Error(
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
