#!/usr/bin/env node
/**
 * Public-catalog rows must never be upgraded by the client.
 *
 * The Hub outage of 2026-07-11..26 stayed invisible for 15 days because this
 * mapper hardcoded kind:"cloud-callable", callable:true, routingReady:true and
 * trustGrade:"A" for every row, so an uncallable package
 * (availabilityReason:cloud_runtime_invalid) still rendered "Hub callable ·
 * Security scan A". Delivery state, security grade, and invocation counts are
 * the server's to state; absent means unknown, not favourable.
 */
const assert = require("node:assert/strict");
const { marketPublicAgentToListing } = require("../dist/electron/marketplace/mcp-source.js");

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${label}\n  ${err.message}`);
  }
}

// The exact production shape that used to be mislabelled.
const brokenTeam = {
  slug: "defect-driven-slide-studio",
  title: "Defect-Driven Slide Studio",
  titleKo: "결함 기반 슬라이드 스튜디오",
  kind: "team",
  deliveryKind: "install-only",
  callable: false,
  callTool: null,
  availabilityReason: "cloud_runtime_invalid",
  perCallCredits: 10,
};

check("uncallable server row stays uncallable", () => {
  const listing = marketPublicAgentToListing(brokenTeam);
  assert.equal(listing.callable, false, "callable must mirror the server");
  assert.equal(listing.kind, "install-only", "kind must mirror deliveryKind");
  assert.equal(listing.availabilityReason, "cloud_runtime_invalid", "repair reason must survive to the UI");
});

check("missing trustGrade is unknown, never A", () => {
  const listing = marketPublicAgentToListing(brokenTeam);
  assert.equal(listing.trustGrade, "unknown", `expected unknown, got ${listing.trustGrade}`);
});

check("server trustGrade is preserved", () => {
  const listing = marketPublicAgentToListing({ ...brokenTeam, trustGrade: "B" });
  assert.equal(listing.trustGrade, "B");
});

check("callable row is reported callable", () => {
  const listing = marketPublicAgentToListing({
    ...brokenTeam,
    deliveryKind: "cloud-callable",
    callable: true,
    callTool: "agentlas.get_runtime_bundle",
    availabilityReason: undefined,
    trustGrade: "A",
    verifiedInvocations: 23,
  });
  assert.equal(listing.callable, true);
  assert.equal(listing.kind, "cloud-callable");
  assert.equal(listing.verifiedInvocations, 23);
});

check("callable:true without cloud-callable delivery is refused", () => {
  const listing = marketPublicAgentToListing({ ...brokenTeam, callable: true });
  assert.equal(listing.callable, false, "delivery kind gates callability");
});

check("borrow volume is never reported as verified invocations", () => {
  const listing = marketPublicAgentToListing({ ...brokenTeam, totalBorrows: 41 });
  assert.equal(listing.totalBorrows, 41);
  assert.equal(
    listing.verifiedInvocations,
    undefined,
    "absent invocation ledger must stay absent, not inherit totalBorrows",
  );
});

check("absent team agentCount stays unknown (credit quotes depend on it)", () => {
  const listing = marketPublicAgentToListing(brokenTeam);
  assert.equal(listing.agentCount, undefined, `expected undefined, got ${listing.agentCount}`);
  const sized = marketPublicAgentToListing({ ...brokenTeam, agentCount: 7 });
  assert.equal(sized.agentCount, 7);
});

check("routingReady is only claimed when the server states it", () => {
  const listing = marketPublicAgentToListing(brokenTeam);
  assert.equal(listing.routingReady, undefined);
  assert.equal(marketPublicAgentToListing({ ...brokenTeam, routingReady: false }).routingReady, false);
  assert.equal(marketPublicAgentToListing({ ...brokenTeam, routingReady: true }).routingReady, true);
});

if (failures > 0) {
  console.error(`${failures} assertion group(s) failed`);
  process.exit(1);
}
console.log("hub listing honesty: all assertions passed");
