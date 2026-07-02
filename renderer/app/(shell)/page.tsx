// 홈(/)은 대시보드로 보내는 리다이렉터.
// 첫 화면 = 대시보드. 예전 composer 홈("오늘 뭐 도와드릴까요?")은 비활성 — 새 채팅은 사이드바/대시보드에서.
// 온보딩 플로우는 제거됨 — 신규 유저 안내는 대시보드 퀘스트 보드(QuestBoard)가 담당한다.
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomeRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);

  return null;
}
