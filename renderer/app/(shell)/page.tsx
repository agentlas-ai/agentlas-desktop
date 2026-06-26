// 홈(/)은 대시보드로 보내는 리다이렉터.
// 첫 화면 = 대시보드. 예전 composer 홈("오늘 뭐 도와드릴까요?")은 비활성 — 새 채팅은 사이드바/대시보드에서.
// 첫 실행(미온보딩)·런타임 미연결이면 온보딩으로.
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";

export default function HomeRedirect() {
  const router = useRouter();

  useEffect(() => {
    const api = ipc();
    if (!api) {
      router.replace("/dashboard");
      return;
    }
    void (async () => {
      // 1) 첫 실행 마법사를 완료하지 않았으면 → /onboarding
      try {
        if (window.localStorage.getItem("agentlas.onboarded") !== "1") {
          router.replace("/onboarding");
          return;
        }
      } catch {
        // localStorage 불가 — 계속 진행
      }
      // 2) 백엔드(LLM) 0개면 → /onboarding (백엔드 단계)
      try {
        const runtimes = await api.runtime.detect();
        if (runtimes.length === 0) {
          router.replace("/onboarding");
          return;
        }
      } catch {
        // 감지 실패 — 대시보드로 진행
      }
      // 3) 그 외에는 대시보드로
      router.replace("/dashboard");
    })();
  }, [router]);

  return null;
}
