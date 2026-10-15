import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeStatus, InstalledMcpServer } from "../../shared/types";
import { RUNTIME_MCP_SUPPORT } from "../../shared/runtime-mcp";
import type { McpConfigResult } from "../mcp-tools/mcp-config";
import { extendPreparedMcpConfig, preparedMcpBindings } from "../mcp-tools/prepared-transport";

export const BUILDER_CONTRACT_KEY = "agentlas_builder_contracts";
export const BUILDER_CONTRACT_TOOL = "read_builder_contract";
export interface BuilderContractSection { id: string; label: string; source: string; text: string }
export interface BuilderContractCatalogRow { id: string; label: string; source: string; characters: number; sha256: string }
export interface BuilderContractReader {
  catalog: BuilderContractCatalogRow[];
  attach(base?: McpConfigResult | null): McpConfigResult;
  cleanup(): void;
}

/** Exact model capability, never a provider/model-name guess. Native MCP deliveries already have a tool surface. */
export function builderContractReaderSupported(runtime: RuntimeStatus): boolean {
  // selection.ts -> runManagedLocalModelSlotted -> daemon-client.ts exports stock MCP admission.
  // That receiver reconstructs installed registry servers and cannot admit this ephemeral snapshot reader.
  // This is a host transport capability boundary even for a model with verified tool support.
  if (runtime.kind === "agentlas-local") return false;
  const delivery = RUNTIME_MCP_SUPPORT[runtime.kind]?.delivery;
  if (!delivery) return false;
  if (delivery !== "in-process-loop") return true;
  return Boolean(runtime.model && runtime.allocationModelProfiles?.[runtime.model]?.supportsTools === true);
}

/** Immutable snapshot reader. Only supplied section ids can be read; no file, secret, network or write API. */
const READER_SOURCE = String.raw`"use strict";
const fs=require("node:fs"),crypto=require("node:crypto");
const bytes=fs.readFileSync(process.argv[1]);
if(crypto.createHash("sha256").update(bytes).digest("hex")!==process.argv[2])process.exit(78);
const snapshot=JSON.parse(bytes.toString("utf8"));
const sections=new Map(snapshot.sections.map(s=>[s.id,s]));
const tool={name:"read_builder_contract",description:"Read the exact pinned Engine build contract. Follow its full canonical instructions; nextOffset pages the remainder. Read-only, no arbitrary path or network.",annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:{type:"object",additionalProperties:false,properties:{section_id:{type:"string",enum:[...sections.keys()]},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:16384}},required:["section_id"]}};
function handle(r){
 if(r.method==="initialize")return {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"agentlas-builder-contracts",version:"1.0.0"}};
 if(r.method==="notifications/initialized")return;
 if(r.method==="ping")return {};
 if(r.method==="tools/list")return {tools:[tool]};
 if(r.method!=="tools/call")throw Error("Method not found");
 const p=r.params||{},a=p.arguments||{},s=sections.get(a.section_id),offset=a.offset===undefined?0:a.offset,limit=a.limit===undefined?16384:a.limit;
 if(p.name!==tool.name||!s||Object.keys(a).some(k=>!["section_id","offset","limit"].includes(k))||!Number.isSafeInteger(offset)||offset<0||offset>s.text.length||!Number.isSafeInteger(limit)||limit<1||limit>16384)return {isError:true,content:[{type:"text",text:"builder_contract_request_refused"}]};
 const end=Math.min(s.text.length,offset+limit);
 return {content:[{type:"text",text:JSON.stringify({schema:"agentlas.builder-contract-page.v1",section_id:s.id,source:s.source,sha256:s.sha256,totalCharacters:s.text.length,offset,nextOffset:end<s.text.length?end:null,text:s.text.slice(offset,end)})}]};
}
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk;if(Buffer.byteLength(input)>65536)process.exit(78);let n;while((n=input.indexOf("\n"))>=0){const line=input.slice(0,n);input=input.slice(n+1);let r;try{r=JSON.parse(line)}catch{continue}Promise.resolve().then(()=>handle(r)).then(result=>{if(r.id!==undefined&&result!==undefined)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\n")}).catch(e=>{if(r.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,error:{code:-32601,message:String(e.message)}})+"\n")});}});
`;
const SOURCE_SHA256 = createHash("sha256").update(READER_SOURCE).digest("hex");
const BOOTSTRAP = `const c=require("node:crypto"),v=require("node:vm"),s=Buffer.from(process.argv[3],"base64").toString("utf8");if(c.createHash("sha256").update(s).digest("hex")!==${JSON.stringify(SOURCE_SHA256)})process.exit(78);v.runInThisContext(s,{filename:"agentlas-builder-contracts.cjs"});`;

const tomlString = (value: string) => JSON.stringify(value).replace(/\u0000/g, "");
/** Snapshot and config live in private storage outside the generated package and are removed only by this owner. */
export function createBuilderContractReader(sections: readonly BuilderContractSection[], isCurrent: () => boolean): BuilderContractReader {
  if (!sections.length || new Set(sections.map(s => s.id)).size !== sections.length
    || sections.some(s => !s.id || !s.text || !s.source)) throw new Error("builder_contract_snapshot_invalid");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-builder-contract-"));
  fs.chmodSync(root, 0o700);
  const rows = sections.map(s => ({ ...s, sha256: createHash("sha256").update(s.text).digest("hex") }));
  const snapshot = Buffer.from(JSON.stringify({ schema: "agentlas.builder-contracts.v1", sections: rows }), "utf8");
  const snapshotPath = path.join(root, "contracts.json");
  fs.writeFileSync(snapshotPath, snapshot, { mode: 0o600, flag: "wx" });
  const digest = createHash("sha256").update(snapshot).digest("hex");
  const args = ["-e", BOOTSTRAP, snapshotPath, digest, Buffer.from(READER_SOURCE).toString("base64")];
  const spec = { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
  // Source and data paths, not 90K text in argv: all OS launches remain below Windows' command-line limit.
  if (JSON.stringify(spec).length > 24_000) { fs.rmSync(root, { recursive: true }); throw new Error("builder_contract_launch_too_large"); }
  const server: InstalledMcpServer = { id: BUILDER_CONTRACT_KEY, catalogId: BUILDER_CONTRACT_KEY,
    name: "Builder contracts", nameEn: "Builder contracts", transport: "stdio", command: spec.command,
    args, url: null, envKeys: [], enabled: true, configurationValid: true, installedAt: new Date().toISOString() };
  const cleanupViews: Array<() => boolean> = [];
  const cache = new Map<McpConfigResult | null, McpConfigResult>();
  let live = true;
  const current = () => live && isCurrent() && fs.existsSync(snapshotPath)
    && createHash("sha256").update(fs.readFileSync(snapshotPath)).digest("hex") === digest;
  return {
    catalog: rows.map(({ id, label, source, sha256, text }) => ({ id, label, source, sha256, characters: text.length })),
    attach(base = null): McpConfigResult {
      if (!current()) throw new Error("builder_contract_snapshot_stale");
      const cached = cache.get(base); if (cached) { preparedMcpBindings(cached.configPath); return cached; }
      const raw = base ? JSON.parse(fs.readFileSync(base.configPath, "utf8")) as { mcpServers?: Record<string, unknown> } : {};
      if (base) preparedMcpBindings(base.configPath); // opaque source admission, never JSON authority
      if (raw.mcpServers && Object.hasOwn(raw.mcpServers, BUILDER_CONTRACT_KEY)) throw new Error("builder_contract_key_collision");
      const configPath = path.join(root, `mcp-${cache.size}.json`);
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { ...(raw.mcpServers ?? {}), [BUILDER_CONTRACT_KEY]: spec } }), { mode: 0o600, flag: "wx" });
      const runtimeEnv = { ...(base?.runtimeEnv ?? {}) };
      cleanupViews.push(extendPreparedMcpConfig({ path: configPath, sourcePath: base?.configPath,
        servers: [{ configKey: BUILDER_CONTRACT_KEY, server, transport: spec }], runtimeEnv, isCurrent: current }));
      const codex = ["-c", `mcp_servers.${BUILDER_CONTRACT_KEY}.command=${tomlString(spec.command)}`,
        "-c", `mcp_servers.${BUILDER_CONTRACT_KEY}.args=[${args.map(tomlString).join(",")}]`,
        "-c", `mcp_servers.${BUILDER_CONTRACT_KEY}.env={ELECTRON_RUN_AS_NODE="1"}`];
      const result: McpConfigResult = { ...(base ?? {}), configPath,
        allowedTools: [...(base?.allowedTools ?? []), `mcp__${BUILDER_CONTRACT_KEY}__${BUILDER_CONTRACT_TOOL}`],
        codexConfigArgs: [...(base?.codexConfigArgs ?? []), ...codex], runtimeEnv,
        includedServerIds: [...(base?.includedServerIds ?? []), BUILDER_CONTRACT_KEY],
        includedServers: [...(base?.includedServers ?? []), { serverId: BUILDER_CONTRACT_KEY, catalogId: BUILDER_CONTRACT_KEY, configKey: BUILDER_CONTRACT_KEY }],
        // Existing selected MCP cleanup is owned by the original attachment, never by this temporary view.
        cleanup: undefined,
      };
      cache.set(base, result); return result;
    },
    cleanup() { live = false; for (const release of cleanupViews) release(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
