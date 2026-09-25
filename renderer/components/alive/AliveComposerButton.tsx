"use client";
/*
 * AGI(Alive 에이전트) 작성창 단추 + 작은 팝오버 — One·Work 두 작성창이 같은 조각을 쓴다.
 *
 * 오너 사양(2026-09-24, 2026-09-25 개정):
 *   - 단추는 작성창 안의 "+" 단추와 같은 모양(호스트가 그 클래스·스타일을 그대로 넘긴다).
 *     켜짐은 조용하게 — 작은 살아 있는 점 하나, 상태(도는 중·대기·쉬는 중·토큰 소진)에 따라 색만 바뀐다.
 *   - 팝오버는 작성창의 다른 떠 있는 메뉴(One 모델·추론·"+" 메뉴)와 같은 **메뉴**다(오너 2026-09-25:
 *     "토큰한도 플로팅 디자인이 쓰레기 — 미니멀하게, 코덱스 플로팅·one 드롭다운·+ 메뉴 참고").
 *     상자 칩·프리셋 알약 줄·진행 막대를 걷어 내고 행(row)만 쓴다: 머리 행(AGI + 스위치, 범위 한 줄) ·
 *     조용한 알림 행(글자 동작 하나) · 모델 순서(작은 글자 사슬 ›) · "토큰 한도  1.2M / 5M ›"(하위 목록) ·
 *     "대시보드에서 순서 바꾸기 ›". 치수·색·그림자는 OneShell.module.css 의 composerPopover* 값과 같다.
 *   - 한도는 켜기 전에도 정한다 — 고른 값은 켜질 때 적용된다(host alive_pending_grants).
 *   - Work 는 프로젝트당 Alive 하나: 다른 대화에서 돌고 있으면 "…에서 실행 중" + "여기로 옮기기".
 *
 * 브리지 계약(ipc().alive)은 Main/preload 쪽에서 따로 착지한다. 없으면(구 preload) 단추를 그리지 않는다.
 *
 * 참고한 것:
 *   - Apple HIG Popovers: 한 번에 하나, 트리거 가까이, 바깥을 누르면 닫힘, 내용만큼만 크게.
 *   - WAI-ARIA APG Switch: role=switch + aria-checked, Space/Enter 로 토글.
 *   - 작성창의 기존 메뉴(OneComposerControls ComposerRow): 22px 아이콘 칸 · 12px 제목 · 10px 보조 줄 · 8px 모서리 행 ·
 *     1px paper-3 구분선 · 선택은 체크 표시. 새 모양을 만들지 않고 그 문법을 따른다.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconArrowLeft, IconCheck, IconChevronRight, IconEdit, IconLayers, IconRoute, IconTarget } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { AgentlasIpc } from "@shared/types";
import {
  ALIVE_DEFAULT_TOKEN_LIMIT,
  ALIVE_MAX_TOKEN_LIMIT,
  type AliveModelOrderItem,
  type AliveState,
  type AliveStatus,
  type AliveSurface,
} from "@shared/alive";
import { navigate } from "@/lib/navigation";
import styles from "./AliveComposerButton.module.css";

type AliveApi = AgentlasIpc["alive"];

/** 브리지 기능 감지 — 구 preload 에는 alive 가 없다. 없으면 단추를 그리지 않는다. */
function aliveApi(): AliveApi | null {
  const alive = (ipc() as { alive?: Partial<AliveApi> } | null)?.alive;
  if (!alive || typeof alive.getState !== "function" || typeof alive.setEnabled !== "function" || typeof alive.setTokenLimit !== "function") return null;
  return alive as AliveApi;
}

const TOKEN_PRESETS: Array<number | null> = [ALIVE_DEFAULT_TOKEN_LIMIT, 2_000_000, 10_000_000, null];

/** "한도 올리기" — 지금 쓴 양보다 큰 다음 프리셋, 없으면 두 배. */
function raisedLimit(limit: number | null, used: number): number | null {
  const floor = Math.max(limit ?? 0, used);
  const next = TOKEN_PRESETS.find((preset): preset is number => typeof preset === "number" && preset > floor);
  return Math.min(ALIVE_MAX_TOKEN_LIMIT, next ?? Math.max(floor * 2, ALIVE_DEFAULT_TOKEN_LIMIT));
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function errorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.match(/\[agentlas:code=([A-Za-z0-9._-]+)\]/)?.[1] ?? null;
}

function statusLabel(status: AliveStatus, ko: boolean): string {
  switch (status) {
    case "running": return ko ? "실행 중" : "Running";
    case "waiting": return ko ? "대기 중" : "Waiting";
    case "resting": return ko ? "쉬는 중" : "Resting";
    case "tokens-spent": return ko ? "토큰 한도 도달" : "Token limit reached";
    case "usage-unknown": return ko ? "사용량 확인 불가" : "Usage unknown";
    case "blocked": return ko ? "멈춤" : "Blocked";
    default: return ko ? "꺼짐" : "Off";
  }
}

function errorMessage(code: string | null, ko: boolean): string {
  if (code === "alive-goal-required") return ko ? "먼저 목표를 시작하세요." : "Start a goal first.";
  if (code === "alive-project-conflict") return ko ? "이 프로젝트의 다른 대화에서 이미 실행 중입니다." : "Already running in another chat of this project.";
  if (code === "alive-sign-in-required") return ko ? "Alive Agent를 쓰려면 Agentlas 계정으로 로그인하세요." : "Sign in to your Agentlas account to use Alive Agent.";
  if (code === "alive-plan-required") return ko ? "현재 요금제에서는 Alive Agent를 사용할 수 없습니다. 요금제를 확인하세요." : "Alive Agent is unavailable on your current plan. Review your plan.";
  if (code === "alive-entitlement-unavailable") return ko ? "Alive Agent 사용 권한을 확인할 수 없습니다. 연결 상태를 확인하고 다시 시도하세요." : "Could not verify Alive Agent access. Check your connection and try again.";
  return ko ? "바꾸지 못했습니다. 잠시 후 다시 시도하세요." : "Couldn't update. Try again in a moment.";
}

type Props = {
  surface: AliveSurface;
  chatId: string | null;
  locale: "ko" | "en";
  /** 작성창 "+" 단추의 클래스 — 같은 모양을 쓰기 위해 그대로 받는다. */
  triggerClassName?: string;
  triggerStyle?: CSSProperties | ((open: boolean) => CSSProperties);
  disabled?: boolean;
};

export function AliveComposerButton({ surface, chatId, locale, triggerClassName, triggerStyle, disabled }: Props) {
  const ko = locale === "ko";
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<AliveState | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftLimit, setDraftLimit] = useState("");
  /** 팝오버 안의 화면 — 본 메뉴, 또는 토큰 한도 하위 목록(다른 선택기의 하위 메뉴처럼 제자리에서 바뀐다). */
  const [view, setView] = useState<"main" | "limit">("main");
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 12, bottom: 120, width: 300, maxHeight: 420 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLElement | null>(null);
  const switchRef = useRef<HTMLButtonElement | null>(null);
  const limitRowRef = useRef<HTMLButtonElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const popoverId = useId().replace(/:/g, "");
  const chatRef = useRef(chatId);
  chatRef.current = chatId;

  const refresh = useCallback(async () => {
    const api = aliveApi();
    if (!api) { setSupported(false); return; }
    setSupported(true);
    const requested = chatRef.current;
    if (!requested) { setState(null); return; }
    try {
      const next = await api.getState({ surface, chatId: requested });
      if (chatRef.current !== requested) return;
      setState(next);
    } catch {
      if (chatRef.current === requested) setState(null);
    }
  }, [surface]);

  useEffect(() => {
    setState(null);
    setError(null);
    setOpen(false);
    void refresh();
  }, [refresh, chatId]);

  /*
   * 다시 읽는 때: alive:changed(켜기·한도·옮기기) + 목표·대화 변경(실측 2026-09-25: One 목표를 끝내도
   * alive:changed 가 오지 않아 단추가 "대기 중"에 남았다) + 화면 복귀 + 켜져 있을 때 30초 박동.
   * 목표·대화 변경은 몰려 오므로 한 번으로 묶는다.
   */
  useEffect(() => {
    const events = ipcEvents();
    let timer: number | null = null;
    const soon = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void refresh(); }, 400);
    };
    const offAlive = events?.onAliveChanged?.((event) => {
      if (!event || event.surface === surface) void refresh();
    });
    const offStore = events?.onStoreChanged?.((change) => {
      if (["chat", "long-run", "task"].includes(change.entity)) soon();
    });
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      offAlive?.();
      offStore?.();
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refresh, surface]);
  const enabledNow = Boolean(state?.enabled);
  useEffect(() => {
    if (!enabledNow) return;
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => window.clearInterval(poll);
  }, [enabledNow, refresh]);
  useEffect(() => setPortalHost(document.body), []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    setError(null);
    setDraftLimit("");
    setView("main");
  }, [open, refresh]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  // 바깥 누르기·Esc 로 닫는다. Esc 는 트리거로 초점을 돌려준다.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      // 하위 목록에서는 한 단계만 뒤로 — 다른 메뉴의 하위 메뉴와 같다.
      if (viewRef.current === "limit") {
        setView("main");
        window.requestAnimationFrame(() => limitRowRef.current?.focus({ preventScroll: true }));
        return;
      }
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open || !portalHost) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      // 다른 작성창 메뉴처럼 작성창 위에 뜬다(작성창을 덮지 않는다). 작성창을 못 찾으면 단추 위.
      const composer = trigger.closest<HTMLElement>('[data-one-composer="true"], .chat-input-shell');
      const anchor = composer?.getBoundingClientRect();
      const anchorTop = anchor ? anchor.top : r.top;
      const anchorLeft = anchor ? anchor.left : r.left - 8;
      const margin = window.innerWidth <= 700 ? 10 : 16;
      const width = Math.min(300, window.innerWidth - margin * 2);
      const left = Math.min(Math.max(margin, anchorLeft), Math.max(margin, window.innerWidth - margin - width));
      const bottom = Math.max(margin, window.innerHeight - anchorTop + 8);
      const maxHeight = Math.max(160, anchorTop - margin - 8);
      setPosition({ left, bottom, width, maxHeight });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, portalHost]);

  useEffect(() => {
    if (!open) return;
    // 스위치가 막혀 있으면(목표 없음·다른 대화에서 실행 중) 팝오버 안의 첫 조작 요소로 — 초점이 body 로 떨어지지 않게.
    const frame = window.requestAnimationFrame(() => {
      const target = switchRef.current && !switchRef.current.disabled
        ? switchRef.current
        : popoverRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? popoverRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || view !== "limit") return;
    const frame = window.requestAnimationFrame(() => {
      const pop = popoverRef.current;
      const target = pop?.querySelector<HTMLElement>('[data-alive-preset][aria-pressed="true"]')
        ?? pop?.querySelector<HTMLElement>("[data-alive-preset]");
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, view]);

  if (!supported || !chatId || !state || !state.available) return null;
  const activeChatId = chatId;

  const status: AliveStatus = state.enabled ? state.status : "off";
  const conflict = surface === "work" ? state.conflict : undefined;
  const blockedByGoal = state.needsGoal && !state.enabled;
  // 순서는 오케스트레이터 멤버 → 워커 멤버. "지금" 표시는 사슬 순서상 첫 current 하나만 —
  // 백엔드가 둘 이상을 current 로 보내면(계약 위반) 첫 것만 강조하고 나머지는 무시한다.
  const ordered = [
    ...state.modelOrder.filter((entry) => entry.role === "orchestrator"),
    ...state.modelOrder.filter((entry) => entry.role === "worker"),
  ];
  const currentIndex = ordered.findIndex((entry) => entry.current);
  const limit = state.budget.tokenLimit;
  const used = Math.max(0, state.budget.tokensUsed || 0);

  async function run(action: (api: AliveApi) => Promise<AliveState>) {
    const api = aliveApi();
    if (!api || pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await action(api);
      setState(next);
    } catch (cause) {
      setError(errorMessage(errorCode(cause), ko));
      void refresh();
    } finally {
      setPending(false);
    }
  }

  const toggle = () => {
    if (blockedByGoal || (conflict && !state.enabled)) return;
    void run((api) => api.setEnabled({ surface, chatId: activeChatId, enabled: !state.enabled }));
  };
  const moveHere = () => void run((api) => api.setEnabled({ surface, chatId: activeChatId, enabled: true, moveFrom: true }));
  /*
   * 한도를 정하는 호출은 "usage-unknown"(도중에 죽은 깨어남은 사용량을 영영 못 잰다)의 출구이기도 하다 —
   * 같은 값이라도 다시 보내면 그 깨어남을 인정하고 이어 간다. 그래서 그 상태에선 같은 값도 보낸다.
   */
  const setLimit = (tokenLimit: number | null) => {
    if (tokenLimit === limit && status !== "usage-unknown") return;
    void run((api) => api.setTokenLimit({ surface, chatId: activeChatId, tokenLimit }));
  };
  const regrant = () => void run((api) => api.setTokenLimit({ surface, chatId: activeChatId, tokenLimit: limit ?? ALIVE_DEFAULT_TOKEN_LIMIT }));
  const commitDraft = () => {
    const raw = draftLimit.trim();
    if (!raw) return;
    const millions = Number(raw.replace(",", "."));
    if (!Number.isFinite(millions) || millions <= 0) { setDraftLimit(""); return; }
    setDraftLimit("");
    setLimit(Math.min(ALIVE_MAX_TOKEN_LIMIT, Math.round(millions * 1_000_000)));
  };
  const openDashboard = () => {
    close(false);
    navigate("/dashboard#runtime-roles");
  };

  /*
   * 한도는 켜기 전에도 정할 수 있다(1.2.43 E2E: 끈 상태에서 프리셋을 누르면 "Turn AGI on first" 거절).
   * 설정을 먼저 고르고 스위치로 시작하는 흐름 — 비활성 단추는 이유를 말해 주지 못한다(Smashing Magazine
   * "Usability Pitfalls of Disabled Buttons", 2021). 고른 값은 이 대화의 스위치가 만들 삶에 저장돼 켤 때 적용된다.
   * 삶이 붙을 곳 자체가 없을 때(One 대화에 목표 없음)만 스위치와 같은 이유로 함께 막는다 — 그 이유는 알림 행이 말한다.
   */
  const limitDisabled = pending || !state.scope;
  const triggerLabel = `AGI · ${statusLabel(status, ko)}`;
  const switchDisabled = pending || blockedByGoal || Boolean(conflict && !state.enabled)
    || Boolean(state.accessReasonCode && !state.enabled);
  const limitText = limit ? compactTokens(limit) : (ko ? "무제한" : "No limit");
  // 쓴 양이 있거나 켜져 있을 때만 "쓴 양 / 한도" — 아니면 한도 하나만(조용한 글자).
  const usageText = state.enabled || used > 0 ? `${compactTokens(used)} / ${limitText}` : limitText;
  const raiseTo = raisedLimit(limit, used);
  const customSelected = typeof limit === "number" && !TOKEN_PRESETS.includes(limit);

  const roleName = (role: "orchestrator" | "worker") => role === "orchestrator"
    ? (ko ? "오케스트레이터" : "Orchestrator")
    : (ko ? "워커" : "Worker");

  /*
   * 조용한 알림 행 — 한 줄 글 + 글자 동작 하나. 칸 배경·경고 상자 없음(다른 메뉴 행과 같은 결).
   * 상태를 말하는 점만 아이콘 칸에 둔다.
   */
  type Notice = { key: string; tone: "warn" | "info"; text: ReactNode; action?: { label: string; onClick: () => void; attr: Record<string, string>; disabled?: boolean } };
  const notices: Notice[] = [];
  if (blockedByGoal) {
    notices.push({ key: "needs-goal", tone: "info", text: surface === "one"
      ? (ko ? "먼저 목표를 시작하면 켤 수 있습니다." : "Start a goal first to turn this on.")
      : (ko ? "이 대화에 목표가 있어야 켤 수 있습니다." : "This chat needs a goal before it can run.") });
  }
  if (state.accessReasonCode) {
    notices.push({ key: "plan-access", tone: "info", text: errorMessage(state.accessReasonCode, ko) });
  }
  if (state.enabled && state.needsGoal) {
    notices.push({ key: "goal-ended", tone: "info", text: surface === "one"
      ? (ko ? "목표가 끝나 쉬는 중. 새 목표를 시작하면 이어 갑니다." : "Paused: the goal ended. Start a new goal to continue.")
      : (ko ? "목표가 없어 기다리는 중. 목표가 생기면 이어 갑니다." : "Waiting: this chat has no goal. It continues once there is one.") });
  }
  if (conflict) {
    notices.push({
      key: "conflict",
      tone: "info",
      text: <>{ko ? "실행 중: " : "Running in "}<strong title={conflict.title}>{conflict.title}</strong></>,
      action: { label: ko ? "여기로 옮기기" : "Move here", onClick: moveHere, attr: { "data-alive-move": "true" }, disabled: pending || Boolean(state.accessReasonCode) },
    });
  }
  if (state.enabled && status === "usage-unknown") {
    notices.push({
      key: "usage-unknown",
      tone: "warn",
      text: ko ? "끊긴 실행의 사용량을 잴 수 없습니다." : "An interrupted run's usage can't be measured.",
      action: { label: ko ? "다시 허용" : "Re-grant", onClick: regrant, attr: { "data-alive-regrant": "true" }, disabled: pending },
    });
  }
  if (state.enabled && status === "tokens-spent") {
    notices.push({
      key: "tokens-spent",
      tone: "warn",
      text: ko ? `${limitText} 한도를 다 썼습니다.` : `${limitText} limit used up.`,
      action: {
        label: ko ? `${compactTokens(raiseTo ?? 0)}까지 올리기` : `Raise to ${compactTokens(raiseTo ?? 0)}`,
        onClick: () => setLimit(raiseTo),
        attr: { "data-alive-raise": "true" },
        disabled: pending,
      },
    });
  }

  const renderNotice = (notice: Notice) => (
    <div key={notice.key} className={styles.notice} data-alive-notice={notice.key} data-alive-hint={notice.key} role={notice.tone === "warn" ? "status" : undefined}>
      <span className={styles.icon} aria-hidden="true"><span className={styles.noticeDot} data-tone={notice.tone} /></span>
      <span className={styles.noticeText}>{notice.text}</span>
      {notice.action ? (
        <button type="button" className={styles.textAction} onClick={notice.action.onClick} disabled={notice.action.disabled} {...notice.action.attr}>
          {notice.action.label}
        </button>
      ) : null}
    </div>
  );

  /*
   * 모델 순서 — 한 줄로 이어지는 작은 글자 사슬(칩 상자 없음). Alive 는 한 번에 한 모델로만 돈다.
   * 순서는 오케스트레이터 멤버 다음 워커 멤버로 이어지는 하나의 예비 순서. 역할은 툴팁·낭독용 글로만 남긴다.
   */
  const renderChain = () => (
    <ol className={styles.chain} aria-label={ko ? "모델 예비 순서" : "Model fallback order"} data-alive-chain="true">
      {ordered.length === 0 ? (
        <li className={styles.chainEmpty}>{ko ? "대시보드에 모델 순서가 없습니다" : "No model order in the dashboard"}</li>
      ) : ordered.map((entry, index) => {
        const isCurrent = index === currentIndex;
        return (
          <li key={`${entry.role}:${entry.runtimeId}:${entry.model}:${index}`} className={styles.chainItem} data-alive-role={entry.role}>
            {index > 0 && <span className={styles.chainArrow} aria-hidden="true">›</span>}
            <span
              className={styles.model}
              data-alive-model="true"
              data-current={isCurrent ? "true" : undefined}
              data-exhausted={entry.exhausted ? "true" : undefined}
              title={`${roleName(entry.role)} · ${entry.label}${isCurrent ? (ko ? " · 지금 사용 중" : " · in use now") : ""}${entry.exhausted ? (ko ? " · 한도 소진" : " · exhausted") : ""}`}
            >
              <span className={styles.srOnly}>{roleName(entry.role)}: </span>
              {entry.label}
              <span className={styles.srOnly}>
                {isCurrent ? (ko ? " (지금 사용 중)" : " (in use now)") : ""}
                {entry.exhausted ? (ko ? " (한도 소진)" : " (exhausted)") : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );

  const scopeLine = state.scope
    ? `${state.scope.kind === "one-goal" ? (ko ? "목표" : "Goal") : (ko ? "프로젝트" : "Project")} · ${state.scope.label}`
    : null;

  const mainView = (
    <div className={styles.list}>
      <button
        ref={switchRef}
        type="button"
        role="switch"
        aria-checked={state.enabled}
        aria-label={ko ? "AGI 켜기" : "Turn on AGI"}
        aria-describedby={`${popoverId}-status`}
        className={`${styles.row} ${styles.switchRow}`}
        data-on={state.enabled ? "true" : "false"}
        disabled={switchDisabled}
        onClick={toggle}
        data-alive-switch="true"
      >
        <span className={styles.icon} aria-hidden="true"><span className={styles.statusDot} data-alive-status={status} /></span>
        <span className={styles.copy}>
          <span className={styles.titleLine}>
            <strong>AGI</strong>
            <span id={`${popoverId}-status`} className={styles.statusText} data-alive-status={status}>{statusLabel(status, ko)}</span>
          </span>
          {scopeLine && <small className={styles.scope} title={state.scope?.label} data-alive-scope="true">{scopeLine}</small>}
        </span>
        <span className={styles.toggle} data-on={state.enabled ? "true" : "false"} aria-hidden="true"><span /></span>
      </button>

      {notices.map(renderNotice)}

      <div className={styles.divider} />

      <div className={`${styles.row} ${styles.staticRow}`} data-alive-order-row="true">
        <span className={styles.icon} aria-hidden="true"><IconRoute size={15} /></span>
        <span className={styles.copy}>
          <strong>{ko ? "모델 순서" : "Model order"}</strong>
          {renderChain()}
        </span>
      </div>

      <button
        ref={limitRowRef}
        type="button"
        className={styles.row}
        data-alive-limit-row="true"
        aria-haspopup="true"
        aria-expanded={false}
        disabled={limitDisabled}
        onClick={() => setView("limit")}
      >
        <span className={styles.icon} aria-hidden="true"><IconTarget size={15} /></span>
        <span className={styles.copy}>
          <strong>{ko ? "토큰 한도" : "Token limit"}</strong>
          {state.tokenLimitAppliesOnEnable && state.scope && (
            <small data-alive-hint="limit-on-enable">{ko ? "켜면 이 한도로 시작합니다" : "AGI starts with this limit"}</small>
          )}
        </span>
        <span className={styles.trailing}>
          <span className={styles.value} data-alive-limit-value="true">{usageText}</span>
          <IconChevronRight size={13} />
        </span>
      </button>

      <div className={styles.divider} />

      <button type="button" className={styles.row} onClick={openDashboard} data-alive-dashboard="true">
        <span className={styles.icon} aria-hidden="true"><IconLayers size={15} /></span>
        <span className={styles.copy}><strong>{ko ? "대시보드에서 순서 바꾸기" : "Change order in dashboard"}</strong></span>
        <span className={styles.trailing}><IconChevronRight size={13} /></span>
      </button>

      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );

  const backToMain = () => {
    setView("main");
    window.requestAnimationFrame(() => limitRowRef.current?.focus({ preventScroll: true }));
  };

  const limitView = (
    <div className={styles.list} data-alive-limit-menu="true">
      <div className={styles.subHead}>
        <button type="button" className={styles.back} onClick={backToMain} aria-label={ko ? "뒤로" : "Back"} data-alive-back="true">
          <IconArrowLeft size={14} />
        </button>
        <strong id={`${popoverId}-limit`}>{ko ? "토큰 한도" : "Token limit"}</strong>
        <span className={styles.value}>{usageText}</span>
      </div>
      <div className={styles.divider} />
      <div role="group" aria-labelledby={`${popoverId}-limit`} className={styles.options}>
        {TOKEN_PRESETS.map((preset) => {
          const selected = limit === preset;
          return (
            <button
              key={preset ?? "none"}
              type="button"
              className={styles.row}
              aria-pressed={selected}
              data-selected={selected ? "true" : undefined}
              disabled={limitDisabled}
              data-alive-preset={preset ?? "none"}
              onClick={() => { setLimit(preset); backToMain(); }}
            >
              <span className={styles.icon} aria-hidden="true" />
              <span className={styles.copy}><strong>{preset === null ? (ko ? "무제한" : "No limit") : compactTokens(preset)}</strong></span>
              <span className={styles.trailing}>{selected ? <IconCheck size={14} /> : null}</span>
            </button>
          );
        })}
        <label className={`${styles.row} ${styles.customRow}`} data-selected={customSelected ? "true" : undefined}>
          <span className={styles.icon} aria-hidden="true"><IconEdit size={14} /></span>
          <span className={styles.copy}><strong>{ko ? "직접 입력" : "Custom"}</strong></span>
          <span className={styles.customField}>
            <input
              type="number"
              inputMode="decimal"
              min={0.1}
              step={0.5}
              value={draftLimit}
              placeholder={customSelected && limit ? String(Number((limit / 1_000_000).toFixed(2))) : "3"}
              aria-label={ko ? "직접 입력 (백만 토큰)" : "Custom (million tokens)"}
              onChange={(event) => setDraftLimit(event.target.value)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); commitDraft(); backToMain(); }
              }}
              disabled={limitDisabled}
              data-alive-custom="true"
            />
            <span aria-hidden="true">M</span>
          </span>
        </label>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );

  const popover = open ? (
    <section
      ref={popoverRef}
      id={popoverId}
      className={styles.popover}
      role="dialog"
      aria-label={ko ? "AGI 설정" : "AGI settings"}
      data-alive-popover={surface}
      data-alive-view={view}
      style={{
        "--alive-left": `${position.left}px`,
        "--alive-bottom": `${position.bottom}px`,
        "--alive-width": `${position.width}px`,
        "--alive-max-height": `${position.maxHeight}px`,
      } as CSSProperties}
    >
      {view === "limit" ? limitView : mainView}
    </section>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName ?? ""} ${styles.trigger}`.trim()}
        style={typeof triggerStyle === "function" ? triggerStyle(open) : triggerStyle}
        data-alive-trigger={surface}
        data-alive-status={status}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={triggerLabel}
        title={triggerLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.triggerText} aria-hidden="true">AGI</span>
        {status !== "off" && <span className={styles.triggerDot} data-alive-status={status} aria-hidden="true" />}
      </button>
      {popover && portalHost ? createPortal(popover, portalHost) : null}
    </>
  );
}
