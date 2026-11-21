"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The project page is retired: a project's tasks open in the Workspace's panes, with the same composer as every other chat. An old link to it
 * (a restored window, a saved address) lands in the Workspace instead of on the page that opened the Work cockpit with its own, different composer.
 */
export default function ProjectDetailRetiredPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/workspace");
  }, [router]);
  return null;
}
