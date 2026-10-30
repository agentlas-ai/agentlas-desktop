import { APP_CONTROL_CATALOG, type AppControlCatalogEntry } from "./catalog.generated";
import { APP_CONTROL_ARGUMENT_SCHEMAS } from "./argument-schemas.generated";
import { appControlOmittedFromModelCatalog, appControlPolicy } from "./policy";

/*
 * Reading a model's app.call the way the model meant it, before the dispatcher judges it.
 *
 * The dispatcher (service.ts appControlCallLocal) refuses an argument it does not know, an `args` that is not an object,
 * a required `chatId` that is absent and an operation it has never heard of. Observed in use (failure_events,
 * harness_call app.call): 30 of those refusals were a model that had the right operation and the right value under a
 * neighbouring name -- chats.getGoalContext {chatId} (it takes `id`), automations.latestRun {id} (it takes `automationId`),
 * `args: []` for an operation with no arguments, invoke.latestReceipt {} (the conversation it is asked from), the harness
 * operations app.operations / app.describe named as if they were app operations, automations.getGoalResumeReview for the one
 * operation that is called chats.getGoalResumeReview. Each of those has exactly one possible reading, so it is read that way
 * and the reply says what was read (`resolved`); anything with two readings is left to the dispatcher's own refusal.
 *
 * Pure: the catalog and its argument schemas are generated data, no host, no Electron, so the daemon runs it too.
 * Writes are never guessed at: an operation is resolved by neighbouring name only when it only reads.
 */

export type AppCallResolution =
  | { kind: "port"; port: string; args: Record<string, unknown> }
  | { kind: "call"; operation: unknown; args: unknown; resolved: Array<Record<string, string>> };

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const idLike = (name: string): boolean => name === "id" || /[a-z]Id$/.test(name) || /_id$/i.test(name);

let byPath: Map<string, AppControlCatalogEntry> | null = null;
function visibleOperations(): Map<string, AppControlCatalogEntry> {
  // The model's own catalog: an operation it is not offered (policy.ts MODEL_CATALOG_OMITTED) is not offered by this either.
  return byPath ??= new Map(APP_CONTROL_CATALOG.filter((entry) => !appControlOmittedFromModelCatalog(entry)).map((entry) => [entry.path, entry]));
}
const readsOnly = (entry: AppControlCatalogEntry): boolean => {
  const policy = appControlPolicy(entry);
  return policy.allowed && policy.effect === "read";
};
const requiredOf = (path: string): string[] => {
  const required = APP_CONTROL_ARGUMENT_SCHEMAS[path]?.required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
};

/** The one catalog operation a not-quite-right name stands for, or null when it names none or more than one. */
function neighbouringOperation(path: string): AppControlCatalogEntry | null {
  const all = visibleOperations();
  const parts = path.split(".");
  // The same operation under a different first area: automations.runLedger.events -> runLedger.events.
  for (let at = 1; at < parts.length - 1; at += 1) {
    const found = all.get(parts.slice(at).join("."));
    if (found && readsOnly(found)) return found;
  }
  // A long, specific verb that only one operation carries: automations.getGoalResumeReview -> chats.getGoalResumeReview.
  const verb = parts[parts.length - 1] ?? "";
  if (parts.length < 2 || verb.length < 8) return null;
  const same = [...all.values()].filter((entry) => entry.path.endsWith(`.${verb}`));
  return same.length === 1 && readsOnly(same[0]) ? same[0] : null;
}

/** `args` as the object the dispatcher takes: an empty array is no arguments, one bare value is the operation's single argument. */
function argumentObject(entry: AppControlCatalogEntry, raw: unknown): unknown {
  if (raw === undefined || raw === null) return {};
  let value = raw;
  if (typeof value === "string" && value.trim().startsWith("{")) { try { value = JSON.parse(value); } catch { return raw; } }
  if (isObject(value)) return { ...value };
  if (!Array.isArray(value)) return raw;
  if (value.length === 0) return {};
  const required = requiredOf(entry.path);
  const sole = required.length === 1 ? required[0] : required.length === 0 && entry.params.length === 1 ? entry.params[0] : null;
  if (value.length === 1 && sole && (typeof value[0] === "string" || typeof value[0] === "number")) return { [sole]: value[0] };
  return raw;
}

/**
 * App operations that answer only through a harness port, because the port checks the conversation the operation cannot (service.ts
 * CHAT_SCOPED_OPERATIONS). app.call liveDocument.render {sessionId, from, count} was refused "chat-scope-required" with the port's name in
 * the text (10-24): the model had the right call, so it is run as the port, which takes the same arguments and keeps its own chat check.
 */
const APP_OPERATION_PORT: Readonly<Record<string, string>> = { "liveDocument.render": "document.render" };

export function resolveAppCallRequest(
  operation: unknown,
  rawArgs: unknown,
  options: { chatId?: string | null; harnessPorts: ReadonlySet<string> },
): AppCallResolution {
  const passthrough: AppCallResolution = { kind: "call", operation, args: rawArgs, resolved: [] };
  const path = typeof operation === "string" ? operation.trim() : "";
  if (!path) return passthrough;
  const asPort = APP_OPERATION_PORT[path];
  if (asPort && options.harnessPorts.has(asPort)) {
    const args = typeof rawArgs === "string" ? (() => { try { return JSON.parse(rawArgs) as unknown; } catch { return null; } })() : rawArgs;
    return { kind: "port", port: asPort, args: isObject(args) ? args : {} };
  }
  const all = visibleOperations();
  let entry = all.get(path) ?? null;
  const resolved: Array<Record<string, string>> = [];
  if (!entry) {
    // A harness operation named as an app operation (app.operations, app.describe...): it is run as itself.
    if (options.harnessPorts.has(path)) {
      const args = typeof rawArgs === "string" ? (() => { try { return JSON.parse(rawArgs) as unknown; } catch { return null; } })() : rawArgs;
      return { kind: "port", port: path, args: isObject(args) ? args : {} };
    }
    // The host's own `app.*` operations (service.ts HOST_OPERATIONS) are no catalog entries: they are never read as another name.
    entry = path.startsWith("app.") ? null : neighbouringOperation(path);
    if (!entry) return passthrough;
    resolved.push({ kind: "operation", from: path, to: entry.path });
  }
  const args = argumentObject(entry, rawArgs);
  if (!isObject(args)) return { kind: "call", operation: entry.path, args, resolved };

  const params = new Set(entry.params);
  const required = requiredOf(entry.path);
  // Neighbouring names for a parameter the call is missing: one unknown key, one missing parameter, one reading.
  const unknown = Object.keys(args).filter((key) => !params.has(key));
  const open = () => entry!.params.filter((param) => args[param] === undefined);
  for (const key of unknown) {
    const targets = open();
    const same = targets.filter((param) => normalize(param) === normalize(key));
    let target: string | null = same.length === 1 ? same[0] : null;
    // An id under the conversation's / run's / goal's name for the operation's plain `id`: chats.getGoalContext {chatId} -> {id}.
    if (!target && idLike(key) && key !== "id" && targets.includes("id") && unknown.filter((other) => idLike(other) && other !== "id").length === 1
      && !targets.some((param) => param !== "id" && normalize(param) === normalize(key))) target = "id";
    // The plain `id` for the one parameter that is an id of this operation's subject: automations.latestRun {id} -> {automationId}.
    if (!target && key === "id") {
      const ids = targets.filter((param) => /[a-z]Id$/.test(param) && required.includes(param));
      if (ids.length === 1) target = ids[0];
    }
    if (!target) continue;
    args[target] = args[key];
    delete args[key];
    resolved.push({ kind: "argument", from: key, to: target });
  }
  // The conversation a read is asked from, when it asks for one and the call named none (invoke.latestReceipt {}, goalPanel.view {}).
  if (required.includes("chatId") && args.chatId === undefined && readsOnly(entry) && options.chatId && options.chatId !== "ui") {
    args.chatId = options.chatId;
    resolved.push({ kind: "default", from: "chatId", to: "this conversation" });
  }
  // An identifier the operation does not take, beside every one it does (invoke.receipt {chatId, runId}): a read is not changed by it.
  if (readsOnly(entry) && required.every((key) => args[key] !== undefined)) {
    for (const key of Object.keys(args).filter((name) => !params.has(name))) {
      if (!idLike(key)) continue;
      delete args[key];
      resolved.push({ kind: "ignored", from: key, to: `${entry.path} takes ${entry.params.join(", ") || "no arguments"}` });
    }
  }
  return { kind: "call", operation: entry.path, args, resolved };
}
