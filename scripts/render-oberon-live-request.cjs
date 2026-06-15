#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, shell } = require("electron");

const root = path.resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value) {
  return String(value || "").replace(/[A-Za-z0-9_.-]{24,}/g, "[redacted]");
}

async function copyDelivery(job, deliveryDir, request) {
  if (!deliveryDir) return null;
  await fs.mkdir(deliveryDir, { recursive: true });
  const copied = [];
  for (const file of job.files) {
    const target = path.join(deliveryDir, file.name);
    await fs.copyFile(file.absPath, target);
    copied.push({ ...file, absPath: target });
  }
  const manifestPath = path.join(deliveryDir, "oberon-render-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        title: request.title,
        productionId: request.productionId,
        provider: job.provider,
        model: job.model,
        outputDir: job.outputDir,
        deliveryDir,
        warnings: job.warnings,
        files: copied.map((file) => ({
          kind: file.kind,
          name: file.name,
          sizeBytes: file.sizeBytes,
          absPath: file.absPath,
        })),
        shots: request.shots.map((shot) => ({
          shotId: shot.shotId,
          durationSec: shot.durationSec,
          prompt: shot.prompt,
          negativePrompt: shot.negativePrompt,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  copied.push({ kind: "manifest", name: path.basename(manifestPath), absPath: manifestPath, sizeBytes: (await fs.stat(manifestPath)).size });
  return copied;
}

async function main() {
  if (process.env.OBERON_LIVE_VEO !== "1") {
    throw new Error("Set OBERON_LIVE_VEO=1 to run a live Google Veo render.");
  }
  const requestPath = process.env.OBERON_LIVE_REQUEST_FILE;
  if (!requestPath) throw new Error("Set OBERON_LIVE_REQUEST_FILE to a JSON render request.");

  const { readEnvVar } = require(path.join(root, "dist/electron/secrets/vault.js"));
  const { getOberonRenderJob, startOberonRender } = require(path.join(root, "dist/electron/oberon/render.js"));

  const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
  const hasCloudProject = Boolean(await readEnvVar("GOOGLE_CLOUD_PROJECT"));
  const hasGemini = Boolean(await readEnvVar("GEMINI_API_KEY"));
  const hasGoogle = Boolean(await readEnvVar("GOOGLE_API_KEY"));
  console.log(`GOOGLE_CLOUD_PROJECT=${hasCloudProject ? "present" : "missing"}`);
  console.log(`GEMINI_API_KEY=${hasGemini ? "present" : "missing"}`);
  console.log(`GOOGLE_API_KEY=${hasGoogle ? "present" : "missing"}`);
  if (!hasCloudProject && !hasGemini && !hasGoogle) {
    throw new Error("Missing Google Cloud project or Google API key in Agentlas env vault.");
  }

  const job = startOberonRender(request);
  console.log(`JOB=${job.id}`);
  console.log(`OUT_DIR=${job.outputDir}`);

  const maxPolls = Number(process.env.OBERON_LIVE_MAX_POLLS || 144);
  const pollMs = Number(process.env.OBERON_LIVE_POLL_MS || 5000);
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollMs);
    const current = getOberonRenderJob(job.id);
    if (!current) throw new Error("Render job disappeared.");
    console.log(
      `POLL status=${current.status} phase=${current.progress.phase} clips=${current.progress.completedClips}/${current.progress.totalClips} percent=${current.progress.percent}`,
    );
    if (current.status === "succeeded") {
      const deliveryFiles = await copyDelivery(current, process.env.OBERON_LIVE_DELIVERY_DIR, request);
      for (const file of current.files) {
        console.log(`FILE kind=${file.kind} name=${file.name} bytes=${file.sizeBytes}`);
      }
      if (deliveryFiles) {
        for (const file of deliveryFiles) {
          console.log(`DELIVERY kind=${file.kind} name=${file.name} path=${file.absPath} bytes=${file.sizeBytes}`);
        }
        if (process.env.OBERON_LIVE_OPEN_DELIVERY === "1") await shell.openPath(process.env.OBERON_LIVE_DELIVERY_DIR);
      }
      if (!current.files.some((file) => file.kind === "master_mp4")) throw new Error("Missing master MP4.");
      if (!current.files.some((file) => file.kind === "master_mov")) throw new Error("Missing master MOV.");
      if (!current.files.some((file) => file.kind === "master_wav")) throw new Error("Missing master WAV.");
      if (current.warnings.length) console.log(`WARNINGS=${current.warnings.map(sanitize).join(" | ")}`);
      return;
    }
    if (current.status === "failed" || current.status === "cancelled") {
      const warningText = current.warnings.length ? ` warnings=${current.warnings.map(sanitize).join(" | ")}` : "";
      const clipText = current.clips
        .filter((clip) => clip.error)
        .map((clip) => `${clip.shotId}:${sanitize(clip.error)}`)
        .join(" | ");
      throw new Error(`${current.status}: ${sanitize(current.error || current.message)}${warningText}${clipText ? ` clips=${clipText}` : ""}`);
    }
  }

  throw new Error("Timed out waiting for Oberon live render.");
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(sanitize(error?.stack || error));
    app.exit(1);
  });
