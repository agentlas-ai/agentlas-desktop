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

export type TrexImageModel = "codex" | "gemini" | "auto";
export interface TrexImageResult {
  ok: boolean;
  src?: string;
  reason?: string;
  /** 실제 생성에 성공한 엔진(auto 페일오버 추적용). */
  engine?: "codex" | "gemini";
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
      // stdin은 반드시 닫는다(ignore) — 파이프로 열려 있으면 codex가
      // "Reading additional input from stdin..."으로 EOF를 기다리며 영원히 블록된다.
      child = spawn(bin, ["exec", "-s", "workspace-write", "--skip-git-repo-check", instruction], {
        cwd,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      finish();
      return;
    }
    // 실측: codex image_gen은 콜드 스타트 시 2~4분 — 150s는 완성 직전에 죽인다(all-engines 오탐 원인).
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
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
      // stdin ignore — codex와 동일한 stdin-EOF 대기 블록 방지.
      child = spawn(bin, ["--dangerously-skip-permissions", "--add-dir", outDir, "--print", instruction], {
        cwd: outDir,
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
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
}

/** gemini 경로 1회 시도 — agy 나노바나나(키리스) → GEMINI_API_KEY Imagen 폴백. */
async function tryGemini(clean: string, target: string): Promise<boolean> {
  const agyOk = await runAgyNanoBanana(clean, target);
  if (agyOk) return true;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) return false;
  return runGeminiImage(clean, target, apiKey);
}

// auto 페일오버 상태 — 한 엔진이 실패(쿼터 소진/미설치)하면 세션 내 잠시 뒤로 미룬다(15분).
// 매 이미지마다 죽은 엔진에 150초 타임아웃을 다시 태우는 낭비를 막는 소프트 쿨다운.
const engineCooldown: Record<"codex" | "gemini", number> = { codex: 0, gemini: 0 };
const COOLDOWN_MS = 15 * 60 * 1000;

/**
 * 이미지 생성. model="auto"면 codex→gemini 순으로 시도하고, 실패한 엔진은 쿨다운을 걸어
 * 남은 사용량이 있는 쪽을 자동으로 쓴다(사용자 요구: 사용량 부족 시 남는 곳 자동 사용).
 * 명시 모델(codex/gemini)이어도 실패 시 반대쪽을 1회 시도한다 — 이미지 없는 덱보다 낫다.
 */
export async function generateTrexImage(model: TrexImageModel, prompt: string): Promise<TrexImageResult> {
  try {
    const clean = (prompt || "").trim().slice(0, 1200);
    if (!clean) return { ok: false, reason: "empty-prompt" };
    const dir = path.join(app.getPath("userData"), "trex-images");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `trex_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`);

    const now = Date.now();
    const preferred: Array<"codex" | "gemini"> =
      model === "gemini"
        ? ["gemini", "codex"]
        : ["codex", "gemini"];
    // auto일 때만 쿨다운으로 순서 재배열(명시 모델은 사용자의 의도를 우선 존중).
    const order =
      model === "auto"
        ? [...preferred].sort((a, b) => (engineCooldown[a] > now ? 1 : 0) - (engineCooldown[b] > now ? 1 : 0))
        : preferred;

    let engine: "codex" | "gemini" | null = null;
    for (const e of order) {
      const ok =
        e === "codex"
          ? await runCodexImage(clean, target, dir)
          : await tryGemini(clean, target);
      if (ok) {
        engine = e;
        engineCooldown[e] = 0;
        break;
      }
      engineCooldown[e] = now + COOLDOWN_MS;
    }
    if (!engine) return { ok: false, reason: "all-engines-unavailable" };

    const buf = fs.readFileSync(target);
    const mime = sniffImageMime(buf);
    return { ok: true, src: `data:${mime};base64,${buf.toString("base64")}`, engine };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 매직바이트로 이미지 mime 판별 — 확장자와 실제 내용이 다를 수 있어 내용 기준으로 라벨링. */
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  return "image/png";
}

/** 드롭다운 가용성 — codex bin 존재 / gemini 키 존재 여부를 렌더러에 알려준다. */
export async function trexImageProviders(): Promise<{ codex: boolean; gemini: boolean }> {
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
