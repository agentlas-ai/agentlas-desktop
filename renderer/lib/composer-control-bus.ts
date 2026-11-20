/*
 * The controls a composer can open on request (a button that appears must do something). A receipt card's button "Send through another AI" or
 * "Raise the permission" belongs to the conversation's composer, not to the card: the composer that is mounted for a conversation REGISTERS what it can open, the card reads the
 * registry, and a button whose control is not registered on this surface is not drawn. Nothing is stored; the registry is the mounted composers and nothing else.
 *
 *   registerComposerControls(chatId, controls)  -> unregister   (a composer's effect; the cleanup removes it)
 *   useComposerControls(chatId)                 the merged controls of that conversation (the latest registrant wins; a stable object until a registration changes)
 */
import { useSyncExternalStore } from "react";

export interface ComposerControls {
  /** Open the picker that chooses which AI runs the next send (the model chip's menu). */
  openRuntimePicker?: () => void;
  /** Open the conversation's permission control. */
  openPermission?: () => void;
}

const registrants = new Map<string, Map<symbol, ComposerControls>>();
const merged = new Map<string, ComposerControls>();
const listeners = new Set<() => void>();
const NONE: ComposerControls = Object.freeze({});

function rebuild(chatId: string): void {
  const all = registrants.get(chatId);
  if (!all || all.size === 0) { registrants.delete(chatId); merged.delete(chatId); return; }
  const next: ComposerControls = {};
  for (const controls of all.values()) {
    if (controls.openRuntimePicker) next.openRuntimePicker = controls.openRuntimePicker;
    if (controls.openPermission) next.openPermission = controls.openPermission;
  }
  merged.set(chatId, next);
}

export function registerComposerControls(chatId: string | null | undefined, controls: ComposerControls): () => void {
  if (!chatId) return () => undefined;
  const token = Symbol("composer-controls");
  const all = registrants.get(chatId) ?? new Map<symbol, ComposerControls>();
  all.set(token, controls);
  registrants.set(chatId, all);
  rebuild(chatId);
  for (const listener of [...listeners]) listener();
  return () => {
    const current = registrants.get(chatId);
    if (!current?.delete(token)) return;
    rebuild(chatId);
    for (const listener of [...listeners]) listener();
  };
}

export function composerControlsOf(chatId: string | null | undefined): ComposerControls {
  return (chatId ? merged.get(chatId) : undefined) ?? NONE;
}

export function useComposerControls(chatId: string | null | undefined): ComposerControls {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => composerControlsOf(chatId),
    () => composerControlsOf(chatId),
  );
}
