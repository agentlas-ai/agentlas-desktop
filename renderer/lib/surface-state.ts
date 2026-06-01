import type { JsonObject, JsonValue } from "./types";

export function applySurfaceStatePatch(
  state: JsonObject | undefined,
  path: string,
  value: JsonValue,
): JsonObject {
  const segments = parsePointer(path);
  const next = JSON.parse(JSON.stringify(state ?? {})) as JsonObject;
  let cursor: JsonObject | JsonValue[] = next;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const shouldBeArray = /^\d+$/.test(nextSegment);
    const existing = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment];
    const child = shouldBeArray ? (Array.isArray(existing) ? existing : []) : isObject(existing) ? existing : {};
    if (Array.isArray(cursor)) cursor[Number(segment)] = child;
    else cursor[segment] = child;
    cursor = child as JsonObject | JsonValue[];
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) cursor[Number(last)] = value;
  else cursor[last] = value;
  return next;
}

function parsePointer(path: string): string[] {
  if (!path.startsWith("/")) throw new Error("Surface state path must be a JSON Pointer.");
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
