// 작성창 하단 툴바를 한 줄로 지킨다 — 넘치면 칩 글자를 우선순위대로 접어 아이콘만 남긴다.
//
// 오너 2026-10-23: 우측 패널로 대화 열이 좁아지면 "Running sonnet · Next request …" 칩이 뭉개지다 못해 중지·마이크·
// 보내기가 둘째 줄로 떨어졌다("이런 디테일 주의 — 무조건 한 줄, 알아서 다 아이콘으로"). 폭 문턱(@container)은 칩이 몇 개
// 켜져 있는지, 모델 이름이 얼마나 긴지 모른다. 그래서 문턱 대신 실제로 넘치는지를 재서 한 단계씩 접는다.
//
// 이 파일은 "언제 몇 단계로 접는가" 만 안다. 단계마다 무엇을 접는지는 CSS 한 곳(globals.css 의 [data-fit="n"] 규칙)에 있다.
// 호스트 판단만 한다 — 모델에 들어가는 글은 아니다.
import { useLayoutEffect, type RefObject } from "react";

/** 0 = 전부 글자. 숫자가 클수록 더 접는다. 마지막 단계(MAX)가 어떤 폭에서도 한 줄을 지키는 보루다. */
export const TOOLBAR_FIT_MAX_LEVEL = 7;

/**
 * 단계를 CSS 가 "n 단계 이상" 으로 읽게 속성에 단어로 적는다: 3 단계 = data-fit="1 2 3" → [data-fit~="3"] 는 3 단계 이상.
 * 숫자만 필요한 곳(검사·진단)은 data-fit-level 을 읽는다.
 */
export function applyToolbarFitLevel(toolbar: HTMLElement, level: number): void {
  toolbar.dataset.fit = Array.from({ length: level }, (_, index) => String(index + 1)).join(" ");
  toolbar.dataset.fitLevel = String(level);
}

/**
 * 한 줄에 다 들어가는가. 줄바꿈을 막아 두었으니 넘치면 스크롤 폭이 보이는 폭을 넘는다.
 * 칩 묶음이 따로 넘칠 수 있어(왼쪽 묶음이 오른쪽 묶음 자리로 파고든다) [data-fit-box] 표시가 있는 상자도 함께 잰다.
 */
export function toolbarOverflows(toolbar: HTMLElement): boolean {
  if (toolbar.scrollWidth > toolbar.clientWidth + 1) return true;
  const boxes = toolbar.querySelectorAll<HTMLElement>("[data-fit-box]");
  for (let i = 0; i < boxes.length; i += 1) {
    if (boxes[i].scrollWidth > boxes[i].clientWidth + 1) return true;
  }
  return false;
}

/**
 * 가장 덜 접은 단계부터 올라가며 처음으로 한 줄에 들어가는 단계를 고른다.
 * 같은 동작 안에서 속성만 바꿔 재므로 그리기 전에 끝난다(깜빡임 없음). 어디서도 안 맞으면 마지막 단계에 머문다.
 */
export function fitToolbarLevel(toolbar: HTMLElement, maxLevel: number = TOOLBAR_FIT_MAX_LEVEL): number {
  for (let level = 0; level <= maxLevel; level += 1) {
    applyToolbarFitLevel(toolbar, level);
    if (!toolbarOverflows(toolbar)) return level;
  }
  applyToolbarFitLevel(toolbar, maxLevel);
  return maxLevel;
}

/**
 * 폭이 바뀔 때(창·우측 패널·사이드바), 칩이 생기거나 사라지거나 글이 바뀔 때(모델 이름·실행 중 표시·권한), 글꼴이
 * 늦게 올 때 다시 맞춘다. 칩의 글은 DOM 에서 바뀌므로 MutationObserver 가 잡고, 우리가 쓰는 data-fit 속성은 관찰하지 않는다.
 */
export function useToolbarFit(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!toolbar) return undefined;
    let disposed = false;
    let lastWidth = -1;
    const fit = () => { if (!disposed) fitToolbarLevel(toolbar); };
    fit();
    // 단계가 바뀌면 높이만 달라질 수 있다 — 폭이 그대로면 다시 재지 않아 관찰 고리가 돌지 않는다.
    const resize = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
        const width = toolbar.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        fit();
      })
      : null;
    resize?.observe(toolbar);
    const mutate = typeof MutationObserver === "function" ? new MutationObserver(fit) : null;
    mutate?.observe(toolbar, { childList: true, subtree: true, characterData: true });
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    void fonts?.ready.then(fit).catch(() => undefined);
    return () => {
      disposed = true;
      resize?.disconnect();
      mutate?.disconnect();
    };
  }, [ref]);
}
