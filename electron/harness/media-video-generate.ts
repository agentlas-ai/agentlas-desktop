/*
 * media.video.generate — text-to-video through a connector route (docs/2026-10-13-native-harness/17 §3-§6).
 *
 * The route is chosen by the owner or the model, never by the host from the prompt text: an explicit routeId wins;
 * without one only the owner's saved video provider (when it is a ready text route) is used. A paid API route is never
 * picked silently (§5: a subscription to API move is a separate plan, not a hidden fallback), so with nothing selected
 * the answer is a refusal that lists the ready routes. The job itself is the video.ts job (same store, polling, cancel,
 * artifact persistence and recovery as media.video.animate-image); media.job.status / media.job.cancel read it.
 * No electron import at top level: the daemon loads this module.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MediaVideoGenerateResult =
  | { status: "ok"; data: unknown }
  | { status: "refused" | "unavailable"; reason: string; next?: string };

interface PortContext { chatId: string; runId: string; dryRun?: boolean }

const ASPECTS = ["16:9", "9:16", "1:1"] as const;
type Aspect = (typeof ASPECTS)[number];

const refused = (reason: string, next?: string): MediaVideoGenerateResult => ({ status: "refused", reason, ...(next ? { next } : {}) });

async function appendReceipt(entry: Record<string, unknown>): Promise<void> {
  try {
    const { userDataPath } = await import("../runtime-paths");
    const file = userDataPath(path.join("harness", "receipts.jsonl"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ receiptId: `hr_${randomUUID()}`, at: new Date().toISOString(), ...entry });
    if (Buffer.byteLength(line) <= 64 * 1024) fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // The ledger is evidence, not a gate.
  }
}

interface ReadyRoute { routeId: string; label: string; billing: string; provider: string }

/** Text-capable routes that are ready AND hold the key the job will actually read. */
async function readyTextRoutes(): Promise<{ ready: ReadyRoute[]; capable: string[] }> {
  const { mediaRoutes, routeReadiness, VIDEO_JOB_PROVIDER } = await import("./media-routes");
  const { videoKeyStatus } = await import("../multimodal/video");
  const capable = (await mediaRoutes()).filter((route) => route.operations.includes("media.video.generate") && !route.adapterRequired && VIDEO_JOB_PROVIDER[route.routeId]);
  // An unreadable key store means no route is ready (refused with the reason below), never a thrown operation.
  const keys: Partial<Awaited<ReturnType<typeof videoKeyStatus>>> = await videoKeyStatus().catch(() => ({}));
  const ready: ReadyRoute[] = [];
  for (const route of capable) {
    const provider = VIDEO_JOB_PROVIDER[route.routeId];
    if (await routeReadiness(route) !== "ready") continue;
    // The grok job provider has two credentials: the subscription CLI (image-to-video) and the xAI key (this route).
    const keyField = route.routeId === "grok-api-video" ? "grokApi" : provider;
    if (!keys[keyField as keyof typeof keys]) continue;
    ready.push({ routeId: route.routeId, label: route.label, billing: route.billing, provider });
  }
  return { ready, capable: capable.map((route) => route.routeId) };
}

export async function mediaVideoGenerate(args: Record<string, unknown>, ctx: PortContext): Promise<MediaVideoGenerateResult> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return refused("prompt_required");
  if (prompt.length > 12_000) return refused("prompt_too_long");
  const routeId = typeof args.routeId === "string" ? args.routeId.trim() : "";
  const durationSeconds = args.durationSeconds;
  if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60)) {
    return refused("duration_invalid", "durationSeconds is a number of seconds between 1 and 60");
  }
  const aspectRatio = args.aspectRatio;
  if (aspectRatio !== undefined && !ASPECTS.includes(aspectRatio as Aspect)) return refused("aspect_ratio_invalid", "aspectRatio is 16:9, 9:16 or 1:1");

  const { ready, capable } = await readyTextRoutes();
  const listing = ready.length ? `ready text-to-video routes: ${ready.map((route) => route.routeId).join(", ")}` : "no text-to-video route is ready; connect a key in Environment Keys (media.routes shows each reason)";

  let chosen: ReadyRoute | undefined;
  if (routeId) {
    if (!capable.includes(routeId)) return refused("route_not_text_video_capable", `routes with a text-to-video caller: ${capable.join(", ") || "none"}`);
    chosen = ready.find((route) => route.routeId === routeId);
    if (!chosen) return refused("route_not_ready", listing);
  } else {
    if (ready.length === 0) return refused("no_ready_video_route", listing);
    // The owner's saved video provider is an owner selection; anything else would be the host choosing a paid route.
    let saved = "";
    try {
      const { getMultimodalSettings } = await import("../multimodal/settings");
      saved = getMultimodalSettings().videoProvider;
    } catch { /* settings unreadable: no owner selection */ }
    chosen = ready.find((route) => route.routeId === saved);
    if (!chosen) {
      const subscription = ready.filter((route) => route.billing === "subscription");
      if (subscription.length === 1) chosen = subscription[0];
    }
    if (!chosen) return refused("route_selection_required", `pass routeId (a paid API route is never picked for you); ${listing}`);
  }

  if (ctx.dryRun) return { status: "ok", data: { dryRun: true, started: false, routeId: chosen.routeId, billing: chosen.billing } };

  const { startVideoJob } = await import("../multimodal/video");
  try {
    const job = startVideoJob({
      provider: chosen.provider as Parameters<typeof startVideoJob>[0]["provider"],
      prompt,
      textOnly: true,
      ...(typeof durationSeconds === "number" ? { durationSec: durationSeconds } : {}),
      ...(aspectRatio ? { aspectRatio: aspectRatio as Aspect } : {}),
    });
    await appendReceipt({ operationId: "media.video.generate", jobId: job.id, routeId: chosen.routeId, provider: chosen.provider, billing: chosen.billing, chatId: ctx.chatId, runId: ctx.runId });
    return { status: "ok", data: { jobId: job.id, routeId: chosen.routeId, status: job.status, next: "media.job.status with this jobId" } };
  } catch (error) {
    return refused(error instanceof Error ? error.message.slice(0, 120) : "video_job_refused");
  }
}
