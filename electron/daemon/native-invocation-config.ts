import { NATIVE_DAEMON_INVOCATION_POLICY } from "./native-invocation-policy";
export const NATIVE_INVOCATION_PRODUCTION_RESOURCES = NATIVE_DAEMON_INVOCATION_POLICY;
export type NativeInvocationResources = Readonly<{ maxTransferBytes: number; maxRecords: number }>;
export function parseNativeInvocationResources(value: unknown): NativeInvocationResources {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, "maxTransferBytes") || !Object.hasOwn(value, "maxRecords")) {
    throw Object.assign(new Error("native_invocation_resources_invalid"), { code: "native_invocation_resources_invalid" });
  }
  const v = value as Record<string, unknown>;
  if (![v.maxTransferBytes, v.maxRecords].every(n => Number.isSafeInteger(n) && Number(n) > 0)) {
    throw Object.assign(new Error("native_invocation_resources_invalid"), { code: "native_invocation_resources_invalid" });
  }
  return Object.freeze({ maxTransferBytes: Number(v.maxTransferBytes), maxRecords: Number(v.maxRecords) });
}
export function nativeInvocationResourcesFromArgv(argv: readonly string[]): NativeInvocationResources | undefined {
  const flag = argv.indexOf("--native-invocation-resources");
  if (flag < 0) return undefined;
  if (argv.lastIndexOf("--native-invocation-resources") !== flag || typeof argv[flag + 1] !== "string" || argv[flag + 1].length > 256) {
    throw Object.assign(new Error("native_invocation_resources_invalid"), { code: "native_invocation_resources_invalid" });
  }
  let value: unknown;
  try { value = JSON.parse(argv[flag + 1]); } catch { throw Object.assign(new Error("native_invocation_resources_invalid"), { code: "native_invocation_resources_invalid" }); }
  return parseNativeInvocationResources(value);
}
