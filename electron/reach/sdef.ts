import { createHash } from "node:crypto";
import { childrenNamed, parseXml, type XmlElement } from "./mini-xml";
import type { Capability, CapabilityParameter, HarvestOutcome, ReachHost } from "./types";

// macOS: the scripting dictionary (sdef) is the list of things an app says it can do. `sdef <App.app>` prints it without
// launching the app. Commands become operations; every class property becomes a read (and, when writable, a write) on that class.

// Measured 2026-10-23 on 139 apps: every dictionary that exists prints in about a second (Excel, 838 KB, included). The one
// that does not (GarageBand: scripting enabled, no sdef file) never returns, so a long wait only buys a slower failure.
const SDEF_TIMEOUT_MS = 10_000;
const SDEF_MAX_BYTES = 24 * 1024 * 1024;

// Measured on 139 apps: TextEdit, Preview, OneDrive and System Information expose exactly these three suites and nothing of
// their own (13 commands, 84 properties each). They describe Cocoa, not the app.
const GENERIC_SUITES: ReadonlySet<string> = new Set(["Standard Suite", "Text Suite", "Type Definitions"]);

const PRIMITIVE_TYPES: Record<string, string> = {
  text: "string",
  string: "string",
  "rich text": "string",
  integer: "integer",
  number: "number",
  real: "number",
  boolean: "boolean",
  date: "date",
  file: "path",
  "alias": "path",
  "POSIX file": "path",
  "location specifier": "specifier:location",
  specifier: "specifier",
  "type": "type",
  any: "any",
  "missing value": "null",
  "double integer": "integer",
  point: "list<integer>",
  rectangle: "list<integer>",
  RGB: "list<integer>",
  "RGB color": "list<integer>",
};

function mapType(raw: string, enums: ReadonlySet<string>, classes: ReadonlySet<string>): string {
  const name = raw.trim();
  if (!name) return "any";
  if (PRIMITIVE_TYPES[name]) return PRIMITIVE_TYPES[name];
  if (enums.has(name)) return `enum:${name}`;
  if (classes.has(name)) return `specifier:${name}`;
  return name;
}

function enumNameOf(element: XmlElement, enums: ReadonlySet<string>): string | undefined {
  const names = element.attrs.type ? [element.attrs.type] : childrenNamed(element, "type").map((item) => item.attrs.type ?? "");
  return names.find((name) => enums.has(name));
}

function typeOf(element: XmlElement, enums: ReadonlySet<string>, classes: ReadonlySet<string>): string {
  const direct = element.attrs.type;
  const nested = childrenNamed(element, "type");
  const names = direct ? [direct] : nested.map((item) => item.attrs.type ?? "").filter(Boolean);
  const mapped = names.map((name) => mapType(name, enums, classes));
  const listed = element.attrs.list === "yes" || nested.some((item) => item.attrs.list === "yes");
  const base = mapped.length === 0 ? "any" : mapped.length === 1 ? mapped[0] : mapped.join("|");
  return listed ? `list<${base}>` : base;
}

function visible(element: XmlElement): boolean {
  return element.attrs.hidden !== "yes";
}

function describe(element: XmlElement): string | undefined {
  const value = element.attrs.description;
  return value && value.trim() ? value.trim() : undefined;
}

// A property belongs to an object: the caller says which one with a specifier. The application itself needs none.
function targetParameter(className: string): CapabilityParameter[] {
  return [{ name: "target", type: `specifier:${className}`, required: className !== "application" }];
}

export interface ParsedDictionary {
  capabilities: Capability[];
  suites: number;
  classes: number;
  unresolvedIncludes: number;
}

export function parseScriptingDictionary(xml: string, appKey: string): ParsedDictionary {
  const root = parseXml(xml);
  const suites = root.name === "dictionary" ? childrenNamed(root, "suite") : [];
  let unresolvedIncludes = root.children.filter((child) => child.name.endsWith("include")).length;
  const enums = new Set<string>();
  const enumMembers = new Map<string, string[]>();
  const classes = new Set<string>();
  for (const suite of suites) {
    for (const child of suite.children) {
      if (child.name === "enumeration" && child.attrs.name) {
        enums.add(child.attrs.name);
        enumMembers.set(child.attrs.name, childrenNamed(child, "enumerator").map((member) => member.attrs.name ?? "").filter(Boolean));
      }
      if ((child.name === "class" || child.name === "record-type" || child.name === "value-type") && child.attrs.name) classes.add(child.attrs.name);
    }
  }
  const capabilities: Capability[] = [];
  let classCount = 0;
  const seen = new Set<string>();
  const push = (capability: Capability): void => {
    if (seen.has(capability.id)) return;
    seen.add(capability.id);
    capabilities.push(capability.suite && GENERIC_SUITES.has(capability.suite) ? { ...capability, generic: true } : capability);
  };

  for (const suite of suites) {
    const suiteName = suite.attrs.name ?? "Suite";
    unresolvedIncludes += suite.children.filter((child) => child.name.endsWith("include")).length;
    for (const child of suite.children) {
      if (!visible(child)) continue;
      if ((child.name === "command" || child.name === "event") && child.attrs.name) {
        const parameters: CapabilityParameter[] = [];
        const direct = childrenNamed(child, "direct-parameter")[0];
        if (direct) {
          parameters.push({
            name: "direct",
            type: typeOf(direct, enums, classes),
            required: direct.attrs.optional !== "yes",
            ...(describe(direct) ? { description: describe(direct) } : {}),
          });
        }
        for (const parameter of childrenNamed(child, "parameter")) {
          if (!parameter.attrs.name || !visible(parameter)) continue;
          const enumName = enumNameOf(parameter, enums);
          const members = enumName ? enumMembers.get(enumName) : undefined;
          parameters.push({
            name: parameter.attrs.name,
            type: typeOf(parameter, enums, classes),
            required: parameter.attrs.optional !== "yes",
            ...(describe(parameter) ? { description: describe(parameter) } : {}),
            ...(members && members.length > 0 ? { enumValues: members } : {}),
          });
        }
        const result = childrenNamed(child, "result")[0];
        push({
          id: `${appKey}#published:sdef/${suiteName}/command/${child.attrs.name}`,
          tier: "published",
          source: { kind: "sdef", ref: `${suiteName}/command/${child.attrs.name}` },
          name: child.attrs.name,
          suite: suiteName,
          ...(describe(child) ? { description: describe(child) } : {}),
          kind: "command",
          granularity: "operation",
          parameters,
          ...(result ? { result: typeOf(result, enums, classes) } : {}),
          // A dictionary names a command; it never says whether the command destroys anything.
          effect: { class: "unknown", basis: "unverified" },
        });
      } else if ((child.name === "class" || child.name === "class-extension") && (child.attrs.name || child.attrs.extends)) {
        classCount += 1;
        const className = child.attrs.name ?? child.attrs.extends ?? "class";
        for (const property of childrenNamed(child, "property")) {
          if (!property.attrs.name || !visible(property)) continue;
          const type = typeOf(property, enums, classes);
          const writable = property.attrs.access !== "r";
          const base = `${suiteName}/${className}/${property.attrs.name}`;
          push({
            id: `${appKey}#published:sdef/${base}/get`,
            tier: "published",
            source: { kind: "sdef", ref: `${base}/get` },
            name: `${className}.${property.attrs.name}`,
            suite: suiteName,
            ...(describe(property) ? { description: describe(property) } : {}),
            kind: "query",
            granularity: "property",
            parameters: targetParameter(className),
            result: type,
            target: className,
            effect: { class: "read", basis: "declared" },
          });
          if (writable) {
            const propertyEnum = enumNameOf(property, enums);
            const propertyMembers = propertyEnum ? enumMembers.get(propertyEnum) : undefined;
            push({
              id: `${appKey}#published:sdef/${base}/set`,
              tier: "published",
              source: { kind: "sdef", ref: `${base}/set` },
              name: `${className}.${property.attrs.name}=`,
              suite: suiteName,
              ...(describe(property) ? { description: describe(property) } : {}),
              kind: "command",
              granularity: "property",
              parameters: [...targetParameter(className), { name: "value", type, required: true, ...(propertyMembers && propertyMembers.length > 0 ? { enumValues: propertyMembers } : {}) }],
              target: className,
              effect: { class: "write", basis: "declared" },
            });
          }
        }
      }
    }
  }
  return { capabilities, suites: suites.length, classes: classCount, unresolvedIncludes };
}

// Runs `/usr/bin/sdef`, which LAUNCHES an app that has no static dictionary file: call it only for an app whose bundle holds one (macos.ts).
export async function harvestScriptingDictionary(host: ReachHost, appPath: string, appKey: string): Promise<HarvestOutcome> {
  const started = Date.now();
  const result = await host.exec("/usr/bin/sdef", [appPath], { timeoutMs: SDEF_TIMEOUT_MS, maxBytes: SDEF_MAX_BYTES });
  const ms = Date.now() - started;
  const base = { source: "sdef", tier: "published" as const, ms };
  if (result.timedOut) return { record: { ...base, status: "failed", count: 0, detail: "sdef timed out" }, capabilities: [] };
  if (result.truncated) return { record: { ...base, status: "failed", count: 0, detail: "sdef output exceeded the size ceiling" }, capabilities: [] };
  if (result.code !== 0 || !result.stdout.trim()) {
    return { record: { ...base, status: "unavailable", count: 0, detail: "the app publishes no scripting dictionary" }, capabilities: [] };
  }
  const contentSha256 = createHash("sha256").update(result.stdout).digest("hex");
  try {
    const parsed = parseScriptingDictionary(result.stdout, appKey);
    const operations = parsed.capabilities.filter((item) => item.granularity === "operation").length;
    const detail = `${parsed.suites} suites, ${parsed.classes} classes, ${operations} commands` +
      (parsed.unresolvedIncludes > 0 ? `, ${parsed.unresolvedIncludes} unresolved includes` : "");
    return {
      record: { ...base, status: parsed.capabilities.length > 0 ? "ok" : "empty", count: parsed.capabilities.length, detail, contentSha256 },
      capabilities: parsed.capabilities,
    };
  } catch (error) {
    return {
      record: { ...base, status: "failed", count: 0, detail: `dictionary could not be read: ${error instanceof Error ? error.name : "error"}`, contentSha256 },
      capabilities: [],
    };
  }
}
