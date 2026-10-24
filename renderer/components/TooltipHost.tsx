"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconSparkles } from "./Icon";
import styles from "./TooltipHost.module.css";

const TOOLTIP_ID = "agentlas-context-tooltip";
type Hint = { text: string; x: number; y: number; above: boolean };

/**
 * A control that opened something (a menu, a list, a popover) needs no hint: the hint would sit on top of what it
 * opened. The product switcher's hint ("Switch product") covered the One item of its own open list on Windows
 * (retests 2026-10-24) — removing the trigger's title on open did not help, because this host had already taken the
 * title over and kept showing its own copy.
 */
function hintSuppressed(target: Element): boolean {
  return target.getAttribute("aria-expanded") === "true";
}

/**
 * One visual tooltip for native title hints, including dynamically mounted controls.
 * The hint goes away when the control is pressed (pointer or Enter/Space) and does not come back for that control
 * until the pointer leaves it; it never shows, and is taken down, while the control is expanded.
 */
export function TooltipHost() {
  const [hint, setHint] = useState<Hint | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    if (!hint || !tooltipRef.current) return;
    const tooltip = tooltipRef.current;
    const bounds = tooltip.getBoundingClientRect();
    const halfWidth = bounds.width / 2;
    tooltip.style.left = `${Math.max(halfWidth + 12, Math.min(hint.x, window.innerWidth - halfWidth - 12))}px`;
    const top = hint.above ? hint.y - bounds.height : hint.y;
    tooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
    tooltip.style.transform = "translateX(-50%)";
  }, [hint]);
  useEffect(() => {
    let active: HTMLElement | null = null;
    let title = "";
    let originalTitle = "";
    let addedLabel = false;
    /** The active control was pressed: its hint stays down (title still held) until the pointer leaves it. */
    let pressed = false;
    /** What the current pointer press went down on; the focus that press moves is not a reason to show a hint. */
    let pressTarget: Node | null = null;
    let expandedWatch: MutationObserver | null = null;
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setHint(null);
    };
    const clear = () => {
      expandedWatch?.disconnect();
      expandedWatch = null;
      pressed = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (active) {
        if (!active.hasAttribute("title")) active.setAttribute("title", originalTitle);
        const descriptions = (active.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id && id !== TOOLTIP_ID);
        if (descriptions.length) active.setAttribute("aria-describedby", descriptions.join(" "));
        else active.removeAttribute("aria-describedby");
        if (addedLabel && active.getAttribute("aria-label") === title) active.removeAttribute("aria-label");
      }
      active = null;
      addedLabel = false;
      setHint(null);
    };
    const show = (target: HTMLElement, immediate: boolean, pressedNow = false) => {
      if (active === target || target.closest("[inert]")) return;
      clear();
      pressed = pressedNow;
      originalTitle = target.getAttribute("title") ?? "";
      title = originalTitle.trim();
      if (!title) return;
      active = target;
      const describedBy = target.getAttribute("aria-describedby");
      // Suppress the OS tooltip only while our accessible hint is active.
      target.removeAttribute("title");
      target.setAttribute("aria-describedby", [describedBy, TOOLTIP_ID].filter(Boolean).join(" "));
      if (!target.getAttribute("aria-label") && !target.getAttribute("aria-labelledby") && !target.textContent?.trim()) {
        target.setAttribute("aria-label", title);
        addedLabel = true;
      }
      // Expanding while hinted (keyboard, programmatic open) takes the hint down at once.
      if (typeof MutationObserver === "function") {
        expandedWatch = new MutationObserver(() => { if (active && hintSuppressed(active)) hide(); });
        expandedWatch.observe(target, { attributes: true, attributeFilter: ["aria-expanded"] });
      }
      const reveal = () => {
        if (!active || !active.isConnected || active.closest("[inert]")) { clear(); return; }
        if (pressed || hintSuppressed(active)) return;
        const bounds = active.getBoundingClientRect();
        const above = bounds.top > 96;
        setHint({ text: title, x: Math.max(12, Math.min(bounds.left + bounds.width / 2, window.innerWidth - 12)), y: above ? bounds.top - 8 : bounds.bottom + 8, above });
      };
      if (immediate) reveal();
      else timer.current = setTimeout(reveal, 350);
    };
    const over = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (active?.contains(event.target)) return;
      const target = event.target.closest<HTMLElement>("[title]");
      if (target) show(target, false);
      else clear();
    };
    const out = (event: PointerEvent) => {
      if (active && (!(event.relatedTarget instanceof Node) || !active.contains(event.relatedTarget))) clear();
    };
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>("[title]");
      if (target) show(target, true, pressTarget !== null && target.contains(pressTarget));
      else if (!active?.contains(event.target)) clear();
    };
    const press = (event: PointerEvent) => {
      pressTarget = event.target instanceof Node ? event.target : null;
      if (!active || !pressTarget || !active.contains(pressTarget)) return;
      pressed = true;
      hide();
    };
    const release = () => { pressTarget = null; };
    const key = (event: KeyboardEvent) => {
      pressTarget = null;
      if (event.key === "Escape") { clear(); return; }
      if ((event.key === "Enter" || event.key === " ") && active && event.target instanceof Node && active.contains(event.target)) {
        pressed = true;
        hide();
      }
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", clear);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      clear();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", clear);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, []);
  return hint ? createPortal(<div ref={tooltipRef} id={TOOLTIP_ID} role="tooltip" className={styles.hint} data-above={hint.above || undefined}
    style={{ left: hint.x, top: hint.y }}><IconSparkles size={14} /><span>{hint.text}</span></div>, document.body) : null;
}
