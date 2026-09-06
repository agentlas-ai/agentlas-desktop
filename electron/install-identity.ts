/**
 * Immutable install identity boundary.
 *
 * The packaged marker is injected into app.asar/package.json by
 * electron-builder. It deliberately does not consult environment variables:
 * a mutable launch environment must never turn an official-shaped bundle into
 * a local/QA candidate.
 */
export type PackagedInstallChannel = "official" | "local-candidate";
export type InstallChannel = PackagedInstallChannel | "qa" | "dev";

export type BuildInstallIdentityMarker = Readonly<{
  schemaVersion: 1;
  channel: PackagedInstallChannel;
  appId: string;
  appName: string;
  userDataNamespace: string;
  keychainService: string;
  updateFeed: "official" | "none";
}>;

export type InstallIdentity = Readonly<{
  channel: InstallChannel;
  appName: string;
  userDataNamespace: string;
  keychainService: string;
  updatesEnabled: boolean;
  /** Explicit QA-only path. Official, local candidates and dev use null. */
  userDataOverride: string | null;
}>;

export class InstallIdentityError extends Error {
  constructor(message: string) {
    super(`Install identity refused: ${message}`);
    this.name = "InstallIdentityError";
  }
}

export const OFFICIAL_BUILD_INSTALL_IDENTITY: BuildInstallIdentityMarker = Object.freeze({
  schemaVersion: 1,
  channel: "official",
  appId: "com.agentlas.desktop",
  appName: "Agentlas",
  userDataNamespace: "Agentlas",
  keychainService: "com.agentlas.desktop",
  updateFeed: "official",
});

export const LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY: BuildInstallIdentityMarker = Object.freeze({
  schemaVersion: 1,
  channel: "local-candidate",
  appId: "com.agentlas.desktop.candidate",
  appName: "Agentlas-Local-Candidate",
  userDataNamespace: "Agentlas-Local-Candidate",
  keychainService: "com.agentlas.desktop.candidate",
  updateFeed: "none",
});

export const OFFICIAL_INSTALL_IDENTITY: InstallIdentity = Object.freeze({
  channel: "official",
  appName: OFFICIAL_BUILD_INSTALL_IDENTITY.appName,
  userDataNamespace: OFFICIAL_BUILD_INSTALL_IDENTITY.userDataNamespace,
  keychainService: OFFICIAL_BUILD_INSTALL_IDENTITY.keychainService,
  updatesEnabled: true,
  userDataOverride: null,
});

/** Source development has a stable namespace separate from every packaged app. */
export const DEV_INSTALL_IDENTITY: InstallIdentity = Object.freeze({
  channel: "dev",
  appName: "Agentlas-Dev",
  userDataNamespace: "Agentlas-Dev",
  keychainService: "com.agentlas.desktop.dev",
  updatesEnabled: false,
  userDataOverride: null,
});

const QA_INSTALL_IDENTITY: InstallIdentity = Object.freeze({
  channel: "qa",
  appName: "Agentlas-QA",
  userDataNamespace: "Agentlas-QA",
  keychainService: "com.agentlas.desktop.qa",
  updatesEnabled: false,
  userDataOverride: null,
});

export type ResolveInstallIdentityInput = Readonly<{
  packaged: boolean;
  packageMetadata?: unknown;
  qaUserDataDir?: string | null;
  /** Only source/dev runs may opt into an explicit QA data directory. */
  allowQaOverride?: boolean;
}>;

const MARKER_KEYS = [
  "schemaVersion",
  "channel",
  "appId",
  "appName",
  "userDataNamespace",
  "keychainService",
  "updateFeed",
] as const;

let configuredInstallIdentity: InstallIdentity | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactMarker(value: unknown, expected: BuildInstallIdentityMarker): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== MARKER_KEYS.length) return false;
  if (keys.some((key, index) => key !== [...MARKER_KEYS].sort()[index])) return false;
  return MARKER_KEYS.every((key) => value[key] === expected[key]);
}

function packageMarker(packageMetadata: unknown): unknown {
  if (!isRecord(packageMetadata)) {
    throw new InstallIdentityError("packaged app metadata is missing");
  }
  return packageMetadata.agentlasInstallIdentity;
}

function runtimeIdentityFromMarker(marker: BuildInstallIdentityMarker): InstallIdentity {
  return Object.freeze({
    channel: marker.channel,
    appName: marker.appName,
    userDataNamespace: marker.userDataNamespace,
    keychainService: marker.keychainService,
    updatesEnabled: marker.updateFeed === "official",
    userDataOverride: null,
  });
}

function resolvePackagedInstallIdentity(packageMetadata: unknown): InstallIdentity {
  const marker = packageMarker(packageMetadata);
  if (isExactMarker(marker, OFFICIAL_BUILD_INSTALL_IDENTITY)) {
    return OFFICIAL_INSTALL_IDENTITY;
  }
  if (isExactMarker(marker, LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY)) {
    return runtimeIdentityFromMarker(LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY);
  }

  if (isRecord(marker) && marker.channel === "local-candidate") {
    throw new InstallIdentityError("local candidate marker is invalid");
  }
  throw new InstallIdentityError("packaged marker is unknown or incomplete");
}

/**
 * Resolves an identity without Electron, filesystem, process, or environment
 * access so the trust contract remains independently testable.
 */
export function resolveInstallIdentity(input: ResolveInstallIdentityInput): InstallIdentity {
  const qaUserDataDir = input.qaUserDataDir?.trim() || null;
  if (input.packaged) {
    if (qaUserDataDir) {
      throw new InstallIdentityError("QA userData override is forbidden in a packaged app");
    }
    return resolvePackagedInstallIdentity(input.packageMetadata);
  }

  if (!qaUserDataDir) return DEV_INSTALL_IDENTITY;
  if (!input.allowQaOverride) {
    throw new InstallIdentityError("QA userData override is allowed only for an unpackaged run");
  }
  return Object.freeze({ ...QA_INSTALL_IDENTITY, userDataOverride: qaUserDataDir });
}

function isValidRuntimeIdentity(identity: InstallIdentity): boolean {
  if (identity.channel === "dev") {
    return identity.appName === DEV_INSTALL_IDENTITY.appName
      && identity.userDataNamespace === DEV_INSTALL_IDENTITY.userDataNamespace
      && identity.keychainService === DEV_INSTALL_IDENTITY.keychainService
      && identity.updatesEnabled === false
      && identity.userDataOverride === null;
  }
  if (identity.channel === "official") {
    return identity.appName === OFFICIAL_INSTALL_IDENTITY.appName
      && identity.userDataNamespace === OFFICIAL_INSTALL_IDENTITY.userDataNamespace
      && identity.keychainService === OFFICIAL_INSTALL_IDENTITY.keychainService
      && identity.updatesEnabled
      && identity.userDataOverride === null;
  }
  if (identity.channel === "local-candidate") {
    return identity.appName === LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY.appName
      && identity.userDataNamespace === LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY.userDataNamespace
      && identity.keychainService === LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY.keychainService
      && !identity.updatesEnabled
      && identity.userDataOverride === null;
  }
  if (identity.channel !== "qa") return false;
  return identity.appName === QA_INSTALL_IDENTITY.appName
    && identity.userDataNamespace === QA_INSTALL_IDENTITY.userDataNamespace
    && identity.keychainService === QA_INSTALL_IDENTITY.keychainService
    && !identity.updatesEnabled
    && typeof identity.userDataOverride === "string"
    && identity.userDataOverride.length > 0;
}

/** Main configures this before any secret or updater access. */
export function configureInstallIdentity(identity: InstallIdentity): void {
  if (!isValidRuntimeIdentity(identity)) {
    throw new InstallIdentityError("runtime identity did not pass the immutable contract");
  }
  if (configuredInstallIdentity) {
    const sameIdentity = configuredInstallIdentity.channel === identity.channel
      && configuredInstallIdentity.appName === identity.appName
      && configuredInstallIdentity.userDataNamespace === identity.userDataNamespace
      && configuredInstallIdentity.keychainService === identity.keychainService
      && configuredInstallIdentity.updatesEnabled === identity.updatesEnabled
      && configuredInstallIdentity.userDataOverride === identity.userDataOverride;
    if (!sameIdentity) {
      throw new InstallIdentityError("identity cannot be reconfigured after startup");
    }
    return;
  }
  configuredInstallIdentity = Object.freeze({ ...identity });
}

/** Returns null instead of silently choosing an identity for a packaged app. */
export function configuredIdentity(): InstallIdentity | null {
  return configuredInstallIdentity;
}

/**
 * The headless daemon is an Electron child process, so it cannot read the
 * packaged app metadata through `app.getAppPath()`. Desktop therefore passes
 * the identity it already resolved at startup over the private child
 * environment. Keep the payload small, explicit, and independently checked
 * before the daemon touches protected storage.
 */
export function serializeInstallIdentity(identity: InstallIdentity): string {
  if (!isValidRuntimeIdentity(identity)) {
    throw new InstallIdentityError("cannot serialize an invalid runtime identity");
  }
  return JSON.stringify(identity);
}

export function deserializeInstallIdentity(raw: string): InstallIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InstallIdentityError("daemon identity payload is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new InstallIdentityError("daemon identity payload is not an object");
  }
  const expectedKeys = [
    "appName",
    "channel",
    "keychainService",
    "updatesEnabled",
    "userDataNamespace",
    "userDataOverride",
  ].sort();
  const actualKeys = Object.keys(parsed).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new InstallIdentityError("daemon identity payload has unexpected fields");
  }

  const identity = {
    channel: parsed.channel,
    appName: parsed.appName,
    userDataNamespace: parsed.userDataNamespace,
    keychainService: parsed.keychainService,
    updatesEnabled: parsed.updatesEnabled,
    userDataOverride: parsed.userDataOverride,
  } as InstallIdentity;
  if (!isValidRuntimeIdentity(identity)) {
    throw new InstallIdentityError("daemon identity payload failed the immutable contract");
  }
  return Object.freeze({ ...identity });
}

export function requireConfiguredInstallIdentity(): InstallIdentity {
  if (!configuredInstallIdentity) {
    throw new InstallIdentityError("identity was not configured before protected storage access");
  }
  return configuredInstallIdentity;
}
