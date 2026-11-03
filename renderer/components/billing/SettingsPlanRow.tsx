"use client";

// Settings → Plan: the way back to the plans after the first-run paywall.
// It opens the one app-wide plan picker (PlanPickerHost); nothing about prices or trials is written here.
import { openPricing } from "@/components/UpgradeCta";
import { useT } from "@/lib/i18n";

export function SettingsPlanRow() {
  const { locale } = useT();
  const ko = locale === "ko";
  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
        {ko ? "플랜" : "Plan"}
      </h2>
      <div
        data-settings-plan-row
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
          borderRadius: "var(--radius-md)",
          background: "var(--paper)",
          border: "1px solid var(--paper-edge)",
          boxShadow: "var(--shadow-1)",
          wordBreak: "keep-all",
        }}
      >
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
          {ko
            ? "현재 플랜을 확인하고 Pro·Max·WoW로 바꿉니다. 결제는 웹 결제 페이지에서 진행돼요."
            : "See your current plan and switch to Pro, Max or WoW. Payment happens on the web checkout page."}
        </span>
        <button
          type="button"
          onClick={() => openPricing("settings")}
          data-settings-plan-open
          style={{
            flex: "0 0 auto",
            whiteSpace: "nowrap",
            padding: "8px 14px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            fontWeight: 600,
            background: "var(--black)",
            color: "var(--white)",
            border: 0,
            cursor: "pointer",
          }}
        >
          {ko ? "플랜 보기" : "See plans"}
        </button>
      </div>
    </>
  );
}
