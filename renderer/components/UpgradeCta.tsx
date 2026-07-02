// 구독/충전 CTA — 웹 결제 페이지(https://agentlas.cloud/pricing)를 외부 브라우저로 연다.
// 데스크탑 셸에서 window.open(_blank)은 electron/main.ts의 setWindowOpenHandler가
// shell.openExternal로 넘긴다(ChatRightPanel·WorkbenchPanel과 동일 패턴).
// 프롬프트 저장소 정책(2026-07): 유료 구독=무제한 열람+저장, 무료=프롬프트당 맛보기 1회.
"use client";
import { useT } from "@/lib/i18n";

export const PRICING_URL = "https://agentlas.cloud/pricing";

/** 결제/구독 페이지를 시스템 기본 브라우저로 연다. */
export function openPricing(): void {
  if (typeof window === "undefined") return;
  window.open(PRICING_URL, "_blank", "noopener,noreferrer");
}

export function UpgradeCta({
  variant = "inline",
  message,
  buttonLabel,
}: {
  /** inline = 작은 한 줄 CTA, banner = 적극적(맛보기 3회 소진 등) 배너 */
  variant?: "inline" | "banner";
  message?: string;
  buttonLabel?: string;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const text =
    message ??
    (ko
      ? "구독하면 모든 프롬프트를 무제한으로 열람하고 저장할 수 있어요."
      : "Subscribe to unlock and save every prompt without limits.");
  const label = buttonLabel ?? (ko ? "구독 알아보기" : "See plans");

  if (variant === "banner") {
    return (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid var(--paper-edge)",
          background: "var(--fill-1)",
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
            {ko ? "맛보기를 알차게 쓰고 계시네요!" : "You are making the most of your tastes!"}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--muted-deep)", lineHeight: 1.5, marginTop: 2 }}>
            {text}
          </div>
        </div>
        <button
          type="button"
          className="neu-btn-primary"
          onClick={openPricing}
          style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12.5, whiteSpace: "nowrap" }}
        >
          {label}
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        fontSize: 12,
        color: "var(--muted-deep)",
        lineHeight: 1.5,
      }}
    >
      <span style={{ flex: 1, minWidth: 160 }}>{text}</span>
      <button
        type="button"
        onClick={openPricing}
        style={{
          padding: "5px 10px",
          borderRadius: 8,
          border: "1px solid var(--paper-edge)",
          background: "var(--paper)",
          color: "var(--accent)",
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </button>
    </div>
  );
}
