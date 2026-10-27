"use client";

/*
 * 승인 프롬프트 — 도구 승인(ToolApprovalCard)과 브라우저 승인(BrowserActionApprovalSheet)이 함께 쓰는 한 장의 모양.
 *
 * ★오너 2026-10-27 "승인카드 디자인이 좀 애매하다. 코덱스나 클로드코드 앱의 승인카드 디자인을 따라해라."
 *   두 제품의 승인 프롬프트가 공통으로 가진 문법만 옮겼다.
 *   1. 위에 질문 한 줄.
 *   2. 실제로 실행될 명령·경로·대상을 모노스페이스 코드 블록으로(긴 것은 4줄에서 접고 펼치기).
 *   3. 그 아래 번호 붙은 세로 선택지. 선택 행은 은은한 바탕, 오른쪽에 단축키 힌트.
 *   4. 승인이 여러 건이면 한 번에 한 장만 보이고 "1/3 · 다음" 으로 넘긴다(쌓지 않는다).
 * 이 컴포넌트는 그리기와 키보드만 한다. 무엇을 보내는지(저장 범위·IPC)는 부르는 쪽이 그대로 가진다.
 *
 * 키보드: 카드(또는 카드 안의 요소)에 포커스가 있을 때만 듣는다 — 숫자 1~9, y(첫 선택지)·n(거절), Esc(거절),
 *   ↑↓(선택 이동), Enter(선택 확정), ←→(여러 건 넘기기). 카드가 뜰 때 포커스는 아무 곳도 잡혀 있지 않을 때만 가져온다.
 *   작성창에 글을 쓰는 중이면 포커스를 뺏지 않고, 숫자 키는 그 글자로 입력된다.
 *
 * ★오너 2026-10-27 "아니오, 그리고 대신 이렇게 하세요" (Claude Code·Codex 승인 프롬프트의 마지막 선택지): `denyNote` 를 주면 거절 행 아래에
 *   한 줄 입력이 열린다. 거절 행에 포커스가 있을 때 Tab(또는 행 아래 안내 단추)로 열고, Enter 는 그 줄과 함께 거절, 비워 두고 Enter 는 줄 없는
 *   거절이다. 입력칸에 포커스가 있는 동안 카드 단축키(숫자·y·n)는 글자로 입력되고 Esc 만 입력칸을 닫는다. 한글 조합 중 Enter 는 보내지 않는다.
 *   입력이 열려 있고 글이 있으면 거절을 어떻게 눌러도(클릭·n·Esc·Enter) 그 글이 같이 간다 — 눈에 보이는 글이 나가는 글이다. 초안은 요청 id
 *   별로 카드 밖에 있어(lib/approval-note-drafts) 카드를 넘기거나 결정이 재시도돼도 결정이 확정되기 전에는 사라지지 않는다.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { APPROVAL_NOTE_MAX_CHARS, cleanApprovalNote, readApprovalNoteDraft, writeApprovalNoteDraft } from "@/lib/approval-note-drafts";

export interface ApprovalPromptOption {
  id: string;
  title: string;
  /** 짧은 보조 설명. showNote 가 켜진 행에만 보이고, 접근성 이름에는 항상 들어간다. */
  note?: string;
  showNote?: boolean;
  /** primary = 첫 허용(y), deny = 거절(n · Esc). 나머지는 숫자 키로만. */
  role?: "primary" | "deny";
  disabled?: boolean;
}

export interface ApprovalPromptDeck {
  /** 0부터. */
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function ApprovalPrompt({
  question,
  ariaLabel,
  code,
  codeLabel,
  meta,
  warning,
  options,
  locked = false,
  onChoose,
  denyNote,
  deck,
  trailing,
  footer,
  className,
  testId = "tool-approval-card",
  attrs,
}: {
  question: string;
  ariaLabel?: string;
  /** 이미 redaction 을 거친, 실제로 실행될 명령·경로·대상. 없으면 코드 블록을 그리지 않는다. */
  code?: string | null;
  codeLabel?: string;
  meta?: ReactNode;
  /** 경고 톤 한 줄(결제 등). */
  warning?: ReactNode;
  options: ApprovalPromptOption[];
  locked?: boolean;
  /** `note` only accompanies the deny option, and only when `denyNote` is set and the owner wrote one. */
  onChoose: (id: string, note?: string) => void;
  /** "No, and do this instead": the request this card answers (the draft's key). Absent = no input (a request with no room to tell). */
  denyNote?: { draftKey: string } | null;
  deck?: ApprovalPromptDeck;
  /** 머리 줄 오른쪽 끝 — 남은 시간 같은 짧은 것. */
  trailing?: ReactNode;
  /** 카드 맨 아래 — 결과·오류 안내. */
  footer?: ReactNode;
  className?: string;
  testId?: string;
  attrs?: Record<string, string | undefined>;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const rootRef = useRef<HTMLElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const codeRef = useRef<HTMLPreElement>(null);
  const [sel, setSel] = useState(() => Math.max(0, options.findIndex((o) => o.role === "primary" && !o.disabled)));
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const noteKey = denyNote?.draftKey;
  const denyIndex = denyNote ? options.findIndex((o) => o.role === "deny") : -1;
  const [noteOpen, setNoteOpen] = useState(() => denyIndex >= 0 && readApprovalNoteDraft(noteKey).open);
  const [noteText, setNoteText] = useState(() => readApprovalNoteDraft(noteKey).text);
  const noteRef = useRef<HTMLInputElement>(null);
  const focusNoteNext = useRef(false);
  const composingRef = useRef(false);
  const composedAtRef = useRef(-1000);
  const placeholder = ko ? "대신 이렇게 하세요 (Enter 로 보내기)" : "Tell the personal agent what to do instead (Enter to send)";
  const noteLabel = ko ? "아니오, 대신 이렇게 하세요" : "No, and tell the personal agent what to do instead";

  // 카드가 뜰 때: 아무 곳에도 포커스가 없을 때만 카드로 가져온다 (작성창에서 글을 쓰는 중이면 그대로 둔다).
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, []);

  useLayoutEffect(() => {
    const element = codeRef.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [code, expanded]);

  useEffect(() => {
    if (noteOpen && focusNoteNext.current) {
      focusNoteNext.current = false;
      noteRef.current?.focus({ preventScroll: true });
    }
  }, [noteOpen]);

  const rememberNote = (text: string, open: boolean) => writeApprovalNoteDraft(noteKey, { text, open });
  const openNote = () => {
    if (denyIndex < 0 || locked || options[denyIndex].disabled) return;
    focusNoteNext.current = true;
    setNoteOpen(true);
    rememberNote(noteText, true);
    // 이미 열려 있으면 effect 가 다시 돌지 않는다 — 곧장 포커스.
    if (noteOpen) { focusNoteNext.current = false; noteRef.current?.focus({ preventScroll: true }); }
  };
  const closeNote = (refocusDeny: boolean) => {
    setNoteOpen(false);
    rememberNote(noteText, false);
    if (refocusDeny) rowRefs.current[denyIndex]?.focus();
  };
  /** One place every choice goes through: a refusal carries the line the owner can see in the open input. */
  const choose = (index: number) => {
    const option = options[index];
    if (option.role === "deny" && denyNote && noteOpen) onChoose(option.id, cleanApprovalNote(noteText));
    else onChoose(option.id);
  };

  const usable = (index: number) => index >= 0 && index < options.length && !options[index].disabled && !locked;
  const pick = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (!usable(index)) return;
    event.preventDefault();
    event.stopPropagation();
    choose(index);
  };
  const move = (event: KeyboardEvent<HTMLElement>, step: 1 | -1) => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!enabled.length) return;
    event.preventDefault();
    const at = enabled.indexOf(sel);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    setSel(next);
    if ((event.target as HTMLElement).closest("[data-approval-row]")) rowRefs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    // Tab on the refusal row (selected, or the card itself with it selected) opens "No, and do this instead".
    if (event.key === "Tab" && !event.shiftKey && denyNote && denyIndex >= 0 && !noteOpen && usable(denyIndex)) {
      const row = target.closest("[data-approval-row]");
      if (row ? row === rowRefs.current[denyIndex] : target === event.currentTarget && sel === denyIndex) {
        event.preventDefault();
        event.stopPropagation();
        openNote();
        return;
      }
    }
    if (/^[1-9]$/.test(event.key)) { pick(event, Number(event.key) - 1); return; }
    if (event.key === "Escape") { pick(event, options.findIndex((o) => o.role === "deny")); return; }
    // 한글 입력 상태에서도 같은 자리 키가 듣도록 key 가 아니라 물리 키(code)로 본다.
    if (event.code === "KeyY") { pick(event, options.findIndex((o) => o.role === "primary")); return; }
    if (event.code === "KeyN") { pick(event, options.findIndex((o) => o.role === "deny")); return; }
    if (event.key === "ArrowDown") { move(event, 1); return; }
    if (event.key === "ArrowUp") { move(event, -1); return; }
    if (deck && deck.total > 1 && event.key === "ArrowRight") { event.preventDefault(); deck.onNext(); return; }
    if (deck && deck.total > 1 && event.key === "ArrowLeft") { event.preventDefault(); deck.onPrev(); return; }
    // 행 단추에 포커스가 있으면 Enter 는 그 단추를 누른다. 카드 자체에 있을 때만 선택된 행을 확정한다.
    if (event.key === "Enter" && target === event.currentTarget) pick(event, sel);
  };

  const hintFor = (option: ApprovalPromptOption): string | null =>
    option.role === "primary" ? "Y" : option.role === "deny" ? "N · Esc" : null;

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      className={`tool-approval-chip${className ? ` ${className}` : ""}`}
      role="alertdialog"
      aria-live="assertive"
      aria-label={ariaLabel ?? question}
      data-ask-card="true"
      data-testid={testId}
      onKeyDown={onKeyDown}
      {...attrs}
    >
      <div className="tool-approval-chip-head">
        <strong className="tool-approval-chip-question">{question}</strong>
        {(deck && deck.total > 1) || trailing ? (
          <span className="tool-approval-chip-deck" data-approval-deck={deck && deck.total > 1 ? "true" : undefined}>
            {trailing && <span className="tool-approval-chip-trailing">{trailing}</span>}
            {deck && deck.total > 1 && (
              <>
                <span className="tool-approval-chip-count" aria-label={ko ? `${deck.total}건 중 ${deck.index + 1}번째` : `${deck.index + 1} of ${deck.total}`}>
                  {deck.index + 1}/{deck.total}
                </span>
                <button type="button" className="tool-approval-chip-step" data-approval-prev="true" onClick={deck.onPrev}
                  aria-label={ko ? "이전 승인" : "Previous approval"} title={ko ? "이전 승인 (←)" : "Previous approval (←)"}>‹</button>
                <button type="button" className="tool-approval-chip-step tool-approval-chip-step-next" data-approval-next="true" onClick={deck.onNext}
                  aria-label={ko ? "다음 승인" : "Next approval"} title={ko ? "다음 승인 (→)" : "Next approval (→)"}>{ko ? "다음" : "Next"} ›</button>
              </>
            )}
          </span>
        ) : null}
      </div>
      {code ? (
        <div className="tool-approval-chip-codewrap">
          {/* The box (background + padding) is a wrapper: padding inside a line-clamped element shows a sliver of the fifth line. */}
          <div className="tool-approval-chip-codebox">
            <pre ref={codeRef} className="tool-approval-chip-code" data-expanded={expanded ? "true" : "false"} tabIndex={expanded ? 0 : undefined}
              aria-label={codeLabel ?? (ko ? "실행될 내용" : "What will run")}><code>{code}</code></pre>
          </div>
          {(overflowing || expanded) && (
            <button type="button" className="tool-approval-chip-expand" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? (ko ? "접기" : "Collapse") : (ko ? "펼치기" : "Expand")}
            </button>
          )}
        </div>
      ) : null}
      {meta ? <div className="tool-approval-chip-meta">{meta}</div> : null}
      {warning ? <div className="tool-approval-chip-warning" role="note">{warning}</div> : null}
      <div className="tool-approval-chip-actions" role="group" aria-label={ko ? "승인 선택" : "Approval choices"}>
        {options.map((option, index) => {
          const hint = hintFor(option);
          return (
            <Fragment key={option.id}>
            <button
              ref={(node) => { rowRefs.current[index] = node; }}
              type="button"
              data-approval-row="true"
              data-ask-option={option.id}
              data-sel={sel === index ? "true" : "false"}
              data-active={sel === index ? "true" : "false"}
              className={`tool-approval-chip-action tool-approval-chip-action-${option.id.replace("allow_", "")}`}
              title={option.note}
              aria-label={option.note ? `${option.title}: ${option.note}` : option.title}
              aria-keyshortcuts={String(index + 1)}
              disabled={locked || option.disabled}
              onClick={() => choose(index)}
              onFocus={() => setSel(index)}
              onMouseEnter={() => { if (!locked && !option.disabled) setSel(index); }}
            >
              <span className="tool-approval-chip-key" aria-hidden>{index + 1}</span>
              <span className="tool-approval-chip-text">
                <span className="tool-approval-chip-action-title">{option.title}</span>
                {option.showNote && option.note ? <span className="tool-approval-chip-action-note">{option.note}</span> : null}
              </span>
              {hint ? <kbd className="tool-approval-chip-hint" aria-hidden>{hint}</kbd> : null}
            </button>
            {denyNote && index === denyIndex ? (
              noteOpen ? (
                <div className="tool-approval-chip-note" data-approval-note="open">
                  <input
                    ref={noteRef}
                    type="text"
                    className="tool-approval-chip-note-input"
                    data-approval-note-input="true"
                    value={noteText}
                    maxLength={APPROVAL_NOTE_MAX_CHARS}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={locked}
                    aria-busy={locked || undefined}
                    onChange={(event) => { setNoteText(event.target.value); rememberNote(event.target.value, true); }}
                    onCompositionStart={() => { composingRef.current = true; }}
                    onCompositionEnd={(event) => { composingRef.current = false; composedAtRef.current = event.timeStamp; }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        // 한글 조합을 확정하는 Enter(조합 중이거나, 조합이 막 끝난 직후의 같은 키)는 보내지 않는다.
                        if (event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current
                          || event.timeStamp - composedAtRef.current < 30) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (!locked) onChoose(options[denyIndex].id, cleanApprovalNote(noteText));
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeNote(true);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        rowRefs.current[denyIndex]?.focus();
                      }
                    }}
                  />
                  <kbd className="tool-approval-chip-hint" aria-hidden>Enter</kbd>
                </div>
              ) : (
                <button
                  type="button"
                  className="tool-approval-chip-note-open"
                  data-approval-note-open="true"
                  disabled={locked}
                  onClick={openNote}
                  title={noteLabel}
                >
                  <span className="tool-approval-chip-note-label">{noteLabel}</span>
                  <kbd className="tool-approval-chip-hint" aria-hidden>Tab</kbd>
                </button>
              )
            ) : null}
            </Fragment>
          );
        })}
      </div>
      {footer}
    </section>
  );
}
