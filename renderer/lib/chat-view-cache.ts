// 채팅 뷰 스냅샷 캐시 — 채팅 전환 시 이전 채팅의 렌더 상태(메시지·에이전트 패널·타임라인)를
// 모듈 레벨에 보관했다가, 되돌아오면 히스토리 로드/attach 왕복을 기다리지 않고 즉시 복원한다.
// (기존에는 전환마다 setMessages([])로 화면을 전부 헐어 빈 화면 플래시 + 재조립 지연이 생겼다.)
// busy/streaming 라이브 드래프트는 저장하지 않는다 — 재진입 시 attach가 main 버퍼에서
// 라이브 버블을 재구성하므로, 여기 남기면 중복 버블이 된다.
import type { StreamMessage } from "@/components/ChatStream";
import type { LiveAgent, NetTimelineItem } from "@/components/AgentNetworkPanel";

export interface ChatViewSnapshot {
  messages: StreamMessage[];
  liveAgents: Record<string, LiveAgent>;
  netTimeline: NetTimelineItem[];
}

const MAX_ENTRIES = 12; // LRU 상한 — 대형 세션 다수를 무한 보관하지 않는다.
const cache = new Map<string, ChatViewSnapshot>();

export function saveChatViewSnapshot(chatId: string, snap: ChatViewSnapshot): void {
  const cleaned: ChatViewSnapshot = {
    messages: snap.messages.filter((m) => !m.busy && !m.streaming),
    liveAgents: snap.liveAgents,
    netTimeline: snap.netTimeline,
  };
  cache.delete(chatId); // 재삽입으로 LRU 순서 갱신
  cache.set(chatId, cleaned);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function readChatViewSnapshot(chatId: string): ChatViewSnapshot | null {
  const hit = cache.get(chatId);
  if (!hit) return null;
  cache.delete(chatId);
  cache.set(chatId, hit); // LRU touch
  return hit;
}

/** 히스토리 삭제/채팅 삭제 시 무효화. */
export function dropChatViewSnapshot(chatId: string): void {
  cache.delete(chatId);
}
