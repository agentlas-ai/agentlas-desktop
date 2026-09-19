import { createHash, randomUUID } from "node:crypto";
import type { PreparedMcpBinding } from "./prepared-transport";

export interface MainMcpEffectReceipt {
  id: string; server: string; tool: string; argumentsDigest: string;
  state: "pending" | "settled" | "uncertain"; failed: boolean;
}
type Listener = (receipt: MainMcpEffectReceipt) => void;
const listeners = new WeakMap<PreparedMcpBinding, Set<Listener>>();
export interface MainMcpExecutionCompletion {
  receiptId: string; contract: "time" | "native-browser"; server: string; tool: string;
  argumentsDigest: string; resultDigest: string; outputDigests: string[]; resultPreview: string;
}
// Only actual Main publications carry this capability. Copying provider JSON,
// including a plausible receipt ID or browser stamp, cannot manufacture it.
const completions = new WeakMap<MainMcpEffectReceipt, {binding: PreparedMcpBinding; proof: MainMcpExecutionCompletion}>();
export function mainMcpExecutionCompletion(receipt: MainMcpEffectReceipt, bindings: readonly PreparedMcpBinding[]): MainMcpExecutionCompletion | null {
  const entry = completions.get(receipt);
  return entry && bindings.includes(entry.binding) ? { ...entry.proof, outputDigests: [...entry.proof.outputDigests] } : null;
}
export function mcpEffectOutputDigest(value: unknown): string {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { /* Exact opaque text. */ } }
  return mcpEffectArgumentsDigest(value);
}
/** Main's opaque prepared binding, never a model/renderer-supplied server name. */
export function observeMainMcpEffects(bindings: readonly PreparedMcpBinding[], listener: Listener): () => void {
  for (const binding of bindings) {
    const set = listeners.get(binding) ?? new Set<Listener>();
    set.add(listener); listeners.set(binding, set);
  }
  return () => { for (const binding of bindings) listeners.get(binding)?.delete(listener); };
}
export function mcpEffectArgumentsDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
}
// Exact native operations supported by the bundled leaf-completion observer.
// A normal MCP response alone is insufficient: upstream may race a modal dialog.
const BROWSER_ACTIONS = new Set(["browser_evaluate", "browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_hover",
  "browser_type", "browser_fill_form", "browser_select_option", "browser_press_key", "browser_drag", "browser_tabs",
  "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_wait_for", "browser_handle_dialog", "browser_file_upload", "browser_resize",
  // The pinned implementation runs arbitrary code inside Tab.waitForCompletion
  // and awaits its ManualPromise before BrowserBackend.callTool resolves. Main's
  // leaf hook below additionally requires that callback to finish, no modal
  // interruption, no abort, and no tracked callback left pending. This proves
  // dispatch settlement only; it does not attest the page's business outcome.
  "browser_run_code", "browser_run_code_unsafe"]);
/** Called at the actual Main proxy request, before policy/upstream dispatch. */
export function beginMainMcpEffect(binding: PreparedMcpBinding, tool: string, args: Record<string, unknown>, contract: "time" | "native-browser" | null) {
  const targets = [...(listeners.get(binding) ?? [])];
  const receipt: MainMcpEffectReceipt = { id: randomUUID(), server: binding.configKey, tool,
    argumentsDigest: mcpEffectArgumentsDigest(args), state: "pending", failed: false };
  let completion: MainMcpExecutionCompletion | null = null;
  const publish = () => { for (const listener of targets) {
    const published = { ...receipt };
    if (completion) completions.set(published, { binding, proof: completion });
    listener(published);
  } };
  publish(); let dispatched = false, finished = false;
  return {
    dispatched: () => { dispatched = true; },
    finish: (frame?: Record<string, any>) => {
      if (finished) return; finished = true;
      const result = frame?.result;
      const valid = result && typeof result === "object" && !Array.isArray(result) && Array.isArray(result.content)
        && (result.isError === undefined || typeof result.isError === "boolean") && result.task === undefined;
      receipt.failed = !valid || result.isError === true || frame?.error != null;
      const time = contract === "time" && ["get_current_time", "convert_time"].includes(tool);
      const leaf = result?._meta?.agentlasBrowserLeaf;
      const browserCompleted = contract === "native-browser" && BROWSER_ACTIONS.has(tool)
        && leaf && typeof leaf === "object" && !Array.isArray(leaf) && Object.keys(leaf).length === 3
        && leaf.schemaVersion === "agentlas.browser-leaf.v1" && leaf.tool === tool && leaf.state === "completed";
      const predispatch = contract === "native-browser" && tool === "browser_evaluate"
        && valid && result.isError === true && result._meta?.agentlasToolDispatch === "not-dispatched"
        && result._meta?.agentlasFailureCode === "browser_evaluate_function_required" && typeof args.function !== "string";
      // A definite local rejection is settled; a dropped wire after send never is.
      // Even a snapshot may have an outstanding callback after a modal race;
      // every native browser operation needs the exact leaf-completion receipt.
      receipt.state = !dispatched || predispatch || (valid && !frame?.error && (time || (browserCompleted && !receipt.failed))) ? "settled" : "uncertain";
      if (dispatched && receipt.state === "settled" && !receipt.failed && (time || browserCompleted)) {
        const resultDigest = mcpEffectArgumentsDigest(result);
        const outputDigests = [resultDigest];
        if (result.content.length === 1 && result.content[0]?.type === "text" && typeof result.content[0].text === "string") {
          outputDigests.push(mcpEffectOutputDigest(result.content[0].text));
        }
        completion = { receiptId: receipt.id, contract: time ? "time" : "native-browser", server: receipt.server, tool,
          argumentsDigest: receipt.argumentsDigest, resultDigest, outputDigests: [...new Set(outputDigests)],
          // Observation only; this preview is bounded/redacted again by the
          // durable store, and never attests domain or business correctness.
          resultPreview: JSON.stringify(result).slice(0, 1200) };
      }
      publish();
    },
  };
}
