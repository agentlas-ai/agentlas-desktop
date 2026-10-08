"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";

export default function FirmDetailPage() {
  return <Suspense fallback={null}><FirmWorkspaceRedirect /></Suspense>;
}

/** Preserve old team links while keeping file review in one workspace. */
function FirmWorkspaceRedirect() {
  const params = useSearchParams();
  const { locale } = useT();
  const id = params.get("id") ?? "";
  useEffect(() => {
    navigate(id ? `/library/agents?firmId=${encodeURIComponent(id)}` : "/library/agents", "replace");
  }, [id]);
  return <main role="status" style={{ minHeight: "100%", display: "grid", placeItems: "center", color: "var(--muted-deep)", fontSize: 13 }}>
    {locale === "ko" ? "에이전트 파일 여는 중…" : "Opening agent files…"}
  </main>;
}
