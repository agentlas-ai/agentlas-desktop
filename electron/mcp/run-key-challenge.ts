/**
 * A key asked for at the moment a tool needs it ("잘못된 키 이름은 그때 가서 질문칩 띄우고 승인하면 vault 알아서 바꿔야지").
 *
 * Voice, video and image routes are tools like any MCP server: the model picks one from the task, nothing attaches them to every
 * run. The pre-run key sheet (run-key-elicitation.ts) only covers the catalog MCP tools the judge chose before the run starts. A
 * keyed harness route is called in the middle of a turn, so when its key is not saved the call is refused with a typed reason and
 * this module opens the same sheet for it: the owner pastes the key, or approves "use the saved ELEVENLABS_1 as ELEVENLABS_API_KEY"
 * (the vault renames it; the value never leaves Main), and the model's next call finds the key. The model is never told a value and
 * is not made to wait: the sheet is the owner's, the answer is read from the vault by the next call.
 *
 * Shape follows what comparable systems do: the MCP elicitation spec sends secrets through an out-of-band URL step and has the tool
 * answer "elicitation required" so the same request is retried after the step (URLElicitationRequiredError -32042);
 * just-in-time auth products challenge the user only when a tool needs it. Here the out-of-band step is Agentlas's own key sheet.
 *
 * Only an interactive desktop run binds a sink (client.ts); an unattended run, an Agent App or a phone-hosted run has no screen
 * for the sheet, so a challenge there is "unavailable" and the refusal text says where the owner saves the key.
 */
import { listEnvKeys } from "../secrets/vault";
import type { AutoSelectedMcpTool } from "../mcp-tools/auto-select";
import type { McpInvocationEvent } from "../../shared/types";
import { awaitRunKeyElicitation, buildRunKeyRequest, pendingRunKeyElicitation, runKeyElicitationTimeoutMs } from "./run-key-elicitation";

type Sink = (event: McpInvocationEvent) => void;

interface Binding { sink: Sink; signal?: AbortSignal; boundAt: number }
const bindings = new Map<string, Binding>();
const MAX_BINDINGS = 64;
const MAX_BINDING_AGE_MS = 6 * 60 * 60_000;

/** An interactive run lets a tool it calls open the key sheet. Returns the unbind function (the run's end calls it). */
export function bindRunKeyChallengeSink(runId: string | undefined, sink: Sink, signal?: AbortSignal): () => void {
  if (!runId) return () => {};
  const now = Date.now();
  for (const [id, entry] of bindings) if (now - entry.boundAt > MAX_BINDING_AGE_MS) bindings.delete(id);
  while (bindings.size >= MAX_BINDINGS) bindings.delete(bindings.keys().next().value as string);
  const entry: Binding = { sink, signal, boundAt: now };
  bindings.set(runId, entry);
  return () => { if (bindings.get(runId) === entry) bindings.delete(runId); };
}

export type RunKeyChallengeResult = "asked" | "already-asked" | "unavailable";

/** The tool whose key is missing, as the sheet names it. `envKey` is the name the tool reads. */
export interface RunKeyChallengeTool {
  id: string; name: string; envKey: string; label?: string; setupUrl?: string;
  /** A saved name the model proposes for this key (vault.use): the sheet offers the rename and applies it only on the owner's click. */
  proposedFrom?: string;
}

/**
 * Opens the key sheet for one tool of this run. Never waits for the owner and never throws: the answer lands in the vault, and the
 * tool reads it on its next call. A sheet already open for the run counts as asked (one pending window per run).
 */
export async function raiseRunKeyChallenge(runId: string | undefined, tool: RunKeyChallengeTool): Promise<RunKeyChallengeResult> {
  try {
    const binding = runId ? bindings.get(runId) : undefined;
    if (!runId || !binding || binding.signal?.aborted) return "unavailable";
    if (pendingRunKeyElicitation(runId)) return "already-asked";
    let storedNames: string[] = [];
    try { storedNames = await listEnvKeys(); } catch { /* a locked vault only drops the rename offer */ }
    const row: AutoSelectedMcpTool = {
      id: tool.id, name: tool.name, reason: "the model called this tool and its key is not saved", installed: true,
      missingEnv: [tool.envKey], required: true, state: "missing-key",
    };
    const request = buildRunKeyRequest(runId, [row], runKeyElicitationTimeoutMs(), storedNames);
    if (!request) return "unavailable";
    if (tool.setupUrl || tool.label || tool.proposedFrom) {
      request.tools = request.tools.map((entry) => entry.id !== tool.id ? entry : {
        ...entry,
        ...(tool.setupUrl ? { setupUrl: tool.setupUrl } : {}),
        envKeys: entry.envKeys.map((key) => key.key !== tool.envKey ? key : {
          ...key,
          ...(tool.label ? { label: tool.label, labelEn: tool.label } : {}),
          // Offered by Main on this request, so resolveRunKeyWithStoredName accepts exactly this name for this key.
          ...(tool.proposedFrom && storedNames.includes(tool.proposedFrom) ? { storedMatch: tool.proposedFrom } : {}),
        }),
      });
    }
    // The window settles on the owner's answer or its timeout; nothing here waits for it.
    void awaitRunKeyElicitation({ runId, request, sink: binding.sink, signal: binding.signal }).catch(() => undefined);
    return "asked";
  } catch {
    return "unavailable";
  }
}
