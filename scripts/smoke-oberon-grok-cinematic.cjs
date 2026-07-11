#!/usr/bin/env node
// Oberon 시네마틱 몽타주 데모 — grok-imagine 로 3샷(샷별 카메라 무빙 + 초단위 안무 + 컷 전환).
// 프롬프트는 renderer/lib/oberon 문법(taxonomy/directing/prompt-craft)의 verbatim 어휘를 그대로 사용해
// composeShotPrompt 구조(framing + timed choreography + transition directive)를 손으로 재현한다.
const path = require("node:path");
const os = require("node:os");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");
app.on("window-all-closed", (e) => e.preventDefault());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 공통 주제: 새벽 서퍼 — 시네마틱 몽타주(intensify: ELS→MS→ECU, 점점 타이트하게).
const SUBJECT = "a lone surfer at dawn on a glassy ocean, wetsuit, backlit by a low golden sun, photorealistic, anamorphic film look, cinematic color grade";

const SHOTS = [
  {
    shotId: "s1",
    index: 0,
    durationSec: 4,
    aspectRatio: "16:9",
    // ELS + aerial + crane + 24mm, whip-pan exit
    prompt:
      `${SUBJECT}. Extreme long shot, vast wide establishing frame, subject tiny in the environment. ` +
      `Aerial drone shot, sweeping altitude. 24mm wide lens, deep focus. ` +
      `Timed choreography — [0.0-0.5s] establish framing; [0.5-3.4s] a sweeping crane move descending through the sea mist toward the surfer, parallax revealing the coastline; [3.4-4.0s] hold. ` +
      `Exit on a whip-pan blur to jump location. Golden-hour rim light, volumetric god rays over water.`,
    negativePrompt: "",
  },
  {
    shotId: "s2",
    index: 1,
    durationSec: 3,
    aspectRatio: "16:9",
    // MS + eye_level + tracking/push_in + handheld + 35mm, smash cut at peak
    prompt:
      `${SUBJECT}. Medium shot, subject from the waist up, paddling hard through the swell. Eye-level angle. ` +
      `Handheld camera with subtle organic shake, a slow continuous dolly push-in that tightens on the surfer, gaining intimacy toward the end. 35mm lens. ` +
      `Timed choreography — [0.0-0.4s] establish framing; [0.4-2.6s] tracking the paddle strokes, spray flicking off the arms; [2.6-3.0s] the wave face rises behind. ` +
      `End abruptly at peak energy for a hard smash cut. Crisp backlight, water droplets catching the sun.`,
    negativePrompt: "",
  },
  {
    shotId: "s3",
    index: 2,
    durationSec: 3,
    aspectRatio: "16:9",
    // ECU + orbit + 85mm, match cut out
    prompt:
      `${SUBJECT}. Extreme close-up, the surfer's eyes and salt-flecked face filling the frame, focused and calm. ` +
      `A steady arc orbiting around the subject, parallax revealing form and depth. 85mm portrait lens, shallow depth of field, creamy bokeh. ` +
      `Timed choreography — [0.0-0.4s] establish framing; [0.4-2.5s] the orbit sweeps past the eyeline as the first light hits the iris; [2.5-3.0s] camera settles on a clean, stable final frame. ` +
      `End on a shape/motion that the next shot can match-cut into. Soft golden key, glistening water on skin.`,
    negativePrompt: "",
  },
];

async function main() {
  const { startOberonRender, getOberonRenderJob } = require(path.join(root, "dist/electron/oberon/render.js"));
  const out = process.env.OUT || path.join(os.homedir(), "Desktop", "grok-cinematic-demo");
  const job = startOberonRender({
    productionId: "grok-cinematic-demo",
    title: "Grok Cinematic Demo",
    aspectRatio: "16:9",
    shots: SHOTS,
    maxShots: 3,
    takesPerShot: 1,
    provider: "grok-imagine",
    model: "runtime-default",
    resolution: "720p",
  });
  console.log(`JOB=${job.id} provider=${job.provider} clips=${job.progress.totalClips} outputDir=${job.outputDir}`);

  for (let i = 0; i < 900; i += 1) {
    await sleep(2000);
    const j = getOberonRenderJob(job.id);
    if (!j) continue;
    if (i % 5 === 0) console.log(`  [${i * 2}s] ${j.status}/${j.progress.phase} ${j.progress.completedClips}/${j.progress.totalClips} ${j.progress.percent}% shot=${j.progress.currentShotId || "-"}`);
    if (j.status === "succeeded") {
      const master = j.files.find((f) => f.kind === "master_mp4");
      const clips = j.files.filter((f) => f.kind === "clip_mp4");
      console.log(`SUCCESS clips=${clips.length} master=${master ? master.absPath : "(none)"} (${master ? master.sizeBytes : 0}b)`);
      if (j.warnings.length) console.log(`warnings: ${JSON.stringify(j.warnings)}`);
      console.log(`OUTPUT_DIR=${job.outputDir}`);
      if (master) console.log(`MASTER=${master.absPath}`);
      app.exit(master ? 0 : 1);
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
