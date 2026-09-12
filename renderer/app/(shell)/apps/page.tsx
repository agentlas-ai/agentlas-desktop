"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Legacy app links open the current project workspace. */
export default function AppsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/workspace");
  }, [router]);
  return null;
}
