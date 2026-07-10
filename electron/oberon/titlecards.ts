// Oberon — 타이틀/캡션 결정적 번인 (HyperFrames 방식: HTML→Chromium PNG→ffmpeg overlay).
//
// 글자를 생성 모델이 아니라 코드로 결정적으로 합성한다. shared/oberon-titles.ts가
// OberonTitleSpec을 결정적 HTML로 만들고, 여기서 Chromium 오프스크린으로 PNG 래스터화
// → ffmpeg의 코어 필터(overlay/concat/color/fade)로 본편에 합성한다.
//
// drawtext/subtitles(libfreetype/libass)에 의존하지 않는다 — 많은 ffmpeg 빌드가 그
// 필터 없이 빌드돼 있다(Homebrew 등). 래스터라이저는 주입 가능:
//   · 프로덕션: Electron BrowserWindow(번들 Chromium, 신규 의존 0)
//   · 테스트/폴백: Playwright(설치돼 있으면)
// 모든 단계는 best-effort — 실패하면 경고만 남기고 마스터는 유지한다.

import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { currentUiLocale } from "../ui-locale";
import {
  cardHtml,
  frameSizeFor,
  textOverlayHtml,
  type OberonLowerThird,
  type OberonSubtitleCue,
  type OberonTextStyle,
  type OberonTitleCard,
  type OberonTitleSpec,
} from "../../shared/oberon-titles";

const execFileAsync = promisify(execFile);
const FPS = 24;
const MAX_OVERLAYS = 48; // 필터그래프 폭주 방지

/** HTML → 투명 PNG 버퍼. */
export type RasterizeFn = (html: string, width: number, height: number) => Promise<Buffer>;

export interface TitleComposeInput {
  ffmpeg: string;
  masterMp4: string;
  outDir: string;
  /** 출력 파일 베이스명 (보통 safeSlug(title)). */
  baseName: string;
  spec: OberonTitleSpec;
  /** HTML 래스터라이저. 생략 시 Electron BrowserWindow를 사용. */
  rasterize?: RasterizeFn;
}

export interface TitleComposeFile {
  kind: "titled_mp4" | "titled_mov";
  absPath: string;
  label: string;
  mime: string;
}

export interface TitleComposeResult {
  files: TitleComposeFile[];
  warnings: string[];
}

interface TimedOverlay {
  png: string; // outDir 기준 상대 ascii 파일명
  start: number;
  end: number;
}

/** 타이틀/로어서드/자막을 본편에 번인해 *_titled.mp4 / .mov를 만든다. */
export async function composeTitledDelivery(input: TitleComposeInput): Promise<TitleComposeResult> {
  const ko = currentUiLocale() === "ko";
  const { ffmpeg, masterMp4, outDir, baseName, spec } = input;
  const warnings: string[] = [];
  const hasWork =
    !!spec.titleCard ||
    !!spec.endCard ||
    spec.lowerThirds.length > 0 ||
    (spec.subtitles.length > 0 && !!spec.subtitleStyle);
  if (!hasWork) return { files: [], warnings: [] };

  let rasterize: RasterizeFn;
  let disposeRaster: (() => Promise<void>) | null = null;
  try {
    if (input.rasterize) {
      rasterize = input.rasterize;
    } else {
      const built = buildElectronRasterizer();
      rasterize = built.rasterize;
      disposeRaster = built.dispose;
    }
  } catch (error) {
    return {
      files: [],
      warnings: [
        ko ? `래스터라이저 초기화 실패(타이틀 건너뜀): ${msg(error)}` : `Rasterizer initialization failed (skipping titles): ${msg(error)}`,
      ],
    };
  }

  const probed = await probeSize(ffmpeg, masterMp4).catch(() => null);
  const fallback = frameSizeFor(spec.aspectRatio);
  const W = probed?.w ?? fallback.w;
  const H = probed?.h ?? fallback.h;
  const masterBase = path.basename(masterMp4);
  const temps: string[] = [];

  try {
    // 1) 타이틀/엔드 카드 PNG → 독립 클립 세그먼트
    let titleSeg: string | null = null;
    let endSeg: string | null = null;
    if (spec.titleCard) {
      titleSeg = await buildCardSegment(ffmpeg, rasterize, outDir, "title", spec.titleCard, W, H, spec.fontImportHref, temps, warnings);
    }
    if (spec.endCard) {
      endSeg = await buildCardSegment(ffmpeg, rasterize, outDir, "end", spec.endCard, W, H, spec.fontImportHref, temps, warnings);
    }

    // 2) 시간구간 오버레이(로어서드 + 자막) PNG 래스터화
    const overlays: TimedOverlay[] = [];
    let idx = 0;
    for (const lt of spec.lowerThirds) {
      if (overlays.length >= MAX_OVERLAYS) break;
      const png = `_ov${idx++}.png`;
      await writePng(rasterize, path.join(outDir, png), textOverlayHtml(lt.lines, lt.style, W, H, spec.fontImportHref), W, H);
      temps.push(png);
      overlays.push({ png, start: Math.max(0, lt.startSec), end: Math.max(lt.startSec + 0.2, lt.endSec) });
    }
    if (spec.subtitleStyle) {
      for (const cue of spec.subtitles) {
        if (overlays.length >= MAX_OVERLAYS) {
          warnings.push(
            ko ? `자막 큐가 많아 ${MAX_OVERLAYS}개까지만 번인` : `Too many subtitle cues; burning in only the first ${MAX_OVERLAYS}`,
          );
          break;
        }
        if (!cue.text.trim() || cue.endSec <= cue.startSec) continue;
        const png = `_ov${idx++}.png`;
        await writePng(rasterize, path.join(outDir, png), subtitleOverlayHtml(cue, spec.subtitleStyle, W, H, spec.fontImportHref), W, H);
        temps.push(png);
        overlays.push({ png, start: cue.startSec, end: cue.endSec });
      }
    }

    // 3) 본편 위 오버레이 합성 → _body.mp4 (target 코덱/fps)
    const bodyName = "_body.mp4";
    temps.push(bodyName);
    await buildBody(ffmpeg, outDir, masterBase, overlays, bodyName);

    // 4) concat (title + body + end), 전부 동일 파라미터 → copy
    const segments = [titleSeg, bodyName, endSeg].filter((s): s is string => !!s);
    const titledMp4 = `${baseName}_titled.mp4`;
    const titledMp4Abs = path.join(outDir, titledMp4);
    if (segments.length === 1) {
      await fs.copyFile(path.join(outDir, segments[0]), titledMp4Abs);
    } else {
      const listName = "_titled_concat.txt";
      await fs.writeFile(path.join(outDir, listName), segments.map((s) => `file '${s}'`).join("\n"), "utf8");
      temps.push(listName);
      try {
        await run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", titledMp4], outDir);
      } catch {
        await run(
          ffmpeg,
          ["-y", "-f", "concat", "-safe", "0", "-i", listName, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", titledMp4],
          outDir,
        );
      }
    }

    const files: TitleComposeFile[] = [
      {
        kind: "titled_mp4",
        absPath: titledMp4Abs,
        label: ko ? "Titled MP4 (타이틀/자막 번인)" : "Titled MP4 (title/subtitle burn-in)",
        mime: "video/mp4",
      },
    ];

    // 5) MOV
    const titledMov = `${baseName}_titled.mov`;
    try {
      await run(ffmpeg, ["-y", "-i", titledMp4, "-c", "copy", titledMov], outDir);
      files.push({ kind: "titled_mov", absPath: path.join(outDir, titledMov), label: "Titled MOV", mime: "video/quicktime" });
    } catch {
      warnings.push(ko ? "titled MOV 생성 실패(MP4는 정상)" : "Failed to create titled MOV (MP4 is fine)");
    }

    return { files, warnings };
  } catch (error) {
    warnings.push(ko ? `타이틀 번인 실패(마스터는 정상): ${msg(error)}` : `Title burn-in failed (master is fine): ${msg(error)}`);
    return { files: [], warnings };
  } finally {
    if (disposeRaster) await disposeRaster().catch(() => undefined);
    await Promise.all(temps.map((t) => fs.rm(path.join(outDir, t), { force: true }).catch(() => undefined)));
  }
}

// ── 카드 세그먼트 (loop PNG → 클립) ──────────────────────

async function buildCardSegment(
  ffmpeg: string,
  rasterize: RasterizeFn,
  outDir: string,
  tag: string,
  card: OberonTitleCard,
  W: number,
  H: number,
  fontHref: string | undefined,
  temps: string[],
  warnings: string[],
): Promise<string | null> {
  const ko = currentUiLocale() === "ko";
  try {
    const png = `_card_${tag}.png`;
    await writePng(rasterize, path.join(outDir, png), cardHtml(card, W, H, fontHref), W, H);
    temps.push(png);
    const seg = `_seg_${tag}.mp4`;
    temps.push(seg);
    const dur = Math.max(1, card.durationSec);
    const fadeOut = Math.max(0, dur - 0.4).toFixed(2);
    await run(
      ffmpeg,
      [
        "-y",
        "-loop",
        "1",
        "-i",
        png,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        String(dur),
        "-r",
        String(FPS),
        "-vf",
        `fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4,format=yuv420p`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-shortest",
        seg,
      ],
      outDir,
    );
    return seg;
  } catch (error) {
    warnings.push(ko ? `${tag} 카드 생성 실패: ${msg(error)}` : `Failed to create the ${tag} card: ${msg(error)}`);
    return null;
  }
}

// ── 본편 오버레이 합성 ───────────────────────────────────

async function buildBody(ffmpeg: string, outDir: string, masterBase: string, overlays: TimedOverlay[], outName: string): Promise<void> {
  const args = ["-y", "-i", masterBase];
  if (!overlays.length) {
    // 오버레이 없음 — concat 호환 위해 target 파라미터로 재인코딩만.
    args.push("-r", String(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", outName);
    await run(ffmpeg, args, outDir);
    return;
  }
  for (const ov of overlays) args.push("-loop", "1", "-i", ov.png);
  let prev = "[0:v]";
  const steps: string[] = [];
  overlays.forEach((ov, i) => {
    const label = i === overlays.length - 1 ? "[vout]" : `[v${i}]`;
    steps.push(`${prev}[${i + 1}:v]overlay=format=auto:enable='between(t,${fmt(ov.start)},${fmt(ov.end)})'${label}`);
    prev = `[v${i}]`;
  });
  args.push(
    "-filter_complex",
    steps.join(";"),
    "-map",
    "[vout]",
    "-map",
    "0:a?",
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    // -loop 1 이미지 입력은 무한이므로 본편(0:v) 길이에 맞춰 끊는다(미설정 시 무한 인코딩).
    "-shortest",
    outName,
  );
  await run(ffmpeg, args, outDir);
}

// ── 자막 큐 → 오버레이 HTML (화자 라벨 포함) ─────────────

function subtitleOverlayHtml(cue: OberonSubtitleCue, style: OberonTextStyle, W: number, H: number, fontHref?: string): string {
  const prefix = cue.voiceover ? "(V.O.) " : "";
  return textOverlayHtml([prefix + cue.text], style, W, H, fontHref);
}

// ── Electron 래스터라이저 (프로덕션, offscreen Chromium) ──
// show:false 비표시 창은 컴포지팅이 안 돼 capturePage()가 무한 대기한다(macOS).
// offscreen:true로 화면 없이 실제 렌더 → capturePage 정상. HyperFrames와 동일한
// 헤드리스 Chromium 경로. 창 1개를 재사용하고, capture는 타임아웃으로 가드한다.

function buildElectronRasterizer(): { rasterize: RasterizeFn; dispose: () => Promise<void> } {
  const ko = currentUiLocale() === "ko";
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require("electron") as typeof import("electron");
  const { BrowserWindow } = electron;
  if (!BrowserWindow) {
    throw new Error(ko ? "Electron BrowserWindow 사용 불가(메인 프로세스 아님)" : "Electron BrowserWindow unavailable (not the main process)");
  }

  let win: import("electron").BrowserWindow | null = null;

  const ensureWin = (width: number, height: number) => {
    if (win && !win.isDestroyed()) {
      win.setContentSize(width, height);
      return win;
    }
    win = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.setFrameRate(10);
    return win;
  };

  const rasterize: RasterizeFn = async (html, width, height) => {
    const w = ensureWin(width, height);
    await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    await w.webContents
      .executeJavaScript("(document.fonts && document.fonts.ready) ? document.fonts.ready.then(()=>true) : true")
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150)); // 폰트·레이아웃 정착
    // offscreen은 paint 이벤트로 프레임을 받는다(capturePage는 비표시창에서 멈춤).
    const image = await withTimeout(
      new Promise<import("electron").NativeImage>((resolve) => {
        const wc = w.webContents;
        const onPaint = (_e: unknown, _dirty: unknown, img: import("electron").NativeImage) => {
          wc.removeListener("paint", onPaint as never);
          resolve(img);
        };
        wc.on("paint", onPaint as never);
        wc.invalidate();
      }),
      8000,
      "offscreen paint timeout",
    );
    return image.toPNG();
  };

  const dispose = async () => {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  };
  return { rasterize, dispose };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ── 유틸 ─────────────────────────────────────────────────

async function writePng(rasterize: RasterizeFn, absPath: string, html: string, w: number, h: number): Promise<void> {
  const buf = await rasterize(html, w, h);
  await fs.writeFile(absPath, buf);
}

async function probeSize(ffmpeg: string, file: string): Promise<{ w: number; h: number }> {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext || ""}`);
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ]);
    const m = stdout.trim().match(/(\d{2,5})\s*[,x]\s*(\d{2,5})/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  } catch {
    /* fall through */
  }
  try {
    await execFileAsync(ffmpeg, ["-i", file], { maxBuffer: 1024 * 1024 * 8 });
  } catch (e: unknown) {
    const stderr = (e as { stderr?: string })?.stderr ?? "";
    const m = stderr.match(/,\s*(\d{2,5})x(\d{2,5})[\s,]/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  }
  throw new Error("could not probe size");
}

async function run(bin: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(bin, args, { cwd, maxBuffer: 1024 * 1024 * 16 });
}

function fmt(n: number): string {
  return Number(n).toFixed(2);
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
