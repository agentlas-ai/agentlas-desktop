// 툴체인 관리 — 환경설정(MCP 밑). One이 부를 수 있게 만든 그래프와 반복 실행에서 배운 것.
// 답변의 툴체인 출처 칩은 ?automation=<id> 로 이 화면의 그 항목을 연다.
"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ToolchainsManager } from "@/components/toolchains/ToolchainsManager";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";

function ToolchainsPageInner() {
  const searchParams = useSearchParams();
  const { locale } = useT();
  return <ToolchainsManager api={ipc()?.toolchains} locale={locale} focusAutomationId={searchParams.get("automation")} />;
}

export default function LibraryToolchainsPage() {
  return (
    <Suspense fallback={null}>
      <ToolchainsPageInner />
    </Suspense>
  );
}
