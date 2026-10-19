// 가벼운 테마 프로바이더 — 의존성 0. i18n.tsx와 동일한 패턴.
//
// 우선순위:
//   1) localStorage["agentlas.theme"] (light / dark) — 사용자 override
//   2) system (prefers-color-scheme) — 기본값
//
// <html data-theme="dark"> 를 토글하고, globals.css의 :root[data-theme="dark"]
// 토큰 레이어가 전 화면에 적용된다. FOUC 방지용 인라인 스크립트는 app/layout.tsx 참고.
"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "agentlas.theme";

function systemDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**












 */
export const DARK_THEME_ENABLED = false;

function resolve(pref: ThemePref): ResolvedTheme {
  if (!DARK_THEME_ENABLED) return "light";
  if (pref === "system") return systemDark() ? "dark" : "light";
  return pref;
}

function apply(theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

interface ThemeValue {
  /** "system" = OS 따라감, "light"/"dark" = 사용자 고정 */
  pref: ThemePref;
  /** 실제 적용된 테마 (system을 OS 값으로 환산한 결과) */
  resolved: ResolvedTheme;
  setPref: (p: ThemePref) => void;
  /** light↔dark 빠른 전환 (system이면 현재 화면 반대로 고정) */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  // 부팅: 저장된 선호값 로드 → 적용 (인라인 스크립트가 이미 깜빡임은 막았고, 여기서 상태 동기화)
  useEffect(() => {
    let stored: ThemePref = "system";
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      // sandbox/private mode — 기본값 사용
    }
    setPrefState(stored);
    const r = resolve(stored);
    setResolved(r);
    apply(r);
  }, []);

  // system 모드일 때만 OS 변경을 추적
  useEffect(() => {
    // 다크가 꺼져 있으면 OS 가 어두워져도 따라가지 않는다. 이 줄이 없으면 앱이 켜져 있는
    // 동안 OS 테마가 바뀌는 순간 다시 어두워진다 — 껐다고 말하고 안 꺼진 상태가 된다.
    if (!DARK_THEME_ENABLED) return;
    if (pref !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r: ResolvedTheme = mq.matches ? "dark" : "light";
      setResolved(r);
      apply(r);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    try {
      if (p === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // ignore
    }
    setPrefState(p);
    const r = resolve(p);
    setResolved(r);
    apply(r);
  }, []);

  const toggle = useCallback(() => {
    setPref(resolved === "dark" ? "light" : "dark");
  }, [resolved, setPref]);

  return (
    <ThemeContext.Provider value={{ pref, resolved, setPref, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Provider 외부 (error 페이지 등) — light fallback, no-op setter
    return { pref: "system", resolved: "light", setPref: () => {}, toggle: () => {} };
  }
  return ctx;
}
