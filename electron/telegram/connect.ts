import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, session as electronSession, shell } from "electron";
import { currentUiLocale } from "../ui-locale";
import { runMcpInvocation } from "../mcp/client";
import { getAgentById, listInstalledAgents } from "../mcp/registry";
import { getAgentGroup } from "../store/agent-groups";
import { resolveAgentGroupForRuntime } from "../store/agent-groups";
import { createChat, getChat } from "../store/chats";
import { getDb } from "../store/db";
import { getFirm } from "../store/firms";
import { agentRunCwd } from "../runtime/exec";
import { deleteSecret, readSecret, setSecret } from "../secrets/vault";
import type {
  Automation,
  ImageAttachment,
  McpInvocationEvent,
  TelegramConnectActionResult,
  TelegramConnectAutoInput,
  TelegramConnectBinding,
  TelegramConnectCloneInput,
  TelegramConnectStartInput,
  TelegramConnectStatus,
  TelegramConnectTargetKind,
} from "../../shared/types";

interface TelegramBindingRow {
  id: string;
  target_kind: TelegramConnectTargetKind;
  target_id: string;
  telegram_chat_id: string | null;
  telegram_chat_title: string | null;
  bot_user_id: number | null;
  bot_username: string | null;
  bot_display_name: string | null;
  chat_session_id: string | null;
  status: TelegramConnectStatus;
  enabled: number;
  automation_report_enabled: number;
  token_saved: number;
  token_fingerprint: string | null;
  last_update_id: number;
  last_error: string | null;
  last_test_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramFileDescriptor;
  video?: TelegramFileDescriptor;
  animation?: TelegramFileDescriptor;
  audio?: TelegramFileDescriptor;
  voice?: TelegramFileDescriptor;
  reply_to_message?: {
    from?: TelegramUser;
  };
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramFileDescriptor {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramFileInfo {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramRuntimeAttachment {
  path: string;
  name: string;
  mediaType: string;
  kind: string;
  size: number;
  image?: ImageAttachment;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface Poller {
  token: string;
  bindingIds: Set<string>;
  controller: AbortController;
  running: boolean;
}

const TELEGRAM_SECRET_SCOPE = "telegram.bot-token";
const TELEGRAM_WEB_PARTITION = "persist:agentlas-telegram-connect";
const BOTFATHER_WEB_URL = "https://web.telegram.org/k/#@BotFather";
const pollers = new Map<string, Poller>();
let reconcileInFlight: Promise<void> | null = null;
const TELEGRAM_INVOCATION_TIMEOUT_MS = 15 * 60 * 1000;
const TELEGRAM_REQUEST_TIMEOUT_MS = readPositiveTimeoutMs(
  process.env.AGENTLAS_TELEGRAM_REQUEST_TIMEOUT_MS,
  30_000,
);
const TELEGRAM_LONG_POLL_GRACE_MS = readPositiveTimeoutMs(
  process.env.AGENTLAS_TELEGRAM_LONG_POLL_GRACE_MS,
  10_000,
);
const TELEGRAM_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const TOKEN_RE = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;

interface TelegramWebState {
  token: string | null;
  tokens: string[];
  hasComposer: boolean;
  hasBotFather: boolean;
  botFatherBlocked: boolean;
  href: string;
}

interface BotFatherCapture {
  token: string;
  source: "existing" | "created";
  window: BrowserWindow;
}

const TELEGRAM_COPY = {
  ko: {
    "auto.existing_confirmed": "이미 연결된 Telegram 방을 확인했고 테스트 메시지도 보냈습니다.",
    "auto.chat_connected": "Telegram 방까지 연결했습니다. 이제 그 방에서 말하면 Agentlas가 선택한 에이전트에게 보냅니다.",
    "auto.bot_ready": "봇은 준비됐습니다. 열린 Telegram 창에서 시작을 누르면 방 연결이 끝납니다.",
    "start.bot_verified": "봇 확인 완료. 이제 Telegram에서 봇에게 메시지를 보내면 이 연결이 방을 기억합니다.",
    "clone.bot_verified": "같은 봇으로 새 방 포트를 만들었습니다. Telegram 방에서 시작 메시지를 보내면 연결됩니다.",
    "open.title": "Agentlas Telegram 열기",
    "open.success": "Telegram 창을 열었습니다: @{username}",
    "settings.title": "Agentlas Telegram 봇 설정",
    "settings.bot_username_unknown": "아직 봇 이름을 모릅니다. 먼저 봇 포트를 만들어주세요.",
    "settings.group_enabled": "그룹 전체 메시지 받기를 켰습니다. 이미 초대한 그룹은 봇을 빼고 다시 초대해야 적용될 수 있고, 반영에 몇 분 걸릴 수 있습니다.",
    "settings.manual_disable": "BotFather 설정 창을 열어두었습니다. 화면에 보이는 Disable 버튼을 누르면 그룹 전체 메시지 받기가 켜집니다.",
    "test.message": "Agentlas 연결 테스트입니다. 이 메시지에 답장하거나 봇을 불러 작업을 맡겨보세요.",
    "test.sent": "테스트 메시지를 보냈습니다.",
    "pair.connected": "Agentlas에 연결되었습니다. 이제 메시지로 실행할 수 있어요.",
    "run.started": "시작했어요. 웹/파일 제작은 몇 분 걸릴 수 있습니다. 끝나면 이 방에 결과 경로와 여는 방법을 보냅니다.",
    "run.working": "받았어요. 지금 작업 중입니다 — 몇 분 걸릴 수 있어요. 끝나면 이 방에 결과를 보냅니다.",
    "run.timeout": "작업이 너무 오래 걸려 자동으로 멈췄습니다. 이 방에 \"계속 진행해\"라고 보내면 같은 세션에서 이어갈 수 있습니다.",
    "attachment.default_prompt": "첨부 파일을 확인해줘.",
    "attachment.too_large": "첨부 파일이 너무 큽니다: {name}. Telegram에서 받을 수 있는 안전 한도는 {limit}MB입니다.",
    "attachment.download_failed": "첨부 파일을 내려받지 못했습니다: {message}",
    "target.deleted": "이 Telegram 연결의 대상이 삭제되었습니다. Agentlas의 Telegram 연결 화면에서 새 에이전트 그룹을 선택해 다시 연결해주세요.",
    "automation.disable_done": "알겠습니다. 앞으로 자동화 완료 보고는 이 Telegram 방으로 보내지 않을게요.",
    "automation.enable_done": "좋아요. 앞으로 Agentlas 자동화가 끝나면 이 Telegram 방에 보고할게요. 끄려면 \"자동화 보고 꺼\"라고 말하면 됩니다.",
    "automation.status_on": "자동화 완료 보고가 이 Telegram 방으로 오도록 켜져 있습니다. 끄려면 \"자동화 보고 꺼\"라고 말하면 됩니다.",
    "automation.status_off": "자동화 완료 보고는 아직 꺼져 있습니다. \"자동화 끝나면 여기에 보고해\"라고 말하면 켤 수 있습니다.",
    "automation.report_title": "자동화 보고: {name}",
    "automation.status_label": "상태: {status}",
    "automation.time_label": "시간: {time}",
    "automation.error_label": "오류: {error}",
    "automation.summary_label": "요약: {summary}",
    "automation.status_completed": "완료",
    "automation.status_skipped": "건너뜀",
    "automation.status_failed": "실패",
    "botfather.connect_title": "Agentlas Telegram 연결",
    "botfather.login_timeout": "Telegram 로그인이 끝나지 않았습니다. 열린 창에서 로그인한 뒤 다시 시도해주세요.",
    "botfather.blocked": "Telegram이 현재 계정에서 BotFather 메시지를 막고 있습니다. 열린 BotFather 창에서 제한이 풀린 계정으로 로그인하거나 Telegram 데스크톱/모바일에서 직접 설정해야 합니다.",
    "botfather.manual_settings": "BotFather 창을 열어두었습니다. 로그인 후 /setprivacy를 보내고 이 봇을 고른 뒤 Disable을 누르면 그룹 전체 메시지 받기가 켜집니다.",
    "botfather.create_failed": "BotFather가 새 봇을 만들지 못했습니다. Telegram 창의 안내를 확인해주세요.",
    "delete.title": "Agentlas Telegram 봇 삭제",
    "error.bot_username_unknown": "아직 봇 이름을 모릅니다. 먼저 봇 포트를 만들어주세요.",
    "error.chat_not_paired": "Telegram 방이 아직 연결되지 않았습니다.",
    "error.message_box_missing": "Telegram 입력창을 찾지 못했습니다.",
    "error.missing_keychain": "Telegram 봇 비밀문자가 로컬 비밀 저장소에 없습니다.",
    "error.no_reply": "Agentlas가 보낼 답을 만들지 못했습니다.",
    "error.open_chat_failed": "Telegram 봇 채팅을 열지 못했습니다.",
    "error.run_failed": "Agentlas 실행 실패: {message}",
    "error.token_not_bot": "Telegram 비밀문자가 봇용이 아닙니다.",
    "error.token_required": "Telegram 봇 비밀문자가 필요합니다.",
    "error.window_closed": "Telegram 연결 창이 닫혔습니다.",
  },
  en: {
    "auto.existing_confirmed": "Existing Telegram chat confirmed. A test message was sent.",
    "auto.chat_connected": "Telegram chat connected. Messages in that chat now route to the selected Agentlas target.",
    "auto.bot_ready": "Bot is ready. Press Start in the Telegram window to finish pairing the chat.",
    "start.bot_verified": "Bot verified. Send a Telegram message to the bot and this connection will remember that chat.",
    "clone.bot_verified": "Created another chat port with the same bot. Send the start message in Telegram to pair it.",
    "open.title": "Agentlas Telegram",
    "open.success": "Telegram window opened: @{username}",
    "settings.title": "Agentlas Telegram Bot Settings",
    "settings.bot_username_unknown": "Bot username is not known yet. Create the bot port first.",
    "settings.group_enabled": "Group-wide message receiving was requested. If the bot is already in a group, remove and re-add it; Telegram may take a few minutes to apply it.",
    "settings.manual_disable": "BotFather settings are open. Press the visible Disable button to let the bot receive group-wide messages.",
    "test.message": "Agentlas connection test. Reply to this message or mention the bot to assign work.",
    "test.sent": "Test message sent.",
    "pair.connected": "Connected to Agentlas. You can now run it by messaging here.",
    "run.started": "Started. Website/file creation can take a few minutes. I will send the result path and how to open it here when it finishes.",
    "run.working": "Got it. Working on it now — this can take a few minutes. I will send the result here when it's done.",
    "run.timeout": "The run took too long and was stopped automatically. Send \"continue\" in this chat to resume the same session.",
    "attachment.default_prompt": "Please inspect the attached file.",
    "attachment.too_large": "The attachment is too large: {name}. The safe Telegram download limit is {limit}MB.",
    "attachment.download_failed": "Could not download the attachment: {message}",
    "target.deleted": "The target for this Telegram connection was deleted. Open Telegram Connect in Agentlas and choose a new agent group to reconnect.",
    "automation.disable_done": "Done. Automation completion reports will no longer be sent to this Telegram chat.",
    "automation.enable_done": "Got it. Agentlas automation completions will be reported to this Telegram chat. Say \"turn off automation reports\" to stop.",
    "automation.status_on": "Automation completion reports are on for this Telegram chat. Say \"turn off automation reports\" to stop them.",
    "automation.status_off": "Automation completion reports are off. Say \"report automation completions here\" to turn them on.",
    "automation.report_title": "Automation report: {name}",
    "automation.status_label": "Status: {status}",
    "automation.time_label": "Time: {time}",
    "automation.error_label": "Error: {error}",
    "automation.summary_label": "Summary: {summary}",
    "automation.status_completed": "Completed",
    "automation.status_skipped": "Skipped",
    "automation.status_failed": "Failed",
    "botfather.connect_title": "Agentlas Telegram Connect",
    "botfather.login_timeout": "Telegram login did not finish. Log in in the opened window, then try again.",
    "botfather.blocked": "Telegram is blocking BotFather messages for this account. Use the opened BotFather window with an account that can message BotFather, or set it in Telegram Desktop/mobile.",
    "botfather.manual_settings": "BotFather is open. After logging in, send /setprivacy, choose this bot, then press Disable to let it receive group-wide messages.",
    "botfather.create_failed": "BotFather could not create a new bot. Check the Telegram window for its message.",
    "delete.title": "Delete Agentlas Telegram Bot",
    "error.bot_username_unknown": "Bot username is not known yet. Create the bot port first.",
    "error.chat_not_paired": "Telegram chat is not paired yet.",
    "error.message_box_missing": "Could not find the Telegram message box.",
    "error.missing_keychain": "Telegram bot secret is missing from the local secret store.",
    "error.no_reply": "Agentlas did not produce a reply.",
    "error.open_chat_failed": "Could not open the Telegram bot chat.",
    "error.run_failed": "Agentlas run failed: {message}",
    "error.token_not_bot": "Telegram token does not belong to a bot.",
    "error.token_required": "Telegram bot secret is required.",
    "error.window_closed": "Telegram connect window was closed.",
  },
} as const;

type TelegramCopyKey = keyof typeof TELEGRAM_COPY.en;
type TelegramInvocationMode = {
  permissions: "read" | "write";
  goalMode: boolean;
  instruction: string;
};

class TelegramInvocationTimeoutError extends Error {}
class TelegramRequestTimeoutError extends Error {}

function readPositiveTimeoutMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(10, Math.floor(parsed));
}

function tg(key: TelegramCopyKey, vars: Record<string, string | number> = {}, localeOverride?: "ko" | "en"): string {
  const locale = localeOverride ?? (currentUiLocale() === "ko" ? "ko" : "en");
  const template = TELEGRAM_COPY[locale][key] ?? TELEGRAM_COPY.en[key];
  return template.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name] ?? ""));
}

// 응답 언어는 앱 UI 로케일이 아니라 "사용자가 보낸 메시지의 언어"를 따른다.
// 한글이 있으면 ko, 아니면 en(스캐폴딩·안내문 기준). 실제 응답 언어는 LLM에
// "메시지와 같은 언어로 답하라" 지시로 임의 외국어까지 맞춘다.
function detectReplyLocale(text: string): "ko" | "en" {
  return /[가-힣]/.test(text) ? "ko" : "en";
}

function nowIso(): string {
  return new Date().toISOString();
}

function secretKey(bindingId: string): string {
  return `${TELEGRAM_SECRET_SCOPE}:${bindingId}`;
}

/**
 * Keychain and SQLite cannot share one physical transaction. Commit the secret first,
 * publish the binding row only after that succeeds, and compensate the secret if the
 * database write fails. This keeps list/restart paths from ever observing a row whose
 * token_saved=1 points at a missing Keychain entry.
 */
async function commitBindingWithSecret(id: string, token: string, insertRow: () => void): Promise<void> {
  const key = secretKey(id);
  try {
    await setSecret(key, token);
    insertRow();
  } catch (err) {
    try {
      await deleteSecret(key);
    } catch {
      // Preserve the original failure. A failed insert cannot expose an orphaned secret
      // through the UI because no binding row exists.
    }
    throw err;
  }
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function markTokenAvailable(id: string, token: string): void {
  getDb()
    .prepare("UPDATE telegram_bindings SET token_saved = 1, token_fingerprint = ?, updated_at = ? WHERE id = ?")
    .run(tokenKey(token), nowIso(), id);
}

function markTokenMissing(id: string): void {
  getDb()
    .prepare("UPDATE telegram_bindings SET token_saved = 0, status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
    .run(tg("error.missing_keychain").slice(0, 1000), nowIso(), id);
}

async function readBindingSecret(id: string): Promise<string | null> {
  try {
    const token = await readSecret(secretKey(id));
    if (token) {
      markTokenAvailable(id, token);
      return token;
    }
  } catch (err) {
    getDb()
      .prepare("UPDATE telegram_bindings SET token_saved = 0, status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .run((err instanceof Error ? err.message : String(err)).slice(0, 1000), nowIso(), id);
    return null;
  }
  markTokenMissing(id);
  return null;
}

function isBindingSessionRunning(bindingId: string): boolean {
  for (const poller of pollers.values()) {
    if (!poller.controller.signal.aborted && poller.bindingIds.has(bindingId)) return true;
  }
  return false;
}

function bindingFromRow(row: TelegramBindingRow, hasToken: boolean, tokenPreview: string | null): TelegramConnectBinding {
  const target = resolveTarget(row.target_kind, row.target_id, false);
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    // Deleted target → keep the last known chat title (or a short id) instead of a raw UUID,
    // and flag it so the UI can warn + offer cleanup.
    targetName: target?.name ?? row.telegram_chat_title ?? `#${row.target_id.slice(0, 8)}`,
    targetMissing: target === null,
    status: row.status,
    enabled: row.enabled === 1,
    sessionRunning: isBindingSessionRunning(row.id),
    automationReportEnabled: row.automation_report_enabled === 1,
    hasToken,
    tokenPreview,
    botUserId: row.bot_user_id ?? null,
    botUsername: row.bot_username ?? null,
    botDisplayName: row.bot_display_name ?? null,
    telegramChatId: row.telegram_chat_id,
    telegramChatTitle: row.telegram_chat_title,
    chatSessionId: row.chat_session_id,
    lastUpdateId: row.last_update_id,
    lastError: row.last_error,
    lastTestAt: row.last_test_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getBindingRow(id: string): TelegramBindingRow | null {
  const row = getDb()
    .prepare("SELECT * FROM telegram_bindings WHERE id = ?")
    .get(id) as TelegramBindingRow | undefined;
  return row ?? null;
}

function listBindingRows(): TelegramBindingRow[] {
  return getDb()
    .prepare("SELECT * FROM telegram_bindings ORDER BY updated_at DESC")
    .all() as TelegramBindingRow[];
}

function toBinding(row: TelegramBindingRow): TelegramConnectBinding {
  return bindingFromRow(row, row.token_saved === 1, null);
}

export function listTelegramBindings(): TelegramConnectBinding[] {
  return listBindingRows().map(toBinding);
}

function resolveTarget(
  targetKind: TelegramConnectTargetKind,
  targetId: string,
  strict = true,
): { name: string } | null {
  if (targetKind === "agent") {
    const agent = getAgentById(targetId);
    if (!agent && strict) throw new Error(`Telegram Connect target agent not found: ${targetId}`);
    return agent ? { name: agent.nameEn || agent.name } : null;
  }
  if (targetKind === "firm") {
    const firm = getFirm(targetId);
    if (!firm && strict) throw new Error(`Telegram Connect target firm not found: ${targetId}`);
    return firm ? { name: firm.nameEn || firm.name } : null;
  }
  const group = getAgentGroup(targetId);
  if (!group && strict) throw new Error(`Telegram Connect target group not found: ${targetId}`);
  return group ? { name: group.name } : null;
}

async function telegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const longPollSeconds = method === "getUpdates" && typeof payload.timeout === "number"
    ? Math.max(0, payload.timeout)
    : 0;
  const requestTimeoutMs = Math.max(
    TELEGRAM_REQUEST_TIMEOUT_MS,
    longPollSeconds * 1000 + (longPollSeconds > 0 ? TELEGRAM_LONG_POLL_GRACE_MS : 0),
  );
  const controller = new AbortController();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return;
    const error = reason instanceof Error ? reason : new Error(String(reason || "Telegram request aborted"));
    controller.abort(error);
    // Promise.race makes the deadline finite even for a non-compliant fetch mock/adapter
    // that ignores AbortSignal. Native fetch still receives the abort for socket cleanup.
    rejectAbort(error);
  };
  const onOperationAbort = () => abort(signal?.reason);
  if (signal?.aborted) onOperationAbort();
  else signal?.addEventListener("abort", onOperationAbort, { once: true });
  const timeoutError = new TelegramRequestTimeoutError(
    `Telegram ${method} request timed out after ${requestTimeoutMs}ms`,
  );
  const timer = setTimeout(() => abort(timeoutError), requestTimeoutMs);

  try {
    const request = fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const res = await Promise.race([request, aborted]);
    // Keep the same deadline while consuming the body. fetch() resolves at headers,
    // so clearing the timer before json() would still allow a stalled body forever.
    const json = await Promise.race([
      res.json().catch(() => null),
      aborted,
    ]) as { ok?: boolean; result?: T; description?: string } | null;
    if (!res.ok || !json?.ok) {
      throw new Error(json?.description || `Telegram ${method} failed (${res.status})`);
    }
    return json.result as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOperationAbort);
  }
}

async function verifyBotToken(token: string): Promise<TelegramUser> {
  const me = await telegramApi<TelegramUser>(token, "getMe", {});
  if (!me.is_bot) throw new Error(tg("error.token_not_bot"));
  return me;
}

export async function autoConnectTelegram(input: TelegramConnectAutoInput): Promise<TelegramConnectActionResult> {
  const target = resolveTarget(input.targetKind, input.targetId, true);
  const existing = await findReusableTargetBinding(input.targetKind, input.targetId);
  if (existing?.telegram_chat_id) {
    const result = await sendTelegramTest(existing.id);
    return {
      binding: result.binding,
      message: tg("auto.existing_confirmed"),
    };
  }

  // 이미 BotFather로 만들었지만 방 페어링이 끝나지 않은 봇이 있으면 그 봇을 재사용해
  // 방 연결만 다시 시도한다. 매번 새 봇을 만들면 봇이 계속 남발되고 결국 텔레그램
  // 계정의 봇 개수 한도에 걸려 "새 봇을 만들지 못했습니다"가 뜨던 문제를 막는다.
  if (existing?.bot_username) {
    const reused = await reuseExistingBotPairing(existing);
    if (reused) return reused;
  }

  let capture: BotFatherCapture | null = null;
  try {
    capture = await captureBotFatherToken(target?.name ?? "Agentlas", input.botName);
    const result = await startTelegramConnection({
      targetKind: input.targetKind,
      targetId: input.targetId,
      botToken: capture.token,
    });

    let binding = result.binding;
    let paired = false;
    if (binding.botUsername) {
      const pairedBinding = await openBotAndSendStart(capture.window, binding.botUsername, binding.id);
      if (pairedBinding) {
        binding = pairedBinding;
        paired = true;
      }
    }

    closeBotFatherWindow(capture.window);
    capture = null;
    return {
      binding,
      message: paired
        ? tg("auto.chat_connected")
        : tg("auto.bot_ready"),
    };
  } catch (err) {
    if (capture?.window) closeBotFatherWindow(capture.window);
    throw new Error(maskTelegramSecrets(err instanceof Error ? err.message : String(err)));
  }
}

// 이미 만들어진 봇(토큰 보유, 방 미페어링)으로 방 연결만 다시 시도한다.
// 새 봇을 만들지 않으므로 봇 남발/봇 한도 초과를 유발하지 않는다.
async function reuseExistingBotPairing(row: TelegramBindingRow): Promise<TelegramConnectActionResult | null> {
  if (!row.bot_username) return null;
  const token = await readBindingSecret(row.id);
  if (!token) return null;
  // /start 핸드셰이크로 방을 귀속하려면 이 봇의 poller가 살아 있어야 한다.
  await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: false }).catch(() => false);
  await reconcileTelegramWorkers();
  const win = createTelegramWebWindow(tg("botfather.connect_title"));
  try {
    // Telegram 웹 로그인(QR)만 확보하면 된다 — BotFather 메시지는 보내지 않는다.
    await loadTelegramWebUrl(win, BOTFATHER_WEB_URL, "reuse login");
    await waitForBotFatherReady(win, 180_000).catch(() => null);
    const paired = await openBotAndSendStart(win, row.bot_username, row.id);
    closeBotFatherWindow(win);
    return {
      binding: paired ?? toBinding(getBindingRow(row.id) as TelegramBindingRow),
      message: paired ? tg("auto.chat_connected") : tg("auto.bot_ready"),
    };
  } catch (err) {
    closeBotFatherWindow(win);
    throw new Error(maskTelegramSecrets(err instanceof Error ? err.message : String(err)));
  }
}

async function findReusableTargetBinding(
  targetKind: TelegramConnectTargetKind,
  targetId: string,
): Promise<TelegramBindingRow | null> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM telegram_bindings
       WHERE target_kind = ? AND target_id = ? AND enabled = 1
       ORDER BY telegram_chat_id IS NULL ASC, updated_at DESC
       LIMIT 4`,
    )
    .all(targetKind, targetId) as TelegramBindingRow[];
  for (const row of rows) {
    const token = await readBindingSecret(row.id);
    if (token && row.bot_username) return row;
  }
  return null;
}

export async function startTelegramConnection(input: TelegramConnectStartInput): Promise<TelegramConnectActionResult> {
  resolveTarget(input.targetKind, input.targetId, true);
  const token = input.botToken.trim();
  if (!token) throw new Error(tg("error.token_required"));
  const me = await verifyBotToken(token);
  const fingerprint = tokenKey(token);
  const id = randomUUID();
  const now = nowIso();
  await commitBindingWithSecret(id, token, () => {
    getDb()
      .prepare(
        `INSERT INTO telegram_bindings
         (id, target_kind, target_id, bot_user_id, bot_username, bot_display_name, status, enabled, token_saved, token_fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'waiting_for_chat', 1, 1, ?, ?, ?)`,
      )
      .run(
        id,
        input.targetKind,
        input.targetId,
        me.id,
        me.username ?? null,
        me.first_name ?? null,
        fingerprint,
        now,
        now,
      );
  });
  await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: false }).catch(() => false);
  await reconcileTelegramWorkers();
  const binding = await toBinding(getBindingRow(id) as TelegramBindingRow);
  return {
    binding,
    message: tg("start.bot_verified"),
  };
}

export async function cloneTelegramConnection(input: TelegramConnectCloneInput): Promise<TelegramConnectActionResult> {
  const source = getBindingRow(input.sourceBindingId);
  if (!source) throw new Error(`Telegram binding not found: ${input.sourceBindingId}`);
  const targetKind = input.targetKind ?? source.target_kind;
  const targetId = input.targetId ?? source.target_id;
  resolveTarget(targetKind, targetId, true);
  const token = await readBindingSecret(source.id);
  if (!token) throw new Error(tg("error.missing_keychain"));
  const me = await verifyBotToken(token);
  const fingerprint = tokenKey(token);
  const id = randomUUID();
  const now = nowIso();
  await commitBindingWithSecret(id, token, () => {
    getDb()
      .prepare(
        `INSERT INTO telegram_bindings
         (id, target_kind, target_id, bot_user_id, bot_username, bot_display_name, status, enabled, token_saved, token_fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'waiting_for_chat', 1, 1, ?, ?, ?)`,
      )
      .run(
        id,
        targetKind,
        targetId,
        me.id,
        me.username ?? source.bot_username ?? null,
        me.first_name ?? source.bot_display_name ?? null,
        fingerprint,
        now,
        now,
      );
  });
  getDb()
    .prepare("UPDATE telegram_bindings SET token_saved = 1, token_fingerprint = ?, updated_at = ? WHERE id = ?")
    .run(fingerprint, nowIso(), source.id);
  await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: false }).catch(() => false);
  await reconcileTelegramWorkers();
  const binding = await toBinding(getBindingRow(id) as TelegramBindingRow);
  return {
    binding,
    message: tg("clone.bot_verified"),
  };
}

export async function stopTelegramConnection(id: string): Promise<TelegramConnectBinding> {
  const row = getBindingRow(id);
  if (!row) throw new Error(`Telegram binding not found: ${id}`);
  getDb()
    .prepare("UPDATE telegram_bindings SET enabled = 0, status = 'disabled', updated_at = ? WHERE id = ?")
    .run(nowIso(), id);
  await reconcileTelegramWorkers();
  return toBinding(getBindingRow(id) as TelegramBindingRow);
}

export async function resumeTelegramConnection(id: string): Promise<TelegramConnectBinding> {
  const row = getBindingRow(id);
  if (!row) throw new Error(`Telegram binding not found: ${id}`);
  const token = await readBindingSecret(id);
  if (!token) {
    return toBinding(getBindingRow(id) as TelegramBindingRow);
  }
  const wasStopped = row.enabled === 0 || row.status === "disabled";
  const canDropPending = wasStopped && !hasOtherActiveBindingForToken(id, token);
  const nextStatus: TelegramConnectStatus =
    row.telegram_chat_id
      ? row.status === "disabled" || row.status === "failed"
        ? "chat_paired"
        : row.status
      : "waiting_for_chat";
  getDb()
    .prepare("UPDATE telegram_bindings SET enabled = 1, status = ?, last_error = NULL, updated_at = ? WHERE id = ?")
    .run(nextStatus, nowIso(), id);
  await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: canDropPending }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    markBindingFailed(id, message);
    throw err;
  });
  await reconcileTelegramWorkers();
  return toBinding(getBindingRow(id) as TelegramBindingRow);
}

function hasOtherActiveBindingForToken(bindingId: string, token: string): boolean {
  const tokenHash = tokenKey(token);
  const row = getDb()
    .prepare("SELECT id FROM telegram_bindings WHERE enabled = 1 AND id <> ? AND token_fingerprint = ? LIMIT 1")
    .get(bindingId, tokenHash) as { id: string } | undefined;
  return Boolean(row);
}

export async function removeTelegramConnection(
  id: string,
  deleteBotInBotFather = false,
): Promise<{ botDeleted: boolean }> {
  const row = getBindingRow(id);
  let botDeleted = false;
  // 옵션이 켜졌고, 이 봇을 쓰는 다른 포트가 없을 때만 BotFather에서 실제 봇을 삭제한다.
  // (clone 포트가 같은 봇 토큰을 공유하면 다른 포트가 깨지므로 공유 시엔 포트만 제거.)
  if (deleteBotInBotFather && row?.bot_username && !botTokenSharedByOtherBinding(id, row.token_fingerprint)) {
    botDeleted = await deleteBotViaBotFather(row.bot_username).catch(() => false);
  }
  getDb().prepare("DELETE FROM telegram_bindings WHERE id = ?").run(id);
  await deleteSecret(secretKey(id));
  await reconcileTelegramWorkers();
  return { botDeleted };
}

function botTokenSharedByOtherBinding(bindingId: string, tokenFingerprint: string | null): boolean {
  if (!tokenFingerprint) return false;
  const row = getDb()
    .prepare("SELECT id FROM telegram_bindings WHERE id <> ? AND token_fingerprint = ? LIMIT 1")
    .get(bindingId, tokenFingerprint) as { id: string } | undefined;
  return Boolean(row);
}

// BotFather 웹을 구동해 `/deletebot`으로 실제 봇을 텔레그램 계정에서 영구 삭제한다.
// 로그인(QR)만 확보되면 로그인 계정 소유 봇 목록에서 대상 봇을 골라 확인 문구를 보낸다.
async function deleteBotViaBotFather(botUsername: string): Promise<boolean> {
  const win = createTelegramWebWindow(tg("delete.title"));
  try {
    await loadTelegramWebUrl(win, BOTFATHER_WEB_URL, "delete bot");
    const ready = await waitForBotFatherReady(win, 180_000).catch(() => null);
    if (!ready || ready.botFatherBlocked) {
      closeBotFatherWindow(win);
      return false;
    }
    await sendTelegramWebMessage(win, "/deletebot");
    await sleep(1400);
    // 봇 선택 — reply 키보드 버튼 클릭, 실패 시 @username 직접 전송.
    const labels = [`@${botUsername}`, botUsername];
    const selected = await clickTelegramButtonByText(win, labels, 5_000);
    if (!selected) {
      await sendTelegramWebMessage(win, `@${botUsername}`);
      await sleep(1400);
    }
    // 확인 — BotFather의 "Yes, I am totally sure." 버튼/문구.
    const confirmed = await clickTelegramButtonByText(win, ["Yes, I am totally sure.", "Yes, I am totally sure"], 4_000);
    if (!confirmed) {
      await sendTelegramWebMessage(win, "Yes, I am totally sure.");
    }
    await sleep(1800);
    const done = await telegramLatestIncomingIncludes(win, ["Done! The bot is gone", "bot is gone", "The bot is gone"]);
    closeBotFatherWindow(win);
    return done;
  } catch {
    closeBotFatherWindow(win);
    return false;
  }
}

export async function resetTelegramConversation(id: string): Promise<TelegramConnectBinding> {
  const row = getBindingRow(id);
  if (!row) throw new Error(`Telegram binding not found: ${id}`);
  if (!resolveTarget(row.target_kind, row.target_id, false)) {
    disableMissingTargetBinding(id);
    await reconcileTelegramWorkers();
    return toBinding(getBindingRow(id) as TelegramBindingRow);
  }
  const nextStatus: TelegramConnectStatus =
    row.enabled === 0 || row.status === "disabled"
      ? "disabled"
      : row.telegram_chat_id
        ? "chat_paired"
        : "waiting_for_chat";
  getDb()
    .prepare("UPDATE telegram_bindings SET chat_session_id = NULL, status = ?, last_error = NULL, updated_at = ? WHERE id = ?")
    .run(nextStatus, nowIso(), id);
  return toBinding(getBindingRow(id) as TelegramBindingRow);
}

/**
 * Remove every binding whose target agent/firm/group no longer exists.
 * These are dangling "ports" left behind when the user deletes the underlying
 * agent/team/group — they can never run again, so we prune them on request.
 */
export async function pruneOrphanedTelegramBindings(): Promise<{ removed: number }> {
  const orphans = listBindingRows().filter(
    (row) => resolveTarget(row.target_kind, row.target_id, false) === null,
  );
  const db = getDb();
  for (const row of orphans) {
    db.prepare("DELETE FROM telegram_bindings WHERE id = ?").run(row.id);
    await deleteSecret(secretKey(row.id));
  }
  if (orphans.length > 0) await reconcileTelegramWorkers();
  return { removed: orphans.length };
}

export async function openTelegramBot(id: string): Promise<{ ok: boolean; message: string }> {
  const row = getBindingRow(id);
  if (!row?.bot_username) return { ok: false, message: tg("error.bot_username_unknown") };
  const win = createTelegramWebWindow(tg("open.title"));
  await loadTelegramWebUrl(win, `https://web.telegram.org/k/#@${encodeURIComponent(row.bot_username)}`, "open bot");
  return {
    ok: true,
    message: tg("open.success", { username: row.bot_username }),
  };
}

export async function configureTelegramBotSettings(id: string): Promise<{ ok: boolean; message: string }> {
  const row = getBindingRow(id);
  if (!row) throw new Error(`Telegram binding not found: ${id}`);
  if (!row.bot_username) {
    return {
      ok: false,
      message: tg("settings.bot_username_unknown"),
    };
  }

  const win = createTelegramWebWindow(tg("settings.title"));
  try {
    await loadTelegramWebUrl(win, BOTFATHER_WEB_URL, "bot settings");
    const ready = await waitForBotFatherReady(win, 12_000).catch(() => null);
    if (!ready) return botFatherManualSettingsMessage();
    if (await isBotFatherMessagingBlocked(win)) return botFatherBlockedMessage();
    const sentPrivacyCommand = await settleWithin(sendTelegramWebMessage(win, "/setprivacy").then(() => true), 8_000, false);
    if (!sentPrivacyCommand) return botFatherManualSettingsMessage();
    await sleep(1200);
    if (await isBotFatherMessagingBlocked(win)) return botFatherBlockedMessage();

    const botLabels = [
      row.bot_username,
      `@${row.bot_username}`,
      row.bot_display_name ?? "",
      row.bot_display_name ? `${row.bot_display_name} bot` : "",
    ].filter(Boolean);
    const selectedBot = await clickTelegramButtonByText(win, botLabels, 5_000);
    if (!selectedBot) {
      const sentBotName = await settleWithin(sendTelegramWebMessage(win, `@${row.bot_username}`).then(() => true), 8_000, false);
      if (!sentBotName) return botFatherManualSettingsMessage();
      await sleep(1200);
    }
    if (await isBotFatherMessagingBlocked(win)) return botFatherBlockedMessage();

    if (await telegramLatestIncomingIncludes(win, ["Current status is: DISABLED", "status is: DISABLED"])) {
      closeBotFatherWindow(win);
      return {
        ok: true,
        message: tg("settings.group_enabled"),
      };
    }
    await clickTelegramButtonByText(win, ["Open", "열기"], 2_000);
    await sleep(700);
    let disabledPrivacy = await clickTelegramButtonByText(
      win,
      ["Disable", "Turn off", "Off", "비활성", "해제", "끄기"],
      5_000,
    );
    if (!disabledPrivacy) {
      const openedSettings = await clickTelegramButtonByText(win, ["Bot Settings", "Settings", "봇 설정", "설정"], 3_000);
      if (openedSettings) {
        await sleep(1000);
        await clickTelegramButtonByText(win, ["Group Privacy", "Privacy", "Privacy Mode", "그룹 개인정보", "개인정보"], 3_000);
        await sleep(1000);
        disabledPrivacy = await clickTelegramButtonByText(
          win,
          ["Turn off", "Disable", "Off", "비활성", "해제", "끄기"],
          3_000,
        );
      }
    }
    if (!disabledPrivacy) {
      disabledPrivacy = await settleWithin(sendTelegramWebMessage(win, "Disable").then(() => true), 8_000, false);
      if (disabledPrivacy) {
        await sleep(1800);
        disabledPrivacy = await telegramLatestIncomingIncludes(win, ["DISABLED", "disabled", "has been disabled"]);
      }
    }
    if (disabledPrivacy) {
      await sleep(1200);
      closeBotFatherWindow(win);
      return {
        ok: true,
        message: tg("settings.group_enabled"),
      };
    }
    return {
      ok: false,
      message: tg("settings.manual_disable"),
    };
  } catch (err) {
    if (!win.isDestroyed()) win.focus();
    throw new Error(maskTelegramSecrets(err instanceof Error ? err.message : String(err)));
  }
}

async function telegramLatestIncomingIncludes(win: BrowserWindow, needles: string[]): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(
    `(() => {
      const bubbles = Array.from(document.querySelectorAll(".bubble.is-in"));
      const text = (bubbles[bubbles.length - 1]?.textContent || document.body?.innerText || "");
      const needles = ${JSON.stringify(needles)};
      return needles.some((needle) => text.includes(needle));
    })()`,
    true,
  ).catch(() => false));
}

export async function sendTelegramTest(id: string): Promise<TelegramConnectActionResult> {
  const row = getBindingRow(id);
  if (!row) throw new Error(`Telegram binding not found: ${id}`);
  if (!row.telegram_chat_id) throw new Error(tg("error.chat_not_paired"));
  const token = await readBindingSecret(id);
  if (!token) throw new Error(tg("error.missing_keychain"));
  const text = tg("test.message");
  await telegramApi(token, "sendMessage", { chat_id: row.telegram_chat_id, text });
  getDb()
    .prepare("UPDATE telegram_bindings SET last_test_at = ?, status = 'test_passed', updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), id);
  return {
    binding: await toBinding(getBindingRow(id) as TelegramBindingRow),
    message: tg("test.sent"),
  };
}

async function activeBindingSecrets(): Promise<Array<{ row: TelegramBindingRow; token: string }>> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM telegram_bindings
       WHERE enabled = 1
         AND token_saved = 1
         AND status <> 'failed'`,
    )
    .all() as TelegramBindingRow[];
  const out: Array<{ row: TelegramBindingRow; token: string }> = [];
  for (const row of rows) {
    const token = await readBindingSecret(row.id);
    if (token) out.push({ row, token });
  }
  return out;
}

export async function reconcileTelegramWorkers(): Promise<void> {
  if (reconcileInFlight) return reconcileInFlight;
  reconcileInFlight = reconcileTelegramWorkersOnce().finally(() => {
    reconcileInFlight = null;
  });
  return reconcileInFlight;
}

async function reconcileTelegramWorkersOnce(): Promise<void> {
  const active = await activeBindingSecrets();
  const byToken = new Map<string, { token: string; bindingIds: Set<string> }>();
  for (const item of active) {
    const key = tokenKey(item.token);
    const group = byToken.get(key) ?? { token: item.token, bindingIds: new Set<string>() };
    group.bindingIds.add(item.row.id);
    byToken.set(key, group);
  }

  for (const [key, poller] of pollers) {
    const next = byToken.get(key);
    if (!next) {
      poller.controller.abort();
      pollers.delete(key);
    } else {
      poller.bindingIds = next.bindingIds;
    }
  }

  for (const [key, group] of byToken) {
    if (pollers.has(key)) continue;
    const poller: Poller = {
      token: group.token,
      bindingIds: group.bindingIds,
      controller: new AbortController(),
      running: true,
    };
    pollers.set(key, poller);
    void pollTelegram(poller).catch((err) => {
      console.error("[telegram] poller crashed:", err);
      for (const bindingId of poller.bindingIds) markBindingFailed(bindingId, err instanceof Error ? err.message : String(err));
      pollers.delete(key);
    });
  }
}

export function stopTelegramWorkers(): void {
  for (const poller of pollers.values()) poller.controller.abort();
  pollers.clear();
}

async function pollTelegram(poller: Poller): Promise<void> {
  let offset = currentOffset([...poller.bindingIds]);
  while (!poller.controller.signal.aborted) {
    try {
      const updates = await telegramApi<TelegramUpdate[]>(
        poller.token,
        "getUpdates",
        {
          offset,
          timeout: 25,
          allowed_updates: ["message"],
        },
        poller.controller.signal,
      );
      for (const update of updates) {
        offset = update.update_id + 1;
        markUpdateSeen([...poller.bindingIds], update.update_id);
        await handleTelegramUpdate(poller, update);
      }
    } catch (err) {
      if (poller.controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      for (const bindingId of poller.bindingIds) markBindingFailed(bindingId, message);
      await delay(3500, poller.controller.signal);
    }
  }
}

function currentOffset(bindingIds: string[]): number {
  if (bindingIds.length === 0) return 0;
  const placeholders = bindingIds.map(() => "?").join(",");
  const row = getDb()
    .prepare(`SELECT MAX(last_update_id) AS max_id FROM telegram_bindings WHERE id IN (${placeholders})`)
    .get(...bindingIds) as { max_id: number | null } | undefined;
  return (row?.max_id ?? 0) + 1;
}

function markUpdateSeen(bindingIds: string[], updateId: number): void {
  if (bindingIds.length === 0) return;
  const placeholders = bindingIds.map(() => "?").join(",");
  getDb()
    .prepare(`UPDATE telegram_bindings SET last_update_id = MAX(last_update_id, ?), updated_at = ? WHERE id IN (${placeholders})`)
    .run(updateId, nowIso(), ...bindingIds);
}

async function handleTelegramUpdate(poller: Poller, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const text = message ? telegramMessageText(message) : "";
  if (!message || (!text && !hasTelegramAttachment(message))) return;
  const chatId = String(message.chat.id);
  let binding = findBindingForChat([...poller.bindingIds], chatId);
  if (!binding) {
    // 보안: 선착순 귀속 금지. `/start <bindingId>` 토큰이 일치하는 미페어링 바인딩만 귀속한다.
    // bindingId는 randomUUID(추측 불가)이고 앱의 텔레그램 세션만 이 토큰을 실어 보낸다.
    binding =
      tryPairBindingWithToken([...poller.bindingIds], message, text) ??
      tryPairFreshPrivateBinding([...poller.bindingIds], message);
    if (binding) {
      // 페어링 확정 — 이 핸드셰이크 메시지는 실행하지 않고 확인만 보낸다.
      await telegramApi(poller.token, "sendMessage", {
        chat_id: chatId,
        text: tg("pair.connected"),
      }).catch(() => undefined);
    }
    if (!binding || /^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return;
  }
  if (!resolveTarget(binding.target_kind, binding.target_id, false)) {
    disableMissingTargetBinding(binding.id);
    await telegramApi(poller.token, "sendMessage", {
      chat_id: chatId,
      text: tg("target.deleted"),
    }).catch(() => undefined);
    await reconcileTelegramWorkers();
    return;
  }
  if (!shouldHandleMessage(binding, message, text)) return;

  const clean = cleanTelegramPrompt(binding, text) || tg("attachment.default_prompt");
  if (!clean) return;
  if (isAutomationReportStatusRequest(clean)) {
    await telegramApi(poller.token, "sendMessage", {
      chat_id: chatId,
      text: automationReportStatusText(binding),
    }).catch(() => undefined);
    return;
  }
  if (isAutomationReportDisableRequest(clean)) {
    setAutomationReportEnabled(binding.id, false);
    await telegramApi(poller.token, "sendMessage", {
      chat_id: chatId,
      text: tg("automation.disable_done"),
    }).catch(() => undefined);
    return;
  }
  if (isAutomationReportEnableRequest(clean)) {
    setAutomationReportEnabled(binding.id, true);
    await telegramApi(poller.token, "sendMessage", {
      chat_id: chatId,
      text: tg("automation.enable_done"),
    }).catch(() => undefined);
    return;
  }
  await telegramApi(poller.token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  let attachments: TelegramRuntimeAttachment[] = [];
  try {
    attachments = await downloadTelegramAttachments(poller.token, binding, message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markBindingFailed(binding.id, msg);
    await telegramApi(poller.token, "sendMessage", {
      chat_id: chatId,
      text: tg("attachment.download_failed", { message: msg }),
    }).catch(() => undefined);
    return;
  }
  const cleanWithAttachments = appendTelegramAttachmentGuide(clean, attachments);
  const mode = telegramInvocationMode(cleanWithAttachments);
  // 응답 언어는 사용자가 보낸 메시지의 언어를 따른다(앱 UI 로케일 무시).
  const replyLocale = detectReplyLocale(clean);
  getDb()
    .prepare("UPDATE telegram_bindings SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), binding.id);
  // 접수 확인은 모든 메시지에 보낸다. 제작(goalMode)이면 상세 안내, 그 외(리서치·질문 등)는
  // 가벼운 "작업 중" 확인. 예전엔 goalMode에만 보내서 리서치는 완료까지 무반응이라
  // "되는 건지 안 되는 건지" 알 수 없었다. 안내문도 메시지 언어에 맞춘다.
  await telegramApi(poller.token, "sendMessage", {
    chat_id: chatId,
    text: mode.goalMode ? tg("run.started", {}, replyLocale) : tg("run.working", {}, replyLocale),
  }).catch(() => undefined);
  // 실행 내내 typing(…) 표시를 살려둔다(텔레그램은 ~5초면 꺼지므로 주기적으로 재전송).
  const stopTyping = startTypingKeepAlive(poller.token, chatId, poller.controller.signal);
  try {
    const finalText = await runBindingInvocation(binding, message, cleanWithAttachments, mode, attachments, replyLocale);
    await sendLongMessage(poller.token, chatId, finalText);
    const nextStatus: TelegramConnectStatus = /테스트|test/i.test(clean) ? "test_passed" : "chat_paired";
    getDb()
      .prepare("UPDATE telegram_bindings SET status = ?, last_error = NULL, last_test_at = COALESCE(last_test_at, ?), updated_at = ? WHERE id = ?")
      .run(nextStatus, nextStatus === "test_passed" ? nowIso() : null, nowIso(), binding.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markBindingFailed(binding.id, msg);
    const text = err instanceof TelegramInvocationTimeoutError ? msg : tg("error.run_failed", { message: msg }, replyLocale);
    await telegramApi(poller.token, "sendMessage", { chat_id: chatId, text }).catch(() => undefined);
  } finally {
    stopTyping();
  }
}

// 실행이 끝날 때까지 typing 액션을 주기적으로 재전송한다. 텔레그램 typing은 약 5초 후
// 자동으로 사라지므로 4.5초마다 갱신해 "작업 중" 표시가 끊기지 않게 한다.
function startTypingKeepAlive(token: string, chatId: string, signal: AbortSignal): () => void {
  let stopped = false;
  const interval = setInterval(() => {
    if (stopped || signal.aborted) return;
    void telegramApi(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }, 4500);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function findBindingForChat(bindingIds: string[], chatId: string): TelegramBindingRow | null {
  if (bindingIds.length === 0) return null;
  const placeholders = bindingIds.map(() => "?").join(",");
  const row = getDb()
    .prepare(`SELECT * FROM telegram_bindings WHERE id IN (${placeholders}) AND telegram_chat_id = ? AND enabled = 1 LIMIT 1`)
    .get(...bindingIds, chatId) as TelegramBindingRow | undefined;
  return row ?? null;
}

// 페어링 토큰(`/start <bindingId>`)이 일치하는 미페어링 바인딩만 귀속한다.
// 선착순 귀속을 없애 봇을 발견한 제3자가 로컬 에이전트 실행을 탈취하는 것을 차단.
function tryPairBindingWithToken(bindingIds: string[], message: TelegramMessage, text: string): TelegramBindingRow | null {
  if (bindingIds.length === 0) return null;
  const token = text.match(/^\/start(?:@\w+)?\s+(\S+)/i)?.[1];
  if (!token || !bindingIds.includes(token)) return null; // 토큰 없음/미관리 바인딩 → 페어링 안 함
  const row = getDb()
    .prepare(`SELECT * FROM telegram_bindings WHERE id = ? AND telegram_chat_id IS NULL AND enabled = 1`)
    .get(token) as TelegramBindingRow | undefined;
  if (!row) return null;
  return pairBindingToMessage(row, message);
}

function tryPairFreshPrivateBinding(bindingIds: string[], message: TelegramMessage): TelegramBindingRow | null {
  if (bindingIds.length === 0 || message.chat.type !== "private") return null;
  const placeholders = bindingIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT * FROM telegram_bindings
       WHERE id IN (${placeholders})
         AND telegram_chat_id IS NULL
         AND enabled = 1
         AND status = 'waiting_for_chat'
       ORDER BY created_at DESC`,
    )
    .all(...bindingIds) as TelegramBindingRow[];
  if (rows.length !== 1) return null;
  const createdAt = Date.parse(rows[0].created_at);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30 * 60 * 1000) return null;
  return pairBindingToMessage(rows[0], message);
}

function pairBindingToMessage(row: TelegramBindingRow, message: TelegramMessage): TelegramBindingRow | null {
  const title = chatTitle(message.chat);
  getDb()
    .prepare(
      `UPDATE telegram_bindings
       SET telegram_chat_id = ?, telegram_chat_title = ?, status = 'chat_paired', updated_at = ?
       WHERE id = ?`,
    )
    .run(String(message.chat.id), title, nowIso(), row.id);
  return getBindingRow(row.id);
}

function chatTitle(chat: TelegramChat): string {
  return chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim() || chat.username || String(chat.id);
}

function telegramMessageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

function hasTelegramAttachment(message: TelegramMessage): boolean {
  return Boolean(
    message.photo?.length ||
      message.document ||
      message.video ||
      message.animation ||
      message.audio ||
      message.voice,
  );
}

function bestTelegramPhoto(message: TelegramMessage): TelegramPhotoSize | null {
  const photos = message.photo ?? [];
  if (!photos.length) return null;
  return [...photos].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0] ?? null;
}

function telegramAttachmentDescriptors(message: TelegramMessage): Array<{
  kind: string;
  fileId: string;
  name?: string;
  mediaType?: string;
  size?: number;
}> {
  const out: Array<{ kind: string; fileId: string; name?: string; mediaType?: string; size?: number }> = [];
  const photo = bestTelegramPhoto(message);
  if (photo) {
    out.push({
      kind: "photo",
      fileId: photo.file_id,
      name: `telegram-photo-${message.message_id}.jpg`,
      mediaType: "image/jpeg",
      size: photo.file_size,
    });
  }
  const addFile = (kind: string, file: TelegramFileDescriptor | undefined, fallbackName: string) => {
    if (!file?.file_id) return;
    out.push({
      kind,
      fileId: file.file_id,
      name: file.file_name || fallbackName,
      mediaType: file.mime_type,
      size: file.file_size,
    });
  };
  addFile("document", message.document, `telegram-document-${message.message_id}`);
  addFile("video", message.video, `telegram-video-${message.message_id}.mp4`);
  addFile("animation", message.animation, `telegram-animation-${message.message_id}.mp4`);
  addFile("audio", message.audio, `telegram-audio-${message.message_id}`);
  addFile("voice", message.voice, `telegram-voice-${message.message_id}.ogg`);
  return out;
}

function sanitizeTelegramFilename(name: string, fallback: string): string {
  const base = path.basename(name || fallback);
  return (base.replace(/[^\w.\-()가-힣 ]+/g, "_").replace(/\s+/g, " ").trim() || fallback).slice(0, 96);
}

function extensionForMediaType(mediaType: string | undefined, fallback = ".bin"): string {
  const type = (mediaType ?? "").toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "application/pdf") return ".pdf";
  if (type.includes("text/plain")) return ".txt";
  if (type.includes("json")) return ".json";
  if (type.includes("csv")) return ".csv";
  if (type.includes("markdown")) return ".md";
  if (type.startsWith("video/")) return ".mp4";
  if (type.startsWith("audio/")) return ".audio";
  return fallback;
}

function ensureNameExtension(name: string, mediaType: string | undefined): string {
  if (path.extname(name)) return name;
  return `${name}${extensionForMediaType(mediaType)}`;
}

async function downloadTelegramAttachments(
  token: string,
  binding: TelegramBindingRow,
  message: TelegramMessage,
): Promise<TelegramRuntimeAttachment[]> {
  const descriptors = telegramAttachmentDescriptors(message);
  if (!descriptors.length) return [];
  const runId = `${binding.id.slice(0, 8)}-${message.message_id}-${Date.now()}`;
  const dir = path.join(agentRunCwd(), ".agentlas", "chat-attachments", "telegram", runId);
  await fs.mkdir(dir, { recursive: true });
  const out: TelegramRuntimeAttachment[] = [];
  for (const [index, descriptor] of descriptors.entries()) {
    const fileInfo = await telegramApi<TelegramFileInfo>(token, "getFile", { file_id: descriptor.fileId });
    const size = descriptor.size ?? fileInfo.file_size ?? 0;
    const fallbackName = `telegram-${descriptor.kind}-${index + 1}`;
    const safeName = ensureNameExtension(
      sanitizeTelegramFilename(descriptor.name || fallbackName, fallbackName),
      descriptor.mediaType,
    );
    if (size > TELEGRAM_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        tg("attachment.too_large", {
          name: safeName,
          limit: Math.round(TELEGRAM_ATTACHMENT_MAX_BYTES / 1024 / 1024),
        }),
      );
    }
    if (!fileInfo.file_path) {
      throw new Error(`Telegram file path is missing for ${safeName}`);
    }
    const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > TELEGRAM_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        tg("attachment.too_large", {
          name: safeName,
          limit: Math.round(TELEGRAM_ATTACHMENT_MAX_BYTES / 1024 / 1024),
        }),
      );
    }
    const filePath = path.join(dir, `${String(index + 1).padStart(2, "0")}-${safeName}`);
    await fs.writeFile(filePath, bytes);
    const mediaType = descriptor.mediaType || mediaTypeFromFilename(safeName);
    out.push({
      path: filePath,
      name: safeName,
      mediaType,
      kind: descriptor.kind,
      size: bytes.byteLength,
      image: mediaType.startsWith("image/")
        ? { mediaType, name: safeName, data: bytes.toString("base64") }
        : undefined,
    });
  }
  return out;
}

function mediaTypeFromFilename(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".md") return "text/markdown";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if ([".mp4", ".mov", ".webm", ".m4v"].includes(ext)) return "video/mp4";
  if ([".ogg", ".mp3", ".wav", ".m4a"].includes(ext)) return "audio/mpeg";
  return "application/octet-stream";
}

function appendTelegramAttachmentGuide(prompt: string, attachments: TelegramRuntimeAttachment[]): string {
  if (!attachments.length) return prompt;
  const ko = currentUiLocale() === "ko";
  const list = attachments
    .map((att, index) => {
      const sizeMb = (att.size / 1024 / 1024).toFixed(att.size > 1024 * 1024 ? 1 : 3);
      return `${index + 1}. ${att.path} (${att.kind}, ${att.mediaType}, ${sizeMb}MB, original: ${att.name})`;
    })
    .join("\n");
  const guide = ko
    ? [
        "[Telegram 첨부 파일]",
        `사용자가 Telegram 메시지에 파일 ${attachments.length}개를 첨부했습니다. Agentlas가 읽을 수 있도록 아래 경로에 저장했습니다.`,
        list,
        "이미지는 먼저 열어서 확인하고, 문서/파일은 위 정확한 경로를 읽으세요. 다운로드 폴더나 최근 파일을 추측하지 마세요.",
      ].join("\n")
    : [
        "[Telegram attachments]",
        `The user attached ${attachments.length} file(s) in Telegram. Agentlas saved them at these readable paths:`,
        list,
        "Open images first and read documents/files from these exact paths. Do not guess via Downloads or recent files.",
      ].join("\n");
  return prompt.trim() ? `${prompt}\n\n${guide}` : guide;
}

function shouldHandleMessage(binding: TelegramBindingRow, message: TelegramMessage, text: string): boolean {
  if (message.chat.type === "private") return true;
  const chatBindings = listEnabledBindingsForChat(String(message.chat.id));
  const lower = text.toLowerCase();
  const mentionedBindings = chatBindings.filter((row) => {
    const username = row.bot_username ? `@${row.bot_username.toLowerCase()}` : "";
    return Boolean(username && lower.includes(username));
  });
  if (mentionedBindings.length > 0) {
    return mentionedBindings.some((row) => row.id === binding.id);
  }

  const repliedBotId = message.reply_to_message?.from?.id;
  if (repliedBotId) {
    const repliedBinding = chatBindings.find((row) => row.bot_user_id === repliedBotId);
    if (repliedBinding) return repliedBinding.id === binding.id;
  }

  if (chatBindings.length <= 1) return true;

  const orchestrators = chatBindings.filter((row) => row.target_kind === "firm" || row.target_kind === "group");
  if (orchestrators.length === 1 && orchestrators[0].id === binding.id) {
    return true;
  }

  return false;
}

function listEnabledBindingsForChat(chatId: string): TelegramBindingRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM telegram_bindings
       WHERE telegram_chat_id = ?
         AND enabled = 1
       ORDER BY target_kind = 'agent' ASC, updated_at DESC`,
    )
    .all(chatId) as TelegramBindingRow[];
}

function cleanTelegramPrompt(binding: TelegramBindingRow, text: string): string {
  let out = text;
  if (binding.bot_username) {
    out = out.replace(new RegExp(`@${escapeRegExp(binding.bot_username)}`, "ig"), "");
  }
  return out.replace(/^\/start\b/i, "테스트").trim();
}

function isAutomationReportEnableRequest(text: string): boolean {
  const lower = text.toLowerCase();
  const mentionsAutomation = /자동화|automation|scheduled job|background job/i.test(text);
  const wantsNotification =
    /보고|알림|알려|말해|보내|띄워|전달|브리핑|notify|notification|report|tell|send|post|brief/i.test(text);
  const completion =
    /끝나|끝났|끝날|끝나고|끝나면|완료|마치|complete|completed|done|finish|finished|after/i.test(text);
  const future =
    /앞으로|이제부터|계속|마다|될 때|할 때|whenever|from now|future|every time/i.test(text);
  const thisChat =
    /여기|이 방|이방|이 채팅|텔레|telegram|dm|나한테|this chat|here|to me/i.test(lower);
  return mentionsAutomation && wantsNotification && (completion || future || thisChat);
}

function isAutomationReportDisableRequest(text: string): boolean {
  return /자동화|automation/i.test(text) && /보고|알림|notify|notification|report/i.test(text) && /꺼|끄|중지|그만|stop|off|disable/i.test(text);
}

function isAutomationReportStatusRequest(text: string): boolean {
  return /자동화|automation/i.test(text) && /보고|알림|notify|notification|report/i.test(text) && /상태|켜져|켜짐|꺼져|확인|status|on|off/i.test(text);
}

function automationReportStatusText(binding: TelegramBindingRow): string {
  if (binding.automation_report_enabled === 1) {
    return tg("automation.status_on");
  }
  return tg("automation.status_off");
}

function setAutomationReportEnabled(bindingId: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE telegram_bindings SET automation_report_enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nowIso(), bindingId);
}

function telegramInvocationMode(userText: string): TelegramInvocationMode {
  const asksToMakeSomething =
    /만들|제작|구현|개발|코딩|빌드|생성|작성|수정|고쳐|고치|배포|웹|웹사이트|사이트|랜딩|페이지|앱|대시보드|프로토타입|자동화|create|make|build|implement|code|write|edit|fix|deploy|website|web\s*app|site|landing|page|dashboard|prototype|automation/i.test(
      userText,
    );
  if (!asksToMakeSomething) {
    return { permissions: "read", goalMode: false, instruction: "" };
  }
  const ko = currentUiLocale() === "ko";
  return {
    permissions: "write",
    goalMode: true,
    instruction: ko
      ? [
          "Telegram 전용 실행이다.",
          "사용자는 데스크톱 채팅창을 열지 않고 이 Telegram 대화만으로 결과를 받길 기대한다.",
          "웹/앱/파일 제작 요청이면 실제 파일을 만들거나 수정하고, 완료 후 Telegram에 결과 경로, 실행 방법, 다음에 보낼 수 있는 수정 문장을 짧게 보고하라.",
          "폴더가 명시되지 않았으면 현재 Agentlas 기본 작업 폴더 아래에 목표를 알 수 있는 새 폴더를 만들어 진행하라.",
        ].join("\n")
      : [
          "This is a Telegram-only execution.",
          "The user expects to drive the work from this Telegram chat without opening the desktop chat UI.",
          "For website/app/file creation requests, actually create or edit files, then report the artifact path, how to run it, and the next Telegram edit they can send.",
          "If no folder is specified, create a clearly named folder under the current Agentlas default working folder.",
        ].join("\n"),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runBindingInvocation(
  binding: TelegramBindingRow,
  message: TelegramMessage,
  userText: string,
  mode = telegramInvocationMode(userText),
  attachments: TelegramRuntimeAttachment[] = [],
  replyLocale: "ko" | "en" = detectReplyLocale(userText),
): Promise<string> {
  const chat = await ensureBindingChat(binding);
  // 언어 규칙: 앱 지침이 한국어여도, 사용자가 보낸 메시지의 언어로 답한다(영어면 영어,
  // 그 외 외국어면 그 언어). LLM이 임의 언어까지 맞추도록 명시 지시.
  const languageDirective =
    "IMPORTANT language rule: reply in the SAME language the user wrote their message in. " +
    "If the user's message is in English, answer in English; if Korean, answer in Korean; " +
    "if in any other language, answer in that language. Do not default to the app's UI language.";
  const prompt = [
    `Telegram chat: ${binding.telegram_chat_title || chatTitle(message.chat)} (${message.chat.type})`,
    message.from?.username ? `From: @${message.from.username}` : "",
    languageDirective,
    mode.instruction,
    "",
    userText,
  ].filter(Boolean).join("\n");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TELEGRAM_INVOCATION_TIMEOUT_MS);
  let finalFromEvents = "";
  let errorFromEvents = "";
  const result = await runMcpInvocation({
    chatId: chat.id,
    userPrompt: prompt,
    images: attachments.map((attachment) => attachment.image).filter((image): image is ImageAttachment => Boolean(image)),
    locale: replyLocale,
    permissions: mode.permissions,
    goalMode: mode.goalMode,
  }, (event: McpInvocationEvent) => {
    const text = event.kind === "final" ? event.text?.trim() : "";
    if (text) {
      finalFromEvents = text;
    } else if (event.kind === "error" && event.error?.message) {
      errorFromEvents = event.error.message;
    }
  }, controller.signal).finally(() => {
    clearTimeout(timer);
  });
  if (timedOut) {
    throw new TelegramInvocationTimeoutError(tg("run.timeout", {}, replyLocale));
  }
  const finalText = result.finalText?.trim() || finalFromEvents.trim();
  if (!finalText) {
    throw new Error(errorFromEvents.trim() || tg("error.no_reply", {}, replyLocale));
  }
  // 엔진이 남긴 <<agentlas-ask>>·<<agentlas-multimodal-setup>> raw fence를 평문화한 뒤 전송.
  return flattenSentinelsForTelegram(finalText, replyLocale);
}

async function ensureBindingChat(binding: TelegramBindingRow) {
  if (binding.chat_session_id) {
    const existing = getChat(binding.chat_session_id);
    if (existing) return existing;
  }
  let input: { agentId?: string; firmId?: string | null; agentGroupId?: string | null };
  if (binding.target_kind === "agent") {
    const agent = getAgentById(binding.target_id);
    if (!agent) throw new Error(`Telegram target agent not found: ${binding.target_id}`);
    input = { agentId: agent.id };
  } else if (binding.target_kind === "firm") {
    const firm = getFirm(binding.target_id);
    if (!firm) throw new Error(`Telegram target firm not found: ${binding.target_id}`);
    input = { firmId: firm.id };
  } else {
    const group = await resolveAgentGroupForRuntime(binding.target_id);
    if (!group || group.members.length === 0) throw new Error(`Telegram target group has no runnable members: ${binding.target_id}`);
    const installed = listInstalledAgents();
    const localSlug = group.members.find((member) => member.source !== "hub")?.slug.split(":").pop();
    const anchor = localSlug ? installed.find((agent) => agent.slug === localSlug) : null;
    if (!anchor) throw new Error(`Telegram target group needs at least one installed local member: ${binding.target_id}`);
    input = { agentId: anchor.id, agentGroupId: group.group.id };
  }
  const chat = createChat({
    ...input,
    kind: "division",
    title: `⟦telegram⟧${binding.id}`,
  });
  getDb()
    .prepare("UPDATE telegram_bindings SET chat_session_id = ?, updated_at = ? WHERE id = ?")
    .run(chat.id, nowIso(), binding.id);
  return chat;
}

// LLM 응답의 sentinel fence를 텔레그램용 평문으로 바꾼다.
// 데스크톱 렌더러는 <<agentlas-ask>>를 질문 카드(ChatQuestionSheet)로,
// <<agentlas-multimodal-setup>>을 설정 버튼으로 변환하지만(renderer/lib/ask-question.ts·
// multimodal-setup.ts), 엔진(electron/mcp/client.ts)은 이 두 fence를 raw로 남긴 채
// finalText를 반환한다. 텔레그램엔 그 UI가 없어 원문 마커가 그대로 노출됐다 —
// 여기서 사람이 읽을 수 있는 텍스트로 평문화한다. fence 포맷은 ask-question.ts와 동일.
const TG_ASK_OPEN = "<<agentlas-ask>>";
const TG_ASK_CLOSE = "<</agentlas-ask>>";
const TG_MULTIMODAL_MARKER = "<<agentlas-multimodal-setup>>";

function flattenAskFenceBody(body: string, replyLocale: "ko" | "en"): string | null {
  const stripped = body.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.question !== "string") return null;
  const lines: string[] = [o.question.trim()];
  const optionsRaw = Array.isArray(o.options) ? o.options : [];
  let n = 0;
  for (const opt of optionsRaw) {
    if (!opt || typeof opt !== "object") continue;
    const ob = opt as Record<string, unknown>;
    if (typeof ob.label !== "string") continue;
    const desc =
      typeof ob.description === "string" && ob.description.trim() ? ` — ${ob.description.trim()}` : "";
    lines.push(`${n + 1}. ${ob.label.trim()}${desc}`);
    n++;
  }
  if (n > 0) {
    lines.push(
      replyLocale === "en"
        ? "\nReply with the number (or the option) you want."
        : "\n원하는 번호(또는 항목)를 답장으로 보내주세요.",
    );
  }
  return lines.join("\n");
}

/** 텔레그램 아웃바운드 텍스트의 ask/멀티모달 sentinel fence를 평문화·제거한다. */
function flattenSentinelsForTelegram(text: string, replyLocale: "ko" | "en"): string {
  let out = text;
  if (out.includes(TG_ASK_OPEN)) {
    let result = "";
    let rest = out;
    for (;;) {
      const open = rest.indexOf(TG_ASK_OPEN);
      if (open < 0) {
        result += rest;
        break;
      }
      result += rest.slice(0, open);
      const afterOpen = rest.slice(open + TG_ASK_OPEN.length);
      const close = afterOpen.indexOf(TG_ASK_CLOSE);
      if (close < 0) {
        // 닫는 fence가 없으면(스트리밍 잔재) 열림 마커만 제거하고 본문은 보존
        result += afterOpen;
        break;
      }
      const flat = flattenAskFenceBody(afterOpen.slice(0, close), replyLocale);
      result += flat ?? ""; // 파싱 실패 시 fence 통째 제거(raw 노출 방지)
      rest = afterOpen.slice(close + TG_ASK_CLOSE.length);
    }
    out = result;
  }
  if (out.includes(TG_MULTIMODAL_MARKER)) {
    out = out.split(TG_MULTIMODAL_MARKER).join("");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

async function sendLongMessage(token: string, chatId: string, text: string): Promise<void> {
  const chunks = chunkText(text, 3800);
  for (const chunk of chunks) {
    await telegramApi(token, "sendMessage", { chat_id: chatId, text: chunk });
  }
}

export async function notifyTelegramAutomationDone(
  automation: Automation,
  status: "ok" | "error" | "skipped",
  detail?: { error?: string | null; output?: string; at?: string },
): Promise<void> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM telegram_bindings
       WHERE enabled = 1
         AND automation_report_enabled = 1
         AND telegram_chat_id IS NOT NULL`,
    )
    .all() as TelegramBindingRow[];
  if (!rows.length) return;
  const text = formatAutomationReport(automation, status, detail);
  const sent = new Set<string>();
  for (const row of rows) {
    const key = `${row.id}:${row.telegram_chat_id}`;
    if (sent.has(key) || !row.telegram_chat_id) continue;
    try {
      const token = await readBindingSecret(row.id);
      if (!token) continue;
      await sendLongMessage(token, row.telegram_chat_id, text);
      sent.add(key);
    } catch (error) {
      // One revoked bot, transient Telegram outage, or broken chat must not
      // starve every later destination. Keep the failure scoped to this port.
      console.warn(
        `[telegram] automation report failed for binding ${row.id}:`,
        maskTelegramSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

function formatAutomationReport(
  automation: Automation,
  status: "ok" | "error" | "skipped",
  detail?: { error?: string | null; output?: string; at?: string },
): string {
  const ko = currentUiLocale() === "ko";
  const at = detail?.at ? new Date(detail.at) : new Date();
  const when = at.toLocaleString(ko ? "ko-KR" : "en-US", { dateStyle: "short", timeStyle: "short" });
  const title = tg("automation.report_title", { name: automation.name });
  const statusText = status === "ok"
    ? tg("automation.status_completed")
    : status === "skipped"
      ? tg("automation.status_skipped")
      : tg("automation.status_failed");
  const lines = [
    title,
    tg("automation.status_label", { status: statusText }),
    tg("automation.time_label", { time: when }),
  ];
  if (detail?.error) lines.push(tg("automation.error_label", { error: clipForTelegram(detail.error, 800) }));
  else if (detail?.output?.trim()) lines.push(tg("automation.summary_label", { summary: clipForTelegram(detail.output, 1200) }));
  return lines.join("\n");
}

function clipForTelegram(value: string, max: number): string {
  const clean = value.replace(/\s+\n/g, "\n").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function markBindingFailed(id: string, message: string): void {
  getDb()
    .prepare("UPDATE telegram_bindings SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
    .run(message.slice(0, 1000), nowIso(), id);
}

function disableMissingTargetBinding(id: string): void {
  getDb()
    .prepare("UPDATE telegram_bindings SET enabled = 0, status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
    .run(tg("target.deleted").slice(0, 1000), nowIso(), id);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function createTelegramWebWindow(title: string): BrowserWindow {
  const ses = electronSession.fromPartition(TELEGRAM_WEB_PARTITION);
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("before-input-event", (_event, input) => {
    const closeRequested = input.type === "keyDown" && (input.key === "Escape" || ((input.meta || input.control) && input.key.toLowerCase() === "w"));
    if (closeRequested) win.close();
  });

  return win;
}

async function loadTelegramWebUrl(win: BrowserWindow, url: string, context: string): Promise<void> {
  await win.loadURL(url).catch((err) => {
    console.warn(`[telegram] ${context} window load failed:`, err instanceof Error ? err.message : err);
  });
}

async function captureBotFatherToken(
  targetName: string,
  customDisplayName?: string,
): Promise<BotFatherCapture> {
  const win = createTelegramWebWindow(tg("botfather.connect_title"));
  await loadTelegramWebUrl(win, BOTFATHER_WEB_URL, "botfather");
  const ready = await waitForBotFatherReady(win, 180_000);
  if (ready.botFatherBlocked) throw new Error(tg("botfather.blocked"));

  const createdToken = await createBotWithBotFather(win, targetName, customDisplayName);
  return { token: createdToken, source: "created", window: win };
}

async function waitForBotFatherReady(win: BrowserWindow, timeoutMs: number): Promise<TelegramWebState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertWindowOpen(win);
    const state = await readTelegramWebState(win);
    if (state.botFatherBlocked || (state.hasComposer && state.hasBotFather)) return state;
    await sleep(1000);
  }
  throw new Error(
    tg("botfather.login_timeout"),
  );
}

async function readTelegramWebState(win: BrowserWindow): Promise<TelegramWebState> {
  try {
    const state = await settleWithin(win.webContents.executeJavaScript(
      `(() => {
        const text = document.body && document.body.innerText ? document.body.innerText : "";
        const matches = text.match(/\\b\\d{8,12}:[A-Za-z0-9_-]{30,}\\b/g) || [];
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'));
        const visibleEditors = editors.filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 24 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
        });
        return {
          token: matches.length ? matches[matches.length - 1] : null,
          tokens: matches,
          hasComposer: visibleEditors.length > 0,
          hasBotFather: /BotFather/i.test(text) || location.href.toLowerCase().includes("botfather"),
          botFatherBlocked: /Only Premium users can message BotFather/i.test(text),
          href: location.href
        };
      })()`,
      true,
    ) as Promise<TelegramWebState>, 2500, null as TelegramWebState | null);
    if (!state) return { token: null, tokens: [], hasComposer: false, hasBotFather: false, botFatherBlocked: false, href: "" };
    return {
      token: typeof state.token === "string" ? state.token : null,
      tokens: Array.isArray(state.tokens) ? state.tokens.filter((token) => typeof token === "string") : [],
      hasComposer: Boolean(state.hasComposer),
      hasBotFather: Boolean(state.hasBotFather),
      botFatherBlocked: Boolean(state.botFatherBlocked),
      href: typeof state.href === "string" ? state.href : "",
    };
  } catch {
    return { token: null, tokens: [], hasComposer: false, hasBotFather: false, botFatherBlocked: false, href: "" };
  }
}

async function isBotFatherMessagingBlocked(win: BrowserWindow): Promise<boolean> {
  const state = await readTelegramWebState(win);
  return state.botFatherBlocked;
}

function botFatherBlockedMessage(): { ok: boolean; message: string } {
  return {
    ok: false,
    message: tg("botfather.blocked"),
  };
}

function botFatherManualSettingsMessage(): { ok: boolean; message: string } {
  return {
    ok: false,
    message: tg("botfather.manual_settings"),
  };
}

async function createBotWithBotFather(
  win: BrowserWindow,
  targetName: string,
  customDisplayName?: string,
): Promise<string> {
  // 사용자가 봇 표시 이름을 지정하면 그대로(공백 정리 + BotFather 64자 한도), 없으면
  // "Agentlas <타겟명>" 자동. username(@…bot)은 전역 유니크 제약 탓에 항상 랜덤 유지한다.
  const custom = customDisplayName?.replace(/\s+/g, " ").trim().slice(0, 62);
  const displayName = custom || botDisplayName(targetName);
  const knownTokens = new Set((await readTelegramWebState(win)).tokens);
  await sendTelegramWebMessage(win, "/newbot");
  await sleep(1400);
  await sendTelegramWebMessage(win, displayName);
  await sleep(1400);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const username = botUsername();
    await sendTelegramWebMessage(win, username);
    const token = await waitForTokenForBot(win, 18_000, knownTokens, username);
    if (token) return token;
    for (const existing of (await readTelegramWebState(win)).tokens) knownTokens.add(existing);
    await sleep(800);
  }

  // BotFather가 왜 거부했는지(봇 개수 한도·레이트리밋·이름 중복 등)를 그대로 붙여
  // 사용자가 원인을 알 수 있게 한다. 토큰은 마스킹.
  const reason = maskTelegramSecrets(await telegramLatestIncomingText(win));
  throw new Error(
    reason ? `${tg("botfather.create_failed")} — ${reason}` : tg("botfather.create_failed"),
  );
}

async function telegramLatestIncomingText(win: BrowserWindow): Promise<string> {
  return String(
    (await win.webContents
      .executeJavaScript(
        `(() => {
          const bubbles = Array.from(document.querySelectorAll(".bubble.is-in"));
          return (bubbles[bubbles.length - 1]?.textContent || "").trim().slice(0, 300);
        })()`,
        true,
      )
      .catch(() => "")) || "",
  ).trim();
}

async function waitForTokenForBot(
  win: BrowserWindow,
  timeoutMs: number,
  knownTokens: Set<string>,
  expectedUsername: string,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertWindowOpen(win);
    const state = await readTelegramWebState(win);
    for (const token of state.tokens) {
      if (knownTokens.has(token)) continue;
      try {
        const me = await verifyBotToken(token);
        if (me.username?.toLowerCase() === expectedUsername.toLowerCase()) return token;
      } catch {
        // Ignore non-bot or stale tokens surfaced in BotFather history.
      }
      knownTokens.add(token);
    }
    await sleep(900);
  }
  return null;
}

async function openBotAndSendStart(win: BrowserWindow, botUsername: string, bindingId: string): Promise<TelegramConnectBinding | null> {
  assertWindowOpen(win);
  await loadTelegramWebUrl(win, `https://web.telegram.org/k/#@${encodeURIComponent(botUsername)}`, "pair bot");
  await waitForTelegramChatReady(win, 90_000);
  // 페어링 토큰을 반드시 실어 보낸다 — poller는 `/start <bindingId>`가 일치할 때만 귀속한다.
  // (Start 버튼은 페이로드 없는 /start만 보내므로, 토큰이 실린 텍스트 메시지를 직접 보낸다.)
  await clickTelegramStartButton(win).catch(() => false);
  await sendTelegramWebMessage(win, `/start ${bindingId}`);
  return waitForBindingChat(bindingId, 35_000);
}

async function waitForTelegramChatReady(win: BrowserWindow, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertWindowOpen(win);
    const ready = await win.webContents.executeJavaScript(
      `(() => {
        const text = document.body && document.body.innerText ? document.body.innerText : "";
        const buttons = Array.from(document.querySelectorAll('button, .Button, [role="button"]'));
        const hasStart = buttons.some((el) => /^start$/i.test((el.textContent || "").trim()) || /시작/.test(el.textContent || ""));
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'));
        const hasComposer = editors.some((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 24 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
        });
        return hasStart || hasComposer || /Bot Info|Send Message|메시지/i.test(text);
      })()`,
      true,
    ).catch(() => false);
    if (ready) return;
    await sleep(1000);
  }
  throw new Error(tg("error.open_chat_failed"));
}

async function clickTelegramStartButton(win: BrowserWindow): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button, .Button, [role="button"]'));
      const button = buttons.find((el) => /^start$/i.test((el.textContent || "").trim()) || /시작/.test(el.textContent || ""));
      if (!button) return false;
      button.click();
      return true;
    })()`,
    true,
  ).catch(() => false));
}

async function clickTelegramButtonByText(win: BrowserWindow, labels: string[], timeoutMs: number): Promise<boolean> {
  const needles = labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertWindowOpen(win);
    const clicked = await settleWithin(win.webContents.executeJavaScript(
      `(() => {
        const needles = ${JSON.stringify(needles)};
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const elements = Array.from(document.querySelectorAll('button, .Button, [role="button"], .reply-markup-button, .KeyboardButton, span.reply-markup-button-text'));
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (rect.width < 12 || rect.height < 10 || style.display === "none" || style.visibility === "hidden") continue;
          const text = normalize(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title"));
          if (!text) continue;
          if (needles.some((needle) => text.includes(needle))) {
            const target = el.closest('button, .Button, [role="button"], .reply-markup-button, .KeyboardButton') || el;
            target.click();
            return true;
          }
        }
        return false;
      })()`,
      true,
    ) as Promise<boolean>, 1800, false);
    if (clicked) return true;
    await sleep(900);
  }
  return false;
}

async function sendTelegramWebMessage(win: BrowserWindow, text: string): Promise<void> {
  assertWindowOpen(win);
  const focused = await settleWithin(win.webContents.executeJavaScript(
    `(() => {
      const candidates = Array.from(document.querySelectorAll('div[contenteditable="true"], [contenteditable="true"], textarea, input[type="text"]'));
      const visible = candidates.filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 24 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
      });
      const scored = visible
        .filter((el) => !String(el.className || "").includes("fake") && !el.closest(".input-field-input-fake"))
        .map((el) => {
          const className = String(el.className || "");
          let score = 0;
          if (el.matches('textarea, input[type="text"]')) score += 20;
          if (el.matches('[data-peer-id]')) score += 40;
          if (className.includes("input-message-input")) score += 30;
          if (el.getAttribute("role") === "textbox") score += 10;
          return { el, score };
        })
        .sort((a, b) => a.score - b.score);
      const el = scored[scored.length - 1]?.el || visible[visible.length - 1];
      if (!el) return false;
      el.focus();
      if ("value" in el) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("delete", false);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      }
      return true;
    })()`,
    true,
  ) as Promise<boolean>, 3500, false);
  if (!focused) {
    throw new Error(tg("error.message_box_missing"));
  }
  await win.webContents.insertText(text);
  await sleep(250);
  const clicked = await settleWithin(win.webContents.executeJavaScript(
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button, .Button, [role="button"]'));
      const button = buttons.find((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width < 10 || rect.height < 10 || style.display === "none" || style.visibility === "hidden") return false;
        return /send|보내기/i.test(el.getAttribute("aria-label") || "") || /btn-send|send/i.test(String(el.className || ""));
      });
      if (!button) return false;
      button.click();
      return true;
    })()`,
    true,
  ) as Promise<boolean>, 2500, false);
  if (!clicked) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  }
  await sleep(850);
}

async function waitForBindingChat(bindingId: string, timeoutMs: number): Promise<TelegramConnectBinding | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = getBindingRow(bindingId);
    if (row?.telegram_chat_id) return toBinding(row);
    await sleep(1000);
  }
  return null;
}

function botDisplayName(targetName: string): string {
  const clean = targetName.replace(/\s+/g, " ").trim();
  const suffix = clean ? ` ${clean}` : "";
  return `Agentlas${suffix}`.slice(0, 62);
}

function botUsername(): string {
  return `agentlas${randomUUID().replace(/-/g, "").slice(0, 12)}bot`;
}

function assertWindowOpen(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    throw new Error(tg("error.window_closed"));
  }
}

function closeBotFatherWindow(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    try {
      win.close();
    } catch {
      // ignore
    }
  }
}

function maskTelegramSecrets(message: string): string {
  return message.replace(TOKEN_RE, "[hidden]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
