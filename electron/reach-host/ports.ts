import { runAppleScript } from "../reach/applescript";
import { isPublishedOffLimits, isSensitiveApp } from "../reach/explore-policy";
import { isDirectMenuCommand, isCurrentDialogCapability, type CapabilityPolicyContext } from "../reach/map";
import { findLiveCandidates, firstWithWindow } from "../reach/app-match";
import { exploreApp } from "../reach/explorer";
import { findMenuWindow } from "../reach/menu-probe";
import { withForeground } from "../reach/foreground";
import { repairDialogCapability } from "../reach/repair";
import { runSteps } from "../reach/steps-runner";
import type { AppRecord, Capability, CapabilityParameter } from "../reach/types";
import { getReachRuntime, type ReachRuntime } from "./runtime";

/*
 * Harness ports for Agentlas Reach (reach.*). Every surface reaches them the same way: the model through harness_search / harness_describe /
 * harness_call, the UI and SDK through callHarnessPort. They answer from the map and the registry that the background service keeps; they
 * never read an app themselves except to carry out one capability the caller named.
 *
 *   reach.map       which installed apps there are and how far each is usable          (query)
 *   reach.app       one app's capabilities                                              (query)
 *   reach.describe  one capability: parameters as JSON Schema, effect, how it is carried out (query)
 *   reach.status    the background service's state                                      (query)
 *   reach.invoke    carry out one capability                                            (command, needs write unless a declared read)
 *   reach.explore   look at one running app now                                         (command, write)
 *   reach.verify    check a capability still works and re-read it if the app moved      (command, write)
 *
 * No electron import (the daemon loads the harness). Driving an app needs the desktop's driver: a host without one answers `unavailable`
 * with the reason instead of pretending.
 */

type Outcome =
  | { status: "ok"; data: unknown }
  | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

// signal: the calling turn's lifetime (HarnessCallContext.signal). Stop or a cancelled goal aborts it; a call that drives an app has to follow it.
interface Ctx { chatId: string; runId: string; dryRun?: boolean; permission?: "read" | "write" | "full"; signal?: AbortSignal }

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const refused = (reason: string, next?: string, data?: unknown): Outcome => ({ status: "refused", reason, ...(next ? { next } : {}), ...(data !== undefined ? { data } : {}) });
const stopped = (ctx: Ctx): boolean => ctx.signal?.aborted === true;
const aborted = (): Outcome => refused("aborted", "the run was stopped; the app was left as it was");
const unavailable = (reason: string, next?: string): Outcome => ({ status: "unavailable", reason, ...(next ? { next } : {}) });
const writable = (ctx: Ctx): boolean => ctx.permission === "write" || ctx.permission === "full";
const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(low, Math.min(high, n));
};
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const MAX_RESULT_CHARS = 24_000;

// ---- helpers ---------------------------------------------------------------------------------------------------------------------------
async function resolveApp(rt: ReachRuntime, ref: string): Promise<{ ok: true; app: AppRecord } | { ok: false; outcome: Outcome }> {
  const map = await rt.readMap();
  if (!map) return { ok: false, outcome: unavailable("map_not_ready", "the app map is built in the background shortly after Agentlas starts; try again in a minute") };
  const exact = map.apps.find((app) => app.key === ref);
  if (exact) return { ok: true, app: exact };
  const wanted = ref.toLowerCase();
  const byName = map.apps.filter((app) => app.name.toLowerCase() === wanted);
  if (byName.length === 1) return { ok: true, app: byName[0] };
  const partial = byName.length > 1 ? byName : map.apps.filter((app) => app.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return { ok: true, app: partial[0] };
  if (partial.length === 0) return { ok: false, outcome: refused("app_unknown", "reach.map lists the installed apps and their keys") };
  return { ok: false, outcome: refused("app_ambiguous", "name one of these by its key", { candidates: partial.slice(0, 6).map((app) => ({ key: app.key, name: app.name, version: app.version })) }) };
}

async function allCapabilities(rt: ReachRuntime, app: AppRecord): Promise<Capability[]> {
  const [harvest, learned] = await Promise.all([rt.readHarvest(app.key), rt.registry.capabilities(app.key)]);
  return [...(harvest ?? []), ...learned];
}

// The object classes the app's own dictionary names: the ones a property acts on, and the ones its commands take as specifiers.
function classesOf(capabilities: readonly Capability[]): Set<string> {
  const classes = new Set<string>(["application"]);
  for (const capability of capabilities) {
    if (capability.target) classes.add(capability.target);
    for (const parameter of capability.parameters) for (const match of parameter.type.matchAll(/specifier:([^,|>]+)/g)) classes.add(match[1].trim());
  }
  return classes;
}

const TIER_PREFERENCE = ["explored", "published", "app-protocol", "external-tool", "structure"];

function findCapability(list: readonly Capability[], ref: string): { ok: true; capability: Capability } | { ok: false; outcome: Outcome } {
  const exact = list.find((capability) => capability.id === ref);
  if (exact) return { ok: true, capability: exact };
  const byName = list.filter((capability) => capability.name === ref || capability.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return { ok: true, capability: byName[0] };
  if (byName.length > 1) {
    const best = [...byName].sort((a, b) => TIER_PREFERENCE.indexOf(a.tier) - TIER_PREFERENCE.indexOf(b.tier));
    // the same name at different tiers: the more reliable one wins, but only if it is the only one of its tier
    if (best[0].tier !== best[1].tier) return { ok: true, capability: best[0] };
    return { ok: false, outcome: refused("capability_ambiguous", "use the capability id", { candidates: byName.slice(0, 6).map((c) => ({ id: c.id, tier: c.tier })) }) };
  }
  return { ok: false, outcome: refused("capability_unknown", "reach.app lists an app's capabilities and their ids") };
}

function policyContext(app: AppRecord): CapabilityPolicyContext {
  return { sensors: app.signals.some((signal) => signal.startsWith("sensor:")), name: app.name, bundleId: bundleOf(app.key) ?? app.key, platform: app.platform };
}

// A scripting (published) capability of an app Reach never scripts: still listed, never callable.
function publishedOffLimits(capability: Capability, context: CapabilityPolicyContext = {}): boolean {
  return capability.body?.kind !== "steps" && isPublishedOffLimits({ name: context.name ?? "", bundleId: context.bundleId });
}

function usableNow(capability: Capability, context: CapabilityPolicyContext = {}): boolean {
  if (capability.generic || capability.status === "degraded" || publishedOffLimits(capability, context)) return false;
  if (capability.tier === "structure") return isDirectMenuCommand(capability, context); // the live menu confirms each command
  if (capability.tier === "explored" && !isCurrentDialogCapability(capability, context)) return false;
  if (capability.tier === "published" && capability.status === undefined) return true;
  return capability.status === "verified";
}

function jsonSchemaType(parameter: CapabilityParameter): Record<string, unknown> {
  const type = parameter.type;
  const withDescription = (schema: Record<string, unknown>) => (parameter.description ? { ...schema, description: parameter.description } : schema);
  if (type === "string") return withDescription({ type: "string" });
  if (type === "integer") return withDescription({ type: "integer" });
  if (type === "number") return withDescription({ type: "number" });
  if (type === "boolean") return withDescription({ type: "boolean" });
  if (type === "path") return withDescription({ type: "string", description: `${parameter.description ? `${parameter.description}; ` : ""}an absolute path` });
  if (type.startsWith("enum:") || (parameter.enumValues && parameter.enumValues.length > 0)) {
    const members = parameter.enumValues ?? type.slice(5).split("|");
    return withDescription({ type: "string", enum: members });
  }
  if (type.startsWith("list<") && type.endsWith(">")) return withDescription({ type: "array", items: jsonSchemaType({ ...parameter, type: type.slice(5, -1), description: undefined }) });
  if (type.startsWith("specifier")) {
    return withDescription({ type: "array", description: `${parameter.description ? `${parameter.description}; ` : ""}segments of an object reference, innermost first`, items: { type: "object", properties: { class: { type: "string" }, index: { type: "integer" }, name: { type: "string" }, id: {} }, required: ["class"] } });
  }
  return withDescription({});
}

export function inputSchemaOf(capability: Capability): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of capability.parameters) {
    properties[parameter.name] = jsonSchemaType(parameter);
    if (parameter.required) required.push(parameter.name);
  }
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function row(capability: Capability, context: CapabilityPolicyContext): Record<string, unknown> {
  return {
    id: capability.id,
    name: cut(capability.name, 120),
    tier: capability.tier,
    kind: capability.kind,
    ...(capability.granularity === "property" ? { granularity: "property" } : {}),
    usable: usableNow(capability, context),
    ...(capability.status ? { status: capability.status } : {}),
    ...(capability.verification ? { verification: capability.verification } : {}),
    effect: capability.effect.class,
    parameters: capability.parameters.length,
    ...(capability.traits?.length ? { traits: capability.traits } : {}),
  };
}

// ---- queries ---------------------------------------------------------------------------------------------------------------------------
export async function reachMap(args: Record<string, unknown>): Promise<Outcome> {
  const rt = await getReachRuntime();
  const map = await rt.readMap();
  if (!map) return unavailable("map_not_ready", "the app map is built in the background shortly after Agentlas starts; try again in a minute");
  const query = str(args.query).toLowerCase();
  const level = str(args.level);
  const limit = clamp(args.limit, 1, 60, 30);
  const offset = clamp(args.offset, 0, 100_000, 0);
  const order: Record<string, number> = { scriptable: 0, partial: 1, unmapped: 2 };
  const apps = map.apps
    .filter((app) => (!query || app.name.toLowerCase().includes(query) || app.key.toLowerCase().includes(query)) && (!level || app.level === level))
    .sort((a, b) => order[a.level] - order[b.level] || b.usableCount - a.usableCount || a.name.localeCompare(b.name));
  const page = apps.slice(offset, offset + limit);
  const explored = await Promise.all(page.map(async (app) => (await rt.registry.capabilities(app.key)).filter((capability) => capability.tier === "explored" && usableNow(capability, policyContext(app))).length));
  return {
    status: "ok",
    data: {
      generatedAt: map.generatedAt,
      platform: map.platform,
      totals: { apps: map.totals.apps, ...map.totals.byLevel },
      total: apps.length,
      truncated: offset + page.length < apps.length,
      apps: page.map((app, index) => ({ key: app.key, name: cut(app.name, 80), ...(app.version ? { version: app.version } : {}), kind: app.kind, level: app.level, usable: app.usableCount, published: app.capabilitiesByTier.published ?? 0, explored: explored[index] })),
    },
  };
}

export async function reachApp(args: Record<string, unknown>): Promise<Outcome> {
  const rt = await getReachRuntime();
  const resolved = await resolveApp(rt, str(args.app));
  if (!resolved.ok) return resolved.outcome;
  const context = policyContext(resolved.app);
  const search = str(args.search).toLowerCase();
  const tier = str(args.tier);
  const limit = clamp(args.limit, 1, 50, 25);
  const offset = clamp(args.offset, 0, 100_000, 0);
  const list = (await allCapabilities(rt, resolved.app)).filter((capability) =>
    (!search || capability.name.toLowerCase().includes(search)) && (!tier || capability.tier === tier) && (args.usable !== true || usableNow(capability, context)) && !capability.generic);
  // operations before property reads; usable before candidates
  list.sort((a, b) => Number(usableNow(b, context)) - Number(usableNow(a, context)) || (a.granularity === b.granularity ? 0 : a.granularity === "operation" ? -1 : 1) || a.name.localeCompare(b.name));
  const page = list.slice(offset, offset + limit);
  return {
    status: "ok",
    data: {
      app: { key: resolved.app.key, name: resolved.app.name, level: resolved.app.level },
      total: list.length,
      truncated: offset + page.length < list.length,
      capabilities: page.map((capability) => row(capability, context)),
    },
  };
}

function runnableReason(capability: Capability, rt: ReachRuntime, context: CapabilityPolicyContext): string | null {
  if (publishedOffLimits(capability, context)) return "Reach does not script this app: it holds credentials, money, messages or the system";
  if (capability.status === "degraded") return "it failed when last used; Reach re-reads it when the owner is away";
  if (!usableNow(capability, context)) return "only seen so far: it becomes callable once an exploration has opened and closed its dialog";
  if (capability.body?.kind === "steps") return rt.gui ? null : "this host has no driver for the app's screen";
  if (capability.source.kind === "sdef") return rt.platform === "darwin" ? null : "AppleScript runs only on macOS";
  return `${capability.source.kind} capabilities cannot be called yet`;
}

export async function reachDescribe(args: Record<string, unknown>): Promise<Outcome> {
  const rt = await getReachRuntime();
  const resolved = await resolveApp(rt, str(args.app));
  if (!resolved.ok) return resolved.outcome;
  const found = findCapability(await allCapabilities(rt, resolved.app), str(args.capability));
  if (!found.ok) return found.outcome;
  const capability = found.capability;
  const context = policyContext(resolved.app);
  const reason = runnableReason(capability, rt, context);
  return {
    status: "ok",
    data: {
      app: { key: resolved.app.key, name: resolved.app.name, version: resolved.app.version },
      id: capability.id,
      name: capability.name,
      tier: capability.tier,
      kind: capability.kind,
      ...(capability.description ? { description: cut(capability.description, 400) } : {}),
      usable: usableNow(capability, context),
      ...(capability.status ? { status: capability.status } : {}),
      ...(capability.verification ? { verification: capability.verification } : {}),
      effect: capability.effect,
      inputSchema: inputSchemaOf(capability),
      ...(capability.result ? { result: capability.result } : {}),
      ...(capability.postconditions?.length ? { postconditions: capability.postconditions } : {}),
      ...(capability.revision ? { revision: capability.revision } : {}),
      carriedOutBy: capability.body?.kind === "steps" ? `${capability.body.steps.length} driver steps` : capability.body?.kind === "adapter" ? capability.body.interface : capability.source.kind,
      runnable: reason === null,
      ...(reason ? { notRunnableBecause: reason } : {}),
      next: reason === null
        ? (capability.effect.class === "read" && capability.effect.basis === "declared" ? "reach.invoke with these parameters" : "reach.invoke with these parameters; it needs the run's write permission because what it does is not declared")
        : publishedOffLimits(capability, context) ? "choose another app; Reach does not script this one"
        : "choose another capability, or ask the owner to turn on app exploration in Settings",
    },
  };
}

export async function reachStatus(): Promise<Outcome> {
  const rt = await getReachRuntime();
  const status = rt.service?.getStatus();
  return { status: "ok", data: { ...(status ?? { enabled: false, mapAt: (await rt.readMap())?.generatedAt ?? null }), explorationSwitch: rt.exploreEnabled(), driver: rt.gui ? (rt.gui.running ? "running" : "idle") : "unavailable_in_this_host" } };
}

// ---- commands --------------------------------------------------------------------------------------------------------------------------
function bundleOf(key: string): string | null {
  return key.startsWith("bundle:") ? key.slice("bundle:".length).split("@")[0] : null;
}

async function liveTarget(rt: ReachRuntime, app: { key: string; name: string; path?: string }, actuator: import("../reach/actuator").Actuator, signal?: AbortSignal): Promise<{ pid: number; windowId: number; name: string } | { error: string }> {
  const apps = await actuator.listApps({ signal });
  const candidates = findLiveCandidates(app, apps);
  if (candidates.length === 0) return { error: "app_not_running" };
  // the process that was picked is not a sensitive app, whatever the map's record says (independent review 4, S2)
  if (candidates.some((candidate) => isSensitiveApp({ name: candidate.name, bundleId: candidate.bundleId }))) return { error: "app_off_limits" };
  // the window that carries the app's menu bar (an About box or a panel has none), looked for in each process of the program until one has it
  const found = await firstWithWindow(candidates, (live) => findMenuWindow(actuator, live.pid, signal));
  if (!found) return { error: "app_has_no_window" };
  return { pid: found.live.pid, windowId: found.window.windowId, name: found.live.name };
}

function guiRefusal(error: string): Outcome {
  const next: Record<string, string> = {
    app_not_running: "open the app first; Reach only drives an app that is already running",
    app_has_no_window: "bring one of the app's windows on screen first",
    app_off_limits: "Reach never drives this app (it holds secrets, messages or settings)",
    gui_not_supported_for_this_app: "only macOS apps are driven through their screen in this version",
    cua_download_failed: "the driver could not be downloaded; the owner can retry from Settings > Explore this desktop's apps",
    driver_unavailable: "the driver could not be started",
    gui_busy: "another job is using the screen right now (Reach drives one app at a time); try again in a moment",
    cannot_bring_forward: "the app would not come to the front (macOS refused); try again when it is not busy",
  };
  return unavailable(error, next[error] ?? "the app's screen could not be driven");
}

export async function reachInvoke(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return refused("dry_run", "nothing was run");
  if (stopped(ctx)) return aborted();
  const rt = await getReachRuntime();
  const resolved = await resolveApp(rt, str(args.app));
  if (!resolved.ok) return resolved.outcome;
  const found = findCapability(await allCapabilities(rt, resolved.app), str(args.capability));
  if (!found.ok) return found.outcome;
  const capability = found.capability;
  const context = policyContext(resolved.app);
  // The app's own scripting interface is held to the same off-limits screen as its screen: reach.explore refuses Terminal and Mail, so reach.invoke
  // must not run their `do script` or read their message bodies. Said before the permission check, because no permission would make it allowed.
  if (publishedOffLimits(capability, context)) return refused("app_off_limits", "Reach never scripts apps that hold credentials, money, messages or the system");
  // A menu command stored by an older, looser rule is asked again at the moment of the call - with what is known about this app (a camera, a microphone, a location
  // makes the rule stricter) - and withdrawn when it no longer passes (independent review 7, V1): nothing is pressed.
  if ((capability.tier === "structure" && capability.traits?.includes("menu-command") && !isDirectMenuCommand(capability, context))
    || (capability.tier === "explored" && !isCurrentDialogCapability(capability, context))) {
    if (rt.service) await rt.service.onInvokeOutcome(resolved.app.key, resolved.app.fingerprint, capability.id, { ok: false, code: "rule_tightened" });
    else await rt.registry.recordOutcome(resolved.app.key, resolved.app.fingerprint, capability.id, { ok: false, code: "rule_tightened" }, rt.day());
    return refused("capability_not_usable", "the current exploration rule no longer allows this stored capability");
  }
  if (!usableNow(capability, context)) return refused("capability_not_usable", capability.status === "degraded" ? "it failed when last used; Reach repairs it when the owner is away, or pick another" : "it has only been seen, not proven; reach.app with usable:true lists what is ready");
  // A read the source itself declares can run under a read-only run; anything whose effect is not declared needs the run's write permission.
  const declaredRead = capability.effect.class === "read" && capability.effect.basis === "declared";
  if (!declaredRead && !writable(ctx)) return refused("permission_required", "this run may only read; what this capability does is not declared, so it needs write permission");
  const parameters = args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters) ? (args.parameters as Record<string, unknown>) : {};
  const reason = runnableReason(capability, rt, context);
  if (reason) return unavailable("not_runnable", reason);

  if (capability.body?.kind === "steps") {
    const gui = rt.gui;
    if (!gui) return unavailable("no_driver_in_this_host", "run this from the desktop app");
    const outcome = await gui.use(async (actuator) => {
      // Stop can arrive while this call waited for the screen lease: the app is not touched then.
      if (stopped(ctx)) return { guiError: "aborted" } as const;
      const target = await liveTarget(rt, resolved.app, actuator, ctx.signal);
      if ("error" in target) return { guiError: target.error } as const;
      const front = await withForeground(actuator, { pid: target.pid, windowId: target.windowId }, () => runSteps({ actuator, target: { pid: target.pid, windowId: target.windowId }, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(rt.sleep ? { sleep: rt.sleep, settleMs: 1 } : {}) }, capability, parameters), ctx.signal, rt.sleep);
      return front.ok ? ({ run: front.value } as const) : ({ guiError: front.code } as const);
    });
    // A driver call that failed because the run was stopped is a stop, not "the app's screen could not be driven".
    if (!outcome.ok) return stopped(ctx) ? aborted() : guiRefusal(outcome.error);
    if ("guiError" in outcome.value) return stopped(ctx) ? aborted() : guiRefusal(outcome.value.guiError as string);
    const run = outcome.value.run;
    // A call that did not finish because the run was stopped says nothing about the capability, and the reason is the stop, not a refused step.
    if (!run.ok && stopped(ctx)) return aborted();
    // Only a failure that says the app's screen moved (the runner marks it repairable) degrades the capability; a call with wrong arguments, an app that was
    // not in front or a cancelled call leaves a healthy capability usable.
    await rt.service?.onInvokeOutcome(resolved.app.key, resolved.app.fingerprint, capability.id, { ok: run.ok, code: run.code, repairable: run.repairable });
    return run.ok
      ? { status: "ok", data: { ok: true, stepsRun: run.stepsRun, postcondition: run.postcondition ?? "unknown" } }
      : { status: "refused", reason: run.code ?? "step_failed", next: run.repairable ? "the app's screen seems to have changed; Reach will re-read it when the owner is away and this works again afterwards" : "the call did not complete; the dialog it opened was closed", data: { ok: false, message: cut(run.message ?? "", 300), stepsRun: run.stepsRun } };
  }

  // a published capability: the app's own scripting interface
  const bundleId = bundleOf(resolved.app.key);
  if (!bundleId) return unavailable("not_runnable", "only apps identified by a bundle id can be scripted");
  const harvest = (await rt.readHarvest(resolved.app.key)) ?? [];
  const knownClasses = classesOf(harvest);
  if (stopped(ctx)) return aborted();
  const result = await runAppleScript(rt.exec, { bundleId, capability, parameters, knownClasses });
  await rt.service?.onInvokeOutcome(resolved.app.key, resolved.app.fingerprint, capability.id, { ok: result.ok, code: result.code });
  if (result.ok) return { status: "ok", data: { ok: true, value: cut(result.value ?? "", MAX_RESULT_CHARS) } };
  const next: Record<string, string> = {
    automation_denied: "macOS needs the owner to allow Agentlas to control this app (System Settings > Privacy & Security > Automation)",
    bad_value: "the parameters do not fit the capability; reach.describe shows them",
    missing_parameter: "reach.describe lists the required parameters",
    timeout: "the app did not answer in time; it may be showing a dialog",
  };
  return { status: "refused", reason: result.code ?? "applescript_error", ...(result.code && next[result.code] ? { next: next[result.code] } : {}), data: { ok: false, message: cut(result.message ?? "", 300) } };
}

export async function reachExplore(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return refused("dry_run", "nothing was opened");
  if (!writable(ctx)) return refused("permission_required", "exploring brings the app to the front and opens its dialogs; the run needs write permission");
  if (stopped(ctx)) return aborted();
  const rt = await getReachRuntime();
  if (!rt.gui) return unavailable("no_driver_in_this_host", "run this from the desktop app");
  const resolved = await resolveApp(rt, str(args.app));
  if (!resolved.ok) return resolved.outcome;
  if (isSensitiveApp({ name: resolved.app.name, bundleId: bundleOf(resolved.app.key) ?? undefined })) return refused("app_off_limits", "Reach never explores apps that hold credentials, money, messages or the system");
  const bundleId = bundleOf(resolved.app.key) ?? undefined;
  // Stop ends the exploration after the dialog in hand is closed (exploreApp's shouldStop / signal), and a Stop that arrived while this waited for the screen lease means it never starts.
  const outcome = await rt.gui.use((actuator) => stopped(ctx) ? Promise.resolve(null) : exploreApp({ actuator, registry: rt.registry, day: () => rt.day(), shouldStop: () => stopped(ctx), ...(ctx.signal ? { signal: ctx.signal } : {}), ...(rt.sleep ? { sleep: rt.sleep } : {}) }, { key: resolved.app.key, name: resolved.app.name, ...(bundleId ? { bundleId } : {}), sensors: resolved.app.signals.some((signal) => signal.startsWith("sensor:")), fingerprint: resolved.app.fingerprint }, { maxDialogs: 6, maxMillis: 120_000 }));
  if (!outcome.ok) return stopped(ctx) ? aborted() : guiRefusal(outcome.error);
  const report = outcome.value;
  if (!report) return aborted();
  if (report.skipped) return stopped(ctx) ? aborted() : guiRefusal(report.skipped === "not_running" ? "app_not_running" : report.skipped === "no_window" ? "app_has_no_window" : report.skipped === "sensitive" ? "app_off_limits" : "cannot_bring_forward");
  return { status: "ok", data: { app: report.app, menuItemsSeen: report.menuItems, dialogsTried: report.probed, nowUsable: report.verified, failed: report.failed, stoppedEarly: report.stoppedEarly, blocked: report.blocked } };
}

export async function reachVerify(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return refused("dry_run", "nothing was opened");
  if (!writable(ctx)) return refused("permission_required", "verifying brings the app to the front and opens its dialog; the run needs write permission");
  if (stopped(ctx)) return aborted();
  const rt = await getReachRuntime();
  if (!rt.gui) return unavailable("no_driver_in_this_host", "run this from the desktop app");
  const resolved = await resolveApp(rt, str(args.app));
  if (!resolved.ok) return resolved.outcome;
  const found = findCapability(await allCapabilities(rt, resolved.app), str(args.capability));
  if (!found.ok) return found.outcome;
  const capability = found.capability;
  if (capability.tier !== "explored" || capability.body?.kind !== "steps") return refused("not_verifiable_here", "only explored capabilities are re-read; a published one is stated by the app itself");
  const outcome = await rt.gui.use(async (actuator) => {
    if (stopped(ctx)) return { guiError: "aborted" } as const;
    const target = await liveTarget(rt, resolved.app, actuator, ctx.signal);
    if ("error" in target) return { guiError: target.error } as const;
    return { result: await repairDialogCapability({ actuator, target: { pid: target.pid, windowId: target.windowId }, appKey: resolved.app.key, fingerprint: resolved.app.fingerprint, day: rt.day(), ...(ctx.signal ? { signal: ctx.signal } : {}), ...(rt.sleep ? { sleep: rt.sleep } : {}) }, capability) } as const;
  });
  if (!outcome.ok) return stopped(ctx) ? aborted() : guiRefusal(outcome.error);
  if ("guiError" in outcome.value) return stopped(ctx) ? aborted() : guiRefusal(outcome.value.guiError as string);
  const result = outcome.value.result;
  if (result.status === "repaired") {
    await rt.registry.upsert(resolved.app.key, resolved.app.fingerprint, [result.capability], rt.day());
    return { status: "ok", data: { id: capability.id, status: "verified", changed: result.how !== "same" || (result.capability.revision ?? 0) > (capability.revision ?? 0), how: result.how, revision: result.capability.revision ?? 0 } };
  }
  // A re-read cut short by Stop proves nothing about the app: the capability is not marked degraded for it.
  if (stopped(ctx)) return aborted();
  await rt.service?.onInvokeOutcome(resolved.app.key, resolved.app.fingerprint, capability.id, { ok: false, code: result.reason });
  return { status: "ok", data: { id: capability.id, status: "degraded", reason: result.reason, ...(result.status === "degraded" && result.code ? { code: result.code } : {}) } };
}

// Keeps a result inside what a model can read: a bounded page of rows is cut to fit, never silently resized.
export function boundedOutcome(outcome: Outcome): Outcome {
  if (outcome.status !== "ok") return outcome;
  const text = JSON.stringify(outcome.data);
  if (text.length <= MAX_RESULT_CHARS) return outcome;
  const data = outcome.data as Record<string, unknown>;
  for (const key of ["apps", "capabilities"]) {
    const rows = data?.[key];
    if (Array.isArray(rows)) {
      let keep = rows.length;
      while (keep > 1 && JSON.stringify({ ...data, [key]: rows.slice(0, keep) }).length > MAX_RESULT_CHARS) keep = Math.floor(keep * 0.7);
      return { status: "ok", data: { ...data, [key]: rows.slice(0, keep), truncated: true } };
    }
  }
  return { status: "ok", data: { truncated: true, text: text.slice(0, MAX_RESULT_CHARS) } };
}

const bounded = (run: (args: Record<string, unknown>, ctx: Ctx) => Promise<Outcome>) => async (args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> => boundedOutcome(await run(args, ctx));

export const REACH_HANDLERS = {
  "reach.map": bounded((args) => reachMap(args)),
  "reach.app": bounded((args) => reachApp(args)),
  "reach.describe": bounded((args) => reachDescribe(args)),
  "reach.status": bounded(() => reachStatus()),
  "reach.invoke": bounded(reachInvoke),
  "reach.explore": bounded(reachExplore),
  "reach.verify": bounded(reachVerify),
} as const;
