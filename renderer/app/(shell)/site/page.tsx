"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Retired Site Studio links return to the current project workspace. */
export default function SitePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/workspace");
  }, [router]);
  return null;
}
