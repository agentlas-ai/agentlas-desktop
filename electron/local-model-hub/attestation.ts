import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertLocalEnginePackageIdentity, type LocalEnginePackageIdentity } from "../../shared/local-model-hub";
import { resolveManagedNodeRuntimeAsync } from "../runtime/managed-node";
import { ENGINE_CERTIFICATE_IDENTITY, type EngineAttestationEvidence } from "./attestation-worker";

export interface EngineAttestationOptions {
  /** Private host-contract seam. Production always resolves the source-pinned packaged runtime. */
  resolveRuntime?: typeof resolveManagedNodeRuntimeAsync;
  workerPath?: string;
  timeoutMs?: number;
}

export async function verifyManagedEngineAttestation(identity: LocalEnginePackageIdentity, archivePath: string, cacheRoot: string, signal?: AbortSignal, options: EngineAttestationOptions = {}): Promise<EngineAttestationEvidence> {
  assertLocalEnginePackageIdentity(identity);
  signal?.throwIfAborted();
  // 강제 재검증은 런타임 트리 전체를 다시 해시한다 — 기본 15초 상한은 메모리 압박·느린 디스크에서
  // 넘어가 engine_attestation_managed_runtime_unavailable 로 끝났다(프로덕션 1.2.0 실측 2026-09-13).
  // 여기서는 사용자가 버튼을 누르고 기다리는 자리라 상한을 최대(60초)로 준다.
  const runtime = await (options.resolveRuntime ?? resolveManagedNodeRuntimeAsync)({ signal, forceVerify: true, timeoutMs: 60_000 });
  signal?.throwIfAborted();
  if (!runtime.ok) {
    // 사유를 로그에 남긴다 — 프로덕션 1.2.0 실측에서 이 코드만 남아 "왜"를 알 길이 없었다.
    console.warn(`[local-model-hub] engine attestation: managed Node unavailable — ${runtime.reason}`);
    throw new Error(`engine_attestation_managed_runtime_unavailable: ${runtime.reason}`);
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const cacheParent = await mkdtemp(join(cacheRoot, "verify-"));
  const nonce = randomUUID();
  try {
    // Electron reads these application bytes from its integrity-checked ASAR. Plain managed Node
    // needs a real file; never ask it to read app.asar or execute an unverified unpacked sibling.
    const workerBytes = await readFile(options.workerPath ?? join(__dirname, "attestation-worker.js"));
    const workerPath = join(cacheParent, "worker.cjs");
    await writeFile(workerPath, workerBytes, { mode: 0o600, flag: "wx" });
    if (createHash("sha256").update(await readFile(workerPath)).digest("hex") !== createHash("sha256").update(workerBytes).digest("hex")) throw new Error("engine_attestation_worker_changed");
    signal?.throwIfAborted();
    return await new Promise((resolveResult, reject) => {
      const env = { ...process.env };
      // A verified executable must not preload caller-selected code or use a caller-selected TLS trust root.
      for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "ELECTRON_RUN_AS_NODE"]) delete env[key];
      const child = spawn(runtime.runtime.node, [workerPath], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", failure: Error | null = null, killTimer: NodeJS.Timeout | null = null;
      const stop = (error: Error) => {
        if (failure) return; failure = error;
        try { child.kill("SIGTERM"); } catch { /* close still owns settlement */ }
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 1000);
      };
      const abort = () => stop(new Error("engine_attestation_cancelled"));
      const deadline = setTimeout(() => stop(new Error("engine_attestation_timed_out")), options.timeoutMs ?? 60000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        if (Buffer.byteLength(stdout) + chunk.byteLength > 8192) return stop(new Error("engine_attestation_receipt_invalid"));
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", () => { /* Drain diagnostics; no remote prose becomes a host policy decision. */ });
      child.once("error", () => { failure ??= new Error("engine_attestation_worker_failed"); });
      child.stdin.on("error", () => { /* close owns completion */ });
      child.once("close", (code) => {
        clearTimeout(deadline); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
        if (failure || signal?.aborted) return reject(failure ?? new Error("engine_attestation_cancelled"));
        try {
          const value = JSON.parse(stdout), evidence = value.evidence;
          if (value.nonce !== nonce) throw new Error("engine_attestation_receipt_invalid");
          if (code !== 0 || value.ok !== true) throw new Error(/^engine_[a-z_]+$/.test(value.reasonCode) ? value.reasonCode : "engine_artifact_attestation_failed");
          if (evidence?.verifier !== "managed-sigstore" || evidence.certificateIdentity !== ENGINE_CERTIFICATE_IDENTITY
            || evidence.sourceCommit !== identity.sourceCommit || !/^[a-f0-9]{64}$/.test(evidence.bundleSha256)) throw new Error("engine_attestation_receipt_invalid");
          resolveResult(evidence);
        } catch (error) { reject(error); }
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.end(JSON.stringify({ nonce, identity, archivePath, modulePath: join(dirname(dirname(runtime.runtime.npmCli)), "node_modules", "sigstore"), cacheParent }));
    });
  } finally { await rm(cacheParent, { recursive: true, force: true }); }
}
