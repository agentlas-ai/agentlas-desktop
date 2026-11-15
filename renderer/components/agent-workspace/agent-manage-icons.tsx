"use client";
// Line icons Manage agents needs that the shared Icon set does not have (same 24px stroke style). Local on purpose: the shared Icon file has other editors.
import type { ReactNode } from "react";
function icon(paths: ReactNode, size = 16) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths}</svg>;
}
export const IconPin = ({ size }: { size?: number }) => icon(<><path d="M12 17v5" /><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" /></>, size);
export const IconTrendUp = ({ size }: { size?: number }) => icon(<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>, size);
export const IconGlobe = ({ size }: { size?: number }) => icon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" /></>, size);
export const IconHistoryClock = ({ size }: { size?: number }) => icon(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>, size);
export const IconCloudOff = ({ size }: { size?: number }) => icon(<><path d="M3 3l18 18" /><path d="M17 17H7a4 4 0 0 1-1-7.9M9.5 5.6A6 6 0 0 1 18 9a4 4 0 0 1 3 3.9" /></>, size);
export const IconFolderOff = ({ size }: { size?: number }) => icon(<><path d="M3 3l18 18" /><path d="M3 6v12a2 2 0 0 0 2 2h13M9 4h3l2 2h5a2 2 0 0 1 2 2v7" /></>, size);
export const IconDisk = ({ size }: { size?: number }) => icon(<><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 17h.01" /></>, size);
export const IconPause = ({ size }: { size?: number }) => icon(<><path d="M9 5v14M15 5v14" /></>, size);
export const IconSaveOff = ({ size }: { size?: number }) => icon(<><path d="M3 3l18 18" /><path d="M7 4h9l4 4v8M5 7v12h13" /></>, size);
export const IconRuler = ({ size }: { size?: number }) => icon(<><rect x="3" y="8" width="18" height="8" rx="1" /><path d="M7 8v4M11 8v3M15 8v4M19 8v3" /></>, size);
