const assert = require("node:assert/strict");
const { app } = require("electron");

async function main() {
  await app.whenReady();
  const { normalizeRecommendation } = require("../dist/electron/hephaestus/recommendation.js");

  const localTeam = normalizeRecommendation({
    action: "route",
    selected: { id: "paid/release-team", type: "team", name: "Release Team" },
  }, "ship");
  assert.deepEqual(localTeam.agents[0].target, {
    source: "local",
    entityKind: "team",
    firmId: "paid/release-team",
  });

  const cloudTeam = normalizeRecommendation({
    action: "hub_candidates",
    hub: { scope: "cloud", results: [{ slug: "release-team", entityKind: "team", name: "Release Team" }] },
  }, "ship");
  assert.deepEqual(cloudTeam.agents[0].target, {
    source: "cloud",
    entityKind: "team",
    slug: "release-team",
  });

  const sameSlugExactKinds = normalizeRecommendation({
    action: "hub_candidates",
    hub: {
      scope: "hub",
      results: [
        { slug: "review", entityKind: "agent", name: "Review Agent" },
        { slug: "review", entityKind: "team", name: "Review Team" },
      ],
    },
  }, "review");
  assert.deepEqual(sameSlugExactKinds.agents.map((agent) => agent.target.entityKind), ["agent", "team"]);

  const ambiguousOrderedSlug = normalizeRecommendation({
    action: "hub_candidates",
    hub: {
      scope: "hub",
      results: [
        { slug: "review", entityKind: "agent" },
        { slug: "review", entityKind: "team" },
      ],
    },
    execution: { recommended_agents: [{ agent: "review" }] },
  }, "review");
  assert.equal(ambiguousOrderedSlug.mode, "none");

  const unprovenKind = normalizeRecommendation({
    action: "hub_candidates",
    hub: { scope: "hub", results: [{ slug: "unknown", kind: "cloud-callable" }] },
  }, "unknown");
  assert.equal(unprovenKind.mode, "none");

  console.log("hephaestus recommendation exact-target contract ok");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
