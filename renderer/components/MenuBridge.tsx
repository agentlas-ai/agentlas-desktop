// Electron 메뉴 → Next.js 라우터 브릿지.
// 메인 프로세스의 buildAppMenu가 webContents.send("menu:navigate", route)로 보냄.
// 라우트면 router.push, 특수 sentinel(__toggle_sidebar__ 등)은 별도 처리.
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface MenuBridge {
  onNavigate: (handler: (route: string) => void) => () => void;
}

declare global {
  interface Window {
    agentlasMenu?: MenuBridge;
  }
}

const SIDEBAR_COLLAPSE_KEY = "agentlas.sidebar.collapsed";

export function MenuBridge() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined" || !window.agentlasMenu) return;
    const off = window.agentlasMenu.onNavigate((route) => {
      if (route === "__toggle_sidebar__") {
        // 사이드바 컴포넌트의 localStorage 기반 토글을 flip + storage 이벤트로 알림
        try {
          const curr = window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1";
          window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, curr ? "0" : "1");
          window.dispatchEvent(new StorageEvent("storage", {
            key: SIDEBAR_COLLAPSE_KEY,
            newValue: curr ? "0" : "1",
          }));
        } catch {
          // ignore
        }
        return;
      }
      if (route === "__show_shortcuts__") {
        // V1: 단축키 다이얼로그. 지금은 alert로 대체.
        alert(
          [
            "⌘N  New chat",
            "⌘[  Toggle sidebar",
            "⌘,  Settings",
            "⌘↵  Send message",
            "⇧⌘M  Apps Store",
            "⇧⌘L  Apps",
            "Esc  Close popover",
          ].join("\n"),
        );
        return;
      }
      if (route.startsWith("/")) {
        router.push(route);
      }
    });
    return off;
  }, [router]);

  return null;
}
