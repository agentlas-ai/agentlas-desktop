// Words and key glyphs that differ by operating system. Windows users saw macOS names and glyphs
// (⌘, ↵, "Keychain", "Finder") in the Korean and English UI (Windows audit 2026-10-24, ui.md #14).
// The platform comes from the same signal as layout.tsx's data-platform bootstrap.
import { useEffect, useState } from "react";

export type UiPlatform = "macos" | "windows" | "linux";

export function uiPlatform(nav: { platform?: string; userAgent?: string } | undefined =
  typeof navigator === "undefined" ? undefined : navigator): UiPlatform {
  const platform = nav?.platform ?? "";
  const ua = nav?.userAgent ?? "";
  if (/Win32|Win64|Windows/i.test(`${platform} ${ua}`)) return "windows";
  if (/Mac/i.test(platform)) return "macos";
  return "linux";
}

/**
 * The platform for text rendered on first paint. Pages are prerendered without a navigator, so the first
 * render uses the macOS words (what the static HTML holds) and switches after mount: no hydration mismatch.
 */
export function useUiPlatform(): UiPlatform {
  const [platform, setPlatform] = useState<UiPlatform>("macos");
  useEffect(() => { setPlatform(uiPlatform()); }, []);
  return platform;
}

/** Where the OS keeps secrets: macOS Keychain, Windows Credential Manager, Linux keyring. */
export function credentialStoreName(ko: boolean, platform: UiPlatform = uiPlatform()): string {
  if (platform === "windows") return ko ? "Windows 자격 증명 관리자" : "Windows Credential Manager";
  if (platform === "linux") return ko ? "시스템 키링" : "system keyring";
  return ko ? "키체인" : "Keychain";
}

/** The file manager: Finder, File Explorer, or the desktop's file manager. */
export function fileManagerName(ko: boolean, platform: UiPlatform = uiPlatform()): string {
  if (platform === "windows") return ko ? "파일 탐색기" : "File Explorer";
  if (platform === "linux") return ko ? "파일 관리자" : "the file manager";
  return "Finder";
}

/** A shortcut as this OS writes it: "⌘P" / "⌘↵" on macOS, "Ctrl+P" / "Ctrl+Enter" elsewhere. */
export function shortcutLabel(key: string, platform: UiPlatform = uiPlatform()): string {
  if (platform === "macos") return `⌘${key === "Enter" ? "↵" : key}`;
  return `Ctrl+${key}`;
}
