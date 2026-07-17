#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import https from "node:https";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);

const envFile = resolve(desktopRoot, String(args.get("--env-file") || "release/desktop-release.production.env"));
const verificationFile = resolve(desktopRoot, String(args.get("--verification-file") || "release/desktop-release-verification.json"));
const apply = args.has("--apply");
const restart = args.has("--restart");
const verifyUrl = String(args.get("--verify-url") || "");
const service = String(args.get("--service") || "agentlas-web");
const environment = String(args.get("--environment") || "production");
const expectedRepo = String(
  args.get("--expected-repo") ||
  process.env.AGENTLAS_DESKTOP_GITHUB_REPO ||
  "agentlas-ai/agentlas-desktop-releases",
);
const railwayCwd = resolve(desktopRoot, String(args.get("--railway-cwd") || process.env.AGENTLAS_RAILWAY_CWD || "."));

const pairs = existsSync(verificationFile)
  ? releasePairsFromVerification(verificationFile)
  : args.has("--env-file") && existsSync(envFile)
    ? readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .filter((line) => /^AGENTLAS_DESKTOP_[A-Z0-9_]+=/.test(line))
    : (() => {
      throw new Error(
        `Missing verified release metadata: ${verificationFile}. ` +
        "The production env file is accepted only as an explicit legacy --env-file input.",
      );
    })();

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
  if (!values[key]) throw new Error(`Verified release metadata is missing ${key}`);
}
if (values.AGENTLAS_DESKTOP_RELEASE_VERIFIED !== "true" || values.AGENTLAS_DESKTOP_RELEASE_NOTARIZED !== "true") {
  throw new Error("Refusing to apply desktop release env until release is verified and notarized.");
}
if (args.get("--expected-version") && values.AGENTLAS_DESKTOP_VERSION !== args.get("--expected-version")) {
  throw new Error("Verified release metadata does not match --expected-version.");
}
if (args.get("--expected-tag") && values.AGENTLAS_DESKTOP_RELEASE_TAG !== args.get("--expected-tag")) {
  throw new Error("Verified release metadata does not match --expected-tag.");
}
if (values.AGENTLAS_DESKTOP_GITHUB_REPO !== expectedRepo) {
  throw new Error(`Verified release metadata does not match the expected release repository (${expectedRepo}).`);
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
  // 기본 20분: env 적용이 Railway 풀 리빌드(reason: deploy)를 촉발하면 빌드+배포에
  // 7분 이상 걸린다. 180초 창은 v0.7.21/v0.7.22에서 릴리스가 실제로 성공했는데도
  // 이 단계만 두 번 연속 빨간 X를 만들었다(restart가 "not restartable"로 스킵된 뒤
  // 리빌드가 끝나기 전에 창 만료).
  await waitForReleaseApi(verifyUrl, {
    version: values.AGENTLAS_DESKTOP_VERSION,
    tag: values.AGENTLAS_DESKTOP_RELEASE_TAG,
    timeoutMs: Number(process.env.AGENTLAS_RELEASE_API_TIMEOUT_MS || 1_200_000),
  });
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function releasePairsFromVerification(file) {
  let verification;
  try {
    verification = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid release verification JSON: ${file}`, { cause: error });
  }
  if (
    !verification || typeof verification !== "object" ||
    verification.ready !== true || verification.allowUnnotarized === true ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(String(verification.version || "")) ||
    verification.tag !== `v${verification.version}` ||
    !/^[0-9a-f]{40}$/i.test(String(verification.sourceCommit || "")) ||
    typeof verification.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(verification.repo)
  ) {
    throw new Error("Release verification does not prove an exact ready stable release.");
  }
  const artifacts = Array.isArray(verification.artifacts) ? verification.artifacts : [];
  const byArch = Object.fromEntries(artifacts.map((artifact) => [artifact?.arch, artifact]));
  if (artifacts.length !== 2 || !byArch.arm64 || !byArch.x64) {
    throw new Error("Release verification must contain exactly one arm64 and one x64 artifact.");
  }
  for (const arch of ["arm64", "x64"]) {
    const artifact = byArch[arch];
    const expectedFile = `Agentlas-${verification.version}-${arch}.dmg`;
    const expectedUrl = `https://github.com/${verification.repo}/releases/download/${verification.tag}/${expectedFile}`;
    if (
      artifact.fileName !== expectedFile || artifact.url !== expectedUrl ||
      artifact.notarized !== true || artifact.gatekeeperAccepted !== true ||
      artifact.innerApp?.notarized !== true || artifact.innerApp?.gatekeeperAccepted !== true ||
      !/^[0-9a-f]{64}$/.test(String(artifact.sha256 || "")) ||
      !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0
    ) {
      throw new Error(`Release verification artifact contract failed for ${arch}.`);
    }
  }
  const line = (key, value) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`;
  return [
    line("AGENTLAS_DESKTOP_VERSION", verification.version),
    line("AGENTLAS_DESKTOP_RELEASE_CHANNEL", "public"),
    line("AGENTLAS_DESKTOP_GITHUB_REPO", verification.repo),
    line("AGENTLAS_DESKTOP_RELEASE_TAG", verification.tag),
    line("AGENTLAS_DESKTOP_RELEASE_VERIFIED", "true"),
    line("AGENTLAS_DESKTOP_RELEASE_NOTARIZED", "true"),
    line("AGENTLAS_DESKTOP_MAC_ARM64_URL", byArch.arm64.url),
    line("AGENTLAS_DESKTOP_MAC_ARM64_SHA256", byArch.arm64.sha256),
    line("AGENTLAS_DESKTOP_MAC_ARM64_SIZE", byArch.arm64.sizeBytes),
    line("AGENTLAS_DESKTOP_MAC_X64_URL", byArch.x64.url),
    line("AGENTLAS_DESKTOP_MAC_X64_SHA256", byArch.x64.sha256),
    line("AGENTLAS_DESKTOP_MAC_X64_SIZE", byArch.x64.sizeBytes),
    line(
      "AGENTLAS_DESKTOP_RELEASE_NOTES",
      "Agentlas Desktop for macOS. Install approved Agentlas firms from the web and run them with your own AI runtime.",
    ),
  ];
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
