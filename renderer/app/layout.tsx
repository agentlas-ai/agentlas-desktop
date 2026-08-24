import type { Metadata } from "next";
import "./globals.css";
// 수식 스타일 — KaTeX 는 자체 CSS 와 폰트가 있어야 글자가 제자리에 선다. 앱과 함께
// 번들되므로 네트워크가 없어도 그대로 그려진다(Electron 오프라인 전제).
import "katex/dist/katex.min.css";
// MapLibre's controls/popups are local package assets. The map itself renders
// through WebGL canvas; this stylesheet only lays out its accessible controls.
import "maplibre-gl/dist/maplibre-gl.css";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { AuthGate } from "@/components/AuthGate";
import { OneRecoveryPlane } from "@/components/OneRecoveryPlane";

export const metadata: Metadata = {
  title: "Agentlas",
  description: "Run expert assistant teams on your existing AI subscriptions",
};

// 첫 페인트 전에 <html data-theme>를 동기 설정 — 다크모드 깜빡임(FOUC) 방지.
//
// ★ 다크는 지금 꺼져 있다(오너 지시 2026-08-24, renderer/lib/theme.tsx 의 DARK_THEME_ENABLED).
// 여기도 함께 고정해야 한다 — 이 스크립트는 첫 페인트에서 먼저 돌기 때문에, 여기만 남겨 두면
// 화면이 어둡게 그려졌다가 밝게 되돌아오는 깜빡임이 생긴다. 다시 켤 때는 두 곳을 같이 켠다.
const THEME_BOOTSTRAP = `(function(){try{document.documentElement.dataset.theme='light';}catch(e){}})();`;

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
