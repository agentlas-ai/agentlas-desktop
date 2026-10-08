"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { appUiPreferenceDefinitions, normalizeAppUiPreference, type AppUiPreferenceName, type AppUiPreferences } from "@shared/app-ui-preferences";

export { appUiPreferenceDefinitions } from "@shared/app-ui-preferences";
const CHANGE_EVENT = "agentlas:ui-preference-changed";

export function readAppUiPreference<K extends AppUiPreferenceName>(name: K): AppUiPreferences[K] {
  const definition = appUiPreferenceDefinitions[name];
  try {
    const raw = window.localStorage.getItem(definition.storageKey);
    if (raw !== null) return normalizeAppUiPreference(name, definition.encoding === "json" ? JSON.parse(raw) : raw);
  } catch { /* A malformed preference uses its existing product default. */ }
  return structuredClone(definition.defaultValue) as AppUiPreferences[K];
}

export function readAppUiPreferences(): AppUiPreferences {
  return Object.fromEntries((Object.keys(appUiPreferenceDefinitions) as AppUiPreferenceName[])
    .map((name) => [name, readAppUiPreference(name)])) as unknown as AppUiPreferences;
}

export function writeAppUiPreference<K extends AppUiPreferenceName>(name: K, value: unknown): AppUiPreferences[K] {
  const normalized = normalizeAppUiPreference(name, value);
  const definition = appUiPreferenceDefinitions[name];
  const next = normalized === null ? null : definition.encoding === "json" ? JSON.stringify(normalized) : String(normalized);
  if (next === null) window.localStorage.removeItem(definition.storageKey);
  else window.localStorage.setItem(definition.storageKey, next);
  if (window.localStorage.getItem(definition.storageKey) !== next) throw new Error("app_ui_preference_write_unconfirmed");
  // Defer delivery out of React state updater callbacks used by existing drag handlers.
  queueMicrotask(() => window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { name } })));
  return readAppUiPreference(name);
}

export function subscribeAppUiPreference<K extends AppUiPreferenceName>(name: K, listener: (value: AppUiPreferences[K]) => void): () => void {
  const changed = (event: Event) => {
    if (event instanceof StorageEvent) {
      if (event.key !== null && event.key !== appUiPreferenceDefinitions[name].storageKey) return;
    } else if ((event as CustomEvent<{ name?: string }>).detail?.name !== name) return;
    listener(readAppUiPreference(name));
  };
  window.addEventListener(CHANGE_EVENT, changed);
  window.addEventListener("storage", changed);
  return () => { window.removeEventListener(CHANGE_EVENT, changed); window.removeEventListener("storage", changed); };
}

/** A local control and app-control share the same state without mount-time writes overwriting persisted values. */
export function useAppUiPreference<K extends AppUiPreferenceName>(name: K): [AppUiPreferences[K], (next: SetStateAction<AppUiPreferences[K]>) => void] {
  const [value, setValue] = useState<AppUiPreferences[K]>(() => structuredClone(appUiPreferenceDefinitions[name].defaultValue) as AppUiPreferences[K]);
  const currentValue = useRef(value);
  useEffect(() => {
    const apply = (next: AppUiPreferences[K]) => { currentValue.current = next; setValue(next); };
    apply(readAppUiPreference(name));
    return subscribeAppUiPreference(name, apply);
  }, [name]);
  const update = useCallback((next: SetStateAction<AppUiPreferences[K]>) => {
    const value = typeof next === "function" ? (next as (current: AppUiPreferences[K]) => AppUiPreferences[K])(currentValue.current) : next;
    let applied: AppUiPreferences[K];
    try { applied = writeAppUiPreference(name, value); }
    catch { applied = normalizeAppUiPreference(name, value); }
    currentValue.current = applied;
    setValue(applied);
  }, [name]);
  return [value, update];
}
