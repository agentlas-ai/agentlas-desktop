// 데스크톱 시작 화면은 기존 작업공간인 Work로 진입한다.
// One은 좌상단 제품 전환 메뉴에서 명시적으로 열 수 있다.
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
