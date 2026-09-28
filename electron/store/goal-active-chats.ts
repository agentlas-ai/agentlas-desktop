/*
 * 목표가 아직 살아 있는 대화 — One 사이드바 "실행 중" 혜성의 두 번째 근거.
 *
 * 코디네이터 결정 2026-09-27(오너 요청 "지금 돌아가고 있는 건" 안에서): 턴과 턴 사이에서
 * 다음 이어가기 실행을 기다리는 활성 목표도 "도는 중"이다. 실행 중(invoke:activeChats)과는
 * 따로 센다 — activeChatIds 는 "지금 턴이 돈다(chat-busy)" 라는 실행 권한 판단에 쓰이므로
 * 거기에 섞으면 안 된다.
 *
 * 도는 것으로 치는 장기 실행 상태: 대기열·실행·작업자 대기·다음 실행 대기(waiting_tool)·검증·호스트 일시정지.
 * 오너를 기다리는 상태(waiting_user·blocked·오너/승인/예산 paused·pausing)와 끝난 상태는 치지 않는다.
 * 이 목록이 바뀌는 순간은 long_runs 의 모든 상태 전이가 이미 내는
 * store:changed {entity:"long-run"} 방송으로 화면이 안다(새 폴링 없음).
 *
 * 오너 정정 2026-09-28 ("명시적 멈춤이 멈춤 아니냐"): 다음 예약·이어가기 실행을 기다리는 waiting_tool 과, 앱이 스스로
 * 멈춘 호스트 일시정지(app_closed·crash_recovery·runtime_unavailable·agent_paused)도 작동 중이다 — 골 칩과 같은 규칙
 * (shared/goal-display-state.ts). 오너 일시정지·승인·예산·막힘·질문은 여전히 돌지 않는다.
 */
import { getDb } from "./db";
import { GOAL_HOST_PAUSE_REASONS, GOAL_SPINNING_STATUSES } from "../../shared/goal-display-state";
import { automationLiveChatIds } from "./automation-chat-activity";

export function goalActiveChatIds(): string[] {
  const hostPauses = [...GOAL_HOST_PAUSE_REASONS];
  const rows = getDb().prepare(
    `SELECT c.id AS id FROM chats c JOIN long_runs lr ON lr.goal_id = c.goal_id
     WHERE c.goal_id IS NOT NULL AND c.archived_at IS NULL
       AND (lr.status IN (${GOAL_SPINNING_STATUSES.map(() => "?").join(",")})
         OR (lr.status = 'paused' AND lr.pause_reason IN (${hostPauses.map(() => "?").join(",")})))`,
  ).all(...GOAL_SPINNING_STATUSES, ...hostPauses) as Array<{ id: string }>;
  // 오너 2026-09-28 (Thread Marketing): 이 대화의 자동화가 숨은 세션에서 지금 도는 중이면 이 대화도 돈다.
  // 바뀌는 순간은 store:changed {entity:"automation"} 가 알린다(실행 시작·리스 해제·종료 기록).
  let automationChats: string[] = [];
  try { automationChats = automationLiveChatIds(); } catch { automationChats = []; }
  return [...new Set([...rows.map((row) => row.id), ...automationChats])];
}
