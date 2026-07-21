#!/usr/bin/env node
import { createHash } from "node:crypto";
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
const redeploy = args.has("--redeploy") || args.has("--restart");
const verifyUrl = String(args.get("--verify-url") || "");
const service = String(args.get("--service") || "agentlas-web");
const environment = String(args.get("--environment") || "production");
const expectedProject = "38a28b33-b637-414f-a355-8cb9a7e01a35";
const project = String(args.get("--project") || process.env.RAILWAY_PROJECT_ID || expectedProject);
const expectedRepo = String(
  args.get("--expected-repo") ||
  process.env.AGENTLAS_DESKTOP_GITHUB_REPO ||
  "agentlas-ai/agentlas-desktop-releases",
);
const requestTimeoutMs = Number(process.env.AGENTLAS_RELEASE_REQUEST_TIMEOUT_MS || 300_000);
if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 1_200_000) {
  throw new Error("AGENTLAS_RELEASE_REQUEST_TIMEOUT_MS must be an integer from 1000 to 1200000.");
}
const railwayCwd = resolve(desktopRoot, String(args.get("--railway-cwd") || process.env.AGENTLAS_RAILWAY_CWD || "."));
if (project !== expectedProject) {
  throw new Error(`Refusing non-production Railway project ${project}; expected ${expectedProject}.`);
}

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
];
command.push("--project", project);
command.push(...pairs);

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

const auditKeys = pairs.map((line) => line.slice(0, line.indexOf("=")));
const auditArgs = ["run", "--service", service, "--environment", environment];
auditArgs.push("--project", project);
// BSD printenv (used by local macOS release operators) accepts multiple names
// but prints only the first one while still exiting 0. Run one lookup per key
// through POSIX sh so all 13 release values are audited on macOS and Linux.
auditArgs.push(
  "sh",
  "-c",
  'for key do printenv "$key" || exit 1; done',
  "agentlas-release-env-audit",
  ...auditKeys,
);
const auditResult = spawnSync("railway", auditArgs, {
  cwd: railwayCwd,
  encoding: "utf8",
  env: process.env,
});
const actualAuditValues = String(auditResult.stdout || "").trim().split(/\r?\n/);
const expectedAuditValues = auditKeys.map((key) => values[key]);
if (auditResult.status !== 0 ||
    actualAuditValues.length !== expectedAuditValues.length ||
    actualAuditValues.some((value, index) => value !== expectedAuditValues[index])) {
  throw new Error("Railway did not persist the exact verified Desktop release metadata in the requested project/service/environment.");
}

if (redeploy) {
  // A variable write can create a SKIPPED deployment when the connected web
  // source currently has a failed check suite. A restart reuses the old env
  // snapshot, so redeploy the last verified image with the newly audited vars.
  const redeployArgs = ["redeploy", "--service", service, "--environment", environment];
  redeployArgs.push("--project", project);
  redeployArgs.push("--yes");
  const redeployResult = spawnSync("railway", redeployArgs, {
    cwd: railwayCwd,
    stdio: "inherit",
    env: process.env,
    timeout: Number(process.env.AGENTLAS_RAILWAY_REDEPLOY_TIMEOUT_MS || process.env.AGENTLAS_RAILWAY_RESTART_TIMEOUT_MS || 120_000),
  });
  if (redeployResult.status !== 0) process.exit(redeployResult.status || 1);
}

if (verifyUrl) {
  // 기본 20분: env 적용이 Railway 풀 리빌드(reason: deploy)를 촉발하면 빌드+배포에
  // 7분 이상 걸린다. 180초 창은 v0.7.21/v0.7.22에서 릴리스가 실제로 성공했는데도
  // 이 단계만 두 번 연속 빨간 X를 만들었다(restart가 "not restartable"로 스킵된 뒤
  // 리빌드가 끝나기 전에 창 만료).
  await waitForReleaseApi(verifyUrl, {
    version: values.AGENTLAS_DESKTOP_VERSION,
    tag: values.AGENTLAS_DESKTOP_RELEASE_TAG,
    artifacts: {
      arm64: {
        fileName: `Agentlas-${values.AGENTLAS_DESKTOP_VERSION}-arm64.dmg`,
        sha256: values.AGENTLAS_DESKTOP_MAC_ARM64_SHA256,
        size: Number(values.AGENTLAS_DESKTOP_MAC_ARM64_SIZE),
      },
      x64: {
        fileName: `Agentlas-${values.AGENTLAS_DESKTOP_VERSION}-x64.dmg`,
        sha256: values.AGENTLAS_DESKTOP_MAC_X64_SHA256,
        size: Number(values.AGENTLAS_DESKTOP_MAC_X64_SIZE),
      },
    },
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
        await verifyReleaseDownloads(url, expected.artifacts);
        console.log(`Verified ${url} and both served DMG bytes: version=${json.version} tag=${json.releaseTag} ready=${json.ready}`);
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

async function verifyReleaseDownloads(apiUrl, artifacts) {
  for (const arch of ["arm64", "x64"]) {
    const expected = artifacts[arch];
    const downloadUrl = new URL(`/api/desktop/download?arch=${arch}`, apiUrl).toString();
    const headers = await requestHeaders(downloadUrl);
    const disposition = String(headers["content-disposition"] || "");
    if (
      headers["x-agentlas-desktop-arch"] !== arch ||
      headers["x-agentlas-desktop-sha256"] !== expected.sha256 ||
      Number(headers["x-agentlas-desktop-size"]) !== expected.size ||
      Number(headers["content-length"]) !== expected.size ||
      !disposition.includes(`filename="${expected.fileName}"`)
    ) {
      throw new Error(`Download headers do not bind ${arch} to the verified release artifact.`);
    }
    const served = await downloadDigest(downloadUrl);
    if (served.size !== expected.size || served.sha256 !== expected.sha256) {
      throw new Error(`Served ${arch} DMG bytes do not match the verified release artifact.`);
    }
  }
}

function requestHeaders(url) {
  return new Promise((resolveHead, rejectHead) => {
    const request = https.request(url, { method: "HEAD" }, (response) => {
      response.resume();
      if (response.statusCode !== 200) {
        rejectHead(new Error(`Download HEAD ${response.statusCode}`));
        return;
      }
      resolveHead(response.headers);
    });
    request.on("error", rejectHead);
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("Download HEAD timed out.")));
    request.end();
  });
}

function downloadDigest(url) {
  return new Promise((resolveDownload, rejectDownload) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`Download GET ${response.statusCode}`));
        return;
      }
      const digest = createHash("sha256");
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        digest.update(chunk);
      });
      response.on("end", () => resolveDownload({ size, sha256: digest.digest("hex") }));
      response.on("error", rejectDownload);
    });
    request.on("error", rejectDownload);
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("Download GET timed out.")));
  });
}

function get(url) {
  return new Promise((resolveGet, rejectGet) => {
    const request = https.get(url, (response) => {
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
      });
    request.on("error", rejectGet);
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("Release API request timed out.")));
  });
}
