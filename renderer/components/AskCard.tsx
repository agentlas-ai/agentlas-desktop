"use client";

import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { askCardFooterLabel } from "@shared/ask-card-footer";
import {
  ASK_CARD_FIXED_FALLBACK_PX, ASK_OPTION_PEEK_PX, askCardPlan, findAskCardColumn, measureAskCardColumn, measureAskCardParts,
  sameAskCardPlan, type AskCardPlan,
} from "@/lib/ask-card-room";
import { IconChat, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconEdit, IconSend } from "./Icon";
import styles from "./AskCard.module.css";

/**
 * 사람에게 무언가 고르게 하는 자리는 앱 어디서나 같은 모양이다.
 *
 * 오너 지시 2026-08-24: 승인·질문이 각자 다른 모양으로 갈려 있었다(승인 시트,
 * 인라인 칩, 브라우저 승인, 질문 시트 넷). 모양은 이 컴포넌트 하나가 정하고,
 * 값은 globals.css 의 --ask-* 토큰이 정본이다. 규격은 docs/DESIGN-ASK-CARD.md.
 *
 * 웹에도 같은 규격을 그대로 옮긴다 — 토큰과 마크업이 문서에 적혀 있다.
 */
export interface AskCardOption {
  id: string;
  icon?: ReactNode;
  title: string;
  /** 한 줄 설명. 없으면 제목만 보인다. */
  note?: string;
  /** "추천" 같은 짧은 표식. */
  badge?: string;
  disabled?: boolean;
  /** 이 선택지가 지금 선택된 상태인지(키보드 이동·기본 추천 표시). */
  active?: boolean;
  /**
   * 여러 개 고르는 질문의 체크 상태. 값이 있으면 오른쪽에 체크 상자가 그려지고
   * aria-pressed 가 붙는다 — 고른 것이 "화살표 강조"로만 보이면 사람은 그것이
   * 이미 보낸 답인지 고른 상태인지 가를 수 없었다(오너 신고 2026-09-27).
   */
  checked?: boolean;
}

/**
 * 카드 아래 동작 줄 — [보조(건너뛰기/닫기)] [주(제출)].
 * 판단은 shared/ask-action-bar.ts 가 하고, 여기는 그 결과를 그린다.
 */
export interface AskCardActionRow {
  notice?: string | null;
  reason?: string | null;
  hint?: string | null;
  secondary?: { id: string; label: string; disabled?: boolean };
  primary?: { id: string; label: string; disabled?: boolean };
  onAction: (id: string, freeText: string) => void;
}

/** 서버 렌더에서는 레이아웃 효과가 없다 — 같은 모양의 효과로 물러난다. */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function AskCard({
  title,
  icon = <IconChat size={18} />,
  options,
  onChoose,
  onClose,
  footer,
  otherOption,
  freeText,
  onFreeTextChange,
  children,
  locale = "ko",
  subtitle,
  actionRow,
  collapsible = false,
  collapsed: collapsedProp,
  onCollapsedChange,
  "data-testid": testId,
}: {
  title: string;
  icon?: ReactNode;
  /**
   * 접을 수 있는 카드 — 머리 줄에 접기 단추가 생기고, 접으면 제목 줄만 남는다. 묻는 카드가 대화 영역을 통째로
   * 가리거나(Finance 검토 카드의 Save 가 안 보이던 일) 답하지 않고는 아래를 볼 수 없는 일이 없게 한다.
   * 접힌 카드도 답을 기다리는 중이다(닫기와 다르다: 닫기는 건너뜀이다).
   */
  collapsible?: boolean;
  /** 접힘 상태를 밖에서 쥘 때. 없으면 카드가 스스로 쥔다. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** 제목 아래 한 줄 — 질문 본문. 제목이 짧은 머리말(header)일 때 무엇을 묻는지 보인다. */
  subtitle?: string;
  /** 아래 동작 줄. 있으면 footer 의 단일 단추 대신 이 줄이 답을 보내고 건너뛴다. */
  actionRow?: AskCardActionRow;
  options: AskCardOption[];
  onChoose: (id: string, freeText: string) => void;
  onClose?: () => void;
  /**
   * 아래 자유 입력줄. placeholder 와 건너뛰기 문구를 주면 그 줄이 생긴다.
   * 건너뛰기는 선택지를 고르지 않고 넘어가는 길이므로, 낼 수 있는 질문에는
   * 언제나 빠져나갈 길이 있어야 한다는 규칙을 이 줄이 지킨다.
   */
  /*
   * ★ 이 단추는 두 가지 일을 한다. 입력란이 비었으면 건너뛰고, 글이 있으면 그 글을 답으로
   * 보낸다. 그런데 라벨은 늘 "건너뛰기"였다 — 답을 적어 둔 사람이 그 단추를 누르면
   * **적은 답이 그대로 나간다.** 라벨이 시킨 것과 정반대다.
   * 그래서 라벨도 상태를 따라간다: 글이 있으면 submitLabel, 없으면 skipLabel.
   */
  footer?: {
    placeholder: string;
    skipLabel: string;
    submitLabel: string;
    onSkip: (freeText: string) => void;
    hideInput?: boolean;
    /** 사람이 이미 보기를 골라 둔 상태인가 — 라벨이 "건너뛰기"로 거짓말하지 않게. */
    hasSelection?: boolean;
    /** 단추 없이 입력칸만 — 동작은 actionRow 가 맡는다. Enter 는 여전히 onSkip 을 부른다. */
    hideButton?: boolean;
  };
  /** An explicit, keyboard-reachable row for the free-text answer. */
  otherOption?: { title: string; note?: string };
  /** Optional controlled value for drafts that outlive this card instance. */
  freeText?: string;
  /** Called whenever the free-text input changes in controlled mode. */
  onFreeTextChange?: (value: string) => void;
  children?: ReactNode;
  locale?: "ko" | "en";
  "data-testid"?: string;
}) {
  const [internalFreeText, setInternalFreeText] = useState("");
  const footerInputRef = useRef<HTMLInputElement | null>(null);
  const currentFreeText = freeText ?? internalFreeText;
  /*
   * 아래 단추의 이름은 "이 카드에서 사람이 답한 것"을 전부 보고 정해진다. 고른 보기를 빼고
   * 자유입력만 보던 때에는, 여러 개 고르는 질문에서 보기를 골라도 단추가 "건너뛰기"라
   * 보낼 길이 화면에 없었다(오너 신고 2026-09-14, Work 에서 재현).
   *
   * 고른 보기가 있는지는 `options[].active` 로 셀 수 없다 — 같은 칸을 승인 카드가 "권장 기본값"
   * 강조로도 쓰기 때문이다(OneShell 승인, AskUserSheet 첫 보기). 그래서 답했는지는 묻는 쪽이
   * 직접 말한다. 안 말하면 예전 그대로 자유입력만 본다.
   */
  const footerState = { freeText: currentFreeText, hasSelection: footer?.hasSelection ?? false };
  const updateFreeText = (value: string) => {
    if (freeText === undefined) setInternalFreeText(value);
    onFreeTextChange?.(value);
  };
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = collapsible && (collapsedProp ?? internalCollapsed);
  const setCollapsedValue = (next: boolean) => {
    if (collapsedProp === undefined) setInternalCollapsed(next);
    onCollapsedChange?.(next);
  };
  const toggleCollapsed = () => {
    // 사람이 직접 접거나 편 뒤에는 카드가 스스로 접지도 펴지도 않는다.
    userToggledRef.current = true;
    setCollapsedValue(!isCollapsed);
  };

  /*
   * 작성창 위 결정 슬롯에 앉은 카드는 자기가 앉은 대화 열의 높이를 본다: 열이 낮으면 카드 + 작성창이 열을 다 먹어
   * 대화 영역(예: Finance 검토 카드의 Save)이 0px 로 잘렸다. 상한 = 열 − 다른 모든 것 − 대화 최소(ASK_THREAD_MIN_PX). 상한 안에서
   * 보기 목록이 먼저 줄고(보기 한 줄은 늘 보인다), 그래도 모자라면 카드가 접힌 채로 시작한다. 슬롯 밖의 카드는 그대로다.
   */
  const cardRef = useRef<HTMLElement | null>(null);
  const partsRef = useRef<{ fixed: number; shrinkable: number } | null>(null);
  const userToggledRef = useRef(false);
  const autoFoldedRef = useRef(false);
  const [plan, setPlan] = useState<AskCardPlan | null>(null);
  useIsoLayoutEffect(() => {
    const card = cardRef.current;
    const column = card ? findAskCardColumn(card) : null;
    if (!card || !column) {
      setPlan((current) => (current === null ? current : null));
      return;
    }
    const measure = () => {
      const parts = measureAskCardParts(card);
      if (parts) partsRef.current = parts;
      const known = partsRef.current ?? { fixed: ASK_CARD_FIXED_FALLBACK_PX, shrinkable: ASK_OPTION_PEEK_PX };
      const next = askCardPlan({ ...measureAskCardColumn(card, column), cardFixedHeight: known.fixed, shrinkableHeight: known.shrinkable });
      setPlan((current) => (sameAskCardPlan(current, next) ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    observer.observe(column.element);
    for (const child of Array.from(column.element.children)) observer.observe(child);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [isCollapsed, options.length, Children.count(children)]);
  useIsoLayoutEffect(() => {
    if (!collapsible || !plan || userToggledRef.current) return;
    if (plan.tight && !isCollapsed) {
      autoFoldedRef.current = true;
      setCollapsedValue(true);
    } else if (!plan.tight && isCollapsed && autoFoldedRef.current) {
      autoFoldedRef.current = false;
      setCollapsedValue(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsible, plan?.tight, isCollapsed]);
  const ko = locale === "ko";
  /*
   * 직접 입력은 보기 줄 하나다. 예전에는 "기타" 보기 줄과 입력 줄이 따로 있어(둘 다 같은 입력칸을 가리켰다) 카드가
   * 한 줄 반 더 컸다. 입력 줄이 있으면 그 줄이 "기타"이고, 입력 줄이 없을 때만 "기타" 단추를 그린다.
   */
  const otherIsInputRow = Boolean(otherOption && footer && !footer.hideInput);

  return (
    <section
      ref={cardRef}
      className={styles.card}
      role="group"
      aria-label={title}
      data-ask-card="true"
      data-collapsed={isCollapsed ? "true" : undefined}
      data-ask-room={plan ? plan.room : undefined}
      data-ask-tight={plan?.tight ? "true" : undefined}
      style={plan && !isCollapsed ? { maxHeight: `min(var(--ask-card-max-height), ${plan.maxHeight}px)` } : undefined}
      data-testid={testId}
    >
      <div className={styles.head}>
        <span className={styles.headingIcon} aria-hidden="true">{icon}</span>
        <div className={styles.titleBlock}>
          <p className={styles.title}>{title}</p>
          {subtitle && subtitle !== title && !isCollapsed && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {(collapsible || onClose) && (
          <div className={styles.headActions}>
            {collapsible && (
              <button
                type="button"
                className={styles.collapse}
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? (ko ? "펼치기" : "Expand") : (ko ? "접기" : "Collapse")}
                title={isCollapsed ? (ko ? "펼치기" : "Expand") : (ko ? "접어서 대화 보기" : "Collapse to see the conversation")}
                data-ask-collapse="true"
                onClick={toggleCollapsed}
              >
                <IconChevronDown size={16} />
              </button>
            )}
            {onClose && (
              <button
                type="button"
                className={styles.close}
                aria-label={ko ? "닫기" : "Close"}
                onClick={onClose}
              >
                <IconClose size={16} />
              </button>
            )}
          </div>
        )}
      </div>

      {!isCollapsed && Children.toArray(children).length > 0 && <div className={styles.body} data-ask-body="true">{children}</div>}
      {!isCollapsed && <div className={styles.options} data-ask-options="true">
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className={styles.option}
            data-active={option.active ? "true" : "false"}
            data-ask-option={option.id}
            {...(option.checked !== undefined ? { "aria-pressed": option.checked, "data-checked": option.checked ? "true" : "false" } : {})}
            disabled={option.disabled}
            onClick={() => onChoose(option.id, currentFreeText.trim())}
          >
            <span className={styles.index} aria-hidden="true">{option.icon ?? index + 1}</span>
            <span className={styles.optionText}>
              <span className={styles.optionTitleRow}>
                <span className={styles.optionTitle}>{option.title}</span>
                {option.badge && <span className={styles.badge}>{option.badge}</span>}
              </span>
              {option.note && <span className={styles.optionNote}>{option.note}</span>}
            </span>
            {option.checked !== undefined
              ? <span className={styles.check} data-checked={option.checked ? "true" : "false"} aria-hidden="true">{option.checked && <IconCheck size={13} />}</span>
              : option.active && <span className={styles.arrow} aria-hidden="true"><IconChevronRight size={16} /></span>}
          </button>
        ))}
        {otherOption && !otherIsInputRow && (
          <button
            type="button"
            className={styles.option}
            data-ask-option="other"
            data-ask-other-option="true"
            data-active={currentFreeText.trim() ? "true" : "false"}
            onClick={() => footerInputRef.current?.focus()}
          >
            <span className={styles.index} aria-hidden="true"><IconEdit size={14} /></span>
            <span className={styles.optionText}>
              <span className={styles.optionTitleRow}><span className={styles.optionTitle}>{otherOption.title}</span></span>
              {otherOption.note && <span className={styles.optionNote}>{otherOption.note}</span>}
            </span>
            {currentFreeText.trim() && <span className={styles.arrow} aria-hidden="true"><IconChevronRight size={16} /></span>}
          </button>
        )}
      </div>}

      {!isCollapsed && footer && (
        <div
          className={styles.footer}
          data-ask-footer="true"
          data-input={footer.hideInput ? "false" : "true"}
          data-ask-other-option={otherIsInputRow ? "true" : undefined}
          data-active={otherIsInputRow && currentFreeText.trim() ? "true" : undefined}
        >
          <span className={styles.footerMark} aria-hidden="true"><IconEdit size={14} /></span>
          {!footer.hideInput && <input
              ref={footerInputRef}
              className={styles.footerInput}
              value={currentFreeText}
              placeholder={footer.placeholder}
              aria-label={otherOption?.title ?? footer.placeholder}
              onChange={(event) => updateFreeText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  event.preventDefault();
                  /*
                   * ★Enter 는 **바로 아래 단추가 하는 일**을 한다 (실측 2026-09-08).
                   *   예전에는 `if (answer)` 가 붙어 있어 입력이 비면 Enter 가 아무 일도
                   *   안 했다. 그런데 같은 자리의 단추는 비어 있어도 건너뛴다 — 같은 화면의
                   *   두 길이 서로 다른 답을 내면 사람은 둘 중 하나를 고장으로 읽는다.
                   *   라벨(askCardFooterLabel)도 이미 입력 유무를 따라가므로, 사람은 누르기
                   *   전에 무슨 일이 일어날지 읽을 수 있다.
                   */
                  footer.onSkip(currentFreeText.trim());
                }
              }}
            />}
          {!footer.hideButton && <button type="button" className={styles.skip} onClick={() => footer.onSkip(currentFreeText.trim())}>
            {askCardFooterLabel(footerState, footer)}
          </button>}
        </div>
      )}

      {!isCollapsed && actionRow && (
        <div className={styles.actionRow} data-ask-action-row="true">
          {actionRow.notice && <p className={styles.actionNotice} role="status" data-ask-action-notice="true">{actionRow.notice}</p>}
          <div className={styles.actionButtons}>
            <p className={styles.actionReason} data-ask-action-reason={actionRow.reason ? "true" : undefined} aria-live="polite">
              {actionRow.reason ?? actionRow.hint ?? ""}
            </p>
            {actionRow.secondary && (
              <button
                type="button"
                className={styles.actionSecondary}
                data-ask-action={actionRow.secondary.id}
                disabled={actionRow.secondary.disabled}
                onClick={() => actionRow.onAction(actionRow.secondary!.id, currentFreeText.trim())}
              >
                {actionRow.secondary.label}
              </button>
            )}
            {actionRow.primary && (
              <button
                type="button"
                className={styles.actionPrimary}
                data-ask-action={actionRow.primary.id}
                disabled={actionRow.primary.disabled}
                title={actionRow.primary.disabled && actionRow.reason ? actionRow.reason : undefined}
                onClick={() => actionRow.onAction(actionRow.primary!.id, currentFreeText.trim())}
              >
                <IconSend size={14} />
                {actionRow.primary.label}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
