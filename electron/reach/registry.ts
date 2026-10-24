import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Capability, CapabilityStatus } from "./types";

// What Reach learned by looking (menu structure) and by trying (dialog probes, real calls), kept per app next to the map. Harvested
// capabilities (what an app publishes) live in the map's own files and are rewritten on every scan; this registry holds the rest, so a
// re-scan can never erase something that took exploration to earn.
//
// One file per app: <dir>/explored/<key>-<hash>.json
//   { key, fingerprint, capabilities, attempts }
// `attempts` remembers what was tried and failed, so exploration does not hammer the same menu item forever.

export interface RegistryFile {
  key: string;
  fingerprint: string;
  capabilities: Capability[];
  attempts: Record<string, { fails: number; lastCode: string; lastDay: string }>;
  exploredAt?: string;
}

export const MAX_FAILS_BEFORE_GIVING_UP = 2;
export const NO_CANCEL_RULE_DAY = "2026-10-24";

function fileFor(dir: string, key: string): string {
  const slug = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return path.join(dir, "explored", `${slug}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}.json`);
}

async function writeAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, body, { mode: 0o600 });
  await fs.rename(temp, file);
}

export class CapabilityRegistry {
  constructor(private readonly dir: string) {}

  async read(key: string): Promise<RegistryFile | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileFor(this.dir, key), "utf8")) as RegistryFile;
      return parsed.key === key && Array.isArray(parsed.capabilities) ? parsed : null;
    } catch {
      return null;
    }
  }

  async capabilities(key: string): Promise<Capability[]> {
    return (await this.read(key))?.capabilities ?? [];
  }

  private async mutate(key: string, fingerprint: string, change: (file: RegistryFile) => void): Promise<RegistryFile> {
    const file = (await this.read(key)) ?? { key, fingerprint, capabilities: [], attempts: {} };
    file.fingerprint = fingerprint;
    change(file);
    await writeAtomic(fileFor(this.dir, key), JSON.stringify(file));
    return file;
  }

  // When the app changed (a new fingerprint), everything proven against the old one is only a candidate again until it is re-proven.
  async rebase(key: string, fingerprint: string): Promise<number> {
    let stale = 0;
    const existing = await this.read(key);
    if (!existing || existing.fingerprint === fingerprint) return 0;
    await this.mutate(key, fingerprint, (file) => {
      for (const capability of file.capabilities) {
        if (capability.status === "verified" && capability.boundFingerprint !== fingerprint) { capability.status = "candidate"; stale += 1; }
      }
      file.attempts = {};
    });
    return stale;
  }

  // Merge what a scan or a probe found. Existing evidence is kept and extended, a verified capability is never downgraded by a plain
  // sighting, and the same capability seen on another day counts as another observation.
  async upsert(key: string, fingerprint: string, found: readonly Capability[], day: string): Promise<{ added: number; updated: number }> {
    let added = 0;
    let updated = 0;
    await this.mutate(key, fingerprint, (file) => {
      const byId = new Map(file.capabilities.map((capability) => [capability.id, capability]));
      for (const incoming of found) {
        const current = byId.get(incoming.id);
        if (!current) {
          file.capabilities.push(incoming);
          byId.set(incoming.id, incoming);
          added += 1;
          continue;
        }
        updated += 1;
        // `observations` counts the DAYS on which the capability was seen, not the sightings: the same dialog probed twice in one
        // afternoon is one observation, and something that is only ever seen once never looks established.
        if (incoming.evidence) {
          const seenToday = current.evidence?.lastSeenDay === day;
          current.evidence = {
            observations: (current.evidence?.observations ?? 0) + (seenToday ? 0 : 1),
            firstSeenDay: current.evidence?.firstSeenDay ?? incoming.evidence.firstSeenDay,
            lastSeenDay: day,
          };
        }
        // a fresh probe of the same dialog replaces the shape (the app may have changed) and re-binds the fingerprint
        if (incoming.status === "verified") {
          current.parameters = incoming.parameters;
          if (incoming.body) current.body = incoming.body;
          if (incoming.postconditions) current.postconditions = incoming.postconditions;
          current.boundFingerprint = incoming.boundFingerprint ?? fingerprint;
          if (current.status !== "verified") current.status = "verified";
          // A repair (a higher revision) changed what the capability is: its new name and source replace the old ones, and what a real call
          // proved about the OLD shape no longer holds. A plain re-probe of an unchanged dialog keeps the stronger proof.
          const repaired = (incoming.revision ?? 0) > (current.revision ?? 0);
          if (repaired) {
            current.revision = incoming.revision;
            current.name = incoming.name;
            current.suite = incoming.suite;
            current.source = incoming.source;
            current.verification = incoming.verification;
          } else {
            current.verification = current.verification === "behavioral" ? "behavioral" : incoming.verification;
          }
        }
      }
    });
    return { added, updated };
  }

  async recordAttempt(key: string, fingerprint: string, capabilityId: string, ok: boolean, code: string, day: string): Promise<number> {
    let fails = 0;
    await this.mutate(key, fingerprint, (file) => {
      const current = file.attempts[capabilityId] ?? { fails: 0, lastCode: "", lastDay: day };
      file.attempts[capabilityId] = ok ? { fails: 0, lastCode: "ok", lastDay: day } : { fails: current.fails + 1, lastCode: code, lastDay: day };
      fails = file.attempts[capabilityId].fails;
    });
    return fails;
  }

  async shouldSkip(key: string, capabilityId: string): Promise<boolean> {
    const attempt = (await this.read(key))?.attempts[capabilityId];
    if (!attempt) return false;
    // A window with no Cancel button was refused ("no_cancel") until 2026-10-24, when such settings windows began to be read. A give-up recorded
    // under the old rule is looked at once more; if it is refused again the day is today and the count stands.
    if (attempt.lastCode === "no_cancel" && attempt.lastDay < NO_CANCEL_RULE_DAY) return false;
    return attempt.fails >= MAX_FAILS_BEFORE_GIVING_UP;
  }

  // A real call finished. Success with its postcondition holding upgrades to behavioral proof; failure degrades.
  // A failure that says the app's screen no longer matches the recorded steps marks the capability degraded (the next idle round repairs it). A failure that
  // is the caller's own (wrong arguments, the app not in front, a cancelled call) says nothing about the capability: it stays as it was.
  async recordOutcome(key: string, fingerprint: string, capabilityId: string, outcome: { ok: boolean; code?: string; repairable?: boolean }, day: string): Promise<CapabilityStatus | null> {
    let status: CapabilityStatus | null = null;
    await this.mutate(key, fingerprint, (file) => {
      const capability = file.capabilities.find((item) => item.id === capabilityId);
      if (!capability) return;
      if (outcome.ok) {
        capability.status = "verified";
        capability.verification = "behavioral";
        capability.boundFingerprint = fingerprint;
        const evidence = capability.evidence ?? { observations: 0, firstSeenDay: day, lastSeenDay: day };
        capability.evidence = { observations: evidence.observations + 1, firstSeenDay: evidence.firstSeenDay, lastSeenDay: day };
      } else if (outcome.repairable !== false) {
        capability.status = "degraded";
      }
      status = capability.status ?? null;
    });
    return status;
  }

  async markExplored(key: string, fingerprint: string, at: string): Promise<void> {
    await this.mutate(key, fingerprint, (file) => { file.exploredAt = at; });
  }

  async keys(): Promise<string[]> {
    try {
      const names = await fs.readdir(path.join(this.dir, "explored"));
      const keys: string[] = [];
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        try { keys.push((JSON.parse(await fs.readFile(path.join(this.dir, "explored", name), "utf8")) as RegistryFile).key); } catch { /* skip a damaged file */ }
      }
      return keys;
    } catch {
      return [];
    }
  }
}
