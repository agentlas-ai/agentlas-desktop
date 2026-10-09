// Electron 메뉴 → Next.js 라우터 브릿지.
// 메인 프로세스의 buildAppMenu가 webContents.send("menu:navigate", route)로 보냄.
// 라우트면 router.push, 특수 sentinel(__toggle_sidebar__ 등)은 별도 처리.
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT, type LocalePref } from "@/lib/i18n";
import { DARK_THEME_ENABLED, useTheme, type ThemePref } from "@/lib/theme";
import { installAppControlRenderer, setAppSidebarCollapsed, SIDENAV_COLLAPSE_KEY } from "@/lib/app-control-bridge";
import { readMediaDisplayPreferences, writeMediaDisplayPreferences, type MediaDisplayKind } from "@/lib/media-display-preferences";
import { readWorkSidebarWidth, clampWorkSidebarWidth, setWorkSidebarWidth } from "@/lib/work-sidebar-width";
import type { AppControlRendererState } from "@shared/app-control";
import { isAppUiPreferenceName } from "@shared/app-ui-preferences";
import { readAppUiPreferences, writeAppUiPreference } from "@/lib/app-ui-preferences";
import { PopupFrame } from "./Popup";
import { IconApps, IconChat, IconClose, IconFolder, IconSettings, IconSidebar, IconStore } from "./Icon";

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
        setShortcutsOpen(true);
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

  const ko = locale === "ko";
  const modifier = typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘" : "Ctrl";
  const shortcuts = [
    { label: ko ? "새 프로젝트" : "New project", keys: [modifier, "N"], icon: <IconFolder size={18} /> },
    { label: ko ? "사이드바" : "Sidebar", keys: [modifier, "["], icon: <IconSidebar size={18} /> },
    { label: ko ? "설정" : "Settings", keys: [modifier, ","], icon: <IconSettings size={18} /> },
    { label: ko ? "메시지 보내기" : "Send message", keys: [modifier, "↵"], icon: <IconChat size={18} /> },
    { label: "Agent Hub", keys: ["⇧", modifier, "M"], icon: <IconStore size={18} /> },
    { label: ko ? "앱" : "Apps", keys: ["⇧", modifier, "L"], icon: <IconApps size={18} /> },
    { label: ko ? "팝업 닫기" : "Close popup", keys: ["Esc"], icon: <IconClose size={18} /> },
  ];
  return shortcutsOpen ? <PopupFrame title={ko ? "단축키" : "Shortcuts"} icon={<IconApps size={20} />}
    closeLabel={ko ? "닫기" : "Close"} onClose={() => setShortcutsOpen(false)}>
    {shortcuts.map(({ label, keys, icon }) => <div key={label} style={{display: "flex", alignItems: "center", gap: 10, minHeight: 44}}>
      <span aria-hidden="true" style={{color: "var(--muted-deep)"}}>{icon}</span>
      <span style={{flex: 1, fontSize: 13}}>{label}</span>
      <span style={{display: "flex", gap: 4}}>{keys.map((key, index) => <kbd key={index} style={{display: "grid", placeItems: "center", minWidth: 26, height: 28, padding: "0 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)", boxShadow: "0 2px 0 var(--line)", font: "inherit", fontSize: 12}}>{key}</kbd>)}</span>
    </div>)}
  </PopupFrame> : null;
}
