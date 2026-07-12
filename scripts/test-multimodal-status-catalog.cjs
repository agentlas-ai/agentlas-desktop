#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-multimodal-status-"));
const fakeGrok = path.join(root, "grok");
const authFile = path.join(root, "auth.json");
process.env.AGENTLAS_E2E = "1";
process.env.AGENTLAS_STORE_PATH = path.join(root, "agentlas.sqlite");
process.env.AGENTLAS_GROK_BIN = fakeGrok;
process.env.AGENTLAS_GROK_AUTH_FILE = authFile;
fs.writeFileSync(fakeGrok, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.writeFileSync(authFile, JSON.stringify({ qa: { auth_mode: "oidc", refresh_token: "qa-refresh" } }), { mode: 0o600 });

try {
  const store = require("../dist/electron/store/db.js");
  const { MULTIMODAL_PROVIDERS } = require("../dist/shared/multimodal.js");
  const { getMultimodalStatus } = require("../dist/electron/multimodal/settings.js");
  store.initStore();
  Promise.resolve(getMultimodalStatus()).then((rows) => {
    assert.equal(rows.length, MULTIMODAL_PROVIDERS.length, "status must cover every catalog provider");
    const byId = new Map(rows.map((row) => [row.provider.id, row]));
    assert.equal(byId.get("grok-cli-image")?.ready, true);
    assert.equal(byId.get("grok-cli-video")?.ready, true);
    for (const modality of ["image", "video", "audio"]) {
      assert.ok(
        rows.filter((row) => row.modality === modality && row.auto).length <= 1,
        `at most one auto-resolved provider for ${modality}`,
      );
    }
    fs.rmSync(root, { recursive: true, force: true });
    console.log("Multimodal status covers the full provider catalog with live Grok readiness");
    process.exit(0);
  }).catch((error) => {
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
} catch (error) {
  fs.rmSync(root, { recursive: true, force: true });
  throw error;
}
