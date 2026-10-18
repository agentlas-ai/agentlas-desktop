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
import { antigravityPermissionArgs } from "../runtime/antigravity";
import { invocationBreaker, invocationBreakerKey } from "../runtime/invocation-breaker";
import { withModelCallLedger, withModelCallScope } from "../runtime/model-call-ledger";
import type { Runner, RunnerResult } from "../runtime/runner";

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
 * Every engine run goes through the same model-call ledger and invocation breaker as a runtime turn (R-078). Production
 * 2026-10-13..17: nine generate_image runs (five for the Yotube room on 10-17) spawned `agy --dangerously-skip-permissions
 * --print` directly; none was in the ledger (the last antigravity row was 10-16 08:02Z), none counted by the breaker,
 * and the room's write permission was not applied.
 */
const IMAGE_ENGINE_RUNTIME: Record<ImageEngine, { kind: string; backend: string; source: string; label: string }> = {
  codex: { kind: "codex", backend: "openai", source: "codex", label: "Codex image" },
  gemini: { kind: "antigravity", backend: "google", source: "agy", label: "Antigravity image" },
  grok: { kind: "grok", backend: "xai", source: "grok", label: "Grok Imagine" },
};

async function runImageEngine(engine: ImageEngine, phase: "multimodal-image" | "multimodal-image-edit", instruction: string,
  permission: "write" | "full" | undefined, produce: () => Promise<boolean>): Promise<boolean> {
  const runtime = IMAGE_ENGINE_RUNTIME[engine];
  const adapter: Runner = async (): Promise<RunnerResult> => (await produce())
    ? { text: "", ownerControlTerminal: "completed" }
    : { text: "", ownerControlTerminal: "completed", failure: { kind: "exit", runtime: runtime.kind, source: "marker",
      providerCode: "image_not_produced", message: `${runtime.label} produced no image.` } };
  const runner = invocationBreaker.wrap(withModelCallLedger(adapter, { kind: runtime.kind, backend: runtime.backend, model: null, effort: null }),
    invocationBreakerKey(runtime), runtime.label);
  try {
    const result = await withModelCallScope({ role: "worker", phase }, () => runner({ systemPrompt: "", history: [], userPrompt: instruction,
      backendLabel: runtime.label, locale: "en", ...(permission ? { permission } : {}), singleUse: true }, { onPartial: () => {}, onStatus: () => {} }));
    return !result.failure;
  } catch {
    return false;
  }
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

function newestPngSince(dir: string, since: number): string | null {
  const out: Array<{ p: string; m: number }> = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.png$/i.test(e.name)) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m >= since) out.push({ p, m });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  out.sort((a, b) => b.m - a.m);
  return out[0]?.p ?? null;
}

async function runCodexImage(prompt: string, target: string, cwd: string, inputImage?: string, permission?: "write" | "full"): Promise<boolean> {
  const bin = resolveBin("codex", [
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]);
  if (!bin) return false;
  const instruction = inputImage
    // Edit: the attached image is the source; the instruction says what changes (NH34).
    ? `Use your built-in image_gen tool to edit the attached image and save exactly ONE resulting PNG to ${target}. ` +
      `EDIT: ${prompt}. Keep everything the edit does not mention. If you cannot edit images print exactly NO_IMAGE_GEN.`
    : `Use your built-in image_gen tool to generate exactly ONE image and save the PNG to ${target} ` +
      `(largest landscape size, e.g. 1536x1024). IMAGE PROMPT: ${prompt}. ` +
      `Absolutely no text, no words, no letters, no numbers, no logo, no watermark. ` +
      `If you cannot generate images print exactly NO_IMAGE_GEN.`;
  const since = Date.now() - 3000;
  // workspace-write is already below every permission that may generate an image (write and full).
  return runImageEngine("codex", inputImage ? "multimodal-image-edit" : "multimodal-image", instruction, permission, async () => {
  await new Promise<void>((resolve) => {
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
      child = spawn(bin, ["exec", "-s", "workspace-write", "--skip-git-repo-check", ...(inputImage ? ["-i", inputImage] : []), instruction], {
        cwd,
        // The user's Codex home without their personal AGENTS.md, like every product run.
        env: withCodexProductHome(process.env),
        stdio: ["ignore", "ignore", "ignore"],
        ...detachedSpawnOpts(),
      });
      trackRunChild(child);
    } catch {
      finish();
      return;
    }
    // 실측: codex image_gen은 콜드 스타트 시 2~4분 — 150s는 완성 직전에 죽인다(all-engines 오탐 원인).
    const timer = setTimeout(() => {
      try {
        if (child) killCliTree(child, 250);
      } catch {
        /* ignore */
      }
      finish();
    }, 300_000);
    child.on("close", () => {
      clearTimeout(timer);
      finish();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
  if (fs.existsSync(target)) return true;
  const found = newestPngSince(path.join(os.homedir(), ".codex", "generated_images"), since);
  if (found) {
    try {
      fs.copyFileSync(found, target);
      return true;
    } catch {
      /* ignore */
    }
  }
  return false;
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
 * 앱에 Antigravity를 연결한 사용자면 누구나 키 없이 이미지 생성. agy는 활성 워크스페이스가 없으면
 * ~/.gemini/antigravity-cli/scratch 에 저장하므로, --add-dir로 출력폴더 권한을 주고, 실패 시 scratch의
 * 최신 PNG를 target으로 복사한다.
 */
async function runAgyNanoBanana(prompt: string, target: string, inputImage?: string, permission?: "write" | "full"): Promise<boolean> {
  const bin = resolveBin("agy", [
    path.join(os.homedir(), ".local/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ]);
  if (!bin) return false;
  const outDir = path.dirname(target);
  const instruction = inputImage
    ? `Use your image generation capability (Nano Banana / Gemini image) to edit the image at the absolute path ${inputImage}: ${prompt}. ` +
      `Keep everything the edit does not mention. Save exactly ONE resulting PNG to the absolute path ${target}. If you cannot edit images, reply exactly NO_IMAGE_GEN.`
    : `Use your image generation capability (Nano Banana / Gemini image) to generate exactly ONE image: ${prompt}. ` +
      `Save the resulting PNG file to the absolute path ${target}. ` +
      `No text, no words, no letters, no numbers, no logo, no watermark. If you cannot generate images, reply exactly NO_IMAGE_GEN.`;
  const scratch = path.join(os.homedir(), ".gemini", "antigravity-cli", "scratch");
  const since = Date.now() - 3000;
  // HOME mirror: the conversation stays in the product store; scratch/ is linked, so the image is still found there.
  const env = withAgyProductHome({ ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" }, undefined, undefined);
  // The selected route uses subscription OAuth, regardless of ambient API keys.
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"]) delete env[key];
  // The room's permission, as for every agy run: write is sandboxed, full is not. A caller with no room keeps full.
  const permissionArgs = antigravityPermissionArgs(permission ?? "full");
  return runImageEngine("gemini", inputImage ? "multimodal-image-edit" : "multimodal-image", instruction, permission, async () => {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    let child;
    try {
      // stdin ignore — codex와 동일한 stdin-EOF 대기 블록 방지.
      child = spawn(bin, [...permissionArgs, "--add-dir", outDir, ...(inputImage ? ["--add-dir", path.dirname(inputImage)] : []), "--print", instruction], {
        cwd: outDir,
        env,
        stdio: ["ignore", "ignore", "ignore"],
        ...detachedSpawnOpts(),
      });
      trackRunChild(child);
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child) killCliTree(child, 250);
      } catch {
        /* ignore */
      }
      finish();
    }, 300_000);
    child.on("close", () => {
      clearTimeout(timer);
      finish();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
  if (fs.existsSync(target)) return true;
  const found = newestPngSince(scratch, since) || newestPngSince(outDir, since);
  if (found && found !== target) {
    try {
      fs.copyFileSync(found, target);
    } catch {
      /* ignore */
    }
  }
  return fs.existsSync(target);
  });
}

/** The subscription route never falls through to a paid API transport. */
async function tryGemini(clean: string, target: string, permission?: "write" | "full"): Promise<boolean> {
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
async function tryGrok(prompt: string, target: string, dir: string, permission?: "write" | "full"): Promise<boolean> {
  const { runGrokImagine } = await import("./grok-imagine");
  // Grok Imagine keeps its own media-only boundary (--sandbox strict, shell/edit denied) for every permission.
  return runImageEngine("grok", "multimodal-image", prompt, permission, async () => {
    const produced = await runGrokImagine({ prompt, cwd: dir, kind: "image", targetPath: target });
    return Boolean(produced) && fs.existsSync(target);
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
    target = path.join(dir, `trex_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`);

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
      const ok =
        e === "codex"
          ? await runCodexImage(clean, target, dir, undefined, permission)
          : e === "grok"
            ? await tryGrok(clean, target, dir, permission)
            : await tryGemini(clean, target, permission);
      if (ok) {
        engine = e;
        engineCooldown[e] = 0;
        break;
      }
      engineCooldown[e] = now + COOLDOWN_MS;
    }
    if (!engine) {
      // Retain partial media at its durable target for inspection and recovery.
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
    const target = path.join(dir, `edit_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`);
    const order: Array<"codex" | "gemini"> = model === "codex" ? ["codex"] : model === "gemini" ? ["gemini"] : ["codex", "gemini"];
    for (const engine of order) {
      const ok = engine === "codex" ? await runCodexImage(clean, target, dir, imagePath, permission) : await runAgyNanoBanana(clean, target, imagePath, permission);
      if (!ok || !fs.existsSync(target)) continue;
      const output = fs.readFileSync(target);
      const outputSha256 = createHash("sha256").update(output).digest("hex");
      // A route that copied the input back unchanged did not edit anything.
      if (outputSha256 === sourceSha256) { fs.rmSync(target, { force: true }); continue; }
      return { ok: true, engine, artifactPath: target, src: `data:${sniffImageMime(output)};base64,${output.toString("base64")}`, lineage: { sourceSha256, outputSha256 } };
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
