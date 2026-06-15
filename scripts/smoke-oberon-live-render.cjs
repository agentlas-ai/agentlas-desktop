#!/usr/bin/env node
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value) {
  return String(value || "").replace(/[A-Za-z0-9_.-]{24,}/g, "[redacted]");
}

async function main() {
  if (process.env.OBERON_LIVE_VEO !== "1") {
    throw new Error("Set OBERON_LIVE_VEO=1 to run the live Google Veo smoke.");
  }

  const { readEnvVar } = require(path.join(root, "dist/electron/secrets/vault.js"));
  const { getOberonRenderJob, startOberonRender } = require(path.join(root, "dist/electron/oberon/render.js"));

  const hasGemini = Boolean(await readEnvVar("GEMINI_API_KEY"));
  const hasGoogle = Boolean(await readEnvVar("GOOGLE_API_KEY"));
  console.log(`GEMINI_API_KEY=${hasGemini ? "present" : "missing"}`);
  console.log(`GOOGLE_API_KEY=${hasGoogle ? "present" : "missing"}`);
  if (!hasGemini && !hasGoogle) {
    throw new Error("Missing GEMINI_API_KEY or GOOGLE_API_KEY in Agentlas env vault.");
  }

  const job = startOberonRender({
    productionId: `oberon-live-smoke-${Date.now()}`,
    title: "Oberon Live Smoke",
    aspectRatio: "16:9",
    maxShots: Number(process.env.OBERON_LIVE_MAX_SHOTS || 2),
    takesPerShot: 1,
    provider: process.env.OBERON_LIVE_PROVIDER || "google-gemini-veo",
    model: process.env.OBERON_LIVE_MODEL || "veo-3.1-fast-generate-preview",
    resolution: "720p",
    shots: [
      {
        shotId: "SH_001",
        index: 0,
        durationSec: 4,
        aspectRatio: "16:9",
        providerId: "google-veo",
        providerMode: "text_to_video",
        prompt:
          "A cinematic product film shot of a premium glass perfume bottle on wet black stone at night. Indigo accent light, cool neutral palette, slow macro push-in, rain reflections, luxury commercial lighting, no text, no watermark.",
        negativePrompt: "subtitles, watermark, logo text, distorted text, low quality",
      },
      {
        shotId: "SH_002",
        index: 1,
        durationSec: 4,
        aspectRatio: "16:9",
        providerId: "google-veo",
        providerMode: "text_to_video",
        prompt:
          "A cinematic close product shot: the perfume bottle turns slightly as mist moves across a polished surface. Soft rim light, shallow depth of field, elegant ad-film motion, 16:9 composition, no logo text, no watermark.",
        negativePrompt: "subtitles, watermark, logo text, distorted text, low quality",
      },
      {
        shotId: "SH_003",
        index: 2,
        durationSec: 4,
        aspectRatio: "16:9",
        providerId: "google-veo",
        providerMode: "text_to_video",
        prompt:
          "A final luxury advertising pack shot: the perfume bottle stands centered while rain ripples reflect a single indigo light. Slow elegant dolly-out, cinematic realism, polished commercial finish, no text, no watermark.",
        negativePrompt: "subtitles, watermark, logo text, distorted text, low quality",
      },
    ],
  });

  console.log(`JOB=${job.id}`);
  console.log(`OUT_DIR=${job.outputDir}`);

  for (let i = 0; i < 96; i += 1) {
    await sleep(5000);
    const current = getOberonRenderJob(job.id);
    if (!current) throw new Error("Render job disappeared.");
    console.log(
      `POLL status=${current.status} phase=${current.progress.phase} clips=${current.progress.completedClips}/${current.progress.totalClips} percent=${current.progress.percent}`,
    );
    if (current.status === "succeeded") {
      for (const file of current.files) {
        console.log(`FILE kind=${file.kind} name=${file.name} bytes=${file.sizeBytes}`);
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
