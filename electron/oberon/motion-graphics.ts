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
import { currentUiLocale } from "../main";

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
  const ko = currentUiLocale() === "ko";
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
    message: ko ? "모션그래픽 렌더 준비 중" : "Preparing the motion graphics render",
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
  const ko = currentUiLocale() === "ko";
  cancelledJobs.add(id);
  job.status = "cancelled";
  job.progress.phase = "cancelled";
  job.message = ko ? "모션그래픽 렌더 취소됨" : "Motion graphics render cancelled";
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
  const ko = currentUiLocale() === "ko";
  const job = requireJob(id);
  await fs.mkdir(job.outputDir, { recursive: true });
  const framesDir = path.join(job.outputDir, "frames");
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const htmlPath = path.join(job.outputDir, "agentlas_motion_ad_preview.html");
  const promptPackPath = path.join(job.outputDir, "agentlas_motion_ad_prompt_pack.md");
  const manifestPath = path.join(job.outputDir, "agentlas_motion_ad_manifest.json");
  const mp4Path = path.join(job.outputDir, "agentlas_motion_ad.mp4");

  await fs.writeFile(htmlPath, buildBrandMotionHtml(job, request), "utf8");
  await fs.writeFile(promptPackPath, buildPromptPack(job, request), "utf8");

  job.files.push(await makeFile("html_preview", "HTML preview", htmlPath, "text/html"));
  job.files.push(await makeFile("prompt_pack", "Prompt pack", promptPackPath, "text/markdown"));
  updateJob(job, "running", "rendering_frames", 0, ko ? "Chromium 프레임 렌더 중" : "Rendering frames with Chromium");

  await renderFramesWithElectron(job, htmlPath, framesDir);
  assertNotCancelled(job.id);

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not found. Install ffmpeg to encode the motion ad MP4.");
  updateJob(job, "running", "encoding", job.progress.totalFrames, ko ? "프레임을 MP4로 인코딩 중" : "Encoding frames to MP4");
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
  updateJob(job, "succeeded", "complete", job.progress.totalFrames, ko ? "모션그래픽 렌더 완료" : "Motion graphics render complete");
}

async function renderFramesWithElectron(job: OberonMotionAdJob, htmlPath: string, framesDir: string): Promise<void> {
  const ko = currentUiLocale() === "ko";
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
        updateJob(
          job,
          "running",
          "rendering_frames",
          frame + 1,
          ko ? `프레임 ${frame + 1}/${job.progress.totalFrames}` : `Frame ${frame + 1}/${job.progress.totalFrames}`,
        );
      }
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

// 범용 브랜드 모션그래픽 — 고객 로고/브랜드/태그라인/강조색으로 렌더(Agentlas 하드코딩 없음).
// 어떤 고객이든 자기 브랜드 영상이 나온다. CLI 플래너가 brief를 해석해 brand/concept(태그라인)를 채운다.
function buildBrandMotionHtml(job: OberonMotionAdJob, request: OberonMotionAdRequest): string {
  const accent = sanitizeColor(request.accentColor) || pickAccent(job.brand);
  const logo = resolveLogoSrc(request.logoSource);
  const tagline = String(request.concept || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0] || "";
  const W = job.width;
  const H = job.height;
  const base = Math.min(W, H);
  const config = { brand: job.brand, tagline, duration: job.durationSec };
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  const monogram = escapeHtml((job.brand || "B").trim().charAt(0).toUpperCase() || "B");
  const logoMarkup = logo
    ? `<img id="logoImg" src="${escapeHtml(logo)}" alt="" />`
    : `<div id="monogram">${monogram}</div>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0c11;}
  body{font-family:"Pretendard","Apple SD Gothic Neo",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;}
  #frame{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#0b0c11;color:#f5f6fa;}
  #glow{position:absolute;inset:-25%;background:radial-gradient(closest-side at 30% 28%, ${accent}66, transparent 70%),radial-gradient(closest-side at 76% 80%, ${accent}30, transparent 72%);will-change:transform;}
  #grid{position:absolute;inset:0;opacity:.05;background-image:linear-gradient(${accent} 1px,transparent 1px),linear-gradient(90deg,${accent} 1px,transparent 1px);background-size:${Math.round(base * 0.06)}px ${Math.round(base * 0.06)}px;}
  #stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 8%;}
  #logoWrap{display:flex;align-items:center;justify-content:center;width:${Math.round(base * 0.26)}px;height:${Math.round(base * 0.26)}px;border-radius:${Math.round(base * 0.05)}px;overflow:hidden;opacity:0;will-change:transform,opacity;}
  #logoImg{width:100%;height:100%;object-fit:contain;}
  #monogram{width:100%;height:100%;display:flex;align-items:center;justify-content:center;border-radius:${Math.round(base * 0.05)}px;background:${accent};color:#fff;font-size:${Math.round(base * 0.13)}px;font-weight:900;}
  #brand{margin-top:${Math.round(base * 0.045)}px;font-size:${Math.round(base * 0.085)}px;font-weight:900;letter-spacing:-0.01em;line-height:1.02;opacity:0;will-change:transform,opacity;word-break:keep-all;}
  #tag{margin-top:${Math.round(base * 0.03)}px;max-width:${Math.round(W * 0.7)}px;font-size:${Math.round(base * 0.033)}px;font-weight:600;line-height:1.45;color:rgba(245,246,250,.74);opacity:0;will-change:transform,opacity;word-break:keep-all;}
  #cta{margin-top:${Math.round(base * 0.05)}px;display:inline-flex;align-items:center;gap:10px;height:${Math.round(base * 0.075)}px;padding:0 ${Math.round(base * 0.05)}px;border-radius:999px;background:${accent};color:#fff;font-size:${Math.round(base * 0.03)}px;font-weight:800;opacity:0;will-change:transform,opacity;}
  #cta i{width:${Math.round(base * 0.013)}px;height:${Math.round(base * 0.013)}px;border-radius:999px;background:#fff;}
  #bar{position:absolute;left:8%;right:8%;bottom:6%;height:4px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden;}
  #bar span{display:block;height:100%;width:0%;background:${accent};border-radius:999px;}
</style>
</head>
<body>
<div id="frame">
  <div id="glow"></div>
  <div id="grid"></div>
  <div id="stage">
    <div id="logoWrap">${logoMarkup}</div>
    <div id="brand"></div>
    <div id="tag"></div>
    <div id="cta"><i></i><span id="ctaText"></span></div>
  </div>
  <div id="bar"><span></span></div>
</div>
<script>
  const CONFIG = ${configJson};
  const $ = (id) => document.getElementById(id);
  const logoWrap = $("logoWrap"), brand = $("brand"), tag = $("tag"), cta = $("cta"), ctaText = $("ctaText"), glow = $("glow");
  const bar = document.querySelector("#bar span");
  brand.textContent = CONFIG.brand;
  tag.textContent = CONFIG.tagline;
  ctaText.textContent = CONFIG.brand;
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function ease(x){x=clamp(x,0,1);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;}
  function seg(p,a,b){return ease((p-a)/Math.max(0.0001,(b-a)));}
  function lerp(a,b,t){return a+(b-a)*t;}
  function show(el,v){el.style.opacity=String(clamp(v,0,1));}
  window.__oberonSetFrame = function(frame, fps, duration){
    const t = frame / fps;
    const p = clamp(t / Math.max(0.1, duration), 0, 1);
    bar.style.width = (p*100).toFixed(2) + "%";
    const reveal = seg(p,0,.24);
    const brandIn = seg(p,.30,.52);
    const tagIn = seg(p,.50,.72);
    const ctaIn = seg(p,.80,.94);
    show(logoWrap, reveal);
    logoWrap.style.transform = "translateY("+lerp(36,0,reveal).toFixed(1)+"px) scale("+lerp(.7,1,reveal).toFixed(3)+")";
    show(brand, brandIn);
    brand.style.transform = "translateY("+lerp(26,0,brandIn).toFixed(1)+"px)";
    show(tag, tagIn);
    tag.style.transform = "translateY("+lerp(18,0,tagIn).toFixed(1)+"px)";
    show(cta, ctaIn);
    cta.style.transform = "translateY("+lerp(18,0,ctaIn).toFixed(1)+"px) scale("+lerp(.96,1,ctaIn).toFixed(3)+")";
    glow.style.transform = "translate("+(Math.sin(t*0.6)*2.4).toFixed(2)+"%,"+(Math.cos(t*0.5)*2.4).toFixed(2)+"%)";
  };
  window.__oberonSetFrame(0, ${job.fps}, ${job.durationSec});
</script>
</body>
</html>`;
}

function resolveLogoSrc(src: string | undefined): string {
  const s = (src || "").trim();
  if (!s) return "";
  if (/^(https?:|data:)/i.test(s)) return s;
  if (path.isAbsolute(s)) {
    try {
      return pathToFileURL(s).href;
    } catch {
      return "";
    }
  }
  return ""; // 텍스트 설명 등 이미지가 아니면 모노그램으로.
}

function sanitizeColor(c: string | undefined): string {
  const s = (c || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : "";
}

function pickAccent(brand: string): string {
  const palette = ["#5a56dc", "#0d9488", "#dc2626", "#ea580c", "#7c3aed", "#2563eb", "#db2777"];
  let h = 0;
  const s = brand || "brand";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function buildMotionAdHtml(job: OberonMotionAdJob, request: OberonMotionAdRequest): string {
  const proofRoot = path.join(process.cwd(), "artifacts", "desktop-functional-proof-20260627-144423");
  const motionRoot = path.join(process.cwd(), "artifacts", "oberon-motion-agentlas");
  const config = {
    title: job.title,
    brand: job.brand,
    concept:
      request.concept ||
      "빌려 쓰는 AI가 아니라, 내가 소유하는 AI 일꾼들. Agentlas는 내 로컬 환경에서 에이전트 팀을 운영하는 데스크탑 Agent OS입니다.",
    width: job.width,
    height: job.height,
    duration: job.durationSec,
    screens: {
      dashboard: pathToFileURL(path.join(proofRoot, "dashboard.png")).href,
      build: pathToFileURL(path.join(proofRoot, "build.png")).href,
      hub: pathToFileURL(path.join(proofRoot, "hub.png")).href,
      agents: pathToFileURL(path.join(proofRoot, "agents.png")).href,
      apps: pathToFileURL(path.join(proofRoot, "apps.png")).href,
      motion: pathToFileURL(path.join(motionRoot, "oberon-motion-menu.png")).href,
    },
  };
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(job.title)} preview</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #f5f3ea; }
    body { font-family: "Noto Sans KR", "Apple SD Gothic Neo", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    #frame { position: relative; width: ${job.width}px; height: ${job.height}px; overflow: hidden; background: #f5f3ea; color: #101820; }
    .wash { position: absolute; inset: -12%; background: radial-gradient(circle at 15% 15%, rgba(12,95,92,.18), transparent 28%), radial-gradient(circle at 88% 76%, rgba(196,74,54,.13), transparent 30%), linear-gradient(135deg, #f8f6ee 0%, #eef2ed 45%, #f6efe5 100%); }
    .grain { position: absolute; inset: 0; opacity: .16; background-image: linear-gradient(90deg, rgba(16,24,32,.045) 1px, transparent 1px), linear-gradient(rgba(16,24,32,.035) 1px, transparent 1px); background-size: 28px 28px; }
    .topline { position: absolute; z-index: 5; top: 30px; left: 48px; right: 48px; display: flex; align-items: center; gap: 12px; font-size: 22px; font-weight: 820; color: #12212b; }
    .mark { width: 27px; height: 27px; border-radius: 8px; background: #10242b; position: relative; box-shadow: inset 0 0 0 2px rgba(255,255,255,.14); }
    .mark::after { content: ""; position: absolute; inset: 7px; border-radius: 3px; border: 2px solid #f7f5ed; border-top-color: #29a39a; }
    .subbrand { font-size: 12px; font-weight: 800; color: rgba(16,24,32,.5); text-transform: uppercase; }
    .proof-note { margin-left: auto; height: 28px; display: inline-flex; align-items: center; padding: 0 11px; border-radius: 999px; background: rgba(255,255,255,.72); border: 1px solid rgba(16,24,32,.12); font-size: 11px; font-weight: 800; color: rgba(16,24,32,.66); }
    .headline { position: absolute; z-index: 4; left: 62px; top: 116px; width: 520px; font-size: 56px; line-height: .98; font-weight: 900; color: #101820; transform-origin: left center; word-break: keep-all; }
    .headline .accent { color: #0d6b66; }
    .kicker { position: absolute; z-index: 4; left: 65px; top: 315px; width: 490px; font-size: 20px; line-height: 1.42; font-weight: 650; color: rgba(16,24,32,.68); word-break: keep-all; }
    .scene-label { position: absolute; z-index: 4; left: 66px; top: 92px; font-size: 12px; font-weight: 900; color: #c04735; text-transform: uppercase; letter-spacing: .08em; }
    .cta { position: absolute; z-index: 4; left: 66px; top: 508px; height: 43px; display: flex; align-items: center; gap: 10px; padding: 0 17px; border-radius: 10px; background: #101820; color: #f7f7f2; font-size: 15px; font-weight: 850; box-shadow: 0 18px 42px rgba(16,24,32,.2); }
    .cta i { width: 8px; height: 8px; border-radius: 999px; background: #29a39a; }
    .screen-stage { position: absolute; z-index: 3; right: 54px; top: 96px; width: 622px; height: 430px; border-radius: 22px; background: rgba(255,255,255,.8); border: 1px solid rgba(16,24,32,.12); box-shadow: 0 34px 95px rgba(16,24,32,.22); overflow: hidden; transform-origin: center; }
    .bar { height: 42px; display: flex; align-items: center; padding: 0 18px; gap: 8px; background: #13242b; color: rgba(255,255,255,.86); font-size: 12px; font-weight: 820; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #d45745; }
    .dot:nth-child(2) { background: #c79b39; }
    .dot:nth-child(3) { background: #29a39a; margin-right: 10px; }
    .screen-crop { position: absolute; left: 16px; right: 16px; top: 58px; bottom: 16px; border-radius: 16px; overflow: hidden; background: #eef1ea; border: 1px solid rgba(16,24,32,.11); }
    .screen-crop::after { content: ""; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.5), inset 0 -90px 120px rgba(16,24,32,.06); }
    .screen-img { width: 100%; height: 100%; object-fit: cover; object-position: left top; transform-origin: center; filter: saturate(.96) contrast(1.02); }
    .caption-tag { position: absolute; z-index: 5; right: 24px; bottom: 24px; min-width: 160px; padding: 12px 13px; border-radius: 14px; background: rgba(16,24,32,.88); color: #f7f7f2; font-size: 13px; line-height: 1.25; font-weight: 800; box-shadow: 0 18px 44px rgba(16,24,32,.22); }
    .caption-tag small { display: block; margin-top: 5px; color: rgba(247,247,242,.7); font-size: 11px; line-height: 1.25; font-weight: 650; }
    .chaos { position: absolute; z-index: 6; right: 82px; top: 118px; width: 580px; height: 390px; pointer-events: none; }
    .rent-card { position: absolute; width: 196px; height: 86px; border-radius: 15px; background: rgba(255,255,255,.9); border: 1px solid rgba(16,24,32,.13); box-shadow: 0 20px 48px rgba(16,24,32,.16); padding: 14px; font-size: 12px; font-weight: 800; color: #101820; }
    .rent-card small { display: block; margin-top: 8px; color: rgba(16,24,32,.52); font-weight: 650; line-height: 1.25; }
    .rent-card em { position: absolute; right: 12px; top: 11px; padding: 4px 7px; border-radius: 999px; background: rgba(196,74,54,.12); color: #b53d2f; font-size: 9px; font-style: normal; font-weight: 900; }
    .rent-card:nth-child(1) { left: 260px; top: 18px; transform: rotate(-5deg); }
    .rent-card:nth-child(2) { left: 96px; top: 136px; transform: rotate(4deg); }
    .rent-card:nth-child(3) { left: 318px; top: 248px; transform: rotate(-2deg); }
    .keychain { position: absolute; z-index: 7; right: 76px; bottom: 78px; width: 330px; padding: 14px; border-radius: 18px; background: rgba(16,24,32,.9); color: #f7f7f2; box-shadow: 0 24px 70px rgba(16,24,32,.28); }
    .keychain strong, .graph strong, .package strong, .gate strong { display: block; font-size: 16px; margin-bottom: 8px; }
    .key-row { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 12px; color: rgba(247,247,242,.78); font-weight: 700; }
    .key-row span { width: 9px; height: 9px; border-radius: 999px; background: #29a39a; }
    .graph { position: absolute; z-index: 7; right: 88px; top: 122px; width: 330px; height: 210px; padding: 18px; border-radius: 20px; background: rgba(255,255,255,.9); border: 1px solid rgba(16,24,32,.11); box-shadow: 0 24px 68px rgba(16,24,32,.18); color: #101820; }
    .node { position: absolute; width: 86px; height: 34px; border-radius: 999px; display: flex; align-items: center; justify-content: center; background: #10242b; color: #f7f7f2; font-size: 11px; font-weight: 850; }
    .node.n1 { left: 28px; top: 74px; }
    .node.n2 { right: 26px; top: 70px; background: #0d6b66; }
    .node.n3 { left: 116px; bottom: 28px; background: #c04735; }
    .graph svg { position: absolute; left: 20px; top: 54px; width: 290px; height: 130px; overflow: visible; }
    .package { position: absolute; z-index: 7; right: 82px; bottom: 74px; width: 360px; height: 160px; border-radius: 20px; background: #10242b; color: #f7f7f2; box-shadow: 0 24px 70px rgba(16,24,32,.28); overflow: hidden; }
    .package::before { content: ""; position: absolute; left: 0; top: 0; width: 132px; height: 34px; border-radius: 0 0 17px 0; background: #29a39a; }
    .package strong { position: absolute; left: 22px; top: 58px; font-size: 19px; }
    .package small { position: absolute; left: 22px; top: 90px; width: 220px; color: rgba(247,247,242,.72); font-size: 12px; line-height: 1.35; font-weight: 700; }
    .runtime { position: absolute; right: 18px; width: 94px; height: 26px; border-radius: 999px; background: rgba(255,255,255,.12); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 850; color: rgba(247,247,242,.86); }
    .runtime.r1 { top: 42px; } .runtime.r2 { top: 78px; } .runtime.r3 { top: 114px; }
    .gate { position: absolute; z-index: 7; right: 86px; top: 130px; width: 350px; padding: 18px; border-radius: 20px; background: rgba(255,255,255,.92); border: 1px solid rgba(16,24,32,.13); box-shadow: 0 26px 76px rgba(16,24,32,.2); color: #101820; }
    .scan-line { height: 8px; border-radius: 999px; background: rgba(16,24,32,.1); overflow: hidden; margin-top: 11px; }
    .scan-line span { display: block; height: 100%; width: 0%; background: linear-gradient(90deg,#c04735,#29a39a); border-radius: 999px; }
    .receipt { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
    .receipt div { padding: 9px 10px; border-radius: 11px; background: #f5f3ea; border: 1px solid rgba(16,24,32,.08); font-size: 11px; font-weight: 850; color: rgba(16,24,32,.72); }
    .final-card { position: absolute; z-index: 8; right: 72px; bottom: 76px; width: 420px; height: 154px; border-radius: 22px; background: #101820; color: #f7f7f2; box-shadow: 0 30px 90px rgba(16,24,32,.32); padding: 24px; }
    .final-card strong { display: block; font-size: 31px; line-height: 1.03; letter-spacing: 0; }
    .final-card small { display: block; margin-top: 14px; color: rgba(247,247,242,.7); font-size: 13px; line-height: 1.35; font-weight: 700; }
    .timeline { position: absolute; z-index: 9; left: 66px; bottom: 44px; width: 610px; height: 8px; border-radius: 999px; background: rgba(16,24,32,.12); overflow: hidden; }
    .timeline span { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #0d6b66, #c04735); border-radius: 999px; }
  </style>
</head>
<body>
  <div id="frame">
    <div class="wash"></div>
    <div class="grain"></div>
    <div class="topline"><span class="mark"></span><span id="brandText">Agentlas</span><span class="subbrand">user-owned agent OS</span><span class="proof-note">local · BYOK · .agentlas</span></div>
    <div id="sceneLabel" class="scene-label">01 ownership</div>
    <div id="headline" class="headline">빌려 쓰는 AI가 아니라<br><span class="accent">소유하는 AI 일꾼들.</span></div>
    <div id="kicker" class="kicker">Agentlas는 내 기기에서 에이전트 팀을 만들고, 내 구독과 API 키로 직접 운영하는 데스크탑 앱입니다.</div>
    <div id="cta" class="cta"><i></i><span id="ctaText">Build agents as apps</span></div>
    <div id="screenStage" class="screen-stage">
      <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span id="screenTitle">Agentlas Desktop</span></div>
      <div class="screen-crop"><img id="screenImg" class="screen-img" alt="" /></div>
      <div id="captionTag" class="caption-tag">real desktop surface<small>not a fake AI dashboard</small></div>
    </div>
    <div id="chaos" class="chaos">
      <div class="rent-card">rented prompt box<em>RENTED</em><small>same instructions typed again</small></div>
      <div class="rent-card">lost context<em>RESET</em><small>new session, same briefing</small></div>
      <div class="rent-card">vendor lock-in<em>LOCKED</em><small>model choice becomes workflow choice</small></div>
    </div>
    <div id="keychain" class="keychain">
      <strong>내 키로 직접 실행</strong>
      <div class="key-row"><span></span>OpenAI · Anthropic · Google · local model</div>
      <div class="key-row"><span></span>OS Keychain keeps credentials local</div>
      <div class="key-row"><span></span>Agentlas 서버를 거쳐 모델 호출하지 않음</div>
    </div>
    <div id="graph" class="graph">
      <strong>기억이 작업을 이어받음</strong>
      <svg viewBox="0 0 290 130">
        <path d="M54 38 C112 8 186 8 238 34" stroke="#0d6b66" stroke-width="4" fill="none" stroke-linecap="round" opacity=".8"/>
        <path d="M60 56 C92 104 160 122 204 88" stroke="#c04735" stroke-width="4" fill="none" stroke-linecap="round" opacity=".78"/>
        <path d="M236 48 C216 80 188 98 164 104" stroke="#10242b" stroke-width="3" fill="none" stroke-linecap="round" opacity=".65"/>
      </svg>
      <div class="node n1">company rules</div>
      <div class="node n2">agent memory</div>
      <div class="node n3">supersedes</div>
    </div>
    <div id="package" class="package">
      <strong>.agentlas package</strong>
      <small>에이전트, 런타임 어댑터, 기억, 라우팅 카드를 묶어 다른 기기와 런타임으로 이동.</small>
      <div class="runtime r1">Claude Code</div>
      <div class="runtime r2">Codex</div>
      <div class="runtime r3">Gemini</div>
    </div>
    <div id="gate" class="gate">
      <strong>Stormbreaker: 검증 전엔 완료 아님</strong>
      <div class="scan-line"><span id="scan"></span></div>
      <div class="receipt">
        <div>secret scan</div>
        <div>permission gate</div>
        <div>handoff receipt</div>
        <div>operator approval</div>
      </div>
    </div>
    <div id="finalCard" class="final-card"><strong>Agentlas Desktop<br><span style="color:#29a39a">내가 소유하는 AI 일꾼들</span></strong><small>Local-first agent teams. BYOK. Hub marketplace. Durable memory. Verified handoffs.</small></div>
    <div id="timeline" class="timeline"><span></span></div>
  </div>
  <script>
    const CONFIG = ${configJson};
    const scenes = [
      { at: 0, label: "01 ownership", screen: "dashboard", title: "빌려 쓰는 AI가 아니라", accent: "소유하는 AI 일꾼들.", sub: "Agentlas는 내 기기에서 에이전트 팀을 만들고, 내 구독과 API 키로 직접 운영하는 데스크탑 앱입니다.", tab: "Agentlas Dashboard", tag: "ownership first", tag2: "your machine, your keys" },
      { at: 5, label: "02 local byok", screen: "build", title: "모델은 빌려도", accent: "일꾼은 내 것이다.", sub: "OpenAI, Claude, Gemini, 로컬 모델까지. Agentlas 서버를 거치지 않고 OS Keychain의 키로 직접 실행합니다.", tab: "Build · BYOK", tag: "vendor-agnostic", tag2: "no server pass-through" },
      { at: 10, label: "03 hub network", screen: "hub", title: "처음부터 만들지 말고", accent: "검증된 에이전트를 호출.", sub: "허브에서 에이전트를 검색해 쓰고, 내가 만든 에이전트는 Firm 또는 커뮤니티 레지스트리에 올립니다.", tab: "Hub Marketplace", tag: "search · call · publish", tag2: "agent marketplace" },
      { at: 15, label: "04 durable memory", screen: "agents", title: "세션이 끝나도", accent: "일꾼은 기억한다.", sub: "회사 규칙, 역할, 작업 맥락을 매번 다시 설명하지 않습니다. 관계 그래프 메모리가 다음 작업을 이어받습니다.", tab: "My Agents", tag: "relationship graph", tag2: "memory survives sessions" },
      { at: 20, label: "05 portable package", screen: "apps", title: "집에서 만든 에이전트를", accent: "회사에서도 그대로.", sub: ".agentlas 패키지가 에이전트와 런타임 어댑터를 묶어 Claude Code, Codex, Gemini, Cursor로 이동시킵니다.", tab: ".agentlas Package", tag: "portable agent", tag2: "runtime adapter included" },
      { at: 25, label: "06 verified execution", screen: "motion", title: "작업이 끝난 척하지 않고", accent: "검증을 통과한다.", sub: "Stormbreaker 규율은 보안 스캔, 권한 게이트, 핸드오프 영수증을 남겨 환각과 무단 행동을 줄입니다.", tab: "Oberon · Motion Proof", tag: "gate clean", tag2: "receipt-backed execution" },
      { at: 28.2, label: "07 agent os", screen: "dashboard", title: "Agentlas Desktop", accent: "Build agents as apps.", sub: CONFIG.concept, tab: "Agentlas Desktop", tag: "local agent OS", tag2: "owned AI workers" }
    ];
    const headline = document.getElementById("headline");
    const kicker = document.getElementById("kicker");
    const sceneLabel = document.getElementById("sceneLabel");
    const screenStage = document.getElementById("screenStage");
    const screenImg = document.getElementById("screenImg");
    const screenTitle = document.getElementById("screenTitle");
    const captionTag = document.getElementById("captionTag");
    const chaos = document.getElementById("chaos");
    const keychain = document.getElementById("keychain");
    const graph = document.getElementById("graph");
    const pkg = document.getElementById("package");
    const gate = document.getElementById("gate");
    const finalCard = document.getElementById("finalCard");
    const cta = document.getElementById("cta");
    const ctaText = document.getElementById("ctaText");
    const scan = document.getElementById("scan");
    const timeline = document.querySelector("#timeline span");
    document.getElementById("brandText").textContent = CONFIG.brand;
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function ease(x) { x = clamp(x, 0, 1); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
    function seg(t, a, b) { return ease((t - a) / (b - a)); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function show(el, v) { el.style.opacity = String(clamp(v, 0, 1)); }
    function activeScene(t) {
      let current = scenes[0];
      for (const scene of scenes) if (t >= scene.at) current = scene;
      return current;
    }
    function sceneProgress(t, scene) {
      const index = scenes.indexOf(scene);
      const next = scenes[index + 1];
      return clamp((t - scene.at) / Math.max(.1, (next ? next.at : CONFIG.duration || 30) - scene.at), 0, 1);
    }
    window.__oberonSetFrame = function(frame, fps, duration) {
      const t = frame / fps;
      const p = clamp(t / duration, 0, 1);
      const scene = activeScene(t);
      const sp = sceneProgress(t, scene);
      timeline.style.width = (p * 100).toFixed(2) + "%";
      if (screenImg.dataset.screen !== scene.screen) {
        screenImg.dataset.screen = scene.screen;
        screenImg.src = CONFIG.screens[scene.screen];
      }
      sceneLabel.textContent = scene.label;
      headline.innerHTML = scene.title + "<br><span class='accent'>" + scene.accent + "</span>";
      kicker.textContent = scene.sub;
      screenTitle.textContent = scene.tab;
      captionTag.innerHTML = scene.tag + "<small>" + scene.tag2 + "</small>";
      ctaText.textContent = t > 27.5 ? "Download Agentlas Desktop" : "Build agents as apps";
      const sceneKick = seg(sp, 0, .22);
      const endBeat = seg(t, 27.8, 30);
      headline.style.transform = "translateY(" + lerp(22, 0, sceneKick).toFixed(2) + "px) scale(" + lerp(.98, 1, sceneKick).toFixed(3) + ")";
      kicker.style.transform = "translateY(" + lerp(16, 0, sceneKick).toFixed(2) + "px)";
      screenStage.style.transform = "translate(" + lerp(72, 0, seg(t, .4, 2.0)).toFixed(2) + "px," + lerp(16, -8, endBeat).toFixed(2) + "px) scale(" + lerp(.95, 1, seg(t, .4, 2.0)).toFixed(3) + ")";
      screenImg.style.transform = "scale(" + lerp(1.06, 1.14, sp).toFixed(3) + ") translate(" + lerp(0, -18, sp).toFixed(2) + "px," + lerp(0, -10, sp).toFixed(2) + "px)";
      show(screenStage, seg(t, .2, 1.2) * (1 - seg(t, 29.2, 30) * .2));
      show(chaos, (1 - seg(t, 5.2, 7.4)) * seg(t, .2, 1.2));
      chaos.style.transform = "translateY(" + lerp(0, -26, seg(t, 1, 5)).toFixed(2) + "px)";
      show(keychain, seg(t, 5.2, 6.8) * (1 - seg(t, 11.8, 13.2)));
      keychain.style.transform = "translateY(" + lerp(70, 0, seg(t, 5.2, 6.8)).toFixed(2) + "px)";
      show(graph, seg(t, 14.5, 15.8) * (1 - seg(t, 20.2, 21.4)));
      graph.style.transform = "translateY(" + lerp(50, 0, seg(t, 14.5, 15.8)).toFixed(2) + "px)";
      show(pkg, seg(t, 19.5, 21.0) * (1 - seg(t, 25.0, 26.0)));
      pkg.style.transform = "translateY(" + lerp(76, 0, seg(t, 19.5, 21.0)).toFixed(2) + "px)";
      show(gate, seg(t, 24.4, 25.7) * (1 - seg(t, 28.4, 29.2)));
      gate.style.transform = "translateY(" + lerp(60, 0, seg(t, 24.4, 25.7)).toFixed(2) + "px)";
      scan.style.width = Math.round(seg(t, 25.0, 28.2) * 100) + "%";
      show(finalCard, seg(t, 27.8, 29.0));
      finalCard.style.transform = "translateY(" + lerp(64, 0, seg(t, 27.8, 29.0)).toFixed(2) + "px)";
      cta.style.transform = "translateY(" + lerp(34, 0, seg(t, 1.2, 2.6)).toFixed(2) + "px)";
      show(cta, seg(t, 2.0, 4.2));
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
- Core slogan: 빌려 쓰는 AI가 아니라, 내가 소유하는 AI 일꾼들

## Source Compression

The attached product overview was compressed into five video-safe claims:

1. Agentlas is a local desktop app for building and operating AI agent teams.
2. Agentlas does not host or resell AI models; the user connects subscriptions or API keys.
3. Agents keep durable memory instead of losing context every session.
4. .agentlas packages move agents across machines and runtimes.
5. Stormbreaker gates and handoff receipts keep execution inspectable.

Market sizing and long competitor comparisons are intentionally excluded from the 30s ad because they are dense and require separate citation QA.

## 30s Storyboard

| Time | Beat | Visual | Motion | Copy |
| --- | --- | --- | --- | --- |
| 0-5s | Ownership hook | Real Agentlas dashboard behind rented AI cards | Cards slide away, product screen pushes forward | 빌려 쓰는 AI가 아니라, 소유하는 AI 일꾼들 |
| 5-10s | Local BYOK | Build screen plus keychain panel | Key rows snap into local vault | 모델은 빌려도, 일꾼은 내 것이다 |
| 10-15s | Hub | Hub marketplace screen | Cards sort/search/call | 검증된 에이전트를 호출하고 공유 |
| 15-20s | Memory | Agents screen plus relationship graph | Nodes connect and supersede | 세션이 끝나도 일꾼은 기억한다 |
| 20-25s | Portability | Apps/package screen plus .agentlas folder | Package travels across runtimes | 집에서 만든 에이전트를 회사에서도 그대로 |
| 25-30s | Verification | Oberon/motion proof plus Stormbreaker gate | Scan line completes; final lockup lands | 검증 전엔 완료 아님 |

## Veo 3 / Flow 8s Cutdowns

### Cut 1: Ownership Hook

{
형식: 고급 제품 모션그래픽 광고, 16:9, 실제 데스크탑 UI와 키네틱 타이포 중심
상황: 늦은 밤 작업실 책상 위, 여러 AI 구독 창과 프롬프트 메모가 어수선하게 떠 있는 화면, 카메라는 데스크탑 화면을 정면에서 천천히 밀고 들어간다.
001 행동과 대사: "RENTED", "RESET", "LOCKED"가 찍힌 프롬프트 카드들이 흔들리며 쌓이고, 뒤쪽에서 Agentlas 데스크탑 화면이 선명하게 켜진다.
002 행동과 대사: 카드들이 왼쪽으로 밀려나며 큰 문장 "빌려 쓰는 AI가 아니라"가 나타나고, 화면 속 Agentlas 대시보드가 중심으로 확대된다.
003 행동과 대사: Agentlas 화면 위에 "내가 소유하는 AI 일꾼들"이라는 큰 타이포가 고정되고, 작은 키 아이콘들이 로컬 기기 안으로 들어간다.
004 행동과 대사: 마지막 1초는 Agentlas 로고와 데스크탑 화면을 멈춰 보여준다.
}

네거티브: 보라색 AI 그라디언트, 로봇 손, 빛나는 뇌, 읽기 어려운 작은 글자, 가짜 대시보드, 과도한 3D 아이콘

### Cut 2: Local BYOK

{
형식: 세련된 SaaS 제품 데모 모션그래픽, 실제 UI 스크린샷 기반
상황: 밝은 오프화이트 배경의 데스크탑 앱 화면, 카메라는 상단 탭에서 API 키 저장 영역으로 부드럽게 이동한다.
001 행동과 대사: OpenAI, Claude, Gemini, local model 라벨이 각자 작은 키로 변해 OS Keychain 금고 안으로 들어간다.
002 행동과 대사: Agentlas UI에서 "direct local run" 상태가 켜지고, 서버를 거치지 않는 경로가 짧은 선으로 표시된다.
003 행동과 대사: "모델은 빌려도, 일꾼은 내 것이다" 문장이 UI 위에 크게 고정된다.
004 행동과 대사: 화면은 Agentlas Build 페이지와 CTA "Build agents as apps"에서 멈춘다.
}

네거티브: API 키 원문 노출, 실제 비밀값, 작은 코드 글자, 추상 홀로그램, 미래형 과장 효과

### Cut 3: Memory And Package

{
형식: 제품 UI와 정보그래픽이 결합된 모션그래픽 광고
상황: Agentlas My Agents 화면 위에 관계 그래프가 투명하게 겹쳐진 장면, 카메라는 화면 오른쪽에서 왼쪽으로 천천히 팬한다.
001 행동과 대사: "company rules", "agent memory", "supersedes" 노드가 선으로 연결되고 이전 기억이 새 기억으로 교체된다.
002 행동과 대사: 그래프가 접히며 .agentlas 패키지 폴더가 되고, Claude Code, Codex, Gemini 런타임 칩 사이를 이동한다.
003 행동과 대사: Stormbreaker 게이트가 나타나 permission gate, handoff receipt, operator approval 항목을 체크한다.
004 행동과 대사: 최종 프레임은 "Agentlas Desktop — 내가 소유하는 AI 일꾼들"로 끝난다.
}

네거티브: 불필요한 인물, 복잡한 네트워크 과밀, 읽기 어려운 노드, 블록체인 느낌, 허위 보안 인증 마크

## Google Vids Outline

1. Title card: 빌려 쓰는 AI가 아니라, 내가 소유하는 AI 일꾼들.
2. Product screen: Agentlas Desktop dashboard.
3. Explanation: 내 구독/API 키를 연결해 로컬에서 실행.
4. Feature montage: Hub marketplace, durable memory, .agentlas portability.
5. Trust card: Stormbreaker gate and handoff receipts.
6. CTA: Build agents as apps.

## Cliche Rejection

- No purple/blue AI magic background.
- No robot hand, glowing brain, abstract stars, or generic prompt window.
- No fake SaaS dashboard when real Agentlas screenshots exist.
- No market-size claims inside the ad.
- No "future of work" copy.

## Source Concept

${request.concept || "빌려 쓰는 AI가 아니라, 내가 소유하는 AI 일꾼들. Agentlas는 내 로컬 환경에서 에이전트 팀을 운영하는 데스크탑 Agent OS입니다."}
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
  const ko = currentUiLocale() === "ko";
  if (cancelledJobs.has(id) || error instanceof MotionAdCancelled) {
    job.status = "cancelled";
    job.progress.phase = "cancelled";
    job.message = ko ? "모션그래픽 렌더 취소됨" : "Motion graphics render cancelled";
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
