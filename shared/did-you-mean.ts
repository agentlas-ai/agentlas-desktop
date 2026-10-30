/**
 * "Did you mean" hints for a name the model got wrong: a tool, an operation, an argument or a value that must come from
 * a fixed set. One deterministic, dependency-free matcher serves every refusal the app writes for such a mistake.
 *
 * A hint is text and nothing else. The caller refuses the call first and only then asks this module for candidates, so
 * a near match is never run, substituted or treated as the model's intent. Candidates must be names the model can
 * already see (the declared parameters of the operation, the values of the enum, the registered tool names); this module
 * never reads files, paths or user data, and it returns nothing when no candidate is clearly close.
 */

/** Below this similarity (0..1) a candidate is not offered. A typo needs a tighter match than shared words do. */
const MIN_SIMILARITY = 0.66;
const MIN_TYPO_SIMILARITY = 0.7;
/** Candidates scoring within this distance of the best one are offered together (a tie is not a winner). */
const TIE_BAND = 0.12;
/** Most candidates one hint names. */
const MAX_HINTS = 3;
/** Edit distance is computed on names up to this long; longer names fall back to token overlap. */
const MAX_EDIT_LENGTH = 96;

/** Lowercase words of a name: camelCase, snake_case, kebab-case, dotted and `mcp__server__tool` names all split alike. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Optimal string alignment distance: insert, delete, substitute, or swap two neighbours, each one edit. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let beforeLast: number[] = [];
  let last = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(last[j] + 1, row[j - 1] + 1, last[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, beforeLast[j - 2] + 1);
      row.push(best);
    }
    beforeLast = last;
    last = row;
  }
  return last[b.length];
}

/** Two words match when they are equal, or when the longer one starts with the shorter one (three letters or more). */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * How close two names are, from 0 to 1. Case, separators and word order of camelCase/snake_case are ignored first
 * (`agent_id` and `agentId` are 1). Beyond that the best of: a small typo (edit distance), one name being the
 * start of the other, and the share of words the two names have in common (`file_path` and `path`).
 */
export function nameSimilarity(requested: string, candidate: string): number {
  const a = words(requested);
  const b = words(candidate);
  if (!a.length || !b.length) return 0;
  const compactA = a.join("");
  const compactB = b.join("");
  if (compactA === compactB) return 1;
  let best = 0;
  const length = Math.max(compactA.length, compactB.length);
  if (length >= 4 && length <= MAX_EDIT_LENGTH) {
    const typo = 1 - editDistance(compactA, compactB) / length;
    if (typo >= MIN_TYPO_SIMILARITY) best = typo;
  }
  const [short, long] = compactA.length <= compactB.length ? [compactA, compactB] : [compactB, compactA];
  if (short.length >= 4 && long.startsWith(short) && short.length / long.length >= 0.5) best = Math.max(best, 0.7 + 0.3 * short.length / long.length);
  const unused = [...b];
  let shared = 0;
  for (const word of a) {
    const at = unused.findIndex((other) => wordsMatch(word, other));
    if (at >= 0) { shared += 1; unused.splice(at, 1); }
  }
  return Math.max(best, (2 * shared) / (a.length + b.length));
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The candidates clearly close to `requested`, closest first; ties keep every tied candidate and sort by name, so the
 * answer does not depend on the order the candidates were given in. Empty when nothing is clearly close. A candidate
 * equal to `requested` is never offered (the caller only asks after the name was refused).
 */
export function closestNames(requested: string, candidates: Iterable<string>, limit = MAX_HINTS): string[] {
  if (typeof requested !== "string" || !requested.trim()) return [];
  const scored = new Map<string, number>();
  for (const name of candidates) {
    if (typeof name !== "string" || name === requested || scored.has(name)) continue;
    const score = nameSimilarity(requested, name);
    if (score >= MIN_SIMILARITY) scored.set(name, score);
  }
  if (!scored.size) return [];
  const best = Math.max(...scored.values());
  return [...scored]
    .filter(([, score]) => score >= best - TIE_BAND)
    .sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
    .slice(0, Math.max(1, limit))
    .map(([name]) => name);
}

const orList = (names: readonly string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

/** ` Did you mean x?` (leading space) when a candidate is clearly close, otherwise the empty string. */
export function didYouMean(requested: string, candidates: Iterable<string>): string {
  const near = closestNames(requested, candidates);
  return near.length ? ` Did you mean ${orList(near)}?` : "";
}

/**
 * `Unknown argument limt (did you mean limit?), foo; automations.list takes limit, offset.` Each unknown argument names its
 * closest declared parameters; the declared list stays, so a name with no close match still shows what is accepted.
 */
export function unknownArgumentMessage(target: string, unknown: readonly string[], declared: readonly string[]): string {
  const named = unknown.map((key) => {
    const near = closestNames(key, declared);
    return near.length ? `${key} (did you mean ${orList(near)}?)` : key;
  });
  return `Unknown argument ${named.join(", ")}; ${target} takes ${declared.length ? declared.join(", ") : "no arguments"}.`;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** What the model sent, shown back short: a string as text, anything else as its kind. */
function received(value: unknown): string {
  if (value === undefined) return "missing";
  return typeof value === "string" ? `got "${clip(value, 40)}"` : `got ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`;
}

/**
 * The tail of a refusal for a value outside a fixed set: `must be ko, en or system (got "kor"). Did you mean ko?`.
 * `listAll: false` (a long set) names only how many values are allowed and the closest ones, and points at `readAt`.
 */
export function valueChoiceMessage(value: unknown, allowed: readonly string[], options: { listAll?: boolean; readAt?: string } = {}): string {
  const near = typeof value === "string" ? closestNames(value, allowed) : [];
  const hint = near.length ? ` Did you mean ${orList(near)}?` : "";
  return options.listAll !== false
    ? `must be ${orList(allowed)} (${received(value)}).${hint}`
    : `is not one of the ${allowed.length} allowed values (${received(value)}).${hint}${options.readAt ? ` Read ${options.readAt}.` : ""}`;
}

/** `locale must be ko, en or system (got "kor"). Did you mean ko?` (see valueChoiceMessage). */
export function invalidValueMessage(field: string, value: unknown, allowed: readonly string[], options: { listAll?: boolean; readAt?: string } = {}): string {
  return `${field} ${valueChoiceMessage(value, allowed, options)}`;
}

/**
 * `required: skillId. skill is not an argument (did you mean skillId?)`: the arguments a call lacks, and for each argument
 * it sent that no operation field matches, the missing field it is closest to. `declared` is every name the operation
 * reads, so an optional argument that was sent on purpose is never called wrong.
 */
export function missingArgumentsMessage(missing: readonly string[], sent: readonly string[], declared: readonly string[]): string {
  const known = new Set(declared);
  const wrong = sent.filter((key) => !known.has(key)).flatMap((key) => {
    const near = closestNames(key, missing);
    return near.length ? [`${key} is not an argument (did you mean ${orList(near)}?)`] : [];
  });
  return `required: ${missing.join(", ")}${wrong.length ? `. ${wrong.join("; ")}` : ""}`;
}

type SchemaNode = Record<string, unknown>;
const isRecord = (value: unknown): value is SchemaNode => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Hints for an arguments object read against the JSON-schema subset the app's tools declare: a field the schema lists
 * (`properties`, closed with `additionalProperties: false`) that the object does not have, and a string outside a string
 * `enum`, and a nested object missing a field its `required` lists. Each hint names the allowed values or fields and the closest one. It only describes; what the tool does with
 * the arguments is decided elsewhere, so a hint is used on a call that already failed. Unions (`anyOf`/`oneOf`) and open
 * objects are not judged.
 */
export function schemaArgumentHints(schema: unknown, args: unknown, options: { topLevel?: boolean; maxHints?: number } = {}): string[] {
  const maxHints = options.maxHints ?? MAX_HINTS;
  const hints: string[] = [];
  const visit = (node: unknown, value: unknown, path: string, depth: number): void => {
    if (hints.length >= maxHints || depth > 4 || !isRecord(node)) return;
    if (Array.isArray(node.enum)) {
      const allowed = node.enum.filter((item): item is string => typeof item === "string");
      if (allowed.length && allowed.length === node.enum.length && typeof value === "string" && !allowed.includes(value)) {
        hints.push(invalidValueMessage(path, value, allowed, { listAll: allowed.length <= 8 }));
      }
      return;
    }
    if (Array.isArray(value) && isRecord(node.items)) {
      value.slice(0, 5).forEach((item, index) => visit(node.items, item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(value) || !isRecord(node.properties)) return;
    const fields = Object.keys(node.properties);
    if (node.additionalProperties === false && (path || options.topLevel)) {
      const unknown = Object.keys(value).filter((key) => !fields.includes(key));
      if (unknown.length) {
        const named = unknown.map((key) => {
          const near = closestNames(key, fields);
          return near.length ? `${key} (did you mean ${orList(near)}?)` : key;
        });
        const takes = `${fields.slice(0, 12).join(", ")}${fields.length > 12 ? ", ..." : ""}`;
        hints.push(path ? `${path} has no field ${named.join(", ")}; it takes ${takes}.` : `Unknown argument ${named.join(", ")}; it takes ${takes || "no arguments"}.`);
      }
    }
    // A nested object that lacks a field its schema requires: the handler answers with a bare code (alive.getState {input:{chatId}} read
    // "alive-input-invalid" with nothing about `surface`, 10-25). Name the missing field and, when the schema lists them, its values.
    if (path && Array.isArray(node.required)) {
      const missing = node.required.filter((field): field is string => typeof field === "string" && !Object.hasOwn(value, field));
      if (missing.length) {
        const named = missing.map((field) => {
          const values = (node.properties as SchemaNode)[field];
          const listed = isRecord(values) && Array.isArray(values.enum) && values.enum.every((item) => typeof item === "string") && values.enum.length <= 8 ? ` (${(values.enum as string[]).join(" | ")})` : "";
          return `${field}${listed}`;
        });
        hints.push(`${path} needs ${named.join(", ")}.`);
      }
    }
    for (const field of fields) {
      if (Object.hasOwn(value, field)) visit(node.properties[field], value[field], path ? `${path}.${field}` : field, depth + 1);
    }
  };
  visit(schema, args, "", 0);
  return hints.slice(0, maxHints);
}
