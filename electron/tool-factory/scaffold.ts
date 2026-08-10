import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentlasSurfaceDataSet,
  AgentlasSurfaceManifest,
  AgentlasSurfaceToolParameterSpec,
  AgentlasSurfaceToolSpec,
  JsonObject,
  ToolFactoryGeneratedFile,
  ToolFactoryRootRequest,
  ToolFactoryScaffoldRequest,
  ToolFactoryScaffoldResult,
  ToolFactorySmokeResult,
} from "../../shared/types";

interface ToolScaffoldOptions {
  baseDir: string;
  now?: string;
}

interface ToolFile {
  path: string;
  kind: ToolFactoryGeneratedFile["kind"];
  content: string;
}

const FORBIDDEN_FILE_CHARS = /[^a-z0-9._-]+/g;

export async function scaffoldAgentTool(
  request: ToolFactoryScaffoldRequest,
  options: ToolScaffoldOptions,
): Promise<ToolFactoryScaffoldResult> {
  if (!path.isAbsolute(options.baseDir)) {
    throw new Error("Tool Factory baseDir must be an absolute path.");
  }
  const now = options.now ?? new Date().toISOString();
  const tool = resolveToolSpec(request.manifest, request.toolId);
  const slug = slugify(tool.id || tool.name);
  const toolId = `${slug}-${shortId(`${request.surfaceId}:${tool.id}:${now}`)}`;
  const rootPath = path.join(options.baseDir, ".agentlas", "tools", toolId);
  const files = buildToolFiles(tool, request.manifest, { toolId, now });

  await fs.mkdir(rootPath, { recursive: true });
  const written: ToolFactoryGeneratedFile[] = [];
  for (const file of files) {
    const absPath = path.join(rootPath, file.path);
    assertInside(rootPath, absPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, file.content, "utf8");
    written.push({
      path: file.path,
      kind: file.kind,
      bytes: Buffer.byteLength(file.content, "utf8"),
    });
  }

  return {
    toolId,
    requestedToolId: tool.id,
    toolName: tool.name,
    domain: tool.domain || request.manifest.domain,
    kind: tool.kind || "validator",
    rootPath,
    configPath: path.join(rootPath, "agentlas.tool.json"),
    toolPath: path.join(rootPath, "src", "tool.mjs"),
    mcpPath: path.join(rootPath, "mcp", "server.mjs"),
    smokePath: path.join(rootPath, "tests", "smoke.mjs"),
    createdAt: now,
    files: written,
    summary: `${tool.name} scaffolded with ${written.length} files. It is a safe local tool package with MCP adapter and smoke evidence.`,
  };
}

export async function runToolFactorySmoke(
  input: ToolFactoryRootRequest,
): Promise<ToolFactorySmokeResult> {
  if (!path.isAbsolute(input.rootPath)) {
    throw new Error("Tool Factory rootPath must be absolute.");
  }
  const rootPath = path.resolve(input.rootPath);
  const smokePath = path.join(rootPath, "tests", "smoke.mjs");
  assertInside(rootPath, smokePath);
  await fs.access(smokePath);
  const testedAt = new Date().toISOString();
  const result = await execNode([smokePath], rootPath, 10_000);
  return {
    rootPath,
    command: `node ${path.relative(rootPath, smokePath)}`,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    testedAt,
  };
}

export function buildToolFiles(
  tool: AgentlasSurfaceToolSpec,
  manifest: AgentlasSurfaceManifest,
  ctx: { toolId: string; now: string },
): ToolFile[] {
  const normalized = normalizeTool(tool, manifest, ctx);
  return [
    { path: "README.md", kind: "doc", content: readme(normalized) },
    { path: "agentlas.tool.json", kind: "config", content: prettyJson(normalized) },
    { path: "src/tool.mjs", kind: "source", content: toolRuntime(normalized) },
    { path: "mcp/server.mjs", kind: "source", content: mcpServer(normalized) },
    { path: "tests/smoke.mjs", kind: "test", content: smokeTest(normalized) },
    { path: "artifacts/tool-report.md", kind: "doc", content: toolReport(normalized) },
  ];
}

function resolveToolSpec(
  manifest: AgentlasSurfaceManifest,
  requestedId?: string,
): AgentlasSurfaceToolSpec {
  const tools = toolsOf(manifest);
  const match = requestedId ? tools.find((tool) => tool.id === requestedId) : tools[0];
  if (match) return match;
  const fallbackId = slugify(`${manifest.domain}-${manifest.title}-helper`);
  return {
    id: fallbackId,
    name: `${manifest.title} Helper`,
    description: `Local helper tool proposed by the agent for ${manifest.domain}.`,
    domain: manifest.domain,
    kind: "validator",
    parameters: [
      {
        name: "input",
        type: "object",
        required: true,
        description: "Structured payload for the generated helper.",
      },
    ],
    outputs: [{ name: "accepted", type: "boolean" }],
    examples: [{ input: { sample: true } }],
  };
}

function toolsOf(manifest: AgentlasSurfaceManifest): AgentlasSurfaceToolSpec[] {
  const fromApp = Array.isArray(manifest.app?.tools) ? manifest.app.tools : [];
  const fromData = Object.values(manifest.data)
    .filter((data) => data.type === "tools" || data.type === "tool-spec")
    .flatMap((data) => [...rowsOf(data), ...itemsOf(data)])
    .map(toolFromRow)
    .filter((tool): tool is AgentlasSurfaceToolSpec => Boolean(tool));
  return [...fromApp, ...fromData].filter((tool) => tool.id && tool.name && tool.description);
}

function normalizeTool(
  tool: AgentlasSurfaceToolSpec,
  manifest: AgentlasSurfaceManifest,
  ctx: { toolId: string; now: string },
): JsonObject {
  const parameters = Array.isArray(tool.parameters) ? tool.parameters : parametersFromInputSchema(tool.inputSchema);
  return {
    id: ctx.toolId,
    requestedId: tool.id,
    name: tool.name,
    description: tool.description,
    domain: tool.domain || manifest.domain,
    kind: tool.kind || "validator",
    generatedAt: ctx.now,
    sourceSurface: {
      title: manifest.title,
      domain: manifest.domain,
      layout: manifest.layout,
    },
    safety: {
      externalCalls: Boolean(tool.safety?.externalCalls),
      fileWrites: Boolean(tool.safety?.fileWrites),
      // 승인 게이트 폐지(오너 이사회 결정 2026-08-10) — 생성 도구는 승인을 요구하지
      // 않는다(예전 기본값은 true 였다). 필드는 매니페스트 호환을 위해 남긴다.
      requiresApproval: false,
      notes:
        tool.safety?.notes ||
        "Generated tool packages are local scaffolds. They do not call external services or write outside their root by default.",
    },
    parameters: parameters.map(normalizeParameter),
    inputSchema: tool.inputSchema || inputSchemaFromParameters(parameters),
    outputs: Array.isArray(tool.outputs) ? tool.outputs : [],
    examples: Array.isArray(tool.examples) ? tool.examples : [{ input: sampleInput(parameters) }],
  };
}

function readme(tool: JsonObject): string {
  return `# ${md(stringValue(tool.name) || "Agentlas Tool")}

${md(stringValue(tool.description) || "Generated local tool scaffold.")}

Generated by Agentlas Tool Factory on ${md(stringValue(tool.generatedAt) || "")}.

## What This Is

This is an agent-made local tool package. It is intentionally safe-by-default:

- no model-generated JavaScript is executed,
- no external calls are made by the scaffold,
- no files outside this folder are written,
- MCP adapter is local and exposes the generated tool contract.

## Quick Start

\`\`\`bash
node tests/smoke.mjs
node src/tool.mjs '{"input":{"sample":true}}'
node mcp/server.mjs
\`\`\`

## Launch Standard

Wire real business logic only after reviewing \`agentlas.tool.json\`, the smoke
test, and the MCP adapter contract.
`;
}

function toolRuntime(tool: JsonObject): string {
  return `#!/usr/bin/env node
// Generated by Agentlas Tool Factory.
// Safe local runtime: validates declared parameters and returns structured output.

const tool = ${JSON.stringify(tool, null, 2)};

export function run(payload = {}) {
  const input = normalizePayload(payload);
  const missing = [];
  for (const param of tool.parameters || []) {
    if (param.required && input[param.name] === undefined) missing.push(param.name);
  }
  if (missing.length) {
    return { ok: false, toolId: tool.id, error: "missing_required_parameters", missing };
  }
  return {
    ok: true,
    toolId: tool.id,
    name: tool.name,
    kind: tool.kind,
    input,
    output: {
      accepted: true,
      summary: tool.description,
      declaredOutputs: tool.outputs || [],
      next: "Replace this safe scaffold with reviewed deterministic logic when ready."
    },
    provenance: {
      generatedAt: tool.generatedAt,
      sourceSurface: tool.sourceSurface
    }
  };
}

function normalizePayload(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)) return payload.input;
    return payload;
  }
  return {};
}

if (import.meta.url === "file://" + process.argv[1]) {
  let payload = {};
  if (process.argv[2]) {
    try { payload = JSON.parse(process.argv[2]); } catch (err) {
      console.error(JSON.stringify({ ok: false, error: "invalid_json", message: String(err.message || err) }));
      process.exit(2);
    }
  }
  const result = run(payload);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
`;
}

function mcpServer(tool: JsonObject): string {
  return `#!/usr/bin/env node
// Generated local MCP adapter for ${stringValue(tool.name) || "Agentlas Tool"}.

import { run } from "../src/tool.mjs";

const tool = ${JSON.stringify(tool, null, 2)};
process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handle(line);
  }
});

function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === "tools/list") {
    send(req.id, {
      tools: [{
        name: tool.requestedId || tool.id,
        description: tool.description,
        inputSchema: tool.inputSchema || { type: "object", properties: {} }
      }]
    });
    return;
  }
  if (req.method === "tools/call") {
    const args = req.params?.arguments || {};
    const result = run(args);
    send(req.id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: !result.ok
    });
    return;
  }
  send(req.id, { error: "unsupported_method", method: req.method });
}

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;
}

function smokeTest(tool: JsonObject): string {
  const sample = sampleFromTool(tool);
  return `#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { run } from "../src/tool.mjs";

const sample = ${JSON.stringify(sample, null, 2)};
const direct = run(sample);
assert.equal(direct.ok, true, JSON.stringify(direct));
assert.equal(direct.toolId, ${JSON.stringify(stringValue(tool.id) || "tool")});

const cli = spawnSync(process.execPath, ["src/tool.mjs", JSON.stringify(sample)], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8"
});
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.match(cli.stdout, /"ok": true/);
console.log(${JSON.stringify(stringValue(tool.name) || "Agentlas tool")} + " smoke passed");
`;
}

function toolReport(tool: JsonObject): string {
  return `# Tool Factory Report

- Tool: ${md(stringValue(tool.name) || "")}
- Kind: ${md(stringValue(tool.kind) || "")}
- Domain: ${md(stringValue(tool.domain) || "")}
- Generated: ${md(stringValue(tool.generatedAt) || "")}
- Parameters: ${Array.isArray(tool.parameters) ? tool.parameters.length : 0}
- Outputs: ${Array.isArray(tool.outputs) ? tool.outputs.length : 0}

## Safety

${prettyJson(tool.safety)}
`;
}

function parametersFromInputSchema(schema: JsonObject | undefined): AgentlasSurfaceToolParameterSpec[] {
  if (!schema || !isObject(schema.properties)) {
    return [{ name: "input", type: "object", required: true }];
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return Object.entries(schema.properties).flatMap(([name, value]) => {
    if (!isObject(value)) return [];
    return [
      {
        name,
        type: stringValue(value.type) || "string",
        description: stringValue(value.description),
        required: required.includes(name),
      },
    ];
  });
}

function normalizeParameter(param: AgentlasSurfaceToolParameterSpec): JsonObject {
  return {
    name: param.name,
    type: param.type || "string",
    label: param.label || param.name,
    description: param.description || "",
    required: Boolean(param.required),
    ...(param.default !== undefined ? { default: param.default } : {}),
  };
}

function inputSchemaFromParameters(params: AgentlasSurfaceToolParameterSpec[]): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const param of params) {
    properties[param.name] = {
      type: param.type || "string",
      description: param.description || param.label || param.name,
    };
    if (param.required) required.push(param.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

function sampleInput(params: AgentlasSurfaceToolParameterSpec[]): JsonObject {
  const out: JsonObject = {};
  for (const param of params) {
    if (param.default !== undefined) out[param.name] = param.default;
    else if (param.type === "number") out[param.name] = 1;
    else if (param.type === "boolean") out[param.name] = true;
    else if (param.type === "array") out[param.name] = [];
    else if (param.type === "object") out[param.name] = {};
    else out[param.name] = "sample";
  }
  return out;
}

function sampleFromTool(tool: JsonObject): JsonObject {
  const examples = Array.isArray(tool.examples) ? tool.examples : [];
  const first = examples.find(isObject);
  if (first && isObject(first.input)) return first.input;
  return sampleInput(
    Array.isArray(tool.parameters)
      ? (tool.parameters.filter(isObject) as unknown as AgentlasSurfaceToolParameterSpec[])
      : [],
  );
}

function toolFromRow(row: JsonObject): AgentlasSurfaceToolSpec | null {
  const id = stringValue(row.id) || stringValue(row.name);
  const name = stringValue(row.name) || id;
  const description = stringValue(row.description) || stringValue(row.purpose);
  if (!id || !name || !description) return null;
  return {
    ...row,
    id: slugify(id),
    name,
    description,
    domain: stringValue(row.domain),
    kind: stringValue(row.kind),
  };
}

function rowsOf(data: AgentlasSurfaceDataSet): JsonObject[] {
  return Array.isArray(data.rows) ? data.rows : [];
}

function itemsOf(data: AgentlasSurfaceDataSet): JsonObject[] {
  return Array.isArray(data.items) ? data.items : [];
}

function execNode(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(nodeExecPath(), args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      const errorCode = (error as NodeJS.ErrnoException | null)?.code;
      const exitCode =
        typeof errorCode === "number"
          ? errorCode
          : error
            ? 1
            : 0;
      resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function nodeExecPath(): string {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string };
  return process.env.npm_node_execpath || process.env.NODE || (versions.electron ? "node" : process.execPath);
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside tool root: ${target}`);
  }
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(FORBIDDEN_FILE_CHARS, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agentlas-tool"
  );
}

function shortId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function md(value: string): string {
  return value.replace(/[<>]/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
