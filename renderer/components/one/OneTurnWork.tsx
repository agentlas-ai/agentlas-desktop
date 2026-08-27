"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { InvocationRunReceipt } from "@shared/types";
import { IconChevronDown } from "@/components/Icon";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { extractAutomationRegistrations, type OneActivityState } from "@/lib/one-activity";
import { OneAutomationRegistrationCard } from "./OneAdaptiveResult";
import { McpResultPreview } from "../McpResultPreview";
import {
  CONNECTED_TOOL_LABEL,
  buildOneWorkPresentation,
  cellVerb,
  formatWorkElapsed,
  type OneWorkCell,
  type OneWorkPresentation,
} from "@/lib/one-turn-work";
import styles from "./OneTurnWork.module.css";

/**
 * One assistant turn's process, drawn the way Codex draws it:
 *
 *   running →  ✦ <the model's latest thought headline, shimmering>
 *              탐색함  README.md, package.json
 *              실행함  npm test
 *   settled →  27s 동안 작업 ›            (collapsed; click to open the rows)
 *
 * Every row is what the runtime actually did (typed protocol → ledger), never
 * a hard-coded status sentence. The headline is the model's own reasoning
 * summary; only when a runtime gives none does the row verb stand in.
 */

function useElapsed(startedAt: number | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return startedAt == null ? 0 : Math.max(0, now - startedAt);
}

/** Bold-only markdown for thought bodies: `**x**` → <strong>, lines → <br>. */
function ThoughtBody({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return (
    <div className={styles.thoughtBody}>
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <span key={index} className={styles.thoughtGap} />;
        const parts = trimmed.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
        return (
          <p key={index}>
            {parts.map((part, partIndex) => (
              part.startsWith("**") && part.endsWith("**")
                ? <strong key={partIndex}>{part.slice(2, -2)}</strong>
                : <Fragment key={partIndex}>{part}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function ExpandableRow({
  cell,
  head,
  children,
  locale,
}: {
  cell: OneWorkCell;
  head: ReactNode;
  children?: ReactNode;
  locale: "ko" | "en";
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(children);
  const running = cell.status === "running";
  return (
    <div className={styles.row} data-kind={cell.kind} data-status={cell.status} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className={styles.rowHead}
        onClick={expandable ? () => setOpen((current) => !current) : undefined}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        title={expandable ? (locale === "ko" ? "자세히" : "Details") : undefined}
      >
        <span className={styles.rowMark} data-status={cell.status} aria-hidden="true" />
        {/* 단톡 실행에서는 이 행을 누가 했는지가 곧 내용이다 (G-4). */}
        {cell.agent && <span className={styles.muted} data-cell-agent="true">{cell.agent} ·</span>}
        <span className={running ? `${styles.rowText} ${styles.shimmer}` : styles.rowText}>{head}</span>
        {expandable && <span className={styles.rowChevron} aria-hidden="true"><IconChevronDown size={12} /></span>}
      </button>
      {expandable && open && <div className={styles.rowBody}>{children}</div>}
    </div>
  );
}

function statusSuffix(cell: OneWorkCell, locale: "ko" | "en"): ReactNode {
  if (cell.status === "failed") return <span className={styles.failed}>{locale === "ko" ? "실패" : "failed"}</span>;
  if (cell.status === "cancelled") return <span className={styles.muted}>{locale === "ko" ? "취소됨" : "cancelled"}</span>;
  return null;
}

function normalizeLiveLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function liveThoughtLabel(cell: OneWorkCell, locale: "ko" | "en"): string {
  if (cell.kind !== "thought") return "";
  return cell.headline ?? (cell.status === "running" ? cellVerb(cell, locale) : "");
}

function WorkRow({ cell, locale }: { cell: OneWorkCell; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const verb = cellVerb(cell, locale);
  switch (cell.kind) {
    case "thought": {
      // Codex draws the model's own summary headline as the row ("Planning
      // applypatch creation"); the span length is secondary. Only a thought
      // with no text falls back to "Thought for Ns".
      const seconds = cell.durationMs != null && cell.durationMs >= 1_000 ? formatWorkElapsed(cell.durationMs) : null;
      const label = cell.headline
        ?? (cell.status === "running"
          ? verb
          : seconds
            ? (ko ? `${seconds} 동안 생각함` : `Thought for ${seconds}`)
            : verb);
      const bodyIsMoreThanHeadline = Boolean(cell.body && cell.headline && cell.body.replace(/[*_`#\s]/g, "") !== cell.headline.replace(/[*_`#\s]/g, "").replace(/…$/, ""));
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={(
            <>
              <span className={styles.thoughtLabel}>{label}</span>
              {cell.headline && seconds && <span className={styles.muted}>{ko ? `${seconds} 생각` : `thought ${seconds}`}</span>}
            </>
          )}
        >
          {cell.body && (bodyIsMoreThanHeadline || !cell.headline) ? <ThoughtBody text={cell.body} /> : undefined}
        </ExpandableRow>
      );
    }
    case "explore":
      // Codex: "Explored" then its Read/List/Search lines, always visible.
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={(
            <span className={styles.exploreHead}>
              <span>
                <strong>{verb}</strong>
                {statusSuffix(cell, locale)}
              </span>
              <span className={styles.exploreList}>
                {cell.entries.map((entry, index) => (
                  <span key={`${entry.op}:${index}`} className={styles.exploreLine}>
                    <span className={styles.exploreOp}>
                      {entry.op === "read" ? (ko ? "읽음" : "Read") : entry.op === "list" ? (ko ? "목록" : "List") : (ko ? "검색" : "Search")}
                    </span>
                    <span className={styles.exploreTarget}>{entry.label}</span>
                  </span>
                ))}
              </span>
            </span>
          )}
        />
      );
    case "run":
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={(
            <>
              <strong>{verb}</strong>
              <code className={styles.command}>{cell.command}</code>
              {cell.exitCode != null && cell.exitCode !== 0 && <span className={styles.failed}>exit {cell.exitCode}</span>}
              {cell.exitCode == null && statusSuffix(cell, locale)}
            </>
          )}
        >
          {cell.output ? <pre className={styles.output}>{cell.output}</pre> : undefined}
        </ExpandableRow>
      );
    case "edit":
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={(
            <>
              <strong>{verb}</strong>
              <span className={styles.files}>
                {cell.files.map((file, index) => (
                  <span key={`${file.path}:${index}`} className={styles.file}>
                    <code>{file.path}</code>
                    {(file.added !== undefined || file.removed !== undefined) && (
                      <span className={styles.diffStat}>
                        {file.added !== undefined && <em className={styles.added}>+{file.added}</em>}
                        {file.removed !== undefined && <em className={styles.removed}>−{file.removed}</em>}
                      </span>
                    )}
                  </span>
                ))}
              </span>
              {statusSuffix(cell, locale)}
            </>
          )}
        >
          {cell.diff ? <pre className={styles.output}>{cell.diff}</pre> : undefined}
        </ExpandableRow>
      );
    case "web_search":
      return (
        <ExpandableRow cell={cell} locale={locale} head={<><strong>{verb}</strong><span className={styles.object}>{cell.query}</span>{statusSuffix(cell, locale)}</>} />
      );
    case "fetch":
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={(
            <>
              <strong>{verb}</strong>
              <span className={styles.object}>{cell.url}</span>
              {cell.statusCode !== undefined && <span className={styles.muted}>{cell.statusCode}</span>}
              {statusSuffix(cell, locale)}
            </>
          )}
        />
      );
    case "call": {
      const body = [cell.detail, cell.args, cell.result].filter(Boolean).join("\n\n");
      const label = cell.label === CONNECTED_TOOL_LABEL
        ? (ko ? "연결된 도구 사용" : "Use connected tool")
        : cell.label;
      return (
        <div>
          <ExpandableRow
            cell={cell}
            locale={locale}
            head={<><strong>{verb}</strong><span className={styles.object}>{label}</span>{statusSuffix(cell, locale)}</>}
          >
            {body ? <pre className={styles.output}>{body}</pre> : undefined}
          </ExpandableRow>
          <McpResultPreview result={cell.result} toolName={cell.label} locale={locale} compact />
        </div>
      );
    }
    case "agent":
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={(
            <>
              <strong>{verb}</strong>
              <span className={styles.object}>{cell.role ? `${cell.name} · ${cell.role}` : cell.name}</span>
              {statusSuffix(cell, locale)}
            </>
          )}
        />
      );
    case "answer":
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={(
            <>
              <strong>{verb}</strong>
              {cell.chars != null && cell.status !== "running" && (
                <span className={styles.muted}>{ko ? `${cell.chars.toLocaleString()}자` : `${cell.chars.toLocaleString()} chars`}</span>
              )}
            </>
          )}
        />
      );
    case "notice":
      return (
        <ExpandableRow
          cell={cell}
          locale={locale}
          head={<span className={styles.notice} data-level={cell.level}>{cell.message}</span>}
        >
          {cell.details ? <pre className={styles.output}>{cell.details}</pre> : undefined}
        </ExpandableRow>
      );
    default:
      return null;
  }
}

export function OneTurnWorkDividers({ presentation }: { presentation: OneWorkPresentation }) {
  if (presentation.dividers.length === 0) return null;
  return (
    <>
      {presentation.dividers.map((divider) => (
        <div key={divider.id} className={styles.divider} role="note" data-one-work-divider="true">
          <span className={styles.dividerIcon} aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" />
            </svg>
          </span>
          <span>{divider.message}</span>
        </div>
      ))}
    </>
  );
}

export function OneTurnWork({
  state,
  busy,
  preparing = false,
  startedAt,
  locale,
  workspacePath,
  runStatus,
  onRetry,
  retryDisabled = false,
}: {
  state: OneActivityState;
  /** True only for the live run this block belongs to. */
  busy: boolean;
  /** Main preflight before a run id exists — no rows yet, just the live headline. */
  preparing?: boolean;
  startedAt: number | null;
  locale: "ko" | "en";
  workspacePath: string | null;
  /**
   * ★ 실행이 답 없이 끝난 것을 화면이 말하게 하는 칸 (UX-D-1).
   *
   * 원장은 "시작 줄만 있고 종료 줄이 없는" 실행을 `interrupted`로 이미 알고 있다
   * (`store/run-events.ts` getInvocationRunReceipt). 그런데 이 블록은 종료 *이벤트*로만
   * 실패를 판정해서, 앱이 통째로 죽어 종료 줄 자체가 안 남은 실행은 실패로 보이지 않았다.
   * 화면에는 "N초 동안 작업"만 남고 답은 없어, 사용자에게는 답이 조용히 증발한 것으로 읽힌다
   * (실측 2026-08-25: 같은 대화에서 질문 3개 중 2개가 이 상태였다).
   */
  runStatus?: InvocationRunReceipt["status"];
  /** 낸 오류에는 푸는 길이 있어야 한다 — 중단된 턴의 질문을 다시 보낸다. */
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const ko = locale === "ko";
  const presentation = useMemo(() => buildOneWorkPresentation(state, locale, workspacePath), [state, locale, workspacePath]);
  const automationRegistrations = useMemo(() => extractAutomationRegistrations(state), [state]);
  const active = busy || preparing;
  const [expanded, setExpanded] = useState(active);
  useEffect(() => {
    // A settled block collapses to its "Worked for" line the moment the run
    // ends; a new run of the same block opens it again.
    setExpanded(active);
  }, [active]);
  const liveElapsedMs = useElapsed(startedAt, active);
  // 답 없이 끊긴 실행. 종료 이벤트가 아니라 원장 판정을 근거로 삼는다 — 앱이 죽으면
  // 종료 줄을 쓸 주체가 없으므로, "종료 이벤트가 없다"는 사실 자체가 유일한 증거다.
  const interrupted = !active && runStatus === "interrupted";
  /*
   * ★못 잰 시간을 지어내지 않는다. 끝나지 않은 실행에는 종료 시각이 없어서, 시작 시각부터
   * "지금"까지를 재면 질문한 지 오래될수록 숫자가 계속 자란다 — 실측에서 20초쯤 돌다 멈춘
   * 실행이 "1시간 26분 동안 작업"으로 보였다. 실제로 얼마나 돌았는지는 아무도 모르므로
   * 시간 칸을 비우고, 대신 답을 못 받았다는 사실만 적는다.
   */
  const settledMs = presentation.durationMs
    ?? (startedAt != null && !active && !interrupted ? liveElapsedMs : undefined);
  const recordedRows = presentation.cells.length > 0;
  const headline = preparing && !recordedRows
    ? (ko ? "준비하는 중" : "Preparing")
    : presentation.headline;
  // The active headline is a live projection of the latest thought. Do not
  // echo that exact thought again as the first expanded row; older thoughts
  // and the full settled ledger remain visible for audit.
  let liveHeadlineCell = -1;
  if (active) {
    const normalizedHeadline = normalizeLiveLabel(headline);
    for (let index = presentation.cells.length - 1; index >= 0; index -= 1) {
      const cell = presentation.cells[index];
      if (
        cell.kind === "thought"
        && normalizeLiveLabel(liveThoughtLabel(cell, locale)) === normalizedHeadline
      ) {
        liveHeadlineCell = index;
        break;
      }
    }
  }
  const visibleCells = liveHeadlineCell < 0
    ? presentation.cells
    : presentation.cells.filter((_cell, index) => index !== liveHeadlineCell);
  const hasRows = visibleCells.length > 0;

  if (!active && !hasRows && !presentation.terminalMessage && !interrupted) {
    // Nothing happened beyond the answer itself (no thought, no tool). Codex
    // shows no work line for such a turn.
    return null;
  }

  const terminal = presentation.terminal;
  const failed = !active && (terminal === "failed" || terminal === "cancelled");
  const workedFor = settledMs != null
    ? (ko ? `${formatWorkElapsed(settledMs)} 동안 작업` : `Worked for ${formatWorkElapsed(settledMs)}`)
    : (ko ? "작업" : "Work");
  return (
    <>
    <section
      className={styles.work}
      data-one-turn-work="true"
      data-state={preparing ? "preparing" : active ? "running" : "settled"}
      aria-busy={active}
    >
      {active ? (
        <div className={styles.liveBlock}>
          <div className={styles.live} role="status" aria-live="polite">
            <span className={styles.liveMark} aria-hidden="true" />
            <span className={`${styles.liveText} ${styles.shimmer}`}>{headline}</span>
            {hasRows && (
              <button
                type="button"
                className={styles.liveToggle}
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
                aria-label={ko ? "과정 접기/펼치기" : "Toggle steps"}
              >
                <IconChevronDown size={12} />
              </button>
            )}
          </div>
          <div className={styles.liveEstimate}>
            <LoadingEstimate
              compact
              locale={locale}
              operationKey={preparing ? "one-turn-preparing" : "one-turn-running"}
              startedAt={startedAt ?? undefined}
              expectedSeconds={preparing ? [2, 45] : [30, 900]}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.header}
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          data-terminal={terminal ?? "completed"}
        >
          <span>{workedFor}</span>
          {/* 표시=실행 (C-D-1): 이 턴이 실제로 돈 모델을 실행 기록 표면에 남긴다. */}
          {presentation.model && <span className={styles.muted} data-run-model="true">· {presentation.model}</span>}
          {failed && (
            <span className={styles.headerTerminal}>
              · {terminal === "cancelled" ? (ko ? "중단됨" : "stopped") : (ko ? "실패" : "failed")}
            </span>
          )}
          {!failed && interrupted && (
            <span className={styles.headerTerminal}>
              · {ko ? "답을 받지 못함" : "no answer"}
            </span>
          )}
          <span className={styles.headerChevron} aria-hidden="true"><IconChevronDown size={12} /></span>
        </button>
      )}
      {expanded && hasRows && (
        <div className={styles.rows}>
          {visibleCells.map((cell) => <WorkRow key={cell.id} cell={cell} locale={locale} />)}
        </div>
      )}
      {/* ★ 실패 사유는 접힘과 무관하게 보인다 (2026-08-23).
          이 블록은 실행이 끝나는 순간 스스로 접힌다(위 useEffect). 그래서 사유가
          펼침 안에만 있던 동안에는, 사유를 적어 두고도 **적는 순간 감췄다.**
          사용자에게 남는 것은 "실패" 배지 하나뿐이고 왜인지는 눌러야 나왔다.
          낸 오류에는 푸는 길이 있어야 한다 — 사유는 길의 첫 칸이다.
          행 목록은 그대로 접어 둔다. 감춰서 문제였던 것은 사유 한 줄이다. */}
      {presentation.terminalMessage && !presentation.cells.some((cell) => cell.kind === "notice" && cell.message === presentation.terminalMessage) && (
        <div className={styles.rows}>
          <div className={styles.row} data-kind="notice" data-status="failed">
            <span className={styles.rowHead}>
              <span className={styles.rowMark} data-status="failed" aria-hidden="true" />
              <span className={styles.rowText}><span className={styles.notice} data-level="error">{presentation.terminalMessage}</span></span>
            </span>
          </div>
        </div>
      )}
      {/* ★ 답이 사라진 자리에는 사라졌다고 적는다 (UX-D-1).
          앱이 실행 도중 멈추면 종료 줄을 쓸 주체가 없어 답도, 실패 표시도 남지 않았다.
          사용자에게는 자기 질문만 나란히 남아 "왜 답이 없는지" 알 길이 자체가 없었다.
          접힘과 무관하게 보이고, 다시 물을 수 있는 길을 같은 자리에 둔다. */}
      {interrupted && (
        <div className={styles.rows} data-one-turn-interrupted="true">
          <div className={styles.row} data-kind="notice" data-status="failed">
            <span className={styles.rowHead}>
              <span className={styles.rowMark} data-status="failed" aria-hidden="true" />
              <span className={styles.rowText}>
                <span className={styles.notice} data-level="error">
                  {ko
                    ? "이 질문은 답을 받지 못했습니다 — 실행 도중 앱이 멈춰 답이 저장되지 않았습니다."
                    : "This question never received an answer — the app stopped mid-run, so nothing was saved."}
                </span>
              </span>
            </span>
          </div>
          {onRetry && (
            <div className={styles.retryRow}>
              <button
                type="button"
                className={styles.retryButton}
                onClick={onRetry}
                disabled={retryDisabled}
                data-one-turn-retry="true"
              >
                {ko ? "다시 시도" : "Retry"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
    {/* 자동화 등록 영수증(automation.create/update)은 접힌 작업 행 안의 한 줄이
        아니라 대화의 1급 결과 카드다 — 호스트가 확인한 등록만 여기 승격된다. */}
    {automationRegistrations.map((registration) => (
      <OneAutomationRegistrationCard
        key={`automation-registration:${registration.itemId}`}
        name={registration.name}
        action={registration.action}
        schedule={registration.schedule}
        locale={locale}
      />
    ))}
    <OneTurnWorkDividers presentation={presentation} />
    </>
  );
}
