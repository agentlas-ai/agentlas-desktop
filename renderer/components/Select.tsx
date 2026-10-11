"use client";

import {
  Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ChangeEvent, type ReactElement, type ReactNode, type Ref,
} from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "./Icon";
import styles from "./Select.module.css";

type Item = { kind: "option"; value: string; label: ReactNode; disabled: boolean } | { kind: "group"; label: string };

function collect(nodes: ReactNode, out: Item[]): void {
  Children.forEach(nodes, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<{ value?: string | number; disabled?: boolean; label?: string; children?: ReactNode }>;
    if (element.type === Fragment) { collect(element.props.children, out); return; }
    if (element.type === "optgroup") {
      out.push({ kind: "group", label: String(element.props.label ?? "") });
      collect(element.props.children, out);
      return;
    }
    if (element.type === "option") {
      const text = element.props.children;
      const value = element.props.value ?? (typeof text === "string" || typeof text === "number" ? text : "");
      out.push({ kind: "option", value: String(value), label: text, disabled: Boolean(element.props.disabled) });
    }
  });
}

export interface SelectProps {
  value?: string | number;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  id?: string;
  title?: string;
  name?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
  selectRef?: Ref<HTMLButtonElement>;
  [data: `data-${string}`]: string | boolean | undefined;
}

/**
 * 앱 전체의 드롭다운. 네이티브 <select> 의 OS 팝업 대신 디자인된 목록을 쓴다.
 * 쓰는 법은 <select> 와 같다(value·onChange·<option>·<optgroup>), onChange 는 target.value 를 준다.
 */
export function Select(props: SelectProps) {
  const { value, onChange, children, className, style, disabled, id, title, name, autoFocus, selectRef, ...rest } = props;
  const items = useMemo(() => { const out: Item[] = []; collect(children, out); return out; }, [children]);
  const options = items.filter((item): item is Extract<Item, { kind: "option" }> => item.kind === "option");
  const current = options.find((option) => option.value === String(value ?? ""));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const setTrigger = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (typeof selectRef === "function") selectRef(node);
    else if (selectRef) (selectRef as { current: HTMLButtonElement | null }).current = node;
  }, [selectRef]);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const up = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(320, up ? above : below));
    const width = Math.max(rect.width, 160);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    setBox({ left, top: up ? rect.top - 4 : rect.bottom + 4, width, maxHeight, up });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  const close = useCallback((restore = true) => { setOpen(false); if (restore) triggerRef.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) { event.stopPropagation(); event.preventDefault(); close(); }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, close, place]);
  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, options.findIndex((option) => option.value === String(value ?? "")));
    setActive(index);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && active >= 0) menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const choose = (next: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (next === String(value ?? "")) return;
    const target = { value: next, name: name ?? "" };
    onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
  };
  const move = (delta: number) => {
    if (!options.length) return;
    let index = active;
    for (let i = 0; i < options.length; i += 1) {
      index = (index + delta + options.length) % options.length;
      if (!options[index].disabled) break;
    }
    setActive(index);
  };
  const onTriggerKey = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) { event.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const option = options[active]; if (option && !option.disabled) choose(option.value); }
    else if (event.key === "Tab") setOpen(false);
  };

  let optionIndex = -1;
  const label = current?.label ?? "";
  return <>
    <button ref={setTrigger} type="button" id={id} title={title} name={name} autoFocus={autoFocus} disabled={disabled}
      className={`${styles.trigger}${className ? ` ${className}` : ""}`} style={style}
      role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-label={rest["aria-label"]} data-select="true" data-value={String(value ?? "")}
      {...Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith("data-")))}
      onClick={() => { if (!disabled) setOpen((previous) => !previous); }} onKeyDown={onTriggerKey}>
      <span className={styles.label}>{label}</span>
      <IconChevronDown size={14} />
    </button>
    {open && box && createPortal(
      <div ref={menuRef} id={listId} role="listbox" className={styles.menu} data-select-menu="true"
        style={{ left: box.left, top: box.top, minWidth: box.width, maxHeight: box.maxHeight, transform: box.up ? "translateY(-100%)" : undefined }}>
        {items.map((item, position) => {
          if (item.kind === "group") return <div key={`g${position}`} className={styles.group} role="presentation">{item.label}</div>;
          optionIndex += 1;
          const index = optionIndex;
          const selected = item.value === String(value ?? "");
          return <div key={`${item.value}:${position}`} role="option" aria-selected={selected} aria-disabled={item.disabled || undefined}
            data-index={index} data-active={index === active ? "true" : undefined} className={styles.option}
            onPointerMove={() => { if (!item.disabled) setActive(index); }}
            onClick={() => { if (!item.disabled) choose(item.value); }}>
            <span className={styles.optionLabel}>{item.label}</span>
            {selected && <IconCheck size={14} />}
          </div>;
        })}
      </div>, document.body)}
  </>;
}
