#!/usr/bin/env node
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { getOberonMotionAdJob, startOberonMotionAd } = require(path.join(
    root,
    "dist/electron/oberon/motion-graphics.js",
  ));
  const job = startOberonMotionAd({
    productionId: `oberon-motion-smoke-${Date.now()}`,
    title: process.env.OBERON_MOTION_TITLE || "Agentlas Motion Ad",
    brand: "Agentlas",
    concept:
      "Agentlas turns scattered prompts, agents, images, and folders into a local production operating system.",
    aspectRatio: process.env.OBERON_MOTION_ASPECT === "9:16" ? "9:16" : "16:9",
    durationSec: Number(process.env.OBERON_MOTION_DURATION || 30),
    fps: Number(process.env.OBERON_MOTION_FPS || 15),
    outputDir: process.env.OBERON_MOTION_OUTPUT_DIR || undefined,
  });

  console.log(`JOB=${job.id}`);
  console.log(`OUT_DIR=${job.outputDir}`);

  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    const current = getOberonMotionAdJob(job.id);
    if (!current) throw new Error("Motion ad job disappeared.");
    console.log(
      `POLL status=${current.status} phase=${current.progress.phase} frames=${current.progress.completedFrames}/${current.progress.totalFrames} percent=${current.progress.percent}`,
    );
    if (current.status === "succeeded") {
      for (const file of current.files) {
        console.log(`FILE kind=${file.kind} name=${file.name} bytes=${file.sizeBytes} path=${file.absPath}`);
      }
      if (!current.files.some((file) => file.kind === "motion_mp4")) throw new Error("Missing motion MP4.");
      if (!current.files.some((file) => file.kind === "html_preview")) throw new Error("Missing HTML preview.");
      return;
    }
    if (current.status === "failed" || current.status === "cancelled") {
      throw new Error(`${current.status}: ${current.error || current.message}`);
    }
  }

  throw new Error("Timed out waiting for Oberon motion ad render.");
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
