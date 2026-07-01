// 그래프 라이브 실행 브로드캐스트(설계 §5 P2) — run-graph.ts의 per-node 상태 이벤트를
// 열린 모든 렌더러 창으로 방송한다. 채널명은 automation id로 스코프해 플로우 페이지가
// 자기 자동화의 실행만 구독하게 한다(agentlasEvents.on 화이트리스트 확장).
//
// 스케줄러/트리거/Run now 어느 경로로 그래프가 돌든 같은 채널을 쓴다 — 캔버스는 앱이 켜져
// 있는 한 백그라운드 실행도 실시간으로 그린다.
import { BrowserWindow } from "electron";
import type { McpInvocationEvent } from "../../shared/types";

/** 자동화별 라이브 실행 채널명. preload 화이트리스트와 렌더러 helper가 이 접두사를 공유. */
export function liveRunChannel(automationId: string): string {
  return `automations:liveRun:${automationId}`;
}

/** run-graph.ts의 sink가 낸 이벤트를 해당 자동화 채널로 방송. 창이 없으면 no-op. */
export function broadcastLiveRun(automationId: string, ev: McpInvocationEvent): void {
  const channel = liveRunChannel(automationId);
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(channel, ev);
    } catch {
      /* 창이 닫히는 중이면 무시 */
    }
  }
}
