// T-rex 슬라이드 배경 이미지 생성 — 키 없는 CLI 경로(codex image_gen) 우선.
//  - codex: `codex exec`의 내장 image_gen(OAuth, API 키 불필요) — 검증된 키리스 경로.
//  - gemini(나노바나나): 플레인 Gemini CLI는 이미지 툴 미노출(NO_IMAGE_GEN/404)이라,
//    GEMINI_API_KEY가 보관함에 있을 때만 @google/genai로 생성(없으면 needs-key).
// 결과는 data:image/png;base64 로 렌더러에 바로 넘겨 슬라이드 배경으로 깐다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

export type TrexImageModel = "codex" | "gemini";
export interface TrexImageResult {
  ok: boolean;
  src?: string;
  reason?: string;
}

function resolveBin(name: string, extra: string[]): string | null {
  const fromPath = (process.env.PATH || "").split(":").filter(Boolean).map((d) => path.join(d, name));
  for (const c of [...extra, ...fromPath]) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
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

async function runCodexImage(prompt: string, target: string, cwd: string): Promise<boolean> {
  const bin = resolveBin("codex", [
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]);
  if (!bin) return false;
  const instruction =
    `Use your built-in image_gen tool to generate exactly ONE image and save the PNG to ${target} ` +
    `(largest landscape size, e.g. 1536x1024). IMAGE PROMPT: ${prompt}. ` +
    `Absolutely no text, no words, no letters, no numbers, no logo, no watermark. ` +
    `If you cannot generate images print exactly NO_IMAGE_GEN.`;
  const since = Date.now() - 3000;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    let child;
    try {
      child = spawn(bin, ["exec", "-s", "workspace-write", "--skip-git-repo-check", instruction], { cwd, env: process.env });
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish();
    }, 150_000);
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
async function runAgyNanoBanana(prompt: string, target: string): Promise<boolean> {
  const bin = resolveBin("agy", [
    path.join(os.homedir(), ".local/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ]);
  if (!bin) return false;
  const outDir = path.dirname(target);
  const instruction =
    `Use your image generation capability (Nano Banana / Gemini image) to generate exactly ONE image: ${prompt}. ` +
    `Save the resulting PNG file to the absolute path ${target}. ` +
    `No text, no words, no letters, no numbers, no logo, no watermark. If you cannot generate images, reply exactly NO_IMAGE_GEN.`;
  const scratch = path.join(os.homedir(), ".gemini", "antigravity-cli", "scratch");
  const since = Date.now() - 3000;
  const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" };
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    let child;
    try {
      child = spawn(bin, ["--dangerously-skip-permissions", "--add-dir", outDir, "--print", instruction], { cwd: outDir, env });
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish();
    }, 180_000);
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
}

export async function generateTrexImage(model: TrexImageModel, prompt: string): Promise<TrexImageResult> {
  try {
    const clean = (prompt || "").trim().slice(0, 1200);
    if (!clean) return { ok: false, reason: "empty-prompt" };
    const dir = path.join(app.getPath("userData"), "trex-images");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `trex_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`);

    if (model === "gemini") {
      // 1) Antigravity CLI(agy) 나노바나나 — 키리스(OAuth). 연결한 사용자면 누구나.
      const agyOk = await runAgyNanoBanana(clean, target);
      if (!agyOk) {
        // 2) 폴백: GEMINI_API_KEY가 있으면 Imagen으로.
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
        if (!apiKey) return { ok: false, reason: "gemini-needs-connect" };
        const ok = await runGeminiImage(clean, target, apiKey);
        if (!ok) return { ok: false, reason: "gemini-failed" };
      }
    } else {
      const ok = await runCodexImage(clean, target, dir);
      if (!ok) return { ok: false, reason: "codex-unavailable" };
    }

    const buf = fs.readFileSync(target);
    return { ok: true, src: `data:image/png;base64,${buf.toString("base64")}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 드롭다운 가용성 — codex bin 존재 / gemini 키 존재 여부를 렌더러에 알려준다. */
export function trexImageProviders(): { codex: boolean; gemini: boolean } {
  const codex = !!resolveBin("codex", [
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]);
  // 나노바나나 = Antigravity CLI(agy) 키리스, 또는 GEMINI_API_KEY 폴백.
  const agy = !!resolveBin("agy", [
    path.join(os.homedir(), ".local/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ]);
  const gemini = agy || !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return { codex, gemini };
}
