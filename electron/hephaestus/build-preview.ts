// Preview: the owner talks to the agent being built, as a test (Agentlas 2.0 Build backend; owner: "Preview conversations are never remembered").
//
// How "never remembered" is made true, not promised:
// - the turn runs under a memory actor id of the Hub-called kind (`hub:build-preview:<build>`), the owner-decided rule that already
//    makes a called agent leave and read no memory (memoryActorKind === "hub": no store opened, no curation job, no experience chip, no
//    drawer write). There is no second mechanism and no Preview flag in the memory code.
//  - this module imports nothing of the memory, experience, skill-promotion, self-improvement or checkpoint code and calls the runner
//    directly (the way the Build turn does), so none of those pipelines ever sees the turn (a source assertion in the gate keeps it so).
//  - a CLI runtime's own hooks write through the memory root of their environment: it is a throwaway empty folder for this turn.
//  - the permission is "read": the agent folder is not writable from a Preview at all.
//  - the conversation lives in this process only, bounded, and is dropped by restart, close, and the end of the process.
import { memoryActorKind } from "../../shared/memory-ownership";

export const PREVIEW_MAX_MESSAGES = 40;
export const PREVIEW_MAX_SESSIONS = 8;
const PREVIEW_MAX_TEXT = 12_000;
const PREVIEW_HISTORY_WINDOW = 20;

export type PreviewRefusal = "build_not_found" | "folder_unavailable" | "no_prompt" | "preview_busy" | "empty_message" | "runtime_unavailable" | "preview_failed" | "preview_cancelled";

export interface PreviewRunRequest {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  userPrompt: string;
  cwd: string;
  /** Always a Hub-kind memory actor id. */
  actor: string;
  permission: "read";
  signal: AbortSignal;
  onPartial: (snapshot: string) => void;
}

export interface PreviewPorts {
  folderOf(buildKey: string): string | null;
  /** The agent's canonical prompt plus its skills line, read from the folder now (the build's current files). null = no prompt file yet. */
  composePrompt(folder: string): string | null;
  run(request: PreviewRunRequest): Promise<{ text: string; failure?: string | null }>;
}

interface Session { messages: Array<{ role: "user" | "assistant"; text: string; at: string }>; abort: AbortController | null }

const sessions = new Map<string, Session>();

export function previewActor(buildKey: string): string {
  const actor = `hub:build-preview:${buildKey}`;
  if (memoryActorKind(actor) !== "hub") throw new Error("preview_actor_not_memoryless");
  return actor;
}

function touch(buildKey: string): Session {
  let session = sessions.get(buildKey);
  if (session) { sessions.delete(buildKey); sessions.set(buildKey, session); return session; }
  session = { messages: [], abort: null };
  sessions.set(buildKey, session);
  while (sessions.size > PREVIEW_MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string;
    sessions.get(oldest)?.abort?.abort();
    sessions.delete(oldest);
  }
  return session;
}

export function previewMessages(buildKey: string): Array<{ role: "user" | "assistant"; text: string; at: string }> {
  return (sessions.get(buildKey)?.messages ?? []).map((m) => ({ ...m }));
}

/** A test turn of this build is running now (the phone reads it with the messages; contracts/phone-build2.md section 3). */
export function previewBusy(buildKey: string): boolean {
  return sessions.get(buildKey)?.abort != null;
}

/** One test turn. The reply is returned and kept in this process only; a second turn while one runs is refused, not queued. */
export async function previewSend(ports: PreviewPorts, buildKey: string, text: unknown): Promise<{ ok: true; reply: string; messages: Array<{ role: "user" | "assistant"; text: string; at: string }> } | { ok: false; code: PreviewRefusal }> {
  const message = typeof text === "string" ? text.slice(0, PREVIEW_MAX_TEXT).trim() : "";
  if (!message) return { ok: false, code: "empty_message" };
  const folder = ports.folderOf(buildKey);
  if (!folder) return { ok: false, code: "build_not_found" };
  let systemPrompt: string | null = null;
  try { systemPrompt = ports.composePrompt(folder); } catch { return { ok: false, code: "folder_unavailable" }; }
  if (!systemPrompt) return { ok: false, code: "no_prompt" };
  const session = touch(buildKey);
  if (session.abort) return { ok: false, code: "preview_busy" };
  const controller = new AbortController();
  session.abort = controller;
  const history = session.messages.slice(-PREVIEW_HISTORY_WINDOW).map((m) => ({ role: m.role, text: m.text }));
  try {
    const result = await ports.run({ systemPrompt, history, userPrompt: message, cwd: folder, actor: previewActor(buildKey), permission: "read", signal: controller.signal, onPartial: () => undefined });
    // Restart or close while the turn ran: the answer belongs to a conversation that no longer exists.
    if (controller.signal.aborted || sessions.get(buildKey) !== session) return { ok: false, code: "preview_cancelled" };
    // "No model to run it with" is its own code (the window sends the owner to Settings); every other failure is the provider's (desktop 3, Workspace §4.6 #1).
    if (result.failure === "runtime_unavailable") return { ok: false, code: "runtime_unavailable" };
    if (result.failure) return { ok: false, code: "preview_failed" };
    const at = new Date().toISOString();
    session.messages.push({ role: "user", text: message, at }, { role: "assistant", text: result.text.slice(0, PREVIEW_MAX_TEXT * 4), at });
    if (session.messages.length > PREVIEW_MAX_MESSAGES) session.messages.splice(0, session.messages.length - PREVIEW_MAX_MESSAGES);
    return { ok: true, reply: result.text, messages: previewMessages(buildKey) };
  } catch {
    return { ok: false, code: controller.signal.aborted ? "preview_cancelled" : "preview_failed" };
  } finally {
    if (session.abort === controller) session.abort = null;
  }
}

/** Restart: the conversation is dropped and a running turn is cancelled. */
export function previewRestart(buildKey: string): void {
  const session = sessions.get(buildKey);
  session?.abort?.abort();
  sessions.delete(buildKey);
}

/** The window closed (or the build was removed or its agent deleted): the same as restart. */
export function previewClose(buildKey: string): void { previewRestart(buildKey); }

export function previewCloseAll(): void { for (const key of [...sessions.keys()]) previewRestart(key); }

export function previewSessionCount(): number { return sessions.size; }
