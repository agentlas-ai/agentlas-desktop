"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { openChatInSpace } from "@/lib/space-store";
import { isSafeId } from "@shared/space-layout";

/**
 * `/workspace?open=<chatId>` - the one address a notification, an approval banner or a link uses to put a conversation on screen:
 * Space opens (or brings forward) that chat's tab and the parameter is removed, so a reload does not open it again. A chat that
 * does not exist is dropped by Space's own check. The kind is read from the store by Space (a room draws as a room, a Work
 * session as Work), so the link does not need to know it.
 */
export function SpaceDeepLink() {
  const params = useSearchParams();
  const router = useRouter();
  const open = params.get("open");
  useEffect(() => {
    if (!open) return;
    if (isSafeId(open)) openChatInSpace({ chatId: open, kind: "room" }, "replace-pane");
    router.replace("/workspace");
  }, [open, router]);
  return null;
}
