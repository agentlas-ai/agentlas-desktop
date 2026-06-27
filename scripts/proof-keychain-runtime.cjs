#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-keychain-runtime-"));
const userDataDir = path.join(tempDir, "user-data");
const artifactDir = path.resolve(process.cwd(), "artifacts", "keychain-runtime");
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", userDataDir);

const { initStore } = require("../dist/electron/store/db.js");
const {
  deleteApiKey,
  deleteEnvVar,
  hasApiKey,
  hasEnvVar,
  previewEnvVar,
  saveApiKey,
  setEnvVar,
} = require("../dist/electron/secrets/vault.js");
const { detectRuntimes, setActiveRuntime } = require("../dist/electron/runtime/detect.js");
const { pickActive, pickRunner } = require("../dist/electron/runtime/selection.js");

const safeBackends = ["anthropic", "openai", "google", "upstage", "custom"];

async function runRealRuntimeSmoke(runtimes) {
  if (process.env.AGENTLAS_SKIP_REAL_LLM === "1") {
    return { status: "skipped", reason: "AGENTLAS_SKIP_REAL_LLM=1" };
  }
  const active = pickActive(runtimes);
  if (!active) return { status: "skipped", reason: "no runtime detected" };
  const picked = pickRunner(active);
  if (!picked) return { status: "skipped", reason: `no runner for ${active.kind}/${active.backend}` };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AGENTLAS_RUNTIME_PROOF_TIMEOUT_MS ?? 90_000));
  const partials = [];
  const statuses = [];
  try {
    const result = await picked.runner(
      {
        systemPrompt: "You are an Agentlas Desktop release smoke-test responder.",
        history: [],
        userPrompt: "Return exactly AGENTLAS_RUNTIME_OK and nothing else.",
        backendLabel: picked.label,
        model: active.model ?? undefined,
        longContext: active.longContextEnabled ?? undefined,
        effort: active.effort ?? undefined,
        permission: "read",
        cwd: tempDir,
        chatId: `proof-${Date.now()}`,
        locale: "en",
        signal: controller.signal,
      },
      {
        onPartial: (chunk) => partials.push(String(chunk).slice(-500)),
        onStatus: (status) => statuses.push(status),
        onTool: (name, args, toolResult, id, isError) => {
          statuses.push(`tool:${name}:${isError ? "error" : "ok"}:${id ?? ""}`);
        },
      },
    );
    const text = String(result.text ?? "").trim();
    const ok = /AGENTLAS_RUNTIME_OK/.test(text);
    return {
      status: ok ? "passed" : "failed",
      runtime: {
        kind: active.kind,
        backend: active.backend,
        source: active.source,
        model: active.model ?? null,
        label: picked.label,
      },
      responsePreview: text.slice(0, 500),
      statuses: statuses.slice(0, 12),
      partialCount: partials.length,
      tokenCount: result.tokens ?? null,
    };
  } catch (err) {
    return {
      status: "failed",
      runtime: {
        kind: active.kind,
        backend: active.backend,
        source: active.source,
        model: active.model ?? null,
        label: picked.label,
      },
      error: err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000),
      statuses: statuses.slice(0, 12),
      partialCount: partials.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

(async () => {
  let exitCode = 0;
  const envKey = `AGENTLAS_PROOF_${Date.now()}_${process.pid}`;
  let touchedByokBackend = null;
  try {
    initStore();

    await setEnvVar(envKey, "proof-secret-value-1234567890");
    assert.equal(await hasEnvVar(envKey), true, "saved env key must be visible through hasEnvVar");
    const preview = await previewEnvVar(envKey);
    assert.ok(preview && preview.includes("•"), "env preview must be masked");
    assert.ok(!preview.includes("proof-secret-value"), "env preview must not leak the full value");
    await deleteEnvVar(envKey);
    assert.equal(await hasEnvVar(envKey), false, "deleted env key must not remain visible");

    for (const backend of safeBackends) {
      if (!(await hasApiKey(backend))) {
        touchedByokBackend = backend;
        break;
      }
    }

    let byokRoundtrip = { status: "skipped", reason: "all safe backends already have user keys" };
    if (touchedByokBackend) {
      await saveApiKey(touchedByokBackend, `proof-byok-${Date.now()}-${process.pid}`);
      assert.equal(await hasApiKey(touchedByokBackend), true, "saved BYOK key must be visible through hasApiKey");
      await deleteApiKey(touchedByokBackend);
      assert.equal(await hasApiKey(touchedByokBackend), false, "deleted BYOK key must not remain visible");
      byokRoundtrip = { status: "passed", backend: touchedByokBackend };
    }

    const runtimes = await detectRuntimes();
    const detectedKinds = [...new Set(runtimes.map((runtime) => runtime.kind))];
    const active = runtimes.find((runtime) => runtime.active) ?? null;

    let setActiveProof = null;
    if (runtimes.length > 0) {
      const candidate = runtimes[0];
      const updated = await setActiveRuntime({
        kind: candidate.kind,
        backend: candidate.backend,
        source: candidate.source,
        model: candidate.model ?? undefined,
        longContext: candidate.longContextEnabled ?? undefined,
      });
      setActiveProof = {
        requested: {
          kind: candidate.kind,
          backend: candidate.backend,
          source: candidate.source,
          model: candidate.model ?? null,
        },
        activeAfterSet:
          updated.find((runtime) => runtime.active)?.kind ??
          updated[0]?.kind ??
          null,
      };
      assert.ok(setActiveProof.activeAfterSet, "runtime:setActive should leave an active candidate when runtimes exist");
    }

    const liveInvocation = await runRealRuntimeSmoke(runtimes);

    const proof = {
      ok: true,
      recordedAt: new Date().toISOString(),
      storePath: process.env.AGENTLAS_STORE_PATH,
      userDataDir,
      keychain: {
        envRoundtrip: "passed",
        envPreviewMasked: true,
        byokRoundtrip,
      },
      runtime: {
        detectedCount: runtimes.length,
        detectedKinds,
        active: active
          ? {
              kind: active.kind,
              backend: active.backend,
              source: active.source,
              version: active.version,
              model: active.model ?? null,
            }
          : null,
        setActiveProof,
        liveInvocation,
      },
    };
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "proof.json"), JSON.stringify(proof, null, 2) + "\n", "utf8");
    if (liveInvocation.status === "failed") {
      throw new Error(`Runtime live invocation failed: ${liveInvocation.error ?? liveInvocation.responsePreview ?? "unknown"}`);
    }
    console.log(JSON.stringify(proof, null, 2));
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    try {
      await deleteEnvVar(envKey);
      if (touchedByokBackend) await deleteApiKey(touchedByokBackend);
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
