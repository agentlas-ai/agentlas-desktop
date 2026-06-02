// /library → Apps 런처로
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LibraryIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/apps");
  }, [router]);
  return null;
}
