// App Router 전용 404 — pages/_error 폴백이 호출되는 것을 막아준다.
// 빈 정적 페이지 한 장.
"use client";
import { useT } from "@/lib/i18n";

export default function NotFound() {
  const { locale } = useT();
  const ko = locale === "ko";
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "var(--paper-2)",
        color: "var(--ink)",
        fontFamily: "var(--font-body)",
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-head)",
          fontSize: 28,
          fontWeight: 700,
        }}
      >
        {ko ? "길을 잃었어요" : "Page not found"}
      </h1>
      <p style={{ margin: 0, color: "var(--muted-deep)" }}>
        {ko ? "찾으시는 페이지가 없습니다." : "The page you're looking for doesn't exist."}
      </p>
      <a href="/" style={{ color: "var(--accent)", fontWeight: 600 }}>
        {ko ? "메인으로" : "Go home"}
      </a>
    </main>
  );
}
