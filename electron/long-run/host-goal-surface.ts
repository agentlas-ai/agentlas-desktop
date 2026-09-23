/**
 * Surfaces whose ongoing Goals run the host-observed episode loop: verified-cycle
 * progress accounting, stall detection → replan/backoff wakes, quota-cooldown
 * runtime handoff at a wake, and the replan accounting anchor.
 *
 * ★Owner (2026-09-23): "지금 만든 장기작업과 메모리 등등 플러그인 툴 라우팅도 다 워크도 되야한다."
 * These checks were `surface === "one"`, so a Work ongoing Goal that stopped
 * making progress was hard-blocked with `stall_window_exhausted` while the same
 * Goal in One got a replan. Work and One share the invocation path, the
 * verifier checkpoint and the wait ledger; nothing in the loop reads a One-only
 * field. Science stays out: its Goals are owned by the Science execution owner.
 */
export function ownsHostGoalLoop(surface: string | null | undefined): boolean {
  return surface === "one" || surface === "work";
}
