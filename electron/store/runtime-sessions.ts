// CLI 런타임 세션 매핑 — chat × backend(kind) × 점유자(agentId)별로 CLI 세션 id를 보관한다.
// 세션 resume를 지원하는 러너(Claude Code/Codex)가 두 번째 턴부터 시스템 프롬프트/히스토리를
// 재전송하지 않고 이어가도록 한다. fingerprint는 호출 표면이 정한 안정 세션 정체성이고,
// 정체성이 달라질 때만 기존 세션을 버리고 새로 시작한다.
//
// ★ agentId 가 키에 들어간 이유(SEAT-SESSION-PLAN-v2 I5, v103): 점유자 교체 후 두 봇이
// 같은 (chatId, kind) 행을 서로 덮어써 이전 봇의 세션이 사라졌다. 오폭(다른 봇 세션 재사용)
// 자체는 지문 시드의 agentId 가 이미 막고 있었지만, 행이 덮이는 유실은 키만이 막는다.
// 구버전 행은 agentId='' 레거시 키로 남아 있고, 정확한 키에 행이 없을 때만 지문 검증을
// 전제로 승계 대상으로 읽힌다(지문이 다르면 러너가 스스로 새 세션을 시작한다).
//
// updatedAt은 "이 세션이 대화를 어디까지 봤는가"의 워터마크다. 러너는 resume 시
// updatedAt 이후에 쌓인 채팅 메시지(스웜/Ollama 등 다른 경로의 턴)를 gap-replay하고,
// 호출자는 assistant 메시지 저장 후 touchRuntimeSession으로 워터마크를 전진시킨다.
//
// 인메모리 폴백: DB 쓰기/읽기가 어떤 이유로든 실패해도(테이블 없음·잠김·디스크 오류)
// 프로세스가 살아 있는 동안 세션 연속성이 끊기지 않는다. 디스크는 앱 재시작 간 연속성,
// 메모리는 "어떤 버그가 있어도" 턴 간 연속성을 책임진다. 같은 프로세스에서는 save가
// 항상 메모리를 먼저 갱신하므로 메모리가 DB 이상으로 최신이다 — get은 메모리를 우선한다.
import { getDb } from "./db";

export interface RuntimeSession {
  sessionId: string;
  fingerprint: string;
  /** 이 세션이 채팅 히스토리를 마지막으로 반영한 시각(ISO). 구버전 행/폴백은 null. */
  updatedAt: string | null;
  /** Codex resume 스트림이 마지막으로 보고한 누적 output token 수. */
  reportedOutputTokens: number | null;
  /** 같은 스트림이 보고한 누적 input token 수(캐시 읽기 포함한 전체). */
  reportedInputTokens: number | null;
  /** 그중 캐시에서 읽은 몫의 누적치 — 입력의 부분집합이라 합산하지 않는다. */
  reportedCachedInputTokens: number | null;
}

const memSessions = new Map<string, RuntimeSession>();
const memKey = (chatId: string, kind: string, agentId: string): string => `${chatId}\0${kind}\0${agentId}`;
const normalizeAgentId = (agentId?: string | null): string => agentId ?? "";

type SessionRow = {
  session_id: string;
  fingerprint: string;
  updated_at: string | null;
  reported_output_tokens?: number | null;
  reported_input_tokens?: number | null;
  reported_cached_input_tokens?: number | null;
};

function toSession(row: SessionRow): RuntimeSession {
  return {
    sessionId: row.session_id,
    fingerprint: row.fingerprint,
    updatedAt: row.updated_at ?? null,
    reportedOutputTokens: Number.isInteger(row.reported_output_tokens) ? row.reported_output_tokens! : null,
    reportedInputTokens: Number.isInteger(row.reported_input_tokens) ? row.reported_input_tokens! : null,
    reportedCachedInputTokens: Number.isInteger(row.reported_cached_input_tokens) ? row.reported_cached_input_tokens! : null,
  };
}

export function getRuntimeSession(
  chatId: string,
  kind: string,
  agentId?: string | null,
  options?: { isolateOwner?: boolean },
): RuntimeSession | null {
  const agent = normalizeAgentId(agentId);
  const mem = memSessions.get(memKey(chatId, kind, agent)) ?? null;
  if (mem) return mem;
  try {
    const select = getDb().prepare(
      "SELECT session_id, fingerprint, updated_at, reported_output_tokens, reported_input_tokens, reported_cached_input_tokens FROM chat_runtime_sessions WHERE chat_id = ? AND kind = ? AND agent_id = ?",
    );
    let row = select.get(chatId, kind, agent) as SessionRow | undefined;
    // v103 이전 행은 agent_id='' 로 이관돼 있다. 정확한 키에 행이 없으면 레거시 행을
    // 승계 후보로 읽는다 — 다른 봇의 세션이면 러너의 지문 검증이 스스로 버린다.
    if (!row && agent !== "" && options?.isolateOwner !== true) {
      row = select.get(chatId, kind, "") as SessionRow | undefined;
    }
    if (!row) return null;
    const resolved = toSession(row);
    // 첫 DB 읽기도 메모리에 승격한다. 이후 DB가 잠기거나 일시 실패해도 같은
    // 프로세스의 다음 턴은 이미 확인한 세션을 잃지 않는다.
    memSessions.set(memKey(chatId, kind, agent), resolved);
    return resolved;
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
  options?: {
    reportedOutputTokens?: number | null;
    reportedInputTokens?: number | null;
    reportedCachedInputTokens?: number | null;
    agentId?: string | null;
    /** Internal task-stage slots never inherit or delete the visible chat's legacy session row. */
    isolateOwner?: boolean;
  },
): boolean {
  const agent = normalizeAgentId(options?.agentId);
  const now = new Date().toISOString();
  const previous = memSessions.get(memKey(chatId, kind, agent)) ?? null;
  const sameSession = previous?.sessionId === sessionId && previous.fingerprint === fingerprint;
  const carry = (
    next: number | null | undefined,
    kept: number | null | undefined,
  ): number | null => next ?? (sameSession ? kept ?? null : null);
  const reportedOutputTokens = carry(options?.reportedOutputTokens, previous?.reportedOutputTokens);
  const reportedInputTokens = carry(options?.reportedInputTokens, previous?.reportedInputTokens);
  const reportedCachedInputTokens = carry(options?.reportedCachedInputTokens, previous?.reportedCachedInputTokens);
  // 메모리 먼저 — DB가 실패해도 이 프로세스 안에서는 세션이 절대 유실되지 않는다.
  memSessions.set(memKey(chatId, kind, agent), {
    sessionId,
    fingerprint,
    updatedAt: now,
    reportedOutputTokens,
    reportedInputTokens,
    reportedCachedInputTokens,
  });
  try {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO chat_runtime_sessions(chat_id, kind, agent_id, session_id, fingerprint, updated_at, reported_output_tokens, reported_input_tokens, reported_cached_input_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatId, kind, agent, sessionId, fingerprint, now, reportedOutputTokens, reportedInputTokens, reportedCachedInputTokens);
    // 레거시 행을 승계했다면 이제 새 키가 정본이다 — 같은 세션을 가리키는 '' 행을
    // 정리해 다음 점유자가 이 봇의 세션을 승계 후보로 오인하지 않게 한다.
    if (agent !== "" && options?.isolateOwner !== true) {
      getDb()
        .prepare("DELETE FROM chat_runtime_sessions WHERE chat_id = ? AND kind = ? AND agent_id = '' AND session_id = ?")
        .run(chatId, kind, sessionId);
    }
    return true;
  } catch {
    // false = 디스크 영속화 실패(재시작 시 유실 가능) — 호출자가 lifecycle receipt를 남긴다.
    // 인메모리 폴백 덕에 진행 중인 대화의 연속성은 유지된다.
    return false;
  }
}

/**
 * 세션 워터마크 전진 — 이 kind의 세션이 방금 저장된 assistant 메시지까지 봤다고 표시한다.
 * assistant 메시지를 채팅에 append한 "뒤에" 호출해야 다음 resume 턴이 자기 자신의 직전
 * 답변을 gap으로 오인해 재주입하지 않는다.
 */
export function touchRuntimeSession(chatId: string, kind: string, agentId?: string | null): void {
  const agent = normalizeAgentId(agentId);
  const now = new Date().toISOString();
  const mem = memSessions.get(memKey(chatId, kind, agent));
  if (mem) mem.updatedAt = now;
  try {
    // 레거시 '' 행도 함께 전진시킨다 — 승계 직후 아직 새 키로 저장되기 전의 턴이
    // 자기 답변을 gap으로 오인하지 않게 한다.
    getDb()
      .prepare("UPDATE chat_runtime_sessions SET updated_at = ? WHERE chat_id = ? AND kind = ? AND agent_id IN (?, '')")
      .run(now, chatId, kind, agent);
  } catch {
    // 무시 — 인메모리 워터마크가 프로세스 내 연속성을 지킨다.
  }
}

export function clearRuntimeSession(
  chatId: string,
  kind: string,
  agentId?: string | null,
  options?: { isolateOwner?: boolean },
): void {
  const agent = normalizeAgentId(agentId);
  memSessions.delete(memKey(chatId, kind, agent));
  try {
    // 정확한 키와 레거시 '' 행을 함께 지운다 — "이 chat×kind 세션을 버려라"는 의도다.
    if (options?.isolateOwner === true) {
      getDb()
        .prepare("DELETE FROM chat_runtime_sessions WHERE chat_id = ? AND kind = ? AND agent_id = ?")
        .run(chatId, kind, agent);
    } else {
      getDb()
        .prepare("DELETE FROM chat_runtime_sessions WHERE chat_id = ? AND kind = ? AND agent_id IN (?, '')")
        .run(chatId, kind, agent);
    }
  } catch {
    // 무시
  }
}

/**
 * SQLite transaction이 모든 provider 세션을 지운 뒤 인메모리 resume 포인터도
 * 같은 경계로 폐기한다. DB transaction 전에 호출하면 이후 단계 실패 시 메모리만
 * 사라지는 부분 성공이 되므로, 호출자는 반드시 commit 성공 뒤에 실행해야 한다.
 */
export function evictRuntimeSessionsForChat(chatId: string): void {
  const prefix = `${chatId}\0`;
  for (const key of memSessions.keys()) {
    if (key.startsWith(prefix)) memSessions.delete(key);
  }
}
