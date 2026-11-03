import { LearnRecorder, type RecordedSession } from "../reach/learn-recorder";
import { learnFromTrace, norm, type LearnTrace } from "../reach/learn";
import type { AppRecord } from "../reach/types";
import { learnTap, setLearnTap } from "../computer-use/learn-tap";
import { getReachRuntime, type ReachRuntime } from "./runtime";

// Reach learns from the work an agent does on an app's screen, while it does it. The control server taps every observation and action (computer-use/learn-tap.ts);
// the recorder (reach/learn-recorder.ts) turns one stretch of work on one app into a trace; this sink resolves the app in Reach's map and keeps the trace as a
// candidate capability (reach/learn.ts), where a second matching success makes it a port. Runs only while the owner's Reach switch is on, in the Desktop's Main process.
//
// Electron-free except for the tap it installs (also Electron-free).

export function resolveMappedApp(apps: readonly AppRecord[], ref: string): AppRecord | null {
  const wanted = norm(ref);
  if (!wanted || wanted.startsWith("pid:")) return null;
  const exact = apps.filter((app) => norm(app.name) === wanted || norm(app.key) === wanted || norm(app.key.replace(/^bundle:/, "")) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = apps.filter((app) => norm(app.name).includes(wanted) || wanted.includes(norm(app.name)));
  return partial.length === 1 ? partial[0] : null;
}

export interface ReachLearning { stop(): Promise<void>; recorder: LearnRecorder }

export function installReachLearning(options: { quietMs?: number; log?: (line: string) => void; runtime?: () => Promise<ReachRuntime> } = {}): ReachLearning {
  const runtimeOf = options.runtime ?? getReachRuntime;
  let runtime: ReachRuntime | null = null;
  void runtimeOf().then((rt) => { runtime = rt; }).catch(() => undefined);
  const log = options.log ?? (() => undefined);
  const recorder = new LearnRecorder({
    enabled: () => runtime?.exploreEnabled() === true,
    log,
    async submit(session: RecordedSession): Promise<void> {
      const rt = runtime ?? await runtimeOf();
      const map = await rt.readMap();
      const app = map ? resolveMappedApp(map.apps, session.app) : null;
      if (!app) { log(`[reach-learn] ${session.app} is not in Reach's map; nothing kept`); return; }
      const bundleId = app.key.startsWith("bundle:") ? app.key.slice(7) : undefined;
      const trace: LearnTrace = {
        app: { key: app.key, name: app.name, ...(bundleId ? { bundleId } : {}), fingerprint: app.fingerprint },
        name: session.name, steps: session.steps, succeeded: true, check: session.check, checkHeldBefore: session.checkHeldBefore, day: rt.day(),
      };
      const outcome = await learnFromTrace(rt.registry, trace);
      log(outcome.action === "refused" ? `[reach-learn] refused on ${app.name}: ${outcome.reason}` : `[reach-learn] ${outcome.action} ${outcome.capability.id} on ${app.name} (${outcome.capability.status})`);
    },
  }, options.quietMs !== undefined ? { quietMs: options.quietMs } : {});
  setLearnTap({
    active: () => runtime?.exploreEnabled() === true,
    observed: (observation) => recorder.observed(observation),
    acted: (action) => recorder.acted(action),
  });
  return { recorder, async stop() { setLearnTap(null); await recorder.flush().catch(() => undefined); } };
}

export { learnTap };
