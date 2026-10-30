import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A value-free marker that moves on every successful keychain write or delete, in any host.
 *
 * The background service cannot see the window's vault edits, so it used to trust a cached credential for one second
 * (vault.ts, observed in use). That made every read a fresh helper process plus a durable recovery attempt:
 * measured, 20 helper processes in 40 s and 22% of all file events on the machine. Comparing this marker
 * tells the service a write happened the moment it happened, so a cached value can be trusted for longer.
 *
 * Holds a random token only, never a name or a value.
 */
function generationFile(): string | null {
  try {
    const { userDataPath } = require("../runtime-paths") as typeof import("../runtime-paths");
    return userDataPath("credential-generation-v1");
  } catch { return null; }
}

/** The current token; "none" before the first write; null when it cannot be observed, so callers must not rely on it. */
export function readCredentialGeneration(): string | null {
  const file = generationFile();
  if (!file) return null;
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "none" : null; }
}

/** Best effort: a host that cannot bump leaves other hosts on their bounded freshness window. */
export function bumpCredentialGeneration(): void {
  const file = generationFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, randomUUID(), { mode: 0o600 });
  } catch { /* the bounded freshness window still applies */ }
}
