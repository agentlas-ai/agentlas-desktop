// Antigravity CLI resident sessions.
//
// `agy --input-format stream-json --output-format stream-json` keeps one CLI
// process alive and accepts one user turn per NDJSON line.  This module owns
// only that process lifetime.  Antigravity's runner remains the authority for
// prompt construction, tool receipts, and per-turn result settlement.
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { AcpSessionPool, type AcpSessionLease } from "./acp-session-pool";
import { detachedSpawnOpts, killCliTree, spawnCli, trackRunChild } from "./exec";
import { ensureChildCloseAfterExit } from "./runner";
import { waitForRetiredCliExit } from "./retired-cli-exit";

export type { AcpSessionLease };

export interface AntigravityTurnSink {
  onLine: (line: string) => void;
  onStderr: (chunk: string) => void;
  onDeath: (code: number | null) => void;
}

export interface AntigravityResidentOwner {
  chatId: string;
  sessionOwnerId: string | null;
  isolateOwner: boolean;
  generation: string;
  /** agy binds the selected model when the process starts. */
  model: string | null;
  /** Full pool identity; authority/config changes must retire old idle seats. */
  scopeKey?: string;
}

export interface AntigravityResidentSession {
  executableOwner: AntigravityResidentOwner;
  child: ChildProcess;
  active: AntigravityTurnSink | null;
  closed: boolean;
  dead: boolean;
  completedTurns: number;
  stderrTail: string;
  /** Main-owned resident MCP scopes to revoke when this CLI is retired. */
  persistentMcpScopes: Map<string, string>;
  onPersistentMcpScopeClose?: (key: string, owner: string) => void;
}

const STDERR_TAIL_MAX = 8 * 1024;

/** Read provider NDJSON without allowing one malformed line to kill the pool. */
export function createAgyNdjsonLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

/** Open one agy process; stdin deliberately remains open for later turns. */
export function openAntigravityResidentSession(opts: {
  executableOwner: AntigravityResidentOwner;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onPersistentMcpScopeClose?: (key: string, owner: string) => void;
}): AntigravityResidentSession {
  const child = spawnCli(opts.bin, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env,
    cwd: opts.cwd,
    ...detachedSpawnOpts(),
  });
  const session: AntigravityResidentSession = {
    executableOwner: { ...opts.executableOwner },
    child,
    active: null,
    closed: false,
    dead: false,
    completedTurns: 0,
    stderrTail: "",
    persistentMcpScopes: new Map(),
    onPersistentMcpScopeClose: opts.onPersistentMcpScopeClose,
  };
  trackRunChild(child);
  ensureChildCloseAfterExit(child);

  const readStdout = createAgyNdjsonLineReader((line) => {
    try { session.active?.onLine(line); } catch { /* turn settlement owns failures */ }
  });
  child.stdout?.on("data", readStdout);
  const stderrDecoder = new StringDecoder("utf8");
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    session.stderrTail = (session.stderrTail + text).slice(-STDERR_TAIL_MAX);
    try { session.active?.onStderr(text); } catch { /* see stdout handler */ }
  });
  const die = (code: number | null) => {
    if (session.dead) return;
    session.dead = true;
    const sink = session.active;
    session.active = null;
    try { sink?.onDeath(code); } catch { /* the active turn settles itself */ }
  };
  child.once("close", (code) => die(typeof code === "number" ? code : null));
  child.once("error", () => die(null));
  child.stdin?.on("error", () => {});
  return session;
}

export function antigravityResidentSessionAlive(session: AntigravityResidentSession): boolean {
  if (session.closed || session.dead) return false;
  const child = session.child;
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return false;
  return Boolean(child.stdin && child.stdin.writable);
}

export function closeAntigravityResidentSession(session: AntigravityResidentSession): void {
  session.closed = true;
  session.active = null;
  for (const [key, owner] of session.persistentMcpScopes) {
    try { session.onPersistentMcpScopeClose?.(key, owner); } catch { /* close remains unconditional */ }
  }
  session.persistentMcpScopes.clear();
  try { session.child.stdin?.end(); } catch { /* already closed */ }
  try { killCliTree(session.child); } catch { /* already dead */ }
}

export function bindAntigravityPersistentMcpScope(
  session: AntigravityResidentSession,
  key: string,
  owner: string,
): void {
  if (session.closed) return;
  session.persistentMcpScopes.set(key, owner);
}

/** Send one user turn while keeping stdin open for the next turn. */
export function writeAntigravityResidentTurn(session: AntigravityResidentSession, text: string): boolean {
  const stdin = session.child.stdin;
  if (!stdin || !stdin.writable) return false;
  const line = `${JSON.stringify({
    event: "user",
    message: { role: "user", content: text },
  })}\n`;
  try {
    stdin.write(line);
    return true;
  } catch {
    return false;
  }
}

let sessionPool: AcpSessionPool<AntigravityResidentSession> | null = null;

export function antigravitySessionPool(): AcpSessionPool<AntigravityResidentSession> {
  if (!sessionPool) {
    sessionPool = new AcpSessionPool<AntigravityResidentSession>({
      alive: antigravityResidentSessionAlive,
      close: closeAntigravityResidentSession,
      unref: (session) => {
        session.child.unref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { unref?: () => void } | null)?.unref?.();
        }
      },
      ref: (session) => {
        session.child.ref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { ref?: () => void } | null)?.ref?.();
        }
      },
    });
    process.once("exit", () => {
      try { sessionPool?.disposeAll(); } catch { /* process is exiting */ }
    });
  }
  return sessionPool;
}

export function disposeAntigravitySessionPool(): void {
  sessionPool?.disposeAll();
  sessionPool = null;
}

export async function retireSupersededAntigravitySessions(
  pool: AcpSessionPool<AntigravityResidentSession>,
  owner: AntigravityResidentOwner,
): Promise<void> {
  const retired = pool.retireIdleMatching((session) => {
    const prior = session.executableOwner;
    return prior.chatId === owner.chatId
      && prior.sessionOwnerId === owner.sessionOwnerId
      && prior.isolateOwner === owner.isolateOwner
      && (
        prior.generation !== owner.generation
        || prior.model !== owner.model
        || (owner.scopeKey !== undefined && prior.scopeKey !== owner.scopeKey)
      );
  });
  if (retired.busy) throw new Error("runtime_session_owner_busy");
  await Promise.all(retired.retired.map(session => waitForRetiredCliExit(session.child)));
}

function stableArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    // Prompt and provider conversation ids are per-turn/session state, not
    // process authority.  A restored runtime-session id must not create a
    // second pool seat after the same resident process has been restarted.
    if (args[i] === "--prompt" || args[i] === "--conversation") { i += 1; continue; }
    out.push(args[i]!);
  }
  return out.sort();
}

/** Stable pool identity. Session ids and the per-turn prompt are excluded. */
export function antigravityPoolKey(input: {
  chatId: string;
  fingerprint: string;
  sessionOwnerId?: string | null;
  isolateOwner?: boolean;
  executableGeneration: string;
  cwd: string;
  bin: string;
  model?: string | null;
  mcpConfigPath?: string;
  toolBrokerSettingsPath?: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const envDigest = crypto.createHash("sha256");
  for (const name of Object.keys(input.env ?? {}).sort()) {
    envDigest.update(name).update("\0").update(String((input.env ?? {})[name] ?? "")).update("\0");
  }
  const argvDigest = crypto.createHash("sha256");
  for (const arg of stableArgs(input.args)) argvDigest.update(arg).update("\0");
  return crypto.createHash("sha256")
    .update("antigravity-pool-v1\0")
    .update(input.chatId).update("\0")
    .update(JSON.stringify([input.sessionOwnerId ?? null, input.isolateOwner ?? false])).update("\0")
    .update(input.fingerprint).update("\0")
    .update(input.executableGeneration).update("\0")
    .update(input.cwd).update("\0")
    .update(input.bin).update("\0")
    .update(input.model ?? "").update("\0")
    .update(input.mcpConfigPath ?? "").update("\0")
    .update(input.toolBrokerSettingsPath ?? "").update("\0")
    .update(argvDigest.digest("hex")).update("\0")
    .update(envDigest.digest("hex"))
    .digest("hex");
}
