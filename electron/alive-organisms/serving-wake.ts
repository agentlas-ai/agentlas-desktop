/**
 * Light Alive decision call on the Agentlas-served runtime (/api/one/serving/chat, tiers light/normal/hard).
 *
 * The general serving runner (runtime/agentlas-serving.ts, owned by the One/Work serving work) wraps the
 * system prompt with the chat harness and has no structured-output or usage channel. A controller wake needs
 * neither the harness nor tools: this sends the controller's own system prompt and one compact observation,
 * asks the server for the strict decision schema (`outputSchema`, web 0dc08fde — the host parser stays the authority
 * either way), and reads the provider-measured usage from the `done` frame ({usage:{inputTokens,outputTokens}}). No usage in the frame = unmeasured (never estimated): the light runner then learns
 * "usage-unmeasured" for this runtime and the pool skips it for token-bounded lives.
 */
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import { isAgentlasServingModel } from "../../shared/agentlas-serving";
import type { Runner, RunnerResult } from "../runtime/runner";

/** Controller wakes are classification-sized; light is the default tier unless the pool member names another. */
export const ALIVE_SERVING_DEFAULT_TIER = "agentlas-light";

async function* frames(response: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try { yield { event, data: JSON.parse(data.join("\n")) as Record<string, unknown> }; } catch { /* a broken frame is skipped */ }
    }
  }
}

const measured = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export const runAliveServingDecision: Runner = async (req, _events): Promise<RunnerResult> => {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { text: "", failure: { kind: "auth", runtime: "agentlas", source: "marker", providerCode: "sign_in_required", message: "Sign in to use Agentlas models." } };
  const model = isAgentlasServingModel(req.model) ? String(req.model).trim() : ALIVE_SERVING_DEFAULT_TIER;
  const response = await fetch(`${webBaseUrl()}/api/one/serving/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-agentlas-client": "desktop", "accept-language": "en" },
    body: JSON.stringify({
      model, system: req.systemPrompt, messages: [{ role: "user", text: req.userPrompt }],
      maxTokens: Math.max(256, Math.min(req.maxOutputTokens ?? 600, 1_000)),
      // The route (web 0dc08fde) constrains decoding with text.format json_schema from `outputSchema`.
      ...(req.outputSchema ? { outputSchema: { name: req.outputSchema.name, schema: req.outputSchema.schema } } : {}),
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!response.ok) {
    let code = "";
    try { code = String(((await response.json()) as { code?: unknown }).code ?? ""); } catch { /* no body */ }
    // Refused at the gate (auth/credits/unknown tier): nothing was generated.
    const kind = response.status === 401 ? "auth" : response.status === 402 || code === "insufficient_credits" ? "quota" : "unsupported";
    return { text: "", failure: { kind, runtime: "agentlas", source: "marker", providerCode: code || `http_${response.status}`, message: `serving ${response.status}` } };
  }
  let text = "";
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  for await (const frame of frames(response)) {
    if (frame.event === "delta" && typeof frame.data.text === "string") text += frame.data.text;
    else if (frame.event === "done") {
      if (typeof frame.data.text === "string" && frame.data.text.length > text.length) text = frame.data.text;
      const u = frame.data.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
      if (u && measured(u.inputTokens) && measured(u.outputTokens)) usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
    } else if (frame.event === "error") {
      throw new Error(typeof frame.data.message === "string" ? frame.data.message : "serving_failed");
    }
  }
  return { text, ...(usage ? { observedUsage: usage } : {}) };
};
