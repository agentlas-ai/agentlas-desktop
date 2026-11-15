import { createHash } from "node:crypto";
import type { ApprovalToolAnnotations } from "../runtime/approval-rule";

/*
 * "This exact call passed the app's one approval window" (Agentlas 2.0 DD, contracts/desktop-server-tools.md section 3).
 *
 * A change to a connected app that lives on the server (the keys are in the server's vault) leaves this computer with `allowWrite: true` only when
 * (1) the caller is the personal agent's own conversation, (2) the owner wrote the turn, and (3) the call went through the approval window. The three
 * places that raise that window each record the answer here the moment it is not "deny": the Main proxy (subscription CLIs, mcp-tools/proxy-session.ts),
 * the in-process loop (API and local models, runtime/local-tool-loop.ts) and the harness `tool.call` port (harness/tool-dispatch.ts). The bridge's
 * loopback handler (one/server-apps-host.ts) consumes the record once when the call reaches it. A call that arrives without one - a runtime that reached
 * the bridge child without the proxy, a model that replayed a tool name - is a call nobody approved: it goes out without `allowWrite`, and the server
 * refuses a change that way (`write_not_allowed`).
 *
 * Memory only: a record lives at most `TICKET_MS` and at most `TICKET_MAX` live at once (oldest first). Nothing is stored on disk, nothing is read by
 * any other file. No Electron import (the background service loads it).
 */
export const HOST_CALL_SERVER_KEY = "agentlas-server-apps";
/** basis: the proxy's own request wait (requestTimeoutMs(0) = 60 s) is the longest it lets pass between its approval answer and the frame reaching the child. Reached: the record is dropped and the call goes out as unapproved (a read still runs). */
export const TICKET_MS = 60_000;
/** basis: the server's concurrent-call number (4) times the two attempts a runtime may have in flight per call = 8 (contract section 2 "동시 4"). Reached: the oldest record is dropped (that call, if it arrives later, is unapproved). */
export const TICKET_MAX = 8;

const tickets = new Map<string, number>();

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}
const digest = (tool: string, args: unknown): string => createHash("sha256").update(`${tool}\n${canonical(args ?? {})}`).digest("hex");

/** The approval answer for this call was not "deny". Only this host server's tools are recorded (nothing grows for any other server). */
export function grantHostCall(serverKey: string, tool: string, args: unknown, now = Date.now()): void {
  if (serverKey !== HOST_CALL_SERVER_KEY) return;
  for (const [key, expires] of tickets) if (expires <= now) tickets.delete(key);
  tickets.set(`${digest(tool, args)}#${now}#${tickets.size}`, now + TICKET_MS);
  while (tickets.size > TICKET_MAX) { const oldest = tickets.keys().next().value; if (oldest === undefined) break; tickets.delete(oldest); }
}

/** Takes one record of this exact call (tool and arguments); true when there was one. Used once per call. */
export function consumeHostCall(tool: string, args: unknown, now = Date.now()): boolean {
  const want = `${digest(tool, args)}#`;
  for (const [key, expires] of tickets) {
    if (expires <= now) { tickets.delete(key); continue; }
    if (key.startsWith(want)) { tickets.delete(key); return true; }
  }
  return false;
}

/** For a gate. */
export function hostCallTicketCount(): number { return tickets.size; }

/*
 * What the host DECLARED about each tool of a live bundle for the approval rule: the marks the bridge lists (readOnlyHint, destructiveHint, openWorldHint) and, for a tool the server declares
 * as costing money, `costsMoneyHint`. The MCP SDK drops every annotation key it does not know when it parses a tool list (measured: SDK 1.32.1 keeps four keys and strips `costsMoneyHint`),
 * and Codex's approval request carries no annotations at all, so the runtimes that do not read the raw list (the in-process loop, Codex) would ask without the marks a CLI behind the proxy sees.
 * This registry is the one place they all read the same marks from; it is the host's own copy, never the server's answer at call time. Memory only, ended with the bundle.
 */
const toolMarks = new Map<string, ReadonlyMap<string, ApprovalToolAnnotations>>();
export function declareHostToolMarks(bundleId: string, marks: Iterable<readonly [string, ApprovalToolAnnotations]>): void { toolMarks.set(bundleId, new Map(marks)); }
export function releaseHostToolMarks(bundleId: string): void { toolMarks.delete(bundleId); costHosts.delete(bundleId); }
export function hostToolMarks(serverKey: string, tool: string): ApprovalToolAnnotations | null {
  if (serverKey !== HOST_CALL_SERVER_KEY) return null;
  for (const marks of toolMarks.values()) { const found = marks.get(tool); if (found) return found; }
  return null;
}
export function clearHostCallTickets(): void { tickets.clear(); }

/*
 * Contract section 14: the server may list, on the `web__request` tool, the exact API hosts of the services the person saved a key for AND whose public price page bills every call to that person
 * (`effects.costsMoneyHosts`). A call of that tool whose target host IS one of them is a money call (`costsMoneyHint`, the same mark `costsMoney` writes: the money card, every time, in every mode). Decided from the
 * call's own URL by comparing the parsed host to the list, never by reading a word. Anything else - no list, a URL that does not parse, a host that differs in any way (case, a trailing dot, a port, user info,
 * a subdomain, an IP) - is "no mark": the call goes as before. Memory only, ended with the bundle.
 */
const costHosts = new Map<string, ReadonlyMap<string, readonly string[]>>();
export function declareHostCostHosts(bundleId: string, entries: Iterable<readonly [string, readonly string[]]>): void { costHosts.set(bundleId, new Map(entries)); }
/** true only when `url` is a string that parses and its host, written exactly as it is in the text (lower case, no user info, no port, no trailing dot), is in `hosts`. */
export function urlHostIsListed(url: unknown, hosts: readonly string[]): boolean {
  if (typeof url !== "string" || !hosts.length) return false;
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.host !== parsed.hostname) return false;
    if (url.slice(0, parsed.protocol.length + 2 + parsed.host.length) !== `${parsed.protocol}//${parsed.host}`) return false;
    return hosts.includes(parsed.hostname);
  } catch { return false; }
}
/** The marks of THIS call: the host's copy for the tool (`hostToolMarks`) plus `costsMoneyHint` when the call's URL host is in the tool's declared list. null when the host declared nothing for the tool and nothing matched. */
export function hostCallMarks(serverKey: string, tool: string, args: unknown): ApprovalToolAnnotations | null {
  const base = hostToolMarks(serverKey, tool);
  if (serverKey !== HOST_CALL_SERVER_KEY) return base;
  let hosts: readonly string[] | undefined;
  for (const entries of costHosts.values()) { const found = entries.get(tool); if (found) { hosts = found; break; } }
  const url = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).url : undefined;
  return hosts && urlHostIsListed(url, hosts) ? { ...(base ?? {}), costsMoneyHint: true } : base;
}

/*
 * Which tools of this host server only read (the stored list's own marks, copied at mint time). The approval gates of the proxy and of Codex ask "is this call a
 * change?" by a closed table of names; a connected app's tools are not in any table, so without this every one of them - a plain search included - would count as a
 * change and a read-permission turn (a woken one) could never read an app. A name is a read only when a live bundle declared it so; unknown means a change.
 */
const readTools = new Map<string, ReadonlySet<string>>();
export function declareHostReadTools(bundleId: string, names: Iterable<string>): void { readTools.set(bundleId, new Set(names)); }
export function releaseHostReadTools(bundleId: string): void { readTools.delete(bundleId); }
export function hostToolIsRead(serverKey: string, tool: string): boolean {
  if (serverKey !== HOST_CALL_SERVER_KEY) return false;
  for (const names of readTools.values()) if (names.has(tool)) return true;
  return false;
}
