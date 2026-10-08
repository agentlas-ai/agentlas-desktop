// Independent Toolchain assets. Source links resolve asset IDs; legacy graph links stay explicit.
"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ToolchainsManager } from "@/components/toolchains/ToolchainsManager";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";

function ToolchainsPageInner() {
  const searchParams = useSearchParams();
  const { locale } = useT();
  const version = Number(searchParams.get("version"));
  const focusVersionNumber = Number.isSafeInteger(version) && version > 0 ? version : null;
  return <ToolchainsManager api={ipc()?.toolchains} locale={locale} focusAssetId={searchParams.get("asset")} focusVersionNumber={focusVersionNumber} focusAutomationId={searchParams.get("automation")} />;
}

export default function LibraryToolchainsPage() {
  return (
    <Suspense fallback={null}>
      <ToolchainsPageInner />
    </Suspense>
  );
}
