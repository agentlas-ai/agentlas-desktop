import type { Capability, CapabilityParameter, ExecFn } from "./types";

// Calls a published capability of a macOS app by building the AppleScript for it. This is the one place where values from a caller
// become script text, so nothing is spliced as-is: every value is rendered by its declared type through a fixed set of literal forms, a
// string can only ever become a quoted AppleScript string, a class or keyword must be one the app's own dictionary lists, and anything
// that does not fit is refused before osascript is started. osascript itself is started with an argument vector (no shell).

export type SpecifierSegment =
  | { class: string; index: number }
  | { class: string; name: string }
  | { class: string; id: string | number };

export interface AppleScriptRequest {
  bundleId: string;
  capability: Capability;
  // Parameter name -> value. A `specifier` value is an array of segments, innermost first ("cell B3" of "table 1" of "sheet 1").
  parameters: Record<string, unknown>;
  // Classes the dictionary defines, from the app's published capabilities: a specifier segment must name one of them.
  knownClasses: ReadonlySet<string>;
}

export class AppleScriptRefusal extends Error {
  constructor(public readonly code: "bad_bundle_id" | "bad_value" | "unknown_class" | "unknown_enum" | "missing_parameter" | "unsupported_capability" | "bad_keyword", message: string) {
    super(message);
    this.name = "AppleScriptRefusal";
  }
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.\-_]{0,160}$/;
// An AppleScript terminology word: letters, digits, spaces, hyphens, underscores. The dictionary's own words only.
const KEYWORD = /^[A-Za-z][A-Za-z0-9 _\-]{0,79}$/;

export function quoteString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new AppleScriptRefusal("bad_value", "a control character cannot be put in a script string");
  if (value.length > 8000) throw new AppleScriptRefusal("bad_value", "the string is too long");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function keyword(word: string): string {
  if (!KEYWORD.test(word)) throw new AppleScriptRefusal("bad_keyword", `not a dictionary keyword: ${word.slice(0, 40)}`);
  return word;
}

function number(value: unknown, integer: boolean): string {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AppleScriptRefusal("bad_value", "a number was expected");
  if (integer && !Number.isInteger(value)) throw new AppleScriptRefusal("bad_value", "an integer was expected");
  return String(value);
}

export function renderSpecifier(value: unknown, knownClasses: ReadonlySet<string>): string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new AppleScriptRefusal("bad_value", "a specifier is 1 to 8 segments");
  const parts = value.map((raw) => {
    const segment = raw as Record<string, unknown>;
    const cls = typeof segment?.class === "string" ? segment.class : "";
    if (cls !== "application" && !knownClasses.has(cls)) throw new AppleScriptRefusal("unknown_class", `the dictionary has no class "${cls.slice(0, 40)}"`);
    keyword(cls);
    if (cls === "application" && value.length === 1) return "application";
    if (typeof segment.index === "number") return `${cls} ${number(segment.index, true)}`;
    if (typeof segment.name === "string") return `${cls} ${quoteString(segment.name)}`;
    if (typeof segment.id === "number") return `${cls} id ${number(segment.id, true)}`;
    if (typeof segment.id === "string") return `${cls} id ${quoteString(segment.id)}`;
    throw new AppleScriptRefusal("bad_value", "a specifier segment needs an index, a name or an id");
  });
  // innermost first: "cell B3" of "table 1" of "sheet 1"
  return parts.join(" of ");
}

export function renderValue(parameter: CapabilityParameter, value: unknown, knownClasses: ReadonlySet<string>): string {
  const type = parameter.type;
  if (type.startsWith("list<") && type.endsWith(">")) {
    if (!Array.isArray(value) || value.length > 200) throw new AppleScriptRefusal("bad_value", "a list was expected");
    const inner: CapabilityParameter = { ...parameter, type: type.slice(5, -1) };
    return `{${value.map((item) => renderValue(inner, item, knownClasses)).join(", ")}}`;
  }
  if (type === "string") { if (typeof value !== "string") throw new AppleScriptRefusal("bad_value", "a string was expected"); return quoteString(value); }
  if (type === "integer") return number(value, true);
  if (type === "number") return number(value, false);
  if (type === "boolean") { if (typeof value !== "boolean") throw new AppleScriptRefusal("bad_value", "a boolean was expected"); return value ? "true" : "false"; }
  if (type === "path") { if (typeof value !== "string" || !value.startsWith("/")) throw new AppleScriptRefusal("bad_value", "an absolute path was expected"); return `POSIX file ${quoteString(value)}`; }
  if (type === "date") throw new AppleScriptRefusal("unsupported_capability", "dates are not supported yet");
  if (type.startsWith("enum:")) {
    const members = parameter.enumValues ?? [];
    if (typeof value !== "string" || !members.includes(value)) throw new AppleScriptRefusal("unknown_enum", `not one of: ${members.slice(0, 12).join(", ")}`);
    return keyword(value);
  }
  if (type === "specifier" || type.startsWith("specifier:")) return renderSpecifier(value, knownClasses);
  throw new AppleScriptRefusal("unsupported_capability", `the type ${type.slice(0, 40)} cannot be rendered yet`);
}

export function buildAppleScript(request: AppleScriptRequest): string {
  const { bundleId, capability, parameters, knownClasses } = request;
  if (!BUNDLE_ID.test(bundleId)) throw new AppleScriptRefusal("bad_bundle_id", "the bundle id is not valid");
  if (capability.source.kind !== "sdef") throw new AppleScriptRefusal("unsupported_capability", "only dictionary capabilities run through AppleScript");
  const known = new Set(Object.keys(parameters));
  for (const key of known) if (!capability.parameters.some((parameter) => parameter.name === key)) throw new AppleScriptRefusal("bad_value", `unknown parameter ${key.slice(0, 40)}`);
  for (const parameter of capability.parameters) if (parameter.required && !(parameter.name in parameters)) throw new AppleScriptRefusal("missing_parameter", `missing ${parameter.name}`);

  let body: string;
  if (capability.granularity === "property") {
    const target = capability.target ?? "application";
    const property = capability.name.split(".")[1]?.replace(/=$/, "") ?? "";
    keyword(target); keyword(property);
    const owner = parameters.target === undefined ? "" : ` of ${renderSpecifier(parameters.target, knownClasses)}`;
    if (capability.kind === "query") body = `get ${property}${owner}`;
    else {
      const valueParameter = capability.parameters.find((parameter) => parameter.name === "value");
      if (!valueParameter) throw new AppleScriptRefusal("unsupported_capability", "a setter needs a value parameter");
      body = `set ${property}${owner} to ${renderValue(valueParameter, parameters.value, knownClasses)}`;
    }
  } else {
    const parts = [keyword(capability.name)];
    for (const parameter of capability.parameters) {
      if (!(parameter.name in parameters)) continue;
      const rendered = renderValue(parameter, parameters[parameter.name], knownClasses);
      parts.push(parameter.name === "direct" ? rendered : `${keyword(parameter.name)} ${rendered}`);
    }
    body = parts.join(" ");
  }
  return `tell application id ${quoteString(bundleId)}\n  ${body}\nend tell`;
}

export interface AppleScriptResult { ok: boolean; value?: string; code?: string; message?: string }

export async function runAppleScript(exec: ExecFn, request: AppleScriptRequest, timeoutMs = 30_000): Promise<AppleScriptResult> {
  let script: string;
  try { script = buildAppleScript(request); } catch (error) {
    if (error instanceof AppleScriptRefusal) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
  const run = await exec("/usr/bin/osascript", ["-e", script], { timeoutMs, maxBytes: 256 * 1024 });
  if (run.timedOut) return { ok: false, code: "timeout", message: "the app did not answer in time" };
  if (run.code !== 0) {
    // -1743 is "not authorized to send Apple events": the Automation permission is missing or was refused.
    const denied = /-1743|not authorized/i.test(run.stderr);
    return { ok: false, code: denied ? "automation_denied" : "applescript_error", message: run.stderr.trim().slice(0, 300) };
  }
  return { ok: true, value: run.stdout.replace(/\n$/, "").slice(0, 64 * 1024) };
}
