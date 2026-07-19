// 제품 루트는 One의 선제 Briefing으로 진입한다. 기존 작업공간은 좌상단
// 제품 전환 메뉴의 Work로 그대로 유지하며 같은 canonical Task를 연다.
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomeRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/one");
  }, [router]);

  return null;
}
