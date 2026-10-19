// 멀티모달 — 이미지 생성 엔진 (T-rex에서 적출, 2026-08-21).
//  - codex: `codex exec`의 내장 image_gen(OAuth, API 키 불필요) — 검증된 키리스 경로.
//  - gemini(나노바나나): Antigravity CLI에는 이미지 툴이 노출되지 않아
//    GEMINI_API_KEY가 보관함에 있을 때만 @google/genai로 생성(없으면 needs-key).
// 결과는 data:image/png;base64 로 렌더러에 바로 넘겨 슬라이드 배경으로 깐다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { userDataPath } from "../runtime-paths";
import { detachedSpawnOpts, killCliTree, trackRunChild } from "../runtime/exec";
import { withCodexProductHome } from "../runtime/codex-product-home";
import { withAgyProductHome } from "../runtime/antigravity-personal-context";
import { findExecutableSync } from "../runtime/path-lookup";
import { antigravityPermissionArgs, reduceAgyLine, stageFreshAgyGeneratedImage } from "../runtime/antigravity";
import { DIRECT_CLI_RUNTIMES, runLedgeredCliCall, type DirectCliRuntime } from "../runtime/direct-cli-ledger";
import { productHomeRefusedOnThisHost } from "../runtime/product-home-identity";

export type ImageModel = "codex" | "gemini" | "grok" | "auto";

/**
 * The calling run's admission (R-078, 2026-10-18): the room/run permission the tool call was approved under. A route
 * spawns its CLI with that permission's flags, never broader (agy: write = --dangerously-skip-permissions --sandbox,
 * full = without --sandbox; antigravity.ts antigravityPermissionArgs). "read" generates nothing (image generation
 * writes a file; generate_image is an edit-level tool). Absent = a caller with no room (the slide studio, Toolchain
 * icons): the route's own flags as before.
 */
export interface ImageAdmission {
  permission?: "read" | "write" | "full";
}

type ImageEngine = "codex" | "gemini" | "grok";

/**



 */
const IMAGE_ENGINE_RUNTIME: Record<ImageEngine, DirectCliRuntime> = {
  codex: { ...DIRECT_CLI_RUNTIMES.codex, label: "Codex image" },
  gemini: { ...DIRECT_CLI_RUNTIMES.antigravity, label: "Antigravity image" },
  grok: { ...DIRECT_CLI_RUNTIMES.grok, label: "Grok Imagine" },
};

function runImageEngine(engine: ImageEngine, phase: "multimodal-image" | "multimodal-image-edit", instruction: string,
  permission: "write" | "full" | undefined, produce: () => Promise<string | null>): Promise<string | null> {
  return runLedgeredCliCall({ runtime: IMAGE_ENGINE_RUNTIME[engine], phase, request: instruction, permission,
    failureCode: "image_not_produced", produce });
}

/**
 * One exclusive folder per engine attempt (2026-10-18): the CLI works in it and its target lives in it. An image is taken
 * only from that folder or from the exact file the runtime names (agy: its generate_image output in this run's own
 * conversation; codex: this exec thread's generated_images folder). Before, a missing target was replaced by the newest
 * PNG of the last 3 s in the shared multimodal-images folder, ~/.gemini/antigravity-cli/scratch or ~/.codex/generated_images,
 * so two concurrent jobs could take each other's image (or a personal session's).
 */
function newAttemptDir(root: string): string {
  return fs.mkdtempSync(path.join(root, "job-"));
}
function dropEmptyAttemptDir(dir: string): void {
  try { fs.rmdirSync(dir); } catch { /* not empty (partial media kept for recovery) or already gone */ }
}

export interface ImageResult {
  ok: boolean;
  src?: string;
  reason?: string;
  /** 실제 생성에 성공한 엔진(auto 페일오버 추적용). */
  engine?: "codex" | "gemini" | "grok";
  /** Main-only source path; never put this path in model/user text. */
  artifactPath?: string;
  /** Edit lineage (NH34): the input's and the output's content digests. */
  lineage?: { sourceSha256: string; outputSha256: string };
}

function resolveBin(name: string, extra: string[]): string | null {
  // Platform PATH delimiter and Windows PATHEXT (NH31): a POSIX ":" split read every Windows CLI as absent.
  return findExecutableSync(name, extra);
}

const IMAGE_FILE = /\.(?:png|jpe?g|webp)$/i;

/** Spawns a CLI with stdin closed and stdout read line by line; resolves when it exits or after `timeoutMs`. */
function runCliLines(bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  onLine: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    let child;
    try {
      // stdin은 반드시 닫는다(ignore) — 파이프로 열려 있으면 codex가
      // "Reading additional input from stdin..."으로 EOF를 기다리며 영원히 블록된다.
      child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "ignore"], ...detachedSpawnOpts() });
      trackRunChild(child);
    } catch {
      finish();
      return;
    }
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at).trim();
        pending = pending.slice(at + 1);
        if (line) { try { onLine(line); } catch { /* a malformed line is not the image */ } }
      }
    });
    const timer = setTimeout(() => {
      try {
        if (child) killCliTree(child, 250);
      } catch {
        /* ignore */
      }
      finish();
    }, options.timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      if (pending.trim()) { try { onLine(pending.trim()); } catch { /* ignore */ } }
      finish();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** The newest image file directly in `dir` (an exclusive folder of this attempt, never a shared one). */
function newestImageIn(dir: string): string | null {
  let best: { file: string; mtime: number } | null = null;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!IMAGE_FILE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size === 0) continue;
      if (!best || stat.mtimeMs > best.mtime) best = { file, mtime: stat.mtimeMs };
    } catch { /* gone */ }
  }
  return best?.file ?? null;
}

/** Puts `found` at `target` (copy; the source stays where its runtime keeps it). */
function placeAt(found: string | null, target: string): string | null {
  if (fs.existsSync(target)) return target;
  if (!found || found === target) return null;
  try {
    fs.copyFileSync(found, target);
    return target;
  } catch {
    return null;
  }
}

async function runCodexImage(prompt: string, target: string, inputImage?: string, permission?: "write" | "full"): Promise<string | null> {
  // A gate or script (no install identity) in the account's own HOME would run the person's codex and sign-in.
  if (productHomeRefusedOnThisHost(os.homedir())) return null;
  const bin = resolveBin("codex", [
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]);
  if (!bin) return null;
  const cwd = path.dirname(target);
  const instruction = inputImage
    // Edit: the attached image is the source; the instruction says what changes (NH34).
    ? `Use your built-in image_gen tool to edit the attached image and save exactly ONE resulting PNG to ${target}. ` +
      `EDIT: ${prompt}. Keep everything the edit does not mention. If you cannot edit images print exactly NO_IMAGE_GEN.`
    : `Use your built-in image_gen tool to generate exactly ONE image and save the PNG to ${target} ` +
      `(largest landscape size, e.g. 1536x1024). IMAGE PROMPT: ${prompt}. ` +
      `Absolutely no text, no words, no letters, no numbers, no logo, no watermark. ` +
      `If you cannot generate images print exactly NO_IMAGE_GEN.`;
  // The user's Codex home without their personal AGENTS.md, like every product run.
  const env = withCodexProductHome(process.env);
  // workspace-write is already below every permission that may generate an image (write and full).
  return runImageEngine("codex", inputImage ? "multimodal-image-edit" : "multimodal-image", instruction, permission, async () => {
    // `--json` names this exec's thread; codex keeps that thread's images in <CODEX_HOME>/generated_images/<thread id>/.
    let threadId: string | null = null;
    // 실측: codex image_gen은 콜드 스타트 시 2~4분 — 150s는 완성 직전에 죽인다(all-engines 오탐 원인).
    await runCliLines(bin, ["exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", ...(inputImage ? ["-i", inputImage] : []), instruction],
      { cwd, env, timeoutMs: 300_000 }, (line) => {
        const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
        if (event?.type === "thread.started" && typeof event.thread_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(event.thread_id)) threadId ??= event.thread_id;
      });
    if (fs.existsSync(target)) return target;
    const codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
    // What the model saved in this attempt's folder, else this thread's own image copied in.
    return newestImageIn(cwd) ?? placeAt(threadId ? newestImageIn(path.join(codexHome, "generated_images", threadId)) : null, target);
  });
}

async function runGeminiImage(prompt: string, target: string, apiKey: string): Promise<boolean> {
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const r = await ai.models.generateImages({
      model: "imagen-4.0-generate-001",
      prompt,
      config: { numberOfImages: 1, aspectRatio: "16:9", imageSize: "1K" },
    });
    const bytes = r.generatedImages?.[0]?.image?.imageBytes;
    if (!bytes) return false;
    fs.writeFileSync(target, Buffer.from(bytes, "base64"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Antigravity CLI(agy) 나노바나나(Nano Banana / Gemini image) — 키리스(Google OAuth).
 * 앱에 Antigravity를 연결한 사용자면 누구나 키 없이 이미지 생성. 이 시도의 전용 폴더를 --add-dir 작업 공간으로 주고,
 * 모델이 target에 저장하지 않았으면 이 실행 자신의 대화(stream-json 의 conversation_id)에서 generate_image 가 만든
 * 바로 그 파일(stageFreshAgyGeneratedImage)을 가져온다. 공유 폴더(scratch 등)를 시간 창으로 뒤지지 않는다.
 */
async function runAgyNanoBanana(prompt: string, target: string, inputImage?: string, permission?: "write" | "full"): Promise<string | null> {
  // A gate or script (no install identity) in the account's own HOME would run the person's agy in their own ~/.gemini.
  if (productHomeRefusedOnThisHost(os.homedir())) return null;
  const bin = resolveBin("agy", [
    path.join(os.homedir(), ".local/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ]);
  if (!bin) return null;
  const outDir = path.dirname(target);
  const instruction = inputImage
    ? `Use your image generation capability (Nano Banana / Gemini image) to edit the image at the absolute path ${inputImage}: ${prompt}. ` +
      `Keep everything the edit does not mention. Save exactly ONE resulting PNG to the absolute path ${target}. If you cannot edit images, reply exactly NO_IMAGE_GEN.`
    : `Use your image generation capability (Nano Banana / Gemini image) to generate exactly ONE image: ${prompt}. ` +
      `Save the resulting PNG file to the absolute path ${target}. ` +
      `No text, no words, no letters, no numbers, no logo, no watermark. If you cannot generate images, reply exactly NO_IMAGE_GEN.`;
  // HOME mirror: the conversation (and its generated image) stays in the product store.
  const env = withAgyProductHome({ ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" }, undefined, undefined);
  // The selected route uses subscription OAuth, regardless of ambient API keys.
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"]) delete env[key];
  // The room's permission, as for every agy run: write is sandboxed, full is not. A caller with no room keeps full.
  const permissionArgs = antigravityPermissionArgs(permission ?? "full");
  return runImageEngine("gemini", inputImage ? "multimodal-image-edit" : "multimodal-image", instruction, permission, async () => {
    const startedAt = Date.now();
    const state: Parameters<typeof reduceAgyLine>[1] = { text: "", inputTokens: 0, outputTokens: 0 };
    let imageName: string | undefined;
    // stdin ignore — codex와 동일한 stdin-EOF 대기 블록 방지. stream-json names the conversation and the tool's image.
    await runCliLines(bin, [...permissionArgs, "--output-format", "stream-json", "--add-dir", outDir,
      ...(inputImage ? ["--add-dir", path.dirname(inputImage)] : []), "--print", instruction], { cwd: outDir, env, timeoutMs: 300_000 }, (line) => {
      const step = reduceAgyLine(line, state);
      if (step.tool?.done && !step.tool.failed && step.tool.name === "generate_image" && step.tool.args) {
        const args = JSON.parse(step.tool.args) as { ImageName?: unknown } | null;
        if (typeof args?.ImageName === "string") imageName = args.ImageName;
      }
    });
    if (fs.existsSync(target)) return target;
    const staged = state.conversationId && imageName
      ? stageFreshAgyGeneratedImage({ conversationId: state.conversationId, imageName, invocationStartedAtMs: startedAt,
        destinationRoot: outDir, home: env.HOME })
      : null;
    // Both live in this attempt's own folder: the staged copy of the exact generated file, or what the model saved there.
    return staged?.artifactPath ?? newestImageIn(outDir);
  });
}

/** The subscription route never falls through to a paid API transport. */
async function tryGemini(clean: string, target: string, permission?: "write" | "full"): Promise<string | null> {
  return runAgyNanoBanana(clean, target, undefined, permission);
}

// auto 페일오버 상태 — 한 엔진이 실패(쿼터 소진/미설치)하면 세션 내 잠시 뒤로 미룬다(15분).
// 매 이미지마다 죽은 엔진에 150초 타임아웃을 다시 태우는 낭비를 막는 소프트 쿨다운.
const engineCooldown: Record<"codex" | "gemini" | "grok", number> = { codex: 0, gemini: 0, grok: 0 };
const COOLDOWN_MS = 15 * 60 * 1000;

/**
 * 이미지 생성. model="auto"면 codex→gemini 순으로 시도하고, 실패한 엔진은 쿨다운을 걸어
 * 남은 사용량이 있는 쪽을 자동으로 쓴다. 명시 모델은 그 엔진만 쓴다. Dashboard 역할
 * 슬롯에서 온 선택을 몰래 다른 공급자로 바꾸면 저장된 선택과 실제 영수증이 달라진다.
 */
/** Grok Imagine (official CLI, OAuth subscription only — runGrokImagine refuses an API key) into the exact target. */
async function tryGrok(prompt: string, target: string, permission?: "write" | "full"): Promise<string | null> {
  const { runGrokImagine } = await import("./grok-imagine");
  // Grok Imagine keeps its own media-only boundary (--sandbox strict, shell/edit denied) for every permission; it
  // harvests by its own session id, in this attempt's folder.
  return runImageEngine("grok", "multimodal-image", prompt, permission, async () => {
    const produced = await runGrokImagine({ prompt, cwd: path.dirname(target), kind: "image", targetPath: target });
    return produced && fs.existsSync(target) ? target : null;
  });
}

export async function generateImage(model: ImageModel, prompt: string, admission?: ImageAdmission): Promise<ImageResult> {
  let target: string | undefined;
  try {
    const clean = (prompt || "").trim().slice(0, 1200);
    if (!clean) return { ok: false, reason: "empty-prompt" };
    if (admission?.permission === "read") return { ok: false, reason: "image-permission-read" };
    const permission = admission?.permission;
    const dir = userDataPath("multimodal-images");
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `trex_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;

    const now = Date.now();
    // Grok (Imagine through the official CLI, subscription OAuth only) is used only when chosen: auto keeps codex → gemini.
    const preferred: Array<"codex" | "gemini" | "grok"> =
      model === "gemini"
        ? ["gemini"]
        : model === "codex"
          ? ["codex"]
          : model === "grok"
            ? ["grok"]
            : ["codex", "gemini"];
    // auto일 때만 쿨다운으로 순서 재배열(명시 모델은 사용자의 의도를 우선 존중).
    const order =
      model === "auto"
        ? [...preferred].sort((a, b) => (engineCooldown[a] > now ? 1 : 0) - (engineCooldown[b] > now ? 1 : 0))
        : preferred;

    let engine: "codex" | "gemini" | "grok" | null = null;
    for (const e of order) {
      const attemptDir = newAttemptDir(dir);
      const attemptTarget = path.join(attemptDir, fileName);
      const produced =
        e === "codex"
          ? await runCodexImage(clean, attemptTarget, undefined, permission)
          : e === "grok"
            ? await tryGrok(clean, attemptTarget, permission)
            : await tryGemini(clean, attemptTarget, permission);
      if (produced) {
        target = produced;
        engine = e;
        engineCooldown[e] = 0;
        break;
      }
      dropEmptyAttemptDir(attemptDir);
      engineCooldown[e] = now + COOLDOWN_MS;
    }
    if (!engine || !target) {
      // Retain partial media in its attempt folder for inspection and recovery.
      return { ok: false, reason: "all-engines-unavailable" };
    }

    const buf = fs.readFileSync(target);
    const mime = sniffImageMime(buf);
    return {
      ok: true,
      src: `data:${mime};base64,${buf.toString("base64")}`,
      engine,
      artifactPath: target,
    };
  } catch (e) {
    // Keep the original target, including partial media, for recovery.
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const EDIT_INPUT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Edit one image through a subscription route (NH34): Codex image_gen with the image attached (`codex exec -i`) or
 * Antigravity Nano Banana reading it from its directory. Grok Imagine and the paid Gemini API are not edit routes here;
 * an explicit route never falls through to another. The input is read, never changed; the output is a new file with
 * the input and output digests as lineage.
 */
export async function editImage(model: Exclude<ImageModel, "grok">, imagePath: string, instruction: string, admission?: ImageAdmission): Promise<ImageResult> {
  try {
    const clean = (instruction || "").trim().slice(0, 1200);
    if (!clean) return { ok: false, reason: "empty-instruction" };
    if (admission?.permission === "read") return { ok: false, reason: "image-permission-read" };
    const permission = admission?.permission;
    const stat = fs.statSync(imagePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > EDIT_INPUT_MAX_BYTES) return { ok: false, reason: "edit-input-invalid" };
    const source = fs.readFileSync(imagePath);
    const png = source.length > 8 && source.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = source.length > 3 && source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff;
    const webp = source.length > 12 && source.toString("latin1", 0, 4) === "RIFF" && source.toString("latin1", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp) return { ok: false, reason: "edit-input-not-image" };
    const { createHash } = await import("node:crypto");
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const dir = userDataPath("multimodal-images");
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `edit_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
    const order: Array<"codex" | "gemini"> = model === "codex" ? ["codex"] : model === "gemini" ? ["gemini"] : ["codex", "gemini"];
    for (const engine of order) {
      const attemptDir = newAttemptDir(dir);
      const target = path.join(attemptDir, fileName);
      const produced = engine === "codex" ? await runCodexImage(clean, target, imagePath, permission) : await runAgyNanoBanana(clean, target, imagePath, permission);
      if (!produced || !fs.existsSync(produced)) { dropEmptyAttemptDir(attemptDir); continue; }
      const output = fs.readFileSync(produced);
      const outputSha256 = createHash("sha256").update(output).digest("hex");
      // A route that copied the input back unchanged did not edit anything.
      if (outputSha256 === sourceSha256) { fs.rmSync(produced, { force: true }); dropEmptyAttemptDir(attemptDir); continue; }
      return { ok: true, engine, artifactPath: produced, src: `data:${sniffImageMime(output)};base64,${output.toString("base64")}`, lineage: { sourceSha256, outputSha256 } };
    }
    return { ok: false, reason: "all-engines-unavailable" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/**
 * Remove one generated source after its bytes have been copied into the
 * durable chat attachment store. The path is accepted only inside the
 * app-owned multimodal root and only when it is a private regular file.
 */
export function removeGeneratedImageArtifact(filePath: string): boolean {
  try {
    const root = fs.realpathSync.native(path.resolve(userDataPath("multimodal-images")));
    const candidate = path.resolve(filePath);
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) return false;
    fs.unlinkSync(candidate);
    // Its attempt folder (job-*) goes too once nothing else is left in it.
    const parent = path.dirname(candidate);
    if (parent !== root && path.dirname(parent) === root && path.basename(parent).startsWith("job-")) dropEmptyAttemptDir(parent);
    return true;
  } catch {
    return false;
  }
}

/** 매직바이트로 이미지 mime 판별 — 확장자와 실제 내용이 다를 수 있어 내용 기준으로 라벨링. */
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  return "image/png";
}

/** CLI presence is availability metadata, not a provider execution receipt. */
export async function imageProviders(): Promise<{ codex: boolean; gemini: boolean }> {
  const codex = !!resolveBin("codex", [
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]);
  // Nano Banana is the Antigravity subscription route; API keys are not its availability.
  const agy = !!resolveBin("agy", [
    path.join(os.homedir(), ".local/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ]);
  const gemini = agy;
  return { codex, gemini };
}
