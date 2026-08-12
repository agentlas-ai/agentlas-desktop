import { createHash } from "node:crypto";
import { registrableTelegramCommands } from "./commands-catalog";
import type { TelegramBindingRow } from "./connect";

/**
 * 텔레그램 명령 메뉴 등록.
 *
 * 이게 있어야 사용자가 `/` 를 쳤을 때 목록이 뜨고 **방향키로 고를 수 있다**.
 * Bot API 가 주는 유일한 키보드 탐색 메뉴다(인라인 버튼은 탭/클릭 전용).
 *
 * 언어는 앱 로케일이 아니라 **사용자 클라이언트 언어**가 정한다: ko 목록을
 * language_code="ko" 로, 영어 목록을 기본(무지정)으로 올려 두면 텔레그램이 고른다.
 * 답장 언어가 메시지 언어를 따르는 기존 규칙과 같은 철학이다.
 */
export interface TelegramCommandSyncApi {
  call: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
}

type BotCommand = { command: string; description: string };

/** 이미 같은 목록을 올린 바인딩은 건너뛴다. 카탈로그가 바뀌면 digest 가 바뀌어 다시 올린다. */
const syncedDigests = new Map<string, string>();

function commandsFor(row: TelegramBindingRow, locale: "ko" | "en"): BotCommand[] {
  return registrableTelegramCommands(row.target_kind).map((entry) => ({
    command: entry.name,
    // BotCommand.description 은 1–256자. 카탈로그 게이트가 길이를 이미 잠근다.
    description: locale === "ko" ? entry.ko : entry.en,
  }));
}

function scopesFor(row: TelegramBindingRow): Array<Record<string, unknown> | null> {
  // 기본 스코프는 항상 등록한다. 페어링 전 첫 접촉에서도 메뉴가 있어야 하고,
  // 페어링 이후에도 클라이언트가 방 스코프를 못 받은 상황(캐시·다른 기기)에서
  // 기댈 곳이 남는다. 실측: 페어링이 첫 동기화보다 먼저 끝나면 방 스코프만
  // 등록돼 기본 스코프가 영영 비어 있었다.
  const scopes: Array<Record<string, unknown> | null> = [null];
  if (row.telegram_chat_id) {
    scopes.push({ type: "chat", chat_id: row.telegram_chat_id });
  }
  return scopes;
}

/**
 * 실패해도 치명적이지 않다 — 타이핑 디스패치는 등록과 무관하게 동작한다.
 * 그래서 바인딩을 failed 로 만들지 않고 경고만 남긴다.
 */
export async function syncTelegramBotCommands(
  api: TelegramCommandSyncApi,
  row: TelegramBindingRow,
): Promise<void> {
  const ko = commandsFor(row, "ko");
  const en = commandsFor(row, "en");
  const scopes = scopesFor(row);
  const digest = createHash("sha256")
    .update(JSON.stringify({ ko, en, scopes }))
    .digest("hex");
  if (syncedDigests.get(row.id) === digest) return;
  try {
    for (const scope of scopes) {
      const base = scope ? { scope } : {};
      await api.call("setMyCommands", { ...base, commands: en });
      await api.call("setMyCommands", { ...base, commands: ko, language_code: "ko" });
    }
    syncedDigests.set(row.id, digest);
  } catch (error) {
    console.warn(
      `[telegram] command menu registration failed for binding ${row.id}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function forgetTelegramCommandSync(bindingId: string): void {
  syncedDigests.delete(bindingId);
}

/** 게이트가 검사하는 등록 목록. setMyCommands 로 실제 나가는 배열과 같은 함수를 쓴다. */
export function registrationPayloadForTest(row: TelegramBindingRow): { ko: BotCommand[]; en: BotCommand[] } {
  return { ko: commandsFor(row, "ko"), en: commandsFor(row, "en") };
}
