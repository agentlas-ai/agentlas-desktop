import { useEffect, useRef, type ReactNode } from "react";
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

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * The single visual and interaction contract for One's modal bottom sheets.
 * Content-specific sheets should provide only their body; geometry, scrim,
 * focus containment, Escape handling, and mobile anchoring live here.
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
    const hiddenSiblings: Array<{ element: HTMLElement; ariaHidden: string | null; inert: string | null }> = [];

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
        hiddenSiblings.push({
          element: sibling,
          ariaHidden: sibling.getAttribute("aria-hidden"),
          inert: sibling.getAttribute("inert"),
        });
        sibling.setAttribute("aria-hidden", "true");
        sibling.setAttribute("inert", "");
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
      for (const record of hiddenSiblings.reverse()) {
        if (record.ariaHidden === null) record.element.removeAttribute("aria-hidden");
        else record.element.setAttribute("aria-hidden", record.ariaHidden);
        if (record.inert === null) record.element.removeAttribute("inert");
        else record.element.setAttribute("inert", record.inert);
      }
      if (priorFocus && document.contains(priorFocus)) priorFocus.focus();
    };
  }, [closeOnEscape, open]);

  if (!open) return null;

  return (
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
        data-one-bottom-sheet={size}
        role={dialogRole}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy ?? titleId}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
      >
        <div className={styles.handle} aria-hidden="true" />
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
    </div>
  );
}
