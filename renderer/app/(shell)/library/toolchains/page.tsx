// Toolchain assets: MCP tools for apps and web pages once operated by hand. Source links resolve asset IDs.
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
  return <ToolchainsManager api={ipc()?.toolchains} locale={locale} focusAssetId={searchParams.get("asset")} focusVersionNumber={focusVersionNumber} />;
}

export default function LibraryToolchainsPage() {
  return (
    <Suspense fallback={null}>
      <ToolchainsPageInner />
    </Suspense>
  );
}
