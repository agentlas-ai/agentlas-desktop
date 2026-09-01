import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]);
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};

type SearchRecord = {
  canonicalId: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  containerTitle: string | null;
  citationCount: number | null;
  landingUrl: string;
  sourceId: string | null;
  sourceVersionId: string | null;
  providerIds: Record<string, string | undefined>;
  referencedOpenAlexIds?: string[];
  relatedOpenAlexIds?: string[];
};

type Input = {
  schema: "agentlas.science-academic-to-citation-network-input/v1";
  title: string;
  searchRunId: string;
  searchOutputSha256: string;
  query: string;
  records: SearchRecord[];
};

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(`invalid-${field}`);
  return value.trim();
}

function main(): void {
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd());
  const inputPath = path.resolve(String(inputArg ?? ""));
  const outputPath = path.resolve(String(outputArg ?? ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const inputStat = fs.lstatSync(inputPath);
  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size < 2 || inputStat.size > 8 * 1024 * 1024) fail("science-tool-input-invalid");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as Input;
  if (!input || input.schema !== "agentlas.science-academic-to-citation-network-input/v1") fail("science-tool-input-schema-invalid");
  const title = text(input.title, 240, "title");
  const query = text(input.query, 1_000, "query");
  if (!/^[a-f0-9-]{36}$/i.test(input.searchRunId) || !/^[a-f0-9]{64}$/.test(input.searchOutputSha256)) fail("science-tool-search-lineage-invalid");
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > 200) fail("science-tool-records-invalid");

  const nodes = input.records.map((record, index) => {
    const id = text(record.sourceId ?? record.canonicalId, 500, `node-${index}-id`);
    const openAlexId = typeof record.providerIds?.openalex === "string" && /^https:\/\/openalex\.org\/W\d+$/.test(record.providerIds.openalex)
      ? record.providerIds.openalex
      : null;
    return {
      id,
      canonicalId: text(record.canonicalId, 500, `node-${index}-canonical-id`),
      sourceId: record.sourceId,
      sourceVersionId: record.sourceVersionId,
      openAlexId,
      title: text(record.title, 1_000, `node-${index}-title`),
      authors: Array.isArray(record.authors) ? record.authors.slice(0, 50).map((author, authorIndex) => text(author, 500, `node-${index}-author-${authorIndex}`)) : [],
      publicationYear: Number.isSafeInteger(record.publicationYear) ? record.publicationYear : null,
      containerTitle: typeof record.containerTitle === "string" ? record.containerTitle.slice(0, 500) : null,
      citationCount: Number.isFinite(record.citationCount) ? Math.max(0, Number(record.citationCount)) : null,
      landingUrl: text(record.landingUrl, 4_000, `node-${index}-landing-url`),
      isSeed: index < 5,
    };
  });
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) fail("science-tool-node-id-duplicate");
  const openAlexToNode = new Map(nodes.flatMap((node) => node.openAlexId ? [[node.openAlexId, node.id] as const] : []));
  const edgeKeys = new Set<string>();
  const edges: Array<{ id: string; source: string; target: string; relation: "cites" | "related" }> = [];
  input.records.forEach((record, index) => {
    const source = nodes[index].id;
    for (const referenced of record.referencedOpenAlexIds ?? []) {
      const target = openAlexToNode.get(referenced);
      if (!target || target === source) continue;
      const key = `cites:${source}:${target}`;
      if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ id: key, source, target, relation: "cites" }); }
    }
    for (const related of record.relatedOpenAlexIds ?? []) {
      const target = openAlexToNode.get(related);
      if (!target || target === source) continue;
      const ordered = [source, target].sort();
      const key = `related:${ordered[0]}:${ordered[1]}`;
      if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ id: key, source: ordered[0], target: ordered[1], relation: "related" }); }
    }
  });
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "literature.citation-network",
      title,
      rendererId: "agentlas.cytoscape",
      rendererVersion: "3.34.1",
      payload: {
        network: { nodes, edges },
        view: { layout: "cose", relations: ["cites", "related"] },
        provenance: { academicSearchRunId: input.searchRunId, academicSearchOutputSha256: input.searchOutputSha256, query },
      },
      semantic: {
        title,
        summary: `Interactive citation network built deterministically from ${nodes.length} exact academic-search records. Directed edges are OpenAlex referenced-work links; related-work links remain separately typed.`,
        entities: nodes.slice(0, 100).map((node) => ({ id: node.id, label: node.title, type: "publication" })),
        observations: [
          { label: "Publications", value: nodes.length, unit: null },
          { label: "Citation links", value: edges.filter((edge) => edge.relation === "cites").length, unit: null },
          { label: "Related-work links", value: edges.filter((edge) => edge.relation === "related").length, unit: null },
        ],
        warnings: edges.length ? [] : ["No OpenAlex links connected the selected result set; isolated records are preserved rather than fabricating edges."],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  if (bytes.length > 4 * 1024 * 1024) fail("science-tool-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

main();
