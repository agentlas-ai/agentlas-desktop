import { AppControlError } from "./ipc-registry";

const MAX_BINARY_BYTES = 16 * 1024 * 1024;
type Schema = Record<string, unknown>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function matches(value: unknown, schema: Schema): boolean {
  if ("const" in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "object" && !record(value) || schema.type === "array" && !Array.isArray(value)) return false;
  if (schema.type === "null" && value !== null || schema.type === "string" && typeof value !== "string"
    || schema.type === "number" && typeof value !== "number" || schema.type === "boolean" && typeof value !== "boolean") return false;
  if (record(value) && record(schema.properties)) {
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key === "string" && !Object.hasOwn(value, key))) return false;
    for (const [key, field] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && record(field) && !matches(value[key], field)) return false;
    }
  }
  return true;
}

/** JSON cannot carry IPC typed arrays. Decode only fields marked by the generated native input schema. */
export function decodeAppControlArguments(value: unknown, schema: Schema | undefined): unknown {
  let usedBytes = 0;
  const decode = (value: unknown, schema: Schema | undefined, depth: number): unknown => {
    if (!schema || depth > 24 || value === undefined || value === null) return value;
    const binary = schema["x-agentlas-binary"];
    if (binary !== undefined) {
      let bytes: Buffer;
      if (Array.isArray(value)) {
        if (value.length > MAX_BINARY_BYTES || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          throw new AppControlError("invalid-arguments", "Binary bytes must be integers from 0 to 255, within 16 MiB.");
        }
        bytes = Buffer.from(value);
      } else if (record(value) && Object.keys(value).length === 1 && typeof value.base64 === "string") {
        if (value.base64.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4 || value.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) {
          throw new AppControlError("invalid-arguments", "Binary base64 must use the canonical base64 encoding, within 16 MiB.");
        }
        bytes = Buffer.from(value.base64, "base64");
        if (bytes.toString("base64") !== value.base64) throw new AppControlError("invalid-arguments", "Noncanonical binary base64.");
      } else throw new AppControlError("invalid-arguments", "Provide binary data as byte integers or {base64: string}.");
      usedBytes += bytes.length;
      if (usedBytes > MAX_BINARY_BYTES) throw new AppControlError("invalid-arguments", "Combined binary input exceeds 16 MiB.");
      if (binary === "Buffer") return bytes;
      const output = Uint8Array.from(bytes);
      if (binary === "ArrayBuffer") return output.buffer;
      if (binary === "Uint8Array") return output;
      throw new AppControlError("invalid-arguments", "Unsupported native binary input type.");
    }
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives)) {
      const variant = alternatives.find(item => record(item) && matches(value, item));
      if (record(variant)) return decode(value, variant, depth + 1);
    }
    if (Array.isArray(value) && record(schema.items)) return value.map(item => decode(item, schema.items as Schema, depth + 1));
    if (record(value) && record(schema.properties)) {
      const properties = schema.properties;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        decode(item, record(properties[key]) ? properties[key] : record(schema.additionalProperties) ? schema.additionalProperties : undefined, depth + 1),
      ]));
    }
    return value;
  };
  return decode(value, schema, 0);
}
