import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type https from "node:https";

import { generate } from "selfsigned";

const BRIDGE_DIR = "mobile-bridge";
const CERTIFICATE_FILE = "server-cert.pem";
const PRIVATE_KEY_FILE = "server-key.pem";
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface MobileBridgeTlsMaterial {
  serverOptions: https.ServerOptions;
  certificateFingerprint: string;
  certificateDer: string;
}

function bridgeDirectory(userDataPath: string): string {
  return path.join(userDataPath, BRIDGE_DIR);
}

function certificatePath(userDataPath: string): string {
  return path.join(bridgeDirectory(userDataPath), CERTIFICATE_FILE);
}

function privateKeyPath(userDataPath: string): string {
  return path.join(bridgeDirectory(userDataPath), PRIVATE_KEY_FILE);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function writePrivateFileAtomic(target: string, value: string): void {
  const directory = path.dirname(target);
  ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function publicNetworkAddresses(): string[] {
  const addresses = new Set<string>();
  for (const records of Object.values(os.networkInterfaces())) {
    for (const record of records ?? []) {
      if (record.internal) continue;
      addresses.add(record.address.split("%", 1)[0]);
    }
  }
  return [...addresses];
}

function certificateNames(): Array<{ type: 2; value: string } | { type: 7; ip: string }> {
  const hostname = os.hostname().trim().toLowerCase();
  const dnsNames = new Set(["localhost"]);
  if (hostname) {
    dnsNames.add(hostname);
    dnsNames.add(hostname.endsWith(".local") ? hostname : `${hostname}.local`);
  }
  const ipAddresses = new Set(["127.0.0.1", "::1", ...publicNetworkAddresses()]);
  return [
    ...[...dnsNames].map((value) => ({ type: 2 as const, value })),
    ...[...ipAddresses].map((ip) => ({ type: 7 as const, ip })),
  ];
}

function normalizeFingerprint(value: string): string {
  const fingerprint = value.replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("Mobile Bridge TLS certificate has an invalid SHA-256 fingerprint");
  }
  return fingerprint;
}

function materialFromPem(certificate: string, privateKey: string): MobileBridgeTlsMaterial {
  const parsed = new X509Certificate(certificate);
  if (!parsed.ca) {
    throw new Error("Mobile Bridge TLS certificate must be its own pinned trust anchor");
  }
  const expiresAt = Date.parse(parsed.validTo);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + RENEW_BEFORE_MS) {
    throw new Error("Mobile Bridge TLS certificate is expired or near expiry");
  }
  return {
    serverOptions: {
      cert: certificate,
      key: privateKey,
      minVersion: "TLSv1.2",
    },
    certificateFingerprint: normalizeFingerprint(parsed.fingerprint256),
    certificateDer: parsed.raw.toString("base64"),
  };
}

/**
 * DESKTOP_MOBILE_BRIDGE: The private key never crosses IPC or the QR payload.
 * The public DER certificate is embedded in the one-time QR so Mobile can
 * build a trust store pinned to this exact Desktop certificate before sending
 * either the pairing nonce or its long-lived bearer credential.
 */
export async function loadOrCreateMobileBridgeTls(
  userDataPath: string,
): Promise<MobileBridgeTlsMaterial> {
  const certPath = certificatePath(userDataPath);
  const keyPath = privateKeyPath(userDataPath);
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const material = materialFromPem(
        fs.readFileSync(certPath, "utf8"),
        fs.readFileSync(keyPath, "utf8"),
      );
      if (process.platform !== "win32") {
        fs.chmodSync(certPath, 0o600);
        fs.chmodSync(keyPath, 0o600);
      }
      return material;
    } catch {
      // Rotation is explicit and atomic below. Existing paired devices fail
      // closed on the old fingerprint and must scan a new Desktop QR.
    }
  } else if (fs.existsSync(certPath) || fs.existsSync(keyPath)) {
    throw new Error("Mobile Bridge TLS material is incomplete; explicit recovery is required");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 825 * 24 * 60 * 60 * 1_000);
  const generated = await generate(
    [{ name: "commonName", value: os.hostname() || "Agentlas Desktop" }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now.getTime() - 5 * 60_000),
      notAfterDate: expiresAt,
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyAgreement: true,
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: certificateNames(), critical: true },
      ],
    },
  );
  const material = materialFromPem(generated.cert, generated.private);
  // Write the key before the certificate. A crash between writes is detected
  // as an incomplete pair on the next launch and never silently regenerated.
  writePrivateFileAtomic(keyPath, generated.private);
  writePrivateFileAtomic(certPath, generated.cert);
  return material;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
  );
}

function isLanIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

/** Prefer a private LAN/Tailscale IPv4 address that a physical phone can use. */
export function preferredMobileBridgeHost(): string {
  const addresses = publicNetworkAddresses();
  return (
    addresses.find(isLanIpv4) ??
    addresses.find(isPrivateIpv4) ??
    addresses.find((address) => !address.includes(":")) ??
    "127.0.0.1"
  );
}
