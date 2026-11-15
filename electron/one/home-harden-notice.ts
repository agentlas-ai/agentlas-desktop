/*
 * "7 days before an unconfirmed connection confirms itself, tell the owner once" (Agentlas 2.0 AO,; contracts/trust-root.md section 9).
 * No timer and no poll: home.ts asks `hardenVerdict` each time it has just taken a pointer into memory (the start-up read, every later read, every answer that carries a pointer), so a computer that was off on
 * the day tells at the next start while the 7 days are still running. The one fact kept is `hardenTold` in the home record (the `hardenAt` told about): read by that decision, erased when the connection is
 * confirmed, reverted, changed or its clock restarts (a different `hardenAt`). Pure functions here; the OS notification itself is installed by Main (`installOneHomeHardenNotice`) and is absent in the background service.
 */
/** AO: "7 days before the automatic confirmation" (the 30 days are the server's, this file never sees them). */
export const HARDEN_NOTICE_BEFORE_MS = 7 * 86_400_000;

export type HardenVerdict = "tell" | "clear" | "none";

/** A time as the pointer reader keeps it (ms or an ISO text) in ms, or null. */
export function hardenAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") { const t = Date.parse(value); return Number.isFinite(t) && t > 0 ? t : null; }
  return null;
}

/**
 * `unconfirmedHere`: this computer is the connected desktop and the server calls the connection unconfirmed (the same fact the settings screen calls "this desktop · not confirmed").
 * `now` is the server's clock as far as the computer can tell (home.ts adds the offset it read from the server's answer).
 */
export function hardenVerdict(input: { unconfirmedHere: boolean; hardenAt: number | null; now: number; told: number | undefined }): HardenVerdict {
  const { unconfirmedHere, hardenAt, now, told } = input;
  if (!unconfirmedHere || hardenAt === null) return told === undefined ? "none" : "clear";
  if (told !== undefined && told !== hardenAt) return "clear";            // the clock restarted: the earlier notice belongs to a connection that no longer waits for that date
  if (hardenAt <= now) return "none";                                      // the date has come; the server confirms at its next read (then the line is erased)
  if (hardenAt - now > HARDEN_NOTICE_BEFORE_MS) return "none";
  return told === hardenAt ? "none" : "tell";
}

/** Whole days left, at least 1. */
export const daysLeft = (hardenAt: number, now: number): number => Math.max(1, Math.ceil((hardenAt - now) / 86_400_000));

export function hardenNoticeText(lang: "ko" | "en", hardenAt: number, now: number): { title: string; body: string } {
  const n = daysLeft(hardenAt, now);
  return lang === "ko"
    ? { title: "데스크탑 연결 확인 대기", body: `본인이 변경하지 않았다면 ${n}일 안에 복원해 주세요.` }
    : { title: "Desktop connection not confirmed", body: `If you didn't make this change, revert it within ${n} day${n > 1 ? "s" : ""}.` };
}

export interface HardenNoticeHost {
  locale(): "ko" | "en";
  /** The keep-alive every Main notification goes through (notification-target.ts `retainNotification`). */
  retain<T extends { on(event: "click" | "close" | "failed", listener: (...args: unknown[]) => void): unknown }>(notification: T): T;
  /** Opens the main window at a route (the settings page, section "personal"). */
  open(route: string): void | Promise<void>;
  /** False in a development candidate whose outside effects are suppressed. */
  allowed(): boolean;
}

/** The place a click on the notice takes the owner: Settings > Personal agent (settings/page.tsx reads the hash). */
export const HARDEN_NOTICE_ROUTE = "/settings#personal";

export interface HardenInfo { hardenAt: number; now: number }
let notifier: ((info: HardenInfo) => boolean) | null = null;
/** Main installs the OS notification here; the background service never does. */
export function setOneHomeHardenNotifier(fn: ((info: HardenInfo) => boolean) | null): void { notifier = fn; }
/** Whether a notice was handled. false = nobody can show one here (the background service) or the notice was not allowed: nothing is marked as told. */
export function tellHardenSoon(info: HardenInfo): boolean { try { return notifier ? notifier(info) === true : false; } catch { return false; } }

/** Main only: installs the notification (shown, or the platform cannot show one: nothing to retry). */
export function installOneHomeHardenNotice(host: HardenNoticeHost, electron: () => { Notification: { new (o: { title: string; body: string; silent?: boolean }): { show(): void; on(e: "click" | "close" | "failed", l: (...a: unknown[]) => void): unknown }; isSupported(): boolean } } = () => require("electron")): void {
  setOneHomeHardenNotifier(({ hardenAt, now }) => {
    if (!host.allowed()) return false;
    try {
      const { Notification } = electron();
      if (!Notification.isSupported()) return true;
      const text = hardenNoticeText(host.locale(), hardenAt, now);
      const notification = new Notification({ ...text, silent: true });
      notification.on("click", () => { void Promise.resolve(host.open(HARDEN_NOTICE_ROUTE)).catch(() => undefined); });
      host.retain(notification).show();
      return true;
    } catch { return false; }
  });
}
