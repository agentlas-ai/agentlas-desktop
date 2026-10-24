import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `xcrun stapler validate` looks the ticket up online (CloudKit, api.apple-cloudkit.com) even when the ticket is
// already stapled. From GitHub's macOS runners that lookup drops for minutes at a time ("The network connection was
// lost", Error 68). 1.3.56 stapled its arm64 DMG five times in eight minutes, and the validate run right after each
// staple failed every time. Half of the failed release runs on 2026-10-13..17 died on a lookup like this. Waiting and
// retrying cannot outlast it.
// A lost connection says nothing about the artifact, so only that verdict is decided offline. Two things must hold:
// the Apple ticket ("s8ch") is stapled in the artifact itself, and Gatekeeper calls the artifact "Notarized Developer
// ID". A missing ticket, or any other stapler verdict, still fails.

const TICKET_MAGIC = "s8ch";
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_BLOBWRAPPER = 0xfade0b01;
const CSSLOT_TICKETSLOT = 0x10002;
// UDIF trailer ("koly", last 512 bytes): code signature offset and length are big-endian u64 at 0x128 and 0x130.
const KOLY_CODE_SIGNATURE_OFFSET = 0x128;

export function staplerLookupUnreachable(output) {
  const text = String(output || "");
  if (/does not have a ticket stapled/i.test(text)) return false;
  return /NSURLErrorDomain Code=-10(?:0[1-9]|1[0-9]|20)\b/.test(text)
    || /network connection was lost|Internet connection appears to be offline|request timed out/i.test(text);
}

export function gatekeeperCallsNotarized(output) {
  return /source=Notarized Developer ID/i.test(String(output || ""));
}

export function dmgHasStapledTicket(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size < 512) return false;
    const koly = Buffer.alloc(512);
    readSync(fd, koly, 0, 512, size - 512);
    if (koly.toString("latin1", 0, 4) !== "koly") return false;
    const offset = Number(koly.readBigUInt64BE(KOLY_CODE_SIGNATURE_OFFSET));
    const length = Number(koly.readBigUInt64BE(KOLY_CODE_SIGNATURE_OFFSET + 8));
    if (!offset || length < 12 || length > 16 * 1024 * 1024 || offset + length > size - 512) return false;
    const signature = Buffer.alloc(length);
    readSync(fd, signature, 0, length, offset);
    if (signature.readUInt32BE(0) !== CSMAGIC_EMBEDDED_SIGNATURE) return false;
    const count = signature.readUInt32BE(8);
    if (12 + count * 8 > length) return false;
    for (let index = 0; index < count; index += 1) {
      if (signature.readUInt32BE(12 + index * 8) !== CSSLOT_TICKETSLOT) continue;
      const at = signature.readUInt32BE(16 + index * 8);
      return at + 12 <= length
        && signature.readUInt32BE(at) === CSMAGIC_BLOBWRAPPER
        && signature.toString("latin1", at + 8, at + 12) === TICKET_MAGIC;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function appHasStapledTicket(appPath) {
  const file = join(appPath, "Contents", "CodeResources");
  let fd;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size < TICKET_MAGIC.length) return false;
    fd = openSync(file, "r");
    const head = Buffer.alloc(TICKET_MAGIC.length);
    readSync(fd, head, 0, head.length, 0);
    return head.toString("latin1") === TICKET_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * `stapler` and `spctl` are the { ok, output } results of the commands the caller already ran on `path`.
 * `kind` is "dmg" or "app".
 */
export function decideStapledNotarization({ path, kind, stapler, spctl }) {
  if (stapler?.ok) return { ok: true, via: "stapler" };
  if (!staplerLookupUnreachable(stapler?.output)) return { ok: false, cause: "stapler-rejected" };
  const stapled = kind === "dmg" ? dmgHasStapledTicket(path) : appHasStapledTicket(path);
  if (!stapled) return { ok: false, cause: "ticket-missing", staplerLookupUnreachable: true };
  if (!spctl?.ok || !gatekeeperCallsNotarized(spctl.output)) {
    return { ok: false, cause: "gatekeeper-not-notarized", staplerLookupUnreachable: true };
  }
  return { ok: true, via: "stapled-ticket-and-gatekeeper", staplerLookupUnreachable: true };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    status: result.status,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

// CLI for scripts/package-mac.sh: node scripts/lib/stapled-ticket.mjs <file.dmg>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file || !file.endsWith(".dmg")) {
    console.error("usage: node scripts/lib/stapled-ticket.mjs <file.dmg>");
    process.exit(2);
  }
  const stapler = runCommand("xcrun", ["stapler", "validate", file]);
  const spctl = stapler.ok
    ? null
    : runCommand("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", file]);
  const decision = decideStapledNotarization({ path: file, kind: "dmg", stapler, spctl });
  if (!stapler.ok) console.error(stapler.output);
  console.log(JSON.stringify({ file, ...decision }));
  process.exit(decision.ok ? 0 : 1);
}
