// The Actuator is the one thing Reach needs from a GUI driver: see windows, read menus, act on elements. Everything above it (menu
// scan, dialog probes, synthesis, repair) is written against this interface, so the Cua Driver is one implementation and a fake in
// tests is another. No Electron import: the engine is loadable by the daemon.

export interface ActuatorApp {
  name: string;
  pid: number; // 0 when the app is installed but not running
  bundleId?: string;
  running: boolean;
}

export interface ActuatorWindow {
  windowId: number;
  pid: number;
  appName: string;
  title: string;
  onScreen: boolean;
  layer: number;
  // Stacking order as the driver reports it: the frontmost window has the highest value; null/absent when stacking is unavailable.
  zIndex?: number | null;
  bounds: { x: number; y: number; width: number; height: number };
}

// What one tool call came back as. `refusalCode` is set when the driver refused on purpose (nothing happened).
export interface ToolOutcome {
  ok: boolean;
  text: string;
  structured?: Record<string, unknown>;
  refusalCode?: string;
  errorCode?: string;
}

export interface ActuatorStatus {
  available: boolean;
  version?: string;
  accessibility?: boolean;
  screenRecording?: boolean;
  reason?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ActuatorPlatform = "darwin" | "win32" | "linux";

export interface Actuator {
  readonly id: string;
  // The desktop the driver drives. Absent means macOS (the first and the default).
  readonly platform?: ActuatorPlatform;
  status(options?: CallOptions): Promise<ActuatorStatus>;
  listApps(options?: CallOptions): Promise<ActuatorApp[]>;
  listWindows(filter: { app?: string; pid?: number }, options?: CallOptions): Promise<ActuatorWindow[]>;
  // Tool-level access for everything else (get_window_state, invoke_menu, set_value ...). Names are the driver's own.
  call(tool: string, args: Record<string, unknown>, options?: CallOptions): Promise<ToolOutcome>;
  close(): Promise<void>;
}
