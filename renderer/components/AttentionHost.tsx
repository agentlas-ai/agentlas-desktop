"use client";

import { useEffect } from "react";
import { ensureAttention } from "@/lib/attention";
import { ensureAskUserQueue } from "@/lib/ask-user-queue";

/**
 * 앱 루트에 한 번 — 전역 주의 저장소(파란 점·승인 대기 폴링·독 배지)와 러너 질문 대기열을
 * 라우트 트리와 무관하게 켜 둔다. 아무것도 그리지 않는다.
 */
export function AttentionHost() {
  useEffect(() => {
    ensureAskUserQueue();
    ensureAttention();
  }, []);
  return null;
}
