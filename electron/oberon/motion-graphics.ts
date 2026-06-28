import { app, BrowserWindow, shell } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  OberonMotionAdFile,
  OberonMotionAdJob,
  OberonMotionAdRequest,
} from "../../shared/types";

const execFileAsync = promisify(execFile);
const DEFAULT_DURATION = 30;
const DEFAULT_FPS = 15;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

const jobs = new Map<string, OberonMotionAdJob>();
const cancelledJobs = new Set<string>();

class MotionAdCancelled extends Error {
  constructor() {
    super("Motion ad render cancelled");
  }
}

export function startOberonMotionAd(request: OberonMotionAdRequest): OberonMotionAdJob {
  const id = randomUUID();
  const width = evenInt(request.width ?? (request.aspectRatio === "9:16" ? 720 : DEFAULT_WIDTH), 320, 3840);
  const height = evenInt(request.height ?? (request.aspectRatio === "9:16" ? 1280 : DEFAULT_HEIGHT), 320, 3840);
  const durationSec = evenDuration(request.durationSec ?? DEFAULT_DURATION);
  const fps = clampInt(request.fps ?? DEFAULT_FPS, 8, 30);
  const title = (request.title || "Agentlas Motion Ad").trim();
  const brand = (request.brand || "Agentlas").trim();
  const outputDir =
    request.outputDir && path.isAbsolute(request.outputDir)
      ? request.outputDir
      : path.join(app.getPath("userData"), "oberon-motion", `${safeSlug(title)}-${id.slice(0, 8)}`);
  const now = Date.now();
  const job: OberonMotionAdJob = {
    id,
    productionId: request.productionId,
    title,
    brand,
    status: "queued",
    outputDir,
    progress: {
      phase: "queued",
      totalFrames: Math.max(1, Math.round(durationSec * fps)),
      completedFrames: 0,
      percent: 0,
    },
    files: [],
    message: "모션그래픽 렌더 준비 중",
    warnings: [],
    durationSec,
    fps,
    width,
    height,
    createdAtMs: now,
    updatedAtMs: now,
  };
  jobs.set(id, job);
  void runMotionAdJob(id, request).catch((error: unknown) => failJob(id, error));
  return snapshot(job);
}

export function getOberonMotionAdJob(id: string): OberonMotionAdJob | null {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function cancelOberonMotionAd(id: string): OberonMotionAdJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  cancelledJobs.add(id);
  job.status = "cancelled";
  job.progress.phase = "cancelled";
  job.message = "모션그래픽 렌더 취소됨";
  job.updatedAtMs = Date.now();
  return snapshot(job);
}

export async function openOberonMotionAdOutput(id: string): Promise<{ ok: boolean; message: string }> {
  const job = jobs.get(id);
  if (!job) return { ok: false, message: "Motion ad job not found." };
  await fs.mkdir(job.outputDir, { recursive: true });
  const result = await shell.openPath(job.outputDir);
  return result ? { ok: false, message: result } : { ok: true, message: job.outputDir };
}

async function runMotionAdJob(id: string, request: OberonMotionAdRequest): Promise<void> {
  const job = requireJob(id);
  await fs.mkdir(job.outputDir, { recursive: true });
  const framesDir = path.join(job.outputDir, "frames");
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const htmlPath = path.join(job.outputDir, "agentlas_motion_ad_preview.html");
  const promptPackPath = path.join(job.outputDir, "agentlas_motion_ad_prompt_pack.md");
  const manifestPath = path.join(job.outputDir, "agentlas_motion_ad_manifest.json");
  const mp4Path = path.join(job.outputDir, "agentlas_motion_ad.mp4");

  await fs.writeFile(htmlPath, buildMotionAdHtml(job, request), "utf8");
  await fs.writeFile(promptPackPath, buildPromptPack(job, request), "utf8");

  job.files.push(await makeFile("html_preview", "HTML preview", htmlPath, "text/html"));
  job.files.push(await makeFile("prompt_pack", "Prompt pack", promptPackPath, "text/markdown"));
  updateJob(job, "running", "rendering_frames", 0, "Chromium 프레임 렌더 중");

  await renderFramesWithElectron(job, htmlPath, framesDir);
  assertNotCancelled(job.id);

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not found. Install ffmpeg to encode the motion ad MP4.");
  updateJob(job, "running", "encoding", job.progress.totalFrames, "프레임을 MP4로 인코딩 중");
  await runFfmpeg(ffmpeg, [
    "-y",
    "-framerate",
    String(job.fps),
    "-start_number",
    "0",
    "-i",
    path.join(framesDir, "frame_%04d.png"),
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t",
    String(job.durationSec),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    mp4Path,
  ]);

  job.files.push(await makeFile("motion_mp4", "Motion MP4", mp4Path, "video/mp4"));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        id: job.id,
        title: job.title,
        brand: job.brand,
        durationSec: job.durationSec,
        fps: job.fps,
        width: job.width,
        height: job.height,
        renderEngine: "Electron Chromium frame capture + ffmpeg",
        noVideoApi: true,
        files: job.files.map((file) => ({
          kind: file.kind,
          name: file.name,
          sizeBytes: file.sizeBytes,
        })),
        createdAtMs: job.createdAtMs,
      },
      null,
      2,
    ),
    "utf8",
  );
  job.files.push(await makeFile("manifest_json", "Render manifest", manifestPath, "application/json"));
  updateJob(job, "succeeded", "complete", job.progress.totalFrames, "모션그래픽 렌더 완료");
}

async function renderFramesWithElectron(job: OberonMotionAdJob, htmlPath: string, framesDir: string): Promise<void> {
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: job.width,
      height: job.height,
      useContentSize: true,
      backgroundColor: "#f7f7f2",
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(htmlPath);
    await wait(120);
    for (let frame = 0; frame < job.progress.totalFrames; frame += 1) {
      assertNotCancelled(job.id);
      await win.webContents.executeJavaScript(
        `window.__oberonSetFrame(${frame}, ${job.fps}, ${job.durationSec})`,
        true,
      );
      const image = await win.webContents.capturePage();
      await fs.writeFile(path.join(framesDir, `frame_${String(frame).padStart(4, "0")}.png`), image.toPNG());
      if (frame % 5 === 0 || frame === job.progress.totalFrames - 1) {
        updateJob(job, "running", "rendering_frames", frame + 1, `프레임 ${frame + 1}/${job.progress.totalFrames}`);
      }
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

function buildMotionAdHtml(job: OberonMotionAdJob, request: OberonMotionAdRequest): string {
  const config = {
    title: job.title,
    brand: job.brand,
    concept:
      request.concept ||
      "Agentlas turns scattered prompts, agents, and local files into a production operating system.",
    width: job.width,
    height: job.height,
  };
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(job.title)} preview</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #f7f7f2; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    #frame { position: relative; width: ${job.width}px; height: ${job.height}px; overflow: hidden; background: #f7f7f2; color: #101820; }
    .grain { position: absolute; inset: 0; opacity: .18; background-image: linear-gradient(90deg, rgba(16,24,32,.055) 1px, transparent 1px), linear-gradient(rgba(16,24,32,.04) 1px, transparent 1px); background-size: 32px 32px; }
    .wash { position: absolute; inset: -12%; background: radial-gradient(circle at 18% 24%, rgba(14,106,102,.18), transparent 28%), radial-gradient(circle at 82% 76%, rgba(212,87,69,.12), transparent 28%), linear-gradient(135deg, #f7f7f2 0%, #eef2ed 52%, #f6f1e8 100%); }
    .topline { position: absolute; top: 36px; left: 52px; display: flex; align-items: center; gap: 12px; font-size: 22px; font-weight: 760; color: #12212b; }
    .mark { width: 26px; height: 26px; border-radius: 7px; background: #10242b; position: relative; box-shadow: inset 0 0 0 2px rgba(255,255,255,.16); }
    .mark::after { content: ""; position: absolute; inset: 7px; border-radius: 3px; border: 2px solid #f5f6ef; border-top-color: #28a39a; }
    .subbrand { font-size: 12px; font-weight: 720; color: rgba(16,24,32,.48); text-transform: uppercase; }
    .headline { position: absolute; left: 70px; top: 138px; width: 560px; font-size: 58px; line-height: .96; font-weight: 830; color: #101820; transform-origin: left center; }
    .headline .accent { color: #0e6a66; }
    .subline { position: absolute; left: 74px; top: 330px; width: 510px; font-size: 20px; line-height: 1.34; font-weight: 560; color: rgba(16,24,32,.68); }
    .cta { position: absolute; left: 74px; top: 488px; display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 17px; border-radius: 9px; background: #101820; color: #f7f7f2; font-size: 15px; font-weight: 760; box-shadow: 0 18px 40px rgba(16,24,32,.18); }
    .cta i { width: 8px; height: 8px; border-radius: 50%; background: #28a39a; }
    .desktop { position: absolute; right: 62px; top: 114px; width: 540px; height: 384px; border-radius: 20px; background: rgba(255,255,255,.88); border: 1px solid rgba(16,24,32,.12); box-shadow: 0 32px 90px rgba(16,24,32,.22); overflow: hidden; }
    .bar { height: 42px; display: flex; align-items: center; padding: 0 18px; gap: 8px; background: #13242b; color: rgba(255,255,255,.82); font-size: 12px; font-weight: 720; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #d45745; }
    .dot:nth-child(2) { background: #c79b39; }
    .dot:nth-child(3) { background: #28a39a; margin-right: 10px; }
    .lanes { position: absolute; left: 18px; right: 18px; top: 66px; bottom: 22px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .tile { border-radius: 14px; border: 1px solid rgba(16,24,32,.09); background: #fbfbf6; padding: 16px; position: relative; overflow: hidden; }
    .tile h3 { margin: 0 0 8px; font-size: 15px; line-height: 1.1; color: #101820; }
    .tile p { margin: 0; font-size: 11.5px; line-height: 1.45; color: rgba(16,24,32,.56); }
    .tile .meter { position: absolute; left: 16px; right: 16px; bottom: 16px; height: 7px; border-radius: 999px; background: rgba(16,24,32,.08); overflow: hidden; }
    .tile .meter span { display: block; height: 100%; width: 0%; background: #0e6a66; border-radius: 999px; }
    .prompt { position: absolute; min-width: 128px; height: 36px; padding: 0 14px; border-radius: 999px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.84); border: 1px solid rgba(16,24,32,.12); color: rgba(16,24,32,.74); font-size: 12px; font-weight: 730; box-shadow: 0 12px 30px rgba(16,24,32,.11); }
    .folder { position: absolute; right: 98px; bottom: 58px; width: 230px; height: 130px; border-radius: 16px; background: #10242b; color: #f7f7f2; box-shadow: 0 26px 60px rgba(16,24,32,.25); overflow: hidden; }
    .folder::before { content: ""; position: absolute; left: 0; top: 0; width: 92px; height: 28px; border-radius: 0 0 14px 0; background: #28a39a; }
    .folder strong { position: absolute; left: 20px; top: 48px; font-size: 18px; }
    .folder small { position: absolute; left: 20px; top: 78px; font-size: 12px; line-height: 1.35; color: rgba(247,247,242,.7); }
    .timeline { position: absolute; left: 74px; bottom: 48px; width: 610px; height: 8px; border-radius: 999px; background: rgba(16,24,32,.12); overflow: hidden; }
    .timeline span { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #0e6a66, #d45745); border-radius: 999px; }
  </style>
</head>
<body>
  <div id="frame">
    <div class="wash"></div>
    <div class="grain"></div>
    <div class="topline"><span class="mark"></span><span id="brandText">Agentlas</span><span class="subbrand">local production OS</span></div>
    <div id="headline" class="headline">Prompt chaos<br><span class="accent">into production.</span></div>
    <div id="subline" class="subline">Turn briefs, agents, images, prompts, and output folders into one controlled desktop workflow.</div>
    <div id="cta" class="cta"><i></i><span>Build agents as apps</span></div>
    <div id="desktop" class="desktop">
      <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>Oberon · Motion Ads</div>
      <div class="lanes">
        <div class="tile" id="tile1"><h3>Plan</h3><p>Prompt pack, beats, CTA, assets.</p><div class="meter"><span></span></div></div>
        <div class="tile" id="tile2"><h3>Compose</h3><p>Typography, UI panels, product proof.</p><div class="meter"><span></span></div></div>
        <div class="tile" id="tile3"><h3>Render</h3><p>Chromium frames to ffmpeg MP4.</p><div class="meter"><span></span></div></div>
        <div class="tile" id="tile4"><h3>Export</h3><p>HTML preview, MP4, manifest, notes.</p><div class="meter"><span></span></div></div>
      </div>
    </div>
    <div id="folder" class="folder"><strong>export folder</strong><small>Paste-ready prompts<br>motion preview<br>MP4 delivery</small></div>
    <div id="timeline" class="timeline"><span></span></div>
    <div id="prompts"></div>
  </div>
  <script>
    const CONFIG = ${configJson};
    const labels = ["brief", "agent", "image", "prompt", "folder", "render", "QA", "publish"];
    const points = [[720,92],[880,82],[1070,92],[1120,510],[860,578],[652,545],[1000,606],[1168,302]];
    const promptRoot = document.getElementById("prompts");
    const pills = labels.map((label, i) => {
      const el = document.createElement("div");
      el.className = "prompt";
      el.textContent = label;
      el.style.left = points[i][0] + "px";
      el.style.top = points[i][1] + "px";
      promptRoot.appendChild(el);
      return el;
    });
    const headline = document.getElementById("headline");
    const subline = document.getElementById("subline");
    const desktop = document.getElementById("desktop");
    const folder = document.getElementById("folder");
    const cta = document.getElementById("cta");
    const timeline = document.querySelector("#timeline span");
    document.getElementById("brandText").textContent = CONFIG.brand;
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function ease(x) { x = clamp(x, 0, 1); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
    function seg(t, a, b) { return ease((t - a) / (b - a)); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function show(el, v) { el.style.opacity = String(clamp(v, 0, 1)); }
    window.__oberonSetFrame = function(frame, fps, duration) {
      const t = frame / fps;
      const p = clamp(t / duration, 0, 1);
      timeline.style.width = (p * 100).toFixed(2) + "%";
      const chaos = 1 - seg(t, 2.8, 8.0);
      const organize = seg(t, 4.2, 9.0);
      const proof = seg(t, 9.5, 18.0);
      const exportBeat = seg(t, 18.0, 24.0);
      const endBeat = seg(t, 24.0, 29.0);
      if (t < 8.2) {
        headline.innerHTML = "Prompt chaos<br><span class='accent'>into production.</span>";
        subline.textContent = "Turn briefs, agents, images, prompts, and output folders into one controlled desktop workflow.";
      } else if (t < 17.5) {
        headline.innerHTML = "Oberon plans.<br><span class='accent'>Agentlas executes.</span>";
        subline.textContent = "No video API required for this lane: code motion, local frames, and an export folder your team can reuse.";
      } else if (t < 24) {
        headline.innerHTML = "A folder, not<br><span class='accent'>a dead prompt.</span>";
        subline.textContent = "Ship an MP4, HTML preview, manifest, and paste-ready production notes from the desktop.";
      } else {
        headline.innerHTML = "Agentlas.<br><span class='accent'>Build agents as apps.</span>";
        subline.textContent = CONFIG.concept;
      }
      headline.style.transform = "translateY(" + lerp(24, 0, seg(t, 0, 1.2)).toFixed(2) + "px) scale(" + lerp(.96, 1, endBeat < .5 ? seg(t, 0, 1.2) : endBeat * .03 + 1).toFixed(3) + ")";
      desktop.style.transform = "translate(" + lerp(120, 0, organize).toFixed(2) + "px," + lerp(22, -20, endBeat).toFixed(2) + "px) scale(" + lerp(.86, .95, proof).toFixed(3) + ")";
      show(desktop, seg(t, 1.4, 3.2) * (1 - seg(t, 27.5, 29.5) * .18));
      folder.style.transform = "translateY(" + lerp(90, 0, exportBeat).toFixed(2) + "px) scale(" + lerp(.88, 1, exportBeat).toFixed(3) + ")";
      show(folder, exportBeat * (1 - endBeat * .55));
      cta.style.transform = "translateY(" + lerp(36, 0, seg(t, 2.0, 4.2)).toFixed(2) + "px)";
      show(cta, seg(t, 2.0, 4.2));
      document.querySelectorAll(".meter span").forEach((m, i) => {
        const local = seg(t, 7 + i * 2.2, 10.4 + i * 2.2);
        m.style.width = Math.round(local * 100) + "%";
      });
      pills.forEach((el, i) => {
        const a = points[i];
        const targetX = 688 + (i % 4) * 128;
        const targetY = 150 + Math.floor(i / 4) * 62;
        const wobble = Math.sin(t * 1.8 + i * 1.7) * 26 * chaos;
        const x = lerp(a[0] + wobble, targetX, organize);
        const y = lerp(a[1] + Math.cos(t * 1.5 + i) * 18 * chaos, targetY, organize);
        el.style.transform = "translate(" + (x - a[0]).toFixed(2) + "px," + (y - a[1]).toFixed(2) + "px) scale(" + lerp(1, .84, organize).toFixed(3) + ")";
        show(el, clamp(chaos + organize * .72 - endBeat * .55, 0, 1));
      });
    };
    window.__oberonSetFrame(0, ${job.fps}, ${job.durationSec});
  </script>
</body>
</html>`;
}

function buildPromptPack(job: OberonMotionAdJob, request: OberonMotionAdRequest): string {
  return `# ${job.title}

Local motion graphics ad package for ${job.brand}.

## Render Lane
- Engine: Electron Chromium frame capture + ffmpeg
- Duration: ${job.durationSec}s
- FPS: ${job.fps}
- Canvas: ${job.width}x${job.height}
- Video API: not used

## Creative Beats
1. Prompt chaos, scattered assets, and model choices.
2. Agentlas Desktop turns the mess into lanes.
3. Oberon Motion Ads composes product proof with deterministic typography.
4. Export folder ships MP4, HTML preview, manifest, and paste-ready notes.
5. CTA: Build agents as apps.

## Source Concept
${request.concept || "Agentlas turns scattered prompts, agents, and local files into a production operating system."}
`;
}

async function makeFile(
  kind: OberonMotionAdFile["kind"],
  label: string,
  absPath: string,
  mime: string,
): Promise<OberonMotionAdFile> {
  const stat = await fs.stat(absPath);
  return {
    id: randomUUID(),
    kind,
    name: path.basename(absPath),
    label,
    absPath,
    url: pathToFileURL(absPath).href,
    mime,
    sizeBytes: stat.size,
  };
}

function updateJob(
  job: OberonMotionAdJob,
  status: OberonMotionAdJob["status"],
  phase: OberonMotionAdJob["progress"]["phase"],
  completedFrames: number,
  message: string,
): void {
  job.status = status;
  job.progress.phase = phase;
  job.progress.completedFrames = Math.max(0, Math.min(completedFrames, job.progress.totalFrames));
  job.progress.percent =
    phase === "encoding"
      ? 92
      : phase === "complete"
        ? 100
        : Math.round((job.progress.completedFrames / Math.max(1, job.progress.totalFrames)) * 88);
  job.message = message;
  job.updatedAtMs = Date.now();
}

function failJob(id: string, error: unknown): void {
  const job = jobs.get(id);
  if (!job) return;
  if (cancelledJobs.has(id) || error instanceof MotionAdCancelled) {
    job.status = "cancelled";
    job.progress.phase = "cancelled";
    job.message = "모션그래픽 렌더 취소됨";
  } else {
    job.status = "failed";
    job.progress.phase = "failed";
    job.progress.percent = Math.max(job.progress.percent, 1);
    job.error = errorMessage(error);
    job.message = job.error;
  }
  job.updatedAtMs = Date.now();
}

function requireJob(id: string): OberonMotionAdJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Motion ad job not found: ${id}`);
  return job;
}

function assertNotCancelled(id: string): void {
  if (cancelledJobs.has(id)) throw new MotionAdCancelled();
}

function snapshot(job: OberonMotionAdJob): OberonMotionAdJob {
  return {
    ...job,
    progress: { ...job.progress },
    files: job.files.map((file) => ({ ...file })),
    warnings: [...job.warnings],
  };
}

async function findFfmpeg(): Promise<string | null> {
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]) {
    if (candidate.includes(path.sep)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return candidate;
  }
  return null;
}

async function runFfmpeg(bin: string, args: string[]): Promise<void> {
  await execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 16 });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evenInt(value: number, min: number, max: number): number {
  const n = Math.max(min, Math.min(max, Math.round(value)));
  return n % 2 === 0 ? n : n + 1;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function evenDuration(value: number): number {
  return Math.max(6, Math.min(60, Math.round(value)));
}

function safeSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/[^\w가-힣-]+/g, "_")
      .replace(/_{2,}/g, "_")
      .slice(0, 48) || "motion_ad"
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
