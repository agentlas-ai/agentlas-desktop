/**
 * The one place a turn's OVERSIZED CURRENT INPUT is kept as a file instead of being sent whole: a refusal or failure must not happen, and an
 * honest message is not a fix.
 *
 * A paste larger than half of what the selected runtime's model takes (min of its context window and, for Agentlas serving, the serving
 * input limit) overflowed the conversation, and the turn ended on the capacity line. Every product runner passes pickRunner
 * (runtime/selection.ts), which wraps the selected adapter with withOversizedInputSpill outermost, before the agent context journals the
 * turn and before the daemon receives it, so the same rule holds for the seven subscription CLIs, BYOK, Agentlas serving, agentlas-local and
 * the local model servers, in Main and in the daemon, in ordinary turns and in every Goal pass (all of them call the selected runner).
 * The journal keeps the small reference block, never the full text; the full text lives in the file (store/chat-input-spill.ts, which also
 * holds the deletion rule), inside the folder the run works in, which the runtime's own file tools and CLI sandboxes read.
 *
 * Nothing is summarized: the model reads the file itself, in slices. No spill (the input goes as before) when the run has no file-read
 * tool this turn, when the folder cannot take the file, or when the input is a host judgment whose parser needs it inline.
 *
 * Two measured facts decide beyond the estimate: a local or API runner that refused the turn before sending anything for capacity
 * (turn 0, "not-dispatched") gets the same input as a reference once more, because its own exact measurement is better than this estimate.
 */
import type { Runner, RunnerRequest } from "./runner";
import { LOCAL_LOOP_RUNTIME_KINDS } from "./runner";
import { carryRunnerTurnContext, replaceRunnerUserPrompt } from "./runner-turn-context-binding";
import { registerDeclaredPromptModule } from "./prompt-order";
import { estimateTransportTokens } from "./compact";
import { LOCAL_RUNTIME_UNKNOWN_WINDOW, runtimeContextWindow } from "./session-generation";
import os from "node:os";
import { agentRunCwd } from "./exec";
import { redactSecrets } from "../../shared/secret-patterns";
import { runtimeReadsWithTools } from "../../shared/runtime-capabilities";
import { aliveDecisionProfileForRequest } from "./alive-decision-context";
import { resolveEffectiveContextWindow, UNKNOWN_CONTEXT_WINDOW } from "../../shared/models";
import { agentlasServingContextWindow } from "../../shared/agentlas-serving";
import { writeChatInputSpill, type ChatInputSpill } from "../store/chat-input-spill";

/** Half of the model's input window; the answer, the instructions and the conversation need the rest. */
export const SPILL_WINDOW_RATIO = 0.5;
const EDGE_CHARS = 1024;

interface Provider { kind: string; backend?: string }

/** The window the selected runtime's runner works against, from the same sources and the same fallback as that runner. */
export function runnerInputWindow(provider: Provider, req: Pick<RunnerRequest, "model" | "longContext">): number {
  if (provider.kind === "agentlas") return agentlasServingContextWindow(req.model);
  if (provider.kind === "byok") return resolveEffectiveContextWindow(provider.backend ?? "", req.model, !!req.longContext).contextWindow ?? UNKNOWN_CONTEXT_WINDOW;
  if (LOCAL_LOOP_RUNTIME_KINDS.has(provider.kind)) return resolveEffectiveContextWindow(provider.kind, req.model, false).contextWindow ?? LOCAL_RUNTIME_UNKNOWN_WINDOW;
  return runtimeContextWindow(provider.kind, req.model) ?? UNKNOWN_CONTEXT_WINDOW;
}

/** Half of that window, in tokens. */
export function spillTokenLimit(provider: Provider, req: Pick<RunnerRequest, "model" | "longContext">): number {
  return Math.floor(runnerInputWindow(provider, req) * SPILL_WINDOW_RATIO);
}

/** Whether this turn's runtime can read a file by path and how it gets there: the folder the file goes under, and whether the turn's file root
 * must be narrowed to the conversation's own folder (an API or local run with no working folder has no file root; it gets exactly this one). `shared` is the default run folder, which every
 * conversation without a project reads: a secret in a paste is masked in the file there (the existing secret patterns). */
function readableFolder(req: RunnerRequest, kind: string): { folder: string; narrow: boolean; shared?: true } | null {
  if (req.untrustedNoTools || req.browserOnly || req.mcpGrantCatalogOnly || req.simulation || req.minimalObservation
    || req.judgmentOnly || req.outputSchema || aliveDecisionProfileForRequest(req)) return null;
  // A Science recovery turn's prompt is pinned by its single-use grant (recovery-authority.ts assertScienceRecoveryRequest rejects any other
  // text, and Science builds it bounded by reference): a reference block here would fail the turn as a scope mismatch instead of reaching the model.
  if (req.scienceRecoveryCapability !== undefined) return null;
  // A step at read permission on a runtime that cannot read with tools answers in text only (Antigravity): no file to read.
  if (req.permission === "read" && !runtimeReadsWithTools(kind)) return null;
  if (req.cwd && req.cwd.trim()) return { folder: req.cwd, narrow: false };
  // agentRunCwd falls back to the person's home when its own folder cannot be made: nothing is written there (no cleanup reaches it).
  const folder = agentRunCwd();
  if (folder === os.homedir()) return null;
  return { folder, narrow: LOCAL_LOOP_RUNTIME_KINDS.has(kind), shared: true };
}

/** The model-facing reference block (prompt module input.spill-reference): where the text is, how big, both ends, and how to read it. */
function referenceBlock(path: string, spill: ChatInputSpill, text: string, masked: boolean): string {
  registerDeclaredPromptModule({ id: "input.spill-reference", revision: 1, stability: "turn-context", changeTriggers: ["owner-input"], order: 0 });
  return [
    `[Input too large to inline: saved as ${path} (relative to the working folder), ${spill.chars} chars, ${spill.lines} lines${spill.wrapped ? "; lines over 2000 chars are wrapped" : ""}${masked ? "; secrets are masked" : ""}]`,
    "Read all of it in slices with your file-read tool (line offset and limit) before you answer.",
    `--- first ${EDGE_CHARS} chars ---`, text.slice(0, EDGE_CHARS),
    `--- last ${EDGE_CHARS} chars ---`, text.slice(-EDGE_CHARS),
  ].join("\n");
}

/** The request with its oversized current input replaced by the reference block; null when the input stays as it is. */
export function spillOversizedInput(req: RunnerRequest, provider: Provider): RunnerRequest | null {
  const text = req.userPrompt;
  if (typeof text !== "string" || !text) return null;
  try {
    const tokens = estimateTransportTokens(text);
    if (tokens <= spillTokenLimit(provider, req)) return null;
    const where = readableFolder(req, provider.kind);
    if (!where) return null;
    // In the shared default folder the file holds the text with secrets masked; the block shows the same text.
    const kept = where.shared ? redactSecrets(text) : text;
    const spill = writeChatInputSpill(where.folder, req.chatId ?? "", kept);
    // Narrowed: the turn's file root becomes the conversation's own folder, so the reference is just the file's name and nothing else is readable.
    const base = where.narrow ? carryRunnerTurnContext(req, { ...req, cwd: spill.scopeDirectory }) : req;
    const next = replaceRunnerUserPrompt(base, referenceBlock(where.narrow ? spill.fileName : spill.relativePath, spill, kept, kept !== text));
    // The memory reader binding is keyed by request identity (memory/surface-recall.ts): the new request keeps the original's.
    return carrySurfaceMemoryRequest(req, next);
  } catch { return null; }
}

function carrySurfaceMemoryRequest<T extends object>(original: object, next: T): T {
  // Loaded at dispatch, as in runner.ts: the memory module's dependencies would cycle back into runtime selection at load time.
  const memory = require("../memory/surface-recall") as typeof import("../memory/surface-recall");
  return memory.carrySurfaceMemoryRequest(original, next);
}

export function withOversizedInputSpill(runner: Runner, provider: Provider): Runner {
  return async (req, events) => {
    const spilled = spillOversizedInput(req, provider);
    // No second, forced pass after a pre-send capacity refusal: the first pass already journaled this turn's input, and a
    // retry with a different body under the same turn id is refused by the agent context store as an event collision.
    return runner(spilled ?? req, events);
  };
}
