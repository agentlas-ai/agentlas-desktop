"use client";
/*
 * AGI(Alive 에이전트) 작성창 단추 + 작은 팝오버 — One·Work 두 작성창이 같은 조각을 쓴다.
 *
 * 오너 사양(2026-09-24):
 *   - 단추는 작성창 안의 "+" 단추와 같은 모양(호스트가 그 클래스·스타일을 그대로 넘긴다).
 *     켜짐은 조용하게 — 작은 살아 있는 점 하나, 상태(도는 중·대기·쉬는 중·토큰 소진)에 따라 색만 바뀐다.
 *   - 팝오버: 켜기/끄기 스위치 · 모델 순서(작성창 모델 선택기가 아니라 대시보드의 오케스트레이터→워커
 *     순서를 쓴다 — 글이 아니라 칩 사슬로) · 토큰 한도(프리셋+입력, 사용/한도 얇은 막대) ·
 *     "대시보드로 이동"(검은 바탕 흰 글자 단추 금지 — 조용한 글자 단추).
 *   - Work 는 프로젝트당 Alive 하나: 다른 대화에서 돌고 있으면 "…에서 실행 중" + "여기로 옮기기".
 *
 * 브리지 계약(ipc().alive)은 Main/preload 쪽에서 따로 착지한다. 없으면(구 preload) 단추를 그리지 않는다.
 *
 * 참고한 것:
 *   - Apple HIG Popovers: 한 번에 하나, 트리거 가까이, 바깥을 누르면 닫힘, 내용만큼만 크게.
 *   - WAI-ARIA APG Switch: role=switch + aria-checked, Space/Enter 로 토글.
 *   - GitHub Actions 시각화 그래프: 상태 색 아이콘이 붙은 작업 칩을 선으로 이어 순서를 보여 준다 → 예비 순서 사슬.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconBrain, IconUsers } from "@/components/Icon";
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
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 12, bottom: 120, width: 300, maxHeight: 420 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLElement | null>(null);
  const switchRef = useRef<HTMLButtonElement | null>(null);
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

  useEffect(() => {
    const off = ipcEvents()?.onAliveChanged?.((event) => {
      if (!event || event.surface === surface) void refresh();
    });
    return () => off?.();
  }, [refresh, surface]);
  useEffect(() => setPortalHost(document.body), []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    setError(null);
    setDraftLimit("");
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
      const margin = window.innerWidth <= 700 ? 10 : 16;
      const width = Math.min(312, window.innerWidth - margin * 2);
      const left = Math.min(Math.max(margin, r.left - 8), Math.max(margin, window.innerWidth - margin - width));
      const bottom = Math.max(margin, window.innerHeight - r.top + 8);
      const maxHeight = Math.max(160, r.top - margin - 8);
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

  if (!supported || !chatId || !state || !state.available) return null;
  const activeChatId = chatId;

  const status: AliveStatus = state.enabled ? state.status : "off";
  const conflict = surface === "work" ? state.conflict : undefined;
  const blockedByGoal = state.needsGoal && !state.enabled;
  const orchestrators = state.modelOrder.filter((entry) => entry.role === "orchestrator");
  const workers = state.modelOrder.filter((entry) => entry.role === "worker");
  const limit = state.budget.tokenLimit;
  const used = Math.max(0, state.budget.tokensUsed || 0);
  const ratio = limit && limit > 0 ? Math.min(1, used / limit) : 0;

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

  const triggerLabel = `AGI · ${statusLabel(status, ko)}`;
  const switchDisabled = pending || blockedByGoal || Boolean(conflict && !state.enabled);

  const chain = (entries: AliveModelOrderItem[], role: "orchestrator" | "worker") => (
    <div className={styles.lane} data-alive-lane={role}>
      <span className={styles.laneTag} title={role === "orchestrator" ? (ko ? "오케스트레이터" : "Orchestrator") : (ko ? "워커" : "Worker")}>
        {role === "orchestrator" ? <IconBrain size={13} aria-hidden="true" /> : <IconUsers size={13} aria-hidden="true" />}
        <span className={styles.srOnly}>{role === "orchestrator" ? (ko ? "오케스트레이터" : "Orchestrator") : (ko ? "워커" : "Worker")}</span>
      </span>
      <ol className={styles.chain} aria-label={role === "orchestrator" ? (ko ? "오케스트레이터 예비 순서" : "Orchestrator fallback order") : (ko ? "워커 예비 순서" : "Worker fallback order")}>
        {entries.length === 0 ? (
          <li className={styles.chainEmpty}>{ko ? "설정 없음" : "Not set"}</li>
        ) : entries.map((entry, index) => (
          <li key={`${entry.runtimeId}:${entry.model}:${index}`} className={styles.chainItem}>
            {index > 0 && <span className={styles.chainArrow} aria-hidden="true">›</span>}
            <span
              className={styles.modelChip}
              data-current={entry.current ? "true" : undefined}
              data-exhausted={entry.exhausted ? "true" : undefined}
              title={`${entry.label}${entry.current ? (ko ? " · 지금 사용 중" : " · in use now") : ""}${entry.exhausted ? (ko ? " · 한도 소진" : " · exhausted") : ""}`}
            >
              {entry.current && <span className={styles.modelDot} aria-hidden="true" />}
              <span className={styles.modelName}>{entry.label}</span>
              <span className={styles.srOnly}>
                {entry.current ? (ko ? " (지금 사용 중)" : " (in use now)") : ""}
                {entry.exhausted ? (ko ? " (한도 소진)" : " (exhausted)") : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>
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
      style={{
        "--alive-left": `${position.left}px`,
        "--alive-bottom": `${position.bottom}px`,
        "--alive-width": `${position.width}px`,
        "--alive-max-height": `${position.maxHeight}px`,
      } as CSSProperties}
    >
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <strong>AGI</strong>
          <span className={styles.statusText} data-alive-status={status}>
            <span className={styles.statusDot} data-alive-status={status} aria-hidden="true" />
            {statusLabel(status, ko)}
          </span>
        </span>
        <button
          ref={switchRef}
          type="button"
          role="switch"
          aria-checked={state.enabled}
          aria-label={ko ? "AGI 켜기" : "Turn on AGI"}
          className={styles.switch}
          data-on={state.enabled ? "true" : "false"}
          disabled={switchDisabled}
          onClick={toggle}
          data-alive-switch="true"
        >
          <span />
        </button>
      </header>

      {state.scope && (
        <p className={styles.scope} title={state.scope.label}>
          {state.scope.kind === "one-goal" ? (ko ? "목표" : "Goal") : (ko ? "프로젝트" : "Project")} · {state.scope.label}
        </p>
      )}
      {blockedByGoal && (
        <p className={styles.hint} data-alive-hint="needs-goal">
          {surface === "one"
            ? (ko ? "먼저 목표를 시작하면 켤 수 있습니다." : "Start a goal first to turn this on.")
            : (ko ? "이 대화에 목표가 있어야 켤 수 있습니다." : "This chat needs a goal before it can run.")}
        </p>
      )}
      {conflict && (
        <div className={styles.conflict} data-alive-conflict="true">
          <span className={styles.conflictText}>
            {ko ? "실행 중: " : "Running in "}
            <strong title={conflict.title}>{conflict.title}</strong>
          </span>
          <button type="button" className={styles.quiet} onClick={moveHere} disabled={pending}>
            {ko ? "여기로 옮기기" : "Move here"}
          </button>
        </div>
      )}

      {state.enabled && status === "usage-unknown" && (
        <div className={styles.notice} data-alive-notice="usage-unknown">
          <span className={styles.noticeText}>
            {ko ? "중간에 끊긴 실행의 사용량을 잴 수 없습니다." : "An interrupted run's usage can't be measured."}
          </span>
          <button type="button" className={styles.quiet} onClick={regrant} disabled={pending} data-alive-regrant="true">
            {ko ? "다시 허용" : "Re-grant"}
          </button>
        </div>
      )}
      {state.enabled && status === "tokens-spent" && (
        <div className={styles.notice} data-alive-notice="tokens-spent">
          <span className={styles.noticeText}>
            {ko ? "한도를 다 썼습니다. 올리면 이어서 합니다." : "Limit used up. Raise it to continue."}
          </span>
          <button
            type="button"
            className={styles.quiet}
            onClick={() => setLimit(raisedLimit(limit, used))}
            disabled={pending}
            data-alive-raise="true"
          >
            {ko ? `${compactTokens(raisedLimit(limit, used) ?? 0)}로 올리기` : `Raise to ${compactTokens(raisedLimit(limit, used) ?? 0)}`}
          </button>
        </div>
      )}

      <div className={styles.section}>
        {chain(orchestrators, "orchestrator")}
        {chain(workers, "worker")}
        <p className={styles.caption}>{ko ? "작성창 모델 대신 대시보드 순서를 씁니다" : "Uses the dashboard order, not the composer model"}</p>
      </div>

      <div className={styles.section}>
        <div className={styles.budgetHead}>
          <span id={`${popoverId}-limit`}>{ko ? "토큰 한도" : "Token limit"}</span>
          <span className={styles.budgetValue}>
            {compactTokens(used)} / {limit ? compactTokens(limit) : (ko ? "무제한" : "No limit")}
          </span>
        </div>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label={ko ? "토큰 사용량" : "Token usage"}
          aria-valuemin={0}
          aria-valuemax={limit ?? undefined}
          aria-valuenow={limit ? used : undefined}
          aria-valuetext={limit ? `${compactTokens(used)} / ${compactTokens(limit)}` : (ko ? "한도 없음" : "No limit")}
          data-spent={limit && used >= limit ? "true" : undefined}
        >
          <span style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
        <div className={styles.presets} role="group" aria-labelledby={`${popoverId}-limit`}>
          {TOKEN_PRESETS.map((preset) => (
            <button
              key={preset ?? "none"}
              type="button"
              className={styles.preset}
              aria-pressed={limit === preset}
              disabled={pending}
              onClick={() => setLimit(preset)}
            >
              {preset === null ? "∞" : compactTokens(preset)}
            </button>
          ))}
          <label className={styles.custom}>
            <input
              type="number"
              inputMode="decimal"
              min={0.1}
              step={0.5}
              value={draftLimit}
              placeholder={limit && !TOKEN_PRESETS.includes(limit) ? String(Number((limit / 1_000_000).toFixed(2))) : ""}
              aria-label={ko ? "직접 입력 (백만 토큰)" : "Custom (million tokens)"}
              onChange={(event) => setDraftLimit(event.target.value)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); commitDraft(); }
              }}
              disabled={pending}
            />
            <span aria-hidden="true">M</span>
          </label>
        </div>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <footer className={styles.foot}>
        <button type="button" className={styles.quiet} onClick={openDashboard} data-alive-dashboard="true">
          {ko ? "대시보드로 이동" : "Open dashboard"} <span aria-hidden="true">→</span>
        </button>
      </footer>
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
