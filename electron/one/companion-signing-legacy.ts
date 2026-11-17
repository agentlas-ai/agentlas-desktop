/**
 * What THIS computer checked before this change before it SIGNED for a phone (the bridge roads `one.companion.publicKey` / `.proof` / the continuity and front-transfer consent: the phone's old
 * desktop-registry enrollment): it had to be the confirmed home right now (`workStanding`), the envelope's host id had to be its own, and the pairing record behind the phone's device id had to be one a
 * screen QR made or the owner pressed "trust" for (`phoneVouch`). The contract's door (the signed-in account only, companion-computer-gate.ts) is for the road that takes server-ordered work and runs only
 * with `AGENTLAS_COMPANION_WORK_V2`; the signing roads are older than that and are used by nothing else, so with that switch off they keep their condition and a computer that is not the home still does not
 * sign a phone's enrollment. Nothing here sends a request, starts a timer or reads a text: the answer is a closed word. The words are the ones the phones know.
 */
export type LegacySigningWord = "not_home" | "home_unconfirmed" | "no_pointer" | "signed_out" | "device_proof_unavailable" | "no_device_key" | "move_in_progress" | "host_mismatch" | "phone_not_paired" | "gate_unavailable";
const KNOWN: ReadonlySet<string> = new Set(["not_home", "home_unconfirmed", "no_pointer", "signed_out", "device_proof_unavailable", "no_device_key", "move_in_progress"]);

export function legacySigningVerdict(deviceId: unknown, hostId: string | null): { ok: true } | { ok: false; why: LegacySigningWord } {
  try {
    const { oneHome } = require("./home") as typeof import("./home");   // loaded when asked: the Node entries that import the gate never load the home
    const home = oneHome();
    const standing = home.workStanding();
    if (!standing.ok) return { ok: false, why: KNOWN.has(standing.why) ? standing.why as LegacySigningWord : "not_home" };
    if (!(hostId !== null && standing.hostId === hostId)) return { ok: false, why: "host_mismatch" };
    return typeof deviceId === "string" && home.phoneVouch(deviceId) === "eligible" ? { ok: true } : { ok: false, why: "phone_not_paired" };
  } catch { return { ok: false, why: "gate_unavailable" }; }
}
