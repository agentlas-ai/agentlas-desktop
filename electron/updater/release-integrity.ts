/**
 * What actually protects an update on each platform, said truthfully — and the company-mirror gate that does not
 * depend on Windows code signing.
 *
 * Measured 2026-10-24 (real Windows 1.3.88 -> 1.3.89): the log said `install 1.3.89: app signature verified`, yet on
 * Windows nothing was verified. The installed-app trust check is macOS-only, and electron-updater checks an
 * Authenticode publisher only when app-update.yml carries `publisherName` — which electron-builder writes only for a
 * signed build. Windows builds are unsigned today, so the honest statement is: no signature; integrity is the sha512
 * in the feed metadata, fetched over HTTPS.
 *
 * That gap mattered most for the company Enterprise Server mirror, which serves both the installer and the metadata
 * carrying its checksum. The mirror path now requires either a real OS signature check (macOS code signature, or a
 * configured Windows Authenticode publisher) or the cloud-signed release manifest verified against compiled-in roots
 * plus a SHA-256 match of the downloaded file. Without one of those the mirrored update is refused with a typed reason.
 * The public feed path is unchanged.
 *
 * Code signing hook: when Windows signing lands, electron-builder computes `publisherName` from the certificate and
 * writes it to app-update.yml (`win.verifyUpdateCodeSignature` defaults to true). electron-updater then rejects any
 * update not signed by that publisher, and readPublisherNames() below turns that into an `authenticode-publisher`
 * receipt. Unsigned builds carry no publisherName and keep updating exactly as before.
 *
 * Pure Node: no Electron import.
 */
import {
  checkPayloadAgainstManifest,
  openReleaseManifest,
  ReleaseManifestError,
  type ReleaseManifestPayload,
} from "./release-manifest";
import type { ReleaseTrustRoot } from "./release-trust-roots";

export const UPDATE_TRUST_SCHEMA = "agentlas.update-trust.v1" as const;

export type UpdateFeedKind = "official" | "company";
export type UpdateSignatureCheck =
  /** The running app is Developer ID verified here; Squirrel.Mac checks the payload against its designated requirement. */
  | "macos-code-signature"
  /** electron-updater verified the installer's Authenticode publisher against app-update.yml publisherName. */
  | "windows-authenticode-publisher"
  /** Unsigned Windows build: no publisherName, so no signature is checked. */
  | "not-verified-unsigned-windows"
  /** AppImage and other Linux payloads carry no OS signature. */
  | "not-verified-linux";

export interface UpdateTrustReceipt {
  schema: typeof UPDATE_TRUST_SCHEMA;
  platform: string;
  feed: UpdateFeedKind;
  signature: UpdateSignatureCheck;
  /** electron-updater always checks the downloaded file against the sha512 in latest*.yml. */
  integrity: "sha512-from-feed-metadata";
  transport: "https" | "http-loopback";
  releaseManifest: "not-required" | "verified";
}

export type ReleaseIntegrityFailure =
  | "mirror-trust-roots-missing"
  | "mirror-manifest-unavailable"
  | "mirror-manifest-invalid"
  | "mirror-payload-mismatch";

export type ReleaseIntegrityVerdict =
  | { ok: true; receipt: UpdateTrustReceipt }
  | { ok: false; reason: ReleaseIntegrityFailure; detail: string; receipt: UpdateTrustReceipt };

export type ReleaseIntegrityStage = "before-download" | "before-install";

/**
 * Every Desktop feed is a generic provider. GitHub's release-asset CDN answers a multi-range request
 * (`Range: bytes=a-b,c-d`) with 501, so electron-updater's default multi-range differential download always failed
 * and fell back to the full installer (643 MB instead of ~157 MB, Windows 1.3.88 -> 1.3.89). Single-range requests
 * are answered by GitHub, S3-style stores and the company server alike.
 */
export function desktopGenericFeedOptions(url: string): { provider: "generic"; url: string; useMultipleRangeRequest: false } {
  return { provider: "generic", url, useMultipleRangeRequest: false };
}

/** publisherName from app-update.yml text: `publisherName: X`, a quoted value, `[A, B]`, or a block list. */
export function readPublisherNames(appUpdateYml: string | null | undefined): string[] {
  if (typeof appUpdateYml !== "string" || !appUpdateYml) return [];
  const lines = appUpdateYml.split(/\r?\n/);
  const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^publisherName:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const inline = match[1].replace(/\s+#.*$/, "").trim();
    if (inline && inline !== "null" && inline !== "~") {
      if (inline.startsWith("[") && inline.endsWith("]")) {
        return inline.slice(1, -1).split(",").map(unquote).filter(Boolean);
      }
      const single = unquote(inline);
      return single ? [single] : [];
    }
    if (inline === "null" || inline === "~") return [];
    const names: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const item = /^\s+-\s+(.*)$/.exec(lines[next]);
      if (!item) break;
      const value = unquote(item[1]);
      if (value) names.push(value);
    }
    return names;
  }
  return [];
}

export function describeUpdateTrust(input: {
  platform: string;
  feed: UpdateFeedKind;
  publisherNames: readonly string[];
  transport?: UpdateTrustReceipt["transport"];
  releaseManifest?: UpdateTrustReceipt["releaseManifest"];
}): UpdateTrustReceipt {
  const signature: UpdateSignatureCheck = input.platform === "darwin"
    ? "macos-code-signature"
    : input.platform === "win32"
      ? (input.publisherNames.length > 0 ? "windows-authenticode-publisher" : "not-verified-unsigned-windows")
      : "not-verified-linux";
  return {
    schema: UPDATE_TRUST_SCHEMA,
    platform: input.platform,
    feed: input.feed,
    signature,
    integrity: "sha512-from-feed-metadata",
    transport: input.transport ?? "https",
    releaseManifest: input.releaseManifest ?? "not-required",
  };
}

function feedMetadataFile(platform: string): string {
  return platform === "darwin" ? "latest-mac.yml" : platform === "win32" ? "latest.yml" : "latest-linux.yml";
}

/** One log line / receipt sentence. Never says "verified" for something that was not. */
export function formatUpdateTrust(receipt: UpdateTrustReceipt): string {
  const signature = {
    "macos-code-signature": "signature: running app verified (Developer ID), update checked by Squirrel.Mac",
    "windows-authenticode-publisher": "signature: Authenticode publisher checked by electron-updater",
    "not-verified-unsigned-windows": "signature: not verified (unsigned Windows build)",
    "not-verified-linux": "signature: not verified (no OS signature on Linux)",
  }[receipt.signature];
  const transport = receipt.transport === "https" ? "HTTPS" : "loopback HTTP";
  const parts = [
    signature,
    `integrity: sha512 from ${feedMetadataFile(receipt.platform)} over ${transport}`,
    `feed: ${receipt.feed === "company" ? "company server" : "official"}`,
  ];
  if (receipt.releaseManifest === "verified") parts.push("release list: Agentlas-signed manifest verified, sha256 matches");
  return parts.join("; ");
}

/** A receipt read back from a journal written by any version: closed enums only, otherwise ignored. */
export function parseUpdateTrustReceipt(value: unknown): UpdateTrustReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const signatures: readonly string[] = ["macos-code-signature", "windows-authenticode-publisher", "not-verified-unsigned-windows", "not-verified-linux"];
  if (raw.schema !== UPDATE_TRUST_SCHEMA || typeof raw.platform !== "string"
    || (raw.feed !== "official" && raw.feed !== "company")
    || typeof raw.signature !== "string" || !signatures.includes(raw.signature)
    || raw.integrity !== "sha512-from-feed-metadata"
    || (raw.transport !== "https" && raw.transport !== "http-loopback")
    || (raw.releaseManifest !== "not-required" && raw.releaseManifest !== "verified")) return null;
  return raw as unknown as UpdateTrustReceipt;
}

export interface ReleaseIntegrityInput {
  platform: string;
  feed: { kind: "official" } | { kind: "company"; serverUrl: string };
  publisherNames: readonly string[];
  version: string;
  stage: ReleaseIntegrityStage;
  downloadedFile: string | null;
  roots: readonly ReleaseTrustRoot[];
  revokedKids?: readonly string[];
  /** The signed envelope from the company server, or null when it could not be read. Called only when required. */
  fetchManifest: () => Promise<unknown | null>;
}

/** True when the mirror path has an OS signature check that a compromised mirror cannot satisfy. */
function companyFeedHasOsSignature(platform: string, publisherNames: readonly string[]): boolean {
  return platform === "darwin" || (platform === "win32" && publisherNames.length > 0);
}

export async function verifyReleaseIntegrity(input: ReleaseIntegrityInput): Promise<ReleaseIntegrityVerdict> {
  const transport: UpdateTrustReceipt["transport"] = input.feed.kind === "company" && input.feed.serverUrl.startsWith("http:")
    ? "http-loopback"
    : "https";
  const receipt = describeUpdateTrust({
    platform: input.platform,
    feed: input.feed.kind,
    publisherNames: input.publisherNames,
    transport,
  });
  if (input.feed.kind === "official") return { ok: true, receipt };
  if (companyFeedHasOsSignature(input.platform, input.publisherNames)) return { ok: true, receipt };

  if (input.roots.length === 0) {
    return { ok: false, reason: "mirror-trust-roots-missing", detail: "no_trust_roots", receipt };
  }
  let envelope: unknown | null;
  try {
    envelope = await input.fetchManifest();
  } catch {
    envelope = null;
  }
  if (envelope === null || envelope === undefined) {
    return { ok: false, reason: "mirror-manifest-unavailable", detail: "manifest_unavailable", receipt };
  }
  let manifest: ReleaseManifestPayload;
  try {
    manifest = openReleaseManifest(envelope, {
      roots: input.roots,
      revokedKids: input.revokedKids ?? [],
      product: "desktop",
      version: input.version,
    });
  } catch (error) {
    const detail = error instanceof ReleaseManifestError ? error.code : "manifest_invalid";
    return { ok: false, reason: "mirror-manifest-invalid", detail, receipt };
  }
  if (input.stage === "before-install") {
    const payload = await checkPayloadAgainstManifest(manifest, input.downloadedFile);
    if (!payload.ok) return { ok: false, reason: "mirror-payload-mismatch", detail: payload.reason, receipt };
  }
  return { ok: true, receipt: { ...receipt, releaseManifest: "verified" } };
}
