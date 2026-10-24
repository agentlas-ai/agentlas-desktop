// Agentlas Reach, the Settings switch (owner 2026-10-23): a default-OFF switch for exploring the owner's installed desktop apps in the
// background. The switch and the status line are the only owner-facing surface; the map is built and used by the Reach service.

/** What the Settings status line shows. Everything but `enabled` and `permissions` is written by the Reach service. */
export type ReachStatusDto = {
  /** The switch. Always the stored value, never the service's last report. */
  enabled: boolean;
  /** When the app map was last built (ISO 8601), or null when it never was. */
  mapAt: string | null;
  /** Installed apps on the map. */
  apps: number;
  /** Apps with abilities AI can use now. */
  green: number;
  /** Apps with some abilities. */
  amber: number;
  /** Apps nothing was found for yet. */
  gray: number;
  /** True while an exploration pass is running. */
  exploring: boolean;
  /** Verified abilities AI can call right now. */
  usable: number;
  /** The last exploration error in plain words, or null. */
  lastError: string | null;
  /** macOS Accessibility and Screen Recording grants, read fresh and without prompting. null = unknown or not applicable (other OS). */
  permissions: { accessibility: boolean | null; screenRecording: boolean | null };
};

export interface ReachAPI {
  /** Reads the Agentlas Reach switch ("Explore this desktop's apps" in Settings). Off by default. Changes nothing. */
  getExplore(): Promise<{ enabled: boolean }>;
  /** Turns background exploration of the owner's installed desktop apps on or off and returns the stored value. Needs a real boolean. The owner's own switch: turning it on downloads a driver and sends anonymous ability descriptions, so it is not an app-control operation. Turning it ON also needs `consent: true`, which the Settings dialog sends only after the owner agrees (part of the activity may be sent to improve the product). */
  setExplore(enabled: boolean, consent?: boolean): Promise<{ enabled: boolean }>;
  /** Reads the exploration status shown under the switch: the switch value, when the app map was last built, how many apps are usable, partial or not found yet, whether a pass is running, the last error, and the macOS permission grants. Never prompts for a permission. Changes nothing. */
  status(): Promise<ReachStatusDto>;
}
