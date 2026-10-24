import * as path from "node:path";
import type { Actuator } from "../reach/actuator";
import type { ActuatorManager } from "../reach/actuator-manager";
import { nodeExec } from "../reach/host";
import { readAppCapabilities, readReachMap } from "../reach/map";
import { CapabilityRegistry } from "../reach/registry";
import type { ReachService, ReachStatus } from "../reach/service";
import type { Capability, ExecFn, ReachMap, ReachPlatform } from "../reach/types";

// What the harness operations (reach.*) stand on. Electron-free: the daemon loads the harness, so everything here must load without it.
// The desktop's Main process sets the full runtime (driver, background service); any other host gets a read-only one that can still answer
// reach.map / reach.app / reach.describe from the files the map left on disk, and says plainly that it cannot drive an app.

export interface ReachRuntime {
  stateDir: string;
  platform: ReachPlatform;
  readMap(): Promise<ReachMap | null>;
  readHarvest(appKey: string): Promise<Capability[] | null>;
  registry: CapabilityRegistry;
  exec: ExecFn;
  // null in a host with no driver (the daemon, the terminal) or on a platform the GUI part does not support yet
  gui: Pick<ActuatorManager<unknown>, "use" | "ensure" | "running"> | null;
  service: Pick<ReachService, "getStatus" | "onInvokeOutcome"> | null;
  exploreEnabled(): boolean;
  now(): number;
  day(): string;
  // Waiting between screen steps. Absent: real timers. A gate injects an instant one so the dialog flows run in milliseconds.
  sleep?: (ms: number) => Promise<void>;
}

let current: ReachRuntime | null = null;
let readOnly: Promise<ReachRuntime> | null = null;

export function setReachRuntime(runtime: ReachRuntime | null): void {
  current = runtime;
}

export function reachStateDirFor(pluginsRoot: string): string {
  return path.join(pluginsRoot, "agentlas-reach", ".state");
}

export async function reachStateDir(): Promise<string> {
  if (process.env.AGENTLAS_REACH_STATE_DIR && path.isAbsolute(process.env.AGENTLAS_REACH_STATE_DIR)) return process.env.AGENTLAS_REACH_STATE_DIR;
  // loaded lazily: the module pulls in the install identity, which the daemon resolves differently
  const { installedPluginsRoot } = await import("../plugins/materialize");
  return reachStateDirFor(installedPluginsRoot({ configureScience: false }));
}

export function buildRuntime(stateDir: string, over: Partial<ReachRuntime> = {}): ReachRuntime {
  const platform = (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux" ? process.platform : "linux") as ReachPlatform;
  return {
    stateDir,
    platform,
    readMap: () => readReachMap(path.join(stateDir, "map")),
    readHarvest: (key) => readAppCapabilities(path.join(stateDir, "map"), key),
    registry: new CapabilityRegistry(path.join(stateDir, "registry")),
    exec: nodeExec,
    gui: null,
    service: null,
    exploreEnabled: () => false,
    now: () => Date.now(),
    day: () => new Date().toISOString().slice(0, 10),
    ...over,
  };
}

export function getReachRuntime(): Promise<ReachRuntime> {
  if (current) return Promise.resolve(current);
  readOnly ??= reachStateDir().then((dir) => buildRuntime(dir));
  return readOnly;
}

export type { Actuator, ReachStatus };
