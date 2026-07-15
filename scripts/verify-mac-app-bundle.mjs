#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMacAppBundle } from "./lib/mac-app-signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);
const appPath = String(args.get("--app") || "");
const policyPath = resolve(root, String(args.get("--policy") || "build-resources/macos-release-signing-policy.json"));
if (!appPath) {
  console.error("--app is required");
  process.exit(2);
}
const result = verifyMacAppBundle({ appPath: resolve(appPath), policyPath });
console.log(JSON.stringify({
  ok: result.ok,
  category: result.category,
  developerId: result.developerId,
  notarized: result.notarized,
  stapledNotarization: result.stapledNotarization,
  gatekeeperAccepted: result.gatekeeperAccepted,
  bundleIdentifier: result.bundleIdentifier ?? null,
  teamIdentifier: result.teamIdentifier ?? null,
  leafAuthority: result.leafAuthority ?? null,
  designatedRequirement: result.designatedRequirement,
}, null, 2));
if (!result.ok) process.exit(1);
