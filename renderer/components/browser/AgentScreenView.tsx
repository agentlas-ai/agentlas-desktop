"use client";

/**
 * 에이전트가 보고 있는 화면 — 한 벌의 구현.
 *
 * 예전에는 이 화면이 Work 의 떠 있는 카드(FloatingComputerUsePanel)에만 있었다. One 은
 * 같은 것을 결과 레일 **안에** 그리는데 Work 는 레일이 열리지도 않아, 브라우저 도구가 돌면
 * 화면이 창 한가운데 떠 있는 카드로만 나왔다(2026-09-03 실측: 레일 없음, 카드 430×311 at 772,473).
 * 사용자는 띄워 달라고만 했는데 매번 떠다닌다고 보고했다.
 *
 * 그래서 캡처 루프와 캔버스를 여기로 꺼냈다. 레일과 떠 있는 카드가 **같은 코드**를 쓴다 —
 * 두 벌로 갈리면 한쪽만 고쳐지는 자리가 다시 생긴다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { BrowserLiveFrame, ComputerUsePreview } from "@/lib/types";

export type AgentScreenMode = "browser" | "computer";

export interface AgentScreenState {
  mode: AgentScreenMode;
  image: string | undefined;
  ready: boolean | undefined;
  label: string;
  browserFrame: BrowserLiveFrame | null;
  computerFrame: ComputerUsePreview | null;
  sourceId: string | undefined;
  setSourceId: (id: string | undefined) => void;
  focusBusy: boolean;
  focusNotice: string | null;
  focusPreview: () => Promise<void>;
}

/**
 * 화면 캡처 루프. `enabled` 가 false 면 한 장도 잡지 않는다 — 캡처는 렌더러 타이머 중
 * 가장 비싸서, 보이지 않는 자리에서 돌면 그대로 낭비다.
 */
export function useAgentScreen(mode: AgentScreenMode, enabled: boolean, ko: boolean): AgentScreenState {
  const api = ipc();
  const [browserFrame, setBrowserFrame] = useState<BrowserLiveFrame | null>(null);
  const [computerFrame, setComputerFrame] = useState<ComputerUsePreview | null>(null);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusNotice, setFocusNotice] = useState<string | null>(null);
  const busy = useRef(false);

  const capture = useCallback(async () => {
    if (!api || busy.current || document.visibilityState !== "visible") return;
    busy.current = true;
    try {
      if (mode === "browser") {
        const next = await api.browser.captureLiveFrame();
        // 순간적인 CDP 딸꾹질(바쁜 소켓, 이동 중, 느린 스크린샷)에 화면을 비우지 않는다.
        // 매 실패마다 "대기 중"으로 깜빡이면 멀쩡한 프레임 사이가 갈라진다.
        // 화면이 안 변했으면(같은 dataUrl) 이전 참조를 유지한다 — 멀티 MB 문자열 교체와
        // 이미지 재디코드를 틱마다 반복하지 않는다.
        setBrowserFrame((prev) => {
          if (!next.dataUrl && prev?.dataUrl) return prev;
          if (prev && prev.dataUrl === next.dataUrl && prev.title === next.title && prev.url === next.url) return prev;
          return next;
        });
      } else {
        const next = await api.computerUse.capturePreview(sourceId);
        setComputerFrame((prev) => {
          if (!next.dataUrl && prev?.dataUrl) return prev;
          if (prev && prev.dataUrl === next.dataUrl) return prev;
          return next;
        });
        if (!sourceId && next.selectedSourceId) setSourceId(next.selectedSourceId);
      }
    } catch {
      // 개발 중 리로드로 preload 가 낡아도 작업 화면이 죽으면 안 된다.
    } finally {
      busy.current = false;
    }
  }, [api, mode, sourceId]);

  useEffect(() => {
    if (!enabled) return;
    void capture();
    const tick = () => { if (document.visibilityState !== "hidden") void capture(); };
    const timer = window.setInterval(tick, mode === "browser" ? 1_300 : 1_900);
    const onVisible = () => { if (document.visibilityState !== "hidden") void capture(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [capture, enabled, mode]);

  const focusPreview = useCallback(async () => {
    if (!api || focusBusy) return;
    setFocusBusy(true);
    setFocusNotice(null);
    try {
      const receipt = mode === "browser"
        ? await api.browser.focusLiveTarget(browserFrame?.targetId ?? undefined)
        : await api.computerUse.revealPreview();
      setFocusNotice(receipt.ok
        ? mode === "browser"
          ? ko ? "브라우저 화면을 앞으로 가져왔습니다." : "Browser brought to the front."
          : ko ? "컴퓨터 화면을 열었습니다." : "Computer view opened."
        : mode === "browser"
          ? ko ? "열 수 있는 브라우저 화면이 없습니다." : "No browser target is available to open."
          : ko ? "컴퓨터 화면을 열지 못했습니다. 화면 기록 권한을 확인해 주세요." : "The computer view could not be opened. Check Screen Recording permission.");
    } catch {
      setFocusNotice(mode === "browser"
        ? ko ? "브라우저 화면을 열지 못했습니다. 다시 시도해 주세요." : "The browser view could not be opened. Try again."
        : ko ? "컴퓨터 화면을 열지 못했습니다. 다시 시도해 주세요." : "The computer view could not be opened. Try again.");
    } finally {
      setFocusBusy(false);
    }
  }, [api, browserFrame?.targetId, focusBusy, ko, mode]);

  const image = (mode === "browser" ? browserFrame?.dataUrl : computerFrame?.dataUrl) ?? undefined;
  const ready = (mode === "browser" ? browserFrame?.available : computerFrame?.observationAvailable) ?? undefined;
  const label = (mode === "browser"
    ? browserFrame?.title || (ko ? "브라우저 화면" : "Browser view")
    : computerFrame?.sources.find((source) => source.id === computerFrame.selectedSourceId)?.name
      || (ko ? "컴퓨터 화면" : "Computer view")) || (ko ? "화면" : "Screen");

  return {
    mode, image, ready, label, browserFrame, computerFrame,
    sourceId, setSourceId, focusBusy, focusNotice, focusPreview,
  };
}

/** 화면 그림 한 장 + 아직 없을 때의 안내. 누르면 그 화면을 앞으로 가져온다. */
export function AgentScreenCanvas({ screen, ko }: { screen: AgentScreenState; ko: boolean }) {
  const { image, mode, focusBusy, focusPreview } = screen;
  return (
    <button
      type="button"
      className="cua-canvas"
      onClick={() => void focusPreview()}
      disabled={focusBusy}
      aria-busy={focusBusy}
      data-agent-screen-canvas="true"
      aria-label={mode === "browser"
        ? ko ? "브라우저 화면 앞으로 가져오기" : "Bring browser to front"
        : ko ? "컴퓨터 화면 열기" : "Show computer screen"}
    >
      {image ? (
        // Main 은 로컬에서 만든 이미지 data URL 만 돌려준다.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt={ko ? "에이전트가 보는 화면" : "Screen visible to the agent"} />
      ) : (
        <div className="cua-empty">
          <span className="cua-empty-screen" aria-hidden="true" />
          <strong>{ko ? "화면 연결 대기 중" : "Waiting for screen"}</strong>
          <span>
            {mode === "browser"
              ? ko ? "브라우저 도구가 시작되면 자동으로 표시됩니다." : "It appears automatically when a browser tool starts."
              : ko ? "Agentlas의 화면 기록 권한을 확인해 주세요." : "Check Agentlas Screen Recording permission."}
          </span>
        </div>
      )}
    </button>
  );
}

/** 컴퓨터 화면일 때의 권한·소스 줄. 브라우저 모드에서는 그리지 않는다. */
export function AgentScreenFooter({ screen, ko }: { screen: AgentScreenState; ko: boolean }) {
  const { mode, computerFrame, sourceId, setSourceId } = screen;
  if (mode !== "computer" || !computerFrame) return null;
  return (
    <footer>
      {computerFrame.sources.length > 1 && (
        <select value={sourceId ?? ""} onChange={(event) => setSourceId(event.target.value || undefined)}>
          {computerFrame.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
      )}
      <span className={computerFrame.screenPermission === "granted" ? "ok" : "warn"}>
        {ko ? "화면" : "Screen"} {computerFrame.screenPermission === "granted" ? "ON" : "OFF"}
      </span>
      <span className={computerFrame.accessibility ? "ok" : "warn"}>
        {ko ? "조작 권한" : "Control"} {computerFrame.accessibility ? "ON" : "OFF"}
      </span>
      {!computerFrame.interactionAvailable && (
        <span className="native">{ko ? "네이티브 입력 드라이버 필요" : "Native input driver required"}</span>
      )}
    </footer>
  );
}
