#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";

const desktopRoot = resolve(new URL("..", import.meta.url).pathname);
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);

const envFile = resolve(desktopRoot, String(args.get("--env-file") || "release/desktop-release.production.env"));
const apply = args.has("--apply");
const restart = args.has("--restart");
const verifyUrl = String(args.get("--verify-url") || "");
const service = String(args.get("--service") || "agentlas-web");
const environment = String(args.get("--environment") || "production");
const railwayCwd = resolve(desktopRoot, String(args.get("--railway-cwd") || process.env.AGENTLAS_RAILWAY_CWD || "."));

if (!existsSync(envFile)) {
  throw new Error(`Missing release env file: ${envFile}. Run npm run release:mac:verify first.`);
}

const pairs = readFileSync(envFile, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .filter((line) => /^AGENTLAS_DESKTOP_[A-Z0-9_]+=/.test(line));

const values = Object.fromEntries(
  pairs.map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

for (const key of [
  "AGENTLAS_DESKTOP_RELEASE_VERIFIED",
  "AGENTLAS_DESKTOP_RELEASE_NOTARIZED",
  "AGENTLAS_DESKTOP_MAC_ARM64_SHA256",
  "AGENTLAS_DESKTOP_MAC_ARM64_SIZE",
  "AGENTLAS_DESKTOP_MAC_X64_SHA256",
  "AGENTLAS_DESKTOP_MAC_X64_SIZE",
]) {
  if (!values[key]) throw new Error(`${envFile} is missing ${key}`);
}
if (values.AGENTLAS_DESKTOP_RELEASE_VERIFIED !== "true" || values.AGENTLAS_DESKTOP_RELEASE_NOTARIZED !== "true") {
  throw new Error("Refusing to apply desktop release env until release is verified and notarized.");
}

const command = [
  "railway",
  "variable",
  "set",
  "--service",
  service,
  "--environment",
  environment,
  ...pairs,
];

if (!apply) {
  console.log(`(cd ${shellQuote(railwayCwd)} && ${command.map(shellQuote).join(" ")})`);
  console.log("Dry run only. Re-run with --apply after confirming the release is public.");
  process.exit(0);
}

const result = spawnSync(command[0], command.slice(1), {
  cwd: railwayCwd,
  stdio: "inherit",
  env: process.env,
});
if (result.status !== 0) process.exit(result.status || 1);

if (restart) {
  const restartResult = spawnSync("railway", ["restart", "--service", service, "--yes"], {
    cwd: railwayCwd,
    stdio: "inherit",
    env: process.env,
    timeout: Number(process.env.AGENTLAS_RAILWAY_RESTART_TIMEOUT_MS || 120_000),
  });
  if (restartResult.status !== 0 && !verifyUrl) process.exit(restartResult.status || 1);
}

if (verifyUrl) {
  await waitForReleaseApi(verifyUrl, {
    version: values.AGENTLAS_DESKTOP_VERSION,
    tag: values.AGENTLAS_DESKTOP_RELEASE_TAG,
    timeoutMs: Number(process.env.AGENTLAS_RELEASE_API_TIMEOUT_MS || 180_000),
  });
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function waitForReleaseApi(url, expected) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < expected.timeoutMs) {
    try {
      const body = await get(url);
      const json = JSON.parse(body);
      if (json.version === expected.version && json.releaseTag === expected.tag && json.ready === true) {
        console.log(`Verified ${url}: version=${json.version} tag=${json.releaseTag} ready=${json.ready}`);
        return;
      }
      last = `version=${json.version} tag=${json.releaseTag} ready=${json.ready}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  throw new Error(`Release API did not reflect version=${expected.version} tag=${expected.tag}: ${last}`);
}

function get(url) {
  return new Promise((resolveGet, rejectGet) => {
    https
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            rejectGet(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          resolveGet(body);
        });
      })
      .on("error", rejectGet);
  });
}
