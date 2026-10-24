import { childrenNamed, parseXml, type XmlElement } from "./mini-xml";
import type { Capability, CapabilityParameter } from "./types";

// D-Bus introspection (Linux session bus): the XML an app returns for org.freedesktop.DBus.Introspectable.Introspect.
// Methods become operations; readable properties become reads, writable ones also become writes. The three standard plumbing
// interfaces say nothing about the app and are left out.

const PLUMBING = new Set(["org.freedesktop.DBus.Introspectable", "org.freedesktop.DBus.Properties", "org.freedesktop.DBus.Peer", "org.freedesktop.DBus.Monitoring"]);

const BASIC: Record<string, string> = {
  s: "string", o: "path", g: "string",
  y: "integer", n: "integer", q: "integer", i: "integer", u: "integer", x: "integer", t: "integer", h: "integer",
  d: "number", b: "boolean", v: "any",
};

// One complete D-Bus type, returning the reader's text and the position after it.
function readType(signature: string, at: number): { type: string; next: number } {
  const ch = signature[at];
  if (ch === undefined) return { type: "any", next: at };
  if (ch === "a") {
    if (signature[at + 1] === "{") {
      let depth = 0;
      let end = at + 1;
      for (; end < signature.length; end += 1) {
        if (signature[end] === "{") depth += 1;
        if (signature[end] === "}") depth -= 1;
        if (depth === 0) break;
      }
      return { type: "object", next: end + 1 };
    }
    const inner = readType(signature, at + 1);
    return { type: inner.type === "integer" && signature[at + 1] === "y" ? "bytes" : `list<${inner.type}>`, next: inner.next };
  }
  if (ch === "(") {
    let depth = 0;
    let end = at;
    for (; end < signature.length; end += 1) {
      if (signature[end] === "(") depth += 1;
      if (signature[end] === ")") depth -= 1;
      if (depth === 0) break;
    }
    return { type: "list<any>", next: end + 1 };
  }
  return { type: BASIC[ch] ?? "any", next: at + 1 };
}

export function dbusTypeName(signature: string | undefined): string {
  if (!signature) return "any";
  const parts: string[] = [];
  let at = 0;
  while (at < signature.length) {
    const read = readType(signature, at);
    parts.push(read.type);
    at = read.next;
  }
  return parts.length === 0 ? "any" : parts.length === 1 ? parts[0] : parts.join(",");
}

export interface IntrospectionNode {
  path: string;
  children: string[];
  capabilities: Capability[];
}

export function parseDbusIntrospection(xml: string, options: { appKey: string; busName: string; objectPath: string }): IntrospectionNode {
  const root: XmlElement = parseXml(xml);
  const capabilities: Capability[] = [];
  const children = childrenNamed(root, "node").map((node) => node.attrs.name ?? "").filter(Boolean);
  for (const iface of childrenNamed(root, "interface")) {
    const interfaceName = iface.attrs.name;
    if (!interfaceName || PLUMBING.has(interfaceName)) continue;
    const where = `${options.busName}${options.objectPath}`;
    for (const method of childrenNamed(iface, "method")) {
      if (!method.attrs.name) continue;
      const parameters: CapabilityParameter[] = childrenNamed(method, "arg")
        .filter((arg) => (arg.attrs.direction ?? "in") === "in")
        .map((arg, index) => ({ name: arg.attrs.name || `arg${index}`, type: dbusTypeName(arg.attrs.type), required: true }));
      const out = childrenNamed(method, "arg").filter((arg) => arg.attrs.direction === "out").map((arg) => dbusTypeName(arg.attrs.type));
      capabilities.push({
        id: `${options.appKey}#published:dbus/${where}/${interfaceName}.${method.attrs.name}`,
        tier: "published",
        source: { kind: "dbus", ref: `${where}:${interfaceName}.${method.attrs.name}` },
        name: `${interfaceName}.${method.attrs.name}`,
        suite: interfaceName,
        kind: "command",
        granularity: "operation",
        parameters,
        ...(out.length > 0 ? { result: out.join(",") } : {}),
        effect: { class: "unknown", basis: "unverified" },
      });
    }
    for (const property of childrenNamed(iface, "property")) {
      if (!property.attrs.name) continue;
      const access = property.attrs.access ?? "read";
      const type = dbusTypeName(property.attrs.type);
      const readable = access === "read" || access === "readwrite";
      const writable = access === "write" || access === "readwrite";
      if (readable) {
        capabilities.push({
          id: `${options.appKey}#published:dbus/${where}/${interfaceName}.${property.attrs.name}/get`,
          tier: "published",
          source: { kind: "dbus", ref: `${where}:${interfaceName}.${property.attrs.name}/get` },
          name: `${interfaceName}.${property.attrs.name}`,
          suite: interfaceName,
          kind: "query",
          granularity: "property",
          parameters: [],
          result: type,
          effect: { class: "read", basis: "declared" },
        });
      }
      if (writable) {
        capabilities.push({
          id: `${options.appKey}#published:dbus/${where}/${interfaceName}.${property.attrs.name}/set`,
          tier: "published",
          source: { kind: "dbus", ref: `${where}:${interfaceName}.${property.attrs.name}/set` },
          name: `${interfaceName}.${property.attrs.name}=`,
          suite: interfaceName,
          kind: "command",
          granularity: "property",
          parameters: [{ name: "value", type, required: true }],
          effect: { class: "write", basis: "declared" },
        });
      }
    }
  }
  return { path: options.objectPath, children, capabilities };
}
