import type { Automation, WorkflowGraph, WorkflowNode } from "../../shared/types";
import type { GraphToolchainBinding } from "../../shared/graph-tool-binding";
import type { ToolchainAsset, ToolchainJsonSchema } from "../../shared/toolchain-asset";
import { graphExecutionDigest } from "../../shared/graph-execution-digest";
import { resolveNodeEffect, requiredExecutionPermission } from "../../shared/graph-node-protocol";
import { graphInputRequirement } from "../../shared/graph-trigger-input";
import { getAutomation } from "../store/automations";
import { getToolchainAsset, toolchainSchemaProblems } from "../toolchains/assets";

const wholeBinding = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/;
const placeholders = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function types(schema: ToolchainJsonSchema | undefined): string[] {
  if (!schema) return [];
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((value): value is string => typeof value === "string");
  for (const key of ["anyOf", "oneOf"]) if (Array.isArray(schema[key])) return [...new Set((schema[key] as ToolchainJsonSchema[]).flatMap(types))];
  return [];
}
function compatible(a: string, b: string): boolean { return a === b || [a, b].every(type => type === "integer" || type === "number"); }
export interface ToolchainInspectionDependencies {
  loadAsset?: (id: string) => ToolchainAsset | null;
  loadAutomation?: (id: string) => Automation | null;
  initialInputSchema?: ToolchainJsonSchema;
  implementationProblems?: (graph: WorkflowGraph) => string[];
}

/** Live, read-only admission. Dynamic values are never invented to satisfy a schema:
 * known producer contracts are checked statically; the calls service validates actual values. */
export function inspectGraphToolchainCalls(graph: WorkflowGraph | null | undefined,
  dependencies: ToolchainInspectionDependencies = {}): GraphToolchainBinding[] {
  if (!graph) return [];
  const loadAsset = dependencies.loadAsset ?? getToolchainAsset;
  const loadAutomation = dependencies.loadAutomation ?? getAutomation;
  let inspected = 0;
  const inspect = (current: WorkflowGraph, inputSchema: ToolchainJsonSchema | undefined,
    chain: string[], depth: number, prefix = ""): GraphToolchainBinding[] => {
    const rows: GraphToolchainBinding[] = [];
    const initial = new Map<string, ToolchainJsonSchema | undefined>();
    if (object(inputSchema?.properties)) for (const [name, schema] of Object.entries(inputSchema.properties)) initial.set(name, object(schema) ? schema : undefined);
    const requirement = graphInputRequirement(current);
    if (requirement?.required) initial.set(requirement.varName, initial.get(requirement.varName));
    const ancestors = (node: WorkflowNode): WorkflowNode[] => {
      const seen = new Set<string>(); const todo = [node.id];
      while (todo.length) {
        const target = todo.shift();
        for (const edge of current.edges) if (edge.target === target && !edge.maxIterations && !seen.has(edge.source)) { seen.add(edge.source); todo.push(edge.source); }
      }
      return current.nodes.filter(candidate => seen.has(candidate.id) && candidate.id !== node.id);
    };
    for (const node of current.nodes) {
      if (node.type !== "toolchain_call") continue;
      const call = object(node.config.toolchainCall) ? node.config.toolchainCall : {};
      const id = typeof call.toolchainId === "string" ? call.toolchainId : "";
      const version = typeof call.version === "number" ? call.version : null;
      const problems: string[] = [];
      const row: GraphToolchainBinding = { nodeId: `${prefix}${node.id}`, nodeLabel: node.label || node.id,
        toolchainId: id, version, ready: false, problems, dynamicInputs: false };
      rows.push(row);
      if (++inspected > 256) { problems.push("toolchain_inspection_limit"); continue; }
      try {
        if (!id || !Number.isSafeInteger(version) || version! < 1) { problems.push("toolchain_pin_required"); continue; }
        const asset = loadAsset(id), release = asset?.versions.find(item => item.version === version);
        if (!asset || !release) { problems.push("toolchain_version_not_found"); continue; }
        row.name = asset.name;
        if (asset.status === "withdrawn") problems.push("toolchain_withdrawn");
        else if (asset.status !== "callable" || release.validation.state !== "passed") problems.push("toolchain_version_not_callable");
        const marker = `toolchain:${id}@${version}`;
        if (chain.includes(marker) || depth >= 8) { problems.push("toolchain_call_cycle_or_depth"); continue; }
        const implementation = loadAutomation(release.implementation.automationId);
        const frozen = release.implementation.snapshot;
        if (!implementation?.graph || !frozen.graph || graphExecutionDigest(implementation, implementation.graph) !== graphExecutionDigest(frozen, frozen.graph)) problems.push("toolchain_implementation_changed");
        if (!frozen.graph) continue;
        problems.push(...(dependencies.implementationProblems?.(frozen.graph) ?? []));
        if (resolveNodeEffect(node) !== "mutation" && requiredExecutionPermission(frozen.graph) === "write") problems.push("toolchain_effect_declaration_mismatch");
        const output = release.implementation.outputBinding;
        if (!output || !frozen.graph.nodes.some(candidate => candidate.id === output.nodeId) || !["json", "text"].includes(output.format)) problems.push("toolchain_output_binding_invalid");
        const produced = new Map(initial);
        for (const producer of ancestors(node)) {
          const name = typeof producer.config.produces === "string" ? producer.config.produces : producer.type === "transform" && typeof producer.config.to === "string" ? producer.config.to : null;
          if (!name) continue;
          let schema: ToolchainJsonSchema | undefined = producer.type === "trigger" ? initial.get(name) : undefined;
          const upstream = object(producer.config.toolchainCall) ? producer.config.toolchainCall : null;
          if (producer.type === "toolchain_call" && upstream && typeof upstream.toolchainId === "string") {
            schema = loadAsset(upstream.toolchainId)?.versions.find(item => item.version === upstream.version)?.contract.outputSchema;
          }
          produced.set(name, schema);
        }
        const args = call.args;
        if (!object(args)) { problems.push("toolchain_arguments_object_required"); continue; }
        let json: string;
        try { json = JSON.stringify(args); } catch { problems.push("toolchain_arguments_invalid"); continue; }
        if (Buffer.byteLength(json) > 64 * 1024) { problems.push("toolchain_arguments_limit"); continue; }
        let argumentEntries = 0;
        const checkJson = (value: unknown, level: number): void => {
          if (++argumentEntries > 4096 || level > 16) { problems.push("toolchain_arguments_limit"); return; }
          if (value === null || typeof value === "string" || typeof value === "boolean") return;
          if (typeof value === "number" && Number.isFinite(value)) return;
          if (Array.isArray(value)) { value.forEach(item => checkJson(item, level + 1)); return; }
          if (object(value)) {
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
              problems.push("toolchain_arguments_invalid"); return;
            }
            for (const [key, item] of Object.entries(value)) {
            if (reserved.has(key)) problems.push("toolchain_argument_key_reserved");
            checkJson(item, level + 1);
          } return; }
          problems.push("toolchain_arguments_invalid");
        };
        checkJson(args, 0);
        row.dynamicInputs = /\{\{|\}\}/.test(json);
        if (!row.dynamicInputs) problems.push(...toolchainSchemaProblems(release.contract.inputSchema, args).map(problem => `toolchain_input_invalid:${problem}`));
        const visit = (value: unknown, expected: ToolchainJsonSchema | undefined, path: string, level: number) => {
          if (level > 16) { problems.push("toolchain_arguments_limit"); return; }
          if (typeof value === "string") {
            const exact = value.match(wholeBinding);
            const names = Array.from(value.matchAll(placeholders), match => match[1]);
            for (const name of names) {
              if (reserved.has(name) || !produced.has(name)) { problems.push(`toolchain_input_binding_missing:${name}`); continue; }
              const actual = types(produced.get(name)), wanted = types(expected);
              if (exact && actual.length && wanted.length && !actual.some(a => wanted.some(b => compatible(a, b)))) problems.push(`toolchain_input_binding_type:${path}:${name}`);
              if (!exact && actual.length && actual.every(type => type === "object" || type === "array")) problems.push(`toolchain_embedded_binding_not_scalar:${name}`);
            }
            if (names.length) {
              const remainder = value.replace(placeholders, "");
              if (remainder.includes("{{") || remainder.includes("}}")) problems.push(`toolchain_placeholder_invalid:${path}`);
              if (!exact && types(expected).length && !types(expected).includes("string")) problems.push(`toolchain_input_binding_type:${path}:string`);
              return;
            }
            if (value.includes("{{") || value.includes("}}")) problems.push(`toolchain_placeholder_invalid:${path}`);
          }
          const dynamic = /\{\{|\}\}/.test(JSON.stringify(value));
          if (!dynamic && expected) {
            try { problems.push(...toolchainSchemaProblems({ ...expected,
              ...(release.contract.inputSchema.$defs ? { $defs: release.contract.inputSchema.$defs } : {}),
              ...(release.contract.inputSchema.definitions ? { definitions: release.contract.inputSchema.definitions } : {}) }, value).map(problem => `toolchain_input_invalid:${path}${problem}`)); }
            catch { /* References spanning sibling properties are validated on the complete runtime value. */ }
            return;
          }
          if (object(value)) {
            if (types(expected).length && !types(expected).includes("object")) problems.push(`toolchain_input_binding_type:${path}:object`);
            for (const name of Array.isArray(expected?.required) ? expected.required : []) if (typeof name === "string" && !Object.hasOwn(value, name)) problems.push(`toolchain_input_required:${path}/${name}`);
            const properties = object(expected?.properties) ? expected.properties : {};
            for (const [key, item] of Object.entries(value)) {
              if (reserved.has(key)) { problems.push("toolchain_argument_key_reserved"); continue; }
              if (!Object.hasOwn(properties, key) && expected?.additionalProperties === false) problems.push(`toolchain_input_additional_property:${path}/${key}`);
              visit(item, object(properties[key]) ? properties[key] : object(expected?.additionalProperties) ? expected.additionalProperties : undefined, `${path}/${key}`, level + 1);
            }
          } else if (Array.isArray(value)) {
            if (types(expected).length && !types(expected).includes("array")) problems.push(`toolchain_input_binding_type:${path}:array`);
            value.forEach((item, index) => visit(item, object(expected?.items) ? expected.items : undefined, `${path}/${index}`, level + 1));
          }
        };
        if (row.dynamicInputs) visit(args, release.contract.inputSchema, "", 0);
        const children = inspect(frozen.graph, release.contract.inputSchema, [...chain, marker], depth + 1, `${row.nodeId}/`);
        rows.push(...children);
        if (children.some(child => !child.ready)) problems.push("toolchain_dependency_unavailable");
        row.ready = problems.length === 0;
      } catch (error) { problems.push(error instanceof Error ? error.message : "toolchain_inspection_unavailable"); }
    }
    return rows;
  };
  return inspect(graph, dependencies.initialInputSchema, [], 0);
}
