#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const appSource = fs.readFileSync(path.join(root, "node_modules/agentlas-science/ui/app.js"), "utf8");
const adapterStart = appSource.indexOf("// TABLE_PAYLOAD_ADAPTER_START");
const adapterEnd = appSource.indexOf("// TABLE_PAYLOAD_ADAPTER_END");
assert.ok(adapterStart >= 0 && adapterEnd > adapterStart, "table payload adapter markers must exist");
const adapterSource = appSource.slice(adapterStart, adapterEnd);
const actualTablePayload = new Function(`${adapterSource}\nreturn actualTablePayload;`)();

const domainPayload = {
  schema: "agentlas.science-table/v1",
  title: "Available avian reference inputs; crocodilian assembly retrieval remains unresolved",
  columns: [
    { id: "species", label: "Extant species", type: "string", unit: null },
    { id: "taxonomyId", label: "NCBI taxonomy ID", type: "integer", unit: null },
    { id: "assembly", label: "Assembly", type: "string", unit: null },
    { id: "accession", label: "Assembly accession", type: "string", unit: null },
    { id: "release", label: "Ensembl release", type: "integer", unit: null },
    { id: "bases", label: "Assembly bases", type: "integer", unit: "bp" },
    { id: "regions", label: "Top-level regions", type: "integer", unit: "count" },
    { id: "asset", label: "Pinned toplevel FASTA asset", type: "string", unit: null },
    { id: "providerChecksum", label: "Provider checksum (BSD sum)", type: "string", unit: null },
  ],
  rows: [
    ["Gallus gallus", 9031, "bGalGal1.mat.broiler.GRCg7b", "GCA_016699485.1", 116, 1053332251, 214, "Gallus_gallus.bGalGal1.mat.broiler.GRCg7b.dna.toplevel.fa.gz", "53028"],
    ["Taeniopygia guttata", 59729, "bTaeGut1_v1.p", "GCA_003957565.2", 116, 1057995280, 134, "Taeniopygia_guttata.bTaeGut1_v1.p.dna.toplevel.fa.gz", "21250"],
  ],
  notes: ["FASTA contents were not downloaded."],
};
const contentSha256 = "6c717675b50eda423732326e0aab385c6a641260a6217559af376411161ad0ac";
const domain = actualTablePayload({ payload: domainPayload, contentSha256 });
assert.equal(domain.cause, null);
assert.equal(domain.sourceShape, "domain-publication-table");
assert.equal(domain.contentSha256, contentSha256);
assert.equal(domain.payload.receipts, null, "the adapter must not invent a table receipt");
assert.deepEqual(domain.payload.profile, { rowCount: 2, columnCount: 9, nullCount: 0, formulaLikeCellCount: 0 });
assert.equal(domain.payload.columns[0].name, "species");
assert.equal(domain.payload.columns[0].label, "Extant species");
assert.equal(domain.payload.rows[0].species, "Gallus gallus");
assert.equal(domain.payload.rows[0].taxonomyId, 9031);
assert.equal(domain.payload.rows[1].accession, "GCA_003957565.2");

const previewStart = appSource.indexOf("function manuscriptTablePreviewMarkup");
const previewEnd = appSource.indexOf("\n  function paleontologyArtifactPayload", previewStart);
assert.ok(previewStart >= 0 && previewEnd > previewStart, "manuscript table preview must be extractable");
const escapeHtml = (value) => String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
const manuscriptTablePreviewMarkup = new Function("actualTablePayload", "escapeHtml", `${appSource.slice(previewStart, previewEnd)}\nreturn manuscriptTablePreviewMarkup;`)(actualTablePayload, escapeHtml);
const preview = manuscriptTablePreviewMarkup(domainPayload);
assert.match(preview, /Extant species/u);
assert.match(preview, /Gallus gallus/u);
assert.match(preview, /GCA_016699485\.1/u);

const datasetPayload = {
  schema: "agentlas.science-table/v1",
  columns: [{ name: "year", logicalType: "string", nullable: false }, { name: "value", logicalType: "number", nullable: true }],
  rows: [{ year: "2026", value: 2.5 }],
  profile: { rowCount: 1, columnCount: 2, nullCount: 0, formulaLikeCellCount: 0 },
  receipts: { tableSha256: "a".repeat(64) },
};
const dataset = actualTablePayload({ payload: datasetPayload, contentSha256: "b".repeat(64) });
assert.equal(dataset.cause, null);
assert.equal(dataset.sourceShape, "dataset-table");
assert.equal(dataset.payload, datasetPayload, "the canonical dataset dialect must remain unchanged");

const badRow = structuredClone(domainPayload);
badRow.rows[0] = ["Gallus gallus", 9031];
assert.equal(actualTablePayload(badRow).cause, "science-data-table-domain-row-invalid");
const badCell = structuredClone(domainPayload);
badCell.rows[0][1] = "9031";
assert.equal(actualTablePayload(badCell).cause, "science-data-table-domain-cell-invalid");
const malformedCanonicalColumn = {
  schema: "agentlas.science-table/v1",
  columns: [null],
  rows: [],
  profile: { rowCount: 0, columnCount: 1, nullCount: 0, formulaLikeCellCount: 0 },
};
assert.equal(actualTablePayload(malformedCanonicalColumn).cause, "science-data-table-dataset-shape-invalid");
assert.match(appSource, /manuscriptTablePreviewMarkup[\s\S]*?const actual = actualTablePayload\(payload\)/u);
assert.match(appSource, /surface\.dataset\.tablePayloadShape = actual\.sourceShape/u);

const serverSource = fs.readFileSync(path.join(root, "node_modules/agentlas-science/src/tool-control-server.ts"), "utf8");
const shapeStart = serverSource.indexOf("export function dataTableShape");
const shapeEnd = serverSource.indexOf("\n}\n\n\n/**", shapeStart) + 2;
assert.ok(shapeStart >= 0 && shapeEnd > shapeStart, "dataTableShape source must be extractable");
const transpiled = ts.transpileModule(serverSource.slice(shapeStart, shapeEnd).replace(/^export /u, ""), {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataTableShape = new Function(`${transpiled}\nreturn dataTableShape;`)();
const domainShape = dataTableShape(domainPayload);
assert.deepEqual(domainShape, {
  columns: [
    { name: "species", logicalType: "string", nullable: false },
    { name: "taxonomyId", logicalType: "integer", nullable: false },
    { name: "assembly", logicalType: "string", nullable: false },
    { name: "accession", logicalType: "string", nullable: false },
    { name: "release", logicalType: "integer", nullable: false },
    { name: "bases", logicalType: "integer", nullable: false },
    { name: "regions", logicalType: "integer", nullable: false },
    { name: "asset", logicalType: "string", nullable: false },
    { name: "providerChecksum", logicalType: "string", nullable: false },
  ],
  rowCount: 2,
});
assert.doesNotMatch(JSON.stringify(domainShape), /Gallus|GCA_/u, "shape projection must not expose cell values");
assert.deepEqual(dataTableShape(datasetPayload), {
  columns: [{ name: "year", logicalType: "string", nullable: false }, { name: "value", logicalType: "number", nullable: true }],
  rowCount: 1,
});
assert.equal(dataTableShape(badRow), null);
assert.equal(dataTableShape(badCell), null);
assert.equal(dataTableShape(malformedCanonicalColumn), null);

process.stdout.write("table-payload-dialects-contract: ok domain=2x9 dataset=1x2 preview-values=3 typed-negatives=3\n");
