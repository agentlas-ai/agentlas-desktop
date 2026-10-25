"use client";
// OS-specific words inside running text (Windows audit 2026-10-24, ui.md #14): "키체인" on macOS,
// "Windows 자격 증명 관리자" on Windows, "시스템 키링" on Linux. Renders the macOS word on first paint
// (prerendered HTML) and switches after mount (lib/platform-copy.ts useUiPlatform).
import { credentialStoreName, useUiPlatform } from "@/lib/platform-copy";

export function CredentialStoreWord({ ko }: { ko: boolean }) {
  const platform = useUiPlatform();
  return <>{credentialStoreName(ko, platform)}</>;
}
