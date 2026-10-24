import { createHash } from "node:crypto";

const CHAT_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function stableScienceRuntimeChatId(conversationId: string): string {
  if (!CHAT_UUID_RE.test(conversationId)) throw new Error("Invalid Science conversation id");
  const hex = createHash("sha256").update(`agentlas:science-runtime-chat:v1:${conversationId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

