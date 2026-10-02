













import { getDb } from "./store/db";

export const CHANNEL_PUBLISH_RECEIPT_KIND = "channel_publish_receipt";
export const CHANNEL_PUBLISH_RECEIPT_SCHEMA = "agentlas.channel-publish-receipt.v1";

export interface ChannelPublishReceipt {
  platform: "youtube";
  videoId: string;
  url: string;
  /** How the host saw it: "studio-video-page" (own-video Studio link) or "upload-dialog-link". */
  evidence: "studio-video-page" | "upload-dialog-link";
  firstSeenAt: string;
  runId: string;
}

const VIDEO_ID = "[A-Za-z0-9_-]{11}";
const STUDIO_PAGE = /Page URL:\s*https:\/\/studio\.youtube\.com\//;
const STUDIO_VIDEO_LINK = new RegExp(`studio\\.youtube\\.com/video/(${VIDEO_ID})/(?:edit|analytics|comments|monetization|editor)`, "g");
const PUBLIC_VIDEO_LINK = new RegExp(`(?:youtube\\.com/shorts/|youtu\\.be/|youtube\\.com/watch\\?v=)(${VIDEO_ID})(?![A-Za-z0-9_-])`, "g");

/** Own-channel video ids named in one successful Studio tool result. Pure; exported for contracts. */
export function youtubeOwnVideosInStudioResult(text: string): Array<{ videoId: string; evidence: ChannelPublishReceipt["evidence"] }> {
  if (!text || !STUDIO_PAGE.test(text)) return [];
  const found = new Map<string, ChannelPublishReceipt["evidence"]>();
  for (const match of text.matchAll(STUDIO_VIDEO_LINK)) found.set(match[1]!, "studio-video-page");
  // The upload/publish dialog shows "Video link" followed by the new video's public URL. Other public links on
  // Studio pages (news cards, inspiration) are other channels' videos and are never taken on their own.
  for (const match of text.matchAll(PUBLIC_VIDEO_LINK)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 200), match.index ?? 0);
    if (/Video link|동영상 링크/i.test(before) && !found.has(match[1]!)) found.set(match[1]!, "upload-dialog-link");
  }
  return [...found].map(([videoId, evidence]) => ({ videoId, evidence }));
}

/** Called for each recorded tool event. Records nothing unless a successful Studio result names own videos. */
export function recordChannelPublishReceipts(
  event: { runId: string; chatId: string | null; payload: Record<string, unknown> },
  record: (input: { runId: string; chatId: string | null; kind: string; sourceEventId: string; payload: Record<string, unknown> }) => void,
): number {
  const payload = event.payload;
  if (payload.toolIsError !== false || typeof payload.toolResultPreview !== "string") return 0;
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
  if (!/browser/i.test(toolName)) return 0;
  const videos = youtubeOwnVideosInStudioResult(payload.toolResultPreview);
  for (const video of videos) {
    record({ runId: event.runId, chatId: event.chatId, kind: CHANNEL_PUBLISH_RECEIPT_KIND,
      sourceEventId: `channel-publish:youtube:${video.videoId}`,
      payload: { schemaVersion: CHANNEL_PUBLISH_RECEIPT_SCHEMA, platform: "youtube", videoId: video.videoId,
        url: `https://youtube.com/shorts/${video.videoId}`, evidence: video.evidence, sourceToolName: toolName.slice(0, 120) } });
  }
  return videos.length;
}

/** Distinct receipts, newest first (the owner's machine has one channel identity per platform account). */
export function listChannelPublishReceipts(limit = 20): ChannelPublishReceipt[] {
  let rows: Array<{ run_id: string; ts: string; payload_json: string }> = [];
  try {
    rows = getDb().prepare(`SELECT run_id, ts, payload_json FROM run_events WHERE kind = ? ORDER BY ts DESC LIMIT 500`)
      .all(CHANNEL_PUBLISH_RECEIPT_KIND) as typeof rows;
  } catch { return []; }
  const byId = new Map<string, ChannelPublishReceipt>();
  for (const row of rows) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
    if (value.schemaVersion !== CHANNEL_PUBLISH_RECEIPT_SCHEMA || typeof value.videoId !== "string") continue;
    const existing = byId.get(value.videoId);
    // Oldest sighting wins as firstSeenAt; rows arrive newest first.
    byId.set(value.videoId, { platform: "youtube", videoId: value.videoId, url: String(value.url ?? ""),
      evidence: value.evidence === "upload-dialog-link" ? "upload-dialog-link" : "studio-video-page",
      firstSeenAt: row.ts, runId: existing?.runId ?? row.run_id });
  }
  return [...byId.values()].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)).slice(0, limit);
}

/** One prompt block, or "" when the host has no receipt. Facts only; never an instruction to post. */
export function channelPublishReceiptsPromptBlock(receipts: ChannelPublishReceipt[] = listChannelPublishReceipts()): string {
  if (!receipts.length) return "";
  return [
    "[Host-recorded channel receipts — facts from the app's own ledger, not from any agent's notes]",
    "The app saw these videos exist on the owner's YouTube channel in YouTube Studio (they were uploaded; check Studio for their visibility):",
    ...receipts.map((receipt) => `- ${receipt.url} (first seen ${receipt.firstSeenAt}, ${receipt.evidence})`),
    "A video listed here was uploaded: never upload the same file again. A local note that says \"not posted\" is older than this receipt.",
    "[/Host-recorded channel receipts]",
  ].join("\n");
}

/** The receipt block only for work about YouTube; other goals and automations never carry it. */
export function channelPublishReceiptsPromptBlockFor(context: string, receipts?: ChannelPublishReceipt[]): string {
  if (!/youtube|유튜브|유투브|쇼츠|숏츠|\bshorts\b/i.test(context ?? "")) return "";
  return channelPublishReceiptsPromptBlock(receipts);
}
