"use client";

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { Ref, TextareaHTMLAttributes } from "react";

export type OneComposerValue = string | ((current: string) => string);

export interface OneComposerInputHandle {
  getValue(): string;
  setValue(value: OneComposerValue): void;
  /** Move the native editor before navigation commits or another insertion runs. */
  switchScope(scopeKey: string, explicitValue?: string): void;
  /** Clear only the accepted prompt when a receipt may arrive after further editing. */
  clear(expectedValue?: string): boolean;
  flushDraft(): void;
  focus(options?: FocusOptions): void;
  readonly element: HTMLTextAreaElement | null;
}

export interface OneComposerInputProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onSubmit" | "onCompositionStart" | "onCompositionEnd"> {
  scopeKey: string;
  readDraft(scopeKey: string): string;
  writeDraft(scopeKey: string, value: string): void;
  /** Synchronous scoped restore; may carry the next draft into a newly created chat. */
  resolveScopeValue?(nextKey: string, previousKey: string, currentValue: string): string;
  /** Update refs here; parent state should change only for semantic boundaries. */
  onValueChange?(value: string, scopeKey: string): void;
  onSubmit(value: string): void;
  inputRef?: Ref<HTMLTextAreaElement>;
}

function assignInputRef(ref: Ref<HTMLTextAreaElement> | undefined, input: HTMLTextAreaElement | null) {
  if (typeof ref === "function") ref(input);
  else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = input;
}

/** Native editing never schedules a React render of the surrounding conversation. */
export const OneComposerInput = memo(forwardRef<OneComposerInputHandle, OneComposerInputProps>(function OneComposerInput(props, ref) {
  const { scopeKey, readDraft, writeDraft, resolveScopeValue, onValueChange, onSubmit, inputRef,
    onKeyDown, onBlur, rows = 1, ...textareaProps } = props;
  const callbacks = useRef(props);
  // A concurrent render may be abandoned. Native edits must use the last
  // committed handlers, never a submit closure from that unfinished render.
  useLayoutEffect(() => { callbacks.current = props; });
  const initial = useRef<{ key: string; value: string } | null>(null);
  if (!initial.current) initial.current = { key: scopeKey, value: readDraft(scopeKey) };
  const scope = useRef(initial.current.key);
  const value = useRef(initial.current.value);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const dirty = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizeFrame = useRef<number | null>(null);
  const composing = useRef(false);
  const compositionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getValue = useCallback(() => input.current?.value ?? value.current, []);
  const flushDraft = useCallback(() => {
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    if (!dirty.current) return;
    value.current = getValue();
    callbacks.current.writeDraft(scope.current, value.current);
    dirty.current = false;
  }, [getValue]);
  const resize = useCallback(() => {
    const element = input.current;
    if (!element) return;
    const height = element.value.split("\n").length * 24;
    element.style.height = `${Math.max(24, Math.min(height, 210))}px`;
    element.style.overflowY = height > 210 ? "auto" : "hidden";
  }, []);
  const scheduleResize = useCallback(() => {
    if (sizeFrame.current !== null) return;
    sizeFrame.current = requestAnimationFrame(() => { sizeFrame.current = null; resize(); });
  }, [resize]);
  const publish = useCallback((next: string, immediate: boolean) => {
    value.current = next;
    dirty.current = true;
    // Publish before notifying Shell: a receipt callback can synchronously inspect this value.
    if (immediate) flushDraft();
    else {
      if (draftTimer.current !== null) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(flushDraft, 150);
    }
    callbacks.current.onValueChange?.(next, scope.current);
    scheduleResize();
  }, [flushDraft, scheduleResize]);
  const setValue = useCallback((update: OneComposerValue) => {
    const next = typeof update === "function" ? update(getValue()) : update;
    if (input.current) input.current.value = next;
    publish(next, true);
  }, [getValue, publish]);
  const switchScope = useCallback((nextKey: string, explicitValue?: string) => {
    const previousKey = scope.current;
    const previousValue = getValue();
    flushDraft();
    const next = explicitValue !== undefined ? explicitValue
      : callbacks.current.resolveScopeValue
        ? callbacks.current.resolveScopeValue(nextKey, previousKey, previousValue)
        : callbacks.current.readDraft(nextKey);
    scope.current = nextKey;
    if (input.current) input.current.value = next;
    composing.current = false;
    if (compositionTimer.current !== null) clearTimeout(compositionTimer.current);
    compositionTimer.current = null;
    publish(next, true);
  }, [getValue, flushDraft, publish]);
  useImperativeHandle(ref, () => ({
    getValue, setValue, switchScope, flushDraft,
    clear(expectedValue) {
      if (expectedValue !== undefined && getValue() !== expectedValue) return false;
      setValue("");
      return true;
    },
    focus(options) { input.current?.focus(options); },
    get element() { return input.current; },
  }), [getValue, setValue, switchScope, flushDraft]);

  const mountInput = useCallback((element: HTMLTextAreaElement | null) => {
    // Capture native edits before React detaches the node during unmount.
    if (!element && input.current) value.current = input.current.value;
    input.current = element;
    assignInputRef(callbacks.current.inputRef, element);
  }, []);
  useLayoutEffect(() => {
    if (scope.current !== scopeKey) {
      switchScope(scopeKey);
    } else {
      callbacks.current.onValueChange?.(getValue(), scope.current);
    }
    resize();
  }, [scopeKey, getValue, switchScope, resize]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") flushDraft(); };
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      flushDraft();
      if (sizeFrame.current !== null) cancelAnimationFrame(sizeFrame.current);
      if (compositionTimer.current !== null) clearTimeout(compositionTimer.current);
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushDraft]);

  return <textarea
    {...textareaProps}
    ref={mountInput}
    rows={rows}
    defaultValue={initial.current.value}
    onChange={event => publish(event.currentTarget.value, false)}
    onCompositionStart={() => {
      if (compositionTimer.current !== null) clearTimeout(compositionTimer.current);
      composing.current = true;
    }}
    onCompositionEnd={() => {
      // Chromium sends compositionend before its committing Enter keydown.
      compositionTimer.current = setTimeout(() => { composing.current = false; compositionTimer.current = null; }, 0);
    }}
    onBlur={event => { composing.current = false; flushDraft(); callbacks.current.onBlur?.(event); }}
    onKeyDown={event => {
      callbacks.current.onKeyDown?.(event);
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (composing.current) return;
      flushDraft();
      callbacks.current.onSubmit(event.currentTarget.value);
    }}
  />;
}));
