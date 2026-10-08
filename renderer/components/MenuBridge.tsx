// Electron 메뉴 → Next.js 라우터 브릿지.
// 메인 프로세스의 buildAppMenu가 webContents.send("menu:navigate", route)로 보냄.
// 라우트면 router.push, 특수 sentinel(__toggle_sidebar__ 등)은 별도 처리.
"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useT, type LocalePref } from "@/lib/i18n";
import { DARK_THEME_ENABLED, useTheme, type ThemePref } from "@/lib/theme";
import { installAppControlRenderer, setAppSidebarCollapsed, SIDENAV_COLLAPSE_KEY } from "@/lib/app-control-bridge";
import { readMediaDisplayPreferences, writeMediaDisplayPreferences, type MediaDisplayKind } from "@/lib/media-display-preferences";
import { readWorkSidebarWidth, clampWorkSidebarWidth, setWorkSidebarWidth } from "@/lib/work-sidebar-width";
import type { AppControlRendererState } from "@shared/app-control";
import { isAppUiPreferenceName } from "@shared/app-ui-preferences";
import { readAppUiPreferences, writeAppUiPreference } from "@/lib/app-ui-preferences";

interface MenuBridge {
  onNavigate: (handler: (route: string) => void) => () => void;
}

declare global {
  interface Window {
    agentlasMenu?: MenuBridge;
  }
}

const SIDEBAR_COLLAPSE_KEY = SIDENAV_COLLAPSE_KEY;

export function MenuBridge() {
  const router = useRouter();
  const { pref: localePreference, locale, setPref: setLocalePref } = useT();
  const { pref: themePreference, resolved: theme, setPref: setThemePref } = useTheme();
  const state = useRef({ localePreference, locale, themePreference, theme });
  state.current = { localePreference, locale, themePreference, theme };

  useEffect(() => installAppControlRenderer({
    read: (): AppControlRendererState => ({
      route: window.location.pathname + window.location.search,
      ...state.current,
      darkThemeAvailable: DARK_THEME_ENABLED,
      sidebarCollapsed: window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1",
      sidebarWidth: readWorkSidebarWidth(),
      media: readMediaDisplayPreferences(),
      uiPreferences: readAppUiPreferences(),
    }),
    apply: async (operation, args) => {
      if (operation === "app.navigate") {
        if (typeof args.route !== "string" || !/^\/[A-Za-z0-9/_\-?=&%.:~]*$/.test(args.route) || args.route.length > 300) throw new Error("Invalid app route.");
        router.push(args.route);
      } else if (operation === "app.setLanguage") {
        if (typeof args.locale !== "string" || !["ko", "en", "system"].includes(args.locale)) throw new Error("Invalid language preference.");
        return { locale: await setLocalePref(args.locale as LocalePref) };
      } else if (operation === "app.setTheme") {
        if (typeof args.theme !== "string" || !["light", "dark", "system"].includes(args.theme)) throw new Error("Invalid theme preference.");
        if (args.theme === "dark" && !DARK_THEME_ENABLED) throw new Error("Dark theme is disabled in the app.");
        setThemePref(args.theme as ThemePref);
      } else if (operation === "app.setSidebar") {
        if (args.collapsed !== undefined) {
          if (typeof args.collapsed !== "boolean") throw new Error("collapsed must be a boolean.");
          setAppSidebarCollapsed(args.collapsed);
        }
        if (args.width !== undefined) {
          if (typeof args.width !== "number" || !Number.isFinite(args.width)) throw new Error("width must be a number.");
          args.width = clampWorkSidebarWidth(args.width);
          setWorkSidebarWidth(args.width as number);
        }
      } else if (operation === "app.setMediaDisplay") {
        if (typeof args.kind !== "string" || !["image", "video", "audio"].includes(args.kind) || typeof args.visible !== "boolean") throw new Error("Provide a media kind and a boolean visible value.");
        writeMediaDisplayPreferences({ ...readMediaDisplayPreferences(), [args.kind as MediaDisplayKind]: args.visible });
      } else if (operation === "app.setUiPreference") {
        if (!isAppUiPreferenceName(args.name)) throw new Error("Unknown app UI preference.");
        const value = writeAppUiPreference(args.name, args.value);
        return { uiPreferences: { ...readAppUiPreferences(), [args.name]: value } };
      } else throw new Error("Unknown renderer operation.");
    },
  }), [router, setLocalePref, setThemePref]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.agentlasMenu) return;
    const off = window.agentlasMenu.onNavigate((route) => {
      if (route === "__toggle_sidebar__") {
        // 사이드바 컴포넌트의 localStorage 기반 토글을 flip + storage 이벤트로 알림
        try {
          const curr = window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1";
          setAppSidebarCollapsed(!curr);
        } catch {
          // ignore
        }
        return;
      }
      if (route === "__show_shortcuts__") {
        // V1: 단축키 다이얼로그. 지금은 alert로 대체.
        alert(
          [
            "⌘N  New project",
            "⌘[  Toggle sidebar",
            "⌘,  Settings",
            "⌘↵  Send message",
            "⇧⌘M  Agent Hub",
            "⇧⌘L  Apps",
            "Esc  Close popover",
          ].join("\n"),
        );
        return;
      }
      // One changed the app language for the owner (electron/app-control): the same setter as Settings.
      const locale = /^__locale__:(ko|en|system)$/.exec(route)?.[1];
      if (locale) {
        setLocalePref(locale as LocalePref);
        return;
      }
      if (route.startsWith("/")) {
        router.push(route);
      }
    });
    return off;
  }, [router, setLocalePref]);

  return null;
}
