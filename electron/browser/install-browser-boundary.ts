import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { configuredIdentity, requireConfiguredInstallIdentity } from "../install-identity";
import { userDataDir } from "../runtime-paths";
import { assertDedicatedBrowserProfilePath } from "./profile-path-boundary";

export type InstallBrowserBoundary = Readonly<{ root: string; canonicalRoot: string; profile: string; launcher: string; port: number }>;
type PendingBoundary = Omit<InstallBrowserBoundary, "port"> & { port: number | null; requestedPort: number | null };
let boundary: PendingBoundary | null = null;

/** Embedded in generated launchers too; no Electron or mutable identity lookup. */
export function assertInstallBrowserPath(root: string, target: string, context: { fs: typeof fs; path: typeof path; forbiddenRoots?: readonly string[]; canonicalRoot?: string }): string {
  const { fs, path } = context;
  const refuse = (): never => { throw new Error("browser-install-boundary-refused"); };
  const inside = (child: string, parent: string) => {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const canonical = (value: string): string => {
    let ancestor = path.resolve(value);
    const missing: string[] = [];
    for (;;) {
      try { return path.join(fs.realpathSync(ancestor), ...missing); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse();
        try { if (fs.lstatSync(ancestor).isSymbolicLink()) return refuse(); }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return refuse(); }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return refuse();
        missing.unshift(path.basename(ancestor)); ancestor = parent;
      }
    }
  };
  const base = path.resolve(root);
  const canonicalRoot = canonical(base);
  // A namespace's leaf must not alias another install, even when its target
  // would pass the separate everyday-Chrome boundary.
  if (fs.lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink()) refuse();
  if (context.canonicalRoot && canonicalRoot !== context.canonicalRoot) refuse();
  for (const protectedRoot of context.forbiddenRoots ?? []) {
    const protectedPath = canonical(protectedRoot);
    const resolved = canonical(base);
    if (resolved === protectedPath || inside(resolved, protectedPath) || inside(protectedPath, resolved)) refuse();
  }
  if (!inside(path.resolve(target), base) || !inside(canonical(target), canonical(base))) refuse();
  const entry = fs.statSync(target, { throwIfNoEntry: false });
  if (entry?.isFile() && entry.nlink !== 1) refuse();
  return canonicalRoot;
}

function assertPath(target: string): void {
  if (!boundary) throw new Error("browser-install-boundary-unconfigured");
  assertInstallBrowserPath(boundary.root, target, { fs, path, canonicalRoot: boundary.canonicalRoot });
  assertDedicatedBrowserProfilePath(boundary.root, { platform: process.platform, home: os.homedir(), env: process.env, fs, path }, [target]);
}

/** Main calls this after immutable identity validation, before namespace mkdir. */
export function configureInstallBrowserBoundary(root: string, officialRoot: string): void {
  const identity = requireConfiguredInstallIdentity();
  if (identity.channel === "official") return;
  if (!path.isAbsolute(root)) throw new Error("browser-install-boundary-refused");
  // Neither an explicit QA userData root nor its aliases may adopt the
  // official Electron namespace or the shared Desktop/Terminal CDP namespace.
  const canonicalRoot = assertInstallBrowserPath(root, path.join(root, "browser"), { fs, path,
    forbiddenRoots: [officialRoot, path.join(os.homedir(), ".agentlas"),
      ...["Agentlas-Dev", "Agentlas-QA", "Agentlas-Local-Candidate"]
        .filter(namespace => namespace !== identity.userDataNamespace)
        .map(namespace => path.join(path.dirname(officialRoot), namespace))] });
  const profile = process.env.AGENTLAS_CDP_PROFILE?.trim() || path.join(root, "browser", "chrome-cdp-profile");
  const launcher = process.env.AGENTLAS_CDP_LAUNCHER?.trim() || path.join(root, "browser", "agentlas-browser-cdp.mjs");
  const rawPort = process.env.AGENTLAS_CDP_PORT?.trim();
  const requestedPort = rawPort ? Number(rawPort) : null;
  if (requestedPort !== null && (!/^\d+$/.test(rawPort!) || !Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535 || requestedPort === 9222)) {
    throw new Error("browser-install-port-refused");
  }
  const next = { root: path.resolve(root), canonicalRoot, profile: path.resolve(profile), launcher: path.resolve(launcher), port: null, requestedPort };
  if (boundary) {
    if (boundary.root !== next.root || boundary.profile !== next.profile || boundary.launcher !== next.launcher) throw new Error("browser-install-boundary-reconfigure-refused");
    return;
  }
  boundary = next;
  try {
    assertPath(profile); assertPath(launcher); assertPath(portRecordPath());
    assertDedicatedBrowserProfilePath(profile, { platform: process.platform, home: os.homedir(), env: process.env, fs, path });
  } catch (error) { boundary = null; throw error; }
  process.env.AGENTLAS_CDP_PROFILE = next.profile;
  process.env.AGENTLAS_CDP_LAUNCHER = next.launcher;
}

function portRecordPath(): string { return path.join(boundary!.root, "browser", "cdp-port.json"); }
function readPort(): number | null {
  const file = portRecordPath();
  assertPath(file);
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 128) throw new Error("browser-install-port-refused");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1) throw new Error("browser-install-port-refused");
    let record: { schemaVersion?: unknown; port?: unknown };
    try { record = JSON.parse(fs.readFileSync(fd, "utf8")); }
    catch { throw new Error("browser-install-port-refused"); }
    const port = record.port;
    if (record.schemaVersion !== 1 || typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 9222) throw new Error("browser-install-port-refused");
    if (boundary!.requestedPort !== null && port !== boundary!.requestedPort) throw new Error("browser-install-port-refused");
    return port;
  } finally { fs.closeSync(fd); }
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once("error", reject);
    reservation.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = reservation.address();
      reservation.close((error) => {
        if (error || !address || typeof address === "string") reject(error || new Error("browser-install-port-refused"));
        else resolve(address.port);
      });
    });
  });
}

/** The OS chooses a free port once. Persist it with exclusive creation so
 * restarts and login-service helpers retain the exact same profile/port pair.
 * A later collision is refused by existing exact-profile ownership checks. */
export async function prepareInstallBrowserBoundary(allocatePort = allocateLoopbackPort): Promise<void> {
  if (!boundary) return;
  let port = readPort();
  if (port === null) {
    port = boundary.requestedPort ?? await allocatePort();
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 9222) throw new Error("browser-install-port-refused");
    const file = portRecordPath(); assertPath(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); assertPath(file);
    // Publish complete, flushed bytes without replacing a concurrent record.
    // A reader observing the brief link/unlink interval fails closed on nlink.
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    assertPath(temporary);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, port })); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      assertPath(file); assertPath(temporary);
      try { fs.linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { fs.unlinkSync(temporary); }
    port = readPort();
    if (port === null) throw new Error("browser-install-port-refused");
  }
  boundary.port = port;
  process.env.AGENTLAS_CDP_PORT = String(port);
}

/** Login-service Node hosts restore identity/userData, but not Main's env.
 * Resolve their already-created private port record; never fall back to 9222. */
export function installBrowserBoundary(): InstallBrowserBoundary | null {
  const identity = configuredIdentity();
  if (!identity) {
    if (process.type === "browser") throw new Error("browser-install-boundary-unconfigured");
    return null; // Standalone Terminal keeps its historical shared defaults.
  }
  if (identity.channel === "official") return null;
  if (!boundary) {
    const appData = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32" ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    configureInstallBrowserBoundary(userDataDir(), path.join(appData, "Agentlas"));
  }
  assertPath(boundary!.profile); assertPath(boundary!.launcher);
  if (boundary!.port === null) boundary!.port = readPort();
  if (boundary!.port === null) throw new Error("browser-install-port-unconfigured");
  return { root: boundary!.root, canonicalRoot: boundary!.canonicalRoot, profile: boundary!.profile, launcher: boundary!.launcher, port: boundary!.port };
}

export function assertPendingInstallBrowserBoundary(): void {
  if (boundary) { assertPath(boundary.profile); assertPath(boundary.launcher); assertPath(portRecordPath()); }
}

export function assertInstallBrowserTarget(target: string): void {
  if (installBrowserBoundary()) assertPath(target);
}
