/*
 * 목표가 아직 살아 있는 대화 — One 사이드바 "실행 중" 혜성의 두 번째 근거.
 *
 * 코디네이터 결정 2026-09-27(오너 요청 "지금 돌아가고 있는 건" 안에서): 턴과 턴 사이에서
 * 다음 이어가기 실행을 기다리는 활성 목표도 "도는 중"이다. 실행 중(invoke:activeChats)과는
 * 따로 센다 — activeChatIds 는 "지금 턴이 돈다(chat-busy)" 라는 실행 권한 판단에 쓰이므로
 * 거기에 섞으면 안 된다.
 *
 * 도는 것으로 치는 장기 실행 상태: 대기열·실행·작업자 대기·검증. 오너를 기다리는 상태
 * (waiting_user·waiting_tool·blocked·paused·pausing)와 끝난 상태는 치지 않는다.
 * 이 목록이 바뀌는 순간은 long_runs 의 모든 상태 전이가 이미 내는
 * store:changed {entity:"long-run"} 방송으로 화면이 안다(새 폴링 없음).
 */
import { getDb } from "./db";

const SPINNING_GOAL_STATUSES = ["queued", "running", "waiting_worker", "verifying"] as const;

export function goalActiveChatIds(): string[] {
  const rows = getDb().prepare(
    `SELECT c.id AS id FROM chats c JOIN long_runs lr ON lr.goal_id = c.goal_id
     WHERE c.goal_id IS NOT NULL AND c.archived_at IS NULL
       AND lr.status IN (${SPINNING_GOAL_STATUSES.map(() => "?").join(",")})`,
  ).all(...SPINNING_GOAL_STATUSES) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
