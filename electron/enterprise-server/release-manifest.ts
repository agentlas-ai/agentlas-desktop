/**
 * Verify an Agentlas-signed release manifest (docs/enterprise-server/API-CONTRACT.md §0.1, §1.3) and check that a
 * downloaded update file is one of its artifacts.
 *
 * Why the Desktop needs this: a company Enterprise Server mirrors the official installers and also serves the
 * electron-updater feed metadata (latest.yml) that carries their sha512. A compromised mirror can therefore change
 * both the installer and its checksum. On macOS Squirrel.Mac still checks the code signature, but Windows builds are
 * unsigned today and AppImage has no OS signature, so on those platforms the only signature an attacker cannot forge
 * is the cloud's signature over the release list. The rules below are a byte-compatible port of the server verifier
 * (agentlas_enterprise_server/src/license/envelope.mjs openEnvelope + src/mirror.mjs validManifest).
 *
 * Pure Node (no Electron import) so the daemon, tests and the Main process share one implementation.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReleaseTrustRoot } from "./release-trust-roots";

export const RELEASE_MANIFEST_FORMAT = "agentlas.enterprise-release-manifest.v1";
export const SIGNING_CERT_FORMAT = "agentlas.enterprise-signing-cert.v1";
/** Feed-relative file name under /updates/desktop/v<version>/ on the company server (API-CONTRACT.md §4.3). */
export const MIRRORED_RELEASE_MANIFEST_FILE = "agentlas-release-manifest.json";

export type ReleaseManifestFailure =
  | "envelope_invalid"
  | "envelope_too_large"
  | "format_mismatch"
  | "cert_missing"
  | "untrusted_root"
  | "cert_invalid"
  | "key_revoked"
  | "kid_mismatch"
  | "purpose_mismatch"
  | "signature_invalid"
  | "payload_invalid"
  | "non_canonical"
  | "cert_window"
  | "manifest_invalid"
  | "product_mismatch"
  | "version_mismatch";

export interface ReleaseManifestArtifact {
  platform: string;
  kind: string;
  filename: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifestPayload {
  product: "desktop" | "server";
  version: string;
  channel: string;
  issuedAt: string;
  artifacts: ReleaseManifestArtifact[];
}

export class ReleaseManifestError extends Error {
  constructor(readonly code: ReleaseManifestFailure) {
    super(code);
  }
}

const B64U = /^[A-Za-z0-9_-]+$/;
const KID = /^[a-z][a-z0-9_]{1,40}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,180}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_ARTIFACT = 2 * 1024 ** 3;
const PURPOSE_OF_RELEASE = "release";

/** Canonical JSON: object keys sorted, no whitespace, only JSON-safe values (envelope.mjs canonicalJson). */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReleaseManifestError("non_canonical");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new ReleaseManifestError("non_canonical");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new ReleaseManifestError("non_canonical");
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    }).join(",")}}`;
  }
  throw new ReleaseManifestError("non_canonical");
}

function signingInput(format: string, kid: string, payload: string): Buffer {
  return Buffer.from(`${format}\n${kid}\n${payload}`, "utf8");
}

function publicKeyFromRaw(raw32b64u: string) {
  const raw = Buffer.from(String(raw32b64u), "base64url");
  if (raw.length !== 32) throw new ReleaseManifestError("cert_invalid");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

interface Envelope {
  format: string;
  kid: string;
  payload: string;
  sig: string;
  cert?: unknown;
}

function checkShape(value: unknown, keys: readonly string[]): Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReleaseManifestError("envelope_invalid");
  const env = value as Record<string, unknown>;
  if (Object.keys(env).some((key) => !keys.includes(key))
    || !["format", "kid", "payload", "sig"].every((key) => typeof env[key] === "string")) {
    throw new ReleaseManifestError("envelope_invalid");
  }
  if (!B64U.test(env.payload as string) || !B64U.test(env.sig as string) || !KID.test(env.kid as string)) {
    throw new ReleaseManifestError("envelope_invalid");
  }
  if ((env.payload as string).length > 65536) throw new ReleaseManifestError("envelope_too_large");
  return env as unknown as Envelope;
}

function verifyRaw(env: Envelope, publicKey: ReturnType<typeof createPublicKey>): void {
  const sig = Buffer.from(env.sig, "base64url");
  if (sig.length !== 64 || !edVerify(null, signingInput(env.format, env.kid, env.payload), publicKey, sig)) {
    throw new ReleaseManifestError("signature_invalid");
  }
}

function decodePayload(env: Envelope): Record<string, unknown> {
  const json = Buffer.from(env.payload, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ReleaseManifestError("payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReleaseManifestError("payload_invalid");
  if (canonicalJson(parsed) !== json) throw new ReleaseManifestError("non_canonical");
  return parsed as Record<string, unknown>;
}

function openCertificate(cert: unknown, roots: readonly ReleaseTrustRoot[], revokedKids: readonly string[]) {
  const env = checkShape(cert, ["format", "kid", "payload", "sig"]);
  if (env.format !== SIGNING_CERT_FORMAT) throw new ReleaseManifestError("format_mismatch");
  const root = roots.find((entry) => entry.root === env.kid);
  if (!root) throw new ReleaseManifestError("untrusted_root");
  verifyRaw(env, publicKeyFromRaw(root.publicKey));
  const payload = decodePayload(env);
  if (typeof payload.kid !== "string" || !KID.test(payload.kid) || typeof payload.publicKey !== "string"
    || payload.root !== env.kid || !Array.isArray(payload.purposes)
    || typeof payload.notBefore !== "string" || !Number.isFinite(Date.parse(payload.notBefore))
    || typeof payload.notAfter !== "string" || !Number.isFinite(Date.parse(payload.notAfter))) {
    throw new ReleaseManifestError("cert_invalid");
  }
  if (revokedKids.includes(payload.kid)) throw new ReleaseManifestError("key_revoked");
  return payload as { kid: string; publicKey: string; purposes: unknown[]; notBefore: string; notAfter: string };
}

function validManifest(payload: Record<string, unknown>): payload is Record<string, unknown> & ReleaseManifestPayload {
  const artifacts = payload.artifacts;
  return (payload.product === "server" || payload.product === "desktop")
    && typeof payload.version === "string" && VERSION.test(payload.version)
    && typeof payload.channel === "string"
    && Array.isArray(artifacts) && artifacts.length > 0 && artifacts.length <= 40
    && artifacts.every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const a = raw as Record<string, unknown>;
      return typeof a.filename === "string" && FILE.test(a.filename) && !a.filename.includes("..")
        && typeof a.sha256 === "string" && /^[a-f0-9]{64}$/.test(a.sha256)
        && Number.isInteger(a.size) && (a.size as number) >= 0 && (a.size as number) <= MAX_ARTIFACT
        && typeof a.platform === "string" && typeof a.kind === "string";
    });
}

/**
 * Open a release manifest. The signing certificate must chain to a compiled-in root, carry the `release` purpose and
 * cover the manifest's own issuedAt (signature-time validity, like a code-signing timestamp).
 */
export function openReleaseManifest(
  envelope: unknown,
  opts: { roots: readonly ReleaseTrustRoot[]; revokedKids?: readonly string[]; product: "desktop" | "server"; version: string },
): ReleaseManifestPayload {
  const env = checkShape(envelope, ["format", "kid", "payload", "sig", "cert"]);
  if (env.format !== RELEASE_MANIFEST_FORMAT) throw new ReleaseManifestError("format_mismatch");
  if (!env.cert) throw new ReleaseManifestError("cert_missing");
  const cert = openCertificate(env.cert, opts.roots, opts.revokedKids ?? []);
  if (cert.kid !== env.kid) throw new ReleaseManifestError("kid_mismatch");
  if (!cert.purposes.includes(PURPOSE_OF_RELEASE)) throw new ReleaseManifestError("purpose_mismatch");
  verifyRaw(env, publicKeyFromRaw(cert.publicKey));
  const payload = decodePayload(env);
  const issued = typeof payload.issuedAt === "string" ? Date.parse(payload.issuedAt) : Number.NaN;
  if (!Number.isFinite(issued) || issued < Date.parse(cert.notBefore) || issued > Date.parse(cert.notAfter)) {
    throw new ReleaseManifestError("cert_window");
  }
  if (!validManifest(payload)) throw new ReleaseManifestError("manifest_invalid");
  if (payload.product !== opts.product) throw new ReleaseManifestError("product_mismatch");
  if (payload.version !== opts.version) throw new ReleaseManifestError("version_mismatch");
  return payload;
}

/** Streams the file once; never loads a 600 MB installer into memory. */
export async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      hash.update(buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return { sha256: hash.digest("hex"), size };
}

export type MirroredPayloadCheck =
  | { ok: true; artifact: ReleaseManifestArtifact }
  | { ok: false; reason: "payload-missing" | "payload-not-in-manifest" | "payload-hash-mismatch" };

/** The downloaded file must be listed by name in the verified manifest with the same size and SHA-256. */
export async function checkPayloadAgainstManifest(
  manifest: ReleaseManifestPayload,
  downloadedFile: string | null,
): Promise<MirroredPayloadCheck> {
  if (!downloadedFile) return { ok: false, reason: "payload-missing" };
  let digest: { sha256: string; size: number };
  try {
    digest = await sha256File(downloadedFile);
  } catch {
    return { ok: false, reason: "payload-missing" };
  }
  // electron-updater keeps the feed's file name in its pending directory; normalise Windows separators too.
  const name = path.basename(downloadedFile.replace(/\\/g, "/"));
  const listed = manifest.artifacts.find((artifact) => artifact.filename === name);
  if (!listed) return { ok: false, reason: "payload-not-in-manifest" };
  if (listed.sha256 !== digest.sha256 || listed.size !== digest.size) return { ok: false, reason: "payload-hash-mismatch" };
  return { ok: true, artifact: listed };
}
