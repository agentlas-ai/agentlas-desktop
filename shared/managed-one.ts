/** Service bootstrap is host input, never a model/tool or Mobile request. */
export const MANAGED_ONE_BOOTSTRAP_SCHEMA = "agentlas.managed-one.bootstrap.v1" as const;
export type ManagedOnePurpose = "serving" | "relay" | "pairing" | "control";
export interface ManagedOneBootstrap {
  schemaVersion: typeof MANAGED_ONE_BOOTSTRAP_SCHEMA;
  hostId: string;
  generation: number;
  userId: string;
  workspaceId: string;
  expiresAt: number;
  webBaseUrl: string;
  relayUrl?: string;
  userDataDir: string;
  credentials: Readonly<Record<ManagedOnePurpose, string>>;
  controlBearer: string;
  /** Feature switches, e.g. ["team"] or "team,goal". Absent = AGENTLAS_MANAGED_ONE_FEATURES, then the defaults. */
  features?: string | readonly string[];
  /** Absolute path of a snapshot made by POST /control/snapshot. Needs restoreSha256. Restored only into an empty data folder. */
  restoreFrom?: string;
  restoreSha256?: string;
  /** IANA zone of the owner. Sets the process TZ so a daily HH:MM check-in means the owner's local time. */
  timeZone?: string;
}
export interface ManagedOneHealth {
  hostId: string;
  generation: number;
  supervisorSchema: "agentlas.one-supervisor.v1";
  executor: "agentlas-cloud";
  supervisorReady: boolean;
  relayReady: boolean;
  capabilities: { one: boolean; work: boolean; goal: false; computerUse: false; team: boolean; browser: boolean };
}
