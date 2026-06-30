"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function GeneratedAppPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/apps");
  }, [router]);

  return null;
}
