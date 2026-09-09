"use client";

import { useRef, useState, type ReactNode } from "react";
import { askCardFooterLabel } from "@shared/ask-card-footer";
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
  title: string;
  /** 한 줄 설명. 없으면 제목만 보인다. */
  note?: string;
  /** "추천" 같은 짧은 표식. */
  badge?: string;
  disabled?: boolean;
  /** 이 선택지가 지금 선택된 상태인지(키보드 이동·기본 추천 표시). */
  active?: boolean;
}

export function AskCard({
  title,
  options,
  onChoose,
  onClose,
  footer,
  otherOption,
  freeText,
  onFreeTextChange,
  children,
  locale = "ko",
  "data-testid": testId,
}: {
  title: string;
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
  footer?: { placeholder: string; skipLabel: string; submitLabel: string; onSkip: (freeText: string) => void; hideInput?: boolean };
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
  const updateFreeText = (value: string) => {
    if (freeText === undefined) setInternalFreeText(value);
    onFreeTextChange?.(value);
  };

  return (
    <section className={styles.card} role="group" aria-label={title} data-ask-card="true" data-testid={testId}>
      <div className={styles.head}>
        <p className={styles.title}>{title}</p>
        {onClose && (
          <button
            type="button"
            className={styles.close}
            aria-label={locale === "ko" ? "닫기" : "Close"}
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      {children}
      <div className={styles.options}>
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className={styles.option}
            data-active={option.active ? "true" : "false"}
            data-ask-option={option.id}
            disabled={option.disabled}
            onClick={() => onChoose(option.id, currentFreeText.trim())}
          >
            <span className={styles.index} aria-hidden="true">{index + 1}</span>
            <span className={styles.optionText}>
              <span className={styles.optionTitleRow}>
                <span className={styles.optionTitle}>{option.title}</span>
                {option.badge && <span className={styles.badge}>{option.badge}</span>}
              </span>
              {option.note && <span className={styles.optionNote}>{option.note}</span>}
            </span>
            {option.active && <span className={styles.arrow} aria-hidden="true">→</span>}
          </button>
        ))}
        {otherOption && (
          <button
            type="button"
            className={styles.option}
            data-ask-option="other"
            data-ask-other-option="true"
            data-active={currentFreeText.trim() ? "true" : "false"}
            onClick={() => footerInputRef.current?.focus()}
          >
            <span className={styles.index} aria-hidden="true">{options.length + 1}</span>
            <span className={styles.optionText}>
              <span className={styles.optionTitleRow}><span className={styles.optionTitle}>{otherOption.title}</span></span>
              {otherOption.note && <span className={styles.optionNote}>{otherOption.note}</span>}
            </span>
            {currentFreeText.trim() && <span className={styles.arrow} aria-hidden="true">→</span>}
          </button>
        )}
      </div>

      {footer && (
        <div className={styles.footer}>
          <span className={styles.footerMark} aria-hidden="true">✎</span>
          {!footer.hideInput && <input
              ref={footerInputRef}
              className={styles.footerInput}
              value={currentFreeText}
              placeholder={footer.placeholder}
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
          <button type="button" className={styles.skip} onClick={() => footer.onSkip(currentFreeText.trim())}>
            {askCardFooterLabel(currentFreeText, footer)}
          </button>
        </div>
      )}
    </section>
  );
}
