import { createPrivateKey, X509Certificate } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import type https from "node:https";

import { generate } from "selfsigned";

const BRIDGE_DIR = "mobile-bridge";
const CERTIFICATE_FILE = "server-cert.pem";
const PRIVATE_KEY_FILE = "server-key.pem";
// Paired phones pin the exact certificate DER (sha256), so any reissue changes
// the fingerprint and locks every paired device out (fail-closed). This is a
// pinned self-signed anchor verified out-of-band by the QR payload, NOT a
// public-CA leaf, so it does not fall under the 825-day system TLS policy. A
// century-long lifetime therefore means the certificate effectively never has
// to rotate, which is what keeps a long-lived pairing from silently breaking.
const CERTIFICATE_LIFETIME_MS = 100 * 365 * 24 * 60 * 60 * 1_000;

export interface MobileBridgeTlsMaterial {
  serverOptions: https.ServerOptions;
  certificateFingerprint: string;
  certificateDer: string;
  /** True only when this launch minted a NEW certificate (fingerprint changed). */
  rotated: boolean;
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

export interface MobileBridgeNetworkAddress {
  interfaceName: string;
  address: string;
  internal: boolean;
}

function networkAddressCandidates(): MobileBridgeNetworkAddress[] {
  const candidates: MobileBridgeNetworkAddress[] = [];
  for (const [interfaceName, records] of Object.entries(os.networkInterfaces())) {
    for (const record of records ?? []) {
      candidates.push({
        interfaceName,
        address: record.address.split("%", 1)[0],
        internal: record.internal,
      });
    }
  }
  return candidates;
}

function publicNetworkAddresses(): string[] {
  return [...new Set(
    networkAddressCandidates()
      .filter((candidate) => !candidate.internal)
      .map((candidate) => candidate.address),
  )];
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
  const parsedPrivateKey = createPrivateKey(privateKey);
  if (!parsed.checkPrivateKey(parsedPrivateKey)) {
    throw new Error("Mobile Bridge TLS private key does not match its certificate");
  }
  const expiresAt = Date.parse(parsed.validTo);
  // Only a genuinely expired certificate is rejected. A "near expiry" renewal
  // window was the time bomb: it reissued the certificate ahead of expiry,
  // changing the pinned fingerprint and forcing every paired phone to re-pair.
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Mobile Bridge TLS certificate is expired");
  }
  return {
    serverOptions: {
      cert: certificate,
      key: privateKey,
      minVersion: "TLSv1.2",
    },
    certificateFingerprint: normalizeFingerprint(parsed.fingerprint256),
    certificateDer: parsed.raw.toString("base64"),
    rotated: false,
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
  const expiresAt = new Date(now.getTime() + CERTIFICATE_LIFETIME_MS);
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
  // rotated: true lets the runtime surface a "paired phones must re-pair"
  // warning instead of silently changing the pinned fingerprint. With the
  // century-long lifetime and no renewal window this path is now only reached
  // on first launch or genuine file loss, not on routine near-expiry.
  return { ...material, rotated: true };
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
  const selected = selectPreferredMobileBridgeHost(networkAddressCandidates());
  if (!selected) {
    throw new Error(
      "No usable LAN address was found for Agentlas Mobile Bridge; connect this Desktop to the phone's LAN or set AGENTLAS_MOBILE_BRIDGE_HOST",
    );
  }
  return selected;
}

const PHYSICAL_INTERFACE_RE = /^(?:en\d+|eth\d+|eno\d+|ens\d+|enp\w+|wlan\d+|wlp\w+|wi-?fi|ethernet)/i;
const VIRTUAL_INTERFACE_RE = /^(?:awdl|llw|utun|tun\d*|tap\d*|docker|veth|br-|bridge|vmnet|vbox|virbr|vethernet|hyper-v|parallels|lo\d*)/i;
// On Windows, a Hyper-V external vSwitch or WSL bridged setup moves the
// machine's REAL LAN address onto a "vEthernet (…)" adapter and leaves the
// physical NIC unbound. Dropping those names entirely produced zero candidates
// ("No usable LAN address") on exactly those machines, so they are allowed as
// demoted last-resort candidates instead. Other virtual names stay excluded.
const WINDOWS_VSWITCH_INTERFACE_RE = /^(?:vethernet|hyper-v)/i;

function isUsablePrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    isIP(normalized) === 6 &&
    /^f[cd][0-9a-f]{2}:/.test(normalized)
  );
}

/**
 * Select an address a physical phone can actually route to. Interface class is
 * retained so Docker/VM bridges cannot win merely because the OS enumerated
 * their RFC1918 address first. Only IPv6 ULA addresses auto-bind; a global
 * IPv6 bind remains available only through the explicit operator override.
 */
export function selectPreferredMobileBridgeHost(
  candidates: readonly MobileBridgeNetworkAddress[],
): string | null {
  const scored = candidates.flatMap((candidate) => {
    if (candidate.internal) return [];
    const address = candidate.address.split("%", 1)[0];
    const name = candidate.interfaceName.trim();
    const tailscale = /tailscale/i.test(name) || /^100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(address);
    const virtual = VIRTUAL_INTERFACE_RE.test(name) && !tailscale;
    const windowsVSwitch = virtual && WINDOWS_VSWITCH_INTERFACE_RE.test(name);
    if (virtual && !windowsVSwitch) return [];
    const physical = !virtual && PHYSICAL_INTERFACE_RE.test(name);
    let score: number | null = null;
    if (physical && isLanIpv4(address)) score = 0;
    else if (physical && isUsablePrivateIpv6(address)) score = 10;
    else if (physical && isPrivateIpv4(address)) score = 20;
    else if (tailscale && isPrivateIpv4(address)) score = 30;
    else if (!virtual && isLanIpv4(address)) score = 40;
    else if (!virtual && isUsablePrivateIpv6(address)) score = 50;
    else if (!virtual && isPrivateIpv4(address)) score = 60;
    // A vSwitch on a home/enterprise LAN band (192.168/10.x) is likely the
    // machine's actual route to the phone; the 172.16-31 band is more often a
    // WSL/Default Switch NAT, so it only wins when nothing else exists at all.
    else if (windowsVSwitch && isLanIpv4(address) && !address.startsWith("172.")) score = 100;
    else if (windowsVSwitch && isLanIpv4(address)) score = 130;
    if (score === null) return [];
    return [{ ...candidate, address, score }];
  });
  scored.sort((left, right) =>
    left.score - right.score ||
    left.interfaceName.localeCompare(right.interfaceName) ||
    left.address.localeCompare(right.address),
  );
  return scored[0]?.address ?? null;
}
