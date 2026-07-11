#!/usr/bin/env node
// Oberon 풀 시네마틱 렌더(다중 샷) grok-imagine 프로바이더 라이브 스모크.
// UI "영상 생성"이 부르는 electron/oberon/render.ts(startOberonRender)를 그대로 구동한다.
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");
app.on("window-all-closed", (e) => e.preventDefault());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { startOberonRender, getOberonRenderJob } = require(path.join(root, "dist/electron/oberon/render.js"));
  const job = startOberonRender({
    productionId: "grok-render-smoke",
    title: "Grok Render Smoke",
    aspectRatio: "16:9",
    shots: [
      { shotId: "s1", index: 0, durationSec: 5, aspectRatio: "16:9", prompt: "Photorealistic: a cyclist rides along a coastal road at golden hour, waves crashing, cinematic wide shot." },
      { shotId: "s2", index: 1, durationSec: 5, aspectRatio: "16:9", prompt: "Photorealistic: close-up of the same cyclist's determined face, wind in hair, warm sunset light." },
    ],
    maxShots: 2,
    takesPerShot: 1,
    provider: "grok-imagine",
    model: "runtime-default",
    resolution: "720p",
  });
  console.log(`JOB=${job.id} provider=${job.provider} clips=${job.progress.totalClips}`);

  for (let i = 0; i < 700; i += 1) {
    await sleep(2000);
    const j = getOberonRenderJob(job.id);
    if (!j) continue;
    if (i % 5 === 0) console.log(`  [${i * 2}s] ${j.status}/${j.progress.phase} ${j.progress.completedClips}/${j.progress.totalClips} ${j.progress.percent}%`);
    if (j.status === "succeeded") {
      const clips = j.files.filter((f) => f.kind === "clip_mp4");
      const master = j.files.find((f) => f.kind === "master_mp4");
      console.log(`SUCCESS clips: ${clips.map((c) => `${c.name}(${c.sizeBytes}b)`).join(", ")}`);
      console.log(`master: ${master ? `${master.absPath} (${master.sizeBytes}b)` : "(none — ffmpeg missing)"}`);
      if (j.warnings.length) console.log(`warnings: ${JSON.stringify(j.warnings)}`);
      app.exit(clips.length ? 0 : 1);
      return;
    }
    if (j.status === "failed" || j.status === "cancelled") {
      console.log(`FAIL ${j.status} error=${j.error || "?"} warnings=${JSON.stringify(j.warnings)}`);
      app.exit(1);
      return;
    }
  }
  console.log("TIMEOUT");
  app.exit(1);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
