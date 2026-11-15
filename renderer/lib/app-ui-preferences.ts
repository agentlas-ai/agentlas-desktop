"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { appUiPreferenceDefinitions, normalizeAppUiPreference, type AppUiPreferenceName, type AppUiPreferences } from "@shared/app-ui-preferences";

export { appUiPreferenceDefinitions } from "@shared/app-ui-preferences";
const CHANGE_EVENT = "agentlas:ui-preference-changed";

/*
 * Preferences that belong to the signed-in person, not to the machine (Space's layout names conversations and their titles
 * show in tabs): their storage key carries the account's fingerprint, so a second account on the same computer never reads
 * the first one's list. The scope is set once the session is known (`setAppUiPreferenceScope`); until then the plain key is used.
 */
const SCOPED_PREFERENCES: ReadonlySet<AppUiPreferenceName> = new Set<AppUiPreferenceName>(["homeLayout"]);
const scopes = new Map<AppUiPreferenceName, string>();
const SAFE_SCOPE = /^[A-Za-z0-9_-]{1,64}$/;

export function appUiPreferenceStorageKey(name: AppUiPreferenceName): string {
  const base = appUiPreferenceDefinitions[name].storageKey;
  const scope = SCOPED_PREFERENCES.has(name) ? scopes.get(name) : undefined;
  return scope ? `${base}.${scope}` : base;
}

/** Sets (or clears) the account scope of a per-account preference. Returns the previous scope. */
export function setAppUiPreferenceScope(name: AppUiPreferenceName, scope: string | null): string | null {
  const before = scopes.get(name) ?? null;
  if (!SCOPED_PREFERENCES.has(name)) return before;
  if (scope && SAFE_SCOPE.test(scope)) scopes.set(name, scope); else scopes.delete(name);
  return before;
}

/**
 * The plain (pre-account) key's value moves to the current scope's key ONCE, and the plain key is removed - the first account
 * that signs in on this computer inherits what was there; nobody after it sees it. Nothing moves if the scoped key already has a value.
 */
export function claimLegacyAppUiPreference(name: AppUiPreferenceName): boolean {
  const legacyKey = appUiPreferenceDefinitions[name].storageKey;
  const scopedKey = appUiPreferenceStorageKey(name);
  if (legacyKey === scopedKey) return false;
  try {
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy === null) return false;
    if (window.localStorage.getItem(scopedKey) === null) window.localStorage.setItem(scopedKey, legacy);
    window.localStorage.removeItem(legacyKey);
    return true;
  } catch { return false; }
}

export function readAppUiPreference<K extends AppUiPreferenceName>(name: K): AppUiPreferences[K] {
  const definition = appUiPreferenceDefinitions[name];
  try {
    const raw = window.localStorage.getItem(appUiPreferenceStorageKey(name));
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
  const key = appUiPreferenceStorageKey(name);
  if (next === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, next);
  if (window.localStorage.getItem(key) !== next) throw new Error("app_ui_preference_write_unconfirmed");
  // Defer delivery out of React state updater callbacks used by existing drag handlers.
  queueMicrotask(() => window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { name } })));
  return readAppUiPreference(name);
}

export function subscribeAppUiPreference<K extends AppUiPreferenceName>(name: K, listener: (value: AppUiPreferences[K]) => void): () => void {
  const changed = (event: Event) => {
    if (event instanceof StorageEvent) {
      if (event.key !== null && event.key !== appUiPreferenceStorageKey(name)) return;
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
