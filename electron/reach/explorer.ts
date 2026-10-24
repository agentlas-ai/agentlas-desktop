import type { Actuator, ActuatorApp } from "./actuator";
import { probeDialog, synthesizeDialogCapability, type ProbeResult } from "./dialog-probe";
import { withForeground } from "./foreground";
import { isRiskyMenuPath, isSensitiveApp, opensFilePicker } from "./explore-policy";
import { enumerateMenus, menuCapabilities, menuLeaves, opensDialog, type MenuTarget, findMenuWindow } from "./menu-probe";
import type { CapabilityRegistry } from "./registry";
import type { Capability } from "./types";

// Explores ONE running app: reads its menu bar, then opens a bounded number of its dialog-opening menu items one by one, reads each
// dialog's controls and closes it again, and records what it learned. It runs only when the caller says the owner is away, brings the app to
// the front (the only way macOS enables its menus), and puts the previous front app back when done.

export interface ExploreApp {
  key: string;
  name: string;
  bundleId?: string;
  fingerprint: string;
}

export interface ExplorePorts {
  actuator: Actuator;
  registry: CapabilityRegistry;
  day: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // true as soon as the owner is back (or the switch is off): the current dialog is finished and closed, then exploration returns
  shouldStop: () => boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ExploreOptions {
  maxDialogs?: number;
  maxMillis?: number;
  maxMenuNodes?: number;
}

export type ExploreSkip = "sensitive" | "not_running" | "no_window" | "no_front";

export interface ExploreReport {
  app: string;
  skipped?: ExploreSkip;
  menuItems: number;
  dialogCandidates: number;
  probed: number;
  verified: number;
  failed: number;
  blocked: boolean;
  stoppedEarly: boolean;
  ms: number;
}

const emptyReport = (app: string, skipped?: ExploreSkip): ExploreReport => ({ app, ...(skipped ? { skipped } : {}), menuItems: 0, dialogCandidates: 0, probed: 0, verified: 0, failed: 0, blocked: false, stoppedEarly: false, ms: 0 });

export async function exploreApp(ports: ExplorePorts, app: ExploreApp, options: ExploreOptions = {}): Promise<ExploreReport> {
  const now = ports.now ?? Date.now;
  const started = now();
  const log = ports.log ?? (() => undefined);
  const maxDialogs = options.maxDialogs ?? 8;
  const deadline = started + (options.maxMillis ?? 90_000);
  if (isSensitiveApp({ name: app.name, bundleId: app.bundleId })) return emptyReport(app.name, "sensitive");

  const apps: ActuatorApp[] = await ports.actuator.listApps({ signal: ports.signal });
  const running = apps.find((candidate) => (app.bundleId && candidate.bundleId === app.bundleId) || candidate.name === app.name);
  if (!running || !running.running || running.pid <= 0) return emptyReport(app.name, "not_running");
  const target: MenuTarget | null = await findMenuWindow(ports.actuator, running.pid, ports.signal);
  if (!target) return emptyReport(app.name, "no_window");
  const report = emptyReport(app.name);

  await ports.registry.rebase(app.key, app.fingerprint);
  // The app is brought to the front BEFORE its menus are read: macOS validates a menu (which items are switched on) only for the app in
  // front, and a menu read while the app is behind another one shows stale "disabled" items (measured on System Information, 2026-10-23).
  // The owner's app comes back afterwards.
  let finished = true;
  const front = await withForeground(ports.actuator, target, async () => {
    // 1. the menu bar: read from the accessibility tree, nothing pressed
    const scan = await enumerateMenus(ports.actuator, target, { signal: ports.signal, shouldStop: ports.shouldStop, maxNodes: options.maxMenuNodes ?? 900, ...(ports.sleep ? { sleep: ports.sleep } : {}) });
    const leaves = menuLeaves(scan.nodes);
    report.menuItems = leaves.length;
    const day = ports.day();
    await ports.registry.upsert(app.key, app.fingerprint, menuCapabilities(app.key, scan.nodes), day);
    // A menu that would not close again means the app is not at rest: nothing else is pressed in it.
    if (scan.stuck) { report.blocked = true; finished = false; return; }
    if (ports.shouldStop() || ports.signal?.aborted) { report.stoppedEarly = true; finished = false; return; }

    // 2. which dialog-opening items are worth a try
    const existing = new Map((await ports.registry.capabilities(app.key)).map((capability) => [capability.id, capability]));
    const candidates: string[][] = [];
    for (const leaf of leaves) {
      if (!opensDialog(leaf.label) || isRiskyMenuPath(leaf.path)) continue;
      if ((ports.actuator.platform ?? "darwin") !== "darwin" && opensFilePicker(leaf.path)) continue;
      if (!leaf.enabled) continue; // switched off right now (no document): looked at again in a later pass, not counted as a failure
      const id = `${app.key}#explored:dialog/${leaf.path.join(">")}`;
      const known = existing.get(id);
      if (known?.status === "verified" && known.boundFingerprint === app.fingerprint) continue; // already proven for this version
      if (await ports.registry.shouldSkip(app.key, id)) continue;
      candidates.push(leaf.path);
    }
    report.dialogCandidates = candidates.length;

    // 3. open, read and close each one
    for (const menuPath of candidates.slice(0, maxDialogs)) {
      if (ports.shouldStop() || ports.signal?.aborted || now() > deadline) { report.stoppedEarly = true; break; }
      const result: ProbeResult = await probeDialog({ actuator: ports.actuator, target, ...(ports.sleep ? { sleep: ports.sleep } : {}), signal: ports.signal }, menuPath);
      if (result.code === "aborted") { report.stoppedEarly = true; break; } // nothing was pressed: not a failure of that item
      report.probed += 1;
      const id = `${app.key}#explored:dialog/${menuPath.join(">")}`;
      if (result.status === "ok" && result.shape) {
        const capability: Capability = synthesizeDialogCapability(app.key, menuPath, result.shape, app.fingerprint, ports.day(), ports.actuator.platform);
        await ports.registry.upsert(app.key, app.fingerprint, [capability], ports.day());
        await ports.registry.recordAttempt(app.key, app.fingerprint, id, true, "ok", ports.day());
        report.verified += 1;
      } else {
        report.failed += 1;
        await ports.registry.recordAttempt(app.key, app.fingerprint, id, false, result.code ?? result.status, ports.day());
        log(`[reach] ${app.name}: ${menuPath.join(" > ")} -> ${result.status}${result.code ? `:${result.code}` : ""}`);
        // A dialog that would not close means the app is not at rest: stop here rather than press anything else in it.
        if (result.status === "stuck") { report.blocked = true; break; }
      }
    }
  }, ports.signal, ports.sleep);
  if (!front.ok) { report.skipped = "no_front"; return finish(report, now, started); }
  if (finished) await ports.registry.markExplored(app.key, app.fingerprint, new Date().toISOString());
  return finish(report, now, started);
}

function finish(report: ExploreReport, now: () => number, started: number): ExploreReport {
  report.ms = now() - started;
  return report;
}
