"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Legacy Agent Apps entry now resolves to the only public app surface: Sites. */
export default function AppsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/site");
  }, [router]);
  return null;
}
