// /library → Library 기본 목록으로
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LibraryIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/library/agents");
  }, [router]);
  return null;
}
