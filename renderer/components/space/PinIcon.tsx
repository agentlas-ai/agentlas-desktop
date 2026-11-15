"use client";

/** A pin mark for pinned chats (the shared icon set has none). */
export function PinIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 17v5" /><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
    </svg>
  );
}
