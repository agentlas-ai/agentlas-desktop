import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { webBaseUrl } from "../auth";

const PATH = "/api/mobile-pair/v1/companion/work-signing-key";
const MAX_BYTES = 2048;

/** Fetch the verification key from the Desktop's configured web origin, never
 * from a phone request. HTTPS and same-origin/no-redirect are mandatory in a
 * normal install. A fresh key per admission permits server key rotation. */
export async function loadCompanionWorkKey(): Promise<KeyObject | null> {
  try {
    const configured = new URL(webBaseUrl());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(configured.hostname);
    if (configured.username || configured.password || configured.search || configured.hash ||
        (configured.protocol !== "https:" && !(configured.protocol === "http:" && loopback && process.env.AGENTLAS_E2E === "1"))) return null;
    const url = new URL(PATH, configured.origin);
    const response = await fetch(url, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok || new URL(response.url).origin !== configured.origin || !response.body) return null;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_BYTES) return null;
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const row: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const value = row as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "algorithm,keyId,publicKey,schema" || value.schema !== "agentlas.companion.work-signing-key.v1" ||
        value.algorithm !== "Ed25519" || typeof value.publicKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.publicKey) ||
        typeof value.keyId !== "string" || !/^[a-f0-9]{64}$/.test(value.keyId)) return null;
    const der = Buffer.from(value.publicKey, "base64url");
    if (der.length !== 44 || der.toString("base64url") !== value.publicKey || createHash("sha256").update(der).digest("hex") !== value.keyId) return null;
    const key = createPublicKey({ key: der, type: "spki", format: "der" });
    return key.asymmetricKeyType === "ed25519" && key.export({ type: "spki", format: "der" }).equals(der) ? key : null;
  } catch { return null; }
}
