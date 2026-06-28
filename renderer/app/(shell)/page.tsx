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
      // 첫 실행 마법사를 완료(또는 건너뛰기)하지 않았으면 → /onboarding.
      // 완료했다면 런타임 0개여도 대시보드로 보낸다(무한 온보딩 루프 방지). LLM 연결은
      // 온보딩의 살아있는 가이드 단계와 대시보드 상시 가이드가 유도한다.
      try {
        if (window.localStorage.getItem("agentlas.onboarded") !== "1") {
          router.replace("/onboarding");
          return;
        }
      } catch {
        // localStorage 불가 — 계속 진행
      }
      router.replace("/dashboard");
    })();
  }, [router]);

  return null;
}
