#!/usr/bin/env node
// Oberon 애니메이트(image-to-video) grok 프로바이더 라이브 스모크.
// UI "애니메이션 생성" 버튼이 호출하는 바로 그 백엔드(electron/oberon/animate.ts)를 구동한다:
//   animateKeyStatus() → grok 준비 확인 → startOberonAnimate({provider:"grok"}) → 폴링.
// 실행: OBERON_GROK_KEYFRAME=<jpg> electron scripts/smoke-oberon-grok-animate.cjs
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");
app.on("window-all-closed", (e) => e.preventDefault());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { animateKeyStatus, startOberonAnimate, getOberonAnimateJob } = require(
    path.join(root, "dist/electron/oberon/animate.js"),
  );

  const keys = await animateKeyStatus();
  console.log("animateKeyStatus:", JSON.stringify(keys));
  if (!keys.grok) {
    console.log("FAIL: grok provider not ready (grok CLI 미설치/미로그인)");
    app.exit(1);
    return;
  }

  const keyframe = process.env.OBERON_GROK_KEYFRAME;
  if (!keyframe) {
    console.log("FAIL: OBERON_GROK_KEYFRAME(입력 이미지 절대경로) 미지정");
    app.exit(1);
    return;
  }

  const job = startOberonAnimate({
    productionId: `oberon-grok-smoke-${Date.now()}`,
    title: "Grok Imagine Animate Smoke",
    provider: "grok",
    imagePath: keyframe,
    prompt: "slow cinematic camera push-in, gentle motion, natural physics",
    aspectRatio: "16:9",
    durationSec: 6,
  });
  console.log(`JOB=${job.id} provider=${job.provider} model=${job.model}`);

  let last = job;
  for (let i = 0; i < 600; i += 1) {
    await sleep(1000);
    const cur = getOberonAnimateJob(job.id);
    if (!cur) continue;
    if (cur.progress.phase !== last.progress.phase || cur.status !== last.status) {
      console.log(`  [${i}s] status=${cur.status} phase=${cur.progress.phase} ${cur.percent ?? cur.progress.percent}% ${cur.message}`);
    }
    last = cur;
    if (cur.status === "succeeded") {
      const mp4 = (cur.files || []).find((f) => f.kind === "animation_mp4");
      console.log("SUCCESS mp4:", mp4 ? `${mp4.absPath} (${mp4.sizeBytes} bytes)` : "(no file!)");
      app.exit(mp4 ? 0 : 1);
      return;
    }
    if (cur.status === "failed" || cur.status === "cancelled") {
      console.log(`FAIL status=${cur.status} error=${cur.error || "?"}`);
      app.exit(1);
      return;
    }
  }
  console.log("FAIL: timed out after 600s");
  app.exit(1);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
