import { createHash, verify, type KeyObject } from "node:crypto";
import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import { parseCompanionWorkContext, type CompanionWorkContext } from "./companion-work-context";
import { parseCompanionFrontContext, type CompanionFrontContext } from "./companion-front-context";

const METHOD = "one.front-turn.send.v1", AUDIENCE = "agentlas.companion.front-execution.v1";
const CLAIM_FIELDS = [...COMPANION_HANDOFF_PROOF_FIELDS, "audience", "nonce", "issuedAt", "expiresAt"].sort();
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
type Identity = { userId: string; workspaceId: string; authEpoch: number; accountSubject: string; deviceId: string; hostId: string; oneId: string };
type Binding = Identity & { familyId: string; turnId: string; commandId: string; desktopChallenge: string; method: string;
  contextDigest: string; payloadDigest: string; contextRevision: number; runGeneration: number };
type Verified = { binding: Binding; context: CompanionWorkContext | CompanionFrontContext; assertCurrent(): void };
const capabilities = new WeakMap<object, Verified>();

/** Separate grant and one-use capability for a personal One turn. No Work
 * capability, caller-supplied key, or unsigned context can authorize it. */
export function createCompanionFrontAdmissionVerifier(options: { publicKey: KeyObject; identity(): Identity | null; assertCurrent(): void; now?: () => number }) {
  if (options.publicKey?.type !== "public" || options.publicKey.asymmetricKeyType !== "ed25519" || typeof options.identity !== "function" || typeof options.assertCurrent !== "function") throw new TypeError("companion_front_admission_config");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return function verifyAdmission(input: {grant:string;binding:unknown;payload:string}): object | null {
    try {
      options.assertCurrent();
      if (!input?.binding || typeof input.binding !== "object" || Array.isArray(input.binding)) return null;
      const b = input.binding as Binding;
      if (b.method !== METHOD) return null;
      // Reuse only the closed field-shape validator. The signed grant and
      // payload below retain the real front method and separate audience.
      companionHandoffProofBytes({...b, method:"one.work-handoff.send.v1"});
      const identity = options.identity();
      if (!identity || (["userId","workspaceId","authEpoch","accountSubject","deviceId","hostId","oneId"] as const).some(key => b[key] !== identity[key]) ||
          typeof input.grant !== "string" || input.grant.length > 4096 || typeof input.payload !== "string" || Buffer.byteLength(input.payload, "utf8") > 80 * 1024 || digest(input.payload) !== b.payloadDigest) return null;
      const parts = input.grant.split(".");
      if (parts.length !== 3 || parts[0] !== "cag1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
      const body = Buffer.from(parts[1], "base64url"), sig = Buffer.from(parts[2], "base64url");
      if (body.toString("base64url") !== parts[1] || sig.length !== 64 || sig.toString("base64url") !== parts[2] ||
          !verify(null, Buffer.from(`cag1.${parts[1]}`, "ascii"), options.publicKey, sig)) return null;
      const claims = JSON.parse(body.toString("utf8")) as Record<string, unknown>, keys = Object.keys(claims).sort(), time = now();
      if (keys.length !== CLAIM_FIELDS.length || !keys.every((key, i) => key === CLAIM_FIELDS[i]) || claims.audience !== AUDIENCE ||
          typeof claims.nonce !== "string" || !/^cah_[A-Za-z0-9_-]{22}$/.test(claims.nonce) || !Number.isSafeInteger(claims.issuedAt) ||
          !Number.isSafeInteger(claims.expiresAt) || Number(claims.issuedAt) > time || Number(claims.expiresAt) <= time ||
          Number(claims.expiresAt) - Number(claims.issuedAt) <= 0 || Number(claims.expiresAt) - Number(claims.issuedAt) > 60 ||
          COMPANION_HANDOFF_PROOF_FIELDS.some(key => claims[key] !== b[key])) return null;
      const payload: unknown = JSON.parse(input.payload);
      if (!Array.isArray(payload) || payload.length !== 2 || payload[0] !== METHOD || JSON.stringify(payload) !== input.payload ||
          !payload[1] || typeof payload[1] !== "object" || Array.isArray(payload[1]) || digest(JSON.stringify(payload[1])) !== b.contextDigest) return null;
      const context = payload[1].version===2 ? parseCompanionFrontContext(payload[1],b) : parseCompanionWorkContext(payload[1],b); if (!context) return null;
      options.assertCurrent();
      const capability = Object.freeze({});
      const assertCurrent = () => {
        options.assertCurrent(); const current = options.identity();
        if (!current || now() >= Number(claims.expiresAt) || (["userId","workspaceId","authEpoch","accountSubject","deviceId","hostId","oneId"] as const).some(key => b[key] !== current[key])) throw new Error("companion_front_authority_changed");
      };
      capabilities.set(capability,{binding:structuredClone(b),context,assertCurrent}); return capability;
    } catch { return null; }
  };
}

export function takeCompanionFrontAdmission(capability: unknown): Verified | null {
  if (!capability || typeof capability !== "object") return null;
  const verified = capabilities.get(capability); capabilities.delete(capability);
  if (!verified) return null;
  try { verified.assertCurrent(); return verified; } catch { return null; }
}
