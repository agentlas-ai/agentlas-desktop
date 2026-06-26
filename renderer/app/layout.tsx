import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { AuthGate } from "@/components/AuthGate";

export const metadata: Metadata = {
  title: "Agentlas",
  description: "Run expert assistant teams on your existing AI subscriptions",
};

// 첫 페인트 전에 <html data-theme>를 동기 설정 — 다크모드 깜빡임(FOUC) 방지.
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem('agentlas.theme');var d=p==='dark'||((!p||p==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`;

// 루트 layout은 셸 없이 — 셸은 (shell)/layout.tsx에서 입힌다.
// /onboarding은 (no-shell)/onboarding에 두어서 셸을 우회.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <ThemeProvider>
          <I18nProvider>
            <AuthGate>{children}</AuthGate>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
