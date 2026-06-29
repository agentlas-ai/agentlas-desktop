// CLI 런타임 세션 매핑 — chat × backend(kind)별로 CLI 세션 id를 보관한다.
// 세션 resume를 지원하는 러너(Claude Code/Codex)가 두 번째 턴부터 시스템 프롬프트/히스토리를
// 재전송하지 않고 이어가도록 한다. fingerprint가 달라지면(시스템 프롬프트/모델 변경)
// 기존 세션을 버리고 새로 시작한다.
import { getDb } from "./db";

export interface RuntimeSession {
  sessionId: string;
  fingerprint: string;
}

export function getRuntimeSession(chatId: string, kind: string): RuntimeSession | null {
  try {
    const row = getDb()
      .prepare(
        "SELECT session_id, fingerprint FROM chat_runtime_sessions WHERE chat_id = ? AND kind = ?",
      )
      .get(chatId, kind) as { session_id: string; fingerprint: string } | undefined;
    return row ? { sessionId: row.session_id, fingerprint: row.fingerprint } : null;
  } catch {
    // 테이블 없음(구버전 DB) 등 — 세션 미사용으로 폴백.
    return null;
  }
}

export function saveRuntimeSession(
  chatId: string,
  kind: string,
  sessionId: string,
  fingerprint: string,
): void {
  try {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO chat_runtime_sessions(chat_id, kind, session_id, fingerprint, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chatId, kind, sessionId, fingerprint, new Date().toISOString());
  } catch {
    // DB 오류 시 무시 — 세션 저장 실패해도 다음 턴은 full-context로 동작한다.
  }
}

export function clearRuntimeSession(chatId: string, kind: string): void {
  try {
    getDb()
      .prepare("DELETE FROM chat_runtime_sessions WHERE chat_id = ? AND kind = ?")
      .run(chatId, kind);
  } catch {
    // 무시
  }
}
