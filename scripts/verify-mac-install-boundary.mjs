#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyMacAppBundle } from "./lib/mac-app-signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.split("=");
  return [key, value.join("=") || "1"];
}));
const sourceArgument = String(args.get("--source") || "");
const destinationArgument = String(args.get("--destination") || "");
const source = sourceArgument ? resolve(sourceArgument) : "";
const destination = destinationArgument ? resolve(destinationArgument) : "";
const mode = String(args.get("--mode") || "");
const officialDestination = "/Applications/Agentlas.app";
const policyPath = resolve(root, String(args.get("--policy") || "build-resources/macos-release-signing-policy.json"));

if (!source || !destination || !["official", "local"].includes(mode)) {
  throw new Error("--source, --destination, and --mode=official|local are required");
}
if (mode === "official") {
  if (destination !== officialDestination || basename(source) !== "Agentlas.app") {
    throw new Error("official install identity/path mismatch");
  }
  // Historical official DMGs can contain an app whose notarization is proven
  // by Gatekeeper (`source=Notarized Developer ID`) even when the inner app's
  // ticket was not stapled separately. New release packaging uses the stricter
  // default helper and requires the staple before publication.
  const trust = verifyMacAppBundle({ appPath: source, policyPath, requireStapledNotarization: false });
  if (!trust.ok) throw new Error(`official install source rejected (${trust.category})`);
  console.log(JSON.stringify({ ok: true, mode, destinationClass: "official", trustCategory: trust.category }));
} else {
  if (destination === officialDestination || basename(source) !== "Agentlas-Local-Candidate.app") {
    throw new Error("local candidate must never share the official application path/name");
  }
  const plist = join(source, "Contents", "Info.plist");
  const bundleId = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8" });
  if (bundleId.status !== 0 || bundleId.stdout.trim() !== "com.agentlas.desktop.candidate") {
    throw new Error("local candidate bundle identifier mismatch");
  }
  if (["app-update.yml", "app-update.yaml"].some((name) => existsSync(join(source, "Contents", "Resources", name)))) {
    throw new Error("local candidate contains an update feed");
  }
  console.log(JSON.stringify({ ok: true, mode, destinationClass: "isolated-local", officialFeedEmbedded: false }));
}
