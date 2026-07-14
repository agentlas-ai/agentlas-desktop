// 루트 React ErrorBoundary — 한 화면(pane)의 렌더 throw가 앱 전체를 흰 화면으로
// 무너뜨리지 않도록 격리한다. AppShell의 메인 콘텐츠를 감싸 per-pane으로 동작하며,
// 라우트 변경 시 resetKey(보통 pathname)가 바뀌면 자동으로 복구된다.
"use client";
import { Component, type ReactNode } from "react";

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

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // 콘솔에 남겨 두면 메인 프로세스 로그/DevTools에서 추적 가능.
    console.error("[ErrorBoundary]", error, info.componentStack);
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
        role="alert"
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
          {ko ? "문제가 생겼어요" : "Something went wrong"}
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)", maxWidth: 360, lineHeight: 1.5 }}>
          {ko
            ? "이 화면을 불러오는 중 오류가 발생했어요. 다시 시도하거나 다른 메뉴로 이동해 보세요."
            : "This screen ran into an error. Try again, or move to another menu."}
        </p>
        <button
          type="button"
          onClick={this.reset}
          style={{
            height: 34,
            padding: "0 16px",
            borderRadius: 8,
            border: "none",
            background: "var(--ink)",
            color: "var(--paper)",
            fontSize: 13,
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          {ko ? "다시 시도" : "Try again"}
        </button>
      </div>
    );
  }
}
