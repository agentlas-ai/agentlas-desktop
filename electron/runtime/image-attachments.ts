import { isPrimarilyKorean, preferredLocaleFromText } from "../../shared/detect-language";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ImageAttachment } from "../../shared/types";
import type { RuntimeLocale } from "./status-i18n";
import { agentRunCwd } from "./exec";

interface StageRequest {
  userPrompt: string;
  images?: ImageAttachment[];
  cwd?: string;
  locale: RuntimeLocale;
  chatId?: string;
  runtimeSessionId?: string;
}

export interface StagedCliImage {
  path: string;
  mediaType: string;
  originalName?: string;
}

export interface StageCliImageResult {
  userPrompt: string;
  images: StagedCliImage[];
  directory?: string;
}

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const TEMP_ATTACHMENT_ROOT = path.join(os.tmpdir(), "agentlas-chat-attachments");

function safeBasename(name: string | undefined, fallback: string, ext: string): string {
  const raw = path.basename((name ?? "").trim() || fallback);
  const withoutUnsafe = raw.replace(/[^\w.\-() ]+/g, "_").replace(/\s+/g, " ").trim();
  const clipped = (withoutUnsafe || fallback).slice(0, 80);
  return path.extname(clipped) ? clipped : `${clipped}${ext}`;
}

function runSlug(req: StageRequest): string {
  const stable = req.runtimeSessionId ?? req.chatId ?? "chat";
  const safe = stable.replace(/[^\w.-]+/g, "-").slice(0, 48) || "chat";
  return `${safe}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function writeImages(dir: string, images: ImageAttachment[]): Promise<StagedCliImage[]> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const staged: StagedCliImage[] = [];
  for (const [index, image] of images.entries()) {
    const mediaType = image.mediaType || "application/octet-stream";
    const ext = EXT_BY_MEDIA_TYPE[mediaType.toLowerCase()] ?? ".img";
    const name = safeBasename(image.name, `image-${index + 1}${ext}`, ext);
    const filePath = path.join(dir, `${String(index + 1).padStart(2, "0")}-${name}`);
    await fs.writeFile(filePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
    staged.push({ path: filePath, mediaType, originalName: image.name });
  }
  return staged;
}

async function stageImages(req: StageRequest, images: ImageAttachment[]): Promise<StageCliImageResult> {
  const slug = runSlug(req);
  const fallbackDir = path.join(TEMP_ATTACHMENT_ROOT, slug);
  const cwd = req.cwd ?? agentRunCwd();
  const preferredDir = path.join(cwd, ".agentlas", "chat-attachments", slug);
  const guideLocale = attachmentGuideLocale(req.userPrompt, req.locale);
  try {
    const staged = await writeImages(preferredDir, images);
    return { userPrompt: appendAttachmentGuide(req.userPrompt, staged, guideLocale), images: staged, directory: preferredDir };
  } catch (primaryError) {
    try {
      const staged = await writeImages(fallbackDir, images);
      return { userPrompt: appendAttachmentGuide(req.userPrompt, staged, guideLocale), images: staged, directory: fallbackDir };
    } catch (fallbackError) {
      const detail =
        fallbackError instanceof Error
          ? fallbackError.message
          : primaryError instanceof Error
            ? primaryError.message
            : String(fallbackError);
      throw new Error(
        req.locale === "ko"
          ? `첨부 이미지를 실행용 파일로 준비하지 못했습니다: ${detail}`
          : `Could not prepare attached images for the runtime: ${detail}`,
      );
    }
  }
}

function attachmentGuideLocale(prompt: string, fallback: RuntimeLocale): RuntimeLocale {
  if (isPrimarilyKorean(prompt)) return "ko";
  if (/[A-Za-z]{3,}/.test(prompt)) return "en";
  return fallback;
}

function appendAttachmentGuide(prompt: string, images: StagedCliImage[], _locale: RuntimeLocale): string {
  if (images.length === 0) return prompt;
  const list = images
    .map((image, index) => {
      const original = image.originalName ? `, original: ${image.originalName}` : "";
      return `${index + 1}. ${image.path} (${image.mediaType}${original})`;
    })
    .join("\n");
  const guide = ["[Attached images] saved as files; read these paths first, do not search Downloads:", list].join("\n");
  return prompt.trim() ? `${prompt}\n\n${guide}` : guide;
}

export async function stageCliImageAttachments(req: StageRequest): Promise<StageCliImageResult> {
  const images = req.images ?? [];
  if (images.length === 0) return { userPrompt: req.userPrompt, images: [] };
  return stageImages(req, images);
}
