import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "@/components/Icon";
import styles from "./OneBottomSheet.module.css";

export type OneBottomSheetSize = "compact" | "wide" | "full";

type OneBottomSheetProps = {
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  dialogRole?: "dialog" | "alertdialog";
  size?: OneBottomSheetSize;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  panelClassName?: string;
  bodyClassName?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  titleId?: string;
  description?: ReactNode;
  closeDisabled?: boolean;
  hideHeaderClose?: boolean;
  children: ReactNode;
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
 * inert/aria-hidden 원장 — 시트별 스냅샷 복원 금지.
 *
 * 시트 A가 열린 채 시트 B가 열리면 B의 스냅샷이 A가 설정한 inert="" 를
 * "원래 값"으로 캡처한다. A가 먼저 닫힌 뒤 B가 닫히며 그 스냅샷을 복원하면
 * inert 가 앱 루트에 잔류해 전 화면 입력 불능이 된다(D-3, 간헐).
 * 원본 속성은 아무 시트도 잡고 있지 않던 최초 획득 시점에만 기록하고,
 * 마지막 해제에서만 복원한다. 해제는 상태와 무관하게 무조건 실행된다.
 */
type InertLedgerRecord = { count: number; ariaHidden: string | null; inert: string | null };
const inertLedger = new WeakMap<HTMLElement, InertLedgerRecord>();

function acquireInert(element: HTMLElement) {
  const record = inertLedger.get(element);
  if (record) {
    record.count += 1;
    return;
  }
  inertLedger.set(element, {
    count: 1,
    ariaHidden: element.getAttribute("aria-hidden"),
    inert: element.getAttribute("inert"),
  });
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("inert", "");
}

function releaseInert(element: HTMLElement) {
  const record = inertLedger.get(element);
  if (!record) {
    // 원장에 없다 = 추적이 끊겼다. 잔류가 곧 앱 먹통이므로 무조건 벗긴다.
    element.removeAttribute("aria-hidden");
    element.removeAttribute("inert");
    return;
  }
  record.count -= 1;
  if (record.count > 0) return;
  inertLedger.delete(element);
  if (record.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", record.ariaHidden);
  if (record.inert === null) element.removeAttribute("inert");
  else element.setAttribute("inert", record.inert);
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * The single visual and interaction contract for One's floating dialogs.
 * The legacy component name stays for call-site compatibility, but the visual
 * surface is a centred modal with viewport breathing room, never a bottom
 * sheet. Content-specific dialogs provide only their body; geometry, scrim,
 * focus containment, and Escape handling live here.
 */
export function OneBottomSheet({
  open,
  onClose,
  closeLabel,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  dialogRole = "dialog",
  size = "wide",
  closeOnBackdrop = true,
  closeOnEscape = true,
  panelClassName,
  bodyClassName,
  eyebrow,
  title,
  titleId,
  description,
  closeDisabled = false,
  hideHeaderClose = false,
  children,
}: OneBottomSheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorBodyOverflow = document.body.style.overflow;
    const hiddenSiblings: HTMLElement[] = [];

    document.body.style.overflow = "hidden";

    // Keep the rest of the One surface out of the accessibility tree while the
    // modal is open. This also prevents background controls from being tabbed.
    // Start at the modal layer, not the dialog panel. The panel's sibling is
    // the backdrop button; marking that sibling inert made backdrop dismissal
    // look wired while silently preventing the click from firing.
    let branch: HTMLElement | null = dialog.parentElement ?? dialog;
    while (branch?.parentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
        hiddenSiblings.push(sibling);
        acquireInert(sibling);
      }
      branch = parent === document.body ? null : parent;
    }

    const focusTimer = window.setTimeout(() => dialog.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!closeOnEscape) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorBodyOverflow;
      for (const element of hiddenSiblings) releaseInert(element);
      if (priorFocus && document.contains(priorFocus)) priorFocus.focus();
    };
  }, [closeOnEscape, open]);

  if (!open) return null;

  return createPortal(
    <div className={styles.layer} role="presentation">
      <button
        className={styles.scrim}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => {
          if (closeOnBackdrop) onCloseRef.current();
        }}
      />
      <div
        ref={dialogRef}
        className={[styles.sheet, styles[size], panelClassName].filter(Boolean).join(" ")}
        data-one-modal={size}
        data-one-bottom-sheet={size}
        role={dialogRole}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy ?? titleId}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
      >
        {title !== undefined && (
          <header className={styles.header}>
            <div className={styles.headingCopy}>
              {eyebrow !== undefined && <p className={styles.eyebrow}>{eyebrow}</p>}
              <h2 id={titleId}>{title}</h2>
              {description !== undefined && <p className={styles.description}>{description}</p>}
            </div>
            {!hideHeaderClose && (
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => onCloseRef.current()}
                disabled={closeDisabled}
                aria-label={closeLabel}
              >
                <IconClose size={18} />
              </button>
            )}
          </header>
        )}
        <div
          className={[styles.body, bodyClassName].filter(Boolean).join(" ")}
          data-one-bottom-sheet-body="true"
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
