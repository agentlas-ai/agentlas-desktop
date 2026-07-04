import { createHash, randomUUID } from "node:crypto";
import { BrowserWindow, session as electronSession, shell } from "electron";
import { currentUiLocale } from "../main";
import { runMcpInvocation } from "../mcp/client";
import { getAgentById, listInstalledAgents } from "../mcp/registry";
import { getAgentGroup } from "../store/agent-groups";
import { resolveAgentGroupForRuntime } from "../store/agent-groups";
import { createChat, getChat } from "../store/chats";
import { getDb } from "../store/db";
import { getFirm } from "../store/firms";
import { deleteSecret, previewSecret, readSecret, setSecret } from "../secrets/vault";
import type {
  Automation,
  McpInvocationEvent,
  TelegramConnectActionResult,
  TelegramConnectAutoInput,
  TelegramConnectBinding,
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
  reply_to_message?: {
    from?: TelegramUser;
  };
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
const TOKEN_RE = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;

interface TelegramWebState {
  token: string | null;
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

function nowIso(): string {
  return new Date().toISOString();
}

function secretKey(bindingId: string): string {
  return `${TELEGRAM_SECRET_SCOPE}:${bindingId}`;
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
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
    targetName: target?.name ?? row.target_id,
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

async function toBinding(row: TelegramBindingRow): Promise<TelegramConnectBinding> {
  const preview = await previewSecret(secretKey(row.id));
  return bindingFromRow(row, Boolean(preview), preview);
}

export async function listTelegramBindings(): Promise<TelegramConnectBinding[]> {
  await reconcileTelegramWorkers();
  return Promise.all(listBindingRows().map(toBinding));
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
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const json = await res.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !json?.ok) {
    throw new Error(json?.description || `Telegram ${method} failed (${res.status})`);
  }
  return json.result as T;
}

async function verifyBotToken(token: string): Promise<TelegramUser> {
  const me = await telegramApi<TelegramUser>(token, "getMe", {});
  if (!me.is_bot) throw new Error("Telegram token does not belong to a bot.");
  return me;
}

export async function autoConnectTelegram(input: TelegramConnectAutoInput): Promise<TelegramConnectActionResult> {
  const target = resolveTarget(input.targetKind, input.targetId, true);
  const existing = await findReusableTargetBinding(input.targetKind, input.targetId);
  if (existing?.telegram_chat_id) {
    const result = await sendTelegramTest(existing.id);
    return {
      binding: result.binding,
      message:
        currentUiLocale() === "ko"
          ? "이미 연결된 Telegram 방을 확인했고 테스트 메시지도 보냈습니다."
          : "Existing Telegram chat confirmed. A test message was sent.",
    };
  }

  let capture: BotFatherCapture | null = null;
  try {
    capture = await captureBotFatherToken(target?.name ?? "Agentlas");
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
    const ko = currentUiLocale() === "ko";
    return {
      binding,
      message: paired
        ? ko
          ? "Telegram 방까지 연결했습니다. 이제 그 방에서 말하면 Agentlas가 선택한 에이전트에게 보냅니다."
          : "Telegram chat connected. Messages in that chat now route to the selected Agentlas target."
        : ko
          ? "봇은 준비됐습니다. 열린 Telegram 창에서 시작을 누르면 방 연결이 끝납니다."
          : "Bot is ready. Press Start in the Telegram window to finish pairing the chat.",
    };
  } catch (err) {
    if (capture?.window) closeBotFatherWindow(capture.window);
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
    const token = await readSecret(secretKey(row.id));
    if (token && row.bot_username) return row;
  }
  return null;
}

export async function startTelegramConnection(input: TelegramConnectStartInput): Promise<TelegramConnectActionResult> {
  resolveTarget(input.targetKind, input.targetId, true);
  const token = input.botToken.trim();
  if (!token) throw new Error("Telegram bot secret is required.");
  const me = await verifyBotToken(token);
  const id = randomUUID();
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO telegram_bindings
       (id, target_kind, target_id, bot_user_id, bot_username, bot_display_name, status, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'waiting_for_chat', 1, ?, ?)`,
    )
    .run(
      id,
      input.targetKind,
      input.targetId,
      me.id,
      me.username ?? null,
      me.first_name ?? null,
      now,
      now,
    );
  await setSecret(secretKey(id), token);
  await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: false }).catch(() => false);
  await reconcileTelegramWorkers();
  const binding = await toBinding(getBindingRow(id) as TelegramBindingRow);
  return {
    binding,
    message:
      currentUiLocale() === "ko"
        ? "봇 확인 완료. 이제 Telegram에서 봇에게 메시지를 보내면 이 연결이 방을 기억합니다."
        : "Bot verified. Send a Telegram message to the bot and this connection will remember that chat.",
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
  const token = await readSecret(secretKey(id));
  if (!token) {
    markBindingFailed(id, "Telegram bot secret is missing from Keychain.");
    return toBinding(getBindingRow(id) as TelegramBindingRow);
  }
  const nextStatus: TelegramConnectStatus =
    row.telegram_chat_id
      ? row.status === "disabled" || row.status === "failed"
        ? "chat_paired"
        : row.status
      : "waiting_for_chat";
  getDb()
    .prepare("UPDATE telegram_bindings SET enabled = 1, status = ?, last_error = NULL, updated_at = ? WHERE id = ?")
    .run(nextStatus, nowIso(), id);
  await telegramApi<boolean>(token, "deleteWebhook", { drop_pending_updates: false }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    markBindingFailed(id, message);
    throw err;
  });
  await reconcileTelegramWorkers();
  return toBinding(getBindingRow(id) as TelegramBindingRow);
}

export async function removeTelegramConnection(id: string): Promise<void> {
  getDb().prepare("DELETE FROM telegram_bindings WHERE id = ?").run(id);
  await deleteSecret(secretKey(id));
  await reconcileTelegramWorkers();
}

export async function openTelegramBot(id: string): Promise<{ ok: boolean; message: string }> {
  const row = getBindingRow(id);
  if (!row?.bot_username) return { ok: false, message: "Bot username is not known yet." };
  await shell.openExternal(`https://t.me/${row.bot_username}`);
  return { ok: true, message: `https://t.me/${row.bot_username}` };
}

export async function configureTelegramBotSettings(id: string): Promise<{ ok: boolean; message: string }> {
  const row = getBindingRow(id);
  if (!row) throw new Error(`Telegram binding not found: ${id}`);
  if (!row.bot_username) {
    return {
      ok: false,
      message: currentUiLocale() === "ko" ? "아직 봇 이름을 모릅니다. 먼저 봇 포트를 만들어주세요." : "Bot username is not known yet. Create the bot port first.",
    };
  }

  const win = createTelegramWebWindow(
    currentUiLocale() === "ko" ? "Agentlas Telegram 봇 설정" : "Agentlas Telegram Bot Settings",
  );
  try {
    await win.loadURL(BOTFATHER_WEB_URL);
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
      const sentBotName = await settleWithin(sendTelegramWebMessage(win, row.bot_username).then(() => true), 8_000, false);
      if (!sentBotName) return botFatherManualSettingsMessage();
      await sleep(1200);
    }
    if (await isBotFatherMessagingBlocked(win)) return botFatherBlockedMessage();

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
    const ko = currentUiLocale() === "ko";
    if (disabledPrivacy) {
      await sleep(1200);
      closeBotFatherWindow(win);
      return {
        ok: true,
        message: ko
          ? "그룹 전체 메시지 받기를 켰습니다. 이미 초대한 그룹은 봇을 빼고 다시 초대해야 적용될 수 있고, 반영에 몇 분 걸릴 수 있습니다."
          : "Group-wide message receiving was requested. If the bot is already in a group, remove and re-add it; Telegram may take a few minutes to apply it.",
      };
    }
    return {
      ok: false,
      message: ko
        ? "BotFather 설정 창을 열어두었습니다. 화면에 보이는 Disable 버튼을 누르면 그룹 전체 메시지 받기가 켜집니다."
        : "BotFather settings are open. Press the visible Disable button to let the bot receive group-wide messages.",
    };
  } catch (err) {
    if (!win.isDestroyed()) win.focus();
    throw new Error(maskTelegramSecrets(err instanceof Error ? err.message : String(err)));
  }
}

export async function sendTelegramTest(id: string): Promise<TelegramConnectActionResult> {
  const row = getBindingRow(id);
  if (!row) throw new Error(`Telegram binding not found: ${id}`);
  if (!row.telegram_chat_id) throw new Error("Telegram chat is not paired yet.");
  const token = await readSecret(secretKey(id));
  if (!token) throw new Error("Telegram bot secret is missing from Keychain.");
  if (row.enabled === 1) await reconcileTelegramWorkers();
  const text =
    currentUiLocale() === "ko"
      ? "Agentlas 연결 테스트입니다. 이 메시지에 답장하거나 봇을 불러 작업을 맡겨보세요."
      : "Agentlas connection test. Reply to this message or mention the bot to assign work.";
  await telegramApi(token, "sendMessage", { chat_id: row.telegram_chat_id, text });
  getDb()
    .prepare("UPDATE telegram_bindings SET last_test_at = ?, status = 'test_passed', updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), id);
  return {
    binding: await toBinding(getBindingRow(id) as TelegramBindingRow),
    message: currentUiLocale() === "ko" ? "테스트 메시지를 보냈습니다." : "Test message sent.",
  };
}

async function activeBindingSecrets(): Promise<Array<{ row: TelegramBindingRow; token: string }>> {
  const rows = getDb()
    .prepare("SELECT * FROM telegram_bindings WHERE enabled = 1")
    .all() as TelegramBindingRow[];
  const out: Array<{ row: TelegramBindingRow; token: string }> = [];
  for (const row of rows) {
    const token = await readSecret(secretKey(row.id));
    if (token) out.push({ row, token });
    else markBindingFailed(row.id, "Telegram bot secret is missing from Keychain.");
  }
  return out;
}

export async function reconcileTelegramWorkers(): Promise<void> {
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
  const text = message?.text?.trim();
  if (!message || !text) return;
  const chatId = String(message.chat.id);
  let binding = findBindingForChat([...poller.bindingIds], chatId);
  if (!binding) {
    // 보안: 선착순 귀속 금지. `/start <bindingId>` 토큰이 일치하는 미페어링 바인딩만 귀속한다.
    // bindingId는 randomUUID(추측 불가)이고 앱의 텔레그램 세션만 이 토큰을 실어 보낸다.
    binding = tryPairBindingWithToken([...poller.bindingIds], message, text);
    if (binding) {
      // 페어링 확정 — 이 핸드셰이크 메시지는 실행하지 않고 확인만 보낸다.
      await telegramApi(poller.token, "sendMessage", {
        chat_id: chatId,
        text: currentUiLocale() === "ko" ? "Agentlas에 연결되었습니다. 이제 메시지로 실행할 수 있어요." : "Connected to Agentlas. You can now run it by messaging here.",
      }).catch(() => undefined);
    }
    return;
  }
  if (!shouldHandleMessage(binding, message, text)) return;

  const clean = cleanTelegramPrompt(binding, text);
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
      text:
        currentUiLocale() === "ko"
          ? "알겠습니다. 앞으로 자동화 완료 보고는 이 Telegram 방으로 보내지 않을게요."
          : "Done. Automation completion reports will no longer be sent to this Telegram chat.",
    }).catch(() => undefined);
    return;
  }
  if (isAutomationReportEnableRequest(clean)) {
    setAutomationReportEnabled(binding.id, true);
    await telegramApi(poller.token, "sendMessage", {
      chat_id: chatId,
      text:
        currentUiLocale() === "ko"
          ? "좋아요. 앞으로 Agentlas 자동화가 끝나면 이 Telegram 방에 보고할게요. 끄려면 “자동화 보고 꺼”라고 말하면 됩니다."
          : "Got it. Agentlas automation completions will be reported to this Telegram chat. Say “turn off automation reports” to stop.",
    }).catch(() => undefined);
    return;
  }
  await telegramApi(poller.token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  try {
    const finalText = await runBindingInvocation(binding, message, clean);
    await sendLongMessage(poller.token, chatId, finalText);
    const nextStatus: TelegramConnectStatus = /테스트|test/i.test(clean) ? "test_passed" : "running";
    getDb()
      .prepare("UPDATE telegram_bindings SET status = ?, last_error = NULL, last_test_at = COALESCE(last_test_at, ?), updated_at = ? WHERE id = ?")
      .run(nextStatus, nextStatus === "test_passed" ? nowIso() : null, nowIso(), binding.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markBindingFailed(binding.id, msg);
    await telegramApi(poller.token, "sendMessage", {
      chat_id: chatId,
      text: currentUiLocale() === "ko" ? `Agentlas 실행 실패: ${msg}` : `Agentlas run failed: ${msg}`,
    }).catch(() => undefined);
  }
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

function shouldHandleMessage(binding: TelegramBindingRow, message: TelegramMessage, text: string): boolean {
  if (message.chat.type === "private") return true;
  const username = binding.bot_username ? `@${binding.bot_username.toLowerCase()}` : "";
  if (username && text.toLowerCase().includes(username)) return true;
  if (/\bagentlas\b/i.test(text) || /에이전트라스|에이전틀라스/i.test(text)) return true;
  return Boolean(binding.bot_user_id && message.reply_to_message?.from?.id === binding.bot_user_id);
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
  const ko = currentUiLocale() === "ko";
  if (binding.automation_report_enabled === 1) {
    return ko
      ? "자동화 완료 보고가 이 Telegram 방으로 오도록 켜져 있습니다. 끄려면 “자동화 보고 꺼”라고 말하면 됩니다."
      : "Automation completion reports are on for this Telegram chat. Say “turn off automation reports” to stop them.";
  }
  return ko
    ? "자동화 완료 보고는 아직 꺼져 있습니다. “자동화 끝나면 여기에 보고해”라고 말하면 켤 수 있습니다."
    : "Automation completion reports are off. Say “report automation completions here” to turn them on.";
}

function setAutomationReportEnabled(bindingId: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE telegram_bindings SET automation_report_enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nowIso(), bindingId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runBindingInvocation(binding: TelegramBindingRow, message: TelegramMessage, userText: string): Promise<string> {
  const chat = await ensureBindingChat(binding);
  const prompt = [
    `Telegram chat: ${binding.telegram_chat_title || chatTitle(message.chat)} (${message.chat.type})`,
    message.from?.username ? `From: @${message.from.username}` : "",
    "",
    userText,
  ].filter(Boolean).join("\n");
  const result = await runMcpInvocation({
    chatId: chat.id,
    userPrompt: prompt,
    locale: currentUiLocale(),
    permissions: "read",
  }, (_event: McpInvocationEvent) => undefined);
  if (!result.finalText?.trim()) {
    throw new Error(currentUiLocale() === "ko" ? "Agentlas가 보낼 답을 만들지 못했습니다." : "Agentlas did not produce a reply.");
  }
  return result.finalText.trim();
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
    const token = await readSecret(secretKey(row.id));
    if (!token) {
      markBindingFailed(row.id, "Telegram bot secret is missing from Keychain.");
      continue;
    }
    await sendLongMessage(token, row.telegram_chat_id, text);
    sent.add(key);
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
  const title = ko ? `자동화 보고: ${automation.name}` : `Automation report: ${automation.name}`;
  const statusText = status === "ok"
    ? ko ? "완료" : "Completed"
    : status === "skipped"
      ? ko ? "건너뜀" : "Skipped"
      : ko ? "실패" : "Failed";
  const lines = [
    title,
    ko ? `상태: ${statusText}` : `Status: ${statusText}`,
    ko ? `시간: ${when}` : `Time: ${when}`,
  ];
  if (detail?.error) lines.push(ko ? `오류: ${clipForTelegram(detail.error, 800)}` : `Error: ${clipForTelegram(detail.error, 800)}`);
  else if (detail?.output?.trim()) lines.push(ko ? `요약: ${clipForTelegram(detail.output, 1200)}` : `Summary: ${clipForTelegram(detail.output, 1200)}`);
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

async function captureBotFatherToken(targetName: string): Promise<BotFatherCapture> {
  const win = createTelegramWebWindow(
    currentUiLocale() === "ko" ? "Agentlas Telegram 연결" : "Agentlas Telegram Connect",
  );
  await win.loadURL(BOTFATHER_WEB_URL);
  const ready = await waitForBotFatherReady(win, 180_000);
  if (ready.token) {
    return { token: ready.token, source: "existing", window: win };
  }

  const createdToken = await createBotWithBotFather(win, targetName);
  return { token: createdToken, source: "created", window: win };
}

async function waitForBotFatherReady(win: BrowserWindow, timeoutMs: number): Promise<TelegramWebState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertWindowOpen(win);
    const state = await readTelegramWebState(win);
    if (state.token || state.botFatherBlocked || (state.hasComposer && state.hasBotFather)) return state;
    await sleep(1000);
  }
  throw new Error(
    currentUiLocale() === "ko"
      ? "Telegram 로그인이 끝나지 않았습니다. 열린 창에서 로그인한 뒤 다시 시도해주세요."
      : "Telegram login did not finish. Log in in the opened window, then try again.",
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
          hasComposer: visibleEditors.length > 0,
          hasBotFather: /BotFather/i.test(text) || location.href.toLowerCase().includes("botfather"),
          botFatherBlocked: /Only Premium users can message BotFather/i.test(text),
          href: location.href
        };
      })()`,
      true,
    ) as Promise<TelegramWebState>, 2500, null as TelegramWebState | null);
    if (!state) return { token: null, hasComposer: false, hasBotFather: false, botFatherBlocked: false, href: "" };
    return {
      token: typeof state.token === "string" ? state.token : null,
      hasComposer: Boolean(state.hasComposer),
      hasBotFather: Boolean(state.hasBotFather),
      botFatherBlocked: Boolean(state.botFatherBlocked),
      href: typeof state.href === "string" ? state.href : "",
    };
  } catch {
    return { token: null, hasComposer: false, hasBotFather: false, botFatherBlocked: false, href: "" };
  }
}

async function isBotFatherMessagingBlocked(win: BrowserWindow): Promise<boolean> {
  const state = await readTelegramWebState(win);
  return state.botFatherBlocked;
}

function botFatherBlockedMessage(): { ok: boolean; message: string } {
  const ko = currentUiLocale() === "ko";
  return {
    ok: false,
    message: ko
      ? "Telegram이 현재 계정에서 BotFather 메시지를 막고 있습니다. 열린 BotFather 창에서 제한이 풀린 계정으로 로그인하거나 Telegram 데스크톱/모바일에서 직접 설정해야 합니다."
      : "Telegram is blocking BotFather messages for this account. Use the opened BotFather window with an account that can message BotFather, or set it in Telegram Desktop/mobile.",
  };
}

function botFatherManualSettingsMessage(): { ok: boolean; message: string } {
  const ko = currentUiLocale() === "ko";
  return {
    ok: false,
    message: ko
      ? "BotFather 창을 열어두었습니다. 로그인 후 /setprivacy를 보내고 이 봇을 고른 뒤 Disable을 누르면 그룹 전체 메시지 받기가 켜집니다."
      : "BotFather is open. After logging in, send /setprivacy, choose this bot, then press Disable to let it receive group-wide messages.",
  };
}

async function createBotWithBotFather(win: BrowserWindow, targetName: string): Promise<string> {
  const displayName = botDisplayName(targetName);
  await sendTelegramWebMessage(win, "/newbot");
  await sleep(1400);
  await sendTelegramWebMessage(win, displayName);
  await sleep(1400);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sendTelegramWebMessage(win, botUsername());
    const token = await waitForToken(win, 18_000);
    if (token) return token;
    await sleep(800);
  }

  throw new Error(
    currentUiLocale() === "ko"
      ? "BotFather가 새 봇을 만들지 못했습니다. Telegram 창의 안내를 확인해주세요."
      : "BotFather could not create a new bot. Check the Telegram window for its message.",
  );
}

async function waitForToken(win: BrowserWindow, timeoutMs: number): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertWindowOpen(win);
    const state = await readTelegramWebState(win);
    if (state.token) return state.token;
    await sleep(900);
  }
  return null;
}

async function openBotAndSendStart(win: BrowserWindow, botUsername: string, bindingId: string): Promise<TelegramConnectBinding | null> {
  assertWindowOpen(win);
  await win.loadURL(`https://web.telegram.org/k/#@${encodeURIComponent(botUsername)}`);
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
  throw new Error(currentUiLocale() === "ko" ? "Telegram 봇 채팅을 열지 못했습니다." : "Could not open the Telegram bot chat.");
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
  const inserted = await settleWithin(win.webContents.executeJavaScript(
    `(() => {
      const text = ${JSON.stringify(text)};
      const candidates = Array.from(document.querySelectorAll('div[contenteditable="true"], [contenteditable="true"], textarea, input[type="text"]'));
      const visible = candidates.filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 24 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
      });
      const el = visible[visible.length - 1];
      if (!el) return false;
      el.focus();
      if ("value" in el) {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        el.textContent = "";
        document.execCommand("insertText", false, text);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      return true;
    })()`,
    true,
  ) as Promise<boolean>, 3500, false);
  if (!inserted) {
    throw new Error(currentUiLocale() === "ko" ? "Telegram 입력창을 찾지 못했습니다." : "Could not find the Telegram message box.");
  }
  await sleep(250);
  const clicked = await settleWithin(win.webContents.executeJavaScript(
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button, .Button, [role="button"]'));
      const button = buttons.find((el) => /send|보내기/i.test(el.getAttribute("aria-label") || "") || /btn-send|send/i.test(String(el.className || "")));
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
    throw new Error(currentUiLocale() === "ko" ? "Telegram 연결 창이 닫혔습니다." : "Telegram connect window was closed.");
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
