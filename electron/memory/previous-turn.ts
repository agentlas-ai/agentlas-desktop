import { getDb } from "../store/db";
import { isEffectStatusOnlyTool } from "../invocation/effect-boundary";
import { callLeftNoOutsideEffect } from "../invocation/no-effect-failure";

/**
 * Short-term memory: the previous turn of this conversation, as the host recorded it.
 *
 * Owner decision 2026-10-05: an interrupted outside action no longer locks a Goal. Instead every turn of a
 * conversation (One, Work, a group room, a Goal continuation) sees what the turn before it did and how it
 * ended, and decides for itself whether to look before repeating something. Only the previous turn is kept
 * (a flash memory, overwritten every turn); it is a judgement aid, never an instruction or a verdict.
 *
 * Built from the run ledger already written for every turn, so nothing new is stored. Tool arguments may
 * carry secrets, so only the tool name and a URL's origin + path ever leave the ledger.
 */

const TERMINAL_KINDS = ["invoke_completed", "invoke_waiting", "invoke_failed", "invoke_threw", "invoke_cancelled", "invoke_interrupted"];
const MAX_OUTWARD_CALLS = 6;

interface Row { kind: string; ts: string; payload_json: string }

function parse(row: Row): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.payload_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function targetUrl(args: unknown): string | null {
  let value: unknown = args;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested = record.Arguments && typeof record.Arguments === "object" ? record.Arguments as Record<string, unknown> : null;
  const raw = typeof record.url === "string" ? record.url : typeof nested?.url === "string" ? nested.url : null;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return /^https?:$/u.test(url.protocol) ? `${url.origin}${url.pathname}`.slice(0, 160) : null;
  } catch { return null; }
}

function minute(ts: string | null | undefined): string {
  return ts && Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") + "Z" : "unknown";
}

function ending(terminal: { kind: string; payload: Record<string, unknown> } | null): { line: string; clean: boolean } {
  if (!terminal) return { line: "no end was recorded (the app closed or the run was cut off)", clean: false };
  const code = typeof terminal.payload.errorCode === "string" ? terminal.payload.errorCode.slice(0, 60) : null;
  switch (terminal.kind) {
    case "invoke_completed": return { line: "completed", clean: true };
    case "invoke_waiting": return { line: "ended waiting for input", clean: true };
    case "invoke_cancelled": return { line: "stopped before it finished", clean: false };
    case "invoke_interrupted": return { line: "interrupted before it finished", clean: false };
    default: return { line: `failed${code ? ` (${code})` : ""}`, clean: false };
  }
}

/** The previous turn of `chatId` (the latest one before `currentRunId`), or null when there is none. */
export function previousTurnMemorySection(chatId: string | null | undefined, currentRunId?: string | null): string | null {
  const id = String(chatId ?? "").trim();
  if (!id) return null;
  try {
    const previous = getDb().prepare(`SELECT run_id FROM run_events WHERE chat_id = ? AND kind = 'invoke_started'
      AND run_id <> ? ORDER BY ts DESC LIMIT 1`).get(id, String(currentRunId ?? "")) as { run_id?: string } | undefined;
    return previous?.run_id ? turnMemorySection(previous.run_id) : null;
  } catch {
    return null;
  }
}

/** The short-term memory block for one recorded turn. */
export function turnMemorySection(runId: string): string | null {
  try {
    const rows = getDb().prepare("SELECT kind, ts, payload_json FROM run_events WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as Row[];
    if (!rows.length) return null;
    const terminalRow = [...rows].reverse().find((row) => TERMINAL_KINDS.includes(row.kind)) ?? null;
    const end = ending(terminalRow ? { kind: terminalRow.kind, payload: parse(terminalRow) } : null);

    // One entry per provider call id; a call whose result never arrived was cut off mid-action.
    const calls = new Map<string, { name: string; url: string | null; result: "seen" | "failed" | "none"; readOnly: boolean }>();
    let anonymous = 0;
    // A browser call without its own URL acted on the page opened last; name that page so the look knows where to go.
    let page: string | null = null;
    for (const row of rows) {
      if (row.kind !== "mcp_tool-use") continue;
      const data = parse(row);
      const name = typeof data.toolName === "string" ? data.toolName : "";
      if (!name || isEffectStatusOnlyTool({ name, id: data.toolId, args: data.toolArgs, isError: data.toolIsError })) continue;
      const key = typeof data.toolId === "string" && data.toolId ? data.toolId : `anonymous-${anonymous += 1}`;
      const prior = calls.get(key);
      const hasResult = typeof data.toolResultPreview === "string";
      const result = hasResult ? (data.toolIsError === true ? "failed" : "seen") : prior?.result ?? "none";
      const readOnly = (prior?.readOnly ?? true) && callLeftNoOutsideEffect({ toolName: name, toolArgs: data.toolArgs });
      const own = targetUrl(data.toolArgs);
      if (own && /browser/i.test(name)) page = own;
      const url = own ?? prior?.url ?? (/browser/i.test(name) ? page : null);
      calls.set(key, { name: name.slice(0, 80), url, result, readOnly });
    }
    const outward = [...calls.values()].filter((call) => !call.readOnly);
    const reads = calls.size - outward.length;
    const unresolved = outward.some((call) => call.result !== "seen");

    const lines = [
      "### Previous turn in this conversation (short-term memory, recorded by the app)",
      `Started ${minute(rows[0].ts)}, last activity ${minute(rows[rows.length - 1].ts)}: ${end.line}.`,
    ];
    if (outward.length) {
      lines.push("Calls that may have changed something outside, oldest first:");
      for (const call of outward.slice(-MAX_OUTWARD_CALLS)) {
        const state = call.result === "seen" ? "result returned" : call.result === "failed" ? "returned an error" : "cut off before any result";
        lines.push(`- ${[call.name, call.url].filter(Boolean).join(" · ")} — ${state}`);
      }
      if (outward.length > MAX_OUTWARD_CALLS) lines.push(`- …${outward.length - MAX_OUTWARD_CALLS} earlier call(s) not shown`);
    }
    if (reads) lines.push(`${reads} other call(s) only searched, read or opened pages.`);
    if (!calls.size) lines.push("It made no tool calls.");
    // Only an outside call whose outcome is unknown needs a look; a cut-off turn with no such call does not.
    if (unresolved || (!end.clean && outward.length)) {
      lines.push("Judgement aid, not an instruction: an outside action above may or may not have happened. Before doing it again, look at the current state (for example the account's latest posts or the sent folder). If it already happened, do not repeat it. If you cannot tell, decide yourself and say so in one line.");
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}
