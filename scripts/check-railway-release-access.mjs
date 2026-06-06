#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const desktopRoot = resolve(new URL("..", import.meta.url).pathname);
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);

const service = String(args.get("--service") || "agentlas-web");
const environment = String(args.get("--environment") || "production");
const project = String(args.get("--project") || process.env.RAILWAY_PROJECT_ID || "");
const railwayCwd = resolve(desktopRoot, String(args.get("--railway-cwd") || process.env.AGENTLAS_RAILWAY_CWD || "."));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || railwayCwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024 * 4,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

function fail(message, result) {
  if (process.env.GITHUB_ACTIONS) console.error(`::error::${message}`);
  else console.error(message);
  if (result?.output) console.error(result.output);
  process.exit(result?.status || 1);
}

const version = run("railway", ["--version"]);
if (!version.ok) fail("Railway CLI is not available for release credential validation.", version);

if (project) {
  const link = run("railway", [
    "link",
    "--project",
    project,
    "--environment",
    environment,
    "--service",
    service,
  ]);
  if (!link.ok) {
    fail(
      `Railway release credentials cannot access service=${service} environment=${environment}. Check RAILWAY_TOKEN and RAILWAY_PROJECT_ID.`,
      link,
    );
  }
} else {
  const status = run("railway", ["status"]);
  if (!status.ok) fail("Railway is not linked locally and RAILWAY_PROJECT_ID is not set.", status);
}

const envCheckArgs = ["run", "--service", service, "--environment", environment];
if (project) envCheckArgs.push("--project", project);
envCheckArgs.push("printenv", "AGENTLAS_DESKTOP_VERSION");

const envCheck = run("railway", envCheckArgs);
if (!envCheck.ok) fail(`Railway release credentials cannot read service variables for ${service}/${environment}.`, envCheck);

const currentVersion = envCheck.output.split(/\r?\n/).pop() || "(unset)";
console.log(`Railway release access ok: service=${service} environment=${environment} currentDesktopVersion=${currentVersion}`);
