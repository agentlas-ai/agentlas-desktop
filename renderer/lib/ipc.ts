// preload.ts가 contextBridge로 노출한 window.agentlas / window.agentlasEvents 타이핑.
import type {
  ToolApprovalRequestEvent,
  ToolApprovalDecision,
  ToolApprovalResolutionReceipt,
  AgentlasIpc,
  AgentlasUpdaterEvents,
  McpInvocationEvent,
  AskUserRequestEvent,
  BrowserApprovalRequestEvent,
  FsPathGrant,
} from "./types";
import type { SiteActivityEvent } from "@shared/site-studio";
import type { ProductExtensionStatus, ProductExtensionViewStatus, ScienceSuiteInstallProgress } from "@shared/product-extension";
import {
  connectIpcCacheToStoreEvents,
  invalidateIpcCache,
  wrapIpcWithReadCache,
} from "./ipc-cache";
import { writeViewData } from "./view-data-cache";

// 메인의 store/active-chat 방송을 읽기 캐시에 연결한다. HMR·테스트에서 브릿지가
// 교체되면 이전 구독을 해제하고 새 이벤트 객체에 다시 붙인다.
let connectedEventSource: AgentlasEvents | null = null;
let disconnectStoreEvents: (() => void) | null = null;
let disconnectActiveChats: (() => void) | null = null;
function ensureStoreEventsConnected(): void {
  if (typeof window === "undefined") return;
  const events = window.agentlasEvents;
  if (!events) return;
  if (connectedEventSource === events) return;
  disconnectStoreEvents?.();
  disconnectActiveChats?.();
  connectedEventSource = events;
  disconnectStoreEvents = connectIpcCacheToStoreEvents(events.onStoreChanged?.bind(events));
  try {
    disconnectActiveChats = events.onActiveChats((chatIds) => {
      writeViewData("dashboard.active-chats", chatIds);
    });
  } catch {
    disconnectActiveChats = null;
  }
}

interface AgentlasEvents {
  on: (
    channel: string,
    handler: (event: McpInvocationEvent) => void,
  ) => () => void;
  /** 실행 중 chatId 목록 방송 구독 — 사이드바 "실행 중" 인디케이터. unsubscribe 반환. */
  onActiveChats: (handler: (chatIds: string[]) => void) => () => void;
  /** Pairing/device lifecycle notification. Contains no nonce, token, or certificate. */
  onMobileBridgeChanged?: (handler: (event: { reason: string }) => void) => () => void;
  /** Signed product extension lifecycle notification. */
  onProductExtensionChanged?: (handler: (status: ProductExtensionStatus) => void) => () => void;
  onScienceSuiteProgress?: (handler: (progress: ScienceSuiteInstallProgress) => void) => () => void;
  onProductExtensionViewStatus?: (handler: (status: ProductExtensionViewStatus) => void) => () => void;
  /** Browser 승인 요청 구독 — 경량 바텀시트. unsubscribe 반환. */
  onBrowserApproval: (handler: (req: BrowserApprovalRequestEvent) => void) => () => void;
  /** 에이전트의 동기 질문 — 도구가 답을 기다린다(electron/confirm/ask-user.ts). */
  onAskUser: (handler: (req: AskUserRequestEvent) => void) => () => void;
  /**
   * 도구 승인 구독 — live(답을 기다림)와 post-denial(이미 거부됨)을 함께 받는다.
   * 구 preload에는 없어 optional.
   */
  onToolApproval?: (handler: (req: ToolApprovalRequestEvent) => void) => () => void;
  /** Main-confirmed terminal resolution, including decisions made from Mobile/another window. */
  onToolApprovalResolution?: (handler: (receipt: ToolApprovalResolutionReceipt) => void) => () => void;
  /** 스토어 변경 방송({entity, id}) — 읽기 캐시 무효화용. 구 preload에는 없어 optional. */
  onStoreChanged?: (handler: (change: { entity: string; id?: string }) => void) => () => void;
  /** Site Copilot의 사용자용 처리 단계·타이핑 피드백 구독. */
  onSiteActivity: (handler: (event: SiteActivityEvent) => void) => () => void;
}

interface AgentlasFilesBridge {
  chatFiles?: {
    snapshot: (input: unknown) => Promise<unknown>;
    listGroup: (input: unknown) => Promise<unknown>;
    appendMessage?: (input: unknown) => Promise<unknown>;
  };
  /** webUtils가 확인한 드롭 항목에 대해 main이 발급한 세션 권한. */
  grantForFile: (file: File) => Promise<FsPathGrant | null>;
  /** 클립보드에만 존재하는 허용 파일을 main-owned 스테이징 파일로 고정한다. */
  grantForPastedAttachment?: (file: File) => Promise<FsPathGrant | null>;
  /** 디스크 경로가 없는 클립보드 이미지 — main이 내용을 고정하고 같은 권한을 발급한다. */
  grantForPastedImage?: (file: File) => Promise<FsPathGrant | null>;
}

declare global {
  interface Window {
    agentlas: AgentlasIpc;
    agentlasEvents: AgentlasEvents;
    agentlasUpdater: AgentlasUpdaterEvents;
    agentlasFiles?: AgentlasFilesBridge;
  }
}

let cachedBridge: AgentlasIpc | null = null;
let cachedBridgeSource: AgentlasIpc | null = null;

/**
 * Renderer 어디서나 호출. SSR 시점에는 window가 없으므로 client-only.
 * 안전하게 typeof check.
 *
 * 반환값은 읽기 캐시 프록시(ipc-cache.ts)로 감싼다 — 화이트리스트 읽기 메서드에
 * 한해 in-flight dedup + 짧은 TTL을 적용해, 재방문 화면이 스피너 대신 방금 본
 * 데이터를 즉시 그린다. 그 외 메서드는 그대로 통과한다.
 */
export function ipc(): AgentlasIpc | null {
  if (typeof window === "undefined") return null;
  // Surface-specific components own their own failure UX. A Work IPC failure
  // must never be converted into a hidden One turn or One decision request.
  const raw = window.agentlas ?? null;
  if (!raw) return null;
  if (!cachedBridge || cachedBridgeSource !== raw) {
    // preload/HMR/test bridge identity가 바뀌면 이전 브릿지의 결과와 in-flight 요청을
    // 새 브릿지에 넘기지 않는다. 메서드 프록시도 target별로 분리된다.
    if (cachedBridgeSource && cachedBridgeSource !== raw) invalidateIpcCache();
    cachedBridgeSource = raw;
    cachedBridge = wrapIpcWithReadCache(raw);
    ensureStoreEventsConnected();
  }
  return cachedBridge;
}

export function ipcEvents(): AgentlasEvents | null {
  if (typeof window === "undefined") return null;
  return window.agentlasEvents ?? null;
}

export function updaterEvents(): AgentlasUpdaterEvents | null {
  if (typeof window === "undefined") return null;
  return window.agentlasUpdater ?? null;
}

/** 드롭된 File에 대한 exact-file/폴더 권한을 얻는다. */
export async function grantForDroppedFile(file: File): Promise<FsPathGrant | null> {
  if (typeof window === "undefined") return null;
  return window.agentlasFiles?.grantForFile(file) ?? null;
}

/**
 * 클립보드에서 붙여넣은 이미지에 대한 exact-file 권한. 붙여넣기 이미지는 디스크에
 * 없어서 드롭용 경로 권한을 받을 수 없다 — main이 내용을 비공개 파일로 고정한 뒤
 * 드롭과 동일 등급의 capability를 발급한다.
 */
export async function grantForPastedImage(file: File): Promise<FsPathGrant | null> {
  if (typeof window === "undefined") return null;
  const bridge = window.agentlasFiles;
  if (!bridge?.grantForPastedImage) return null;
  return bridge.grantForPastedImage(file) ?? null;
}

/** 이미지·오디오·비디오·안전 문서 클립보드 파일의 exact-file 권한. */
export async function grantForPastedAttachment(file: File): Promise<FsPathGrant | null> {
  if (typeof window === "undefined") return null;
  const bridge = window.agentlasFiles;
  if (!bridge?.grantForPastedAttachment) return null;
  return bridge.grantForPastedAttachment(file) ?? null;
}
