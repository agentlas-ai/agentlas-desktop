#!/usr/bin/env node
// Live end-to-end proof for the exact Oberon model-stack selections:
// Grok CLI image (Imagine) -> Grok CLI video (Imagine) -> assembled delivery.
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on("window-all-closed", (event) => event.preventDefault());

async function waitFor(read, label, timeoutMs = 20 * 60_000) {
  const started = Date.now();
  let previous = "";
  while (Date.now() - started < timeoutMs) {
    const job = read();
    if (job) {
      const state = `${job.status}/${job.progress.phase}/${job.progress.percent}`;
      if (state !== previous) console.log(`${label}: ${state}% ${job.message}`);
      previous = state;
      if (job.status === "succeeded") return job;
      if (job.status === "failed" || job.status === "cancelled") {
        throw new Error(`${label} ${job.status}: ${job.error || job.message}`);
      }
    }
    await sleep(1000);
  }
  throw new Error(`${label} timed out`);
}

async function main() {
  const { animateKeyStatus } = require(path.join(root, "dist/electron/oberon/animate.js"));
  const { startOberonKeyframes, getOberonKeyframeJob } = require(path.join(root, "dist/electron/oberon/keyframes.js"));
  const { startOberonRender, getOberonRenderJob } = require(path.join(root, "dist/electron/oberon/render.js"));

  const readiness = await animateKeyStatus();
  if (!readiness.grok) throw new Error("Grok CLI OAuth media readiness is false");

  const productionId = `grok-stack-smoke-${Date.now()}`;
  const title = "Grok Stack Live Proof";
  const visual =
    "A cinematic close shot of a small chrome robot standing on a rain-slick Seoul rooftop at blue hour, teal and amber practical lights, photoreal, consistent character design, no text.";
  const keyframe = startOberonKeyframes({
    productionId,
    title,
    aspectRatio: "16:9",
    provider: "grok-cli-image",
    model: "grok-imagine-image",
    maxShots: 1,
    shots: [{ shotId: "shot-001", index: 0, aspectRatio: "16:9", prompt: visual, cameraSize: "close-up" }],
  });
  const keyframeDone = await waitFor(() => getOberonKeyframeJob(keyframe.id), "keyframe", 8 * 60_000);
  const image = keyframeDone.assets[0];
  if (!image?.absPath) throw new Error("Grok keyframe completed without an image asset");
  console.log(`KEYFRAME=${image.absPath}`);

  const render = startOberonRender({
    productionId,
    title,
    aspectRatio: "16:9",
    provider: "grok-cli-video",
    model: "grok-imagine-video",
    maxShots: 1,
    takesPerShot: 1,
    resolution: "720p",
    shots: [{
      shotId: "shot-001",
      index: 0,
      durationSec: 4,
      aspectRatio: "16:9",
      prompt: `${visual} The robot slowly raises its head as rain falls; subtle cinematic push-in and natural reflections.`,
      firstFrame: { absPath: image.absPath, mimeType: image.mime },
    }],
  });
  const renderDone = await waitFor(() => getOberonRenderJob(render.id), "video");
  const clip = renderDone.files.find((file) => file.kind === "clip_mp4");
  const master = renderDone.files.find((file) => file.kind === "master_mp4");
  if (!clip?.absPath) throw new Error("Grok render completed without a video clip");
  console.log(`CLIP=${clip.absPath}`);
  console.log(`MASTER=${master?.absPath || "(ffmpeg delivery unavailable)"}`);
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
