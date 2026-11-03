/**
 * The one place a turn's pictures are fitted to the selected runtime's provider limits (media-carousel).
 *
 * Attaching has no count or size limit any more; what a model can take still does. Every product runner passes pickRunner
 * (runtime/selection.ts), which wraps the selected adapter with withModelImageBudget, so the same rule holds for the seven
 * subscription CLIs, BYOK, Agentlas serving, agentlas-local and the local model servers, in Main and in the daemon.
 *
 *   - a picture over the runtime's edge or byte bound goes as a resized copy (the stored original is untouched);
 *   - more pictures than the runtime takes go as captioned contact sheets (#1, #2 … in the owner's order), so the model
 *     still sees every one of them; no picture is dropped;
 *   - earlier turns' pictures (history imageDataUrls) are resized the same way, never removed.
 * When sharp cannot load or decode a picture, that picture goes unchanged (the provider's own refusal stays visible).
 * No prompt text is added or changed here.
 */
import type { ImageAttachment } from "../../shared/types";
import { contactSheet, fitImage } from "../media/image-fit";
import type { Runner, RunnerRequest } from "./runner";

export interface ModelImageBudget {
  /** Pictures one request may carry. */
  maxImages: number;
  /** Longest side in pixels. */
  maxEdge: number;
  /** Largest picture in bytes (raw, before base64). */
  maxBytes: number;
}

/** Anthropic: 5 MB base64 a picture, 2000 px once a request has more than 20 pictures. 3.75 MB raw stays under 5 MB base64. */
const API_BYTES = Math.floor(3.75 * 1024 * 1024);
const BUDGETS: Readonly<Record<string, ModelImageBudget>> = Object.freeze({
  // Subscription CLIs stage pictures as files and read them with their own tools (image-attachments.ts).
  "claude-code": { maxImages: 32, maxEdge: 2000, maxBytes: API_BYTES },
  codex: { maxImages: 32, maxEdge: 2000, maxBytes: API_BYTES },
  antigravity: { maxImages: 32, maxEdge: 2000, maxBytes: API_BYTES },
  kimi: { maxImages: 32, maxEdge: 2000, maxBytes: API_BYTES },
  grok: { maxImages: 32, maxEdge: 2000, maxBytes: API_BYTES },
  cursor: { maxImages: 32, maxEdge: 2000, maxBytes: API_BYTES },
  acp: { maxImages: 32, maxEdge: 2000, maxBytes: API_BYTES },
  // API keys: Anthropic accepts up to 100 a request, but more than 20 lowers its edge bound to 2000 px; OpenAI-compatible fits too.
  byok: { maxImages: 20, maxEdge: 2000, maxBytes: API_BYTES },
  // Agentlas serving forwards at most 8 pictures a request, tool captures included (agentlas-serving.ts).
  agentlas: { maxImages: 8, maxEdge: 2000, maxBytes: API_BYTES },
  // Local vision models: few pictures, smaller edge (memory on the owner's machine).
  "agentlas-local": { maxImages: 8, maxEdge: 1536, maxBytes: 3 * 1024 * 1024 },
  ollama: { maxImages: 8, maxEdge: 1536, maxBytes: 3 * 1024 * 1024 },
  lmstudio: { maxImages: 8, maxEdge: 1536, maxBytes: 3 * 1024 * 1024 },
  mlx: { maxImages: 8, maxEdge: 1536, maxBytes: 3 * 1024 * 1024 },
});
const DEFAULT_BUDGET: ModelImageBudget = { maxImages: 8, maxEdge: 1536, maxBytes: 3 * 1024 * 1024 };

export function modelImageBudget(kind: string | undefined): ModelImageBudget {
  return (kind && BUDGETS[kind]) || DEFAULT_BUDGET;
}

function decoded(image: ImageAttachment): Buffer | null {
  if (!image || typeof image.data !== "string" || image.data.length < 4) return null;
  try { return Buffer.from(image.data, "base64"); } catch { return null; }
}

async function fitOne(image: ImageAttachment, budget: ModelImageBudget): Promise<ImageAttachment> {
  const bytes = decoded(image);
  if (!bytes) return image;
  const fitted = await fitImage(bytes, { maxEdge: budget.maxEdge, maxBytes: budget.maxBytes });
  if (!fitted || !fitted.resized) return image;
  return { ...image, mediaType: fitted.mediaType, data: fitted.bytes.toString("base64") };
}

/**
 * The pictures of one request, fitted to the budget: each within bounds, at most maxImages, none dropped. `combine: false`
 * fits sizes only (the outer pass, before the agent context journals the turn and adds earlier pictures).
 */
export async function fitModelImages(images: readonly ImageAttachment[], budget: ModelImageBudget, combine = true): Promise<ImageAttachment[]> {
  if (!images.length) return [];
  if (!combine || images.length <= budget.maxImages) return Promise.all(images.map((image) => fitOne(image, budget)));
  // More pictures than the runtime takes: every slot becomes a sheet of consecutive pictures, captioned with their numbers.
  const perSheet = Math.ceil(images.length / budget.maxImages);
  const sheets: ImageAttachment[] = [];
  for (let start = 0; start < images.length; start += perSheet) {
    const group = images.slice(start, start + perSheet);
    const tiles = group.map((image, offset) => ({ bytes: decoded(image) ?? Buffer.alloc(0), label: `#${start + offset + 1}` }));
    const sheet = await contactSheet(tiles, { maxEdge: budget.maxEdge, maxBytes: budget.maxBytes });
    if (!sheet) return Promise.all(images.map((image) => fitOne(image, budget))); // no sharp: unchanged, the provider decides
    sheets.push({ name: `pictures-${start + 1}-${start + group.length}.jpg`, mediaType: sheet.mediaType, data: sheet.bytes.toString("base64") });
  }
  return sheets;
}

const DATA_URL_RE = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

async function fitDataUrl(url: string, budget: ModelImageBudget): Promise<string> {
  const match = DATA_URL_RE.exec(url);
  if (!match) return url;
  const fitted = await fitOne({ mediaType: match[1], data: match[2] }, budget);
  return fitted.data === match[2] ? url : `data:${fitted.mediaType};base64,${fitted.data}`;
}

/** The fitted pictures and history of a request, or null when nothing needs to change. */
export async function fittedRunnerRequestImages(req: RunnerRequest, kind: string | undefined, combine = true): Promise<{ images?: ImageAttachment[]; history?: RunnerRequest["history"] } | null> {
  const budget = modelImageBudget(kind);
  const images = req.images ?? [];
  const history = Array.isArray(req.history) ? req.history : [];
  const historyHasImages = history.some((row) => Array.isArray((row as { imageDataUrls?: unknown }).imageDataUrls) && (row as { imageDataUrls: unknown[] }).imageDataUrls.length > 0);
  if (!images.length && !historyHasImages) return null;
  const nextImages = images.length ? await fitModelImages(images, budget, combine) : images;
  const nextHistory = historyHasImages
    ? await Promise.all(history.map(async (row) => {
        const urls = (row as { imageDataUrls?: unknown }).imageDataUrls;
        if (!Array.isArray(urls) || !urls.length) return row;
        const fitted = await Promise.all(urls.map((url) => typeof url === "string" ? fitDataUrl(url, budget) : url));
        return fitted.every((url, index) => url === urls[index]) ? row : { ...row, imageDataUrls: fitted };
      }))
    : history;
  const imagesChanged = nextImages.length !== images.length || nextImages.some((image, index) => image !== images[index]);
  const historyChanged = nextHistory.some((row, index) => row !== history[index]);
  if (!imagesChanged && !historyChanged) return null;
  return { ...(imagesChanged ? { images: nextImages } : {}), ...(historyChanged ? { history: nextHistory as RunnerRequest["history"] } : {}) };
}

/**
 * Wrap the selected adapter: every request it receives carries pictures its provider accepts. The request object is
 * updated in place, never copied: host bindings (agent context, approvals, turn context, memory) are keyed by its identity.
 * A request a caller froze keeps its pictures (the provider's own answer then stays visible).
 */
export function withModelImageBudget(runner: Runner, kind: string | undefined, options: { combine?: boolean } = {}): Runner {
  return async (req, events) => {
    const fitted = await fittedRunnerRequestImages(req, kind, options.combine ?? true).catch(() => null);
    if (fitted) {
      try {
        if (fitted.images) (req as { images?: ImageAttachment[] }).images = fitted.images;
        if (fitted.history) (req as { history?: RunnerRequest["history"] }).history = fitted.history;
      } catch { /* frozen request: unchanged */ }
    }
    return runner(req, events);
  };
}
