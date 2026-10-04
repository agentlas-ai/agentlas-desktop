"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconCheck, IconChevronDown, IconSearch } from "@/components/Icon";
import { OneAgentPortrait } from "./OneAgentPortrait";
import styles from "./OneAgentChoicePicker.module.css";

export interface OneAgentChoice {
  id: string;
  name: string;
  detail?: string;
  tone?: string;
}

/**
 * A searchable agent picker in the composer model menu's design.
 *
 * Owner 2026-10-04 (screenshot of 담당 교체): the replacement was a native <select> listing every installed agent —
 * no search, no faces, the OS menu's look. It opens in place below its trigger, so a scrolling sheet cannot clip it.
 * Escape closes the list only; the sheet behind it stays open. The app-wide focus ring and button hover wash are
 * opted out (data-focus-ring="wrapper", data-hover="own"): the panel draws its own, as the composer menu does.
 */
export function OneAgentChoicePicker({
  label,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  choices,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  choices: readonly OneAgentChoice[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = choices.find((choice) => choice.id === value) ?? null;
  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => needle ? choices.filter((choice) => `${choice.name} ${choice.detail ?? ""}`.toLocaleLowerCase().includes(needle)) : choices,
    [choices, needle],
  );
  const close = () => { setOpen(false); setQuery(""); };
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { setOpen(false); setQuery(""); }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={root}
      className={styles.picker}
      data-one-agent-picker="true"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.stopPropagation(); close(); }
      }}
    >
      <span className={styles.label}>{label}</span>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-hover="own"
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        data-open={open ? "true" : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {selected ? (
          <>
            <OneAgentPortrait status="quiet" label={selected.name} tone={selected.tone} size="small" />
            <span className={styles.triggerName}>{selected.name}</span>
          </>
        ) : <span className={styles.placeholder}>{placeholder}</span>}
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className={styles.panel}>
          <label className={styles.search}>
            <IconSearch size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} autoFocus aria-label={searchPlaceholder} data-focus-ring="wrapper" />
          </label>
          <div className={styles.divider} />
          <div className={styles.list} id={listId} role="listbox" aria-label={label}>
            {filtered.length === 0 ? <p className={styles.empty}>{emptyLabel}</p> : filtered.map((choice) => (
              <button
                type="button"
                role="option"
                aria-selected={choice.id === value}
                key={choice.id}
                className={styles.row}
                data-hover="own"
                data-selected={choice.id === value ? "true" : undefined}
                title={choice.detail}
                onClick={() => { onChange(choice.id); close(); }}
              >
                <OneAgentPortrait status="quiet" label={choice.name} tone={choice.tone} size="small" />
                <span className={styles.copy}><strong>{choice.name}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
                <span className={styles.meta} aria-hidden="true">{choice.id === value && <IconCheck size={14} />}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
