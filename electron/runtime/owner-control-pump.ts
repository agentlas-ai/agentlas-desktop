import { randomUUID } from "node:crypto";
import { createObservedUsageAccumulator } from "../../shared/observed-usage";
import type { ChatHistoryEntry, ImageAttachment } from "../../shared/types";
import type { RunnerRequest, RunnerResult } from "./runner";

/** Original user attachments remain with their user history row. Only inline
 * formats admitted by the existing attachment pipeline cross the API wire;
 * history cannot authorize fetching a URL or reading a host file. */
export function ownerControlHistoryImages(entry: Pick<ChatHistoryEntry, "role" | "imageDataUrls">): ImageAttachment[] {
  if (entry.role !== "user") return [];
  const images: ImageAttachment[] = [];
  for (const url of entry.imageDataUrls ?? []) {
    const match = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
    if (!match || match[2].length % 4 === 1) continue;
    images.push({ mediaType: match[1].toLowerCase().replace("image/jpg", "image/jpeg"), data: match[2] });
  }
  return images;
}

/** One pending batch between complete provider/tool groups. A transport loss
 * settles the claim without permitting any adapter fallback to replay it. */
export function createOwnerControlBoundary(request: RunnerRequest): {
  take(): Array<{ intentId: string; text: string }>;
  hasPending(): boolean;
  dispatched(): void;
  applied(): void;
  finish(): void;
} {
  const seen = new Set<string>();
  let pending: string[] | null = null;
  let dispatched = false;
  return {
    take() {
      if (!request.ownerControlInbox || request.signal?.aborted || pending) return [];
      const batch = request.ownerControlInbox.take("current-boundary").filter((entry) => {
        if (seen.has(entry.intentId)) return false;
        seen.add(entry.intentId);
        return true;
      });
      if (batch.length) pending = batch.map((entry) => entry.intentId);
      return batch;
    },
    hasPending: () => pending !== null,
    dispatched() { if (pending) dispatched = true; },
    applied() {
      if (!pending) return;
      request.ownerControlInbox!.settle(pending, "applied");
      pending = null;
      dispatched = false;
    },
    finish() {
      if (!pending) return;
      request.ownerControlInbox!.settle(pending, dispatched ? "uncertain" : "rejected",
        dispatched ? "owner_control_brain_reply_lost" : "owner_control_not_dispatched");
      pending = null;
    },
  };
}

/** Continue inside the existing invocation and authority, after a definite brain
 * boundary. Native adapters and managed tool loops may consume this same inbox
 * earlier; taking is Main's atomic claim, never a second root invocation. */
export async function runWithOwnerControl(
  request: RunnerRequest,
  runOnce: (request: RunnerRequest) => Promise<RunnerResult>,
): Promise<RunnerResult> {
  const inbox = request.ownerControlInbox;
  if (!inbox) return runOnce(request);
  const usage = createObservedUsageAccumulator();
  const seen = new Set<string>();
  let tokens: number | undefined = 0;
  let current = request;
  let result = await runOnce(current);
  const record = (): void => {
    usage.record(result.observedUsage);
    tokens = tokens !== undefined && Number.isSafeInteger(result.tokens) && result.tokens! >= 0
      && Number.isSafeInteger(tokens + result.tokens!) ? tokens + result.tokens! : undefined;
  };
  record();
  while (!request.signal?.aborted && !result.failure && result.ownerControlTerminal === "completed") {
    const batch = inbox.take("episode-terminal").filter((entry) => {
      if (seen.has(entry.intentId)) return false;
      seen.add(entry.intentId);
      return true;
    });
    if (batch.length === 0) break;
    const ids = batch.map((entry) => entry.intentId);
    if (request.signal?.aborted) {
      inbox.settle(ids, "rejected", "owner_control_cancelled_before_dispatch");
      break;
    }
    const history: ChatHistoryEntry[] = [...current.history];
    const previousUser = history.at(-1);
    const imageDataUrls = current.images?.map((image) => `data:${image.mediaType};base64,${image.data}`);
    if (previousUser?.role === "user" && previousUser.text === current.userPrompt) {
      if (imageDataUrls?.length) history[history.length - 1] = { ...previousUser, imageDataUrls };
    } else {
      history.push({ id: randomUUID(), role: "user", text: current.userPrompt,
        createdAt: new Date().toISOString(), ...(imageDataUrls?.length ? { imageDataUrls } : {}) });
    }
    history.push({ id: randomUUID(), role: "assistant", text: result.text, createdAt: new Date().toISOString() });
    current = { ...current, history, userPrompt: batch.map((entry) => entry.text).join("\n\n"),
      images: undefined, runtimeSessionId: result.sessionId ?? current.runtimeSessionId };
    try {
      result = await runOnce(current);
      record();
    } catch (error) {
      inbox.settle(ids, "uncertain", "owner_control_episode_reply_lost");
      throw error;
    }
    if (request.signal?.aborted || result.failure || result.ownerControlTerminal !== "completed") {
      inbox.settle(ids, "uncertain", "owner_control_episode_unsettled");
      break;
    }
    inbox.settle(ids, "applied");
  }
  // Missing usage in any episode remains unknown; a later complete pair must
  // not turn earlier unmeasured work into an exact aggregate receipt.
  const { observedUsage: _latestUsage, tokens: _latestTokens, ...rest } = result;
  const observedUsage = usage.total();
  return { ...rest, ownerControlTerminal: result.ownerControlTerminal === "completed" ? "completed" : "uncertain",
    ...(observedUsage ? { observedUsage } : {}), ...(tokens !== undefined ? { tokens } : {}) };
}
