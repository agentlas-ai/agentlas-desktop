// 루트 React ErrorBoundary — 한 화면(pane)의 렌더 throw가 앱 전체를 흰 화면으로
// 무너뜨리지 않도록 격리한다. AppShell의 메인 콘텐츠를 감싸 per-pane으로 동작하며,
// 라우트 변경 시 resetKey(보통 pathname)가 바뀌면 자동으로 복구된다.
"use client";
import { Component, type ReactNode } from "react";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";

// 클래스 컴포넌트라 useT() 훅을 쓸 수 없어, i18n과 동일한 override 키를 직접 읽는다.
// (lib/i18n.tsx: STORAGE_KEY "agentlas.locale", SSR 기본값 en)
function readLocale(): "ko" | "en" {
  try {
    const raw = window.localStorage.getItem("agentlas.locale");
    if (raw === "en") return "en";
  } catch {
    // ignore
  }
  return "en";
}

type Props = {
  children: ReactNode;
  // 이 값이 바뀌면(예: pathname) 폴백 상태를 자동으로 리셋한다.
  resetKey?: unknown;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // 콘솔에 남겨 두면 메인 프로세스 로그/DevTools에서 추적 가능.
    console.error("[ErrorBoundary]", error, info.componentStack);
    requestOneOperationalRecovery("renderer.boundary", {
      error,
      componentStack: info.componentStack,
    });
    this.retryTimer = setTimeout(this.reset, 2_500);
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const ko = readLocale() === "ko";
    return (
      <div
        aria-live="polite"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 32,
          textAlign: "center",
          background: "var(--paper)",
          color: "var(--ink)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800 }}>
          {ko ? "One이 화면을 바로잡고 있습니다" : "One is restoring this screen"}
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)", maxWidth: 360, lineHeight: 1.5 }}>
          {ko
            ? "확인하거나 다시 누를 필요 없이 이 화면에서 이어집니다."
            : "You can stay here. One will continue when the screen is ready."}
        </p>
      </div>
    );
  }
}
