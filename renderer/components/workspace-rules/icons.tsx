"use client";
/** The three line icons "My rules" needs that Icon.tsx does not have (same 24px stroke style; Icon.tsx is shared and not touched). */
import type { CSSProperties } from "react";

function icon(d: string, size: number, style?: CSSProperties) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden><path d={d} /></svg>;
}
export const IconListCheck = ({ size = 16 }: { size?: number }) => icon("M3 17l2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8", size);
export const IconFileEmpty = ({ size = 16 }: { size?: number }) => icon("M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5zM14 2v6h6M3 3l18 18", size);
export const IconFileX = ({ size = 16 }: { size?: number }) => icon("M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5zM14 2v6h6M9.5 12.5l5 5M14.5 12.5l-5 5", size);
export const IconRuler = ({ size = 16 }: { size?: number }) => icon("M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0zM14.5 12.5l2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2", size);
