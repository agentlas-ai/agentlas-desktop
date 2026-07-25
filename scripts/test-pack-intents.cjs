#!/usr/bin/env node
// Contract for the merged pack-intent judgment (electron/pack-intents.ts):
// ONE judgeSubset decision covers creative-ad-pack + ecommerce-ops per request;
// the lexical prefilters are hints (never a gate — a miss can still seed), and
// today's prefilter verdicts remain only the labeled fallback.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.disableHardwareAcceleration();
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-pack-intents-"));
app.setPath("userData", tempDir);

(async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    const { resolveOnePackIntents } = require("../dist/electron/pack-intents.js");
    const { prepareCreativeAdPackManifest, shouldSeedCreativeAdPack } = require("../dist/electron/creative-pack/surface.js");
    const { prepareEcommerceOpsManifest, shouldSeedEcommerceOps } = require("../dist/electron/ecommerce-pack/surface.js");

    // (a) A judged verdict FIRES on a lexical MISS — the prefilter is no longer a gate.
    const arabicAd = "أريد إعلاناً قصيراً لمنتجي الجديد لنشره على وسائل التواصل";
    assert.equal(shouldSeedCreativeAdPack(arabicAd), false, "documented prefilter miss");
    const judgedSeed = await resolveOnePackIntents({
      prompt: arabicAd,
      judgeSubsetFn: async (spec) => {
        assert.equal(spec.kind, "one-pack-intent");
        assert.deepEqual([...spec.labels], ["creative-ad-pack", "ecommerce-ops"]);
        return { selected: ["creative-ad-pack"], confidence: 0.9, reason: "social ad request", source: "llm" };
      },
    });
    assert.deepEqual(judgedSeed.selected, ["creative-ad-pack"]);
    assert.equal(judgedSeed.source, "llm");
    const seededManifest = await prepareCreativeAdPackManifest({
      prompt: arabicAd,
      judgeSubsetFn: async () => ({ selected: ["creative-ad-pack"], confidence: 0.9, reason: "ad", source: "llm" }),
    });
    assert.ok(seededManifest, "a judged creative verdict must seed even when the wordlist missed");
    assert.equal(seededManifest.layout, "creative-studio");

    // (b) A judged EMPTY selection vetoes a coincidental prefilter hit for BOTH packs.
    const bait = "폰트를 small 하게 고치고 백업을 restore 해줘 (mall store orders 아님)";
    assert.equal(shouldSeedEcommerceOps(bait), true, "documented prefilter false positive");
    const judgeNone = async () => ({ selected: [], confidence: 0.85, reason: "not commerce or creative work", source: "llm" });
    assert.equal(await prepareEcommerceOpsManifest({ prompt: bait, judgeSubsetFn: judgeNone }), null,
      "a judged empty selection must suppress the ecommerce seed");
    assert.equal(await prepareCreativeAdPackManifest({ prompt: bait, judgeSubsetFn: judgeNone }), null);

    // (c) NO connected model: the resolver still REPORTS the labeled prefilter
    //     selection (source:"fallback"), but the pack CONSUMERS do NOT seed from
    //     it — a pack surface never appears on a keyword guess (undecided).
    const judgeDown = async () => ({ selected: [], confidence: 0, reason: "no connected model answered", source: "fallback" });
    const commercePrompt = "여성복 쇼핑몰 재고와 주문을 관리하고 싶어";
    const fallbackIntents = await resolveOnePackIntents({ prompt: commercePrompt, judgeSubsetFn: judgeDown });
    assert.equal(fallbackIntents.source, "fallback");
    assert.deepEqual(fallbackIntents.selected, ["ecommerce-ops"], "the resolver still reports the labeled prefilter selection");
    assert.equal(await prepareEcommerceOpsManifest({ prompt: commercePrompt, judgeSubsetFn: judgeDown }), null,
      "no connected model must NOT seed the ecommerce pack from the prefilter — undecided, not the keyword surface");
    assert.equal(await prepareCreativeAdPackManifest({ prompt: "read the report and summarize it", judgeSubsetFn: judgeDown }), null,
      "a prefilter miss with no model stays unseeded");

    // (d) Hermetic un-injected path (no runtime probes): deterministic fallback.
    const hermetic = await resolveOnePackIntents({ prompt: commercePrompt, timeoutMs: 2000 });
    assert.equal(hermetic.source, "fallback");
    assert.deepEqual(hermetic.selected, ["ecommerce-ops"]);

    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.quit();
    process.exit(exitCode);
  }
})();
