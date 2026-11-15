import { createHash, verify, type KeyObject } from "node:crypto";
import { companionHandoffProofBytes } from "../../shared/companion-handoff-proof";
import { parseCompanionWorkContext, type CompanionWorkContext } from "./companion-work-context";

const BINDING_FIELDS = ["userId", "workspaceId", "authEpoch", "accountSubject", "familyId", "deviceId", "hostId", "oneId", "turnId", "commandId", "desktopChallenge", "method", "contextDigest", "payloadDigest", "contextRevision", "runGeneration"] as const;
const CLAIM_FIELDS = [...BINDING_FIELDS, "audience", "nonce", "issuedAt", "expiresAt"].sort();
const AUDIENCE = "agentlas.companion.desktop-execution.v1";
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
type Identity = { userId: string; workspaceId: string; authEpoch: number; accountSubject: string; deviceId: string; hostId: string; oneId: string };
type Binding = Identity & { familyId: string; turnId: string; commandId: string; desktopChallenge: string; method: string; contextDigest: string; payloadDigest: string; contextRevision: number; runGeneration: number };
type Work = { brief: string; doneWhen: string; permissions: "read" | "write" | "full" };
type Verified = { binding: Binding; context: CompanionWorkContext; work: Work; assertCurrent(): void };
const capabilities = new WeakMap<object, Verified>();

/** This factory is Main-owned. Its public key must come from a trusted pinned
 * configuration, never a phone payload. The verifier does not dispatch Work. */
export function createCompanionWorkAdmissionVerifier(options: { publicKey: KeyObject; identity(): Identity | null; assertCurrent(): void; now?: () => number }) {
  if (options.publicKey?.type !== "public" || options.publicKey.asymmetricKeyType !== "ed25519" || typeof options.identity !== "function" || typeof options.assertCurrent !== "function") throw new TypeError("companion_work_admission_config");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return function verifyAdmission(input: { grant: string; binding: unknown; payload: string }): object | null {
    try {
      options.assertCurrent();
      companionHandoffProofBytes(input?.binding);
      const b = input.binding as Binding, identity = options.identity();
      if (!identity || b.method !== "one.work-handoff.send.v1" ||
          (["userId", "workspaceId", "authEpoch", "accountSubject", "deviceId", "hostId", "oneId"] as const).some((key) => b[key] !== identity[key]) ||
          typeof input.grant !== "string" || input.grant.length > 4096 || typeof input.payload !== "string" || Buffer.byteLength(input.payload, "utf8") > 80 * 1024 || digest(input.payload) !== b.payloadDigest) return null;
      const parts = input.grant.split(".");
      if (parts.length !== 3 || parts[0] !== "cag1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
      const body = Buffer.from(parts[1], "base64url"), sig = Buffer.from(parts[2], "base64url");
      if (body.toString("base64url") !== parts[1] || sig.length !== 64 || sig.toString("base64url") !== parts[2] ||
          !verify(null, Buffer.from(`cag1.${parts[1]}`, "ascii"), options.publicKey, sig)) return null;
      const claims = JSON.parse(body.toString("utf8")) as Record<string, unknown>, keys = Object.keys(claims).sort();
      const time = now();
      if (keys.length !== CLAIM_FIELDS.length || !keys.every((key, i) => key === CLAIM_FIELDS[i]) || claims.audience !== AUDIENCE ||
          typeof claims.nonce !== "string" || !/^cah_[A-Za-z0-9_-]{22}$/.test(claims.nonce) || !Number.isSafeInteger(claims.issuedAt) ||
          !Number.isSafeInteger(claims.expiresAt) || Number(claims.issuedAt) > time || Number(claims.expiresAt) <= time ||
          Number(claims.expiresAt) - Number(claims.issuedAt) <= 0 || Number(claims.expiresAt) - Number(claims.issuedAt) > 60 ||
          BINDING_FIELDS.some((key) => claims[key] !== b[key])) return null;
      const decoded: unknown = JSON.parse(input.payload);
      if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== b.method || JSON.stringify(decoded) !== input.payload ||
          !decoded[1] || typeof decoded[1] !== "object" || Array.isArray(decoded[1]) || digest(JSON.stringify(decoded[1])) !== b.contextDigest ||
          decoded[1].accountEpoch !== b.authEpoch || decoded[1].throughUserSeq !== b.contextRevision) return null;
      const context = parseCompanionWorkContext(decoded[1], b);
      if (!context) return null;
      const w = decoded[2] as Record<string, unknown>;
      if (!w || typeof w !== "object" || Array.isArray(w) || Object.keys(w).sort().join(",") !== "brief,doneWhen,permissions" ||
          typeof w.brief !== "string" || !w.brief.trim() || w.brief.length > 600 || /\u0000/u.test(w.brief) ||
          typeof w.doneWhen !== "string" || !w.doneWhen || w.doneWhen.length > 240 || w.doneWhen !== w.doneWhen.replace(/\s+/g, " ").trim() ||
          typeof w.permissions !== "string" || !["read", "write", "full"].includes(w.permissions)) return null;
      options.assertCurrent();
      const capability = Object.freeze({});
      const assertCurrent = () => {
        options.assertCurrent();
        const current = options.identity();
        if (!current || now() >= Number(claims.expiresAt) ||
            (["userId", "workspaceId", "authEpoch", "accountSubject", "deviceId", "hostId", "oneId"] as const).some((key) => b[key] !== current[key])) throw new Error("companion_work_authority_changed");
      };
      capabilities.set(capability, { binding: structuredClone(b), context, work: w as unknown as Work, assertCurrent });
      return capability;
    } catch { return null; }
  };
}

/** One use by the trusted Supervisor only; renderer/phone JSON cannot forge it. */
export function takeCompanionWorkAdmission(capability: unknown): Verified | null {
  if (!capability || typeof capability !== "object") return null;
  const verified = capabilities.get(capability);
  capabilities.delete(capability);
  if (!verified) return null;
  try { verified.assertCurrent(); return verified; } catch { return null; }
}
