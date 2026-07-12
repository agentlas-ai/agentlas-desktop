#!/usr/bin/env node
const assert = require("node:assert/strict");
const { resolveOberonAnimateProvider, resolveOberonRenderProvider } = require("../dist/shared/oberon-provider-routing.js");
const { getMultimodalProvider, providerLadder } = require("../dist/shared/multimodal.js");

assert.deepEqual(resolveOberonAnimateProvider("grok-cli-video", { grok: false, veo: true }), { provider: "grok", via: "explicit" });
assert.deepEqual(resolveOberonAnimateProvider("runway-video", { runway: false, grok: true }), { provider: "runway", via: "explicit" });
assert.deepEqual(resolveOberonAnimateProvider("auto", { veo: true, grok: true }), { provider: "veo", via: "auto" });
assert.deepEqual(resolveOberonAnimateProvider("auto", { grok: true }), { provider: "veo", via: "auto" });
assert.deepEqual(resolveOberonRenderProvider("grok-cli-video"), { ok: true, provider: "grok-cli-video", model: "grok-imagine-video" });
assert.deepEqual(resolveOberonRenderProvider("google-veo"), { ok: true, provider: "google-enterprise-veo", model: "veo-3.1-lite-generate-001" });
assert.deepEqual(resolveOberonRenderProvider("runway-video"), { ok: false, selected: "runway-video" });
assert.equal(getMultimodalProvider("grok-cli-image")?.modality, "image");
assert.equal(getMultimodalProvider("grok-cli-video")?.modality, "video");
assert.equal(
  providerLadder("image").some((provider) => provider.id.startsWith("grok-cli")),
  false,
  "Grok remains an explicit choice until entitlement can be probed without media generation",
);
assert.equal(
  providerLadder("video").some((provider) => provider.id.startsWith("grok-cli")),
  false,
  "Grok remains an explicit choice until entitlement can be probed without media generation",
);

console.log("Oberon provider routing and explicit-only Grok catalog contract passed");
