"use client";
import type { CSSProperties } from "react";

type StudioBotLogoProps = {
  size?: number;
  wordmark?: boolean;
  label?: string;
  style?: CSSProperties;
  markStyle?: CSSProperties;
  textStyle?: CSSProperties;
};

export function StudioBotLogo({
  size = 36,
  wordmark = false,
  label = "Agent Apps",
  style,
  markStyle,
  textStyle,
}: StudioBotLogoProps) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, lineHeight: 1, ...style }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden
        style={{ display: "block", flexShrink: 0, ...markStyle }}
      >
        <path
          d="M17 22.5c-4.4-.6-7.5-3.9-7.5-8.1 0-4.7 3.9-8.4 8.8-8.4 2.2 0 4.2.7 5.7 2 2.1-3 5.7-5 9.8-5 6 0 11 4.3 11.8 9.9 5.1.5 9 4.4 9 9.2 0 5.1-4.5 9.3-10.1 9.3H18.8c-5.2 0-9.4-3.8-9.4-8.6 0-4.3 3.2-7.8 7.6-8.3Z"
          fill="var(--brand-bot-accent)"
          stroke="var(--brand-bot-outline)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <rect x="17.5" y="24" width="29" height="22" rx="7.5" fill="var(--brand-bot-body)" stroke="var(--brand-bot-outline)" strokeWidth="2.5" />
        <rect x="22.5" y="29" width="19" height="11" rx="3.5" fill="var(--brand-bot-face)" stroke="var(--brand-bot-outline)" strokeWidth="2" />
        <path d="m27.2 32.4 3 3-3 3" stroke="var(--brand-bot-glow)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M34.5 38.5h4.2" stroke="var(--brand-bot-glow)" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M22.5 47.5v5.8M41.5 47.5v5.8" stroke="var(--brand-bot-outline)" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M19 35h-5.2M50.2 35H45" stroke="var(--brand-bot-outline)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="25.2" cy="44.3" r="1.6" fill="var(--brand-bot-outline)" />
        <circle cx="38.8" cy="44.3" r="1.6" fill="var(--brand-bot-outline)" />
      </svg>
      {wordmark ? (
        <span
          style={{
            color: "inherit",
            fontSize: 13,
            fontWeight: 820,
            letterSpacing: 0,
            whiteSpace: "nowrap",
            ...textStyle,
          }}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
