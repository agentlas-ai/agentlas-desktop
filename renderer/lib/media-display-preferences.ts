"use client";

import { useCallback, useEffect, useState } from "react";

export type MediaDisplayKind = "image" | "video" | "audio";

export type MediaDisplayPreferences = Record<MediaDisplayKind, boolean>;

export const DEFAULT_MEDIA_DISPLAY_PREFERENCES: MediaDisplayPreferences = {
  image: true,
  video: true,
  audio: true,
};

const STORAGE_KEY = "agentlas.one.media-display.v1";
const CHANGE_EVENT = "agentlas:media-display-preferences";

function normalize(value: unknown): MediaDisplayPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_MEDIA_DISPLAY_PREFERENCES };
  const source = value as Partial<Record<MediaDisplayKind, unknown>>;
  return {
    image: source.image !== false,
    video: source.video !== false,
    audio: source.audio !== false,
  };
}

export function readMediaDisplayPreferences(): MediaDisplayPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_MEDIA_DISPLAY_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_MEDIA_DISPLAY_PREFERENCES };
  } catch {
    return { ...DEFAULT_MEDIA_DISPLAY_PREFERENCES };
  }
}

export function writeMediaDisplayPreferences(value: MediaDisplayPreferences): void {
  if (typeof window === "undefined") return;
  const next = normalize(value);
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* The in-memory setting still applies. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useMediaDisplayPreferences(): {
  preferences: MediaDisplayPreferences;
  setPreference: (kind: MediaDisplayKind, visible: boolean) => void;
} {
  const [preferences, setPreferences] = useState<MediaDisplayPreferences>(() => readMediaDisplayPreferences());

  useEffect(() => {
    const refresh = () => setPreferences(readMediaDisplayPreferences());
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, refresh);
    };
  }, []);

  const setPreference = useCallback((kind: MediaDisplayKind, visible: boolean) => {
    setPreferences((current) => {
      const next = { ...current, [kind]: visible };
      writeMediaDisplayPreferences(next);
      return next;
    });
  }, []);

  return { preferences, setPreference };
}
