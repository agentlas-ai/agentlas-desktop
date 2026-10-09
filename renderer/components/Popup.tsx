"use client";

import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { IconCheck, IconChevronDown } from "./Icon";
import { OneBottomSheet, type OneBottomSheetSize } from "./one/OneBottomSheet";
import styles from "./Popup.module.css";

/** Shared compact modal; uses the same focus, stacking and inert ledger as One. */
export function PopupFrame({ title, icon, closeLabel, onClose, children, footer, description, size = "compact", busy = false, role = "dialog", dataAttributes, ariaDescribedBy }: {
  title: ReactNode;
  icon?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  description?: ReactNode;
  size?: OneBottomSheetSize;
  busy?: boolean;
  role?: "dialog" | "alertdialog";
  dataAttributes?: Record<`data-${string}`, string | boolean | undefined>;
  ariaDescribedBy?: string;
}) {
  const titleId = useId();
  return <OneBottomSheet open onClose={onClose} closeLabel={closeLabel} title={title} titleId={titleId}
    icon={icon} description={description} size={size} dialogRole={role} closeDisabled={busy}
    closeOnBackdrop={!busy} closeOnEscape={!busy} panelClassName={styles.frame}
    bodyClassName={styles.body} footer={footer} dataAttributes={dataAttributes} ariaDescribedBy={ariaDescribedBy}>
    {children}
  </OneBottomSheet>;
}

export function PopupAction({ icon, primary, danger, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode; primary?: boolean; danger?: boolean;
}) {
  return <button {...props} type={props.type ?? "button"} className={[styles.action, props.className].filter(Boolean).join(" ")}
    data-primary={primary || undefined} data-danger={danger || undefined}>
    {icon && <span aria-hidden="true">{icon}</span>}{children}
  </button>;
}

export function PopupFacts({ items }: { items: Array<{ label: string; value?: ReactNode; icon?: ReactNode }> }) {
  return <dl className={styles.facts}>{items.map((item, index) => <div className={styles.fact} key={index}>
    <span className={styles.factIcon} aria-hidden="true">{item.icon ?? <IconCheck size={17} />}</span>
    <dt>{item.label}</dt>{item.value !== undefined && <dd>{item.value}</dd>}
  </div>)}</dl>;
}

export function PopupSteps({ steps }: { steps: Array<{ label: string; icon: ReactNode; active?: boolean }> }) {
  return <ol className={styles.steps}>{steps.map((step, index) => <li key={index} data-active={step.active || undefined}>
    <span className={styles.stepIcon} aria-hidden="true">{step.icon}</span><span>{step.label}</span>
  </li>)}</ol>;
}

export function PopupDetails({ label, children }: { label: string; children: ReactNode }) {
  return <details className={styles.details}><summary><span>{label}</span><IconChevronDown size={15} /></summary>
    <div>{children}</div>
  </details>;
}
