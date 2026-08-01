import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { AuthGate } from "@/components/AuthGate";
import { OneRecoveryPlane } from "@/components/OneRecoveryPlane";

export const metadata: Metadata = {
  title: "Agentlas",
  description: "Run expert assistant teams on your existing AI subscriptions",
};

// 첫 페인트 전에 <html data-theme>를 동기 설정 — 다크모드 깜빡임(FOUC) 방지.
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem('agentlas.theme');var d=p==='dark'||((!p||p==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`;

// 루트 layout은 셸 없이 — 셸은 (shell)/layout.tsx에서 입힌다.
// 캔버스/QA 전용 화면은 (no-shell)에 두고, 신규 사용자 안내는 대시보드 QuestBoard가 담당한다.
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
            <OneRecoveryPlane />
            <AuthGate>{children}</AuthGate>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
