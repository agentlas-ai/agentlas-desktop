// Each Toolchain's app icon (owner 2026-10-05: "툴체인 만들때 가능한 모델은 툴체인별 로고 만들어서 … 앱 형태로").
// Drawn once by an image model the owner already has (multimodal/image: Codex's keyless image tool, or Gemini with
// a saved key) when the Toolchain gets its contract; the screen draws a monogram until then or when no model can.
// One at a time, never twice for the same Toolchain, and a failure is not retried for a day.
//
// Off until the app itself turns it on (main.ts): drawing runs a real image model, so a read, a gate or a scripted
// test must never start one. (2026-10-05: an overview read queued a drawing and a gate launched Codex's image tool.)

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../runtime-paths";

const ICON_SIZE = 256;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const queue: Array<{ automationId: string; name: string; description: string }> = [];
const queued = new Set<string>();
let working = false;
let enabled = false;

/** The app turns drawing on once it runs for real; `backfill` lists Toolchains that already have a contract. */
export function enableToolchainLogos(backfill: () => Array<{ automationId: string; name: string; description: string }>): void {
  enabled = true;
  for (const item of backfill()) ensureToolchainLogo(item);
}

function iconDir(): string {
  return userDataPath("toolchain-icons");
}

function fileFor(automationId: string, suffix: "png" | "failed"): string {
  const key = createHash("sha256").update(automationId).digest("hex").slice(0, 32);
  return path.join(iconDir(), `${key}.${suffix}`);
}

/** Data URLs of every icon drawn so far, by automation id. */
export function toolchainLogos(automationIds: readonly string[]): Record<string, string> {
  const logos: Record<string, string> = {};
  for (const automationId of automationIds) {
    try {
      const bytes = fs.readFileSync(fileFor(automationId, "png"));
      if (bytes.length > 0 && bytes.length < 512 * 1024) logos[automationId] = `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      // Not drawn yet.
    }
  }
  return logos;
}

function recentlyFailed(automationId: string): boolean {
  try {
    return Date.now() - fs.statSync(fileFor(automationId, "failed")).mtimeMs < RETRY_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * The square around what was drawn, without a near-white margin: image tools often draw their own rounded card on
 * white, and the screen rounds the icon itself. `bitmap` is 4 bytes per pixel (BGRA or RGBA; only the colour
 * channels' brightness is read). Returns null when there is no margin worth cutting.
 */
export function iconContentSquare(bitmap: Uint8Array, width: number, height: number): { x: number; y: number; side: number } | null {
  const ink = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return Math.min(bitmap[i], bitmap[i + 1], bitmap[i + 2]) < 236;
  };
  let left = width, right = -1, top = height, bottom = -1;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 256));
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    if (!ink(x, y)) continue;
    if (x < left) left = x; if (x > right) right = x;
    if (y < top) top = y; if (y > bottom) bottom = y;
  }
  if (right < 0) return null;
  const side = Math.max(right - left + 1, bottom - top + 1);
  if (side >= Math.min(width, height) * 0.97) return null;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const x = Math.max(0, Math.min(width - side, Math.round(cx - side / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round(cy - side / 2)));
  return { x, y, side: Math.min(side, width, height) };
}

function prompt(name: string, description: string): string {
  const purpose = description.replace(/\s+/g, " ").trim().split(/(?<=[.!?。])\s/)[0].slice(0, 220);
  return [
    `An app icon for a small tool called "${name}".`,
    purpose ? `What it does: ${purpose}` : "",
    "A single bold, simple white symbol for that purpose, centered on a smooth colored gradient, macOS app icon style.",
    "Square 1:1 image. The gradient fills the whole canvas edge to edge: no white margin, no rounded corners, no frame (the app rounds the corners itself).",
    "Flat and clean, no text, no letters, no words, no border, no shadow.",
  ].filter(Boolean).join(" ");
}

async function draw(item: { automationId: string; name: string; description: string }): Promise<void> {
  const { generateImage, removeGeneratedImageArtifact } = await import("../multimodal/image");
  const result = await generateImage("auto", prompt(item.name, item.description));
  fs.mkdirSync(iconDir(), { recursive: true });
  if (!result.ok || !result.artifactPath) {
    fs.writeFileSync(fileFor(item.automationId, "failed"), result.reason ?? "unavailable");
    return;
  }
  try {
    const { nativeImage } = await import("electron");
    const drawn = nativeImage.createFromPath(result.artifactPath);
    if (drawn.isEmpty()) throw new Error("toolchain_logo_unreadable");
    // Image tools often answer in portrait; a centered square keeps the proportions (the first QA icon came back
    // 1024x1536 and was squeezed into the square with white margins).
    const { width, height } = drawn.getSize();
    const content = iconContentSquare(drawn.toBitmap(), width, height);
    const side = content?.side ?? Math.min(width, height);
    const image = content ? drawn.crop({ x: content.x, y: content.y, width: side, height: side })
      : width === height ? drawn : drawn.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    const target = fileFor(item.automationId, "png");
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: "best" }).toPNG());
    fs.renameSync(temp, target);
    try { fs.rmSync(fileFor(item.automationId, "failed"), { force: true }); } catch { /* none */ }
  } finally {
    removeGeneratedImageArtifact(result.artifactPath);
  }
}

async function drain(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        await draw(item);
      } catch (error) {
        try {
          fs.mkdirSync(iconDir(), { recursive: true });
          fs.writeFileSync(fileFor(item.automationId, "failed"), error instanceof Error ? error.message : "failed");
        } catch { /* the next session tries again */ }
      } finally {
        queued.delete(item.automationId);
      }
    }
  } finally {
    working = false;
  }
}

/** Queue an icon for a Toolchain that has none. Never blocks the caller. */
export function ensureToolchainLogo(input: { automationId: string; name: string; description: string }): void {
  if (!enabled || queued.has(input.automationId) || recentlyFailed(input.automationId)) return;
  if (fs.existsSync(fileFor(input.automationId, "png"))) return;
  queued.add(input.automationId);
  queue.push(input);
  void drain();
}
