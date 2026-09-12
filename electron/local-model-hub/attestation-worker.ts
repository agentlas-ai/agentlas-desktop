import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LocalEnginePackageIdentity } from "../../shared/local-model-hub";

// Keep this child standalone: managed Node cannot import application modules inside Electron's ASAR.
function assertLocalEnginePackageIdentity(identity: LocalEnginePackageIdentity): void {
  if (identity?.engine !== "llama.cpp" || identity.provenance?.repository !== "ggml-org/llama.cpp"
    || identity.provenance.signerWorkflowRepository !== "ggml-org/llama.cpp"
    || !/^[a-f0-9]{64}$/.test(identity.sha256) || !/^[a-f0-9]{40}$/.test(identity.sourceCommit)
    || !/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,255}$/.test(identity.fileName)
    || !Number.isSafeInteger(identity.byteLength) || identity.byteLength < 1) throw new Error("engine_attestation_identity_invalid");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const MAX_BYTES = 4 * 1024 * 1024;
export const ENGINE_CERTIFICATE_IDENTITY = "https://github.com/ggml-org/llama.cpp/.github/workflows/release.yml@refs/heads/master";
export const ENGINE_SIGNATURE_POLICY = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI: `^${ENGINE_CERTIFICATE_IDENTITY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  ctLogThreshold: 1, tlogThreshold: 1, timeout: 5000, retry: 0, tufForceCache: false,
});

export interface EngineAttestationEvidence {
  verifier: "managed-sigstore";
  bundleSha256: string;
  certificateIdentity: string;
  sourceCommit: string;
}

/** Only call after cryptographic verification of this exact DSSE payload. */
export function bindEngineStatement(bundle: any, identity: LocalEnginePackageIdentity): void {
  if (bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json") throw new Error("engine_attestation_payload_type_invalid");
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  const definition = statement?.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const repository = "https://github.com/ggml-org/llama.cpp";
  if (statement?._type !== "https://in-toto.io/Statement/v1"
    || statement.predicateType !== "https://slsa.dev/provenance/v1"
    || definition?.buildType !== "https://actions.github.io/buildtypes/workflow/v1"
    || workflow?.repository !== repository || workflow?.path !== ".github/workflows/release.yml"
    || workflow?.ref !== "refs/heads/master"
    || statement.predicate?.runDetails?.builder?.id !== ENGINE_CERTIFICATE_IDENTITY) throw new Error("engine_attestation_workflow_mismatch");
  const subjects = Array.isArray(statement.subject) ? statement.subject.filter((value: any) => value?.name === identity.fileName) : [];
  if (subjects.length !== 1 || subjects[0]?.digest?.sha256 !== identity.sha256) throw new Error("engine_attestation_subject_mismatch");
  const sources = Array.isArray(definition.resolvedDependencies) ? definition.resolvedDependencies.filter((value: any) => value?.uri === `git+${repository}@refs/heads/master`) : [];
  if (sources.length !== 1 || sources[0]?.digest?.gitCommit !== identity.sourceCommit) throw new Error("engine_attestation_source_mismatch");
}

export async function fetchEngineAttestations(identity: LocalEnginePackageIdentity, fetcher: typeof fetch = fetch): Promise<unknown[]> {
  assertLocalEnginePackageIdentity(identity);
  const response = await fetcher(`https://api.github.com/repos/ggml-org/llama.cpp/attestations/sha256:${identity.sha256}?per_page=8`, {
    redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Agentlas-Engine-Verifier" },
  });
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "engine_attestation_rate_limited" : "engine_attestation_fetch_failed");
  if (Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) throw new Error("engine_attestation_response_too_large");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("engine_attestation_response_too_large");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(value?.attestations) || !value.attestations.length || value.attestations.length > 8) throw new Error("engine_attestation_bundle_missing");
  // This fixed, bounded first page is sufficient for current pinned releases. Never follow a remote Link URL.
  return value.attestations.map((row: any) => row?.bundle);
}

export async function verifyEngineBundle(bundle: unknown, identity: LocalEnginePackageIdentity, sigstore: { verify: (bundle: unknown, options: object) => Promise<unknown> }, cachePath: string): Promise<EngineAttestationEvidence> {
  assertLocalEnginePackageIdentity(identity);
  await sigstore.verify(bundle, { ...ENGINE_SIGNATURE_POLICY, tufCachePath: cachePath });
  bindEngineStatement(bundle, identity);
  return { verifier: "managed-sigstore", bundleSha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"), certificateIdentity: ENGINE_CERTIFICATE_IDENTITY, sourceCommit: identity.sourceCommit };
}

interface Request { nonce: string; identity: LocalEnginePackageIdentity; archivePath: string; modulePath: string; cacheParent: string }
async function execute(request: Request): Promise<EngineAttestationEvidence> {
  assertLocalEnginePackageIdentity(request.identity);
  if ((await stat(request.archivePath)).size !== request.identity.byteLength || await sha256File(request.archivePath) !== request.identity.sha256) throw new Error("engine_attestation_archive_changed");
  // A fresh cache starts from the root shipped in the verified Node/npm tree. A writable cached root is never a trust anchor.
  const cache = await mkdtemp(join(request.cacheParent, "trust-"));
  try {
    const sigstore = require(request.modulePath) as Parameters<typeof verifyEngineBundle>[2];
    const bundles = await fetchEngineAttestations(request.identity);
    for (const bundle of bundles) {
      try { return await verifyEngineBundle(bundle, request.identity, sigstore, cache); } catch { /* Try only the bounded signed bundles from this exact subject endpoint. */ }
    }
    throw new Error("engine_artifact_attestation_failed");
  } finally { await rm(cache, { recursive: true, force: true }); }
}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => { input += chunk; if (input.length > 32768) process.exit(2); });
  process.stdin.on("end", async () => {
    let nonce = "";
    try {
      const request = JSON.parse(input) as Request;
      if (typeof request.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(request.nonce)) throw new Error("engine_attestation_request_invalid");
      nonce = request.nonce;
      const evidence = await execute(request);
      process.stdout.write(JSON.stringify({ nonce, ok: true, evidence }));
    } catch (error) {
      const code = error instanceof Error && /^engine_[a-z_]+$/.test(error.message) ? error.message : "engine_artifact_attestation_failed";
      process.stdout.write(JSON.stringify({ nonce, ok: false, reasonCode: code })); process.exitCode = 1;
    }
  });
}
