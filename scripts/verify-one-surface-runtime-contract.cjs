const assert = require("node:assert/strict");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const { adaptLegacySurfaceToOneV1 } = require("../dist/shared/one-surface.js");

function manifest(type, data, layout = "report") {
  return {
    version: "0.1",
    kind: "surface",
    title: `${type} result`,
    domain: "one-contract-test",
    layout,
    data: { result: { type, ...data } },
    widgets: [{ type: "report", data: "result", title: `${type} details` }],
  };
}

async function main() {
  const verifierUrl = pathToFileURL(join(__dirname, "../../Agentlas_One/contracts/verify-contracts.mjs")).href;
  const { validateContractDocument } = await import(verifierUrl);
  const cases = [
    manifest("markdown", { value: "The durable run ended and a result is ready." }),
    manifest("metrics", { items: [{ label: "Candidates", value: 3 }] }, "dashboard"),
    manifest("table", { columns: ["product", "price"], rows: [{ product: "A", price: 42 }] }, "table"),
    manifest("timeline", { items: [{ title: "Research", at: "2026-07-18T00:00:00.000Z", status: "done" }] }, "timeline"),
    manifest("routes", { items: [
      { label: "Airport", latitude: 33.5104, longitude: 126.4914 },
      { label: "Beach", lat: "33.5434", lng: "126.6698" },
    ] }, "map-list"),
    manifest("pricing", {
      currency: "KRW",
      limit: 1200000,
      items: [
        { label: "Flight", amount: 420000, verificationStatus: "estimated" },
        { label: "Stay", amount: 300000, verificationStatus: "verified" },
      ],
    }, "report"),
    manifest("artifacts", { items: [{ name: "brief.pdf", type: "document", sizeBytes: 512 }] }),
    manifest("media", { rows: [
      { path: "/Users/private/generated-looking.png", mediaType: "image", label: "Unknown source" },
      { path: "/Users/private/explicit-generated.png", mediaType: "image", label: "Generated", provenance: "generated" },
    ] }, "gallery"),
    manifest("launch-checklist", { items: [{ label: "Review", status: "completed" }] }, "workflow"),
    manifest("json", { value: { unsupported: true } }),
    manifest("markdown", { value: "<script>location='https://example.com'</script> /Users/private/token" }),
  ];

  for (const [index, legacy] of cases.entries()) {
    const value = adaptLegacySurfaceToOneV1({
      manifest: legacy,
      surfaceId: `surface:test-${index + 1}`,
      taskId: "task:test-contract",
      syncedAt: "2026-07-18T00:00:00.000Z",
    });
    const report = validateContractDocument("one-surface-manifest.v1.schema.json", value);
    assert.equal(report.ok, true, `surface case ${index + 1}: ${JSON.stringify(report.issues)}`);
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /<script|https:\/\/example\.com|\/Users\/private|javascript:/i);
    assert.doesNotMatch(serialized, /link omitted|\]\(/i);
    assert.deepEqual(value.recomposition.desktop.blockOrder, value.recomposition.mobile.blockOrder);
  }

  const gallery = adaptLegacySurfaceToOneV1({
    manifest: cases[7],
    surfaceId: "surface:gallery-provenance",
    taskId: "task:test-gallery-provenance",
    syncedAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(gallery.blocks[0].type, "Gallery");
  assert.equal(gallery.blocks[0].items[0].provenance, "unknown_source");
  assert.equal(gallery.blocks[0].items[1].provenance, "generated");
  assert.doesNotMatch(JSON.stringify(gallery), /\/Users\/private/);

  const itinerary = adaptLegacySurfaceToOneV1({
    manifest: {
      version: "0.1",
      kind: "surface",
      title: "Jeju family trip",
      domain: "travel",
      layout: "map-list",
      data: {
        schedule: {
          type: "timeline",
          items: [
            { title: "Arrive", at: "2026-07-24T10:30:00+09:00", status: "upcoming" },
          ],
        },
        route: {
          type: "routes",
          items: [
            { label: "Airport", latitude: 33.5104, longitude: 126.4914 },
            { label: "Beach", latitude: 33.5434, longitude: 126.6698 },
          ],
        },
        costs: {
          type: "pricing",
          currency: "KRW",
          limit: 1200000,
          items: [
            { label: "Flight", amount: 420000, verificationStatus: "estimated" },
            { label: "Stay", amount: 300000, verificationStatus: "estimated" },
          ],
        },
      },
      widgets: [
        { type: "timeline", data: "schedule", title: "Schedule" },
        { type: "map", data: "route", title: "Route" },
        { type: "cost-summary", data: "costs", title: "Budget" },
      ],
    },
    surfaceId: "surface:itinerary-portable",
    taskId: "task:itinerary-portable",
    syncedAt: "2026-07-20T00:00:00.000Z",
  });
  assert.deepEqual(
    itinerary.blocks.map((block) => block.type),
    ["Timeline", "Map", "Budget"],
    "itinerary semantics must survive the legacy Surface boundary",
  );
  assert.equal(itinerary.blocks[1].locations[0].sequence, 1);
  assert.equal(itinerary.blocks[2].total, 720000);
  assert.equal(itinerary.blocks[2].limit, 1200000);

  const localizedItinerary = adaptLegacySurfaceToOneV1({
    manifest: {
      version: "0.1",
      kind: "surface",
      title: "아이 동반 제주 여행 일정",
      domain: "travel",
      layout: "map-list",
      data: {
        schedule: { type: "timeline", items: [{ title: "제주공항 도착", status: "upcoming" }] },
        costs: { type: "pricing", currency: "KRW", items: [{ label: "항공권", amount: 420000 }] },
        checklist: { type: "launch-checklist", items: [{ label: "아이 상비약", status: "pending" }] },
        routes: { type: "routes", items: [{ label: "제주공항", latitude: 33.5104, longitude: 126.4914 }] },
      },
      widgets: [
        { type: "timeline", data: "schedule", title: "Schedule" },
        { type: "cost-summary", data: "costs", title: "Costs" },
        { type: "checklist", data: "checklist", title: "Checklist" },
        { type: "map", data: "routes", title: "Routes" },
      ],
    },
    surfaceId: "surface:localized-itinerary",
    taskId: "task:localized-itinerary",
    syncedAt: "2026-07-20T00:00:00.000Z",
  });
  assert.deepEqual(
    localizedItinerary.blocks.map((block) => block.title),
    ["일정", "예상 비용", "준비 체크리스트", "이동 경로"],
    "generic system block names must follow the result language rather than leaking provider English",
  );

  const missingCoordinates = adaptLegacySurfaceToOneV1({
    manifest: manifest("routes", { items: [{ label: "Unknown stop" }] }, "map-list"),
    surfaceId: "surface:no-invented-map",
    taskId: "task:no-invented-map",
    syncedAt: "2026-07-20T00:00:00.000Z",
  });
  assert.equal(
    missingCoordinates.blocks.some((block) => block.type === "Map"),
    false,
    "One must not invent a map when coordinates are absent",
  );

  const secretId = `ghp_${"Z".repeat(32)}`;
  const hostileIdentifiers = adaptLegacySurfaceToOneV1({
    manifest: {
      version: "0.1",
      kind: "surface",
      title: "Path hardening",
      domain: "one-contract-test",
      layout: "table",
      data: {
        [secretId]: {
          type: "table",
          columns: ["value"],
          rows: [{ value: "/etc/passwd /root/.ssh/id_ed25519 \\\\server\\private\\secret" }],
        },
      },
      widgets: [{ type: "table", data: secretId, title: "Sensitive identifier" }],
      evidence: [{ id: secretId, kind: "source", source: "/opt/agentlas/private.json" }],
    },
    surfaceId: secretId,
    taskId: "task:test-sensitive-identifiers",
    syncedAt: "2026-07-18T00:00:00.000Z",
  });
  const hostileReport = validateContractDocument(
    "one-surface-manifest.v1.schema.json",
    hostileIdentifiers,
  );
  assert.equal(hostileReport.ok, true, JSON.stringify(hostileReport.issues));
  const hostileSerialized = JSON.stringify(hostileIdentifiers);
  assert.equal(hostileSerialized.includes(secretId), false);
  assert.doesNotMatch(hostileSerialized, /\/etc\/passwd|\/root\/\.ssh|\/opt\/agentlas|\\\\server\\private/i);

  const mixedPortableResult = adaptLegacySurfaceToOneV1({
    manifest: {
      version: "0.1",
      kind: "surface",
      title: "30만원 이하 제품 추천",
      domain: "one-contract-test",
      layout: "table",
      data: {
        summary: { type: "markdown", value: "30만원 안에서는 위닉스 타워 프라임이 가장 잘 맞습니다." },
        comparison: {
          type: "table",
          columns: ["제품", "가격"],
          rows: [
            { 제품: "위닉스 타워 프라임", 가격: "278,100원 ([다나와](https://example.com/price))" },
            { 제품: "LG 퓨리케어", 가격: "348,050원" },
            { 제품: "정보가 빈 추천", 가격: "—" },
          ],
        },
        providerMetadata: { type: "json", value: { internal: true } },
      },
      widgets: [
        { type: "report", data: "summary", title: "요약" },
        { type: "table", data: "comparison", title: "비교" },
        { type: "brief-panel", data: "providerMetadata", title: "Provider metadata" },
      ],
      evidence: [{ id: "source:1", kind: "claimed", label: "공식 가격" }],
    },
    surfaceId: "surface:mixed-portable",
    taskId: "task:mixed-portable",
    syncedAt: "2026-07-20T00:00:00.000Z",
  });
  assert.deepEqual(
    mixedPortableResult.blocks.map((block) => block.type),
    ["Narrative", "Table", "SourceList"],
    "one unsupported provider dataset must not erase portable explanation and table blocks",
  );
  assert.equal(mixedPortableResult.summary, "필요한 내용만 모았어요.");
  const mixedTable = mixedPortableResult.blocks.find((block) => block.type === "Table");
  assert.equal(mixedTable.rows.length, 2, "rows made mostly of placeholders must not reach One or Mobile");
  assert.equal(mixedTable.rows[0].cells[1].value, "278,100원 (다나와)");

  console.log(`Agentlas One runtime surface contract passed (${cases.length + 4} cases).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
