"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./GraphWorkspace.module.css";

/** Visible geometry, named controls: tooltips and keyboard names stay available. */
export function GraphControl({ label, icon, primary, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string; icon: ReactNode; primary?: boolean;
}) {
  return <button {...props} type={props.type ?? "button"} aria-label={label} title={props.title ?? label}
    className={`titlebar-nodrag ${styles.control} ${primary ? styles.primary : ""} ${props.className ?? ""}`}>
    {icon}
  </button>;
}
