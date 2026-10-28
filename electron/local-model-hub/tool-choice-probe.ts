/**
 * The one tool-choice measurement every local model runtime uses (owner-loaded weights: the Local Models hub and the
 * owner's Ollama / LM Studio / MLX servers). The transport differs; the tasks, the tools offered and the verdict rule
 * are this module's.
 *
 * Two markers, measured separately (2026-10-28):
 * - toolUse: can the model RUN tools — unforced choice of the right tool with correct arguments for tasks that need one.
 *   Workload routing reads it (supportsTools). A model that is good at calling tools stays allocatable for tool work.
 * - toolJudgment: can the model JUDGE which tools a task needs — toolUse AND it answers without a tool when none is
 *   needed. Only this marker qualifies a model as the optional-tool judge (judgment-competence.ts).
 *
 * Statistical rule: one pass per task flips with sampling (qwen3:30b-a3b passed all tasks 3 of 5 times). Each task is
 * asked up to TOOL_PROBE_RUNS times and passes by majority; asking stops as soon as the majority is decided.
 */

export const TOOL_CHOICE_PROBE_SYSTEM = "You are a desktop agent. Use a tool when the task needs the browser, files or the shell.";

export const TOOL_USE_PROBE_TOOLS = [
  { type: "function", function: { name: "browser_navigate", description: "Open a URL in the browser tab", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "write_file", description: "Write text to a file in the project folder", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_shell", description: "Run a shell command in the project folder", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "computer_screenshot", description: "Take a screenshot of the desktop", parameters: { type: "object", properties: {} } } },
] as const;

export interface ToolChoiceProbeTask {
  id: string;
  user: string;
  /** null = the task needs no tool: it passes only when the model answers without calling one. */
  expect: string | null;
  check: (args: unknown) => boolean;
}

// 강제(tool_choice)로 한 도구를 부르게 하면 0.6B 도 "확인됨"이 된다 — 실측 2026-09-13 에서 그 모델은 실제 과제 4개 중
// 2개에서 엉뚱한 도구를 골랐다(4B 는 4/4). 그래서 강제 없이 도구 여러 개를 주고 과제에 맞는 도구를 올바른 인자로 고르는지
// 본다. 도구가 필요 없는 과제(2026-10-28)는 판정 자격에만 쓴다: 0.6B 판정기가 "Say OK."에 브라우저를 붙였다.
export const TOOL_USE_PROBES: ReadonlyArray<ToolChoiceProbeTask> = [
  { id: "browser", user: "Open https://example.com in the browser and tell me the page title.", expect: "browser_navigate", check: (args) => /^https?:\/\/example\.com\/?$/.test(String((args as { url?: unknown })?.url ?? "")) },
  { id: "write", user: "Create a file named hello.txt in the project folder containing the text hi.", expect: "write_file", check: (args) => /hello\.txt$/.test(String((args as { path?: unknown })?.path ?? "")) && typeof (args as { content?: unknown })?.content === "string" },
  { id: "shell", user: "Count how many files are in the project folder.", expect: "run_shell", check: (args) => typeof (args as { command?: unknown })?.command === "string" && (args as { command: string }).command.length > 0 },
  { id: "none-chat", user: "Say OK.", expect: null, check: () => true },
  { id: "none-math", user: "What is 17 times 23? Answer with the number only.", expect: null, check: () => true },
];

/**
 * Asks per task (majority of this many). Chosen from 20 sampled answers per task and model (2026-10-28, docs
 * 2026-10-28-local-model-browser-judge, resampled 10,000 times): the chance the same capable model measures as a judge
 * was 72-81% with one ask, 87-90% with a majority of 3 and 93-94% with a majority of 5 (qwen3:1.7b, qwen3:30b-a3b,
 * gpt-oss:20b); Qwen3-0.6B (never calls the shell tool) was 0% under every rule. About 16 asks per measurement.
 */
export const TOOL_PROBE_RUNS = 5;

export type ToolProbeCall = (messages: Array<{ role: "system" | "user"; content: string }>, tools: typeof TOOL_USE_PROBE_TOOLS,
  task: ToolChoiceProbeTask) => Promise<{ name: string; arguments: string } | null>;

/** The exact request of one probe ask, for transports that rebuild it on the other side (the hub daemon). */
export function toolProbeMessages(task: ToolChoiceProbeTask): Array<{ role: "system" | "user"; content: string }> {
  return [{ role: "system", content: TOOL_CHOICE_PROBE_SYSTEM }, { role: "user", content: task.user }];
}

export function toolProbeTask(id: string): ToolChoiceProbeTask | undefined {
  return TOOL_USE_PROBES.find((task) => task.id === id);
}

export interface ToolChoiceProbeResult {
  toolUse: "verified" | "failed";
  toolJudgment: "verified" | "failed";
  /** Per task: passes / asks. */
  tasks: Array<{ id: string; passes: number; runs: number; passed: boolean }>;
  reasonCodes: string[];
}

function taskPassed(task: ToolChoiceProbeTask, call: { name: string; arguments: string } | null): boolean {
  if (task.expect === null) return call === null;
  if (call?.name !== task.expect) return false;
  try { return task.check(JSON.parse(call.arguments || "")); } catch { return false; }
}

/** Majority of `runs` asks per task, stopping as soon as the majority is decided. A transport error counts as a fail. */
export async function runToolChoiceProbe(call: ToolProbeCall, opts: { runs?: number; signal?: AbortSignal } = {}): Promise<ToolChoiceProbeResult> {
  const runs = Math.max(1, opts.runs ?? TOOL_PROBE_RUNS);
  const need = Math.floor(runs / 2) + 1;
  const tasks: ToolChoiceProbeResult["tasks"] = [];
  for (const task of TOOL_USE_PROBES) {
    let passes = 0; let asked = 0;
    while (asked < runs && passes < need && asked - passes <= runs - need) {
      opts.signal?.throwIfAborted();
      let result: { name: string; arguments: string } | null | undefined;
      try {
        result = await call(toolProbeMessages(task), TOOL_USE_PROBE_TOOLS, task);
      } catch (error) {
        if (opts.signal?.aborted) throw error;
        result = undefined;
      }
      asked += 1;
      if (result !== undefined && taskPassed(task, result)) passes += 1;
    }
    tasks.push({ id: task.id, passes, runs: asked, passed: passes >= need });
  }
  const callTasks = tasks.filter((_, i) => TOOL_USE_PROBES[i].expect !== null);
  const noneTasks = tasks.filter((_, i) => TOOL_USE_PROBES[i].expect === null);
  const toolUse = callTasks.every((task) => task.passed) ? "verified" : "failed";
  const toolJudgment = toolUse === "verified" && noneTasks.every((task) => task.passed) ? "verified" : "failed";
  const reasonCodes = tasks.filter((task) => !task.passed).map((task) => `tool_probe_failed:${task.id}:${task.passes}/${task.runs}`);
  return { toolUse, toolJudgment, tasks, reasonCodes };
}
