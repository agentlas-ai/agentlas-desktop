#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ASSET_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_ASSET_POLL_MS = 10 * 1000;

export function requiredReleaseAssetNames(version) {
  return [
    `Agentlas-${version}-Windows-x64-Setup.exe`,
    `Agentlas-${version}-Windows-x64-Setup.exe.blockmap`,
    `Agentlas-${version}-Windows-x64-Portable.exe`,
    `Agentlas-${version}-Linux-x64.AppImage`,
    `Agentlas-${version}-Linux-x64.deb`,
    `Agentlas-${version}-arm64.dmg`,
    `Agentlas-${version}-arm64.dmg.blockmap`,
    `Agentlas-${version}-arm64.zip`,
    `Agentlas-${version}-arm64.zip.blockmap`,
    `Agentlas-${version}-x64.dmg`,
    `Agentlas-${version}-x64.dmg.blockmap`,
    `Agentlas-${version}-x64.zip`,
    `Agentlas-${version}-x64.zip.blockmap`,
    "latest.yml",
    "latest-linux.yml",
    "latest-mac.yml",
    "desktop-release-verification.json",
  ];
}

/**
 * Explicit public allowlist. Production Railway variables are derived in
 * memory from desktop-release-verification.json; env files, tests, and
 * internal evidence never become GitHub release assets.
 */
export function publicReleaseAssetNames(version) {
  return requiredReleaseAssetNames(version);
}

export function assertStableReleaseIdentity(version, tag) {
  const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
  if (!stableVersion.test(version) || tag !== `v${version}`) {
    throw new Error(
      `Stable publisher requires an exact vMAJOR.MINOR.PATCH tag with no prerelease suffix (version=${version}, tag=${tag}).`,
    );
  }
}

export function inspectReleaseState(version, release, requiredAssets = requiredReleaseAssetNames(version)) {
  const assetNames = new Set(
    Array.isArray(release?.assets)
      ? release.assets
        .map((asset) => (typeof asset === "string" ? asset : asset?.name))
        .filter((name) => typeof name === "string" && name.length > 0)
      : [],
  );
  const missingAssets = requiredAssets.filter((name) => !assetNames.has(name));
  const requiredAssetSet = new Set(requiredAssets);
  const unexpectedAssets = [...assetNames].filter((name) => !requiredAssetSet.has(name)).sort();
  const isDraft = release?.isDraft === true;
  const isPrerelease = release?.isPrerelease === true;
  return {
    isDraft,
    isPrerelease,
    isStable: !isDraft && !isPrerelease,
    complete: missingAssets.length === 0 && unexpectedAssets.length === 0,
    requiredAssets,
    missingAssets,
    unexpectedAssets,
    assetNames: [...assetNames].sort(),
  };
}

export function boundedMilliseconds(rawValue, fallback, { name, min, max }) {
  if (rawValue === undefined || rawValue === "") return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} milliseconds.`);
  }
  return parsed;
}

export async function waitForRequiredReleaseAssets({
  version,
  readState,
  waitMs,
  pollMs,
  sleep = (delay) => new Promise((resolveSleep) => setTimeout(resolveSleep, delay)),
  now = () => Date.now(),
  onWait = () => {},
}) {
  const deadline = now() + waitMs;
  for (;;) {
    const state = readState();
    if (!state) throw new Error(`Release v${version} disappeared while waiting for staged assets.`);
    if (state.isStable && !state.complete) {
      throw new Error(
        `Refusing non-exact stable release v${version}; missing required assets: ${state.missingAssets.join(", ") || "none"}; ` +
        `unexpected public assets: ${state.unexpectedAssets.join(", ") || "none"}`,
      );
    }
    if (state.complete) return state;

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out waiting for the exact public release assets for v${version}; stable promotion is blocked. ` +
        `Missing: ${state.missingAssets.join(", ") || "none"}; unexpected: ${state.unexpectedAssets.join(", ") || "none"}`,
      );
    }
    onWait(state, remaining);
    await sleep(Math.min(pollMs, remaining));
  }
}

function spawn(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: desktopRoot,
    stdio: options.stdio || "pipe",
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024 * 12,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return { ...result, output };
}

function run(command, commandArgs, options = {}) {
  const result = spawn(command, commandArgs, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed\n${result.output}`);
  }
  return result.output;
}

function requireFile(file) {
  if (!existsSync(file)) throw new Error(`Missing release artifact: ${file}`);
  return file;
}

function cleanupAppleDouble(releaseDir) {
  if (!existsSync(releaseDir)) return;
  run("find", [releaseDir, "-name", "._*", "-delete"]);
  if (process.platform === "darwin") {
    const dotClean = spawnSync("sh", ["-lc", "command -v dot_clean || test ! -x /usr/sbin/dot_clean || printf /usr/sbin/dot_clean"], {
      cwd: desktopRoot,
      encoding: "utf8",
      env: process.env,
    }).stdout.trim();
    if (dotClean) run(dotClean, ["-m", releaseDir]);
  }
}

function readReleaseState({ repo, tag, version }) {
  const result = spawn("gh", [
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "isDraft,isPrerelease,assets",
  ]);
  if (result.status !== 0) {
    if (/release not found|HTTP 404|\bNot Found\b/i.test(result.output)) return null;
    throw new Error(`Could not inspect staged release ${tag}; refusing to guess its state.\n${result.output}`);
  }
  try {
    return inspectReleaseState(version, JSON.parse(result.stdout), publicReleaseAssetNames(version));
  } catch (error) {
    throw new Error(`Could not parse staged release ${tag}; refusing stable promotion. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readLatestStableTag(repo) {
  const result = spawn("gh", [
    "release",
    "view",
    "--repo",
    repo,
    "--json",
    "tagName,isDraft,isPrerelease",
  ]);
  if (result.status !== 0) {
    throw new Error(`Could not verify the latest stable release for ${repo}.\n${result.output}`);
  }
  try {
    const latest = JSON.parse(result.stdout);
    if (latest?.isDraft === true || latest?.isPrerelease === true || typeof latest?.tagName !== "string") {
      throw new Error("latest release response was not a published stable tag");
    }
    return latest.tagName;
  } catch (error) {
    throw new Error(`Could not parse the latest stable release for ${repo}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertNoPartialStable(state, tag) {
  if (state?.unexpectedAssets?.length) {
    throw new Error(
      `Refusing release ${tag} with assets outside the public allowlist: ${state.unexpectedAssets.join(", ")}`,
    );
  }
  if (state?.isStable && !state.complete) {
    throw new Error(
      `Refusing to modify partial stable release ${tag}; missing required assets: ${state.missingAssets.join(", ")}`,
    );
  }
}

function createOrNormalizeStagingRelease({ repo, tag, version, notesPath, keepDraft }) {
  let state = readReleaseState({ repo, tag, version });
  assertNoPartialStable(state, tag);

  if (!state) {
    const createArgs = [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--title",
      `Agentlas Desktop ${version}`,
      "--notes-file",
      notesPath,
      keepDraft ? "--draft" : "--prerelease",
    ];
    const created = spawn("gh", createArgs);
    if (created.status !== 0) {
      // The Windows/Linux publisher may have won the create race. Re-read the
      // authoritative state; network/auth failures still fail closed.
      state = readReleaseState({ repo, tag, version });
      if (!state) {
        throw new Error(`Could not create staged release ${tag}.\n${created.output}`);
      }
      assertNoPartialStable(state, tag);
    }
  }

  state = state || readReleaseState({ repo, tag, version });
  if (!state) throw new Error(`Staged release ${tag} is unavailable after creation.`);
  if (!state.isStable) {
    const editArgs = [
      "release",
      "edit",
      tag,
      "--repo",
      repo,
      "--title",
      `Agentlas Desktop ${version}`,
      "--notes-file",
      notesPath,
    ];
    if (keepDraft) editArgs.push("--draft");
    else editArgs.push("--draft=false", "--prerelease");
    run("gh", editArgs);
    state = readReleaseState({ repo, tag, version });
    if (!state || state.isStable) {
      throw new Error(`Release ${tag} did not remain in draft/prerelease staging before Mac upload.`);
    }
  }
  return state;
}

async function main() {
  const args = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, ...rest] = arg.split("=");
      return [key, rest.length ? rest.join("=") : "1"];
    }),
  );
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const version = String(args.get("--version") || pkg.version);
  const repo = String(args.get("--repo") || process.env.AGENTLAS_DESKTOP_GITHUB_REPO || "agentlas-ai/agentlas-desktop-releases");
  const tag = String(args.get("--tag") || process.env.AGENTLAS_DESKTOP_RELEASE_TAG || `v${version}`);
  const releaseDir = resolve(desktopRoot, String(args.get("--release-dir") || "release"));
  const keepDraft = args.has("--draft");
  assertStableReleaseIdentity(version, tag);
  const waitMs = boundedMilliseconds(
    process.env.AGENTLAS_RELEASE_ASSET_WAIT_MS,
    DEFAULT_ASSET_WAIT_MS,
    { name: "AGENTLAS_RELEASE_ASSET_WAIT_MS", min: 1_000, max: 30 * 60 * 1000 },
  );
  const pollMs = boundedMilliseconds(
    process.env.AGENTLAS_RELEASE_ASSET_POLL_MS,
    DEFAULT_ASSET_POLL_MS,
    { name: "AGENTLAS_RELEASE_ASSET_POLL_MS", min: 250, max: 60_000 },
  );

  run("node", ["scripts/verify-mac-release.mjs", `--repo=${repo}`, `--tag=${tag}`, `--version=${version}`]);
  run("node", ["scripts/fix-mac-latest-zip.mjs"]);
  cleanupAppleDouble(releaseDir);

  const notesPath = join(releaseDir, "github-release-notes.md");
  writeFileSync(
    notesPath,
    [
      `# Agentlas Desktop ${version}`,
      "",
      "Verified cross-platform release.",
      "",
      "- Windows setup/portable and Linux AppImage/deb artifacts were staged before stable promotion.",
      "- Apple silicon and Intel DMGs are Developer ID signed, notarized, and Gatekeeper verified.",
      "- Requires macOS 12 Monterey or newer. macOS 11 Big Sur stays on the last compatible release and does not receive this automatic update.",
      "- Installs approved Agentlas firms from agentlas.cloud.",
      "- Runs with user-selected BYOK APIs or local CLI runtimes.",
      "",
      "Stable/latest promotion occurs only after all required platform installers, update feeds, and Mac verification evidence are present.",
      "Checksums and file sizes are in `desktop-release-verification.json`.",
      "",
    ].join("\n"),
  );
  cleanupAppleDouble(releaseDir);

  // The macOS runner is the single public writer.  It must own every byte in
  // the exact barrier contract rather than upload Mac files and poll for a
  // different writer that no longer exists.
  run("node", [
    "scripts/verify-release-assets.mjs",
    `--release-dir=${releaseDir}`,
    `--tag=${tag}`,
    `--version=${version}`,
    "--public-allowlist",
  ]);
  const publicFiles = publicReleaseAssetNames(version).map((name) => requireFile(join(releaseDir, name)));

  const initialState = createOrNormalizeStagingRelease({ repo, tag, version, notesPath, keepDraft });
  if (!initialState.isStable) {
    run("gh", ["release", "upload", tag, "--repo", repo, "--clobber", ...publicFiles], { stdio: "inherit" });
  }
  cleanupAppleDouble(releaseDir);

  // Fetch every staged asset from GitHub and compare its bytes with the local
  // manifest before any stable/latest mutation.  Listing names alone is not
  // release provenance and does not prove users receive the intended feeds.
  run("node", [
    "scripts/verify-release-assets.mjs",
    `--release-dir=${releaseDir}`,
    `--tag=${tag}`,
    `--version=${version}`,
    `--repo=${repo}`,
    "--verify-remote",
    "--public-allowlist",
  ]);

  // Verify the bytes that the staged release actually serves, not merely the
  // local artifacts we intended to upload. This gate runs before the release
  // can become stable/latest and also proves the new apps accept the previous
  // official app's designated requirement.
  run("node", [
    "scripts/verify-mac-update-lineage.mjs",
    `--repo=${repo}`,
    `--tag=${tag}`,
    `--version=${version}`,
    `--release-dir=${releaseDir}`,
    "--history-count=2",
  ]);

  const completeState = await waitForRequiredReleaseAssets({
    version,
    readState: () => readReleaseState({ repo, tag, version }),
    waitMs,
    pollMs,
    onWait: (state, remaining) => {
      console.log(
        `[release-stage] waiting up to ${Math.ceil(remaining / 1000)}s; ` +
        `missing=${state.missingAssets.join(", ") || "none"}; unexpected=${state.unexpectedAssets.join(", ") || "none"}`,
      );
    },
  });

  let promoted = false;
  if (!keepDraft) {
    // Always reassert --latest, including an idempotent retry after a prior
    // promotion whose final verification was interrupted.
    run("gh", [
      "release",
      "edit",
      tag,
      "--repo",
      repo,
      "--draft=false",
      "--prerelease=false",
      "--latest",
    ]);
    promoted = true;
  }

  const finalState = readReleaseState({ repo, tag, version });
  if (!finalState?.complete) {
    throw new Error(`Release ${tag} lost required assets before final state verification; stable promotion is blocked.`);
  }
  if (keepDraft) {
    if (finalState.isStable) throw new Error(`Release ${tag} became stable despite --draft.`);
  } else if (!finalState.isStable) {
    throw new Error(`Release ${tag} did not become stable/latest after complete asset verification.`);
  }
  if (!keepDraft) {
    const latestTag = readLatestStableTag(repo);
    if (latestTag !== tag) {
      throw new Error(`Release ${tag} is stable but latest still points to ${latestTag}; refusing a partial promotion receipt.`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    repo,
    tag,
    promoted,
    draft: keepDraft,
    requiredAssetCount: finalState.requiredAssets.length,
    uploaded: publicFiles.map((file) => basename(file)),
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
