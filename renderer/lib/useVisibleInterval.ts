// 탭이 보일 때만 도는 폴링 훅 — 숨김(hidden) 동안 setInterval을 멈춰 백그라운드 폴링 폭풍을 막는다.
// 시맨틱: visible이면 주기적으로 fn() 실행, hidden이면 정지, visible 복귀 시 즉시 1회 실행 후 재시작.
// 초기 load는 호출부가 따로 하므로(중복 실행 방지) 마운트 시점엔 tick하지 않고 start만 한다.
"use client";
import { useEffect, useRef } from "react";

export function useVisibleInterval(
  fn: () => void,
  ms: number,
  opts?: { immediate?: boolean },
): void {
  // fn을 ref로 최신화해 stale closure를 막는다(deps는 [ms]만 두기 위함).
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // immediate도 ref로 잡아 deps에서 제외(주기/리스너 재설치를 ms 변경에만 묶는다).
  const immediateRef = useRef(opts?.immediate);
  immediateRef.current = opts?.immediate;

  useEffect(() => {
    if (typeof document === "undefined") return;

    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      stop();
      timer = window.setInterval(() => fnRef.current(), ms);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // 숨김: 타이머 정지(틱 폭주 차단).
        stop();
      } else {
        // 복귀: immediate가 false가 아니면 즉시 1회 실행 후 재시작.
        if (immediateRef.current !== false) fnRef.current();
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    // 마운트 시 visible이면 start만(초기 load는 호출부 담당 → 여기서 tick하지 않음).
    if (document.visibilityState !== "hidden") start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [ms]);
}
