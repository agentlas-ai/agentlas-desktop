/** Window-process notifications for runs that execute in the background service (1.3.0 A3).
 *
 * A run the service hosts never settles in Main's invocation service, so the two settle bridges in main.ts (the run-alert
 * bridge with the owner's notification settings, and the One team toast for approval / failure / long completion) never
 * saw it: the owner got no notification for Hope's background turns. The service already streams every settlement it
 * hosts to Main on the native public event stream; this applies the SAME decisions to that settlement, with the same
 * settings and the same foreground rule (a focused window is already looking at it). */
import type { NativePublicSettlement } from "./native-public-events";
import type { RunAlertDecision, RunAlertSettings } from "../run-alerts";

export interface DaemonRunAlertPorts {
  settings(): RunAlertSettings;
  /** True when one of the app's windows has focus. */
  focused(): boolean;
  locale(): string;
  quiet(runId: string): boolean;
  signedIn(): boolean;
  decide(settings: RunAlertSettings, input: { status: string; startedAt?: string; finishedAt?: string; focused: boolean; pendingQuestion?: boolean }): RunAlertDecision;
  fireRunAlert(input: { decision: Extract<RunAlertDecision, { alert: true }>; settings: RunAlertSettings; locale: string; goal: string; onClick?: () => void }): void;
  toast(input: { title: string; body: string; onClick?: () => void }): void;
  open(chatId: string): void;
  /** Work rules Main's own run-alert bridge applies (main.ts startRunAlertBridge): the Work main owns a child session's progress and
   * repair, and a parent turn that ends while its children still work is not finished. Absent = the ordinary path. */
  workChildRun?(chatId: string, runId: string): boolean;
  workParentAwaitingChildren?(chatId: string, runId: string): boolean;
}

const LONG_COMPLETE_MS = 5 * 60 * 1_000;
export function createDaemonRunAlerts(ports: DaemonRunAlertPorts) {
  const teamKeys = new Set<string>(), alerted = new Set<string>();
  const remember = (set: Set<string>, key: string): boolean => {
    if (set.has(key)) return false;
    set.add(key); if (set.size > 512) set.delete(set.values().next().value as string);
    return true;
  };
  function notifySettled(envelope: NativePublicSettlement): void {
    try {
      // A redelivered settlement (stream replay after a re-attach) must not alert twice.
      if (!remember(alerted, envelope.runId)) return;
      const receipt = envelope.receipt, focused = ports.focused(), locale = ports.locale();
      // The wire also allows "waiting_input" (the run stopped for the owner's answer or approval); Main's own vocabulary
      // carries that as pendingQuestion, so both mean "needs your input".
      const waiting = envelope.pendingQuestion === true || String(receipt.status) === "waiting_input";
      const status = String(receipt.status) === "waiting_input" ? "completed" : receipt.status;
      // A background-hosted Work child or a parent still waiting on its children raises neither the toast nor the alarm, as in Main.
      if (ports.workChildRun?.(envelope.chatId, envelope.runId)) return;
      if (status === "completed" && !waiting && ports.workParentAwaitingChildren?.(envelope.chatId, envelope.runId)) return;
      const reason = waiting ? "approval" : receipt.status === "failed" ? "failure"
        : status === "completed" && Date.parse(receipt.finishedAt || receipt.updatedAt) - Date.parse(receipt.startedAt) >= LONG_COMPLETE_MS ? "long-complete" : null;
      if (reason && ports.signedIn() && !focused && remember(teamKeys, `${receipt.runId}:${reason}`)) {
        const ko = locale === "ko";
        ports.toast({ title: "Agentlas One", onClick: () => ports.open(envelope.chatId),
          body: reason === "approval" ? (ko ? "이어가려면 확인이 필요해요." : "One needs your input to continue.")
            : reason === "failure" ? (ko ? "확인이 필요한 실패한 작업이 있어요." : "One had a failed run to review.")
            : (ko ? "오래 걸린 작업을 끝냈어요." : "One finished a long-running task.") });
      }
      const settings = ports.settings();
      const decision = ports.decide(settings, { status, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt ?? receipt.updatedAt, focused, pendingQuestion: waiting });
      if (!decision.alert) return;
      if (ports.quiet(receipt.runId)) return; // One decided the owner needs to hear nothing ([quiet])
      if ([...teamKeys].some(key => key.startsWith(`${receipt.runId}:`))) return; // the toast above already told them
      ports.fireRunAlert({ decision, settings, locale, goal: "", onClick: () => ports.open(envelope.chatId) });
    } catch {
      // Notifications are an extra: they never touch the run's settlement.
    }
  }
  return Object.freeze({ notifySettled });
}

let override: ReturnType<typeof createDaemonRunAlerts> | undefined, loaded: Promise<ReturnType<typeof createDaemonRunAlerts>> | undefined;
/** Test seam: replace the real Electron-backed ports. */
export function configureDaemonRunAlerts(value: ReturnType<typeof createDaemonRunAlerts> | undefined): void { override = value; loaded = undefined; }
async function electronAlerts(): Promise<ReturnType<typeof createDaemonRunAlerts>> {
  const [electron, runAlerts, windows, auth, locale, presentation, db, tasks, tray, workSessions] = await Promise.all([
    import("electron"), import("../run-alerts"), import("../one-window-manager"), import("../auth"), import("../ui-locale"),
    import("../one/supervisor-presentation"), import("../store/db"), import("../store/tasks"), import("../background-tray"),
    import("../work/session-dispatch"),
  ]);
  return createDaemonRunAlerts({
    settings: () => runAlerts.getRunAlerts(),
    // Focused, shown and not minimized (run-alerts.ts windowWatched): a minimized window can still hold focus on Windows.
    focused: () => runAlerts.anyWindowWatched(electron.BrowserWindow.getAllWindows()),
    locale: () => locale.currentUiLocale(),
    quiet: runId => { try { return presentation.supervisorQuietRun(db.getDb(), runId); } catch { return false; } },
    signedIn: () => auth.getAuthSession().signedIn,
    decide: runAlerts.decideRunAlert,
    fireRunAlert: runAlerts.fireRunAlert,
    toast: ({ title, body, onClick }) => {
      if (!electron.Notification.isSupported()) return;
      const notification = new electron.Notification({ title, body, silent: true });
      if (onClick) notification.on("click", onClick);
      notification.show();
    },
    open: chatId => { try { tray.leaveBackgroundHold(); void windows.openOneWindow({ taskId: tasks.findCanonicalTaskForChat(chatId)?.id }); } catch { /* the window may be closing */ } },
    // The dispatch ledger is the shared store, so Main reads the background service's Work children from it; unreadable = ordinary path.
    workChildRun: (chatId, runId) => { try { return workSessions.isWorkSessionChildRun(chatId, runId); } catch { return false; } },
    workParentAwaitingChildren: (chatId, runId) => { try { return workSessions.workSessionParentHasPendingChildren(chatId, runId); } catch { return false; } },
  });
}
/** Called by the Main public-event bridge for every settlement the background service reports. */
export function notifyDaemonRunSettled(envelope: NativePublicSettlement): void {
  const alerts = override ?? undefined;
  if (alerts) { alerts.notifySettled(envelope); return; }
  (loaded ??= electronAlerts()).then(value => value.notifySettled(envelope), () => undefined);
}
