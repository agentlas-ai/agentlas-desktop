import type { BrowserLiveFrame } from "../../shared/types";
import { getDb } from "../store/db";
import { captureBrowserLiveFrame } from "./live-view";

type ToolObservation = { toolName?: unknown; toolArgs?: unknown; toolResultPreview?: unknown; toolIsError?: unknown };
export type TaskBrowserSource = { kind: "canonical"; url: string } | { kind: "unlinked" | "missing" };

/** Newest-first tool receipts; text in a screenshot or arbitrary tool output
 * never authorizes opening a URL or attaching an unrelated browser session. */
export function taskBrowserSource(observations: readonly ToolObservation[]): TaskBrowserSource {
  for (const observation of observations) {
    if (observation.toolIsError || typeof observation.toolResultPreview !== "string") continue;
    let name = typeof observation.toolName === "string" ? observation.toolName : "";
    let server = "";
    let args: Record<string, unknown>;
    try { args = JSON.parse(String(observation.toolArgs ?? "{}")); } catch { continue; }
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    if (name === "call_mcp_tool") {
      server = typeof args.ServerName === "string" ? args.ServerName : "";
      name = typeof args.ToolName === "string" ? args.ToolName : "";
      const nested = args.Arguments;
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
      args = nested as Record<string, unknown>;
    } else {
      const exact = /^mcp__([^:]+?)__(browser_[a-z_]+)$/u.exec(name);
      if (exact) { server = exact[1]; name = exact[2]; }
    }
    if (!name.startsWith("browser_")) continue;
    // A proxy envelope alone proves no CDP ownership. The canonical config
    // key is assigned only by Main's dedicated Browser launcher resolver.
    if (server !== "agentlas-browser") return { kind: "unlinked" };
    if (name !== "browser_navigate" || typeof args.url !== "string") continue;
    try {
      const url = new URL(args.url);
      if (!/^https?:$/u.test(url.protocol) || url.username || url.password) continue;
      return { kind: "canonical", url: url.toString() };
    } catch { /* Invalid navigation is no observation authority. */ }
  }
  return { kind: "missing" };
}

function resolveTaskSource(chatId: string): TaskBrowserSource & { runId?: string } {
  // A new invocation invalidates the prior invocation's screen, including
  // while its first browser call has not happened yet.
  const run = getDb().prepare("SELECT run_id FROM run_events WHERE chat_id = ? AND kind = 'invoke_started' ORDER BY rowid DESC LIMIT 1")
    .get(chatId) as { run_id: string } | undefined;
  if (!run) return { kind: "missing" };
  const rows = getDb().prepare("SELECT payload_json FROM run_events WHERE chat_id = ? AND run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq DESC LIMIT 160")
    .all(chatId, run.run_id) as { payload_json: string }[];
  const observations: ToolObservation[] = [];
  for (const row of rows) { try { observations.push(JSON.parse(row.payload_json)); } catch { /* Skip corrupt receipts. */ } }
  return { ...taskBrowserSource(observations), runId: run.run_id };
}

function emptyFrame(error: BrowserLiveFrame["error"]): BrowserLiveFrame {
  return { available: false, dataUrl: null, targetId: null, title: null, url: null,
    width: null, height: null, viewport: "desktop", capturedAt: new Date().toISOString(), error };
}

export async function captureTaskBrowserFrame(chatId: unknown): Promise<BrowserLiveFrame> {
  if (typeof chatId !== "string" || !chatId || chatId.length > 200) return emptyFrame("task-scope-missing");
  const source = resolveTaskSource(chatId);
  if (source.kind !== "canonical") return emptyFrame(source.kind === "unlinked" ? "browser-session-unlinked" : "no-page");
  const frame = await captureBrowserLiveFrame(source.url);
  const current = resolveTaskSource(chatId);
  if (current.kind !== "canonical" || current.url !== source.url || current.runId !== source.runId) return emptyFrame("no-page");
  return frame;
}
