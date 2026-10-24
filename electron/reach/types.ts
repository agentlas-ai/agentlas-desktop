// Agentlas Reach: the shapes shared by every platform. No Electron import anywhere in electron/reach/ (the daemon and the
// terminal engine load this too).

export const REACH_MAP_SCHEMA = "agentlas.reach.map/v1" as const;

export type ReachPlatform = "darwin" | "win32" | "linux";

// How far the app itself vouches for a capability. A lower number is cheaper to call and safer to trust, so discovery always
// tries the low tiers first and the GUI is only opened for what they leave out.
//   self-api       typed operations Agentlas already has for its own screens (electron/app-control)
//   published      an interface the OS or the app publishes: AppleScript dictionary, COM type library, D-Bus, desktop actions
//   app-protocol   a control protocol the app speaks: Chrome DevTools, LibreOffice UNO, an add-on socket, a local REST port
//   external-tool  an MCP server or a CLI that already exists for this app
//   structure      what the screen shows without acting: menu bar items, accessibility roles (observed, never clicked)
//   explored       synthesized from GUI exploration and verified
export const CAPABILITY_TIERS = ["self-api", "published", "app-protocol", "external-tool", "structure", "explored"] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export type AppKind = "native" | "electron" | "cef" | "qt" | "java" | "web-wrapper" | "unknown";

export type CapabilityKind = "query" | "command" | "job" | "device-action" | "unclassified";

// Same classes as electron/app-control/policy.ts. "unknown" is the honest default for a third-party app: a dictionary says a
// command exists, never whether it deletes something. The basis says where the class came from.
export type CapabilityEffectClass = "read" | "write" | "destructive" | "consent" | "unknown";
export type CapabilityEffectBasis = "declared" | "structural" | "unverified";

export interface CapabilityParameter {
  name: string;
  type: string; // string | integer | number | boolean | date | path | any | specifier:<class> | enum:<name> | list<...>
  required: boolean;
  description?: string;
  // The members of an enumeration, when the source lists them (an AppleScript enumeration's keywords).
  enumValues?: string[];
}

// candidate  seen, not proven   verified  proven for the fingerprint it carries   degraded  worked once, a later use or scan failed
export type CapabilityStatus = "candidate" | "verified" | "degraded";
// published   the app or OS states it (a dictionary, a manifest)   structural  the entry point was exercised and left no trace
// (a dialog opened and was cancelled)   behavioral   a real call ran and its postcondition held
export type CapabilityVerification = "published" | "structural" | "behavioral";

// How a capability is carried out. `adapter` calls a published interface; `steps` replays driver tools with ${parameter} placeholders.
export type CapabilityBody =
  | { kind: "adapter"; interface: string; ref: string }
  | { kind: "steps"; steps: Array<{ tool: string; args: Record<string, unknown> }> };

// Three-valued on purpose: "unknown" is never read as success.
export type PostconditionKind = "dialog-closed" | "dialog-open" | "window-count-unchanged" | "element-present" | "element-value-equals";
export interface Postcondition { kind: PostconditionKind; detail?: Record<string, string | number | boolean> }

export interface Capability {
  id: string;
  tier: CapabilityTier;
  source: { kind: string; ref: string };
  name: string;
  suite?: string;
  description?: string;
  kind: CapabilityKind;
  granularity: "operation" | "property";
  // Apple's boilerplate suites (open, save, close, text styles, type definitions) are in almost every Cocoa app's dictionary and
  // say nothing about what the app is for. They stay in the map, flagged, so counts can tell the two apart.
  generic?: true;
  // Facts about how the capability behaves that a caller or a policy may key on. "opens-dialog": a menu item whose title ends in an
  // ellipsis (the platform convention for "asks for more input before it acts").
  traits?: string[];
  // Absent on published entries: the source itself is the proof. Present on everything Reach observed or built.
  status?: CapabilityStatus;
  verification?: CapabilityVerification;
  body?: CapabilityBody;
  postconditions?: Postcondition[];
  // The app fingerprint this capability was proven against. A different fingerprint means "re-verify before trusting".
  boundFingerprint?: string;
  // Incremented whenever repair or a fresh probe changes the parameters or the steps, so a caller can tell the shape moved.
  revision?: number;
  evidence?: { observations: number; firstSeenDay: string; lastSeenDay: string };
  parameters: CapabilityParameter[];
  result?: string;
  target?: string; // the object class a property capability acts on
  effect: { class: CapabilityEffectClass; basis: CapabilityEffectBasis };
}

export type HarvestStatus = "ok" | "empty" | "unavailable" | "failed" | "skipped";

// What one source said about one app. The map keeps the empty and failed answers too, so a later run does not probe blind and
// the drawing can show how much of an app is still unexplored.
export interface HarvestRecord {
  source: string;
  tier: CapabilityTier;
  status: HarvestStatus;
  count: number;
  ms: number;
  detail?: string;
  contentSha256?: string;
  // The dictionary exists but can only be read without disturbing the owner while the app is running: a later scan, made while the owner has the
  // app open, reads it (and keeps it for the scans after that).
  deferred?: boolean;
}

export type ReachLevel = "scriptable" | "partial" | "unmapped";

export interface AppRecord {
  key: string;
  platform: ReachPlatform;
  name: string;
  version?: string;
  path: string;
  kind: AppKind;
  signals: string[];
  fingerprint: string;
  harvest: HarvestRecord[];
  capabilityCount: number;
  // Capabilities that are not generic boilerplate: what the app itself adds.
  specificCount: number;
  // Of those, the ones an agent can rely on: published, or proven by an exercise (not merely seen).
  usableCount: number;
  capabilitiesByTier: Partial<Record<CapabilityTier, number>>;
  operationCount: number;
  propertyCount: number;
  level: ReachLevel;
}

export interface ReachMap {
  schema: typeof REACH_MAP_SCHEMA;
  generatedAt: string;
  platform: ReachPlatform;
  host: { arch: string; release: string };
  apps: AppRecord[];
  totals: {
    apps: number;
    byLevel: Record<ReachLevel, number>;
    byKind: Partial<Record<AppKind, number>>;
    capabilities: number;
    specific: number;
    usable: number;
  };
}

export interface AppCandidate {
  key: string;
  platform: ReachPlatform;
  name: string;
  version?: string;
  path: string;
  kind: AppKind;
  signals: string[];
  fingerprint: string;
}

export interface HarvestOutcome {
  record: HarvestRecord;
  capabilities: Capability[];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

// argv only. There is no shell string anywhere in Reach, so an app name or a path can never become a command.
export type ExecFn = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export interface ReachFs {
  readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  realpath(path: string): Promise<string>;
  mtimeMs(path: string): Promise<number | null>;
  exists(path: string): Promise<boolean>;
}

export interface ReachHost {
  platform: ReachPlatform;
  arch: string;
  release: string;
  homedir: string;
  env: Readonly<Record<string, string | undefined>>;
  exec: ExecFn;
  fs: ReachFs;
  now: () => Date;
}
